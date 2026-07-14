# Multi-Boxing — Multiple Claude Accounts — Brainstorm & Research (July 2026)

**Concept:** Support multiple logged-in Claude (and later Codex) accounts on one computer. Every session is scoped to exactly one account and shows it. Repos can prefer specific accounts (personal vs work). Optionally, new sessions are routed automatically across accounts by remaining capacity ("round-robin").

Status: **v1 implemented (July 2026), provider-agnostically** — account registry (`config/accounts.rs` / `commands/account_cmds.rs` / Settings → Accounts), per-session pinning via `SdkSession.accountId` → `CLAUDE_CONFIG_DIR` / `CODEX_HOME` env injection, per-repo account whitelist (`RepoConfig.account_ids`, empty = all; order = preference), setup-view picker and header/list badges. See the "Agent Accounts" section in CLAUDE.md. **v1.5 (per-account rate-limit tracking + queue keying) is also implemented** — per-account fetch commands, a per-account store registry, account-keyed exhaustion/queue gates, per-account header pills and settings usage bars. v2 (capacity routing) remains unimplemented. Original research below unchanged; based on a web research sweep (auth mechanics, community tooling, prior art in dev-tool identity UX and LLM routers) and a codebase integration scan.

---

## 1. The one decision that shapes everything: architecture & ToS

Research surfaced a hard split between two architectures, and Anthropic's enforcement keys on exactly this distinction:

- **BANNED — token-pooling proxy.** A server/process pools subscription OAuth tokens, exposes one Anthropic-compatible endpoint, rewrites headers/`account_uuid`, impersonates the official client (CC-Router, claude-relay-service, TeamClaude's mid-session swap trick). Anthropic detects "one source, many tokens" and bans in waves. Additionally, community reporting describes a **Feb 2026 Consumer-ToS tightening**: subscription OAuth tokens (Free/Pro/Max) may not be used in third-party tools/services, with the Agent SDK expected to use API-key auth; from April 2026 enforcement reportedly shifted to billing (harness usage draws pay-as-you-go "extra usage" instead of subscription limits). ([winbuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/), [augmentedmind](https://augmentedmind.substack.com/p/the-end-of-the-claude-subscription-hack))
- **ACCEPTED — N isolated real-client profiles.** Each account is logged in by the user themselves via the official flow, isolated in its own **`CLAUDE_CONFIG_DIR`**. No relay, no shared token store, no impersonation — Anthropic sees N ordinary users. A write-up contrasting the two patterns notes Anthropic acknowledged the config-dir approach as legitimate. ([dev.to comparison](https://dev.to/vainamoinen/two-multi-account-claude-code-architectures-one-anthropic-accepts-one-they-ban-2om7); native profile support is a popular open request, [claude-code #20131](https://github.com/anthropics/claude-code/issues/20131))

**Where OpenWhisperer stands:** the app already runs the user's own single OAuth login through the Agent SDK sidecar (`ClaudeAuthMethod::OAuth`, default). Multi-boxing as designed here doesn't change that posture — it multiplies the user's *own* first-party logins, each isolated per `CLAUDE_CONFIG_DIR`, selected locally at session spawn. That is the defensible end of the spectrum. What we must **never** build: a shared proxy, token pooling across users, or automatic mid-conversation account hopping (that's the proxy pattern's tell). The ToS gray zone (subscription OAuth + Agent SDK) already applies to the app today with one account; multi-account doesn't make it worse, but the risk section (§7) should be honest in the UI/docs.

Also relevant: Anthropic's consumer terms prohibit *sharing* account credentials between people. One person's personal + work accounts on one machine is the ordinary case; a team pooling accounts is not. Scope the feature and its copy to "your accounts."

---

## 2. Auth mechanics (what actually works)

### Credential storage & `CLAUDE_CONFIG_DIR`

- **Windows** (our primary platform): credentials live at `%USERPROFILE%\.claude\.credentials.json` (plain JSON, user-ACL). **If `CLAUDE_CONFIG_DIR` is set, the whole config dir — including `.credentials.json` — moves there.** Two processes with different config dirs are fully isolated logged-in accounts, concurrently. Same on Linux. ([auth docs](https://code.claude.com/docs/en/authentication))
- **macOS**: the sharp edge. Credentials live in one shared Keychain entry (`Claude Code-credentials`) that `CLAUDE_CONFIG_DIR` does *not* redirect — a second `/login` overwrites the first, and there's a known keychain race ([#24317 via #37512](https://github.com/anthropics/claude-code/issues/37512)). Tools either swap keychain contents on switch (claude-swap) or use `CLAUDE_CODE_OAUTH_TOKEN` in env — which has its own nasty bug: **it silently deletes the Keychain entry on exit** ([#37512](https://github.com/anthropics/claude-code/issues/37512)). macOS support should be a later phase.
- **Auth precedence** (docs): Bedrock/Vertex → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` (1-year token from `claude setup-token`) → `/login` OAuth. The env chain applies to the CLI **and the Agent SDK**.

### The SDK respects per-session env

The TS SDK's `query()` honors `options.env` — this is how per-account `CLAUDE_CONFIG_DIR` / `ANTHROPIC_API_KEY` gets scoped per session inside one sidecar process. One live bug to design around: an `env` block in `~/.claude/settings.json` **overrides `options.env`** ([sdk-typescript #217](https://github.com/anthropics/claude-agent-sdk-typescript/issues/217)) — keep auth env out of shared settings files; per-account config dirs sidestep this too.

### Fresh config dirs need onboarding

A brand-new `CLAUDE_CONFIG_DIR` triggers the first-run walkthrough/login. So "Add account" is necessarily an interactive step: the app spawns a terminal with `CLAUDE_CONFIG_DIR=<dir> claude` (or `claude setup-token`) and the user logs in there once — same UX shape as our existing `run_docker_setup` "open a terminal and drive it" pattern.

### Codex symmetry

Codex reads `CODEX_HOME` (default `~/.codex`, holds `auth.json`); the identical per-profile-dir trick works, and the community tooling mirrors Claude's (codex-profiles, codex-switch; first-class `--auth-profile` requested in [openai/codex #4432](https://github.com/openai/codex/issues/4432)). Design the account model provider-generically from day one, ship Claude first.

---

## 3. Prior art — what good multi-identity design looks like

From gh CLI / AWS profiles / kubectl contexts / git `includeIf` / Firefox containers, plus LLM routers (LiteLLM, OpenRouter) and Claude-specific pool tools (claude-swap, TeamClaude):

1. **Named profiles bundling identity + defaults** (like kubectl contexts), not a bare credential list.
2. **A single global "active account" is the #1 complaint** (gh CLI's model) — every mature tool grew per-invocation override and per-directory affinity. We should have *no* global active account at all: selection is per-session, defaulted by repo.
3. **Repo-derived affinity beats manual switching** — git `includeIf` and Firefox's "always open in this container" prove identity should follow *location* automatically.
4. **Visual identity must be impossible to miss.** Firefox's thin colored line is a documented failure. Account = user-chosen color + name, badged prominently on session header, list items, and the setup view.
5. **Pin per conversation, re-key only on new sessions.** A Claude conversation is resumable only under its creating account, and the prompt cache is account-scoped (every hop = guaranteed cache miss). When the pinned account exhausts mid-session, **queue the turn to window reset — never silently hop** (our Smart Queue already models exactly this).
6. **Routing strategy consensus:** sticky-until-threshold beats naive round-robin. claude-swap auto-switches at 90% utilization to the account with most quota left, with a 5-min cooldown + hysteresis to stop flip-flopping; TeamClaude stays until ~98% then prefers the account whose window resets soonest, and ramps concurrency after a switch to avoid a thundering-herd exhaustion cascade.
7. **Track capacity per (account × window)** — and note TeamClaude tracks weekly caps per *model family* (an account can be out of Opus but fine for Sonnet).
8. **Show a live per-account capacity dashboard** (5h/7d bars, reset times, data freshness) — the universal feature of every serious pool tool.
9. **API-key accounts are a tracking blind spot** — they never report window utilization; routing logic must treat them as "unknown capacity" (or last-resort/metered).

---

## 4. Codebase integration map

The codebase scan's headline: **the backend rail already exists** (per-repo GitHub-token pinning), the session/persistence model absorbs a new field for free, and the one real refactor is de-singleton-ing the Claude rate-limit state.

### Account → env: ride the GH_TOKEN rail (no new IPC)

- Per-repo `gh_user` already flows: `RepoConfig.gh_user` (`config/repo.rs:63-66`) → `resolve_gh_token`/`gh_session_env` (`commands/github_cmds.rs:174-200, 466-475`) → `create_sdk_session`'s `env` map (`commands/sdk_cmds.rs:31-36`) → `OutboundMessage::Create.env` (`sidecar.rs:82-85`) → sidecar `options.env` (`sidecar/src/index.ts:3197-3203`, stored as `session.extraEnv`, also applied to the Codex app-server spawn env).
- **An account is just another env delta on the same rail:** OAuth-profile accounts inject `CLAUDE_CONFIG_DIR=<per-account dir>`; API-key accounts inject `ANTHROPIC_API_KEY=<key>`. Codex later: `CODEX_HOME`.
- **One sidecar process suffices.** `SidecarManager` runs a single Node child (`sidecar.rs:657-676`); sessions are multiplexed in a `Map` (`index.ts:537`) each with isolated `options.env`. No process-per-account needed. Per-account config *dirs* also solve concurrent token-refresh contention (two sessions on the same account share a dir; different accounts never touch each other's credentials).
- Caveat to verify at implementation time: today `sidecar.rs:762-777` injects one keyring `ANTHROPIC_API_KEY` process-globally at sidecar spawn — with the settings.json-env-precedence bug (#217) in mind, per-session values must reliably win over process-global ones (they're merged later in `options.env`, so they should).

### Session model: one auto-persisted field

- Add `claudeAccountId?: string` to `SdkSession` (`stores/sdkSessions.ts:428-562`, beside `provider`). Auto-persist-by-exclusion means it survives restart with **zero persistence code** (just don't add it to `NON_PERSISTABLE_FIELDS`).
- Thread it through `snapshotLaunchConfigForRepo` (`utils/sessionLaunch.ts:42-48`) and the `create_sdk_session` invoke (`sdkSessions.ts:1850-1873`, beside `ghUser`). On restore, re-resolve account → env exactly where `gh_user` is re-resolved (`sdkSessions.ts:1837-1839`).
- Forks and reruns inherit the parent's account (resumability is account-locked).

### Per-repo preference: mirrors `gh_user` byte-for-byte

- `RepoConfig.claude_account: Option<String>` (+ maybe `accounts_allowed: Vec<String>` later) in `config/repo.rs`, mirror in `stores/repos.ts:45`, picker as a sibling row to the existing gh-account `<select>` in `RepositoryView.svelte:750-777`. The gh integration's "auto-match owner on first detect, but an explicit Default choice sticks" pattern (`RepositoryView.svelte:124-135`) is reusable.

### The hard refactor: per-account rate limits & queue

Everything rate-limit/queue-shaped is a per-provider singleton today:

- `rateLimits.ts:242-261` — one Claude store + one Codex store; `fetch_claude_rate_limits` (`sdk_cmds.rs:558-599`) reads the single hardcoded `~/.claude/.credentials.json` and hits the OAuth usage endpoint.
- `queueDetection.ts` (`storeForProvider`, `providerExhaustion`, `shouldQueue`) and `smartQueue.ts` (`PROVIDERS`, `drain`, `isReady`) key on provider only; `QueueInfo`/`RateLimitedState` carry `provider`.

Multi-account version: Claude limits become `Map<accountId, ProviderRateLimits>` (fetch iterates each account's config dir — `fetch_claude_rate_limits` gains a credentials-path parameter); exhaustion/queueing/draining key on `(provider, accountId)`. A session's rate-limited turn waits for *its* account's window. This refactor is the bulk of v1.5 (§6).

### Spare Tokens synergy

`spareTokens.ts` already implements capacity-aware selection (`evaluateBurn` classifies prime/okay burn windows per provider store). Run per account and it becomes "burn the account with the most expiring headroom" — and conversely, the round-robin account picker for new sessions is essentially `evaluateBurn`'s inverse ("most headroom remaining"). Same per-account-store dependency as the queue refactor.

### UI surfaces

- **Account manager:** `settings/ClaudeTab.svelte:85-176` (Authentication block) — list accounts, Add (spawns terminal login into a fresh config dir), Remove, per-account color/label, per-account 5h/7d bars.
- **Picker at session creation:** `SessionSetupView.svelte` beside Provider/Model, gated like `showProviderChoice` (only when >1 account) — defaults from repo affinity, per-session override.
- **Badges:** `SdkSessionHeader.svelte` (beside the model badge at `:287`), `SessionListItem.svelte`, pane headers. Color + short label; prominent (Firefox lesson).
- **Capacity:** `RateLimitIndicator.svelte:129` grows one bar per account (compact stacked variant in the header).
- **Usage attribution:** tag usage records with the session's `claudeAccountId` at ingestion (`sdk-usage-<id>` handler; `usageStats.ts`) so the Usage dashboard can slice by account — "how much did my work account cost this week."

---

## 5. Design decisions

- **No global "active account."** Account is a property of a session, resolved at creation: explicit pick > repo affinity > default account > (v2) capacity router. Matches AWS-profile/per-invocation semantics, avoids gh CLI's biggest complaint.
- **Sticky forever.** A session's account never changes after creation. Exhaustion mid-conversation → existing rate-limited-turn deferral, waiting on *that account's* reset. Round-robin applies to **new sessions only**.
- **Account model** (new `config/accounts.rs` + TS mirror, following the `QueueConfig` serde-defaults pattern — no migration entry needed):

  ```
  ClaudeAccount {
    id, label,            // "Personal", "Work"
    color, icon?,         // visual identity
    kind: OAuthProfile | ApiKey,
    config_dir,           // OAuthProfile: absolute path (default <app-config>/claude-accounts/<id>/)
    keyring_ref,          // ApiKey: keyring entry name (never the key in config)
    disabled?, added_at
  }
  ```

  Backward compatibility: the user's existing default `~/.claude` login is auto-registered as account #1 ("Default") with `config_dir: None` — zero behavior change until a second account is added; all account UI stays hidden with only one account (same philosophy as `enabled_providers`).
- **Add-account flow:** pick a label + color → app creates the config dir → spawns a terminal with `CLAUDE_CONFIG_DIR` set running `claude` → user completes `/login` → app polls for `.credentials.json` appearing → verified, fetch its rate limits as a smoke test. (Reuses the `run_docker_setup` spawn-a-terminal pattern and the onboarding "poll until ready" pattern.)
- **Routing (v2), per prior-art consensus:** sticky-until-threshold. New session → candidate set = repo's allowed accounts (or all enabled) → filter exhausted/cooling-down → prefer the current repo-affine account until it crosses ~90% of either window → otherwise pick most-remaining-capacity (tiebreak: resets soonest). 5-min cooldown + a few-percent hysteresis margin. API-key accounts rank last (metered, no window data).
- **Voice angle:** account joins the pre-send cycling family (`recordingCycles.ts` — repo, model, *account*) and gets a hotkey + overlay chip; "use my work account" as a voice-command modifier fits the app's identity.
- **Honest-risk copy:** the account-manager UI carries one calm sentence — these must be your own accounts, automation across accounts is at your own risk under Anthropic's consumer terms, and heavy parallel use is a known flag signal.

### Ambition ladder

- **v1 — scoping (the must-have):** account registry + add/remove UI; `claudeAccountId` on sessions; env injection at create; per-repo preferred account; badges everywhere. Round-robin absent; rate-limit UI still shows the default account only. Small, and delivers the stated core need ("scope each session to one account, and show it").
- **v1.5 — per-account awareness:** de-singleton rate limits (`Map<accountId, …>`), per-account bars in the indicator, Smart Queue keys on `(provider, account)`, usage attribution per account.
- **v2 — capacity routing:** "Auto" entry in the account picker; sticky-until-threshold selection for new sessions; queue drain picks the least-exhausted allowed account for *never-launched* queued sessions (rate-limited turns stay pinned).
- **v2.5 — adjacent wins:** Spare Tokens burns per-account expiring headroom; Codex multi-account via `CODEX_HOME`; macOS support (needs the keychain strategy).

---

## 6. Suggested MVP (v1)

1. `config/accounts.rs` (`Vec<ClaudeAccount>` on `AppConfig`, serde defaults) + settings.ts mirror.
2. `list/add/remove` commands + terminal-login flow; `resolve_claude_account_env(account_id) -> Vec<(String,String)>` beside `gh_session_env`.
3. `claudeAccountId` on `SdkSession` + threaded through create/restore/fork; `claude_account` on `RepoConfig` + RepositoryView picker.
4. Account picker in `SessionSetupView` (hidden with ≤1 account) + badges in `SdkSessionHeader`/`SessionListItem`.

Everything rides existing rails; the only new backend machinery is the account registry and the terminal-login helper.

---

## 7. Risks & gotchas (design around these)

1. **ToS gray zone** (§1): keep strictly local, first-party logins, user-initiated; no proxying, no mid-session hops, no "sign in with Claude" productization. Reported detection signals: many tokens from one endpoint, unusual OAuth patterns, high parallel volume.
2. **macOS keychain** shared entry + the `CLAUDE_CODE_OAUTH_TOKEN` keychain-deletion bug (#37512) — defer macOS; Windows/Linux config-dir isolation is clean.
3. **`options.env` vs settings.json env bug** (sdk-ts #217) — ensure no auth env in shared settings files; verify per-session precedence over the sidecar's process-global `ANTHROPIC_API_KEY` injection (`sidecar.rs:762`).
4. **Resumability is account-locked** — deleting an account with live sessions must warn; restored sessions with a missing account fall back to Default with a visible banner, not silently.
5. **Prompt cache is account-scoped** — another reason routing applies to new sessions only.
6. **Per-model-family weekly caps** — v1.5's per-account windows may eventually need an account×model dimension; don't paint the store shape into a corner.
7. **Fresh config dirs must be onboarded** — the add-account flow owns this; detect "dir exists but never logged in" and surface it as an account health state (like gh's quarantine-on-expired-token idea: expired/unrefreshable account → `disabled` with a re-login prompt).
8. **7d window is per account but real money/limits are too** — round-robin makes it easy to quietly drain the work account with personal experiments; per-repo *allowed* lists (not just preferred) are the guardrail.

---

## 8. Sources

Primary:

- https://code.claude.com/docs/en/authentication — credential storage per OS, env-var precedence, `CLAUDE_CONFIG_DIR`, `setup-token`, `apiKeyHelper`; applies to CLI + Agent SDK.
- https://github.com/anthropics/claude-code/issues/20131 — open request for native multi-account profiles.
- https://github.com/anthropics/claude-code/issues/37512 — `CLAUDE_CODE_OAUTH_TOKEN` deletes macOS Keychain entry; refs keychain race #24317.
- https://github.com/anthropics/claude-code/issues/33430 — `CLAUDE_CONFIG_DIR` docs request, closed not-planned.
- https://github.com/anthropics/claude-agent-sdk-typescript/issues/217 — settings.json `env` overrides `options.env`.
- https://github.com/openai/codex/issues/4432 — Codex `--auth-profile` request; `CODEX_HOME` pattern.

Community tooling & patterns:

- https://github.com/realiti4/claude-swap — per-platform credential swapper; 90% threshold auto-switch to most-quota-left; cooldown + hysteresis; per-terminal account scoping.
- https://github.com/KarpelesLab/teamclaude — sticky-until-98%, reset-soonest rotation, per-model-family weekly buckets, storm control. (Proxy architecture — pattern reference only.)
- https://github.com/VictorMinemu/CC-Router — round-robin proxy w/ 429/529 cooldown. (Banned architecture — anti-pattern reference.)
- https://docs.litellm.ai/docs/routing — canonical router vocabulary: deployments, cooldowns, fallback order, usage-based routing.
- https://openrouter.ai/docs/guides/routing/provider-selection — hard constraints vs soft preferences, automatic fallbacks.
- https://github.com/cli/cli/blob/trunk/docs/multiple-accounts.md + https://github.com/cli/cli/issues/12459 — gh multi-account; global-active-pointer pain.
- https://medium.com/@mrjink/using-includeif-to-manage-your-git-identities-bcc99447b04b — per-directory identity (git `includeIf`).
- https://github.com/mozilla/multi-account-containers/ — visual identity + URL affinity; thin-indicator failure mode.
- https://joshcgrossman.com/2026/02/04/claude-two-accounts-windows/ , https://jaesolshin.com/posts/claude-code-multi-account/ — CLAUDE_CONFIG_DIR multi-account guides (Windows/general).
- https://github.com/weidwonder/claude_agent_sdk_oauth_demo — Agent SDK + `CLAUDE_CODE_OAUTH_TOKEN` subscription auth.

ToS / enforcement reporting:

- https://dev.to/vainamoinen/two-multi-account-claude-code-architectures-one-anthropic-accepts-one-they-ban-2om7 — the accepted-vs-banned architecture split.
- https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ , https://augmentedmind.substack.com/p/the-end-of-the-claude-subscription-hack — Feb 2026 OAuth clampdown reporting.
- https://metricnexus.ai/blog/anthropic-banning-multiple-claude-accounts , https://www.grandlinux.com/en/blogs/claude-account-ban-risk.html — multi-account ban-risk analyses; detection signals.
