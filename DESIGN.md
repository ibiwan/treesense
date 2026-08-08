# Design notes

Code comments explain a decision *at its site*. This file holds the invariants
that span sites — the ones no single file can own, and that break quietly when
one participant forgets its part.

Everything here is load-bearing. If something is merely a local reason, it
belongs in a comment next to the line, not here.

---

## 1. Three units, and two of them lie

Offsets appear in three incompatible units:

| Unit | Where |
|---|---|
| **UTF-8 bytes** | our canonical form: `Full.bytes`, digests, all slicing |
| **UTF-16 code units** | LSP positions (default), ast-grep `Pos.index` |
| **Lines** | everything the model sees |

Both non-canonical sources *claim* otherwise. ast-grep's type definition
documents `Pos.index` as "byte offset of the position" and it is not — verified
with `é`/`ü`, then with `🦀` to rule out codepoints. LSP is honest but its
default is UTF-16, and the utf-8 negotiation may be declined.

**The rule: convert at the boundary, never in the middle.** A byte offset that
originated as UTF-16 and was not converted is indistinguishable from a correct
one until a file contains non-ASCII — at which point it is wrong by a few
characters, still resolves to *something*, and reads plausibly.

Participants: `syntax.ts` converts on the way out of ast-grep; `lsp.ts` converts
on the way in and out of rust-analyzer; `address.ts` and `render.ts` deal only
in lines and never see either.

Every offset test needs a non-ASCII case. A test suite that is pure ASCII
cannot fail on any of this.

---

## 2. One file, one name

Canonical path (realpath'd, absolute) is the key for generations, the handle
table, and staleness. Two spellings of one file — a symlink, a relative path,
`/tmp` versus `/private/tmp`, a case difference on APFS — split the map in two,
and every guarantee built on generations quietly stops holding for that file.

So: **canonicalise on ingest, never later.** `FileRegistry.canonical()` is the
only door. Relative paths resolve against the *workspace root*, never
`process.cwd()` — the daemon is long-lived and may have been started anywhere,
so its cwd means nothing to a client that says `src/main.rs`.

Responses echo the canonical path, not the caller's spelling, so a file cannot
appear under two names across two answers.

`lsp.ts` additionally converts to and from `file://` URIs. That is a fourth
spelling; it stays inside `lsp.ts`.

---

## 3. Generations: who bumps, who checks

A generation is optimistic concurrency control. We cannot lock the working tree
— editors, git, build scripts and other agents all write it — so instead every
read is stamped and the stamp is checked when we act.

**Bump only on confirmed content change.** Not on access. Not on a stat. Not on
an mtime that moved while the bytes did not (`touch`, a checkout of identical
content) — `FileRegistry.snapshot` compares contents before bumping, precisely
because a spurious bump invalidates every outstanding handle for nothing.

Failing to bump is the opposite failure and is worse: the scheme silently stops
protecting anything while continuing to look like it works. This is why the
lazy stat-on-read path matters — it is what makes the generation trustworthy.

The workspace generation is a separate counter for *multi-file* results. Twelve
individually-valid reads are not a coherent snapshot; capture it on entry to a
collection and re-check on exit. `trace` is the case that needs it most, because
its conclusion depends on every link holding simultaneously.

**Witness what you validated, never what you can read again.** `snapshot()` is
read-through and stats on every call, so two reads of one file are two separate
looks at disk with a window between them. A write that lands in that window is
absorbed into the second look — so a witness taken by re-reading agrees with
itself at commit time and waves through bytes spliced from the *first* buffer.
Every participant already carries the generation it was validated or read at
(`Full.generation` from `resolve`, `FileSnapshot.generation` from `locate`);
witnessing that number makes the window zero-width by construction rather than
narrow, and narrow windows are the ones that only ever fail in production. When
two participants disagree about one file, the lower stamp wins: disagreement
means the file moved between their validations, and the earlier stamp is the
one that makes the recheck say so.

---

## 4. What a handle promises — and what it does not

A handle asserts **byte identity**: these bytes are unchanged. It cannot assert
**semantic identity**: that they still mean what they meant.

```rust
fn f() {
    let x = 1;
                          // ← insert `let x = compute();`
    foo(x);               // handle here: bytes untouched, rebases cleanly,
}                         //   and now binds to a different variable
```

The same gap opens on a swapped `use`, a changed upstream return type, or a new
trait impl shifting method resolution — none of which touch a byte near the
handle. Rust and the ML family make the local case easy because same-scope
rebinding is idiomatic; most languages need a nested block, which would disturb
the bytes. The cross-file cases are language-independent and no byte-level
scheme catches them.

Positional recovery, by contrast, *is* handled — in two different ways
depending on who moved the bytes. Our own edits carry a delta, so `rebase`
shifts entries arithmetically. An external change gives no delta at all, so the
referent is found again by **identity**: same kind, same qualified name, and
only when the match is unique. Locals correctly fall through to `gone` — they
have no qualified name, and three `x`s in a function are distinguishable only
by position, which is exactly what was lost.

Whichever path runs, the **anchor moves with the range**. It is the offset
questions are posed at, it lives inside the range, and leaving it behind aims
the next question at whatever now occupies that byte.

The semantic gap above is an accepted limitation, not an oversight: the
compiler is the backstop, and paying an index round trip per handle to catch
what `cargo check` catches would be a bad trade. What follows from it:

- `edit` guards **textual** premises. Semantic premises are the caller's to
  declare, via deps — and even deps only catch *modification* of nodes named,
  not the *introduction* of a new binding that shadows one.
- **Never cache a `refs` result and edit from it.** References are a semantic
  claim; re-run against current state.
- The overview must not imply more than this. See `api-def.md` § Basics.

---

## 5. Reads never block; questions do

`read` needs file bytes and, for a position, nothing else. It touches neither
rust-analyzer nor a parse. So the agent can work seconds after daemon start
while the index is still building.

`refs` and `trace` need name resolution and therefore wait on `whenReady()`.

This split is why readiness must be *real*. Both signals are opt-in and a server
sends neither to a client that did not ask (`window.workDoneProgress`,
`experimental.serverStatusNotification`), and only `quiescent` means ready — a
server emits several progress sequences, so the first `end` is not completion.
Get either wrong and `whenReady()` never resolves: `read` keeps working, so the
daemon looks healthy, while every semantic query hangs forever.

---

## 6. Two processes, and which one may hold state

MCP stdio servers are spawned by the host and die with the client session. A
rust-analyzer held inside one would re-index on every editor restart, and two
clients would mean two indexes — the entire cost the warm daemon exists to
avoid.

So the facade is stateless and the daemon owns everything with a lifetime:
handles, generations, the index. The consequence worth stating plainly is that
**handles die when the daemon dies, not when a client disconnects** — and a
dropped connection must fail outstanding requests loudly, because every handle
the caller holds is now void rather than merely stale.

Corollary: nothing in `src/mcp/` may import from `src/daemon/index.ts`, which
runs `main()` on load. Shared helpers go in `src/shared/`.

---

## 7. Why responses look like that

The tool exists to save tokens, so the response format is part of the design
rather than presentation.

- **Round trips cost more than bytes.** Spending twenty tokens to eliminate a
  call is almost always right, which is why `find`/`refs` front-load hierarchy
  and sizes: the model should never need a second call to decide what to read.
- **Newlines are the only expensive whitespace.** Single ASCII spaces separate
  fields; no blank lines, no rules, no alignment padding. Unicode separators
  tokenize worse than ASCII for no gain.
- **A path owns its line**, so a filename containing spaces needs no quoting.
- **Free text goes last on its line**, so a code snippet may contain anything
  without being mistaken for structure.
- **No spatial inference.** Hierarchy is a `>` chain, not indentation: reading
  relative nesting is fine, counting depth is not.
- **Tool descriptions are a permanent tax** — they sit in context on every
  request, used or not. Six verbs, terse schemas, no `mode` or `scope` knobs.

Sizes are reported only when *surprising* (denser than ~80 bytes/line). On
ordinary code the line count conveys magnitude already, so the field's presence
is itself the signal that line count cannot be trusted here.

---

## 8. Failure shapes

Two rules that decide most error-handling questions:

**Reads may auto-recover; writes never may.** Resolving a stale handle to
current content costs a label on a read. Doing the same on an edit is a silent
clobber — "whatever is there now" is not what was asked for.

**Retry through a race; refuse a conflict.** These look similar and are not.
A language server answering `ContentModified` has not disagreed with us — its
state was moving while it answered, and the same request succeeds moments
later, so retrying is correct. A stale handle *is* a disagreement and must
never be retried into. Any external write opens the first kind of window,
because we announce the change and then immediately ask about it.

**Refuse rather than truncate.** Half a function usually still parses, so
truncated source invites confident reasoning about code that does not exist —
the caller never sees the early return twenty lines further down. An error
carrying the size is one extra round trip and zero wrong conclusions.

And a corollary that catches a whole class: **a terminated branch must never be
indistinguishable from a completed one.** A `trace` that stopped at a macro and
a `trace` that genuinely ended both look like short trees. Hence stop reasons on
every terminus, `ambiguous` as an explicit first line, and `changed:` as a
marker rather than something inferred from a differing handle.
