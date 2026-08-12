import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReasonTs, startTypeScriptFixture } from "../testkit/index.js";

const skip = skipReasonTs();

/**
 * The handle lifecycle under mutation, against the TypeScript fixture.
 *
 * handles.test.ts already covers this mechanism on the Rust side; the
 * mechanism itself (files.ts, handles.ts) does not vary by language. What
 * does vary is everything upstream of it that a handle's relocation and
 * digest checks depend on: tree-sitter-typescript's node shapes (JSDoc
 * attachment, `export` wrappers), and — for `moved`/`edited` in
 * particular — whatever tsserver-facing state a prior query left behind
 * (see typescript.ts's open-doc/didChange notes). Only the declaration-
 * merging ambiguity case was covered before this file; see PLAN.md.
 *
 * Every case mutates the fixture *copy*, same reasoning as the Rust suite.
 */
describe("handle lifecycle (typescript)", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startTypeScriptFixture>>;
  let pristine: string;

  before(async () => {
    fx = await startTypeScriptFixture();
    pristine = await fx.read("src/helper.ts");
  });
  after(async () => {
    await fx?.stop();
  });
  beforeEach(async () => {
    await fx.write("src/helper.ts", pristine);
  });

  /** A handle to `function scale`, minted fresh against current file state. */
  async function scaleHandle(): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: "src/helper.ts:11" });
    const ident = amb.text.match(/(#\w+) \[[^\]]*\] :\d+ scale/)?.[1];
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
    // Unlike the Rust fixture, `scale`'s JSDoc opens the file with nothing
    // above it — a blank line after the inserted comment is required, or the
    // insertion glues onto the doc block itself (same `attachedTo` rule that
    // makes a real doc comment stick to its item, just triggered by an
    // unrelated line that happens to sit hard against it).
    const handle = await scaleHandle();
    await fx.write("src/helper.ts", `// a new line at the top\n\n${pristine}`);

    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /changed:/, `moving is not changing:\n${res.text}`);
    assert.match(res.text, /export function scale/, res.text);
  });

  test("edit the referent: reads succeed but say so", async () => {
    const handle = await scaleHandle();
    await fx.write("src/helper.ts", pristine.replace("value * factor", "value * factor + 0"));

    const res = await fx.rpc({ op: "read", target: handle });
    assert.ok(res.ok, "a read may recover; only a write must refuse");
    assert.match(res.text, /^changed:/, `the caller's premise moved:\n${res.text}`);
    assert.match(res.text, /factor \+ 0/, res.text);

    const replacement = res.text.match(/^changed: (#\w+)/)?.[1];
    assert.ok(replacement, res.text);
    const again = await fx.rpc({ op: "read", target: replacement });
    assert.ok(again.ok, again.text);
    assert.doesNotMatch(again.text, /^changed:/, "the replacement is current");
  });

  test("delete the referent: gone, and not retryable", async () => {
    const handle = await scaleHandle();
    await fx.write("src/helper.ts", pristine.replace(/export function scale[\s\S]*?\n}\n/, ""));

    const res = await fx.rpc({ op: "read", target: handle });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /gone/, res.text);
    assert.doesNotMatch(res.text, /changed/, res.text);
  });

  test("a touch that changes no bytes invalidates nothing", async () => {
    const handle = await scaleHandle();
    await fx.write("src/helper.ts", pristine); // identical content

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
    const handle = await scaleHandle();
    await fx.write("src/helper.ts", `// pushed down\n// by two lines\n${pristine}`);

    const res = await fx.rpc({ op: "refs", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /^ambiguous/, `should still resolve to scale:\n${res.text}`);
    assert.match(res.text, /^refs scale /, res.text);
  });
});
