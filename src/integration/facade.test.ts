import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

/**
 * The MCP facade, driven the way a real client drives it.
 *
 * Every other suite here speaks the daemon's own protocol, which is why this
 * one exists: for a while the facade returned `structuredContent` carrying
 * only index status and no answer, and clients that prefer structured output
 * over text received nothing but readiness for every verb. Sixty-three green
 * tests could not see it, because none of them crossed this boundary — and a
 * text-rendering client showed the answer fine, so a single client could not
 * see it either.
 *
 * So the assertions below are deliberately about the *envelope*: that both
 * channels independently carry the answer. Content assertions belong in the
 * suites that own each verb.
 */
const skip = skipReason();

const here = dirname(fileURLToPath(import.meta.url));
/** dist/integration -> repo root */
const repoRoot = join(here, "..", "..");

interface Rpc {
  call(method: string, params?: unknown): Promise<Record<string, any>>;
  stop(): void;
}

/** Newline-delimited JSON-RPC over the facade's stdio, correlated by id. */
function speak(child: ChildProcess): Rpc {
  const pending = new Map<number, (result: Record<string, any>) => void>();
  let next = 1;
  let buffered = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as { id?: number; result?: Record<string, any> };
      if (message.id === undefined) continue;
      pending.get(message.id)?.(message.result ?? {});
      pending.delete(message.id);
    }
  });

  return {
    call(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`facade did not answer ${method}`));
        }, 20_000);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stop() {
      child.kill();
    },
  };
}

describe("mcp facade", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;
  let facade: ChildProcess;
  let rpc: Rpc;

  before(async () => {
    fx = await startFixture();
    // Point the facade at the daemon the harness already owns. Letting it
    // autostart its own would leave a detached process nothing here can kill,
    // holding a rust-analyzer for the rest of the run.
    if (fx.socket === null) return;

    facade = spawn(process.execPath, [join(repoRoot, "dist", "mcp", "index.js")], {
      env: { ...process.env, FLUENT_ROOT: fx.root, FLUENT_SOCKET: fx.socket },
      stdio: ["pipe", "pipe", "pipe"],
    });
    rpc = speak(facade);

    await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "facade.test", version: "0" },
    });
  });

  after(async () => {
    rpc?.stop();
    await fx?.stop();
  });

  test("every tool declares what its structured output is", async (t) => {
    if (fx.socket === null) return t.skip("stdio fallback: the facade cannot dial a socket");

    const { tools } = (await rpc.call("tools/list")) as {
      tools: Array<{ name: string; outputSchema?: unknown }>;
    };
    assert.ok(tools.length > 0, "the facade registered no tools");

    // Without a declared schema the spec leaves structured-vs-text precedence
    // open, and clients diverge — which is the ambiguity this whole suite
    // exists because of.
    const undeclared = tools.filter((tool) => tool.outputSchema === undefined).map((t) => t.name);
    assert.deepEqual(undeclared, [], `these would be read inconsistently: ${undeclared.join(" ")}`);
  });

  test("the answer arrives in both channels, and each stands alone", async (t) => {
    if (fx.socket === null) return t.skip("stdio fallback: the facade cannot dial a socket");

    const result = (await rpc.call("tools/call", {
      name: "find",
      arguments: { needle: "load-bearing", haystack: "README.md" },
    })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { text: string };
      isError?: boolean;
    };

    assert.ok(!result.isError, JSON.stringify(result));

    const text = result.content[0]?.text ?? "";
    assert.match(text, /load-bearing/, `text channel lost the answer:\n${text}`);

    // The regression: a client reading structuredContent uses it *instead of*
    // content, so status alone here is silent, total failure for that client.
    assert.match(
      result.structuredContent.text,
      /load-bearing/,
      `structured channel carries no answer: ${JSON.stringify(result.structuredContent)}`,
    );
  });

  test("a failed call reports the reason, not just that it failed", async (t) => {
    if (fx.socket === null) return t.skip("stdio fallback: the facade cannot dial a socket");

    const result = (await rpc.call("tools/call", {
      name: "read",
      arguments: { target: "#ZZZZZZ" },
    })) as { content: Array<{ text: string }>; structuredContent: { text: string }; isError?: boolean };

    assert.equal(result.isError, true, JSON.stringify(result));
    // Same envelope rule on the error path, where it matters more: an error
    // with no reason is indistinguishable from the tool being broken.
    assert.match(result.content[0]?.text ?? "", /unknown/, JSON.stringify(result.content));
    assert.match(result.structuredContent.text, /unknown/, JSON.stringify(result.structuredContent));
  });
});
