# Session Mining: Data Hygiene & Storage (2026-07-12)

Findings from auditing the live app data dir (`%APPDATA%\open-whisperer`, ~1.07 GB total) against the persistence code. Data set: 1,545 archived sessions (Feb–Jul 2026).

## Measured breakdown

| Dir | Files | Size |
|---|---|---|
| `archive\sessions` | 1545 | **942 MB** (88% of total) |
| `logs` | 22 | 107 MB |
| `debug-recordings-audio` | 81 | 12.9 MB |
| `archive-dev` / `sessions-dev` | 53 / 1 | ~0.15 MB |
| `pile-audio`, `recording-captures` | 0 | 0 |

## Findings (ranked)

### 1. Archive is 941 MB dominated by verbatim tool_result text — compact or gzip it

> **Correction (post-review):** the original claim of "zero images in the archive" was a mining error — the scan searched for `data:image/` URIs and `"data"` blobs, but the schema stores images as `base64Data` fields. `base64Data` is present in 11 of the 60 most recent session files, so images DO contribute to the 941 MB. The tool_result finding below still holds for the largest measured files.

What makes the biggest sessions huge is uncompacted tool output. The largest file (`f6a1a0cf-…json`, 12.03 MB, 955 messages):

| message type | count | size |
|---|---|---|
| **tool_result** | 355 | **11.28 MB (94%)** |
| tool_start | 355 | 0.48 MB |
| thinking | 142 | 0.04 MB |
| text | 68 | 0.03 MB |

The 8 largest single messages are all tool_results at 609–678 KB each (verbatim file reads / command output). 289 of 1545 files are ≥1 MB; 28 are ≥3 MB.

**Fix ideas:** truncate large tool_result payloads on archive (head+tail with elision marker), and/or gzip the on-disk session JSON (text compresses 5–10×; base64 image data compresses poorly but is the minority). Highest-impact storage fix by a wide margin. Touch points: `src-tauri/src/archive.rs`, session serialization.

### 2. Archive retention can never fire; no byte budget

`Archive::trim_to_max` (`archive.rs:251`) trims by **entry count** only, driven by `session_persistence.max_archived_sessions`. Code default is 500, but the on-disk config has **2000** — current archive is 1545, so trimming never runs. At the observed ~0.61 MB avg, a full 2000-entry archive ≈ 1.2 GB, and a run of big-tool-output sessions can blow far past that.

**Fix ideas:** add a total-bytes retention budget alongside the entry cap; surface the effective cap + current archive size in Settings.

### 3. Debug-recording audio leaks: 61 orphan files, no reconciliation

`debug-recordings.json` references exactly 20 recordings (`MAX_RECORDINGS = 20`), but `debug-recordings-audio\` holds **81 .webm files — 61 orphans / 10 MB**, growing forever.

Root cause: eviction deletes audio fire-and-forget (`invoke('delete_debug_audio', …).catch(() => {})`, `debugRecordings.ts:136`) and audio can be saved for recordings that never land in (or are evicted from) the 20-entry list. Unlike the pile's capture system, **there is no startup reconciliation sweep**.

**Fix:** on load, list `debug-recordings-audio\*` and delete any `.webm` whose id isn't in the current metadata — mirrors the existing pile capture-recovery pattern. Trivial.

### 4. Legacy config backups + stray files never cleaned

Current code (`persist.rs:109`, `CONFIG_BACKUPS = 3`) writes `config.json.bak1..bak3` (live, dated 2026-07-12). The older dotted scheme `config*.json.bak.1..bak.10` (20 files, frozen 2026-04 to 2026-07-04) is **dead code's leftovers** — nothing references it, so those files persist forever. Plus unmanaged strays: `config - Copy.json`, `config.dev.old.json`, `config.dev.json.dev`, `fix-claudewhisperer-rename.ps1`.

**Fix:** one-time startup sweep of the legacy `*.json.bak.N` pattern and known strays.

### 5. Frontend log volume: 32 MB in one day, per-line flush

Log **policy** is fine (50 MB rotation cap + 7-day retention sweep at startup, `lib.rs:124`, `log_cmds.rs:20`). The issues are:

- **Volume:** `frontend-2026-07-10.log` = 32 MB for a single day at Info level — something is high-frequency-logging (see the errors/failures doc for what's spamming).
- **I/O:** `write_frontend_log` flushes on every line (`log_cmds.rs:96-98`).
- **Retention runs only at startup**, so a long-running instance never prunes (an 8-day-old log was still present).

**Fix ideas:** gate high-frequency log lines behind dev_mode, drop per-line flush, add a periodic retention pass.

## Non-issues verified

- `sessions\index.json` vs `archive\index.json`: different schemas, distinct purposes — not duplication.
- `*-dev` dirs are the debug-build equivalents; divergence is expected.
- `archive\index.json` (0.91 MB) is rewritten on every archive op — fine at this size, but grows linearly with the archive.

## Key files

`src-tauri/src/archive.rs`, `src-tauri/src/persist.rs`, `src-tauri/src/commands/log_cmds.rs`, `src-tauri/src/commands/debug_recordings_cmds.rs`, `src/lib/stores/debugRecordings.ts`, `src/lib/stores/sessionPersistence.ts`, `src-tauri/src/config/mod.rs`.
