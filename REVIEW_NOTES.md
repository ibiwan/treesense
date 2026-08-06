# Daemon identity hardening
Canonicalize workspace root before deriving the socket key.
Replace unconditional socket removal with stale-socket detection plus atomic startup locking.

# Edit-time handle validation
Reread and hash every target/dependency immediately before commit.
If moved but uniquely relocatable, issue/use a replacement handle.
Otherwise fail exactly as an expired handle would.

# M2/M3 utility test
Dogfood navigation on real work.
Measure tool calls, bytes returned, successful target selection, and retry frequency.

# `refs` ambiguity / LLM QoL
When `refs` cannot identify a single symbol, optimize the response for one-call
recovery rather than exhaustiveness.

- Start with a short English reason, e.g. `ambiguous: 3 symbols at this position`
  or `ambiguous: handle covers multiple names`.
- Return one candidate per symbol, not every reference hit yet.
- Include the smallest useful context on each candidate: candidate handle,
  file/range, enclosing item, and a one-line snippet.
- Candidate handles should point at the symbol/declaration to feed straight
  back into `refs`.
- Prefer declarations over usages when constructing candidates.
- Sort likely intent first when there is a strong heuristic signal, but do not
  silently auto-pick.
- Keep the wording action-oriented, e.g. `call refs again with one of these
  handles`.
- Avoid extra knobs or modes until real usage shows they are needed.

# Future `move` semantics
Start with `move exactly`: remove the source handle's bytes exactly as captured
and insert them at the destination anchor without automatic reindentation or
trivia adjustment.

- Overlapping source/destination regions fail.
- If doc comments or attributes should move too, that must be expressed by the
  chosen handle; `move` should not guess at prologue ownership.
- Return a new handle for the inserted text at the destination.
- Add corner-case behavior only when real usage proves it important.
