import type { LspClient } from "./lsp-client.js";

/**
 * Everything that differs by target language, gathered behind one seam.
 * `Workspace` depends only on this — never on a concrete client — so adding a
 * language means adding a profile under `languages/`, not branching the
 * daemon.
 */
export interface LanguageProfile {
  readonly id: string;
  createClient(root: string): LspClient;
}
