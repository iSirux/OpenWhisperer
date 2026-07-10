# Onboarding Brainstorm — 2026-07

Full-screen, super-easy first-run onboarding. Voice-or-not choice up front, Docker and LLM
hand-holding, recommended defaults (dual transcription + Moonshine). This doc captures the
codebase scan, external research, and the proposed design.

> **Status: IMPLEMENTED (2026-07-10), with these decisions overriding the proposal below:**
> Docker-only for transcription (no Groq/cloud fallback); the no-voice path is called
> **"Text"**, not "Keyboard only"; the test recording prompts the user to say **"hello
> hello"**; the Agent step lets the user enable **Claude, Codex, or both** and hides the
> disabled provider app-wide (`enabled_providers` config); the LLM step shows for text-mode
> users too; the payoff step (step 6/7) was **cut**. See the "Onboarding" section in
> CLAUDE.md for the as-built reference.

## Current state (codebase scan)

**Nothing resembling onboarding exists — it's greenfield.** Key facts:

- **No first-run signal.** `AppConfig::load()` (`src-tauri/src/config/mod.rs`) knows when no
  `config.json` existed (returns defaults) but never tells the frontend. No
  `onboarding_completed` flag anywhere.
- **`Start.svelte` is the closest thing** — shown whenever `mainView === 'start'` (i.e. every
  launch with zero sessions, not just the first). Covers mic selection + Whisper connection
  status only. Renders essentially empty when `system.voice_mode_disabled` is set.
- **Chromeless full-screen precedent exists:** the overlay route lives *outside* the `(main)`
  route group, so it renders with no AppHeader/rail. An `src/routes/onboarding/+page.svelte`
  outside the group gets a clean full-screen canvas in the main window for free.
- **Run-once marker precedent:** `.migrated-from-claude-whisperer` marker file in
  `config/mod.rs` — same pattern usable for onboarding completion (though a config field +
  migration is cleaner).

**Reusable building blocks (all already exist):**

| Need | Existing primitive |
|---|---|
| Mic permission + device list | `getUserMedia` + `enumerateDevices` pattern in `Start.svelte` / `MicrophoneTab` |
| Verify Whisper | `test_whisper_connection` (health + real transcription test) |
| Verify realtime STT | `test_realtime_connection` (per-provider WS test) |
| Verify LLM | `test_gemini_connection` (serves all providers despite the name) |
| Claude auth probe | `check_claude_auth` (env key / OAuth creds file / keyring) |
| Codex auth probe + login | `check_openai_codex_auth`, `run_codex_login` (in-app!) |
| One-click Docker | `run_docker_setup` — **Moonshine and SherpaOnnx only** (embedded contexts) |
| Terminal fallback | `run_in_terminal` (used by WhisperTab's copyable docker command) |
| API key storage | keyring-backed `save_*_api_key` / `has_*_api_key` commands |
| Settings deep-links | `goto('/settings?tab=<id>')` |

**Gaps to build:**

1. `onboarding_completed` flag (config field + migration that stamps `true` for existing
   configs so upgraders never see the wizard; fresh defaults get `false`).
2. Frontend-visible fresh-install signal (surface it via `get_config` or a dedicated command).
3. A stepper/wizard UI (none exists; `AskUserQuestionWizard` is an unrelated in-session tool UI).
4. **Docker detection** — nothing probes whether Docker is installed/running; failures surface
   only as broken `docker start` calls. Need a `check_docker` command
   (`docker version` → installed; `docker info` → daemon running).
5. One-click Whisper container — `run_docker_setup` has no whisper context; WhisperTab is
   copy/run-in-terminal only. Either embed a faster-whisper context or drive the existing
   command through `run_in_terminal`.
6. Claude has no in-app login equivalent to `run_codex_login` — could spawn `claude login`
   via `run_in_terminal` and poll `check_claude_auth`.

## External research (what great onboarding does)

- **Wispr Flow** is the consensus best-in-class for voice tools: grant permissions → then
  *dictate a practice email in a low-stakes environment* before real use; every failure state
  has a specific message and a fix-it button ("Open Settings" for mic permission, "mic in use
  by another app", etc.); whole setup ~5 minutes.
- **Superwhisper**: permissions → model download → test dictation → hotkey in any app.
- General 2025 guidance: progressive disclosure (one decision per screen), visible progress,
  personalize the path by an early segmentation question (our voice/no-voice choice is exactly
  this), make everything skippable, live verification per step, don't overload day 1 —
  defer advanced features to in-app discovery ("everboarding").

## Proposed design

### Shell

- **Route:** `src/routes/onboarding/+page.svelte`, outside `(main)` → chromeless full screen.
- **Entry:** on startup, if `!onboarding_completed` → `goto('/onboarding')` (check in root or
  `(main)` layout before anything else mounts). Completing or skipping the wizard sets the flag.
- **Re-runnable:** "Run setup again" button in Settings → About (cheap, high value).
- **Look:** big centered card per step, progress dots, one primary action per screen,
  `Skip for now` on everything except the welcome. Reuse `Waveform.svelte` for the mic test.

### Flow

**Step 0 — Welcome + the fork.** Logo, one-liner ("Talk to your coding agents"), and the single
segmentation question:

> **How do you want to drive it?**
> 🎤 **Voice** (recommended) — record prompts by hotkey, live transcription
> ⌨️ **Keyboard only** — type prompts; you can enable voice later

Keyboard-only sets `system.voice_mode_disabled = true` and skips steps 1–2 entirely
(4 screens total for that path).

**Step 1 — Microphone (voice only).** Device picker + permission prompt + live level meter.
Inline "say something" check: bar moves → green check. Failure states with fix buttons
(permission denied → open Windows privacy settings; silent mic → pick another device).

**Step 2 — Transcription (voice only). The Docker step.** Recommend the default stack verbatim:
**dual transcription (`Both` mode) with Moonshine realtime + local Whisper** — both already the
config defaults, so this step is about *making them actually run*, not choosing.

Run `check_docker` first and branch:

- **Docker running** → one big "Set up transcription" button that runs `run_docker_setup`
  for Moonshine + the Whisper container (needs the new whisper context or a
  `run_in_terminal` bridge), then polls `test_realtime_connection` +
  `test_whisper_connection` until green. Show per-container status rows.
- **Docker installed, daemon down** → "Start Docker Desktop" hint, poll until up, continue.
- **No Docker** → two honest options:
  - "Install Docker Desktop" (link) — *and* let them continue and finish later; the step
    parks as an unfinished checklist item.
  - **Cloud transcription instead:** switch Whisper provider to **Groq** (free tier, one API
    key) and mode to `Whisper`-only. Big synergy: *the same Groq key powers the LLM step* —
    a zero-Docker user gets fully working voice + smart features from one key.

End the step with a live test: record 2 seconds, show the transcript. (The Wispr Flow trick —
prove it works before it matters.)

**Step 3 — Coding agent.** Both paths land here. Probe `check_claude_auth` /
`check_openai_codex_auth` on entry:

- Already authenticated (very common — target users likely have `claude` set up) → instant
  green check, "Claude detected ✓", next.
- Not authenticated → provider cards: Claude (spawn `claude login` via `run_in_terminal`,
  poll the probe) or Codex (`run_codex_login`, already in-app). API-key entry as the
  secondary path (keyring commands exist).

**Step 4 — Smart features (LLM), optional-but-recommended.** Pitch it as outcomes, not config:
"Cleans up your transcripts, names sessions, picks the right model & repo." Groq default;
if a Groq key was entered in step 2, reuse it silently and just show the toggle already green.
One key field + `test_gemini_connection` → enable `llm.enabled` and leave the feature
defaults (all true) alone. Skippable.

**Step 5 — First repository.** Folder picker → add repo → auto-generate description (existing
LLM description generation) if step 4 succeeded. Skippable ("you can add repos from the rail").

**Step 6 — The payoff.** Teach exactly one hotkey and use it immediately:

- Voice path: "Hold **Ctrl+Shift+Space** and describe a task." → live marquee → transcript
  appears → button: **Send it** (launches their actual first session) or **Done**.
- Keyboard path: "Press **Ctrl+N** for a new session" → drop them into `SessionSetupView`
  with the repo pre-selected.

Finishing the wizard on a *real first session already running* is the strongest possible
ending; the transcript-only version is the safe fallback.

### After the wizard ("everboarding")

- Skipped/failed steps become a small **setup checklist** (header pill or Start-view card):
  "2 setup steps remaining" → deep-links to the right settings tab. Removes the pressure to
  block the wizard on Docker installs.
- Advanced features (pile, sequences, smart queue, open mic, prompt chips) stay out of
  onboarding entirely — surface them contextually later.

### Build list (rough order)

1. `system.onboarding_completed` (or top-level) + migration v3 stamping `true` for existing
   configs; expose fresh-install to frontend.
2. `check_docker` command (installed / daemon-running / neither).
3. Onboarding route + stepper shell + step components (mic step largely ports
   `Start.svelte` logic — which this flow likely *replaces*; the sessions-empty state can
   become the checklist card).
4. Whisper one-click container path (embed context in `docker_cmds.rs` or `run_in_terminal`
   bridge).
5. `claude login` bridge (`run_in_terminal` + poll).
6. Groq-key sharing between transcription and LLM steps.
7. Checklist/everboarding surface.

### Open questions

- Should step 6 actually launch a real session (needs a repo from step 5) or stop at the
  practice transcription?
- Does `Start.svelte` get deleted in favor of the checklist card, or kept as the empty-state?
- Keyboard-only users: still pitch the LLM step (naming/model-rec still apply) — presumably
  yes, with transcription-cleanup lines dropped from the pitch?
- Windows mic permission edge: `getUserMedia` denial in the webview — do we need a deep link
  to `ms-settings:privacy-microphone`?

## Sources

- https://kristenberman.substack.com/p/wispr-flow-8-lessons-from-the-best
- https://docs.wisprflow.ai/articles/3152211871-setup-guide
- https://superwhisper.com/docs/get-started/introduction
- https://www.uxdesigninstitute.com/blog/ux-onboarding-best-practices-guide/
- https://www.appcues.com/blog/user-onboarding-ui-ux-patterns
- https://www.eleken.co/blog-posts/wizard-ui-pattern-explained
