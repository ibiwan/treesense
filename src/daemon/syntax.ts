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

/**
 * Decoration vocabulary, per grammar. Used to answer one question: which single
 * name does an expression denote?
 *
 * `trace` is a name tracer. `&mut x`, `(x)`, `x?` and `x.clone()` are all still
 * x as far as a name is concerned, and refusing to see through them stops a
 * trace at the first borrow — which in Rust is roughly immediately. The rules
 * are syntactic and identical across languages; only these token sets differ,
 * which is what keeps the traversal one implementation rather than four.
 */
interface PeelTable {
  /** Single-operand wrappers. The operand is the last named child. */
  readonly wrappers: ReadonlySet<string>;
  /** Dotted/scoped access. The value is the rightmost segment. */
  readonly paths: ReadonlySet<string>;
  readonly call: string;
  readonly args: string;
  /** Binds a name to a value: the name comes first, the value last. */
  readonly binding: ReadonlySet<string>;
  /** Explicit return. The returned value is the last named child. */
  readonly returns: ReadonlySet<string>;
}

const RUST_PEEL: PeelTable = {
  wrappers: new Set([
    "reference_expression", // &x, &mut x
    "unary_expression", // *x, -x
    "parenthesized_expression",
    "try_expression", // x?
    "await_expression",
  ]),
  paths: new Set(["field_expression", "scoped_identifier"]),
  call: "call_expression",
  args: "arguments",
  binding: new Set(["let_declaration"]),
  returns: new Set(["return_expression"]),
};

const TS_PEEL: PeelTable = {
  wrappers: new Set([
    "parenthesized_expression",
    "await_expression",
    "non_null_expression", // x!
    "unary_expression",
    "spread_element", // ...x
    "as_expression", // x as T
    "satisfies_expression",
  ]),
  paths: new Set(["member_expression"]),
  call: "call_expression",
  args: "arguments",
  binding: new Set(["variable_declarator"]),
  returns: new Set(["return_statement"]),
};

const PEEL: Record<Language, PeelTable> = {
  rust: RUST_PEEL,
  typescript: TS_PEEL,
  javascript: TS_PEEL,
  tsx: TS_PEEL,
};

/** Runaway guard: real decoration nests a few deep, never dozens. */
const MAX_PEEL = 12;


/**
 * Raw kind of a function declaration's parameter list — diverges per
 * grammar. tree-sitter-rust calls it `parameters`; tree-sitter-typescript
 * (and JS/TSX, which share its shape) calls it `formal_parameters`.
 */
const PARAMETERS_KIND: Record<Language, string> = {
  rust: "parameters",
  typescript: "formal_parameters",
  javascript: "formal_parameters",
  tsx: "formal_parameters",
};

/** The parameter-list node of a function-kind declaration, or null if none is found. */
export function parametersOf(lang: Language, fn: SyntaxNode): SyntaxNode | null {
  return fn.children().find((c) => c.rawKind === PARAMETERS_KIND[lang]) ?? null;
}

/** Never report more names from one expression than a reader will scan. */
const MAX_CANDIDATES = 8;

/**
 * Every identifier an expression might denote, best guess first.
 *
 * PERMISSIVE BY DESIGN. `&mut x`, `(x)` and `x.clone()` denote exactly `x`, but
 * `item.fields` plausibly means either the field or its container, and
 * `seed + 1` plausibly means `seed`. All of them are returned rather than
 * adjudicated.
 *
 * The asymmetry that justifies it: a reader discards a wrong candidate at a
 * glance, but cannot detect a flow that was silently dropped. Over-reporting
 * costs a line; under-reporting costs a wrong conclusion. So this errs toward
 * including, and `trace` documents that its edges are candidates.
 *
 * Order is a hint, never a filter — the name an expression most likely denotes
 * comes first, and callers that want just that one may take `[0]`.
 *
 * An empty array still means what it says: no name in there at all.
 */
export function candidateNames(lang: Language, node: SyntaxNode): SyntaxNode[] {
  const table = PEEL[lang];
  const out: SyntaxNode[] = [];

  const add = (found: SyntaxNode): void => {
    if (out.length >= MAX_CANDIDATES) return;
    if (out.some((seen) => seen.bytes.start === found.bytes.start)) return;
    out.push(found);
  };

  const walk = (cur: SyntaxNode, depth: number): void => {
    if (depth > MAX_PEEL || out.length >= MAX_CANDIDATES) return;
    if (cur.kind === "ident") {
      add(cur);
      return;
    }
    const raw = cur.rawKind;

    // Pure decoration: exactly one name underneath, no ambiguity to report.
    if (table.wrappers.has(raw)) {
      const inner = cur.children().at(-1);
      if (inner !== undefined) walk(inner, depth + 1);
      return;
    }

    if (raw === table.call) {
      const kids = cur.children();
      const callee = kids[0];
      const args = kids[1];
      if (callee === undefined) return;
      const hasArgs = args?.rawKind === table.args && args.children().length > 0;
      // A zero-argument method continues the receiver's story under a different
      // type: `x.clone()`, `x.toString()`. The receiver is the value, which is
      // why this precedes the path rule — that would offer `clone` instead.
      if (!hasArgs && table.paths.has(callee.rawKind)) {
        const receiver = callee.children()[0];
        if (receiver !== undefined) walk(receiver, depth + 1);
        return;
      }
      // A call with arguments produces a NEW value. Its arguments did not flow
      // into the enclosing position, so offering them would be a false edge
      // even by permissive standards — the callee's return is the real link,
      // and `stepDownThroughReturn` is what follows it.
      return;
    }

    // Dotted access: the field is the likelier reading, the container the
    // plausible one. Rightmost first, then outward.
    if (table.paths.has(raw)) {
      const kids = cur.children();
      for (let i = kids.length - 1; i >= 0; i--) walk(kids[i]!, depth + 1);
      return;
    }

    // Anything else — arithmetic, comparison, a tuple, an array literal. Every
    // name inside it is a candidate: `seed + 1` offers `seed`.
    for (const child of cur.children()) walk(child, depth + 1);
  };

  walk(node, 0);
  return out;
}

/**
 * The likeliest single name, or null when the expression names nothing.
 *
 * A convenience over `candidateNames` for callers that genuinely need one
 * answer. Prefer the full list wherever a caller can carry several.
 */
export function principalName(lang: Language, node: SyntaxNode): SyntaxNode | null {
  return candidateNames(lang, node)[0] ?? null;
}

/**
 * If this identifier is the name a binding introduces, the expression it is
 * bound to. `let pose = draw_pose(..)` asked about `pose` gives the call.
 *
 * The name-first/value-last shape holds across every language in the table, so
 * an optional type annotation or a `mut` in between costs nothing.
 */
export function boundValue(lang: Language, node: SyntaxNode): SyntaxNode | null {
  const parent = node.parent;
  if (parent === null || !PEEL[lang].binding.has(parent.rawKind)) return null;

  const value = parent.children().at(-1);
  if (value === undefined) return null;
  // Asked about the value rather than the name: that is not a binding edge.
  if (value.bytes.start <= node.bytes.start) return null;
  return value;
}

/**
 * Every expression whose value leaves this function: the tail expression, plus
 * anything explicitly returned.
 *
 * A tail that is a statement is not a value — `fn f() { g(); }` returns unit,
 * and reporting `g()` as its return would invent a flow.
 */
export function returnValues(lang: Language, fn: SyntaxNode): SyntaxNode[] {
  const table = PEEL[lang];
  const out: SyntaxNode[] = [];

  const body = fn.children().find((c) => c.kind === "block");
  if (body === undefined) return out;

  const tail = body.children().at(-1);
  if (tail !== undefined && tail.kind !== "stmt") out.push(tail);

  const walk = (node: SyntaxNode, depth: number): void => {
    if (depth > 40) return;
    if (table.returns.has(node.rawKind)) {
      const value = node.children().at(-1);
      if (value !== undefined) out.push(value);
      return;
    }
    // A nested function's returns belong to it, not to us.
    if (depth > 0 && node.kind === "fn") return;
    for (const child of node.children()) walk(child, depth + 1);
  };
  walk(body, 0);

  return out;
}

/**
 * Inverse of `boundValue`: the name a binding gives to this value expression,
 * looking through any decoration between them (`let x = f()?`).
 */
export function boundName(lang: Language, value: SyntaxNode): SyntaxNode | null {
  const table = PEEL[lang];
  let cur: SyntaxNode = value;
  for (let depth = 0; depth < MAX_PEEL; depth++) {
    const parent: SyntaxNode | null = cur.parent;
    if (parent === null) return null;
    if (table.binding.has(parent.rawKind)) {
      const kids = parent.children();
      // Only the bound value carries the name; an argument inside it does not.
      if (kids.at(-1)?.bytes.start !== cur.bytes.start) return null;
      // First identifier, so `let mut x` and `let x: T` both land on `x`.
      return kids.find((k) => k.kind === "ident") ?? null;
    }
    if (!table.wrappers.has(parent.rawKind)) return null;
    cur = parent;
  }
  return null;
}

/** Peel decoration off an expression to the call underneath, if there is one. */
export function callWithin(lang: Language, node: SyntaxNode): SyntaxNode | null {
  const table = PEEL[lang];
  let cur: SyntaxNode | null = node;
  for (let depth = 0; cur !== null && depth < MAX_PEEL; depth++) {
    if (cur.rawKind === table.call) return cur;
    if (!table.wrappers.has(cur.rawKind)) return null;
    cur = cur.children().at(-1) ?? null;
  }
  return null;
}

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
  /** Named children, in source order. Needed to locate an argument by position. */
  children(): SyntaxNode[];
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

  children(): SyntaxNode[] {
    return this.sg
      .children()
      .filter((c) => c.isNamed())
      .map((c) => new Node(c, this.tree));
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
   * Structural search. `$A`-style metavariables match any node, so
   * `$A.unwrap()` finds every unwrap regardless of receiver — which a text
   * search cannot express and a regex expresses badly.
   */
  search(pattern: string): SyntaxNode[];
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

  search(pattern: string): SyntaxNode[] {
    return this.root.findAll(pattern).map((m) => new Node(m, this));
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
    // TS/JS wrap a declaration in an `export_statement` whose own span starts
    // at the `export` keyword, before the declaration it wraps. A position
    // landing in that keyword span (LSP symbol search returns exactly this —
    // the start of the whole exported declaration) resolves via `nodeAt` to
    // the wrapper itself: it is the smallest NAMED node containing that byte,
    // since the wrapped declaration's own range starts later. The wrapper has
    // no item-kind ancestors (it's usually near the top of the file) and,
    // being a statement rather than a declaration, is not an item itself —
    // so climbing stops with nothing, even though the real declaration is
    // sitting one level down. Rust has no such wrapper: a visibility modifier
    // is a child token of the item itself, never a separate enclosing node.
    return node.children().find((c) => isItemKind(c.kind)) ?? null;
  }

  itemRangeWithDocs(node: SyntaxNode): ByteRange {
    const sg = (node as Node).raw;

    // TS/JS wrap a lone declaration in an `export_statement`, contributing a
    // leading "export"/"export default" the declaration's own range
    // excludes. That prefix is real text belonging to the declaration — a
    // move or edit using the bare range would leave the keyword behind as an
    // orphan token — and a doc comment precedes the wrapper, not the
    // declaration nested inside it, so the backward walk for docs has to
    // start there too: `sg.prev()` alone finds nothing, since the
    // declaration has no siblings of its own, and a comment sitting right
    // above `export function foo` would be reported detached.
    const parent = sg.parent();
    const wrapped = parent !== null
      && !isItemKind(normaliseKind(this.language, String(parent.kind())))
      && parent.children().filter((c) => c.isNamed()).length === 1;
    const anchor = wrapped ? parent! : sg;

    let start = this.offsets.toBytes(anchor.range().start.index);

    for (let prev = anchor.prev(); prev !== null; prev = prev.prev()) {
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

/**
 * Is this pattern well-formed for the language?
 *
 * `findAll` does not throw on a malformed pattern — it builds one containing
 * ERROR nodes and quietly matches nothing, which is indistinguishable from a
 * genuine empty result. Since zero matches is meaningful information here, the
 * pattern has to be checked rather than assumed.
 *
 * Metavariables are substituted first: `$A` is not valid source in any of
 * these grammars, and `$$$` stands for zero or more nodes, so it drops out.
 */
export function patternParses(pattern: string, lang: Language): boolean {
  const probe = pattern
    .replace(/\$\$\$[A-Za-z_][A-Za-z_0-9]*|\$\$\$/g, "")
    .replace(/\$([A-Za-z_][A-Za-z_0-9]*)/g, "zz_$1");
  if (probe.trim().length === 0) return false;
  return !parse(Buffer.from(probe, "utf8"), lang).hasParseError();
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
