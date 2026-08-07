/**
 * Indentation, derived from the buffer rather than from the payload.
 *
 * A node's range starts at its first token, so the leading indentation of its
 * first line sits *outside* the range while every continuation line's sits
 * inside it. Splice replacement text in naively and the result is mangled in a
 * way that is tedious to debug and often still parses.
 *
 * The alternative — snapping ranges to line boundaries — is a heuristic whose
 * failure mode is deleting a sibling, because a line may hold more than one
 * node (minified bundles being the reductio). Deriving indentation instead is
 * exact, works on dense lines, and happens to be the required semantics in
 * Python, where relative structure is preserved but the block is rebased.
 */

const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE = 0x0a;

/**
 * Whitespace preceding `offset` on its own line, or null when something other
 * than whitespace sits there — in which case the node shares its line and
 * there is no base indent to speak of.
 */
export function baseIndent(content: Buffer, offset: number): string | null {
  let start = offset;
  while (start > 0 && content[start - 1] !== NEWLINE) {
    const ch = content[start - 1]!;
    if (ch !== SPACE && ch !== TAB) return null;
    start -= 1;
  }
  return content.subarray(start, offset).toString("utf8");
}

/**
 * Normalise incoming text to sit at `indent`.
 *
 * Dedents to its own minimum first, so the caller may send text flush-left or
 * already-indented and get the same result — one less thing for it to get
 * incidentally right.
 */
export function reindent(text: string, indent: string): string {
  const lines = text.split("\n");
  if (lines.length === 0) return text;

  let common: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue; // blank lines carry no information
    const lead = line.slice(0, line.length - line.trimStart().length);
    common = common === null ? lead : sharedPrefix(common, lead);
  }

  const strip = common ?? "";
  return lines
    .map((line, i) => {
      if (i === 0) return line; // the buffer's own indent already precedes it
      if (line.trim() === "") return "";
      return indent + (line.startsWith(strip) ? line.slice(strip.length) : line.trimStart());
    })
    .join("\n");
}

function sharedPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}
