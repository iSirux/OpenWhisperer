# Session Mining: Workflow & UX Friction (2026-07-12)

Findings from 1,545 archived sessions (Feb 22 – Jul 12, 2026). 1,489 Claude / 32 OpenAI; repos: Funnelfeedr 589, OpenWhisperer 243, VoxelFactoryGame 180; 254 distinct worktrees; peak day 59 sessions (Jul 10).

Methodology note: index `messageCount` counts tool events (median 177, inflated). By **user turns**: 463 sessions had 1 turn, 454 had 2–3 — **~59% of sessions are ≤3 user turns**; only 68 exceeded 15.

## Ranked opportunities

### 1. Context overflow is the #1 manual-retry friction — **RESOLVED**

> **Post-review:** this was caused by a since-fixed bug where models didn't use their 1M context window. All occurrences predate the fix; kept for the record. The 529-retry point (#2) and the long-session cost angle (cost doc #4) still stand.
- **"Prompt is too long" appears 224 times across 96 sessions (6.2%).** `dfe85488` hit it 25×; `7c080171` 9×; several others 5–8×.
- Users recover by brute force: **"keep going" appears 104 times across 80 sessions**, and tracing what precedes each one shows it is almost always a "Prompt is too long" or 529 Overloaded error — not the agent voluntarily stopping (`cebb4649`, `6808d9bb`, `65c807c3`, `3cbaaf7d`, `44800e74`).
- `ContextOverflowBanner` and the fork remedy exist, but real usage shows users ignoring them and re-typing "keep going" — the fork/compact path isn't discoverable or isn't worth it mid-task.

**Fix:** auto-compaction / summarize-and-continue on overflow, or one-click "continue in fresh session with context carried over" that auto-resends the last turn. Touch points: `sdkSessions.ts` (`promptTooLong`), `ContextOverflowBanner.svelte`.

### 2. API 529 Overloaded has no auto-retry
27 occurrences across 22 sessions, same manual "keep going" pattern. A transient server error should retry with backoff instead of surfacing as a dead turn. Related user-filed complaint: *"getting a lot of 'Tool permission request failed: Error: Stream closed' on claude tool calls. investigate."*

### 3. Auto-model: zero adoption; trivial prompts run on Opus
- `autoModelRequested` = true in **0 / 1,546 sessions**.
- **48 trivial sessions (prompt ≤12 chars, e.g. "hello") ran on Opus**; only 3 on Sonnet/Haiku.
- Auto-routing simple work to cheaper models is a large unrealized savings lever (see the cost doc).

**Fix:** make Auto the default or nudge strongly; auto-downgrade obviously-trivial first prompts.

### 4. Fork / read-only / discuss are dead features — and agent overreach causes reverts
- Fork used in **1** session; `readOnlyMode` in 1; `noteMode` in 0.
- Meanwhile **25 short "revert" messages**, including *"did you make changes? i just wanted advice. revert"* and *"revert that 'fix', fix the issue i described."* Default `acceptEdits` means the agent edits even when the user wanted discussion.

**Fix:** surface a lightweight "Discuss / ask-only" toggle prominently (capability exists, nobody finds it); consider detecting advice-style prompts; auto-suggest fork exactly at the context-overflow moment (ties to #1).

### 5. Plan mode is the standout successful feature — lean into it
- ExitPlanMode used in **232 sessions (15%)**; 164 plans approved, 71 change-requested (30% first-plan rejection) — the rejections are substantive, so it demonstrably catches bad plans before code is written.
- Note: the `planMode` field seen in archived JSONs is **vestigial** — zero references in current `src/` (plan mode is now SDK-native ExitPlanMode via `canUseTool`, no per-session flag). The actionable bit is smaller than first stated: if plan-mode analytics/filtering is wanted, a persisted "used plan mode" marker would need to be added.

### 6. AI metadata pipeline: dead `summary` field; categories regressed
- **`summary` = 0 / 1,546** — but this is a **vestigial schema field**, not a broken user-facing feature: the "session summary" users see in the UI is `aiMetadata.outcome` (`generate_session_outcome`, shown by the `show_session_summary` setting in `SessionCard.svelte` / `SessionListItem.svelte`), which generates fine (78%). Actionable bit: remove or repurpose the always-null `summary` column in the archive index (archive search over it matches nothing).
- **`category` populated on only 486 (31%)**, and it's a regression over time: Feb 84% → Mar 27% → May 15% → Jul 39%. The naming call (`features.rs:34`) marks category as a required schema field and names arrive 99% of the time — category is being dropped somewhere (parse/merge bug, or a later name-only update overwriting metadata).
- What works: name 99%, outcome 78%, quickActions 77%. Junk names ~2%: "Commit and Push Changes" ×24, "Code Simplification Task" ×12, plus meta-prompt leaks ("Generate Coding Session Name" ×3 — the namer named the session after its own instruction).

### 7. Manual error copy-paste loop
**187 user messages across 126 sessions (8%) paste raw error output** (stack traces, `error TS`, `npm ERR`, exit codes) — a forced keyboard fallback in a voice-first app. **Fix idea:** a "paste from clipboard as error block" affordance or terminal-output ingestion.

### 8. Typed prompts lost on archive
**21 sessions archived with an unsent draft/pending/prepared prompt.** Ironically, one lost draft (`e4007dd0`) is the user requesting this exact feature: *"when the user writes in the prompt field, we should persist that debounced"*; another (`d3494685`): *"I need to be able to bring back sessions from the archive back into the session list."* Both feature requests are themselves sitting in lost drafts.

### 9. Parallel/worktree workflow is heavy but batch launch looks underused
455 sessions (29%) ran in worktrees across 254 paths, but only 18 session pairs were created within 15s of each other — the user spins up parallel sessions one at a time despite pile multi-select / Notion / Issues batch-launch existing. Worth checking discoverability.

## Feature-adoption scorecard (of 1,546 sessions)

| Feature | Usage | Verdict |
|---|---|---|
| Plan mode | 232 sessions | Heavily used, high value |
| Worktrees | 455 sessions | Heavily used |
| Effort levels | high 936 / medium 518 / extremes ~66 | high+medium only |
| Fork | 1 | Dead |
| Auto model | 0 | Dead |
| Read-only / discuss | 1 | Dead |
| Note mode | 0 | Dead |
| AI summary | 0 | Broken pipeline |
| AI category | 486 (31%, regressed) | Degraded |
| Unread markers | 19 | Minimal |
| Abandoned sessions | 3 | Negligible |
