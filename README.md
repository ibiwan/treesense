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

## Verbs

| | |
|---|---|
| `find`  | search; returns hits grouped by file and enclosing item |
| `read`  | source, or a reason it can't be returned — never navigation |
| `refs`  | references to a symbol; blocks on the index |
| `edit`  | modify at a handle, guarded by the target and declared deps |
| `move`  | relocate a handle's bytes before/after another handle, same-file or cross-file |
| `trace` | naive value flow up/down the call chain |

Addresses come in three forms: an opaque handle (`#317H`), a position
(`src/main.rs:12`), or a symbol (`Widget::count`). The model can originate the
latter two and can only echo the first. Nothing asks it to count bytes or
columns.

## Status

All six verbs are implemented: `read`, `refs`, `edit`, `find`, `move`, `trace`. Also
in place: addresses; the file registry with generations and lazy staleness;
the handle table including rebasing, identity-based relocation and the
`changed:` / `gone` paths; UTF-16↔UTF-8 offset conversion; the ast-grep syntax
layer; the rust-analyzer client.

Symbolic addresses (`Widget::count`) are accepted by the grammar but not yet
resolved — they need `workspace/symbol`.

What's left is M7: dogfooding against a real workload to measure whether this
actually costs fewer tokens than `grep`/`cat`. See [PLAN.md](PLAN.md).

`npm test` is hermetic and fast; `npm run test:lsp` needs rust-analyzer and
runs against a disposable copy of `fixtures/rust-workspace`. See
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
with the editor's instance.

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
