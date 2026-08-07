/**
 * Workspace file enumeration.
 *
 * Prunes as it descends rather than filtering afterwards. `target/` in a Rust
 * workspace routinely holds more files than the source tree by orders of
 * magnitude, and enumerating it only to discard it is most of the cost of a
 * workspace-wide search.
 *
 * Grammar-driven, like everything else here: a file is a candidate only if a
 * grammar is registered for its extension, so assets, logs and generated blobs
 * never enter the list at all.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { FilePath } from "../shared/types.js";
import { languageFor } from "./syntax.js";

/**
 * Never descended into. Build output and VCS internals, plus the dependency
 * directories that dominate file counts without containing project source.
 */
const PRUNE = new Set([
  "target",
  "node_modules",
  ".git",
  ".jj",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

export interface WalkLimits {
  /** Stop after this many candidates. A search is not an inventory. */
  maxFiles?: number;
  /**
   * Restrict to files a grammar covers. Structural patterns need one by
   * definition; a literal text search does not, and refusing to look at a
   * README because nothing can parse it is not a defensible answer.
   */
  grammarsOnly?: boolean;
}

export interface Walked {
  files: FilePath[];
  /** The cap was reached, so the list is incomplete — and must be reported. */
  truncated: boolean;
}

export async function walkSource(root: string, limits: WalkLimits = {}): Promise<Walked> {
  const max = limits.maxFiles ?? 5000;
  const grammarsOnly = limits.grammarsOnly ?? true;
  const out: FilePath[] = [];
  let truncated = false;

  const descend = async (dir: string): Promise<void> => {
    if (out.length >= max) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole search.
      return;
    }

    for (const entry of entries) {
      if (out.length >= max) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (PRUNE.has(entry.name)) continue;
      }
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name)) continue;
        await descend(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (grammarsOnly && languageFor(path) === null) continue;
      out.push(path as FilePath);
    }
  };

  await descend(root);
  return { files: out, truncated };
}

/**
 * A NUL byte in the first few KB is the standard, cheap binary test. Text
 * search must not spew an object file into the response.
 */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}
