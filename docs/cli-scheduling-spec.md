# `ow` CLI — agent-driven scheduling (2026-09)

A small standalone CLI (`ow`, crate in `cli/`) that coding agents (Claude Code,
Codex) call from inside a session to schedule prompts in OpenWhisperer: one-shot
at a time, recurring, or run now. The agent learns how to use it from a skill
(`cli/skill/SKILL.md`, installed globally by `ow install-skills`).

Design decisions (agreed 2026-09-03):

- **Transport: request/ack files in an inbox directory**, not an HTTP server.
  The frontend owns the Schedule schema and recurrence math, so the app — not
  the CLI — turns a request into a `Schedule` (`stores/schedules.ts`). Works when
  the app is closed (schedule requests are picked up on next launch).
- **Default target for "schedule a follow-up" is a new session in the same
  worktree.** `--same-session` continues the invoking session instead
  (message target, `ifSessionGone: 'launch_new'`).
- **Worktree gone at fire time → fall back to the main repo path** (all
  schedule kinds, recurring included), recorded in the run history. This is a
  deliberate exception to the "unattended runs never touch main" rule.
- **Distribution:** the binary is bundled with the app (`bundle.externalBin`,
  staged by `scripts/build-cli.mjs` from `tauri:dev` / `beforeBuildCommand`) and
  installed from Settings → System → "Agent CLI (ow)", which runs the bundled
  binary's `self-install` (copy to the user bin dir, user PATH, skills).
  `npm run cli:install` is the headless equivalent. The app also prepends its
  CLI bin dir to the PATH of every agent session it spawns, so the CLI is
  reachable inside sessions without a terminal restart.

## Directories & env

- Config dir: `dirs::config_dir()/open-whisperer` (same as `AppConfig::config_dir()`).
- Inbox: `<config dir>/cli-inbox/` (release build) or `<config dir>/cli-inbox-dev/`
  (debug build). The CLI picks the release inbox unless `--dev` is passed or
  `OPENWHISPERER_INBOX_DIR` is set.
- CLI bin dir: Windows `%LOCALAPPDATA%\OpenWhisperer\bin`, else `~/.local/bin`.
- Env injected into every agent session by `create_sdk_session` (rides the
  existing `OutboundMessage::Create.env` rail next to `GH_TOKEN` /
  `CLAUDE_CONFIG_DIR`):
  - `OPENWHISPERER_SESSION_ID` — the OpenWhisperer session id (frontend id)
  - `OPENWHISPERER_INBOX_DIR` — absolute inbox dir of the running app instance
  - `PATH` — the app's PATH with the CLI bin dir prepended (only if that dir exists)

## Protocol (version 1)

The CLI writes `<inbox>/<id>.request.json` **atomically** (write `<id>.tmp`,
rename) so the app never reads a partial file. The app polls the inbox every 2 s
(`take_cli_requests`), deletes each request file after reading it, applies it,
and writes `<inbox>/<id>.ack.json` (`write_cli_ack`, atomic). The CLI polls for
the ack (150 ms) up to `--timeout` seconds (default 120 for `run`, 10 otherwise),
prints it, deletes it. A run's ack is sent after worktree creation and session
launch, which can take longer than the original 10-second timeout.

If no ack arrives in time:
- `schedule` → the request is **left in the inbox** (durable; applied on next
  app launch). CLI prints a warning with the request id and exits 0.
- `run` / `cancel` / `list` / `ping` → the CLI attempts to delete its request
  and checks once more for a racing ack. Successful deletion cancels an unclaimed
  request (exit 1). If deletion fails, the app may already be executing it:
  report an unknown outcome (exit 3), request id and ack path. Never claim that
  the app is closed or that the action did not run in this case. Retrying may
  duplicate the action; inspect the app or late ack first. `--json` emits the
  same distinction as `status: "cancelled" | "unknown"`.
  The app only applies a request after successfully removing its file, so a
  cancellation that wins the deletion race prevents execution. The app also
  refuses non-`schedule` requests older than 60 s before handling them; the
  longer run timeout allows an already-claimed launch to finish.
- Acks older than 1 h are swept by the app on each poll.

### Request

```jsonc
{
  "version": 1,
  "id": "<uuid v4>",
  "createdAt": 1756900000000,            // epoch ms
  "kind": "schedule" | "run" | "cancel" | "list" | "ping",
  "cwd": "F:/Repos/Foo-worktrees/feature-x",   // CLI's cwd, absolute, forward slashes
  "sessionId": "<OPENWHISPERER_SESSION_ID>" | null,

  // schedule + run
  "prompt": "…",
  "label": "…" | null,
  "target": {
    "mode": "new_session" | "same_session",
    "repoPath": "F:/Repos/Foo" | null,     // main worktree root (git common dir's parent); null outside git
    "worktreePath": "F:/Repos/Foo-worktrees/feature-x" | null,  // toplevel of cwd; null when it IS the main root
    "branch": "feature-x" | null,
    "repo": "<--repo name-or-path override>" | null,
    "model": "…" | null,                   // name or short alias ("opus", "astra"); provider follows from it
    "effort": "off" | "low" | "medium" | "high" | "xhigh" | "max" | null,
    "provider": "claude" | "openai" | null, // deprecated (no --provider flag); honored only when "model" is null
    "newWorktree": false                   // --new-worktree: create a fresh worktree instead
  },

  // schedule only — same shapes as stores/schedules.ts
  "when": { "kind": "at", "at": 1756976400000 }
        | { "kind": "recurring", "rule": {
              "time": { "hour": 9, "minute": 0 },
              "pattern": { "kind": "daily" }
                       | { "kind": "weekly", "days": [1, 3], "everyNWeeks": 2 }   // 0 = Sunday
                       | { "kind": "monthly", "day": 1 | "last" }                 // 1..28 or "last"
                       | { "kind": "interval", "everyNDays": 3 },
              "endAt": 1760000000000,       // optional
              "maxRuns": 5 } },             // optional
  "waitForIdle": false,
  "catchUp": "run_once" | "skip",

  // cancel only
  "scheduleId": "…"
}
```

### Ack

```jsonc
{ "ok": true, "kind": "schedule", "message": "Scheduled \"Follow up on feature X\" — Once · tomorrow 09:00 · Foo (worktree feature-x)",
  "scheduleId": "…", "label": "…", "nextFireAt": 1756976400000, "repo": "Foo", "cwd": "F:/Repos/Foo-worktrees/feature-x" }
{ "ok": true, "kind": "run", "message": "Started session …", "sessionId": "…", "repo": "Foo", "cwd": "…" }
{ "ok": true, "kind": "list", "message": "3 schedules", "schedules": [ { "id", "label", "when": "Daily 09:00", "nextFireAt", "enabled", "target": "new session · Foo (worktree feature-x)", "source": "cli" | "app" } ] }
{ "ok": true, "kind": "cancel", "message": "Deleted schedule …" }
{ "ok": true, "kind": "ping", "message": "OpenWhisperer 1.32.0 (dev)", "sessionId": "…" | null }
{ "ok": false, "error": "…" }
```

### App-side resolution (`stores/cliInbox.ts`)

- Repo: `target.repo` (name, case-insensitive, or path) if given; else match
  `target.repoPath` against `repos.list[].path` (normalized: forward slashes,
  lowercase, no trailing slash). No match → error `Not a registered
  OpenWhisperer repository: <path>. Add it in the app or pass --repo <name>.`
- Worktree: `target.worktreePath` is kept only when it differs from the repo
  path. `newWorktree` wins over it.
- Model/effort/account: explicit request values → else the invoking session's
  (when `sessionId` resolves to a live session) → else the app defaults for that
  repo (`snapshotLaunchConfigForRepo`). **The provider is derived from the
  resolved model** (`getProviderForModel`), never requested separately: a
  `target.model` is expanded through `resolveModelAlias` and must land on a
  catalog model whose provider is enabled, otherwise the request is refused with
  the list of available models. Effort inherits across providers too (clamped via
  `clampEffortForModel`); an account only inherits within its own provider.
- `same_session` requires `sessionId` to resolve to a live session; the fallback
  snapshot carries the resolved repo/model/… and `worktreePath`.
- `schedule` → `schedules.add({...})` with `source: 'cli'`; if `nextFireAt` is
  already due (e.g. `run --same-session`), the driver is poked immediately.
- `run` (new session) → `launchSession({ worktreePath, … })` directly (no
  Schedule entity); with `--wait-idle` it is parked on the Smart Queue's
  `after_sessions` rail (`schedule: 'after_sessions'`) until the scope is idle.
  `run --same-session` → a message-target schedule at *now* (so it waits for the
  session to be idle instead of colliding with a running turn).
- CLI grammar extras beyond the table below (implemented in `cli/src/timeparse.rs`):
  `--in` also takes `s`/`w` units; `--every` accepts `daily|weekly|monthly|weekday`
  aliases; `today HH:MM` never rolls over (the app rejects a past time).

## Schedule schema additions (`stores/schedules.ts`)

- `ScheduleSessionTarget.worktreePath?: string` — run in this existing worktree.
  Ignored when `useWorktree` is true. At fire time, if the directory is gone,
  launch in `repo.path` and record `note: 'Worktree <path> is gone; ran in main repo'`
  on the run.
- `ScheduleMessageTarget.fallback.worktreePath?: string` — same, for `launch_new`.
- `Schedule.source?: 'cli'` — badge in the Scheduled tab.
- `waitForIdle` for session targets is scoped to the target cwd
  (`worktreePath ?? repo.path`), not always the main repo path.
- `ScheduleRun.note?: string`.

## CLI surface

```
ow run "<prompt>" [target opts]                     # new session in this worktree, now
ow run --same-session "<prompt>"                    # follow-up turn in the invoking session (waits for idle)
ow schedule "<prompt>" --at <when>                  # one-shot
ow schedule "<prompt>" --in <dur>                   # one-shot, relative
ow schedule "<prompt>" --every <rule> [--time HH:MM] [--on …] [--interval N] [--until <when>] [--max-runs N]
ow list [--json]        ow cancel <id>        ow ping        ow install-skills        ow self-install
```

Prompt: positional, or `--prompt-file <path>`, or `-` for stdin.

Common options: `--label`, `--repo <name|path>`, `--model <name|alias>`,
`--effort`, `--new-worktree`, `--same-session`, `--wait-idle`,
`--catch-up run-once|skip` (default run-once), `--json`, `--timeout <s>`,
`--dev`, `--no-wait`.

Time grammar (local wall clock):
- `--at`: `YYYY-MM-DD` (09:00), `YYYY-MM-DDTHH:MM`, `YYYY-MM-DD HH:MM`, `HH:MM`
  (today, or tomorrow if already past), `today HH:MM`, `tomorrow [HH:MM]`,
  `mon|tue|…|sun [HH:MM]` (next occurrence), or epoch ms.
- `--in`: `30m`, `2h`, `1h30m`, `3d`, bare number = minutes.
- `--every`: `day`, `weekdays` (Mon–Fri), `week` (+ `--on mon,wed`, default =
  today's weekday; `--interval 2` = every 2 weeks), `month` (+ `--on 1..28|last`,
  default 1), `Nd` (every N days). `--time` defaults to 09:00.
- Exactly one of `--at` / `--in` / `--every` for `schedule`.

Git detection (in cwd): `git rev-parse --show-toplevel` (worktree root),
`git rev-parse --path-format=absolute --git-common-dir` (main root = its parent
when it ends in `/.git`, else itself), `git rev-parse --abbrev-ref HEAD`
(`HEAD` → null). Paths normalized to absolute forward-slash form.

Exit codes: 0 ok (incl. schedule left in inbox), 1 app error / cancelled before
execution, 2 usage error, 3 timeout with unknown outcome (may already be running).
