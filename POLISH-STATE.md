# POLISH-STATE — Mermaid Node Editor → Marketplace

<!-- STATUS: v1.0.1 — the 4 HIGH bugs /deep-review found are FIXED (+10 unit regression tests + visual coverage); pre-public steps pending | next=ultrareview→scrub→publish | GATE: operator (resume in a fresh session) -->

## ⏭ Resume here — pre-public steps (new session)

Build complete; **v1.0.1** committed + pushed (was v1.0.0; bumped for the deep-review bug fixes). `.vsix` = `mermaid-node-editor-1.0.1.vsix`, publisher `ssud11`, repo `github.com/ssud11/mermaid-node-editor` (still **private**). Docs were trimmed to a lean, user-facing README (dev detail → `CONTRIBUTING.md`); commits no longer carry an AI co-author trailer. Remaining before public — all operator-driven:

1. **Ultrareview** — operator runs `/code-review ultra` (user-triggered + billed; an agent cannot launch it). Apply any fixes as clean commits (no trailer).
2. **Scrub for public** — operator runs `bash ~/scrub-mermaid-for-public.sh`: rewrites history to remove `CLAUDE.md` / `POLISH-STATE.md` / `.claude/` (kept on disk via `.git/info/exclude`) and strip the `Co-Authored-By: Claude` trailer + drop now-empty process-only commits. Review its verification output.
3. **Force-push** — `git push --force origin main` (the script prints it). An agent can read/verify git state but **cannot run the rewrite or force-push** (harness blocks destructive history ops — that's expected).
4. **Icon** — `icon.png` is still the generated placeholder; swap if desired.
5. **Go public + publish** — flip the repo public (the README GIF only renders once public; vsce rewrites the image to a GitHub raw URL), then upload the `.vsix` in the Marketplace UI or `vsce publish`.

> ✅ **The 4 HIGH bugs /deep-review found are FIXED in v1.0.1 (2026-06-06)** — see [reviews/deep-review-2026-06-06.md](reviews/deep-review-2026-06-06.md) for the findings. (1) inline dash/dotted/thick edge-label prose no longer corrupted on ID rename (`20f4e8a`); (2) YAML-frontmatter flowcharts now recognized (`7a49cc5`); (3) `;` statements parsed — edges not dropped/merged (`2cf36eb`); (4) edit-rejection errors stay visible (`4d6d1b0`). Each shipped with regression tests (+10 unit; #3 via the Playwright webview harness — `npm run visual`). 36/36 unit green, `vsce package` clean at 1.0.1. **Nothing outstanding here** — `/code-review ultra` (step 1) is now a clean second-opinion pass, not a must-fix.

Security review (this session): no secrets in tracked files; CSP + CSPRNG nonce, no `innerHTML`, scoped `WorkspaceEdit`, no runtime deps. The only pre-public concern was the AI-process files above (handled by the scrub).

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
- [x] **Runtime — automated** `@vscode/test-electron` smoke passes headless under xvfb — IT-1, exit 0
- [x] **Runtime — operator visual sign-off** — signed off 2026-06-05 on Playwright screenshots (dark/light/unsupported/empty in `artifacts/`)
- [x] `icon` field + `icon.png` (128×128) — **placeholder** (revisit before publish)
- [x] `repository` field in `package.json` — `github.com/ssud11/mermaid-node-editor` (private; operator-confirmed)
- [x] `CHANGELOG.md`
- [x] README: animated GIF hero (`images/demo.gif`) — recorded on xrdp + ffmpeg-optimized
- [x] Theme-matched UI (`--vscode-*` tokens; clean empty/unsupported states) — signed off IT-1; read-only subgraph id dimmed IT-3
- [x] `/code-review` (high) + security review — done; T1+T2 fixed, T3 documented
- [x] `vsce package` → `.vsix` builds, no warnings — 17.99 KB, 11 files, clean
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

### IT-1 — Runtime smoke + screenshots (xvfb)  · _status: DONE (smoke + Playwright visual; operator signed off 2026-06-05)_
- Stand up a minimal `@vscode/test-electron` harness; launch the real extension host headless under `xvfb-run`; open [examples/demo.mmd](examples/demo.mmd); capture screenshots of: panel populated, label edit, ID rename, subgraph title, `sequenceDiagram` unsupported notice → `artifacts/`.
- Fix obvious breakage in [panel.ts](src/webview/panel.ts) / [main.js](src/webview/main.js).
- **Accept:** smoke launches; screenshots captured. → **REVIEW-GATE** (your visual/F5 sign-off on the 5 behaviours).

### IT-2 — Automated integration assertions  · _status: DONE (write-back verified end-to-end)_
- Extend the harness into real assertions: activation · webview message round-trip · `WorkspaceEdit` write-back lands · ID-rename edge propagation end-to-end. Wire `npm run test:integration`.
- **Accept:** integration suite passes headless. _(continue)_

### IT-3 — UI / theme polish  · _status: DONE (read-only subgraph id dimmed; design already signed off IT-1)_
- [style.css](src/webview/style.css) → `var(--vscode-*)` tokens, spacing, focus rings, hover, empty + unsupported states. Re-capture light+dark screenshots.
- **Accept:** native look both themes; no hard-coded colors. → **REVIEW-GATE** (design taste).

### IT-4 — Marketplace metadata + assets  · _status: DONE (icon placeholder + CHANGELOG + galleryBanner; vsce package clean 17.99 KB)_
- `icon.png` (128×128) + `icon` field; `galleryBanner`; tidy categories/keywords; `CHANGELOG.md` (Keep-a-Changelog, `0.1.0`).
- **Accept:** `vsce package --dry-run` clean; icon renders. → **REVIEW-GATE** (icon design).

### IT-5 — README + GIF demo  · _status: DONE — animated demo hero (`images/demo.gif`, 5.5s/107KB) recorded + optimized_
- Screenshot + animated GIF of the edit→write-back flow; feature list; install/usage; supported-shapes table; known limitations.
- **Repo is PRIVATE** → bundle README images *inside* the `.vsix` (relative paths), NOT `raw.githubusercontent.com` URLs (those need auth and won't render on the Marketplace). Verify images render from the packaged extension.
- **Accept:** README renders well as a Marketplace landing page. → **REVIEW-GATE** (copy + GIF taste).

### IT-6 — Hardening + final CHECK  · _status: review done; T1+T2 fixed (7 bugs, +6 tests); T3 documented; .vsix 41.6 KB_
- `/code-review high` · `/simplify` · `/security-review` (verify CSP/nonce + no-innerHTML hold). Full sweep: typecheck + unit + integration + `vsce package` → `.vsix`.
- **Accept:** reviews clean; `.vsix` staged. → **REVIEW-GATE** (final sign-off → you publish).

---

## Iteration log (newest on top — REVIEW PACKETs land here)

### 2026-06-06 · Fixed the 4 HIGH deep-review bugs → v1.0.1 · DONE
- **Fixed (one `fix:` commit each, every one on a green gate + a regression test that fails on the old code):**
  - `20f4e8a` — `editor.ts protectedRanges`: protect inline dash/dotted/thick edge-label prose so an id rename can't rewrite words inside `A -- send A data --> B` (pipe form was already safe). +3 unit tests.
  - `7a49cc5` — `parser.ts buildBlock`: skip a leading `--- … ---` YAML frontmatter block so titled/configured flowcharts aren't marked "unsupported". +4 unit tests.
  - `2cf36eb` — `parser.ts parseEdges`: parse `;`-separated statements so edges aren't dropped/synthesized; also un-blinds the rename collision-guard (no more silent node merge). +3 unit tests (incl. the downstream editor guard).
  - `4d6d1b0` — `panel.ts` + `main.js`: rejected edits now send a single `{error, message, block}` (no follow-up `update` to wipe it) and the webview resets the field without hiding the error. Verified via the **Playwright webview harness** (`npm run visual`) — error-persist + field-reset assertions (fail on old `main.js`).
- **Version:** `1c0102f` — bumped 1.0.0 → **1.0.1** + CHANGELOG (operator: "fold as v1.0.1 for our records"). 36/36 unit green; `vsce package` clean → `mermaid-node-editor-1.0.1.vsix`.
- All 5 commits pushed to `main`. mermaid otherwise unchanged.

### 2026-06-06 · Tooling — built the `/deep-review` skill (separate from the release loop) · DONE
- **What:** operator + I built a reusable, local, multi-agent code-review tool (fan-out by lens → adversarially verify → synthesize) — the free, agent-runnable twin of cloud `/code-review ultra`. Approved plan: `/home/ssud11/.claude-account-b/plans/luminous-puzzling-squid.md` (copy in cowork `mermaid-note-editor/`).
- **Shipped:** `.claude/review.json` (4 curated lenses + scope) + `.claude/commands/deep-review.md` (command + embedded Workflow template + gated `--fix`); `reviews/` gitignored; commits `942e23d` + `969c7d4` (pushed). Promoted to a **global skill** in both account dirs (`~/.claude-account-{a,b}/skills/deep-review/SKILL.md`, byte-identical) — `/deep-review` now works in any repo.
- **Proven (all 3):** full-tree run (5→5 confirmed, parity PASS vs prototype, report written); scoped run (`src/parser.ts` → single lens, found the NEW `;` bug); `--fix` (applied rank-#1 fix → allowlist held → 26 tests green → bug fixed in repro → **reverted clean**). mermaid source untouched.
- **Output:** the 4 HIGH bugs above (see the ⚠ note at top + `reviews/deep-review-2026-06-06.md`). **Flagged, not fixed** — operator's call.

### 2026-06-05 · IT-5 GIF — animated demo hero · DONE (all roadmap complete)
- **Recorded** the real extension on the xrdp desktop (Peek → GIF), driving the ID rename `B → Auth`. First take 47s and missed the rename (edited the Label, not the ID); coached ID-vs-Label; second take nailed the ripple.
- **Processed** with ffmpeg: cropped the empty right, trimmed to the tight action window (6.5–12s), 12fps, scaled 900px, palette-optimized → `images/demo.gif` (5.5s, 107 KB).
- **Verified (not assumed):** reproduced against the real code that label/id edits preserve `{}` shape — the square brackets in the take were the operator's manual edit, not a bug.
- **Wired** as the README hero (replaced + removed the static `panel-dark.png`). `.vsix` = 12 files, 120.3 KB, GIF bundled.
- **IT-0 → IT-6 + GIF all complete.** Only the operator-only publish remains.

### 2026-06-05 · IT-6 — fixes (T1 + T2) + T3 docs · GATE: it6-final-signoff
- **Fixed (7):** first-open render race (handle webview `{type:'ready'}`); active-editor guard in `onDidChangeTextEditorSelection`; CSPRNG nonce (`crypto.randomBytes`); newline strip on edited values; `computeIdRename` — collision check now covers edge-referenced ids (no silent merge), skips the directive + subgraph-declaration lines (no keyword/title clobber), and protects arrow operators (single-char `x`/`o` ids safe).
- **Tests:** +4 unit regression tests (each fails against the OLD code) → 26/26 unit; +2 integration (newline collapse, ready handshake) → 8/8 integration. typecheck clean.
- **Documented (T3):** reversed arrows, `&` fan-out, `end`-as-id, unquoted `]`, `#quot;` round-trip → README "Known limitations".
- **Repackaged + reinstalled** the hardened `.vsix` (41.6 KB) into the operator's VS Code (reload window to load it).
- **GATE it6-final-signoff:** operator final review → operator publishes. Remaining: the IT-5 animated GIF (the "presenting" discussion).

### 2026-06-05 · IT-6 — code review (3 agents) · REVIEW-GATE: it6-bug-triage
- **Ran** a 3-agent review over parser.ts / editor.ts / panel.ts+main.js+extension.ts (no diff on clean main → reviewed full source). **Verified each finding against the code myself** (read editor.ts + parser.ts).
- **~15 real bugs** — tests were green but cover happy paths only. Triage:
  - **T1 (easy + impactful):** initial-render race (webview sends `{type:'ready'}` but onMessage has no handler → panel stays empty until the cursor moves — this is the "click into the diagram" behaviour); missing active-editor guard in `onDidChangeTextEditorSelection` (a non-focused editor can hijack the target doc — my IT-6 test gave false confidence here); `Math.random()` CSP nonce → use CSPRNG; label/id newlines not stripped (paste splits the line).
  - **T2 (silent rename corruption):** `computeIdRename` merges into bare referenced-but-undefined ids; rewrites tokens inside the `graph TD` directive line and subgraph titles; single-char ids `x`/`o` collide with `--x`/`--o` arrowheads.
  - **T3 (rare → document as v1 limits):** reversed arrows `<--` reversed in the connection list; `A & B` fan-out edges dropped; node literally named `end` dropped; unquoted label containing `]` truncated; `#quot;` escape non-reversible.
- **GATE:** operator scope decision — "ship v1, nothing more" → pick which tiers to fix vs document.

### 2026-06-05 · IT-5 — README screenshot (GIF deferred) · CONTINUE
- **Built:** added a centered panel screenshot (`images/panel-dark.png`, from the Playwright dark render) to the README. README was already comprehensive (features/usage/shapes/architecture/limitations) — left otherwise as-is.
- **Result:** `vsce package` clean — 12 files, 40.32 KB; image bundled.
- **Private-repo caveat:** vsce may rewrite the relative image to a GitHub raw URL needing auth → verify rendering at publish, or it resolves once the repo goes public.
- **Deferred (operator):** the animated **GIF** demo — operator wants to design the "cool live code-moving" demo as a dedicated presenting discussion after IT-6.
- **Next:** IT-6 (/code-review + /security-review + final .vsix).

### 2026-06-05 · Test hardening — multi-file/block/subgraph coverage · CONTINUE (no gate)
- **Why:** operator asked whether the multi-file / multi-block / subgraph behaviors were actually tested. They were NOT — only inferred from reading the code (`getBlockAtLine` had no direct test). Verification-discipline gap, owned and closed.
- **Built:** 4 new end-to-end assertions in `test/integration/suite/index.js`: (a) active-editor switching targets the focused file (covers split focus — same code path); (b) multi-block Markdown is cursor-scoped (a node outside the cursor's block can't be edited); (c) cursor outside any block → clear + edit no-op; (d) subgraph title write-back through the panel glue.
- **Result — all 4 PASS, no bugs.** The code behaves as described; now asserted under xvfb. Suite = IT-1 smoke + IT-2 write-back + these 4.
- **Bonus:** the commit-msg hook rejected a 74-char subject (limit 72) — hard enforcement confirmed working live.

### 2026-06-05 · IT-4 — Marketplace icon + CHANGELOG + metadata · CONTINUE (no gate)
- **Built:** `icon.png` (128×128, **placeholder** per operator — node-graph glyph; source `assets/icon.svg` + `assets/render-icon.js` via playwright-core). `icon` field + `galleryBanner` (#19222f dark) in package.json. `CHANGELOG.md` (Keep-a-Changelog, 0.1.0). `.vscodeignore` excludes `assets/`.
- **Result:** `vsce package` clean — **mermaid-node-editor-0.1.0.vsix, 11 files, 17.99 KB**; packaged set = package.json + icon + README + LICENSE + CHANGELOG + dist/extension.js + 3 webview assets (no test/dev-meta/source leakage). Gate green.
- **Next:** IT-5 (README + screenshot/GIF). README + a static screenshot can come from the Playwright shots (`artifacts/`); the animated GIF needs the live extension recorded (xrdp) → that part gates.

### 2026-06-05 · IT-3 — UI/theme polish · GATE: it4-icon-design
- **Built:** `style.css` — read-only subgraph id input now dimmed (`opacity .6` + `not-allowed` cursor), visually distinct from editable fields. Re-ran the visual harness → updated `artifacts/01-04`. The panel was already fully `--vscode-*`-token-based and signed off at IT-1, so no further changes warranted.
- **Result:** VISUAL PASS; TEST gate green. Design confirmed.
- **GATE — needs you:** IT-4's Marketplace **icon** (128×128) is a design-taste call. CHANGELOG + gallery metadata I'll do autonomously; the icon needs your direction (or "you generate a candidate").
- **Resume:** pick an icon direction → I produce icon + CHANGELOG + metadata, then IT-5 (README/GIF).

### 2026-06-05 · IT-2 — Write-back integration assertions · CONTINUE (no gate)
- **Built:** test seam — `activate()` now returns `{ provider }`; `MermaidEditorProvider.onMessage` made public. Extended `test/integration/suite/index.js` with end-to-end write-back assertions.
- **Result — PASS (real host, xvfb):** `nodeIdChanged` A→Z → `WorkspaceEdit` → `Z[Start]` **and** edge `B --> A` propagates to `B --> Z` (old `A[Start]` gone); `nodeLabelChanged` B→Halt → `B[Halt]`. The previously zero-coverage panel.ts glue is now verified. typecheck + 22 unit green.
- **Decision:** the integration suite stays **local-only** (loop CHECK), NOT in CI — same rationale as the visual harness (keep CI lean; the 240 MB VS Code download per run isn't worth it for a solo repo). Say the word to gate it on every push instead.
- **Next:** IT-3 (UI/theme polish) — the panel already uses `--vscode-*` tokens throughout and you signed off on the look at IT-1, so this is likely light → ends at a design-taste gate.

### 2026-06-05 · IT-1 visual — Playwright webview screenshots · GATE: it1-visual-signoff (screenshots ready)
- **Built (operator request — "use playwright"):** `test/visual/{harness.html,snap.js}` — renders the REAL webview (style.css + main.js) in chromium via `playwright-core`, reusing this box's chromium-1224 (no download; Gotcha 30 GL flags `--disable-gpu` + `LIBGL_ALWAYS_SOFTWARE=1`). `npm run visual` → 4 PNGs in `artifacts/` + DOM assertions. Local-only (not CI), per operator choice.
- **Decision resolved:** the earlier "headless webview screenshots impractical" call is superseded — Playwright on the *isolated webview* works well and is the visual layer going forward (also serves IT-3 theme polish).
- **Result — VISUAL PASS:** screenshots reviewed (by me): panel renders clean + native in dark & light; node/subgraph cards correct; **injection-safe confirmed visually** (`<b>End</b>` + `<img src=x>` render as literal text); unsupported notice correct.
- **REVIEW PACKET — your sign-off:** open `artifacts/01-populated-dark.png` · `02-populated-light.png` · `03-unsupported-dark.png` · `04-empty-dark.png`. Confirm the design reads right. (A real xrdp F5 is still welcome for true end-to-end, but the wiring is already proven by the test-electron smoke.)
- **Resume:** "signed off" (+ any design tweaks → IT-3 backlog) → loop continues to IT-2.

### 2026-06-05 · IT-1 — Runtime smoke (xvfb) · REVIEW-GATE: it1-visual-signoff
- **Built:** `test/integration/runTest.js` + `suite/index.js` — headless extension-host smoke via `@vscode/test-electron`; `npm run test:integration` (xvfb). `.vscode-test/` added to .gitignore; `.vscodeignore` tightened (excludes .github/.githooks/.claude/dev-meta from the `.vsix`).
- **Bug found + fixed:** the host sets `ELECTRON_RUN_AS_NODE=1`, so the downloaded VS Code launched as plain Node and rejected every flag (`bad option`, exit 9). `runTest.js` now strips it. Tell: `code --version` printed `v24.15.0` (the Node version).
- **Result — PASS (exit 0):** extension loads + activates; commands `mermaid-node-editor.open/.refresh` registered; `demo.mmd` opens; **`resolveWebviewView` runs clean** (the zero-coverage panel.ts path). Unit gate still 22/22.
- **REVIEW PACKET — needs you:**
  - **Design call:** headless *webview screenshots* aren't practical via the extension-test API. Recommend the visual half of "Both" be your **xrdp F5 pass**; the automated smoke covers the runtime/activation path (and runs in CI at IT-2).
  - **Your visual/F5 sign-off:** open this folder in VS Code on xrdp → F5 → open `examples/demo.mmd`, cursor inside → confirm: panel populates · label edit writes back · ID rename updates all edges · subgraph title edits · `sequenceDiagram` shows the unsupported notice.
  - **FYI:** one moderate `npm audit` finding via `@vscode/test-electron` (dev-only, transitive); not auto-fixing under `--force` without your ok.
- **Resume:** set `GATE: none` (add any fixes as new backlog items) → loop continues to IT-2 (turn the smoke into assertions + add the integration job to CI).

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
