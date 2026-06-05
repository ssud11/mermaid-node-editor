# Changelog

All notable changes to the **Mermaid Node Editor** extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-05

Initial release. **Flowcharts only** in v1.

### Added
- Sidebar property editor for Mermaid **flowchart** nodes (`graph` / `flowchart`).
- Edit a node's **label** and **ID** from the Explorer panel; changes write back to the source via `WorkspaceEdit`.
- **ID rename propagates** to every edge reference.
- Editable **subgraph titles** (the subgraph id is read-only in v1).
- Read-only per-node **connection list** (incoming / outgoing).
- Works inside Markdown ` ```mermaid ` fenced blocks and whole `.mmd` / `.mermaid` files.
- Supported node shapes: `[]` `()` `([])` `[[]]` `[()]` `(())` `{}` `{{}}` `>]` — bracket shape and quoting are preserved on write-back.
- Non-flowchart diagrams (sequence / state / class / ER) show an "unsupported in v1" notice.

[Unreleased]: https://github.com/ssud11/mermaid-node-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ssud11/mermaid-node-editor/releases/tag/v0.1.0
