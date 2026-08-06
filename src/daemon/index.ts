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

import { createServer, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";

import { Envelope, type Reply, type Request } from "../shared/protocol.js";
import { socketPathFor } from "../shared/socket.js";
import { edit } from "./actions/edit.js";
import { find } from "./actions/find.js";
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
    case "trace":
      return trace(ws, request);
    case "status":
      return {
        ok: true,
        text: `root ${ws.root}\nindex ${ws.lsp.readiness}\nws ${ws.files.workspaceGen}`,
      };
  }
}

function handle(ws: Workspace, socket: Socket): void {
  const lines = createInterface({ input: socket });
  lines.on("line", (line) => {
    void (async () => {
      // Parse the envelope first and separately: without an id there is
      // nothing to correlate a failure to, so a malformed request would
      // otherwise strand the caller waiting forever.
      let envelope: Envelope;
      try {
        envelope = Envelope.parse(JSON.parse(line));
      } catch (cause) {
        process.stderr.write(`dropping unparseable request: ${String(cause)}\n`);
        return;
      }

      let reply: Reply;
      try {
        reply = await dispatch(ws, envelope.request);
      } catch (cause) {
        reply = { ok: false, text: `error: ${(cause as Error).message}` };
      }
      socket.write(`${JSON.stringify({ id: envelope.id, ...reply })}\n`);
    })();
  });
}

async function main(): Promise<void> {
  // Dynamic grammars are registered process-wide and exactly once, so this
  // belongs at startup rather than inside a lazy parse.
  registerLanguages();

  const root = process.argv[2] ?? process.cwd();
  const targetDir = process.env.FLUENT_TARGET_DIR;

  const ws = new Workspace(root, targetDir);
  const path = socketPathFor(root);
  rmSync(path, { force: true });

  const server = createServer((socket) => handle(ws, socket));

  // Without this the process stays alive holding a socket that was never
  // bound — healthy-looking and unreachable, which is a far worse failure
  // than exiting. The common cause is sun_path: the kernel caps a unix socket
  // path near 104 bytes and does not fail loudly when it is exceeded.
  server.on("error", (cause: NodeJS.ErrnoException) => {
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
