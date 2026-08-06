# LLM-optimized editing vocabulary using LSP and tree-sitter behind a thin unifying MCP

## Basics
Line numbers and text searches are supported, but are treated as fallbacks and starting points.  Direct node references are preferred, and are provided/recognized/translated by the MCP facade.

Actions include "find string in file", "read source", "find references", "edit source", "trace flow".

Location references can take the form of opaque block handles, file and line number tuples, and logical (namespace-style) breadcrumb chains.

Concurrency safety is maintained through version stamping; editing a handle with a stale version will fail.  (Success just means the bytes did not change, but meaning can change if context around those bytes changed their meaning.)  Generation tags are maintained internally to the MCP and implied by handles.

## Location References

### Full

Tuple, internal-only to the facade.  Holds appropriate subset of: full system path to the file, line number[s], byte range, generation tag, type of node, name of symbol, qualified path if available, definition path otherwise.

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
| Mode      | Not Implemented Yet: One of string, text, symbol, or ast-grep query. Inferred, by default. |
| **returns** |  |
| Hits | All Hits |

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
| Handle \| Position \| Symbolic |  |
| **returns** | (if...) |
| Hits | handle points to one token |
| | handle points to a named declaration block |
| | position includes only one symbol |
| | symbolic ref is unique |
| Candidates | handle is a statement or block with multiple symbols |
| | position include multiple symbols |
| | symbolic ref matches multiple places (reentrant impls, e.g.) |

If multiple distinct symbols match, "ambiguous" will be the first line of the response, then the list will be the first hit found per candidate symbol, matching the formatting of Hits. Refs can be called again with one of those handles which should then be unambiguous.

| EDIT | |
| -- | -- |
| **arguments** | |
| Target Handle | No positions for safety |
| Action | Replace, Insert-Before, Insert-After, Delete |
| Dependency Handles | Write should fail if any handle listed is stale, use for cross-reference assumptions
| Replacement Content | Starts after first newline. No content for Delete |
| **returns** |  |
| Handle Plus | new reference to introduced content (enclosing node if  Delete) |
| Error | With description, instead of handle, if target or dependency handles are unrecoverably stale. |

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
