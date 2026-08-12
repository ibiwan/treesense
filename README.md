# mcp-fluent

An LLM-optimized editing vocabulary over LSP and tree-sitter, behind a thin
unifying MCP facade. Protocol contract lives in [api-def.md](api-def.md).

The premise: `grep` and `cat` are poor tools for an agent moving around a
codebase — not mainly because chunks are too big, but because a string matcher
returns hundreds of hits an agent must read and discard, and because line
numbers force it to guess where a construct begins and ends. Name resolution
turns three hundred hits into twelve, and node addressing removes the guessing.

## Shape

MCP stdio servers are spawned by the host and die with the client session, so
the process holding rust-analyzer has to be a different one — otherwise a warm
index disappears every time an editor restarts, and two clients mean two
indexes.

```
MCP client ──stdio──▶ mcp-fluent          thin, per-session, stateless
                          │ unix socket
                          ▼
                      fluentd             long-lived: rust-analyzer,
                                          handle table, generations
```

Handles die when the daemon dies, not when a client disconnects.

## Handles

Handles are opaque source-region identities returned by `find`, `refs`, and a
large-read overview. Echo them back rather than constructing them. A handle
survives a source insertion above it when its bytes are unchanged; if its own
bytes changed, `read` may return a replacement handle prefixed `changed:`, and
if it cannot be recovered it is `gone`. `edit` and `move` take handles only;
their `deps` list names every other handle whose unchanged state the operation
assumes.

Rendered handles pair that opaque identity with a stable human label, for
example `#6B [frame_loop.rs::tick]`. Results use project-relative paths, so a
handle-bearing line is also a compact human citation.

## Verbs

| | |
|---|---|
| `overview` | bounded source tree, manifests, and heuristic entry-like files; needs no index |
| `find`  | search; returns hits grouped by file and enclosing item |
| `read`  | source when compact; a handle-bearing structural overview when large |
| `refs`  | references to a symbol; blocks on the index |
| `edit`  | modify at a handle, guarded by the target and declared deps |
| `move`  | relocate a handle's bytes before/after another handle, same-file or cross-file |
| `trace` | naive value flow up/down the call chain |

Addresses come in three forms: an opaque handle (`#317H`), a position
(`src/main.rs:12`), or a symbol (`Widget::count`). The model can originate the
latter two and can only echo the first. Nothing asks it to count bytes or
columns.

## Language profiles

Two profiles exist today: Rust (`rust-analyzer`) and TypeScript/JavaScript
(`typescript-language-server`). `fluentd` picks one automatically from the
workspace root's own manifests — `Cargo.toml` selects Rust, `tsconfig.json`
or `package.json` (no `tsconfig.json` required — plain JS projects count too)
selects TypeScript. A root with both picks Rust; a root with neither also
picks Rust, with a note on stderr. `FLUENT_LANG=rust` or
`FLUENT_LANG=typescript` overrides detection outright.

The TypeScript profile expects `typescript-language-server` on `PATH` — it is
not bundled, the same way `rust-analyzer` is not. `FLUENT_TS_COMMAND` points
at a different binary; `FLUENT_TS_TSSERVER_PATH` pins a specific `tsserver.js`
(or its containing directory) when the target project's own `typescript`
dependency ships none, e.g. `typescript@7`'s native-compiler rewrite.

## Status

All seven verbs are implemented: `overview`, `read`, `refs`, `edit`, `find`, `move`, `trace`. Also
in place: addresses; the file registry with generations and lazy staleness;
the handle table including rebasing, identity-based relocation and the
`changed:` / `gone` paths; UTF-16↔UTF-8 offset conversion; the ast-grep syntax
layer; the rust-analyzer and typescript-language-server clients, chosen by
the detection described above.

Symbolic addresses resolve in `refs` through `workspace/symbol`; ambiguous
names return handle-bearing candidates rather than being guessed.

What's left is M7: dogfooding against a real workload to measure whether this
actually costs fewer tokens than `grep`/`cat`. See [PLAN.md](PLAN.md).

`npm test` is hermetic and fast; `npm run test:lsp` needs rust-analyzer and
typescript-language-server, and runs against disposable copies of
`fixtures/rust-workspace` and `fixtures/typescript-project`. Either half
skips cleanly with a message if its language server isn't on `PATH`. See
[PLAN.md](PLAN.md) for milestones and [DESIGN.md](DESIGN.md) for the
cross-cutting invariants.

## Develop

```sh
npm install
npm run typecheck
npm run dev:daemon        # fluentd on the current directory
npm run dev:mcp           # facade; autostarts the daemon if absent
```

`FLUENT_ROOT` overrides the workspace root, `FLUENT_TARGET_DIR` gives
rust-analyzer its own `target/` so cargo's exclusive lock is never contended
with the editor's instance. `FLUENT_LANG` overrides language detection — see
[Language profiles](#language-profiles).

## Suggested flow

Start with `overview`, then use `find({ needle: "term", collapse: true })`.
Read a returned handle to drill in. `find` and `read` work while the semantic
index warms; `refs` and `trace` wait automatically. A capped `find` response
names the accepted `haystack` refinements: a file, line range, or handle.

(If you need a term to search on just to exercise the stack, use the following to find one!)
`rg --files . | shuf -n 1 | xargs rg -ow '[a-zA-Z_][a-zA-Z0-9_]*' | shuf -n 1`

When a large handle becomes an overview, select several listed children in one
call with `read({ target: "#parent", sections: ["#child1", "#child2"] })`.
The children must still be current and inside that parent; their request order
is preserved, and oversized children remain summaries rather than becoming a
bulk source dump.
- Add a lightweight project map: roots, languages, build files, index state,
  and LSP availability.

## Two invariants worth not breaking

**Generations bump only on confirmed content change.** They are optimistic
concurrency control — the working tree can't be locked, since editors, git and
other agents all write it, so every read is stamped and the stamp is checked
when we act. Bumping on mere access invalidates every outstanding handle for
nothing; failing to bump silently stops protecting anything.

**A handle asserts byte identity, not semantic identity.** It stays valid while
its bytes are unchanged — but a shadowing `let` inserted above it, a swapped
`use`, or a changed upstream return type all alter what a symbol resolves to
without touching a byte. The compiler is the backstop for that; don't let the
overview imply otherwise.
