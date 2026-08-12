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
| ✅ | **M3** handle lifecycle under mutation |
| ✅ | **M4** `edit` |
| ✅ | **M5** `find` |
| ✅ | **M6** `trace` |
| 🚧 | **M7** use it against a real workload and measure |
| ✅ | `move` — relocate a handle's bytes before/after another handle, same-file or cross-file (added post-M6, see REVIEW_NOTES.md) |
| ✅ | Language-profile seam — `LspClient` interface, `RustAnalyzer` extracted behind `createRustProfile()` (see below) |
| ✅ | TypeScript profile — `TypeScriptServer implements LspClient`, `createTypeScriptProfile()` (see below) |

All six verbs are implemented and exercised. A first qualitative Tauroid run
confirmed the navigation workflow is less noisy than `grep` plus `cat`; M7
still needs a measured comparison of tool calls, bytes returned, successful
target selection and retries before the token-efficiency premise is a claim
rather than an observation.

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
- [x] symbolic addresses (`Widget::count`) — resolved through `workspace/symbol`

**Done** for handle and position addresses. Against tauroid, `refs` on
`rgba_to_zrgb` found three references across two files including a cross-crate
one through `pixel::`, which is real name resolution rather than text matching;
`read` on a hierarchy handle returned the enclosing test function with its
`#[test]` attribute attached.

Note the first handles now exist, so M3 is finally reachable.

## M3 — handle lifecycle

**Done.** Six cases, all mutating the disposable copy: unchanged, moved,
altered, deleted, rewritten-identically, and unknown.

It needed one feature after all. `rebase` only runs from our own edits, which
carry a delta; an *external* change gives none, so a moved referent was read
back at a stale byte range. Relocation by identity fills that in — same kind,
same qualified name, and only when the match is unique. Locals correctly fall
through to `gone`: they have no qualified name, and three `x`s in a function
are distinguishable only by position, which is exactly what was lost.

Handles are minted by `refs` as of M2, and exercised under mutation as of M3.

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

**Done.** Shape dispatch on the needle, ast-grep patterns, hierarchy-grouped
hits, and scoping by file, line range or handle.

The pattern engine earns its place immediately: `scale($A, $B)` matches
`scale(raw, 3)` and `scale(seed + 1, step)` together — no literal or simple
regex does — while correctly *not* matching `pub fn scale(value: u32, …)`,
because a signature is not a call.

## M6 — `trace`

Breadth-first with a visited set keyed by (file, byte range). Every terminated
branch carries a stop reason.

**Done**, naive as designed. Against the fixture, tracing `scaled` down finds
the `macro` stop at `println!`, the `non-ident-arg` stop at
`scale(seed + 1, step)`, and a genuine cross-crate hop into `helper`'s `value`
parameter — every feature the fixture was built to exercise.

## M7 — use it

Wire into an MCP client and do real work against tauroid. The token-efficiency
premise is the entire point of the project and is so far entirely untested.

**Take a baseline right after M3, not here.** Measuring tool calls, bytes
returned, successful target selection and retry frequency once `refs`/`read`
work gives a number to compare against later. Left until M7, there is nothing
to compare the finished tool *to*, and the headline claim stays an assertion.

## Language profile — TypeScript

The daemon supported exactly one target language, hardcoded, until this
milestone. Two things had to happen before a second language was even a
question worth answering: separate the shared engine from the Rust-specific
half, and find out what the LSP side of "TypeScript" actually requires. Both
are done; a working TypeScript `LanguageProfile` is not.

**The seam.** `src/daemon/lsp-client.ts` holds the `LspClient` interface
(`start`/`stop`/`whenReady`/`references`/`definition`/`workspaceSymbols`/
`didChangeWatched`) plus the language-agnostic bits — `Readiness`,
`IndexStatus`, `WorkspaceSymbol`, `pathToUri`/`uriToPath`. `src/daemon/
language-profile.ts` holds the one-method `LanguageProfile` interface
(`createClient(root) => LspClient`). `src/daemon/languages/rust.ts` is the old
`lsp.ts` moved verbatim behind `createRustProfile()` — unchanged behavior,
same 17 unit + 73 integration tests green. `Workspace` now takes a
`LanguageProfile` instead of constructing `RustAnalyzer` directly; `index.ts`
is the only place that currently picks `createRustProfile()`, which is where
language detection or an explicit override belongs later.

**Why a TypeScript profile isn't just a second config object.** Investigated
empirically the way rust-analyzer's readiness was originally pinned down —
spawn the server, log every notification, and test what queries actually
return before and after each candidate signal, first against a 2-file toy
project and then against a real ~4500-file TypeScript project (Appsmith's
`app/client`, cloned shallow/sparse for this purpose) to catch anything that
only shows up at scale. It did: see Verified findings. Short version:
rust-analyzer indexes proactively from disk with no "open" step, so
`LspClient` has no file-lifecycle concept and doesn't need one.
`typescript-language-server` requires the *query's own* file to be opened via
`textDocument/didOpen` first (an unopened query target returns `[]`, not an
error), and — once corrected for a routing bug below — does **not** require
every file in the project to be opened; it searches the whole configured
project regardless of open state, much closer to rust-analyzer's model than
first measurements suggested. A working TS client still needs a minimal
open/close lifecycle (open a file before asking about a position in it) and
must mirror writes through `textDocument/didChange` once a file is open,
since `didChangeWatchedFiles` alone does not invalidate it — new surface on
`LspClient`, but far smaller than "open everything."

**The routing bug that produced the wrong first conclusion.**
`typescript-language-server` runs a syntax/semantic tsserver pair (partial
semantic mode: a fast syntax-only server plus a real semantic one) and races
them — cheap requests can be answered by the syntax server before the
semantic server has finished loading the real project. The syntax server's
project is a throwaway single-file `Inferred` project rooted at `/dev/null`,
confirmed directly from tsserver's own log (`.log/tsserver-log-*/tsserver.log`
under the workspace root): `Finding references to ... in project
/dev/null/inferredProject1*`. Its answer is a well-formed, empty
`references` response — nothing marks it as coming from the wrong server. On
the 2-file toy project the semantic server always won the race (project load
near-instant), which is why the first pass concluded incorrectly that every
file needed opening. Setting `initializationOptions.tsserver.useSyntaxServer:
"never"` forces every request through the real semantic server; with that set
and only the *declaration's own file* ever opened, `references` on Appsmith's
`useFeatureFlag` (83 real call sites per `grep`) correctly returned 178 hits
across 81 files, none of which were ever `didOpen`'d.

**Built:** `src/daemon/languages/typescript.ts` — `TypeScriptServer implements
LspClient` (`useSyntaxServer: "never"`, open-on-demand for query targets, a
one-file bootstrap so `workspace/symbol` works before any specific file is
touched, `didChange` only for files it opened itself) and
`createTypeScriptProfile()`. Not yet wired into `index.ts`'s profile
selection — that still needs the auto-detect-or-override decision noted
above.

**Bug found and fixed via real integration testing, not the raw-protocol
probes:** declaring `window.workDoneProgress: true` in client capabilities
without handling the server's resulting `window/workDoneProgress/create`
request crashed the entire `typescript-language-server` process outright
(unhandled promise rejection inside the server, not a graceful error back to
the client) — surfaced by driving the real `Workspace` + `actions/refs.ts`
against a live daemon, which none of the earlier raw-JSON-RPC probes would
have caught since every probe script happened to register a handler for it
by habit. Fixed by not declaring that capability (nothing here needs it —
see the readiness findings above) plus a defensive blanket `onRequest(() =>
null)` so an unhandled server request can never take the process down again.

**A second bug, this one in shared code:** `refs` on a bare exported
symbol — `export function foo()`, the overwhelmingly common shape in any
real TypeScript file — failed with `symbol foo not found` even though
`workspaceSymbols` itself returned the right location. Root cause: TS/JS
wraps a declaration in an `export_statement` node whose own span starts at
the `export` keyword, before the wrapped declaration's range begins.
`workspace/symbol`'s returned position sits at the very start of that span,
so `nodeAt` resolves to the `export_statement` wrapper — correctly, it *is*
the smallest named node containing that byte — but the wrapper has no
item-kind ancestors (climbing up finds nothing) and isn't an item itself, so
`enclosingItem` returned null even though the real `function_declaration`
was sitting one level down as its child. Rust has no such wrapper — a
visibility modifier is a child token of the item itself, never a separate
enclosing node — so no Rust test could have caught this. Fixed in
`syntax.ts`'s `enclosingItem`: when climbing ancestors finds nothing, check
the node's own direct children for an item-kind one before giving up. Added
`enclosingItem sees through an export_statement wrapper` to
`syntax.test.ts`; full suite (18 unit + 73 integration) still green
afterward.

**First bootstrapping case: treesense's TypeScript profile used against
treesense's own source.** `overview`, `find`, `refs` (symbolic, cross-file —
`Workspace` resolved usages grouped correctly across `locate.ts`, `deps.ts`,
`actions/edit.ts`, `actions/find.ts` and more) and `read` all worked
end-to-end through the real daemon code path, not a scratch probe. One
cosmetic gap surfaced here, not a correctness bug: hierarchy lines through an
unmapped raw kind (e.g. a constructor parameter position) render as the
generic `expr` fallback rather than something like `param` — `KIND_MAP.
typescript` in `syntax.ts` is not yet as complete as `KIND_MAP.rust`.

**A third bug, same root cause as the `export_statement` one, in a different
place: `trace.ts` hardcoded the raw grammar kind of a parameter list as
`"parameters"`, which is tree-sitter-rust's name for it — tree-sitter-
typescript (and JS/TSX) calls it `formal_parameters`.** Silent, not a thrown
error: tracing a value down across a call boundary just stopped with
`unresolved`, indistinguishable from a real dead end, at exactly the point
that needed to look up the callee's parameter list. Found via a real
`trace` integration test, not a raw probe. Fixed by extracting a
`PARAMETERS_KIND` per-language table and a `parametersOf(lang, fn)` helper in
`syntax.ts`, following the same shape as `KIND_MAP`/`PEEL`, and updating both
call sites in `trace.ts` (`parameterSlot`, `parameterFor`) to use it instead
of the hardcoded string.

**A fourth: `itemRangeWithDocs` excluded the `export` keyword entirely from
an exported TS declaration's own range, not just its doc comment.** Bigger
than a JSDoc-attachment gap — `mint()` uses this range for every item-kind
handle, so `edit`/`move` on any exported TS symbol would have left a
dangling `export` keyword behind as an orphan token, a real corruption risk,
not just a cosmetic one. Same root cause as the `enclosingItem` fix: the
wrapped declaration's own byte range starts at `function`/`class`/etc, after
the wrapper's `export`/`export default` prefix, and the doc-comment backward
walk (`sg.prev()`) found nothing to walk from, since the declaration has no
siblings of its own inside the wrapper. Fixed by anchoring both the range's
start and the backward doc walk on the wrapper node when the item is a lone
child of a non-item parent, falling back to the item's own node otherwise
(so Rust, which has no such wrapper, is unaffected — confirmed by the full
suite staying green).

**Built out the durable test coverage this all depended on `PLAN.md` prose
and scratch scripts for until now.** `fixtures/typescript-project` (mirrors
`fixtures/rust-workspace`'s role — dependency-free, tests point
`tsserverPath` at the repo's own `typescript` devDependency instead of
requiring a fixture-local install) plus `src/integration/typescript.test.ts`
(12 tests covering symbolic refs through the `export_statement` fix,
cross-file resolution, JSDoc attachment, the `non-ident-arg`/cross-boundary
trace cases that caught the `formal_parameters` bug, and declaration merging
as a genuine relocator-ambiguity case). `testkit/index.ts` gained
`skipReasonTs()`/`hasTypeScriptLanguageServer()` mirroring the Rust pair
exactly, and `startFixture()` took an options parameter (`fixture`, `lang`)
so both profiles share one harness; `startTypeScriptFixture()` is the
convenience wrapper. `index.ts` reads `FLUENT_LANG=typescript` (plus
`FLUENT_TS_COMMAND`/`FLUENT_TS_TSSERVER_PATH`) to select the profile — an
explicit override for tests to use, not the detection feature itself, which
is still future work. Full suite: 18 unit + 85 integration (73 Rust + 12
TypeScript), all green; the TypeScript suite skips cleanly with a message
when `typescript-language-server` isn't on PATH, same as Rust's.

**Closed the `edit`/`move`/handle-lifecycle coverage gap.** Three new files —
`edit-typescript.test.ts` (11 tests), `move-typescript.test.ts` (10 tests),
`handles-typescript.test.ts` (7 tests) — mirror the Rust suites' cases
against `fixtures/typescript-project` rather than relying on the mechanism
being language-independent (edit.ts/move.ts never touch the LSP client, only
`syntax.ts`/`locate.ts`, so this was a real gap, not a redundant one). Two
things surfaced that the Rust mirror alone couldn't have:
- `itemRangeWithDocs`'s comment-attachment walk glues an unrelated leading
  comment onto a JSDoc block when there's no blank line to stop at — visible
  on `scale` specifically because its JSDoc opens the file with nothing above
  it, unlike the Rust fixture's `scale`, which has a blank-line-separated
  module header acting as a moat. Not a bug (the same rule is what makes a
  real doc comment stick to its item), just a fixture-shape difference the
  Rust test happened not to exercise — worth remembering if a future TS
  fixture puts a declaration at the very top of a file.
- The open-doc/`didChange` sync path (typescript.ts's central concern) now
  has a real regression test in each of the two files: open a file via a
  query, mutate it through our own `edit`/`move` verb, then issue a fresh
  LSP-backed query and confirm it reflects the change rather than tsserver's
  stale pre-edit buffer. `edit`/`move` themselves never touch the LSP client
  — this is the only place that dropped `didChangeWatched` call would have
  surfaced, and nothing exercised it before.

Full suite is now 18 unit + 113 integration (73 Rust + 40 TypeScript).

**Closed the reachability gap.** `detect-language.ts` picks a profile from
the workspace root's own manifests — `Cargo.toml` for Rust, `tsconfig.json`
or bare `package.json` for TypeScript (JS projects routinely have no
`tsconfig.json`, and the TS client already speaks JS/JSX) — checked at the
root only, no walking up to an ancestor manifest. `index.ts`'s `main()` now
calls it whenever `FLUENT_LANG` is unset; a root with both manifests picks
Rust, a root with neither falls back to Rust with a note on stderr rather
than refusing to start, and an unrecognized `FLUENT_LANG` value is reported
and ignored rather than silently swallowed the way it was before (previously
anything other than the literal string `"typescript"` fell through to Rust
with no signal at all). 6 new unit tests in `detect-language.test.ts`, plus a
manual smoke test of all three branches (`rust-workspace`, `typescript-
project`, and an empty directory) against the built daemon binary. `README.md`
gained a "Language profiles" section covering detection, the `FLUENT_LANG`
override, and `FLUENT_TS_COMMAND`/`FLUENT_TS_TSSERVER_PATH`.

**Left undone.** In rough priority order:

- **Overload signatures aren't recognized as items at all** — only the
  implementation is (`tree.items()` skips signature-only overload
  declarations entirely). Found while building the fixture; not
  investigated further. Could matter on real overload-heavy code.
- **`KIND_MAP.typescript` is incomplete.** Unmapped raw kinds (e.g. a
  parameter position) render as the generic `expr` fallback instead of
  something like `param`. Cosmetic, not correctness — surfaced during the
  dogfood run against treesense's own source.
- **`qualifiedName`'s `::` join is still Rust-flavored** for TS symbolic
  addresses. Works (tests pass), just not idiomatic — `Foo::bar` instead of
  `Foo.bar`.
- **No init-work/bundling for `typescript-language-server`** — deferred on
  purpose (see above); the user provisions it themselves, mirroring
  `rust-analyzer`. A possible future enhancement, not a gap to close by
  default.
- **No `vtsls`/raw-tsserver-protocol comparison** — deprioritized on purpose
  once `useSyntaxServer: "never"` solved what it would have investigated.

None of these block real usage — they're cosmetic, deliberately deferred, or
scoped-out comparisons, not gaps in what ships today.

## Testing

Two tiers, because one slow suite is a suite that stops being run.

| | | |
|---|---|---|
| `npm test` | unit | hermetic, ~400ms, needs nothing installed |
| `npm run test:lsp` | integration | needs rust-analyzer and/or typescript-language-server on PATH; each half skips with a message if its server is absent |
| `npm run test:all` | both | |

Integration tests run against `fixtures/rust-workspace` and
`fixtures/typescript-project`, and **every run copies its fixture to a tmpdir
first**. Mutation is the whole point from M3 onward, and mutating a committed
fixture in place would make runs non-repeatable, leave `git status` dirty,
and break any two runs that overlap.

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

**`line_comment` nodes absorb their trailing newline; `attribute_item` does
not.** So a blank line between a module header and a doc comment appears as a
single newline in the gap, and any "at most one newline" contiguity rule reads
a detached header as attached — making every item handle in a documented file
span the top of the file. Compare against whether the previous node's own range
already ends in a newline.

**A cap enforced in one branch is not a cap.** `find` bounded hits in the
parsed path and not in the grammarless one, so a text file with 500 matches
reported an uncapped count with no marker. Sibling code paths need the same
budget, and the same applies to `trace`: returning quietly at its site limit
let a truncated walk read as a complete one — the exact failure its stop
reasons exist to prevent, arriving through the back door.

**Bounding results does not bound the response.** Sixty hits on a minified
line is a quarter-megabyte of snippets. Caps on count and on excerpt length are
different limits and both are needed.

**A malformed structural pattern does not throw.** ast-grep builds a pattern
containing ERROR nodes and matches nothing, which is indistinguishable from a
genuine empty result — fatal when zero matches is meaningful. Validate by
substituting metavariables (`$A` is not valid source; `$$$` drops out) and
parsing the probe.

**First sight of a file is not a change.** The workspace generation bumped on
every initial snapshot, so any multi-file collection declared itself stale
purely for having read more than one file — the coherence signal fired on
success. Count a change only when a *tracked* file's content moves.

**Validate-then-write is not enough on its own; the window has to be closed
at both ends.** Validating against one snapshot and splicing against another
lets a write land on bytes nobody checked — and `handles.resolve()` takes its
own snapshot internally, so the two can diverge even with no external writer.
Witness every participating file's generation at validation time and re-check
it immediately before the rename. The residual stat-to-rename window cannot be
closed: POSIX has no compare-and-swap rename.

**A witness that re-reads is not a witness.** The corollary, and it survived
two rounds of review because it looks like the fix rather than a hole in it:
`witness()` originally took its own snapshot of each participating file, and
`snapshot()` stats on every call. So `resolve` looked at disk, `locate` looked
again, and the witness looked a third time — a write landing between any two of
those is absorbed into the *later* number, after which `recheck` compares the
new generation against the new generation, agrees with itself, and commits
bytes spliced from the older buffer. Moving the call earlier only narrows it.
The fix is to witness the generation each participant was already validated or
read at, which every one of them carries; then there is no second look to race.
Generalises past this code: any freshness check whose baseline is re-derived
rather than carried is checking the wrong thing.

**A schema-invalid request still has an id, and is still owed a reply.**
Validating the whole envelope at once loses the id along with the bad body, and
the daemon dropped the request silently — the caller then waited forever.
Recover the id first, validate the body second. The same rule applies to the
test harness: every request needs a timeout, or one wedged call hangs the suite
with no output at all.

**A file change we announce opens a `ContentModified` window.** We notify
rust-analyzer of every disk change we observe and may query before its state
settles, which answers `-32801`. Any external write can open it — an editor
saving, a `git checkout`, another agent — so LSP requests retry through it.

**Unix socket paths cap near 104 bytes** (`sun_path`). Exceeding it does not
reliably raise — the daemon can listen successfully and be unreachable.

**`typescript@7` (the tsgo/native-compiler rewrite) ships no `tsserver.js`.**
`typescript-language-server` requires the classic tsserver and fails
`initialize` with "Could not find a valid TypeScript installation" against a
workspace pinned to TS 7. Dev/test fixtures must pin `typescript@5` (or
configure `tsserver.path` explicitly) until the ecosystem catches up.

**`typescript-language-server` has no `quiescent`-equivalent readiness
signal.** Verified with `typescript-language-server` 5.3.0 / tsserver 5.9.3,
same method as the rust-analyzer findings above: spawn it, log every
notification, test what queries actually return. Every notification observed
was one of `window/logMessage`, `$/typescriptVersion`,
`textDocument/publishDiagnostics`; a `window/workDoneProgress/create` request
fires once but is never followed by a `$/progress` begin/report/end tied to
project load. There is nothing to subscribe to.

**Readiness is implicit in request latency, not a signal to wait for — for
the request that's actually asking about the right files.** The first
`textDocument/references` sent immediately after `didOpen`, with no wait at
all, returned the correct cross-file answer; it simply took ~2.8s (project
load happening synchronously inside the request) instead of returning
fast-and-wrong. Every call after that was single-digit milliseconds. A TS
`whenReady()` can plausibly be a no-op — see the next finding for the
condition that makes this true or false.

**The query's own file must be `textDocument/didOpen`'d first, or the answer
is silently wrong, not an error — but files elsewhere in the project do not
need to be.** Confirmed against source (`typescript-language-server`'s
`references()` handler, `cli.mjs:24342`): it calls
`tsClient.toOpenDocument(uri)` and returns `[]` outright if the query's own
file was never opened — no error, no distinguishing marker, exactly the
ambiguity DESIGN.md §8 says a terminated branch must never have. First
measured against a two-file toy fixture, this looked like it extended to
*every* file involved — opening only the declaration's file and asking for
references found nothing there. That reading turned out to be an artifact of
the syntax/semantic routing bug below, not a real per-file requirement: at
Appsmith scale, with the routing bug fixed and only the query's own file ever
opened, `references` correctly found real usages in 81 files that were never
opened. The minimal, real requirement is narrow — open the file a position is
asked about, nothing more.

**`typescript-language-server` races a syntax-only tsserver against the real
one, and the syntax one can silently answer semantic queries wrong.** It runs
a syntax/semantic tsserver pair (partial semantic mode — a fast syntax-only
server plus a real one) and can route a request to whichever answers first.
The syntax server's project is a throwaway single-file `Inferred` project
rooted at `/dev/null` — confirmed directly from tsserver's own log
(`.log/tsserver-log-*/tsserver.log` under the workspace root):
`Finding references to ... in project /dev/null/inferredProject1*`. Its reply
is a well-formed, empty `references` response; nothing in the LSP-level
response marks it as coming from the wrong server. On a 2-file toy project
the real (semantic) server always won the race, since project load was
near-instant, which is what produced the overly pessimistic finding above.
On a real ~4500-file project (Appsmith's `app/client`) project load takes
several seconds and the syntax server answered first every time, every
answer empty. Setting `initializationOptions.tsserver.useSyntaxServer:
"never"` forces every request through the real server and fixed it
completely.

**All four `LspClient` methods checked out at Appsmith scale under the fixed
config.** `references` and `workspace/symbol` above; `definition` separately,
querying from a real, never-before-opened call site
(`GlobalSearch/index.tsx`) for a symbol declared in a different file that was
also never opened — it correctly resolved cross-file into
`useFeatureFlag.ts`'s real declaration. `didChangeWatched` covered by the
finding below.

**Once a file is open, tsserver stops trusting disk for it.**
`workspace/didChangeWatchedFiles` (type `Changed`) — the only file-change
notification the current `RustAnalyzer` client sends, via
`Workspace.files.onChange` — has no effect on an already-open document.
Renaming a symbol on disk and sending only `didChangeWatchedFiles` left query
results unchanged (stale, pointing at the old name); only an explicit
`textDocument/didChange` with real content updated them. Reproduced at
Appsmith scale too, with the routing bug fixed: a disk rename plus
`didChangeWatchedFiles` alone left `references` unchanged (178 hits / 81
files, identical to baseline); only a real `didChange` updated it, correctly
dropping to zero once the callers no longer matched the renamed symbol. A TS
profile that
opens a file to query it — the real, narrower requirement above — but keeps
notifying changes only via `didChangeWatchedFiles` would silently serve a
stale answer after the first edit to any file it had reason to open.

**A file the client never opened doesn't need any notification at all —
tsserver watches every project file itself.** tsserver's own log shows a
`Closed Script info` file watcher registered for every file in the
configured project, opened or not. Confirmed: with only the declaration file
open, editing a *different*, never-opened caller file directly on disk with
zero LSP notifications sent — no `didOpen`, no `didChangeWatchedFiles`,
nothing — was picked up on its own within a few seconds; that file correctly
dropped out of a subsequent `references` result (178/81 → 176/80, the edited
file gone). So the previous finding about `didChangeWatchedFiles` not
invalidating a file only bites for files the client itself opened to answer
a query; every other file, which is most of them, tsserver already tracks
without help. `Workspace.files.onChange` likely needs no TS-specific branch
at all for the common case — only a client-side "is this URI one I opened?"
check to decide whether a write needs a `didChange`.
