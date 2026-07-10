# Local Transcription Services — Research Findings (July 2026)

Brainstorm research into new/better **free, local/self-hosted** transcription options for OpenWhisperer — real-time only or hybrid real-time + batch. Compiled from a codebase audit plus web research (Opus agents). Cloud services deliberately excluded.

---

## 0. Status / decisions (2026-07-08)

- ✅ **Idea D done** — the LLM cleanup prompt now does context biasing: `buildRepoContextForCleanup` / `buildAllReposContextForCleanup` (`src/lib/utils/llm.ts`) emit a `Known terms:` bias list (repo names + keywords + vocabulary + `BASE_CLEANUP_VOCABULARY` app terms), and the Rust prompt (`features.rs clean_transcription_with_usage`) instructs sound-alike substitution with exact casing. Repo names are now always included even when no keywords/vocabulary are configured.
- ✅ **Moonshine v2 verified working end-to-end** (2026-07-08): user built + started the container in-app and it "worked perfectly" — the `moonshine-voice` v0.0.65 API assumptions in `server.py` are confirmed real.
- 🔧 **sherpa-onnx container fixed (x2), retest pending**: crash 1 was `ModuleNotFoundError: http_server` (`streaming_server.py` imports a sibling file the Dockerfile didn't fetch); crash 2 was `HttpServer` eagerly reading a fixed list of 16 demo-page assets from `--doc-root` at startup. Fixed in `docker/sherpa-onnx/Dockerfile`: fetch `http_server.py` + create empty placeholder assets under `/app/web` (we only use the WebSocket side).
- 🔧 **Realtime-first cut-off fixed** (first live test): the frontend unlistened `realtime-final` events BEFORE stopping the backend, dropping the last line's in-flight final (and the Moonshine shim's eof tail was empty since the completed line reset `last_partial`). Fixes: listeners now stay attached through backend stop + 150ms grace (`recording.ts`), and the shim folds all leftover queue events + current partial into one combined eof reply with a quiescence-based drain (0.35s idle, 1.5s cap) instead of a fixed 0.3s sleep.
- ✅ **Transcription mode is now an explicit three-way choice** (`vosk.transcription_mode`, replacing the short-lived `use_for_final` bool): **Whisper** (batch final; live engine optional preview via its enable toggle), **Realtime** (harvest IS the transcript, Whisper never called; empty harvest → transcription failure → pile salvage, retriable there via Whisper), **Both** (realtime-first, Whisper fallback — default & recommended). In Realtime/Both the live engine runs during every recording regardless of the enable toggle. Default provider = Moonshine (marked "recommended"), `vosk.enabled` default true.
- ✅ **"Realtime-first" implemented** (`vosk.use_for_final`): the recording store now harvests every realtime final segment plus the eof-finalized tail (`stop_realtime_session` returns it) and, when the setting is on, uses that as THE transcript — no Whisper round-trip, instant stop→prompt. Empty harvest (engine off/dead/silent) falls through to the normal Whisper queue, so it can never lose a recording. LLM cleanup still applies downstream. Engine-agnostic; makes most sense with Moonshine.
- ✅ **Settings tabs merged**: "Transcription (Whisper)" + "Real-time Transcription" are now one **Transcription** tab (`TranscriptionTab.svelte`) with a "Final transcript source" picker (Whisper batch vs Real-time first) on top; the old `?tab=whisper`/`?tab=vosk` ids redirect.
- ✅ **Both are now Dockerized in-repo** (`docker/README.md`): neither ships an official image, so we build our own. `docker/sherpa-onnx/` wraps the pip package + repo streaming server + baked-in Zipformer model (speaks the existing SherpaOnnx provider protocol on 6006). `docker/moonshine/` wraps `moonshine-voice` behind a Vosk-protocol WS shim (`server.py`, port 2702).
- ✅ **Everything is testable in-app**: Moonshine is a first-class realtime provider (enum variant reusing `VoskSession`, own endpoint/sample-rate/docker settings + connection test), and both new providers have a one-click **Build & Start Container** button in Settings → Real-time — the build contexts are embedded in the binary (`docker_cmds.rs run_docker_setup`), written to disk together with a `setup.cmd`/`setup.sh` script (rm old container → build → run), and executed in a visible terminal window. No manual commands.
- ❌ **Speaches ruled out** — couldn't get it working locally (matches the research caveat: its realtime side is the least mature part, docs "TODO", disconnect issues). Deprioritize idea C.
- Swedish support is a non-requirement (user decision) — Moonshine's English-only streaming is fine.

### Test plan: sherpa-onnx streaming Zipformer (zero code changes expected)

The app's existing sherpa-onnx provider expects a WS server on `ws://localhost:6006` taking float32 samples. sherpa-onnx ships one:

1. Download a prebuilt release binary (Windows x64) from https://github.com/k2-fsa/sherpa-onnx/releases — you want `sherpa-onnx-online-websocket-server`.
2. Download a streaming Zipformer model from the same releases (asr-models), e.g. `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (int8, lightweight) or a larger/newer English streaming Zipformer for accuracy.
3. Run (verify flag names against the docs — https://k2-fsa.github.io/sherpa/onnx/websocket/index.html):
   ```
   sherpa-onnx-online-websocket-server --port=6006 ^
     --tokens=<model>/tokens.txt ^
     --encoder=<model>/encoder-*.int8.onnx ^
     --decoder=<model>/decoder-*.onnx ^
     --joiner=<model>/joiner-*.int8.onnx
   ```
4. In Settings → Vosk tab, switch realtime provider to sherpa-onnx, endpoint `ws://localhost:6006`, sample rate 16000, test connection, record.
5. Compare marquee latency + partial quality vs Vosk on the same phrases; also check wake-word/voice-command matching quality via open mic.

### Test plan: Moonshine v2 Medium Streaming (needs a thin bridge)

No server mode exists, so quickest path is a small WS shim speaking one of our existing protocols (Vosk-shaped is simplest: binary i16 PCM in → `{"partial": ...}` / `{"text": ...}` out, `{"eof":1}` to finalize):

1. Prototype a ~100-line Python (or Node) script wrapping Moonshine v2's streaming API (`moonshine-v2` repo) behind a websocket on some port; convert incoming i16 → float, feed the streaming encoder, emit committed text as partials and the utterance-end state as final.
2. Point the app's **Vosk** provider at it — no Rust changes needed for a first test.
3. If it wins: decide between keeping the shim as a bundled sidecar vs. waiting for sherpa-onnx/RealtimeSTT Moonshine-v2 backends to mature (both have begun integrating Moonshine models).
4. Remember: English-focused (no Swedish) — Whisper stays the batch path for Swedish either way.

---

## 1. What we already have (codebase audit)

### Batch (Whisper)

- `src-tauri/src/whisper.rs` — `WhisperClient` speaks **OpenAI-compatible `multipart/form-data`** to `/v1/audio/transcriptions`, parses `{ "text": ... }`.
- The `WhisperProvider` enum (Local/OpenAI/Groq/Custom) is **never matched in Rust** — it's purely a frontend preset selector in `WhisperTab.svelte`. Any OpenAI-compatible server works **today** via Custom; a first-class preset is a ~5-line frontend change.
- Local preset uses Docker image `fedirz/faster-whisper-server` (the UI only generates a copy-paste `docker run` command; the app doesn't manage Docker).
- ⚠️ Known wart: we send **WebM/Opus bytes labeled `audio.wav` / `audio/wav`** (`whisper.rs:37-40`). faster-whisper/OpenAI sniff the container so it works, but a strict server could reject it. Worth fixing regardless.

### Real-time (streaming)

Much more generalized than the "Vosk" naming suggests. `src-tauri/src/realtime.rs` has a clean **`RealtimeSession` trait** (`send_audio` / `try_recv` / `finalize` / `close`) with **four provider implementations**:

| Provider | Protocol | Audio format | Default endpoint |
|---|---|---|---|
| **Vosk** | `{"config":...}` → binary PCM → `{"eof":1}`; `{"partial"}`/`{"text"}` responses | binary i16 LE | `ws://localhost:2700` |
| **VoiceStreamAI** | JSON config frame, all results final | binary i16 LE | `ws://localhost:8765` |
| **sherpa-onnx** | WS server, `"Done"` to finalize, `{text, is_final}` | **float32 LE** | `ws://localhost:6006` |
| **Speaches** | OpenAI-Realtime-style events, config via URL params | base64 i16 in JSON | `ws://localhost:2701/v1/realtime` |

- Config lives in `config/realtime.rs` but is stored under the legacy JSON key `vosk` (`VoskConfig` is the umbrella struct). Naming is leaky; interfaces are generic.
- Adding a new streaming engine ≈ 1 trait impl + enum variants + config struct + `test_*_connection` + 2 frontend sample-rate ternaries (`recording.ts`, `openMic.ts`) + a `VoskTab.svelte` block. Moderate, well-trodden.
- Audio path: `ScriptProcessorNode` → Float32→i16 → `send_realtime_audio` (JSON i16 array) → Tauri events `realtime-partial/final/error-{sessionId}` → overlay marquee.

### Adjacent

- **Dual-source LLM cleanup** (`llm.ts cleanTranscription`): both the Whisper and realtime transcripts go to the LLM to cross-correct.
- **Open mic wake word** = matching wake phrases against live Vosk partials (RMS gate + pre-roll). No dedicated keyword-spotting model.
- **Voice commands** matched against live partials.
- **Capture-first durability** + pile re-transcription already let us swap providers and re-run old audio.

---

## 2. Engine candidates (local, free)

### Tier 1 — best fits

#### sherpa-onnx streaming Zipformer ⭐ zero-integration Vosk replacement
- **Apache-2.0**, extremely active (v1.13.4, July 7 2026; 183 releases).
- **True streaming** transducer: genuine partials, endpointing, ~44 ms latency, RTF ≈ 0.02 **on CPU** (14–20M param int8 models, ~50 MB).
- English streaming Zipformer ≈ **3.88% WER** test-clean — clearly better than Vosk's small models (though LibriSpeech-trained → weaker on noisy/domain audio than Whisper).
- **We already speak its WS protocol** (`ws://localhost:6006`, float32). Ships Python/C++/Go WS servers; single static binary, first-class Windows builds — could ship as a bundled sidecar exe instead of Docker.
- Also does **open-vocabulary keyword spotting** (see §3) and has Rust/Node bindings for an eventual in-process path.
- https://github.com/k2-fsa/sherpa-onnx

#### Moonshine v2 — best accuracy that's realistic on Windows CPU
- **MIT.** The headline result of early 2026: **Medium Streaming (245M) = 6.65% WER — beats Whisper large-v3 (7.4%)** while being a *true streaming* model at 258 ms latency, CPU-first (ONNX/portable C++). Tiny (26M) matches Whisper Medium.
- v2's "ergodic streaming encoder" caches state — the live text can *be* the final text, collapsing our two-pass design for English.
- Languages: en, es, zh, ja, ko, vi, uk, ar (⚠️ **no Swedish**).
- **Gap:** it's a library, not a server — no WS server, no Docker. Would need a thin bridge (wrap its JS/ONNX bindings in the Node sidecar, or a small WS shim speaking our Vosk/sherpa protocol). RealtimeSTT and sherpa-onnx have begun integrating Moonshine models, which may become the easy path.
- https://github.com/moonshine-ai/moonshine · https://arxiv.org/abs/2602.12241

#### Speaches — consolidation play (already integrated!)
- **MIT**, faster-whisper under the hood. One `ghcr.io/speaches-ai/speaches` container serves **both protocols we already implement**: OpenAI-Realtime-style WS *and* OpenAI-compatible batch `/v1/audio/transcriptions`. Could replace the Vosk container + the whisper container with a single service at Whisper-large accuracy.
- Caveats: the realtime WS is its least mature part (docs literally "TODO", disconnect issues — speaches#214), and it's **VAD-chunked pseudo-streaming** — partials feel laggier than Vosk/sherpa. Best as batch backend + optional realtime, not the low-latency marquee driver.
- https://speaches.ai/

### Tier 2 — worth watching / situational

| Engine | License | Notes |
|---|---|---|
| **WhisperLiveKit** | Apache-2.0 (verify SimulStreaming backend license at adoption) | Packages the SOTA streaming-Whisper research (SimulStreaming/AlignAtt, ~5× faster than old whisper_streaming; IWSLT 2025 winner). Built-in Silero VAD, diarization, backends incl. faster-whisper/Voxtral/Qwen3-ASR. WS + web UI + OpenAI-compatible REST; Docker CPU/GPU. Custom WS protocol → needs a 5th `RealtimeSession` impl. ~10.5k stars, v0.2.22 June 2026. The "streaming quality good enough to skip the second pass" Whisper option. https://github.com/QuentinFuxa/WhisperLiveKit |
| **Kyutai STT** (delayed-streams-modeling) | Code MIT/Apache, weights CC-BY 4.0 | Genuinely streaming *and* accurate (stt-1b en/fr @ 0.5s fixed delay, semantic VAD built in), production Rust WS server. **But effectively GPU/CUDA-required and no Windows story** (Linux/Mac focus, WSL2+CUDA only). Wrong platform fit for our default install; right pick only if we assume an NVIDIA GPU. https://github.com/kyutai-labs/delayed-streams-modeling |
| **Kroko ASR** (kroko-onnx) | Community models CC-BY-SA free; the good "professional" models are commercial (free key = non-commercial only) | sherpa-onnx derivative — likely works over our existing sherpa WS path (needs a smoke test). Free-model upgrade path within an integration we already have. https://github.com/kroko-ai/kroko-onnx |
| **RealtimeSTT** (KoljaB) | MIT | Our exact architecture (fast live model + accurate final model) in one Python library; multi-engine (faster-whisper, whisper.cpp, Moonshine, sherpa-onnx, Kroko), Silero/WebRTC VAD, wake words. Active (v1.0.2 May 2026), Windows .bat installers. Great reference; less clean to ship (Python library + demo WS server, custom protocol). https://github.com/KoljaB/RealtimeSTT |
| **WhisperLive** (Collabora) | MIT | Pseudo-streaming (VAD + sliding-buffer re-decode). Solid but dominated by Speaches (already integrated) and WhisperLiveKit (better algorithm). https://github.com/collabora/WhisperLive |
| **whisper.cpp** | MIT | Best-in-class CPU batch engine, but real-time story is still DIY (naive `whisper-stream` re-decode; server segment-streaming still at discussion stage). Not a realtime candidate. |
| **NVIDIA Parakeet-TDT 0.6B / Canary-Qwen 2.5B** | CC-BY-4.0 | Canary-Qwen = **5.63% WER, #1 open** on OpenASR leaderboard; Parakeet absurdly fast. But ONNX exports are **offline-only** — true streaming needs the heavy NeMo stack or a small third-party Rust server (aivo0/rust-asr-server, Linux-oriented). These are **batch accuracy upgrades**, not a practical Windows realtime path today. |
| **Vosk** (incumbent) | Apache-2.0 | Alive but slow-cycle; Kaldi-era English models essentially unchanged for years. No stability reason to leave; every accuracy reason to. |

---

## 3. Supporting tech (free)

### Wake word / keyword spotting — upgrade opportunity
- **sherpa-onnx open-vocabulary KWS is the standout**: Apache-2.0, fully offline, Windows exe + 12 language bindings, and **custom phrases need no training** — "hey claude" is just a string passed through `text2token`. Strictly better than our current match-against-Vosk-partials approach (accuracy and false-accept rate).
- **openWakeWord**: slightly better raw accuracy, but pretrained models are **CC-BY-NC-SA (non-commercial)** and custom-word training is Linux-only (Piper TTS dep). License landmine.
- **Porcupine**: not free for custom wake words (Enterprise). Ruled out.

### VAD / endpointing
- **TEN VAD** (Apache-2.0 + additional conditions clause — read before shipping): ~300 KB, ~32% lower RTF than Silero, catches short silences Silero misses, **has WASM/JS builds** — usable directly in the Tauri webview for snappy auto-stop-on-silence.
- **Silero VAD v6** (Aug 2025): **MIT** (the license worry is historical — VAD is confirmed MIT), 2.2 MB, the safe ecosystem default (used by Handy, RealtimeSTT, WhisperLiveKit).
- Either beats WebRTC VAD. Use for (a) auto-stop when the user stops talking, (b) trimming silence before the batch pass.

### LLM cleanup — highest-ROI cheap win
- Best practice has converged on **context/vocabulary biasing**, not generic "fix my text": inject a per-session bias list ("These terms may appear: Tauri, sherpa-onnx, Svelte, &lt;repo names&gt;, &lt;file names&gt;, &lt;MCP tool names&gt;…") into the cleanup prompt. We already have repo descriptions + config to build this list, and we already do dual-source (Whisper+realtime) cleanup — this is a prompt upgrade, not new infra.
- Don't LLM-clean partials; clean finalized utterances only (endpoint via VAD), optionally debounced per sentence.

### Context from the OSS dictation scene
Popular free dictation apps (**Handy** — MIT, ~22k stars, Rust-adjacent, runs Whisper/Parakeet/Moonshine locally with Silero VAD; VoiceInk, Whispering, OpenWhispr) mostly **skip live streaming entirely**: hold-hotkey → single local batch pass. The field is moving from two-pass (our pattern) toward **single streaming-native models** (Moonshine v2, Kyutai, Parakeet, Voxtral Realtime — Apache 2.0 open weights with 100-phrase context biasing) whose live output is final quality.

---

## 4. Architecture ideas (brainstorm)

**A. sherpa-onnx Zipformer as the live engine — "do it this week"** *(effort: trivial–low)*
Point the existing sherpa-onnx provider at a streaming Zipformer server (or ship the static binary as a sidecar exe — no Docker needed). Better-than-Vosk accuracy, ~44 ms partials on CPU, zero protocol work. Optionally trial Kroko community models on the same runtime.

**B. sherpa-onnx KWS for wake word + voice commands** *(effort: low–medium)*
Replace open-mic wake detection (and possibly voice-command matching) with sherpa-onnx open-vocabulary keyword spotting — no training, just phrase strings. Biggest robustness win for "hey claude" / "send it" / "cancel that". Could run alongside the same sherpa runtime as idea A.

**C. Speaches consolidation** *(effort: trivial)*
Make one Speaches container the default for both batch and (optionally) realtime — fewer moving parts, Whisper-large accuracy. Accept laggier pseudo-streaming partials, or pair with idea A: sherpa for the marquee, Speaches for the final pass.

**D. Vocabulary-biased cleanup prompt** *(effort: low, orthogonal — do regardless)*
Upgrade `cleanTranscription` to inject repo/file/model/tool vocabulary as a bias list. Immediate accuracy gain on technical terms with zero new dependencies.

**E. Moonshine v2 as the future single engine (English)** *(effort: medium-high)*
Prototype Moonshine v2 Medium Streaming in the Node sidecar (JS/ONNX bindings) or behind a thin WS shim speaking our existing protocol. If live ≈ final quality holds, the two-pass architecture (and the second engine) disappears for English. Watch for sherpa-onnx/RealtimeSTT shipping Moonshine backends as a shortcut.

**F. Smarter endpointing** *(effort: low-medium)*
TEN VAD (WASM in the webview, or native) for auto-stop-on-silence and silence trimming — snappier hands-free flow than fixed timeouts, less audio sent to the batch pass.

### Suggested sequencing
1. **D** (bias prompt) + **A** (sherpa Zipformer live) — cheap, immediate wins.
2. **B** (KWS wake words) once A proves the sherpa runtime.
3. **C** as a settings-default cleanup; **F** opportunistically.
4. **E** as the forward-looking prototype; re-evaluate WhisperLiveKit/Kyutai if we ever assume a GPU.

---

## 5. Key sources

- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx · KWS: https://k2-fsa.github.io/sherpa/onnx/kws/index.html · Zipformer models: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html
- Moonshine v2: https://github.com/moonshine-ai/moonshine · paper: https://arxiv.org/abs/2602.12241
- Speaches: https://speaches.ai/ · realtime issues: https://github.com/speaches-ai/speaches/issues/214
- WhisperLiveKit: https://github.com/QuentinFuxa/WhisperLiveKit · SimulStreaming: https://github.com/ufal/SimulStreaming
- Kyutai STT: https://kyutai.org/stt/ · https://github.com/kyutai-labs/delayed-streams-modeling
- RealtimeSTT: https://github.com/KoljaB/RealtimeSTT · Kroko: https://github.com/kroko-ai/kroko-onnx
- Parakeet v3: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 · Canary-Qwen: https://huggingface.co/nvidia/canary-qwen-2.5b · rust-asr-server: https://github.com/aivo0/rust-asr-server
- TEN VAD: https://github.com/TEN-framework/ten-vad · Silero VAD: https://github.com/snakers4/silero-vad
- openWakeWord: https://github.com/dscripka/openWakeWord
- Context-biasing research: https://arxiv.org/html/2512.21828v1
- Handy (reference app): https://github.com/cjpais/Handy · dictation roundup: https://github.com/primaprashant/awesome-voice-typing
- Vosk status: https://alphacephei.com/en/news.html
