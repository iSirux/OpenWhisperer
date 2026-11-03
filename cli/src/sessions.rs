//! `ow sessions` and `ow transcript`: read-only views of the app's agent
//! sessions, read straight from its files (no app round trip, works while the
//! app is closed).
//!
//! Sources, both written by the app:
//! - live sessions: `sessions[-dev]/index.json` + `sessions[-dev]/data/<id>.json`
//! - archived sessions: `archive[-dev]/index.json` + `archive[-dev]/sessions/<id>.json`
//!
//! The live index only carries id/name/model/cwd/status/times/cost, so every
//! live session that is going to be listed has its data file opened for the
//! rest (effort, message counts, schedule, PR). Archive index entries written
//! by app versions with the `ow sessions` fields (marked by `userMessageCount`)
//! are complete on their own; older entries get the same backfill from their
//! session file. Filtering by time and repo happens on the indexes first, and
//! files are only opened for rows that are actually printed (or, with
//! `--scheduled` / `--interactive`, examined), so `--since` / `--limit` bound
//! the cost.

use std::collections::HashSet;

use chrono::Local;
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::appdata::{read_json, AppData};
use crate::timeparse;

// ---------------------------------------------------------------------------
// On-disk shapes (only the fields read here; everything else is skipped)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct Config {
    #[serde(default)]
    repos: Vec<RepoConf>,
}

#[derive(Deserialize)]
struct RepoConf {
    #[serde(default)]
    id: Option<String>,
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct Index<E> {
    #[serde(default = "Vec::new")]
    entries: Vec<E>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveEntry {
    id: String,
    session_type: Option<String>,
    name: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_at: u64,
    last_activity_at: Option<u64>,
    total_cost: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveEntry {
    id: String,
    session_type: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    repo_path: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_at: u64,
    archived_at: Option<u64>,
    total_cost: Option<f64>,
    message_count: Option<u32>,
    cwd: Option<String>,
    effort_level: Option<String>,
    last_activity_at: Option<u64>,
    user_message_count: Option<u32>,
    schedule_id: Option<String>,
    schedule_label: Option<String>,
    pr_number: Option<u64>,
    pr_state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile<M> {
    cwd: Option<String>,
    repo_id: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    effort_level: Option<String>,
    status: Option<String>,
    last_activity_at: Option<u64>,
    created_branch: Option<String>,
    current_branch: Option<String>,
    #[serde(default = "Vec::new")]
    messages: Vec<M>,
    usage: Option<Usage>,
    ai_metadata: Option<AiMetadata>,
    schedule_tag: Option<ScheduleTag>,
    pr: Option<PrSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    #[serde(alias = "totalCost")]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    query_usage: Vec<QueryUsageSample>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryUsageSample {
    total_cost_usd: Option<f64>,
}

/// Session cost rebuilt from the raw per-result records. Each record's
/// `totalCostUsd` is the Claude CLI process's running total, and app builds
/// before the fix summed it every turn, so the stored session total can be
/// inflated many times over. Same rule as the app's `correctedCumulativeTotals`
/// (`src/lib/utils/usageCost.ts`): growth counts; a drop is a new process and
/// counts in full, unless it equals a total already seen (restored on resume,
/// nothing spent yet). Zero records carry no information.
fn corrected_cost(samples: &[QueryUsageSample]) -> f64 {
    const EPSILON: f64 = 1e-9;
    let mut last = 0.0;
    let mut total = 0.0;
    let mut seen: Vec<f64> = Vec::new();
    for cost in samples.iter().filter_map(|s| s.total_cost_usd).filter(|c| c.is_finite() && *c > 0.0) {
        if cost >= last - EPSILON {
            total += cost - last;
        } else if !seen.iter().any(|v| (v - cost).abs() < EPSILON) {
            total += cost;
        }
        last = cost;
        seen.push(cost);
    }
    total
}

#[derive(Deserialize)]
struct AiMetadata {
    name: Option<String>,
}

#[derive(Deserialize)]
struct ScheduleTag {
    id: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrSummary {
    number: Option<u64>,
    state: Option<String>,
    is_draft: Option<bool>,
}

/// What listing needs of a message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageHead {
    #[serde(rename = "type")]
    kind: String,
    content: Option<String>,
    queued: Option<String>,
}

/// What a transcript needs of a message (tool output is never read).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    #[serde(rename = "type")]
    kind: String,
    content: Option<String>,
    tool: Option<String>,
    input: Option<Value>,
    parent_tool_use_id: Option<String>,
    queued: Option<String>,
    timestamp: Option<u64>,
    images: Option<Vec<IgnoredAny>>,
}

trait MessageLike {
    fn kind(&self) -> &str;
    fn content(&self) -> Option<&str>;
    fn is_queued(&self) -> bool;
}

impl MessageLike for MessageHead {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }
    fn is_queued(&self) -> bool {
        self.queued.is_some()
    }
}

impl MessageLike for Message {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn content(&self) -> Option<&str> {
        self.content.as_deref()
    }
    fn is_queued(&self) -> bool {
        self.queued.is_some()
    }
}

// ---------------------------------------------------------------------------
// Output rows
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct ScheduleRef {
    pub id: Option<String>,
    pub label: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PrRef {
    pub number: Option<u64>,
    /// "open" | "draft" | "merged" | "closed"
    pub state: Option<String>,
}

/// One session as `ow sessions` reports it. Fields read from the session file
/// are `null` when that file is missing (`detailsAvailable: false`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub name: Option<String>,
    /// Registered repository name
    pub repo: Option<String>,
    pub repo_path: Option<String>,
    /// Working directory (the worktree for worktree sessions)
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    /// "off" | "low" | … | "max"
    pub effort: Option<String>,
    pub status: String,
    pub archived: bool,
    pub created_at: u64,
    pub last_activity_at: Option<u64>,
    pub archived_at: Option<u64>,
    /// User prompts sent (queued, not-yet-sent turns excluded)
    pub user_messages: Option<u32>,
    /// All transcript entries (tool calls, results, thinking … included)
    pub messages: Option<u32>,
    /// The native schedule that launched it; `null` = interactive
    pub schedule: Option<ScheduleRef>,
    pub pr: Option<PrRef>,
    /// USD
    pub cost: Option<f64>,
    /// First user prompt, truncated to 200 characters
    pub prompt: Option<String>,
    pub details_available: bool,
}

impl SessionRow {
    /// Last activity, else (archived) the archive time, else creation.
    fn activity(&self) -> u64 {
        self.last_activity_at
            .or(self.archived_at)
            .unwrap_or(self.created_at)
    }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

struct Repos(Vec<RepoConf>);

impl Repos {
    fn load(data: &AppData) -> Self {
        let config: Config = read_json(&data.config_file()).ok().flatten().unwrap_or_default();
        Self(config.repos)
    }

    fn by_id(&self, id: &str) -> Option<&RepoConf> {
        self.0.iter().find(|r| r.id.as_deref() == Some(id))
    }

    /// The repository a path belongs to: exact match, then the app's worktree
    /// convention (`<parent>/<repo>-worktrees/<branch>`), then the longest
    /// registered repo containing it.
    fn for_path(&self, path: &str) -> Option<&RepoConf> {
        let wanted = norm(path);
        if let Some(repo) = self.0.iter().find(|r| norm(&r.path) == wanted) {
            return Some(repo);
        }
        if let Some(main) = main_repo_from_worktree(&wanted) {
            if let Some(repo) = self.0.iter().find(|r| norm(&r.path) == main) {
                return Some(repo);
            }
        }
        self.0
            .iter()
            .filter(|r| wanted.starts_with(&format!("{}/", norm(&r.path))))
            .max_by_key(|r| r.path.len())
    }
}

/// Comparable form of a path: forward slashes, no trailing slash, and
/// lowercase on Windows.
fn norm(path: &str) -> String {
    let s = path.trim().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// `<parent>/<repo>-worktrees/<branch>` → `<parent>/<repo>` (normalized input).
fn main_repo_from_worktree(normalized: &str) -> Option<String> {
    let (worktrees_dir, _branch) = normalized.rsplit_once('/')?;
    let (parent, dir_name) = worktrees_dir.rsplit_once('/')?;
    let repo = dir_name.strip_suffix("-worktrees").filter(|r| !r.is_empty())?;
    Some(format!("{parent}/{repo}"))
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

fn live_row(entry: LiveEntry, repos: &Repos) -> SessionRow {
    let repo = entry.cwd.as_deref().and_then(|cwd| repos.for_path(cwd));
    SessionRow {
        repo: repo.map(|r| r.name.clone()),
        repo_path: repo.map(|r| r.path.clone()),
        id: entry.id,
        name: entry.name,
        cwd: entry.cwd,
        branch: None,
        model: entry.model,
        provider: None,
        effort: None,
        status: entry.status,
        archived: false,
        created_at: entry.created_at,
        last_activity_at: entry.last_activity_at,
        archived_at: None,
        user_messages: None,
        messages: None,
        schedule: None,
        pr: None,
        cost: entry.total_cost,
        prompt: None,
        details_available: false,
    }
}

fn archive_row(entry: ArchiveEntry, repos: &Repos) -> SessionRow {
    let repo = entry
        .repo_path
        .as_deref()
        .and_then(|path| repos.for_path(path))
        .or_else(|| entry.cwd.as_deref().and_then(|cwd| repos.for_path(cwd)));
    // Entries carrying `userMessageCount` were written with every field below.
    let complete = entry.user_message_count.is_some();
    SessionRow {
        repo: repo.map(|r| r.name.clone()),
        repo_path: entry.repo_path.or_else(|| repo.map(|r| r.path.clone())),
        id: entry.id,
        name: entry.name,
        cwd: entry.cwd,
        branch: None,
        model: entry.model,
        provider: None,
        effort: complete.then(|| entry.effort_level.unwrap_or_else(|| "off".to_string())),
        status: entry.status,
        archived: true,
        created_at: entry.created_at,
        last_activity_at: entry.last_activity_at,
        archived_at: entry.archived_at,
        user_messages: entry.user_message_count,
        messages: entry.message_count,
        schedule: entry.schedule_id.map(|id| ScheduleRef {
            id: Some(id),
            label: entry.schedule_label,
        }),
        pr: entry.pr_number.map(|number| PrRef {
            number: Some(number),
            state: entry.pr_state,
        }),
        cost: entry.total_cost,
        prompt: entry.prompt,
        details_available: complete,
    }
}

/// Fill a row from its session file.
fn enrich<M: MessageLike>(row: &mut SessionRow, file: &SessionFile<M>, repos: &Repos) {
    if let Some(cwd) = file.cwd.as_deref().filter(|c| !c.is_empty()) {
        row.cwd = Some(cwd.to_string());
    }
    let repo = file
        .repo_id
        .as_deref()
        .and_then(|id| repos.by_id(id))
        .or_else(|| row.cwd.as_deref().and_then(|cwd| repos.for_path(cwd)));
    if let Some(repo) = repo {
        row.repo = Some(repo.name.clone());
        row.repo_path = Some(repo.path.clone());
    }
    row.branch = file
        .current_branch
        .clone()
        .or_else(|| file.created_branch.clone());
    if file.model.is_some() {
        row.model = file.model.clone();
    }
    row.provider = file.provider.clone();
    row.effort = Some(
        file.effort_level
            .clone()
            .unwrap_or_else(|| "off".to_string()),
    );
    if !row.archived {
        if let Some(status) = &file.status {
            row.status = status.clone();
        }
    }
    row.last_activity_at = file.last_activity_at.or(row.last_activity_at);
    row.messages = Some(file.messages.len() as u32);
    row.user_messages = Some(
        file.messages
            .iter()
            .filter(|m| m.kind() == "user" && !m.is_queued())
            .count() as u32,
    );
    if row.prompt.is_none() {
        row.prompt = file
            .messages
            .iter()
            .find(|m| m.kind() == "user")
            .and_then(|m| m.content())
            .map(|c| truncate(c, 200));
    }
    if let Some(name) = file.ai_metadata.as_ref().and_then(|m| m.name.clone()) {
        row.name = Some(name);
    }
    row.schedule = file.schedule_tag.as_ref().map(|tag| ScheduleRef {
        id: tag.id.clone(),
        label: tag.label.clone(),
    });
    row.pr = file.pr.as_ref().map(|pr| PrRef {
        number: pr.number,
        state: pr.state.as_deref().map(|state| {
            if state == "open" && pr.is_draft == Some(true) {
                "draft".to_string()
            } else {
                state.to_string()
            }
        }),
    });
    if let Some(usage) = file.usage.as_ref() {
        let cost = if usage.query_usage.is_empty() {
            usage.total_cost_usd
        } else {
            Some(corrected_cost(&usage.query_usage))
        };
        if cost.is_some() {
            row.cost = cost;
        }
    }
    row.details_available = true;
}

fn session_path(data: &AppData, row: &SessionRow) -> std::path::PathBuf {
    if row.archived {
        data.archived_session(&row.id)
    } else {
        data.live_session(&row.id)
    }
}

/// Every agent session in both indexes (sequence executions excluded), live
/// first; an id in both counts as live.
fn load_rows(data: &AppData, repos: &Repos) -> Result<Vec<SessionRow>, String> {
    let is_sdk = |t: &Option<String>| t.as_deref().map_or(true, |t| t == "sdk");
    let live: Index<LiveEntry> =
        read_json(&data.live_index())?.unwrap_or(Index { entries: Vec::new() });
    let archive: Index<ArchiveEntry> =
        read_json(&data.archive_index())?.unwrap_or(Index { entries: Vec::new() });

    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for entry in live.entries.into_iter().filter(|e| is_sdk(&e.session_type)) {
        seen.insert(entry.id.clone());
        rows.push(live_row(entry, repos));
    }
    for entry in archive.entries.into_iter().filter(|e| is_sdk(&e.session_type)) {
        if !seen.contains(&entry.id) {
            rows.push(archive_row(entry, repos));
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// `ow sessions`
// ---------------------------------------------------------------------------

pub struct ListOptions<'a> {
    pub since: Option<&'a str>,
    pub repo: Option<&'a str>,
    /// `Some(true)` = only scheduled, `Some(false)` = only interactive
    pub scheduled: Option<bool>,
    /// 0 = no limit
    pub limit: usize,
}

#[derive(Serialize)]
pub struct Listing {
    #[serde(rename = "sessions")]
    pub rows: Vec<SessionRow>,
    /// More sessions matched than `limit` allowed
    pub truncated: bool,
}

fn matches_repo(row: &SessionRow, query: &str, repos: &Repos) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    // An exact registered name selects that repository only ("Repos" must not
    // match every path under F:\Repos).
    if repos.0.iter().any(|r| r.name.to_lowercase() == q) {
        return row.repo.as_deref().is_some_and(|name| name.to_lowercase() == q);
    }
    let q_path = q.replace('\\', "/");
    [&row.repo, &row.repo_path, &row.cwd]
        .into_iter()
        .flatten()
        .any(|field| field.to_lowercase().replace('\\', "/").contains(&q_path))
}

pub fn list(data: &AppData, opts: &ListOptions) -> Result<Listing, String> {
    let repos = Repos::load(data);
    let since = opts
        .since
        .map(|s| timeparse::parse_since(s, Local::now()))
        .transpose()?;

    let mut rows: Vec<SessionRow> = load_rows(data, &repos)?
        .into_iter()
        .filter(|row| since.map_or(true, |since| row.activity() as i64 >= since))
        .filter(|row| opts.repo.map_or(true, |q| matches_repo(row, q, &repos)))
        .collect();
    rows.sort_by(|a, b| b.activity().cmp(&a.activity()));

    let mut out = Vec::new();
    let mut truncated = false;
    for mut row in rows {
        if opts.limit > 0 && out.len() >= opts.limit {
            truncated = true;
            break;
        }
        if !row.details_available {
            // Unreadable/missing file: keep the index data, details stay null.
            if let Ok(Some(file)) = read_json::<SessionFile<MessageHead>>(&session_path(data, &row)) {
                enrich(&mut row, &file, &repos);
            }
            // An older archive entry was pre-filtered on its archive time; its
            // real last activity can be earlier.
            if since.is_some_and(|since| (row.activity() as i64) < since) {
                continue;
            }
        }
        if let Some(want_scheduled) = opts.scheduled {
            if !row.details_available || row.schedule.is_some() != want_scheduled {
                continue;
            }
        }
        out.push(row);
    }
    // The file's last activity can differ from the index's.
    out.sort_by(|a, b| b.activity().cmp(&a.activity()));
    Ok(Listing {
        rows: out,
        truncated,
    })
}

pub fn print_table(listing: &Listing) {
    if listing.rows.is_empty() {
        println!("No sessions match.");
        return;
    }
    let mut table: Vec<[String; 10]> = vec![[
        "ID".into(),
        "LAST ACTIVE".into(),
        "REPO".into(),
        "MODEL".into(),
        "EFFORT".into(),
        "MSGS".into(),
        "COST".into(),
        "STATUS".into(),
        "SCHEDULE / PR".into(),
        "NAME".into(),
    ]];
    for row in &listing.rows {
        let unknown = || "?".to_string();
        let msgs = format!(
            "{}/{}",
            row.user_messages.map_or_else(unknown, |n| n.to_string()),
            row.messages.map_or_else(unknown, |n| n.to_string())
        );
        let mut tags = Vec::new();
        if let Some(schedule) = &row.schedule {
            tags.push(format!(
                "sched: {}",
                truncate_plain(schedule.label.as_deref().unwrap_or("?"), 28)
            ));
        }
        if let Some(pr) = &row.pr {
            tags.push(format!(
                "PR #{} {}",
                pr.number.map_or_else(unknown, |n| n.to_string()),
                pr.state.as_deref().unwrap_or("")
            ));
        }
        let tags = if tags.is_empty() {
            if row.details_available { "-".to_string() } else { "?".to_string() }
        } else {
            tags.join(", ")
        };
        table.push([
            short_id(&row.id),
            timeparse::format_local(row.activity() as i64),
            row.repo
                .clone()
                .or_else(|| row.cwd.as_deref().map(basename))
                .unwrap_or_else(|| "-".into()),
            row.model.clone().unwrap_or_else(|| "-".into()),
            row.effort.clone().unwrap_or_else(unknown),
            msgs,
            row.cost.map_or_else(|| "-".into(), |c| format!("${c:.2}")),
            if row.archived { "archived".into() } else { row.status.clone() },
            tags.trim().to_string(),
            truncate_plain(row.name.as_deref().unwrap_or("-"), 60),
        ]);
    }
    print_aligned(&table);

    let archived = listing.rows.iter().filter(|r| r.archived).count();
    println!();
    println!(
        "{} session{} ({} live, {} archived){}",
        listing.rows.len(),
        if listing.rows.len() == 1 { "" } else { "s" },
        listing.rows.len() - archived,
        archived,
        if listing.truncated {
            " — more match; raise --limit (0 = all) or narrow --since/--repo"
        } else {
            ""
        }
    );
}

// ---------------------------------------------------------------------------
// `ow transcript`
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Detail {
    /// User prompts only
    UserOnly,
    /// User prompts, assistant text, errors and interruptions
    Conversation,
    /// … plus one line per tool call and notices
    Full,
}

pub struct TranscriptOptions {
    pub detail: Detail,
    /// 0 = no truncation
    pub max_chars: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    /// "user" | "assistant" | "tool" | "error" | "interrupted" | "notice"
    pub role: &'static str,
    pub timestamp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Image count of a user prompt
    #[serde(skip_serializing_if = "is_zero")]
    pub images: usize,
    /// A turn parked for later that has not been sent yet
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Serialize)]
pub struct Transcript {
    pub session: SessionRow,
    pub messages: Vec<TranscriptEntry>,
}

/// Find a session by full id or unique prefix in both indexes.
fn find_row(rows: Vec<SessionRow>, query: &str) -> Result<SessionRow, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("missing session id".to_string());
    }
    let mut matches: Vec<SessionRow> = Vec::new();
    for row in rows {
        if row.id == query {
            return Ok(row);
        }
        if row.id.starts_with(query) {
            matches.push(row);
        }
    }
    match matches.len() {
        0 => Err(format!("no session with id {query} (see `ow sessions`)")),
        1 => Ok(matches.remove(0)),
        n => Err(format!("ambiguous id prefix {query} ({n} sessions match)")),
    }
}

pub fn transcript(data: &AppData, query: &str, opts: &TranscriptOptions) -> Result<Transcript, String> {
    let repos = Repos::load(data);
    let mut row = find_row(load_rows(data, &repos)?, query)?;
    let path = session_path(data, &row);
    let file: SessionFile<Message> = read_json(&path)?
        .ok_or_else(|| format!("the session file {} is missing", path.display()))?;
    enrich(&mut row, &file, &repos);

    let cut = |text: &str| {
        if opts.max_chars == 0 {
            text.to_string()
        } else {
            truncate(text, opts.max_chars)
        }
    };
    let mut messages = Vec::new();
    for m in &file.messages {
        // Subagent internals are left out: the Agent/Task call stands for them.
        if m.parent_tool_use_id.is_some() {
            continue;
        }
        let text = m.content.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let entry = |role, text: Option<String>, tool: Option<String>| TranscriptEntry {
            role,
            timestamp: m.timestamp,
            text,
            tool,
            images: 0,
            queued: false,
        };
        let item = match (m.kind.as_str(), opts.detail) {
            ("user", _) => Some(TranscriptEntry {
                images: m.images.as_ref().map_or(0, Vec::len),
                queued: m.queued.is_some(),
                ..entry("user", Some(cut(text.unwrap_or(""))), None)
            }),
            (_, Detail::UserOnly) => None,
            ("text", _) => text.map(|t| entry("assistant", Some(cut(t)), None)),
            ("error", _) => Some(entry("error", Some(cut(text.unwrap_or("error"))), None)),
            ("stopped", _) => Some(entry("interrupted", None, None)),
            ("tool_start", Detail::Full) => {
                let tool = m.tool.clone().unwrap_or_else(|| "tool".to_string());
                let summary = tool_summary(&tool, m.input.as_ref());
                Some(entry("tool", Some(summary).filter(|s| !s.is_empty()), Some(tool)))
            }
            ("notification", Detail::Full) => text.map(|t| entry("notice", Some(cut(t)), None)),
            _ => None,
        };
        messages.extend(item);
    }
    Ok(Transcript {
        session: row,
        messages,
    })
}

pub fn print_transcript(t: &Transcript) {
    let s = &t.session;
    println!(
        "{} ({})",
        s.name.as_deref().unwrap_or("(unnamed session)"),
        s.id
    );
    let mut where_ = Vec::new();
    if let Some(repo) = &s.repo {
        where_.push(repo.clone());
    }
    if let Some(cwd) = &s.cwd {
        where_.push(cwd.clone());
    }
    if let Some(branch) = &s.branch {
        where_.push(format!("branch {branch}"));
    }
    if !where_.is_empty() {
        println!("Where:    {}", where_.join(" · "));
    }
    let mut model = vec![s.model.clone().unwrap_or_else(|| "-".into())];
    if let Some(effort) = &s.effort {
        model.push(format!("effort {effort}"));
    }
    model.push(if s.archived {
        "archived".to_string()
    } else {
        s.status.clone()
    });
    println!("Model:    {}", model.join(" · "));
    println!(
        "Time:     created {} · last active {}",
        timeparse::format_local(s.created_at as i64),
        timeparse::format_local(s.activity() as i64)
    );
    println!(
        "Activity: {} user prompts · {} messages · {}",
        s.user_messages.unwrap_or(0),
        s.messages.unwrap_or(0),
        s.cost.map_or_else(|| "cost -".into(), |c| format!("${c:.2}"))
    );
    if let Some(schedule) = &s.schedule {
        println!(
            "Schedule: {} ({})",
            schedule.label.as_deref().unwrap_or("?"),
            schedule.id.as_deref().unwrap_or("?")
        );
    }
    if let Some(pr) = &s.pr {
        println!(
            "PR:       #{} {}",
            pr.number.map_or_else(|| "?".into(), |n| n.to_string()),
            pr.state.as_deref().unwrap_or("")
        );
    }

    let mut last_was_tool = false;
    for m in &t.messages {
        let time = m
            .timestamp
            .map(|ts| timeparse::format_local(ts as i64))
            .unwrap_or_default();
        match m.role {
            "tool" => {
                if !last_was_tool {
                    println!();
                }
                let tool = m.tool.as_deref().unwrap_or("tool");
                match &m.text {
                    Some(summary) => println!("  > {tool}: {summary}"),
                    None => println!("  > {tool}"),
                }
                last_was_tool = true;
                continue;
            }
            "interrupted" => {
                println!();
                println!("--- interrupted · {time}");
            }
            role => {
                let mut label = role.to_uppercase();
                if m.images > 0 {
                    label.push_str(&format!(
                        " (+{} image{})",
                        m.images,
                        if m.images == 1 { "" } else { "s" }
                    ));
                }
                if m.queued {
                    label.push_str(" (queued, not sent yet)");
                }
                println!();
                println!("--- {label} · {time}");
                if let Some(text) = &m.text {
                    println!("{text}");
                }
            }
        }
        last_was_tool = false;
    }
}

/// One line describing a tool call: the command, file, pattern … it acted on.
fn tool_summary(tool: &str, input: Option<&Value>) -> String {
    let Some(input) = input.and_then(Value::as_object) else {
        return String::new();
    };
    let s = |key: &str| input.get(key).and_then(Value::as_str);
    let text = match tool {
        "Bash" | "PowerShell" => s("command").map(str::to_string),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            s("file_path").or_else(|| s("notebook_path")).map(str::to_string)
        }
        "Grep" => s("pattern").map(|p| match s("path") {
            Some(path) => format!("{p} in {path}"),
            None => p.to_string(),
        }),
        "Glob" => s("pattern").map(str::to_string),
        "Agent" | "Task" => s("description").map(|d| match s("subagent_type") {
            Some(kind) => format!("[{kind}] {d}"),
            None => d.to_string(),
        }),
        "WebFetch" => s("url").map(str::to_string),
        "WebSearch" => s("query").map(str::to_string),
        "Skill" => s("skill").map(str::to_string),
        "TodoWrite" => input
            .get("todos")
            .and_then(Value::as_array)
            .map(|todos| format!("{} todos", todos.len())),
        _ => None,
    };
    let text = text.or_else(|| {
        ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]
            .iter()
            .find_map(|key| s(key).map(str::to_string))
    });
    let text = text.unwrap_or_else(|| Value::Object(input.clone()).to_string());
    one_line(&text, 160)
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/// Keep the first `max` characters, noting how many were cut.
fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{}… [+{} chars]", kept.trim_end(), count - max)
}

/// Single-line truncation for table cells.
fn truncate_plain(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

fn one_line(text: &str, max: usize) -> String {
    truncate_plain(text, max)
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

fn print_aligned<const N: usize>(rows: &[[String; N]]) {
    let mut widths = [0usize; N];
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    for row in rows {
        let mut line = String::new();
        for (index, cell) in row.iter().enumerate() {
            line.push_str(cell);
            if index + 1 < N {
                line.push_str(&" ".repeat(widths[index] - cell.chars().count() + 2));
            }
        }
        println!("{}", line.trim_end());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(costs: &[f64]) -> Vec<QueryUsageSample> {
        costs.iter().map(|c| QueryUsageSample { total_cost_usd: Some(*c) }).collect()
    }

    #[test]
    fn corrected_cost_reads_running_totals() {
        // One process: the last running total, not the sum (4.35 + 12.01 + 12.17).
        assert!((corrected_cost(&samples(&[4.35, 12.01, 12.17])) - 12.17).abs() < 1e-9);
        // A fresh process after a drop counts in full; a restored total adds nothing.
        assert!((corrected_cost(&samples(&[5.0, 8.0, 2.0, 3.0])) - 11.0).abs() < 1e-9);
        assert!((corrected_cost(&samples(&[5.0, 8.0, 0.0, 5.0, 6.0])) - 9.0).abs() < 1e-9);
        assert_eq!(corrected_cost(&samples(&[0.0, 0.0])), 0.0);
    }

    fn repos() -> Repos {
        let repo = |name: &str, path: &str| RepoConf {
            id: Some(format!("id-{name}")),
            name: name.to_string(),
            path: path.to_string(),
        };
        Repos(vec![
            repo("Repos", r"F:\Repos"),
            repo("Foo", r"F:\Repos\Foo"),
        ])
    }

    #[test]
    fn repo_for_path_prefers_exact_then_worktree_then_longest_prefix() {
        let repos = repos();
        assert_eq!(repos.for_path(r"F:\Repos\Foo").unwrap().name, "Foo");
        assert_eq!(repos.for_path("F:/Repos/Foo-worktrees/feature-x").unwrap().name, "Foo");
        assert_eq!(repos.for_path(r"F:\Repos\Foo\sub\dir").unwrap().name, "Foo");
        assert_eq!(repos.for_path(r"F:\Repos\Other").unwrap().name, "Repos");
        assert!(repos.for_path(r"C:\elsewhere").is_none());
    }

    #[test]
    fn exact_repo_name_does_not_match_by_path() {
        let repos = repos();
        let mut row = live_row(
            LiveEntry {
                id: "a".into(),
                session_type: None,
                name: None,
                model: None,
                cwd: Some(r"F:\Repos\Foo".into()),
                status: "idle".into(),
                created_at: 0,
                last_activity_at: None,
                total_cost: None,
            },
            &repos,
        );
        assert!(matches_repo(&row, "foo", &repos));
        assert!(!matches_repo(&row, "Repos", &repos), "exact name selects only that repo");
        assert!(matches_repo(&row, "repos/fo", &repos), "path substring");
        row.repo = None;
        assert!(matches_repo(&row, r"Repos\Foo", &repos));
    }

    #[test]
    fn transcript_tool_summaries() {
        let input = serde_json::json!({ "command": "npm run check\n  && echo ok" });
        assert_eq!(tool_summary("Bash", Some(&input)), "npm run check && echo ok");
        let input = serde_json::json!({ "pattern": "foo", "path": "src" });
        assert_eq!(tool_summary("Grep", Some(&input)), "foo in src");
        let input = serde_json::json!({ "description": "Find x", "subagent_type": "Explore" });
        assert_eq!(tool_summary("Agent", Some(&input)), "[Explore] Find x");
        let input = serde_json::json!({ "n": 1 });
        assert_eq!(tool_summary("Mystery", Some(&input)), r#"{"n":1}"#);
    }

    #[test]
    fn truncation_notes_the_cut() {
        assert_eq!(truncate("hello world", 5), "hello… [+6 chars]");
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate_plain("a  b\nc", 10), "a b c");
    }
}
