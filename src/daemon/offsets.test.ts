import assert from "node:assert/strict";
import { test } from "node:test";

import { OffsetMap } from "./offsets.js";

/**
 * A pure-ASCII suite cannot fail on any of this, which is exactly why the
 * conversion bug is easy to ship. Every case here is deliberately non-ASCII.
 */

test("ascii is the identity", () => {
  const m = new OffsetMap(Buffer.from("fn main() {}", "utf8"));
  for (const i of [0, 3, 7, 12]) {
    assert.equal(m.toBytes(i), i);
    assert.equal(m.toUtf16(i), i);
  }
});

test("two-byte characters shift byte offsets", () => {
  // "é" is 1 UTF-16 unit, 2 UTF-8 bytes.
  const src = "// é\nlet x = 1;\n";
  const buf = Buffer.from(src, "utf8");
  const m = new OffsetMap(buf);

  const u16 = src.indexOf("let");
  const bytes = buf.indexOf(Buffer.from("let", "utf8"));
  assert.notEqual(u16, bytes, "test is pointless if they coincide");

  assert.equal(m.toBytes(u16), bytes);
  assert.equal(m.toUtf16(bytes), u16);
});

test("astral characters are two UTF-16 units and four bytes", () => {
  const src = "// 🦀\nlet x = 1;\n";
  const buf = Buffer.from(src, "utf8");
  const m = new OffsetMap(buf);

  const u16 = src.indexOf("let");
  const bytes = buf.indexOf(Buffer.from("let", "utf8"));
  assert.equal(bytes - u16, 2, "🦀 is 4 bytes vs 2 units");

  assert.equal(m.toBytes(u16), bytes);
  assert.equal(m.toUtf16(bytes), u16);
});

test("round-trips at every character boundary", () => {
  const src = "aé🦀b\nçd\n// ünïcödé\nfn ƒ() {}\n";
  const buf = Buffer.from(src, "utf8");
  const m = new OffsetMap(buf);

  let u16 = 0;
  for (const ch of src) {
    const bytes = m.toBytes(u16);
    assert.equal(m.toUtf16(bytes), u16, `round trip failed at u16=${u16}`);
    assert.equal(
      buf.subarray(bytes, bytes + Buffer.byteLength(ch, "utf8")).toString("utf8"),
      ch,
      `slice mismatch at u16=${u16}`,
    );
    u16 += ch.length;
  }
});

test("lengths are reported in their own units", () => {
  const buf = Buffer.from("é🦀", "utf8");
  const m = new OffsetMap(buf);
  assert.equal(m.byteLength, 6); // 2 + 4
  assert.equal(m.utf16Length, 3); // 1 + 2
});
