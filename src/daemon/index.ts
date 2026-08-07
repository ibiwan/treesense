#!/usr/bin/env node
/**
 * fluentd — the long-lived half.
 *
 * This process exists because MCP stdio servers are spawned by the host and
 * die with the client session. Holding rust-analyzer inside one would mean
 * paying a full cold index every time an editor restarted, and running two
 * indexes whenever two clients connected — which is the entire cost the warm
 * daemon was meant to avoid.
 *
 * First client to connect starts it; it outlives them all.
 */

import { connect, createServer, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";

import { Outer, Request, type Reply } from "../shared/protocol.js";
import { socketPathFor } from "../shared/socket.js";
import { edit } from "./actions/edit.js";
import { find } from "./actions/find.js";
import { move } from "./actions/move.js";
import { read } from "./actions/read.js";
import { refs } from "./actions/refs.js";
import { trace } from "./actions/trace.js";
import { registerLanguages } from "./syntax.js";
import { Workspace } from "./workspace.js";

async function dispatch(ws: Workspace, request: Request): Promise<Reply> {
  switch (request.op) {
    case "find":
      return find(ws, request);
    case "read":
      return read(ws, request);
    case "refs":
      return refs(ws, request);
    case "edit":
      return edit(ws, request);
    case "move":
      return move(ws, request);
    case "trace":
      return trace(ws, request);
    case "status":
      return {
        ok: true,
        text: `root ${ws.root}\nindex ${ws.lsp.readiness}\nws ${ws.files.workspaceGen}`,
      };
  }
}

/** Zod errors are verbose; the first issue is the useful part. */
function describe(cause: unknown): string {
  const issues = (cause as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  if (issues !== undefined && issues.length > 0) {
    const first = issues[0]!;
    const where = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return `${where}${first.message}`;
  }
  return (cause as Error).message;
}

function handle(ws: Workspace, socket: Socket): void {
  const lines = createInterface({ input: socket });
  lines.on("line", (line) => {
    void (async () => {
      // The id is recovered separately from the request body, because a
      // request that fails *schema* validation still has an id — and a reply
      // is owed. Dropping it silently strands the caller forever, which is a
      // far worse failure than a rejected request.
      let id: number | null = null;
      let reply: Reply;
      try {
        const outer = Outer.parse(JSON.parse(line));
        id = outer.id;
        reply = await dispatch(ws, Request.parse(outer.request));
      } catch (cause) {
        reply = { ok: false, text: `error: ${describe(cause)}` };
      }

      if (id === null) {
        // No id at all: nobody is waiting on a correlation we cannot make.
        process.stderr.write(`dropping unaddressable request: ${reply.text}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ id, ...reply })}\n`);
    })();
  });
}

/**
 * Is something actually listening, or is this a leftover file?
 *
 * A daemon killed with SIGKILL leaves its socket behind; connecting to that
 * fails with ECONNREFUSED, which is how a stale entry is told apart from a
 * live one. Only the stale case may be unlinked.
 */
function isServed(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

async function main(): Promise<void> {
  // Dynamic grammars are registered process-wide and exactly once, so this
  // belongs at startup rather than inside a lazy parse.
  registerLanguages();

  // Canonicalise before anything else sees it. The registry realpaths every
  // file, so a root that still contains a symlink (/tmp, or any mkdtemp path
  // on darwin) makes our two halves disagree about the same file: we ask
  // rust-analyzer about /private/var/... while it indexed /var/... and it
  // answers "file not found" for a file plainly on disk. DESIGN.md § 2.
  const requested = process.argv[2] ?? process.cwd();
  const root = await realpath(requested).catch(() => requested);
  const targetDir = process.env.FLUENT_TARGET_DIR;

  const path = socketPathFor(root);

  // Never unlink blindly. A socket file that is still being served means
  // another daemon owns this root, and deleting it would orphan a process
  // holding a warm index and the entire handle table — while new clients
  // silently got a daemon whose handles are all void.
  if (await isServed(path)) {
    process.stderr.write(`fluentd already serving ${root}\n`);
    return;
  }
  rmSync(path, { force: true });

  const ws = new Workspace(root, targetDir);
  const server = createServer((socket) => handle(ws, socket));

  server.on("error", (cause: NodeJS.ErrnoException) => {
    // Two daemons can clear the check above simultaneously; whoever loses the
    // bind should stand down rather than fail, because the winner is a
    // perfectly good daemon for this root and the client will reach it.
    if (cause.code === "EADDRINUSE") {
      process.stderr.write(`fluentd lost the startup race for ${root}\n`);
      process.exit(0);
    }
    // Otherwise: staying alive holding a socket that was never bound is worse
    // than exiting — healthy-looking and unreachable. The usual cause is
    // sun_path, which the kernel caps near 104 bytes without failing loudly.
    process.stderr.write(`fluentd cannot listen on ${path}: ${cause.message}\n`);
    process.exit(1);
  });

  server.listen(path, () => {
    process.stderr.write(`fluentd listening ${path}\n`);
  });

  const shutdown = (): void => {
    server.close();
    rmSync(path, { force: true });
    void ws.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the index warming but do not block the socket on it: READ needs
  // neither the index nor a parse, so clients can work immediately.
  ws.start().catch((cause: unknown) => {
    process.stderr.write(`rust-analyzer failed to start: ${String(cause)}\n`);
  });
}

void main();
