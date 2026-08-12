/**
 * Manifest-based language detection — the piece `index.ts` used to defer
 * (`FLUENT_LANG` was a test-only override, not a detection feature). Checked
 * at the workspace root only, the same scope `Workspace` itself operates
 * over; this does not walk up looking for an ancestor manifest.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

export type Lang = "rust" | "typescript";

/**
 * `Cargo.toml` wins over a TypeScript/JS manifest when a root somehow has
 * both (a Tauri app, say) — Rust is the more established profile here, and
 * `FLUENT_LANG` is the way out of a wrong guess, not a reason to grow a
 * precedence list. `package.json` alone (no `tsconfig.json`) still counts:
 * plenty of real JS projects have no `tsconfig.json`, and `typescript.ts`'s
 * client already speaks JS/JSX, not just TS.
 */
export async function detectLanguage(root: string): Promise<Lang | null> {
  if (await exists(join(root, "Cargo.toml"))) return "rust";
  if (await exists(join(root, "tsconfig.json"))) return "typescript";
  if (await exists(join(root, "package.json"))) return "typescript";
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
