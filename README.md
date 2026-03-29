# ClaudeWhisperer

A desktop tool for voice-controlled Claude Code and Codex interactions. Speak your prompts, and ClaudeWhisperer transcribes, interprets, and spawns coding-agent sessions with a desktop UI on top.

## Features

- **Voice-to-Code** — Speak naturally, get code. Local Whisper transcription with optional Haiku interpretation for cleaner prompts.
- **Multi-Provider Coding Agents** — Run Claude or OpenAI Codex sessions, including current GPT-5.4 and GPT-5.4 Mini model options.
- **Task/Subagent Visibility** — Claude and Codex task delegation is surfaced in the session UI as grouped task blocks instead of a flat stream of child tool calls.
- **Multi-Terminal Management** — Spawn and manage multiple coding-agent sessions with a tabbed interface.
- **Recording Overlay** — Minimal, always-on-top overlay shows transcription status, active repo, and git settings.
- **Git Workflow Integration** — Auto-create branches, auto-merge, or work directly on main. Handles merge conflicts automatically.
- **Flexible Input Modes** — Open mic, push-to-talk hotkeys, or voice commands ("go go") to send prompts.
- **Note-Taking Mode** — Switch between coding and transcription-to-file for meeting notes or documentation.
- **Fully Configurable** — Hotkeys, endpoints, models, repos, overlays—everything is customizable.

## Tech Stack

| Layer                 | Technology                               |
| --------------------- | ---------------------------------------- |
| Desktop Framework     | Tauri 2.0 (Rust backend, native WebView) |
| Frontend              | Svelte 5 + TypeScript, Tailwind CSS      |
| Terminal              | xterm.js                                 |
| Audio                 | Web Audio API                            |
| Speech-to-Text        | Local Whisper (Docker)                   |
| Prompt Interpretation | Anthropic API (Haiku) — optional         |

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (recommended) or npm
- [Docker](https://www.docker.com/) (for Whisper)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- **Windows only**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload

### Whisper Setup

Run a local Whisper instance via Docker:

```bash
docker run -d --gpus all -p 8000:8000 -v ~/.cache/huggingface:/root/.cache/huggingface fedirz/faster-whisper-server:latest-cuda
```

## Installation

```bash
# Clone the repository
git clone https://github.com/iSirux/ClaudeWhisperer.git
cd ClaudeWhisperer

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

## Usage

### Quick Start

1. Launch ClaudeWhisperer
2. Select your target repository from the dropdown
3. Press the record hotkey (default: `Cmd+Shift+V` / `Ctrl+Shift+V`) or enable open mic
4. Speak your prompt
5. Say "go go" or press the send hotkey to dispatch
6. Watch Claude Code work in the spawned terminal

### Keyboard Shortcuts

| Action           | Default Shortcut       |
| ---------------- | ---------------------- |
| Toggle Recording | `Cmd/Ctrl + Shift + V` |
| Send Prompt      | `Cmd/Ctrl + Enter`     |
| Toggle Open Mic  | `Cmd/Ctrl + Shift + M` |
| Switch Repo      | `Cmd/Ctrl + Shift + R` |
| New Terminal     | `Cmd/Ctrl + T`         |
| Close Terminal   | `Cmd/Ctrl + W`         |

_All shortcuts are configurable in Settings._

### Voice Commands

- **"go go"** — Send the current transcription as a prompt (configurable)
- **"cancel"** — Discard current recording
- **"switch to notes"** — Toggle note-taking mode

## Configuration

Access settings via the gear icon or `Cmd/Ctrl + ,`.

### General

- **Default Model** — Claude model for code generation
- **Whisper Endpoint** — URL for your Whisper instance (with connection test)
- **Haiku Interpretation** — Enable/disable prompt cleanup via Haiku

### Audio

- **Microphone Selection** — Choose input device
- **Open Mic Mode** — Continuous listening vs. push-to-talk
- **Voice Command Trigger** — Customize the "send" phrase

### Git Workflow

- **Branch Strategy** — Work on main, auto-create branches, or prompt each time
- **Auto-merge** — Automatically merge completed branches to main
- **Create PR** — Open pull request instead of direct merge
- **Use Worktrees** — Isolate branches with git worktrees

### Overlay

- **Position** — Top-center (default), or choose corner
- **Show Transcript** — Display live transcription in overlay
- **Transcript Length** — How much text to show

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClaudeWhisperer                              │
├──────────────────────┬──────────────────────────────────────────┤
│      Frontend        │              Rust Backend                 │
│  ┌────────────────┐  │  ┌─────────────┐    ┌─────────────────┐  │
│  │   Svelte UI    │  │  │   Whisper   │───▶│  Local Docker   │  │
│  │  + xterm.js    │◀─┼─▶│   Client    │    │    Whisper      │  │
│  └────────────────┘  │  ├─────────────┤    └─────────────────┘  │
│         │            │  │    Haiku    │───▶ Anthropic API       │
│         │            │  │ Interpreter │     (optional)          │
│         ▼            │  ├─────────────┤                         │
│  ┌────────────────┐  │  │ Terminal    │                         │
│  │  Web Audio API │──┼─▶│  Manager    │───▶ claude CLI (PTY)    │
│  │   (mic input)  │  │  │(portable-pty)                         │
│  └────────────────┘  │  ├─────────────┤                         │
│                      │  │ Git Manager │───▶ git worktrees       │
│                      │  └─────────────┘                         │
└──────────────────────┴──────────────────────────────────────────┘
```

## Development

```bash
# Run with hot reload
pnpm tauri dev

# Type checking
pnpm check

# Lint
pnpm lint

# Format
pnpm format
```

### Project Structure

```
ClaudeWhisperer/
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── main.rs      # Entry point
│   │   ├── terminal.rs  # PTY management
│   │   ├── whisper.rs   # Whisper client
│   │   ├── haiku.rs     # Prompt interpretation
│   │   ├── git.rs       # Git operations
│   │   └── config.rs    # Settings
│   └── Cargo.toml
├── src/                 # Svelte frontend
│   ├── lib/
│   │   ├── components/  # UI components
│   │   ├── stores/      # State management
│   │   └── services/    # IPC wrappers
│   └── pages/           # Main views
└── package.json
```

## License

[MIT + Commons Clause](LICENSE) — source-available: free to use, modify, and share, but you cannot sell software or services derived substantially from it.

```

---

## Structure Summary
```

LICENSE
├── Part 1: MIT License text (base terms)
│
└── Part 2: Commons Clause (addendum that restricts selling)
└── Specifies: Licensor, Software name, and the non-selling condition

```

---
```
