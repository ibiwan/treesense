to possibly steal from jetbrains' mcp:

Yes. After filtering their giant list through “does this reduce model reasoning/token churn while staying a small semantic-source tool?”, I get about three real roadmap candidates, plus two maybes. Treesense already has the right core seven-verb shape, and I would resist adding verbs unless dogfooding proves a hole.
1. Semantic rename — strong yes. JetBrains’ rename_refactoring is the clearest thing I’d steal.
An agent renaming a symbol with Treesense today conceptually has to refs, understand all the sites, and perform a bunch of edits. That is precisely the kind of work the semantic backend can do more cheaply and reliably. I would not add rename as an eighth verb; make it an edit action:
edit(target=#handle, action=rename, replacement="new_name", deps=[...]).
The hard bit is worthwhile: accept the LSP WorkspaceEdit, validate every affected document immediately before commit, then apply the set transactionally enough that you don't half-rename a project. This also fits your handle philosophy unusually well: the model names the intended transformation; the machinery finds the bytes.
2. Symbol/type/hover information — strong yes, probably inside read. JetBrains’ get_symbol_info returns signature, type, docs, declaration, etc. without making the agent go read surrounding source.
This is almost perfectly aligned with your token thesis. Very frequently the question is “what does this thing take/return?” rather than “show me its implementation.” I could see:
read(target=#foo, view="info")
or even having a compact semantic header automatically appear before an overview when available. I wouldn't expose separate hover/signature/type APIs. One tiny semantic-info path is enough.
3. Diagnostics attached to edits — strong yes, but not necessarily a callable tool. JetBrains has several variants of “show me problems after the edit,” including get_file_problems, batch linting, and inspections.
Your own README already identifies the precise weakness this addresses: a handle establishes byte identity, while surrounding changes can alter meaning without altering those bytes, leaving the compiler as backstop.
Since you already have a warm LSP, I'd be tempted to make successful edit responses optionally wait for the new analysis snapshot and include new diagnostics caused in touched files. Something like:
ok #NEW
diagnostics: 2 new
followed by compact handle-bearing locations. Again, no eighth verb. Spend milliseconds/seconds to save a model turn.
4. Call hierarchy — yes as an implementation ingredient for trace, not a feature. JetBrains’ analyze_calls is explicitly built around incoming/outgoing semantic call edges instead of usage search.
That is almost exactly one of the expensive steps your trace abstraction needs; your current contract says trace walks caller/callee relationships and maps argument positions.
Where the target LSP offers call hierarchy, use it underneath trace. The user-facing abstraction is already better than theirs for your purpose.
5. Project dependency/module awareness — modest yes, folded into overview. JetBrains exposes project modules and dependencies separately.
Treesense already has “lightweight project map: roots, languages, build files, index state, LSP availability” sitting in the README.
I'd extend that one line slightly to include workspace/package/module names and direct dependencies when cheaply obtainable. An agent asking “do we already depend on serde/regex/foo?” should not have to search manifests and interpret them. But I would absolutely not create dependencies and modules tools.

The one JetBrains feature I find tempting but would not put on the roadmap yet is code actions / quick fixes. Their inspection tools can return named fixes and then apply them.

LSPs can potentially make that enormously powerful: “compiler says this; apply the backend's known fix.” But it's also a gateway drug to becoming an IDE facade. Workspace edits, arbitrary server commands, language-specific actions, choice presentation, stale diagnostics... there's a lot hiding behind a seemingly tiny feature. I'd wait until dogfooding repeatedly finds the agent staring at a diagnostic whose LSP already knows how to fix it.
