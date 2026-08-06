/**
 * rust-analyzer client.
 *
 * We own the instance rather than borrowing the editor's, because we need a
 * lifecycle we control. It is a real cost — a second multi-gigabyte resident
 * process alongside whatever the user's editor already has warm — but the
 * alternative is a server whose index disappears whenever an editor restarts.
 *
 * Two configuration choices worth not undoing:
 *
 *   checkOnSave: false   None of find/read/refs/trace needs `cargo check`.
 *                        Diagnostics are the only feature that requires
 *                        spawning cargo, and an agent that wants to know
 *                        whether something compiles can run cargo itself.
 *                        Leaving it on means fighting the user's editor for
 *                        the exclusive lock on target/, which surfaces as
 *                        random multi-second stalls with no obvious cause.
 *
 *   procMacro: true      Tempting to disable, since proc macros must be
 *                        compiled to dylibs before anything can expand them.
 *                        Do not: every #[derive]-generated impl and
 *                        #[tokio::main] simply ceases to exist for name
 *                        resolution, and traces terminate early at derive
 *                        boundaries while looking like legitimate answers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type {
  InitializeResult,
  Location,
  Position,
  ServerCapabilities,
} from "vscode-languageserver-protocol";

/** LSP `ContentModified`: the server's state moved while it was answering. */
const CONTENT_MODIFIED = -32801;

export type Readiness = "starting" | "indexing" | "ready" | "failed";

export interface LspOptions {
  /** Workspace root. Must be canonical. */
  root: string;
  command?: string;
  /** Isolate from the editor's target/ so cargo's exclusive lock is never contended. */
  targetDir?: string;
}

export class RustAnalyzer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: MessageConnection | null = null;
  private capabilities: ServerCapabilities | null = null;
  private state: Readiness = "starting";
  private readyWaiters: Array<() => void> = [];

  constructor(private readonly opts: LspOptions) {}

  get readiness(): Readiness {
    return this.state;
  }

  /**
   * Queries that need name resolution must wait; reads must not. READ never
   * calls this — it needs file bytes and at most a parse, so the agent can be
   * reading code seconds after start while the index is still building.
   */
  async whenReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "failed") throw new Error("rust-analyzer failed to start");
    await new Promise<void>((res) => this.readyWaiters.push(res));
  }

  async start(): Promise<void> {
    const command = this.opts.command ?? "rust-analyzer";
    const proc = spawn(command, [], {
      cwd: this.opts.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.opts.targetDir === undefined
          ? {}
          : { CARGO_TARGET_DIR: this.opts.targetDir }),
      },
    });
    this.proc = proc;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      // Worth keeping: a crash costs a full cold re-index, so knowing why it
      // died matters more than it would for a cheaply-restartable process.
      process.stderr.write(`[rust-analyzer] ${chunk}`);
    });

    proc.once("exit", (code) => {
      this.state = "failed";
      process.stderr.write(`[rust-analyzer] exited: ${code}\n`);
    });

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.conn = conn;

    // A server emits several progress sequences — fetching metadata, building
    // proc macros, then indexing — so the first `end` is emphatically not
    // "ready". Progress only ever moves us to `indexing` here; it is a
    // liveness signal, not a completion one.
    conn.onNotification("$/progress", (params: { value?: { kind?: string } }) => {
      const kind = params?.value?.kind;
      if (kind === "begin" && this.state !== "ready") {
        this.transition("indexing", "progress begin");
      }
    });

    // serverStatus is the only signal that actually means quiescent, which is
    // why the experimental capability is worth declaring rather than trying to
    // infer completion from progress tokens.
    conn.onNotification(
      "experimental/serverStatus",
      (params: { quiescent?: boolean; health?: string }) => {
        if (params?.health === "error") {
          this.transition("failed", "serverStatus health=error");
          return;
        }
        if (params?.quiescent === true) this.markReady();
      },
    );

    if (process.env.FLUENT_LSP_TRACE !== undefined) {
      const seen = new Set<string>();
      conn.onNotification((method: string) => {
        if (seen.has(method)) return;
        seen.add(method);
        process.stderr.write(`[lsp-trace] notification: ${method}\n`);
      });
    }

    conn.listen();

    const result = (await conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.opts.root),
      workspaceFolders: [{ uri: pathToUri(this.opts.root), name: "workspace" }],
      capabilities: {
        // Ask for UTF-8 so positions are byte offsets end to end. Without
        // this, LSP positions count UTF-16 code units while tree-sitter counts
        // UTF-8 bytes, and any line with a non-ASCII character before the
        // column of interest silently misaligns.
        general: { positionEncodings: ["utf-8", "utf-16"] },
        // Both readiness signals are opt-in, and neither is sent to a client
        // that did not ask. Omit them and the server indexes perfectly well
        // while we sit at "starting" forever — so whenReady() never resolves
        // and every query that needs name resolution deadlocks.
        window: { workDoneProgress: true },
        experimental: { serverStatusNotification: true },
        textDocument: {
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true, symbol: {} },
      },
      initializationOptions: {
        checkOnSave: false,
        procMacro: { enable: true },
        cargo: {
          buildScripts: { enable: true },
          ...(this.opts.targetDir === undefined ? {} : { targetDir: this.opts.targetDir }),
        },
      },
    })) as InitializeResult;

    this.capabilities = result.capabilities;
    await conn.sendNotification("initialized", {});
  }

  /** utf-8 if the server accepted it, utf-16 otherwise. Convert at the boundary. */
  get positionEncoding(): "utf-8" | "utf-16" {
    return this.capabilities?.positionEncoding === "utf-8" ? "utf-8" : "utf-16";
  }

  async references(uri: string, position: Position): Promise<Location[]> {
    await this.whenReady();
    const res = await this.settled(() =>
      this.require().sendRequest("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: false },
      }),
    );
    return (res as Location[] | null) ?? [];
  }

  async definition(uri: string, position: Position): Promise<Location[]> {
    await this.whenReady();
    const res = await this.settled(() =>
      this.require().sendRequest("textDocument/definition", {
        textDocument: { uri },
        position,
      }),
    );
    if (res === null || res === undefined) return [];
    return Array.isArray(res) ? (res as Location[]) : [res as Location];
  }

  /**
   * Retry through `ContentModified`.
   *
   * We announce every disk change we observe, and the server answers -32801
   * while its own state is still settling. That is a race any external write
   * can open — an editor saving, a `git checkout`, another agent — not a test
   * artefact, and the failure is a hard error on a request that would have
   * succeeded a moment later. Waiting is free here; being wrong is not.
   */
  private async settled<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (cause) {
        const code = (cause as { code?: number }).code;
        if (code !== CONTENT_MODIFIED || attempt >= 4) throw cause;
        await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
      }
    }
  }

  /**
   * Disk changes rust-analyzer did not make must be announced, or its snapshot
   * drifts from ours — and a translation between two views of one file is only
   * sound when both describe the same bytes.
   */
  async didChangeWatched(uri: string, type: 1 | 2 | 3): Promise<void> {
    await this.require().sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri, type }],
    });
  }

  async stop(): Promise<void> {
    if (this.conn === null || this.proc === null) return;
    try {
      await this.conn.sendRequest("shutdown");
      await this.conn.sendNotification("exit");
    } catch {
      // Already gone.
    }
    this.proc.kill();
    await once(this.proc, "exit").catch(() => undefined);
  }

  private markReady(): void {
    if (this.state === "ready") return;
    this.transition("ready", "quiescent");
    for (const wake of this.readyWaiters) wake();
    this.readyWaiters = [];
  }

  /** Logged because a crash costs a full cold re-index; knowing how the
   *  server got to a state is worth the two lines it takes to record. */
  private transition(next: Readiness, why: string): void {
    if (this.state === next) return;
    process.stderr.write(`[lsp] ${this.state} -> ${next} (${why})\n`);
    this.state = next;
  }

  private require(): MessageConnection {
    if (this.conn === null) throw new Error("rust-analyzer not started");
    return this.conn;
  }
}

export function pathToUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}
