# Contributing

## Development

```bash
npm install               # dev dependencies
npm run compile           # bundle -> dist/extension.js
npm run watch             # rebuild on change
npm run typecheck         # tsc --noEmit
npm test                  # unit tests (parser + editor)
npm run test:integration  # extension-host tests (needs a display; use xvfb-run on Linux)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the extension loaded, then open a `.mmd` file.

## Architecture

| File | Responsibility |
|---|---|
| `src/parser.ts` | Mermaid block detection + node/subgraph/edge extraction. Pure, no `vscode` dependency. |
| `src/editor.ts` | Write-back: label / ID / subgraph-title edits, returned as text-edit descriptors. Pure. |
| `src/webview/panel.ts` | Webview lifecycle and message routing; applies edits via `WorkspaceEdit`. |
| `src/webview/{index.html,main.js,style.css}` | Sidebar UI (vanilla JS). |
| `src/extension.ts` | Activation, command and listener wiring. |

`parser.ts` and `editor.ts` are kept free of the `vscode` module so they unit-test in plain Node. `npm run visual` renders the webview in Chromium and writes theme screenshots to `artifacts/`.

## Packaging

```bash
npm run package           # -> mermaid-node-editor-1.0.0.vsix
```

CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, and `vsce package` on every push. Actions are SHA-pinned; commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by `.githooks/commit-msg`).
