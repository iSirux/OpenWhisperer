//! Integration with the `no-mistakes` Go CLI (git-push validation proxy).
//!
//! `no-mistakes axi` is a headless interface that drives a validation pipeline
//! (review → test → docs → lint → push → PR → CI) inside an isolated worktree.
//! It blocks until it reaches a decision gate or completes, printing TOON
//! (Token-Oriented Object Notation) output. We don't have exact TOON samples,
//! so every extractor here is tolerant/heuristic and every emitted event carries
//! the raw text so the UI can fall back to showing it verbatim.
//!
//! The [`NoMistakesManager`] owns the lifecycle of active runs: it spawns the
//! `axi run`/`axi respond` child process (streaming its output as `nm-log`
//! events), polls `axi status` on a timer (`nm-status`), and — when the child
//! exits — either surfaces a decision gate (`nm-gate`) or a terminal outcome
//! (`nm-done`).

#![allow(dead_code)]

use crate::proc::run_command_async;
use crate::util::emit_or_log;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::task::AbortHandle;

/// Name of the CLI binary (assumed to be on PATH).
const NM_BIN: &str = "no-mistakes";
/// How often the status poller runs `axi status` while a run is live.
const STATUS_POLL_MS: u64 = 2500;

// ── Event payloads ─────────────────────────────────────────────────────────────
// Field names are already snake_case single words, matching the frontend contract.

/// A single pipeline step and its status, as reported by `axi status`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NmStep {
    /// Canonical step name (`review|test|docs|lint|push|pr|ci`) when recognized,
    /// otherwise whatever the tool reported, lowercased.
    pub name: String,
    /// One of `pending|running|passed|failed|skipped|unknown`.
    pub status: String,
}

/// A finding row from a decision gate's findings table.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct NmFinding {
    pub id: String,
    pub severity: String,
    pub file: String,
    /// One of `auto-fix|ask-user|no-op` (passed through as-is).
    pub action: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    steps: Vec<NmStep>,
    raw: String,
}

#[derive(Debug, Clone, Serialize)]
struct GatePayload {
    findings: Vec<NmFinding>,
    raw: String,
}

#[derive(Debug, Clone, Serialize)]
struct LogPayload {
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct DonePayload {
    outcome: String,
    message: String,
    raw: String,
}

/// Result of [`NoMistakesManager::check`], serialized for the `nm_check` command.
#[derive(Debug, Clone, Serialize)]
pub struct NmCheckResult {
    pub installed: bool,
    pub version: Option<String>,
    pub status_ok: bool,
    pub raw_status: String,
}

// ── Run state ──────────────────────────────────────────────────────────────────

/// Lifecycle phase of a tracked run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// A child process is executing (`axi run`/`axi respond`).
    Running,
    /// The child exited at a decision gate; awaiting `nm_respond`.
    AwaitingGate,
}

/// Per-run bookkeeping stored in the manager's map.
struct RunState {
    /// Working directory the run operates in (also its uniqueness key alongside id).
    cwd: String,
    phase: Phase,
    /// Abort handle for the driver task (streaming child + exit parsing).
    run_abort: Option<AbortHandle>,
    /// Abort handle for the status poller task.
    poll_abort: Option<AbortHandle>,
    /// OS pid of the live child, so cancel can tree-kill any subprocesses.
    child_pid: Option<u32>,
}

/// Manages active `no-mistakes` runs. Registered as Tauri state (`Arc<NoMistakesManager>`).
pub struct NoMistakesManager {
    runs: Mutex<HashMap<String, RunState>>,
}

impl NoMistakesManager {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// Probe the environment: whether the binary is installed, its version, and
    /// whether `axi status` succeeds in `cwd`.
    pub async fn check(&self, cwd: String) -> NmCheckResult {
        let dir = cwd.clone();
        let path = Path::new(&dir);

        // Installed + version from `no-mistakes --version`.
        let (installed, version) =
            match run_command_async(NM_BIN, &["--version".to_string()], Some(path), &[]).await {
                Ok(out) => {
                    let combined = format!("{}{}", out.stdout, out.stderr);
                    (true, extract_version(&combined))
                }
                Err(_) => (false, None),
            };

        // Status probe from `no-mistakes axi status`.
        let (status_ok, raw_status) = match run_command_async(
            NM_BIN,
            &["axi".to_string(), "status".to_string()],
            Some(path),
            &[],
        )
        .await
        {
            Ok(out) => (out.success, format!("{}{}", out.stdout, out.stderr)),
            Err(e) => (false, e),
        };

        NmCheckResult {
            installed,
            version,
            status_ok,
            raw_status,
        }
    }

    /// Start a validation run. Errors if a run with `run_id` already exists or
    /// another run is active for the same `cwd`.
    pub fn start_run(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: String,
        cwd: String,
        intent: String,
    ) -> Result<(), String> {
        {
            let runs = self.runs.lock();
            if runs.contains_key(&run_id) {
                return Err(format!("A run with id '{}' already exists", run_id));
            }
            if runs.values().any(|r| r.cwd == cwd) {
                return Err(format!(
                    "Another no-mistakes run is already active for '{}'",
                    cwd
                ));
            }
        }

        let args = vec![
            "axi".to_string(),
            "run".to_string(),
            "--intent".to_string(),
            intent,
        ];
        self.insert_and_drive(app, run_id, cwd, args);
        Ok(())
    }

    /// Resolve a decision gate. Valid only when the run is `AwaitingGate`.
    pub fn respond(
        self: &Arc<Self>,
        app: AppHandle,
        run_id: String,
        action: String,
        findings: Vec<String>,
    ) -> Result<(), String> {
        let cwd = {
            let mut runs = self.runs.lock();
            let state = runs
                .get_mut(&run_id)
                .ok_or_else(|| format!("Unknown run '{}'", run_id))?;
            if state.phase != Phase::AwaitingGate {
                return Err(format!("Run '{}' is not waiting at a gate", run_id));
            }
            state.phase = Phase::Running;
            state.cwd.clone()
        };

        let mut args = vec![
            "axi".to_string(),
            "respond".to_string(),
            "--action".to_string(),
            action,
        ];
        if !findings.is_empty() {
            args.push("--findings".to_string());
            args.push(findings.join(","));
        }

        self.spawn_driver(app, run_id, cwd, args);
        Ok(())
    }

    /// Cancel a run: kill any live child, emit `nm-done` (cancelled), remove it.
    pub fn cancel(self: &Arc<Self>, app: AppHandle, run_id: String) -> Result<(), String> {
        let state = {
            let mut runs = self.runs.lock();
            runs.remove(&run_id)
                .ok_or_else(|| format!("Unknown run '{}'", run_id))?
        };

        // Abort the driver task (its child is spawned with kill_on_drop) and the poller.
        if let Some(h) = state.run_abort {
            h.abort();
        }
        if let Some(h) = state.poll_abort {
            h.abort();
        }
        // Best-effort tree-kill so subprocesses spawned by the child die too.
        if let Some(pid) = state.child_pid {
            kill_process_tree(pid);
        }

        emit_or_log(
            &app,
            &format!("nm-done-{}", run_id),
            DonePayload {
                outcome: "cancelled".to_string(),
                message: "Run cancelled by user".to_string(),
                raw: String::new(),
            },
        );
        log::info!("[no-mistakes] run '{}' cancelled", run_id);
        Ok(())
    }

    /// Insert a fresh `Running` state then spawn the driver for it.
    fn insert_and_drive(self: &Arc<Self>, app: AppHandle, run_id: String, cwd: String, args: Vec<String>) {
        {
            let mut runs = self.runs.lock();
            runs.insert(
                run_id.clone(),
                RunState {
                    cwd: cwd.clone(),
                    phase: Phase::Running,
                    run_abort: None,
                    poll_abort: None,
                    child_pid: None,
                },
            );
        }
        self.spawn_driver(app, run_id, cwd, args);
    }

    /// Spawn the driver task for an already-registered run and record its abort handle.
    fn spawn_driver(self: &Arc<Self>, app: AppHandle, run_id: String, cwd: String, args: Vec<String>) {
        let manager = Arc::clone(self);
        let handle = tokio::spawn(drive_run(manager, app, run_id.clone(), cwd, args));
        let mut runs = self.runs.lock();
        if let Some(state) = runs.get_mut(&run_id) {
            state.run_abort = Some(handle.abort_handle());
        }
    }
}

impl Default for NoMistakesManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Driver task ────────────────────────────────────────────────────────────────

/// Run one `axi` subcommand to completion: stream its output, poll status, then
/// parse the captured output into a gate or a terminal outcome.
async fn drive_run(
    manager: Arc<NoMistakesManager>,
    app: AppHandle,
    run_id: String,
    cwd: String,
    args: Vec<String>,
) {
    log::info!("[no-mistakes] run '{}' starting: {} {:?}", run_id, NM_BIN, args);

    let mut cmd = tokio::process::Command::new(NM_BIN);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::proc::CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to start {}: {}", NM_BIN, e);
            log::error!("[no-mistakes] {}", msg);
            finish_run(&manager, &app, &run_id, "error", &msg, "");
            return;
        }
    };

    // Record pid so cancel can tree-kill; bail if the run vanished (cancelled).
    {
        let mut runs = manager.runs.lock();
        match runs.get_mut(&run_id) {
            Some(state) => state.child_pid = child.id(),
            None => return,
        }
    }

    // Start the status poller.
    let poll_handle = tokio::spawn(poll_status(app.clone(), run_id.clone(), cwd.clone()));
    {
        let mut runs = manager.runs.lock();
        if let Some(state) = runs.get_mut(&run_id) {
            state.poll_abort = Some(poll_handle.abort_handle());
        }
    }

    // Stream stdout + stderr concurrently into `nm-log` events and a shared buffer.
    let buf = Arc::new(Mutex::new(String::new()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_fut = stream_lines(stdout, app.clone(), run_id.clone(), Arc::clone(&buf));
    let err_fut = stream_lines(stderr, app.clone(), run_id.clone(), Arc::clone(&buf));
    tokio::join!(out_fut, err_fut);

    let status = child.wait().await;
    poll_handle.abort();

    let raw = buf.lock().clone();

    // Emit a final status snapshot parsed from the full output.
    let steps = extract_steps(&raw);
    emit_or_log(
        &app,
        &format!("nm-status-{}", run_id),
        StatusPayload {
            steps,
            raw: raw.clone(),
        },
    );

    // Decide the result under the lock so we don't race a concurrent cancel.
    enum Decision {
        Gate,
        Done { outcome: String },
        Cancelled,
    }

    let exit_code = status.as_ref().ok().and_then(|s| s.code());
    let decision = {
        let mut runs = manager.runs.lock();
        if !runs.contains_key(&run_id) {
            Decision::Cancelled
        } else if has_gate(&raw) {
            if let Some(state) = runs.get_mut(&run_id) {
                state.phase = Phase::AwaitingGate;
                state.child_pid = None;
            }
            Decision::Gate
        } else {
            runs.remove(&run_id);
            let outcome = extract_outcome(&raw).unwrap_or_else(|| match exit_code {
                Some(0) => "passed".to_string(),
                _ => "failed".to_string(),
            });
            Decision::Done { outcome }
        }
    };

    match decision {
        Decision::Cancelled => {
            log::info!("[no-mistakes] run '{}' driver exiting (cancelled)", run_id);
        }
        Decision::Gate => {
            let findings = extract_findings(&raw);
            log::info!(
                "[no-mistakes] run '{}' reached gate with {} finding(s)",
                run_id,
                findings.len()
            );
            emit_or_log(
                &app,
                &format!("nm-gate-{}", run_id),
                GatePayload { findings, raw },
            );
        }
        Decision::Done { outcome } => {
            log::info!("[no-mistakes] run '{}' finished: {}", run_id, outcome);
            emit_or_log(
                &app,
                &format!("nm-done-{}", run_id),
                DonePayload {
                    outcome,
                    message: String::new(),
                    raw,
                },
            );
        }
    }
}

/// Emit a terminal `nm-done` and drop the run from the map (used for spawn failures).
fn finish_run(
    manager: &Arc<NoMistakesManager>,
    app: &AppHandle,
    run_id: &str,
    outcome: &str,
    message: &str,
    raw: &str,
) {
    {
        let mut runs = manager.runs.lock();
        runs.remove(run_id);
    }
    emit_or_log(
        app,
        &format!("nm-done-{}", run_id),
        DonePayload {
            outcome: outcome.to_string(),
            message: message.to_string(),
            raw: raw.to_string(),
        },
    );
}

/// Read lines from a child stream, emitting each as an `nm-log` event and
/// appending it to the shared capture buffer. A `None` stream is a no-op.
async fn stream_lines<R>(
    stream: Option<R>,
    app: AppHandle,
    run_id: String,
    buf: Arc<Mutex<String>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(stream) = stream else { return };
    let mut lines = BufReader::new(stream).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                emit_or_log(
                    &app,
                    &format!("nm-log-{}", run_id),
                    LogPayload { line: line.clone() },
                );
                let mut b = buf.lock();
                b.push_str(&line);
                b.push('\n');
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

/// Poll `axi status` on a timer, emitting `nm-status` with parsed steps. Runs
/// until aborted by the driver (child exit) or by cancel.
async fn poll_status(app: AppHandle, run_id: String, cwd: String) {
    let path = Path::new(&cwd);
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(STATUS_POLL_MS)).await;
        let raw = match run_command_async(
            NM_BIN,
            &["axi".to_string(), "status".to_string()],
            Some(path),
            &[],
        )
        .await
        {
            Ok(out) => format!("{}{}", out.stdout, out.stderr),
            Err(_) => continue,
        };
        let steps = extract_steps(&raw);
        emit_or_log(
            &app,
            &format!("nm-status-{}", run_id),
            StatusPayload { steps, raw },
        );
    }
}

/// Kill a process and its descendants (Windows: `taskkill /T`; Unix: SIGKILL).
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(crate::proc::CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn();
    }
}

// ── TOON heuristic extractors ──────────────────────────────────────────────────

/// Canonical pipeline step names, in pipeline order.
const CANONICAL_STEPS: [&str; 7] = ["review", "test", "docs", "lint", "push", "pr", "ci"];

/// Extract a semver-ish version token from `--version` output, else `None`.
pub fn extract_version(raw: &str) -> Option<String> {
    let re = regex::Regex::new(r"\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?").ok()?;
    re.find(raw).map(|m| m.as_str().to_string())
}

/// Normalize a raw status word to the contract's status set.
fn normalize_status(word: &str) -> Option<&'static str> {
    let w = word.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
    match w.to_ascii_lowercase().as_str() {
        "running" | "in-progress" | "in_progress" | "active" | "started" => Some("running"),
        "passed" | "pass" | "ok" | "done" | "success" | "succeeded" | "complete" | "completed" => {
            Some("passed")
        }
        "failed" | "fail" | "error" | "errored" => Some("failed"),
        "skipped" | "skip" => Some("skipped"),
        "pending" | "queued" | "waiting" | "todo" | "not-started" | "not_started" => Some("pending"),
        _ => None,
    }
}

/// Map an arbitrary reported step name to canonical form when recognized, else lowercased.
fn canonical_step(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    // Accept a few obvious aliases for the two-letter steps.
    let mapped = match n.as_str() {
        "pull-request" | "pull_request" | "pullrequest" => "pr",
        "continuous-integration" | "ci-checks" => "ci",
        "linting" => "lint",
        "review" | "tests" => {
            if n == "tests" {
                "test"
            } else {
                "review"
            }
        }
        other => other,
    };
    mapped.to_string()
}

/// Scan output for `<step> <status>` pairs. Returns steps in first-seen order,
/// with later occurrences updating a step's status. Empty when nothing recognized.
pub fn extract_steps(raw: &str) -> Vec<NmStep> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, String> = HashMap::new();

    for line in raw.lines() {
        // Tokenize on the common TOON/table separators.
        let tokens: Vec<&str> = line
            .split(|c: char| c == ':' || c == ',' || c == '|' || c.is_whitespace())
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .collect();
        if tokens.is_empty() {
            continue;
        }
        // The step name must be one of the first two tokens (avoids matching a
        // canonical word buried mid-sentence).
        let name_pos = tokens
            .iter()
            .take(2)
            .position(|t| CANONICAL_STEPS.contains(&t.to_ascii_lowercase().as_str()));
        let Some(pos) = name_pos else { continue };
        let name = canonical_step(tokens[pos]);
        // First recognizable status word after the name.
        let status = tokens[pos + 1..]
            .iter()
            .find_map(|t| normalize_status(t))
            .unwrap_or("unknown")
            .to_string();

        if !map.contains_key(&name) {
            order.push(name.clone());
        }
        map.insert(name, status);
    }

    order
        .into_iter()
        .map(|name| {
            let status = map.get(&name).cloned().unwrap_or_else(|| "unknown".to_string());
            NmStep { name, status }
        })
        .collect()
}

/// Whether the output represents a decision gate: an explicit `gate` key/section,
/// or any parseable findings.
pub fn has_gate(raw: &str) -> bool {
    for line in raw.lines() {
        let t = line.trim().to_ascii_lowercase();
        if t == "gate" || t.starts_with("gate:") || t.starts_with("gate[") || t.starts_with("gate{")
        {
            return true;
        }
    }
    !extract_findings(raw).is_empty()
}

/// Prefer an explicit `outcome:`/`result:`/`status:` key line; otherwise fall
/// back to a word-boundary token search (ignoring step lines), preferring the
/// last occurrence.
pub fn extract_outcome(raw: &str) -> Option<String> {
    const TOKENS: [&str; 4] = ["checks-passed", "passed", "failed", "cancelled"];

    // Pass 1: explicit key lines (last one wins).
    let mut key_hit: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if key == "outcome" || key == "result" {
            if let Some(tok) = match_outcome_token(value, &TOKENS) {
                key_hit = Some(tok);
            }
        } else if key == "status" {
            // `status:` can also be a step; only accept a terminal token here.
            if let Some(tok) = match_outcome_token(value, &TOKENS) {
                key_hit = Some(tok);
            }
        }
    }
    if key_hit.is_some() {
        return key_hit;
    }

    // Pass 2: token search over non-step lines, last occurrence wins.
    let mut fallback: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        // Skip lines keyed by a canonical step name (e.g. "review: passed").
        if let Some((key, _)) = trimmed.split_once(':') {
            if CANONICAL_STEPS.contains(&key.trim().to_ascii_lowercase().as_str()) {
                continue;
            }
        }
        if let Some(tok) = match_outcome_token(trimmed, &TOKENS) {
            fallback = Some(tok);
        }
    }
    fallback
}

/// Find a terminal-outcome token in `text` using word boundaries. Prefers the
/// longest/last match so `checks-passed` isn't shadowed by `passed`.
fn match_outcome_token(text: &str, tokens: &[&str]) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    // Rank by end position, then by token length: overlapping matches that share
    // an end (e.g. `checks-passed` vs `passed`) resolve to the longer token, while
    // distinct occurrences still prefer the last one.
    let mut best: Option<(usize, usize, String)> = None; // (end, len, token)
    for tok in tokens {
        let mut from = 0;
        while let Some(rel) = lower[from..].find(tok) {
            let start = from + rel;
            let end = start + tok.len();
            let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
            let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
            if before_ok && after_ok {
                let better = match &best {
                    None => true,
                    Some((be, bl, _)) => end > *be || (end == *be && tok.len() > *bl),
                };
                if better {
                    best = Some((end, tok.len(), (*tok).to_string()));
                }
            }
            from = start + 1;
        }
    }
    best.map(|(_, _, t)| t)
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Extract gate findings, trying (in order) a TOON tabular header, a pipe/aligned
/// table, then repeated indented key/value blocks. Returns the first non-empty result.
pub fn extract_findings(raw: &str) -> Vec<NmFinding> {
    let t = extract_findings_toon_table(raw);
    if !t.is_empty() {
        return t;
    }
    let p = extract_findings_pipe_table(raw);
    if !p.is_empty() {
        return p;
    }
    extract_findings_blocks(raw)
}

/// Split a comma-separated TOON row, honoring `"..."` quoting (with `""` escapes).
fn split_csv_row(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes {
                    if chars.peek() == Some(&'"') {
                        cur.push('"');
                        chars.next();
                    } else {
                        in_quotes = false;
                    }
                } else {
                    in_quotes = true;
                }
            }
            ',' if !in_quotes => {
                fields.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

/// Build an NmFinding from column names + row values, positionally by column.
fn finding_from_columns(cols: &[String], values: &[String]) -> NmFinding {
    let get = |name: &str| -> String {
        cols.iter()
            .position(|c| c.eq_ignore_ascii_case(name))
            .and_then(|i| values.get(i))
            .cloned()
            .unwrap_or_default()
    };
    NmFinding {
        id: get("id"),
        severity: get("severity"),
        file: get("file"),
        action: get("action"),
        description: get("description"),
    }
}

/// Parse a TOON tabular block: `findings[N]{id,severity,file,action,description}:`
/// followed by indented comma-separated rows.
fn extract_findings_toon_table(raw: &str) -> Vec<NmFinding> {
    let header_re =
        regex::Regex::new(r"(?i)findings\s*\[\s*\d*\s*\]\s*\{([^}]*)\}\s*:").ok();
    let Some(header_re) = header_re else {
        return Vec::new();
    };

    let lines: Vec<&str> = raw.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(caps) = header_re.captures(line) else {
            continue;
        };
        let cols: Vec<String> = caps[1]
            .split(',')
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect();
        if cols.is_empty() {
            continue;
        }
        let header_indent = indent_of(line);

        let mut findings = Vec::new();
        for row_line in &lines[i + 1..] {
            let trimmed = row_line.trim();
            if trimmed.is_empty() {
                break;
            }
            // Rows are indented deeper than the header (or bulleted).
            let is_row = indent_of(row_line) > header_indent || trimmed.starts_with('-');
            if !is_row {
                break;
            }
            let body = trimmed.trim_start_matches('-').trim();
            let values = split_csv_row(body);
            // Merge overflow (unquoted commas) into the last column.
            let values = clamp_values(values, cols.len());
            findings.push(finding_from_columns(&cols, &values));
        }
        if !findings.is_empty() {
            return findings;
        }
    }
    Vec::new()
}

/// If there are more values than columns, join the surplus into the final column.
fn clamp_values(mut values: Vec<String>, ncols: usize) -> Vec<String> {
    if ncols == 0 || values.len() <= ncols {
        return values;
    }
    let tail = values.split_off(ncols - 1).join(", ");
    values.push(tail);
    values
}

/// Leading-whitespace width of a line.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Parse a pipe/aligned table with an `id | severity | file | action | description`
/// header followed by `|`-delimited rows.
fn extract_findings_pipe_table(raw: &str) -> Vec<NmFinding> {
    let lines: Vec<&str> = raw.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if !line.contains('|') {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if !(lower.contains("id") && lower.contains("severity")) {
            continue;
        }
        let cols: Vec<String> = split_pipe_row(line);
        if cols.len() < 2 {
            continue;
        }

        let mut findings = Vec::new();
        for row_line in &lines[i + 1..] {
            if !row_line.contains('|') {
                break;
            }
            let trimmed = row_line.trim();
            // Skip separator rows like `|---|---|`.
            if trimmed
                .chars()
                .all(|c| c == '-' || c == '|' || c == ':' || c == ' ' || c == '+')
            {
                continue;
            }
            let values = split_pipe_row(row_line);
            if values.iter().all(|v| v.is_empty()) {
                break;
            }
            findings.push(finding_from_columns(&cols, &values));
        }
        if !findings.is_empty() {
            return findings;
        }
    }
    Vec::new()
}

/// Split a `|`-delimited row, dropping empty leading/trailing cells.
fn split_pipe_row(line: &str) -> Vec<String> {
    let parts: Vec<String> = line.split('|').map(|p| p.trim().to_string()).collect();
    let start = if parts.first().map(|s| s.is_empty()).unwrap_or(false) {
        1
    } else {
        0
    };
    let end = if parts.last().map(|s| s.is_empty()).unwrap_or(false) {
        parts.len().saturating_sub(1)
    } else {
        parts.len()
    };
    if start >= end {
        return Vec::new();
    }
    parts[start..end].to_vec()
}

/// Parse repeated indented key/value blocks, each starting at an `id:` key.
fn extract_findings_blocks(raw: &str) -> Vec<NmFinding> {
    let keys = ["id", "severity", "file", "action", "description"];
    let mut findings = Vec::new();
    let mut current: Option<NmFinding> = None;
    let mut has_field = false;

    for line in raw.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if !keys.contains(&key.as_str()) {
            continue;
        }
        let value = value.trim().trim_matches('"').to_string();

        if key == "id" {
            if let Some(f) = current.take() {
                if has_field {
                    findings.push(f);
                }
            }
            let mut f = NmFinding::default();
            f.id = value;
            current = Some(f);
            has_field = true;
            continue;
        }

        let f = current.get_or_insert_with(NmFinding::default);
        has_field = true;
        match key.as_str() {
            "severity" => f.severity = value,
            "file" => f.file = value,
            "action" => f.action = value,
            "description" => f.description = value,
            _ => {}
        }
    }
    if let Some(f) = current.take() {
        if has_field {
            findings.push(f);
        }
    }
    // Require at least an id or description so stray key lines don't produce noise.
    findings
        .into_iter()
        .filter(|f| !f.id.is_empty() || !f.description.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_extraction() {
        assert_eq!(extract_version("no-mistakes version 1.4.2"), Some("1.4.2".to_string()));
        assert_eq!(extract_version("v0.9"), Some("0.9".to_string()));
        assert_eq!(extract_version("1.2.3-beta.1"), Some("1.2.3-beta.1".to_string()));
        assert_eq!(extract_version("no version here"), None);
    }

    #[test]
    fn steps_toon_keyed() {
        let raw = "\
pipeline:
  review: passed
  test: running
  docs: pending
  lint: skipped
  push: failed
";
        let steps = extract_steps(raw);
        assert_eq!(
            steps,
            vec![
                NmStep { name: "review".into(), status: "passed".into() },
                NmStep { name: "test".into(), status: "running".into() },
                NmStep { name: "docs".into(), status: "pending".into() },
                NmStep { name: "lint".into(), status: "skipped".into() },
                NmStep { name: "push".into(), status: "failed".into() },
            ]
        );
    }

    #[test]
    fn steps_synonyms_and_table() {
        let raw = "\
| review | ok |
| test   | in-progress |
| pr     | queued |
| ci     | success |
";
        let steps = extract_steps(raw);
        assert_eq!(
            steps,
            vec![
                NmStep { name: "review".into(), status: "passed".into() },
                NmStep { name: "test".into(), status: "running".into() },
                NmStep { name: "pr".into(), status: "pending".into() },
                NmStep { name: "ci".into(), status: "passed".into() },
            ]
        );
    }

    #[test]
    fn steps_later_occurrence_updates() {
        let raw = "review: running\nreview: passed\n";
        let steps = extract_steps(raw);
        assert_eq!(steps, vec![NmStep { name: "review".into(), status: "passed".into() }]);
    }

    #[test]
    fn steps_empty_when_unrecognized() {
        assert!(extract_steps("nothing to see here\nfoo: bar\n").is_empty());
    }

    #[test]
    fn findings_toon_table() {
        let raw = "\
gate:
  findings[2]{id,severity,file,action,description}:
    F1,high,src/main.rs,ask-user,Null deref possible
    F2,low,src/util.rs,auto-fix,Unused import
";
        let f = extract_findings(raw);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].id, "F1");
        assert_eq!(f[0].severity, "high");
        assert_eq!(f[0].file, "src/main.rs");
        assert_eq!(f[0].action, "ask-user");
        assert_eq!(f[0].description, "Null deref possible");
        assert_eq!(f[1].id, "F2");
        assert_eq!(f[1].action, "auto-fix");
    }

    #[test]
    fn findings_toon_table_quoted_comma() {
        // Description contains a comma, protected by quotes.
        let raw = "\
findings[1]{id,severity,file,action,description}:
  F9,medium,a.rs,no-op,\"Handles a, b and c\"
";
        let f = extract_findings(raw);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].id, "F9");
        assert_eq!(f[0].description, "Handles a, b and c");
    }

    #[test]
    fn findings_toon_table_unquoted_overflow() {
        // No quotes: surplus commas fold into the last (description) column.
        let raw = "\
findings[1]{id,severity,file,action,description}:
  F3,high,a.rs,ask-user,Do x, then y
";
        let f = extract_findings(raw);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].description, "Do x, then y");
    }

    #[test]
    fn findings_pipe_table() {
        let raw = "\
gate
| id | severity | file | action | description |
|----|----------|------|--------|-------------|
| F1 | high | src/a.rs | ask-user | Possible panic |
| F2 | low  | src/b.rs | no-op    | Style nit |
";
        let f = extract_findings(raw);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].id, "F1");
        assert_eq!(f[0].file, "src/a.rs");
        assert_eq!(f[1].action, "no-op");
        assert_eq!(f[1].description, "Style nit");
    }

    #[test]
    fn findings_blocks() {
        let raw = "\
gate:
  - id: F1
    severity: high
    file: src/main.rs
    action: ask-user
    description: Check this
  - id: F2
    severity: low
    file: src/lib.rs
    action: auto-fix
    description: Trivial
";
        let f = extract_findings(raw);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].id, "F1");
        assert_eq!(f[0].description, "Check this");
        assert_eq!(f[1].id, "F2");
        assert_eq!(f[1].action, "auto-fix");
    }

    #[test]
    fn has_gate_detection() {
        assert!(has_gate("gate:\n  findings[0]{}:\n"));
        assert!(has_gate("| id | severity | file | action | description |\n| F1 | high | a | no-op | x |\n"));
        assert!(!has_gate("review: passed\ntest: passed\noutcome: passed\n"));
    }

    #[test]
    fn outcome_key_line_wins() {
        let raw = "review: passed\ntest: passed\noutcome: checks-passed\n";
        assert_eq!(extract_outcome(raw), Some("checks-passed".to_string()));
    }

    #[test]
    fn outcome_result_key() {
        let raw = "result: failed\n";
        assert_eq!(extract_outcome(raw), Some("failed".to_string()));
    }

    #[test]
    fn outcome_ignores_step_lines_in_fallback() {
        // No key line; "passed" only appears on step lines, which are skipped.
        let raw = "review: passed\ntest: passed\n";
        assert_eq!(extract_outcome(raw), None);
    }

    #[test]
    fn outcome_fallback_token_last_wins() {
        let raw = "some log line\nthe run was cancelled\n";
        assert_eq!(extract_outcome(raw), Some("cancelled".to_string()));
    }

    #[test]
    fn outcome_checks_passed_not_shadowed() {
        let raw = "final: all checks-passed\n";
        assert_eq!(extract_outcome(raw), Some("checks-passed".to_string()));
    }
}
