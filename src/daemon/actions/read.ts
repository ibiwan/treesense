/**
 * READ — content, or a reason it could not be returned. Never navigation.
 *
 * The split is deliberate: FIND and REFS resolve addresses and hand back
 * structure, sizes and handles; by the time READ is called the decision is
 * already made. That only pays off if those responses are complete enough
 * that every read is an informed call, which is what lets READ stay this dumb.
 */

import { parseAddress } from "../../shared/address.js";
import {
  READ_DEFAULT_AVG_BYTES_PER_LINE,
  READ_SINGLE_LINE_BYTES,
} from "../../shared/protocol.js";
import { handlePlus } from "../../shared/render.js";
import type { Reply } from "../../shared/protocol.js";
import type { Handle } from "../../shared/types.js";
import type { Workspace } from "../workspace.js";

export interface ReadArgs {
  target: string;
  maxLines?: number | undefined;
  maxBytesPerLine?: number | undefined;
}

export async function read(ws: Workspace, args: ReadArgs): Promise<Reply> {
  const address = parseAddress(args.target);

  if (address.form === "symbolic") {
    return err(`read takes a handle or position; ${args.target} is a symbol — use find or refs`);
  }

  if (address.form === "handle") {
    return readHandle(ws, address.handle);
  }

  return readPosition(ws, address.path, address.lines, args);
}

async function readHandle(ws: Workspace, handle: Handle): Promise<Reply> {
  const resolved = await ws.handles.resolve(handle);

  switch (resolved.status) {
    case "unknown":
      return err(`${handle} unknown — handles do not survive a daemon restart; re-query`);

    case "gone":
      return err(`${handle} gone — its node no longer exists; the plan needs revisiting`);

    case "ok":
    case "changed": {
      const full = resolved.full;
      const snap = await ws.files.snapshot(full.file);
      const body = snap.content.subarray(full.bytes.start, full.bytes.end).toString("utf8");
      // No cap on a handle read: the size was shown at selection time, so
      // second-guessing it here would just be a round trip to say "yes, really".
      const marker = resolved.status === "changed" ? "changed: " : "";
      return { ok: true, text: `${marker}${handlePlus(full, { withPath: true })}\n${body}` };
    }
  }
}

async function readPosition(
  ws: Workspace,
  path: string,
  lines: { start: number; end: number } | null,
  args: ReadArgs,
): Promise<Reply> {
  const file = await ws.files.canonical(path);
  let snap;
  try {
    snap = await ws.files.snapshot(file);
  } catch {
    return err(`${path} could not be read`);
  }

  const span = lines ?? { start: 1, end: snap.index.lineCount };
  const requested = span.end - span.start + 1;

  const maxLines = args.maxLines ?? -1;
  if (maxLines >= 0 && requested > maxLines) {
    return err(`${requested} lines exceeds maxLines ${maxLines}`);
  }

  const bytes = snap.index.bytesForLines(span, snap.content.length);
  const total = bytes.end - bytes.start;

  const perLine = args.maxBytesPerLine ?? READ_DEFAULT_AVG_BYTES_PER_LINE;
  if (perLine >= 0) {
    // The single-line floor raises the allowance; it never lowers an explicit
    // one. A one-line read is a probe rather than a sized request — the caller
    // asked for a line with no way to know it would be a doozie — so the
    // discontinuity at two lines is deliberate.
    const allowance =
      requested === 1
        ? Math.max(perLine, READ_SINGLE_LINE_BYTES)
        : perLine * requested;
    if (total > allowance) {
      // Refuse rather than truncate. Half a function usually still parses, so
      // a truncated read invites confident reasoning about code that does not
      // exist — the caller never sees the early return twenty lines down.
      return err(
        `${total}B over ${requested} lines exceeds ${allowance}B; pass maxBytesPerLine=-1 to read anyway`,
      );
    }
  }

  const body = snap.content.subarray(bytes.start, bytes.end).toString("utf8");
  // Echo the canonical path, not the caller's spelling: a file that appears
  // under two names across responses undermines the identity the whole
  // generation scheme is keyed on.
  return { ok: true, text: `${file}:${span.start}-${span.end}\n${body}` };
}

function err(message: string): Reply {
  return { ok: false, text: `error: ${message}` };
}
