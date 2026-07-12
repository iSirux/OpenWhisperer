# Session Mining: Cost & Usage Efficiency (2026-07-12)

Findings from 1,545 archived sessions, `usage_stats.json`, and `config.json`.

## Headline numbers

- Archive tracked cost: **$30,656** across 1,545 sessions; `usage_stats.json` lifetime **$33,358** across 2,168 sessions. Real lifetime is ≈ **$35k** once untracked Codex spend is added (see bugs).
- Extreme concentration: **top 10 sessions = 28.5% of spend, top 20 = 42.3%, top 50 = 60.7%**. Mean $21.98/session, median only $3.40.
- Session length is the real driver: **73 sessions with >1000 messages = 51% of all cost**; 273 sessions >500 messages = 78%.

## Cost by model — the spend explosion is a model-tier migration

| model | sessions | total $ | avg $/session | $/msg | period |
|---|---|---|---|---|---|
| claude-opus-4-8 | 417 | 14,250 | 34.17 | 0.11 | May 29–Jul 12 |
| **claude-fable-5** | **101** | **11,535** | **114.20** | **0.22** | Jun 11–Jul 12 |
| claude-opus-4-6 | 871 | 4,495 | 5.16 | 0.02 | Feb 25–May 28 |
| claude-opus-4-7 | 53 | 322 | 6.07 | 0.02 | Apr 16–19 |
| claude-sonnet-4-6 | 45 | 56 | 1.23 | 0.01 | Feb–Mar |

fable-5 is 6.5% of sessions but **37% of total spend** — 11× the per-message cost of opus-4-6.

Top sessions (all Opus-tier, mostly game side-projects): `869f11ec` $2,065 "Factory Game Performance Research" (fable-5, 3,844 msgs); `2d93d3f5` $1,475 "Design Voxel Factory Game Mechanics"; `40e5e2f8` $772 "Implement Quarries Fully" (5,347 msgs). By repo: **VoxelFactoryGame $10,873 (35%)**, Funnelfeedr ≈ $10k, OpenWhisperer $2,992, Replicatory $2,217.

## Cache & tokens — caching is healthy; the lever is session length

Estimated Claude cost split: **cache read 55.5%, cache write 28.0%, output 16.1%, fresh input 0.4%** — ~83% of every dollar is cache operations, the signature of thousand-turn agentic sessions re-reading a large context each turn. Cache reuse ratios are excellent (cacheRead:freshInput up to 49,000×). There is no context-bloat or cache-hygiene problem on the Claude side; the money goes to legitimately long sessions on premium tiers.

## Auto-model is dormant; everything runs Opus at high effort

- **`autoModelRequested: true` in 0 of 1,545 sessions.** The `recommend_model` LLM feature is enabled in config, but "Auto" is never selected, so the router never runs. `model_usage`: 1,894 Opus sessions vs 72 Sonnet, 6 Haiku.
- Effort: **high = 936 (62%)**, medium = 518 (34%), xhigh = 24, low = 22, max = 20.

## Cost-tracking bugs (concrete)

1. **Codex/OpenAI cost entirely untracked.** 30 OpenAI sessions, total tracked $6.85, yet they burned 9.8M output + 942M cache-read + 1,079M fresh-input tokens ≈ **$1,564 invisible**. Example `33c4d987` (gpt-5.4): 309M input tokens over 105 turns, recorded cost $0.
2. **Provider mislabel:** 7 sessions have `provider: "claude"` but `model: "gpt-5.3-codex"` (e.g. `12d227a4`, `24c6b7d5`) — provider-inference bug, all $0.
3. **Codex barely caches:** cacheRead:freshInput ≈ 0.7–0.9 (near-full context resent uncached each turn) vs Claude's 1,000–49,000×. If priced, Codex would look far less efficient per turn — currently invisible.
4. **`usage_stats.json` gaps:** `repo_usage` has only `{repo_path, session_count, prompt_count}` — **no cost/token fields**; `daily_stats` likewise has no cost. The most useful cost-control views (per-repo, per-day) can't be shown in-app. `average_session_duration_ms` and `average_prompts_per_session` are both stuck at 0 despite ample data.
5. Index `totalCost` faithfully mirrors `usage.totalCostUsd` (0 mismatches) — the index math is fine, it just inherits Codex's zeros.

Other stats: 19,511 secondary-LLM (Groq) requests / 11.86M input tokens for naming/cleanup/etc.; 211k tool calls (Read 76k, Bash 35k, Edit 35k, Grep 30k); 1,031 recordings.

## Improvement opportunities (ranked)

1. **Fix Codex cost tracking + the provider mislabel.** ~$1.5k of spend recorded as $0; dashboards understate reality and can't compare Claude vs Codex efficiency.
2. **Add per-repo and per-day cost/token accumulation** to `usage_stats.json` (and fix the always-0 derived averages). VoxelFactoryGame alone is 35% of spend and that's invisible in-app today.
3. **Activate smarter routing.** Auto-model is enabled but never used — consider defaulting new sessions to Auto or nudging toward it; 62% of sessions run high effort on the priciest tier while opus-4-6-era work cost $0.02/msg.
4. **Long-session cost guardrail.** 73 sessions >1000 msgs = 51% of spend, and ~83% of cost is cache ops on ever-growing contexts. A warning / compaction nudge / auto-fork-to-fresh-context past N turns attacks the dominant cost driver directly (`40e5e2f8`: 5,347 msgs, $772).
5. **Cost concentration dashboard.** "Biggest sessions / repos this week" view — the 6.5% fable-5 sessions that are 37% of cost should be visible at a glance.
