import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

describe("find", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;

  before(async () => {
    fx = await startFixture();
  });
  after(async () => {
    await fx?.stop();
  });

  test("text search spans the workspace and groups by file", async () => {
    const res = await fx.rpc({ op: "find", needle: "scale" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^find "scale" text \d+/, res.text);
    assert.match(res.text, /crates\/helper\/src\/lib\.rs/, res.text);
    assert.match(res.text, /src\/main\.rs/, res.text);
  });

  test("the reading used is stated, so a misread costs a line not a round trip", async () => {
    const text = await fx.rpc({ op: "find", needle: "clamp" });
    const pattern = await fx.rpc({ op: "find", needle: "scale($A, $B)" });
    assert.match(text.text, /^find "clamp" text /, text.text);
    assert.match(pattern.text, /^find "scale\(\$A, \$B\)" pattern /, pattern.text);
  });

  test("a structural pattern matches by shape, not by spelling", async () => {
    // Two call sites with different arguments — `scale(seed, step)` and
    // `scale(seed + 1, step)`. No literal string matches both.
    const res = await fx.rpc({ op: "find", needle: "scale($A, $B)" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /scale\(seed, step\)/, res.text);
    assert.match(res.text, /scale\(seed \+ 1, step\)/, res.text);
  });

  test("no matches is an answer, not an error", async () => {
    const res = await fx.rpc({ op: "find", needle: "definitely_not_present_anywhere" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, / 0$/, res.text);
  });

  test("a file haystack narrows the search", async () => {
    const all = await fx.rpc({ op: "find", needle: "scale" });
    const one = await fx.rpc({ op: "find", needle: "scale", haystack: "src/main.rs" });
    assert.ok(one.ok, one.text);
    assert.doesNotMatch(one.text, /pipeline\.rs/, one.text);
    assert.match(all.text, /pipeline\.rs/, "the unscoped search should have found more");
  });

  test("a handle haystack bounds the search to that node", async () => {
    const amb = await fx.rpc({ op: "refs", target: "src/pipeline.rs:9" });
    const run = amb.text.match(/(#\w+) :\d+ run/)?.[1];
    assert.ok(run, amb.text);

    const res = await fx.rpc({ op: "find", needle: "scale", haystack: run });
    assert.ok(res.ok, res.text);
    // `use helper::{clamp, scale};` is line 1, outside `fn run` — so a search
    // bounded by the handle must not see it.
    assert.doesNotMatch(res.text, /use helper/, res.text);
    assert.match(res.text, /total \+= scale/, res.text);
  });

  test("hits carry a handle that feeds straight back into refs", async () => {
    const res = await fx.rpc({ op: "find", needle: "clamp", haystack: "src/pipeline.rs" });
    assert.ok(res.ok, res.text);
    const handle = res.text.match(/> (#\w+) /)?.[1];
    assert.ok(handle, res.text);

    const back = await fx.rpc({ op: "refs", target: handle });
    assert.ok(back.ok, back.text);
    assert.doesNotMatch(back.text, /^ambiguous/, `a hit handle must be exact:\n${back.text}`);
  });

  test("find needs no index — it reads files, not name resolution", async () => {
    // Nothing here asserts on timing; the point is that the same call works
    // without ever awaiting readiness, which `refs` cannot do.
    const res = await fx.rpc({ op: "find", needle: "värde" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /värde/, "non-ASCII needles must round-trip");
  });

  test("literal search works in files no grammar covers", async () => {
    // The fixture carries a .md and a .toml precisely for this path. `read`
    // already falls back to literal lines for them; a text search that cannot
    // look at them contradicts "find string in file" being a basic capability.
    const md = await fx.rpc({ op: "find", needle: "load-bearing", haystack: "README.md" });
    assert.ok(md.ok, md.text);
    assert.match(md.text, / text [1-9]/, `should have found it:\n${md.text}`);

    const toml = await fx.rpc({ op: "find", needle: "width", haystack: "config.toml:1-5" });
    assert.ok(toml.ok, toml.text);
    assert.match(toml.text, /width = 320/, `a line range needs no grammar:\n${toml.text}`);
  });

  test("a grammarless hit still carries a usable handle", async () => {
    const res = await fx.rpc({ op: "find", needle: "load-bearing", haystack: "README.md" });
    const handle = res.text.match(/> (#\w+) /)?.[1];
    assert.ok(handle, res.text);

    const read = await fx.rpc({ op: "read", target: handle });
    assert.ok(read.ok, read.text);
    assert.match(read.text, /load-bearing/, read.text);
  });

  test("a malformed pattern is an error, not zero results", async () => {
    // Zero matches is meaningful information here, so a broken query must not
    // be able to impersonate one.
    const res = await fx.rpc({ op: "find", needle: "fn $A( { ) $B" });
    assert.equal(res.ok, false, `malformed patterns must not read as empty:\n${res.text}`);
    assert.match(res.text, /pattern is not valid/, res.text);
  });

  test("the hit cap applies to grammarless files too", async () => {
    // A cap enforced only in the parsed path is not a cap. dense.txt holds
    // 4000 occurrences on one line, and is grammarless.
    const res = await fx.rpc({ op: "find", needle: "x", haystack: "dense.txt" });
    assert.ok(res.ok, res.text);

    const count = Number(res.text.match(/ text (\d+)/)?.[1]);
    assert.ok(Number.isFinite(count), res.text);
    assert.ok(count <= 60, `cap must hold on this path too, got ${count}`);
    assert.match(res.text, /text \d+\+/, `truncation must be marked:\n${res.text.split("\n")[0]}`);
    assert.match(res.text, /capped at 60 hits/, res.text);
    // And the hit cap alone does not bound the response: each snippet is a
    // 4000-byte line, so snippets must be capped independently.
    assert.ok(res.text.length < 20_000, `response should stay readable: ${res.text.length}B`);
  });
});
