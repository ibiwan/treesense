import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

/**
 * The handle lifecycle under mutation — the machinery everything else rests
 * on, and until this suite existed, entirely untested code.
 *
 * Every case mutates the fixture *copy*, which is why the harness copies at
 * all. The committed fixture is never touched.
 */
describe("handle lifecycle", { skip }, () => {
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

  /** A handle to `fn scale`, minted fresh against current file state. */
  async function scaleHandle(): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: "crates/helper/src/lib.rs:10" });
    const ident = amb.text.match(/(#\w+) :\d+ scale/)?.[1];
    assert.ok(ident, `no scale handle in:\n${amb.text}`);
    const res = await fx.rpc({ op: "read", target: ident });
    assert.ok(res.ok, res.text);
    return ident;
  }

  test("unchanged file: the handle just resolves", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /changed:/, res.text);
  });

  test("insert above: the referent moved but did not change", async () => {
    // The classic false conflict. Bytes shifted, meaning untouched — rejecting
    // here would make any sequence of edits above a referent fail to converge.
    const handle = await scaleHandle();
    await fx.write("crates/helper/src/lib.rs", `// a new line at the top\n${pristine}`);

    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /changed:/, `moving is not changing:\n${res.text}`);
    assert.match(res.text, /pub fn scale/, res.text);
  });

  test("edit the referent: reads succeed but say so", async () => {
    const handle = await scaleHandle();
    await fx.write(
      "crates/helper/src/lib.rs",
      pristine.replace("value * factor", "value.saturating_mul(factor)"),
    );

    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, "a read may recover; only a write must refuse");
    assert.match(res.text, /^changed:/, `the caller's premise moved:\n${res.text}`);
    assert.match(res.text, /saturating_mul/, res.text);

    // The marker must carry a usable replacement, not just a warning.
    const replacement = res.text.match(/^changed: (#\w+)/)?.[1];
    assert.ok(replacement, res.text);
    const again = await fx.rpc({ op: "read", target: replacement });
    assert.ok(again.ok, again.text);
    assert.doesNotMatch(again.text, /^changed:/, "the replacement is current");
  });

  test("delete the referent: gone, and not retryable", async () => {
    const handle = await scaleHandle();
    await fx.write(
      "crates/helper/src/lib.rs",
      pristine.replace(/#\[inline\]\npub fn scale[\s\S]*?\n}\n/, ""),
    );

    const res = await fx.rpc({ op: "read", target: handle });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /gone/, res.text);
    // "gone" must be distinguishable from "changed": one means re-read and
    // retry, the other means the plan itself needs revisiting.
    assert.doesNotMatch(res.text, /changed/, res.text);
  });

  test("a touch that changes no bytes invalidates nothing", async () => {
    const handle = await scaleHandle();
    await fx.write("crates/helper/src/lib.rs", pristine); // identical content

    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /changed:/, "identical bytes are not a change");
  });

  test("an unknown handle is refused without guessing", async () => {
    const res = await fx.rpc({ op: "read", target: "#ZZZZZZ" });
    assert.equal(res.ok, false);
    assert.match(res.text, /unknown/, res.text);
  });

  test("a relocated handle can still be questioned", async () => {
    // Relocation rewrites the byte range, and the anchor lives inside it. If
    // only the range moves, the next question about this handle is asked at
    // whatever now occupies the old offset — a wrong answer that looks fine.
    const handle = await scaleHandle();
    await fx.write("crates/helper/src/lib.rs", `// pushed down\n// by two lines\n${pristine}`);

    const res = await fx.rpc({ op: "refs", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /^ambiguous/, `should still resolve to scale:\n${res.text}`);
    assert.match(res.text, /^refs scale /, res.text);
  });
});
