# Mermaid Node Editor

A sidebar editor for Mermaid flowchart nodes. Click into a diagram and the panel lists its nodes; change a node's label or ID and it's written straight back to your file. Renaming an ID also updates every edge that references it, so there's no find-and-replace.

<p align="center">
  <img src="images/demo.gif" alt="Renaming a node's ID in the sidebar updates every edge that references it" width="820">
</p>

## Features

- Edit node labels and IDs from the Explorer sidebar
- Renaming an ID updates all of its edges
- Edit subgraph titles
- See each node's incoming and outgoing connections
- Works in `.mmd` / `.mermaid` files and ` ```mermaid ` blocks in Markdown
- Follows your VS Code theme

Flowcharts only (`graph` / `flowchart`). Other diagram types show an "unsupported" notice.

## Usage

Open a `.mmd` file, or a Markdown file with a ` ```mermaid ` block, and put your cursor inside the diagram. The **Mermaid Node Editor** panel shows up in the Explorer. Edit a field and click away to apply. You can also run **Mermaid: Open Node Editor** from the Command Palette.

## Supported shapes

`A[rect]`, `A(round)`, `A([stadium])`, `A[[subroutine]]`, `A[(database)]`, `A((circle))`, `A{decision}`, `A{{hexagon}}`, `A>flag]`. The shape and any quotes around a label are preserved when you edit it.

## Release notes

See the [changelog](CHANGELOG.md).

## License

MIT
