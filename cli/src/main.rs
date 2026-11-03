//! `ow` — the agent-facing OpenWhisperer CLI.
//!
//! Coding agents call this from inside a session to hand a prompt to the
//! OpenWhisperer desktop app: run it now as a new session, continue the
//! invoking session, or schedule it once / recurring. Communication is a
//! request/ack file exchange in an inbox directory (see [`inbox`]), so the
//! commands also work while the app is closed — a `schedule` (or `pile add`,
//! quick-action / chip edit) request simply stays in the inbox until the next
//! launch. `sessions` and `transcript` read the app's session files directly
//! (see [`sessions`]).

mod appdata;
mod git;
mod inbox;
mod install;
mod sessions;
mod timeparse;

use std::fmt::Display;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::Duration;

use chrono::{DateTime, Local};
use clap::{ArgAction, Args, CommandFactory, Parser, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

/// Protocol version of the request files.
const PROTOCOL_VERSION: u32 = 1;

/// Env var carrying the OpenWhisperer session id into agent processes.
const SESSION_ID_ENV: &str = "OPENWHISPERER_SESSION_ID";

fn main() {
    let cli = Cli::parse();
    match &cli.command {
        Command::Run { prompt, target } => {
            let prompt = resolve_prompt(prompt);
            let label = target.label.clone();
            let wait_for_idle = target.wait_idle;
            let (cwd, target) = build_target(target);
            send(
                &cli,
                "run",
                cwd,
                Payload::Run {
                    prompt,
                    label,
                    target,
                    wait_for_idle,
                },
            )
        }
        Command::Schedule {
            prompt,
            target,
            timing,
        } => {
            let prompt = resolve_prompt(prompt);
            let when = resolve_when(timing, Local::now());
            let label = target.label.clone();
            let wait_for_idle = target.wait_idle;
            let (cwd, target) = build_target(target);
            send(
                &cli,
                "schedule",
                cwd,
                Payload::Schedule {
                    prompt,
                    label,
                    target,
                    when,
                    wait_for_idle,
                    catch_up: timing.catch_up.as_json(),
                },
            )
        }
        Command::List => send(&cli, "list", current_dir(), Payload::Empty {}),
        // The app has no per-schedule read: `show` asks for the list and picks one.
        Command::Show { id } => send_rendered(
            &cli,
            "list",
            current_dir(),
            Payload::Empty {},
            &Render::Show(id.clone()),
        ),
        Command::Update { id, prompt, label } => {
            let prompt = resolve_optional_prompt(prompt);
            if prompt.is_none() && label.is_none() {
                usage_error("nothing to update: pass a new prompt (argument, --prompt-file or \"-\") and/or --label");
            }
            send(
                &cli,
                "update",
                current_dir(),
                Payload::Update {
                    schedule_id: id.clone(),
                    prompt,
                    label: label.clone(),
                },
            )
        }
        Command::Cancel { id } => send(
            &cli,
            "cancel",
            current_dir(),
            Payload::Cancel {
                schedule_id: id.clone(),
            },
        ),
        Command::Sessions(args) => {
            let data = app_data(&cli);
            let listing = sessions::list(
                &data,
                &sessions::ListOptions {
                    since: args.since.as_deref(),
                    repo: args.repo.as_deref(),
                    scheduled: if args.scheduled {
                        Some(true)
                    } else if args.interactive {
                        Some(false)
                    } else {
                        None
                    },
                    limit: args.limit,
                },
            )
            .unwrap_or_else(|err| fail(err));
            if cli.json {
                print_serialized(&listing);
            } else {
                sessions::print_table(&listing);
            }
            exit(0)
        }
        Command::Transcript(args) => {
            let data = app_data(&cli);
            let detail = if args.user_only {
                sessions::Detail::UserOnly
            } else if args.full {
                sessions::Detail::Full
            } else {
                sessions::Detail::Conversation
            };
            let transcript = sessions::transcript(
                &data,
                &args.id,
                &sessions::TranscriptOptions {
                    detail,
                    max_chars: args.max_chars,
                },
            )
            .unwrap_or_else(|err| fail(err));
            if cli.json {
                print_serialized(&transcript);
            } else {
                sessions::print_transcript(&transcript);
            }
            exit(0)
        }
        Command::Pile {
            action: PileCommand::Add {
                text,
                title,
                repo,
                model,
            },
        } => {
            let text = resolve_prompt(text);
            let cwd = current_dir();
            let info = git::detect(Path::new(&cwd));
            let target = Target {
                mode: "new_session",
                repo_path: info.repo_path,
                worktree_path: info.worktree_path,
                branch: info.branch,
                repo: repo.clone(),
                model: model.clone(),
                effort: None,
                new_worktree: false,
            };
            send(
                &cli,
                "pile_add",
                cwd,
                Payload::PileAdd {
                    text,
                    title: title.clone(),
                    target,
                },
            )
        }
        Command::QuickAction { action } => edit_list(&cli, ListKind::QuickAction, action),
        Command::Chip { action } => edit_list(&cli, ListKind::Chip, action),
        Command::Ping => send(&cli, "ping", current_dir(), Payload::Empty {}),
        Command::Doctor => {
            print_diagnostics(&cli);
            send(&cli, "ping", current_dir(), Payload::Empty {})
        }
        Command::InstallSkills { dirs } => {
            match install::install_skills(dirs) {
                Ok(paths) => {
                    for path in paths {
                        println!("Installed skill: {}", path.display());
                    }
                }
                Err(err) => fail(err),
            }
            exit(0)
        }
        Command::SelfInstall { skills_only } => {
            if let Err(err) = install::self_install(*skills_only, &[]) {
                fail(err);
            }
            exit(0)
        }
    }
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "ow",
    // Keep usage strings as "ow …" instead of the argv[0] "ow.exe" on Windows.
    bin_name = "ow",
    version,
    about = "Hand a prompt to OpenWhisperer (run it now, or schedule it once or recurring), read its sessions, and add Pile items",
    long_about = "Hand a prompt to the OpenWhisperer desktop app, which runs it as an agent \
                  session in the repository and worktree of the current directory.\n\n\
                  The app must be running for scheduled runs to fire; schedules are durable \
                  and catch up on the next launch.\n\n\
                  `sessions` and `transcript` read the app's session files directly; `pile add` \
                  and quick-action / chip edits are applied by the app (on its next launch if \
                  it is closed)."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Print JSON instead of a human-readable summary
    #[arg(long, global = true, help_heading = "Common options")]
    json: bool,

    /// Seconds to wait for completion (default: 120 for run, 10 otherwise)
    #[arg(
        long,
        value_name = "SECONDS",
        global = true,
        help_heading = "Common options"
    )]
    timeout: Option<u64>,

    /// Use the development build's inbox and data files (cli-inbox-dev, sessions-dev, …)
    #[arg(long, global = true, help_heading = "Common options")]
    dev: bool,

    /// Write the request and exit without waiting for a response
    #[arg(long = "no-wait", global = true, help_heading = "Common options")]
    no_wait: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Start a new agent session now (or continue this one with --same-session)
    Run {
        #[command(flatten)]
        prompt: PromptArgs,
        #[command(flatten)]
        target: TargetArgs,
    },
    /// Schedule a prompt for later: once (--at/--in) or recurring (--every)
    Schedule {
        #[command(flatten)]
        prompt: PromptArgs,
        #[command(flatten)]
        target: TargetArgs,
        #[command(flatten)]
        timing: TimingArgs,
    },
    /// List the schedules OpenWhisperer knows about
    List,
    /// Show one schedule in full, prompt included (id or unambiguous prefix, see `ow list`)
    Show {
        /// Schedule id or a unique prefix of it
        #[arg(value_name = "ID")]
        id: String,
    },
    /// Replace a schedule's prompt and/or label, keeping its timing and run history
    Update {
        /// Schedule id or a unique prefix of it
        #[arg(value_name = "ID")]
        id: String,
        #[command(flatten)]
        prompt: OptionalPromptArgs,
        /// New short title
        #[arg(long, value_name = "TEXT")]
        label: Option<String>,
    },
    /// Delete a schedule by id (see `ow list`)
    Cancel {
        /// Schedule id
        #[arg(value_name = "ID")]
        id: String,
    },
    /// List recent agent sessions, live and archived (reads the app's files; works while it is closed)
    Sessions(SessionsArgs),
    /// Print a session's conversation (id or unique prefix, see `ow sessions`)
    Transcript(TranscriptArgs),
    /// Add findings to the app's Pile (an inbox of prompts to launch later)
    Pile {
        #[command(subcommand)]
        action: PileCommand,
    },
    /// List, add or remove the quick actions shown under the prompt input
    #[command(name = "quick-action")]
    QuickAction {
        #[command(subcommand)]
        action: ListCommand,
    },
    /// List, add or remove the prompt chips (toggles appended to a prompt on send)
    Chip {
        #[command(subcommand)]
        action: ListCommand,
    },
    /// Check whether OpenWhisperer is reachable
    Ping,
    /// Like `ping`, plus the resolved inbox directory, session id and bin directory
    Doctor,
    /// Install the OpenWhisperer skill into the global agent skill directories
    InstallSkills {
        /// Skill directory to write SKILL.md into (repeatable; replaces the defaults)
        #[arg(long = "dir", value_name = "PATH", action = ArgAction::Append)]
        dirs: Vec<PathBuf>,
    },
    /// Copy this binary to the user bin directory, put it on PATH and install the skill
    SelfInstall {
        /// Only install the skill files
        #[arg(long = "skills-only")]
        skills_only: bool,
    },
}

#[derive(Args)]
struct SessionsArgs {
    /// Only sessions active since: 7d, 24h, today, yesterday, 2026-10-27, 2026-10-27T09:00
    #[arg(long, value_name = "WHEN")]
    since: Option<String>,

    /// Registered repository name, or a substring of the repo path / working directory
    #[arg(long, value_name = "NAME|PATH")]
    repo: Option<String>,

    /// Only sessions launched by a schedule
    #[arg(long, conflicts_with = "interactive")]
    scheduled: bool,

    /// Only sessions not launched by a schedule
    #[arg(long)]
    interactive: bool,

    /// Maximum number of sessions, most recently active first (0 = no limit)
    #[arg(long, value_name = "N", default_value_t = 50)]
    limit: usize,
}

#[derive(Args)]
struct TranscriptArgs {
    /// Session id or a unique prefix of it
    #[arg(value_name = "ID")]
    id: String,

    /// Only the user's prompts
    #[arg(long = "user-only", conflicts_with = "full")]
    user_only: bool,

    /// Also one line per tool call (tool name + what it acted on) and app notices
    #[arg(long)]
    full: bool,

    /// Truncate each message to N characters (0 = no truncation)
    #[arg(long = "max-chars", value_name = "N", default_value_t = 2000)]
    max_chars: usize,
}

#[derive(Subcommand)]
enum PileCommand {
    /// Add a text item to the Pile, tagged with the invoking session
    Add {
        #[command(flatten)]
        text: PromptArgs,

        /// Short title (the app generates one when omitted)
        #[arg(long, value_name = "TEXT")]
        title: Option<String>,

        /// Repository name or path (default: the repository of the current
        /// directory; the app recommends one when neither resolves)
        #[arg(long, value_name = "NAME|PATH")]
        repo: Option<String>,

        /// Model name or short alias for when the item is launched
        #[arg(long, value_name = "NAME")]
        model: Option<String>,
    },
}

#[derive(Subcommand)]
enum ListCommand {
    /// Show the current entries
    List,
    /// Add an entry (an existing one, compared case-insensitively, is left as is)
    Add {
        #[arg(value_name = "TEXT")]
        text: String,
    },
    /// Remove an entry (exact text, case-insensitive)
    Remove {
        #[arg(value_name = "TEXT")]
        text: String,
    },
}

#[derive(Copy, Clone)]
enum ListKind {
    QuickAction,
    Chip,
}

impl ListKind {
    /// Request kind, also the noun in messages.
    fn request_kind(self) -> &'static str {
        match self {
            ListKind::QuickAction => "quick_action",
            ListKind::Chip => "chip",
        }
    }

    /// Key in config.json.
    fn config_key(self) -> &'static str {
        match self {
            ListKind::QuickAction => "quick_actions",
            ListKind::Chip => "prompt_chips",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            ListKind::QuickAction => "quick action",
            ListKind::Chip => "prompt chip",
        }
    }
}

/// Where the prompt text comes from: positional, file, or stdin (`-`).
#[derive(Args)]
struct PromptArgs {
    /// The prompt for the agent ("-" reads stdin)
    #[arg(value_name = "PROMPT")]
    prompt: Option<String>,

    /// Read the prompt from a file instead
    #[arg(long = "prompt-file", value_name = "PATH", conflicts_with = "prompt")]
    prompt_file: Option<PathBuf>,
}

/// Like [`PromptArgs`], for commands where a new prompt is optional (`update`).
#[derive(Args)]
struct OptionalPromptArgs {
    /// The new prompt ("-" reads stdin); omit to keep the current one
    #[arg(value_name = "PROMPT")]
    prompt: Option<String>,

    /// Read the new prompt from a file instead
    #[arg(long = "prompt-file", value_name = "PATH", conflicts_with = "prompt")]
    prompt_file: Option<PathBuf>,
}

/// Which session the prompt should run in, and how it should be configured.
#[derive(Args)]
#[command(next_help_heading = "Target options")]
struct TargetArgs {
    /// Short title (the app derives one from the prompt when omitted)
    #[arg(long, value_name = "TEXT")]
    label: Option<String>,

    /// Repository name or path (default: the repository of the current directory)
    #[arg(long, value_name = "NAME|PATH")]
    repo: Option<String>,

    /// Model name or short alias: opus, sonnet, haiku, fable, astra, sol,
    /// terra, luna (default: the invoking session's model). The agent provider
    /// follows from the model — Claude names run on Claude, GPT names on Codex.
    #[arg(long, value_name = "NAME")]
    model: Option<String>,

    /// Effort level (default: the invoking session's effort)
    #[arg(long, value_enum, value_name = "LEVEL")]
    effort: Option<Effort>,

    /// Create a fresh worktree for the run instead of using the current one
    #[arg(long = "new-worktree")]
    new_worktree: bool,

    /// Continue the invoking session instead of starting a new one
    #[arg(long = "same-session", conflicts_with = "new_worktree")]
    same_session: bool,

    /// Hold the run until nothing else is working in the target worktree
    #[arg(long = "wait-idle")]
    wait_idle: bool,
}

/// The `schedule` timing flags.
#[derive(Args)]
#[command(next_help_heading = "Timing options")]
struct TimingArgs {
    /// One-shot at an absolute time: 2026-09-04T09:00, "tomorrow 09:00", "fri 17:30", 17:30
    #[arg(long, value_name = "WHEN", conflicts_with_all = ["in_", "every"])]
    at: Option<String>,

    /// One-shot after a delay: 30m, 2h, 1h30m, 3d (bare number = minutes)
    #[arg(long = "in", value_name = "DURATION", conflicts_with_all = ["at", "every"])]
    in_: Option<String>,

    /// Recurring: day, weekdays, week, month or Nd (e.g. 3d)
    #[arg(long, value_name = "RULE")]
    every: Option<String>,

    /// Time of day for --every (default 09:00)
    #[arg(long, value_name = "HH:MM", requires = "every")]
    time: Option<String>,

    /// Weekdays for --every week (mon,wed), or 1..28|last for --every month
    #[arg(long, value_name = "LIST", requires = "every")]
    on: Option<String>,

    /// Every N weeks (only with --every week)
    #[arg(long, value_name = "N", requires = "every")]
    interval: Option<u32>,

    /// Stop recurring after this time (same grammar as --at)
    #[arg(long, value_name = "WHEN", requires = "every")]
    until: Option<String>,

    /// Stop recurring after N runs
    #[arg(long = "max-runs", value_name = "N", requires = "every")]
    max_runs: Option<u32>,

    /// What to do about occurrences missed while the app was closed
    #[arg(
        long = "catch-up",
        value_enum,
        value_name = "MODE",
        default_value = "run-once"
    )]
    catch_up: CatchUp,
}

#[derive(Copy, Clone, ValueEnum)]
enum Effort {
    Off,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    fn as_json(self) -> &'static str {
        match self {
            Effort::Off => "off",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

#[derive(Copy, Clone, ValueEnum)]
enum CatchUp {
    RunOnce,
    Skip,
}

impl CatchUp {
    fn as_json(self) -> &'static str {
        match self {
            CatchUp::RunOnce => "run_once",
            CatchUp::Skip => "skip",
        }
    }
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    version: u32,
    id: String,
    created_at: i64,
    kind: &'static str,
    cwd: String,
    session_id: Option<String>,
    #[serde(flatten)]
    payload: Payload,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Payload {
    #[serde(rename_all = "camelCase")]
    Schedule {
        prompt: String,
        label: Option<String>,
        target: Target,
        when: Value,
        wait_for_idle: bool,
        catch_up: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Run {
        prompt: String,
        label: Option<String>,
        target: Target,
        wait_for_idle: bool,
    },
    #[serde(rename_all = "camelCase")]
    Cancel {
        schedule_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Update {
        schedule_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PileAdd {
        text: String,
        title: Option<String>,
        target: Target,
    },
    /// `quick_action` / `chip` add|remove
    ListEdit {
        op: &'static str,
        text: String,
    },
    Empty {},
}

/// Requests the app applies on its next launch when it does not answer now
/// (they change durable state and are safe to apply late). Everything else is
/// cancelled on timeout, so a stale command can never fire later.
fn is_durable(kind: &str) -> bool {
    matches!(kind, "schedule" | "pile_add" | "quick_action" | "chip")
}

/// How a successful ack is printed.
enum Render {
    /// The ack's `message` (plus the schedule table for `list`).
    Default,
    /// One schedule out of a `list` ack, in full.
    Show(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    mode: &'static str,
    repo_path: Option<String>,
    worktree_path: Option<String>,
    branch: Option<String>,
    repo: Option<String>,
    model: Option<String>,
    effort: Option<&'static str>,
    new_worktree: bool,
}

// ---------------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------------

/// Read the prompt from the positional argument, `--prompt-file` or stdin.
/// Only trailing whitespace is trimmed — leading indentation may be meaningful.
fn resolve_prompt(args: &PromptArgs) -> String {
    let text = match (&args.prompt, &args.prompt_file) {
        (_, Some(path)) => std::fs::read_to_string(path).unwrap_or_else(|err| {
            fail(format!("could not read {}: {err}", path.display()));
        }),
        (Some(value), None) if value == "-" => {
            let mut buffer = String::new();
            if let Err(err) = std::io::stdin().read_to_string(&mut buffer) {
                fail(format!("could not read the prompt from stdin: {err}"));
            }
            buffer
        }
        (Some(value), None) => value.clone(),
        (None, None) => usage_error(
            "a prompt is required: pass it as an argument, with --prompt-file <path>, or as \"-\" to read stdin",
        ),
    };
    let trimmed = text.trim_end().to_string();
    if trimmed.trim().is_empty() {
        usage_error("the prompt is empty");
    }
    trimmed
}

/// The new prompt for `update`, if one was given.
fn resolve_optional_prompt(args: &OptionalPromptArgs) -> Option<String> {
    if args.prompt.is_none() && args.prompt_file.is_none() {
        return None;
    }
    Some(resolve_prompt(&PromptArgs {
        prompt: args.prompt.clone(),
        prompt_file: args.prompt_file.clone(),
    }))
}

/// Build the request `target`, detecting the repository of the current
/// directory. Returns the normalized cwd alongside it.
fn build_target(args: &TargetArgs) -> (String, Target) {
    let cwd = current_dir();
    if args.same_session && session_id().is_none() {
        usage_error(format!(
            "--same-session only works from inside an OpenWhisperer session ({SESSION_ID_ENV} is not set)"
        ));
    }

    let info = git::detect(Path::new(&cwd));
    if info.repo_path.is_none() && args.repo.is_none() {
        eprintln!(
            "note: {cwd} is not inside a git repository — OpenWhisperer will reject this request \
             unless the directory is a registered repository; pass --repo <name> to choose one."
        );
    }

    let target = Target {
        mode: if args.same_session {
            "same_session"
        } else {
            "new_session"
        },
        repo_path: info.repo_path,
        worktree_path: info.worktree_path,
        branch: info.branch,
        repo: args.repo.clone(),
        model: args.model.clone(),
        effort: args.effort.map(Effort::as_json),
        new_worktree: args.new_worktree,
    };
    (cwd, target)
}

/// Turn the timing flags into the `when` shape. Exactly one of `--at`,
/// `--in` and `--every` is required.
fn resolve_when(timing: &TimingArgs, now: DateTime<Local>) -> Value {
    if let Some(at) = &timing.at {
        let at_ms = timeparse::parse_at(at, now).unwrap_or_else(|err| usage_error(err));
        return timeparse::when_at(at_ms);
    }
    if let Some(delay) = &timing.in_ {
        let delta = timeparse::parse_duration_ms(delay).unwrap_or_else(|err| usage_error(err));
        return timeparse::when_at(now.timestamp_millis() + delta);
    }
    if let Some(rule) = &timing.every {
        let spec = timeparse::EverySpec {
            rule,
            time: timing.time.as_deref(),
            on: timing.on.as_deref(),
            interval: timing.interval,
            until: timing.until.as_deref(),
            max_runs: timing.max_runs,
        };
        return timeparse::build_recurring_when(&spec, now).unwrap_or_else(|err| usage_error(err));
    }
    usage_error("schedule needs exactly one of --at <when>, --in <duration> or --every <rule>")
}

/// The OpenWhisperer session id of the surrounding agent session, if any.
fn session_id() -> Option<String> {
    std::env::var(SESSION_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn current_dir() -> String {
    git::normalize_current_dir().unwrap_or_else(|err| fail(err))
}

// ---------------------------------------------------------------------------
// Request/ack round trip
// ---------------------------------------------------------------------------

/// Write the request and (unless `--no-wait`) wait for the app's ack.
fn send(cli: &Cli, kind: &'static str, cwd: String, payload: Payload) -> ! {
    send_rendered(cli, kind, cwd, payload, &Render::Default)
}

/// [`send`], printing a successful ack as `render` says.
fn send_rendered(
    cli: &Cli,
    kind: &'static str,
    cwd: String,
    payload: Payload,
    render: &Render,
) -> ! {
    let dir = inbox::resolve_dir(cli.dev).unwrap_or_else(|err| fail(err));
    inbox::ensure_dir(&dir).unwrap_or_else(|err| fail(err));

    let id = Uuid::new_v4().to_string();
    let request = Request {
        version: PROTOCOL_VERSION,
        id: id.clone(),
        created_at: Local::now().timestamp_millis(),
        kind,
        cwd,
        session_id: session_id(),
        payload,
    };
    let body = serde_json::to_value(&request)
        .unwrap_or_else(|err| fail(format!("could not serialize the request: {err}")));
    inbox::write_request(&dir, &id, &body).unwrap_or_else(|err| fail(err));

    if cli.no_wait {
        if cli.json {
            print_json(&serde_json::json!({ "ok": true, "kind": kind, "id": id, "waited": false }));
        } else {
            println!("Request id: {id}");
        }
        exit(0);
    }

    let timeout = cli.timeout.unwrap_or(if kind == "run" { 120 } else { 10 });
    match inbox::poll_ack(&dir, &id, Duration::from_secs(timeout)) {
        Some(ack) => print_ack(cli, kind, &ack, render),
        None if is_durable(kind) => {
            // Durable: the app applies leftover requests of these kinds on launch.
            let message = format!(
                "OpenWhisperer did not respond (is it running?). The {kind} request was saved \
                 and will be applied when the app starts. Request id: {id}"
            );
            if cli.json {
                print_json(&serde_json::json!({
                    "ok": true, "kind": kind, "id": id, "pending": true, "message": message,
                }));
            } else {
                println!("{message}");
            }
            exit(0);
        }
        None => {
            let removed = inbox::remove_request(&dir, &id);
            // Completion may have raced the deadline and cancellation attempt.
            if let Some(ack) = inbox::poll_ack(&dir, &id, Duration::ZERO) {
                print_ack(cli, kind, &ack, render);
            }
            let cancelled = removed.is_ok();
            let message = if cancelled {
                format!("OpenWhisperer did not pick up request {id} within {timeout}s. The request was cancelled before execution. Check that the app is running and responsive.")
            } else {
                format!("Timed out waiting for completion of request {id} after {timeout}s. The request may already be running or completed; it was NOT cancelled. Do not retry automatically, as that could duplicate the action. Check the app or the response file {}.", dir.join(format!("{id}.ack.json")).display())
            };
            if cli.json {
                print_json(&serde_json::json!({
                    "ok": false, "kind": kind, "id": id,
                    "status": if cancelled { "cancelled" } else { "unknown" },
                    "error": message,
                    "ackPath": dir.join(format!("{id}.ack.json")),
                }));
            } else {
                eprintln!("{message}");
            }
            // Distinguish an uncertain outcome from a confirmed rejection.
            exit(if cancelled { 1 } else { 3 });
        }
    }
}

/// Render the ack: `--json` dumps it verbatim, otherwise `message` (plus the
/// schedule table for `list`). `show` prints its one schedule either way.
fn print_ack(cli: &Cli, kind: &str, ack: &Value, render: &Render) -> ! {
    let ok = ack.get("ok").and_then(Value::as_bool).unwrap_or(false);

    if let (true, Render::Show(query)) = (ok, render) {
        let schedules = ack.get("schedules").and_then(Value::as_array);
        let schedule = find_schedule(schedules, query).unwrap_or_else(|err| fail(err));
        if cli.json {
            print_json(schedule);
        } else {
            print_schedule(schedule);
        }
        exit(0);
    }

    if cli.json {
        print_json(ack);
        exit(if ok { 0 } else { 1 });
    }

    if !ok {
        let message = ack
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("OpenWhisperer rejected the request");
        eprintln!("error: {message}");
        exit(1);
    }

    if let Some(message) = ack.get("message").and_then(Value::as_str) {
        println!("{message}");
    }
    if kind == "list" {
        print_schedule_table(ack.get("schedules").and_then(Value::as_array));
    }
    exit(0);
}

/// Pretty JSON in the struct's field order (a `Value` would sort the keys).
fn print_serialized<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(err) => fail(format!("could not serialize the output: {err}")),
    }
}

fn print_json(value: &Value) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(_) => println!("{value}"),
    }
}

/// `id | enabled | when | next fire | target | label` table for `ow list`.
fn print_schedule_table(schedules: Option<&Vec<Value>>) {
    let Some(schedules) = schedules else { return };
    if schedules.is_empty() {
        return;
    }

    let mut rows: Vec<[String; 6]> = vec![[
        "ID".into(),
        "ENABLED".into(),
        "WHEN".into(),
        "NEXT".into(),
        "TARGET".into(),
        "LABEL".into(),
    ]];
    for schedule in schedules {
        let enabled = match schedule.get("enabled").and_then(Value::as_bool) {
            Some(true) => "yes",
            Some(false) => "no",
            None => "-",
        };
        let next = schedule
            .get("nextFireAt")
            .and_then(Value::as_i64)
            .map(timeparse::format_local)
            .unwrap_or_else(|| "-".to_string());
        rows.push([
            field(schedule, "id"),
            enabled.to_string(),
            field(schedule, "when"),
            next,
            field(schedule, "target"),
            field(schedule, "label"),
        ]);
    }

    let mut widths = [0usize; 6];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }

    println!();
    for row in &rows {
        let mut line = String::new();
        for (index, cell) in row.iter().enumerate() {
            if index + 1 == row.len() {
                line.push_str(cell);
            } else {
                let pad = widths[index] - cell.chars().count();
                line.push_str(cell);
                line.push_str(&" ".repeat(pad + 2));
            }
        }
        println!("{}", line.trim_end());
    }
}

/// The schedule a full id or unambiguous prefix names — the same rule the app
/// applies to `cancel` and `update`.
fn find_schedule<'a>(schedules: Option<&'a Vec<Value>>, query: &str) -> Result<&'a Value, String> {
    let query = query.trim();
    let all = schedules.map(Vec::as_slice).unwrap_or_default();
    let id_of = |s: &Value| {
        s.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let exact: Vec<&Value> = all.iter().filter(|s| id_of(s) == query).collect();
    let matches = if exact.is_empty() {
        all.iter().filter(|s| id_of(s).starts_with(query)).collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [] => Err(format!("no schedule with id {query} (see `ow list`)")),
        [one] => Ok(one),
        many => Err(format!(
            "ambiguous id prefix {query} ({} matches)",
            many.len()
        )),
    }
}

/// `ow show`: the schedule's fields, then its prompt verbatim.
fn print_schedule(schedule: &Value) {
    let enabled = match schedule.get("enabled").and_then(Value::as_bool) {
        Some(true) => "yes",
        Some(false) => "no",
        None => "-",
    };
    let time = |key: &str| {
        schedule
            .get(key)
            .and_then(Value::as_i64)
            .map(timeparse::format_local)
            .unwrap_or_else(|| "-".to_string())
    };
    let runs = schedule
        .get("runCount")
        .and_then(Value::as_u64)
        .map(|n| n.to_string())
        .unwrap_or_else(|| "-".to_string());

    println!("{} ({})", field(schedule, "label"), field(schedule, "id"));
    println!("When:     {}", field(schedule, "when"));
    println!("Next:     {}", time("nextFireAt"));
    println!("Enabled:  {enabled}");
    println!("Target:   {}", field(schedule, "target"));
    println!("Source:   {}", field(schedule, "source"));
    println!("Runs:     {runs} (last: {})", time("lastRunAt"));
    println!();
    match schedule.get("prompt").and_then(Value::as_str) {
        Some(prompt) => println!("{prompt}"),
        None => println!("(this OpenWhisperer version does not report prompts — update the app)"),
    }
}

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("-")
        .to_string()
}

/// The app instance whose files the read-only commands use.
fn app_data(cli: &Cli) -> appdata::AppData {
    appdata::AppData::resolve(cli.dev).unwrap_or_else(|err| fail(err))
}

/// `ow quick-action …` / `ow chip …`: `list` reads the config file directly,
/// `add` / `remove` go through the inbox so the app applies them through its
/// normal settings save (writing config.json from here would be overwritten by
/// the app's in-memory copy on its next save).
fn edit_list(cli: &Cli, kind: ListKind, action: &ListCommand) -> ! {
    let (op, text) = match action {
        ListCommand::List => {
            let data = app_data(cli);
            let path = data.config_file();
            let config: Value = appdata::read_json(&path)
                .unwrap_or_else(|err| fail(err))
                .unwrap_or_else(|| fail(format!("{} does not exist yet", path.display())));
            let entries = config.get(kind.config_key()).cloned();
            if cli.json {
                print_json(&entries.unwrap_or(Value::Null));
            } else {
                match entries.as_ref().and_then(Value::as_array) {
                    Some(list) if list.is_empty() => println!("No {}s.", kind.noun()),
                    Some(list) => {
                        for (index, entry) in list.iter().enumerate() {
                            println!("{:>2}. {}", index + 1, entry.as_str().unwrap_or("?"));
                        }
                    }
                    None => println!("No {}s saved yet (the app uses its built-in defaults).", kind.noun()),
                }
            }
            exit(0)
        }
        ListCommand::Add { text } => ("add", text),
        ListCommand::Remove { text } => ("remove", text),
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        usage_error(format!("the {} text is empty", kind.noun()));
    }
    send(
        cli,
        kind.request_kind(),
        current_dir(),
        Payload::ListEdit { op, text },
    )
}

/// Extra `ow doctor` output. In `--json` mode it goes to stderr so stdout
/// stays a single machine-readable document.
fn print_diagnostics(cli: &Cli) {
    let inbox_dir = inbox::resolve_dir(cli.dev)
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|err| format!("<{err}>"));
    let bin = install::bin_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|err| format!("<{err}>"));
    let session = session_id().unwrap_or_else(|| {
        format!("<{SESSION_ID_ENV} not set — not running inside an OpenWhisperer session>")
    });

    let lines = [
        format!("ow {}", env!("CARGO_PKG_VERSION")),
        format!("inbox dir:  {inbox_dir}"),
        format!("session id: {session}"),
        format!("bin dir:    {bin}"),
    ];
    for line in lines {
        if cli.json {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Usage error: clap-formatted, exit code 2.
fn usage_error(message: impl Display) -> ! {
    Cli::command()
        .error(clap::error::ErrorKind::InvalidValue, message.to_string())
        .exit()
}

/// Runtime error: exit code 1.
fn fail(message: impl Display) -> ! {
    eprintln!("error: {message}");
    exit(1);
}
