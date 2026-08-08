import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

describe("move", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;
  let lib: string;
  let pipeline: string;

  before(async () => {
    fx = await startFixture();
    lib = await fx.read("crates/helper/src/lib.rs");
    pipeline = await fx.read("src/pipeline.rs");
  });
  after(async () => {
    await fx?.stop();
  });
  beforeEach(async () => {
    await fx.write("crates/helper/src/lib.rs", lib);
    await fx.write("src/pipeline.rs", pipeline);
  });

  async function handleFor(target: string, name: string): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target });
    const handle = amb.text.match(new RegExp(`(#\\w+) \\[[^\\]]*\\] :\\d+ ${name}`))?.[1];
    assert.ok(handle, `no ${name} handle in:\n${amb.text}`);
    return handle;
  }

  test("relocates the referent within one file and removes it from the old spot", async () => {
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");

    const res = await fx.rpc({ op: "move", source: scale, destination: clamp, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /fn scale/, res.text);

    const after = await fx.read("crates/helper/src/lib.rs");
    const clampAt = after.indexOf("pub fn clamp");
    const scaleAt = after.indexOf("pub fn scale");
    assert.ok(clampAt >= 0 && scaleAt >= 0, after);
    assert.ok(scaleAt > clampAt, `scale should now follow clamp:\n${after}`);
    assert.doesNotMatch(after, /\n\n\n/, `no blank-line scar:\n${after}`);
  });

  test("a bystander handle shifts rather than dies", async () => {
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");

    const res = await fx.rpc({ op: "move", source: scale, destination: clamp, action: "insert-after" });
    assert.ok(res.ok, res.text);

    const read = await fx.rpc({ op: "read", target: clamp });
    assert.ok(read.ok, read.text);
    assert.doesNotMatch(read.text, /changed:/, `shifted is not changed:\n${read.text}`);
    assert.match(read.text, /pub fn clamp/, read.text);
  });

  test("destination adjacent to source is a no-op — nothing is written", async () => {
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");

    const res = await fx.rpc({ op: "move", source: scale, destination: scale, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /unchanged/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), lib, "file must be byte-identical");
  });

  test("a destination inside the source being moved is rejected", async () => {
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");
    // Two identifiers on this line (`value`, `factor`), so it resolves as
    // ambiguous candidates — same pattern edit.test.ts uses for a nested token.
    const value = await handleFor("crates/helper/src/lib.rs:11", "value");

    const res = await fx.rpc({ op: "move", source: scale, destination: value, action: "insert-after" });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /lands inside the source/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), lib, "file must be untouched");
  });

  test("a stale dependency rejects the move before touching the file", async () => {
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");
    // An unrelated dep in a different file, so mutating it does not also
    // touch source or destination — which would be caught earlier, by their
    // own phase-1 checks, and never reach the dep-rejection path at all.
    const run = await handleFor("src/pipeline.rs:9", "run");

    await fx.write("src/pipeline.rs", pipeline.replace("for step in 0..3 {", "for step in 0..4 {"));
    const before = await fx.read("crates/helper/src/lib.rs");

    const res = await fx.rpc({ op: "move", source: scale, destination: clamp, action: "insert-after", deps: [run] });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.match(res.text, /CHANGED|GONE/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), before, "validated before writing");
  });

  test("move takes handles only, not positions", async () => {
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");
    const res = await fx.rpc({
      op: "move",
      source: "crates/helper/src/lib.rs:10",
      destination: clamp,
      action: "insert-after",
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /takes a handle/, res.text);
  });

  test("cross-file: relocates the referent and removes it from the source file", async () => {
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");
    const run = await handleFor("src/pipeline.rs:9", "run");

    const res = await fx.rpc({ op: "move", source: clamp, destination: run, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /fn clamp/, res.text);

    const newLib = await fx.read("crates/helper/src/lib.rs");
    const newPipeline = await fx.read("src/pipeline.rs");
    assert.doesNotMatch(newLib, /pub fn clamp/, `clamp must be gone from the source:\n${newLib}`);
    assert.match(newPipeline, /pub fn clamp/, `clamp must appear at the destination:\n${newPipeline}`);

    // The old handle's referent is gone. It reads as `unknown` rather than
    // `gone`, because deletion killed it via the same rebase-overlap path
    // that removes any handle overlapping an edit — the entry is dropped
    // outright, not left behind for `resolve`'s digest check to label.
    const read = await fx.rpc({ op: "read", target: clamp });
    assert.match(read.text, /unknown/, read.text);
  });

  test("cross-file: a dependency already dead at validation time rejects cleanly, zero writes", async () => {
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");
    const scale = await handleFor("crates/helper/src/lib.rs:10", "scale");
    const run = await handleFor("src/pipeline.rs:9", "run");

    // Mutate the dep (`scale`), not source or destination (`clamp`, `run`) —
    // otherwise their own phase-1 checks catch it first.
    await fx.write("crates/helper/src/lib.rs", lib.replace("value * factor", "value * factor + 0"));
    const beforeLib = await fx.read("crates/helper/src/lib.rs");

    const res = await fx.rpc({ op: "move", source: clamp, destination: run, action: "insert-after", deps: [scale] });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), beforeLib, "source untouched");
    assert.equal(await fx.read("src/pipeline.rs"), pipeline, "destination untouched");
  });

  test("cross-file: a dep invalidated by the destination write itself yields a partial result, not a loss", async () => {
    // `run`'s own handle straddles anywhere inside its body — including the
    // spot this test inserts into — so declaring it as a dep here means the
    // destination write's own rebase kills it deterministically, without any
    // real race. That is exactly the case a partial report exists to cover.
    const clamp = await handleFor("crates/helper/src/lib.rs:18", "clamp");
    const run = await handleFor("src/pipeline.rs:9", "run");
    // The whole statement, not the bare call — inserting a full `fn` item
    // before a mid-expression node is not valid Rust at all, which is a
    // different failure than the one this test means to exercise.
    const hit = await fx.rpc({
      op: "find",
      needle: "total += scale($A, $B);",
      haystack: "src/pipeline.rs",
    });
    const insideRun = hit.text.match(/> (#\w+) /)?.[1];
    assert.ok(insideRun, hit.text);

    const res = await fx.rpc({
      op: "move",
      source: clamp,
      destination: insideRun,
      action: "insert-before",
      deps: [run],
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /move partial: inserted/, res.text);
    assert.match(res.text, new RegExp(`${run} (UNKNOWN|GONE)`), res.text);

    // Add-before-remove: the destination write already landed, so a duplicate
    // exists — the source must NOT have been touched.
    const newLib = await fx.read("crates/helper/src/lib.rs");
    const newPipeline = await fx.read("src/pipeline.rs");
    assert.match(newLib, /pub fn clamp/, `source must still hold its copy:\n${newLib}`);
    assert.match(newPipeline, /fn clamp/, `destination must hold the new copy:\n${newPipeline}`);
  });
});
