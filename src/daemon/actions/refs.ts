/**
 * REFS — references to a symbol. Blocks on the index; this is the operation
 * that genuinely needs name resolution, so it is where cold start shows up.
 *
 * Resolution rule, which is not simply "one token in the span":
 *
 *   declaration node  -> its own name. A handle to `fn Panel::render` holds
 *                        dozens of identifiers, but the obvious reading is
 *                        references to `render`; enumerating its body would
 *                        be useless.
 *   anything else     -> enumerate the distinct symbols inside it, deduped by
 *                        resolved symbol rather than by occurrence.
 *
 * Never cache a result and edit from it. References are a semantic claim, and
 * a handle only asserts byte identity — a shadowing binding inserted between
 * the query and the edit leaves every byte untouched while changing what the
 * symbol means. Re-run against current state instead.
 */

import { parseAddress } from "../../shared/address.js";
import { renderHits } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { FilePath, Full, Hit } from "../../shared/types.js";
import {
  declares,
  distinctIdentifiers,
  identifiersOnLine,
  locate,
  mint,
  questionNode,
  type Located,
} from "../locate.js";
import { pathToUri, uriToPath } from "../lsp.js";
import { byteToPosition, positionToByte } from "../positions.js";
import { isItemKind, type SyntaxNode } from "../syntax.js";
import type { Workspace } from "../workspace.js";

export interface RefsArgs {
  target: string;
}

/** Where the question will be asked, once we know which symbol is meant. */
interface Anchor {
  located: Located;
  node: SyntaxNode;
}

export async function refs(ws: Workspace, args: RefsArgs): Promise<Reply> {
  const resolved = await anchorFor(ws, args.target);
  if ("error" in resolved) return { ok: false, text: `error: ${resolved.error}` };
  if ("candidates" in resolved) return candidates(ws, resolved.candidates);

  const { located, node } = resolved;
  await ws.lsp.whenReady();

  const position = byteToPosition(located.snap, node.bytes.start, ws.lsp.positionEncoding);
  const locations = await ws.lsp.references(pathToUri(located.snap.path), position);

  if (locations.length === 0) {
    return { ok: true, text: `refs ${node.text()} 0` };
  }

  const groups = new Map<string, Hit[]>();
  for (const loc of locations) {
    const file = (await ws.files.canonical(uriToPath(loc.uri))) as FilePath;
    const target = await locate(ws, file);
    if (target === null) continue;

    const offset = positionToByte(target.snap, loc.range.start, ws.lsp.positionEncoding);
    const hit = hitAt(ws, target, offset);
    if (hit === null) continue;

    const bucket = groups.get(file) ?? [];
    bucket.push(hit);
    groups.set(file, bucket);
  }

  const header = `refs ${node.text()} ${locations.length} ws${ws.files.workspaceGen}`;
  return { ok: true, text: `${header}\n${renderHits(groups)}` };
}

/**
 * Innermost-first chain: the matched token, then the structural nodes that
 * enclose it up to and including its declaration.
 *
 * Both ends earn their place. The token's handle is what makes a follow-up
 * `refs` exact rather than ambiguous; the item's handle is what the caller
 * reads next, and front-loading it here is what collapses the common path from
 * three calls to two.
 */
function hitAt(ws: Workspace, located: Located, offset: number): Hit | null {
  const node = located.tree.nodeAt(offset);
  if (node === null) return null;

  const chain: Full[] = [mint(ws, located, node)];
  for (const ancestor of located.tree.ancestors(node)) {
    if (!INTERESTING.has(ancestor.kind)) continue;
    chain.push(mint(ws, located, ancestor));
    if (isItemKind(ancestor.kind)) break;
  }

  const line = located.snap.index.lineAt(offset);
  const start = located.snap.index.startOfLine(line);
  const end =
    line >= located.snap.index.lineCount
      ? located.snap.content.length
      : located.snap.index.startOfLine(line + 1);

  return {
    hierarchy: chain,
    snippet: located.snap.content.subarray(start, end).toString("utf8").trim(),
  };
}

const INTERESTING = new Set([
  "fn",
  "impl",
  "struct",
  "enum",
  "trait",
  "mod",
  "const",
  "type",
  "branch",
  "loop",
]);

type Resolution =
  | Anchor
  | { candidates: { located: Located; nodes: SyntaxNode[]; where: string } }
  | { error: string };

async function anchorFor(ws: Workspace, target: string): Promise<Resolution> {
  const address = parseAddress(target);

  if (address.form === "handle") {
    const resolved = await ws.handles.resolve(address.handle);
    if (resolved.status === "unknown") {
      return { error: `${address.handle} unknown — handles die with the daemon; re-query` };
    }
    if (resolved.status === "gone") {
      return { error: `${address.handle} gone — its node no longer exists` };
    }
    const located = await locate(ws, resolved.full.file);
    if (located === null) return { error: `no grammar for ${resolved.full.file}` };

    const node = located.tree.nodeAt(resolved.full.bytes.start);
    if (node === null) return { error: `${address.handle} no longer resolves to a node` };

    const question = questionNode(located.tree, node);
    if (question !== null) return { located, node: question };

    // A statement or block names nothing of its own, so the caller has to say
    // which of the symbols inside it they meant.
    const inside = distinctIdentifiers(node);
    if (inside.length === 1) return { located, node: inside[0]! };
    return { candidates: { located, nodes: inside, where: `${address.handle}` } };
  }

  if (address.form === "position") {
    const file = await ws.files.canonical(address.path);
    const located = await locate(ws, file);
    if (located === null) return { error: `no grammar for ${address.path}` };
    if (address.lines === null) return { error: "refs needs a line, not a whole file" };

    const idents = identifiersOnLine(located, address.lines.start);
    if (idents.length === 0) return { error: `no symbols on ${address.path}:${address.lines.start}` };
    if (idents.length === 1) return { located, node: idents[0]! };
    return {
      candidates: { located, nodes: idents, where: `${address.path}:${address.lines.start}` },
    };
  }

  return { error: `symbolic addresses are not implemented yet (${address.symbol})` };
}

/**
 * Ambiguity is a result, not an error, and it is optimised for **one-call
 * recovery** rather than for completeness.
 *
 * So: one entry per distinct symbol — not per reference hit, which is a
 * different and much longer answer to a question nobody asked yet. Each entry
 * carries only what is needed to choose between them, since the caller is
 * about to discard all but one. Declarations sort first because, asked about a
 * line, the caller almost always means the thing declared there rather than a
 * parameter type sharing the line — but nothing is auto-picked.
 */
function candidates(
  ws: Workspace,
  found: { located: Located; nodes: SyntaxNode[]; where: string },
): Reply {
  const { located, nodes, where } = found;

  const ranked = nodes
    .map((node) => ({ node, declaration: declares(located.tree, node) }))
    .sort((a, b) => Number(b.declaration !== null) - Number(a.declaration !== null));

  const lines = ranked.map(({ node, declaration }) => {
    const full = mint(ws, located, node);
    const item = declaration ?? located.tree.enclosingItem(node);
    const context =
      declaration !== null
        ? `declares ${describeItem(declaration)}`
        : item === null
          ? ""
          : `in ${describeItem(item)}`;
    return `${full.handle} :${full.lines.start} ${node.text()}${context === "" ? "" : `  ${context}`}`;
  });

  // Every candidate on one line means one shared snippet rather than the same
  // text repeated per entry.
  const distinctLines = new Set(nodes.map((n) => located.snap.index.lineAt(n.bytes.start)));
  const snippet =
    distinctLines.size === 1 ? [`  ${sourceLine(located, [...distinctLines][0]!)}`] : [];

  const header = `ambiguous: ${nodes.length} symbols on ${where} — call refs again with one of these handles`;
  return { ok: true, text: [header, ...snippet, ...lines].join("\n") };
}

function describeItem(item: SyntaxNode): string {
  return item.name === null ? item.kind : `${item.kind} ${item.name}`;
}

function sourceLine(located: Located, line: number): string {
  const start = located.snap.index.startOfLine(line);
  const end =
    line >= located.snap.index.lineCount
      ? located.snap.content.length
      : located.snap.index.startOfLine(line + 1);
  return located.snap.content.subarray(start, end).toString("utf8").trim();
}
