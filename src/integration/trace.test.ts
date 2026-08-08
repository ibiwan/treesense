import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { skipReason, startFixture } from "../testkit/index.js";

const skip = skipReason();

describe("trace", { skip }, () => {
  let fx: Awaited<ReturnType<typeof startFixture>>;

  before(async () => {
    fx = await startFixture();
  });
  after(async () => {
    await fx?.stop();
  });

  /** Handle for a named identifier on a given line. */
  async function handleFor(where: string, name: string): Promise<string> {
    const amb = await fx.rpc({ op: "refs", target: where });
    const handle = amb.text.match(new RegExp(`(#\\w+) \\[[^\\]]*\\] :\\d+ ${name}\\b`))?.[1];
    assert.ok(handle, `no ${name} handle in:\n${amb.text}`);
    return handle;
  }

  test("follows a value across a call boundary into the callee's parameter", async () => {
    // `let scaled = scale(raw, 3)` -> `pipeline::run(scaled)` -> `fn run(seed)`
    // -> `scale(seed, step)` -> `fn scale(value)`, which is in another crate.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 3 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /pipeline\.rs:\d+ ident seed/, res.text);
    assert.match(res.text, /helper\/src\/lib\.rs:\d+ ident value/, `cross-crate hop:\n${res.text}`);
  });

  test("every terminated branch says why it stopped", async () => {
    // The invariant the verb lives or dies by: a branch that halted because we
    // could not follow it must never look like one that genuinely ended.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 3 });
    assert.ok(res.ok, res.text);

    const rows = res.text.split("\n").slice(1).filter((l) => l.startsWith("down "));
    assert.ok(rows.length > 0, res.text);
    const live = rows.filter((l) => !/ stop:\w/.test(l));
    // A row without a stop reason is a waypoint: it must have a deeper row
    // beyond it, or it is an unexplained terminus.
    for (const row of live) {
      const distance = Number(row.split(" ")[1]);
      assert.ok(
        rows.some((other) => Number(other.split(" ")[1]) > distance),
        `waypoint with nothing beyond it:\n${row}\n---\n${res.text}`,
      );
    }
  });

  test("a macro is a stop, not an ending", async () => {
    // `println!("scaled = {scaled}")` — following a value into a macro needs
    // expansion, which this verb does not do.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 2 });
    assert.match(res.text, /stop:macro/, res.text);
  });

  test("a non-identifier argument is a stop, not an ending", async () => {
    // `scale(seed + 1, step)` — the argument is an expression, so following it
    // would need to know what `+` does with the value.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 3 });
    assert.match(res.text, /stop:non-ident-arg/, res.text);
  });

  test("the depth limit is reported, not silently applied", async () => {
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const shallow = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 1 });
    assert.ok(shallow.ok, shallow.text);
    assert.match(shallow.text, /stop:depth/, `a truncated walk must say so:\n${shallow.text}`);

    const deep = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 3 });
    assert.doesNotMatch(deep.text, /stop:depth/, deep.text);
  });

  test("tracing up finds the arguments that supply a parameter", async () => {
    const value = await handleFor("crates/helper/src/lib.rs:10", "value");
    const res = await fx.rpc({ op: "trace", target: value, maxUp: 2, maxDown: 0 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /^up /m, `expected upward sites:\n${res.text}`);
  });

  test("decoration is peeled: a borrow is still the same name", async () => {
    // `borrowed(&seed)` — `&mut`/`&`/parens/`.clone()` change the type, not
    // which name is flowing. Stopping at the wrapper strands a Rust trace at
    // the first argument it meets.
    const seed = await handleFor("src/pipeline.rs:40", "seed");
    const res = await fx.rpc({ op: "trace", target: seed, maxUp: 0, maxDown: 2 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /pipeline\.rs:\d+ ident carried/, `peeled borrow:\n${res.text}`);
  });

  test("decoration is peeled through a zero-argument method call", async () => {
    // `borrowed(&(seed.clone()))` — three wrappers deep, one name underneath.
    const seed = await handleFor("src/pipeline.rs:40", "seed");
    const res = await fx.rpc({ op: "trace", target: seed, maxUp: 0, maxDown: 2 });
    assert.ok(res.ok, res.text);
    // Both call sites converge on the same parameter, so the second arrival is
    // a cycle — the point is that neither stops at its wrapper.
    const rows = res.text.split("\n").filter((l) => /ident carried/.test(l));
    assert.equal(rows.length, 2, `both call sites reach the parameter:\n${res.text}`);
    assert.doesNotMatch(res.text, /stop:non-ident-arg/, `nothing left undecorated:\n${res.text}`);
  });

  test("a name bound from a call traces up into what that call returns", async () => {
    // `let one = borrowed(&seed)` — the value's origin is `borrowed`'s tail
    // expression. Following arguments alone loses every `let x = f(..)`.
    const one = await handleFor("src/pipeline.rs:41", "one");
    const res = await fx.rpc({ op: "trace", target: one, maxUp: 2, maxDown: 0 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /pipeline\.rs:\d+ ident carried/, `return hop:\n${res.text}`);
  });

  test("a returned value traces down into the caller's binding", async () => {
    // The inverse hop: `carried` leaves `borrowed` via `*carried`, arriving as
    // `one` and `two` in the caller.
    const carried = await handleFor("src/pipeline.rs:48", "carried");
    const res = await fx.rpc({ op: "trace", target: carried, maxUp: 0, maxDown: 2 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /ident one\b/, `bound in caller:\n${res.text}`);
    assert.match(res.text, /ident two\b/, `both call sites:\n${res.text}`);
  });

  test("a return that denotes no single name stops, saying so", async () => {
    // `scale`'s tail is `value * factor`. Neither operand alone is the return
    // value, and the walk must not pick one — same rule as `f(x + 1)`.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 2, maxDown: 0 });
    assert.ok(res.ok, res.text);
    assert.match(res.text, /stop:return/, `honest about the tail:\n${res.text}`);
  });

  test("an ambiguous position is refused rather than guessed", async () => {
    const res = await fx.rpc({ op: "trace", target: "src/pipeline.rs:15", maxUp: 0, maxDown: 2 });
    assert.equal(res.ok, false, res.text);
    assert.match(res.text, /use refs to pick one/, res.text);
  });

  test("a multi-file walk is not reported stale merely for reading files", async () => {
    // The workspace generation must not count first sight of a file as a
    // change, or every cross-file trace declares itself unreliable.
    const scaled = await handleFor("src/main.rs:16", "scaled");
    const res = await fx.rpc({ op: "trace", target: scaled, maxUp: 0, maxDown: 3 });
    assert.doesNotMatch(res.text, /STALE/, res.text);
  });
});
