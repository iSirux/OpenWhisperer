# Session Mining: Errors & Failure Modes (2026-07-12)

Findings from all 78 error-status archived sessions, the 7 `querying` + 3 `setup` stuck sessions, the 2026-07-10 logs (backend 6.7 MB, frontend 32 MB), and `debug-recordings.json`.

## The 78 error sessions, by root cause

The raw error string is misleading — 27 of 78 just say "Claude Code process exited with code 1"; the *preceding* message reveals the true cause.

### 1. Context overflow — 31 (40%) — **RESOLVED**
Real message before the exit-1: "Prompt is too long" or "API Error: The model has reached its context window limit" (e.g. `635fe879`, `ffc9b47c`, `cfcc3ce8`). All 31 fall between 2026-02-26 and 2026-04-22, all `claude-opus-4-6`; none since. Root cause (per maintainer): a since-fixed bug where models didn't use their 1M context window. Kept for the record.

### 2. Git Bash shell-snapshot failure — 27 (35%) — **ONGOING, current #1 issue**
`Error: Failed to create shell snapshot: Command failed: C:\Program Files\Git\bin\bash.exe -c -l … source "C:\Users\joels\.bashrc"` (e.g. `a138addb`, `7bfc9382`). Kills the whole session at the first tool call. By month: Apr 11, May 6, Jun 8, Jul 2.

**Mechanism (verified):** before the first Bash tool call, the Claude Agent SDK runs `bash.exe -c -l "<script>"` which sources `.bashrc` then dumps functions/aliases/shell options into `~/.claude/shell-snapshots/snapshot-bash-….sh`, so later Bash calls run in a consistent env. If that invocation exits non-zero or times out → session dies. This machine's `.bashrc` is one line: `source <(ng completion script)` — it spawns Node + Angular CLI on every snapshot. It succeeds from an interactive shell today (tested, exit 0), so failures are env/timing dependent: app-spawned PATH missing `ng`, or Node cold-start tripping the SDK timeout — matching the intermittent 27-over-4-months pattern.

**Local fix:** guard the line in `.bashrc`: `command -v ng >/dev/null 2>&1 && [[ $- == *i* ]] && source <(ng completion script)`. **App fix** (for other users): detect the snapshot error and retry/surface instead of a dead session.

### 3. Force-termination 0x40010004 — 10 (13%) — largely false positives
All 10 on 2026-06-15, all in `VoxelFactoryGame`, all opus-4-8. `0x40010004 = DBG_TERMINATE_PROCESS`. Five were preceded by "Another agent session was started in this repository…" and five by a normal completed "Done…" summary (`6f65ba22`: "Typecheck passed, committed all 45 … pushed"). **Work often completed, then the child was force-killed and the session flipped to `error`.**

### 4–6. Smaller categories
- **Sidecar IPC pipe closed** — 2 (`1894cf1e`): `Write error: The pipe is being closed. (os error 232)` — Rust wrote to sidecar stdin after Node died. Correlates with backend log "[sidecar] Reader thread exited — resetting sidecar state" (8× on 07-10).
- **Stale executable path** — 2: `executable not found at C:\Program Files\Claude Whisperer\…` (pre-rename install path; also embedded in older shell snapshots).
- **One-offs** — 4: restore failure (`2bd25eac`: "No conversation found with session ID"), Codex model/auth mismatch (`64094f87`: "gpt-5.4-codex not supported with a ChatGPT account"), image over 2000×2000px despite compression (`ccba043e`), 3 generic exit-1.

## Stuck sessions (archived mid-flight)

- **7 `querying`:** every one's last message is a `tool_start` with no result (`6a14cc09`, `96547b80`, `fa098687`) — app quit mid-tool-call, `sdk-done`/`sdk-error` never fired, no watchdog reconciles them on restart.
- **3 `setup`:** NOT empty forms — `efe6bba1` has 1,096 messages, `64a86120` 1,090. Full history but empty `sdkSessionId` and an **unsent trailing user turn**. A restore lost the SDK session id, so the session fell back to `setup` and silently dropped the queued user message. Data-integrity bug.

## Log analysis

### Frontend log = 32 MB / 345,584 lines in ONE day; 97.3% is overlay spam
A tight feedback loop: `overlay-content-changed` → `notifyResize` → `measureAndResize` → resize mutates DOM → `overlay-content-changed`… ~68,720 full cycles/day, each logging 5 lines at INFO (`measureAndResize - found element`, `measured rect`, `scroll dimensions`, `notifyResize dispatching`, `content-changed received`). This is real CPU, not just log noise.

### Recurring ERROR/WARN patterns (2026-07-10)
| Count | Pattern |
|---|---|
| 127 | `[RateLimits] fetch_codex_rate_limits FAILED: 401 token_expired` — polls a dead Codex token all day instead of surfacing "re-auth" once |
| 79 | `Failed to send realtime audio: Realtime session rt_… not found` — audio pumped after session teardown (stop race) |
| ~60 + 58 backend | Groq LLM `429 Too Many Requests` across all 5 LLM features (naming, interaction, outcome, cleanup, quick actions fire per session and collectively trip the limit) |
| 14 | `[LaunchBar] Launch failed … 'Build': The directory name is invalid` — bad cwd/worktree path, no pre-validation |
| 14 | `[settings] Config was loaded from defaults due to a parse error. Saves are blocked` — app ran all day on defaults, silently |
| 7 | `HotKey already registered` double-registration |
| 8 (backend) | `[sidecar] Reader thread exited — resetting sidecar state` |
| 2 (backend) | `Realtime finalize timed out … returning empty tail` |

### debug-recordings.json (20 newest, all 2026-07-12)
All had audio + Whisper + realtime text, but **12/20 have empty `cleanedTranscript`** (LLM cleanup produced nothing — consistent with the Groq 429 storm) and 2/20 empty realtime transcript. LLM-cleanup reliability is visibly degraded by rate limiting.

## Improvement opportunities (ranked)

1. **Shell-snapshot failure recovery** (27×, ongoing #1): detect `Failed to create shell snapshot` and retry with snapshotting disabled / minimal shell env, or surface "your .bashrc is failing" actionably instead of a dead error session. Investigate an SDK option to skip the login-shell snapshot on Windows.
2. **Overlay log/resize feedback loop**: gate `[overlay]` measure/resize logging behind dev_mode (removes ~97% of frontend log volume) and debounce/RAF-coalesce the measure loop — only act when size actually changed.
3. **Startup reconciliation watchdog**: sessions persisted as `querying` with a dangling tool_start → reset to idle with an "interrupted mid-tool-call" note. Sessions with messages but empty `sdkSessionId` → detect, re-resume or flag, never silently drop the queued user turn.
4. **Don't flag completed runs as errors**: if the child is force-terminated after a normal completion message, reconcile to `idle` (10 of 78 "errors" were successes). Investigate why multiple agents in one repo kill sibling sidecars.
5. **Codex 401 handling**: on `token_expired`, stop the poll loop and show a one-time "Reconnect Codex" banner (127 retries/day today).
6. **Groq 429s**: shared rate limiter + backoff across the 5 LLM features instead of independent retries; features already degrade silently but hammer the API.
7. **Config-corruption UX**: saves-blocked mode ran silently all day; add a persistent banner + auto-restore from the newest good `config.json.bakN`.
8. **Context-overflow graceful degrade**: catch "Prompt is too long"/"context window limit" and offer compact/fork-and-continue rather than a dead error session.
9. **Small wins**: validate model/auth combos in the picker (gpt-5.4-codex + ChatGPT account); stop the realtime audio pump before teardown (79× "session not found"); validate launch-profile cwd before spawning (14×); enforce the 2000×2000px image dimension cap in the compression pipeline; purge stale "Claude Whisperer" paths.
