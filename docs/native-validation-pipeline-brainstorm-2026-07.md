# Native Post-Implementation Validation — Rethinking the No Mistakes Integration (July 2026)

**Concept:** Replace the external [no-mistakes](https://github.com/kunchenguid/no-mistakes) CLI integration with a **native, in-app validation pipeline** for the post-implementation phase of a session — the moment the agent finishes coding and the question becomes "is this actually good, and can it ship?" We dissected the no-mistakes codebase (two deep-dive passes over its Go source), mapped our own native building blocks, and swept the state of the art (Conductor, Sculptor, Vibe Kanban, Claude Code `/code-review`, Codex review, Graphite Diamond, self-healing CI, LLM-as-judge research).

Status: **research complete, brainstorm — decisions pending (July 2026).** Supersedes the "No Mistakes: fully separate feature" stance in `conductor-inspired-features-brainstorm-2026-07.md` §3.

---

## 1. Why rethink

The current integration (`no_mistakes.rs`, `noMistakes.ts`, `NoMistakesPanel.svelte`) wraps an external binary and pays for it everywhere:

- **TOON parsing is entirely heuristic** — three fallback finding parsers, token-boundary outcome matching, every event carries `raw` as a fallback because we never had real output samples (`no_mistakes.rs:617`+ and its ~400 lines of extractor tests).
- **Not persisted** — `nmRuns` is an in-memory map; runs vanish on restart (unlike `SessionPrSummary`, which is mirrored onto `SdkSession.pr`).
- **External-binary friction** — install/init flows, `nm_bin()` path resolution, terminal-window installer, the `no-mistakes` git remote as an init marker.
- **Process-polling architecture** — `axi status` respawned every 2.5s; gate-vs-done decided by scanning captured child output.
- **Lossy intent** — `buildIntent` collapses the session to a 1500-char single line, when we natively hold the user's literal voice prompts, cleaned transcripts, screenshots, and AI metadata.
- **Redundant apparatus** — no-mistakes' daemon, bare gate repo, post-receive hook, and disposable worktree exist *only* to intercept `git push` from an arbitrary shell and survive shell exit. We own the session, its cwd, its worktree, and its lifecycle events. None of that machinery buys us anything.
- **Low exposure, low replacement risk** — the "No mistakes" button is `dev_mode`-gated (`SdkSessionHeader.svelte:139`); nothing user-facing breaks while we rebuild.

What no-mistakes gets deeply right — and what we must preserve — is its **concept layer**, not its transport.

---

## 2. What no-mistakes actually is (concepts distilled)

Fixed 9-step state machine (`intent → rebase → review → test → document → lint → push → pr → ci`), sequential executor with a per-step loop, SQLite state, driven headlessly via `axi` (TOON out). The transplant-worthy core:

### 2.1 The Finding model — keep verbatim
```
Finding { id, severity: error|warning|info, file, line, description,
          action: auto-fix | ask-user | no-op, source: agent|user, category }
```
- **`action` is the gate router**: `auto-fix` = objective/mechanical, eligible for the bounded fix loop; `ask-user` = intent-sensitive, always parks for a human; `no-op` = informational.
- **Fail-closed**: a finding with a missing/unknown action is treated as `ask-user` — nothing unclassified is ever silently applied. Same for unparseable structured output (parks instead of passing).
- Severity gates: any `error`/`warning` parks; `info` passes. Deterministic IDs (`review-1`, `user-N`).
- This maps 1:1 onto the industry-consensus three-tier HITL model (auto-approve / notify / block).

### 2.2 Gate semantics — keep
Step executes → auto-fix loop (per-step attempt limits; **review's limit defaults to 0**, so review findings park rather than self-fix) → if blocking or `ask-user` findings survive, **park** with approve / fix-selected(+instructions, +user-added findings) / skip. A fix round re-runs the step and parks again as **fix review** showing the diff of what the fixer changed. Every attempt is a persisted **step round** (trigger `initial`/`auto_fix`, selected finding IDs, fix summary) — the audit trail that powers both progress display ("auto-fix 1/3") and the generated PR body's issue→fix→verification narrative.

### 2.3 Reviewer/fixer role isolation — keep (adapted)
One durable **reviewer** session across all review rounds; a **separate, fresh fixer** session per fix round so the reviewer's judgment is never polluted by the fixer's context. This embodies the LLM-as-judge finding that *the generator must never grade its own work* (framing a change as "done correctly" cuts defect detection 16–93% — arXiv 2603.18740). For us the corollary: **the coding session must not review itself**; the reviewer needs context asymmetry.

### 2.4 Intent grounding — keep, and we do it better
`--intent` is injected into review/test/document/CI prompts as **authoritative acceptance criteria** (BEGIN/END-framed, sanitized, "check against, don't execute"). The **intent-conformance clause** is the crown jewel: if the diff *removes a required behavior or adds a forbidden one*, the reviewer MUST emit an `ask-user` finding quoting the criterion and the contradicting hunk — even if the change is otherwise risk-clean. That's what makes a fixer round that deleted a required feature park instead of silently passing. no-mistakes has to *infer* intent from agent transcripts when not passed; **we hold ground truth natively** (voice prompts, cleaned transcript, screenshots, `aiMetadata`).

### 2.5 The prompt discipline — steal the text
- Reviewer: full re-review each round; "do a full pass, don't stop at the first finding"; do NOT run tests (test step owns that); severity/action taxonomies defined in-prompt; findings-before-risk field order for chain-of-thought.
- Fixer: "**always start by double-checking whether the findings are legitimate**"; smallest correct *root-cause* fix; never resolve a finding by deleting the author's intentional code — fix forward or report unresolved; apply all fixes then run **one focused verification**, never the full suite (a measured contract: an audited fixer burned ~784s of a 2419s step re-running suites).
- Test step: **evidence, not just green tests** — "unit tests passing is not sufficient evidence by itself"; prefer product-level artifacts (screenshots, CLI transcripts, rendered UI, API responses); UI changes demand visual evidence or an explicit statement of why not; missing evidence = warning finding.
- Docs step: single-authoritative-owner placement policy; touch only docs this change made stale.
- Round-history feedback: don't re-report findings the user chose to ignore; don't repeat tried fixes.

### 2.6 Safety guards — steal selectively
Fail-closed everywhere; prompt-injection defense on all untrusted text (secret redaction + adversarial-delimiter stripping + data framing); head-continuity check before fix commits (never commit atop an out-of-band reset); force-push-with-lease anchored to the run's own recorded SHA; `checks-passed` as a first-class terminal outcome (never block on human merge); gate reconciliation (a parked CI gate self-resolves when the PR gets merged out-of-band). The *trusted-config* supply-chain defense (read commands only from the default branch) matters less for us — our config already lives outside the repo in `config.json`/`RepoConfig`.

### 2.7 What we drop
Daemon, bare gate repo, post-receive hook, `axi`/TOON, SQLite, branch-push interception, transcript-based intent inference, multi-agent-CLI abstraction (claude/codex/opencode/copilot/... — our sidecar already abstracts Claude + Codex). The disposable validation worktree becomes optional (§5.6).

---

## 3. What we already have natively (verified)

Replacing no-mistakes requires **almost no new primitive categories**:

| Concern | Existing building block |
| --- | --- |
| Turn-completion hook | `sdk-done` → `finalizeCompletion` (`sdkSessions.ts:938`); the `justFinished` effect that already force-refreshes PR state (`SdkView.svelte:399`) |
| Headless one-shot reviewer agent | `handleGenerateRepoDescription` pattern (`sidecar/index.ts:2590`): `query()` with restricted `allowedTools`, `settingSources: []`, an in-process MCP `submit_*` tool returning **schema-validated structured output** — a near-exact template for `submit_review` findings |
| Full agent session as pipeline step | sequences `execute_prompt` (`sequences/executor/nodes/prompt.rs:46`) |
| Cheap structured LLM judgment | `LlmClient::run_feature<T>` (`llm/features.rs:24`) — `analyze_interaction_needed` / `generate_quick_actions` are direct precedents for pass/fail verdicts and findings arrays |
| Native commit/push/PR-create | sequences nodes `GitCommitNode`/`GitPushNode`/`execute_github_pr` — exist, just not lifted into the interactive path |
| CI watch + merge | `fetch_branch_pr` (with `statusCheckRollup`), `PrPanel` 15s polling, `merge_github_pr` — **shipped** (PR lifecycle v1) |
| Worktree isolation | `create_git_worktree_only` / `create_worktree_with_setup`; sessions often already run in worktrees |
| Blocking decision-gate UX | plan approval: sidecar `canUseTool` promise-block + `PlanApprovalDialog` + `AnswerPlanApproval` — the native precedent for in-loop gates |
| Gate/stepper/findings UI | `NoMistakesPanel.svelte` itself (stepper, findings table with checkboxes, approve/fix/skip) — the UI survives the transplant |
| Panel slot | `SdkView.svelte:1879` (PrPanel + NoMistakesPanel pinned above the prompt input) |
| Findings-as-prompts | `issueActions.ts` compose-and-`sendPrompt` pattern; quick-action chips |
| Run persistence | the auto-persist-by-exclusion session store — mirror run state onto `SdkSession` like `SdkSession.pr` |
| Intent | voice transcript + cleaned prompt + screenshots + `aiMetadata` — richer than anything no-mistakes can infer |
| SDK hooks | Agent SDK Stop/PostToolUse hooks available through the sidecar for *in-loop* gating |

**Missing pieces are small:** a diff-scoped reviewer prompt/tool (`get_git_diff` doesn't exist yet — also wanted by the diff-viewer feature), native `commit`/`push` in `GitManager` (lift from sequences nodes), a `ValidationRun` state model with persistence, and orchestration glue.

---

## 4. State of the art — what the field converged on (July 2026)

1. **Generate-then-adversarially-verify is THE false-positive killer** (Claude Code `/code-review`): parallel specialized reviewers → a per-finding verification subagent that must confirm "truly an issue with high confidence" → drop everything unverified. Published FP data backs it (Graphite Diamond: 82% of findings lead to actual fixes; raw LLM reviewers hallucinate confidently — 80+ agents once unanimously endorsed a non-existent OpenSSL vulnerability).
2. **Severity floor + explicit do-NOT-flag list** (Codex reviews flag only P0/P1 by default; Claude's filter: won't-compile / definitely-wrong / cited-rule-violation only; no style, no maybes, no pre-existing issues). Precision is the product.
3. **Findings are prompts** (Conductor, Vibe Kanban, and the top HN critique of no-mistakes): close the loop to the *coding agent*, not just the human. Inline "send to agent" per finding; batch "fix selected" = one follow-up turn.
4. **One consolidated "ready to ship?" surface** (Conductor's Checks tab): git status + findings + CI + review threads + todos in one panel, unresolved items styled as blockers.
5. **Evidence-based pass claims** (Claude `/verify`): every green step carries its proof — command, exit code, output snippet; bug fixes want red-without/green-with regression proof. Ban "should work."
6. **In-loop gating via Stop hooks**: block the agent from *finishing the turn* until typecheck/tests pass — validation before "done" is even rendered. Claude Code hooks now include `prompt` (Haiku evaluator) and `agent` (subagent verifier) handler types.
7. **Cheap-model pre-flight**: a Haiku-class call decides whether validation is warranted at all (doc-only/trivial diffs skip).
8. **Intent-vs-diff verdicts** (IntentGuard: ALIGNED/MISALIGNED/UNCLEAR): agent PRs measurably suffer "message-code inconsistency" (claimed-but-phantom changes); checking the diff against stated intent is cheap and high-value.
9. **Self-healing CI** (Nx, GH Agentic Workflows): on red, classify transient-vs-real, fix, validate by re-running only the originally failed checks. no-mistakes' `ci` step already does this; ours can too via `fetch_branch_pr` + `gh run view --log-failed`.
10. **Per-repo review guidelines** (Codex `## Review guidelines` in AGENTS.md): a `RepoConfig.review_guidelines` field feeding the reviewer prompt is our analog — alongside existing per-repo vocabulary/keywords.

---

## 5. Proposed design — the native pipeline

### 5.0 Shape

A **per-session Validation Run**, orchestrated in Rust (new `src-tauri/src/validation/` module — the successor to `no_mistakes.rs`), state mirrored to the frontend via typed events (no parsing layer at all), persisted onto the session. Steps are internal, not user-composable (the sequences engine remains the power-user composable substrate; this is a product feature with a fixed, opinionated flow — same reasoning as no-mistakes' non-reorderable steps).

**Proposed step set** (ours, not a 1:1 copy):

`intent → review → test → docs+lint (combined housekeeping) → ship (commit/push/PR) → ci`

- **intent** is free: compose from user messages (verbatim, not collapsed), cleaned transcripts, `aiMetadata.name/outcome`, and screenshots. No inference step needed. Provenance is always "authoritative."
- **rebase** drops out of v1: sessions run on fresh worktree branches created minutes earlier; staleness is rare. Add later as a pre-ship "sync with default branch" check (we already have `get_git_default_branch` + fetch).
- **docs+lint combined** by default (no-mistakes' own optimization when no lint command is configured); split when `RepoConfig` gains explicit test/lint commands.
- **ship + ci** largely exist as PR lifecycle v1 — the validation pipeline becomes the front half of one continuous flow ending in `PrPanel`'s checks/merge.

### 5.1 The reviewer — headless one-shot on the session's cwd

Clone the repo-description generator pattern: new sidecar handler (`review_changes`) that runs `query()` with `cwd` = session worktree, `allowedTools: [Read, Glob, Grep, Bash(git diff/log only), submit_review]`, `settingSources: []` (identity neutralization — same reason no-mistakes passes `--setting-sources user`), and a `submit_review` in-process MCP tool whose schema is the Finding model + `risk_level`/`risk_rationale` + summary. Prompt = no-mistakes' review prompt (§2.5) + intent block with the conformance clause + per-repo review guidelines + the do-NOT-flag list (§4.2).

- **Model/account routing:** reviewer runs on a *different* model than the session by default (context asymmetry + cost): e.g. Sonnet-class for review, with an effort setting. Rides the existing per-account env rail, so validation can even use a different account's quota.
- **Adversarial verify as an effort tier:** at higher effort, each `error` finding gets a verification one-shot ("confirm this is truly an issue; default to refuted if uncertain") before it's allowed to gate. This is the single highest-leverage quality mechanism found in research.
- **Durable reviewer across rounds:** resume the same reviewer session id for fix re-reviews (cheap with SDK `resume`), keeping fixers out of its context.

### 5.2 The fixer — the session itself (our biggest divergence)

no-mistakes spawns an isolated fixer because it has no session to return to. **We do.** "Fix selected" composes the selected findings (+ per-finding user instructions) into a prompt and sends it to the **session's own agent** — full implementation context, visible in the transcript, interruptible, and exactly the loop-closing the field converged on (§4.3). The reviewer then re-reviews (fresh diff) → fix-review gate.

- Keep an "isolated fixer" option for later (batch/unattended mode), but v1 = session-as-fixer.
- Auto-fix loop: bounded per step (default review 0 / test 3 / lint 3 / ci 3, mirroring no-mistakes), auto-selecting `action == 'auto-fix'` findings. With review's limit at 0, review always parks first — the user is in the app; parking is cheap here, unlike a headless push gate.
- Steal the fixer discipline lines into the fix prompt (double-check legitimacy first; root-cause; fix forward; one focused verification, no full suites).

### 5.3 Test step — commands + evidence

- Deterministic baseline: `RepoConfig.commands.{test,lint,format}` (new fields; the launch-profile machinery is adjacent precedent). Non-zero exit → blocking finding with the output attached.
- **Evidence mode** (the differentiator): when intent exists (always, for us), a one-shot agent gathers *product-level proof* the intent is satisfied — screenshots (we have `capture_screenshot` + the image pipeline), CLI transcripts, rendered output — returning `tested[]`, `testing_summary`, `artifacts[]`. Artifacts render in the panel and later in the PR body. Missing-evidence = warning finding, per the no-mistakes prompt.
- Every green step carries its proof (command + exit code + snippet) in the UI — no unproven checkmarks (§4.5).

### 5.4 Gates — native UI, plan-approval-grade

Reuse `NoMistakesPanel`'s stepper/findings-table/approve-fix-skip skeleton, now fed typed events (`validation-step-{id}`, `validation-gate-{id}`, `validation-done-{id}`) instead of parsed TOON. Upgrades:

- **Sub-15-second gate cards:** finding = what / why / patch-preview (once `get_git_diff` exists) / severity + action chips; auto-fix findings pre-checked (already the behavior at `noMistakes.ts:211`).
- Batch approve; per-finding "send to agent" one-click; user-added findings ("also fix X" — voice input is a natural fit here).
- **Fix-review gates show the diff** of what changed since the gate (no-mistakes' `fix_review` + `git.DiffHead` behavior).
- Summary-only-when-clean: a clean run collapses to one green line, not a seven-step ceremony.

### 5.5 Triggers — three tiers of eagerness

1. **Manual** (v1): the existing header button, now un-dev-gated. Also a quick-action chip ("Validate changes").
2. **Auto after turn** (v2, per-repo/per-session opt-in): hook the `justFinished` effect / `finalizeCompletion` — after a turn that changed files (`count_changed_files` > 0), auto-run a *pre-flight* (cheap LLM: "does this diff warrant review?") and start a run. This is Sculptor's always-on "Suggestions" shape.
3. **In-loop** (v3, exploratory): SDK Stop hook via the sidecar — block turn completion until typecheck/tests pass, with `stop_hook_active`-style loop guard and attempt caps. Powerful but riskier UX (fights with voice-driven fire-and-forget); prototype behind a setting.

### 5.6 Where it runs — in place, not a separate worktree (v1)

no-mistakes validates in a disposable worktree so you can keep working in the original checkout. Our sessions **already** run in dedicated worktrees; the "keep working" property holds by construction. v1 validates in the session's cwd (uncommitted changes included — commit happens at the ship step). A later "frozen snapshot" mode (validate a copy while the session keeps mutating) only matters once auto-triggered background validation exists.

### 5.7 State + persistence

`ValidationRun { id, sessionId, status, steps: [{name, status, rounds, findings, evidence, proof}], startedAt, ... }` in the Rust manager (like `NoMistakesManager`), with a summary mirrored onto `SdkSession.validation` via the auto-persist pattern (badge + restore-on-restart — fixing today's biggest gap). Step rounds persisted for the audit trail → generated PR body ("Intent / What changed / Risk / Testing / Pipeline narrative" — steal the deterministic PR-body generator concept outright).

### 5.8 Config surface

- `RepoConfig`: `commands { test, lint, format }`, `review_guidelines` (free text → reviewer prompt), `auto_fix_limits?`, `validation_trigger` (manual / auto / off), reviewer model/effort override.
- Settings → a "Validation" section (or fold into the existing per-repo Repository Settings card).

---

## 6. Subsessions and session grouping

The pipeline spawns agent work (reviewer, evidence gatherer, maybe an isolated fixer) *about* a session. Does that work get session identity of its own — and more broadly, how should related sessions group, if at all?

### 6.1 What exists today

- **Relationships are flat metadata, not hierarchy:** `forkInfo.parentSessionId` (fork lineage), `githubIssue`, `notionCard`, pile items' linked-session lists, `SdkSession.pr` — all badges/back-references on sibling sessions in one flat list. Sequence-engine sessions (`seq-{exec}-{node}`) surface as sequence executions, not as child sessions.
- **True subagents already have a rendering home:** SDK Task/subagent spawns render *inside* the parent transcript as collapsed `SdkTaskBlock`s and defer completion (`liveSubagentIds`). They never appear in the sidebar.
- **Sidebar grouping is in flight** (`sessionGrouping.ts`, uncommitted): repo → worktree groups with collapse state, and the hard-won constraint that Ctrl+1–9 / Ctrl+W ordering must follow rendered order (`applySessionGrouping`). Notably, since our flow is one task = one worktree, **worktree grouping already *is* task grouping in practice**.

### 6.2 Do validation agents get session identity? (recommendation: mostly no)

Per role:

- **Reviewer / evidence / pre-flight (v1): not sessions.** Use the headless one-shot pattern (`Generate*`-style sidecar handlers). They are steps of a run, not conversations — no follow-up interaction, fixed lifecycle, and each would otherwise spam the sidebar every validation round. Keep observability without identity: capture the one-shot's transcript text + usage onto the `ValidationRun` step (a "View reviewer transcript" drawer in the panel, like the current log tail), and attribute its cost to the parent session in `usageStats` (tagged `validation`).
- **Fixer (v1): the session itself** (§5.2) — nothing new to model; fix rounds are ordinary turns in the parent transcript.
- **Isolated fixer / batch-unattended mode (later): real sessions, hidden by default.** If a fixer needs tool-driven multi-turn work outside the parent transcript, give it a real session with a generalized link: `SdkSession.parentSessionId` + `sessionRole: 'validation-fixer' | ...` (generalizing `forkInfo` into the one parent/role model). `useDisplaySessions` filters `sessionRole != null` out of the sidebar; the run panel is their surface (live status chip → click opens as a pane). Auto-close on run completion. Hidden sessions must also be excluded from hotkey ordering — same shape as the collapsed-group handling in `applySessionGrouping`. Optional escape hatch: a "show system sessions" toggle for debugging.

The dividing line: **a session deserves sidebar identity only if the user might talk to it.** Reviewers are read-only oracles; fixers-in-parent are turns; only detached interactive work earns a row.

### 6.3 Grouping model (recommendation: links + the in-flight worktree grouping, no tree)

- **Don't build a session tree in the sidebar.** A narrow sidebar with three-plus nesting levels (repo → worktree → parent → children) fights the number-badge hotkey model and buys little once role-sessions are hidden. The in-flight repo → worktree grouping plus hidden children covers the hierarchy need.
- **Generalize links instead:** the five ad-hoc relationships (fork, pile, issue, Notion, validation parent) are all "this session originated from X." A light `SessionLink`-ish convention — origin badge in `SessionListItem` + a "related sessions" affordance in the header — gives navigation without hierarchy. Low priority; the badges mostly exist.
- **Explicit task groups only when a real feature needs them:** the concrete future trigger is **best-of-N attempts** (§4.10 — same prompt fanned out to N worktrees, compare, pick a winner). That's the one case worktree grouping can't express (one task, N worktrees). If/when built, stamp a `taskGroupId` at launch time in the batch launchers (`createSessionQueue` callers: pile separate/together, issues multi-select, a future attempts fan-out) and render it as a subheader within the repo group. Until then, skip it.
- **Validation runs group with their session, not beside it:** the run lives on `SdkSession.validation` and renders in the session's panel slot — it's session state, like `pr`, not a sibling entity in any list.

---

## 7. Architecture options considered

| Option | Verdict | Why |
| --- | --- | --- |
| **A. Rust `validation/` module + sidecar one-shots** (successor to `no_mistakes.rs`) | **Recommended** | Owns child processes (test commands), timers, event emission; typed end-to-end; mirrors the proven `NoMistakesManager` shape minus parsing. Reviewer/evidence agents via new sidecar `Generate`-style handlers. |
| B. Sequences engine as substrate (it already has git/GitHub/approval/AI nodes + `session_end` trigger) | Rejected as the engine, mined for parts | It's a general workflow engine — gates surface in sequence UI, not the session panel; AI nodes are heavyweight full sessions; YAML-composable where this feature wants a fixed opinionated flow. But **lift its git/gh node code** (`GitCommitNode`, `execute_github_pr`) into `GitManager`/`github_cmds` as shared native ops. |
| C. Frontend-orchestrated (TS store drives existing commands) | Rejected | Loses runs on window reload mid-step; child-process and polling lifecycles belong in Rust; frontend stays the view layer. |
| D. Keep wrapping the external CLI, improve parsing | Rejected | The premise of this doc: transport pain with no ownership of prompts, models, intent fidelity, or UX. |

**Relationship to the existing No Mistakes integration:** keep it untouched (dev-gated) while the native pipeline lands; deprecate/remove once parity is reached (review + test + gate + ship). Its prompts and gate model live on inside the native implementation.

---

## 8. Phasing

1. **v1 — Review + gate (the core loop):** `get_git_diff` (shared with the planned diff viewer), sidecar `review_changes` one-shot with `submit_review` schema, Finding model + fail-closed defaults, single review step with approve / fix-via-session / skip, findings-as-prompts, panel evolved from `NoMistakesPanel`, `SdkSession.validation` persistence, manual trigger (un-dev-gated button + chip). *No new step machinery beyond one step.*
2. **v2 — Pipeline:** test step (repo commands + proof-carrying results), docs+lint housekeeping pass, step rounds + fix-review diffs, per-repo config (`commands`, `review_guidelines`), evidence artifacts, intent-conformance clause, adversarial verify at high effort.
3. **v3 — Ship integration:** native commit/push (lifted from sequences nodes) + PR-create with the deterministically generated body feeding into the existing `PrPanel` checks/merge — one continuous Validate → Ship → CI → Merge surface (Conductor-Checks-tab-ification of PrPanel). CI auto-fix loop (`gh run view --log-failed` → session prompt), bounded + deduped by failing-check set.
4. **v4 — Eagerness:** auto-trigger after turns (cheap pre-flight gate), background validation snapshots, Stop-hook in-loop gating experiment, voice-driven gate responses ("approve it", "fix one and three").

---

## 9. Open questions

1. **Reviewer transport:** sidecar one-shot `query()` (full tool access to read the repo; costs agent-quota) vs. `run_feature` cheap-LLM on a pre-computed diff (no repo exploration; Gemini/Groq-priced)? Lean: one-shot for review (needs to read surrounding code — no-mistakes' reviewer explicitly inspects call sites), `run_feature` for pre-flight and verdict-style checks.
2. **Where fix rounds land:** session-as-fixer puts fix turns in the main transcript (visible, but noisy and burns the session's context window). Alternative: isolated fixer session with the result surfaced as a diff. v1 = session-as-fixer for simplicity; revisit if transcript pollution annoys.
3. **Panel vs. merged ship surface:** separate ValidationPanel alongside PrPanel, or one combined "Ship" panel from day one? Lean: separate in v1, merge in v3.
4. **Effort/model defaults for the reviewer** — and should review cost count toward the session's usage stats (probably yes, tagged as validation)?
5. **Does the `docs` step earn its place** for a solo-developer app, or is docs+lint housekeeping enough? (no-mistakes' placement policy is aimed at multi-contributor drift.)
6. **Voice angle timing:** gate responses are a naturally voice-shaped interaction ("approve", "fix the first two", "skip it") — v1 or wait for the cockpit-adjacent grammar to settle? (Do not wire into cockpit unless the user brings it up.)
