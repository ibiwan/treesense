/**
 * Scales a värde by the given factor.
 *
 * The non-ASCII above is deliberate: it puts multi-byte characters ahead of
 * this declaration so any offset that was never converted from UTF-16 lands
 * in the wrong place. See DESIGN.md § 1. Also exercises the
 * `export_statement`-wrapper fix in `enclosingItem` — a workspace/symbol
 * position on this declaration lands at the `export` keyword, before the
 * wrapped `function_declaration`'s own range begins.
 */
export function scale(value: number, factor: number): number {
  return value * factor;
}

/**
 * Clamps to a ceiling. 🦀
 *
 * The crab is astral: two UTF-16 units, four UTF-8 bytes. A converter that
 * handles `é` but assumes one unit per codepoint still fails here.
 */
export function clamp(value: number, ceiling: number): number {
  return value > ceiling ? ceiling : value;
}

/**
 * Declaration merging: two interfaces sharing one name is a real TypeScript
 * feature, not a contrived edge case, and it produces two genuinely
 * ambiguous item-kind nodes with the same qualified name "Options". A
 * handle's relocator (`Workspace`'s identity-based relocation, see
 * DESIGN.md § 4) must refuse to guess between them after an external edit
 * moves one, rather than silently picking either.
 */
export interface Options {
  name: string;
}

export interface Options {
  value: number;
}
