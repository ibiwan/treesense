/**
 * EDIT — validate everything, then apply. Never apply-then-check.
 *
 * The ordering is not a robustness preference, it is the only correct one:
 * checking a dependency after an earlier write has landed validates it
 * against a world its author never saw.
 *
 * Phases:
 *   1. Validate the target and every dep against the pre-edit snapshot.
 *      Read-only, microseconds, no side effects.
 *   2. Build the new content and parse it. An unbalanced brace stopped here
 *      costs nothing; on disk it resurfaces later as confusing name-resolution
 *      failures rather than as the syntax error it actually is.
 *   3. Write, then bump the generation — never before, or a failed write would
 *      have invalidated every handle for an edit that never landed.
 *   4. Rebase surviving handles across the delta; report which died.
 *
 * Deps are compared by *content digest*, not position. A dep that merely
 * shifted because of an earlier edit still holds its premise, and rejecting
 * it would mean a multi-edit sequence never converges: every edit would
 * invalidate every dep below it.
 */

import { rename, stat, writeFile } from "node:fs/promises";

import { parseAddress } from "../../shared/address.js";
import { handlePlus } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { ByteRange, EditAction, FilePath, Full, Handle } from "../../shared/types.js";
import { baseIndent, reindent } from "../indent.js";
import { locate, mint, type Located } from "../locate.js";
import { languageFor, parse, type SyntaxNode } from "../syntax.js";
import type { Workspace } from "../workspace.js";

export interface EditArgs {
  target: string;
  action: EditAction;
  deps: string[];
  content: string;
}

export async function edit(ws: Workspace, args: EditArgs): Promise<Reply> {
  const address = parseAddress(args.target);
  if (address.form !== "handle") {
    // A position carries no generation and no digest, so a position-targeted
    // write is unchecked by construction — it would clobber whatever happens
    // to occupy those lines now.
    return fail(`edit takes a handle, not ${args.target}`);
  }

  // ---- Phase 1: validate, touching nothing ---------------------------------
  const target = await ws.handles.resolve(address.handle);
  switch (target.status) {
    case "unknown":
      return fail(`${address.handle} unknown — handles die with the daemon; re-query`);
    case "gone":
      return fail(`${address.handle} gone — its node no longer exists; re-plan`);
    case "changed":
      return fail(
        `${address.handle} changed since issue — re-read ${target.full.handle} before editing`,
      );
  }

  const deps = await validateDeps(ws, args.deps);
  if (deps.some((d) => d.verdict !== "ok")) {
    return { ok: false, text: rejection(address.handle, deps) };
  }

  const located = await locate(ws, target.full.file);
  const snap = located?.snap ?? (await ws.files.snapshot(target.full.file));

  // Everything validated above was validated against *some* snapshot; the
  // splice below is computed against *this* one. Record what each participant
  // looked like now, so the same question can be asked again at commit time.
  const witnessed = await witness(ws, target.full.file, deps);

  // ---- Phase 2: build and check --------------------------------------------
  const splice = build(snap.content, target.full, args);
  const next = Buffer.concat([
    snap.content.subarray(0, splice.range.start),
    Buffer.from(splice.text, "utf8"),
    snap.content.subarray(splice.range.end),
  ]);

  const lang = languageFor(target.full.file);
  if (lang !== null && parse(next, lang).hasParseError()) {
    // Only refuse if *we* broke it. A file already unparseable before the edit
    // would otherwise trap the caller in a state only an edit can escape.
    if (!parse(snap.content, lang).hasParseError()) {
      return fail("replacement does not parse; nothing written");
    }
  }

  // ---- Phase 3: re-verify, then write --------------------------------------
  // Validation happened against a snapshot; the bytes below are about to be
  // overwritten *now*. Between those two moments an editor may have saved, a
  // checkout may have landed, or another agent may have written — and we
  // cannot lock the working tree to prevent it. So ask again, immediately
  // before committing, and abort rather than write against a world the caller
  // never saw.
  //
  // The residual window is stat-to-rename, which POSIX gives no way to close:
  // there is no compare-and-swap rename. It is microseconds wide, and the
  // rename itself is atomic, so a reader still never sees a half-written file.
  const drifted = await recheck(ws, witnessed);
  if (drifted !== null) {
    return fail(`${drifted} changed while the edit was being prepared; nothing written`);
  }

  // Temp-and-rename gives per-file atomicity: a reader sees the old bytes or
  // the new ones, never half. Across files there is no equivalent without a
  // journal, which is why this verb takes a single target.
  const temp = `${target.full.file}.fluent-${process.pid}.tmp`;
  try {
    await writeFile(temp, next);
    await rename(temp, target.full.file);
  } catch (cause) {
    return fail(`write failed: ${(cause as Error).message}`);
  }

  const { mtimeMs } = await stat(target.full.file);
  const generation = ws.files.commit(target.full.file, next, mtimeMs);

  // ---- Phase 4: rebase and report ------------------------------------------
  const { killed } = ws.handles.rebase(
    target.full.file,
    splice.range,
    Buffer.byteLength(splice.text, "utf8"),
    generation,
  );

  const fresh = await locate(ws, target.full.file);
  const introduced = fresh === null ? null : outcome(fresh, splice.contentAt, args.action);
  const summary =
    fresh === null || introduced === null
      ? `${target.full.file}:${snap.index.lineAt(splice.contentAt)} ok`
      : handlePlus(mint(ws, fresh, introduced), { withPath: true });

  const dead = killed.filter((handle) => handle !== address.handle);
  const lines = [summary];
  if (dead.length > 0) {
    // Actionable rather than decorative: the caller is holding these and they
    // are now void.
    lines.push(`invalidated ${dead.join(" ")}`);
  }
  return { ok: true, text: lines.join("\n") };
}

/**
 * The node worth handing back after a successful edit.
 *
 * Not simply `nodeAt(start)`, for two different reasons:
 *
 *   insert/replace — the text may begin with a doc comment or `#[attr]`, so
 *                    the node literally at that offset is the prologue, not
 *                    the declaration it introduces. Returning the comment
 *                    makes the handle near-useless for the next read or edit.
 *   delete         — nothing was introduced, and whatever now sits at that
 *                    offset merely slid up into the gap. The enclosing scope
 *                    answers "where am I now" instead.
 */
function outcome(
  fresh: Located,
  offset: number,
  action: EditAction,
): SyntaxNode | null {
  const at = fresh.tree.nodeAt(offset);
  if (at === null) return null;
  if (action === "delete") return fresh.tree.enclosingItem(at);

  const introduced = fresh.tree
    .items()
    .find((item) => fresh.tree.itemRangeWithDocs(item).start === offset);
  return introduced ?? at;
}

interface Splice {
  range: ByteRange;
  text: string;
  /** Where the caller's content actually begins, which is not always where
   *  the splice does. Used only for reporting the outcome. */
  contentAt: number;
}

/** What to splice and with what — computed before anything is written. */
function build(
  content: Buffer,
  target: Full,
  args: EditArgs,
) : Splice {
  const indent = baseIndent(content, target.bytes.start) ?? "";
  const body = reindent(args.content, indent);

  switch (args.action) {
    case "replace":
      return { range: target.bytes, text: body, contentAt: target.bytes.start };

    case "insert-before":
      return {
        range: { start: target.bytes.start, end: target.bytes.start },
        text: `${body}\n${indent}`,
        contentAt: target.bytes.start,
      };

    case "insert-after": {
      // The body is preceded by a newline and the indent, so it does not begin
      // where the splice does — and reporting the splice offset lands between
      // nodes, which resolves to the whole file.
      const lead = Buffer.byteLength(`\n${indent}`, "utf8");
      return {
        range: { start: target.bytes.end, end: target.bytes.end },
        text: `\n${indent}${body}`,
        contentAt: target.bytes.end + lead,
      };
    }

    case "delete": {
      // Take the leading indentation and the trailing newline too, so removing
      // a statement does not leave a blank line where it stood.
      const start = target.bytes.start - indent.length;
      let end = content[target.bytes.end] === 0x0a ? target.bytes.end + 1 : target.bytes.end;

      // Removing something that was blank-line-separated on *both* sides
      // leaves two blank lines abutting — a visible scar where the item was.
      // Collapse them to one. Only when both sides are genuinely blank: an
      // item butted directly against its neighbour has no spare separator to
      // give up.
      const blankBefore = content[start - 1] === 0x0a && content[start - 2] === 0x0a;
      if (blankBefore && content[end] === 0x0a) end += 1;

      return { range: { start, end }, text: "", contentAt: start };
    }
  }
}

/**
 * Which files this edit's correctness rests on, and what generation each was
 * at when it was checked. The target's own file is always included — it is the
 * one being overwritten.
 */
async function witness(
  ws: Workspace,
  file: FilePath,
  deps: DepVerdict[],
): Promise<Map<FilePath, number>> {
  const out = new Map<FilePath, number>();
  out.set(file, (await ws.files.snapshot(file)).generation);
  for (const dep of deps) {
    if (dep.file === null || out.has(dep.file)) continue;
    out.set(dep.file, (await ws.files.snapshot(dep.file)).generation);
  }
  return out;
}

/** The first file that moved since it was witnessed, or null if none did. */
async function recheck(ws: Workspace, witnessed: Map<FilePath, number>): Promise<string | null> {
  for (const [file, generation] of witnessed) {
    const now = await ws.files.snapshot(file).catch(() => null);
    if (now === null || now.generation !== generation) return file;
  }
  return null;
}

interface DepVerdict {
  handle: Handle;
  verdict: "ok" | "changed" | "gone" | "unknown";
  replacement: Handle | null;
  /** Which file the dep lives in, so it can be re-checked at commit time. */
  file: FilePath | null;
}

async function validateDeps(ws: Workspace, deps: string[]): Promise<DepVerdict[]> {
  const out: DepVerdict[] = [];
  for (const raw of deps) {
    const address = parseAddress(raw);
    if (address.form !== "handle") {
      out.push({ handle: raw as Handle, verdict: "unknown", replacement: null, file: null });
      continue;
    }
    const resolved = await ws.handles.resolve(address.handle);
    out.push({
      handle: address.handle,
      verdict: resolved.status === "ok" ? "ok" : resolved.status,
      replacement: resolved.status === "changed" ? resolved.full.handle : null,
      file: resolved.status === "unknown" ? null : resolvedFile(resolved),
    });
  }
  return out;
}

/**
 * The dep outcomes are reported separately because the caller's next move
 * differs sharply: CHANGED means re-read and retry, GONE means the node the
 * plan depended on is deleted and the plan itself needs revisiting. Handed
 * only fresh handles, a caller would happily retry into a premise that no
 * longer exists.
 */
function rejection(target: Handle, deps: DepVerdict[]): string {
  const lines = ["edit rejected: premise changed", `${target} target ok`];
  for (const dep of deps) {
    if (dep.verdict === "ok") continue;
    lines.push(
      dep.verdict === "changed"
        ? `${dep.handle} CHANGED  now ${dep.replacement} — re-read, then retry`
        : `${dep.handle} ${dep.verdict.toUpperCase()} — re-plan`,
    );
  }
  return lines.join("\n");
}

function resolvedFile(resolved: { status: string; full?: Full; was?: Full }): FilePath | null {
  return resolved.full?.file ?? resolved.was?.file ?? null;
}

function fail(message: string): Reply {
  return { ok: false, text: `error: ${message}` };
}
