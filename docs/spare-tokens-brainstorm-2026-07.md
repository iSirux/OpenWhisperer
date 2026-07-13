# Spare Tokens — Brainstorm & Research (July 2026)

**Concept:** When a user has leftover subscription usage near a 5h/7d rate-limit window reset, offer a library of generic, high-value prompts to spend it — e.g. "fan out subagents to hunt for refactoring opportunities." Optionally schedule these to fire shortly *before* a reset, so expiring capacity gets converted into reviewable value instead of evaporating.

Status: brainstorm only, nothing implemented. Based on a web research sweep (community practice, existing products) and a codebase integration scan.

---

## 1. Validation

The concept is validated from both directions:

- **Community practice already exists, manually.** Overnight `claude -p` job queues, scheduled Codex automations (OpenAI runs daily bug scanners and CI-failure summarizers internally), Anthropic's own `/loop` maintenance prompt ("finish work → tend PR → cleanup passes such as bug hunts or simplification"), and Bloomberg's "Pomona" research (scan → debt backlog → ~10-line PRs, 15/17 merged). Users even game window timing (firing a throwaway early prompt to shift the 5h reset) — people already think about resets; nobody productizes *opportunistic* spending of leftover headroom.
- **The codebase already has ~90% of the plumbing.** Live per-window utilization + reset timestamps for both providers, a Smart Queue that fires time-targeted items on a 30s tick, and a one-call session launcher. A pre-reset launch is literally a `scheduled` queue item with `targetStartAt = resetsAt - preRoll`.

**Differentiator vs. existing products:** Claude Code Routines and Codex Automations are cron-based ("every night at 2am"). This feature is *opportunistic* — it reacts to actual remaining headroom and the actual (drifting) reset boundary.

---

## 2. Prompt library

Research surfaced ~40 viable tasks. Selection heuristic that emerged: good spare-token tasks are **regular, tolerant of vague instructions, measurable, and reviewable**; bad ones are open-ended "improve the codebase" runs. Default the library to read-only reports; gate write tasks behind "runs in a worktree, never pushes."

### Tier 1 — read-only reports (safe defaults, pure token→value)

| Task | Prompt sketch | Appetite | Fan-out? |
|---|---|---|---|
| Multi-lens review of recent changes | Parallel reviewers (security, perf, quality, test quality, simplification) over the diff since main; severity-ranked merge; skip linter-catchable nitpicks | medium | **yes** (canonical 9-agent pattern, ~75% useful findings) |
| Refactoring opportunity audit | Surface refactoring opportunities ranked by severity — patterns correct today but future maintenance liabilities; skip anything a linter would catch | med/large | **yes** (per-directory) |
| Security review | Injection, XSS, authz flaws, secrets, leaky errors; filter false positives; explain exploitability | medium | yes (Anthropic ships `/security-review`) |
| Test-coverage gap analysis | Which critical paths / error branches / public APIs have no tests; rank by risk, not percentage | medium | partial |
| Dead-code hunt | Unused exports, unreachable branches, orphaned files, stale feature flags; confidence + blast radius per item | medium | yes |
| Performance audit | N+1 queries, blocking calls on hot paths, unbounded caches, accidentally-quadratic loops; evidence + suggested fix each | medium | yes |
| Error-handling & logging review | Swallowed exceptions, empty catches, missing propagation, logs leaking sensitive data | medium | yes |
| Dependency audit | Outdated deps; read changelogs between our version and latest; flag breaking changes, security fixes, upgrade effort | small/med | yes (per-dep) |
| Documentation drift check | Compare README/docs/CLAUDE.md claims against actual code; list every stale statement | medium | yes |
| "Explain this codebase" deep-dive | Wiki-style architecture report; one subagent per subsystem, merged (DeepWiki-style) | large | **yes** |
| Architecture health review | Dependency map; circular deps, god modules, churn×complexity hotspots | large | yes |
| Codebase health scorecard | Score 0–100 across dimensions (dead code, duplication, error handling, deps, security, testing) + phased plan | large | yes |
| Bus-factor / hotspot analysis | From git history: churn, single-author files, knowledge-risk areas | small/med | no |
| Flaky-test hunt | Tests likely intermittent (sleeps, race-prone async, time/locale); optionally re-run suspects N times | medium | yes |
| Accessibility audit | WCAG 2.2 AA over UI code; cite violated success criterion per finding | medium | yes |
| Deprecated-API scan | All deprecated usages (language/framework/own `@deprecated`); migration checklist | small/med | yes |
| Secrets & config hygiene | Hardcoded credentials, permissive CORS, debug flags in prod config, .env drift | small | no |
| Observability audit | Critical paths with no logging/metrics; noisy logs to demote; minimal instrumentation diff proposal | medium | yes |
| Migration-prep report | Plan X→Y migration: every touched call site, risk ranking, sequencing, test strategy — plan only | large | yes |
| TODO/FIXME triage | Inventory + classify (obsolete / quick win / real project); propose top 10 | small | no |
| CI improvement report | Recent CI failures by cause; slowest jobs, flakiest steps; caching/parallelization fixes | small/med | no |

### Tier 2 — small-diff write tasks (worktree required, never push)

| Task | Prompt sketch | Notes |
|---|---|---|
| Tests for highest-risk uncovered module | Behavior-focused tests matching existing style; all must pass; **no source changes in the same run** | Community consensus: single best unattended task — expected behavior is already defined. Caveat: AI tests often assert implementation, not intent; frame as "cover the riskiest gap," not "raise the number" |
| Tiny-diff quality PRs (Pomona pattern) | From a prioritized backlog (lint violations, debt markers, test gaps), one ~10-line diff per item | Bloomberg: 15/17 merged, median close <2h. Small diffs earn trust |
| Lint/static-analysis burn-down | Fix all warnings in `<dir>` with minimal semantic change; tests after each batch | per-dir fan-out |
| Type-coverage improvement | Eliminate `any`/untyped exports in `<dir>`; tighten one strictness flag; keep build green | |
| Duplication extraction | Top duplication cluster from the tech-debt report → shared utility; behavior identical (tests prove it) | serial, not fan-out |
| Dependency vulnerability fix | `npm audit` equivalent; apply safe upgrades; verify; summarize human decisions needed | |
| Changelog generation | Update CHANGELOG with commits since last tag, grouped, in the file's existing style | |
| CLAUDE.md / AGENTS.md refresh | `/init`-style analysis; create/update agent-onboarding doc; flag rules contradicted by code | **Uniquely leveraged:** makes every future session cheaper (compound-engineering's core idea) |
| Onboarding guide | The doc a senior dev wants on day one: setup, architecture tour, gotchas | per-subsystem fan-out |
| ADR backfill | Infer 5–10 architectural decisions from history/structure; short ADRs for review | |
| Spec drafting / backlog grooming | For each rough backlog idea, draft a reviewable spec: problem, approach, files touched, test plan | Feeds the "night shift" pattern: finished specs become executable work |

### Meta prompt — the library that grows itself

A library entry (`prompt-designer`) whose job is to design *repo-specific* spare-token prompts: fan out subagents to scan the codebase for where spare effort pays off most (coverage weak spots, debt hotspots, drift-prone docs, chores visible in git history) while searching the web for maintenance patterns specific to the repo's exact stack, then propose 5–10 tailored, ready-to-run prompts ranked by expected value. Deliberately excludes what the stock library already covers. **Follow-up idea:** let its output feed back into the library as user-editable custom entries (requires custom-prompt support in the store state + an add/edit UI — the per-item state is already keyed by id, so custom entries slot in naturally).

### Brainstorming cluster — deliverable is a doc, not a chat report

Prompts whose output is a new markdown file under `docs/` (feature brainstorm, competitive landscape, tech-stack radar). Convention: they stay `readOnly: true` — auto-eligible, no worktree — because they may only **create new** markdown files under `docs/`, never modify existing files or source; a new untracked doc is trivially reviewable via git status, and the point is for the doc to land in the real tree. Each combines codebase scanning (what the product actually is) with web-searching subagents (demand signals, competitor changelogs, ecosystem releases) and cites sources.

### Tier 3 — OpenWhisperer-specific (nobody else can offer these)

- **Repo vocabulary extraction** — "extract domain terms, invented names, and abbreviations into a glossary" → feeds `RepoConfig.vocabulary`, which transcription cleanup already uses. Spare tokens literally improve future voice transcription accuracy.
- **Repo description/keywords refresh** — same trick for the LLM repo-router (`auto_select_repo`).
- **Pile grooming** — turn stale pile items into drafted specs / reviewable setup sessions.

---

## 3. Community cautions (what produces slop)

1. **Never point spare tokens outward.** The curl bug-bounty collapse (AI-report confirmation rate <5%, program killed; Ghostty perma-bans, tldraw auto-closes external PRs). Outputs stay local: reports, worktree branches, own-repo issues only.
2. **AI-generated tests can be negative-value** — they replay implementation behavior ("high coverage, broken verification loop"). Mitigations: behavior-framed prompts, forbid source edits in the same run.
3. **The weekly window is shared.** Burning 5h leftovers still draws down the 7-day cap (both providers); overnight burns have throttled people's daytime work. **UI must gate on 7d headroom**, not just 5h.
4. **Unattended long runs fail silently** — context exhaustion, instruction dilution after compaction. Fixes: fresh sessions per phase, verbose output to files, clear completion criteria.
5. **Shape output for review.** Severity-ranked findings with clean areas collapsed; ≤10-line diffs. Explicitly instruct agents to skip formatting/naming nitpicks and linter-catchable issues — that's where most noise comes from.
6. **Foundation-dependence.** Unattended *write* tasks only work with a real test suite and decent docs; on weak repos, restrict to read-only reports plus the bootstrapping tasks (tests, CLAUDE.md, onboarding docs) that build the foundation.

---

## 4. Codebase integration map

### Data — already there (`src/lib/stores/rateLimits.ts`, `queueDetection.ts`)

- `ProviderRateLimits { five_hour, seven_day: RateLimitWindow { utilization /*0-100*/, resets_at /*ISO*/ }, extra_usage }` — live for both providers via `rateLimitData` / `codexRateLimitData` (3-min auto-poll).
- `formatTimeRemaining(iso)` → "2h 15m"; `calculatePace(utilization, resetsAt, windowHours)` → ahead/behind-pace — exactly the "how much headroom is left" computation.
- `nextWindowResetAt(provider, window)` (queueDetection.ts) → epoch-ms reset boundary. **The key primitive for pre-reset scheduling.** Headroom = `100 - utilization`; no new backend data needed.

### Scheduling — reuse the Smart Queue (`src/lib/stores/smartQueue.ts`)

- `QueueReason = 'rate_limit' | 'scheduled' | 'after_sessions'`. The `scheduled` branch of `isReady` fires on `now > targetStartAt && !exhausted`, driven by the existing 30s tick.
- **A pre-reset item is a `scheduled` item with `targetStartAt = nextWindowResetAt(provider, window) - preRollMs`.** Firing *before* reset consumes the expiring window — which is exactly the intent.
- Schedule split-button in `SessionSetupView.svelte` (~L858–889: "When repo is idle / Next 5h reset / Next 7d reset") gets a fourth option: "Just before next reset."
- Add a per-window once-guard so auto-scheduled tasks don't fire every window — borrow the cooldown / once-per-day pattern from `src-tauri/src/sequences/event_triggers.rs`.
- The sequences engine has real cron (`SequenceTrigger::Schedule`), but wall-clock cron can't express "N minutes before a drifting reset" — the pre-reset trigger belongs in smartQueue, not sequences. Sequences could host a *recurring* variant ("every day at 16:55") later.

### Launching — one call (`src/lib/utils/sessionLaunch.ts`)

- `launchSession({ prompt, images?, repo, model, effortLevel, provider, useWorktree?, branchNameHint?, systemPrompt?, tag? })` — immediate launch.
- Deferred: `createSetupSession(...)` → `startSetupSession({ ..., schedule })` (sdkSessions.ts ~L2618), dispatched later by `launchPrepared`. `launchSession` doesn't currently forward `schedule` — small extension needed.
- Batch fan-out: `createSessionQueue().enqueue(tasks, { stagger: true })` — the pile's existing stagger queue.
- `snapshotLaunchConfigForRepo(repo)` captures current default model/effort/provider for a repo — ideal for one-click library launches.

### Storage — new config section, NOT prompt chips

- Chips (`settings.prompt_chips`) are flat label strings appended to existing prompts — too thin. Library entries want structure:
  `{ id, title, prompt, readOnly, recommendedEffort, useWorktree, tags }`.
- Pattern: new `src-tauri/src/config/spare_tokens.rs` (mirror `QueueConfig` in `sequences.rs`), field on `AppConfig` with serde defaults (**no migration entry needed** — `CURRENT_CONFIG_VERSION` derives from the migrations array; missing fields default), TS mirror in `stores/settings.ts`.
- Ship built-in entries **in code** (so they improve across app updates) + user-added custom entries in config.

### UI — two surfaces

1. **"Spare tokens" card on `Start.svelte`** (the primary surface): *"You have 43% of your 5h window left, resets in 1h 12m — spend it?"* with top library prompts and Launch / Schedule buttons. Visibility gate: decent 5h headroom **and** reset approaching **and** 7d window not tight (caution #3).
2. **Library browser/manager:** v1 = a section in the Smart Queue settings tab; later = new `MainView: 'library'` (extend union in `navigation.ts`, add branch in `(main)/+page.svelte` view switch ~L382–397). Per-repo association could follow the `mcp_servers` pattern on `RepoConfig`.
- Scheduler status rides the existing `QueueIndicator.svelte` header pill.

---

## 5. Design decisions

- **Default read-only.** Reports are zero-risk. Write tasks require worktree + real tests.
- **Output shape is the product.** Bake into built-in prompt bodies: "skip linter-catchable issues, rank Critical>High>Medium>Low, collapse clean areas to one line" / "diffs ≤10 lines per concern."
- **Shared autonomous preamble** (analogous to `pileActions.ts` "Plan first" prefix): "This is an autonomous maintenance run; produce a reviewable report/diff; do not ask questions" — unattended sessions can't answer `AskUserQuestion`.
- **Ambition ladder:**
  - v1 — manual launch from the Start card.
  - v1.5 — "schedule before next reset" per prompt (4th schedule-menu item).
  - v2 — opt-in auto mode (see §5a below). The genuine differentiator vs. cron-based Routines/Automations.
- **Voice angle:** "spend my spare tokens" as a voice command / wake action fits the app's identity.

## 5a. Auto mode — the strongest idea

Opt-in: the user pins a few library items for auto-run; the app fires them autonomously when there's headroom that would otherwise go unused — **especially toward the end of the 7d window**.

### The end-of-7d inversion

The research's main caution (§3.3: burning 5h leftovers drains the shared 7d cap) **inverts near the 7d boundary**: unused 7d capacity is about to expire worthless. That's the one time spending is strictly free. Burn-safety tiers (all inputs already in `rateLimitData` + `calculatePace`):

1. **Prime time** — 7d reset within ~24h AND 7d utilization well under 100%: expiring capacity, spend freely.
2. **Okay** — 5h window near reset with headroom AND 7d behind pace (`paceRatio < 1`): the week is being under-used anyway.
3. **Never** — 7d ahead of pace or tight: auto mode stays silent regardless of 5h headroom.

An aggressiveness setting (conservative / normal / aggressive) maps to the thresholds (how close to reset, how much headroom required, whether tier 2 is enabled at all).

### Selection model

- Per library item: an **Auto toggle** + target repo (+ model/effort, defaulting via `snapshotLaunchConfigForRepo`). Items without a repo could default to the most-recently-active one.
- Pinned items form a **rotation**, not a batch — one fires at a time; the next only if headroom remains.

### Dispatch loop

Fire one item → let the 3-minute rate-limit poll reflect the new utilization → re-evaluate → maybe fire the next. Headroom itself is the budget signal; no token estimation needed. Implementation: a small driver alongside `smartQueue.ts` (same 30s-tick + rate-limit-store subscription pattern, started in the main layout), launching via `launchSession` with a `spareTokens` tag.

### Guards (what keeps it from being annoying)

- **Once per window per item**, plus a **staleness gate** for reports: skip if no new commits since the item's last run (re-running a dead-code audit on an unchanged repo is pure noise; last-commit-hash check is cheap).
- **Only fire into an idle repo scope** (`hasBusySessionsInScope`) — never compete with the user's live work.
- **Read-only items only** are auto-eligible by default; write items must have the worktree flag set.
- **Max 1 concurrent auto session**; results surface via existing unread markers + a "recent auto-runs" strip on the Start card. Optional quiet-hours setting.
- Persist per-item `lastRunAt` / last-run window + last-commit-hash so restarts don't double-fire.

### Desktop-app limitation

Auto mode only runs while the app is open — the end-of-7d moment may land at 4am. Mitigations: evaluate the trigger **on app launch** too ("you're in the burn window right now — run your pinned tasks?"), and treat the last-day condition as a wide window (last ~24h) rather than a point-in-time.

### Suggested MVP

Built-in library of ~8 Tier-1 prompts + the vocabulary extractor; Start-view card driven by `rateLimitData` with the 7d-headroom gate; launch via `launchSession` (worktree toggle for write tasks); fourth schedule-menu option reusing existing Smart Queue plumbing. Everything reuses code that already exists.

---

## 6. Sources

- https://hamy.xyz/blog/2026-02_code-reviews-claude-subagents — 9 parallel review subagents with lenses; ~75% useful; skip linter-catchable nitpicks.
- https://jeangalea.com/claude-code-overnight/ — overnight `claude -p` queues; caution: heavy nights eat the weekly ceiling; "morning review is not optional."
- https://medium.com/@evekhm/running-claude-code-autonomously-overnight-what-breaks-and-how-to-fix-it-3bee3bd958b5 — unattended failure modes; good candidates = measurable outputs + clear completion criteria.
- https://jamon.dev/night-shift — "Night Shift" workflow; success depends on test infrastructure and docs.
- https://arxiv.org/pdf/2606.06752 — Bloomberg "Pomona": scan → backlog → ~10-line PRs; 15/17 merged.
- https://newsletter.aiengineer.co/p/how-im-using-openai-codex-automations — real daily Codex automations; automate tasks that are regular, vague-tolerant, reviewable.
- https://code.claude.com/docs/en/scheduled-tasks.md — Claude Code's `/loop` built-in maintenance prompt; Anthropic's canonical "idle capacity" answer.
- https://codex.danielvaughan.com/2026/03/27/codex-cli-automations-scheduled-tasks/ — concrete `codex exec` one-liners (changelog, coverage gaps, deprecated APIs).
- https://www.xda-developers.com/discovered-a-hidden-trick-to-reset-my-claude-5-hour-window-whenever-i-want/ — users already schedule around resets.
- https://dev.to/myougatheaxo/automated-technical-debt-detection-with-claude-code-refactor-suggest-9hi — `/refactor-suggest`: severity-ranked refactoring beyond linters.
- https://github.com/qdhenry/Claude-Command-Suite — 216+ slash commands; ready taxonomy to mine.
- https://github.com/anthropics/claude-code-security-review — official `/security-review` + PR Action with false-positive filtering.
- https://github.com/Iron-Ham/claude-deep-review — architecture health via mapper/cycle-detector/hotspot subagents.
- https://github.com/Community-Access/accessibility-agents — 11 WCAG 2.2 AA specialist agents.
- https://every.to/guides/compound-engineering — doc-generation as the highest-ROI spare-token task.
- https://www.bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/ — the slop backlash; never point spare tokens outward.
- https://davidadamojr.com/ai-generated-tests-are-lying-to-you/ — AI tests replaying implementation behavior.
- https://cognition.com/blog/how-cognition-uses-devin-to-build-devin — Devin's knowledge bank across sessions.
- https://ghuntley.com/ralph/ — the Ralph loop; maximalist token-burning; anti-pattern for reviewable value.

**Products/features studied:** Claude Code `/loop` + Routines (cron cloud agents), OpenAI Codex Automations, Google Jules (plan-first + PR-out contract), Devin/DeepWiki (codebase wiki as productized spare-cycle task), Sweep AI, Ellipsis, Bloomberg Pomona.
