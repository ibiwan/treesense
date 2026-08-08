/**
 * Socket client for the daemon, with autostart.
 *
 * The facade holds no state of its own — handles, generations and the index
 * all live on the daemon side, so this is purely a translator: MCP framing in,
 * daemon protocol out.
 */

import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Response, type DaemonReply, type Request } from "../shared/protocol.js";
import { socketPathFor } from "../shared/socket.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Under `tsx` the module URL keeps its `.ts` extension, so this distinguishes
 * running from source in development from running the compiled tree.
 */
const FROM_SOURCE = import.meta.url.endsWith(".ts");

export class DaemonClient {
  private socket: Socket | null = null;
  private nextId = 0;
  /** Keyed by correlation id — the daemon answers concurrently, not in order. */
  private readonly pending = new Map<number, (reply: DaemonReply) => void>();

  constructor(private readonly root: string) {}

  async send(request: Request): Promise<DaemonReply> {
    const socket = await this.ensure();
    const id = this.nextId++;
    return new Promise<DaemonReply>((resolve) => {
      this.pending.set(id, resolve);
      socket.write(`${JSON.stringify({ id, request })}\n`);
    });
  }

  private async ensure(): Promise<Socket> {
    if (this.socket !== null) return this.socket;
    const path = socketPathFor(this.root);

    let socket = await tryConnect(path);
    if (socket === null) {
      this.spawnDaemon();
      socket = await waitForDaemon(path);
    }

    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      let response;
      try {
        response = Response.parse(JSON.parse(line));
      } catch (cause) {
        process.stderr.write(`malformed daemon response: ${String(cause)}\n`);
        return;
      }
      const waiter = this.pending.get(response.id);
      if (waiter === undefined) return;
      this.pending.delete(response.id);
      waiter({ ok: response.ok, text: response.text, index: response.index });
    });

    socket.on("close", () => {
      this.socket = null;
      // Outstanding requests must fail loudly: a daemon restart means every
      // handle the caller holds is dead, not merely stale.
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        waiter({
          ok: false,
          text: "error: daemon connection lost; handles are void",
          index: { readiness: "failed" },
        });
      }
    });

    this.socket = socket;
    return socket;
  }

  private spawnDaemon(): void {
    // In development the daemon's entrypoint is TypeScript, so it has to go
    // through tsx rather than node — resolving a sibling `.js` would point at
    // a file that only exists after a build.
    const [command, entry] = FROM_SOURCE
      ? [join(here, "..", "..", "node_modules", ".bin", "tsx"), join(here, "..", "daemon", "index.ts")]
      : [process.execPath, join(here, "..", "daemon", "index.js")];

    const child = spawn(command, [entry, this.root], {
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.unref();
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

async function waitForDaemon(path: string, attempts = 50): Promise<Socket> {
  for (let i = 0; i < attempts; i++) {
    const socket = await tryConnect(path);
    if (socket !== null) return socket;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`daemon did not come up at ${path}`);
}
