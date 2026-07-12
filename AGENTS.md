# Repository Guidelines

## Project Structure & Module Organization

OpenWhisperer is a Tauri desktop app with three main code areas:

- `src/`: SvelteKit + TypeScript frontend (routes, components, stores, composables, utilities).
- `src-tauri/src/`: Rust backend (Tauri commands, PTY/session management, Whisper/real-time/LLM integrations, sequences).
- `src-tauri/sidecar/`: Node/TypeScript sidecar process for Claude Agent SDK.

Supporting folders:

- `static/` for frontend static assets.
- `docs/` for design and architecture notes.
- `.github/workflows/` for release automation (`release.yml`).

> **Log files:** `%APPDATA%\open-whisperer\logs\` (Windows) / `~/Library/Application Support/open-whisperer/logs/` (macOS) — named `backend[-dev]-YYYY-MM-DD.log` and `frontend[-dev]-YYYY-MM-DD.log`.

## Build, Test, and Development Commands

- `pnpm install`: install frontend dependencies.
- `pnpm dev`: frontend-only Vite dev server.
- `pnpm check | grep -A 5 "Error:""`: Svelte type checking (`svelte-check`).
- `pnpm tauri dev`: builds sidecar, then launches full desktop app in dev mode.
- `pnpm tauri build`: builds sidecar and packages production Tauri app.
- `pnpm sidecar:install`: installs sidecar dependencies.
- `pnpm sidecar:build`: compiles sidecar TypeScript bundle.

Examples:

- Frontend iteration: `pnpm dev`
- End-to-end app work: `pnpm tauri dev`

## Coding Style & Naming Conventions

- TypeScript/Svelte: 2-space indentation, single quotes in `.svelte` files, `PascalCase` for components (e.g., `SessionList.svelte`), `camelCase` for functions/variables, and `kebab-case` route folders.
- Rust: standard `rustfmt` style (4-space indentation), `snake_case` modules/files (e.g., `session_persistence.rs`), `CamelCase` types.
- Keep files focused by domain (`commands/`, `stores/`, `components/settings/`, `sequences/`).

## Testing Guidelines

There is no dedicated automated test suite yet. Before opening a PR:

- Run `pnpm check` (required).
- For Rust-heavy changes, run `cargo test` in `src-tauri` when adding logic suitable for unit tests.

Use clear test file names when adding tests (for example `feature_name.test.ts` or Rust `mod tests` blocks).

## Commit & Pull Request Guidelines

Recent history is mixed (`feat: ...`, `fix`, `work`, `.`). For new work, use clear Conventional Commit-style subjects:

- `feat: add sequence approval voice commands`
- `fix: prevent overlay focus steal on startup`

PRs should include:

- A concise summary of behavior changes.
- Linked issue(s) when applicable.
- Manual verification steps and commands run.
- Screenshots/GIFs for UI changes (main window, overlay, or settings tabs).

## Security & Configuration Tips

- Never commit API keys, tokens, or local paths.
- Validate changes touching persisted config or secrets handling (`keyring`, settings commands).
- Keep environment-specific values out of tracked files.

### Providers

Read these for info on the interface:

- Claude Agent SDK: "docs\Claude Agent SDK reference - TypeScript.md"
- Codex App Server: "docs\Codex App Server.md"
