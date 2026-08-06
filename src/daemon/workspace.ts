/**
 * The long-lived context. One per workspace root, shared by every client
 * session that attaches to this daemon.
 */

import { FileRegistry } from "./files.js";
import { HandleTable } from "./handles.js";
import { qualifiedName } from "./locate.js";
import { pathToUri, RustAnalyzer } from "./lsp.js";
import { languageFor, parse } from "./syntax.js";

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

    // Relocation by identity, for changes we did not make and so cannot
    // rebase arithmetically. Only declarations are recoverable this way: a
    // local binding has no qualified name, and three `x`s in one function are
    // indistinguishable by anything but position — which is exactly what was
    // lost. Those correctly fall through to `gone`.
    this.handles.relocator = (entry, content) => {
      if (entry.qualified === null) return null;
      const lang = languageFor(entry.file);
      if (lang === null) return null;

      const tree = parse(content, lang);
      const matches = tree
        .items()
        .filter((item) => item.kind === entry.kind && qualifiedName(tree, item) === entry.qualified);

      // Ambiguity is not relocation. Two functions now sharing a qualified
      // name means we cannot say which one the handle meant.
      if (matches.length !== 1) return null;
      const item = matches[0]!;
      return {
        bytes: tree.itemRangeWithDocs(item),
        anchor: (item.nameNode ?? item).bytes.start,
      };
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
