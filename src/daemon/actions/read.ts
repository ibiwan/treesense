/**
 * READ — source when it fits, a handle-bearing structural overview when it
 * does not. A giant source dump is neither reading nor useful navigation.
 */

import { parseAddress } from "../../shared/address.js";
import {
  READ_DEFAULT_AVG_BYTES_PER_LINE,
  READ_SINGLE_LINE_BYTES,
} from "../../shared/protocol.js";
import { handlePlus, stableLabel } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { ByteRange, FilePath, Full, Handle } from "../../shared/types.js";
import { locate, mint, type Located } from "../locate.js";
import type { SyntaxNode } from "../syntax.js";
import type { Workspace } from "../workspace.js";

export interface ReadArgs {
  target: string;
  sections?: string[] | undefined;
  maxLines?: number | undefined;
  maxBytesPerLine?: number | undefined;
}

/** A compact enough source body is still more useful than an outline. */
const OVERVIEW_MAX_LINES = 120;
const OVERVIEW_MAX_BYTES = 24 * 1024;
const MAX_OVERVIEW_SECTIONS = 40;
const MAX_SECTION_HINT = 140;
const MAX_BATCH_SOURCE_BYTES = 48 * 1024;

export async function read(ws: Workspace, args: ReadArgs): Promise<Reply> {
  const address = parseAddress(args.target);

  if (address.form === "symbolic") {
    return err(`read takes a handle or position; ${args.target} is a symbol — use find or refs`);
  }

  if (address.form === "handle") {
    if (args.sections !== undefined) return readSections(ws, address.handle, args.sections, args);
    return readHandle(ws, address.handle, args);
  }

  if (args.sections !== undefined) return err("sections requires target to be a parent overview handle");

  return readPosition(ws, address.path, address.lines, args);
}

/** Read several explicitly selected children without turning an overview into a bulk dump. */
async function readSections(ws: Workspace, parentHandle: Handle, sections: string[], args: ReadArgs): Promise<Reply> {
  if (sections.length === 0) return err("sections is empty; omit it to read the target itself");
  const parent = await ws.handles.resolve(parentHandle);
  if (parent.status === "unknown") return err(`${parentHandle} unknown — handles do not survive a daemon restart; re-query`);
  if (parent.status === "gone") return err(`${parentHandle} gone — its node no longer exists; the plan needs revisiting`);

  const resolved = [] as Array<{ requested: Handle; full: Full }>;
  for (const requested of sections as Handle[]) {
    const section = await ws.handles.resolve(requested);
    if (section.status === "unknown" || section.status === "gone") return err(`${requested} ${section.status}; re-query the parent overview`);
    const full = section.full;
    const contained = full.file === parent.full.file
      && full.bytes.start >= parent.full.bytes.start
      && full.bytes.end <= parent.full.bytes.end;
    if (!contained) return err(`${requested} is not contained by ${parentHandle}; sections must come from that overview`);
    resolved.push({ requested, full });
  }

  // A child that will itself become an overview adds only structural rows, not
  // its full byte size. Budget the source bodies actually headed for output.
  const sourceBytes = resolved
    .filter(({ full }) => !shouldOverview(full.lines.end - full.lines.start + 1, full.bytes.end - full.bytes.start, args))
    .reduce((total, { full }) => total + (full.bytes.end - full.bytes.start), 0);
  if (sourceBytes > MAX_BATCH_SOURCE_BYTES && args.maxLines !== -1 && args.maxBytesPerLine !== -1) {
    return err(`selected sections total ${formatBytes(sourceBytes)}; limit is ${formatBytes(MAX_BATCH_SOURCE_BYTES)} per batch — split the request or explicitly set maxLines=-1`);
  }

  const blocks: string[] = [];
  for (const { requested, full } of resolved) {
    if (shouldOverview(full.lines.end - full.lines.start + 1, full.bytes.end - full.bytes.start, args)) {
      const summary = await renderOverview(ws, full.file, full.bytes);
      if (summary !== null) {
        blocks.push(`section ${requested}\n${summary}`);
        continue;
      }
    }
    const snap = await ws.files.snapshot(full.file);
    const source = snap.content.subarray(full.bytes.start, full.bytes.end).toString("utf8");
    blocks.push(`section ${requested} ${handlePlus(full, { withPath: true, root: ws.root })}\n${source}`);
  }
  return { ok: true, text: `read sections from ${parentHandle} (${blocks.length})\n${blocks.join("\n\n")}` };
}

async function readHandle(ws: Workspace, handle: Handle, args: ReadArgs): Promise<Reply> {
  const resolved = await ws.handles.resolve(handle);

  switch (resolved.status) {
    case "unknown":
      return err(`${handle} unknown — handles do not survive a daemon restart; re-query`);

    case "gone":
      return err(`${handle} gone — its node no longer exists; the plan needs revisiting`);

    case "ok":
    case "changed": {
      const full = resolved.full;
      const snap = await ws.files.snapshot(full.file);
      const body = snap.content.subarray(full.bytes.start, full.bytes.end).toString("utf8");
      const marker = resolved.status === "changed" ? "changed: " : "";
      if (shouldOverview(full.lines.end - full.lines.start + 1, full.bytes.end - full.bytes.start, args)) {
        const overview = await renderOverview(ws, full.file, full.bytes);
        if (overview !== null) return { ok: true, text: `${marker}${overview}` };
      }
      return { ok: true, text: `${marker}${handlePlus(full, { withPath: true, root: ws.root })}\n${body}` };
    }
  }
}

async function readPosition(
  ws: Workspace,
  path: string,
  lines: { start: number; end: number } | null,
  args: ReadArgs,
): Promise<Reply> {
  const file = await ws.files.canonical(path);
  let snap;
  try {
    snap = await ws.files.snapshot(file);
  } catch {
    return err(`${path} could not be read`);
  }

  const span = lines ?? { start: 1, end: snap.index.lineCount };
  const requested = span.end - span.start + 1;

  const maxLines = args.maxLines ?? -1;
  if (maxLines >= 0 && requested > maxLines) {
    return err(`${requested} lines exceeds maxLines ${maxLines}`);
  }

  const bytes = snap.index.bytesForLines(span, snap.content.length);
  const total = bytes.end - bytes.start;

  const perLine = args.maxBytesPerLine ?? READ_DEFAULT_AVG_BYTES_PER_LINE;
  if (perLine >= 0) {
    // The single-line floor raises the allowance; it never lowers an explicit
    // one. A one-line read is a probe rather than a sized request — the caller
    // asked for a line with no way to know it would be a doozie — so the
    // discontinuity at two lines is deliberate.
    const allowance =
      requested === 1
        ? Math.max(perLine, READ_SINGLE_LINE_BYTES)
        : perLine * requested;
    if (total > allowance) {
      // Refuse rather than truncate. Half a function usually still parses, so
      // a truncated read invites confident reasoning about code that does not
      // exist — the caller never sees the early return twenty lines down.
      return err(
        `${total}B over ${requested} lines exceeds ${allowance}B; pass maxBytesPerLine=-1 to read anyway`,
      );
    }
  }

  if (shouldOverview(requested, total, args)) {
    const overview = await renderOverview(ws, file, bytes);
    if (overview !== null) return { ok: true, text: overview };
  }

  const body = snap.content.subarray(bytes.start, bytes.end).toString("utf8");
  // Echo the canonical path, not the caller's spelling: a file that appears
  // under two names across responses undermines the identity the whole
  // generation scheme is keyed on.
  return { ok: true, text: `${file}:${span.start}-${span.end}\n${body}` };
}

/** Explicitly disabling either existing read limit means the caller wants bytes. */
function shouldOverview(lines: number, bytes: number, args: ReadArgs): boolean {
  if (args.maxLines === -1 || args.maxBytesPerLine === -1) return false;
  return lines > OVERVIEW_MAX_LINES || bytes > OVERVIEW_MAX_BYTES;
}

/**
 * The overview is parser-derived, never a generated prose summary. It offers
 * the shallowest declarations in the requested range; if a large function has
 * no nested declarations, its first-level branches and loops are useful next
 * choices instead.
 */
async function renderOverview(ws: Workspace, file: FilePath, bytes: ByteRange): Promise<string | null> {
  const located = await locate(ws, file);
  if (located === null) return null;

  const items = directItems(located, bytes);
  const sections = items.length > 0 ? items : directControlFlow(located, bytes);
  const lines = located.snap.index.linesForBytes(bytes);
  const length = bytes.end - bytes.start;
  const displayFile = file.startsWith(ws.root) ? file.slice(ws.root.length + 1) : file;
  const header = `overview ${displayFile}:${lines.start}-${lines.end} — ${lines.end - lines.start + 1} lines, ${formatBytes(length)}`;
  const recovery = "summary shown instead of raw source by overview guard (>120 lines or >24 KiB); suggested handles follow; use maxLines=-1 or maxBytesPerLine=-1 to override";
  if (sections.length === 0) {
    return `${header}\n${recovery}\n(no nested sections)`;
  }
  const visible = sections.slice(0, MAX_OVERVIEW_SECTIONS).map((node) => {
    const full = mint(ws, located, node);
    return { full, text: renderSection(located, node, full) };
  });
  const suggested = visible.slice(0, 3).map(({ full }) => `${full.handle} [${stableLabel(full)}]`).join(", ");
  return `${header}\n${recovery}\nsuggested first sections: ${suggested}\n${visible.map(({ text }) => text).join("\n")}`
    + (sections.length > MAX_OVERVIEW_SECTIONS ? `\n… capped at ${MAX_OVERVIEW_SECTIONS} sections` : "");
}

function renderSection(located: Located, node: SyntaxNode, full: Full): string {
  const base = `> ${handlePlus(full)}`;
  if (node.kind !== "branch" && node.kind !== "loop") return base;
  return `${base} — ${sectionHint(located, node)}`;
}

/**
 * A control-flow node has no name, but its immediately preceding comments
 * often do: `// stage`, `// promote`, and so on. This is intentionally local
 * and deterministic. Without an attached comment, the opening source line is
 * still a useful honest label (for example, `for mut item in items {`).
 */
function sectionHint(located: Located, node: SyntaxNode): string {
  const line = located.snap.index.lineAt(node.bytes.start);
  const comments: string[] = [];
  for (let previous = line - 1; previous >= 1; previous--) {
    const source = lineText(located, previous).trim();
    const comment = source.match(/^\/\/\/?\s?(.*)$/)?.[1];
    if (comment === undefined) break;
    comments.unshift(comment.trim());
  }
  const hint = comments.length > 0 ? comments.join(" ") : lineText(located, line).trim();
  return hint.length <= MAX_SECTION_HINT ? hint : `${hint.slice(0, MAX_SECTION_HINT - 1)}…`;
}

function lineText(located: Located, line: number): string {
  const start = located.snap.index.startOfLine(line);
  const end = line >= located.snap.index.lineCount
    ? located.snap.content.length
    : located.snap.index.startOfLine(line + 1);
  return located.snap.content.subarray(start, end).toString("utf8").replace(/\r?\n$/, "");
}

function directItems(located: Located, within: ByteRange): SyntaxNode[] {
  const items = located.tree.items().filter((item) => {
    const range = located.tree.itemRangeWithDocs(item);
    // A handle to one declaration must reveal what is inside it, not hand the
    // same declaration back as its only "section".
    const isWholeRequest = range.start === within.start && range.end === within.end;
    return !isWholeRequest && range.start >= within.start && range.end <= within.end;
  });
  return items.filter((item) => !items.some((outer) => {
    if (outer === item) return false;
    const a = located.tree.itemRangeWithDocs(outer);
    const b = located.tree.itemRangeWithDocs(item);
    return a.start <= b.start && a.end >= b.end;
  }));
}

function directControlFlow(located: Located, within: ByteRange): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const walk = (node: SyntaxNode, insideControl: boolean): void => {
    for (const child of node.children()) {
      const range = child.bytes;
      if (range.end <= within.start || range.start >= within.end) continue;
      const contained = range.start >= within.start && range.end <= within.end;
      const control = child.kind === "branch" || child.kind === "loop";
      if (contained && control && !insideControl) {
        out.push(child);
        continue;
      }
      walk(child, insideControl || (contained && control));
    }
  };
  walk(located.tree.rootNode, false);
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function err(message: string): Reply {
  return { ok: false, text: `error: ${message}` };
}
