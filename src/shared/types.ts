/**
 * Core value types shared by the daemon and the MCP facade.
 * See api-def.md § Location References and § Return Types.
 */

/** Canonical absolute path, realpath'd and case-normalised. Never a URI. */
export type FilePath = string & { readonly __brand: "FilePath" };

/** Opaque, server-issued reference. `#` + base-32 (I/L/O/U excluded). */
export type Handle = string & { readonly __brand: "Handle" };

/** Monotonic per-file counter, bumped only on confirmed content change. */
export type Generation = number;

/** Byte offsets into the file's UTF-8 content. Half-open: [start, end). */
export interface ByteRange {
  start: number;
  end: number;
}

/** Inclusive, 1-indexed line span. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Normalised node kind, shared across grammars so responses read the same
 * whatever language produced them. Grammar-specific node kinds map into this.
 */
export type NodeKind =
  | "fn"
  | "impl"
  | "struct"
  | "enum"
  | "trait"
  | "mod"
  | "type"
  | "const"
  | "block"
  | "branch"
  | "loop"
  | "stmt"
  | "expr"
  | "ident"
  | "file"
  | "range";

/**
 * `Full` — the internal tuple a handle resolves to. Never crosses the MCP
 * boundary; the model only ever sees the handle and a rendered Handle Plus.
 */
export interface Full {
  handle: Handle;
  file: FilePath;
  bytes: ByteRange;
  lines: LineRange;
  /** File generation at the moment this handle was issued or last rebased. */
  generation: Generation;
  /** Digest of the referent's bytes. Survives position shifts; breaks on edits. */
  digest: string;
  kind: NodeKind;
  /** Unqualified symbol name, when the node names something. */
  symbol: string | null;
  /** Fully-qualified path (`Widget::count`) when the language provides one. */
  qualified: string | null;
  /**
   * Handle to the declaration this identifier binds to, when resolved.
   * Stored as a handle rather than a location so it rebases with edits.
   * Null until something asks a question that needs name resolution.
   */
  definition: Handle | null;
}

/** One step of a TRACE walk. See api-def.md § Return Types → Site. */
export interface Site {
  direction: "up" | "down";
  /** Number of call boundaries crossed from the origin. */
  distance: number;
  full: Full;
  /** Why this branch ended. `null` while the branch is still live. */
  stop: StopReason | null;
}

/**
 * Why a trace branch terminated. Every leaf carries one — a branch that
 * stopped because we could not follow it must not look like one that ended.
 */
export type StopReason =
  | "end" // value genuinely goes no further
  | "non-ident-arg" // passed as part of a larger expression, e.g. f(x + 1)
  | "macro" // consumed by a macro invocation
  | "destructure" // bound through a pattern we do not model
  | "field-assign" // stored into a struct field
  | "return" // flows out via return value
  | "depth" // hit Max Up / Max Down
  | "cycle" // already visited
  | "unresolved"; // callee could not be resolved

export interface Hit {
  /** Innermost-first chain of enclosing nodes, rendered as `> a > b > c`. */
  hierarchy: Full[];
  /** The matched line(s), verbatim. */
  snippet: string;
}

export type EditAction = "replace" | "insert-before" | "insert-after" | "delete";
