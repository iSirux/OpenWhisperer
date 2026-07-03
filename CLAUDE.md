# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Whisperer is a Tauri v2 desktop application that provides a voice-controlled interface for Claude Code. Users can record voice prompts via hotkeys, which are transcribed using a Whisper API endpoint, then sent to Claude Code either through embedded terminal sessions (PTY mode) or directly via the Claude Agent SDK (SDK mode). The app supports multimodal prompts (text + images), session persistence, usage tracking, thinking levels, voice commands, real-time transcription via Vosk, and LLM-powered intelligent features via Gemini or other providers.

> **Log files:** `%APPDATA%\claude-whisperer\logs\` (Windows) / `~/Library/Application Support/claude-whisperer/logs/` (macOS) — named `backend[-dev]-YYYY-MM-DD.log` and `frontend[-dev]-YYYY-MM-DD.log`.

## Development Commands

```bash
# Full development - builds sidecar then runs Tauri dev
npm run tauri:dev

# Build production app (includes sidecar)
npm run tauri:build

# Type checking
npm run check 2>&1 | grep -A 5 "Error:"

# Frontend only (without Tauri)
npm run dev

# Sidecar only
npm run sidecar:install  # Install sidecar dependencies
npm run sidecar:build    # Build the TypeScript sidecar
```

## Architecture

### Frontend (SvelteKit + Svelte 5)

**Routes:**

- `src/routes/+page.svelte` - Main application view with session list, terminal/SDK view, and transcript. Uses composables for recording flow, hotkey management, event handling, and open mic lifecycle.
- `src/routes/+layout.svelte` - Global layout wrapper for theming and app initialization
- `src/routes/overlay/+page.svelte` - Floating overlay window for recording status and Vosk real-time transcription
- `src/routes/settings/+page.svelte` - Settings modal with tabs (General, System, Themes, Audio, Whisper, Vosk, Git, Hotkeys, Overlay, Repositories, LLM)
- `src/routes/usage/+page.svelte` - Usage statistics dashboard with session/token/cost analytics
- `src/routes/sessions-view/+page.svelte` - Unified sessions grid/list view for browsing all sessions with filtering and layout options

**Stores (`src/lib/stores/`):**

- `settings.ts` - App configuration (terminal mode, whisper endpoint, hotkeys, repos, theme, voice commands, open mic)
- `sessions.ts` - PTY terminal session management and Tauri event listeners
- `sdkSessions.ts` - Claude SDK session management with message streaming, session persistence, progressive usage tracking, thinking levels, and image support
- `recording.ts` - Audio recording state machine using MediaRecorder API
- `overlay.ts` - Floating overlay window visibility and positioning
- `usageStats.ts` - Persistent usage statistics tracking (sessions, tokens, costs, tools, repos, daily stats, streaks)
- `openMic.ts` - Passive voice listening for wake command detection
- `sessionPersistence.ts` - Session persistence layer for disk storage and restoration
- `pile.ts` - Recording pile: inbox of transcribed recordings saved for later (own persistence file, saved audio, background LLM processing for cleanup/repo/model/title)

**Components (`src/lib/components/`):**

Core UI:

- `AppHeader.svelte` - Application header with global controls
- `SessionList.svelte` - Unified list of PTY and SDK sessions with status indicators and unread markers
- `PileList.svelte` - Pile tab in the sidebar: pile item cards with multi-select and batch launch actions
- `PileDetailView.svelte` - Main-pane editor for a pile item (transcript, repo/model, audio playback, re-transcribe, launch)
- `SessionCard.svelte` - Card component for sessions-view grid display
- `SessionHeader.svelte` - Active session metadata display (PTY sessions)
- `SdkSessionHeader.svelte` - Active session metadata display for SDK sessions
- `SessionSidebarHeader.svelte` - Sidebar header with session controls
- `EmptySessionPlaceholder.svelte` - Placeholder for empty session state
- `SessionPendingView.svelte` - View for sessions in pending states (repo selection, transcription)
- `Terminal.svelte` - xterm.js terminal with WebGL rendering for PTY sessions
- `ModelSelector.svelte` - Button group for selecting Claude model (Opus/Sonnet/Haiku/Auto)
- `ThinkingToggle.svelte` - Toggle button for enabling/disabling thinking mode
- `RepoSelector.svelte` - Repository selection dropdown
- `RepoSelectionDialog.svelte` - Modal dialog for repository selection with LLM recommendations
- `Transcript.svelte` - Last recording transcript display
- `TranscriptMarquee.svelte` - Rolling real-time transcript display for Vosk
- `TranscriptDiff.svelte` - Transcript comparison view (original vs cleaned)
- `Waveform.svelte` - Audio waveform visualization
- `StatusBadge.svelte` - Status indicator badge
- `Overlay.svelte` - Overlay window content
- `HotkeyInput.svelte` - Hotkey configuration input
- `Start.svelte` - Welcome screen with microphone selection and Whisper connection status
- `UsagePreview.svelte` - Compact usage stats preview for main view

**SDK Components (`src/lib/components/sdk/`):**

- `SdkMessage.svelte` - Renders individual SDK messages (user prompts, text responses, tool calls, errors, subagent events)
- `SdkLoadingIndicator.svelte` - Animated loading indicator with status text
- `SdkPromptInput.svelte` - Multi-line textarea with image paste/drop support, recording button, and auto-resize
- `SdkUsageBar.svelte` - Token usage display with input/output/cache stats, cost, and context usage bar
- `SessionRecordingHeader.svelte` - Completed recording display header with visualizations

**Settings Components (`src/lib/components/settings/`):**

- `GeneralTab.svelte` - General settings (terminal mode, language)
- `SystemTab.svelte` - System settings (tray behavior, autostart, single instance)
- `ThemesTab.svelte` - Theme selection interface (Midnight, Slate, Snow, Sand)
- `AudioTab.svelte` - Audio settings with microphone selection, voice commands, and open mic configuration
- `WhisperTab.svelte` - Whisper provider selection (Local/OpenAI/Groq/Custom) with Docker configuration
- `VoskTab.svelte` - Vosk real-time transcription settings with Docker support
- `HotkeysTab.svelte` - Global hotkey configuration
- `GitTab.svelte` - Git branch/worktree creation settings
- `OverlayTab.svelte` - Overlay window settings (position, visibility, transparency)
- `ReposTab.svelte` - Repository management with LLM-generated descriptions and MCP server associations
- `LlmTab.svelte` - LLM integration settings with provider selection and feature toggles
- `McpTab.svelte` - MCP server configuration (add/edit/remove/test servers)

**Composables (`src/lib/composables/`) - Svelte 5 Runes:**

- `useHotkeyManager.svelte.ts` - Global hotkey registration (toggle recording, transcribe-to-input, cycle repo/model with auto-repo support)
- `useRecordingFlow.svelte.ts` - Recording lifecycle management (start/stop, pending sessions, audio visualization, overlay integration)
- `useOpenMic.svelte.ts` - Open mic lifecycle with automatic restart after recording stops
- `useSessionEventHandlers.svelte.ts` - Centralized window and Tauri event listener setup/cleanup
- `useSidebarResize.svelte.ts` - Sidebar resize drag handle logic with persistence
- `useTranscriptionProcessor.svelte.ts` - Transcription processing with LLM cleanup, model/repo recommendations, and system prompt building
- `useDisplaySessions.svelte.ts` - Session filtering and sorting for display

**Utilities (`src/lib/utils/`):**

- `markdown.ts` - Markdown processing with syntax highlighting (marked + highlight.js)
- `image.ts` - Image compression and processing for Claude API (5MB limit, auto-resize, format conversion)
- `sound.ts` - Completion sound playback
- `modelColors.ts` - Model-specific color utilities (Opus=purple, Sonnet=amber, Haiku=emerald)
- `models.ts` - Model definitions, thinking levels, and Auto model selection support
- `llm.ts` - LLM integration utilities for session analysis, transcription cleanup, model/repo recommendations
- `voiceCommands.ts` - Voice command detection and processing for sending prompts via voice
- `sessionLaunch.ts` - Shared session launch machinery: `launchSession` (setup session + optional worktree + tagging) and `createSessionQueue` (staggered batch launches; used by NotionKanban and the pile)
- `pileActions.ts` - Turning pile items into sessions (start / prepare / plan-first / discuss)

### Backend (Rust/Tauri)

**Core Modules (`src-tauri/src/`):**

- `lib.rs` - Tauri app initialization, plugin registration, state management
- `config.rs` - Configuration types and persistence:
  - `TerminalMode` enum (Interactive, Prompt, Sdk)
  - `Theme` enum (Midnight, Slate, Snow, Sand)
  - `WhisperProvider` enum (Local, OpenAI, Groq, Custom)
  - `DockerComputeType` enum (CPU, GPU)
  - Nested configs: WhisperConfig, VoskConfig, GitConfig, HotkeyConfig, OverlayConfig, VoiceCommandConfig, OpenMicConfig, AudioConfig, LlmConfig
- `terminal.rs` - PTY management via `portable-pty`, spawns `claude` CLI
- `sidecar.rs` - SidecarManager for Node.js process IPC with Claude Agent SDK
- `whisper.rs` - HTTP client for Whisper transcription API
- `vosk.rs` - WebSocket client for Vosk real-time transcription with streaming
- `git.rs` - GitManager for repository operations (branch/worktree creation)
- `session_persistence.rs` - Session persistence layer for disk storage

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
- `sdk_cmds.rs` - SDK session management, prompt sending, model updates, MCP server passthrough
- `llm_cmds.rs` - LLM integration commands (session naming, interaction analysis, transcription cleanup, model/repo recommendations)
- `vosk_cmds.rs` - Vosk integration commands (connection test, session start/stop, audio streaming)
- `mcp_cmds.rs` - MCP server commands (connection testing for HTTP/SSE servers)
- `input_cmds.rs` - System input simulation (clipboard-based text injection)
- `session_cmds.rs` - Session persistence commands (get/save/clear persisted sessions)
- `usage_cmds.rs` - Usage tracking commands (track sessions, prompts, tools, recordings, tokens)

### Sidecar (Node.js/TypeScript)

Located in `src-tauri/sidecar/`:

- `src/index.ts` - Node.js process using `@anthropic-ai/claude-agent-sdk`
- Communicates with Rust via JSON lines over stdin/stdout
- Handles session creation, query execution, tool calls, and streaming responses
- Supports multimodal prompts (text + images via base64 content blocks)
- Supports thinking levels (think, megathink, ultrathink)
- Session restoration with conversation history context injection
- Progressive usage tracking during streaming (input/output/cache tokens)
- Subagent lifecycle events via SDK hooks (SubagentStart/SubagentStop)
- Query interruption via `iterator.interrupt()` for proper cleanup
- Built via esbuild, bundles to single `dist/index.js`

## Terminal Modes

The app supports three terminal modes (configured in settings):

1. **Interactive** - Opens Claude CLI in interactive mode without a pre-specified prompt
2. **Prompt** - Spawns Claude CLI with the transcribed prompt (`claude -p "<prompt>"`)
3. **SDK** - Uses Claude Agent SDK directly via the sidecar process (no CLI)

## Thinking Mode

SDK mode supports Claude's extended thinking capability as a simple on/off toggle:

- **Off** (null) - Standard response without extended thinking
- **On** - Extended thinking enabled (31999 token budget)

Thinking can be toggled per-session via the ThinkingToggle or automatically recommended by the LLM integration based on prompt complexity.

## Key Data Flow

### PTY Mode (Interactive/Prompt)

1. User presses hotkey → `recording.startRecording()` captures audio via WebRTC
2. Stop recording → audio sent to backend via `transcribe_audio` command
3. Backend posts to Whisper API → returns transcription
4. User confirms → `create_terminal_session` spawns `claude` CLI in PTY
5. PTY output streamed via `terminal-output-${sessionId}` event → rendered in xterm.js

### SDK Mode

1. User presses hotkey → `recording.startRecording()` captures audio
2. (Optional) Vosk streams real-time transcription during recording
3. Stop recording → auto-sends if app not focused
4. (Optional) LLM cleans transcription, recommends model/thinking level
5. (Optional) LLM recommends repository based on prompt content
6. `sdkSessions.createSession(cwd, model, thinkingLevel)` creates SDK session
7. Sidecar process spawned if needed, session registered
8. `sdkSessions.sendPrompt(id, prompt, images?)` sends prompt to sidecar (supports multimodal)
9. Sidecar runs query with Claude Agent SDK
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
- `overlay` - Floating recording indicator (380x140, transparent, always-on-top, initially hidden)

## Configuration

App config stored in system config directory (`claude-whisperer/config.json`):

- `terminal_mode` - Interactive | Prompt | Sdk
- `theme` - Midnight | Slate | Snow | Sand
- `whisper` - Transcription provider, endpoint, model, language, Docker settings
- `vosk` - Real-time transcription endpoint, sample rate, Docker settings, transcript accumulation
- `hotkeys` - Global shortcuts (toggle recording, send prompt, switch repo, transcribe to input)
- `repos` - List of git repositories with paths, optional default models, LLM-generated descriptions, and MCP server associations
- `audio` - Recording device, hotkey toggle, sound settings
- `voice_commands` - Voice command settings (enabled, trigger phrases, confirmation phrases)
- `open_mic` - Passive listening settings (enabled, wake commands, timeout)
- `git` - Branch/worktree creation settings
- `overlay` - Position, visibility, transparency settings
- `system` - Tray behavior, autostart, single instance settings
- `llm` - LLM integration settings (provider, model, API key, features, auto-model priority)
- `mcp` - MCP server configuration (global servers list)

## Key Technologies

**Frontend:** SvelteKit 2.9, Svelte 5, TypeScript 5.6, xterm.js 5.5, TailwindCSS 4.1, Vite 6, marked + highlight.js
**Backend:** Rust, Tauri v2, portable-pty, reqwest, tokio-tungstenite, parking_lot, serde, enigo
**Sidecar:** Node.js, TypeScript, @anthropic-ai/claude-agent-sdk, esbuild

## SDK Session Features

- **Session Persistence:** SDK sessions are persisted and can be restored after app restart
- **Conversation History:** Restored sessions inject previous conversation as context for continuity
- **Multimodal Prompts:** Paste or drag-drop images (auto-compressed to 5MB limit for Claude API)
- **Progressive Usage:** Live token counts update during streaming before final usage event
- **Thinking Levels:** Per-session thinking level selection (Off/Think/Mega/Ultra)
- **Subagent Tracking:** Visual indicators when Claude spawns subagents (Task tool)
- **Per-Session Models:** Each session tracks its own model selection independently
- **Duration Tracking:** Timer-based work duration that survives session restore
- **Unread Markers:** Sessions marked as unread when completed while not viewing
- **AI Metadata:** LLM-generated session names, summaries, and categories

## Session Auto-Persistence System

The session persistence layer (`src/lib/stores/sessionPersistence.ts`) uses an **auto-persist by exclusion** pattern. This means:

- **All session fields are automatically persisted by default**
- **To add new persistable fields:** Just add them to the type definition - they'll be auto-persisted
- **To exclude non-persistable fields:** Add them to `NON_PERSISTABLE_FIELDS`
- **For fields needing transformation:** Add them to `FIELD_TRANSFORMERS`

## Vosk Real-Time Transcription

The app supports optional real-time transcription using Vosk, which runs alongside Whisper:

- **Vosk** provides instant feedback as you speak (shown as a rolling marquee in the overlay)
- **Whisper** provides the final accurate transcription after recording stops
- Both can be combined with the LLM cleanup layer for optimal accuracy

### Configuration (`vosk` in config)

- `enabled` - Whether Vosk real-time transcription is active
- `endpoint` - WebSocket endpoint (default: `ws://localhost:2700`)
- `sample_rate` - Audio sample rate (default: 16000)
- `show_realtime_transcript` - Show live transcript in overlay
- `accumulate_final_transcripts` - Accumulate final transcripts across utterances
- `docker` - Container settings for local Vosk server

### Data Flow

1. User starts recording → audio captured via MediaRecorder (WebM for Whisper)
2. Simultaneously, PCM audio streamed via ScriptProcessorNode to Vosk WebSocket
3. Vosk returns partial results → displayed in overlay marquee
4. Recording stops → complete audio sent to Whisper for final transcription
5. (Optional) LLM cleanup applied to final transcript

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
- **Cancel Recording** - Say a cancel phrase to discard the current recording (e.g., "cancel that", "never mind", "scratch that", "abort abort")

## Recording Pile

An inbox for voice recordings captured now and handled later. Three ways to pile a recording: the `pile_recording` hotkey while recording, a pile voice command ("pile it"), or setting the recording stop mode (`audio.record_and_send_action`) to `pile` — cyclable via the mode chip on the overlay (send → prepare → pile). Prepared/approval sessions can also be demoted to the pile ("To Pile" button).

- Items are persisted to `pile.json` in the config dir (opaque JSON, frontend owns the schema); audio is saved to `pile-audio/<id>.webm` so items can be replayed and re-transcribed (failed transcriptions still land in the pile as audio-only items)
- Each item is LLM-processed in the background: transcription cleanup, repo recommendation (with confidence), model/effort recommendation, and auto-title (reuses session naming)
- UI: Sessions | Pile tabs in the sidebar; pile items open in the main pane for editing (transcript, repo, model, effort, audio playback); multi-select in the list enables batch launch (Start / Prepare / Plan first / Discuss with worktree + Playwright toggles) through the shared session queue
- Sessions launched from an item are tagged (`pileItem`) and shown as linked sessions with live indicators; items stay in the pile until deleted

## Recording Screenshots

Optional (`audio.capture_screenshot_on_record`, Settings → Audio → Recording): when a recording starts, the `capture_screenshot` Tauri command (xcap, monitor under the cursor) grabs the screen before the overlay appears. The screenshot is compressed via the shared image pipeline (`src/lib/utils/image.ts`) and rides on the pending session (`pendingTranscription.screenshot`) through prepare/approval/repo-selection; `sdkSessions.sendPrompt` attaches it to the first prompt as an image and appends `SCREENSHOT_PROMPT_NOTICE` (from `src/lib/utils/screenshot.ts`) at send time only — telling Claude the screenshot may be unrelated to the request, since the user may have been doing something off-topic while talking. Pile items store screenshots on disk (`pile-screenshots/<id>.img`) and attach them at launch. Thumbnails with remove buttons appear in the recording header (prepared/approval views) and the pile detail view; sent messages show the image with a "Screenshot" badge (`SdkImageContent.source === 'screenshot'`).

## Open Mic Mode

Passive voice listening that activates recording when wake commands are detected:

### Configuration (`open_mic` in config)

- `enabled` - Whether open mic mode is active
- `wake_commands` - Phrases that activate recording (e.g., "hey claude", "ok claude")
- `timeout` - Timeout after wake command detection

### Data Flow

1. Open mic continuously listens via Vosk (low resource usage)
2. Wake command detected → recording automatically starts
3. User speaks prompt → normal recording flow continues
4. Recording stops → transcription and prompt processing as usual

## LLM Integration (Gemini/OpenAI/Groq/Local)

The app includes an optional LLM integration layer that uses a secondary AI (Gemini by default) to enhance the user experience. This is configured in Settings → LLM Integration.

### Supported Providers

- **Gemini** - Google's Gemini API with automatic model fallback (2.5 Flash Lite → 2.5 Flash → 2.0 Flash)
- **OpenAI** - OpenAI API (GPT-4, etc.)
- **Groq** - Groq's fast inference API
- **Local** - Any OpenAI-compatible local server (LM Studio, Ollama, etc.)
- **Custom** - Custom OpenAI-compatible endpoint

### Features (`llm.features` in config)

1. **Auto Session Naming** (`auto_name_sessions`) - Generates descriptive session names, summaries, and categories from the first user-assistant exchange
2. **Interaction Detection** (`detect_interaction_needed`) - Analyzes assistant messages to detect when human input is truly required (not just polite offers)
3. **Transcription Cleanup** (`clean_transcription`) - Fixes common voice transcription errors (homophones, technical terms, punctuation)
4. **Model Recommendation** (`recommend_model`) - Analyzes prompts to recommend the most cost-effective Claude model (Haiku/Sonnet/Opus) and thinking level
5. **Auto Repository Selection** (`auto_select_repo`) - Recommends the best repository based on prompt content and repo descriptions

### Auto Model Selection

When enabled, the "Auto" option appears in the model selector. The LLM analyzes each prompt and selects:

- **Model**: Haiku (simple tasks), Sonnet (typical tasks), Opus (complex tasks)
- **Thinking Level**: null, think, megathink, or ultrathink based on task complexity

### Auto Repository Selection

Repositories can have LLM-generated descriptions (from CLAUDE.md or README.md) that help the system route prompts to the correct project. Features include:

- Automatic description generation when adding repos
- Confidence-based recommendations (low/medium/high)
- Optional user confirmation for low-confidence matches
- Optional Claude confirmation prompt when routing may be incorrect

### Data Flow

1. User records voice prompt → Whisper transcription
2. (Optional) Transcription cleanup via LLM
3. (Optional) Model/thinking level recommendation via LLM
4. (Optional) Repository recommendation via LLM
5. Prompt sent to Claude with selected model/repo/thinking level
6. (On completion) Session analysis for naming and interaction detection

## MCP Server Support

The app supports external MCP (Model Context Protocol) servers to extend Claude's capabilities with custom tools. MCP servers can be configured globally or associated with specific repositories.

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

### Repository Association

Repositories can have specific MCP servers assigned via `mcp_servers` in `RepoConfig`. If a repo has servers configured, only those servers are used for sessions in that repo. Otherwise, all enabled global servers are used.

### Server Lifecycle

- Servers are started on-demand when sessions need them
- Configuration is passed to the sidecar during session creation
- The Claude Agent SDK manages server connections

### Settings UI

- **Settings → MCP Servers** - Add, edit, remove, and test MCP servers
- **Settings → Repositories** - Associate servers with specific repos

### Providers

Read these for info on the interface:

- Claude Agent SDK: "docs\Claude Agent SDK reference - TypeScript.md"
- Codex App Server: "docs\Codex App Server.md"
