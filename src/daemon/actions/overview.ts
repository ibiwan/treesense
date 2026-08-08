/**
 * OVERVIEW — a deterministic project map, not an architecture claim.
 *
 * This is deliberately useful before either parsing or semantic indexing: it
 * gives an agent vocabulary and bounded paths for its first `find` or `read`
 * without pretending that a shallow filesystem tree understands the project.
 */

import { basename, relative, sep } from "node:path";

import type { Reply } from "../../shared/protocol.js";
import type { FilePath } from "../../shared/types.js";
import { walkSource } from "../walk.js";
import type { Workspace } from "../workspace.js";

const MAX_ROWS = 60;
const MANIFESTS = new Set(["Cargo.toml", "package.json", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]);
const ENTRY_NAMES = /^(main|lib|index|app|server|program)\.[^.]+$/;

export async function overview(ws: Workspace): Promise<Reply> {
  const walked = await walkSource(ws.root);
  const paths = walked.files.map((file) => displayPath(ws.root, file));
  const manifests = await manifestPaths(ws, paths);
  const entries = paths.filter((path) => ENTRY_NAMES.test(basename(path)));
  const rows = treeRows(paths);

  const lines = [
    `project ${ws.root}`,
    `source files ${paths.length}${walked.truncated ? "+" : ""} (grammar-recognized; build and dependency directories omitted)`,
  ];
  if (manifests.length > 0) lines.push(`manifests: ${manifests.join(", ")}`);
  if (entries.length > 0) lines.push(`entry-like filenames (heuristic): ${entries.join(", ")}`);
  lines.push(`source tree (depth 2; ${Math.min(rows.length, MAX_ROWS)} of ${rows.length} rows):`);
  lines.push(...rows.slice(0, MAX_ROWS));
  if (rows.length > MAX_ROWS) lines.push(`… ${rows.length - MAX_ROWS} more rows omitted`);
  if (walked.truncated) lines.push("… source walk capped; some files were not listed");
  lines.push("next: read a listed file for its structural outline, or find with a listed file as haystack");
  return { ok: true, text: lines.join("\n") };
}

async function manifestPaths(ws: Workspace, sourcePaths: string[]): Promise<string[]> {
  // Manifests are intentionally included even if no parser covers them. Check
  // only the root and source-root directories; recursing the tree again would
  // make an orientation operation surprisingly expensive.
  const roots = new Set<string>([".", ...sourcePaths.map((path) => path.split(sep)[0]!).filter(Boolean)]);
  const found: string[] = [];
  for (const dir of roots) {
    for (const name of MANIFESTS) {
      const path = dir === "." ? name : `${dir}${sep}${name}`;
      const file = await ws.files.canonical(path);
      if (await ws.files.snapshot(file).then(() => true).catch(() => false)) found.push(path);
    }
  }
  return found.sort();
}

function displayPath(root: string, file: FilePath): string {
  return relative(root, file) || ".";
}

function treeRows(paths: string[]): string[] {
  const top = new Map<string, string[]>();
  for (const path of paths) {
    const [head, ...tail] = path.split(sep);
    const key = tail.length === 0 ? "." : head!;
    const rest = tail.length === 0 ? head! : tail.join(sep);
    const list = top.get(key) ?? [];
    list.push(rest);
    top.set(key, list);
  }

  const rows: string[] = [];
  for (const [head, descendants] of [...top.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (head === ".") {
      rows.push(...descendants.sort().map((file) => `  ${file}`));
      continue;
    }
    rows.push(`  ${head}/ (${descendants.length} source files)`);
    const direct = descendants.filter((path) => !path.includes(sep)).sort();
    const nested = new Map<string, number>();
    for (const path of descendants) {
      const [child, ...rest] = path.split(sep);
      if (rest.length > 0) nested.set(child!, (nested.get(child!) ?? 0) + 1);
    }
    rows.push(...direct.map((file) => `    ${file}`));
    rows.push(...[...nested.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, count]) => `    ${dir}/ (${count} source files)`));
  }
  return rows;
}
