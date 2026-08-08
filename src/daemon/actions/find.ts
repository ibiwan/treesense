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
  collapse: boolean;
}

/** A search is not an inventory; past this the answer stops being readable. */
const MAX_HITS = 60;

/**
 * A hit shows *where* something is; it is not a substitute for reading it.
 * Without this, sixty matches on a minified line return a quarter-megabyte of
 * context nobody asked for — the hit cap alone does not bound the response.
 */
const MAX_SNIPPET = 200;

function snippet(content: Buffer, start: number, end: number): string {
  const text = content.subarray(start, end).toString("utf8").trim();
  return text.length <= MAX_SNIPPET ? text : `${text.slice(0, MAX_SNIPPET)}…`;
}

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

  let reading: "pattern" | LiteralReading = structural ? "pattern" : "text";
  let result = await collectMatches(ws, scope, needle, structural ? "structural" : "exact");
  if ("error" in result) return { ok: false, text: `error: ${result.error}` };

  // Exact remains the contract. Looser readings only rescue a true zero, and
  // each reports itself so an agent never mistakes a normalized hit for an
  // exact spelling match.
  if (!structural && result.total === 0) {
    result = await collectMatches(ws, scope, needle, "ascii-insensitive");
    if ("error" in result) return { ok: false, text: `error: ${result.error}` };
    reading = "text (case-insensitive fallback)";
    if (result.total === 0) {
      result = await collectMatches(ws, scope, needle, "normalized");
      if ("error" in result) return { ok: false, text: `error: ${result.error}` };
      reading = "text (normalized fallback)";
    }
  }

  if (args.collapse) result = collapseResults(result);

  const header = `find ${JSON.stringify(needle)} ${reading}${args.collapse ? " collapsed" : ""} ${result.total}${result.truncated || scope.unwalked ? "+" : ""}`;

  const notes: string[] = [];
  if (result.truncated) {
    notes.push(`… capped at ${MAX_HITS} hits; refine haystack to a file (src/x.rs), range (src/x.rs:10-20), or handle (#...)`);
  }
  if (scope.unwalked) notes.push("… file limit reached; some files were never searched");
  const note = notes.length > 0 ? `\n${notes.join("\n")}` : "";

  if (result.total === 0) return { ok: true, text: `${header}${note}` };
  return { ok: true, text: `${header}\n${renderHits(result.groups, ws.root)}${note}` };
}

type LiteralReading = "text" | "text (case-insensitive fallback)" | "text (normalized fallback)";
type MatchMode = "structural" | "exact" | "ascii-insensitive" | "normalized";

interface MatchResults {
  groups: Map<string, Hit[]>;
  total: number;
  truncated: boolean;
}

/**
 * Reconnaissance needs regions, not every spelling inside them. Keep the
 * nearest enclosing declaration as the stable handle, plus one containing
 * declaration/module when available, and retain the first matching line as
 * evidence.
 */
function collapseResults(result: MatchResults): MatchResults {
  const groups = new Map<string, Hit[]>();
  let total = 0;
  for (const [file, hits] of result.groups) {
    const seen = new Set<string>();
    const collapsed: Hit[] = [];
    for (const hit of hits) {
      const itemIndex = hit.hierarchy.findIndex((full) => isItemKind(full.kind));
      const regionIndex = itemIndex === -1 ? hit.hierarchy.length - 1 : itemIndex;
      const region = hit.hierarchy[regionIndex]!;
      const key = `${region.file}:${region.bytes.start}:${region.bytes.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const context = hit.hierarchy[regionIndex + 1];
      collapsed.push({ hierarchy: context === undefined ? [region] : [region, context], snippet: hit.snippet });
    }
    if (collapsed.length > 0) {
      groups.set(file, collapsed);
      total += collapsed.length;
    }
  }
  return { groups, total, truncated: result.truncated };
}

async function collectMatches(
  ws: Workspace,
  scope: Exclude<Scope, { error: string }>,
  needle: string,
  mode: MatchMode,
): Promise<MatchResults | { error: string }> {
  const structural = mode === "structural";
  const groups = new Map<string, Hit[]>();
  let total = 0;
  let truncated = false;
  // A capped *walk* means files were never looked at, which is a different and
  // more serious incompleteness than a capped hit list: the caller cannot tell
  // from the results that anything was skipped.
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
      // Budgeted like the parsed path. A cap enforced in one branch and not
      // its sibling is not a cap: a README with 500 matches would report an
      // uncapped count with no marker, which is precisely what the contract
      // promises never to do.
      const plain = await plainMatches(ws, file, needle, scope.within, MAX_HITS - total, mode);
      if (plain.hits.length > 0) {
        groups.set(file, plain.hits);
        total += plain.hits.length;
      }
      if (plain.truncated) truncated = true;
      continue;
    }

    const found = structural
      ? structuralMatches(located, needle)
      : textMatches(located, needle, mode);
    if (!Array.isArray(found)) return { error: found.error };

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

  return { groups, total, truncated };
}

/** Byte offsets of literal occurrences. */
function textMatches(located: Located, needle: string, mode: Exclude<MatchMode, "structural">): number[] {
  return literalOffsets(located.snap.content, needle, mode);
}

/**
 * ASCII-only by design. Unicode case folding can expand a character and make
 * a match offset differ from the source byte offset that handles rely on.
 */
function literalOffsets(content: Buffer, needle: string, mode: Exclude<MatchMode, "structural">): number[] {
  if (mode === "normalized") return normalizedOffsets(content, needle);

  const pattern = Buffer.from(needle, "utf8");
  const haystack = mode === "ascii-insensitive" ? asciiFold(content) : content;
  const query = mode === "ascii-insensitive" ? asciiFold(pattern) : pattern;
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(query, from);
    if (at === -1) return out;
    out.push(at);
    from = at + query.length;
  }
}

function asciiFold(input: Buffer): Buffer {
  const folded = Buffer.from(input);
  for (let i = 0; i < folded.length; i++) {
    const byte = folded[i]!;
    if (byte >= 0x41 && byte <= 0x5a) folded[i] = byte + 0x20;
  }
  return folded;
}

/**
 * Identifier normalization, not fuzzy matching: separator and camel-case
 * variants collapse to the same ASCII spelling. A source candidate remains a
 * single identifier-like run, so unrelated words across a sentence cannot be
 * silently joined into a match.
 */
function normalizedOffsets(content: Buffer, needle: string): number[] {
  const query = normalizeIdentifier(Buffer.from(needle, "utf8"));
  if (query.length === 0) return [];

  const out: number[] = [];
  let start: number | null = null;
  for (let i = 0; i <= content.length; i++) {
    const byte = content[i];
    if (byte !== undefined && isIdentifierByte(byte)) {
      if (start === null) start = i;
      continue;
    }
    if (start !== null) {
      if (normalizeIdentifier(content.subarray(start, i)).equals(query)) out.push(start);
      start = null;
    }
  }
  return out;
}

function isIdentifierByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || byte === 0x5f || byte === 0x2d;
}

function normalizeIdentifier(input: Buffer): Buffer {
  const out: number[] = [];
  for (const byte of input) {
    if (byte >= 0x41 && byte <= 0x5a) out.push(byte + 0x20);
    else if ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) out.push(byte);
  }
  return Buffer.from(out);
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
  budget: number,
  mode: Exclude<MatchMode, "structural">,
): Promise<{ hits: Hit[]; truncated: boolean }> {
  const snap = await ws.files.snapshot(file).catch(() => null);
  if (snap === null || looksBinary(snap.content)) return { hits: [], truncated: false };

  const hits: Hit[] = [];
  for (const at of literalOffsets(snap.content, needle, mode)) {
    if (within !== null && (at < within.start || at >= within.end)) continue;
    if (hits.length >= budget) return { hits, truncated: true };

    const line = snap.index.lineAt(at);
    const start = snap.index.startOfLine(line);
    const end =
      line >= snap.index.lineCount ? snap.content.length : snap.index.startOfLine(line + 1);

    hits.push({
      hierarchy: [mintRange(ws, snap, { start, end })],
      snippet: snippet(snap.content, start, end),
    });
  }
  return { hits, truncated: false };
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
  let itemCount = 0;
  for (const ancestor of located.tree.ancestors(node)) {
    if (!INTERESTING.has(ancestor.kind)) continue;
    chain.push(mint(ws, located, ancestor));
    if (isItemKind(ancestor.kind) && ++itemCount === 2) break;
  }

  const line = located.snap.index.lineAt(offset);
  const start = located.snap.index.startOfLine(line);
  const end =
    line >= located.snap.index.lineCount
      ? located.snap.content.length
      : located.snap.index.startOfLine(line + 1);

  return { hierarchy: chain, snippet: snippet(located.snap.content, start, end) };
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
    const snap = await ws.files.snapshot(file).catch(() => null);
    if (snap === null) return { error: `${address.path} could not be read; haystack accepts a file (src/x.rs), range (src/x.rs:10-20), or handle (#...)` };
    if (address.lines === null) return { files: [file], within: null, unwalked: false };

    // Line bounds come from the snapshot, not the parse — a range in a file
    // with no grammar is still a perfectly good range.
    const start = snap.index.startOfLine(address.lines.start);
    const end =
      address.lines.end >= snap.index.lineCount
        ? snap.content.length
        : snap.index.startOfLine(address.lines.end + 1);
    return { files: [file], within: { start, end }, unwalked: false };
  }

  return { error: `haystack accepts a file (src/x.rs), range (src/x.rs:10-20), or handle (#...); ${address.symbol} is a symbol, not a scope` };
}
