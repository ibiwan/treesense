# Pending review

## M7 — measured dogfooding

The first qualitative Tauroid navigation run confirmed that handle-based
discovery is substantially less noisy than `rg` plus `cat` for a behavior that
crosses creation, caching, animation and rendering. What remains is the
quantitative part of M7: compare Fluent and shell workflows on representative
tasks, recording tool calls, bytes returned, successful target selection and
retries. The baseline is still missing, so the token-efficiency premise is not
yet a measured claim.


Fluent feedback — second data point, and this one's a genuine finding rather than self-inflicted. The agent did use edit properly this time, and reported: excellent for whole-function rewrites and clean insert-after (no whitespace matching, hand it a full body, it splices), but handle granularity degrades after an edit. Inserting three test functions returned one generic expr handle spanning lines 191–352 — the whole rest of the module — so a later one-line fix inside that region meant re-discovering a fine handle via find, a round trip that raw Edit didn't need.

I hit the same thing: my single edit on #NB came back with invalidated #BW #BX #CN #CR #CV #CY #CZ #D0 #D1 #D2 #D3 #D4 #NA #NC #ND — a dozen handles dead from one change. The invalidation list itself is a good design (honest beats silent), but handle inventory decays fast across a multi-edit session, and that collides with DESIGN §7's "round trips cost more than bytes."

The concrete suggestion I'd offer: have edit return handles for the nodes it created, at the granularity it created them. Replacing one function → one handle is right. Inserting three functions → three handles would be far more useful than one coarse span, and would keep the agent inside the handle workflow instead of dropping out of it to re-discover.

**Fixed.** `outcome()` now mints one handle per top-level item introduced within the edit's splice, not just whichever one happened to start exactly at the splice offset. See PLAN.md § M4.

A fluent finding from doing this myself, and a sharp one: I targeted the corner check via a handle find reported as #X7 [geometry.rs::expr] :116 — the snippet it showed me was the comment line, so I assumed the handle covered the comment and its if. It covered only the single line. My replace inserted the new check and left the old one intact, producing two consecutive guards.

**Fixed.** The root cause: a `find` match inside a comment rendered with the same generic `[file::expr] expr` label as any other unmapped node, so nothing in the response distinguished "this handle is just a comment" from "this handle is a real expression." `NodeKind` now has a dedicated `comment` value; a comment-only hit now reads `[file::comment] :N comment`, immediately legible as not-code. See PLAN.md § M1.

## Test environment — TypeScript LSP

`npm run test:all` is green with the Rust toolchain present (72 pass, 3 skip
on 2026-08-11). The skipped TypeScript integration suites need
`typescript-language-server` on `PATH`; install and exercise that server next
time rather than treating the skip as TypeScript validation.

In this restricted environment, Unix-domain socket binding can be unavailable.
The integration harness then uses `FLUENT_STDIO=1` for the long-lived daemon;
that still exercises daemon actions but skips the MCP-facade socket tests
(`stdio fallback: the facade cannot dial a socket`). Re-run the facade tests
where a Unix socket can bind after installing the TypeScript server. For a
manual daemon check, build first, start `dist/daemon/index.js` with the target
root in one terminal, then create a fresh MCP task so the facade reconnects.
