# POLISH-STATE — Mermaid Node Editor → Marketplace

<!-- STATUS: IT-0 done | next=IT-1 | GATE: none -->

Ledger + memory for the **autonomous** design → build → test → check → design polish loop. Survives across sessions; every `/polish-iterate` pass reads this file and updates it — including the `STATUS:` marker above (a `SessionStart` hook prints it so each new session knows where the loop is).

- **Driver:** SELF-DRIVING via `/loop /polish-iterate`. Passes run unattended. The operator is the **FINAL REVIEW GATE only** — design taste + bug sign-off. Claude does NOT stop every pass; it stops only at a REVIEW-GATE (protocol below).
- **Runtime verification (BOTH):** automated `@vscode/test-electron` smoke runs *inside* the loop under `xvfb-run` (headless) and captures screenshots to `artifacts/` → the operator does the visual / manual-F5 sign-off at a gate.
- **Polish scope:** full (theme-matched UI, GIF demo, integration suite, broad QA).
- **Publisher:** `ssud11` (operator has a Marketplace account). The loop's job ends at a built **`.vsix`**; publishing is operator-only and ALWAYS gated.

---

## The loop (one `/polish-iterate` pass)

| Station | What happens | Tooling |
|---|---|---|
| **GATE check** | If `STATUS:` shows an open `GATE:`, do no work — hand back to operator | this ledger |
| **DESIGN** | Pick topmost non-`DONE` roadmap item; confirm acceptance criteria | this ledger |
| **BUILD** | Implement it (code / assets / `package.json` metadata) | Edit/Write |
| **TEST** (fast gate, must stay green) | `npm run typecheck` · `npm test` · `npm run compile` | Bash (allowlisted) |
| **CHECK** (deep) | xvfb integration smoke + screenshots · `/code-review` · `/security-review` · `vsce package` | per item |
| **COMMIT** | Commit (Conventional Commits, green gate only) + `git push` → triggers CI | git + commit-msg hook |
| **DECIDE** | Update ledger + `STATUS:`; CONTINUE to next pass, or open a REVIEW-GATE | this ledger |

---

## Review-gate protocol (when the loop hands back to YOU)

Open a GATE — set `STATUS: ... | GATE: <name>`, append a **REVIEW PACKET** to the iteration log, and END the loop — when a pass hits ANY of:

1. **Design / taste call** you should own — icon look, GIF content/length, theme & spacing choices, README copy tone.
2. **A bug the loop can't confidently fix** after an honest attempt (don't thrash).
3. **A milestone worth a checkpoint** — a built `.vsix`, or runtime/visual behaviour needing human eyes (IT-1 screenshots).
4. **Same TEST/CHECK step fails ≥3 passes** in a row (stuck — surface it, don't loop forever).
5. **Any outward-facing / destructive action** — `git push`, `vsce publish`, anything network/irreversible. ALWAYS gated; the loop never does these itself.

A **REVIEW PACKET** records: what was done, exactly what to look at, the design questions + suspected bugs, and where the evidence is (`artifacts/*.png`, `.vsix` path). Your feedback → new backlog items → set `GATE: none` → the loop resumes next pass.

If NONE of the above fire: update `STATUS:`, mark the item, and CONTINUE — the next pass starts on its own.

---

## Publish-ready checklist (definition of done)

- [x] TEST gate green (typecheck + 22 unit tests + esbuild bundle) — verified IT-0
- [ ] **Runtime — automated** `@vscode/test-electron` smoke passes headless under xvfb
- [ ] **Runtime — operator visual sign-off** at a gate (screenshots: label edit, ID rename→edge propagation, subgraph title, unsupported notice)
- [ ] `icon` field + `icon.png` (128×128)
- [x] `repository` field in `package.json` — `github.com/ssud11/mermaid-node-editor` (private; operator-confirmed)
- [ ] `CHANGELOG.md`
- [ ] README has screenshot **and** animated GIF
- [ ] Theme-matched UI (`--vscode-*` tokens; clean empty/unsupported states)
- [ ] `/code-review` (high) + `/security-review` clean
- [ ] `vsce package` → `.vsix` builds, no warnings
- [ ] CI green on push/PR — typecheck + unit + `vsce package` ([.github/workflows/ci.yml](.github/workflows/ci.yml))
- [x] Commit convention hard-enforced — Conventional Commits via [.githooks/commit-msg](.githooks/commit-msg)
- [x] `git init` + clean history — commit c82be81 on `main`, 22 files
- [ ] **[operator-only gate]** upload/publish the `.vsix` (web UI, or PAT + `vsce publish`)

---

## Iteration roadmap (full-polish ordering)

> Runtime truth first (can invalidate `panel.ts`/`main.js` assumptions), then lock with automation, then polish surface, then package, then harden.

### IT-0 — Baseline + git  · _status: DONE (commit c82be81)_
- Re-confirm TEST gate green from clean; `git init` + first commit; add `repository` field to `package.json`.
- **Accept:** green gate; repo initialised; `vsce package --dry-run` stops warning about missing repository. _(no gate — continue)_

### IT-1 — Runtime smoke + screenshots (xvfb)  · _status: TODO_
- Stand up a minimal `@vscode/test-electron` harness; launch the real extension host headless under `xvfb-run`; open [examples/demo.mmd](examples/demo.mmd); capture screenshots of: panel populated, label edit, ID rename, subgraph title, `sequenceDiagram` unsupported notice → `artifacts/`.
- Fix obvious breakage in [panel.ts](src/webview/panel.ts) / [main.js](src/webview/main.js).
- **Accept:** smoke launches; screenshots captured. → **REVIEW-GATE** (your visual/F5 sign-off on the 5 behaviours).

### IT-2 — Automated integration assertions  · _status: TODO_
- Extend the harness into real assertions: activation · webview message round-trip · `WorkspaceEdit` write-back lands · ID-rename edge propagation end-to-end. Wire `npm run test:integration`.
- **Accept:** integration suite passes headless. _(continue)_

### IT-3 — UI / theme polish  · _status: TODO_
- [style.css](src/webview/style.css) → `var(--vscode-*)` tokens, spacing, focus rings, hover, empty + unsupported states. Re-capture light+dark screenshots.
- **Accept:** native look both themes; no hard-coded colors. → **REVIEW-GATE** (design taste).

### IT-4 — Marketplace metadata + assets  · _status: TODO_
- `icon.png` (128×128) + `icon` field; `galleryBanner`; tidy categories/keywords; `CHANGELOG.md` (Keep-a-Changelog, `0.1.0`).
- **Accept:** `vsce package --dry-run` clean; icon renders. → **REVIEW-GATE** (icon design).

### IT-5 — README + GIF demo  · _status: TODO_
- Screenshot + animated GIF of the edit→write-back flow; feature list; install/usage; supported-shapes table; known limitations.
- **Repo is PRIVATE** → bundle README images *inside* the `.vsix` (relative paths), NOT `raw.githubusercontent.com` URLs (those need auth and won't render on the Marketplace). Verify images render from the packaged extension.
- **Accept:** README renders well as a Marketplace landing page. → **REVIEW-GATE** (copy + GIF taste).

### IT-6 — Hardening + final CHECK  · _status: TODO_
- `/code-review high` · `/simplify` · `/security-review` (verify CSP/nonce + no-innerHTML hold). Full sweep: typecheck + unit + integration + `vsce package` → `.vsix`.
- **Accept:** reviews clean; `.vsix` staged. → **REVIEW-GATE** (final sign-off → you publish).

---

## Iteration log (newest on top — REVIEW PACKETs land here)

### 2026-06-05 · Config — commit rule + CI · CONTINUE (no gate)
- **Built:** `.githooks/commit-msg` (Conventional Commits, hard-enforced via `core.hooksPath`, auto-set by npm `prepare`); `.github/workflows/ci.yml` (typecheck + unit + `vsce package`, SHA-pinned, `contents: read`, no publish); `.github/dependabot.yml` (actions + npm). Loop now COMMITs + pushes each green pass.
- **Operator decisions:** Conventional Commits + commit-msg hook; CI now (test + build). Push allowed while repo private.
- **Limitation:** this box's fine-grained PAT isn't scoped to `mermaid-node-editor`, so CI run status is NOT observable from here (`gh run list` → 404; SSH push still works). The local TEST gate mirrors CI's test step, so it's the authority; CI is a backstop. To check CI from here, add the repo to the PAT's repository access.
- **Next:** IT-1 (xvfb runtime smoke); CI gains the xvfb integration job at IT-2.

### 2026-06-05 · IT-0 — Baseline + git · CONTINUE (no gate)
- **Built:** added `repository` field to `package.json` (assumed `github.com/ssud11/mermaid-note-editor.git`); added `artifacts/` + `.claude/settings.local.json` to `.gitignore`.
- **TEST:** typecheck clean · 22/22 unit tests pass · esbuild → `dist/extension.js` 9.5 kb. Green.
- **CHECK:** `git init` + initial commit `c82be81` on `main` (22 files; node_modules/dist/out excluded).
- **Follow-up for operator (NOT blocking; needed by IT-5):** repo `ssud11/mermaid-node-editor` created (private, browser-confirmed) but the 2 local commits are NOT pushed — this box's fine-grained PAT is scoped to 3 other repos and can't push here. Grant the token access to this repo (or use SSH), then `git remote add origin … && git push -u origin main`. The loop runs local-only until IT-5, so no rush.
- **Next:** IT-1 (xvfb runtime smoke + screenshots) → will end at a REVIEW-GATE for your visual/F5 sign-off.
