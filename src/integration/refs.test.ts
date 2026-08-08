import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

describe("refs against a real workspace", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;

  before(async () => {
    fx = await startFixture();
  });
  after(async () => {
    await fx?.stop();
  });

  test("a bare position with several symbols is ambiguous, not a guess", async () => {
    // `pub fn run(seed: u32) -> u32 {` holds `run`, `seed` and two `u32`s.
    const res = await fx.rpc({ op: "refs", target: "src/pipeline.rs:9" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^ambiguous:/, res.text);
    assert.match(res.text, /#\w+ \[.*::run\] :\d+ run/, res.text);
  });

  test("a symbolic address resolves through the workspace symbol index", async () => {
    const res = await fx.rpc({ op: "refs", target: "scale" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^refs scale [1-9]/, res.text);
    assert.match(res.text, /src\/main\.rs/, res.text);
  });

  test("refs crosses a crate boundary", async () => {
    // `scale` is declared in the helper crate and used from two files in the
    // root package. Finding those is resolution, not text matching — nothing
    // in `main.rs` spells the helper crate's path the way the definition does.
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:10" });
    assert.ok(amb.ok, amb.text);
    const handle = amb.text.match(/(#\w+) \[.*::scale\] :\d+ scale/)?.[1];
    assert.ok(handle, `no handle for scale in:\n${amb.text}`);

    const res = await fx.rpc({ op: "refs", target: handle });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /src\/main\.rs/, res.text);
    assert.match(res.text, /src\/pipeline\.rs/, res.text);
  });

  test("hierarchy carries a handle for the enclosing item", async () => {
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:10" });
    const scale = amb.text.match(/(#\w+) \[.*::scale\] :\d+ scale/)?.[1];
    assert.ok(scale);
    const res = await fx.rpc({ op: "refs", target: scale });

    // `> #x :n ident scale > #y :a-b fn main` — the trailing handle is what
    // the caller reads next, which is why it is front-loaded here rather than
    // costing an extra round trip.
    //
    // Anchored on the handle-plus shape rather than spanning `>` separators:
    // a looser pattern happily matches across newlines into the next file's
    // block and captures a token handle instead.
    const item = res.text.match(/(#\w+) \[[^\]]*::\w+\] :[\d-]+ fn \w/)?.[1];
    assert.ok(item, `no item handle in:\n${res.text}`);

    const read = await fx.rpc({ op: "read", target: item });
    assert.ok(read.ok, read.text);
    assert.match(read.text, /fn (main|run)\b/, read.text);
  });

  test("declaration handles resolve to their own name", async () => {
    // A handle to `fn run` means references to `run` — not an enumeration of
    // every identifier in its body.
    const amb = await fx.rpc({ op: "refs", target: "src/pipeline.rs:9" });
    const run = amb.text.match(/(#\w+) \[.*::run\] :\d+ run/)?.[1];
    assert.ok(run);
    const res = await fx.rpc({ op: "refs", target: run });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /^ambiguous/, res.text);
  });

  test("refs declines a file it has no grammar for", async () => {
    const res = await fx.rpc({ op: "refs", target: "README.md:3" });
    assert.equal(res.ok, false);
    assert.match(res.text, /no grammar/, res.text);
  });

  test("read falls back to literal lines without a grammar", async () => {
    const res = await fx.rpc({ op: "read", target: "config.toml:3-4" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /width = 320/, res.text);
  });

  test("project overview orients without reading source or waiting for the index", async () => {
    const res = await fx.rpc({ op: "overview" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^project /, res.text);
    assert.match(res.text, /source tree \(depth 2;/, res.text);
    assert.match(res.text, /  src\/ \(/, res.text);
    assert.match(res.text, /next: read a listed file/, res.text);
  });

  test("an oversized read becomes a navigable structural overview", async () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      `pub fn section_${i}() {\n    let value = ${i};\n    assert_eq!(value, ${i});\n}\n`,
    ).join("\n");
    await fx.write("src/overview.rs", manyItems);

    const overview = await fx.rpc({ op: "read", target: "src/overview.rs" });
    assert.ok(overview.ok, overview.text);
    assert.match(overview.text, /^overview .*overview\.rs:1-249 — 249 lines, /, overview.text);
    assert.match(overview.text, /summary shown instead of raw source by overview guard/, overview.text);
    assert.match(overview.text, /suggested first sections: #\w+ \[.*::section_0\]/, overview.text);
    const section = overview.text.match(/^> (#\w+) \[.*::section_0\] :\d+-\d+ fn section_0/m)?.[1];
    assert.ok(section, overview.text);

    const child = await fx.rpc({ op: "read", target: section });
    assert.ok(child.ok, child.text);
    assert.match(child.text, /pub fn section_0/, child.text);

    const forced = await fx.rpc({ op: "read", target: "src/overview.rs", maxLines: -1 });
    assert.ok(forced.ok, forced.text);
    assert.match(forced.text, /pub fn section_49/, forced.text);
  });

  test("an oversized function handle outlines its first-level control flow", async () => {
    const branches = Array.from({ length: 45 }, (_, i) =>
      `${i === 0 ? "    // first phase\n" : ""}    if value == ${i} {\n        value += 1;\n    }\n`,
    ).join("");
    await fx.write("src/large_function.rs", `pub fn large(mut value: u32) -> u32 {\n${branches}    value\n}\n`);

    const file = await fx.rpc({ op: "read", target: "src/large_function.rs" });
    const handle = file.text.match(/^> (#\w+) \[.*::large\] :\d+-\d+ fn large/m)?.[1];
    assert.ok(handle, file.text);

    const overview = await fx.rpc({ op: "read", target: handle });
    assert.ok(overview.ok, overview.text);
    assert.match(overview.text, /^overview .*large_function\.rs:/, overview.text);
    assert.match(overview.text, /^> #\w+ \[.*::branch\] :\d+-\d+ branch — first phase/m, overview.text);
    assert.match(overview.text, /^> #\w+ \[.*::branch\] :\d+-\d+ branch — if value == 1 \{/m, overview.text);

    const sections = [...overview.text.matchAll(/^> (#\w+) \[.*::branch\] :\d+-\d+ branch/mg)].slice(0, 2).map((match) => match[1]!);
    assert.equal(sections.length, 2, overview.text);
    const batch = await fx.rpc({ op: "read", target: handle, sections });
    assert.ok(batch.ok, batch.text);
    assert.match(batch.text, /^read sections from #\w+ \(2\)/, batch.text);
    assert.match(batch.text, /if value == 0/, batch.text);
    assert.match(batch.text, /if value == 1/, batch.text);
  });

  test("the density guard fires on a pathological line", async () => {
    const res = await fx.rpc({ op: "read", target: "dense.txt:1" });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /exceeds/, res.text);

    const forced = await fx.rpc({ op: "read", target: "dense.txt:1", maxBytesPerLine: -1 });
    assert.ok(forced.ok, forced.text);
    assert.ok(forced.text.length > 4000, "the override must actually return it");
  });

  test("a position range honours its end, not just its start", async () => {
    // `src/main.rs:12-13` is the shadowing pair. Looking only at line 12 would
    // report a single symbol and answer confidently about the wrong thing.
    const one = await fx.rpc({ op: "refs", target: "src/main.rs:12" });
    const both = await fx.rpc({ op: "refs", target: "src/main.rs:12-13" });
    assert.ok(both.ok, both.text);
    assert.match(both.text, /^ambiguous:/, both.text);

    const count = (t: string) => (t.match(/^#\w+ /gm) ?? []).length;
    assert.ok(
      count(both.text) > count(one.text),
      `the range must see more than its first line:\n${both.text}`,
    );
  });

  test("same-spelled symbols are not collapsed into one candidate", async () => {
    // `let raw = 7;` then `let raw = raw + 1;` — two distinct bindings that
    // happen to share a spelling. Deduping by text would drop the choice this
    // response exists to offer.
    const res = await fx.rpc({ op: "refs", target: "src/main.rs:12-13" });
    assert.ok(res.ok, res.text);
    const raws = (res.text.match(/^#\w+ \[.*::raw\] :\d+ raw\b/gm) ?? []).length;
    assert.ok(raws >= 2, `expected several raw candidates, got ${raws}:\n${res.text}`);
  });
});
