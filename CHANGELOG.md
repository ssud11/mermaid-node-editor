# Changelog

All notable changes to Mermaid Node Editor are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/ssud11/mermaid-node-editor/releases/tag/v1.0.0
