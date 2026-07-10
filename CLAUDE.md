# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenWhisperer is a Tauri v2 desktop application that provides a voice-controlled interface for coding agents. Users record voice prompts via hotkeys, which are transcribed by a Whisper endpoint (optionally with live realtime transcription alongside), then sent to an agent either through embedded terminal sessions (PTY mode) or directly via an SDK sidecar (SDK mode). Two SDK providers are supported: **Claude** (Claude Agent SDK) and **OpenAI Codex** (Codex SDK or Codex app-server). The app supports multimodal prompts (text + images), session persistence, usage and rate-limit tracking, effort levels, voice commands, a recording pile, sequences (node-based automation), a smart queue that defers work across rate-limit windows, split panes, and LLM-powered intelligent features via Gemini or other providers.

> **Log files:** `%APPDATA%\open-whisperer\logs\` (Windows) / `~/Library/Application Support/open-whisperer/logs/` (macOS) — named `backend[-dev]-YYYY-MM-DD.log` and `frontend[-dev]-YYYY-MM-DD.log`.

## Development Commands

```bash
# Full development - builds sidecar then runs Tauri dev (uses src-tauri/tauri.dev.conf.json)
npm run tauri:dev

# Build production app (includes sidecar)
npm run tauri:build

# Type checking
npm run check 2>&1 | grep -A 5 "Error:"
npm run check:watch      # watch mode

# Frontend only (without Tauri)
npm run dev

# Sidecar only
npm run sidecar:install  # Install sidecar dependencies
npm run sidecar:build    # Build the TypeScript sidecar
```

## Architecture

### Frontend (SvelteKit + Svelte 5)

**Routes (`src/routes/`):**

Most routes live in the `(main)` route group, which shares `(main)/+layout.svelte` (mounts `AppHeader`, starts the smart queue). The overlay route is deliberately outside the group (separate Tauri window, no app chrome).

- `(main)/+page.svelte` - Primary app view: repository rail + sidebar (Sessions/Pile tabs) + main pane. Switches on `navigation.mainView` (`sessions`, `start`, `sequences`, `archive`, `repository`, `notion`, `cockpit`) — these are **internal views**, not routes.
- `(main)/settings/+page.svelte` - Settings page with tabs (see Settings Components)
- `(main)/usage/+page.svelte` - Usage statistics dashboard with session/token/cost analytics
- `(main)/sessions-view/+page.svelte` - Unified sessions grid/list view with filtering and layout options
- `(main)/sequences/+page.svelte` - Sequence management list
- `(main)/sequences/editor/+page.svelte` - Node-canvas sequence editor (`@xyflow/svelte`)
- `overlay/+page.svelte` - Floating overlay window for recording status and realtime transcription

**Stores (`src/lib/stores/`):**

- `settings.ts` - App configuration (terminal mode, providers, transcription, hotkeys, theme, voice commands, open mic, queue, prompt chips, pane layout)
- `repos.ts` - Repository list and active repo (`RepoConfig` with id, description, keywords, vocabulary, icon, color, MCP servers, launch profiles)
- `sessions.ts` - PTY terminal session management and Tauri event listeners
- `sdkSessions.ts` - SDK session management (Claude + Codex) with message streaming, persistence, progressive usage, effort levels, image support, plan approval, rate-limit state
- `recording.ts` - Audio recording state machine using MediaRecorder API
- `recordingFlow.ts` - Global recording lifecycle singleton (start/stop, pending sessions, audio visualization, overlay integration); replaced the former page-scoped `useRecordingFlow` composable
- `transcriptProcessor.ts` - Global transcript processing service (routes finished transcriptions to sessions/pile/input regardless of active route); includes the durable pile failure sink (`handlePileTranscriptReady`)
- `overlay.ts` - Floating overlay window visibility and positioning
- `usageStats.ts` - Persistent usage statistics tracking (sessions, tokens, costs, tools, repos, daily stats, streaks)
- `rateLimits.ts` - Unified `ProviderRateLimits` (5h/7d windows + extra usage) for both Claude and Codex
- `queueDetection.ts` - Smart Queue exhaustion detection: "is a provider's usage window exhausted, which window, when does it reset?" (imports neither `sdkSessions` nor `smartQueue` to avoid cycles)
- `smartQueue.ts` - Smart Queue drain driver: dispatches deferred sessions (`status: 'queued'` → `launchPrepared`) and rate-limited turns (`rateLimited` → `continueRateLimited`) when usage windows reset; started once via `startSmartQueue()` in the main layout
- `openMic.ts` - Passive voice listening for wake command detection
- `sessionPersistence.ts` - Session persistence layer for disk storage and restoration
- `pile.ts` - Recording pile: inbox of transcribed recordings saved for later (own persistence file, saved audio, background LLM processing for cleanup/repo/model/title)
- `panes.ts` - Split-pane layout (up to 4 panes, each holding one SDK session); persists to `settings.pane_layout`
- `navigation.ts` - Main page internal view state (`MainView`, selected repo, repository-add mode)
- `ctrlHint.ts` - Whether Ctrl/Cmd is being held (with a short show delay); drives in-app hotkey hint overlays (session number badges in the sidebar, key badges on Ctrl-hotkey buttons)
- `archive.ts` - Archived-session index (search, entries with cost/duration/message counts)
- `launchProfiles.ts` - Launch profile runtimes per repo (running launches, queued launch waiting for an agent)
- `sequences.ts` / `sequenceExecutions.ts` - Sequence definitions (YAML import/export) and live execution state (node results, logs, notifications)
- `debugRecordings.ts` - Bounded rolling log (20 newest) of recordings with audio + all transcription stages; always on
- `noMistakes.ts` - No Mistakes run store (see No Mistakes Integration)
- `updater.ts` - App update check/download/install state via the Tauri updater plugin (see App Updates)

**Components (`src/lib/components/`):**

Core UI:

- `AppHeader.svelte` - Application header with global controls
- `RepositoryRail.svelte` - Narrow vertical icon rail listing repos with per-repo changed-file badges; drives repo/view selection
- `RepositoryView.svelte` - Main-pane repository landing view: metadata, icon/color, launch profiles via `LaunchBar`
- `SessionList.svelte` / `SessionListItem.svelte` - Unified sidebar list of PTY and SDK sessions with status indicators and unread markers
- `SessionPanes.svelte` - Multi-pane split view (paneforge, up to 4 panes of `SdkView`)
- `SdkView.svelte` - Main SDK session view (message stream, prompt input, panels)
- `PileList.svelte` - Pile tab in the sidebar: pile item cards with multi-select and batch launch actions
- `PileDetailView.svelte` - Main-pane editor for a pile item (transcript, repo/model, audio playback, re-transcribe, launch)
- `ArchiveView.svelte` / `ArchiveEntryItem.svelte` - Archived sessions browser
- `NotionKanban.svelte` - Notion-backed kanban board; cards can be launched as sessions (via the shared session queue). Rail button shown only in dev mode (`settings.system.dev_mode`)
- `SessionCard.svelte` - Card component for sessions-view grid display
- `SessionHeader.svelte` / `SdkSessionHeader.svelte` - Active session metadata display (PTY / SDK)
- `SessionSidebarHeader.svelte` - Sidebar header with session controls
- `EmptySessionPlaceholder.svelte` - Placeholder for empty session state
- `SessionPendingView.svelte` - View for sessions in pending states (repo selection, transcription)
- `SessionSetupView.svelte` - **The manual "New Session" form** (the fields-and-textarea view: Provider/Model/Effort/Repository/Worktree + "Your prompt" + Record/Start Session). This is the typed/manual entry point, distinct from the voice-recording prepared/approval flow in `sdk/SessionRecordingHeader.svelte`. Its `onStart` config is the choke point where the final prompt is assembled. Helpers in `session-setup/sessionSetupHelpers.ts`.
- `PromptChips.svelte` - Reusable toggleable prompt-chip row (chip set from `settings.prompt_chips`); selected chips are appended to the prompt on send. Used in `SessionSetupView`, `sdk/SessionRecordingHeader` (prepared + approval), and `PileDetailView`. See `src/lib/utils/promptChips.ts` (`appendChips`/`mergeChips`).
- `Terminal.svelte` - xterm.js terminal with WebGL rendering for PTY sessions
- `ModelSelector.svelte` - Model selection (per-provider model lists + Auto)
- `EffortToggle.svelte` - Effort level selector (replaces the old on/off ThinkingToggle)
- `RepoSelector.svelte` / `RepoSelectionDialog.svelte` / `RepoIcon.svelte` - Repository selection dropdown, LLM-recommendation dialog, curated repo icons (`utils/repoIcons.ts`)
- `QueueIndicator.svelte` - Smart Queue status indicator (queued count, next reset)
- `RateLimitIndicator.svelte` - Compact Claude + Codex rate-limit utilization indicator
- `Transcript.svelte` / `TranscriptMarquee.svelte` / `TranscriptDiff.svelte` - Transcript display, rolling realtime marquee, original-vs-cleaned diff
- `OpenMicMarquee.svelte` - Open-mic listening indicator
- `Waveform.svelte` - Audio waveform visualization
- `StatusBadge.svelte` / `ConfirmDialog.svelte` / `HotkeyInput.svelte` - Small shared widgets
- `Overlay.svelte` - Overlay window content
- `Start.svelte` - Welcome screen with microphone selection and transcription connection status
- `UsagePreview.svelte` - Compact usage stats preview for main view

**SDK Components (`src/lib/components/sdk/`):**

- `SdkMessage.svelte` - Renders individual SDK messages (user prompts, text responses, tool calls, errors, subagent events)
- `SdkTaskBlock.svelte` - Subagent (Task/Agent tool) block with lazy-mounted content
- `SdkToolGrid.svelte` - Compact grid rendering of tool calls (see `utils/toolCallFormatting.ts`)
- `SdkLoadingIndicator.svelte` - Animated loading indicator with status text
- `SdkPromptInput.svelte` - Multi-line textarea with image paste/drop support, recording button, and auto-resize
- `SdkQuickActions.svelte` - Quick action buttons for a session
- `SdkUsageBar.svelte` - Token usage display with input/output/cache stats, cost, and context usage bar
- `AskUserQuestionWizard.svelte` - Interactive UI for the SDK's AskUserQuestion tool
- `PlanApprovalDialog.svelte` - Approve/deny (with note) for the SDK's native `ExitPlanMode` plan approval, intercepted via `canUseTool` in the sidecar
- `RateLimitBanner.svelte` / `ContextOverflowBanner.svelte` - Session-level warning banners (rate-limited turn queued; context near/at overflow)
- `ForkButton.svelte` / `RerunDropdown.svelte` - Fork a session; re-run a prompt
- `LaunchBar.svelte` - Launch profile/command bar (used in `RepositoryView`)
- `NoMistakesPanel.svelte` - No Mistakes run panel (see No Mistakes Integration)
- `SessionRecordingHeader.svelte` - Header for a voice recording: shows completed-recording visualizations and drives the **prepared** (draft, ready to launch) and **approval** (review-before-send) UIs for voice-originated sessions. This is the post-recording flow — NOT the manual typed New Session form (that's `SessionSetupView.svelte`).
- `sdkViewMessageProcessing.ts` - Message-stream processing helpers for `SdkView`

**Settings Components (`src/lib/components/settings/`):**

Tabs rendered by the settings page: General, Claude, Codex, Themes, System, Microphone, Audio, Voice Commands, Transcription, LLM, Smart Queue (QueueTab), MCP, Hotkeys, Overlay, Sequences, Recordings Log, About.

- `GeneralTab.svelte` - General settings (terminal mode, language)
- `ClaudeTab.svelte` / `CodexTab.svelte` - Per-provider settings (auth method, models, execution mode)
- `SystemTab.svelte` - System settings (tray behavior, autostart, single instance, dev mode, app update mode)
- `ThemesTab.svelte` - Theme selection (Midnight, Slate, Snow, Sand)
- `MicrophoneTab.svelte` / `AudioTab.svelte` - Microphone selection; recording behavior (stop action, screenshots, sounds, open mic)
- `VoiceCommandsTab.svelte` - Voice command phrases
- `TranscriptionTab.svelte` - Unified transcription settings: final transcript source mode (Whisper / Realtime / Both) and embeds `WhisperTab` + `VoskTab` as sub-sections (they are no longer standalone tabs)
- `WhisperTab.svelte` - Whisper provider selection (Local/OpenAI/Groq/Custom) with Docker configuration
- `VoskTab.svelte` - Real-time transcription provider selection (Moonshine recommended, Vosk, VoiceStreamAI, Speaches, SherpaOnnx) with per-provider config and Docker support
- `LlmTab.svelte` - LLM integration settings with provider selection and feature toggles
- `QueueTab.svelte` - Smart Queue settings (rate-limit queueing, stagger delays)
- `McpTab.svelte` - MCP server configuration (add/edit/remove/test servers, OAuth)
- `HotkeysTab.svelte` - Global hotkey configuration
- `OverlayTab.svelte` - Overlay window settings (position, visibility, transparency)
- `SequencesTab.svelte` - Sequence engine settings (notification channels)
- `RecordingsLogTab.svelte` - Playback of the recordings log (audio + each transcription stage)
- `ReposTab.svelte` - Repository management (exported but repo management primarily lives in the repository rail/view)
- `AboutTab.svelte` - Version/about info, manual "Check for Updates" with install progress (see App Updates)

**Composables (`src/lib/composables/`) - Svelte 5 Runes:**

- `useHotkeyManager.svelte.ts` - Global hotkey registration (toggle recording, transcribe-to-input, cycle repo/model with auto-repo support)
- `useOpenMic.svelte.ts` - Open mic lifecycle with automatic restart after recording stops
- `useSessionEventHandlers.svelte.ts` - Centralized window and Tauri event listener setup/cleanup
- `useSidebarResize.svelte.ts` - Sidebar resize drag handle logic with persistence
- `useTranscriptionProcessor.svelte.ts` - Transcription processing with LLM cleanup, model/repo recommendations, and system prompt building
- `useDisplaySessions.svelte.ts` - Session filtering and sorting for display

**Actions (`src/lib/actions/`):**

- `holdSpaceRecord.ts` - Svelte action: hold-Space-to-record inside text inputs (tap types a space; hold retracts it and records; transcript inserted at caret on release). Pairs with `utils/inlineDictation.ts`.

**Utilities (`src/lib/utils/`):**

- `markdown.ts` - Markdown processing with syntax highlighting (marked + highlight.js)
- `image.ts` - Image compression and processing for the Claude API (5MB limit, auto-resize, format conversion)
- `screenshot.ts` - Screenshot prompt notice and helpers (see Recording Screenshots)
- `sound.ts` - Completion/notification sound playback
- `modelColors.ts` / `models.ts` - Model colors; model definitions, effort levels, providers, Auto model support
- `llm.ts` - LLM integration utilities (session analysis, transcription cleanup, model/repo recommendations, feature gates)
- `voiceCommands.ts` - Voice command detection and processing
- `sessionLaunch.ts` - Shared session launch machinery: `launchSession` (setup session + optional worktree + tagging) and `createSessionQueue` (simple sequential batch-launch queue with optional stagger; used by NotionKanban and the pile — distinct from the Smart Queue)
- `sessionCreation.ts` - Create-and-activate a new session from current settings (SDK or PTY); `createSessionInSameRepo` clones the active session's repo/worktree/model into a new setup session (session-header button + `new_session_same_repo` hotkey, default Ctrl+D)
- `sessionSelection.ts` - Shared "activate this display session" logic used by the sidebar list and the fixed Ctrl+1–9 session-switching hotkey (handled in the main layout, ordered identically to the sidebar)
- `pileActions.ts` - Turning pile items into sessions (`PILE_ACTIONS`: start / prepare / plan — "Plan first", a prompt-prefix instruction / discuss)
- `promptChips.ts` - Prompt chip append/merge helpers
- `inlineDictation.ts` - `makeInlineDictation()` hold-to-record dictation factory with LLM cleanup, for inputs without their own recording pipeline
- `recordingCycles.ts` - Shared pre-send cycling of recording context (repo, model) for hotkeys and overlay chips
- `noMistakesIntent.ts` - Composes the No Mistakes `--intent` string
- `sessionStatus.ts` / `duration.ts` / `hotkeys.ts` / `logger.ts` / `repoIcons.ts` / `toolCallFormatting.ts` - Status categories/styling, duration formatting, hotkey normalization, backend-forwarded logging, curated repo icon set, tool-call display formatting
- `sequenceConverter.ts` - Converts sequence definitions to/from `@xyflow/svelte` editor nodes/edges

### Backend (Rust/Tauri)

**Core Modules (`src-tauri/src/`):**

- `lib.rs` - Tauri app initialization, plugin registration, state management, command registration (`main.rs` is a thin entry)
- `config/` - Configuration module (was `config.rs`; all types re-exported from `crate::config`):
  - `mod.rs` - `AppConfig` aggregate, legacy `GitConfig`
  - `provider.rs` - `SdkProvider`, `OpenAiAuthMethod`, `ClaudeAuthMethod`, `ClaudeTerminalMode`, `CodexMode`, `TerminalMode`
  - `realtime.rs` - `VoskConfig` (general realtime transcription config despite the legacy name), `RealtimeProvider` (Vosk | VoiceStreamAI | SherpaOnnx | Speaches | **Moonshine**, default Moonshine), `TranscriptionMode` (Whisper | Realtime | Both), per-provider sub-configs
  - `whisper.rs` - `WhisperProvider`, `WhisperConfig`, `DockerConfig`, `DockerComputeType`
  - `llm.rs` - `LlmProvider`, `LlmConfig`, `LlmFeaturesConfig`, `AutoModelEffort`, `RepoAutoSelectConfidence`
  - `audio.rs` - `AudioConfig`, `VoiceCommandConfig`, `OpenMicConfig`, `RecordAndSendAction`
  - `hotkeys.rs` / `repo.rs` / `mcp.rs` - `HotkeyConfig`; `RepoConfig`, `LaunchCommand`, `LaunchProfile`; `McpServerConfig` (+ `McpAuthType`, `McpOAuthConfig`)
  - `sequences.rs` - `QueueConfig` (Smart Queue), `SequenceConfig`, notification channels
  - `ui.rs` - `Theme`, `OverlayConfig`, `SystemConfig`, `SessionsViewConfig`, `PaneLayoutConfig`, `EffortLevel`, `ToolDisplayMode`, etc.
  - `migration.rs` - Versioned config migration ladder
- `terminal.rs` - PTY management via `portable-pty`, spawns `claude` CLI
- `sidecar.rs` - SidecarManager for Node.js process IPC (message/event protocol types)
- `whisper.rs` - HTTP client for batch Whisper transcription
- `realtime.rs` - Multi-provider real-time STT WebSocket clients (replaces the old `vosk.rs`): common `RealtimeSession` trait dispatched via `RealtimeSessionType`, `RealtimeSessionManager`, per-provider connection tests, `RealtimeResponse` (Partial/Final)
- `git.rs` - GitManager for repository operations (branch/worktree creation, changed-file counts)
- `session_persistence.rs` - Session persistence layer for disk storage
- `archive.rs` - Archived-session index (`ArchiveEntry`/`ArchiveIndex`)
- `launch.rs` - Launch-profile/command execution
- `notion.rs` - Notion API client
- `no_mistakes.rs` - No Mistakes CLI integration (see No Mistakes Integration)
- `usage_stats.rs` - Usage telemetry types (moved out of config)
- `persist.rs` / `proc.rs` / `util.rs` - Shared helpers: atomic JSON writes + rolling backups; process spawning (Windows `CREATE_NO_WINDOW`); small utilities
- `sequences/` - Sequence automation engine

**LLM Module (`src-tauri/src/llm/`):**

- `mod.rs` - Unified `LlmClient` supporting multiple providers with auto-fallback
- `types.rs` - Response types (SessionNameResult, InteractionAnalysis, TranscriptionCleanupResult, ModelRecommendation, RepoRecommendation)
- `api_types.rs` - API request/response types for Gemini and OpenAI APIs
- `features.rs` - Feature implementations (session naming, interaction detection, transcription cleanup, model recommendation, repo selection)
- `providers.rs` - Provider-specific implementations
- `utils.rs` - LLM utilities and helpers

**Commands (`src-tauri/src/commands/`):**

- `settings_cmds.rs` - Config load/save, repo management
- `terminal_cmds.rs` - PTY session CRUD, terminal I/O, resize
- `audio_cmds.rs` - Audio transcription, Whisper connection testing
- `sdk_cmds.rs` - SDK session management (Claude + Codex), prompt sending, model/effort updates, MCP passthrough
- `realtime_cmds.rs` - Real-time transcription sessions (`test_realtime_connection`, `start_realtime_session`, `send_realtime_audio`, `stop_realtime_session`)
- `llm_cmds.rs` - LLM integration commands (session naming, interaction analysis, transcription cleanup, model/repo recommendations)
- `mcp_cmds.rs` - MCP server commands (connection testing, OAuth management)
- `input_cmds.rs` - System input simulation (clipboard-based text injection via enigo)
- `session_cmds.rs` - Session persistence commands
- `usage_cmds.rs` - Usage tracking commands
- `archive_cmds.rs` - Session archive index
- `launch_cmds.rs` - Launch profiles/commands
- `pile_cmds.rs` - Pile persistence: items, audio, captures (`save_capture`/`read_capture`/`delete_capture`/`list_captures`), screenshots
- `screenshot_cmds.rs` - Screen capture (`capture_screenshot`, xcap)
- `image_cmds.rs` - `fetch_remote_image`: backend fetch of remote images (bypasses webview CORS, e.g. pasted Google-Docs HTML)
- `docker_cmds.rs` - `run_docker_setup`: one-click Docker setup for local STT servers (embeds `docker/` build contexts into the binary, writes them + a setup script to the config dir, launches a terminal running docker build/run)
- `debug_recordings_cmds.rs` - Recordings log persistence
- `sequence_cmds.rs` - Sequence engine commands
- `notion_cmds.rs` - Notion card integration
- `no_mistakes_cmds.rs` - No Mistakes run commands
- `git_cmds.rs` - Git/worktree operations
- `log_cmds.rs` - In-memory app log

### Sidecar (Node.js/TypeScript)

Located in `src-tauri/sidecar/`:

- `src/index.ts` - Node.js process communicating with Rust via JSON lines over stdin/stdout
- **Two providers:** Claude (`@anthropic-ai/claude-agent-sdk`) and OpenAI Codex (`@openai/codex-sdk`); `inferProvider()` picks `"claude" | "openai"` per session
- **Codex execution modes:** `codex_mode: "Sdk" | "AppServer"` — the app-server mode is a full JSON-RPC client implementation (turn tracking, item events, usage emission)
- Handles session creation, query execution, tool calls, and streaming responses
- Supports multimodal prompts (text + images via base64 content blocks)
- **Effort levels** via `update_effort` (`low|medium|high|xhigh|max` or off); Claude passes through natively, OpenAI clamps per model (GPT-5.6 family caps at `xhigh`, older Codex models at `high`); effort is plumbed to Codex via `modelReasoningEffort` (SDK mode) / `effort` on `turn/start` (app-server mode)
- Live model switching via `update_model`
- Permission mode defaults to `acceptEdits`; the SDK's native `ExitPlanMode` is intercepted via `canUseTool` and surfaced to the user as a plan-approval dialog (approve / deny / approve-with-note)
- Session restoration with conversation history context injection
- Progressive usage tracking during streaming (input/output/cache tokens)
- Subagent lifecycle events via SDK hooks
- Query interruption via `iterator.interrupt()` for proper cleanup
- Codex-powered generation helpers (`generate_repo_description_with_codex`, `generate_launch_profile_with_codex`)
- Built via esbuild, bundles to single `dist/index.js`

## Terminal Modes

The app supports three terminal modes (configured in settings):

1. **Interactive** - Opens the agent CLI in interactive mode without a pre-specified prompt
2. **Prompt** - Spawns the CLI with the transcribed prompt (`claude -p "<prompt>"`)
3. **SDK** - Uses the provider SDK directly via the sidecar process (no CLI)

## Effort Levels

SDK sessions carry a per-session effort level (off, `low`, `medium`, `high`, `xhigh`, `max`) selected via `EffortToggle` or recommended by the LLM integration. Claude maps effort natively; OpenAI clamps to the model's supported ceiling (`xhigh` for the GPT-5.6 family, `high` for older Codex models).

## Key Data Flow

### PTY Mode (Interactive/Prompt)

1. User presses hotkey → `recording.startRecording()` captures audio via WebRTC
2. Stop recording → audio sent to backend via `transcribe_audio` command
3. Backend posts to Whisper API → returns transcription
4. User confirms → `create_terminal_session` spawns `claude` CLI in PTY
5. PTY output streamed via `terminal-output-${sessionId}` event → rendered in xterm.js

### SDK Mode

1. User presses hotkey → `recording.startRecording()` captures audio
2. (Optional) Realtime provider streams live transcription during recording
3. Stop recording → auto-sends if app not focused
4. (Optional) LLM cleans transcription, recommends model/effort level
5. (Optional) LLM recommends repository based on prompt content
6. `sdkSessions.createSession(...)` creates SDK session (provider, model, effort)
7. Sidecar process spawned if needed, session registered
8. `sdkSessions.sendPrompt(id, prompt, images?)` sends prompt to sidecar (supports multimodal)
9. Sidecar runs query with the provider SDK
10. Events emitted:
    - `sdk-text-${id}` - Text content from assistant
    - `sdk-tool-start-${id}` / `sdk-tool-result-${id}` - Tool call lifecycle
    - `sdk-progressive-usage-${id}` - Live token counts during streaming
    - `sdk-usage-${id}` - Final usage stats (tokens, cost, duration)
    - `sdk-subagent-start-${id}` / `sdk-subagent-stop-${id}` - Subagent lifecycle
    - `sdk-done-${id}` / `sdk-error-${id}` - Query completion
11. Frontend updates store → SdkView renders streaming responses, tool calls, and usage stats
12. Session state persisted → can be restored after app restart with conversation history
13. (On completion) LLM analyzes for session naming and interaction detection

## Windows Configuration

Defined in `tauri.conf.json`:

- `main` - Primary application window (1200x800, decorated)
- `overlay` - Floating recording indicator (transparent, always-on-top, initially hidden)

## Configuration

App config stored in system config directory (`open-whisperer/config.json`), versioned with a migration ladder (`config/migration.rs`):

- `terminal_mode` - Interactive | Prompt | Sdk (plus per-provider `SdkProvider`, auth methods, `CodexMode`)
- `theme` - Midnight | Slate | Snow | Sand
- `whisper` - Batch transcription provider, endpoint, model, language, Docker settings
- `vosk` - Real-time transcription config (legacy key name): `provider` (RealtimeProvider), `transcription_mode` (Whisper | Realtime | Both), per-provider endpoints, Docker settings
- `hotkeys` - Global shortcuts (toggle recording, send prompt, switch repo, transcribe to input, pile recording)
- `repos` - Repositories with paths, descriptions/keywords/vocabulary, icon/color, default models, MCP server and launch profile associations
- `audio` - Recording device, stop action (`record_and_send_action`: send/prepare/pile), screenshot capture, sound settings
- `voice_commands` / `open_mic` - Voice command and wake-word settings
- `overlay` / `system` - Overlay position/visibility; tray, autostart, single instance, dev mode, `update_check` (Off | Notify | Auto)
- `llm` - LLM integration settings (provider, model, API key, features, auto-model priority/effort)
- `mcp` - MCP server configuration (global servers list, OAuth)
- `queue` - Smart Queue settings (rate-limit queueing, stagger)
- `sequences` - Sequence engine settings (notification channels)
- `prompt_chips` / `pane_layout` / `sessions_view` - UI state

## App Updates

In-app updates via the Tauri v2 updater plugin (`tauri-plugin-updater` + `tauri-plugin-process`, registered in `lib.rs`; permissions in `capabilities/default.json`).

- **Endpoint:** static `latest.json` on the newest GitHub release (`https://github.com/iSirux/OpenWhisperer/releases/latest/download/latest.json`), generated automatically by `tauri-apps/tauri-action` in `.github/workflows/release.yml` (both matrix arches merge into one manifest). `bundle.createUpdaterArtifacts` is enabled in `tauri.conf.json`.
- **Signing:** updates are minisign-verified against the `pubkey` in `tauri.conf.json`. CI signs with the `TAURI_SIGNING_PRIVATE_KEY` repo secret (no password); the private key lives at `~/.tauri/openwhisperer.key` on the maintainer's machine. Losing it means existing installs can never update again.
- **Versioning:** the release workflow stamps the `workflow_dispatch` version input into `tauri.conf.json` before building — the updater compares against that version, so releases don't require a manual version bump in git.
- **Frontend:** `stores/updater.ts` (check/download/install state machine); startup check in `(main)/+layout.svelte` per `system.update_check` (Off | Notify | Auto, default Notify; skipped in dev builds); header pill in `AppHeader` when an update is available (links to Settings → About); manual check + install UI in `AboutTab`; mode selector in `SystemTab`.
- **Windows:** `installMode: "passive"` — the app exits while the installer runs, so post-install "restart" UI is only reachable on macOS/Linux.

## Key Technologies

**Frontend:** SvelteKit 2.9, Svelte 5, TypeScript 5.6, xterm.js 5.5, TailwindCSS 4.1, Vite 6, marked + highlight.js, @xyflow/svelte (sequence editor), paneforge (split panes)
**Backend:** Rust, Tauri v2, portable-pty, reqwest, tokio-tungstenite, parking_lot, serde, enigo, xcap
**Sidecar:** Node.js, TypeScript, @anthropic-ai/claude-agent-sdk, @openai/codex-sdk, esbuild

## SDK Session Features

- **Session Persistence:** SDK sessions are persisted and can be restored after app restart
- **Conversation History:** Restored sessions inject previous conversation as context for continuity
- **Multimodal Prompts:** Paste or drag-drop images (auto-compressed to 5MB limit)
- **Progressive Usage:** Live token counts update during streaming before final usage event
- **Effort Levels:** Per-session effort selection (off/low/medium/high/xhigh/max)
- **Plan Approval:** Native SDK plan mode surfaced as an approve/deny dialog (`PlanApprovalDialog`)
- **Subagent Tracking:** Visual indicators when the agent spawns subagents
- **Per-Session Models & Providers:** Each session tracks its own provider/model selection independently
- **Fork & Rerun:** Fork a session; re-run a prompt (`ForkButton`, `RerunDropdown`)
- **Rate-Limit Handling:** Rate-limited turns are kept on the session and re-sent by the Smart Queue when the window resets
- **Duration Tracking:** Timer-based work duration that survives session restore
- **Unread Markers:** Sessions marked as unread when completed while not viewing
- **AI Metadata:** LLM-generated session names, summaries, and categories

## Session Auto-Persistence System

The session persistence layer (`src/lib/stores/sessionPersistence.ts`) uses an **auto-persist by exclusion** pattern. This means:

- **All session fields are automatically persisted by default**
- **To add new persistable fields:** Just add them to the type definition - they'll be auto-persisted
- **To exclude non-persistable fields:** Add them to `NON_PERSISTABLE_FIELDS`
- **For fields needing transformation:** Add them to `FIELD_TRANSFORMERS`

## Smart Queue

A single global driver (`src/lib/stores/smartQueue.ts`, started in `(main)/+layout.svelte`) that dispatches deferred SDK work once a provider's usage window resets or a user-scheduled window boundary passes. Two waiting shapes, one driver:

- `status: 'queued'` — a never-launched session, dispatched via `launchPrepared`
- `rateLimited != null` — a live session with a pending turn to re-send, dispatched via `continueRateLimited` (mid-run rejection, deferred follow-ups, scheduled turns)

Exhaustion detection lives in `queueDetection.ts` (threshold ≥100% utilization of the 5h or 7d window, per provider — Claude and Codex both) which deliberately imports neither `sdkSessions` nor `smartQueue` to break the import cycle. Draining is FIFO per provider with configurable fuzzy stagger (`settings.queue`, Settings → Smart Queue). UI: `QueueIndicator` (header) and `RateLimitBanner` (session). Distinct from `createSessionQueue` in `sessionLaunch.ts`, which is just a sequential batch-launch stagger.

## Sequences

Node-based automation (`src-tauri/src/sequences/` engine + `sequence_cmds.rs`; frontend `stores/sequences.ts`, `stores/sequenceExecutions.ts`, `components/sequences/`, routes `/sequences` and `/sequences/editor`). Sequences are defined as YAML-importable graphs of nodes (AI, git, GitHub, control, action, trigger categories per `utils/sequenceConverter.ts`), edited on an `@xyflow/svelte` canvas, and executed by the backend with per-node status/log events, schedules/event triggers, and completion notifications (sound + system notification, channels configured in Settings → Sequences).

## Real-Time Transcription

Optional live transcription runs alongside Whisper. The old Vosk-only integration is now a **multi-provider realtime abstraction**:

- **Providers** (`RealtimeProvider`): **Moonshine** (default/recommended — Whisper-level accuracy), Vosk, VoiceStreamAI, Speaches, SherpaOnnx. Backend clients live in `src-tauri/src/realtime.rs` behind a common `RealtimeSession` trait.
- **Transcription mode** (`TranscriptionMode`): Whisper | Realtime | Both — which engine produces the *final* transcript (configured in Settings → Transcription).
- Config still lives under the legacy `vosk` key / `VoskConfig` struct for back-compat.
- **Docker:** `docker/` at the repo root holds CPU-only build contexts (moonshine shim on port 2702 speaking the Vosk WebSocket protocol, sherpa-onnx on 6006; real Vosk uses 2700, Speaches 2701). `run_docker_setup` embeds these at compile time and drives a one-click terminal build/run from settings.

### Data Flow

1. User starts recording → audio captured via MediaRecorder (WebM for Whisper)
2. Simultaneously, PCM audio streamed to the realtime provider's WebSocket
3. Partial results → displayed in overlay marquee
4. Recording stops → final transcript from Whisper, the realtime engine, or both (per transcription mode)
5. (Optional) LLM cleanup applied to the final transcript (dual-source when both exist)

## Voice Commands

The app supports voice-triggered actions for hands-free operation:

### Configuration (`voice_commands` in config)

- `enabled` - Whether voice commands are active
- `active_commands` - Phrases that trigger sending the prompt (e.g., "go go", "send it")
- `transcribe_commands` - Phrases that trigger transcribe-to-input (e.g., "paste it", "type it")
- `cancel_commands` - Phrases that cancel/discard the current recording (e.g., "cancel that", "never mind", "abort abort")

### Supported Commands

- **Send Prompt** - Say a trigger phrase after recording to automatically send
- **Transcribe to Input** - Say a transcribe phrase to paste the transcription into the current app
- **Cancel Recording** - Say a cancel phrase to discard the current recording

## Recording Pile

An inbox for voice recordings captured now and handled later. Three ways to pile a recording: the `pile_recording` hotkey while recording, a pile voice command ("pile it"), or setting the recording stop mode (`audio.record_and_send_action`) to `pile` — cyclable via the mode chip on the overlay (send → prepare → pile). Prepared/approval sessions can also be demoted to the pile ("To Pile" button).

- Items are persisted to `pile.json` in the config dir (opaque JSON, frontend owns the schema); audio is saved to `pile-audio/<id>.webm` so items can be replayed and re-transcribed (failed transcriptions still land in the pile as audio-only items)
- Each item is LLM-processed in the background: transcription cleanup, repo recommendation (with confidence), model/effort recommendation, and auto-title (reuses session naming)
- UI: Sessions | Pile tabs in the sidebar; pile items open in the main pane for editing (transcript, repo, model, effort, audio playback); multi-select in the list enables batch launch (Start / Prepare / Plan first / Discuss with worktree + Playwright toggles) through the shared session queue, either separately (one session per item) or together (one combined multi-task session linked to every item). "Plan first" is a per-launch prompt-prefix instruction (`pileActions.ts`), not a separate app mode.
- Sessions launched from an item are tagged (`pileItem`) and shown as linked sessions with live indicators; items stay in the pile until deleted
- **The pile is the durable transcription-failure sink for recordings not tied to a live conversation.** *Any* recording whose transcription fails, errors, returns empty, or hits an unavailable service is salvaged to the pile as a retriable `error` item (audio preserved) — for new-session, prepare, transcribe-to-input, voice-command, and setup-view recordings. This is centralized in `handlePileTranscriptReady` (`transcriptProcessor.ts`), which those stop paths call on failure; the `recording.ts` queue rejects `stopRecording(true)` on transcription error (fixed promise contract) so those paths actually run
- **In-session follow-up recordings stay with their session.** A follow-up recorded for a LIVE session (the record/append buttons in `SdkView`) whose transcription fails is NOT sent to the pile — it was meant for that conversation. It's kept on the session as `SdkSession.failedRecording` (audio stored durably via `save_pile_audio`, keyed by `audioId`; survives restart), surfaced as a Retry/Discard banner above the prompt input. Retry re-transcribes and either sends it to the session or appends it to the prompt (per `mode`); the audio is cleaned up on retry-success, discard, or session close
- **Capture-first durability:** every recording's audio is staged to disk (`recording-captures/<id>.webm`, via `save_capture`/`read_capture`/`delete_capture`/`list_captures` in `pile_cmds.rs`) the moment it stops, *before* transcription, and deleted once transcription settles. If the app crashes mid-transcription, `pile.load()` recovers leftover captures into audio-only `error` items on next launch
- **Retry:** per-item "Retry transcription" (`PileDetailView`) plus "Retry all failed (N)" (`PileList`, `pile.retryAllFailed()`) which sequentially re-transcribes every failed item that still has audio

## Recording Screenshots

Optional (`audio.capture_screenshot_on_record`, Settings → Audio → Recording): when a recording starts, the `capture_screenshot` Tauri command (xcap, monitor under the cursor) grabs the screen before the overlay appears. The screenshot is compressed via the shared image pipeline (`src/lib/utils/image.ts`) and rides on the pending session (`pendingTranscription.screenshots`, an array — combined "together" drafts from the pile carry one per item) through prepare/approval/repo-selection; `sdkSessions.sendPrompt` attaches them to the first prompt as images and appends `SCREENSHOT_PROMPT_NOTICE` (from `src/lib/utils/screenshot.ts`) at send time only — telling Claude the screenshot may be unrelated to the request, since the user may have been doing something off-topic while talking. Pile items store screenshots on disk (`pile-screenshots/<id>.img`) and attach them at launch. Thumbnails with remove buttons appear in the recording header (prepared/approval views) and the pile detail view; sent messages show the image with a "Screenshot" badge (`SdkImageContent.source === 'screenshot'`).

## Open Mic Mode

Passive voice listening that activates recording when wake commands are detected:

### Configuration (`open_mic` in config)

- `enabled` - Whether open mic mode is active
- `wake_commands` - Phrases that activate recording (e.g., "hey claude", "ok claude")
- `timeout` - Timeout after wake command detection

### Data Flow

1. Open mic continuously listens via the realtime provider (low resource usage)
2. Wake command detected → recording automatically starts
3. User speaks prompt → normal recording flow continues
4. Recording stops → transcription and prompt processing as usual

## Recordings Log

`stores/debugRecordings.ts` keeps a bounded rolling log (20 newest) of every recording: the audio plus each transcription stage (realtime, Whisper raw, LLM-cleaned). Always on. Playback and inspection in Settings → Recordings Log. Persistence via `debug_recordings_cmds.rs`; audio for evicted entries is deleted so storage stays bounded.

## LLM Integration (Gemini/OpenAI/Groq/Local)

The app includes an optional LLM integration layer that uses a secondary AI (Gemini by default) to enhance the user experience. This is configured in Settings → LLM.

### Supported Providers

- **Gemini** - Google's Gemini API with automatic model fallback (2.5 Flash Lite → 2.5 Flash → 2.0 Flash)
- **OpenAI** - OpenAI API (GPT-4, etc.)
- **Groq** - Groq's fast inference API
- **Local** - Any OpenAI-compatible local server (LM Studio, Ollama, etc.)
- **Custom** - Custom OpenAI-compatible endpoint

### Features (`llm.features` in config)

1. **Auto Session Naming** (`auto_name_sessions`) - Generates descriptive session names, summaries, and categories from the first user-assistant exchange
2. **Interaction Detection** (`detect_interaction_needed`) - Analyzes assistant messages to detect when human input is truly required (not just polite offers)
3. **Transcription Cleanup** (`clean_transcription`) - Fixes common voice transcription errors (homophones, technical terms, punctuation); uses repo vocabulary when available
4. **Model Recommendation** (`recommend_model`) - Analyzes prompts to recommend the most cost-effective model and effort level
5. **Auto Repository Selection** (`auto_select_repo`) - Recommends the best repository based on prompt content and repo descriptions/keywords

### Auto Model Selection

When enabled, the "Auto" option appears in the model selector. The LLM analyzes each prompt and selects a model (simple → cheap, complex → capable) and an effort level based on task complexity.

### Auto Repository Selection

Repositories can have LLM-generated descriptions (from CLAUDE.md or README.md) that help the system route prompts to the correct project. Features include:

- Automatic description generation when adding repos
- Confidence-based recommendations (low/medium/high)
- Optional user confirmation for low-confidence matches
- Optional Claude confirmation prompt when routing may be incorrect

### Data Flow

1. User records voice prompt → Whisper transcription
2. (Optional) Transcription cleanup via LLM
3. (Optional) Model/effort recommendation via LLM
4. (Optional) Repository recommendation via LLM
5. Prompt sent to the agent with selected model/repo/effort
6. (On completion) Session analysis for naming and interaction detection

## MCP Server Support

The app supports external MCP (Model Context Protocol) servers to extend the agent's capabilities with custom tools. MCP servers can be configured globally or associated with specific repositories.

### Configuration (`mcp` in config)

- `servers` - List of MCP server configurations

### Server Types

- **Stdio** - Local command-line tools (most common). Specify `command` and optional `args`/`env`
- **HTTP** - Remote HTTP-based MCP servers. Specify `url`
- **SSE** - Server-Sent Events for real-time communication. Specify `url`

### Per-Server Configuration

Each MCP server has:

- `id` - Unique identifier
- `name` - Display name
- `server_type` - 'stdio', 'http', or 'sse'
- `command` - Command to run (stdio only)
- `args` - Command arguments (stdio only)
- `env` - Environment variables
- `url` - Server URL (HTTP/SSE only)
- `enabled` - Whether the server is active
- Optional OAuth config (`McpAuthType`, `McpOAuthConfig`)

### Repository Association

Repositories can have specific MCP servers assigned via `mcp_servers` in `RepoConfig`. If a repo has servers configured, only those servers are used for sessions in that repo. Otherwise, all enabled global servers are used.

### Server Lifecycle

- Servers are started on-demand when sessions need them
- Configuration is passed to the sidecar during session creation
- The Claude Agent SDK manages server connections

### Settings UI

- **Settings → MCP** - Add, edit, remove, and test MCP servers
- Repo association via repository management (repository rail/view)

## No Mistakes Integration

Per-session integration of [no-mistakes](https://github.com/kunchenguid/no-mistakes), a git-push validation proxy: its pipeline (review → test → docs → lint → push → PR → CI) runs in an isolated worktree and only pushes/opens a PR when everything is green. The app drives its headless `axi` interface directly from Rust — no agent skill, no Claude orchestration.

- **Backend** (`src-tauri/src/no_mistakes.rs`, `commands/no_mistakes_cmds.rs`): `NoMistakesManager` spawns `no-mistakes axi run --intent <intent>` in the session's cwd, streams child output (`nm-log-${runId}`), polls `axi status` every 2.5s (`nm-status-${runId}` with parsed steps), and on child exit emits either a decision gate (`nm-gate-${runId}` with findings: id/severity/file/action/description) or completion (`nm-done-${runId}` with outcome). Gates are resolved via `nm_respond` (`axi respond --action approve|fix|skip [--findings ids]`), driven like a fresh run. TOON output is parsed heuristically (tolerant extractors + unit tests); every event carries the raw text as fallback. Commands: `nm_check`, `nm_start_run`, `nm_respond`, `nm_cancel`.
- **Frontend**: `src/lib/stores/noMistakes.ts` (run store keyed by runId, one visible run per session), `src/lib/utils/noMistakesIntent.ts` (composes `--intent` from the session's AI metadata + user messages, capped ~1500 chars), `src/lib/components/sdk/NoMistakesPanel.svelte` (7-step stepper, gate findings table with Approve / Fix selected / Skip, outcome banner, collapsible log). The "No mistakes" button lives in `SdkSessionHeader.svelte` (enabled when the session is idle with a real cwd); the panel renders in `SdkView.svelte` pinned above the prompt input until dismissed.
- **Assumptions**: the `no-mistakes` binary is on PATH and the repo has been initialized with `no-mistakes init` (no init automation yet). Runs are not persisted across app restart.

## Cockpit (Experimental)

`src/lib/cockpit/` contains an experimental voice-driven fleet-control system (command grammar, intent executor, cockpit mic/store). It is under active exploration and its design is not settled. **Do not mention, suggest, extend, or wire new features into the cockpit unless the user brings it up first.**

### Providers

Read these for info on the interface:

- Claude Agent SDK: "docs\Claude Agent SDK reference - TypeScript.md"
- Codex App Server: "docs\Codex App Server.md"
