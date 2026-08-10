/**
 * The contract every language server client implements, plus the shared types
 * and helpers that do not vary by language — LSP's request/response shapes
 * are the same regardless of which server answers them.
 */

import type { Location, Position } from "vscode-languageserver-protocol";

export type Readiness = "starting" | "indexing" | "ready" | "failed";

/** The most useful current LSP work item for an agent deciding what to do next. */
export interface IndexStatus {
  readiness: Readiness;
  phase?: string;
  message?: string;
  percentage?: number;
}

/** The location-bearing subset shared by LSP workspace-symbol response forms. */
export interface WorkspaceSymbol {
  name: string;
  location: Location;
}

/**
 * One warm language server for one workspace root.
 *
 * `read` never calls any of these — it needs file bytes and at most a parse,
 * not name resolution, so an agent can work while a client is still starting.
 * `refs` and `trace` need name resolution and wait on `whenReady()`.
 */
export interface LspClient {
  readonly readiness: Readiness;
  /** A snapshot, not a completion signal. What `ready` requires is implementation-defined. */
  readonly indexStatus: IndexStatus;
  /** utf-8 if the server accepted it, utf-16 otherwise. Convert at the boundary. */
  readonly positionEncoding: "utf-8" | "utf-16";

  start(): Promise<void>;
  stop(): Promise<void>;
  whenReady(): Promise<void>;

  references(uri: string, position: Position): Promise<Location[]>;
  definition(uri: string, position: Position): Promise<Location[]>;
  workspaceSymbols(query: string): Promise<WorkspaceSymbol[]>;
  didChangeWatched(uri: string, type: 1 | 2 | 3): Promise<void>;
}

export function pathToUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}
