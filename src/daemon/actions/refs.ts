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
 *   anything else     -> enumerate the identifier occurrences inside it.
 *                        NOT deduplicated by spelling: two `x`s may be two
 *                        bindings, and collapsing them drops the very choice
 *                        the caller is being asked to make.
 *
 * Never cache a result and edit from it. References are a semantic claim, and
 * a handle only asserts byte identity — a shadowing binding inserted between
 * the query and the edit leaves every byte untouched while changing what the
 * symbol means. Re-run against current state instead.
 */

import { formatLineRange, parseAddress } from "../../shared/address.js";
import { renderHits, stableLabel } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { FilePath, Full, Hit } from "../../shared/types.js";
import {
  declares,
  identifiersInRange,
  identifiersWithin,
  locate,
  mint,
  qualifiedName,
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
  if ("symbolCandidates" in resolved) return symbolicCandidates(ws, resolved.symbol, resolved.symbolCandidates);

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
  return { ok: true, text: `${header}\n${renderHits(groups, ws.root)}` };
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
  | { symbolCandidates: Anchor[]; symbol: string }
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

    const node = located.tree.nodeAt(resolved.full.anchor);
    if (node === null) return { error: `${address.handle} no longer resolves to a node` };

    const question = questionNode(located.tree, node);
    if (question !== null) return { located, node: question };

    // A statement or block names nothing of its own, so the caller has to say
    // which of the symbols inside it they meant.
    const inside = identifiersWithin(node);
    if (inside.length === 1) return { located, node: inside[0]! };
    return { candidates: { located, nodes: inside, where: `${address.handle}` } };
  }

  if (address.form === "position") {
    const file = await ws.files.canonical(address.path);
    const located = await locate(ws, file);
    if (located === null) return { error: `no grammar for ${address.path}` };
    if (address.lines === null) return { error: "refs needs a line, not a whole file" };

    const span = formatLineRange(address.lines).slice(1);
    const idents = identifiersInRange(located, address.lines);
    if (idents.length === 0) return { error: `no symbols on ${address.path}:${span}` };
    if (idents.length === 1) return { located, node: idents[0]! };
    return { candidates: { located, nodes: idents, where: `${address.path}:${span}` } };
  }

  return anchorForSymbol(ws, address.symbol);
}

/**
 * LSP symbol search is deliberately broad; its response is a candidate list,
 * not proof that a qualified address is exact. Re-parse the returned source
 * and check the local qualified name before treating it as an address.
 */
async function anchorForSymbol(ws: Workspace, symbol: string): Promise<Resolution> {
  const leaf = symbol.split("::").at(-1)!;
  const locations = await ws.lsp.workspaceSymbols(leaf);
  const found: Anchor[] = [];

  for (const location of locations) {
    const file = (await ws.files.canonical(uriToPath(location.location.uri))) as FilePath;
    const located = await locate(ws, file);
    if (located === null) continue;

    const offset = positionToByte(located.snap, location.location.range.start, ws.lsp.positionEncoding);
    const node = located.tree.nodeAt(offset);
    if (node === null) continue;
    const declaration = declares(located.tree, node) ?? located.tree.enclosingItem(node);
    const question = declaration === null ? questionNode(located.tree, node) : questionNode(located.tree, declaration);
    if (question === null) continue;

    const qualified = declaration === null ? null : qualifiedName(located.tree, declaration);
    // A qualified address needs an exact local verification. Bare names are
    // inherently candidates: `scale` may exist in several crates or modules.
    if (symbol.includes("::") ? qualified !== symbol : question.text() !== symbol) continue;
    found.push({ located, node: question });
  }

  const unique = found.filter((candidate, i) =>
    found.findIndex((other) =>
      other.located.snap.path === candidate.located.snap.path
      && other.node.bytes.start === candidate.node.bytes.start,
    ) === i,
  );
  if (unique.length === 0) return { error: `symbol ${symbol} not found` };
  if (unique.length === 1) return unique[0]!;
  return { symbolCandidates: unique, symbol };
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
    // Hand back the declaration itself when the identifier names one, not the
    // name token. Both feed back into `refs` identically, but only the
    // declaration is a useful `read` or `edit` target — and only it carries a
    // qualified name, which is what lets a handle survive relocation after an
    // external change.
    const full = mint(ws, located, declaration ?? node);
    const item = declaration ?? located.tree.enclosingItem(node);
    const context =
      declaration !== null
        ? `declares ${describeItem(declaration)}`
        : item === null
          ? ""
          : `in ${describeItem(item)}`;
    return `${full.handle} [${stableLabel(full)}] :${full.lines.start} ${node.text()}${context === "" ? "" : `  ${context}`}`;
  });

  // Every candidate on one line means one shared snippet rather than the same
  // text repeated per entry.
  const distinctLines = new Set(nodes.map((n) => located.snap.index.lineAt(n.bytes.start)));
  const snippet =
    distinctLines.size === 1 ? [`  ${sourceLine(located, [...distinctLines][0]!)}`] : [];

  const header = `ambiguous: ${nodes.length} symbols on ${where} — call refs again with one of these handles`;
  return { ok: true, text: [header, ...snippet, ...lines].join("\n") };
}

function symbolicCandidates(ws: Workspace, symbol: string, found: Anchor[]): Reply {
  const lines = found.map(({ located, node }) => {
    const declaration = declares(located.tree, node) ?? located.tree.enclosingItem(node);
    const full = mint(ws, located, declaration ?? node);
    const qualified = declaration === null ? null : qualifiedName(located.tree, declaration);
    return `${full.handle} [${stableLabel(full)}] ${full.file}:${full.lines.start} ${qualified ?? node.text()}`;
  });
  return {
    ok: true,
    text: `ambiguous: ${found.length} symbols matching ${symbol} — call refs again with one of these handles\n${lines.join("\n")}`,
  };
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
