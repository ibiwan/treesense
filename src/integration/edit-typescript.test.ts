import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReasonTs, startTypeScriptFixture } from "../testkit/index.js";

const skip = skipReasonTs();

/**
 * `edit` against the TypeScript fixture. edit.test.ts already covers the
 * verb's mechanics on the Rust side (they do not vary by language — edit.ts
 * and move.ts never touch the LSP client, only `syntax.ts`/`locate.ts`), so
 * this targets what's actually TS-specific per PLAN.md's "Left undone"
 * list: the `export_statement`-wrapper handle range under a real edit
 * (rather than just under `refs`), and the open-doc/`didChange` sync path
 * described in typescript.ts — our own write has to reach tsserver the same
 * way an external one does, just by a different notification, or a query
 * against a file we already opened silently goes stale.
 */
describe("edit (typescript)", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startTypeScriptFixture>>;
  let pristine: string;
  let mainPristine: string;

  before(async () => {
    fx = await startTypeScriptFixture();
    pristine = await fx.read("src/helper.ts");
    mainPristine = await fx.read("src/main.ts");
  });
  after(async () => {
    await fx?.stop();
  });
  beforeEach(async () => {
    await fx.write("src/helper.ts", pristine);
    await fx.write("src/main.ts", mainPristine);
  });

  /** A handle to `function scale`, spanning its JSDoc and the `export` wrapper. */
  async function scaleHandle(): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: "src/helper.ts:11" });
    const handle = amb.text.match(/(#\w+) \[[^\]]*\] :\d+ scale/)?.[1];
    assert.ok(handle, `no scale handle in:\n${amb.text}`);
    return handle;
  }

  async function clampHandle(): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: "src/helper.ts:21" });
    const handle = amb.text.match(/(#\w+) \[[^\]]*\] :\d+ clamp/)?.[1];
    assert.ok(handle, `no clamp handle in:\n${amb.text}`);
    return handle;
  }

  test("replace rewrites the referent -- JSDoc and export wrapper included -- and nothing else", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "replace",
      content:
        "export function scale(value: number, factor: number): number {\n  return Math.imul(value, factor);\n}",
    });
    assert.ok(res.ok, res.text);

    const after = await fx.read("src/helper.ts");
    assert.match(after, /Math\.imul/);
    assert.match(after, /export function clamp/, "the rest of the file must survive");
    assert.doesNotMatch(after, /value \* factor/);
    // The handle spans the JSDoc too (itemRangeWithDocs), so a replacement
    // that omits it drops the old doc comment along with the old body.
    assert.doesNotMatch(after, /Scales a värde/, after);
  });

  test("a replacement that does not parse is refused, and nothing is written", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "replace",
      content: "export function scale(value: number): number {\n  return value +\n}",
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /does not parse/, res.text);
    assert.equal(await fx.read("src/helper.ts"), pristine, "file untouched");
  });

  test("a stale dependency rejects the edit before touching the file", async () => {
    const target = await scaleHandle();
    const dep = await clampHandle();

    await fx.write("src/helper.ts", pristine.replace("value > ceiling", "value >= ceiling"));
    const before = await fx.read("src/helper.ts");

    const res = await fx.rpc({
      op: "edit",
      target,
      action: "replace",
      deps: [dep],
      content: "export function scale(value: number, factor: number): number { return value; }",
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.match(res.text, /CHANGED|GONE/, res.text);
    assert.equal(await fx.read("src/helper.ts"), before, "validated before writing");
  });

  test("insert-after places a sibling at the right indentation", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "insert-after",
      content: "export function doubled(value: number): number {\n  return scale(value, 2);\n}",
    });
    assert.ok(res.ok, res.text);

    const after = await fx.read("src/helper.ts");
    assert.match(after, /export function doubled/);
    // Body indentation comes from the buffer (2 spaces here), not the payload.
    assert.match(after, /\n {2}return scale\(value, 2\);\n/, after);
  });

  test("delete removes the referent without leaving a blank line", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({ op: "edit", target: handle, action: "delete" });
    assert.ok(res.ok, res.text);

    const after = await fx.read("src/helper.ts");
    assert.doesNotMatch(after, /export function scale/);
    assert.match(after, /export function clamp/);
    assert.doesNotMatch(after, /\n\n\n/, `no blank-line scar:\n${after}`);
  });

  test("handles after the edit shift; handles inside it are reported dead", async () => {
    // `clamp` sits below `scale`, so editing `scale` moves it without changing
    // it -- the case that must NOT invalidate, or a sequence of edits above a
    // referent never converges.
    const clamp = await clampHandle();
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
    assert.match(read.text, /export function clamp/, read.text);
  });

  test("edit refuses a position outright", async () => {
    const res = await fx.rpc({
      op: "edit",
      target: "src/helper.ts:11",
      action: "replace",
      content: "x",
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /takes a handle/, res.text);
  });

  test("delete reports where the caller now is, not what slid into the gap", async () => {
    // A whole nested statement inside `run`, not an item -- there is a real
    // enclosing scope (the function) to report, distinct from whatever
    // declaration happens to follow it in the file.
    const hit = await fx.rpc({
      op: "find",
      needle: "const clamped = clamp($A, $B);",
      haystack: "src/main.ts",
    });
    assert.ok(hit.ok, hit.text);
    const stmt = hit.text.match(/> (#\w+) /)?.[1];
    assert.ok(stmt, `no statement handle in:\n${hit.text}`);

    const res = await fx.rpc({ op: "edit", target: stmt, action: "delete" });
    assert.ok(res.ok, res.text);
    // Never a declaration from a different file entirely -- that is what
    // merely slid into the vacated offset.
    assert.doesNotMatch(res.text, /fn scale|fn clamp/, res.text);
  });

  test("the reply handle names the introduced item, not its JSDoc", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "insert-after",
      content:
        "/**\n * Doubles a värde.\n */\nexport function doubled(value: number): number {\n  return scale(value, 2);\n}",
    });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /fn doubled/, `reply should name the item:\n${res.text}`);

    const reply = res.text.match(/^(#\w+)/)?.[1];
    assert.ok(reply, res.text);
    const read = await fx.rpc({ op: "read", target: reply });
    assert.ok(read.ok, read.text);
    assert.match(read.text, /export function doubled/, read.text);
    assert.match(read.text, /Doubles a värde/, "the JSDoc belongs to the item");
  });

  test("the reply handle is exact enough to feed back into refs", async () => {
    const handle = await scaleHandle();
    const res = await fx.rpc({
      op: "edit",
      target: handle,
      action: "replace",
      content:
        "export function scale(value: number, factor: number): number {\n  return Math.imul(value, factor);\n}",
    });
    assert.ok(res.ok, res.text);
    const reply = res.text.match(/^(#\w+)/)?.[1];
    assert.ok(reply, res.text);

    const back = await fx.rpc({ op: "refs", target: reply });
    assert.ok(back.ok, back.text);
    assert.doesNotMatch(back.text, /^ambiguous/, `should resolve to scale:\n${back.text}`);
  });

  test("a write through our own verb reaches tsserver via didChange, not disk", async () => {
    // Force helper.ts open in tsserver's mind -- `refs` always opens its own
    // query target (see typescript.ts's `ensureOpen`). Once open, tsserver
    // stops trusting disk for this file; only `textDocument/didChange` keeps
    // its view current, which is what `Workspace.files.onChange` -> `
    // TypeScriptServer.didChangeWatched` exists to send after our own writes.
    // If that path were silently broken, `edit` would still succeed (it
    // never touches the LSP client) and only a *subsequent* LSP-backed query
    // would show the staleness -- which is exactly what a raw-disk-write
    // test like the declaration-merging one in typescript.test.ts cannot
    // exercise, since it never opens the file through a real edit first.
    const opened = await fx.rpc({ op: "refs", target: "src/helper.ts:11" });
    assert.ok(opened.ok, opened.text);

    const handle = await scaleHandle();
    const edited = await fx.rpc({
      op: "edit",
      target: handle,
      action: "insert-after",
      content: "export function doubled(value: number): number {\n  return scale(value, 2);\n}",
    });
    assert.ok(edited.ok, edited.text);
    // tsserver reindexes asynchronously after didChange; give it a moment,
    // same allowance typescript.test.ts's declaration-merging test makes.
    await new Promise((r) => setTimeout(r, 500));

    const found = await fx.rpc({ op: "refs", target: "doubled" });
    assert.ok(found.ok, found.text);
    assert.match(found.text, /^refs doubled/, found.text);
  });
});
