/**
 * The handle table.
 *
 * A handle is opaque by design, and that is load-bearing rather than
 * cosmetic. Because the model can only echo a token we issued, every handle
 * we receive is one we vouched for — there is no untrusted address to parse.
 * It also means the encoding stays ours to change, and the generation rides
 * along invisibly instead of becoming a parameter the model has to manage.
 *
 * Ids are never reused. A recycled id would turn a stale handle from a clean
 * miss into a confident resolution of the wrong node, which is precisely the
 * failure the generation check exists to prevent.
 */

import { HANDLE_ALPHABET } from "../shared/address.js";
import type { ByteRange, FilePath, Full, Generation, Handle } from "../shared/types.js";
import { digest, type FileRegistry } from "./files.js";

export type ResolveStatus =
  /** Bytes unchanged. May have shifted; the caller need not care. */
  | { status: "ok"; full: Full }
  /**
   * The referent still exists but its bytes differ. Reads succeed and say so;
   * writes must not, because "whatever is there now" is not what was asked for.
   */
  | { status: "changed"; full: Full }
  /** The node no longer exists. Nothing to return; the plan needs revisiting. */
  | { status: "gone"; was: Full }
  /** No such handle — dead session, or a fabricated token. */
  | { status: "unknown" };

export class HandleTable {
  private readonly entries = new Map<Handle, Full>();
  private counter = 0;

  constructor(private readonly files: FileRegistry) {}

  /**
   * Find where a referent moved to after a change we did not make.
   *
   * Our own edits carry a delta, so `rebase` shifts entries arithmetically.
   * An external write gives us no delta at all — the recorded byte range is
   * simply wrong, and reading it back yields whatever now occupies those
   * bytes. Matching on *identity* instead (same kind, same qualified name)
   * relocates the referent when it is still uniquely recognisable, and
   * declines when it is not, which is the honest answer.
   *
   * Set by whoever owns both the table and the syntax layer; the table itself
   * stays free of any parser dependency.
   */
  relocator:
    | ((entry: Full, content: Buffer) => { bytes: ByteRange; anchor: number } | null)
    | null = null;

  private mint(): Handle {
    // Monotonic, base-32, never reused for the life of the daemon.
    let n = ++this.counter;
    let out = "";
    do {
      out = HANDLE_ALPHABET[n % 32]! + out;
      n = Math.floor(n / 32);
    } while (n > 0);
    return `#${out}` as Handle;
  }

  issue(full: Omit<Full, "handle">): Full {
    const handle = this.mint();
    const entry: Full = { ...full, handle };
    this.entries.set(handle, entry);
    return entry;
  }

  peek(handle: Handle): Full | undefined {
    return this.entries.get(handle);
  }

  /**
   * Resolve against current file state.
   *
   * Note what this does and does not promise: it asserts that the *bytes* at
   * the referent are unchanged. It cannot assert that they still mean what
   * they meant — a new shadowing binding, a swapped import, or a changed
   * upstream return type all alter resolution without touching a byte here.
   * See api-def.md § Basics.
   */
  async resolve(handle: Handle): Promise<ResolveStatus> {
    const entry = this.entries.get(handle);
    if (!entry) return { status: "unknown" };

    const snap = await this.files.snapshot(entry.file);

    if (snap.generation === entry.generation) {
      return { status: "ok", full: entry };
    }

    // Generation moved. If our own edit caused it the entry was already
    // rebased, so the recorded range is current and the digest settles whether
    // the referent itself was touched.
    if (entry.bytes.end <= snap.content.length) {
      const inPlace = digest(snap.content, entry.bytes);
      if (inPlace === entry.digest) {
        const refreshed: Full = { ...entry, generation: snap.generation };
        this.entries.set(handle, refreshed);
        return { status: "ok", full: refreshed };
      }
    }

    // Otherwise the range is stale. Try to find the referent by identity.
    const moved = this.relocator?.(entry, snap.content) ?? null;
    if (moved === null) return { status: "gone", was: entry };

    const movedDigest = digest(snap.content, moved.bytes);
    const relocated: Full = {
      ...entry,
      bytes: moved.bytes,
      // The anchor must move with the referent. Spreading the old entry and
      // overriding only the range leaves it pointing into the pre-move file,
      // so the next question about this handle is asked at whatever now
      // occupies that offset.
      anchor: moved.anchor,
      lines: snap.index.linesForBytes(moved.bytes),
      generation: snap.generation,
      digest: movedDigest,
    };

    // Moved but byte-identical: the caller's premise still holds, so this is
    // not a conflict and the handle survives. Rejecting here would mean a
    // sequence of edits above a referent never converges.
    if (movedDigest === entry.digest) {
      this.entries.set(handle, relocated);
      return { status: "ok", full: relocated };
    }

    // Moved *and* altered. A read may have this, clearly marked; a write must
    // not, because "whatever is there now" is not what was asked for.
    const replacement = this.issue(stripHandle(relocated));
    return { status: "changed", full: replacement };
  }

  /**
   * Rebase every outstanding handle in `file` across an edit.
   *
   * The blast radius of an edit is the edited range, not the file: handles
   * wholly before it are untouched, handles wholly after shift by the delta,
   * and only handles that *overlap* the edit die. This is what lets a
   * sequence of single edits work without re-querying between them — and it
   * is why batching edits buys much less than it first appears to.
   */
  rebase(file: FilePath, edited: ByteRange, newLength: number, generation: Generation): {
    shifted: Handle[];
    killed: Handle[];
  } {
    const delta = newLength - (edited.end - edited.start);
    const shifted: Handle[] = [];
    const killed: Handle[] = [];

    for (const [handle, entry] of this.entries) {
      if (entry.file !== file) continue;

      if (entry.bytes.end <= edited.start) {
        this.entries.set(handle, { ...entry, generation });
        continue;
      }
      if (entry.bytes.start >= edited.end) {
        this.entries.set(handle, {
          ...entry,
          generation,
          bytes: { start: entry.bytes.start + delta, end: entry.bytes.end + delta },
          // The anchor lives inside the range and shifts with it. Leaving it
          // behind points the next question at whatever now occupies that
          // offset, which is the same class of silent misresolution the
          // generation check exists to prevent.
          anchor: entry.anchor + delta,
        });
        shifted.push(handle);
        continue;
      }
      this.entries.delete(handle);
      killed.push(handle);
    }

    return { shifted, killed };
  }
}

function stripHandle(full: Full): Omit<Full, "handle"> {
  const { handle: _drop, ...rest } = full;
  return rest;
}
