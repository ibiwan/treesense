/**
 * FIND — search. Returns hits, never candidates.
 *
 * Hits and candidates answer different questions. A search asks "what
 * matches?", and any cardinality is a complete answer — zero means nothing
 * matches, which is information. Candidates report a *failed resolution*:
 * one specific thing was named and the address did not land uniquely. So
 * candidates have cardinality 2..n by construction, and only the operations
 * that take an address can produce them.
 */

import type { Reply } from "../../shared/protocol.js";
import type { Workspace } from "../workspace.js";

export interface FindArgs {
  needle: string;
  haystack?: string | undefined;
}

export async function find(_ws: Workspace, _args: FindArgs): Promise<Reply> {
  // TODO: dispatch on the needle's shape rather than taking a mode parameter,
  // and state the interpretation used in the response header — a misread then
  // costs one line instead of a round trip.
  //
  // Hits group by (file, enclosing item) so the item handle amortises across
  // every hit inside it. The enclosing function is what the caller wants next
  // in the overwhelming majority of cases, so front-loading it collapses the
  // common path from three calls to two.
  //
  // Hit handles must point at the *matched token*, not the enclosing line:
  // a hit's purpose is to be a symbol occurrence, and that is what makes
  // refs-on-a-hit exact instead of ambiguous.
  throw new Error("find: not implemented");
}
