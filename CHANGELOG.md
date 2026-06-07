# Changelog

All notable changes to Mermaid Node Editor are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-06-07

"Editing intelligence" — navigation, linting, and a redesigned panel for working on large diagrams.

### Added

- A dedicated **Activity Bar** panel (moved out of the Explorer) so the editor is visible right after install, with a theme-tinted icon.
- **Searchable master-detail node list** — compact rows with a filter box and a per-node detail editor, instead of a flat wall of cards. Scales to large diagrams.
- **Go to Definition** (`F12`) and **Find All References** (`Shift+F12`) on any tag, in `.mmd` files and inside ` ```mermaid ` blocks in Markdown.
- **Rename Symbol** (`F2`) on a tag — renames the node and propagates to every edge, using the same engine as the sidebar field.
- **Duplicate-tag linting** — a warning (squiggle + Problems panel + a badge in the sidebar) when one id names two different elements (two subgraphs, a node and a subgraph, or the same id with different labels).
- **Selection sync** — the cursor in the source highlights the matching node; clicking a node row reveals it in the source.

### Fixed

- An unterminated ` ```mermaid ` fence, or one nested inside an outer code fence, is no longer mistaken for a live diagram (which could let a write-back rewrite ordinary prose).
- ID rename no longer corrupts an inline edge label glued to its arrow (`A --text--> B`), and a single-word inline label is no longer treated as a node (which had wrongly blocked some renames).
- ID rename no longer rewrites values inside `style` / `classDef` / `linkStyle` / `click` statements.
- An `F2` rename of a subgraph id is declined (subgraph ids remain read-only, matching the sidebar), instead of producing a partial rename.

## [1.0.1] - 2026-06-06

### Fixed

- ID rename no longer corrupts the label text of dash/dotted/thick inline edges (e.g. `A -- send A data --> B`); the pipe form `-->|...|` was already safe.
- Flowcharts that start with a YAML frontmatter header (`--- title: … ---`, `config:`) are now recognized instead of being shown as "unsupported".
- Semicolon-terminated or -separated statements (`A --> B;`, `A --> B; C --> D`) parse correctly — edges are no longer dropped or spuriously synthesized (this also closes a path that could let an ID rename silently merge two nodes).
- Edit-rejection messages (invalid ID, ID collision) now stay visible instead of being cleared instantly, so you can see why an edit was refused.

## [1.0.0] - 2026-06-05

Initial release. Flowcharts only (`graph` / `flowchart`).

### Added

- Sidebar editor for Mermaid flowchart nodes: edit a node's label or ID and have it written back to the source.
- Renaming an ID updates every edge that references it.
- Editable subgraph titles (the subgraph ID stays read-only).
- A per-node connection list (incoming and outgoing).
- Works in `.mmd` / `.mermaid` files and ` ```mermaid ` blocks in Markdown.
- Node shapes `[]` `()` `([])` `[[]]` `[()]` `(())` `{}` `{{}}` `>]`, with the shape and quoting preserved on write-back.
- An "unsupported" notice for non-flowchart diagrams.

[1.1.0]: https://github.com/ssud11/mermaid-node-editor/releases/tag/v1.1.0
[1.0.1]: https://github.com/ssud11/mermaid-node-editor/releases/tag/v1.0.1
[1.0.0]: https://github.com/ssud11/mermaid-node-editor/releases/tag/v1.0.0
