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

A fluent finding from doing this myself, and a sharp one: I targeted the corner check via a handle find reported as #X7 [geometry.rs::expr] :116 — the snippet it showed me was the comment line, so I assumed the handle covered the comment and its if. It covered only the single line. My replace inserted the new check and left the old one intact, producing two consecutive guards.

