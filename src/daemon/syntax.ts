/**
 * Syntax layer, over ast-grep.
 *
 * Grammar-driven by construction: a file is parsed only if a grammar is
 * registered for its extension. Assets, logs and generated blobs are never
 * visited, which is why a repo that grows to tens of thousands of media files
 * costs this tool nothing.
 *
 * Two per-language tables live here, and they are the price of the `item`
 * concept. `node` falls out of the parser for free; "smallest enclosing
 * declaration" needs to know which kinds are declarations, and readable output
 * needs those kinds normalised so a response reads the same whatever grammar
 * produced it.
 *
 * ALL offsets crossing this boundary are converted. ast-grep reports UTF-16
 * code units while documenting them as bytes — see offsets.ts.
 */

import { Lang, parse as agParse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import rustLang from "@ast-grep/lang-rust";

import type { ByteRange, NodeKind } from "../shared/types.js";
import { OffsetMap } from "./offsets.js";

export type Language = "rust" | "typescript" | "javascript" | "tsx";

/**
 * `registerDynamicLanguage` is experimental and must be called exactly once per
 * process, so it belongs to daemon startup rather than to a lazy parse.
 */
let registered = false;
export function registerLanguages(): void {
  if (registered) return;
  registerDynamicLanguage({ rust: rustLang });
  registered = true;
}

const BY_EXTENSION: Record<string, Language> = {
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
};

/** Only languages we can actually parse. Anything else has no syntax layer. */
export function languageFor(path: string): Language | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? null;
}

/** `rust` is the key registered above; the rest are bundled with the binding. */
function agLang(lang: Language): string {
  switch (lang) {
    case "rust":
      return "rust";
    case "typescript":
      return Lang.TypeScript;
    case "javascript":
      return Lang.JavaScript;
    case "tsx":
      return Lang.Tsx;
  }
}

/**
 * Grammar node kind -> shared vocabulary. Raw kinds differ per grammar
 * (`function_item` / `function_declaration` / `function_definition` are one
 * concept in three spellings) and the model should not have to know which
 * language it is looking at to read a response.
 */
const KIND_MAP: Record<Language, Record<string, NodeKind>> = {
  rust: {
    function_item: "fn",
    impl_item: "impl",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
    mod_item: "mod",
    type_item: "type",
    const_item: "const",
    static_item: "const",
    block: "block",
    match_arm: "branch",
    if_expression: "branch",
    else_clause: "branch",
    for_expression: "loop",
    while_expression: "loop",
    loop_expression: "loop",
    expression_statement: "stmt",
    let_declaration: "stmt",
    identifier: "ident",
    field_identifier: "ident",
    type_identifier: "ident",
  },
  typescript: {
    function_declaration: "fn",
    method_definition: "fn",
    arrow_function: "fn",
    class_declaration: "impl",
    interface_declaration: "trait",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "stmt",
    expression_statement: "stmt",
    statement_block: "block",
    if_statement: "branch",
    switch_case: "branch",
    for_statement: "loop",
    while_statement: "loop",
    identifier: "ident",
    property_identifier: "ident",
  },
  javascript: {},
  tsx: {},
};

/** Kinds that count as declarations for `item` scope. */
const ITEM_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "fn",
  "impl",
  "struct",
  "enum",
  "trait",
  "mod",
  "type",
  "const",
]);

/** Attached to the item above them, so replacing a function takes its docs. */
const DOC_KINDS: ReadonlySet<string> = new Set([
  "line_comment",
  "block_comment",
  "attribute_item",
  "inner_attribute_item",
  "comment",
  "decorator",
]);

export function normaliseKind(lang: Language, raw: string): NodeKind {
  const direct = KIND_MAP[lang][raw];
  if (direct !== undefined) return direct;
  // JS and TSX share TS's grammar shape closely enough to borrow its table.
  if (lang !== "typescript") {
    const borrowed = KIND_MAP.typescript[raw];
    if (borrowed !== undefined) return borrowed;
  }
  return "expr";
}

export function isItemKind(kind: NodeKind): boolean {
  return ITEM_KINDS.has(kind);
}

export interface SyntaxNode {
  readonly kind: NodeKind;
  readonly rawKind: string;
  /** UTF-8 byte range, converted. Never ast-grep's raw units. */
  readonly bytes: ByteRange;
  /** Declared name, when the node names something. */
  readonly name: string | null;
  /**
   * The identifier node a declaration is named by. LSP answers questions about
   * a *position*, and asking about the whole `fn` gives nothing useful — the
   * question has to be posed at the name token.
   */
  readonly nameNode: SyntaxNode | null;
  readonly parent: SyntaxNode | null;
  /** Identifier nodes directly beneath this one, innermost occurrences first. */
  identifiers(): SyntaxNode[];
  text(): string;
}

class Node implements SyntaxNode {
  constructor(
    private readonly sg: SgNode,
    private readonly tree: Tree,
  ) {}

  get rawKind(): string {
    return String(this.sg.kind());
  }

  get kind(): NodeKind {
    return normaliseKind(this.tree.language, String(this.sg.kind()));
  }

  get bytes(): ByteRange {
    const r = this.sg.range();
    return {
      start: this.tree.offsets.toBytes(r.start.index),
      end: this.tree.offsets.toBytes(r.end.index),
    };
  }

  get name(): string | null {
    return this.nameNode?.text() ?? null;
  }

  get nameNode(): SyntaxNode | null {
    // Grammars disagree about what the naming field is called: Rust's
    // `impl_item` names its subject `type`, not `name`.
    for (const field of ["name", "type"]) {
      try {
        const f = this.sg.field(field);
        if (f !== null && f !== undefined) return new Node(f, this.tree);
      } catch {
        // This kind has no such field; try the next.
      }
    }
    return null;
  }

  identifiers(): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    const walk = (sg: SgNode): void => {
      if (normaliseKind(this.tree.language, String(sg.kind())) === "ident") {
        out.push(new Node(sg, this.tree));
        return; // an identifier has no identifiers inside it
      }
      for (const child of sg.children()) walk(child);
    };
    walk(this.sg);
    return out;
  }

  get parent(): SyntaxNode | null {
    const p = this.sg.parent();
    return p === null ? null : new Node(p, this.tree);
  }

  text(): string {
    return this.sg.text();
  }

  /** Escape hatch for callers that need the underlying node (ancestor walks). */
  get raw(): SgNode {
    return this.sg;
  }
}

export interface SyntaxTree {
  readonly language: Language;
  /** Whole-file node, for traversals that are not anchored at an offset. */
  readonly rootNode: SyntaxNode;
  /** Smallest *named* node containing the byte offset — never punctuation. */
  nodeAt(byteOffset: number): SyntaxNode | null;
  /** Innermost-first ancestor chain, structural wrappers filtered out. */
  ancestors(node: SyntaxNode): SyntaxNode[];
  /**
   * Smallest enclosing declaration, extended backwards over contiguous doc
   * comments and attributes. Without that extension, replacing a function
   * strands its doc comment describing the old signature — which still parses,
   * so nothing downstream catches it.
   */
  enclosingItem(node: SyntaxNode): SyntaxNode | null;
  /** Byte range of an item including its attached docs. */
  itemRangeWithDocs(node: SyntaxNode): ByteRange;
  /** Every declaration in the file, for identity-based relocation. */
  items(): SyntaxNode[];
  /**
   * Did the parse hit anything it could not make sense of?
   *
   * ast-grep exposes no `hasError()`, but a failed parse leaves `ERROR` nodes
   * in the tree. Checking before a write costs microseconds and stops an
   * unbalanced brace reaching disk, where it resurfaces later as confusing
   * name-resolution failures rather than as the syntax error it actually is.
   */
  hasParseError(): boolean;
}

class Tree implements SyntaxTree {
  constructor(
    readonly language: Language,
    readonly content: Buffer,
    readonly offsets: OffsetMap,
    private readonly root: SgNode,
  ) {}

  get rootNode(): SyntaxNode {
    return new Node(this.root, this);
  }

  nodeAt(byteOffset: number): SyntaxNode | null {
    // ast-grep has no descendant-for-offset primitive, so descend by hand.
    const target = this.offsets.toUtf16(byteOffset);
    let best: SgNode | null = null;
    let cur: SgNode = this.root;

    for (;;) {
      if (cur.isNamed()) best = cur;
      let descended = false;
      for (const child of cur.children()) {
        const r = child.range();
        if (r.start.index <= target && target < r.end.index) {
          cur = child;
          descended = true;
          break;
        }
      }
      if (!descended) break;
    }

    return best === null ? null : new Node(best, this);
  }

  ancestors(node: SyntaxNode): SyntaxNode[] {
    const sg = (node as Node).raw;
    // ast-grep returns innermost-first already (verified against tauroid).
    return sg
      .ancestors()
      .filter((a) => a.isNamed())
      .map((a) => new Node(a, this));
  }

  items(): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    const walk = (sg: SgNode): void => {
      const kind = normaliseKind(this.language, String(sg.kind()));
      if (isItemKind(kind)) out.push(new Node(sg, this));
      // Declarations nest — a fn inside an impl, a mod inside a mod — so keep
      // descending rather than stopping at the first hit.
      for (const child of sg.children()) walk(child);
    };
    walk(this.root);
    return out;
  }

  hasParseError(): boolean {
    const walk = (sg: SgNode): boolean => {
      if (String(sg.kind()) === "ERROR") return true;
      return sg.children().some(walk);
    };
    return walk(this.root);
  }

  enclosingItem(node: SyntaxNode): SyntaxNode | null {
    if (isItemKind(node.kind)) return node;
    for (const a of this.ancestors(node)) {
      if (isItemKind(a.kind)) return a;
    }
    return null;
  }

  itemRangeWithDocs(node: SyntaxNode): ByteRange {
    const sg = (node as Node).raw;
    let start = node.bytes.start;

    for (let prev = sg.prev(); prev !== null; prev = prev.prev()) {
      if (!DOC_KINDS.has(String(prev.kind()))) break;
      const prevRange = {
        start: this.offsets.toBytes(prev.range().start.index),
        end: this.offsets.toBytes(prev.range().end.index),
      };
      // A blank line separates a comment from the item, and it stops
      // belonging to it — a module header is not a function's doc comment.
      if (!attachedTo(this.content, prevRange, start)) break;
      start = prevRange.start;
    }

    return { start, end: node.bytes.end };
  }
}

export function parse(content: Buffer, lang: Language): SyntaxTree {
  registerLanguages();
  const root = agParse(agLang(lang), content.toString("utf8")).root();
  return new Tree(lang, content, new OffsetMap(content), root);
}

/**
 * Is `prev` attached to what follows it, or separated by a blank line?
 *
 * The subtlety: a `line_comment` node's range **includes its own trailing
 * newline**, while an `attribute_item`'s does not. So the gap after a comment
 * already starts on the next line, and a single newline in it means a blank
 * line — whereas after an attribute that same single newline is just the line
 * break. Counting newlines without accounting for that treats a detached
 * module header as attached, and every item handle in a documented file ends
 * up spanning the top of the file.
 */
function attachedTo(content: Buffer, prev: ByteRange, start: number): boolean {
  const absorbsNewline = content[prev.end - 1] === 0x0a;
  const allowed = absorbsNewline ? 0 : 1;

  let newlines = 0;
  for (let i = prev.end; i < start; i++) {
    const ch = content[i]!;
    if (ch === 0x0a) {
      newlines += 1;
      if (newlines > allowed) return false;
      continue;
    }
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d) return false;
  }
  return true;
}

/**
 * Whitespace-only extension to line boundaries — verified, not assumed.
 * Snapping unconditionally is wrong wherever a line holds more than one node
 * (minified bundles being the reductio), and there the failure mode is
 * deleting a sibling. Checking is two byte scans and turns a heuristic into
 * a fact.
 */
export function extendToLineBounds(content: Buffer, range: ByteRange): ByteRange {
  let start = range.start;
  while (start > 0 && content[start - 1] !== 0x0a) {
    const ch = content[start - 1]!;
    if (ch !== 0x20 && ch !== 0x09) return range;
    start -= 1;
  }

  let end = range.end;
  while (end < content.length && content[end] !== 0x0a) {
    const ch = content[end]!;
    if (ch !== 0x20 && ch !== 0x09 && ch !== 0x0d) return { start, end: range.end };
    end += 1;
  }

  return { start, end };
}
