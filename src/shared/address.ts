/**
 * Address parsing and rendering. See api-def.md § Location References.
 *
 * Three forms the model may send:
 *   handle    #317H              server-issued, opaque, echo-only
 *   position  src/main.rs:3-15   literal lines, 1-indexed, inclusive
 *   symbolic  Widget::count      language-qualified symbol
 *
 * The model can originate positions and symbolics; it can only echo handles.
 * Nothing here asks it to count bytes or columns.
 */

import type { Handle, LineRange } from "./types.js";

/** Base-32. I/L/O/U excluded so no token can be misread or read rudely. */
export const HANDLE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HANDLE_RE = /^#[0-9A-HJKMNPQRSTVWXYZ]+$/;

/** Trailing `:12` or `:3-15`. Anchored so `Widget::count` cannot match. */
const TRAILING_LINES_RE = /^(.*?):(\d+)(?:-(\d+))?$/;

export interface PositionAddress {
  form: "position";
  path: string;
  /** Absent means the whole file. */
  lines: LineRange | null;
}

export interface HandleAddress {
  form: "handle";
  handle: Handle;
}

export interface SymbolicAddress {
  form: "symbolic";
  symbol: string;
}

export type Address = HandleAddress | PositionAddress | SymbolicAddress;

export class AddressError extends Error {}

/**
 * Dispatch is by shape — there is no `mode` parameter. Order matters:
 * a trailing `:N` marks a position before `::` can mark a symbolic, so
 * `src/a.rs:12` and `Widget::count` both land correctly.
 */
export function parseAddress(raw: string): Address {
  const text = raw.trim();
  if (text.length === 0) throw new AddressError("empty address");

  if (text.startsWith("#")) {
    const upper = text.toUpperCase();
    if (!HANDLE_RE.test(upper)) {
      throw new AddressError(`malformed handle: ${raw}`);
    }
    return { form: "handle", handle: upper as Handle };
  }

  const m = TRAILING_LINES_RE.exec(text);
  if (m) {
    const [, path, startRaw, endRaw] = m;
    if (path === undefined || startRaw === undefined) {
      throw new AddressError(`malformed position: ${raw}`);
    }
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    if (start < 1) throw new AddressError("lines are 1-indexed");
    if (end < start) throw new AddressError(`inverted line range: ${raw}`);
    return { form: "position", path, lines: { start, end } };
  }

  if (text.includes("::")) {
    return { form: "symbolic", symbol: text };
  }

  // A path needs a separator or an extension to be distinguishable from a
  // bare symbol name. Everything else is treated as a symbol; FIND is the
  // tool for "I only have a string".
  if (text.includes("/") || /\.[A-Za-z0-9]+$/.test(text)) {
    return { form: "position", path: text, lines: null };
  }

  return { form: "symbolic", symbol: text };
}

export function formatLineRange(lines: LineRange): string {
  return lines.start === lines.end
    ? `:${lines.start}`
    : `:${lines.start}-${lines.end}`;
}

export function formatPosition(path: string, lines: LineRange | null): string {
  return lines === null ? path : `${path}${formatLineRange(lines)}`;
}

/**
 * Size is reported only when it is surprising — i.e. when the content is
 * denser than ~80 bytes per line. On ordinary code the line count already
 * conveys magnitude, so the field stays absent and costs nothing. Seeing a
 * size at all is the signal that line count is not a reliable proxy here.
 */
export const SIZE_REPORT_BYTES_PER_LINE = 80;

export function formatSize(bytes: number, lineCount: number): string | null {
  if (lineCount > 0 && bytes < lineCount * SIZE_REPORT_BYTES_PER_LINE) {
    return null;
  }
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
