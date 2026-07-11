# GitHub Issues Integration — Brainstorm (2026-07)

Bring GitHub issues into OpenWhisperer the way Notion cards already are — an inbox of work you can point agents at — but **scoped per repository, not as a global board**. This doc synthesizes a codebase scan, the in-progress per-repo GitHub detection work, and external research into a design brainstorm.

> **Direction already set (2026-07-11):**
> 1. **Per-repo, not global.** Unlike the Notion kanban (a dev-mode rail button + global view), issues belong to a repository. The natural home is the `RepositoryView` main pane, next to launch profiles.
> 2. **Repo ↔ GitHub association is implemented** (working tree, 2026-07-11). `RepoConfig.github_url` (auto-detected) + `RepoConfig.gh_user` (per-repo `gh` account, unset = active account), backed by `src-tauri/src/commands/github_cmds.rs`: `detect_github_url` (normalizes SSH/HTTPS/enterprise remotes, prefers `origin`), `list_gh_accounts` (parses `gh auth status`, reports `installed` + active account), and `gh_session_env(gh_user)` — resolves a token via `gh auth token --user` and injects `GH_TOKEN`/`GITHUB_TOKEN` into the session's agent process (through `sdk_cmds.rs` → sidecar `extraEnv`), failing open to the active account. `RepositoryView` has the account picker UI. This integration *consumes* all of that; it designs none of it.
> 3. Consequence of `gh_user`: **the `gh` CLI is the auth story.** Don't build PAT/OAuth token management for v1.
> 4. **A separate issues view, entered from the repository view** — not a section/tab inside `RepositoryView`.
> 5. **SDK sessions only.** PTY mode is gone; no PTY launch path.

---

## 1. The one-sentence pitch

> **Your repo's issue tracker becomes an agent dispatch queue.** Open a repo, see its open issues, and say or click "implement," "plan first," or "discuss" — each issue becomes a tagged session (optionally in a worktree named after the issue), with linked-session badges, batch launch, and eventually write-back (comment, label, close via `Fixes #N`).

This is the same mental model GitHub itself is pushing with the Copilot coding agent ("assign an issue to the agent, get a PR back") — but provider-agnostic, local-first, voice-drivable, and integrated with OpenWhisperer's queue/worktree/effort machinery.

---

## 2. Codebase baseline

### 2.1 The Notion kanban — the template to copy (and where to diverge)

The Notion integration is deliberately thin and maps almost 1:1 onto what we need:

| Piece | Notion today | GitHub issues equivalent |
|---|---|---|
| Backend client | `src-tauri/src/notion.rs` — `NotionClient { reqwest, token, database_id }`, one `fetch_cards()` method, pagination, no write path | `github.rs` client or `gh` CLI shell-out (see §4.1) |
| Command | `notion_cmds.rs` — single `fetch_notion_cards`, token from `NOTION_TOKEN` env var (the weakest part; **don't copy**) | `github_cmds.rs` — `fetch_github_issues(repoPath, ...)`, auth via `gh` |
| Config | None (token env-only, DB id hardcoded) | Mostly free: `RepoConfig.github_url` + `gh_user` already exist |
| UI | `NotionKanban.svelte` (~825 lines): columns, multi-select, filters, per-card session badges, action buttons | `RepoIssuesView.svelte` — a dedicated per-repo view (**the key divergence**) |
| Launch | `snapshotLaunchConfig()` + `createSessionQueue().enqueue(cards.map(c => () => launchSession({..., tag: { notionCard }})))` with stagger; also a `draftAction` review-before-launch path | Identical, with `tag: { githubIssue }` |
| Session linkage | `cardSessionMap` derived from `$sdkSessions` grouped by `s.notionCard.id`; badge + live pulse per card; `SessionListItem.svelte` renders the tag badge | Same pattern keyed by issue number |
| Nav | `MainView: 'notion'`, rail button gated on `$settings.system.dev_mode` | New `MainView: 'issues'` (repo-scoped via `navigation`'s selected repo), entered from a button in `RepositoryView` |

Prompt composition to copy: `getPromptForAction(action, card)` — a switch over `implement / talk / groom / classify / split / flesh_out / plan` producing natural-language prompts, with per-action worktree defaults (`ACTION_DEFAULTS`: implement → worktree on, groom/talk → off).

### 2.2 Reusable with zero changes

- **`sessionLaunch.ts`**: `launchSession({ prompt, repo, model, effortLevel, provider, useWorktree, branchNameHint, tag })`, `snapshotLaunchConfig()`, `createSessionQueue()` (sequential + 1–5 s fuzzy stagger).
- **Worktree machinery**: `generate_worktree_branch_name` / `create_git_worktree_only` commands, `GitManager` in `git.rs`.
- **Smart Queue**: rate-limit deferral and `after_sessions` scheduling apply to issue-launched sessions for free (they're ordinary setup sessions).
- **LLM harness** (`llm/features.rs` `run_feature`): trivially add issue-shaped features later (triage suggestions, duplicate detection, effort estimation).

### 2.3 The one shared type edit that ripples

`SessionTag` in `sessionLaunch.ts` (`{ notionCard?, pileItem? }`) and the mirrored fields on `SdkSession` in `sdkSessions.ts` gain:

```ts
githubIssue?: { number: number; title: string; url: string; repoId?: string }
```

Auto-persisted by the persistence layer (auto-persist by exclusion — just add the field). Render a badge in `SessionListItem.svelte` next to the existing `notionCard`/`pileItem` badges; clicking opens the issue URL.

### 2.4 Existing GitHub touchpoints

- **Sequences engine** is the only current GitHub consumer: `sequences/executor/nodes/github.rs` shells out to `gh` for **PRs only** (`github_pr`, `github_pr_wait`, `github_pr_merge`), relying on ambient `gh auth`. No issues nodes exist — an obvious later extension (§5.6).
- **No REST client, no octocrab, no GitHub token in keyring.** `git.rs` has no remote-URL parsing yet (the in-progress `github_url` detection presumably adds it).
- **Keyring pattern exists** (`KEYRING_SERVICE = "open-whisperer"`, per-secret accounts, CRUD commands in `llm_cmds.rs`/`sdk_cmds.rs`) if a PAT fallback is ever wanted — but v1 shouldn't need it.

---

## 3. External landscape (web research)

### 3.1 Three ways to talk to GitHub

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **`gh` CLI shell-out** (`gh issue list --json ...`, `gh issue view N --json ...`, `gh issue comment/close/edit`, `gh api` for anything else) | Zero token management; multi-account via `gh auth switch` — which is exactly what `gh_user` models; rich `--json` field set (assignees, labels, milestone, state, comments, `closedByPullRequestsReferences`, sub-issues, project items…); same dependency the sequences engine already assumes | Requires `gh` installed + authed; process-spawn latency (~100–300 ms, fine for a board); JSON fields must be requested explicitly | **v1 choice** |
| **REST API** (`GET /repos/{owner}/{repo}/issues`) via reqwest | No CLI dependency; matches the `notion.rs` pattern; fine-grained PATs need only *Issues: read (+write)* on selected repos; unauthenticated works for public repos (60 req/h) | Token storage + UX (keyring, settings tab); pagination via `Link` header; 5 000 req/h authed | Fallback for users without `gh` — defer |
| **GraphQL** (required for **Projects v2**) | Only way to read/write Projects v2 board *Status* columns (`fieldValueByName(name: "Status")`, `updateProjectV2ItemFieldValue`) | Extra complexity; community reports rough edges updating status programmatically; `gh project item-list` covers some of it via CLI anyway | Only if/when we do true project-board kanban (§5.5) — defer |

Note: issue `state` in REST/CLI is just **open/closed** (+ `stateReason: completed / not_planned / reopened`). Real kanban columns ("Todo / In Progress / Done") live in **Projects v2**, a separate GraphQL-only object. So v1 is honest as a *list/triage* view, not a kanban — which suits a per-repo pane better anyway.

### 3.2 Auth notes (for the eventual non-`gh` fallback)

- **OAuth device flow** is the right desktop-app shape: client ID only, no client secret to embed, user enters a code at github.com/login/device, app polls for the token. GitHub explicitly supports it for OAuth apps and GitHub Apps.
- **Fine-grained PATs** are the simplest manual path: user creates a token scoped to selected repos with Issues read/write; store in keyring like the LLM keys.

### 3.3 Precedent: issue-to-agent is now a mainstream pattern

GitHub's Copilot coding agent flow — assign an issue, agent plans, branches, implements, opens a PR, iterates on review — is the exact loop this integration enables locally. Two takeaways worth stealing:

1. **The issue body is the spec.** Well-groomed issues (clear acceptance criteria) produce good agent runs; there's even research on "what makes an issue ready for Copilot." Our `groom`-style action (from the Notion board) translates directly: *"Read issue #N and rewrite it with clear acceptance criteria as a comment."*
2. **Close the loop through the PR.** Branch naming `issue-42-slug` and `Fixes #42` in the PR body means GitHub auto-links and auto-closes — write-back mostly for free, no API mutation needed (§5.4).

---

## 4. Proposed architecture

### 4.1 Backend: `gh`-CLI-backed commands

`src-tauri/src/commands/github_cmds.rs` **already exists** (detection + accounts + token plumbing, see the direction block). The issues commands extend it, shelling out via the existing `proc.rs` helpers (as `sequences/executor/nodes/github.rs` already does), running in the repo's `path` so `gh` resolves the right remote:

```rust
// All run with cwd = repo.path; when gh_user is set, reuse resolve_gh_token()
// and pass GH_TOKEN in the child env (same mechanism as gh_session_env).
fetch_github_issues(repo_path, gh_user?, state?, labels?, search?) -> Vec<GitHubIssue>
fetch_github_issue(repo_path, gh_user?, number) -> GitHubIssueDetail  // + body + comments
github_issue_comment(repo_path, gh_user?, number, body)              // v2
github_issue_edit(repo_path, gh_user?, number, { labels?, assignees?, state? })  // v2
```

The capability probe also already exists: `list_gh_accounts()` returns `{ installed, accounts[] }` — the issues view gates on that plus `repo.github_url`.

`GitHubIssue` (mirroring `NotionCard`'s shape discipline — one struct, duplicated as a TS interface):

```rust
struct GitHubIssue {
  number: u64, title: String, state: String, state_reason: Option<String>,
  labels: Vec<Label { name, color }>, assignees: Vec<String>,
  milestone: Option<String>, author: String, url: String,
  created_at: String, updated_at: String, comments: u32,
  issue_type: Option<String>,               // GitHub's new issue types
  linked_pr_numbers: Vec<u64>,              // from closedByPullRequestsReferences
  body_preview: Option<String>,             // first ~300 chars for card display
}
```

Multi-account is a solved problem: `gh_session_env` already resolves `gh auth token --user <gh_user>` per process and injects `GH_TOKEN`/`GITHUB_TOKEN` — stateless, race-free (no `gh auth switch` global-state flip), fail-open to the active account. Agent sessions already get it via the sidecar's `extraEnv`, so a launched agent running `gh issue comment` acts as the repo's account today; the issue-fetch commands just call `resolve_gh_token` the same way.

### 4.2 Frontend: per-repo issues pane

- **`stores/repoIssues.ts`** — small cache keyed by repo id: `{ issues, loading, error, lastFetched }`, `fetch(repo)`, staleness-based refetch (e.g. > 2 min old on view entry), manual refresh button. Unlike NotionKanban's component-local state, a store lets the rail badge (§5.7) and other surfaces share it.
- **`components/RepoIssuesView.svelte`** — a dedicated main-pane view, issue cards: number, title, labels (real GitHub label colors), assignee avatars?, comment count, updated-at, linked-PR indicator, linked-session badges (copy `cardSessionMap`). Filters: open/closed, label, milestone, text search, "assigned to me". Multi-select → batch action bar, same as PileList/NotionKanban.
- **Navigation**: new `MainView: 'issues'` in `navigation.ts` (repo-scoped — reuses the store's selected-repo state, like the `repository` view), rendered in `(main)/+page.svelte`'s view switch with the rail alongside. Entry point: an "Issues" button/card in `RepositoryView` (shown when `repo.github_url` is set and `list_gh_accounts` reports `gh` installed + authed; otherwise a one-line hint like "Install/auth `gh` to see issues"). A back affordance returns to the repository view. **No dev-mode gate** — unlike Notion, this is a mainstream feature; gate on capability, not dev mode.

### 4.3 Launch flow (the payoff)

Per-issue and batch actions, mirroring `PILE_ACTIONS` / Notion's action set:

| Action | Prompt sketch | Worktree default |
|---|---|---|
| **Implement** | "Implement GitHub issue #42: {title}. Full issue body and comments below. … When done, reference `Fixes #42` in the commit/PR." | on |
| **Plan first** | prompt-prefix instruction (same trick as `pileActions.ts`) | on |
| **Discuss** | "Let's discuss issue #42 before touching code…" | off |
| **Groom** | "Rewrite issue #42 with clear acceptance criteria; post as a comment (use `gh issue comment`)." | off |
| **Triage** (board-level) | one session: "Here are the N open issues (JSON). Suggest labels/priorities/duplicates/quick wins." | off |

Details:
- **Prompt gets the full issue**, not just the title: `fetch_github_issue` pulls body + comments at launch time (fresh, and keeps list fetches light). Include the URL so the agent can `gh` for more.
- `launchSession({ ..., branchNameHint: \`issue-${number}-${title}\`, tag: { githubIssue } })` — branch names like `issue-42-fix-overlay-flicker` make GitHub's PR↔issue auto-linking work.
- Repo is *forced* to the repo being viewed (no repo picker — it's per-repo by construction). Model/effort from the repo's defaults / current settings via `snapshotLaunchConfig()`.
- Batch multi-select → `createSessionQueue().enqueue(..., { stagger: true })`, plus the "together" combined-session variant the pile has, and Ctrl+click → Smart Queue `after_sessions` (consistent with the rest of the app).
- **Draft path**: a `prepare`-style action creating setup sessions for review before sending (Notion's `draftAction`), for issues whose bodies need a human glance first.

### 4.4 Write-back philosophy: let the agent do it

Deliberately keep app-side mutations minimal. The launched agent has `gh` in its shell — the prompt can instruct it to comment progress, label, and let `Fixes #N` close the issue via the PR. App-side write-back (§5.4) is then a *convenience layer* (quick "close / comment" buttons on the card), not a requirement. This dodges the Projects-v2-mutation mess entirely for v1.

---

## 5. Brainstorm — beyond v1

### 5.1 Voice: "work on issue forty-two"
The per-repo issue list gives voice commands a target namespace. In a session or the cockpit-adjacent surfaces: "implement issue 42", "what's issue 42 about?" (discuss-launch), "triage the new issues". Issue numbers are short, unambiguous, and already how developers talk. (Cockpit itself: not wired unless the user brings it up — but the issue store is the primitive it would consume.)

### 5.2 Pile ↔ issues: "file that as an issue"
The pile is an inbox of half-formed thoughts; many are really issue reports. A pile-item action "File as GitHub issue" (LLM turns transcript → title/body, `gh issue create`, link back). Inverse of launch: capture now, issue later, implement whenever. Also a voice command candidate ("file it").

### 5.3 New-issue awareness
`repoIssues` store already polls-ish; add an unseen-issue count badge on the repository rail icon (precedent: per-repo changed-file badges) and optionally a notification channel (precedent: sequences notifications). "A new issue arrived → triage it with one click" is a strong daily loop. Keep polling lazy (on focus/view, or a slow interval) — no webhooks in a desktop app.

### 5.4 App-side write-back (v2)
Quick actions on the issue card without launching an agent: comment, close/reopen, label, assign (`github_issue_edit`/`comment` commands above). Auto-comment on launch ("🤖 OpenWhisperer session started for this issue") — opt-in, since it's outward-facing.

### 5.5 Projects v2 kanban (v3, maybe never)
True board columns need GraphQL (`fieldValueByName(name: "Status")`, `updateProjectV2ItemFieldValue`) or `gh project` subcommands, and the community reports friction (status mutations not reflecting in board grouping, etc.). Only worth it if the user actually runs Projects boards. The per-repo *list* with state/label filters covers the dispatch-queue use case without it.

### 5.6 Sequences nodes (v2)
Mirror the PR trio with issue nodes: `github_issue_wait` (trigger: new issue with label X), `github_issue_comment`, `github_issue_close`. Combined with existing AI + PR nodes this enables a fully automated "label an issue `agent-ok` → sequence implements it → PR → checks → merge" pipeline — the local Copilot-coding-agent equivalent. The executor pattern (`run_prog("gh", ...)`) is already there.

### 5.7 Cross-repo issue surfaces (later)
Once per-repo works, a unified "assigned to me across repos" view is cheap (`gh search issues --assignee @me`) — but it's explicitly *not* the v1 shape.

---

## 6. Scope tiers

> **Status (2026-07-11): v0 is implemented.** `fetch_github_issues`/`fetch_github_issue` in `github_cmds.rs` (with older-gh retry for the linked-PR field, unit-tested parsing); `stores/repoIssues.ts`; `MainView: 'issues'` + `RepoIssuesView.svelte` (state/label/search filters, multi-select, per-issue linked-session indicators, Draft path) entered via the Issues button in `RepositoryView`'s GitHub section; `utils/issueActions.ts` (Implement / Plan first / Discuss prompts with full body+comments fetched at launch, `Fixes #N` instruction); `githubIssue` tag on `SessionTag`/`SdkSession` + `SessionListItem` badge; branch hint `issue-N-title`; `snapshotLaunchConfigForRepo` added to `sessionLaunch.ts`.

| Tier | Contents |
|---|---|
| **v0 (MVP)** | `fetch_github_issues`/`fetch_github_issue` commands in the existing `github_cmds.rs` (gh CLI, `gh_user` via the existing `resolve_gh_token` env injection; capability gate via existing `list_gh_accounts`); `repoIssues` store; `MainView: 'issues'` + `RepoIssuesView` entered from `RepositoryView` (list, filters, refresh); per-issue Implement/Plan/Discuss + multi-select batch launch through `createSessionQueue` (SDK sessions only); `githubIssue` session tag + `SessionListItem` badge + per-card linked-session indicators; branch hint `issue-N-slug`; prompts instruct `Fixes #N` |
| **v1.x** | Draft/prepare path; Groom + board Triage actions; rail unseen-count badge; "File as issue" from pile |
| **v2** | App-side comment/close/label/assign; launch auto-comment (opt-in); sequences issue nodes; REST+PAT fallback for `gh`-less users (keyring, device flow or fine-grained PAT) |
| **v3** | Projects v2 board columns (GraphQL); cross-repo "my issues" view; voice issue addressing |

---

## 7. Open questions

Resolved 2026-07-11: placement (dedicated `issues` view entered from `RepositoryView`), PTY support (none — PTY mode has been removed from the app entirely), and `gh_user` mechanics (implemented: per-process `GH_TOKEN`/`GITHUB_TOKEN` injection via `gh_session_env`/`resolve_gh_token` in `github_cmds.rs` — the issues commands reuse it).

1. **Issue body in list vs. lazy fetch**: `gh issue list --json body` can be heavy on big repos — fetch bodies lazily per issue (recommended above), or cap list at ~50 with pagination?
2. **Private repos / SSO orgs**: pure `gh` delegation should Just Work (it's the user's auth), but worth a smoke test against an org with SAML SSO.
3. **Should Notion and Issues share a generic "work-item board" abstraction?** Probably not yet — Notion is dev-mode/global, issues are per-repo; unify only if a third source appears (Linear, Jira…).

---

## 8. Sources

- [GitHub REST API — Issues endpoints](https://docs.github.com/en/rest/issues/issues)
- [Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api) · [Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) · [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Authorizing OAuth apps (device flow)](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [OAuth 2.0 Device Authorization Flow changelog](https://github.blog/changelog/2020-07-27-oauth-2-0-device-authorization-flow/)
- [`gh issue list` manual](https://cli.github.com/manual/gh_issue_list) · [`gh issue view`](https://cli.github.com/manual/gh_issue_view) · [gh formatting/JSON output](https://cli.github.com/manual/gh_help_formatting)
- Projects v2 GraphQL: [status/column discussion](https://github.com/orgs/community/discussions/44265) · [listing kanban column contents](https://github.com/orgs/community/discussions/5616) · [project status webhook/GraphQL changelog (2024-06)](https://github.blog/changelog/2024-06-27-github-issues-projects-graphql-and-webhook-support-for-project-status-updates-and-more/)
- Copilot coding agent precedent: [Assigning and completing issues with coding agent](https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/) · [About Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) · [What Makes a GitHub Issue Ready for Copilot? (arXiv)](https://arxiv.org/html/2512.21426v1)
