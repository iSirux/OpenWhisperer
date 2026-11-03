---
name: openwhisperer
description: Schedule a prompt for later, make it recurring, or run it now as a new OpenWhisperer agent session in the current repo/worktree via the `ow` CLI. Use when the user says things like "schedule a follow-up", "do this tomorrow at 9", "tonight", "in 2 hours", "every morning / every weekday / every Monday", "check back later", "run this again next week", "remind me to…", or wants a recurring agent task. Also use to read recent OpenWhisperer sessions and their transcripts (workflow reviews, "what did the agents do this week"), to drop findings into the user's Pile for later, or to add/remove quick actions and prompt chips.
---

# OpenWhisperer scheduling (`ow`)

`ow` hands a prompt to the OpenWhisperer desktop app, which runs it as an agent session at the requested time, in the repo and worktree you are in right now. The app must be running for schedules to fire (schedules persist and catch up on next launch).

## Workflow

1. **Get the current local date and time first** (`date` in bash, `Get-Date` in PowerShell). Never guess the date, the weekday, or the time.
2. Turn the user's phrasing into exactly one timing flag (table below). If it is genuinely ambiguous ("later", "sometime next week"), ask one short question instead of picking.
3. **Write the prompt for a fresh agent that has no memory of this conversation.** State the goal, the branch and files involved, what was already done, and what "done" looks like. Include how to verify. Long prompts: write them to a temp file and pass `--prompt-file`. For a recurring task, first read a few existing recurring prompts in the same repo (`ow list`, then `ow show <id>`) and match how the user words them.
4. Run `ow`, then relay its confirmation line (label, when, repo/worktree) to the user verbatim. If it times out, read the reported outcome: a cancelled request did not execute, but an unknown outcome may already have started. Check the app or the reported ack file before retrying an unknown outcome; never launch a duplicate automatically. Older CLIs incorrectly report "not running" even when a slow launch succeeded, so verify those outcomes too.

## Commands

```
ow run "<prompt>"                                   # new session in this worktree, right now
ow run --same-session "<prompt>"                    # follow-up turn in THIS session (waits until it is idle)
ow schedule "<prompt>" --at <when>                  # one-shot at a time
ow schedule "<prompt>" --in <duration>              # one-shot, relative
ow schedule "<prompt>" --every <rule> [--time HH:MM] [--on ...] [--interval N] [--until <when>] [--max-runs N]
ow list                                             # existing schedules (ids, next fire)
ow show <schedule-id>                               # one schedule in full, prompt included (id or unique prefix)
ow update <schedule-id> "<new prompt>" [--label ...]  # edit in place: timing, run history and id are kept
ow cancel <schedule-id>
ow ping                                             # is the app reachable?
```

Prompt goes as the positional argument, via `--prompt-file <path>`, or `-` to read stdin. Quote it.

## Timing flags (local wall clock)

| Flag | Accepts | Examples |
| --- | --- | --- |
| `--at` | `YYYY-MM-DD` (09:00), `YYYY-MM-DDTHH:MM`, `HH:MM` (today, or tomorrow if past), `today HH:MM`, `tomorrow [HH:MM]`, `mon`..`sun [HH:MM]` (next one) | `--at 2026-09-04T09:00`, `--at "tomorrow 09:00"`, `--at "fri 17:30"` |
| `--in` | `30m`, `2h`, `1h30m`, `3d` | `--in 2h` |
| `--every` | `day`, `weekdays`, `week`, `month`, `Nd` | `--every weekdays --time 09:00`, `--every week --on mon,wed --time 10:00`, `--every week --interval 2 --on fri`, `--every month --on last --time 18:00`, `--every 3d` |

`--time` defaults to 09:00. `--on` takes weekday names for `week` and `1..28` or `last` for `month`. `--until <when>` and `--max-runs N` end a recurrence. Use exactly one of `--at`, `--in`, `--every`.

## Targets and options

- **Default: a new session in the current worktree**, same model and effort as the session you are in. This is right for "schedule a follow-up on this feature": the new agent gets a clean context and your prompt must carry the details.
- `--same-session`: continue this conversation instead. Only when the user explicitly wants the follow-up *here* ("come back to this chat", "continue here"). If the session is gone by then, a new session is launched in the same worktree.
- `--new-worktree`: create a fresh worktree for the run (independent branch).
- If the worktree no longer exists when the schedule fires, the run happens in the main repository checkout instead.
- `--repo <name>`: only when the user asks for a different repository, or you are not inside a git repo.
- `--model <name>`: only when the user names a model. Short names work — `opus`, `sonnet`, `haiku`, `fable` (Claude) and `astra`, `sol`, `terra`, `luna` (Codex/GPT); a full id like `claude-opus-5-5` works too. **The provider follows from the model**, so `--model astra` runs the session on Codex — there is no separate provider flag. An unknown name is refused with the list of available models.
- `--effort off|low|medium|high|xhigh|max`: only when the user asks. Defaults to the effort of the session you are in, clamped to what the model supports.
- `--wait-idle`: hold the run until nothing else is working in that worktree. Good for "after the current work is done".
- `--label "<short title>"`: optional; defaults to the first line of the prompt.

## Examples

User: "Schedule a follow-up on this feature tomorrow morning."
```
ow schedule --at "tomorrow 09:00" --label "Follow up: feature X" \
  "Follow up on feature X on branch feature-x. Yesterday we implemented A and B (see commits since main). Check the CI status of the PR, address any review comments, and run the test suite. Report what changed."
```

User: "Every weekday at 8, check open PRs and rebase the stale ones."
```
ow schedule --every weekdays --time 08:00 --label "Rebase stale PRs" "List the open PRs of this repo with gh. For each one behind main by more than 20 commits, rebase it onto origin/main, resolve trivial conflicts, run the tests, and push. Summarize."
```

User: "In two hours, re-run the flaky test and tell me if it is really fixed. Continue in this chat."
```
ow schedule --in 2h --same-session "Re-run tests/api/test_upload.py 5 times. Report whether the flake from earlier reproduces."
```

User: "Start a separate session now to update the docs for what we just did."
```
ow run "Update docs/ for the new export feature implemented on branch export-v2 (see the diff against main). Keep the existing doc style."
```

## Reviewing sessions and leaving findings

For workflow reviews ("how did the agents do this week?"), read the user's sessions and leave findings where the user will act on them:

```
ow sessions --since 7d [--repo <name>] [--scheduled | --interactive] [--limit N] [--json]
ow transcript <session-id-or-prefix> [--user-only | --full] [--max-chars N] [--json]
ow pile add "<finding + suggested next step>" [--title "<short title>"] [--repo <name>] [--model <name>]
ow quick-action list | add "<text>" | remove "<text>"
ow chip list | add "<text>" | remove "<text>"
```

- `ow sessions` lists live and archived sessions, most recently active first: id, repo, model, effort, user/total message counts, cost, status, the schedule that launched it, its PR. `--since` takes `7d`, `24h`, `today`, `yesterday` or a date. These read the app's files and work even while the app is closed.
- `ow transcript` prints a session: by default the user's prompts and the agent's replies (each cut to 2000 chars; `--max-chars 0` = everything). `--user-only` shows just what the user asked, which is the quickest way to spot repeated corrections. `--full` adds one line per tool call.
- `ow pile add` puts a text item in the user's Pile, an inbox they launch sessions from later. Write it as a self-contained prompt a future agent can act on. Use it for anything the user should decide on; don't launch work yourself.
- Quick actions are one-click prompts under the input box (max 60 chars). Prompt chips are toggles appended to a prompt (max 40 chars). Adding one that already exists does nothing. Only change these when the user asked you to, or when a review explicitly covers them. Run `list` first.
- If the app is closed, `pile add` and quick-action/chip edits are saved and applied on its next launch.

## Gotchas

- Do not schedule vague prompts. The future agent only sees the prompt text.
- `run` waits up to 120 seconds by default for worktree creation and session startup; other commands wait 10 seconds. `--timeout <seconds>` overrides either default.
- On timeout, exit 1 with "cancelled before execution" means the CLI removed the unclaimed request. Exit 3 means the outcome is unknown: the app may have claimed it and may still complete it. Inspect the app or the reported `<id>.ack.json` before retrying. A timeout does not prove the app is closed. A `schedule` request is kept for later processing and exits 0.
- Times are the user's local wall clock. No timezone flags.
- To change a schedule's wording, use `ow update`, not `cancel` + `schedule`: that keeps its id, cadence and run history. Changing the timing still needs cancel + schedule.
- `ow show` on an app older than the CLI prints "does not report prompts": the app needs updating, the schedule is fine.
