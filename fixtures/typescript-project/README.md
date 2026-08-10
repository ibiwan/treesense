# Fixture project

Exists to be parsed, queried and mutated by integration tests against the
TypeScript profile. Every oddity in the source is load-bearing — see the
comments naming which behaviour each one covers before removing anything.

This file is here for the no-grammar path: `read` must fall back to literal
lines for it, and `refs` must decline rather than guess.

No `node_modules` here on purpose. `typescript-language-server` needs a real
`typescript` install to run `tsserver.js`, but not necessarily this
project's own — tests point `tsserverPath` at the repo's own
`node_modules/typescript` instead, so this fixture stays dependency-free the
same way `fixtures/rust-workspace`'s `Cargo.toml` does, for the same reason:
index time should be dominated by this fixture's own handful of files, not
by resolving a real package graph.
