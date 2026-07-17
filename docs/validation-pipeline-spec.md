# Validation Pipeline — Implementation Spec (July 2026)

Binding contract for the native post-implementation validation feature. Design rationale lives in
`docs/native-validation-pipeline-brainstorm-2026-07.md`; this file is the source of truth for names,
types, commands, events, and behaviors. The existing No Mistakes integration (`no_mistakes.rs`,
`noMistakes.ts`, `NoMistakesPanel.svelte`) stays **untouched** (dev-mode-gated) — the new feature is
independent code named **Validation** everywhere. Never use the words "no mistakes" in new
code/UI/strings (referencing `no_mistakes.rs` as a code *pattern* to copy is fine).

Decisions from the user:
- Full v1+v2+v3 scope in one build (review/test/docs/lint pipeline + gates + fix-via-session + ship + ci).
- **No auto-trigger, no SDK Stop hooks.** Manual start only.
- **User picks which steps to run per run** (e.g. skip docs).
- Per-run reviewer **model + effort choice**, with defaults in settings; per-repo settings too.
- Feature name: **Validation** ("Validate" button, "Validation" panel).

---

## 1. Data model

Step order is fixed; the *set* is user-chosen per run. `StepName` (serde `snake_case` / TS string
union): `review | test | docs | lint | ship | ci`.

```rust
// src-tauri/src/validation/types.rs  (all serde camelCase for event payloads)
pub enum ValidationSeverity { Error, Warning, Info }          // "error"|"warning"|"info"
pub enum FindingAction { AutoFix, AskUser, NoOp }             // "auto-fix"|"ask-user"|"no-op"
// FAIL-CLOSED: when deserializing agent output, missing/unknown action => AskUser.

pub struct ValidationFinding {
  pub id: String,                    // deterministic: "<step>-<n>" for agent, "user-<n>" for user-added
  pub severity: ValidationSeverity,
  pub file: Option<String>,
  pub line: Option<u32>,
  pub description: String,
  pub action: FindingAction,
  pub source: String,                // "agent" | "user"
  pub user_instructions: Option<String>,
}

pub enum StepStatus { Pending, Running, Fixing, Gate, FixReview, Passed, Skipped, Failed }
pub enum RunStatus  { Running, Gate, Passed, Failed, Cancelled }

pub struct StepRound {
  pub round: u32,
  pub trigger: String,               // "initial" | "auto_fix" | "user_fix"
  pub findings: Vec<ValidationFinding>,
  pub selected_ids: Vec<String>,     // which findings were sent to the fixer
  pub fix_summary: Option<String>,
}

pub struct StepProof {               // evidence a step passed (rendered under the step)
  pub command: Option<String>,
  pub exit_code: Option<i32>,
  pub output_tail: Option<String>,   // last ~2000 chars
}

pub struct ValidationStep {
  pub name: StepName,
  pub status: StepStatus,
  pub rounds: Vec<StepRound>,
  pub findings: Vec<ValidationFinding>,   // current (latest round) findings
  pub proof: Option<StepProof>,
  pub note: Option<String>,               // e.g. "PR creation skipped: on default branch"
  pub transcript: Option<String>,         // reviewer/agent one-shot transcript text (drawer)
  pub risk_level: Option<String>,         // review only: "low"|"medium"|"high"
  pub risk_rationale: Option<String>,
  pub evidence: Option<EvidenceReport>,   // test only
  pub fix_review_diff: Option<String>,    // raw `git diff` text of what the fix round changed
  pub started_at: Option<u64>, pub finished_at: Option<u64>,
}

pub struct EvidenceReport {          // test step structured output
  pub tested: Vec<String>,
  pub testing_summary: String,
  pub artifacts: Vec<EvidenceArtifact>,  // { kind, label, path }
}

pub struct ShipProposal {            // ship gate payload (user-editable before execution)
  pub commit_message: String,
  pub pr_title: String,
  pub pr_body: String,
  pub base_branch: String,
  pub branch: String,
  pub has_uncommitted: bool,
  pub already_pushed: bool,
  pub existing_pr_url: Option<String>,   // if a PR already exists, ship only commits+pushes
  pub on_default_branch: bool,           // commit+push only, PR skipped
}

pub struct GateState {
  pub step: StepName,
  pub kind: String,                  // "findings" | "fix_review" | "ship" | "ci_failure"
  pub findings: Vec<ValidationFinding>,
  pub ship: Option<ShipProposal>,    // kind == "ship"
  pub diff: Option<String>,          // kind == "fix_review"
}

pub struct ValidationRun {           // the FULL snapshot emitted on every update event
  pub id: String,
  pub session_id: String,
  pub cwd: String,
  pub status: RunStatus,
  pub steps: Vec<ValidationStep>,    // only the user-selected steps, in fixed order
  pub gate: Option<GateState>,
  pub intent: String,
  pub options: RunOptions,
  pub pr_url: Option<String>,
  pub error: Option<String>,
  pub pending_fix: bool,             // a fix turn is being executed by the session
  pub started_at: u64, pub finished_at: Option<u64>,
}

pub struct RunOptions {
  pub steps: Vec<StepName>,
  pub reviewer_model: String,        // Claude model id, or "session" (= use the session's model)
  pub reviewer_effort: Option<String>,   // "low"|"medium"|"high" | None
  pub adversarial_verify: bool,      // error findings get a verify pass before gating
  pub base_branch: Option<String>,   // default: repo default branch
}
```

Timestamps: unix millis (`u64`). Runs are **in-memory only** in the backend (like
`NoMistakesManager`); a summary is mirrored onto the session frontend-side (§7) for
restart-surviving badges. One active run per session; starting a new run replaces a *finished*
run, errors if one is active.

## 2. Tauri commands (`src-tauri/src/commands/validation_cmds.rs`)

```
validation_start_run(session_id, cwd, repo_id: Option<String>, intent: String,
                     options: RunOptions) -> String  // run_id
validation_respond(run_id, action: "approve"|"skip"|"fix",
                   finding_ids: Option<Vec<String>>, instructions: Option<String>,
                   added_findings: Option<Vec<ValidationFinding>>) -> ()
validation_execute_ship(run_id, commit_message, pr_title, pr_body) -> ()   // answer to a "ship" gate
validation_fix_done(run_id, fix_summary: Option<String>) -> ()   // frontend: session fix turn finished
validation_fix_failed(run_id, error: String) -> ()               // frontend: session fix turn errored
validation_cancel(run_id) -> ()
```

Register in `lib.rs` alongside the `nm_*` commands; manager as `Arc<ValidationManager>` state.

## 3. Events (backend → frontend)

- `validation-update-{run_id}` — payload: the full serialized `ValidationRun`. Emitted on every
  state change. The frontend store just replaces its copy (no incremental patching).
- `validation-log-{run_id}` — `{ line: String }` streaming log (step lifecycle, command output lines).
- `validation-fix-request-{run_id}` — `{ step, findings: Vec<ValidationFinding>, instructions:
  Option<String>, round: u32, trigger: "auto_fix"|"user_fix" }`. The frontend composes a fix prompt
  and sends it to the session's own agent (§6), then reports back via `validation_fix_done/_failed`.
- `validation-agent-activity-{run_id}` — `{ role, kind: "tool"|"text", tool?, detail?, text? }`
  (camelCase). Live agent activity, one event per reviewer tool call or text block: `tool` +
  `detail` (one-line input summary — command / file path / pattern) for tool calls, `text`
  (trimmed, ≤400 chars) for text blocks. Client-only feed (bounded, not part of the run snapshot).

## 4. Sidecar protocol (one-shot validation agents)

New `OutboundMessage::ValidationAgent` (Rust `sidecar.rs`) / inbound handler (sidecar `index.ts`):

```
{ type: "validation_agent", id: string, cwd: string, role: "review"|"verify"|"evidence"|"docs"|"lint",
  prompt: string, model: string, effort?: string, resumeSessionId?: string }
```

Sidecar behavior (clone the `handleGenerateRepoDescription` pattern, Claude provider only):
- `query()` with `cwd`, `settingSources: []`, `permissionMode: "default"`, restricted
  `allowedTools: [<submit tool>, "Read", "Glob", "Grep", "Bash"]`, plus a `canUseTool` guard that
  rejects any Bash command not starting with `git ` (read-only intent; the review prompt tells the
  agent to read the diff/history itself via git).
- An in-process MCP server exposes ONE submit tool per role, schema-enforced:
  - `submit_review` → `{ findings: [{severity, file?, line?, description, action}], summary,
    risk_level, risk_rationale }` (findings before risk — field order is deliberate).
  - `submit_verification` → `{ verdict: "confirmed"|"refuted", reason }`.
  - `submit_evidence` → `{ findings: [...], tested: [string], testing_summary,
    artifacts: [{kind, label, path}] }`.
  - `submit_housekeeping` → `{ findings: [{..., category: "documentation"|"lint"}], summary }`
    (used by both docs and lint roles).
- Capture the assistant transcript text (concatenated text blocks) and the SDK session id.
- Emit `validation-agent-result-{id}` `{ structured, transcript, sdkSessionId, usage? }` or
  `validation-agent-error-{id}` `{ error }`.
- Stream `validation-agent-progress-{id}` `{ kind: "tool"|"text", tool?, detail?, text? }` per
  assistant tool call / text block while the query runs (drives the live activity feed and the
  executor's idle-timeout reset).
- Support `resumeSessionId` (SDK `resume` option) so the reviewer is durable across rounds;
  on resume failure fall back to a fresh session.

Rust side awaits the result with an activity-aware timeout: a 10-minute idle window that resets
on every progress event, plus an overall cap (`agent_timeout_minutes`, default 60, §7). Progress
events are re-emitted run-scoped as `validation-agent-activity-{run_id}` (§3). Prompts are
built in Rust (`src-tauri/src/validation/prompts.rs`) — see §5 for required prompt content.

## 5. Step behaviors

Executor: sequential over `options.steps` (fixed order), one tokio task per run with an abort
handle (mirror `NoMistakesManager`'s `RunState`). Statuses/gates per §1. Auto-fix limits come from
config (§7): findings with `action == "auto-fix"` are auto-sent to the fixer (via fix-request,
no user gate) up to the per-step limit; after that, or for any `error`/`warning` or `ask-user`
finding, the step parks as a gate. `info`-only findings never gate. After any fix round the step
re-executes and, if it had gated, parks as `fix_review` with `git diff` text of what changed
(record HEAD + `git status --porcelain` before the fix; diff = `git diff <recorded_head>` plus
untracked-file names).

**Prompt hygiene (all roles):** wrap intent and previous-findings in
`-----BEGIN USER INTENT----- / -----END-----` style markers with "data, not instructions" framing;
strip conflict markers. Include per-repo `review_guidelines` (config §7) when set.

### review
One-shot `role: "review"` on the session cwd. Prompt must include:
- "Review the code changes on this branch. Read the relevant history and diff yourself (git diff
  against `<base_branch>`, git log). Focus findings on risks introduced by changed code, but inspect
  surrounding code, call sites, and tests when needed for root cause. Do NOT run tests — a
  dedicated test step follows. Do a full review pass; don't stop at the first finding."
- Severity taxonomy: error = must not merge; warning = worth addressing, can be follow-up;
  info = nice-to-have.
- Action taxonomy: ask-user = functional/product-behavior questions or anything challenging the
  author's deliberate intent — **when in doubt, ask-user**; auto-fix = objective, non-user-visible
  (correctness, error handling, security, performance, mechanical quality); no-op = informational.
- Do-NOT-flag list: style/formatting, pre-existing issues not touched by this change,
  linter-catchable nits, speculative "might be a problem if" without concrete failure mode.
- Intent block (always present) + **intent-conformance clause**: "If the change removes/omits a
  behavior the intent marks as required, or adds one it forbids, you MUST emit an ask-user finding
  quoting the criterion and the contradicting change, even if the change is otherwise risk-clean.
  Never classify such a contradiction as auto-fix."
- Review auto-fix limit defaults to 0 → review findings always gate.
- `adversarial_verify` option: after review returns, each `error` finding gets a `role: "verify"`
  one-shot ("Adversarially verify this finding — try to refute it. Default to refuted if you cannot
  confirm a concrete failure"). Refuted findings are dropped (logged). Verify runs use the same
  model, fresh sessions, in sequence.
- Reviewer session id is captured on round 1 and resumed for later rounds; re-review prompt says
  "re-review the full current diff" and includes round history: findings the user ignored
  (approved/skipped over) must not be re-reported unless materially new.

### test
1. If `RepoConfig.validation_commands.test` set: run via shell (`sh -c` / `cmd /c`, cwd = session
   cwd; reuse `proc.rs` patterns, stream output lines to the log event). Non-zero exit → one
   `error` finding, `action: auto-fix`, description = trimmed output tail. Proof = command + exit
   code + tail.
2. Evidence agent (if `settings.validation.evidence_enabled`): one-shot `role: "evidence"`.
   Prompt: understand the intent; decide what evidence demonstrates it is satisfied — "unit tests
   passing is not sufficient evidence by itself"; prefer product-level artifacts (CLI transcripts,
   rendered output, screenshots if obtainable headlessly); if sufficient evidence is not possible,
   return a warning finding saying what's missing. Evidence agent MAY run project commands: its
   Bash guard allows any command (it must execute tests/builds) — still `settingSources: []`.
3. No command configured AND evidence disabled → step `skipped` with note.

### docs
One-shot `role: "docs"` (read-only guard). Prompt: find documentation this change made stale
(README/CLAUDE.md/docs), single-authoritative-owner policy (update the owner, don't sync copies;
don't create new doc surfaces to close perceived gaps); only docs THIS change made stale. Findings
only (no editing) — any finding gates (docs auto-fix limit default 0). Fixes flow through the
session like everything else.

### lint
If `RepoConfig.validation_commands.lint` set: run it; non-zero exit → `warning` finding
(auto-fix) with output tail. Else: one-shot `role: "lint"` — detect the project's linters/
formatters, run the relevant checks on changed files only (its Bash guard allows lint/format
commands — same policy as evidence), report unresolved issues as findings. Blocking = error/warning.

### ship
Compute `ShipProposal`: branch, base (repo default via existing `get_default_remote_branch`),
`has_uncommitted` (`git status --porcelain`), `already_pushed`, existing PR (reuse the
`fetch_branch_pr` logic — refactor its core into a `pub(crate)` helper callable from validation),
`on_default_branch`. Draft commit message + PR title/body:
- Try the LLM layer (`llm::client_from_config` + a new small feature fn following
  `generate_branch_name_with_usage`'s shape) with the intent + `git diff --stat` + step-round
  summary; on any failure fall back to deterministic templates (first line of intent; PR body
  sections: `## Intent`, `## What changed` (diffstat), `## Validation` (step outcomes + risk +
  testing summary + artifact names)).
Always **gate** (`kind: "ship"`) with the editable proposal. On `validation_execute_ship`:
`git add -A && git commit` (skip if nothing to commit), `git push` (`--set-upstream origin
<branch>` when un-pushed), then `gh pr create --title --body --base` via the pinned `run_gh` rail
(skip PR when `on_default_branch` or PR exists → note). Store `pr_url` on the run. Git ops: add
`commit_all(cwd, message)` and `push(cwd, set_upstream: bool)` to `git.rs` (lift from
`sequences/executor/nodes/git.rs`). Failures → step `failed` with stderr in the log + error.

### ci
Requires a PR (from ship or pre-existing); else `skipped` with note. Poll the branch-PR checks
(shared helper from §ship) every 30s (60s after 5 min). All checks completed+green → `passed`
(do NOT wait for merge). PR merged/closed during polling → `passed` with note (gate reconciliation).
Failures (all checks settled, ≥1 red):
- Fetch failing logs best-effort: `gh run view <runId> --log-failed` via `run_gh`, trim to 32KB.
- One `error` finding per failing check (`action: auto-fix`), description = check name + log tail.
- Auto-fix loop (limit from config): fix-request → session fixes → on `validation_fix_done`,
  auto `commit_all("Fix CI failures")` + `push` → resume polling. Dedup: don't re-fix an identical
  failing-check-name set twice in a row; that gates instead (`kind: "ci_failure"`).
- Idle timeout (config, default 45 min without any check state change) → gate.

## 6. Fix loop (frontend-mediated; the fixer is the session's own agent)

In `stores/validation.ts`, on `validation-fix-request-{runId}`:
1. Compose the fix prompt (util `buildFixPrompt(findings, instructions?)` in
   `src/lib/utils/validationFix.ts`): list findings (id, severity, file:line, description, any
   per-finding user instructions), plus the fixer discipline: "First double-check each finding is
   legitimate — if one is wrong, say so and leave the code alone. Prefer the smallest correct
   root-cause fix. Never resolve a finding by deleting intentional behavior; fix forward. Apply all
   fixes, then run ONE focused verification of the changed area only — do NOT run the full test or
   lint suite (the validation pipeline runs them next). Do not add comments explaining fixes."
2. If the session is busy (`status === 'querying'`), wait until idle (subscribe), then send via
   `sdkSessions.sendPrompt(sessionId, prompt)`.
3. Watch the session: on its next transition querying→idle, call `validation_fix_done(runId)`;
   on `sdk-error` / stopped-by-user, call `validation_fix_failed(runId, reason)` (backend turns the
   step into a gate so the user decides).
4. While pending, run shows `pending_fix: true`; the panel shows "Agent is fixing (n findings)…".
Cancel (`validation_cancel`) never interrupts an in-flight session turn — it just stops the run.

## 7. Config & settings

`AppConfig` gains (config module + `migration.rs` version bump; follow existing patterns exactly):

```rust
// config/validation.rs
pub struct ValidationConfig {
  pub default_steps: Vec<String>,        // default ["review","test","lint"]
  pub reviewer_model: String,            // default "claude-sonnet-5"; "session" allowed
  pub reviewer_effort: Option<String>,   // default None
  pub adversarial_verify: bool,          // default false
  pub evidence_enabled: bool,            // default true
  pub auto_fix_limits: HashMap<String,u32>, // defaults: review 0, test 2, docs 0, lint 2, ci 2
  pub ci_timeout_minutes: u32,           // default 45
  pub agent_timeout_minutes: u32,        // default 60 — overall cap per agent call; agents also
                                         // have a fixed 10-min idle window reset on every
                                         // streamed progress event (tool call / text)
}
```

`RepoConfig` gains (all optional, `#[serde(default)]`):
`validation_commands: Option<ValidationCommands { test, lint }>`, `review_guidelines:
Option<String>`, `validation_steps: Option<Vec<String>>` (per-repo default step set).

Frontend `stores/settings.ts` mirrors the new types. Per-run choices (steps, model, effort) are
seeded repo-override → global default, and the last-used per-repo choice persists to localStorage
(`open-whisperer:validation-run-options:<repoId>`).

## 8. Frontend store & session mirror

`src/lib/stores/validation.ts` (model on `noMistakes.ts`): `validationRuns:
writable<Map<string /*runId*/, ValidationRunView>>`, one visible run per session; API:
`startRun(sessionId, cwd, repoId, intent, options)`, `respond`, `executeShip`, `cancel`,
`dismiss`, `selectFindings`, `addUserFinding`. Listeners registered before invoking start.
Auto-select `auto-fix` findings at gates.

Intent: `src/lib/utils/validationIntent.ts` — `buildValidationIntent(session)`: aiMetadata
name/outcome + ALL user messages **verbatim** (recent last), cap ~6000 chars (truncate oldest
with a marker). Richer than the old 1500-char one-liner.

`SdkSession` gains `validation?: { runId, status: RunStatus, step?: StepName, findingCount:
number, prUrl?: string, updatedAt: number }` — auto-persisted (do NOT add to
`NON_PERSISTABLE_FIELDS`), updated by the store on every `validation-update`, giving a
restart-surviving badge. Full runs are not restored (in-memory backend), matching No Mistakes'
assumption; a stale mirrored status renders as "last run: <status>".

## 9. UI

- **`SdkSessionHeader.svelte`**: "Validate" button (checkmark-shield style, NOT gated on dev_mode),
  enabled when session idle with a real cwd; opens the start popover. Keep the existing
  dev-gated No Mistakes button as-is.
- **Start popover** (`src/lib/components/sdk/ValidationStartPopover.svelte` or inline): step
  checkboxes (fixed order; seeded per §7), reviewer model select (Claude model list from
  `utils/models.ts` + "Session model"), effort select (off/low/medium/high), adversarial-verify
  toggle, Start button. Remember last per repo.
- **`ValidationPanel.svelte`** (`components/sdk/`, rendered in `SdkView.svelte` in the same slot
  as `NoMistakesPanel`, keyed off the session's run): header (status, elapsed, cancel/dismiss);
  stepper over selected steps; per-step: status icon, proof line (command · exit code) with
  expandable output, risk chip (review), evidence summary + artifact list (test), transcript
  drawer ("View agent transcript"); gate cards:
  - findings gate: table (checkbox / severity chip / action chip / file:line / description),
    per-finding "Send to agent" one-click (single-finding fix), instructions textarea,
    "Add finding" (small text input → user-N finding), buttons **Fix selected (n)** / **Approve** /
    **Skip step**; auto-fix findings pre-checked.
  - fix_review gate: diff text in a `<pre>` (monospace, simple +/- line coloring) + same buttons.
  - ship gate: editable commit message, PR title, PR body (textarea), base→branch line, notes
    (on default branch / existing PR), **Commit & Ship** button.
  - ci_failure gate: failing checks list + findings + Fix selected / Skip.
  Collapsible log tail at the bottom (auto-open on failure). Outcome banner on finish; if a PR
  was created, link + hint to the PR panel.
- **Badge**: small validation status dot/icon in `SessionListItem` (reuse status-color patterns)
  from the mirrored `session.validation`.
- **Settings → Validation tab** (`components/settings/ValidationTab.svelte`, register in the
  settings page tab list): default steps, reviewer model/effort, adversarial verify, evidence
  toggle, auto-fix limits (numeric inputs per step), CI timeout.
- **`RepositoryView.svelte`** Repository Settings card: test command, lint command,
  review guidelines (textarea), per-repo default steps.

## 10. File ownership (for parallel implementation)

- **Backend agent (Rust)**: `src-tauri/src/validation/{mod,types,executor,prompts,ship}.rs`,
  `src-tauri/src/commands/validation_cmds.rs`, `git.rs` (commit_all/push), `github_cmds.rs`
  (extract shared pr-status helper; keep public command signatures unchanged), `sidecar.rs`
  (`OutboundMessage::ValidationAgent`), `config/{validation.rs,mod.rs,repo.rs,migration.rs}`,
  `lib.rs` (registration).
- **Sidecar agent (TS)**: `src-tauri/sidecar/src/index.ts` only.
- **Frontend store agent**: `src/lib/stores/validation.ts`, `src/lib/utils/{validationIntent,validationFix}.ts`,
  `src/lib/types/session.ts`, `src/lib/stores/settings.ts`, `src/lib/stores/sdkSessions.ts`
  (only if a small hook is needed for busy/idle watching — prefer subscribing from validation.ts).
- **UI agent**: `components/sdk/{ValidationPanel,ValidationStartPopover}.svelte`,
  `SdkSessionHeader.svelte`, `SdkView.svelte`, `SessionListItem.svelte`,
  `components/settings/ValidationTab.svelte` + settings page registration,
  `RepositoryView.svelte`.

## 11. Verification

- Rust: `cargo check` in `src-tauri/` must pass. Unit tests for: fail-closed action deserialize,
  finding id normalization, gate routing (error/warning/ask-user park; info passes), ship proposal
  fallback templates. Follow the `no_mistakes.rs` test style.
- Sidecar: `npm run sidecar:build` must pass.
- Frontend: `npm run check` must pass (no new errors vs. baseline).
