/**
 * Integration coverage for the TypeScript profile, against
 * `fixtures/typescript-project`. Not a re-run of every Rust integration
 * test — the Rust suite already covers protocol/daemon/handle-lifecycle
 * mechanics that don't vary by language. This targets what's actually
 * different about `typescript-language-server`, per PLAN.md's "Language
 * profile — TypeScript" section: `useSyntaxServer` routing, open-on-demand
 * file lifecycle, the `export_statement`-wrapper fix, and declaration
 * merging as a genuine relocator-ambiguity case.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { skipReasonTs, startTypeScriptFixture } from "../testkit/index.js";

const skip = skipReasonTs();

describe("typescript profile against a real project", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startTypeScriptFixture>>;

  before(async () => {
    fx = await startTypeScriptFixture();
  });
  after(async () => {
    await fx?.stop();
  });

  /** Handle for a named identifier on a given line, same pattern as trace.test.ts. */
  async function handleFor(where: string, name: string): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: where });
    const handle = amb.text.match(new RegExp(`(#\\w+) \\[[^\\]]*\\] :\\d+ ${name}\\b`))?.[1];
    assert.ok(handle, `no ${name} handle in:\n${amb.text}`);
    return handle;
  }

  test("project overview orients without reading source or waiting for the index", async () => {
    const res = await fx.rpc({ op: "overview" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^project /, res.text);
    assert.match(res.text, /manifests: package\.json/, res.text);
    assert.match(res.text, /  src\/ \(/, res.text);
  });

  test("find needs no index -- it reads files, not name resolution", async () => {
    const res = await fx.rpc({ op: "find", needle: "scale" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /src\/helper\.ts/, res.text);
    assert.match(res.text, /src\/main\.ts/, res.text);
  });

  test("a symbolic address resolves through workspace/symbol, exercising the export_statement fix", async () => {
    // Regression coverage at the protocol level for the enclosingItem fix:
    // workspace/symbol's returned position sits at the `export` keyword,
    // before the wrapped function_declaration's own range begins. Without
    // the fix this fails with "symbol scale not found" even though
    // workspace/symbol itself answered correctly.
    const res = await fx.rpc({ op: "refs", target: "scale" });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^refs scale [1-9]/, res.text);
  });

  test("refs crosses a file boundary -- resolution, not text matching", async () => {
    // `scale` is declared in helper.ts and called from main.ts. Nothing in
    // main.ts spells helper.ts's path the way a grep match would need to.
    const handle = await handleFor("src/helper.ts:11", "scale");
    const res = await fx.rpc({ op: "refs", target: handle });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /src\/main\.ts/, res.text);
  });

  test("declaration handles resolve to their own name, not their whole body", async () => {
    const handle = await handleFor("src/helper.ts:11", "scale");
    const res = await fx.rpc({ op: "refs", target: handle });
    assert.ok(res.ok, res.text);
    assert.doesNotMatch(res.text, /^ambiguous/, res.text);
  });

  test("JSDoc is attached to the item it documents", async () => {
    const found = await fx.rpc({ op: "find", needle: "scale", collapse: true });
    assert.ok(found.ok, found.text);
    const handle = found.text.match(/(#\w+) \[.*::scale\] :\d+-\d+ fn scale/)?.[1];
    assert.ok(handle, `no full-item handle for scale in:\n${found.text}`);

    const read = await fx.rpc({ op: "read", target: handle });
    assert.ok(read.ok, read.text);
    assert.match(read.text, /Scales a värde/, read.text);
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

  test("the density guard fires on a pathological line", async () => {
    const res = await fx.rpc({ op: "read", target: "dense.txt:1" });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /exceeds/, res.text);
  });

  test("trace follows a bare identifier argument across a call boundary", async () => {
    // `export function run(seed: number)` -> `scale(seed, 3)` -> helper.ts's
    // `scale(value, factor)`. `seed` is a bare identifier argument, the same
    // shape as Rust's cross-crate call-boundary trace test.
    const seed = await handleFor("src/main.ts:3", "seed");
    const res = await fx.rpc({ op: "trace", target: seed, maxUp: 0, maxDown: 2 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /helper\.ts:\d+ ident value/, `cross-file hop:\n${res.text}`);
  });

  test("trace stops at a non-identifier argument, saying so", async () => {
    // `scaled` flows into `clamp(scaled + 1, 100)` -- the argument slot is
    // the expression `scaled + 1`, not the bare identifier `scaled`, so
    // trace must stop here rather than guess a flow into clamp's parameter.
    const scaled = await handleFor("src/main.ts:5", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 2 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /non-ident-arg/, res.text);
  });

  test("declaration merging is a genuine relocator ambiguity, refused rather than guessed", async () => {
    // Two `interface Options` blocks in helper.ts -- both real item-kind
    // nodes, same qualified name. After an edit shifts both by the same
    // delta with no rebase-by-edit-delta available (this write is external,
    // not one of our own edits), the handle table's identity-based
    // relocation (kind + qualified name, unique match required) must fall
    // through to `gone` rather than pick either.
    const found = await fx.rpc({ op: "find", needle: "interface Options" });
    assert.ok(found.ok, found.text);
    const handle = found.text.match(/(#\w+) \[.*::Options\]/)?.[1];
    assert.ok(handle, `no handle for an Options interface in:\n${found.text}`);

    const original = await fx.read("src/helper.ts");
    await fx.write("src/helper.ts", `// shifted\n${original}`);
    await new Promise((r) => setTimeout(r, 500));

    const res = await fx.rpc({ op: "read", target: handle });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /\bgone\b/, res.text);
  });
});
