# Session Actions — Design Doc (July 2026)

Status: draft for discussion
Related: `docs/flow-mode-brainstorm-2026-07.md` (cockpit), no-mistakes integration (separate track, see "Future kinds")

## Problem

The app has three degenerate versions of "trigger something from a session", none of which compose:

- `settings.quick_actions: string[]` (`src/lib/stores/settings.ts:551`) — bare prompt strings rendered as buttons by `SdkQuickActions.svelte`, shown only on idle sessions with messages (`SdkView.svelte`, `showQuickActions`).
- `settings.prompt_chips: string[]` — send-time prompt modifiers (different concept, stays as-is).
- Hardcoded header buttons in `SdkSessionHeader.svelte` — `/compact` via `sdkSessions.sendPrompt(sessionId, '/compact')`, Open in VS Code/Terminal/Explorer via purpose-specific Tauri commands.

There is no way to define a reusable action that runs a CLI command in the session's cwd, no per-repo actions, and no way to show an action while a session is running.

## Goal

One `SessionAction` model, defined once in settings (globally or per-repo), rendered on multiple surfaces, supporting both prompt-sends and shell commands. Voice triggering is explicitly **out of scope** (the cockpit intent system can consume actions later without this doc needing to care).

## Data model

```ts
export type SessionActionKind = 'prompt' | 'shell';

export interface SessionAction {
  id: string;                 // stable uuid, generated on create
  label: string;              // button text, e.g. "Run tests"
  kind: SessionActionKind;
  /**
   * kind 'prompt': text sent verbatim via sdkSessions.sendPrompt.
   *   Slash commands work as-is (same path as the /compact button).
   * kind 'shell': command line run in the session's cwd.
   * Template vars (both kinds): {{cwd}}, {{branch}}, {{repoName}}.
   */
  template: string;
  /** Where the button appears. 'idle' = quick-actions row on completed sessions
   *  (current behavior); 'always' = also in the session header while querying. */
  when: 'idle' | 'always';
  /** Two-step confirm before running (for pushes, deploys, destructive shell). */
  confirm?: boolean;
  /** kind 'shell' only: what to do with the command output. */
  output?: 'silent' | 'show' | 'pipe' | 'pipe-on-failure';
}
```

`output` semantics for shell actions:

- `silent` — fire and forget; toast on non-zero exit.
- `show` (default) — render output in a collapsible result block in the session view (an app-level info message, not a conversation message).
- `pipe` — inject output into the session as a prompt: `Ran \`<command>\` (exit <code>):\n<output>` via `sendPrompt`. Turns actions into session fuel ("run tests, hand failures to Claude").
- `pipe-on-failure` — `show` on success, `pipe` on non-zero exit. Probably the most useful default for test/lint actions.

## Config changes

`AppSettings`:

```ts
// replaces: quick_actions: string[]
session_actions: SessionAction[];
```

`RepoConfig` gains optional `session_actions?: SessionAction[]` — merged after global ones (same association pattern as `mcp_servers`). Repo actions with the same `id` as a global action override it.

### Migration

On settings load, if `quick_actions` exists and `session_actions` doesn't, map each string to
`{ id: uuid(), label: s, kind: 'prompt', template: s, when: 'idle' }` and drop `quick_actions`.
Defaults ("Implement this", "Fix the issues", "Keep going") carry over the same way.

## Surfaces

All surfaces read the same resolved list (`global ⊕ repo overrides`, filtered by `when`):

1. **Quick-actions row** (`SdkQuickActions.svelte`) — `when: 'idle'` actions, shown exactly where the row shows today. LLM-generated contextual actions (`aiMetadata.quickActions`) keep their own row unchanged; they remain plain prompts.
2. **Session header** (`SdkSessionHeader.svelte`) — `when: 'always'` actions in an overflow dropdown next to the existing buttons (header space is tight). Available while querying; prompt-kind actions sent mid-query go through the existing queue behavior.
3. **Settings → General** (`GeneralTab.svelte`) — replace the current chip editor with a small list editor: label, kind, template, when, confirm, output. Repo-level editing lives in `ReposTab.svelte`.

Cockpit/voice: not in this doc. When wanted, a `run_action` `CockpitIntent` can resolve an action by label — the model needs no changes for that.

## Execution

New `src/lib/utils/sessionActions.ts`:

```ts
export async function runSessionAction(action: SessionAction, session: SdkSession): Promise<void>
```

- Resolves template vars from the session (`cwd`, branch from worktree info, repo name).
- `confirm: true` → lightweight inline confirm (button flips to "Really run?", 5s timeout) — same spirit as the cockpit's arm/confirm, no modal.
- `kind: 'prompt'` → `sdkSessions.sendPrompt(session.id, resolved)`.
- `kind: 'shell'` → new Tauri command.

### Backend: `run_session_action` command

New command in `src-tauri/src/commands/` wrapping the existing `proc.rs::run_shell_async(cwd, command)`:

```rust
#[tauri::command]
async fn run_session_action(cwd: String, command: String) -> Result<ProcOutput, String>
```

- Runs in the session's cwd. Returns `ProcOutput { success, code, stdout, stderr }` (already defined in `proc.rs`).
- Timeout (default 120s, configurable per action later if needed) to avoid zombie buttons.
- Combined stdout+stderr truncated to ~50 KB before returning, so a noisy build can't blow up the prompt when piped.
- No streaming in v1 — buttons show a spinner until the command settles. Streaming output is a later enhancement (emit `action-output-${runId}` events, same pattern as terminal output).

Frontend keeps a tiny per-session "action running" state so the button can spin and double-clicks are ignored.

## Future kinds (explicitly not in v1)

- `kind: 'pipeline'` — a multi-step orchestrated run with its own progress UI. This is where the no-mistakes deep integration would surface as an action ("Ship it"), but that integration is its own subsystem (pipeline runs attached to sessions, gate/approval UI) and is designed separately. The actions model just needs `kind` to be extensible.
- Action sequences (run action A, then B if A succeeded).
- LLM-suggested shell actions.

## Phasing

1. **v1a** — model + migration + `kind: 'prompt'` on both surfaces + settings editor. No backend work.
2. **v1b** — `kind: 'shell'` with `run_session_action`, output modes, confirm flow.
3. **later** — per-repo actions in ReposTab, streaming output, `pipeline` kind.

## Open questions

- Should `pipe` respect the session's querying state (queue vs interrupt)? Proposal: always queue (sendPrompt's existing behavior), never interrupt.
- Do header actions need icons, or is label-in-dropdown enough for v1? (Proposal: label only.)
- Shell actions on non-worktree sessions run in the repo root — fine, but `confirm` should probably default on for `kind: 'shell'` until we trust the feature.
