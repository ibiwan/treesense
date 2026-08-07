/**
 * TRACE — naive value flow through the call chain. Blocks on the index.
 *
 * The only verb nothing off the shelf already does, and it needs no new
 * engine: references, plus definition, plus a tree-walk, in a loop.
 *
 *   down: for each use, if the symbol is passed as a BARE IDENTIFIER
 *         argument, resolve the callee, match the parameter by position, and
 *         recurse from there.
 *   up:   the same machinery inverted — references on the enclosing function,
 *         filtered to call sites, taking the argument in that slot.
 *
 * The requirement that makes it trustworthy: EVERY terminated branch states
 * why it stopped. A branch that halted at a macro must never be
 * indistinguishable from one that genuinely ended, because the caller reads a
 * short tree as a complete answer either way.
 *
 * DELIBERATELY NAIVE. Out of scope, and visible in the output rather than by
 * omission: borrows and aliasing (`&mut x` reads as a non-identifier
 * argument), destructuring, method receivers, struct fields, closure captures,
 * and trait dispatch where the impl is not statically known. Those need real
 * dataflow over MIR. What is here is syntactic, and says so.
 */

import { parseAddress } from "../../shared/address.js";
import { renderSite } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { FilePath, Site, StopReason } from "../../shared/types.js";
import { locate, mint, questionNode, type Located } from "../locate.js";
import { pathToUri, uriToPath } from "../lsp.js";
import { byteToPosition, positionToByte } from "../positions.js";
import type { SyntaxNode } from "../syntax.js";
import type { Workspace } from "../workspace.js";

export interface TraceArgs {
  target: string;
  maxUp: number;
  maxDown: number;
}

/** Branching downward is combinatorial; a walk is not an inventory. */
const MAX_SITES = 80;

interface Frontier {
  located: Located;
  node: SyntaxNode;
  distance: number;
}

export async function trace(ws: Workspace, args: TraceArgs): Promise<Reply> {
  const address = parseAddress(args.target);
  if (address.form === "symbolic") {
    return { ok: false, text: "error: symbolic addresses are not implemented yet" };
  }

  const start = await anchor(ws, address);
  if ("error" in start) return { ok: false, text: `error: ${start.error}` };

  await ws.lsp.whenReady();
  const before = ws.files.workspaceGen;

  const sites: Site[] = [];
  if (args.maxDown !== 0) await walk(ws, start, "down", args.maxDown, sites);
  if (args.maxUp !== 0) await walk(ws, start, "up", args.maxUp, sites);

  // A trace is an inference, not an enumeration: unlike a reference list, where
  // each entry stands or falls alone, its conclusion depends on every link
  // holding simultaneously. A file changing mid-walk can make the result
  // structurally wrong in a way no individual handle failure reveals — so the
  // workspace generation is checked across the whole walk, not per lookup.
  const after = ws.files.workspaceGen;
  const stale = before === after ? "" : " STALE — files changed mid-walk, re-run";

  const header =
    `trace ${start.node.text()} up${args.maxUp} down${args.maxDown} ` +
    `${sites.length} ws${after}${stale}`;

  if (sites.length === 0) return { ok: true, text: `${header}\n(no flow found)` };
  return { ok: true, text: [header, ...sites.map(renderSite)].join("\n") };
}

async function walk(
  ws: Workspace,
  start: Frontier,
  direction: "up" | "down",
  max: number,
  sites: Site[],
): Promise<void> {
  const seen = new Set<string>([key(start)]);
  /** Where each visited location was reported, so a terminus updates its row. */
  const rows = new Map<string, number>();
  let frontier: Frontier[] = [start];

  for (let distance = 1; frontier.length > 0; distance++) {
    if (max >= 0 && distance > max) {
      for (const item of frontier) sites.push(site(ws, item, direction, distance - 1, "depth"));
      return;
    }

    const next: Frontier[] = [];
    for (const item of frontier) {
      if (sites.length >= MAX_SITES) return;

      const steps = direction === "down" ? await stepDown(ws, item) : await stepUp(ws, item);
      if (steps.length === 0) {
        // A node that goes nowhere is a terminus, not a second visit. Marking
        // the row where it was first reported keeps one line per location —
        // otherwise arriving somewhere and stopping there prints it twice.
        const row = rows.get(key(item));
        if (row === undefined) sites.push(site(ws, item, direction, distance - 1, "end"));
        else sites[row]!.stop = "end";
        continue;
      }

      for (const step of steps) {
        if (sites.length >= MAX_SITES) return;
        if ("stop" in step) {
          sites.push(site(ws, step.at, direction, distance, step.stop));
          continue;
        }
        const id = key(step.to);
        if (seen.has(id)) {
          sites.push(site(ws, step.to, direction, distance, "cycle"));
          continue;
        }
        seen.add(id);
        rows.set(id, sites.length);
        sites.push(site(ws, step.to, direction, distance, null));
        next.push({ ...step.to, distance });
      }
    }
    frontier = next;
  }
}

type Step = { to: Frontier } | { at: Frontier; stop: StopReason };

/**
 * Follow the value into the functions it is passed to.
 *
 * Only a *bare identifier* in argument position is followed. Anything else —
 * an expression, a borrow, a macro — is a terminus with a reason, because
 * following it would require knowing what the surrounding expression does with
 * the value, which is exactly the analysis this verb does not perform.
 */
async function stepDown(ws: Workspace, from: Frontier): Promise<Step[]> {
  const position = byteToPosition(
    from.located.snap,
    from.node.bytes.start,
    ws.lsp.positionEncoding,
  );
  const uses = await ws.lsp.references(pathToUri(from.located.snap.path), position);

  const out: Step[] = [];
  for (const use of uses) {
    const file = (await ws.files.canonical(uriToPath(use.uri))) as FilePath;
    const located = await locate(ws, file);
    if (located === null) continue;

    const offset = positionToByte(located.snap, use.range.start, ws.lsp.positionEncoding);
    const node = located.tree.nodeAt(offset);
    if (node === null) continue;
    const here: Frontier = { located, node, distance: from.distance };

    if (insideMacro(located, node)) {
      out.push({ at: here, stop: "macro" });
      continue;
    }

    const slot = argumentSlot(node);
    if (slot === null) continue; // not in argument position — not a flow edge
    if (!slot.bare) {
      out.push({ at: here, stop: "non-ident-arg" });
      continue;
    }

    const param = await parameterFor(ws, located, slot.call, slot.index);
    if (param === null) {
      out.push({ at: here, stop: "unresolved" });
      continue;
    }
    out.push({ to: param });
  }
  return out;
}

/**
 * Follow the value back to the arguments that supply it.
 *
 * Where the symbol is a parameter, find its position, then look at every call
 * to the enclosing function and take the argument in that slot.
 */
async function stepUp(ws: Workspace, from: Frontier): Promise<Step[]> {
  const slot = parameterSlot(from.located, from.node);
  if (slot === null) return [];

  const fnName = slot.fn.nameNode;
  if (fnName === null) return [{ at: from, stop: "unresolved" }];

  const position = byteToPosition(from.located.snap, fnName.bytes.start, ws.lsp.positionEncoding);
  const callers = await ws.lsp.references(pathToUri(from.located.snap.path), position);

  const out: Step[] = [];
  for (const caller of callers) {
    const file = (await ws.files.canonical(uriToPath(caller.uri))) as FilePath;
    const located = await locate(ws, file);
    if (located === null) continue;

    const offset = positionToByte(located.snap, caller.range.start, ws.lsp.positionEncoding);
    const node = located.tree.nodeAt(offset);
    if (node === null) continue;

    const call = enclosingCall(node);
    if (call === null) continue; // a mention that is not a call
    const args = call.children().find((c) => c.rawKind === "arguments");
    const actual = args?.children()[slot.index];
    if (actual === undefined) {
      out.push({ at: { located, node, distance: from.distance }, stop: "unresolved" });
      continue;
    }

    const here: Frontier = { located, node: actual, distance: from.distance };
    if (actual.kind !== "ident") {
      out.push({ at: here, stop: "non-ident-arg" });
      continue;
    }
    out.push({ to: here });
  }
  return out;
}

/** Is this node a positional argument, and is it a bare identifier? */
function argumentSlot(
  node: SyntaxNode,
): { call: SyntaxNode; index: number; bare: boolean } | null {
  const parent = node.parent;
  if (parent === null) return null;

  if (parent.rawKind === "arguments") {
    const index = parent.children().findIndex((c) => c.bytes.start === node.bytes.start);
    const call = parent.parent;
    if (call === null || index < 0) return null;
    return { call, index, bare: node.kind === "ident" };
  }

  // Wrapped in something — `x + 1`, `&x`, `x.into()`. Walk out once to see
  // whether that wrapper is itself an argument; if so this is a non-bare one.
  const outer = parent.parent;
  if (outer?.rawKind === "arguments") {
    const index = outer.children().findIndex((c) => c.bytes.start === parent.bytes.start);
    const call = outer.parent;
    if (call === null || index < 0) return null;
    return { call, index, bare: false };
  }
  return null;
}

/** The parameter this identifier declares, and its position in the signature. */
function parameterSlot(
  located: Located,
  node: SyntaxNode,
): { fn: SyntaxNode; index: number } | null {
  for (const ancestor of located.tree.ancestors(node)) {
    if (ancestor.kind !== "fn") continue;
    const params = ancestor.children().find((c) => c.rawKind === "parameters");
    if (params === undefined) return null;
    const index = params
      .children()
      .findIndex((p) => p.bytes.start <= node.bytes.start && node.bytes.end <= p.bytes.end);
    return index < 0 ? null : { fn: ancestor, index };
  }
  return null;
}

/** Resolve a call's callee and hand back its Nth parameter. */
async function parameterFor(
  ws: Workspace,
  located: Located,
  call: SyntaxNode,
  index: number,
): Promise<Frontier | null> {
  const callee = call.children()[0];
  if (callee === undefined) return null;

  // `scale(..)` is a bare identifier; `pixel::scale(..)` is a path whose last
  // segment names the function.
  const name = callee.kind === "ident" ? callee : callee.identifiers().at(-1);
  if (name === undefined) return null;

  const position = byteToPosition(located.snap, name.bytes.start, ws.lsp.positionEncoding);
  const definitions = await ws.lsp.definition(pathToUri(located.snap.path), position);
  const definition = definitions[0];
  if (definition === undefined) return null;

  const file = (await ws.files.canonical(uriToPath(definition.uri))) as FilePath;
  const target = await locate(ws, file);
  if (target === null) return null;

  const offset = positionToByte(target.snap, definition.range.start, ws.lsp.positionEncoding);
  const at = target.tree.nodeAt(offset);
  if (at === null) return null;

  const fn = at.kind === "fn" ? at : target.tree.enclosingItem(at);
  if (fn === null || fn.kind !== "fn") return null;

  const params = fn.children().find((c) => c.rawKind === "parameters");
  const param = params?.children()[index];
  if (param === undefined) return null;

  const named = param.kind === "ident" ? param : param.identifiers()[0];
  if (named === undefined) return null;
  return { located: target, node: named, distance: 0 };
}

function enclosingCall(node: SyntaxNode): SyntaxNode | null {
  for (let cur: SyntaxNode | null = node; cur !== null; cur = cur.parent) {
    if (cur.rawKind === "call_expression") return cur;
  }
  return null;
}

/**
 * Format-string captures are not identifiers to the grammar, so a reference
 * inside `println!("{x}")` lands on the string literal. Either way the answer
 * is the same: we cannot follow a value into a macro without expanding it.
 */
function insideMacro(located: Located, node: SyntaxNode): boolean {
  if (node.rawKind === "macro_invocation") return true;
  return located.tree.ancestors(node).some((a) => a.rawKind === "macro_invocation");
}

function site(
  ws: Workspace,
  at: Frontier,
  direction: "up" | "down",
  distance: number,
  stop: StopReason | null,
): Site {
  return { direction, distance, full: mint(ws, at.located, at.node), stop };
}

function key(frontier: Frontier): string {
  return `${frontier.located.snap.path}:${frontier.node.bytes.start}`;
}

type Anchored = Frontier | { error: string };

async function anchor(
  ws: Workspace,
  address: ReturnType<typeof parseAddress>,
): Promise<Anchored> {
  if (address.form === "handle") {
    const resolved = await ws.handles.resolve(address.handle);
    if (resolved.status === "unknown") return { error: `${address.handle} unknown` };
    if (resolved.status === "gone") return { error: `${address.handle} gone` };
    const located = await locate(ws, resolved.full.file);
    if (located === null) return { error: `no grammar for ${resolved.full.file}` };
    const node = located.tree.nodeAt(resolved.full.anchor);
    if (node === null) return { error: `${address.handle} no longer resolves` };
    return { located, node: questionNode(located.tree, node) ?? node, distance: 0 };
  }

  if (address.form === "position") {
    const lines = address.lines;
    if (lines === null) return { error: "trace needs a line, not a whole file" };
    const file = await ws.files.canonical(address.path);
    const located = await locate(ws, file);
    if (located === null) return { error: `no grammar for ${address.path}` };

    const idents = located.tree.rootNode.identifiers().filter((id) => {
      const line = located.snap.index.lineAt(id.bytes.start);
      return line >= lines.start && line <= lines.end;
    });
    if (idents.length === 0) return { error: `no symbols on ${address.path}` };
    if (idents.length > 1) {
      // Same rule as refs: ambiguity is the caller's to resolve, not ours to
      // guess at — and a trace built on the wrong symbol is expensive to spot.
      return {
        error: `${idents.length} symbols there — use refs to pick one, then trace its handle`,
      };
    }
    return { located, node: idents[0]!, distance: 0 };
  }

  return { error: "unreachable" };
}
