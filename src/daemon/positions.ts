/**
 * Byte offsets ↔ LSP positions.
 *
 * An LSP `Position` is `{line, character}` where line is 0-based and
 * `character` is counted in whichever unit was negotiated at initialize —
 * UTF-16 code units by default, UTF-8 bytes only if the server accepted the
 * offer. Our canonical unit is the byte, so this is the boundary where the
 * two coordinate systems meet.
 *
 * Getting the unit wrong is silent. It only misbehaves on lines containing
 * non-ASCII *before* the column of interest, and then it resolves to a
 * neighbouring token rather than failing — which is how a `refs` result ends
 * up describing the wrong symbol while looking entirely reasonable.
 */

import type { Position } from "vscode-languageserver-protocol";

import type { FileSnapshot } from "./files.js";

export type PositionEncoding = "utf-8" | "utf-16";

export function byteToPosition(
  snap: FileSnapshot,
  byteOffset: number,
  encoding: PositionEncoding,
): Position {
  const line = snap.index.lineAt(byteOffset);
  const lineStart = snap.index.startOfLine(line);

  const character =
    encoding === "utf-8"
      ? byteOffset - lineStart
      : snap.offsets.toUtf16(byteOffset) - snap.offsets.toUtf16(lineStart);

  // LSP lines are 0-based; ours are 1-based everywhere else, including in
  // every response the model sees.
  return { line: line - 1, character };
}

export function positionToByte(
  snap: FileSnapshot,
  position: Position,
  encoding: PositionEncoding,
): number {
  const lineStart = snap.index.startOfLine(position.line + 1);

  if (encoding === "utf-8") {
    return Math.min(lineStart + position.character, snap.content.length);
  }

  const utf16 = snap.offsets.toUtf16(lineStart) + position.character;
  return Math.min(snap.offsets.toBytes(utf16), snap.content.length);
}
