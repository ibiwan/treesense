import assert from "node:assert/strict";
import { test } from "node:test";

import { languageFor, parse } from "./syntax.js";

const RUST = `use std::fmt;

/// Returns the widget count.
#[inline]
pub fn count(items: &[Item]) -> usize {
    // héllo ünicode
    let n = items.len();
    n
}

impl Widget {
    fn draw(&self) {}
}
`;

function at(src: string, needle: string): number {
  return Buffer.from(src, "utf8").indexOf(Buffer.from(needle, "utf8"));
}

test("extension mapping", () => {
  assert.equal(languageFor("src/main.rs"), "rust");
  assert.equal(languageFor("a/b.tsx"), "tsx");
  assert.equal(languageFor("notes.md"), null, "no grammar means no syntax layer");
});

test("nodeAt finds the smallest named node", () => {
  const buf = Buffer.from(RUST, "utf8");
  const tree = parse(buf, "rust");

  // Landing on an identifier gives the identifier, not its enclosing call —
  // that is the whole point of "smallest".
  const ident = tree.nodeAt(at(RUST, "items.len()"));
  assert.ok(ident !== null);
  assert.equal(ident.kind, "ident");
  assert.equal(ident.text(), "items");

  // Landing on punctuation gives the smallest *named* ancestor instead,
  // never the anonymous token itself.
  const dot = tree.nodeAt(at(RUST, ".len()"));
  assert.ok(dot !== null);
  assert.notEqual(dot.rawKind, ".", "must never return an anonymous token");
  assert.equal(dot.text(), "items.len", "the field expression, with the call above it");
});

test("byte ranges slice correctly past non-ASCII", () => {
  // The regression the whole offset layer exists for: before conversion, an
  // ast-grep range sliced against a UTF-8 buffer came back shifted by the
  // byte/unit difference — plausible-looking and wrong.
  const buf = Buffer.from(RUST, "utf8");
  const tree = parse(buf, "rust");

  const node = tree.nodeAt(at(RUST, "let n"));
  assert.ok(node !== null);
  const sliced = buf.subarray(node.bytes.start, node.bytes.end).toString("utf8");
  assert.equal(sliced, "let n = items.len();");
  assert.equal(sliced, node.text(), "byte range and node text must agree");
});

test("ancestors are innermost-first", () => {
  const tree = parse(Buffer.from(RUST, "utf8"), "rust");
  const node = tree.nodeAt(at(RUST, "items.len()"));
  assert.ok(node !== null);
  const chain = tree.ancestors(node).map((a) => a.kind);
  const fn = chain.indexOf("fn");
  const block = chain.indexOf("block");
  assert.ok(block >= 0 && fn >= 0, `expected block and fn in ${chain.join(">")}`);
  assert.ok(block < fn, "block encloses less than fn, so it must come first");
});

test("enclosingItem climbs to the declaration", () => {
  const tree = parse(Buffer.from(RUST, "utf8"), "rust");
  const node = tree.nodeAt(at(RUST, "items.len()"));
  assert.ok(node !== null);
  const item = tree.enclosingItem(node);
  assert.ok(item !== null);
  assert.equal(item.kind, "fn");
  assert.equal(item.name, "count");
});

test("item range absorbs doc comments and attributes", () => {
  // Replacing a function without its doc comment strands the comment
  // describing the old signature — and it still parses, so nothing catches it.
  const buf = Buffer.from(RUST, "utf8");
  const tree = parse(buf, "rust");
  const node = tree.nodeAt(at(RUST, "items.len()"));
  assert.ok(node !== null);
  const item = tree.enclosingItem(node);
  assert.ok(item !== null);

  const withDocs = tree.itemRangeWithDocs(item);
  const text = buf.subarray(withDocs.start, withDocs.end).toString("utf8");
  assert.ok(text.startsWith("/// Returns the widget count."), text.slice(0, 40));
  assert.ok(text.includes("#[inline]"));
  assert.ok(text.trimEnd().endsWith("}"));
});

test("a blank line detaches a comment from the item below", () => {
  const src = "// unrelated\n\nfn f() {}\n";
  const buf = Buffer.from(src, "utf8");
  const tree = parse(buf, "rust");
  const node = tree.nodeAt(at(src, "fn f"));
  assert.ok(node !== null);
  const item = tree.enclosingItem(node);
  assert.ok(item !== null);
  const range = tree.itemRangeWithDocs(item);
  assert.equal(buf.subarray(range.start, range.end).toString("utf8"), "fn f() {}");
});

test("identifiers on a declaration line include the declared name", () => {
  // Regression: scanning by offset and advancing past `nodeAt().bytes.end`
  // jumps the whole function body, because `nodeAt` on the `fn` keyword
  // returns the enclosing declaration. The name is then never seen.
  const buf = Buffer.from(RUST, "utf8");
  const tree = parse(buf, "rust");
  const names = tree.rootNode
    .identifiers()
    .filter((id) => {
      const line = RUST.slice(0, buf.subarray(0, id.bytes.start).toString("utf8").length);
      return line.split("\n").length === 5; // the `pub fn count(...)` line
    })
    .map((id) => id.text());
  assert.ok(names.includes("count"), `expected the declared name, got ${names.join(",")}`);
});
