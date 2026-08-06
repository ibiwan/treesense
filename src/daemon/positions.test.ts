import assert from "node:assert/strict";
import { test } from "node:test";

import { LineIndex } from "./files.js";
import { OffsetMap } from "./offsets.js";
import { byteToPosition, positionToByte } from "./positions.js";
import type { FileSnapshot } from "./files.js";
import type { FilePath } from "../shared/types.js";

function snapshot(src: string): FileSnapshot {
  const content = Buffer.from(src, "utf8");
  return {
    path: "/x" as FilePath,
    generation: 1,
    content,
    index: new LineIndex(content),
    offsets: new OffsetMap(content),
  };
}

test("ascii: both encodings agree", () => {
  const snap = snapshot("fn a() {}\nfn b() {}\n");
  const byte = snap.content.indexOf("b");

  for (const enc of ["utf-8", "utf-16"] as const) {
    const pos = byteToPosition(snap, byte, enc);
    assert.deepEqual(pos, { line: 1, character: 3 }, enc);
    assert.equal(positionToByte(snap, pos, enc), byte, enc);
  }
});

test("non-ascii earlier on the line shifts utf-16 columns", () => {
  // "é" before the target: 2 bytes, 1 UTF-16 unit.
  const snap = snapshot("let a = 1;\nlet é_b = 2;\n");
  const byte = snap.content.indexOf("_b");

  const utf8Pos = byteToPosition(snap, byte, "utf-8");
  const utf16Pos = byteToPosition(snap, byte, "utf-16");

  assert.notEqual(
    utf8Pos.character,
    utf16Pos.character,
    "the encodings must disagree or the test proves nothing",
  );
  assert.equal(utf8Pos.character - utf16Pos.character, 1, "é costs one extra byte");

  // Both must round-trip to the same byte under their own encoding.
  assert.equal(positionToByte(snap, utf8Pos, "utf-8"), byte);
  assert.equal(positionToByte(snap, utf16Pos, "utf-16"), byte);
});

test("astral characters cost two utf-16 units", () => {
  const snap = snapshot("// 🦀 crab\nlet x = 1;\n");
  const byte = snap.content.indexOf("crab");

  const utf16Pos = byteToPosition(snap, byte, "utf-16");
  const utf8Pos = byteToPosition(snap, byte, "utf-8");
  assert.equal(utf8Pos.character - utf16Pos.character, 2, "🦀 is 4 bytes vs 2 units");
  assert.equal(positionToByte(snap, utf16Pos, "utf-16"), byte);
});

test("round-trips at every line start", () => {
  const snap = snapshot("aé\n🦀b\nc\n// ünï\nfn ƒ() {}\n");
  for (let line = 0; line < snap.index.lineCount; line++) {
    for (const enc of ["utf-8", "utf-16"] as const) {
      const start = snap.index.startOfLine(line + 1);
      const pos = byteToPosition(snap, start, enc);
      assert.equal(pos.line, line, `line ${line} ${enc}`);
      assert.equal(pos.character, 0, `line ${line} ${enc} should be column 0`);
      assert.equal(positionToByte(snap, pos, enc), start, `line ${line} ${enc}`);
    }
  }
});
