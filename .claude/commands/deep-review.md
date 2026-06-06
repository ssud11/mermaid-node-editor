---
description: Deep multi-agent code review — fan out reviewers by lens, adversarially verify each finding, synthesize a ranked report. Full-tree by default; optional path scope; optional --fix applies confirmed findings. The local, free, self-owned twin of cloud /code-review ultra.
argument-hint: "[optional path to scope] [--fix]"
---

# /deep-review — local multi-agent code review

Runs a **local, multi-agent code review** of the current repo via the `Workflow` tool. Three phases:
**Review** (one reviewer per lens) → **Verify** (an adversarial skeptic tries to *refute* each finding) → **Synthesize** (dedupe + rank survivors). It reads the working tree directly — no diff, no PR, no upload — so it works on a clean tree and a private repo. It is the agent-runnable, free, unlimited equivalent of the billed cloud `/code-review ultra` (which an agent cannot launch).

> This command instructs you (Claude) to author a Workflow script for the current repo and invoke the `Workflow` tool — a valid Workflow opt-in path. Follow the steps below precisely.

---

## Procedure

### 0. Parse arguments (`$ARGUMENTS`)
- A non-flag token → **target path** (a subdir or file, relative to repo root).
- `--fix` → enable the gated fix flow (step 7). Default off.
- No path → **full-tree audit**.

### 1. Resolve the review target
- **No path:** enumerate reviewable source files:
  ```bash
  find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
    -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' -o -name '*.rb' \
    -o -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \
    -o -name '*.html' -o -name '*.css' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/out/*' \
    -not -path '*/build/*' -not -path '*/.git/*' -not -path '*/vendor/*' \
    -not -path '*/.vscode-test/*' -not -path '*/target/*' -not -path '*/__pycache__/*'
  ```
  (Plus any `excludeGlobs` from review.json.)
- **Path given:** restrict to that subtree/file. Drop any lens whose `files` globs don't intersect the target. If a single file is targeted, collapse to one lens reviewing just that file.

### 2. Load review config
- **`.claude/review.json` present** → use it. Fields: `projectName`, `confidenceThreshold` (default 60), `models` (per-phase tier), `scopeNotes`, `knownLimitations[]`, `excludeGlobs[]`, `lenses[]` (each `{key, files:[globs], focus}`). Intersect `lenses` with the resolved target.
- **Absent → auto-detect** (the common case for the global skill):
  - Detect stack from marker files (`package.json`+`tsconfig.json` → TS; `engines.vscode` → VS Code ext; `pyproject.toml`/`requirements.txt` → Python; `go.mod` → Go; `Cargo.toml` → Rust).
  - Build **default lenses** (cap ~6–8, grouped by top-level source dir): a *core/logic* lens, a *boundary/IO/glue* lens, and an always-present *conventions+security* lens (secrets, injection, input validation, dependency surface).
  - Build **scope context** from the repo's `CLAUDE.md` (if present) + `README.md` (extract a "Known limitations"/"Caveats"/"Not supported" section if present). **If a section is absent, say so explicitly in CONTEXT — never invent limitations.** If neither doc exists, fall back to: "No scope docs found; report only clearly-real bugs, be conservative."
  - Default `models`: `{ review: "sonnet", verify: "sonnet", synthesize: "opus" }`.

### 3. Stamp the date
Run `date +%F` once via Bash → `REVIEW_DATE` (e.g. `2026-06-06`). **This is how the date enters the run** — the Workflow scanner bans the literal tokens `Date.now()` / `new Date()` / `Math.random()` anywhere in the script (even inside strings), so never write those.

### 4. Author and run the review Workflow
Fill the template in **§ Workflow template** below with the resolved values:
- `REPO` = absolute repo path · `TARGET` = "full tree" or the path · `REVIEW_DATE` · `CONFIDENCE_MIN` = `confidenceThreshold` · `MODELS` = the resolved per-phase object.
- `CONTEXT` = a scope-rules string built from `scopeNotes` + `knownLimitations` (or the auto-detected scope).
- `LENSES` = an array of `{ key, prompt }`, one per resolved lens, where each `prompt` = `CONTEXT` + `"\n\nYOUR LENS: <key>. <focus>\nRead these files IN FULL (paths relative to REPO): <files joined>."`

Invoke the `Workflow` tool with the filled script. It returns
`{ totalRaised, confirmed, confirmedFindings, synthesis, target, reviewDate }`.

### 5. Write the markdown report
`mkdir -p reviews` then **Write** `reviews/deep-review-${REVIEW_DATE}.md` (suffix `-2`, `-3` … on same-day collision). Structure:
```md
# Deep Review — <projectName> — <REVIEW_DATE>
Target: <full tree | path>   ·   Lenses: <keys>
Raised: <n>   ·   Confirmed (isReal & conf ≥ <MIN>): <n>   ·   Refuted/below-threshold: <n>

## Summary
<synthesis.summary>

## Ranked findings
### 1. <title>  [<severity>]
- **File:** `<file>`:<line>
- **Why it matters:** <why>
- **Suggested fix:** <suggestedFix>
- **Verdict:** isReal=<…>, confidence=<…>
…

## Refuted / below threshold (transparency)
- <title> — `<file>` — conf <…> — <one-line reasoning>

## Run metadata
Agents: <n> · Tokens: <n> · Duration: <m> min · Models: review=<…>/verify=<…>/synthesize=<…>
```
(`reviews/` is gitignored — reports stay local.)

### 6. Print the terminal summary (always)
Target · raised/confirmed counts · the ranked one-liners (`#<rank> [<sev>] <title> — <file>:<line>`) · the report path.

### 7. If `--fix`: apply confirmed findings (gated; never auto-commits)
1. **Pre-flight.** `git status --porcelain`. If any unstaged change overlaps a file a finding will touch → **STOP**, tell the operator to commit/stash first.
2. **Apply pass.** For each confirmed finding in ranked order: re-read the cited file FRESH, apply the **minimal** edit implementing `suggestedFix`, touching **only** files named in that finding. If the fix is ambiguous or would creep scope → skip it and record why. (You may delegate each finding's edit to one agent for isolation; apply per-file sequentially to avoid clobbering.)
3. **Allowlist assert.** After all edits, `git status --porcelain` must show only files in `union(confirmedFindings[].file)`. Any stray file changed → **STOP** and report (nothing is committed regardless).
4. **Re-verify.** Run the repo's checks (from review.json/CLAUDE.md, else detected from `package.json` scripts). For this repo: `npm run typecheck` · `npm test` · `npm run compile`. **Any failure → STOP, do NOT auto-revert**; report the likely-culprit finding (last applied before failure).
5. **Leave uncommitted.** Never `git add/commit/push`. Print: per-finding applied/skipped table, `git diff --stat`, and the test results. The operator inspects and commits manually.

---

## Workflow template

Author this as the `Workflow` `script`, substituting the `${...}` placeholders (resolved in steps 1–4). **No `Date.now()`/`new Date()`/`Math.random()` anywhere.**

```js
export const meta = {
  name: 'deep-review',
  description: 'Multi-agent code review: fan out reviewers by lens, adversarially verify each finding, synthesize a ranked report',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens' },
    { title: 'Verify', detail: 'adversarial skeptic tries to refute each finding' },
    { title: 'Synthesize', detail: 'dedupe + rank survivors' },
  ],
}

const REPO = '${REPO}'
const TARGET = '${TARGET}'              // "full tree" or the path arg
const REVIEW_DATE = '${REVIEW_DATE}'   // passed in from `date +%F`
const CONFIDENCE_MIN = ${CONFIDENCE_MIN}
const MODELS = ${MODELS_JSON}          // e.g. { review:'opus', verify:'opus', synthesize:'opus' }
const CONTEXT = `${CONTEXT}`           // scope rules built from review.json or CLAUDE.md/README
const LENSES = ${LENSES_JSON}          // [{ key, prompt }]

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' },
      severity: { type: 'string', enum: ['critical','high','medium','low'] },
      category: { type: 'string' }, description: { type: 'string' }, evidence: { type: 'string' },
    },
    required: ['title','file','line','severity','category','description','evidence'],
  } } },
  required: ['findings'],
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { isReal: { type: 'boolean' }, confidence: { type: 'number' }, reasoning: { type: 'string' } },
  required: ['isReal','confidence','reasoning'],
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    rankedIssues: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        rank: { type: 'number' }, title: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' },
        severity: { type: 'string' }, why: { type: 'string' }, suggestedFix: { type: 'string' },
      },
      required: ['rank','title','file','line','severity','why','suggestedFix'],
    } },
  },
  required: ['summary','rankedIssues'],
}

phase('Review')
const results = await pipeline(
  LENSES,
  (lens) => agent(lens.prompt, { label: `review:${lens.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, model: MODELS.review }),
  (review, lens) => {
    if (!review || !review.findings || review.findings.length === 0) return []
    return parallel(review.findings.map((f) => () =>
      agent(
        `${CONTEXT}

Another reviewer flagged a potential issue. ADVERSARIALLY VERIFY it — try to REFUTE it. Read the actual code at the cited location and its surrounding context. Default to isReal=false if you cannot concretely confirm it from the code.

FINDING (from lens "${lens.key}"):
- Title: ${f.title}
- File: ${f.file}   Line: ${f.line}
- Severity claimed: ${f.severity}
- Category: ${f.category}
- Description: ${f.description}
- Evidence given: ${f.evidence}

Reject it if: it is a documented limitation, out-of-scope-by-design, a false positive that doesn't hold against the actual code, or a purely theoretical/pre-existing issue that cannot actually trigger for a user. confidence is 0-100 for how sure you are of your verdict.`,
        { label: `verify:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: MODELS.verify }
      ).then((v) => ({ ...f, lens: lens.key, verdict: v })))
    )
  }
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict && f.verdict.isReal && f.verdict.confidence >= CONFIDENCE_MIN)
log(`Raised ${all.length}; ${confirmed.length} survived (isReal && confidence>=${CONFIDENCE_MIN}).`)

if (confirmed.length === 0) {
  return { totalRaised: all.length, confirmed: 0, confirmedFindings: [], synthesis: null, target: TARGET, reviewDate: REVIEW_DATE }
}

phase('Synthesize')
const synthesis = await agent(
  `${CONTEXT}

Here are the findings that SURVIVED adversarial verification (JSON). Dedupe any that are the same underlying bug, rank by real-world severity/impact, and for each give a crisp "why it matters" + a concrete suggestedFix (file + approach). Be honest if some are marginal.

CONFIRMED FINDINGS:
${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: MODELS.synthesize }
)

return { totalRaised: all.length, confirmed: confirmed.length, confirmedFindings: confirmed, synthesis, target: TARGET, reviewDate: REVIEW_DATE }
```

---

## Notes
- **Cost/scale:** number of Review agents == number of lenses (cap ~6–8), NOT number of files — lenses read multiple files each. Verify fans out per surviving finding. The mermaid full-tree run was ~12 agents / ~684k tokens / ~15 min.
- **Opt-in:** invoking this command is the operator's explicit request to run a Workflow.
- **Relationship to cloud ultra:** `/code-review ultra` is a billed, user-only cloud fleet. This is the local, free, automatable counterpart — use it for everyday/automated runs; reach for cloud ultra as an occasional managed second opinion.
