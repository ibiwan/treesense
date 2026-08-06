/**
 * EDIT — validate everything, then apply. Never apply-then-check.
 *
 * The ordering is not a robustness preference, it is the only correct one:
 * checking a dependency after an earlier write has landed validates it
 * against a world its author never saw.
 *
 * Phases:
 *   1. Validate the target (generation, digest, and kind/symbol as a
 *      cross-check) and every dep's digest, against the pre-edit snapshot.
 *      Read-only, microseconds, no side effects.
 *   2. Apply bottom-up by byte offset so earlier offsets stay valid.
 *   3. Bump the file's generation only after the write succeeds — bumping
 *      during validation would invalidate handles for an edit that may not land.
 *   4. Rebase surviving handles across the delta; report which died.
 *
 * Deps are compared by *content digest*, not position. A dep that merely
 * shifted because of an earlier edit still holds its premise, and rejecting
 * it would mean a multi-edit sequence never converges: every edit would
 * invalidate every dep below it.
 */

import type { Reply } from "../../shared/protocol.js";
import type { EditAction } from "../../shared/types.js";
import type { Workspace } from "../workspace.js";

export interface EditArgs {
  target: string;
  action: EditAction;
  deps: string[];
  content: string;
}

export async function edit(_ws: Workspace, _args: EditArgs): Promise<Reply> {
  // TODO: implement the four phases above.
  //
  // Rejection must distinguish three per-dep outcomes, because the caller's
  // next move differs sharply: shifted (no action), CHANGED (re-read, then
  // retry), GONE (do not retry — the node the plan depended on is deleted, so
  // the plan itself needs revisiting).
  //
  // Indentation is derived from the surrounding buffer, never from the
  // incoming text: dedent the replacement to its own minimum, then re-indent
  // continuation lines to the target's base indent. That works for minified
  // input, for multiple statements on one line, and for Python — where it
  // happens to be exactly the required semantics.
  //
  // Parse the replacement before committing. Rejecting a block that yields
  // ERROR nodes costs microseconds and stops an unbalanced brace from landing
  // on disk, where it resurfaces later as confusing name-resolution failures
  // rather than as the syntax error it actually is.
  //
  // Write via temp-file-and-rename for per-file atomicity. Cross-file atomicity
  // is not achievable without a journal; report exactly which files landed.
  throw new Error("edit: not implemented");
}
