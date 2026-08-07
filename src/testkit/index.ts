/**
 * Integration-test harness.
 *
 * Every run gets its own **copy** of the fixture. Mutation tests are the whole
 * point of M3 onward, and mutating the committed fixture in place would make
 * runs non-repeatable, leave `git status` dirty, and break any two runs that
 * overlap. Copy, point the daemon at the copy, mutate freely, discard.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { Reply, RequestInput } from "../shared/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
/** dist/testkit -> repo root */
const repoRoot = join(here, "..", "..");
export const FIXTURE = join(repoRoot, "fixtures", "rust-workspace");

/**
 * Where test sockets live. Overridable because `tmpdir()` is not always
 * writable, and some sandboxes refuse `AF_UNIX` bind outright with EPERM —
 * in which case point this at a directory inside the workspace.
 */
const SOCKET_DIR = process.env.FLUENT_SOCKET_DIR ?? tmpdir();

/** LSP tests need the real binary; skip rather than fail when it is absent. */
export function hasRustAnalyzer(): boolean {
  try {
    execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Can we actually bind a unix socket here?
 *
 * Sandboxes commonly deny this with EPERM, and a suite that dies on the first
 * `before` hook reports seven mysterious failures rather than one clear
 * reason. Probe once and skip with an explanation instead.
 */
export function canBindSocket(): boolean {
  const probe = join(SOCKET_DIR, `fl-probe-${process.pid}.sock`);
  try {
    mkdirSync(SOCKET_DIR, { recursive: true });
    const server = createServer();
    server.listen(probe);
    server.close();
    rmSync(probe, { force: true });
    return true;
  } catch {
    rmSync(probe, { force: true });
    return false;
  }
}

/**
 * One reason string for the whole integration suite, or `false` to run it.
 * Every prerequisite that can be missing gets named here rather than
 * presenting as a failure somewhere inside a hook.
 */
export function skipReason(): string | false {
  if (!hasRustAnalyzer()) return "rust-analyzer is not on PATH";
  if (!canBindSocket()) {
    return `cannot bind a unix socket in ${SOCKET_DIR} — set FLUENT_SOCKET_DIR to a writable path`;
  }
  return false;
}

export interface Harness {
  /** Root of the disposable copy. Mutate anything under here. */
  root: string;
  rpc(request: RequestInput): Promise<Reply>;
  /** Overwrite a file inside the copy, relative to its root. */
  write(relative: string, content: string): Promise<void>;
  read(relative: string): Promise<string>;
}

interface Running extends Harness {
  stop(): Promise<void>;
}

export async function startFixture(): Promise<Running> {
  const root = await mkdtemp(join(tmpdir(), "fl-fx-"));

  // `target/` is build output — copying it would be slow and pointless, and a
  // stale one can confuse a fresh index.
  await cp(FIXTURE, root, {
    recursive: true,
    filter: (src) => !src.includes(`${"/"}target`),
  });

  // Short socket path on purpose: sun_path caps near 104 bytes and a long
  // tmpdir plus a long name silently produces a daemon that never binds.
  const socket = join(SOCKET_DIR, `fl-${process.pid}-${counter++}.sock`);

  const daemon = spawn(process.execPath, [join(repoRoot, "dist", "daemon", "index.js"), root], {
    env: { ...process.env, FLUENT_SOCKET: socket },
    stdio: ["ignore", "ignore", "pipe"],
  });
  spawned.add(daemon);
  daemon.once("exit", () => spawned.delete(daemon));

  const log: string[] = [];
  daemon.stderr?.setEncoding("utf8");
  daemon.stderr?.on("data", (chunk: string) => log.push(chunk));

  const conn = await waitForSocket(socket, daemon, log);
  const pending = new Map<number, (reply: Reply) => void>();
  let nextId = 0;

  createInterface({ input: conn }).on("line", (line) => {
    const res = JSON.parse(line) as Reply & { id: number };
    pending.get(res.id)?.({ ok: res.ok, text: res.text });
    pending.delete(res.id);
  });

  /**
   * Every request is bounded. Without a timeout a single wedged call hangs the
   * whole suite with no output — the failure mode is indistinguishable from a
   * slow index, and the cause is invisible.
   */
  const rpc = (request: RequestInput): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out: ${JSON.stringify(request)}\n${log.join("")}`));
      }, 20_000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      conn.write(`${JSON.stringify({ id, request })}\n`);
    });

  // A dead daemon must fail outstanding calls rather than leave them pending.
  conn.once("close", () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter({ ok: false, text: `daemon connection closed\n${log.join("")}` });
    }
  });

  // Queries that need name resolution block on the index; wait once here so
  // individual tests do not each pay for discovering that.
  await waitForIndex(rpc, log);

  return {
    root,
    rpc,
    write: (relative, content) => writeFile(join(root, relative), content, "utf8"),
    read: (relative) => readFile(join(root, relative), "utf8"),
    async stop() {
      conn.destroy();
      // Wait for it to actually die. Returning early leaves the daemon — and
      // the rust-analyzer it owns — still running while the next suite starts,
      // so fixtures pile up and compete for the machine. That presents as an
      // intermittent timeout somewhere unrelated.
      await endProcess(daemon);
      spawned.delete(daemon);
      await rm(root, { recursive: true, force: true });
      await rm(socket, { force: true });
    },
  };
}

let counter = 0;

/**
 * Every spawned daemon, so a crashing suite cannot leak them.
 *
 * A leaked daemon holds a rust-analyzer, and a handful of those will starve
 * the machine badly enough that the *next* run's index never reaches
 * quiescent — which presents as a mysteriously hanging test suite rather than
 * as the resource leak it is.
 */
const spawned = new Set<ChildProcess>();
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const child of spawned) child.kill("SIGKILL");
  });
}

async function waitForSocket(path: string, daemon: ChildProcess, log: string[]): Promise<Socket> {
  for (let i = 0; i < 100; i++) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited ${daemon.exitCode}:\n${log.join("")}`);
    }
    const sock = await tryConnect(path);
    if (sock !== null) return sock;
    await delay(100);
  }
  throw new Error(`daemon never listened on ${path}:\n${log.join("")}`);
}

async function waitForIndex(rpc: (r: RequestInput) => Promise<Reply>, log: string[]): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const status = await rpc({ op: "status" });
    if (status.text.includes("index ready")) return;
    if (status.text.includes("index failed")) {
      throw new Error(`rust-analyzer failed:\n${log.join("")}`);
    }
    await delay(200);
  }
  throw new Error(`index never became ready:\n${log.join("")}`);
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(path);
    sock.once("connect", () => resolve(sock));
    sock.once("error", () => resolve(null));
  });
}

/** SIGTERM, then SIGKILL if it will not go. Resolves once it is gone. */
async function endProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  const forced = delay(3000).then(() => {
    child.kill("SIGKILL");
  });
  await Promise.race([exited, forced.then(() => exited)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
