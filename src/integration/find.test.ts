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
});
