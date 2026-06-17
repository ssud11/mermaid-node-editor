# mermaid-node-core

A **positioned** Mermaid flowchart language frontend: parse a flowchart to a
typed model where **every node, edge, subgraph and label carries its real source
span** (`{ line, startChar, endChar }`, 0-based). Browser-ESM, **zero runtime
dependencies**.

This is the reusable *read core* for editing and refactoring tooling — the kind
of operation that needs to know exactly *where* each construct is in the source
so it can compute precise, lossless text edits (rename-an-id-and-propagate-it-to-
every-edge, go-to-definition / find-references, validation). Mermaid's own parser
parses to *draw* and discards source positions; this one parses to *edit*.

It is **flowcharts only** (`graph` / `flowchart`). Other diagram types are
reported `supported: false` rather than parsed.

## Install / build

```bash
npm install        # installs peggy (a DEV-only dependency)
npm run build      # generates src/generated-parser.js from grammar/flowchart.peggy
npm test           # builds the parser, then runs the corpus + unit tests on Node 18+
```

The parser is generated from a PEG grammar (`grammar/flowchart.peggy`) by
[Peggy](https://peggyjs.org/). **Peggy is a build-time tool only** — the
generated `src/generated-parser.js` is standalone ESM with no imports, and the
shipped package has **no runtime dependencies**. The grammar file *is* the
specification of the supported input.

## Usage

```js
import { findMermaidBlocks, blockAtLine } from "mermaid-node-core";

// Parse a whole .mmd file (one block):
const blocks = findMermaidBlocks("graph TD\nA[Start] --> B[End]", true);

// …or a markdown document (each ```mermaid / ~~~mermaid fenced block):
const mdBlocks = findMermaidBlocks(markdownText, false);

const b = blocks[0];
b.nodes[0];
// {
//   kind: "node", id: "A", label: "Start", shape: "[]",
//   open: "[", close: "]", quote: "",
//   line: 1, startChar: 0, endChar: 8,     // "A[Start]"
//   labelStart: 2, labelEnd: 7             // "Start"
// }
b.edges[0];
// { kind: "edge", from: "A", to: "B", label: undefined, line: 1, startChar: 0, endChar: 19 }
```

`blockAtLine(blocks, line, isMmd)` returns the block containing a given document
line (useful for cursor-driven tooling).

## Model

Each `Block` carries:

| Field | Meaning |
|---|---|
| `startLine` / `endLine` | block bounds in the document (fence lines for markdown; whole file for `.mmd`) |
| `supported` | `false` for a non-flowchart or unparseable block |
| `diagramType` | the diagram type / first content line |
| `nodes` | each with `id`, `label`, `shape`, `open`/`close`/`quote`, and `{ line, startChar, endChar, labelStart, labelEnd }` |
| `edges` | each with `from`, `to`, optional `label`, and `{ line, startChar, endChar }` |
| `subgraphs` | each with `id`, `label`, `hasId`, `quote`, `members[]`, and `{ line, idStart, idEnd }` |
| `parseError` | the parse-error message when the block did not parse (no exception is thrown) |

Supported flowchart forms: node shapes `[]` `()` `([])` `[[]]` `[()]` `(())`
`{}` `{{}}` `>]`; quoted and unquoted labels; edges `-->`, `-->|label|`,
`-- label -->`, `---`, `==>`, `===`, `-.->`, `-.-`, `<-->`, `<--` in compact
(`A-->B`), spaced (`A --> B`) and one-side-glued forms; chained edges; subgraphs
with an id and/or title; `;`-separated statements; inline and own-line `%%`
comments; YAML frontmatter; markdown fenced blocks and whole `.mmd` files.

### Graceful handling of off-contract input

Inputs outside the contract — hyphenated ids, `&` fan-out, over-bracketed
shapes, reserved-keyword node ids, unterminated brackets/fences — are handled
**gracefully**: the parser never throws or hangs. A hyphenated id is truncated at
the hyphen (the remainder discarded). A block that does not parse is returned
`supported: false` with a `parseError` message. An unterminated fence is skipped,
never swallowing the rest of the document. This lets a consumer **warn** on such
input rather than silently mis-handle it.

## License

MIT
