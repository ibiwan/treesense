/**
 * TRACE — naive value flow through the call chain. Blocks on the index.
 *
 * This is the only verb nothing off the shelf already does, and it needs no
 * new engine: references, plus definition, plus a tree-walk, in a loop.
 *
 *   forward: for each use, if the symbol is passed as a BARE IDENTIFIER
 *            argument, resolve the callee, match the parameter by position,
 *            and recurse from there.
 *   back:    the same machinery inverted — references on a parameter,
 *            filtered to call sites, taking the argument at that position.
 *            Often the more useful direction in practice ("where does this
 *            timeout actually come from?").
 *
 * The requirement that makes it trustworthy: EVERY terminated branch states
 * why it stopped. A branch that halted at a macro must never be
 * indistinguishable from one that genuinely ended, because the caller reads a
 * short tree as a complete answer either way.
 *
 * Out of scope by design, and visibly so in the output rather than by
 * omission: aliasing through references, flow via struct fields, closure
 * captures, and trait dispatch where the impl is not statically known. Those
 * need real dataflow over MIR — the flowistry tier, deferred.
 */

import type { Reply } from "../../shared/protocol.js";
import type { Workspace } from "../workspace.js";

export interface TraceArgs {
  target: string;
  maxUp: number;
  maxDown: number;
}

export async function trace(_ws: Workspace, _args: TraceArgs): Promise<Reply> {
  // TODO: breadth-first with a visited set keyed by (file, byte range) so
  // recursion and mutual recursion terminate as `cycle` rather than hanging.
  //
  // A trace is an inference, not an enumeration: unlike a reference list,
  // where each entry stands or falls alone, its conclusion depends on every
  // link holding simultaneously. So capture the workspace generation on entry
  // and re-check on exit — a file changing mid-walk can make the result
  // structurally wrong in a way no individual handle failure reveals.
  throw new Error("trace: not implemented");
}
