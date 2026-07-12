# Session Mining — July 2026

Five parallel deep-dives over the app's real usage data (`%APPDATA%\open-whisperer`): **1,545 archived sessions** (Feb 22 – Jul 12, 2026, ~$30.7k tracked spend, 942 MB on disk), live logs, `usage_stats.json`, `debug-recordings.json`, and the current config — cross-checked against the source code.

| Doc | Focus |
|---|---|
| [errors-and-failure-modes.md](errors-and-failure-modes.md) | Taxonomy of all 78 error sessions, stuck sessions, log-spam analysis |
| [workflow-and-ux-friction.md](workflow-and-ux-friction.md) | Friction patterns, feature-adoption scorecard, metadata pipeline health |
| [cost-and-usage-efficiency.md](cost-and-usage-efficiency.md) | Where the $30k went, cost-tracking bugs, routing opportunities |
| [transcription-and-prompt-quality.md](transcription-and-prompt-quality.md) | Voice→prompt pipeline: cleanup bugs, vocab gaps, truncation |
| [data-hygiene-storage.md](data-hygiene-storage.md) | 942 MB archive anatomy, orphaned files, retention gaps |

## Top 10 across all reports

1. ~~Context overflow~~ — **RESOLVED**: caused by a since-fixed bug where models didn't use their 1M context window ("Prompt is too long" ×224 across 96 sessions, all pre-fix). The long-session cost angle survives on its own: 73 mega-sessions = 51% of spend, cache-read dominated. *(UX #1, Errors #1, Cost #4)*
2. **Git Bash shell-snapshot failure is the #1 ongoing session killer** — 27 sessions dead at the first Bash call (Apr–Jul). Root cause: the SDK's pre-Bash env snapshot sources `.bashrc`, whose `source <(ng completion script)` line intermittently fails/times out under the app-spawned environment. Local `.bashrc` guard + app-level detect-and-retry. *(Errors #2)*
3. **AI category generation regressed**: from 84% (Feb) to 31% overall despite category being a required schema field — a parse/merge bug worth finding. (The "summaries never generate" claim was a false alarm: the UI's session summary is `aiMetadata.outcome`, which works at 78%; the `summary` field is dead schema. `planMode` in archives is likewise vestigial.) *(UX #6)*
4. **Codex cost tracking records $0** — ≈$1.5k of OpenAI spend is invisible; 7 sessions are provider-mislabeled ("claude" + gpt-5.3-codex). Per-repo and per-day cost fields don't exist in `usage_stats.json` at all. *(Cost #1–2)*
5. **Auto-model / fork / read-only / note mode are dead features** (0–1 uses each) while 48 trivial prompts ran on Opus and 25 "revert — I just wanted advice" messages show acceptEdits overreach. Either promote these features or cut them. Plan mode is the counterexample: 232 sessions, 30% first-plan rejection — it works. *(UX #3–5, Cost #3)*
6. **LLM transcription cleanup has inversion bugs** — it *imports and duplicates* filler from the realtime track ("Yeah. Yeah,"), inserts phrases it's forbidden to insert, and previously dropped trailing clauses (patched for one memorized example only). Needs prompt fixes + a regression suite. *(Transcription #1–2)*
7. **Cleanup vocabulary is missing the most-mangled terms** (LLM→LLC, webhook→web book, Vosk→Vusk, "work tree" split despite being listed) — a one-line list update plus split-form joining. *(Transcription #3–4)*
8. **Archive is 942 MB, dominated by verbatim tool_result text** (94% of the largest file; images are present too — `base64Data` in ~1 in 5 recent sessions — the original "zero images" claim was a scan error) and the retention cap (2000) is above the current count so it never trims. Truncate/gzip tool results + add a byte budget. *(Hygiene #1–2)*
9. **The overlay measure/resize feedback loop burns real CPU and 97% of a 32 MB/day frontend log** (~68,720 cycles/day, 5 log lines each). Debounce the loop, gate the logging. *(Errors #2, Hygiene #5)*
10. **Recoverability gaps**: sessions stuck in `querying` forever after app-quit mid-tool-call (no startup watchdog); restores that lose `sdkSessionId` silently drop the user's queued message (2 sessions with ~1,090 messages each); 21 sessions archived with unsent drafts; config-parse failure ran a whole day silently on defaults with saves blocked. *(Errors #3, #7; UX #8)*

## Quick wins (small, high confidence)

- Reconcile orphaned `debug-recordings-audio` on startup (61 orphan files today; mirrors existing pile capture-recovery).
- Stop the Codex rate-limit poller on 401 `token_expired`; show a "Reconnect Codex" banner (127 futile retries/day).
- Shared rate limiter + backoff across the 5 Groq LLM features (429 storms currently blank out transcription cleanup — 12/20 recent recordings had no cleaned transcript).
- Empty-audio guard: 8 sessions launched from a "." prompt, 25 from junk; route near-empty transcriptions to the pile instead.
- Auto-retry 529 Overloaded with backoff (27 occurrences, all manually nudged).
- One-time sweep of legacy `config*.json.bak.N` files and strays; validate launch-profile cwd before spawning; don't flip force-killed-after-completion sessions to `error` (10 of 78 "errors" were successful runs).
