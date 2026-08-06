# Fixture workspace

Exists to be parsed, queried and mutated by integration tests. Every oddity in
the source is load-bearing — see the comments naming which behaviour each one
covers before removing anything.

This file is here for the no-grammar path: `read` must fall back to literal
lines for it, and `refs` must decline rather than guess.
