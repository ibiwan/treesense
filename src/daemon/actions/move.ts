/**
 * MOVE — relocate a handle's bytes to sit before or after another handle.
 *
 * Same-file and cross-file are mechanically different, not just different in
 * scope:
 *
 *   Same-file   one atomic write (temp-and-rename), built from two splices
 *               against one buffer — a delete at the source, an insert at
 *               the destination.
 *   Cross-file  no atomicity across the pair is possible without a journal
 *               (same reason `edit` takes a single target — see edit.ts).
 *               Cross-file matters more than that guarantee, so this writes
 *               the destination *first*: worst case on a partial failure is
 *               a visible duplicate, never a lost source.
 *
 * See REVIEW_NOTES.md for the design discussion this converged from.
 */

import { rename, stat, writeFile } from "node:fs/promises";

import { parseAddress } from "../../shared/address.js";
import { handlePlus } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { ByteRange, Full, Handle } from "../../shared/types.js";
import { build, outcome } from "./edit.js";
import { toVerdict, validateDeps, verdictLines, witness, recheck, type DepVerdict } from "../deps.js";
import { locate, mint, type Located } from "../locate.js";
import { languageFor, parse } from "../syntax.js";
import type { ResolveStatus } from "../handles.js";
import type { Workspace } from "../workspace.js";

export interface MoveArgs {
  source: string;
  destination: string;
  action: "insert-before" | "insert-after";
  deps: string[];
}

export async function move(ws: Workspace, args: MoveArgs): Promise<Reply> {
  const sourceAddr = parseAddress(args.source);
  if (sourceAddr.form !== "handle") return fail(`move source takes a handle, not ${args.source}`);
  const destAddr = parseAddress(args.destination);
  if (destAddr.form !== "handle") {
    return fail(`move destination takes a handle, not ${args.destination}`);
  }

  // ---- Phase 1: validate, touching nothing ---------------------------------
  const sourceResolved = await ws.handles.resolve(sourceAddr.handle);
  if (sourceResolved.status !== "ok") {
    return fail(describeFailure(sourceAddr.handle, sourceResolved, "source"));
  }
  const destResolved = await ws.handles.resolve(destAddr.handle);
  if (destResolved.status !== "ok") {
    return fail(describeFailure(destAddr.handle, destResolved, "destination"));
  }

  const deps = await validateDeps(ws, args.deps);
  if (deps.some((d) => d.verdict !== "ok")) {
    const lines = [
      "move rejected: premise changed",
      `${sourceAddr.handle} source ok`,
      `${destAddr.handle} destination ok`,
      ...verdictLines(deps),
    ];
    return { ok: false, text: lines.join("\n") };
  }

  const source = sourceResolved.full;
  const destination = destResolved.full;

  return source.file === destination.file
    ? moveSameFile(ws, source, destination, args, deps)
    : moveCrossFile(ws, source, destination, args, deps);
}

function describeFailure(
  handle: Handle,
  resolved: Exclude<ResolveStatus, { status: "ok" }>,
  role: string,
): string {
  switch (resolved.status) {
    case "unknown":
      return `${role} ${handle} unknown — handles die with the daemon; re-query`;
    case "gone":
      return `${role} ${handle} gone — its node no longer exists; re-plan`;
    case "changed":
      return `${role} ${handle} changed since issue — re-read ${resolved.full.handle} before moving`;
  }
}

function splice(content: Buffer, range: ByteRange, text: string): Buffer {
  return Buffer.concat([content.subarray(0, range.start), Buffer.from(text, "utf8"), content.subarray(range.end)]);
}

async function moveSameFile(
  ws: Workspace,
  source: Full,
  destination: Full,
  args: MoveArgs,
  deps: DepVerdict[],
): Promise<Reply> {
  const located = await locate(ws, source.file);
  if (located === null) return fail(`no grammar for ${source.file}`);
  const { snap } = located;

  const point = args.action === "insert-before" ? destination.bytes.start : destination.bytes.end;

  // Geometric, not identity-based: any handle's boundary can coincide with
  // source's, not just the destination handle's own. Strictly inside means no
  // coherent order exists; exactly on a boundary means deleting and
  // reinserting the same bytes reconstructs the file, at either edge.
  if (point > source.bytes.start && point < source.bytes.end) {
    return fail("destination lands inside the source being moved");
  }
  if (point === source.bytes.start || point === source.bytes.end) {
    return { ok: true, text: `${handlePlus(source, { withPath: true, root: ws.root })} unchanged — destination is adjacent to source` };
  }

  // Both participants vouch for the generation their own phase-1 validation
  // ran against, so this asks disk nothing — which is the point: `locate`
  // above already took its own fresh look, and a witness that took a third
  // would stamp whatever landed in between and let it through. Source and
  // destination were resolved one after the other; if they disagree the file
  // moved between those two checks, and the lower stamp is what makes
  // `recheck` refuse.
  const witnessed = await witness(ws, [source, destination], deps);

  const movedText = snap.content.subarray(source.bytes.start, source.bytes.end).toString("utf8");
  const insertSplice = build(snap.content, destination, args.action, movedText);
  const deleteSplice = build(snap.content, source, "delete", "");

  // Apply the rightmost-original-position splice first: its coordinates are
  // still valid against the buffer exactly as captured, because nothing to
  // its left has moved yet by the time its turn comes. The same order is
  // reused below for the handle table, via two ordered calls to the existing
  // single-range rebase — no new primitive needed. See REVIEW_NOTES.md.
  const insertIsRightmost = insertSplice.range.start > deleteSplice.range.start;
  const first = insertIsRightmost ? insertSplice : deleteSplice;
  const second = insertIsRightmost ? deleteSplice : insertSplice;

  let content = splice(snap.content, first.range, first.text);
  content = splice(content, second.range, second.text);

  // The introduced content's final offset. `build` computed it relative to
  // the pristine buffer; it only needs adjusting when delete lands *after*
  // insert in application order, since delete then shifts what was just
  // placed to its left.
  const contentAt =
    first === insertSplice
      ? insertSplice.contentAt - (deleteSplice.range.end - deleteSplice.range.start)
      : insertSplice.contentAt;
  const contentEnd = contentAt + (insertSplice.contentEnd - insertSplice.contentAt);

  const lang = languageFor(source.file);
  if (lang !== null && parse(content, lang).hasParseError()) {
    if (!parse(snap.content, lang).hasParseError()) {
      return fail("relocated content does not parse; nothing written");
    }
  }

  const drifted = await recheck(ws, witnessed);
  if (drifted !== null) {
    return fail(`${drifted} changed while the move was being prepared; nothing written`);
  }

  const temp = `${source.file}.fluent-${process.pid}.tmp`;
  try {
    await writeFile(temp, content);
    await rename(temp, source.file);
  } catch (cause) {
    return fail(`write failed: ${(cause as Error).message}`);
  }

  const { mtimeMs } = await stat(source.file);
  const generation = ws.files.commit(source.file, content, mtimeMs);

  const r1 = ws.handles.rebase(source.file, first.range, Buffer.byteLength(first.text, "utf8"), generation);
  const r2 = ws.handles.rebase(source.file, second.range, Buffer.byteLength(second.text, "utf8"), generation);

  return report(ws, source.file, source.handle, contentAt, contentEnd, args.action, [...r1.killed, ...r2.killed]);
}

async function moveCrossFile(
  ws: Workspace,
  source: Full,
  destination: Full,
  args: MoveArgs,
  deps: DepVerdict[],
): Promise<Reply> {
  const destLocated = await locate(ws, destination.file);
  if (destLocated === null) return fail(`no grammar for ${destination.file}`);
  const sourceLocated = await locate(ws, source.file);
  if (sourceLocated === null) return fail(`no grammar for ${source.file}`);

  // Both files, not just destination. `movedText` below is copied from source
  // into destination's own payload, so source's freshness is as load-bearing
  // to this write as destination's is; checking it only via the source
  // handle's digest (phase 1, above) is not enough, because a digest match
  // tolerates any change elsewhere in the file. The recheck before the write
  // has to answer a stricter question: did *this exact snapshot*, the one
  // `movedText` was sliced from, survive intact all the way to the write.
  //
  // Which is why these are the generations phase 1 validated against rather
  // than a fresh pair of reads. The two `locate` calls above already looked at
  // disk; a witness that looked a third time would absorb anything that landed
  // between look and look, and then agree with itself at commit. See
  // DESIGN.md § 3.
  const destWitness = await witness(ws, [destination, source], deps);

  const movedText = sourceLocated.snap.content.subarray(source.bytes.start, source.bytes.end).toString("utf8");
  const insertSplice = build(destLocated.snap.content, destination, args.action, movedText);
  const nextDest = splice(destLocated.snap.content, insertSplice.range, insertSplice.text);

  const destLang = languageFor(destination.file);
  if (destLang !== null && parse(nextDest, destLang).hasParseError()) {
    if (!parse(destLocated.snap.content, destLang).hasParseError()) {
      return fail("relocated content does not parse at destination; nothing written");
    }
  }

  // Bad here is still a clean, zero-write rejection, exactly like `edit`'s
  // phase 3 — nothing has been written yet.
  const destDrift = await recheck(ws, destWitness);
  if (destDrift !== null) {
    return fail(`${destDrift} changed while the move was being prepared; nothing written`);
  }

  const destTemp = `${destination.file}.fluent-${process.pid}.tmp`;
  try {
    await writeFile(destTemp, nextDest);
    await rename(destTemp, destination.file);
  } catch (cause) {
    return fail(`write failed: ${(cause as Error).message}`);
  }
  const { mtimeMs: destMtime } = await stat(destination.file);
  const destGen = ws.files.commit(destination.file, nextDest, destMtime);
  const { killed: destKilled } = ws.handles.rebase(
    destination.file,
    insertSplice.range,
    Buffer.byteLength(insertSplice.text, "utf8"),
    destGen,
  );

  const freshDest = await locate(ws, destination.file);
  const introduced = freshDest === null ? [] : outcome(freshDest, insertSplice, args.action);
  const newHandle = freshDest !== null && introduced.length > 0 ? mint(ws, freshDest, introduced[0]!) : null;
  const inserted = newHandle === null ? `${destination.file} ok` : handlePlus(newHandle, { withPath: true, root: ws.root });

  // The destination write already landed — from here on, a bad verdict is a
  // *partial* result, not a clean rejection. No automatic reversal write is
  // attempted: reversing a completed write is itself a fresh risky write, not
  // a refusal, and the report is the recovery path instead.
  const sourceRecheck = await ws.handles.resolve(source.handle);
  const depsRecheck = await validateDeps(ws, args.deps);
  const failingDeps = depsRecheck.filter((v) => v.verdict !== "ok");

  if (sourceRecheck.status !== "ok" || failingDeps.length > 0) {
    const failing =
      sourceRecheck.status !== "ok" ? [toVerdict(source.handle, sourceRecheck), ...failingDeps] : failingDeps;
    return { ok: false, text: [`move partial: inserted ${inserted}`, ...verdictLines(failing)].join("\n") };
  }

  const finalSource = sourceRecheck.full;
  const finalSourceLocated = await locate(ws, source.file);
  if (finalSourceLocated === null) return fail(`no grammar for ${source.file}`);

  // The same two-looks gap once more, and this is the worst place for it: the
  // splice below deletes `finalSource.bytes`, a range validated against the
  // resolve above, out of a buffer `locate` read separately. If a write landed
  // between them the coordinates address the wrong bytes, and this is the one
  // destructive write in the verb. Cheap to refuse, and refusing is a partial
  // result rather than a failure — the destination copy already exists, so
  // nothing is lost by leaving the source in place.
  if (finalSourceLocated.snap.generation !== finalSource.generation) {
    return {
      ok: false,
      text: [
        `move partial: inserted ${inserted}`,
        `${source.file} changed before the source could be removed — delete it by hand or re-query`,
      ].join("\n"),
    };
  }

  const deleteSplice = build(finalSourceLocated.snap.content, finalSource, "delete", "");
  const nextSource = splice(finalSourceLocated.snap.content, deleteSplice.range, deleteSplice.text);

  const sourceTemp = `${source.file}.fluent-${process.pid}.tmp`;
  try {
    await writeFile(sourceTemp, nextSource);
    await rename(sourceTemp, source.file);
  } catch (cause) {
    return {
      ok: false,
      text: [`move partial: inserted ${inserted}`, `source delete failed: ${(cause as Error).message}`].join("\n"),
    };
  }
  const { mtimeMs: sourceMtime } = await stat(source.file);
  const sourceGen = ws.files.commit(source.file, nextSource, sourceMtime);
  const { killed: sourceKilled } = ws.handles.rebase(source.file, deleteSplice.range, 0, sourceGen);

  const killed = [...destKilled, ...sourceKilled].filter(
    (h) => h !== source.handle && (newHandle === null || h !== newHandle.handle),
  );
  const lines = [inserted];
  if (killed.length > 0) lines.push(`invalidated ${killed.join(" ")}`);
  return { ok: true, text: lines.join("\n") };
}

/** Shared report shape for the same-file success path. */
async function report(
  ws: Workspace,
  file: Full["file"],
  sourceHandle: Handle,
  contentAt: number,
  contentEnd: number,
  action: MoveArgs["action"],
  killedRaw: Handle[],
): Promise<Reply> {
  const fresh: Located | null = await locate(ws, file);
  const introduced = fresh === null ? [] : outcome(fresh, { contentAt, contentEnd }, action);
  const summary =
    fresh === null || introduced.length === 0
      ? `${file} ok`
      : handlePlus(mint(ws, fresh, introduced[0]!), { withPath: true, root: ws.root });

  const killed = killedRaw.filter((h) => h !== sourceHandle);
  const lines = [summary];
  if (killed.length > 0) lines.push(`invalidated ${killed.join(" ")}`);
  return { ok: true, text: lines.join("\n") };
}

function fail(message: string): Reply {
  return { ok: false, text: `error: ${message}` };
}
