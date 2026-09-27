# Meeting Mode — Implementation Contract (v1)

Binding interface contract for the parallel implementation of the features scoped in
`docs/meeting-mode-brainstorm-2026-09.md`. Four workstreams (A–D) build against the names, shapes and file ownership
below. **If you need to deviate from a signature, keep it backward compatible or note it in your final report** —
another workstream is coding against it at the same time.

JSON field casing: **snake_case everywhere** in payloads defined here (Rust serde default). TS types mirror snake_case.
Timestamps: `*_at` = epoch **ms** (number); transcript `t0`/`t1` = **seconds from meeting start** (float).

## Defaults chosen for the brainstorm's open questions
- Journal UI: a **fourth sidebar tab** (Sessions | Pile | Scheduled | Journal), detail in the main pane.
- Meeting transcription provider: `meeting.transcription_provider` (+ model); `null` = use the dictation Whisper settings.
- Local LLM: no one-click installer in v1 — per-profile "disable thinking" + docs/presets only.
- Audio retention: `meeting.retention_days` (default 30); transcripts/items kept forever.
- Non-actionable triage items (feedback/idea/decision/note) go **straight into the Journal** (non-destructive);
  actionable ones (bug/task/investigate/question) go to the meeting **review list**, and to the pile only via user
  action or opt-in auto-pile.

---

## Workstream A — LLM layer (owner: `src-tauri/src/llm/**`, `src-tauri/src/config/llm.rs`, `src-tauri/src/commands/llm_cmds.rs`, `src/lib/components/settings/LlmTab.svelte`, `src/lib/utils/llm.ts`, `src/lib/utils/autoModelTiers.ts` (new), auto-model call sites)

1. **Structured output:** OpenAI-compatible providers send `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}` using each feature's schema (Gemini keeps its native schema). On HTTP 400 (schema/format rejected) retry once with `json_object`, then once with no `response_format`. Always parse/validate (`extract_json`). Fixes LM Studio, which rejects `json_object`.
2. **Thinking control:** `LlmProfile.disable_thinking: bool` (serde default `true`). When true and provider is Local/Custom, send `chat_template_kwargs: {"enable_thinking": false}`. Checkbox on the profile card.
3. **Timeouts:** per-feature timeout in `run_chain` (per attempt). Fast features ~15 s, quality ~60 s, meeting triage 180 s, consolidation 600 s. Cleanup keeps its existing tighter budget.
4. **OpenRouter LLM provider:** `LlmProvider::OpenRouter` — OpenAI-compatible at `https://openrouter.ai/api/v1/chat/completions`, key per profile (existing keyring scheme), model free text (e.g. `google/gemini-3.1-flash-lite`). Add to LlmTab provider picker.
5. **Auto model = complexity score.** `recommend_model` stops choosing a model: the LLM returns `{ complexity: 1-10, reasoning, confidence }` using an anchored rubric (1–2 trivial … 9–10 very hard). Config: `LlmFeaturesConfig.auto_model_tiers: Vec<AutoModelTier>` with `AutoModelTier { min_score: u8, model: String, effort: Option<String> }` (effort `null|low|medium|high|xhigh|max`), serde default empty = derived defaults. Mapping lives in **`src/lib/utils/autoModelTiers.ts`**:
   ```ts
   export interface AutoModelTier { min_score: number; model: string; effort: EffortLevel | null }
   export function effectiveTiers(settings): AutoModelTier[]           // configured, or derived from enabled_models + auto_model_effort; tiers whose provider is disabled removed; first tier forced to min_score 0
   export function resolveTier(score: number, settings): { model: string; effort: EffortLevel | null; tier: AutoModelTier }  // highest tier with min_score <= score
   ```
   Update every auto-model call site (useTranscriptionProcessor, SdkView, pile.ts, utils/llm.ts …) to use `complexity` → `resolveTier`. Show the score where Auto resolved (e.g. log + a small "Auto · 7" hint where the recommendation is surfaced today). Ladder editor UI in LlmTab (rows: min score, model picker over all enabled providers' models, effort picker; add/remove). `AutoModelEffort` stays for derived defaults.
6. **Meeting features:** `LlmFeature::MeetingTriage` and `LlmFeature::MeetingConsolidate` (both quality chain), feature flag not needed (meeting mode itself is the opt-in). Commands:

```ts
// invoke('meeting_triage', { request })
interface MeetingTriageRequest {
  transcript: string;                 // lines formatted "[HH:MM:SS me|them] text"
  items: { id: string; category: string; title: string }[];          // this meeting's existing items
  journal_items: { id: string; category: string; title: string }[];  // repo's open journal items (ids prefixed "j:")
  repos: { id: string; name: string; description: string }[] | null; // non-null => auto-repo: pick repo_id per new item
  context: string | null;             // meeting title / free-text context
}
interface MeetingTriageResult { ops: TriageOp[] }
interface TriageOp {
  op: 'new' | 'update';
  id: string | null;                  // update: existing item id (or "j:<id>" for a journal item)
  category: 'bug'|'task'|'investigate'|'question'|'feedback'|'idea'|'decision'|'note' | null; // required for new
  title: string | null;               // required for new
  detail: string | null;
  quote: string;                      // verbatim
  t0: string;                         // "HH:MM:SS" of the mention
  complexity: number | null;          // 1-10, new items
  confidence: number | null;          // 0-1, new items
  repo_id: string | null;             // only when repos != null
}

// invoke('meeting_consolidate', { request })
interface MeetingConsolidateRequest {
  transcript: string;                 // full meeting, same line format (backend may map-reduce if huge)
  items: { id: string; category: string; title: string; detail: string; sightings: number }[];
  context: string | null;
}
interface MeetingConsolidateResult {
  summary: string;                    // markdown: overview, decisions, open questions, top items
  merges: { keep_id: string; merge_ids: string[] }[];
  updates: { id: string; title: string; detail: string; category: string }[];
}
```
Prompts: ignore small talk, merge repeated mentions, verbatim quotes, categories as defined in the brainstorm. No input truncation to 500–3000 chars for these two (they window on the frontend).

## Workstream B — Transcription (owner: `src-tauri/src/whisper.rs`, `src-tauri/src/config/whisper.rs`, `src-tauri/src/commands/audio_cmds.rs`, `src/lib/components/settings/WhisperTab.svelte`, `TranscriptionTab.svelte`)

1. **`WhisperProvider::OpenRouter`**: `POST https://openrouter.ai/api/v1/audio/transcriptions`, default model `microsoft/mai-transcribe-2`, API key in the keyring like the other API providers. Research the exact request/response format from OpenRouter docs (openrouter.ai/docs — audio / transcription) and implement it; request `verbose_json`-style segments + speaker labels when available. Mark clearly in code/UI if anything is unverified. Connection test works for it.
2. **Fixes (all providers):** correct filename/MIME per actual format (webm/opus for dictation, wav for meeting segments); optional `prompt`; `reqwest` client with timeouts (connect 10 s, total 120 s); retry with backoff (2 retries) on 429/5xx/network for API providers.
3. **Reusable entry point** used by workstream C:
```rust
// src-tauri/src/whisper.rs
pub struct TranscribeSegment { pub start: f64, pub end: f64, pub text: String, pub speaker: Option<String> }
pub struct TranscribeOutput { pub text: String, pub segments: Vec<TranscribeSegment> }
pub async fn transcribe_detailed(
    config: &crate::config::WhisperConfig,
    audio: Vec<u8>,
    file_name: &str,      // e.g. "seg-0003.wav"
    mime: &str,           // e.g. "audio/wav"
    prompt: Option<&str>, // context: previous segment tail + vocabulary
) -> Result<TranscribeOutput, String>;
```
(`segments` may be empty when the provider doesn't return them.) Existing `transcribe_audio` command keeps working and should route through the same code.

## Workstream C — Meeting backend (owner: `src-tauri/src/meeting/**` (new), `src-tauri/src/commands/meeting_cmds.rs` (new), `src-tauri/src/config/meeting.rs` (new) + its line in `config/mod.rs`, `toggle_meeting` in `config/hotkeys.rs`, `Cargo.toml` deps)

**Capture** (Rust, separate streams, 16 kHz mono i16):
- mic: `cpal` default input or `meeting.mic_device` (cpal device name).
- system: Windows `wasapi` crate — default-render loopback, or **process loopback** (include target process tree) for `meeting.system_process_names` (default `["Discord.exe","Teams.exe","ms-teams.exe"]`) when `meeting.system_target == "process"` (fallback to full loopback if none running; log). Silent endpoints return no packets — keep timelines aligned. macOS: `screencapturekit` audio (cannot be compiled/verified on this Windows machine — keep it behind `cfg(target_os = "macos")`, follow the crate's documented API exactly, mark unverified). Linux: capture from the PipeWire/Pulse monitor of the default sink (via cpal/ALSA `pulse`/`pipewire` device, or `pw-record`/`parec` subprocess fallback) behind `cfg(target_os = "linux")`, mark unverified.
- **Segmenting:** energy VAD per stream (threshold `meeting.vad_threshold`, hangover `meeting.silence_hangover_ms` default 1200, min speech 0.6 s, max segment `meeting.max_segment_secs` default 90, 300 ms pre-roll). Each speech segment → `audio/<seg_id>.wav` (16 kHz mono 16-bit). `seg_id` = `seg-<0000 counter>-<me|them>`.
- **Pipeline (Rust worker per meeting):** segment written → append pending line → `whisper::transcribe_detailed` (config = dictation `WhisperConfig` with `meeting.transcription_provider`/`transcription_model` overrides; prompt = tail of previous line of the same speaker + active repo vocabulary if provided at start) → append final line → emit event. Bounded concurrency 2; failed segments retried 2× with backoff, then `status: 'error'` (retry via command). If provider returns speaker labels for "them" segments, speaker = `them:<label>`.
- **Storage** under `AppConfig::config_dir()/meetings` (`meetings-dev` in debug builds): `<id>/meeting.json` (MeetingMeta), `<id>/transcript.jsonl` (append-only, one TranscriptLine per line; later lines for the same seg_id supersede earlier), `<id>/items.json` (opaque frontend JSON), `<id>/audio/*.wav`. Meeting ids: `mtg-<epoch ms>` ([A-Za-z0-9_-] validated). Retention: on startup delete audio dirs of `done` meetings older than `retention_days`.
- **Crash safety:** meta written on every status change; on startup any meeting with status `recording|paused|finalizing` becomes `interrupted` (pending segments still on disk). `meeting_finalize` transcribes pending/failed segments and sets `done`.
- Only **one active meeting** at a time.

```ts
interface MeetingMeta {
  id: string; title: string; started_at: number; ended_at: number | null;
  status: 'recording' | 'paused' | 'finalizing' | 'done' | 'interrupted';
  repo_id: string | null; auto_repo: boolean; context: string | null; summary: string | null;
  sources: { mic: boolean; system: boolean; system_target: 'all' | 'process' };
  segment_count: number; pending_segments: number; failed_segments: number;
  duration_secs: number;
}
interface TranscriptLine {
  seg_id: string; t0: number; t1: number;
  speaker: string;               // 'me' | 'them' | 'them:<label>'
  text: string; status: 'pending' | 'ok' | 'error'; error?: string | null;
}
```

Commands (all return `Result<_, String>`):
| command | args | returns |
|---|---|---|
| `meeting_start` | `{ opts: { title: string \| null, repo_id: string \| null, auto_repo: boolean, context: string \| null, vocabulary: string[] \| null } }` | `MeetingMeta` |
| `meeting_stop` | `{ id }` | `MeetingMeta` (status `finalizing`, → `done` when pipeline drains; emits status) |
| `meeting_pause` / `meeting_resume` | `{ id }` | `MeetingMeta` |
| `meeting_active` | — | `MeetingMeta \| null` |
| `meeting_list` | — | `MeetingMeta[]` (newest first) |
| `meeting_get` | `{ id }` | `{ meta: MeetingMeta, transcript: TranscriptLine[] }` (deduped by seg_id, sorted by t0) |
| `meeting_update` | `{ id, patch: { title?, summary?, repo_id?, context? } }` | `MeetingMeta` |
| `meeting_get_items` / `meeting_save_items` | `{ id }` / `{ id, items: any }` | `any` / `()` |
| `meeting_read_segment_audio` | `{ id, seg_id }` | `number[]` or bytes (WAV) |
| `meeting_retry_segment` | `{ id, seg_id }` | `()` |
| `meeting_finalize` | `{ id }` | `MeetingMeta` |
| `meeting_delete` | `{ id }` | `()` (refuses active) |
| `meeting_list_input_devices` | — | `string[]` |
| `meeting_list_audio_processes` | — | `{ pid: number; name: string }[]` (Windows; empty elsewhere) |

Events: `meeting-status` → `MeetingMeta`; `meeting-transcript` → `{ meeting_id, line: TranscriptLine }`; `meeting-level` → `{ meeting_id, mic: number, system: number }` (0–1 RMS, ~4 Hz); `meeting-error` → `{ meeting_id, message, seg_id: string | null }`.

Config (`AppConfig.meeting`, `#[serde(default)]`):
```rust
pub struct MeetingConfig {
  pub capture_mic: bool,                 // true
  pub capture_system: bool,              // true
  pub system_target: String,             // "process" | "all"   (default "process")
  pub system_process_names: Vec<String>, // ["Discord.exe","Teams.exe","ms-teams.exe"]
  pub mic_device: Option<String>,        // cpal device name; None = default
  pub vad_threshold: f32,                // 0.015
  pub silence_hangover_ms: u32,          // 1200
  pub max_segment_secs: u32,             // 90
  pub transcription_provider: Option<WhisperProvider>, // None = dictation settings
  pub transcription_model: Option<String>,
  pub triage_interval_minutes: u32,      // 3
  pub auto_pile: bool,                   // false
  pub auto_pile_min_confidence: f32,     // 0.85
  pub default_auto_repo: bool,           // false (use active repo)
  pub retention_days: u32,               // 30
}
```
Plus `HotkeyConfig.toggle_meeting` (default empty/unbound) + `HotkeyEnabledConfig.toggle_meeting`.

## Workstream D — Meeting + Journal frontend (owner: `src/lib/stores/meetings.ts` (new), `src/lib/stores/journal.ts` (new), `src/lib/components/meeting/**` (new), `src/lib/components/journal/**` (new), `src/lib/components/settings/MeetingTab.svelte` (new), settings page tab registration, `settings.ts` meeting/hotkey mirror, `navigation.ts`, sidebar tab wiring, `PileDetailView.svelte`/`PileList.svelte` source display, `pile.ts` `source` field + text-item creation, overlay meeting mode, `useHotkeyManager` + `HotkeysTab` toggle_meeting, open-mic interlock; Rust side only `src-tauri/src/commands/journal_cmds.rs` (new, `get_journal`/`save_journal` opaque JSON like schedules) + its registration)

- **meetings store:** start/stop/pause via C commands; listens to C events; keeps active meeting, transcript, level; **triage driver** every `triage_interval_minutes` (and on stop after finalize): new lines since last triaged `t1` + ~30 s overlap, formatted `[HH:MM:SS speaker] text`, call `meeting_triage` (A), apply ops:
  - `new` actionable → `MeetingItem` (status `new`), auto-pile if enabled and `confidence >= auto_pile_min_confidence`.
  - `new` non-actionable → journal item created/linked (status `journaled`).
  - `update` → append occurrence (to meeting item, or journal item for `j:` ids).
  - persist via `meeting_save_items`. After `done`: `meeting_consolidate` (A) → apply merges/updates, `meeting_update({summary})`.
  - Never runs voice commands / wake words on meeting text. Open mic stays stopped while a meeting is active (gate in `useOpenMic`).
- **MeetingItem** (items.json): `{ id, category, title, detail, complexity, confidence, repo_id, occurrences: [{ quote, t0, t1, speaker, seg_id }], status: 'new'|'piled'|'journaled'|'dismissed', pile_item_id, journal_item_id, created_at, updated_at }`. Map triage `t0` "HH:MM:SS" to the nearest transcript line for `t1`/`seg_id`/speaker.
- **Pile:** `PileItem.source?: { kind: 'meeting'; meeting_id; item_id; quote; t0; t1; seg_id? }`. Create text-only items without dictation cleanup; pre-fill title/repo and model+effort via `resolveTier(complexity)` (A's util). PileDetailView shows the quote + ▶ plays the clip (`meeting_read_segment_audio`).
- **Journal store** (`journal.json` via `get_journal`/`save_journal`): `JournalItem` as in the brainstorm (`category: feedback|idea|decision|note|question`, occurrences, status open|promoted|dismissed, tags, repo_id). Promote → pile item (keeps link both ways). Journal tab in sidebar (list grouped by category, filters repo/meeting/tag, sort by sightings/recency) + main-pane detail.
- **Meeting UI:** `MainView 'meeting'`. Entry: a Meeting button in the sidebar header area / AppHeader + `toggle_meeting` hotkey. View: start panel (title, repo or auto-repo, sources, context), live status (duration, levels, pending/failed segments, next triage countdown), delayed transcript list, **review list** (actionable items: quote, speaker, time, confidence, complexity→tier, repo, ▶ clip; actions Send to pile / To journal / Dismiss / Edit, multi-select), past meetings list (open, finalize interrupted, delete), summary after consolidation. First-use consent notice ("Tell participants you're recording").
- **Overlay:** `OverlayMode 'meeting'` — persistent small "● Meeting 00:42:10" indicator while active; the dictation flow must not hide it (restore meeting mode after dictation stops).
- **Settings → Meeting tab** for all `MeetingConfig` fields (mic device list from `meeting_list_input_devices`, running audio processes helper from `meeting_list_audio_processes`, transcription provider override incl. OpenRouter).

## Ground rules for all workstreams
- Other agents are editing this working tree concurrently. **Never** run `git reset`, `git checkout -- <path>`, `git stash`, `git clean`, or commit. Only edit files you own; for shared registration files (`lib.rs`, `config/mod.rs`, `settings.ts`, `settings/+page.svelte`, `navigation.ts`) make small, targeted edits and re-read before editing.
- Build checks: `cargo check` in `src-tauri` (if it complains about the missing `ow` binary run `npm run cli:build` first) and `npm run check`. Errors in files owned by another workstream mid-flight are expected — don't fix them, mention them.
- Follow existing idioms (see CLAUDE.md). No new tests framework; add Rust unit tests where logic is pure (VAD, tier mapping, op application).
