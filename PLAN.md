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
| ✅ | **M2** `refs` — first verb that mints handles |
| 🚧 | **M3** handle lifecycle under mutation |
| ⬜ | **M4** `edit` |
| ⬜ | **M5** `find` |
| ⬜ | **M6** `trace` |
| ⬜ | **M7** use it against a real workload and measure |

Handles are minted by `refs` as of M2. Still unexercised: **rebasing**, and the
`changed:` / `gone` resolution paths — nothing mutates a file yet, which is
what M3 is for.

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

- [x] byte ↔ LSP position conversion, both encodings
- [x] address resolution: handle, position, ambiguity → candidates
- [x] `didChangeWatched` wired via a registry change callback
- [ ] symbolic addresses (`Widget::count`) — needs `workspace/symbol`

**Done** for handle and position addresses. Against tauroid, `refs` on
`rgba_to_zrgb` found three references across two files including a cross-crate
one through `pixel::`, which is real name resolution rather than text matching;
`read` on a hierarchy handle returned the enclosing test function with its
`#[test]` attribute attached.

Note the first handles now exist, so M3 is finally reachable.

## M3 — handle lifecycle

No new features. Mint a handle, then mutate the file three ways and assert the
outcome: insert above it (→ `ok`, rebased), change it (→ `changed:`), delete it
(→ `gone`). Retires the largest block of untested code in the project.

## M4 — `edit`

Validate-then-apply in four phases, dep digests, indentation derived from the
surrounding buffer, parse-validation before commit, temp-file-and-rename.

Revalidation is phase 1: reread and hash every target *and* dependency
immediately before commit, never against a snapshot taken earlier. Where a
referent has moved but is uniquely relocatable, issue a replacement handle and
proceed; otherwise fail exactly as an expired handle would. That relocation
path is the `TODO(relocate)` already sitting in `handles.ts`.

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

**Take a baseline right after M3, not here.** Measuring tool calls, bytes
returned, successful target selection and retry frequency once `refs`/`read`
work gives a number to compare against later. Left until M7, there is nothing
to compare the finished tool *to*, and the headline claim stays an assertion.

## Testing

Two tiers, because one slow suite is a suite that stops being run.

| | | |
|---|---|---|
| `npm test` | unit | hermetic, ~400ms, needs nothing installed |
| `npm run test:lsp` | integration | needs rust-analyzer on PATH; skips with a message if absent |
| `npm run test:all` | both | |

Integration tests run against `fixtures/rust-workspace`, and **every run copies
it to a tmpdir first**. Mutation is the whole point from M3 onward, and
mutating the committed fixture in place would make runs non-repeatable, leave
`git status` dirty, and break any two runs that overlap.

The fixture is dependency-free on purpose — index time is dominated by
dependencies, not by our own source, so a single `[dependencies]` entry would
slow every LSP test. The suite currently completes in about two seconds
including a cold index.

Its oddities are load-bearing and each carries a comment naming the behaviour
it covers: same-scope rebinding for the byte-vs-semantic gap, `é` and `🦀` for
offset conversion, doc comments and `#[inline]` for `itemRangeWithDocs`,
`if`-in-`for`-in-`fn` for ancestor chains, a macro and a non-identifier
argument for M6's stop reasons, a 4000-byte line for the density guard, and a
`.md`/`.toml` pair for the no-grammar path. Tidying any of them away silently
removes a test.

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

**The workspace root must be canonicalised before rust-analyzer sees it.**
The registry realpaths every file, so a root still containing a symlink
(`/tmp`, or any `mkdtemp` path on darwin) makes the two halves disagree about
the same file: we ask about `/private/var/...` while it indexed `/var/...`, and
it answers `file not found` for a file plainly on disk.

**Unix socket paths cap near 104 bytes** (`sun_path`). Exceeding it does not
reliably raise — the daemon can listen successfully and be unreachable.
