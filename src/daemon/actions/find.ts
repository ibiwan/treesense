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
import { locate, mint, type Located } from "../locate.js";
import { isItemKind } from "../syntax.js";
import { walkSource } from "../walk.js";
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

  const scope = await resolveScope(ws, args.haystack);
  if ("error" in scope) return { ok: false, text: `error: ${scope.error}` };

  const structural = looksStructural(needle);
  const groups = new Map<string, Hit[]>();
  let total = 0;
  let truncated = false;

  for (const file of scope.files) {
    if (total >= MAX_HITS) {
      truncated = true;
      break;
    }

    const located = await locate(ws, file);
    if (located === null) continue;

    const ranges = structural
      ? structuralMatches(located, needle)
      : textMatches(located, needle);

    const hits: Hit[] = [];
    for (const offset of ranges) {
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
  const header = `find ${JSON.stringify(needle)} ${reading} ${total}${truncated ? "+" : ""}`;
  if (total === 0) return { ok: true, text: header };

  const body = renderHits(groups);
  const note = truncated ? `\n… capped at ${MAX_HITS}; narrow with haystack` : "";
  return { ok: true, text: `${header}\n${body}${note}` };
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

/** Byte offsets where a structural match begins. */
function structuralMatches(located: Located, pattern: string): number[] {
  try {
    return located.tree.search(pattern).map((node) => node.bytes.start);
  } catch {
    // An unparseable pattern is a user error, not a crash; it yields nothing
    // and the header still reports that it was read as a pattern.
    return [];
  }
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
  | { files: FilePath[]; within: { start: number; end: number } | null }
  | { error: string };

async function resolveScope(ws: Workspace, haystack: string | undefined): Promise<Scope> {
  if (haystack === undefined) {
    return { files: await walkSource(ws.root), within: null };
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
    };
  }

  if (address.form === "position") {
    const file = await ws.files.canonical(address.path);
    if (address.lines === null) return { files: [file], within: null };

    const located = await locate(ws, file);
    if (located === null) {
      return { error: `no grammar for ${address.path}${formatLineRange(address.lines)}` };
    }
    const start = located.snap.index.startOfLine(address.lines.start);
    const end =
      address.lines.end >= located.snap.index.lineCount
        ? located.snap.content.length
        : located.snap.index.startOfLine(address.lines.end + 1);
    return { files: [file], within: { start, end } };
  }

  return { error: `haystack must be a file or handle, not a symbol (${address.symbol})` };
}
