# Rust Refactoring Findings

> **Implementation status (2026-07-04):** Implemented. All findings were applied by four parallel refactoring agents plus a consolidation pass; `cargo check` is clean, all 70 tests pass. Deliberately deferred: sidecar auto-restart-with-backoff (I2, optional part), realtime WebSocket SplitSink/SplitStream split (I6/T7 contention polish — cancellation fix landed), `dedup_yaml_keys` retained as a defensive repair path (S9 — flatten round-trip not yet proven clean), `suggested_thinking` kept (frontend still reads it as fallback), terminal-mode legacy machinery kept behind doc comments (C6). New shared modules: `util.rs`, `persist.rs`, `proc.rs`, `usage_stats.rs`, `config/`, `sequences/executor/`.

Audit of `src-tauri/src` (~20,500 lines) for long-term maintainability. Four parallel deep-reads covered: the sequences engine, config/persistence/lib, sidecar/realtime/IPC, and llm/git/commands. Findings are grouped into cross-cutting themes (the big levers) and per-subsystem items, then a suggested roadmap.

> Line numbers are as of 2026-07-04 on `main` (uncommitted working tree).

---

## Part 1 — Cross-cutting themes (the big levers)

These patterns repeat across every subsystem. Fixing them once, centrally, resolves dozens of individual findings at a stroke.

### T1. Stringly-typed errors everywhere (`Result<_, String>`)

Every fallible function in the crate returns `Result<T, String>` with hand-formatted `format!("Failed to ...: {}", e)` — hundreds of occurrences. Consequences:

- Callers (and the frontend) cannot distinguish error kinds programmatically (timeout vs. cancel vs. not-found vs. transport). The frontend already string-matches on messages like "Sidecar not started", and those strings have drifted between call sites.
- Sequence retry logic cannot tell a transient failure (HTTP 429) from a permanent one (template bug) — see S12.
- Error messages are inconsistent ("API error" / "Gemini API error" / "Request failed" / "Failed to run git").

**Refactor:** introduce `thiserror`-based enums per module — `SequenceError`, `SidecarError`, `RealtimeError`, `GitError`, `LlmError`, `McpError`, `PersistError` — with `#[from]` conversions. Keep `String` only at the Tauri command boundary via one `impl From<X> for String`. This is the single biggest long-term lever; it can be adopted module-by-module.

### T2. Shell-out boilerplate duplicated ~50× (`git.rs` + sequences executor)

The identical 12-line ceremony — `Command::new`, `.current_dir`, `#[cfg(windows)] creation_flags(CREATE_NO_WINDOW)`, pipe stdout/stderr, `.output()`, map error, check `status.success()`, `from_utf8_lossy` — is copy-pasted:

- ~38 occurrences across `git.rs:44-284` (10+ methods that differ only in the args array)
- ~10 more in `sequences/executor.rs` (git/gh/script/wait nodes, e.g. `1545-1559`, `1648-1691`, `1908-1943`)
- The `cmd`/`sh` shell-selection block is duplicated verbatim between `git.rs:406-414` and `486-502`.

The `#[cfg(windows)]` guard is a real portability footgun — easy to forget on the next new call site.

**Refactor:** one shared helper (sync and async variants):

```rust
fn run_git(repo_path: &str, args: &[&str]) -> Result<String, GitError>   // trimmed stdout, stderr on failure
async fn run_command(program, args, cwd, env) -> Result<CommandOutput, ...>
fn run_shell(cwd, cmd_str) -> ...                                        // cmd /C vs sh -c selection
```

Removes ~150 lines from `git.rs` alone and centralizes the Windows flag, error mapping, and any future timeout/logging.

### T3. Persistence load/save scaffolding duplicated 4×

`create_dir_all` → `to_string_pretty` → atomic write → bespoke error strings; and on load: exists → read → parse → log → fall back to default. Reimplemented in:

- `config.rs:2482-2526` (`AppConfig::save` — the only one with backup rotation)
- `config.rs:688-713` (`UsageStats::load/save`)
- `session_persistence.rs:377-441` (`SessionIndex::save`, `save_session_data`)

Additionally, `atomic_write` (`session_persistence.rs:13-34`) has latent issues: the temp name `path.with_extension("json.tmp")` can collide for multi-dot/extension-less names; the parent directory is never fsynced after rename (the classic atomic-write durability caveat); and `cleanup_tmp_files` only scans session dirs, so a leftover `config.json.tmp` is never cleaned.

**Refactor:** a small `persist` module: `load_json_or_default<T>(path, label)` and `save_json_atomic<T>(path, value, label)` with opt-in backup rotation, unique temp suffixes, and dir fsync. All four call sites become thin.

### T4. Event-name strings and emit boilerplate scattered with no registry

`format!("sdk-...-{}", id)` in `sidecar.rs` (~30×), `realtime-{partial,final,error}-{}` in `realtime_cmds.rs`, `terminal-output-{}` in `terminal.rs`, sequence events in `executor.rs`. Plus `let _ = app.emit(...)` silently swallowing emit failures with inconsistent logging. No single place where Rust and TypeScript agree on event names.

**Refactor:** a central `events.rs` constants module (or codegen shared with the frontend) plus one `emit_event(app, name, payload)` helper that logs failures uniformly.

### T5. LLM client construction + keyring constants duplicated 4×

`KEYRING_SERVICE`/`KEYRING_LLM_KEY` and the "Local provider → optional key, else required" + `LlmClient::new(...)` construction exist in:

- `commands/llm_cmds.rs:98-116` (`create_client`, private)
- `commands/git_cmds.rs:96-119` (copied inline; comment even admits it's "shared with llm_cmds")
- `sequences/executor.rs:2973-3010` (`create_llm_client_from_app`, comment admits duplication)
- `commands/sequence_cmds.rs:217-243`

**Refactor:** one `crate::llm::client_from_config(app, &AppConfig) -> Result<LlmClient, LlmError>`; keyring constants in one place.

### T6. Panic-prone idioms repeated

- `SystemTime::now().duration_since(UNIX_EPOCH).unwrap()` appears in at least 8 places (`config.rs:739`, `terminal.rs:77-80`, `session_cmds.rs:25-27`, `mcp_cmds.rs:335/429/524`, `archive.rs:54`, `git.rs:526`). Extract `now_secs()`/`now_ms()` utils with `unwrap_or_default()`.
- **Latent UTF-8 panic (real bug):** `llm/utils.rs:23-29` `truncate_text` slices by byte index (`&text[..max_len-3]`) and panics if the boundary lands mid-multibyte-char. It runs on every user prompt/transcription fed to LLM features. The codebase already has two *correct* char-boundary implementations (`archive.rs:353-358`, `git_cmds.rs:123-126`) — unify all three into one shared util.
- `&exec_id[..8]` unguarded slicing in 5 executor emit helpers (`executor.rs:2854-2917`) while `executor.rs:1189` already uses the safe `[..8.min(len)]` idiom. Add `fn short_id(&str) -> &str`.

### T7. No documented lock strategy; locks held across slow operations

The codebase mixes `parking_lot::Mutex`, `std`, and `tokio::sync::Mutex` with no rule:

- Every `usage_cmds` command and `settings_cmds::save_config` holds the mutex **across a synchronous fsync-ing disk write** (`usage_cmds.rs:19-92`, `settings_cmds.rs:130-133`) — a slow disk blocks unrelated commands.
- `realtime_cmds.rs:88-144` holds a per-session `tokio::Mutex` across `.await`ed socket operations; the poll loop can starve `send_realtime_audio`.

**Refactor:** document the rule (parking_lot for short non-async sections; tokio only when the guard must cross `.await`). Adopt "mutate under lock, persist after unlock" (clone snapshot, drop guard, then save). Consider `RwLock` for read-mostly `AppConfig`, and debounce `UsageStats` saves rather than writing on every `track_*` call. For realtime, split the WebSocket into `SplitSink`/`SplitStream` so send and recv don't contend at all.

---

## Part 2 — Per-subsystem findings

## A. Sequences engine (`src/sequences/`, ~6,300 lines)

The dominant hotspot: `executor.rs` alone is 3,102 lines (40% of the subsystem).

### S1. `executor.rs` is a god-file with 25+ inline node executors — HIGH

One `impl SequenceExecutor` holds the orchestration loop plus an `execute_*` method per node type (prompt, route, script, notify, delay, transform, approval, 6× git, 3× github, wait, file, http, loop, parallel, foreach, subsequence), dispatched by a 50-line match (`executor.rs:533-582`). Nothing is unit-testable in isolation; every new node type touches the enum, the dispatch, and this file.

**Refactor:** introduce `trait NodeExecutor { async fn execute(&self, node, ctx, deps) -> NodeResult; }`; split into `executor/nodes/{git,github,prompt,control_flow,io}.rs` with the orchestration loop in `executor/engine.rs`. Longest functions to break up regardless: `execute` (~320 lines, `83-403`), `execute_prompt` (~276), `execute_parallel` (~216), `execute_route_ai` (~184).

### S2. Child executors silently drop AI logs & usage — HIGH (correctness)

`ai_logs`/`ai_usage` are `Mutex` fields on each `SequenceExecutor`, but parallel/foreach/subsequence branches construct a **new** executor per branch (`executor.rs:2406, 2636, 2760`). Logs/usage accumulated in children are never drained — AI cost accounting vanishes for anything inside those nodes.

**Refactor:** hoist into a shared `Arc<AiSink>` passed to children, or return captured logs/usage as part of the node result.

### S3. Event listeners leaked on every prompt node — HIGH (correctness)

`execute_prompt` registers 5 `app.listen(...)` handlers (`executor.rs:688-790`) and never calls `unlisten` — dropping the `EventId` does not unregister. Every prompt node permanently leaks 5 handlers (and their `Arc<Mutex<…>>` captures) for the app's lifetime; looping sequences compound this.

**Refactor:** an RAII `SdkSessionListeners` struct that unlistens on `Drop`.

### S4. Busy-poll join loops instead of async joining — MEDIUM-HIGH

Parallel "first"/"any"/"count" strategies poll `handle.is_finished()` with `sleep(50ms)` in four near-identical hand-rolled schedulers (`executor.rs:2419-2579`, `2649-2665`). `ForEachNode.max_parallel` is defined in types but ignored — no concurrency cap.

**Refactor:** `tokio::task::JoinSet`/`FuturesUnordered` with one `collect_branches(handles, strategy)` helper; a `Semaphore` for `max_parallel`.

### S5. Stringly-typed control fields — MEDIUM-HIGH

Behavioral discriminators are `Option<String>` matched against literals with silent fallback arms: `wait_for` ("checks"/"reviews"/"merge"), `on_timeout`, `on_branch_error`, `on_item_error`, `mode`, `method`, `FileNode.operation`, `on_max_iterations`; `ParallelNode.wait` is even a raw `serde_json::Value`. Typos silently hit the default arm; valid values are documented only inside the AI-generation prompt text.

**Refactor:** serde enums (`#[serde(rename_all = "snake_case")]`): `WaitTarget`, `BranchErrorPolicy`, `ItemErrorPolicy`, `ExecutionMode`, `MergeMethod`, `FileOperation`, `WaitStrategy`. Validation moves to parse time; matches become exhaustive.

### S6. Full-execution JSON re-serialized to disk after every node — MEDIUM

`save_execution` writes the entire `SequenceExecution` (all node results, full log vec, context) as pretty-JSON after **every** node (`executor.rs:359`; impl `persistence.rs:440-459`). O(n²) I/O for long/looping sequences.

**Refactor:** an `ExecutionStore` trait with `record_node`/`snapshot`; debounce full snapshots or append deltas.

### S7. Retry semantics split; `ErrorStrategy::Retry` is a no-op — MEDIUM

Retries are driven by `node.retry_count` (`executor.rs:245-272`), while `on_error: retry` (`344-350`) just fails with a comment "already exhausted." Authors configuring `on_error: retry` silently get no retries.

**Refactor:** collapse to one model — `ErrorStrategy::Retry { max, delay, backoff }` as the single source — or remove the variant.

### S8. Trigger model duplicated; guard-state bug — MEDIUM

Triggers are modeled twice (`SequenceTrigger` at `types.rs:660-697` vs `NodeType::Trigger` at `593-618`) with overlapping fields, reconciled by complex entry-selection logic. Separately, `EventTriggerManager::start` (~180 lines, 6-7 nesting levels, `event_triggers.rs:49-230`) allocates a **throwaway per-registration `guard_state`** shadowing the struct-level one — cooldown/once-daily limits don't actually persist across the shared view, and the fire logic is duplicated between the app-start path and the listener path.

**Refactor:** make one trigger representation canonical; extract `fire_trigger` and `check_guards` helpers using the single struct-level state.

### S9. YAML key-dedup repair subsystem masking a serde bug — MEDIUM

`dedup_yaml_keys` (`persistence.rs:211-340` + 4 tests) is a 130-line indentation-tracking string-surgery pass repairing duplicate YAML keys caused by `#[serde(flatten)]` on `NodeType` (`types.rs:110`). Permanent tech debt maintained instead of fixing the round-trip at the source.

**Refactor:** fix the flatten conflict (custom (De)serialize or an explicit `config:` map), then delete the repair path.

### S10. Dead/aspirational schema fields — MEDIUM

Declared but never read: `PromptNode.{images, tools, mcp_servers, session}`, `WaitNode.{on_success, on_failure}`, `ApprovalNode.notify`, `ForEachNode.max_parallel`, and — most misleading — `SequenceDefaults.{model, effort, repo, isolation, timeout}` (only `on_error` is consulted). Also: the `SequenceManager.executions` in-memory map is dead (`mod.rs:36`) — all reads re-parse every JSON file on disk (`persistence.rs:464-507`); AI multi-select route output (`branches`/`targets`, `executor.rs:1017-1062`) is produced but `next_node_id` only reads `"next"`, so the feature is inert.

**Refactor:** wire up or delete; either make `executions` the source of truth for active runs, or remove it and add a persisted summaries index for listing.

### S11. Smaller executor items

- `resolve_cwd` logic duplicated inline in `execute_prompt` (`642-652` vs helper at `2956-2968`).
- "Clone context into Object map + insert vars" pattern written 4× (`2252-2270`, `2610-2626`, `2673-2689`, `1377-1385`) → `with_extra(ctx, entries)` helper.
- Template render failures silently swallowed via `unwrap_or_else(|_| v.clone())` (`1126`, `1270`) — hides template bugs; at least log.
- `parse_duration_to_secs` (`3016-3057`) is a generic util living in the executor; its inverse lives in `template.rs:238` — co-locate.
- Notification senders (`notifications.rs`) repeat the status-check + body-building ladder 3× → `post_and_check` + `build_body` helpers.

## B. Config, persistence, app shell (`config.rs`, `session_persistence.rs`, `lib.rs`)

### C1. `config.rs` is a 2,537-line god-file mixing three concerns — HIGH

(1) ~40 config schema types; (2) the entire `UsageStats` telemetry subsystem **with business logic** (`config.rs:559-964` — tracking, streaks, daily rollups — not configuration at all); (3) a config load/recovery/migration engine (`2053-2480`). Every feature touches this file; merge conflicts are constant.

**Refactor:** convert to a `config/` module dir (`mod.rs`, `migration.rs`, `audio.rs`, `realtime.rs`, `hotkeys.rs`, `mcp.rs`, `sequences.rs`, `llm.rs`, `repo.rs`) and move `UsageStats` to a top-level `usage_stats.rs` (~400 lines out immediately).

### C2. Three-way default-value duplication — HIGH

76 free `default_*()` functions + 20 hand-written `impl Default` blocks + 180 `#[serde(default)]` attributes. Defaults are written twice (fn + impl) and referenced a third time, and they **have already drifted** — e.g. `HotkeyConfig::default` (`config.rs:407-421`) hardcodes literals instead of calling the `default_*` fns that serde uses.

**Refactor:** preferred — derive via the `smart-default` crate (`#[default = 500]` on fields), deleting both the free fns and hand impls for most structs. Minimum-risk mechanical alternative: make every `impl Default` call the `default_*()` fns exclusively. Where all fields have defaults, container-level `#[serde(default)]` + `#[derive(Default)]` suffices (as `ModelUsageStats` already does).

### C3. Ad-hoc versionless migration engine — HIGH (contains a live bug)

Migration is spread across three mechanisms with **no config version number**: custom `Deserialize` impls for effort enums (duplicated at `config.rs:1395-1430` and `1814-1850`), post-parse `migrate_deprecated_llm_models` (`2152-2190`), and the 158-line pre-parse `Value` rewriter `fix_known_fields` (`2322-2480`). Migrations pattern-sniff every load forever and can never be retired. `load` itself (~121 lines) copy-pastes its success path twice (`2256-2266` vs `2287-2297`).

**Live bug:** the valid-theme list at `config.rs:2358-2360` (`"Snow"`, `"Sand"`) is out of sync with the actual `Theme` enum (`1313-1327` — Forest/Ocean/Rose/Storm/Aurora, no Snow/Sand): valid themes get reset to Midnight and unknown ones slip through.

**Refactor:** add `config_version: u32` and a linear `migrations: [fn(&mut Value)]` table keyed by version (as `SessionIndex` already does with its version field); centralize the model-ID alias map shared by defaults, migration, and fixup; extract the duplicated load success path into one `finalize()` helper.

### C4. `UsageStats` logic smells — MEDIUM

`ensure_today_stats` checks only `daily_stats.last()` while other paths scan the whole vec (duplicate-today risk if ever unordered); `update_streak` has a dead empty `if had_yesterday {}` branch (`config.rs:934-937`); `track_session`'s model classification (`756-776`) hardcodes model-name substrings — a third copy of the model taxonomy that silently misclassifies new models. `LlmTokenStats` (30 flat scalar fields + a 7-arm match) begs for an enum-keyed map.

### C5. `lib.rs::run` is a 383-line function — MEDIUM

Config load, logging, plugins, state, a ~120-line `.setup` closure (tray/icons/sequences/scheduler), window events, and a 150-entry `generate_handler!`. The shutdown sequence (sidecar → launch mgr → tray → exit) is **copy-pasted verbatim** in the tray quit handler (`lib.rs:237-248`) and the window CloseRequested handler (`322-331`) — the two paths can drift.

**Refactor:** extract `setup_tray`, `init_sequences`, `build_log_plugin`, and a single `shutdown(app)` used by both paths; group the handler list into per-feature sections.

### C6. Deprecated fields with no removal path — LOW-MEDIUM

`GitConfig` is `@deprecated` but remains a **required** (non-default) field of `AppConfig` (`config.rs:1622`), so it can never be dropped without a migration. `get_effective_terminal_mode` (`2532-2535`) unconditionally returns `Sdk`, making the `TerminalMode`/`ClaudeTerminalMode`/`CodexMode` machinery behaviorally dead — kept only for round-tripping. `PersistedSdkSession` mixes `@deprecated` fields (`thinking_level`, `summary`) indistinguishably with live ones.

**Refactor:** make `git` `#[serde(default)]`, strip via a versioned migration; delete or document the terminal-mode machinery; group legacy persisted fields behind a `#[serde(default)] legacy:` sub-struct.

## C. Sidecar, realtime, terminal (`sidecar.rs`, `realtime.rs`, `sdk_cmds.rs`, ...)

### I1. `SidecarManager::handle_message` — ~380-line match with 30+ arms — HIGH

`sidecar.rs:583-962`. Every arm destructures the typed `InboundMessage` variant, rebuilds the event name via `format!`, then hand-rebuilds a `json!` payload re-typing the same fields (which already carry `#[serde(rename)]` on the enum) — every field exists in **three** places. A misspelled JSON key or dropped field is silent data loss to the frontend. `let _ = app.emit(...)` appears ~30× with inconsistent error logging.

**Refactor:** (1) derive the event suffix from the variant (`fn event_suffix(&self) -> &'static str`); (2) emit the variant's own `Serialize` output instead of hand-built `json!`; (3) one `emit_event` helper that logs failures; (4) collapse the ~10 pure log-and-emit arms into a data-driven table. Cuts the function 50-70%.

### I2. No sidecar crash recovery — HIGH (correctness)

`started` is only reset by `shutdown()`. If the Node process dies, the reader thread logs "Reader thread exited" (`sidecar.rs:577`) but never clears `started`/`stdin`/`process` — `is_started()` stays true, guards pass, and every `send` fails with a confusing write error until app restart. No restart path exists.

**Refactor:** on reader-thread exit, reset state and emit a `sidecar-exited` event; add `restart(app)`; consider auto-restart with backoff; have `is_started()` check `try_wait()`.

### I3. `is_started()` guard copy-pasted in 11+ SDK commands — MEDIUM-HIGH

`sdk_cmds.rs` repeats the identical 3-line guard at ~14 sites with drifting error wording — and it's largely redundant since `SidecarManager::send` already errors when stdin is `None` (`sidecar.rs:973`).

**Refactor:** move the guard into `send` (typed error per T1); add `send_or_start(app, msg)` for the auto-start variants. Each command becomes a one-liner.

### I4. Four WebSocket session types duplicate recv/close/PCM scaffolding — MEDIUM-HIGH

`realtime.rs`: `VoskSession`, `VoiceStreamAISession`, `SherpaOnnxSession`, `SpeachesSession`. The 6-arm `timeout(10ms, socket.next())` recv block is copy-pasted 4× (`110-125`, `243-254`, `394-407`, `748-776`); i16→LE-bytes PCM conversion 3×; `close()` byte-identical 4×; then `RealtimeSessionType` (`794-837`) hand-dispatches all four methods. A 5th provider means re-implementing all of it.

**Refactor:** `trait RealtimeSession { send_audio / try_recv / finalize / close }` with shared `pcm_i16_le()` and a generic `ws_try_recv(socket, parse_fn)`; dispatch via `Box<dyn RealtimeSession>` or a delegation macro. Also unify the four `test_*_connection` functions (`841-955`) behind one `connect_and_check` helper — two of them `.unwrap()` on `serde_json::to_string` (lines `850`, `859`, `892`), panics inside a connection *test*.

### I5. Stringly-typed provider event parsing — MEDIUM

`parse_speaches_event` (`realtime.rs:484-671`, ~187 lines) matches raw event-type strings and walks `serde_json::Value` with `.get(...).and_then(...).unwrap_or_default()` chains; unknown events silently fall through. **Refactor:** `#[serde(tag = "type")] enum SpeachesEvent` so serde does dispatch and field extraction; extract the 7×-repeated truncate+log helper.

### I6. Realtime session lifecycle races — MEDIUM

The polling loop (`realtime_cmds.rs:75-127`) only exits when the session disappears from the map; `stop_realtime_session` removes it while the loop may still hold an `Arc` clone mid-`try_recv`, racing against `finalize`'s drain. No cancellation token or join handle.

**Refactor:** store a `CancellationToken`/`JoinHandle` per session; `close_session` signals and awaits loop exit before finalizing.

### I7. Smaller items

- `fetch_claude_rate_limits` / `fetch_codex_rate_limits` (`sdk_cmds.rs:410-495` / `512-585`) are structural duplicates whose error handling has already drifted → extract `read_bearer_token` + `authed_get_json`.
- `input_cmds.rs` paste/copy are ~90% identical across 2 commands × 2 platform cfg blocks → extract `send_modified_key(letter)`.
- `SpeachesSession::ensure_configured` is a no-op (`configured` set true in the constructor) — dead.

## D. LLM, MCP, misc commands

### L1. Provider request/response paths structurally identical — HIGH

`llm/providers.rs`: `test_connection_gemini` vs `test_connection_openai` (`30-86` vs `88-146`) and `try_gemini_model` vs `generate_openai_with_usage` (`170-228` vs `266-329`) duplicate the whole send → status-check → parse → extract-error → extract-usage → extract-text pipeline; auth-header logic duplicated too. Adding a provider (e.g. Anthropic direct) means copying it all again.

**Refactor:** `trait ProviderResponse { fn into_text_and_usage(self) -> Result<(String, LlmUsage), LlmError>; fn error(&self) -> Option<&str>; }` + a generic `send_and_parse<Req, Resp>` and an `add_auth` helper. `test_connection` becomes provider-agnostic.

### L2. `llm/features.rs` — 8 near-identical prompt+schema+call methods — HIGH

All 8 `*_with_usage` methods (583 lines) hand-build an inline `json!` schema right next to a prompt that manually restates the same shape ("Respond with ONLY a JSON object in this exact format: ..."). Two sources of truth per feature; they can and do drift (the deprecated `suggested_thinking` field lingers in `types.rs` but not in schema/prompt).

**Refactor:** generate schemas from the result types once (`schemars`), or at minimum extract the shared response-format boilerplate and go table-driven (`(prompt_template, schema)` per feature).

### L3. `llm_cmds.rs` — 7 commands repeat the same 6-step guard/track ceremony — MEDIUM-HIGH

lock config → check `llm.enabled` (string repeated 7×) → check feature flag (5×) → `create_client` → call → `track_usage` → unwrap. **Refactor:** a `prepare_client(app, config, feature_flag)` helper + a `run_feature(stats, "key", fut)` wrapper that auto-tracks. Roughly halves the file.

### L4. `mcp_cmds.rs` — OAuth/keyring duplication (not HTTP/SSE) — MEDIUM

Connection testing is actually unified (one arm handles HTTP+SSE). The real weight: the server-lookup idiom `servers.iter().find(...).ok_or_else(...)` appears 6×; `exchange_mcp_oauth_code` and `refresh_mcp_oauth_tokens` share ~40 identical lines; keyring token read+parse duplicated between `get_mcp_oauth_tokens` and `get_mcp_auth_header` — and only the latter checks expiry, an inconsistency inviting bugs.

**Refactor:** `find_server(config, id)`, `store_tokens(app, id, resp, fallback_refresh)`, `load_tokens(app, id)` (with the expiry check in one place). ~120 lines removed.

### L5. Dead code & polish

- `git.rs:35-38` blanket `#[allow(dead_code)]` on all of `GitManager` — audit and remove genuinely dead methods; `is_bare` in `list_worktrees` is written but effectively never consumed.
- `llm/types.rs`: deprecated `suggested_thinking`; unused `RepoRecommendation::get_index/get_name` while `llm_cmds.rs:436-442` reimplements the index remap inline.
- `providers.rs:245,249`: **success** messages logged at `log::error!` — pollutes error logs.
- `launch.rs:14` `_command_name` stored, never read.

---

## Part 3 — Suggested roadmap

Ordered so early steps are mechanical/low-risk and unlock the later structural ones.

**Phase 0 — Bug-adjacent quick wins (hours each, do first)**
1. Fix `llm/utils.rs::truncate_text` UTF-8 panic; unify the 3 truncation impls (T6).
2. Fix the theme validation list drift in `fix_known_fields` (C3).
3. Fix the per-registration `guard_state` shadowing in `event_triggers.rs` (S8).
4. Unlisten prompt-node event listeners via an RAII guard (S3).
5. Route child-executor `ai_logs`/`ai_usage` through a shared sink (S2).
6. Sidecar crash detection: reset state on reader exit + emit `sidecar-exited` (I2).
7. `short_id()` / `now_secs()` helpers; replace the unguarded slices and epoch unwraps (T6).

**Phase 1 — Deduplication helpers (mechanical, high line-count payoff)**
8. `run_git` / `run_command` / `run_shell` helpers; migrate `git.rs` and executor nodes (T2, ~250+ lines removed).
9. `persist` module (`load_json_or_default` / `save_json_atomic` with backup + sound temp naming); migrate the 4 call sites (T3).
10. Shared `client_from_config` for LLM client construction (T5).
11. Fold the `is_started` guard into `SidecarManager::send`; slim `sdk_cmds.rs` (I3).
12. `find_server` / `store_tokens` / `load_tokens` in `mcp_cmds.rs` (L4); `prepare_client`/`run_feature` in `llm_cmds.rs` (L3).

**Phase 2 — Typed errors and events (adopt module-by-module)**
13. `thiserror` enums per module, `String` only at the Tauri boundary (T1). Start with `GitError` and `SidecarError` (smallest surfaces, immediate frontend benefit).
14. Central event-name constants + `emit_event` helper; rewrite `handle_message` to serialize variants directly (T4, I1).
15. Serde enums for the sequences' stringly-typed control fields (S5) and `SpeachesEvent` (I5).

**Phase 3 — Structural splits**
16. Split `config.rs` into a `config/` module; move `UsageStats` out; kill default-value triplication (`smart-default` or defaults-fns-only rule) (C1, C2).
17. Introduce `config_version` + linear migration table; retire `fix_known_fields` pattern-sniffing (C3).
18. Split `executor.rs` behind a `NodeExecutor` trait into `executor/nodes/*`; extract the orchestration loop's phases (S1); replace busy-poll joins with `JoinSet` + `Semaphore` (S4).
19. `RealtimeSession` trait + shared WS helpers; unify connection tests (I4).
20. `ProviderResponse` trait + `send_and_parse` in `llm/providers.rs`; schema-from-type in `features.rs` (L1, L2).
21. Extract `lib.rs` setup/shutdown helpers; single `shutdown()` for both close paths (C5).

**Phase 4 — Debt retirement (needs product decisions)**
22. Fix the `NodeType` flatten round-trip and delete `dedup_yaml_keys` (S9).
23. Resolve retry semantics: one model for `retry_count` vs `on_error: retry` (S7).
24. Wire up or delete aspirational schema fields (`SequenceDefaults.*`, `max_parallel`, multi-select routes, `PromptNode.images/tools/...`) (S10).
25. Deprecated-field removal via versioned migrations (`GitConfig`, terminal-mode machinery, persisted session legacy fields) (C6).
26. Lock-strategy documentation + mutate-under-lock/persist-after-unlock sweep; debounced `UsageStats` saves; realtime socket split (T7, I6).
27. `ExecutionStore` incremental persistence; resolve the dead `executions` map (S6, S10).

### Where the leverage is

| Change | Resolves | Est. scope |
|---|---|---|
| Command-runner helpers (T2) | ~50 duplication sites, Windows-flag footgun | Small, mechanical |
| Typed errors (T1) | Hundreds of `format!` sites, frontend string-matching | Large, incremental |
| `executor.rs` split (S1) | 3,100-line hotspot, untestable nodes | Large, structural |
| `config.rs` split + defaults (C1/C2) | 2,500-line hotspot, 3-way default drift | Medium, mostly mechanical |
| `handle_message` rewrite (I1) | ~380 lines → data-driven, triple field declarations | Medium |
| Session/provider traits (I4/L1/L2) | 4× WS scaffolding, per-provider copy-paste | Medium |
