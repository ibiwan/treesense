/**
 * Dependency and witness/recheck machinery shared by EDIT and MOVE.
 *
 * A dep is a handle whose *unchanged-ness* a write's correctness rests on,
 * without the write itself touching it. Validated once against the pre-write
 * snapshot; witnessed generations are re-checked immediately before the
 * write that depends on them — closing the window at both ends, per
 * DESIGN.md § 3.
 */

import { parseAddress } from "../shared/address.js";
import type { FilePath, Full, Generation, Handle } from "../shared/types.js";
import type { ResolveStatus } from "./handles.js";
import type { Workspace } from "./workspace.js";

export interface DepVerdict {
  handle: Handle;
  verdict: "ok" | "changed" | "gone" | "unknown";
  replacement: Handle | null;
  file: FilePath | null;
  /**
   * The file generation this verdict was reached against — carried, not
   * re-derived, so `witness` never has to ask disk a second question whose
   * answer might differ from the one the verdict rests on.
   */
  generation: Generation | null;
}

function resolvedFull(resolved: ResolveStatus): Full | null {
  switch (resolved.status) {
    case "ok":
    case "changed":
      return resolved.full;
    case "gone":
      return resolved.was;
    case "unknown":
      return null;
  }
}

/** A resolved handle's verdict, in the same shape a dep's would take. */
export function toVerdict(handle: Handle, resolved: ResolveStatus): DepVerdict {
  const full = resolvedFull(resolved);
  return {
    handle,
    verdict: resolved.status,
    replacement: resolved.status === "changed" ? resolved.full.handle : null,
    file: full?.file ?? null,
    // `gone` carries the *entry's* stale generation, which is not a witness of
    // anything current. Only a verdict that actually validated may vouch for a
    // generation; the rest fall back to a read in `witness`.
    generation: resolved.status === "gone" ? null : (full?.generation ?? null),
  };
}

export async function validateDeps(ws: Workspace, deps: string[]): Promise<DepVerdict[]> {
  const out: DepVerdict[] = [];
  for (const raw of deps) {
    const address = parseAddress(raw);
    if (address.form !== "handle") {
      out.push({
        handle: raw as Handle,
        verdict: "unknown",
        replacement: null,
        file: null,
        generation: null,
      });
      continue;
    }
    out.push(toVerdict(address.handle, await ws.handles.resolve(address.handle)));
  }
  return out;
}

/**
 * One report line per non-ok verdict; empty for a clean set. Shared wording
 * for `edit`'s dep rejections and `move`'s partial reports, because the two
 * situations a caller finds themselves in are identical: CHANGED means
 * re-read and retry, GONE means the plan itself needs revisiting.
 */
export function verdictLines(verdicts: readonly DepVerdict[]): string[] {
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.verdict === "ok") continue;
    lines.push(
      v.verdict === "changed"
        ? `${v.handle} CHANGED  now ${v.replacement} — re-read, then retry`
        : `${v.handle} ${v.verdict.toUpperCase()} — re-plan`,
    );
  }
  return lines;
}

/**
 * Anything already validated or already read, vouching for the generation it
 * was validated or read *at*. `Full` satisfies this, and so does a
 * `FileSnapshot` — which is the point: both are things a caller is already
 * holding.
 */
export interface Witnessed {
  file: FilePath;
  generation: Generation;
}

/**
 * Witness the generation of every file this write's correctness rests on.
 *
 * Takes generations the caller already established rather than reading them
 * again, and that distinction is the whole guarantee. `FileRegistry.snapshot`
 * is read-through with a live `stat` on every call, so a witness that
 * re-snapshots is a *second* look at disk: a write landing between the first
 * look and the second is absorbed into the witness itself, and the recheck
 * before commit then compares the new generation against the new generation
 * and passes — while the bytes about to be written were spliced from the old
 * buffer. Witnessing what was actually validated makes that window
 * zero-width by construction instead of merely narrow.
 *
 * The *lowest* generation wins when two participants disagree about one file.
 * Disagreement means the file moved between their two validations, so one of
 * them is already reasoning about a world that no longer exists; the earlier
 * stamp is the one that makes `recheck` say so.
 */
export async function witness(
  ws: Workspace,
  held: readonly Witnessed[],
  deps: readonly DepVerdict[],
): Promise<Map<FilePath, Generation>> {
  const out = new Map<FilePath, Generation>();
  const record = (file: FilePath, generation: Generation): void => {
    const prior = out.get(file);
    if (prior === undefined || generation < prior) out.set(file, generation);
  };

  for (const { file, generation } of held) record(file, generation);
  for (const dep of deps) {
    if (dep.file === null) continue;
    // A verdict that could not vouch for a generation (a `gone` dep) still
    // names a file the write may touch, so fall back to a read for that one.
    record(dep.file, dep.generation ?? (await ws.files.snapshot(dep.file)).generation);
  }
  return out;
}

/** The first file that moved since it was witnessed, or null if none did. */
export async function recheck(
  ws: Workspace,
  witnessed: Map<FilePath, Generation>,
): Promise<string | null> {
  for (const [file, generation] of witnessed) {
    const now = await ws.files.snapshot(file).catch(() => null);
    if (now === null || now.generation !== generation) return file;
  }
  return null;
}
