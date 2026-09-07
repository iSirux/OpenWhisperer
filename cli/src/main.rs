//! `ow` — the agent-facing OpenWhisperer CLI.
//!
//! Coding agents call this from inside a session to hand a prompt to the
//! OpenWhisperer desktop app: run it now as a new session, continue the
//! invoking session, or schedule it once / recurring. Communication is a
//! request/ack file exchange in an inbox directory (see [`inbox`]), so the
//! commands also work while the app is closed — a `schedule` request simply
//! stays in the inbox until the next launch.

mod git;
mod inbox;
mod install;
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
        Command::Cancel { id } => send(
            &cli,
            "cancel",
            current_dir(),
            Payload::Cancel {
                schedule_id: id.clone(),
            },
        ),
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
    about = "Hand a prompt to OpenWhisperer: run it now, or schedule it once or recurring",
    long_about = "Hand a prompt to the OpenWhisperer desktop app, which runs it as an agent \
                  session in the repository and worktree of the current directory.\n\n\
                  The app must be running for scheduled runs to fire; schedules are durable \
                  and catch up on the next launch."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Print the raw response JSON instead of a human-readable summary
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

    /// Use the development inbox directory (cli-inbox-dev)
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
    /// Delete a schedule by id (see `ow list`)
    Cancel {
        /// Schedule id
        #[arg(value_name = "ID")]
        id: String,
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
    Empty {},
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
        Some(ack) => print_ack(cli, kind, &ack),
        None if kind == "schedule" => {
            // Durable: the app applies leftover schedule requests on launch.
            println!(
                "OpenWhisperer did not respond (is it running?). The schedule request was saved \
                 and will be applied when the app starts. Request id: {id}"
            );
            exit(0);
        }
        None => {
            let removed = inbox::remove_request(&dir, &id);
            // Completion may have raced the deadline and cancellation attempt.
            if let Some(ack) = inbox::poll_ack(&dir, &id, Duration::ZERO) {
                print_ack(cli, kind, &ack);
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
/// schedule table for `list`).
fn print_ack(cli: &Cli, kind: &str, ack: &Value) -> ! {
    let ok = ack.get("ok").and_then(Value::as_bool).unwrap_or(false);

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

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("-")
        .to_string()
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
