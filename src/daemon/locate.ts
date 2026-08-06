/**
 * Turning byte positions into handle-bearing records.
 *
 * Shared by `refs` and (later) `find`, because both answer the same underlying
 * question: given a location, what is the node there, what encloses it, and
 * what handle should the caller be given for each.
 */

import type { Full, FilePath, NodeKind } from "../shared/types.js";
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

  return ws.handles.issue({
    file: snap.path,
    bytes,
    lines: snap.index.linesForBytes(bytes),
    generation: snap.generation,
    digest: digest(snap.content, bytes),
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

/** Distinct identifiers within a node, deduplicated by text. */
export function distinctIdentifiers(node: SyntaxNode): SyntaxNode[] {
  const seen = new Set<string>();
  const out: SyntaxNode[] = [];
  for (const id of node.identifiers()) {
    const text = id.text();
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(id);
  }
  return out;
}

/**
 * Identifiers on a 1-indexed line, for resolving a bare position.
 *
 * Walks the tree rather than scanning offsets. Scanning is the obvious
 * approach and it is wrong: `nodeAt` on a keyword returns the enclosing
 * declaration, so advancing past that node's end skips the entire body — and
 * with it the very name the caller was asking about.
 */
export function identifiersOnLine(located: Located, line: number): SyntaxNode[] {
  const { snap, tree } = located;
  const start = snap.index.startOfLine(line);
  const end =
    line >= snap.index.lineCount
      ? snap.content.length
      : snap.index.startOfLine(line + 1);

  const seen = new Set<string>();
  const out: SyntaxNode[] = [];
  for (const id of tree.rootNode.identifiers()) {
    if (id.bytes.end <= start || id.bytes.start >= end) continue;
    const text = id.text();
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(id);
  }
  return out;
}

export const ITEM_KIND_HINT: ReadonlySet<NodeKind> = new Set<NodeKind>(["fn", "impl"]);
