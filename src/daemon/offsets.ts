/**
 * UTF-16 ↔ UTF-8 offset conversion.
 *
 * Our canonical unit is the UTF-8 byte. Two upstream sources speak UTF-16 code
 * units instead, and both are easy to trust by mistake:
 *
 *   - ast-grep's `Pos.index`, whose own type definition calls it a "byte
 *     offset of the position". It is not. Verified with `é`/`ü`, then with
 *     `🦀` to distinguish UTF-16 units from codepoints.
 *   - LSP positions, which default to UTF-16 unless the server accepts the
 *     utf-8 negotiation — and it may decline.
 *
 * An unconverted offset is not loudly wrong. It resolves to *something* a few
 * characters off, only in files containing non-ASCII, and reads plausibly. So
 * conversion happens at the boundary and nowhere else.
 */

/**
 * Breakpoints are recorded at the *end* of every character whose two widths
 * differ. Between one breakpoint and the next character that differs, both
 * coordinate systems advance one-for-one, so a position is reconstructed as
 * "nearest breakpoint plus the untouched remainder" — no per-character table.
 *
 * Most source files are pure ASCII, where the two units coincide entirely and
 * conversion is the identity. Detecting that costs one scan.
 */
export class OffsetMap {
  /** UTF-16 offset just past each divergent character. Ascending. */
  private readonly u16Ends: number[] = [];
  /** Byte offset of the same point, index-aligned with `u16Ends`. */
  private readonly byteEnds: number[] = [];
  private readonly asciiOnly: boolean;

  readonly byteLength: number;
  readonly utf16Length: number;

  constructor(content: Buffer) {
    this.byteLength = content.length;

    let ascii = true;
    for (let i = 0; i < content.length; i++) {
      if (content[i]! >= 0x80) {
        ascii = false;
        break;
      }
    }
    this.asciiOnly = ascii;

    if (ascii) {
      this.utf16Length = content.length;
      return;
    }

    const text = content.toString("utf8");
    this.utf16Length = text.length;

    let byte = 0;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      const u16Len = cp > 0xffff ? 2 : 1;
      const byteLen = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += u16Len;
      byte += byteLen;
      if (byteLen !== u16Len) {
        this.u16Ends.push(i);
        this.byteEnds.push(byte);
      }
    }
  }

  toBytes(utf16Offset: number): number {
    if (this.asciiOnly) return utf16Offset;
    const i = lastAtOrBefore(this.u16Ends, utf16Offset);
    if (i < 0) return utf16Offset;
    return this.byteEnds[i]! + (utf16Offset - this.u16Ends[i]!);
  }

  toUtf16(byteOffset: number): number {
    if (this.asciiOnly) return byteOffset;
    const i = lastAtOrBefore(this.byteEnds, byteOffset);
    if (i < 0) return byteOffset;
    return this.u16Ends[i]! + (byteOffset - this.byteEnds[i]!);
  }
}

/** Index of the greatest element <= `value`, or -1 if all exceed it. */
function lastAtOrBefore(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
