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
import type { FilePath, Full, Handle } from "../shared/types.js";
import type { ResolveStatus } from "./handles.js";
import type { Workspace } from "./workspace.js";

export interface DepVerdict {
  handle: Handle;
  verdict: "ok" | "changed" | "gone" | "unknown";
  replacement: Handle | null;
  file: FilePath | null;
}

function resolvedFile(resolved: { status: string; full?: Full; was?: Full }): FilePath | null {
  return resolved.full?.file ?? resolved.was?.file ?? null;
}

/** A resolved handle's verdict, in the same shape a dep's would take. */
export function toVerdict(handle: Handle, resolved: ResolveStatus): DepVerdict {
  return {
    handle,
    verdict: resolved.status,
    replacement: resolved.status === "changed" ? resolved.full.handle : null,
    file: resolved.status === "unknown" ? null : resolvedFile(resolved),
  };
}

export async function validateDeps(ws: Workspace, deps: string[]): Promise<DepVerdict[]> {
  const out: DepVerdict[] = [];
  for (const raw of deps) {
    const address = parseAddress(raw);
    if (address.form !== "handle") {
      out.push({ handle: raw as Handle, verdict: "unknown", replacement: null, file: null });
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

/** Witness the generation of every file this write's correctness rests on. */
export async function witness(
  ws: Workspace,
  files: readonly FilePath[],
  deps: readonly DepVerdict[],
): Promise<Map<FilePath, number>> {
  const out = new Map<FilePath, number>();
  for (const file of files) out.set(file, (await ws.files.snapshot(file)).generation);
  for (const dep of deps) {
    if (dep.file === null || out.has(dep.file)) continue;
    out.set(dep.file, (await ws.files.snapshot(dep.file)).generation);
  }
  return out;
}

/** The first file that moved since it was witnessed, or null if none did. */
export async function recheck(ws: Workspace, witnessed: Map<FilePath, number>): Promise<string | null> {
  for (const [file, generation] of witnessed) {
    const now = await ws.files.snapshot(file).catch(() => null);
    if (now === null || now.generation !== generation) return file;
  }
  return null;
}
