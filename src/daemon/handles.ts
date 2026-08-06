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

    // Generation moved. If it moved because of our own edit the entry was
    // already rebased, so its range is current; verifying the digest tells us
    // whether the referent itself was touched.
    if (entry.bytes.end > snap.content.length) {
      return { status: "gone", was: entry };
    }

    const current = digest(snap.content, entry.bytes);
    if (current === entry.digest) {
      const refreshed: Full = { ...entry, generation: snap.generation };
      this.entries.set(handle, refreshed);
      return { status: "ok", full: refreshed };
    }

    // TODO(relocate): an external write we did not observe leaves us unable to
    // compute a delta. For now the referent is reported as changed at its
    // recorded range; re-deriving it from `symbol`/`kind` via the syntax layer
    // would let us hand back an accurate replacement handle instead.
    const moved: Full = {
      ...entry,
      generation: snap.generation,
      digest: current,
      lines: snap.index.linesForBytes(entry.bytes),
    };
    const replacement = this.issue(stripHandle(moved));
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
