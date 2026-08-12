/**
 * typescript-language-server client — the TypeScript half of the language
 * seam. Everything here follows from empirical findings recorded in
 * PLAN.md's "Language profile — TypeScript" section; read that first if a
 * choice here looks arbitrary.
 *
 * Three things make this client shaped differently from RustAnalyzer:
 *
 *   useSyntaxServer: "never"   typescript-language-server races a fast
 *                              syntax-only tsserver against the real
 *                              (semantic) one. The syntax server's project is
 *                              a throwaway single-file `Inferred` project, so
 *                              a request it wins answers with a well-formed,
 *                              silently wrong empty result. Disabling it
 *                              forces every request through the real server.
 *
 *   open-on-demand              Unlike rust-analyzer, which indexes the whole
 *                                crate graph from disk with no "open" step,
 *                                tsserver only answers correctly about a file
 *                                it has been told is open via `didOpen` — an
 *                                unopened *query target* returns an empty
 *                                result, not an error. Files elsewhere in the
 *                                project do NOT need to be opened: once the
 *                                query's own file is open, tsserver searches
 *                                the whole configured project on its own.
 *
 *   didChange, only for opened   Once a file is open, tsserver trusts the
 *   files                        LSP-negotiated buffer over disk for it, so a
 *                                disk write needs `didChange` with real
 *                                content, not `didChangeWatchedFiles`. Every
 *                                *other* file — the common case — is watched
 *                                by tsserver itself (its own log shows a file
 *                                watcher registered per project file, open or
 *                                not), so no notification is needed there at
 *                                all.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { Location, Position } from "vscode-languageserver-protocol";

import type { LanguageProfile } from "../language-profile.js";
import {
  pathToUri,
  uriToPath,
  type IndexStatus,
  type LspClient,
  type Readiness,
  type WorkspaceSymbol,
} from "../lsp-client.js";
import { languageFor } from "../syntax.js";
import { walkSource } from "../walk.js";

export interface TypeScriptServerOptions {
  /** Workspace root. Must be canonical. */
  root: string;
  command?: string;
  /**
   * Pins a specific TypeScript install (a `tsserver.js` path or its
   * containing directory), bypassing typescript-language-server's own
   * workspace-then-bundled lookup. Mainly for pinning a `typescript@5.x`
   * install where the target project's own dependency is on `typescript@7`
   * (the tsgo/native-compiler rewrite), which ships no `tsserver.js` at all.
   */
  tsserverPath?: string;
}

function languageIdFor(path: string): string {
  const lang = languageFor(path);
  const isReact = path.endsWith("x");
  if (lang === "tsx") return "typescriptreact";
  if (lang === "typescript") return isReact ? "typescriptreact" : "typescript";
  return isReact ? "javascriptreact" : "javascript";
}

export class TypeScriptServer implements LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: MessageConnection | null = null;
  private state: Readiness = "starting";
  /** uri -> version last sent. Absence means "not ours to keep in sync". */
  private readonly openDocs = new Map<string, number>();
  private bootstrapped: Promise<void> | null = null;

  constructor(private readonly opts: TypeScriptServerOptions) {}

  get readiness(): Readiness {
    return this.state;
  }

  /**
   * There is no push signal analogous to rust-analyzer's `quiescent` — no
   * `$/progress` sequence ties to project load at all. Readiness is implicit
   * in request latency instead: the first semantic request against an opened
   * file blocks until the project is loaded, then answers correctly. So this
   * is a snapshot of "has start() finished," nothing more.
   */
  get indexStatus(): IndexStatus {
    return { readiness: this.state };
  }

  /** typescript-language-server never negotiates `positionEncoding`; it is always UTF-16. */
  get positionEncoding(): "utf-8" | "utf-16" {
    return "utf-16";
  }

  /**
   * Nothing to wait for beyond the process having started — see
   * `indexStatus`. Kept as a real method, not a stub, so a failed start still
   * surfaces here the way RustAnalyzer's does.
   */
  async whenReady(): Promise<void> {
    if (this.state === "failed") throw new Error("typescript-language-server failed to start");
  }

  async start(): Promise<void> {
    const command = this.opts.command ?? "typescript-language-server";
    const proc = spawn(command, ["--stdio"], {
      cwd: this.opts.root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[typescript-language-server] ${chunk}`);
    });
    proc.once("exit", (code) => {
      this.state = "failed";
      process.stderr.write(`[typescript-language-server] exited: ${code}\n`);
    });

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.conn = conn;

    // Server-to-client requests are rare but real (window/workDoneProgress/
    // create, for background work unrelated to project-load readiness — see
    // PLAN.md, there is no progress sequence tied to it worth tracking). An
    // unhandled one doesn't just fail the request: vscode-jsonrpc auto-rejects
    // it, and that unhandled rejection crashed the whole server process in
    // testing. A blanket null answer is always a valid response to a request
    // this client doesn't otherwise care about.
    conn.onRequest(() => null);
    conn.listen();

    // The result carries capabilities, but nothing here reads them:
    // typescript-language-server never negotiates `positionEncoding` (always
    // UTF-16 — see the `positionEncoding` getter), and there is no other
    // capability this client varies its behavior on. `window.workDoneProgress`
    // is deliberately not declared — nothing here needs it, and declaring it
    // is what invites the request above in the first place.
    await conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.opts.root),
      workspaceFolders: [{ uri: pathToUri(this.opts.root), name: "workspace" }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: false },
          references: {},
        },
        workspace: { workspaceFolders: true, symbol: {} },
      },
      initializationOptions: {
        tsserver: {
          useSyntaxServer: "never",
          ...(this.opts.tsserverPath === undefined ? {} : { path: this.opts.tsserverPath }),
        },
      },
    });
    await conn.sendNotification("initialized", {});

    // Nothing left to wait for; see indexStatus/whenReady.
    this.state = "ready";

    // Fire-and-forget: workspace/symbol throws "No Project" until at least
    // one file has been opened, since that is what makes tsserver load the
    // configured project in the first place. References/definition don't
    // need this — they always open their own query target first — but a
    // symbolic-address lookup might be the very first call this client ever
    // gets. Not awaited: start() must not block the daemon's socket on it,
    // same reasoning as rust-analyzer's index warm-up.
    this.bootstrapped = this.bootstrapProject().catch(() => {});
  }

  private async bootstrapProject(): Promise<void> {
    const { files } = await walkSource(this.opts.root, { maxFiles: 200 });
    const anchor = files.find((f) => {
      const lang = languageFor(f);
      return lang === "typescript" || lang === "tsx" || lang === "javascript";
    });
    if (anchor !== undefined) await this.ensureOpen(pathToUri(anchor));
  }

  /**
   * Open a file if this client hasn't already, so a query about a position
   * inside it gets a real answer instead of the empty result
   * typescript-language-server returns for an unopened query target.
   * Idempotent — safe to call before every semantic request.
   */
  private async ensureOpen(uri: string): Promise<void> {
    if (this.openDocs.has(uri)) return;
    let text: string;
    try {
      text = await readFile(uriToPath(uri), "utf8");
    } catch {
      return; // Gone or unreadable; the request itself will surface that.
    }
    this.openDocs.set(uri, 1);
    await this.require().sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdFor(uriToPath(uri)), version: 1, text },
    });
  }

  async references(uri: string, position: Position): Promise<Location[]> {
    await this.whenReady();
    await this.ensureOpen(uri);
    const res = await this.require().sendRequest("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: false },
    });
    return (res as Location[] | null) ?? [];
  }

  async definition(uri: string, position: Position): Promise<Location[]> {
    await this.whenReady();
    await this.ensureOpen(uri);
    const res = await this.require().sendRequest("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    if (res === null || res === undefined) return [];
    return Array.isArray(res) ? (res as Location[]) : [res as Location];
  }

  /**
   * Needs at least one file open (see `bootstrapProject`) or tsserver has no
   * project loaded yet and throws "No Project" outright.
   */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    await this.whenReady();
    if (this.bootstrapped !== null) await this.bootstrapped;
    const res = await this.require().sendRequest("workspace/symbol", { query });
    const symbols = (res as Array<{ name?: string; location?: Location }> | null) ?? [];
    return symbols.flatMap((symbol) =>
      symbol.name === undefined || symbol.location === undefined
        ? []
        : [{ name: symbol.name, location: symbol.location }],
    );
  }

  /**
   * A file this client never opened needs nothing — tsserver watches every
   * project file itself. A file it did open no longer trusts disk once open,
   * so this pushes the real content via `didChange` instead of the
   * `didChangeWatchedFiles` rust-analyzer client sends, which has no effect
   * on an already-open document.
   */
  async didChangeWatched(uri: string, type: 1 | 2 | 3): Promise<void> {
    const version = this.openDocs.get(uri);
    if (version === undefined) return;

    if (type === 3 /* Deleted */) {
      this.openDocs.delete(uri);
      await this.require().sendNotification("textDocument/didClose", { textDocument: { uri } });
      return;
    }

    let text: string;
    try {
      text = await readFile(uriToPath(uri), "utf8");
    } catch {
      return;
    }
    const next = version + 1;
    this.openDocs.set(uri, next);
    await this.require().sendNotification("textDocument/didChange", {
      textDocument: { uri, version: next },
      contentChanges: [{ text }],
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

  private require(): MessageConnection {
    if (this.conn === null) throw new Error("typescript-language-server not started");
    return this.conn;
  }
}

export interface TypeScriptProfileOptions {
  command?: string;
  tsserverPath?: string;
}

export function createTypeScriptProfile(opts: TypeScriptProfileOptions = {}): LanguageProfile {
  return {
    id: "typescript",
    createClient(root) {
      return new TypeScriptServer({
        root,
        ...(opts.command === undefined ? {} : { command: opts.command }),
        ...(opts.tsserverPath === undefined ? {} : { tsserverPath: opts.tsserverPath }),
      });
    },
  };
}
