/**
 * REFS — references to a symbol. Blocks on the index; this is the operation
 * that genuinely needs name resolution, so it is where cold start shows up.
 *
 * Resolution rule, which is not simply "one token in the span":
 *
 *   declaration node  -> its own name. A handle to `fn Panel::render` holds
 *                        dozens of identifiers, but the obvious reading is
 *                        references to `render`; enumerating its body would
 *                        be useless.
 *   anything else     -> enumerate the distinct symbols inside it, deduped by
 *                        resolved symbol rather than by occurrence.
 *
 * Never cache a result and edit from it. References are a semantic claim, and
 * a handle only asserts byte identity — a shadowing binding inserted between
 * the query and the edit leaves every byte untouched while changing what the
 * symbol means. Re-run against current state instead.
 */

import type { Reply } from "../../shared/protocol.js";
import type { Workspace } from "../workspace.js";

export interface RefsArgs {
  target: string;
}

export async function refs(_ws: Workspace, _args: RefsArgs): Promise<Reply> {
  // TODO: resolve the address to a position, then textDocument/references.
  //
  // One textDocument/definition call covers the whole result set rather than
  // one per hit — every reference resolves to the same declaration by
  // construction, which is what makes them references to the same symbol.
  //
  // On ambiguity emit "ambiguous" as the first line, then one representative
  // hit per candidate symbol in the ordinary Hits format, so a follow-up call
  // with one of those handles is unambiguous.
  throw new Error("refs: not implemented");
}
