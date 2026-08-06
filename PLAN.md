# Build plan

Milestones are mostly a hard chain, because each one makes the next testable.
The ordering principle: prefer the step that retires the most *unexercised*
code, not the one that adds the most surface.

Contract lives in [api-def.md](api-def.md). Where this plan and that document
disagree, that document wins — and the disagreement is a bug in one of them.

## Status

| | |
|---|---|
| ✅ | Daemon lifecycle, unix socket, correlated request/response |
| ✅ | rust-analyzer client: spawn, initialize, readiness, shutdown |
| ✅ | File registry: canonical paths, lazy staleness, generations, line index |
| ✅ | Address parsing, response rendering |
| ✅ | `read` (handle and position), density guard, single-line floor |
| ✅ | **M1** syntax layer — offset conversion, ast-grep binding |
| 🚧 | **M2** `refs` — first verb that mints handles |
| ⬜ | **M3** handle lifecycle under mutation |
| ⬜ | **M4** `edit` |
| ⬜ | **M5** `find` |
| ⬜ | **M6** `trace` |
| ⬜ | **M7** use it against a real workload and measure |

Never yet exercised: **every handle**. No verb mints one, so digests, rebasing,
`changed:` and `gone` are all untested code. M2 and M3 exist to fix that before
anything is built on top of them.

## M1 — syntax layer

Deliver `parse`, `nodeAt`, `ancestors`, `enclosingItem`, and the offset
converter they depend on.

- [x] utf16 ↔ utf8 offset conversion, with an ASCII fast path
- [x] ast-grep binding: descent-based `nodeAt`, ancestor chain, item lookup
- [x] `enclosingItem` extends backward over doc comments and attributes
- [x] `registerDynamicLanguage` called exactly once, at daemon startup

**Done.** 12 tests pass, and every sampled offset in `tauroid/src/main.rs` and
`crates/pixel/src/lib.rs` slices back to exactly its own node text — the
invariant the offset layer exists to hold.

**Verified by:** parsing `tauroid/src/main.rs` and `crates/pixel/src/lib.rs`,
asserting known offsets resolve to the right kinds and byte ranges — including
a case with non-ASCII, since that is where the conversion earns its keep.

## M2 — `refs`

First verb to mint handles. Two tasks live here that the stub does not mention:

- **Position encoding.** The LSP client negotiates utf-8 but nothing converts,
  and rust-analyzer may answer in utf-16. Same converter as M1.
- **`didChangeWatched`.** The moment `refs` is real, rust-analyzer's snapshot
  can drift from ours. The TODO in `files.ts` becomes load-bearing.

**Verified by:** `refs` on a real tauroid symbol returning hits grouped by file
and enclosing item, then `read <handle>` returning exactly that node's bytes.

## M3 — handle lifecycle

No new features. Mint a handle, then mutate the file three ways and assert the
outcome: insert above it (→ `ok`, rebased), change it (→ `changed:`), delete it
(→ `gone`). Retires the largest block of untested code in the project.

## M4 — `edit`

Validate-then-apply in four phases, dep digests, indentation derived from the
surrounding buffer, parse-validation before commit, temp-file-and-rename.

**Verified by:** an edit that shifts other outstanding handles, asserting they
rebase rather than die; and a rejection where a dep changed underneath.

## M5 — `find`

Shape dispatch on the needle, ast-grep patterns, hierarchy-grouped hits. Hit
handles point at the *matched token*, not the enclosing line — that is what
makes a follow-up `refs` exact rather than ambiguous.

## M6 — `trace`

Breadth-first with a visited set keyed by (file, byte range). Every terminated
branch carries a stop reason.

**Verified by:** tracing a real value in tauroid and confirming terminated
branches report `macro` / `non-ident-arg` / `depth` rather than simply ending.

## M7 — use it

Wire into an MCP client and do real work against tauroid. The token-efficiency
premise is the entire point of the project and is so far entirely untested.

## Verified findings

Things established by experiment, recorded so they are not rediscovered the
hard way.

**ast-grep offsets are UTF-16 code units — its own types say "byte offset".**
Confirmed with `é`/`ü` (index matched the JS char index, not the byte offset)
and again with `🦀` to separate UTF-16 from codepoints. Slicing a UTF-8 buffer
with a raw ast-grep range returns text shifted by the byte/unit difference:
plausible-looking and wrong. LSP's default is also UTF-16, so one converter
serves both boundaries.

**Readiness signals are opt-in.** `$/progress` requires
`window.workDoneProgress`; the status extension requires
`experimental.serverStatusNotification`. Without them rust-analyzer indexes
happily while the client sits at `starting` forever.

**The status notification is `experimental/serverStatus`**, not
`rust-analyzer/serverStatus`. Set `FLUENT_LSP_TRACE=1` to log every
notification method once — that is how this was settled.

**Only `quiescent` means ready.** A server emits several progress sequences
(metadata, proc macros, indexing), so the first `end` is not completion.

**`@ast-grep/napi` bundles only HTML, JS, TSX, CSS, TypeScript.** Rust arrives
via `@ast-grep/lang-rust` and `registerDynamicLanguage`, which is
`@experimental` and must be called exactly once per process. Prebuilt dylibs
ship for macOS/Linux/Windows, so there is still no compilation at install.

**Unix socket paths cap near 104 bytes** (`sun_path`). Exceeding it does not
reliably raise — the daemon can listen successfully and be unreachable.
