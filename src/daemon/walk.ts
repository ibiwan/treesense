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
}

export async function walkSource(
  root: string,
  limits: WalkLimits = {},
): Promise<FilePath[]> {
  const max = limits.maxFiles ?? 5000;
  const out: FilePath[] = [];

  const descend = async (dir: string): Promise<void> => {
    if (out.length >= max) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole search.
      return;
    }

    for (const entry of entries) {
      if (out.length >= max) return;
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (PRUNE.has(entry.name)) continue;
      }
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name)) continue;
        await descend(path);
        continue;
      }
      if (entry.isFile() && languageFor(path) !== null) {
        out.push(path as FilePath);
      }
    }
  };

  await descend(root);
  return out;
}
