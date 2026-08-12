import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { detectLanguage } from "./detect-language.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function root(...manifests: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fl-detect-"));
  dirs.push(dir);
  await Promise.all(manifests.map((name) => writeFile(join(dir, name), "")));
  return dir;
}

test("Cargo.toml alone detects rust", async () => {
  assert.equal(await detectLanguage(await root("Cargo.toml")), "rust");
});

test("tsconfig.json alone detects typescript", async () => {
  assert.equal(await detectLanguage(await root("tsconfig.json")), "typescript");
});

test("package.json alone detects typescript -- plenty of real JS projects carry no tsconfig.json", async () => {
  assert.equal(await detectLanguage(await root("package.json")), "typescript");
});

test("both Cargo.toml and a TS/JS manifest: Cargo.toml wins", async () => {
  assert.equal(await detectLanguage(await root("Cargo.toml", "tsconfig.json", "package.json")), "rust");
});

test("no recognized manifest: null, not a guess", async () => {
  assert.equal(await detectLanguage(await root("README.md")), null);
});

test("does not walk up to a parent manifest", async () => {
  const parent = await root("Cargo.toml");
  const nested = join(parent, "nested");
  await mkdir(nested);
  assert.equal(await detectLanguage(nested), null);
});
