# Done since this file was written

Three items from the original M2 punch list landed during M3–M5 and are
verified in place; kept here as a record rather than deleted outright.

- **Daemon identity hardening** — `daemon/index.ts` canonicalises the root via
  `realpath` before calling `socketPathFor` (M4), and start-up now probes with
  `isServed` before unlinking a socket, plus stands down cleanly on
  `EADDRINUSE` instead of racing another daemon for the bind (M4).
- **Edit-time handle validation** — `edit.ts` witnesses every target/dep
  generation at validation time and `recheck`s it immediately before the
  rename (M4/M5); `handles.ts#resolve` relocates by identity when a referent
  moved and is uniquely recognisable, issuing a replacement handle on
  `changed` and refusing on `gone` (M3).
- **`refs` ambiguity / LLM QoL** — `refs.ts#candidates` matches the original
  spec: one entry per distinct symbol (not per reference hit), declarations
  ranked first but never auto-picked, candidate handles point at the
  declaration, header reads `ambiguous: N symbols on … — call refs again with
  one of these handles` (M3).

# M2/M3 utility test
Dogfood navigation on real work.
Measure tool calls, bytes returned, successful target selection, and retry frequency.

This is M7 in PLAN.md. Needs a real workload (tauroid) and an LSP-capable
environment; blocked on both in a headless VM with no rust-analyzer installed.

# `move` — implemented

Relocates `source: Handle` to sit `insert-before`/`insert-after`
`destination: Handle`, plus an optional `deps: Handle[]` — same shape and
CHANGED/GONE reporting as `edit`'s deps. Implemented in
`src/daemon/actions/move.ts`, sharing `edit.ts`'s splice builder and a new
`daemon/deps.ts` (validate/witness/recheck, extracted from `edit.ts` so both
verbs use the same premise-checking machinery). Covered by 9 integration
tests in `src/integration/move.test.ts`, including the same-file no-op/
overlap boundary and the cross-file partial-result path. Design record below,
kept for the reasoning rather than as an open item.

**Fixed after review:** the cross-file path witnessed only `destination.file`
before its own write, not `source.file` — but `movedText` is copied from
source into destination's payload, so an external write landing on source
between the read and the destination write could commit stale bytes into
destination, undetected until the (too-late) post-write source recheck. Two
things were wrong, not one: `witness()` also needs `source.file` in its set,
*and* it was being taken after `build`/the parse-check rather than right
after both `locate` calls — which left almost no window bracketed at all.
Fixed by moving the witness earlier and adding `source.file` to it, matching
where `edit.ts` takes its own witness relative to its build step. No
deterministic regression test was added for the exact race: closing this
window from the outside would need an external write landing inside a
synchronous, no-I/O span (build+parse), which isn't something a black-box
test can force without an injected hook — the same class of gap DESIGN.md
already documents as irreducible for the stat-to-rename window. Verified
instead by re-running the full 55-test integration suite clean.

**Reindentation is not skipped.** "Move exactly" turned out to mean "don't do
anything smarter than `edit`'s own `insert-before`/`insert-after` already do,"
not "bypass indentation entirely" — the latter would land unindented code
inside a differently-indented block by default, which is a worse default than
what `edit` already gives every other insert. Reuses `baseIndent`/`reindent`
verbatim; zero new formatting logic.

**Same-file vs cross-file are different mechanically, not just in scope.**
Cross-file relocation matters more than atomicity across the pair — the two
files write independently, add-before-remove, so a failure partway through
leaves a visible duplicate rather than losing the source. Same-file gets a
true single-write atomic guarantee (one temp-and-rename) because both splices
land in one buffer.

- **Same-file:** validate source + destination + deps together against one
  snapshot; reject clean (zero writes) if anything is already bad. Compute the
  destination point (`target.bytes.start` for insert-before, `.end` for
  insert-after) and compare it against the raw source range: strictly inside
  → fail as incoherent (no coherent order exists); equal to either boundary →
  no-op, short-circuit with no write at all, because deleting and reinserting
  the same bytes at either edge of where they already sit reconstructs the
  file exactly — the two boundaries collapse to the identical result, so this
  is not about handle identity, just byte-point comparison. Otherwise: one
  consolidated recheck of everything immediately before the single write,
  build both splices (reusing `edit`'s own splice builder for insert *and*
  delete, so the source-side removal gets the same leading-indent/
  trailing-newline/double-blank cleanup `edit delete` already has), apply the
  **rightmost-original-position splice first** — its coordinates are still
  valid because nothing to its left has moved yet — then rebase via two
  ordered calls to the existing single-range `HandleTable.rebase()`, same
  order. No new rebase primitive needed.
- **Cross-file:** validate source + destination + deps together up front,
  same as above. Recheck destination + deps immediately before writing it
  (destination's second check) — bad here is still a clean, zero-write
  rejection. Write the destination, mint its handle. *Only now* recheck source
  + deps again (source's second check) — this is the one that can produce a
  **partial** result, since the destination write already landed. A partial
  report surfaces exactly what `edit`'s own CHANGED/GONE dep-rejection
  vocabulary already says (CHANGED carries the replacement handle
  `resolve()` already issued; GONE has nothing to restore) — no automatic
  reversal write is attempted; the report is the recovery path, consistent
  with "retry through a race, refuse a conflict" — reversing a completed write
  is itself a fresh risky write, not a refusal. Good outcome: delete the
  source, kill its handle, rebase the rest of that file normally — fully
  independent of the destination file's handle table, so none of the same-file
  ordering trick is needed here.

**Deliberately not doing:** no knobs beyond `deps`; no handle-identity-based
overlap detection (pure byte-point comparison, since unrelated handles can
coincide at the same boundary by coincidence); no speculative extra rechecks
beyond one-at-validation/one-before-its-own-write per participant.

# Transport fallback
If Unix-domain sockets keep failing in constrained environments, a TCP
localhost transport is a plausible durable fallback.

- Not urgent if the issue only appears in sandboxed CI/dev environments.
- Worth building if socket bind failures recur often enough to block testing or
  dogfooding.

# Dogfooding observations — Tauroid navigation

Using the tool against Tauroid to trace the marine sprite lifecycle was
materially more structured and less noisy than the usual `rg` + `cat`
workflow. `find` surfaced compact, enclosing source units with handles, which
made it straightforward to follow the cross-cutting path from prototype and
world creation through SVG templating, sprite caching, animation, rendering,
and eventual process-lifetime cleanup. Literal shell search remains faster for
a one-off text check; the fluent workflow is notably better for understanding
a behavior spread across several modules.

Pain points and likely improvements:

- **Index warm-up is opaque.** The status says it is fetching project
  metadata, but does not say what capability becomes available, whether the
  result is cached, or when it is ready.
- **Large reads fail abruptly.** A 529-line read with `maxLines: 500` returned
  only an error. For oversized files, return a structure view by default (or
  alongside the first requested section) rather than a dead end.
- **A structure-first view would improve orientation.** For example, list
  imports, constants, types, impl blocks, functions, test modules, their line
  spans, and byte/line sizes; then allow reads by stable structural handle,
  such as `frame_loop::tick` or its `stage` phase.
- **Handles need a concise usage contract.** They appear to be stable source
  region identities, but their lifetime, invalidation/replacement behavior,
  and the dependency relationship for edits should be stated near results.
- **Result labels need a legend or a friendlier default.** Terms such as
  `expr`, `ident`, and `range` are compact but unexplained on first use.
- **Project-relative paths should be the default display.** Absolute paths are
  precise but less scannable; retain them as an opt-in detail.
- **Tool choice needs examples.** The distinction between literal discovery
  (`find`) and semantic navigation (`refs`, `trace`) would be easier to learn
  with one compact example each.
- **A lightweight project-map command would help.** Roots, languages, build
  files, indexing state, and LSP availability would make initial orientation
  faster.
