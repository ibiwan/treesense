/**
 * The long-lived context. One per workspace root, shared by every client
 * session that attaches to this daemon.
 */

import { FileRegistry } from "./files.js";
import { HandleTable } from "./handles.js";
import { pathToUri, RustAnalyzer } from "./lsp.js";

export class Workspace {
  readonly files: FileRegistry;
  readonly handles: HandleTable;
  readonly lsp: RustAnalyzer;

  constructor(readonly root: string, targetDir?: string) {
    this.files = new FileRegistry(root);
    this.handles = new HandleTable(this.files);

    // A change we observed and rust-analyzer did not must be announced, or its
    // snapshot drifts from ours and every position translated between the two
    // silently stops meaning the same thing. `2` is LSP's `Changed`.
    this.files.onChange = (path) => {
      void this.lsp.didChangeWatched(pathToUri(path), 2).catch(() => {
        // Pre-initialize, or the server is down; the next query will surface it.
      });
    };
    this.lsp = new RustAnalyzer(
      targetDir === undefined ? { root } : { root, targetDir },
    );
  }

  /**
   * Start the index warming, but do not block on it. READ needs neither the
   * index nor a parse, so the agent can work while rust-analyzer is still
   * chewing through the dependency graph — only REFS and TRACE wait.
   */
  async start(): Promise<void> {
    await this.lsp.start();
  }

  async stop(): Promise<void> {
    await this.lsp.stop();
  }
}
