/**
 * Turning byte positions into handle-bearing records.
 *
 * Shared by `refs` and (later) `find`, because both answer the same underlying
 * question: given a location, what is the node there, what encloses it, and
 * what handle should the caller be given for each.
 */

import type { Full, FilePath, LineRange, NodeKind } from "../shared/types.js";
import { digest, type FileSnapshot } from "./files.js";
import { isItemKind, languageFor, parse, type SyntaxNode, type SyntaxTree } from "./syntax.js";
import type { Workspace } from "./workspace.js";

export interface Located {
  snap: FileSnapshot;
  tree: SyntaxTree;
}

/** Snapshot and parse a file, or null when no grammar covers it. */
export async function locate(ws: Workspace, file: FilePath): Promise<Located | null> {
  const lang = languageFor(file);
  if (lang === null) return null;
  const snap = await ws.files.snapshot(file);
  return { snap, tree: parse(snap.content, lang) };
}

/**
 * Qualified name, built from the chain of enclosing declarations —
 * `Widget::count` rather than bare `count`.
 *
 * Only declarations get one. A local binding has no qualified path: there may
 * be three `x`s in one function and nothing distinguishes them by name, which
 * is exactly why definition-site identity matters more than naming for locals.
 */
export function qualifiedName(tree: SyntaxTree, node: SyntaxNode): string | null {
  const own = isItemKind(node.kind) ? node.name : null;
  if (own === null) return null;

  const parts: string[] = [];
  for (const ancestor of tree.ancestors(node)) {
    if (!isItemKind(ancestor.kind)) continue;
    const name = ancestor.name;
    if (name !== null) parts.unshift(name);
  }
  parts.push(own);
  return parts.join("::");
}

/**
 * Mint a handle for a node.
 *
 * The digest is taken here, at issue time, and is what later distinguishes a
 * referent that merely *moved* from one that actually changed — a distinction
 * that has to exist or a multi-edit sequence never converges.
 */
export function mint(ws: Workspace, located: Located, node: SyntaxNode): Full {
  const { snap, tree } = located;
  const bytes = isItemKind(node.kind) ? tree.itemRangeWithDocs(node) : node.bytes;
  // Ask about the name, span the docs.
  const anchor = (isItemKind(node.kind) ? node.nameNode : null) ?? node;

  return ws.handles.issue({
    file: snap.path,
    bytes,
    lines: snap.index.linesForBytes(bytes),
    generation: snap.generation,
    digest: digest(snap.content, bytes),
    anchor: anchor.bytes.start,
    kind: node.kind,
    symbol: node.name ?? (node.kind === "ident" ? node.text() : null),
    qualified: qualifiedName(tree, node),
    definition: null,
  });
}

/**
 * The node a question about this position should actually be asked of.
 *
 * A handle to `fn Panel::render` holds dozens of identifiers, but "references
 * to it" plainly means references to `render` — so a declaration resolves to
 * its own name token rather than enumerating its body.
 */
export function questionNode(tree: SyntaxTree, node: SyntaxNode): SyntaxNode | null {
  if (node.kind === "ident") return node;
  if (isItemKind(node.kind)) return node.nameNode;
  return null;
}

/**
 * The declaration this identifier names, if it names one.
 *
 * Used to sort declarations ahead of usages when offering candidates: asked
 * about a line, the caller almost always means the thing being declared there
 * rather than a parameter type that happens to share the line.
 */
export function declares(tree: SyntaxTree, node: SyntaxNode): SyntaxNode | null {
  for (const ancestor of tree.ancestors(node)) {
    if (!isItemKind(ancestor.kind)) continue;
    const name = ancestor.nameNode;
    if (name === null) return null;
    return name.bytes.start === node.bytes.start && name.bytes.end === node.bytes.end
      ? ancestor
      : null;
  }
  return null;
}

/**
 * Identifier occurrences within a node, in source order.
 *
 * Deliberately NOT deduplicated by spelling. Collapsing `x` and `x` assumes
 * they are the same symbol, and the cases ambiguity mode exists to serve are
 * exactly the ones where they are not: a shadowed local, a type named twice in
 * one signature, two bindings sharing a name inside a statement. Merging those
 * silently drops a real choice.
 *
 * True identity would need a definition lookup per occurrence — an LSP round
 * trip each, and only available once the index is warm. Listing occurrences
 * costs a redundant entry when a symbol genuinely does repeat, which is the
 * cheap direction to be wrong in: the caller picks either and gets the same
 * answer, because they are the same symbol.
 */
export function identifiersWithin(node: SyntaxNode): SyntaxNode[] {
  return node.identifiers();
}

/**
 * Identifier occurrences overlapping an inclusive, 1-indexed line range.
 *
 * Honours the whole range, not just its first line: a Position is a range in
 * api-def.md, and looking only at `start` would turn a multi-symbol region
 * into a spuriously "unique" answer.
 *
 * Walks the tree rather than scanning offsets. Scanning is the obvious
 * approach and it is wrong: `nodeAt` on a keyword returns the enclosing
 * declaration, so advancing past that node's end skips the entire body — and
 * with it the very name the caller was asking about.
 */
export function identifiersInRange(located: Located, lines: LineRange): SyntaxNode[] {
  const { snap, tree } = located;
  const start = snap.index.startOfLine(lines.start);
  const end =
    lines.end >= snap.index.lineCount
      ? snap.content.length
      : snap.index.startOfLine(lines.end + 1);

  return tree.rootNode
    .identifiers()
    .filter((id) => id.bytes.end > start && id.bytes.start < end);
}

export const ITEM_KIND_HINT: ReadonlySet<NodeKind> = new Set<NodeKind>(["fn", "impl"]);
