# Mermaid Node Editor — Project CLAUDE.md

Project-scoped instructions (layer 3 of the scope ladder; extends `~/CLAUDE.md` machine-class + `~/projects/CLAUDE.md` cross-project). Auto-loaded for any CC session in this tree.

## What this is

A **VS Code extension** that adds a sidebar property editor for **Mermaid flowchart nodes**. Click into a Mermaid diagram, edit a node's **label** and **ID** from the Explorer sidebar, and the change writes back into the source. Solves: Mermaid has no visual editing layer, so renaming a node id means manual find-replace of every edge reference.

Built from a fixed build plan (the operator's "V1 Scope — ship this, nothing more"). The plan is authoritative for scope. **Flowcharts only** in v1.

> ⚠️ **Naming:** the folder is `mermaid-note-editor` (operator created it; likely a "note"/"node" typo). The extension's actual identity everywhere internal is **`mermaid-node-editor`** (it edits *nodes*) — `package.json` name, command ids (`mermaid-node-editor.open`), view id (`mermaidNodeEditor`). Do NOT "fix" one to match the other without asking the operator — both states are intentional right now.

## Current state (as of 2026-06-05)

**v1 initial version is built.** All files exist and the project builds. Status of each layer:

| Thing | State | How confirmed |
|---|---|---|
| `npm install` | ✅ done (6 dev deps) | ran it |
| `npm run typecheck` | ✅ clean (strict) | ran it |
| `npm test` (22 unit tests) | ✅ 22/22 pass | ran it |
| `npm run compile` → `dist/extension.js` | ✅ builds, 9.5 kb | ran it |
| **Extension running in VS Code (F5)** | ❌ **NOT TESTED** | requires interactive GUI / Extension Dev Host |

**The critical gap:** the *pure logic* (parser, ID-rename w/ reference propagation, relabel, subgraph-title) is unit-tested and the bundle builds — but the extension has **never been run as an actual extension**. The webview rendering, the webview↔extension message passing, and write-back landing in a live document via `WorkspaceEdit` are **plausible but unverified**. The plan says "No E2E tests for v1 — manual testing is fine"; that manual F5 test has not happened yet.

**When claiming status, preserve this distinction** (see `~/verification-discipline.md`). Don't say "it works" — say "logic unit-tested; runtime unverified" until someone has done the F5 test.

## Tech stack

- **TypeScript** + VS Code Extension API (`engines.vscode ^1.85.0`)
- **esbuild** bundles `src/extension.ts` → `dist/extension.js` (CJS, `vscode` external, node18 target)
- **Webview** sidebar (vanilla JS, no framework) for the UI
- Write-back via `vscode.WorkspaceEdit`
- **No runtime deps** — parsing is regex line-by-line (the plan explicitly says do NOT use the `mermaid` npm AST), so the `mermaid` package was intentionally omitted. Dev deps only: `esbuild`, `typescript`, `@types/vscode`, `@types/node`.

## Architecture / file map

| File | Responsibility | vscode dep? |
|---|---|---|
| `src/parser.ts` | Mermaid block detection (`.md` fenced + whole `.mmd`) + node/subgraph/edge extraction. Regex line-by-line. | **No** (pure) |
| `src/editor.ts` | Write-back logic: `computeLabelEdit`, `computeIdRename` (propagates to edge refs), `computeSubgraphLabelEdit`. Returns `TextEditDesc[]` (line + col span + newText), NOT vscode edits. | **No** (pure) |
| `src/webview/panel.ts` | `WebviewViewProvider`. Lifecycle, msg routing, converts `TextEditDesc[]` → `WorkspaceEdit` and applies. Re-parses fresh on each edit so positions are never stale. | Yes |
| `src/webview/{index.html,main.js,style.css}` | Sidebar UI. `main.js` builds DOM via `createElement`+`textContent` only (no innerHTML → no markup injection from user labels). CSP with nonce. | runtime assets |
| `src/extension.ts` | `activate()`: registers provider + commands + listeners (selection-change / active-editor-change / doc-change keep the panel synced). | Yes |
| `test/{parser,editor}.test.ts` | `node:test` unit tests. | No |
| `examples/demo.mmd` | Sample flowchart for the F5 manual test. Excluded from the packaged `.vsix`. | — |

**Load-bearing = `parser.ts` + `editor.ts`.** They are deliberately kept free of the `vscode` module so they unit-test in plain Node. Keep them that way — if you need vscode types in the editor layer, push that into `panel.ts` instead.

## Commands (all verified working)

```bash
npm install        # dev deps
npm run typecheck  # tsc --noEmit, strict
npm test           # tsc emit to out/ then: node --test out/test/*.test.js
npm run compile    # esbuild bundle -> dist/extension.js
npm run watch      # esbuild watch
npm run package    # npx @vscode/vsce package -> .vsix
```

To run the extension: open this folder in VS Code, press **F5** → Extension Development Host → open `examples/demo.mmd`, cursor inside → "Mermaid Node Editor" panel appears in Explorer.

### Build gotchas (already handled — don't regress)

- **Test runner glob:** `node --test out/test/` (bare dir) FAILS on Node 24 here ("Cannot find module out/test"). The working form is `node --test out/test/*.test.js` — that's what `package.json`'s `test` script uses. Don't revert it to the bare dir.
- **tsc layout:** `tsconfig.json` has `rootDir: "."`, `include: ["src","test"]`, `outDir: "out"` → emits `out/src/*` + `out/test/*`. Tests import `../src/parser`, which resolves at runtime to `out/src/parser.js`. esbuild outputs separately to `dist/` (does not collide with `out/`).
- **Webview assets are read from `src/webview/` at runtime** (via `extensionUri` + `asWebviewUri`), NOT bundled. `.vscodeignore` excludes `src/**/*.ts` but KEEPS `src/webview/*.{html,css,js}`. If you move those assets, update both `panel.ts` paths and `.vscodeignore`.

## Conventions / decisions (deviations from the literal plan, intentional)

1. **Hand-scaffolded** instead of `npx @vscode/generator` (generator is interactive; structure is identical).
2. **No `mermaid` runtime dep** (plan Step 2 says use regex, not the AST).
3. **Parser/editor return plain types**, not `vscode.Range`, so they're testable without vscode. The plan's interfaces named `vscode.Range`; this is the one structural change and it's why the unit tests can run.
4. Subgraph **id is read-only** in v1; only its **title** is editable (matches plan: "subgraph labels as editable fields").

## Supported / not supported (v1 scope — don't expand without operator say-so)

**Supported:** flowcharts (`graph`/`flowchart`), node shapes `[]` `()` `([])` `[[]]` `[()]` `(())` `{}` `{{}}` `>]`, quoted + unquoted labels (bracket shape & quoting preserved on write-back), markdown ```mermaid blocks + whole `.mmd` files, ID rename with edge-ref propagation, subgraph titles, read-only per-node connection list.

**Out of scope (v1):** sequence/state/class/ER diagrams (shown as "unsupported"); add/delete/reorder nodes; visual canvas; editing labels of bare-referenced-but-undefined ids; renaming subgraph ids; multi-file diagrams.

**Known limitations:** dash-delimited edge labels (`A -- text --> B`) may add a spurious entry to the read-only connection list (pipe form `-->|text|` is handled correctly).

## Autonomous polish loop (self-driving, multi-session)

This project ships with a **self-driving** design→build→test→check loop. The operator is the **final review gate only** (design taste + bug sign-off); the loop runs unattended between gates. Built from Claude Code native apparatus:

- **[POLISH-STATE.md](POLISH-STATE.md)** — durable ledger / loop memory: roadmap IT-0→IT-6, publish-ready checklist, iteration log, and a top `STATUS:` marker. Survives across sessions.
- **`/polish-iterate`** ([.claude/commands/polish-iterate.md](.claude/commands/polish-iterate.md)) — one autonomous pass: GATE-check → DESIGN → BUILD → TEST → CHECK → DECIDE (continue or open a REVIEW-GATE).
- **`/loop /polish-iterate`** — drives repeated passes self-paced (native `/loop`). This is how it "works on its own" within a session.
- **`.claude/settings.json`** — scoped `permissions.allow` (npm / git / esbuild / `vsce package`) so passes don't stall on prompts; `vsce publish` + destructive ops stay denied. **`git push` deny removed 2026-06-05** — operator OK'd it while the repo is private; **re-add it once the repo goes public** so pushes return to operator-only. Plus a `SessionStart` hook that prints the `STATUS:` line.

**Resume in any new session:** read [POLISH-STATE.md](POLISH-STATE.md), then run `/loop /polish-iterate`.

**Review-gate protocol** — the loop STOPS and hands back when it needs a design/taste call (icon, GIF, theme), hits a bug it can't confidently fix, reaches a milestone (e.g. `.vsix` staged or IT-1 screenshots ready), fails the same step ≥3× , or reaches any outward-facing/destructive action (always gated). At a gate it writes a REVIEW PACKET (what to look at, design + bugs). Operator feedback → new backlog items → `GATE: none` → loop resumes.

## Suggested next steps (in order)

1. **F5 manual test** — the #1 unverified thing. Open `examples/demo.mmd`, confirm: panel populates, label edit writes back, ID rename updates all edges, subgraph title edits, unsupported notice shows for a `sequenceDiagram`. Fix whatever's broken in `panel.ts`/`main.js` (most likely failure surface — it has zero test coverage).
2. Then per the plan's order: polish UI to match VS Code theme → README screenshot/GIF → `vsce package` → publish.
3. `git init` has NOT been run (the plan said the human would). `.gitignore` is ready (`node_modules/ dist/ out/ *.vsix`).

## Pointers

- Full feature/usage docs: `README.md`
- The original build plan lives in the operator's conversation, not in-repo. Its V1 scope is law; "ship this, nothing more."
