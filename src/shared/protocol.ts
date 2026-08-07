/**
 * Daemon IPC contract.
 *
 * The MCP server is spawned by the host and dies with the client session; the
 * daemon outlives it. Everything with a lifetime — the handle table,
 * generations, the warm index — lives on the daemon side, so handles die when
 * the daemon dies rather than when a client disconnects.
 *
 * Requests are newline-delimited JSON over a unix socket.
 */

import { z } from "zod";

export const FindRequest = z.object({
  op: z.literal("find"),
  needle: z.string().min(1),
  haystack: z.string().optional(),
});

export const ReadRequest = z.object({
  op: z.literal("read"),
  target: z.string().min(1),
  maxLines: z.number().int().optional(),
  /**
   * Average bytes per line across the response, not a per-line cap: one long
   * line inside an otherwise ordinary read averages away, while wholesale
   * density anomalies still trip. Tolerance therefore scales with how much
   * was asked for, which tracks what the caller already signed up for.
   */
  maxBytesPerLine: z.number().int().optional(),
});

export const RefsRequest = z.object({
  op: z.literal("refs"),
  target: z.string().min(1),
});

export const EditRequest = z.object({
  op: z.literal("edit"),
  /**
   * Handles only — but enforced in the action, not here, so the caller gets
   * "edit takes a handle, not src/x.rs:10" rather than a regex complaint.
   */
  target: z.string().min(1),
  action: z.enum(["replace", "insert-before", "insert-after", "delete"]),
  /**
   * Handles the edit's correctness depends on but does not itself modify.
   * Only the caller knows the premise — we can see that the target is
   * unchanged, but not that the edit was predicated on three call sites
   * looking the way they did when they were read. Over-listing costs a retry;
   * under-listing costs a silently wrong edit, so bias toward listing.
   */
  deps: z.array(z.string().regex(/^#/)).default([]),
  content: z.string().default(""),
});

export const MoveRequest = z.object({
  op: z.literal("move"),
  /** Handles only, same reason as `edit`'s target: a position carries no
   *  generation to check the write against. */
  source: z.string().min(1),
  destination: z.string().min(1),
  action: z.enum(["insert-before", "insert-after"]),
  /** Same semantics as `edit`'s deps: premises the move's correctness rests
   *  on without the move itself touching them. */
  deps: z.array(z.string().regex(/^#/)).default([]),
});

export const TraceRequest = z.object({
  op: z.literal("trace"),
  target: z.string().min(1),
  maxUp: z.number().int().default(-1),
  /** Downward tracing branches; unlimited by default would be a foot-gun. */
  maxDown: z.number().int().default(3),
});

export const StatusRequest = z.object({ op: z.literal("status") });

export const Request = z.discriminatedUnion("op", [
  FindRequest,
  ReadRequest,
  RefsRequest,
  EditRequest,
  MoveRequest,
  TraceRequest,
  StatusRequest,
]);
export type Request = z.infer<typeof Request>;
/**
 * The shape a *client* sends: fields with defaults are optional here and
 * required on `Request`, which is the post-parse view. Typing a caller with
 * the output type forces it to spell out defaults the wire format exists to
 * supply.
 */
export type RequestInput = z.input<typeof Request>;

/**
 * Requests carry a correlation id, and responses echo it.
 *
 * Not optional: the daemon handles each request concurrently and replies when
 * it finishes, so a `read` — which needs neither the index nor a parse — will
 * routinely overtake a `refs` blocked on cold-start indexing. Matching replies
 * by arrival order would hand the read's content to whoever asked for refs.
 * Serialising per connection would fix the ordering too, but at the price of
 * one slow query blocking every fast one behind it.
 */
export const Envelope = z.object({
  id: z.number().int().nonnegative(),
  request: Request,
});
export type Envelope = z.infer<typeof Envelope>;

/**
 * The id, recovered without validating the body.
 *
 * A request that fails schema validation is still owed a reply — it has an id
 * and something is waiting on it. Validating the whole envelope at once means
 * a bad body loses the id along with it, and the caller hangs.
 */
export const Outer = z.object({
  id: z.number().int().nonnegative(),
  request: z.unknown(),
});

/**
 * `text` is rendered on the daemon side and passed through the facade
 * verbatim. Keeping rendering in one place is what stops the wire format
 * drifting from api-def.md.
 */
export const Response = z.object({
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  text: z.string(),
});
export type Response = z.infer<typeof Response>;

/** What an action returns, before the daemon attaches the correlation id. */
export type Reply = Omit<Response, "id">;

/** Read caps. See api-def.md § Actions → READ. */
export const READ_DEFAULT_AVG_BYTES_PER_LINE = 120;
/**
 * Single-line reads get a larger allowance because they are a probe, not a
 * sized request: the caller asked for one line and had no way to know it
 * would be a doozie. The discontinuity at two lines is deliberate.
 */
export const READ_SINGLE_LINE_BYTES = 1024;
