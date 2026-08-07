# LLM-optimized editing vocabulary using LSP and tree-sitter behind a thin unifying MCP

## Basics
Line numbers and text searches are supported, but are treated as fallbacks and starting points.  Direct node references are preferred, and are provided/recognized/translated by the MCP facade.

Actions include "find string in file", "read source", "find references", "edit source", "trace flow".

Location references can take the form of opaque block handles, file and line number tuples, and logical (namespace-style) breadcrumb chains.

Concurrency safety is maintained through version stamping; editing a handle with a stale version will fail.  (Success just means the bytes did not change, but meaning can change if context around those bytes changed their meaning.)  Generation tags are maintained internally to the MCP and implied by handles.

## Location References

### Full

Tuple, internal-only to the facade.  Holds appropriate subset of: full system path to the file, line number[s], byte range, generation tag, type of node, name of symbol, qualified path if available, definition path otherwise.

Also carries an **anchor** byte offset: the point at which position-based questions about this referent are posed.  Distinct from the byte range because a declaration's range starts at its doc comment, and asking a language server about a comment answers nothing.  The anchor must move with the range whenever a handle is rebased or relocated.

### Handle

Opaque reference, a # prefixed alphanumeric token. Conceptually, refers to a symbol/node/block/range as it was at the time it was generated.  Generation tag is implicit, writes to a handle will succeed only as long as the referent hasn't changed.  If the referent has MOVED without changing (because of adding text earlier in the file) it will still be valid.

### Position

Filename (project-relative or system-absolute), colon, optional line number[s]. (Refers to full file if omitted).  
`[/]<filepath>[:<start-line>[-<end-line>]]`

### Symbolic

Language-specific fully qualified symbol, e.g. `Widget::count`

## Return Types

| | example | | 
|-|-|-|
| Handle | `#317H` | "#" [0-9A-Z]+ (but excluding I/L/O/U, case-insensitive) |
| Range | `:3-15` or `:12` | ":" start ["-" end] (lines, 1-indexed, inclusive)|
| Position | `main.c:3` | filename, Range |
| Size | `513KB` | omitted if under (# lines * 120) |
| Type | `fn` | fn, impl, if/match/for block, struct, stmt, file |
| Description | `fn Square::area` | Type, fully-qualified token name |
| Handle Plus | `#317H :35-37 fn Square::area` | Handle, Position\|Range, Size, Description |
| Hierarchy | `> #317H fn area > #R8F2 impl Square`| (">" Handle Plus (range variant))+ |
| Hit | * | Hierarchy, newline, indent, code snippet |
| Per-File Hits | * | filename, (newline, Hit)+ |
| All Hits | * | (Per-File Hits, newline)+ |
| Site | `up 2` <HandlePlus> | "up"\|"down", # calls away, Handle Plus, newline |

\* ex:
```
  main.c
  > #b4 :9-11 else block > #a1 :3-12 fn main
    exit(0);
  > # > # ...
    y = f(x);
  square.c
  > # ...
    ...
```

## Actions

| FIND | |
| -- | -- |
| **arguments** | |
| Needle    | Double-Quoted string to search for |
| Haystack  | Location Reference (handle \| position) |
| Mode      | Inferred from the needle's shape; no parameter. A `$VAR` metavariable means an ast-grep pattern, anything else is literal text. Explicit modes remain unimplemented. |
| **returns** |  |
| Header | `find "<needle>" text\|pattern <count>` — the reading used is stated, so a misread costs one line rather than a round trip. A trailing `+` means the cap was hit. |
| Hits | All Hits |

Hit handles point at the **matched node**, not the enclosing line, so a
follow-up `refs` on one is exact rather than ambiguous.

Haystack scoping: absent searches the workspace (pruning `target/`,
`node_modules/`, `.git/` and friends as it descends); a Position narrows to a
file or a line range; a Handle bounds the search to that node's byte range.

Zero matches is a successful answer, not an error — "nothing matches" is
information. **A malformed pattern is therefore an error, not zero matches**:
it must not be able to impersonate a real empty result.

Text search works on any non-binary file, grammar or not — `find string in
file` is a basic capability, and `read` already falls back to literal lines for
these. A hit in such a file carries a range handle rather than a hierarchy, so
both verbs agree about what is addressable. Structural patterns require a
grammar by definition.

Three caps, all reported rather than silently applied: hits, files enumerated
during a workspace walk, and snippet length. Unwalked files matter most — a
capped hit list is visibly short, whereas files never searched leave no trace
in the results at all. Snippet length is capped separately because the hit cap
alone does not bound the response: sixty matches on a minified line is a
quarter-megabyte of context nobody asked for.

Unlike REFS, FIND needs no index. It reads files and parses them, so it works
during cold start.

| READ | |
| -- | -- |
| **arguments** | |
| Target | Handle obtained from `find` or `refs`, or Position |
| Max Lines | Optional (specify if position is filename without line range, -1 for no limit) |
| Max Bytes per Line | Optional. Specify if using position and risk of long lines.  Default 120 if using position, -1 (no limit) if using handle. Calculated average across response, NOT per line. If single line position (not handle) default is 1024 |
| **returns** |  |
| Handle Plus | If handle has changed, this will be the one representing the new version. Prefixed with "changed: " if changed. |
| Content | All lines to end of response are literal file content with whitespace as-is |
| Error | With description (instead of Handle/Content if target is invalid or maximums are exceeded) |

| REFS | |
| -- | -- |
| **arguments** | |
| Handle \| Position \| Symbolic | Symbolic is **not yet implemented** — needs `workspace/symbol`. |
| **returns** | (if...) |
| Hits | handle points to one token |
| | handle points to a named declaration block |
| | position includes only one symbol |
| | symbolic ref is unique |
| Candidates | handle is a statement or block with multiple symbols |
| | position include multiple symbols |
| | symbolic ref matches multiple places (reentrant impls, e.g.) |

Ambiguity is a result, not an error, and the response is shaped for **one-call recovery** rather than completeness — it is not a Hits list.

```
ambiguous: 3 symbols on src/pipeline.rs:9 — call refs again with one of these handles
  pub fn run(seed: u32) -> u32 {
#1 :9 run  declares fn run
#2 :9 seed  in fn run
```

- First line states the count, where, and what to do next.
- One line per candidate: Handle, Range, name, and either the declaration it names or the item containing it.
- The queried source line appears once when every candidate shares it, rather than repeated per entry.
- Declarations sort first — asked about a line, the caller usually means the thing declared there — but nothing is auto-picked.
- Candidate handles point at the **declaration** where the identifier names one, since only a declaration carries a qualified name and so only it survives relocation.
- Entries are **occurrences, not distinct spellings**.  Two `x`s may be two bindings; collapsing them by text drops exactly the choice this response exists to offer.  A symbol that genuinely repeats costs one redundant line, which is the cheap direction to be wrong in.

| EDIT | |
| -- | -- |
| **arguments** | |
| Target Handle | No positions for safety |
| Action | Replace, Insert-Before, Insert-After, Delete |
| Dependency Handles | Write should fail if any handle listed is stale, use for cross-reference assumptions
| Replacement Content | Starts after first newline. No content for Delete |
| **returns** |  |
| Handle Plus | the item introduced by the edit — not the doc comment or attribute it may begin with, and not whatever merely moved into place. Enclosing node for Delete. |
| Invalidated | `invalidated #A #B` — outstanding handles that overlapped the edit and are now void. Omitted when none died. |
| Error | With description, instead of handle, if target or dependency handles are unrecoverably stale. |

Validation completes before anything is written, and every participating file's generation is re-checked immediately before the rename — a file that moved in between aborts the edit rather than being written against a state the caller never saw.  A rejected edit has touched no file.  Rejection names each failing dependency and *how* it failed, because the next move differs — `CHANGED` means re-read and retry, `GONE` means the node the plan depended on is deleted and the plan itself needs revisiting.

Indentation comes from the buffer, never the payload: the replacement is dedented to its own minimum and re-indented to the target's base indent, so flush-left and pre-indented content give the same result.

A replacement that fails to parse is refused and nothing is written — unless the file was *already* unparseable, which would otherwise trap the caller in a state only an edit can escape.

`delete` takes the leading indentation and trailing newline with the node, and collapses a double blank line when the removed item was blank-separated on both sides.

A Position target is rejected by the action with a readable message rather than by schema, since "no positions for safety" is a documented behaviour and not a syntax error.

| TRACE | *NAIVE* trace of a single value up or down through its call chain |
| -- | -- |
| **arguments** | |
| Handle \| Position \| Symbolic | matches input behavior of REFS
| Max Up | Number of steps UP call chain to trace, default -1 for unlimited |
| Max Down | Number of steps DOWN call chain, default 3,  -1 for unlimited -- warning, can branch extensively |
| **returns** |  |
| Sites | List of Site entries if unique symbol was specified |
| Up/Down Stop Reasons | Max Reached, Macro, Non-Ident, Destructure, Resolved, etc |
| Candidates | as REFS, if not unique |

Naive trace follows the symbol to a named argument or parameter, looks for callers/callees, maps to variables at corresponding position.  No accommodation is made for slices, mutability, ownership, destructuring, etc.

Only a **bare identifier** in argument position is followed.  Anything else is a terminus carrying a reason, because following it would require knowing what the surrounding expression does with the value — which is exactly the analysis this verb does not perform.

Stop reasons: `end`, `macro`, `non-ident-arg`, `destructure`, `field-assign`, `return`, `depth`, `cycle`, `unresolved`, `capped`.  `capped` marks branches abandoned for capacity — a walk that ran out of budget is a truncation, not an ending, and the header says so too.  A row without one is a waypoint with deeper rows beyond it; **a terminus always carries one**, so a branch that halted is never mistakable for a branch that finished.

The header reports the walk's workspace generation and marks the result `STALE` if any file changed during it.  Unlike a reference list — where each entry stands or falls alone — a trace's conclusion depends on every link holding simultaneously, so coherence is checked across the whole walk rather than per lookup.

An ambiguous Position is refused with a pointer to REFS rather than guessed at: a trace built on the wrong symbol is expensive to notice.
