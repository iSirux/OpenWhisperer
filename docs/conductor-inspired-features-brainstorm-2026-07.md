# Conductor-Inspired Features — Research & Brainstorm (July 2026)

**Concept:** Conductor (conductor.build, Melty Labs) is the closest competitor to OpenWhisperer — a Mac desktop app for running parallel Claude Code/Codex/Cursor agents, each in an isolated git worktree. We researched its full feature set (docs crawl + changelog + community sentiment) and verified every candidate gap against our codebase. The headline conclusion: **our missing pillar is the post-agent "review and ship" loop** — seeing what an agent changed (diff), and taking it to a merged PR without leaving the app. Everything before the agent finishes (voice capture, routing, worktree bootstrap, queueing, multi-account) we match or beat.

Status: **research complete, decisions taken (July 2026). PR lifecycle v1 implemented 2026-07-16** — detect / view / merge only (no in-app PR creation): `fetch_branch_pr` + `merge_github_pr` (github_cmds.rs, pinned gh), `get_git_default_branch` (git_cmds.rs), `stores/sessionPrs.ts`, PR badge in `SdkSessionHeader`/`SessionListItem`, `sdk/PrPanel.svelte` (checks, strategy picker remembered via `RepoConfig.last_merge_strategy`, merge, post-merge manual-cleanup hint), and a built-in "Commit, push, create PR, merge from origin/<default> if needed" quick-action chip (agent-driven creation). Still open, in priority order: session diff viewer, then the three small worktree/launch improvements. Research based on two web-research sweeps and a 10-feature codebase verification pass.

---

## 1. Conductor in one paragraph

Free, macOS-only (Apple Silicon), VC-backed ($22M Series A), BYO Claude/Codex/Cursor subscription. Core object model: repo → **workspace** (one per task, backed by a git worktree, 1:1 with a branch) → agent chat(s). Core loop: *create workspace (from scratch, branch, PR, GitHub issue, or Linear issue) → agent implements → in-app Diff Viewer review (inline line comments feed the next prompt) → Create PR (agent drafts description from the diff) → Checks tab (CI, review threads, todos as merge blockers) → merge → auto-archive workspace*. Also: per-turn checkpoints (private git refs, hover-to-revert code+conversation), embedded terminal + run scripts, message queues, command palette, layered committed settings (`.conductor/settings.toml`), Conductor Cloud (hosted persistent agents). Sources: https://www.conductor.build/docs (concepts/workflow, reference/diff-viewer, reference/checks, reference/scripts, reference/settings), https://www.conductor.build/changelog.

Community sentiment (HN, reviews): praised for the polished review loop and model A/B workflows; criticized for GitHub OAuth scope (early), worktree `.env`/deps friction (they fixed with "Files to copy" + setup scripts — **we already have both**: `RepoConfig.worktree_copy_files` / `worktree_post_create_commands`), Mac-only, and cost multiplication across parallel agents. Conductor has **no voice interface at all** — that remains our moat. The strategic framing for everything below: *voice-fired parallel work should also be voice-reviewed and voice-shipped.*

---

## 2. Decision matrix (July 2026)

| Feature | Verdict | Why |
| --- | --- | --- |
| **PR lifecycle (create → checks → merge → archive)** | **ADOPT — top priority** | The feature that prompted this research. Removes the VS Code round-trip. §3 |
| **Session diff viewer** | **ADOPT — pairs with PR flow** | Can't review a PR you can't see. VS Code parity. §4 |
| **Worktree archive/teardown commands** | **ADOPT (small)** | Long-standing gap; chains onto merge→archive. §5.1 |
| **Graceful SIGHUP-then-kill stop for launch commands** | **ADOPT (small)** | We hard-kill (`taskkill /F /T`) today. §5.2 |
| **Per-workspace port allocation** | **ADOPT (small)** | For parallel dev-server starts across worktrees. §5.3 |
| Committed `.openwhisperer.json` per repo | Noted for later | Shareable repo config (setup/run/prompts); RepoConfig already models it, needs a layered loader. |
| Command palette (Ctrl+K) + open-in-editor button | Noted for later | "Interesting, but not now." `open_in_vscode` already exists in git_cmds.rs, just unsurfaced. |
| Visible follow-up queue (queue messages while agent busy) | Noted for later | Sidecar FIFO exists; needs store array + dispatch-on-`sdk-done` + list UI. |
| Open existing PR as session (`gh pr checkout` into worktree) | Noted for later | Natural v2 of the PR view once the lifecycle exists. |
| Model A/B fan-out (same prompt → N models in panes) | Rejected | Not wanted. |
| Per-turn checkpoints (snapshot + revert code/conversation) | Rejected for now | "Meh." |
| Embedded terminal + @terminal-to-prompt | Rejected for now | "Meh." Launch profiles cover most of it. |
| Spotlight testing, cloud workspaces, deep links, managed enterprise settings, Cursor/OpenCode harnesses, Linear | Rejected | Niche / different game / we have Notion + GitHub issues. |

---

## 3. PR lifecycle — the headline feature

**Goal:** a session that finished work in its worktree can go all the way to a merged PR in-app: commit → create PR (drafted description) → watch CI → forward failures/review comments to the agent → merge → auto-archive the session and tear down the worktree.

### What already exists (verified)

- **gh plumbing with account pinning:** `github_cmds.rs` (`run_gh_issue` helper, `gh_session_env`/`resolve_gh_token` → `GH_TOKEN` per repo). PR commands would reuse this rail.
- **Exact gh invocations as reference:** the sequence engine's PR nodes (`src-tauri/src/sequences/executor/nodes/github.rs`): `execute_github_pr` (`gh pr create --title/--body/--draft/--base/--label/--reviewer`), `execute_github_pr_wait` (polls `gh pr checks`, `gh pr view --json reviewDecision/state`), `execute_github_pr_merge` (`gh pr merge --squash/--rebase/--merge --delete-branch`). These are batch automation nodes — the missing surface is the *interactive, session-attached* one.
- **Session-attached panel pattern:** `NoMistakesPanel.svelte` (pinned above the prompt input in `SdkView`, driven by a runId-keyed store) is the exact UI shape to mirror. Header button pattern next to "No mistakes" in `SdkSessionHeader.svelte`.
- **Prompt-injection pattern:** `issueActions.ts` (compose context → `sendPrompt` into the linked session) is the template for "fix the failing checks" / "address review comments".
- **Session identity:** every session carries `cwd`, `createdBranch`/`currentBranch` — everything needed to locate the branch to PR.
- **Overlap to respect:** No Mistakes already covers a *gated pipeline* (review→test→push→PR→CI) via an external binary. The built-in flow is the lightweight native path; both can coexist (No Mistakes = strict pipeline, built-in = quick ship).

### How Conductor does it (for reference)

Their docs deliberately gloss over git mechanics — there is **no manual commit UI documented at all**. The flow is agent-centric: the agent commits as part of its work; "Create PR" (Cmd+Shift+P) "sends the current diff and repository context to the agent so it can draft a pull request description" (customizable via `prompts.create_pr`; titles/descriptions became user-editable Feb 2026). Push plumbing is a setting (`git.worktree_push_auto_setup_remote`). Post-merge cleanup is opt-in automation: `git.archive_on_merge`, `git.delete_branch_on_archive`. So Conductor ships only the "ask the agent" path with an editable result — a manual VS Code-style path and a cheap-LLM path are both differentiators for us.

### Design sketch (decisions 2026-07-16)

- **Three commit/PR-creation modes, user picks per action:**
  1. **Manual (VS Code parity):** user writes the commit message and PR title/body themselves; app runs `git add -A && git commit` / `gh pr create` deterministically. No agent, no LLM.
  2. **LLM-assisted:** app fetches `git diff <base>...HEAD` + commit list, the LLM layer (`llm/features.rs` — cheap Gemini/Groq call, same shape as session naming) drafts commit message / PR title+body, **editable before executing**.
  3. **Ask the agent:** compose an instruction into the session's own agent (`sendPrompt` "commit and open a PR for this work"), Conductor-style. Uses agent tokens and needs the session idle, but the agent has full context.
- **Backend** (`github_cmds.rs` + maybe a small `pr.rs`): `create_github_pr(repo_path, title, body, base, draft)`, `fetch_pr_status(repo_path, number)` → `{state, mergeable, checks: [...], reviewThreads: [...], reviewDecision}`, `merge_github_pr(repo_path, number, strategy, delete_branch)`, plus `commit_all(cwd, message)` and push (with `--set-upstream` handling) in git.rs.
- **Frontend:** `stores/sessionPr.ts` (PR state keyed by session, polling `fetch_pr_status` while the panel is open — reuse the 2.5s-poll pattern from No Mistakes), `sdk/PrPanel.svelte` (stepper-ish: Commit → PR → Checks → Merge → Clean up; failing checks and unresolved review threads render with a "Send to agent" button each). `SdkSession.prNumber`/`prUrl` auto-persist via the exclusion pattern so the panel survives restart.
- **Merge strategy:** chooser in the panel (squash/merge/rebase); **remember last used per repo** (e.g. `RepoConfig.last_merge_strategy`, written on every merge).
- **End of lifecycle — manual, guided:** after merge the panel switches to a cleanup step offering explicit buttons — "Delete branch & remove worktree" (runs `worktree_archive_commands` (§5.1) → `GitManager::remove_worktree` → branch delete) and "Archive session". **Nothing happens automatically**; the panel just makes the cleanup one click each.
- **No Mistakes:** fully separate feature; the PR panel does not integrate with or replace it.
- **Voice angle (later):** "create a PR", "merge it" as voice commands once the buttons exist.

### Phasing

1. **v1 (SHIPPED 2026-07-16): detect / view / merge — no native creation.** PR badge (icon + #number) right of the branch in the session header and list items; PR panel (state/review chips, checks with links, strategy chooser remembered per repo, Merge, 15s polling, post-merge manual-cleanup hint); creation happens via the built-in quick-action chip that sends "Commit, push, create PR, merge from origin/<default> if needed" to the session's agent (default branch resolved per repo).
2. **v1.1 (SHIPPED 2026-07-17): PR description + guided post-merge cleanup.** Panel shows the PR body (collapsible rendered markdown). Merged banner gains "Delete branch & worktree" → `cleanup_merged_branch` (refuses unless safe: clean working tree, no unpushed commits, never the default branch; removes the worktree, deletes local branch, best-effort deletes remote branch) and "Archive session" buttons. Cleanup disabled while an agent is busy in the same cwd scope.
3. **v2:** native creation modes — manual (VS Code parity: user-written commit message + PR title/body, app runs git/gh deterministically) and LLM-assisted (LLM layer drafts, editable before executing).
4. **v3:** forward failing checks / review comments to the agent as composed prompts; sync review threads.
5. **v4:** conflict resolution assist; "open existing PR as session" (`gh pr checkout` into a fresh worktree — fork/cross-repo refs are the hard part).

### Remaining open questions

1. Panel vs. main-pane view: session panel (like NoMistakesPanel) for the lifecycle + maybe a later per-repo PR list view. (Lean: panel only for v1.)
2. Checks polling lifetime: only while panel open, or background + notification on check failure (sound/system notification like sequences)?
3. Commit granularity: v1 is commit-all; is per-file staging (paired with the diff viewer's file list) ever wanted?

---

## 4. Session diff viewer — companion feature

**Goal:** click the "{n} changed" badge on a session and see what the agent actually did, without opening VS Code. Prerequisite-ish for reviewing before "Create PR".

**Verified gap:** backend git support is count-only (`GitManager::count_changed_files` line-counts `git status --porcelain`; no command returns hunks/patches/blob contents). The "{n} changed" span in `SdkSessionHeader.svelte` has no click handler. Only diff UI in the app is transcript text diff (`TranscriptDiff.svelte`). No diff/monaco/codemirror dep in package.json.

**Design sketch:**
- Rust: `get_git_diff(repo_path, base?)` → parsed `{path, status, hunks}` per file (shell `git diff` / `git diff <base>...HEAD` + `git status --porcelain`); `revert_file(repo_path, path)` via `git restore`; later `git log --name-status` for per-commit filtering.
- Frontend: `stores/sessionDiff.ts` (cache per session cwd, refresh alongside `syncSessionBranchMetadata`), `DiffViewer.svelte` under `components/sdk/` (file-list nav + unified view first; side-by-side later; highlight.js for syntax or add `diff2html`). Entry: clickable changed-files badge → panel/tab in `SdkView` (same slot family as NoMistakesPanel/PrPanel).
- **v2 (Conductor's killer bit):** inline comments on changed lines collected as `{file, line, text}` on the session (auto-persisted), serialized into the next prompt at send time — same append pattern as `promptChips.ts` / `SCREENSHOT_PROMPT_NOTICE`. This turns review into iteration without typing file paths.
- Phasing: v1 read-only unified diff + file list + per-file revert; v2 inline-comment-to-prompt; v3 side-by-side + commit filtering.

---

## 5. Small adopted items

### 5.1 Worktree archive/teardown commands

Missing today: there is **no user-facing worktree cleanup at all** — `GitManager::remove_worktree` exists but is only called by the sequences git node. Add `RepoConfig.worktree_archive_commands: Vec<String>` (symmetric to `worktree_post_create_commands`), a `run_worktree_pre_remove` command that runs them in the worktree then calls `remove_worktree` (+ optional branch delete), and a "Remove worktree" session action keyed off `SdkSession.createdBranch`. Primary trigger: the merge→archive chain (§3); secondary: manual session archive/close. UI hangs off the existing Worktree Setup cards in `RepositoryView`/`ReposTab`.

### 5.2 Graceful stop for launch commands

`launch.rs::kill_process` hard-kills (`taskkill /F /T` on Windows, SIGKILL on Unix). Conductor's model: SIGHUP → wait 200ms → SIGKILL. Adopt: on Unix send SIGHUP/SIGTERM first with a short grace window; on Windows attempt a console ctrl event (or graceful close) before falling back to `taskkill /F /T`. Prevents dev servers/dbs corrupting state on Stop.

### 5.3 Per-workspace port allocation

For **parallel starts**: N worktree sessions each running `npm run dev` collide on the same port today. Conductor reserves a 10-port range per workspace and exposes `CONDUCTOR_PORT`. Adopt: allocate a free port (or small range) per worktree session at creation — deterministic base from a branch-name hash (e.g. into 3000–3999) probed for availability — and expose it as `OPENWHISPERER_PORT`/`PORT` via (a) the existing per-session env rail (`OutboundMessage::Create.env`, same as GH_TOKEN/CLAUDE_CONFIG_DIR) so the *agent* sees it, (b) the `run_shell` env in `apply_worktree_setup` so post-create commands see it, and (c) `LaunchCommand` env when launched with a worktree cwd. Repos opt in by referencing the var in their dev script (`vite --port $OPENWHISPERER_PORT`).

---

## 6. Noted for later (not scheduled)

- **Committed `.openwhisperer.json`:** a committed per-repo file (+ gitignored `.local` override) for the shareable subset of `RepoConfig` (setup/run/archive commands, env var names, custom prompts, branch prefix), overlaid onto the central config at session creation. Central `config.json` stays authoritative for machine-local bits (paths, accounts). Needs its own read path — `AppConfig::load()` is a single-file read.
- **Command palette + open-in-editor:** Ctrl+K fuzzy jump over sessions/repos/archive + actions; `open_in_vscode` (already in git_cmds.rs) surfaced as a session-header button / Cmd+O.
- **Visible follow-up queue:** per-session `queuedFollowups[]` (auto-persists), Queue affordance in `SdkPromptInput` while `isQuerying`, dispatch one per `sdk-done`, editable list UI above the prompt. Today busy-send *interrupts/stream-injects* into the running turn, and only one deferred turn can be parked (`rateLimited` slot).
- **Open PR as session:** mirror of the issues stack (`fetch_github_prs`, worktree-from-PR via `gh pr checkout`, `RepoPrsView`, Review/Iterate actions, `githubPr` tag). Slot into the PR view once §3 exists.

---

## 7. Rejected (this round)

Model A/B fan-out; per-turn checkpoints; embedded terminal + @terminal; Spotlight testing (workspace→root sync); cloud/hosted workspaces; workspace/chat deep links; managed enterprise settings; additional harnesses (Cursor/OpenCode); Linear integration. Revisit only if the user brings them up.
