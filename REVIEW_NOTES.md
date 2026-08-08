# Pending review

## M7 — measured dogfooding

The first qualitative Tauroid navigation run confirmed that handle-based
discovery is substantially less noisy than `rg` plus `cat` for a behavior that
crosses creation, caching, animation and rendering. What remains is the
quantitative part of M7: compare Fluent and shell workflows on representative
tasks, recording tool calls, bytes returned, successful target selection and
retries. The baseline is still missing, so the token-efficiency premise is not
yet a measured claim.
