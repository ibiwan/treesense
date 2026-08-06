/**
 * File registry: canonical identity, generations, lazy staleness, line index.
 *
 * Generations are optimistic concurrency control. We cannot lock the working
 * tree — the user's editor, git, build scripts and other agents all write it —
 * so instead every read is stamped and the stamp is checked at the moment we
 * act. A generation bumps ONLY on confirmed content change: bumping on mere
 * access would invalidate every outstanding handle for no reason, and failing
 * to bump would silently stop protecting anything.
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ByteRange, FilePath, Generation, LineRange } from "../shared/types.ts";

export interface FileSnapshot {
  path: FilePath;
  generation: Generation;
  content: Buffer;
  index: LineIndex;
}

/** Byte offsets of each line start, so line<->byte conversion is a binary search. */
export class LineIndex {
  private readonly starts: number[];

  constructor(content: Buffer) {
    const starts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === 0x0a) starts.push(i + 1);
    }
    // A trailing newline produces a final empty line we do not count.
    if (starts.length > 1 && starts[starts.length - 1] === content.length) {
      starts.pop();
    }
    this.starts = starts;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** 1-indexed line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Byte range covering an inclusive, 1-indexed line span. */
  bytesForLines(lines: LineRange, total: number): ByteRange {
    const startLine = Math.max(1, Math.min(lines.start, this.starts.length));
    const endLine = Math.max(startLine, Math.min(lines.end, this.starts.length));
    const start = this.starts[startLine - 1]!;
    const end = endLine >= this.starts.length ? total : this.starts[endLine]!;
    return { start, end };
  }

  linesForBytes(bytes: ByteRange): LineRange {
    return {
      start: this.lineAt(bytes.start),
      end: this.lineAt(Math.max(bytes.start, bytes.end - 1)),
    };
  }
}

interface Tracked {
  path: FilePath;
  generation: Generation;
  mtimeMs: number;
  size: number;
  content: Buffer;
  index: LineIndex;
}

export class FileRegistry {
  private readonly tracked = new Map<FilePath, Tracked>();
  /**
   * Bumped whenever any tracked file changes. Multi-file collections capture
   * it on entry and re-check on exit, so a set of individually-valid reads
   * cannot be shipped as a coherent snapshot if the world moved underneath.
   */
  private workspaceGeneration: Generation = 0;

  /**
   * Relative paths resolve against the workspace root, never the daemon's
   * process cwd — the daemon is long-lived and may have been started from
   * anywhere, so cwd is meaningless to a client that says `src/main.rs`.
   */
  constructor(private readonly root: string) {}

  get workspaceGen(): Generation {
    return this.workspaceGeneration;
  }

  /**
   * Canonical identity. Two spellings of one file must compare equal, or the
   * generation map silently splits and every guarantee built on it evaporates.
   * realpath resolves symlinks (/tmp -> /private/tmp on darwin) and returns
   * the on-disk casing.
   */
  async canonical(input: string, base = this.root): Promise<FilePath> {
    const abs = isAbsolute(input) ? input : resolve(base, input);
    try {
      return (await realpath(abs)) as FilePath;
    } catch {
      // Not on disk yet (a file the agent is about to create). Resolve
      // lexically; it becomes canonical once it exists.
      return abs as FilePath;
    }
  }

  /**
   * Read-through with lazy staleness. Cheaper and more reliable than a
   * watcher: one stat on a path we were taking anyway, always correct at the
   * moment of the answer, and nothing to miss between the event and the query.
   */
  async snapshot(path: FilePath): Promise<FileSnapshot> {
    const prior = this.tracked.get(path);
    const st = await stat(path);

    if (prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size) {
      return {
        path,
        generation: prior.generation,
        content: prior.content,
        index: prior.index,
      };
    }

    const content = await readFile(path);

    // mtime moved but bytes did not (touch, checkout of identical content).
    // Not a change: bumping here would kill handles for nothing.
    if (prior && prior.content.equals(content)) {
      prior.mtimeMs = st.mtimeMs;
      prior.size = st.size;
      return {
        path,
        generation: prior.generation,
        content: prior.content,
        index: prior.index,
      };
    }

    // TODO(sync): a bump detected here is a change rust-analyzer did not make,
    // so it must be told — `lsp.didChangeWatched(uri, 2)` — or its snapshot
    // drifts from ours and every position we translate between the two stops
    // being sound. Silent while REFS is stubbed; wire it before REFS lands.
    // The registry has no LSP reference by design, so the notification belongs
    // to whatever owns both (Workspace), not here.
    const next: Tracked = {
      path,
      generation: (prior?.generation ?? 0) + 1,
      mtimeMs: st.mtimeMs,
      size: st.size,
      content,
      index: new LineIndex(content),
    };
    this.tracked.set(path, next);
    this.workspaceGeneration += 1;
    return { path, generation: next.generation, content, index: next.index };
  }

  /** Record a write we performed ourselves, without a re-read round trip. */
  commit(path: FilePath, content: Buffer, mtimeMs: number): Generation {
    const prior = this.tracked.get(path);
    const next: Tracked = {
      path,
      generation: (prior?.generation ?? 0) + 1,
      mtimeMs,
      size: content.length,
      content,
      index: new LineIndex(content),
    };
    this.tracked.set(path, next);
    this.workspaceGeneration += 1;
    return next.generation;
  }
}

/** Digest of a referent's bytes: survives position shifts, breaks on edits. */
export function digest(content: Buffer, range: ByteRange): string {
  return createHash("sha256")
    .update(content.subarray(range.start, range.end))
    .digest("base64url")
    .slice(0, 16);
}
