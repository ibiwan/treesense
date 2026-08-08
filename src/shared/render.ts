/**
 * Response rendering. See api-def.md § Return Types.
 *
 * Two rules the layout depends on, both there to avoid quoting:
 *   - a filename owns its own line, so a path containing spaces needs no escape
 *   - free text (code snippets) is always last on its line, so it may contain
 *     anything at all without being mistaken for structure
 *
 * Separators are single ASCII spaces. Newlines are the only whitespace that
 * costs a token worth caring about, so there are no blank lines, no rules and
 * no alignment padding.
 */

import { basename, relative } from "node:path";

import { formatLineRange, formatSize } from "./address.js";
import type { Full, Hit, Site } from "./types.js";

/** `#317H [shapes.rs::Square::area] :35-37 fn Square::area` — stable label plus address. */
export function handlePlus(full: Full, opts: { withPath?: boolean; root?: string | undefined } = {}): string {
  const parts: string[] = [full.handle, `[${stableLabel(full)}]`];

  const range = formatLineRange(full.lines);
  const path = opts.root === undefined ? full.file : relative(opts.root, full.file);
  parts.push(opts.withPath === true ? `${path}${range}` : range);

  const size = formatSize(full.bytes.end - full.bytes.start, lineCount(full));
  if (size !== null) parts.push(size);

  parts.push(describe(full));
  return parts.join(" ");
}

/** A short, deterministic label lets an agent recognize a handle across calls. */
export function stableLabel(full: Full): string {
  return `${basename(full.file)}::${full.qualified ?? full.symbol ?? full.kind}`;
}

/** `fn Square::area` — Type plus fully-qualified name where one exists. */
export function describe(full: Full): string {
  const name = full.qualified ?? full.symbol;
  return name === null ? full.kind : `${full.kind} ${name}`;
}

/**
 * `> #317H :9-11 branch > #a1 :3-12 fn main` — innermost first, left to right.
 *
 * Rendered as a chain rather than as indentation on purpose: reading relative
 * nesting is fine, but counting depth is exactly the kind of character
 * arithmetic models get wrong. A chain needs no spatial inference.
 */
export function hierarchy(chain: Full[], root?: string): string {
  return chain.map((full) => `> ${handlePlus(full, { root })}`).join(" ");
}

export function renderHit(hit: Hit, root?: string): string {
  return `${hierarchy(hit.hierarchy, root)}\n  ${hit.snippet}`;
}

/** Hits grouped by file, so each path is written once however many hits it holds. */
export function renderHits(groups: Map<string, Hit[]>, root?: string): string {
  const out: string[] = [];
  for (const [file, hits] of groups) {
    out.push(root === undefined ? file : relative(root, file));
    for (const hit of hits) out.push(renderHit(hit, root));
  }
  return out.join("\n");
}

/**
 * `up 2 #317H :35-37 fn Square::area` — direction, call distance, referent.
 *
 * A terminated branch always states why. A trace that stopped because it could
 * not follow a value must never be indistinguishable from one that genuinely
 * ended: the model reads a short tree as a complete answer either way.
 */
export function renderSite(site: Site, root?: string): string {
  const head = `${site.direction} ${site.distance} ${handlePlus(site.full, { withPath: true, root })}`;
  return site.stop === null ? head : `${head} stop:${site.stop}`;
}

function lineCount(full: Full): number {
  return full.lines.end - full.lines.start + 1;
}
