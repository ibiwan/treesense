/**
 * FIND — search. Returns hits, never candidates.
 *
 * Hits and candidates answer different questions. A search asks "what
 * matches?", and any cardinality is a complete answer — zero means nothing
 * matches, which is information. Candidates report a *failed resolution*:
 * one specific thing was named and the address did not land uniquely. So
 * candidates have cardinality 2..n by construction, and only the operations
 * that take an address can produce them.
 *
 * Unlike `refs`, this needs no index — text and structure both come from the
 * files themselves. So it works during cold start.
 */

import { formatLineRange, parseAddress } from "../../shared/address.js";
import { renderHits } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { FilePath, Full, Hit } from "../../shared/types.js";
import { locate, mint, mintRange, type Located } from "../locate.js";
import { isItemKind, patternParses } from "../syntax.js";
import { looksBinary, walkSource } from "../walk.js";
import type { Workspace } from "../workspace.js";

export interface FindArgs {
  needle: string;
  haystack?: string | undefined;
}

/** A search is not an inventory; past this the answer stops being readable. */
const MAX_HITS = 60;

/**
 * Shape dispatch, not a mode parameter. A metavariable is the one thing a
 * literal search can never contain, so its presence is unambiguous — and the
 * response states which reading was used, so a misread costs one line rather
 * than a round trip.
 */
function looksStructural(needle: string): boolean {
  return /\$[A-Z_]/.test(needle);
}

export async function find(ws: Workspace, args: FindArgs): Promise<Reply> {
  const needle = args.needle.trim();
  if (needle.length === 0) return { ok: false, text: "error: empty needle" };

  const structural = looksStructural(needle);
  const scope = await resolveScope(ws, args.haystack, structural);
  if ("error" in scope) return { ok: false, text: `error: ${scope.error}` };

  const groups = new Map<string, Hit[]>();
  let total = 0;
  let truncated = false;
  // A capped *walk* means files were never looked at, which is a different and
  // more serious incompleteness than a capped hit list: the caller cannot tell
  // from the results that anything was skipped.
  let unwalked = scope.unwalked;

  for (const file of scope.files) {
    if (total >= MAX_HITS) {
      truncated = true;
      break;
    }

    const located = await locate(ws, file);

    // No grammar: a literal search still works on the bytes. A structural one
    // cannot — a pattern is defined in terms of a grammar.
    if (located === null) {
      if (structural) continue;
      const plain = await plainMatches(ws, file, needle, scope.within);
      if (plain.length > 0) {
        groups.set(file, plain);
        total += plain.length;
      }
      continue;
    }

    const found = structural
      ? structuralMatches(located, needle)
      : textMatches(located, needle);
    if (!Array.isArray(found)) return { ok: false, text: `error: ${found.error}` };

    const hits: Hit[] = [];
    for (const offset of found) {
      if (scope.within !== null && (offset < scope.within.start || offset >= scope.within.end)) {
        continue;
      }
      if (total + hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      const hit = hitAt(ws, located, offset);
      if (hit !== null) hits.push(hit);
    }

    if (hits.length > 0) {
      groups.set(file, hits);
      total += hits.length;
    }
  }

  const reading = structural ? "pattern" : "text";
  const header = `find ${JSON.stringify(needle)} ${reading} ${total}${truncated || unwalked ? "+" : ""}`;

  const notes: string[] = [];
  if (truncated) notes.push(`… capped at ${MAX_HITS} hits; narrow with haystack`);
  if (unwalked) notes.push("… file limit reached; some files were never searched");
  const note = notes.length > 0 ? `\n${notes.join("\n")}` : "";

  if (total === 0) return { ok: true, text: `${header}${note}` };
  return { ok: true, text: `${header}\n${renderHits(groups)}${note}` };
}

/** Byte offsets of literal occurrences. */
function textMatches(located: Located, needle: string): number[] {
  const pattern = Buffer.from(needle, "utf8");
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = located.snap.content.indexOf(pattern, from);
    if (at === -1) break;
    out.push(at);
    from = at + pattern.length;
  }
  return out;
}

/**
 * Byte offsets where a structural match begins, or the reason the pattern
 * itself was unusable.
 *
 * Swallowing a bad pattern as "no matches" is the one thing this must not do:
 * we teach callers that zero matches is meaningful information, so a malformed
 * query returning the same shape as a real empty result is actively
 * misleading. It is a user error, and it is reported as one.
 */
function structuralMatches(located: Located, pattern: string): number[] | { error: string } {
  if (!patternParses(pattern, located.tree.language)) {
    return {
      error: `pattern is not valid ${located.tree.language}: ${JSON.stringify(pattern)}`,
    };
  }
  try {
    return located.tree.search(pattern).map((node) => node.bytes.start);
  } catch (cause) {
    return { error: `pattern rejected: ${(cause as Error).message}` };
  }
}

/**
 * Literal matches in a file no grammar covers.
 *
 * There is no hierarchy to report, so each hit carries a range handle — the
 * same thing `read` hands back for these files, so the two verbs agree about
 * what is addressable.
 */
async function plainMatches(
  ws: Workspace,
  file: FilePath,
  needle: string,
  within: { start: number; end: number } | null,
): Promise<Hit[]> {
  const snap = await ws.files.snapshot(file).catch(() => null);
  if (snap === null || looksBinary(snap.content)) return [];

  const pattern = Buffer.from(needle, "utf8");
  const hits: Hit[] = [];
  let from = 0;
  for (;;) {
    const at = snap.content.indexOf(pattern, from);
    if (at === -1) break;
    from = at + pattern.length;
    if (within !== null && (at < within.start || at >= within.end)) continue;

    const line = snap.index.lineAt(at);
    const start = snap.index.startOfLine(line);
    const end =
      line >= snap.index.lineCount ? snap.content.length : snap.index.startOfLine(line + 1);

    hits.push({
      hierarchy: [mintRange(ws, snap, { start, end })],
      snippet: snap.content.subarray(start, end).toString("utf8").trim(),
    });
  }
  return hits;
}

/**
 * Innermost-first chain, exactly as `refs` builds it.
 *
 * The hit handle points at the *matched node*, not the enclosing line: a hit's
 * purpose is to be a symbol occurrence, and that is what makes a follow-up
 * `refs` on it exact rather than ambiguous.
 */
function hitAt(ws: Workspace, located: Located, offset: number): Hit | null {
  const node = located.tree.nodeAt(offset);
  if (node === null) return null;

  const chain: Full[] = [mint(ws, located, node)];
  for (const ancestor of located.tree.ancestors(node)) {
    if (!INTERESTING.has(ancestor.kind)) continue;
    chain.push(mint(ws, located, ancestor));
    if (isItemKind(ancestor.kind)) break;
  }

  const line = located.snap.index.lineAt(offset);
  const start = located.snap.index.startOfLine(line);
  const end =
    line >= located.snap.index.lineCount
      ? located.snap.content.length
      : located.snap.index.startOfLine(line + 1);

  return {
    hierarchy: chain,
    snippet: located.snap.content.subarray(start, end).toString("utf8").trim(),
  };
}

const INTERESTING = new Set([
  "fn",
  "impl",
  "struct",
  "enum",
  "trait",
  "mod",
  "const",
  "type",
  "branch",
  "loop",
]);

type Scope =
  | {
      files: FilePath[];
      within: { start: number; end: number } | null;
      /** The walk hit its file cap, so some files were never candidates. */
      unwalked: boolean;
    }
  | { error: string };

async function resolveScope(
  ws: Workspace,
  haystack: string | undefined,
  structural: boolean,
): Promise<Scope> {
  if (haystack === undefined) {
    // A structural search can only look at files a grammar covers; a literal
    // one may look at anything that is not binary.
    const walked = await walkSource(ws.root, { grammarsOnly: structural });
    return { files: walked.files, within: null, unwalked: walked.truncated };
  }

  const address = parseAddress(haystack);

  if (address.form === "handle") {
    // Searching within a node: one file, bounded by that node's range.
    const resolved = await ws.handles.resolve(address.handle);
    if (resolved.status === "unknown") return { error: `${address.handle} unknown` };
    if (resolved.status === "gone") return { error: `${address.handle} gone` };
    return {
      files: [resolved.full.file],
      within: { start: resolved.full.bytes.start, end: resolved.full.bytes.end },
      unwalked: false,
    };
  }

  if (address.form === "position") {
    const file = await ws.files.canonical(address.path);
    if (address.lines === null) return { files: [file], within: null, unwalked: false };

    // Line bounds come from the snapshot, not the parse — a range in a file
    // with no grammar is still a perfectly good range.
    const snap = await ws.files.snapshot(file).catch(() => null);
    if (snap === null) return { error: `${address.path} could not be read` };

    const start = snap.index.startOfLine(address.lines.start);
    const end =
      address.lines.end >= snap.index.lineCount
        ? snap.content.length
        : snap.index.startOfLine(address.lines.end + 1);
    return { files: [file], within: { start, end }, unwalked: false };
  }

  return { error: `haystack must be a file or handle, not a symbol (${address.symbol})` };
}
