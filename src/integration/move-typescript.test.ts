import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { skipReasonTs, startTypeScriptFixture } from "../testkit/index.js";

const skip = skipReasonTs();

/**
 * `move` against the TypeScript fixture. move.test.ts already covers the
 * verb's mechanics on the Rust side (move.ts, like edit.ts, never touches
 * the LSP client), so this targets what's actually TS-specific per
 * PLAN.md's "Left undone" list: cross-file relocation through the
 * `export_statement` wrapper, and the open-doc/`didChange` sync path --
 * moving a declaration into a file tsserver already has open must reach it
 * the same way an external edit would, or a query right after goes stale.
 */
describe("move (typescript)", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startTypeScriptFixture>>;
  let helper: string;
  let main: string;

  before(async () => {
    fx = await startTypeScriptFixture();
    helper = await fx.read("src/helper.ts");
    main = await fx.read("src/main.ts");
  });
  after(async () => {
    await fx?.stop();
  });
  beforeEach(async () => {
    await fx.write("src/helper.ts", helper);
    await fx.write("src/main.ts", main);
  });

  async function handleFor(target: string, name: string): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target });
    const handle = amb.text.match(new RegExp(`(#\\w+) \\[[^\\]]*\\] :\\d+ ${name}`))?.[1];
    assert.ok(handle, `no ${name} handle in:\n${amb.text}`);
    return handle;
  }

  test("relocates the referent within one file and removes it from the old spot", async () => {
    const scale = await handleFor("src/helper.ts:11", "scale");
    const clamp = await handleFor("src/helper.ts:21", "clamp");

    const res = await fx.rpc({ op: "move", source: scale, destination: clamp, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /fn scale/, res.text);

    const afterFile = await fx.read("src/helper.ts");
    const clampAt = afterFile.indexOf("export function clamp");
    const scaleAt = afterFile.indexOf("export function scale");
    assert.ok(clampAt >= 0 && scaleAt >= 0, afterFile);
    assert.ok(scaleAt > clampAt, `scale should now follow clamp:\n${afterFile}`);
    assert.doesNotMatch(afterFile, /\n\n\n/, `no blank-line scar:\n${afterFile}`);
  });

  test("a bystander handle shifts rather than dies", async () => {
    const scale = await handleFor("src/helper.ts:11", "scale");
    const clamp = await handleFor("src/helper.ts:21", "clamp");

    const res = await fx.rpc({ op: "move", source: scale, destination: clamp, action: "insert-after" });
    assert.ok(res.ok, res.text);

    const read = await fx.rpc({ op: "read", target: clamp });
    assert.ok(read.ok, read.text);
    assert.doesNotMatch(read.text, /changed:/, `shifted is not changed:\n${read.text}`);
    assert.match(read.text, /export function clamp/, read.text);
  });

  test("destination adjacent to source is a no-op -- nothing is written", async () => {
    const scale = await handleFor("src/helper.ts:11", "scale");

    const res = await fx.rpc({ op: "move", source: scale, destination: scale, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /unchanged/, res.text);
    assert.equal(await fx.read("src/helper.ts"), helper, "file must be byte-identical");
  });

  test("a destination inside the source being moved is rejected", async () => {
    const scale = await handleFor("src/helper.ts:11", "scale");
    // Two identifiers on this line (`value`, `factor`), so it resolves as
    // ambiguous candidates -- same pattern edit-typescript.test.ts uses.
    const value = await handleFor("src/helper.ts:11", "value");

    const res = await fx.rpc({ op: "move", source: scale, destination: value, action: "insert-after" });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /lands inside the source/, res.text);
    assert.equal(await fx.read("src/helper.ts"), helper, "file must be untouched");
  });

  test("a stale dependency rejects the move before touching the file", async () => {
    const scale = await handleFor("src/helper.ts:11", "scale");
    const clamp = await handleFor("src/helper.ts:21", "clamp");
    // An unrelated dep in a different file, so mutating it does not also
    // touch source or destination -- which would be caught earlier.
    const run = await handleFor("src/main.ts:3", "run");

    await fx.write("src/main.ts", main.replace("scaled + 1", "scaled + 2"));
    const before = await fx.read("src/helper.ts");

    const res = await fx.rpc({
      op: "move",
      source: scale,
      destination: clamp,
      action: "insert-after",
      deps: [run],
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.match(res.text, /CHANGED|GONE/, res.text);
    assert.equal(await fx.read("src/helper.ts"), before, "validated before writing");
  });

  test("move takes handles only, not positions", async () => {
    const clamp = await handleFor("src/helper.ts:21", "clamp");
    const res = await fx.rpc({
      op: "move",
      source: "src/helper.ts:11",
      destination: clamp,
      action: "insert-after",
    });
    assert.equal(res.ok, false);
    assert.match(res.text, /takes a handle/, res.text);
  });

  test("cross-file: relocates the referent and removes it from the source file", async () => {
    const clamp = await handleFor("src/helper.ts:21", "clamp");
    const run = await handleFor("src/main.ts:3", "run");

    const res = await fx.rpc({ op: "move", source: clamp, destination: run, action: "insert-after" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /fn clamp/, res.text);

    const newHelper = await fx.read("src/helper.ts");
    const newMain = await fx.read("src/main.ts");
    assert.doesNotMatch(newHelper, /export function clamp/, `clamp must be gone from the source:\n${newHelper}`);
    assert.match(newMain, /export function clamp/, `clamp must appear at the destination:\n${newMain}`);

    const read = await fx.rpc({ op: "read", target: clamp });
    assert.match(read.text, /unknown/, read.text);
  });

  test("cross-file: a dependency already dead at validation time rejects cleanly, zero writes", async () => {
    const clamp = await handleFor("src/helper.ts:21", "clamp");
    const scale = await handleFor("src/helper.ts:11", "scale");
    const run = await handleFor("src/main.ts:3", "run");

    // Mutate the dep (`scale`), not source or destination (`clamp`, `run`).
    await fx.write("src/helper.ts", helper.replace("value * factor", "value * factor + 0"));
    const beforeHelper = await fx.read("src/helper.ts");

    const res = await fx.rpc({
      op: "move",
      source: clamp,
      destination: run,
      action: "insert-after",
      deps: [scale],
    });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /premise changed/, res.text);
    assert.equal(await fx.read("src/helper.ts"), beforeHelper, "source untouched");
    assert.equal(await fx.read("src/main.ts"), main, "destination untouched");
  });

  test("cross-file: a dep invalidated by the destination write itself yields a partial result, not a loss", async () => {
    // `run`'s own handle spans anywhere inside its body -- including the spot
    // this test inserts into -- so declaring it as a dep here means the
    // destination write's own rebase kills it deterministically.
    const clamp = await handleFor("src/helper.ts:21", "clamp");
    const run = await handleFor("src/main.ts:3", "run");
    const hit = await fx.rpc({
      op: "find",
      needle: "const clamped = clamp($A, $B);",
      haystack: "src/main.ts",
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

    const newHelper = await fx.read("src/helper.ts");
    const newMain = await fx.read("src/main.ts");
    assert.match(newHelper, /export function clamp/, `source must still hold its copy:\n${newHelper}`);
    assert.match(newMain, /function clamp/, `destination must hold the new copy:\n${newMain}`);
  });

  test("a move through our own verb reaches tsserver via didChange, not disk", async () => {
    // Force both files open in tsserver's mind before moving between them --
    // exactly the case where a dropped notification would go unnoticed by
    // `move` itself (it never touches the LSP client) and only surface on
    // the next LSP-backed query.
    const openedSrc = await fx.rpc({ op: "refs", target: "src/helper.ts:21" });
    assert.ok(openedSrc.ok, openedSrc.text);
    const openedDst = await fx.rpc({ op: "refs", target: "src/main.ts:3" });
    assert.ok(openedDst.ok, openedDst.text);

    const clamp = await handleFor("src/helper.ts:21", "clamp");
    const run = await handleFor("src/main.ts:3", "run");
    const res = await fx.rpc({ op: "move", source: clamp, destination: run, action: "insert-after" });
    assert.ok(res.ok, res.text);
    const moved = res.text.match(/^(#\w+)/)?.[1];
    assert.ok(moved, res.text);
    await new Promise((r) => setTimeout(r, 500));

    // A stale tsserver view of main.ts (still lacking `clamp`, or still
    // showing helper.ts's copy) would answer this with "ambiguous" or no
    // references at all rather than a single clean resolution.
    const found = await fx.rpc({ op: "refs", target: moved });
    assert.ok(found.ok, found.text);
    assert.doesNotMatch(found.text, /^ambiguous/, found.text);
    assert.match(found.text, /^refs clamp/, found.text);
  });
});
