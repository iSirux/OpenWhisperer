# Claude Agent SDK: Native Session Names & Auto Permission Mode

Research notes (2026-07-10) on two SDK capabilities we could adopt. Neither is wired up yet.

## 1. Native session summaries (potential fast path for session naming)

Claude Code auto-generates a short session summary itself — it's what shows up as the terminal
window title when running the CLI (via an OSC title escape sequence) and is stored in its session
store (`sessions-index.json` / summary entries under `~/.claude/projects/<project>/`).

Because the Agent SDK runs on the same CLI infrastructure, this is exposed programmatically:

- `listSessions()` / `getSessionInfo(sessionId)` return each session's **display summary**, plus
  git branch, cwd, last-modified timestamp.
- `renameSession()` / `tagSession()` let us write a `custom_title` and tags back; they're stored
  as trailing JSON lines in the session's `.jsonl` (O_APPEND, safe alongside concurrent CLI writers).

### How we could use it

- **SDK sessions (Claude):** poll `getSessionInfo(sessionId)` in the sidecar after the first
  exchange (e.g. on `sdk-done`) and use the summary as the session name — no Gemini/LLM call needed.
- **PTY mode:** sniff the OSC title sequence (`ESC ] 0 ; <title> BEL`) out of the PTY output
  stream in `terminal.rs` — that's the exact string in the window title.

### Caveats

- Claude-only. Codex sessions still need the existing LLM naming path (`auto_name_sessions`),
  so this would be a per-provider fast path, not a replacement.
- The summary appears asynchronously (after some conversation exists) — needs polling/retry.
- No control over style/language vs. our own naming prompt; compare quality before switching.
- Our LLM naming also produces summary + category; the SDK summary only covers the name.

## 2. `auto` permission mode (AI-classified bash approval)

Distinct from `bypassPermissions`. **`auto` mode** (research preview) uses an AI classifier
(Sonnet 4.6, two-stage: fast single-token filter, then chain-of-thought only if flagged) that
reviews each tool call — including Bash — in the context of the conversation and decides:
safe → runs automatically, risky → blocked or escalated to the user.

Classifier criteria: reversibility, scope alignment with what the user asked, credential /
sensitive-data exposure, cascading effects. A server-side prompt-injection probe on tool outputs
acts as a second defense layer.

### How we could use it

The sidecar currently hardcodes `permissionMode: 'acceptEdits'` (auto-approves file ops only;
bash still gated). Switching is passing `permissionMode: 'auto'` — the mode is part of the SDK's
permission-mode set (subagents inherit `bypassPermissions` / `acceptEdits` / `auto` from the parent).

### Caveats

- Research preview; reduces prompts but doesn't guarantee safety.
- Escalations surface through `canUseTool` — we'd need an approve/deny UI for escalated tool
  calls (similar to the existing `PlanApprovalDialog` interception), otherwise they stall.
- Deny rules still override `auto`, so a blocklist backstop remains possible.
- Classifier adds small per-tool-call latency/cost.
- Middle-ground alternative: keep `acceptEdits` + targeted allow rules (`Bash(npm run *)` etc.)
  or auto-approve selectively in our `canUseTool` callback.

## Sources

- [How we built Claude Code auto mode — Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)
- [Choose a permission mode — Claude Code Docs](https://code.claude.com/docs/en/permission-modes)
- [Configure permissions — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Work with sessions — Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK reference — TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Manage sessions — Claude Code Docs](https://code.claude.com/docs/en/sessions)
