/**
 * Socket path derivation.
 *
 * Lives here rather than beside the daemon's entrypoint so the facade can
 * import it without side effects — `daemon/index.ts` runs `main()` on load,
 * so importing anything from it would start a socket server and a
 * rust-analyzer inside the MCP process, which is the exact arrangement the
 * two-process split exists to prevent.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SOCKET_ENV = "FLUENT_SOCKET";

/**
 * One socket per workspace root, keyed by a hash of the canonical path so two
 * roots never collide and the same root always resolves to the same daemon.
 * `FLUENT_SOCKET` overrides it outright, for tests and for running two daemons
 * against one tree.
 */
/**
 * A unix socket path is copied into `sockaddr_un.sun_path`, which is 104 bytes
 * on darwin and 108 on Linux. Exceeding it does not reliably raise — the bind
 * can simply not produce a socket — so check rather than discover it later as
 * a daemon that listens successfully and is unreachable.
 */
const SUN_PATH_MAX = 100;

export function socketPathFor(root: string): string {
  const override = process.env[SOCKET_ENV];
  if (override !== undefined && override.length > 0) {
    if (Buffer.byteLength(override) > SUN_PATH_MAX) {
      throw new Error(
        `${SOCKET_ENV} is ${Buffer.byteLength(override)} bytes; unix sockets cap at ~${SUN_PATH_MAX}`,
      );
    }
    return override;
  }

  const dir = join(tmpdir(), "mcp-fluent");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(dir, `${key}.sock`);
}
