import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

describe("edit", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;
  let pristine: string;

  before(async () => {
    fx = await startFixture();
    pristine = await fx.read("crates/helper/src/lib.rs");
  });
  after(async () => {
    await fx?.stop();
  });
  beforeEach(async () => {
    await fx.write("crates/helper/src/lib.rs", pristine);
  });

  /** A handle to `fn scale`, minted against current state. */
  async function scaleHandle(): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:10" });
    const handle = amb.text.match(/(#\w+) :\d+ scale/)?.[1];
    assert.ok(handle, `no scale handle in:\n${amb.text}`);
    return handle;
  }

  test("replace rewrites the referent and nothing else", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "replace",
      content: "#[inline]\npub fn scale(value: u32, factor: u32) -> u32 {\n    value.saturating_mul(factor)\n}",
    });
    assert.ok(res.ok, res.text);

    const after = await fx.read("crates/helper/src/lib.rs");
    assert.match(after, /saturating_mul/);
    assert.match(after, /pub fn clamp/, "the rest of the file must survive");
    assert.doesNotMatch(after, /value \* factor/);
  });

  test("a replacement that does not parse is refused, and nothing is written", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "replace",
      content: "pub fn scale(value: u32) -> u32 {\n    value",
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /does not parse/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), pristine, "file untouched");
  });

  test("a stale dependency rejects the edit before touching the file", async () => {
    const target = await scaleHandle();
    // `clamp` as a witness: the edit's correctness is declared to depend on it.
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:18" });
    const dep = amb.text.match(/(#\w+) :\d+ clamp/)?.[1];
    assert.ok(dep, `no clamp handle in:\n${amb.text}`);

    // Something else changes the witness out from under the plan.
    await fx.write(
      "crates/helper/src/lib.rs",
      pristine.replace("if value > ceiling {", "if value >= ceiling {"),
    );
    const before = await fx.read("crates/helper/src/lib.rs");

    const res = await fx.rpc({
      op: "edit",
      target,
      action: "replace",
      deps: [dep],
      content: "pub fn scale(value: u32, factor: u32) -> u32 { value }",
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.match(res.text, /CHANGED|GONE/, res.text);
    assert.equal(await fx.read("crates/helper/src/lib.rs"), before, "validated before writing");
  });

  test("insert-after places a sibling at the right indentation", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "insert-after",
      content: "pub fn doubled(value: u32) -> u32 {\n    scale(value, 2)\n}",
    });
    assert.ok(res.ok, res.text);

    const after = await fx.read("crates/helper/src/lib.rs");
    assert.match(after, /pub fn doubled/);
    // Body indentation comes from the buffer, not from the payload.
    assert.match(after, /\n {4}scale\(value, 2\)\n/, after);
  });

  test("delete removes the referent without leaving a blank line", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({ op: "edit", target: handle, action: "delete" });
    assert.ok(res.ok, res.text);

    const after = await fx.read("crates/helper/src/lib.rs");
    assert.doesNotMatch(after, /pub fn scale/);
    assert.match(after, /pub fn clamp/);
    assert.doesNotMatch(after, /\n\n\n/, `no blank-line scar:\n${after}`);
  });

  test("handles after the edit shift; handles inside it are reported dead", async () => {
    // `clamp` sits below `scale`, so editing `scale` moves it without changing
    // it — the case that must NOT invalidate, or a sequence of edits above a
    // referent never converges.
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:18" });
    const clamp = amb.text.match(/(#\w+) :\d+ clamp/)?.[1];
    assert.ok(clamp);
    const scale = await scaleHandle();

    const res = await fx.rpc({
      op: "edit",
      target: scale,
      action: "insert-before",
      content: "// a comment that pushes everything down\n// by two whole lines",
    });
    assert.ok(res.ok, res.text);

    const read = await fx.rpc({ op: "read", target: clamp });
    assert.ok(read.ok, read.text);
    assert.doesNotMatch(read.text, /changed:/, `shifted is not changed:\n${read.text}`);
    assert.match(read.text, /pub fn clamp/, read.text);
  });

  test("edit refuses a position outright", async () => {
    const res = await fx.rpc({
      op: "edit",
      target: "crates/helper/src/lib.rs:10",
      action: "replace",
      content: "x",
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /takes a handle/, res.text);
  });

  test("delete reports where the caller now is, not what slid into the gap", async () => {
    // A nested statement, so there is a real enclosing scope to report.
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:11" });
    const stmt = amb.text.match(/(#\w+) :\d+ value/)?.[1];
    assert.ok(stmt, amb.text);

    const res = await fx.rpc({ op: "edit", target: stmt, action: "delete" });
    assert.ok(res.ok, res.text);
    // Never the following item — that is what merely moved.
    assert.doesNotMatch(res.text, /fn clamp/, res.text);
  });
});
