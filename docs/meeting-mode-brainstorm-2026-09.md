# Meeting Mode — Brainstorm (2026-09)

Status: brainstorm / scoping. Nothing implemented yet.

## Goal

Switch on a "meeting mode" for in-person meetings or Discord/Teams calls (playtesting a game with friends is the
motivating case) and have the app quietly snap up things to do, fix and investigate — without anyone dictating at it.
The point is **fast iteration with vertical integration** (talk → pile → agent session), not real-time coding:
minutes of delay are fine.

Two layers, as the core idea:

1. **Dump/collect layer** — everything said lands in a durable, append-only meeting journal.
2. **Act layer** — an LLM triages the journal: actionable items (bugs, tasks, investigations) become pile candidates;
   non-actionable ones (feedback, wishlist, decisions, notes) become **journal items**.

Explicitly in scope: auto-repo and fixed-repo selection, local *or* API transcription, local *or* API LLM,
all three desktop platforms. Also pulled in by this scoping: a **local LLM layer that works for every LLM feature**
in the app, the **`json_schema` structured-output fix**, **OpenRouter transcription** (incl. Microsoft
MAI-Transcribe), and **auto model via a complexity score + configurable breakpoints**.

Out of scope for now: live transcript marquee, playtest-specific extras ("mark that" hotkey + screenshot, build tags,
Sequences events), per-person diarization beyond what the STT provider gives for free.

## Decisions so far

| Question | Decision |
|---|---|
| Where do extracted actionable items go? | A per-meeting **review list**; auto-send to pile is **opt-in** (per confidence threshold). |
| Platforms for v1 | **All three** (Windows, macOS, Linux). |
| Live transcript during the meeting | **Not needed.** Chunked batch transcription with delay is the source of truth. |
| Non-actionable items | Land in a new **Journal** (journal items, tagged + mapped to repo/meeting). |
| `json_schema` fix | Ships **with** this work (it's a prerequisite for local LLMs anyway). |
| OpenRouter / MAI transcription | **In scope.** |

## Prior art (research summary)

- **Local-capture, no bot** is the closest model: Granola, Krisp, and the open-source Tauri/Rust apps
  **Meetily** (github.com/Zackriya-Solutions/meetily) and **Hyprnote/anarlog** (github.com/fastrepl/anarlog). All
  capture mic + system audio on-device and run STT + LLM extraction locally or via BYO key.
- Bot-based (Otter, Fireflies, tl;dv, Teams Copilot recap) are irrelevant to the capture design but share the UX:
  action items with owner/confidence, raw transcript vs curated summary.
- Consistent industry gap: *"action items get captured but don't move anywhere."* Routing items into the pile →
  agent session is exactly the missing step, and is OpenWhisperer's differentiator here.
- Extraction pattern that works: rolling windows with overlap + "already-extracted items" context → merge/dedupe
  ops, then a whole-meeting consolidation pass (map-reduce). Ref: arXiv 2312.17581 (action-item-driven summarization).

## Architecture

```
Capture (Rust)        →  Journal (dump)            →  Triage (LLM)                  →  Outputs
mic + system audio       append-only, on disk         rolling windows, classify,       review list → pile (opt-in auto)
VAD-cut segments         {t0,t1,speaker,text}         merge against existing items     journal items (non-actionable)
```

### 1. Capture — in Rust, not the webview

Why not extend `recording.ts`: the frontend path is built for short push-to-talk clips.
- Whole recording buffered in memory (`audioChunks: Blob[]`, `recording.ts:73`), nothing on disk until stop.
- Audio crosses IPC as JSON `number[]` (`Array.from(audioData)`, `recording.ts:868`) — an hour is tens of millions of
  numbers, several times over (capture, pile audio, debug log).
- WebM chunks after the first have no header → can't slice into independently decodable files.
- A hidden WebView2 window may be throttled (tray mode keeps the webview alive, but rAF/timers slow down).
- No system audio capture exists anywhere in the codebase.

Rust capture fixes all of it and is crash-safe by construction.

**Two separate streams: mic and system loopback.** Mic = "me", loopback = "them" — free 2-speaker attribution
(what Granola/Krisp/Hyprnote do). Discord mixes remote voices into one output, so "them" is one bucket; fine for
an item inbox. MAI-Transcribe-2's diarization (below) can split "them" further for free when that provider is used.

Per platform:
- **Windows:** `wasapi` crate (HEnquist/wasapi-rs). Default-render loopback, **plus process loopback**
  (`ActivateAudioInterfaceAsync` + `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, Win10 2004+) to capture
  **only Discord/Teams** and keep game audio/music out. `cpal` has loopback but not the per-process API.
  Gotcha: a silent render endpoint returns *no packets* (not silent ones) — the loop must tolerate that and keep the
  timeline aligned.
- **macOS:** `screencapturekit` crate (13+; audio needs the Screen Recording permission). Core Audio process taps
  (14.4+) are Swift-only → would need a small Swift helper; ScreenCaptureKit is the pragmatic choice.
- **Linux:** PipeWire monitor source (`<sink>.monitor`).
- Mic: `cpal` in Rust too (so both streams share one clock and one writer), device from `settings.audio.device_id`.
  Note the webview uses browser-default constraints (echo cancellation/NS/AGC on); in Rust we get raw input — may want
  light AGC, or rely on STT robustness. Echo: speakers bleeding into the mic produce "me" duplicates of "them" text;
  headphones are the answer for v1, dedupe by time overlap as a later nicety.

**Segmentation:** VAD (Silero via ONNX, or a simple energy gate like open mic's RMS gate as v0) cuts each stream into
speech segments of ~30 s – 2 min, cut on silence, hard cap ~2 min. Each segment is written as its own small file
(Opus/FLAC/16 kHz mono WAV) under `meetings/<meetingId>/audio/`. This also keeps every upload far below the
~25 MB API limits and lets pile items replay the exact clip.

**Controls:** start/stop (hotkey + UI), pause, a persistent overlay "meeting recording" indicator (new
`OverlayMode = 'meeting'`; must not be hidden by the recording flow's stop path, `recordingFlow.ts:348`).

**Consent / trust line.** `docs/flow-mode-brainstorm-2026-07.md:148` deliberately excluded ambient/meeting capture.
Recording other people is subject to all-party-consent law in some jurisdictions and GDPR. Local capture with a
clearly visible on-device indicator is the low-risk posture. Required, not optional: persistent indicator while
active, explicit start (never auto-start), and a one-line "tell participants you're recording" notice on first use.

### 2. Transcription — chunked batch, provider of choice

Each segment is queued to the configured transcription provider on its **own lane** — the existing single-flight
queue in `recording.ts:504-620` would make dictation wait behind meeting chunks (or vice versa).

Providers:
- **Local Whisper** (existing Docker faster-whisper) — free, private; competes for GPU with a local LLM (see below).
- **Groq `whisper-large-v3-turbo`** — existing provider, ~$0.04/hr, very fast, no diarization.
- **OpenRouter** (new) — `POST /api/v1/audio/transcriptions` (launched 2026-07-22), same key as the LLM layer. Routes
  to Whisper, gpt-4o-transcribe, Groq Whisper, Chirp 3, and **Microsoft MAI-Transcribe-2**
  (`microsoft/mai-transcribe-2`, released 2026-09-03): **$0.10/hr, 60 languages incl. Swedish, ~2% AA-WER, speaker
  diarization + word timestamps.** Recommended default API path: one OpenRouter key covers transcription *and* LLM.
  - ⚠️ Unverified: exact request/response schema vs native OpenAI multipart, and size/duration caps. Do one live test
    call before building; expect a small adapter in `whisper.rs` rather than reusing the Custom provider as-is.
  - Mistral Voxtral is out (no Swedish).
- Later / optional: Deepgram / AssemblyAI (streaming if a live view is ever wanted).

`whisper.rs` improvements this needs (also benefit normal dictation):
- Send the correct content type (currently labels WebM as `audio.wav`, `whisper.rs:37-39`).
- Pass `prompt` = tail of the previous segment's text + repo vocabulary (context across cuts).
- Ask for `verbose_json` where supported (segment timestamps; speakers from MAI).
- A request timeout (`reqwest::Client::new()` has none, `whisper.rs:28`).
- Retries with backoff for API providers (currently only local Docker retries).

Failures: a segment whose transcription fails stays on disk with `status: error` and is retried (manual + automatic
backoff); nothing is lost — same philosophy as the pile's capture-first durability.

### 3. Journal of the meeting (the dump layer)

Per meeting, under `<config>/meetings[-dev]/<meetingId>/`:
- `meeting.json` — metadata: title, started/ended, repo mode (fixed repo id or auto), providers used, status.
- `transcript.jsonl` — append-only lines `{ segId, t0, t1, speaker: 'me'|'them'|'them:<n>', text, status }`.
  JSONL append = crash-safe without rewriting the file (current `atomic_write` rewrites whole files; add an append
  command).
- `audio/<segId>.*` — segment files.
- `items.json` — triage output for this meeting (see below).

On app start, an unfinished meeting is detected and offered for resume/finalize (pending segments get transcribed,
final consolidation runs).

Meeting audio must **skip the Recordings Log** (`debugRecordings.ts` stores full audio for its 20 entries).

### 4. Triage (the act layer)

**Rolling pass** every N minutes (default ~3) or after a long pause, over *new* transcript + ~20% overlap:

Input: transcript window (with timestamps/speakers), the meeting's current items, the repo's **open journal items**
(for cross-meeting dedupe), repo descriptions (for auto-repo), meeting context (title, repo).

Output — strict JSON ops:
```json
{ "ops": [
  { "op": "new", "category": "bug", "title": "...", "detail": "...", "quote": "verbatim span",
    "t0": 812.4, "t1": 830.1, "speaker": "them", "confidence": 0.82, "repoId": "..." },
  { "op": "update", "id": "itm_12", "detail": "...", "quote": "...", "t0": 1204.0, "t1": 1210.5 },
  { "op": "ignore_span", "t0": 900, "t1": 960, "reason": "small talk" }
]}
```

Categories:
- **Actionable → review list / pile:** `bug`, `task`, `investigate`, `question` (open technical question to research).
- **Non-actionable → journal items:** `feedback`, `idea` (wishlist), `decision`, `note`.

Items carry every sighting (`occurrences[]` of quote + timestamps), so "the jump feels floaty" said three times is one
item with three sightings — sighting count is itself a priority signal.

**Final consolidation pass** on stop (quality chain): whole journal (or map-reduce if it exceeds the model's comfortable
context) → merge duplicates, rewrite titles/details, adjust categories, produce a meeting summary (decisions, open
questions, top items).

LLM layer notes (from the codebase scan):
- New `LlmFeature`s (`MeetingTriage` → quality chain, `MeetingConsolidate` → quality chain) in `llm/types.rs`,
  result structs, methods in `features.rs` via `run_feature`, commands in `llm_cmds.rs`, feature flag in
  `LlmFeaturesConfig`.
- Existing prompts truncate input to 500–3000 chars — meeting features do their own windowing instead.
- `run_chain` has no timeout (only cleanup has one) — add a per-feature timeout.
- Validate model output ourselves: only Gemini enforces the schema today (see json_schema fix below).

### 5. Outputs

**Review list** (per meeting): actionable items with quote, speaker, timestamp, confidence, repo, and a ▶ button that
plays the segment clip. Actions: Send to pile, Send to journal (re-categorize), Dismiss, Edit. Multi-select.
**Opt-in auto-pile**: actionable items above a confidence threshold go straight to the pile (setting, off by default).

**Pile items** from a meeting: created as text items (`addRecording` already accepts no audio), skipping *dictation*
cleanup (it's the wrong transform for LLM-written text) — pre-fill title/repo/model and only run what's missing.
New field on `PileItem` (opaque JSON, no Rust change):
```ts
source?: { kind: 'meeting'; meetingId: string; itemId: string; quote: string; t0: number; t1: number; segId?: string }
```
Pile detail shows the quote and plays the clip.

**Repo:** meeting-level choice — a fixed repo (typical for a playtest) or auto-repo per item (uses the existing repo
recommender; the pile's auto-repo gating at `pile.ts:264` applies).

### 6. Journal items (new store)

A durable store next to the pile for everything worth keeping that isn't a task *yet*.

```ts
interface JournalItem {
  id: string;
  category: 'feedback' | 'idea' | 'decision' | 'note' | 'question';
  title: string;
  detail: string;
  repoId?: string;
  tags: string[];
  occurrences: { meetingId?: string; quote: string; t0?: number; t1?: number; speaker?: string; at: number }[];
  status: 'open' | 'promoted' | 'dismissed';
  promotedPileItemId?: string;
  createdAt: number; updatedAt: number;
}
```

- Persisted like the pile (`journal.json`, opaque JSON, `.dev.json` split).
- **Accumulates across meetings** — triage gets the repo's open journal items and emits `update` ops against them.
- **Promote to pile** keeps the link both ways.
- UI: a sidebar tab (Sessions | Pile | Scheduled | Journal) or a per-repo view; grouped by category, filters by
  repo/meeting/tag, sorted by sightings/recency. Meeting summary links to the items it produced.
- Entries come **only from meetings** (decided: no "journal it" voice command / hotkey for direct entry).

### 7. Settings

New `meeting` config section (`config/meeting.rs`, additive → no migration needed): capture sources (mic, system,
per-app target on Windows), segment length / VAD sensitivity, transcription provider for meetings (may differ from
dictation), triage interval, auto-pile toggle + confidence threshold, default repo mode, retention (keep audio N days).
Hotkey for start/stop meeting (`HotkeyConfig` + `HotkeyEnabledConfig`, registered in `useHotkeyManager`).
New Settings tab "Meeting".

Interlocks: open mic must stay off during a meeting (`useOpenMic.svelte.ts:53-65` restarts it when nothing records —
add a meeting gate). Voice commands and wake words must never run on meeting speech (a friend saying "send it" or
"pile it"). Normal dictation during a meeting: allowed, but the mic is shared — v1 can simply pause the meeting's mic
stream while push-to-talk records.

## Local LLM layer (app-wide, not just meetings)

Goal: every LLM feature (cleanup, naming, interaction detection, model/repo recommendation, quick actions, branch
names, ship drafts, sequence nodes, meeting triage/consolidation) works on a local model.

The app already has `LlmProvider::Local` (default `http://localhost:1234/v1/chat/completions`, no key) and
profile + fast/quality chain routing — so the plumbing exists. What's missing:

1. **Structured output fix (ship with this).** `providers.rs:327` hardcodes `response_format: {type: "json_object"}`
   for all OpenAI-compatible providers. **LM Studio rejects `json_object` outright** ("must be 'json_schema' or
   'text'") → every JSON feature fails against the app's own default local endpoint today. Fix: send
   `json_schema` with the feature's real schema (already built for Gemini), fall back to `json_object` → plain text on a
   400, and always validate. Also benefits OpenAI/Groq/xAI (true schema enforcement).
2. **Thinking control.** Qwen3.x/3.8 think by default; llama.cpp does *not* apply grammar/schema while thinking is on
   (ggml-org/llama.cpp#20345), and LM Studio has a Qwen3.5 json_schema-empties-content bug (#1773). Send
   `chat_template_kwargs: { enable_thinking: false }` for schema-constrained calls on Local (per-profile toggle
   "disable thinking"); `/no_think` no longer works reliably on 3.8.
3. **Per-feature timeouts** in `run_chain`, generous for Local on background features, tight for cleanup.
4. **Latency-aware routing.** Cleanup is latency-sensitive (8 s cap, `features.rs`); a big local model won't hit it.
   The fast/quality chains already let users put a small/API profile first for fast features and the big local model
   first for quality features — surface this as a preset in Settings → LLM ("Local for background, API for
   instant").
5. **Setup help.** Optional one-click like the Docker STT setup: detect/install Ollama or llama.cpp `llama-server`,
   pull a recommended GGUF, health check + test button. At minimum, documented presets.

### What fits this PC (RTX 4080 16 GB, Ryzen 9 5900X, 64 GB DDR4)

~5.7 GB VRAM is already used by desktop apps + the faster-whisper container → **~9–10 GB free with local Whisper
loaded, ~15 GB without.** No Ollama / LM Studio / llama.cpp installed. Use G: (449 GB free) for model files.

**Qwen3.8** lineup (Sept 2026): **Qwen3.8-27B** dense (Aug 14, Apache-2.0, 262K ctx, thinking by default),
**Qwen3.8-Flash-Next** MoE (~180B total / ~6B active), and a 2.4T-A95B flagship (not feasible here).
**"Swift" is not an official Qwen variant** — `ukisai/Swift-Qwen3.8-27B` is a community fine-tune that cuts thinking
tokens ~58% with <1% accuracy loss. ⚠️ Its license is free only for individuals/orgs under $1M revenue — check before
using it for work.

Recommendation, accepting ~10 tok/s for background work:
- **Smart / background** (meeting triage + consolidation, session analysis, quick actions, ship drafts):
  **Qwen3.8-27B** GGUF, `UD-Q3_K_XL` (~12.5 GB) or `IQ4_XS` (~14.6 GB), q8_0 KV cache, thinking **off** for
  schema-constrained calls. Fits fully on GPU only when local Whisper is *not* loaded; with Whisper loaded it needs a
  few layers on CPU → slower, but plausibly ≥10 tok/s. (Speeds are estimates from quant size — no verified 4080
  numbers; benchmark before committing.) Avoid IQ1/IQ2 quants — quality collapses.
- **Experimental:** Qwen3.8-Flash-Next with `--n-cpu-moe` (experts in RAM, ~6B active) might reach ~10 tok/s on 64 GB
  DDR4 — unverified; worth one benchmark. ⚠️ ~114 GB at Q4 exceeds 64 GB RAM + 16 GB VRAM, so it would need a
  smaller quant (Q2/Q3-class) or mmap streaming from disk (slow).
- Flash-Next skipped (doesn't fit). Swift benchmarked — results below.

### Benchmark: Swift-1.5-Qwen3.8-27B Q3_K_M (2026-09-27)

Setup: llama.cpp b11218 (Windows CUDA 13.4), `-c 32768 -fa on -ctk q8_0 -ctv q8_0 --fit on --jinja`, thinking off
via `chat_template_kwargs: {enable_thinking: false}`, `response_format: json_schema` (strict). Model 12.5 GB.
Fixture: a synthetic 20-min Discord playtest transcript (~2k tokens, English + some Swedish, small talk, repeated
mentions). Script + fixture + raw results: `G:\llm\bench\`.

| Test | A: faster-whisper loaded (model partly on CPU) | B: whisper stopped (model on GPU) |
|---|---|---|
| Triage (2k in → ~1.6k out) | 148 s · gen 20 t/s | **73 s** · gen 23 t/s · ingest 1055 t/s |
| Cleanup (~80 tok out) | 4.5 s | **3.9 s** |
| Complexity score (per prompt) | 2.0–5.6 s | **1.5–4.3 s** |
| Long ingest (9k tokens) | 35 s · 504 t/s | **17 s** · 1327 t/s |
| Triage, thinking **on** | 462 s, hit the 8000-token cap without answering | — |

Note: the faster-whisper container holds ~5 GB VRAM on its own; with it loaded the model spills to CPU.

Quality:
- **Triage: excellent.** 13 items, all valid JSON, all categories sensible (4 bugs, 3 investigate, 3 feedback, 2 ideas,
  1 decision). Repeated mentions merged (floaty jump said 3×, incl. the Swedish line → one item; HUD flicker from two
  speakers → one). Small talk (football, dog) ignored. Intended behavior (torch in water) correctly *not* a bug, but
  the "no indication" remark became an idea. Near-identical output across A and B.
- **Cleanup: good** — fillers/repetitions removed, "to small" → "too small", "tool tip" → "tooltip".
- **Complexity scores: 6/7 in the expected band**, the miss was plausible (cave FPS investigation scored 8 vs expected
  5–7). Scores were stable between runs.
- **Thinking on is unusable** here even for the "less overthinking" Swift fine-tune: 28k chars of reasoning and no
  answer within 8000 tokens. Keep thinking off for every schema call.

Verdict:
- Background features (triage, consolidation, session analysis, complexity scoring): **good enough locally** — triage
  of a 3-minute window (far less text than the fixture) would take ~20–40 s, well within budget.
- Cleanup at ~4 s fits inside the current 8 s cleanup budget but is much slower than Groq (<1 s) — fine as a
  fallback, API preferred first in the fast chain.
- Running local Whisper **and** this model at once halves speed; for meeting mode, pair local LLM with API
  transcription (MAI-Transcribe-2 / Groq), or accept ~2× slower triage.
### Benchmark: smaller 9B models, Q5_K_M, with faster-whisper loaded (2026-09-27)

Same fixture/flags, `-ngl 99 -np 1`. Both fit **fully on the GPU next to faster-whisper**: ~6.6 GB each, leaving
~1.5 GB free (vs. the 27B, which spilled to CPU). ⚠️ Run while four `cargo`/`npm` builds were hogging the CPU, so
generation speed (~22–30 t/s) is likely understated — re-run on an idle machine.

| | Swift-1.5-Qwen3.8-27B Q3_K_M | **Empero Qwen3.8-9B distill** Q5_K_M | Qwen3.5-9B (official) Q5_K_M |
|---|---|---|---|
| VRAM | 12.5 GB (spills with Whisper) | **6.6 GB** | 6.7 GB |
| Triage wall (whisper loaded) | 148 s | **72 s** | 63 s |
| Cleanup | 4.5 s | 3.7 s | **2.8 s** |
| Complexity (in band) | 6/7 | **7/7** | **7/7** |
| Items found | 13, all right | 13 | 11 — **missed the fishing decision** and the torch idea |
| Categorization | best (bug vs investigate split) | good; footstep lag as feedback (arguably bug) | FPS drop filed as bug, not investigate |
| Ingest (9k tok) | 504 t/s | 1430 t/s | 2200 t/s |

**Re-run on an idle machine** (Qwen3.8-9B distill, whisper loaded): triage **18 s** (gen 78 t/s, ingest 3900 t/s),
cleanup **1.25 s**, 9k-token ingest 4.6 s (5250 t/s) — the table above was CPU-starved by ~3.5×. At this speed local
cleanup is competitive with an API.

**Pick: Empero Qwen3.8-9B distill (Q5_K_M)** — near-27B triage quality (all 13 items incl. the decision, 7/7
complexity) at half the VRAM, coexisting with local Whisper. Apache-2.0 (no Swift revenue clause). Qwen3.5-9B is a bit
faster but dropped items. Keep Swift-27B as the "Whisper on API" quality option.

- Follow-ups: the 27B GGUF ships MTP (`nextn`) heads that llama.cpp reported as unused — speculative decoding via MTP could
  raise generation speed; also try IQ4_XS (14.4 GB) for quality when Whisper isn't on the GPU.
- **Fast / latency-sensitive** (transcription cleanup, naming, repo/model recommendation): a 27B at ~10–20 tok/s
  can't do ~200 output tokens in <3 s. Either keep these on a fast API (Groq) first in the fast chain, or run a small
  model (Qwen3.5-9B / 4B, ~80–110 tok/s) alongside — but two models + Whisper won't all fit in 16 GB at once, so that
  means Ollama model-swapping (reload latency) or Whisper moved to an API while the LLM is local.
- **Runtime:** llama.cpp `llama-server` (Windows CUDA build) on `--port 1234` so the app's default works; best control
  (`--n-cpu-moe`, KV-cache quant, `--chat-template-kwargs`). Ollama is the simpler alternative (`:11434/v1`, keeps
  multiple models resident, `think=false`). LM Studio works only after the `json_schema` fix, and has the Qwen bug
  above.
- **Honest verdict:** local is fine for triage, consolidation, naming, analysis — and keeps meeting content on the
  machine. An API still wins for cleanup latency and for very long (>60K token) consolidation quality.

## Configurable auto-model candidates

Today's auto model (`features.rs:349` `recommend_model_with_usage`) only knows `haiku|sonnet|opus` by id prefix,
filtered by `enabled_models`; effort is a separate global setting (`AutoModelEffort`: fixed level or dynamic).
Consequences: Codex/GPT models and Fable are never auto-selectable, capability blurbs are hardcoded, and the user
can't say "only these combos".

Proposal: **the LLM grades the task, the user's config picks the model.** The recommender no longer chooses a model
at all — it returns an estimated **complexity/scope score 1–10** (plus a one-line reason). A user-configured
**breakpoint ladder** maps the score to a model + effort:

```jsonc
"auto_model_tiers": [
  { "min_score": 0, "model": "claude-sonnet-5", "effort": "low"    },
  { "min_score": 6, "model": "claude-opus-5-5", "effort": "medium" },
  { "min_score": 8, "model": "claude-opus-5-5", "effort": "high"   }
]
```

Why this is better than asking for a model:
- The LLM only needs a stable rubric, not knowledge of current model names, prices or capabilities — the prompt never
  goes stale when models change, and no hardcoded Haiku/Sonnet/Opus blurbs.
- Any provider's models can sit on the ladder (Claude, Codex, Fable); disabled providers' tiers are skipped (fall
  through to the next-lower enabled tier).
- Tuning is a config tweak ("I spend too much — move Opus to 7+") instead of prompt engineering, and the score is
  loggable, so the breakpoints can be calibrated against real sessions.
- Deterministic mapping → the same score always yields the same model.

Details:
- **Rubric** in the prompt, anchored with examples, e.g. 1–2 trivial (typo, rename, config value) · 3–4 small
  (single-file change, simple bug) · 5–6 moderate (feature touching a few files) · 7–8 large (cross-cutting feature,
  tricky debugging) · 9–10 very hard (architecture, unfamiliar subsystem, ambiguous requirements). Schema: integer
  1–10 + `reason` (+ optional `confidence`).
- Rule: highest tier whose `min_score` ≤ score. The first tier is forced to `min_score: 0` so every score resolves.
- Defaults derived from `enabled_models` + the current `auto_model_effort` so existing users see roughly today's
  behavior; `auto_model_effort: Dynamic` becomes "effort comes from the tier". Additive config; migration only if we
  retire `auto_model_effort`.
- UI (Settings → LLM or General): a small ladder editor — score threshold, model picker, effort picker, add/remove —
  and the chosen score shown next to "Auto" in session UI ("Auto · 7 → Opus med") so users can calibrate.
- Meeting items and the pile use the same recommender, so this directly affects how triaged items launch; meeting
  triage can even emit the score per item directly, skipping a separate recommendation call.

## Phasing

**v1**
1. `json_schema` structured output + thinking control + per-feature timeouts (app-wide).
2. OpenRouter transcription provider (after a live test call), `whisper.rs` fixes (content type, prompt, timeout).
3. Rust capture: mic + system loopback on Windows (incl. per-app), macOS (ScreenCaptureKit), Linux (PipeWire);
   VAD segmentation to disk.
4. Meeting journal (JSONL, resume after crash), dedicated transcription lane, meeting UI + overlay indicator.
5. Rolling triage + final consolidation, review list, opt-in auto-pile, `PileItem.source` + clip replay.
6. Journal items store + tab, promote to pile, cross-meeting dedupe.
7. Auto model via complexity score (1–10) + configurable breakpoint ladder.
8. Local LLM setup presets / docs (one-click install optional).

**Later:** live transcript view (realtime provider or streaming API), playtest extras (mark-that hotkey + screenshot,
build tags), Sequences events (`meeting-ended`, `meeting-item`), local diarization (sherpa-onnx), echo dedupe.

## Open questions

1. ~~Journal entries from outside meetings~~ — decided: no.
2. Journal UI: fourth sidebar tab vs per-repo view (or both)?
3. Meeting transcription provider: separate setting from dictation, or always the same?
4. Local LLM: build a one-click installer (like Docker STT setup), or document presets only for v1?
5. Retention: how long to keep meeting audio segments (disk grows ~30–60 MB/hr as Opus, more as WAV)?

## Sources

- Meetily — https://github.com/Zackriya-Solutions/meetily · Hyprnote/anarlog — https://github.com/fastrepl/anarlog
- wasapi crate — https://docs.rs/wasapi · screencapturekit crate — https://lib.rs/crates/screencapturekit
- Core Audio taps — https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps
- whisper-streaming (local agreement) — https://arxiv.org/pdf/2307.14743 · WhisperLiveKit — https://github.com/QuentinFuxa/WhisperLiveKit
- Action-item-driven summarization — https://arxiv.org/pdf/2312.17581 · Gladia transcript→notes — https://www.gladia.io/blog/transcript-to-actionable-notes-llm
- OpenRouter audio — https://openrouter.ai/docs/guides/overview/multimodal/audio · https://openrouter.ai/blog/tutorials/transcription-on-openrouter/
- MAI-Transcribe-2 — https://openrouter.ai/microsoft/mai-transcribe-2 · https://microsoft.ai/pdf/MAI-Transcribe-2-Model-Card.pdf
- Groq Whisper turbo — https://console.groq.com/docs/model/whisper-large-v3-turbo
- Qwen3.8 — https://github.com/QwenLM/Qwen3.8 · https://huggingface.co/unsloth/Qwen3.8-27B-GGUF · https://unsloth.ai/docs/models/qwen3.8
- Qwen3.8 quant benchmarks — https://quesma.com/blog/qwen38-27b-quantizations-benchmarked/
- Swift-Qwen3.8-27B — https://huggingface.co/ukisai/Swift-Qwen3.8-27b
- llama.cpp grammar-with-thinking — https://github.com/ggml-org/llama.cpp/issues/20345
- LM Studio structured output — https://lmstudio.ai/docs/developer/openai-compat/structured-output · json_schema Qwen bug — https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1773
- Ollama structured outputs — https://docs.ollama.com/capabilities/structured-outputs
- Recording consent — https://basilai.app/articles/2026-03-12-are-meeting-bots-legal-consent-laws-for-ai-notetakers-in-2026.html
