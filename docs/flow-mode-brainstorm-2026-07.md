# Flow Mode — Brainstorm (2026-07)

A new voice-first mode: the user goes into flow state with an open mic and just *talks* — delegating work, answering agent questions, triaging finished sessions, making decisions — without touching keyboard or mouse. This doc synthesizes a codebase baseline, external landscape research, and a brainstorm of what Flow should (and shouldn't) be.

> **Decision (2026-07-08): the Cockpit (§4.8) ships first.** The voice answer window (`voice-answer-window-2026-07.md`) and Ambient Flow (§4.7) are tabled — kept here as design docs for later phases.

---

## 1. The one-sentence pitch

> **Flow is a conversation with your agent fleet.** Today the app is voice → *one new session*. Flow makes it voice → *the right thing*: a follow-up to a running session, an answer to a blocked agent, a new delegation, a question answered directly, or a note parked in the pile — decided per utterance, hands-free.

The key mental shift: today's pipeline is **recording-centric** (start → stop → route the whole recording via a stop-mode). Flow is **utterance-centric**: a continuous stream of speech segmented into utterances, each classified and routed by intent.

### 1.1 Two visions under one name

There are two distinct products hiding in "Flow", and both are worth building — in a specific order:

**The Cockpit (voice-driven fleet view).** Orchestration *is* the activity. A new view inside OpenWhisperer built for conducting the fleet by voice: you're *looking at the app*, sessions are on screen with nicknames and numbers, and speech replaces keyboard/mouse as the control input. "Flow state" here means flow in *conducting* — the Steinberger mode of running many parallel agents where directing them is the work itself.

**Ambient Flow (the away-mode).** You're in some other app entirely — fullscreen in a game, a browser, a different project — while the fleet works; OpenWhisperer is invisible. "Flow state" means flow in *whatever you're doing*, with the fleet running alongside. The always-on-top HUD renders over fullscreen apps too, and stays the primary ambient surface. The mic is persistent, an intent router decides where each utterance goes, and the app surfaces only as a glanceable HUD and event-driven interrupt cards.

They share almost all machinery (utterance segmentation, STT + cleanup, nicknames, fleet snapshot, answer routing, extraction) but differ in one structural fact — **whether the user's eyes are on the app** — and that fact dissolves or creates the three hardest problems:

| | Cockpit (eyes on app) | Ambient (eyes elsewhere) |
|---|---|---|
| Addressing ambiguity ("thinking aloud vs command") | Gone — everything said in the cockpit is for the fleet by definition | The central unsolved problem; needs address-first convention + router |
| Disambiguation & misroute safety | Visual — on-screen numbers, focus ring, parsed-intent preview before execution | Needs read-back beats, TTS/chimes, utterance ledger for audit |
| Mic trust/privacy story | Clean — mic hot only while window focused | Always-on mic; the full trust burden |
| Intent routing | Lightweight — a focused session + verb grammar resolves most utterances | Full LLM intent router required |
| Speech output | Not needed (feedback is visual) | Needed for true hands-free (phase-4 TTS) |

**Consequence for build order:** the Cockpit is the right *first full Flow experience* (after the standalone voice answer window), and Ambient Flow is the extension that reuses everything the Cockpit builds. §4.8 describes the Cockpit; §4.7's three-layer model is the Ambient architecture.

---

## 2. Codebase baseline — what exists, what's missing

### Assets Flow can build on

| Building block | Where | Why it matters for Flow |
|---|---|---|
| Open mic + wake commands | `openMic.ts`, `useOpenMic.svelte.ts` | Continuous passive listening already works (RMS gate, pre-roll/hangover, `open_mic_passive` realtime session) |
| Generalized realtime STT | `realtime.rs` — 5 providers (Vosk, VoiceStreamAI, sherpa-onnx, Speaches, Moonshine) + Docker one-click | Streaming transcription backbone; Moonshine v2 points at a future single-pass engine |
| Voice commands | `voiceCommands.ts` | String-matched commands (send/cancel/pile/approve/...) — the primitive Flow generalizes into semantic intent |
| `sendPrompt(id, ...)` + sidecar input queue | `sdkSessions.ts:1999`, sidecar `inputQueue` | Prompts can already target an *existing* session, even mid-turn (steering). Nothing chooses the `id` by voice yet |
| LLM feature harness | `features.rs` `run_feature` pattern | Adding a new structured LLM call (intent router, standup digest) is trivial and cheap (Gemini Flash-Lite, sub-second) |
| Completion analysis hook | `finalizeCompletion` → `analyzeSessionCompletion` | Already extracts `outcome`, `needsInteraction` (+reason/urgency/waiting_for), `quickActions` on session done |
| Structural blocking detection | sidecar `canUseTool` intercepts `AskUserQuestion` / `ExitPlanMode` | Reliable "agent is waiting on you" signal with the actual question text — Flow's highest-value trigger |
| The pile | `pile.ts` | A durable utterance inbox with background LLM processing (cleanup/repo/model/title) — the natural sink for non-actionable speech |
| Smart Queue driver | `smartQueue.ts` | The only global session driver (subscribe-all + tick loop) — the architectural template for a "Flow conductor" |
| Launch machinery | `sessionLaunch.ts`, `pileActions.ts` | `launchSession`, batch queue, worktrees, plan/discuss variants — delegation primitives ready to be voice-driven |
| Session tags | `pileItem`/`notionCard` on `SdkSession` | Provenance pattern to reuse for `flowUtterance` linkage |

### Hard constraints (must break or work around)

1. **Open mic and recording are mutually exclusive.** Every recording path calls `openMic.stop()`; open mic restarts 500 ms after recording ends. Flow needs **one persistent capture pipeline** feeding both wake/intent detection and dictation — not two lifecycles fighting over `getUserMedia`.
2. **No VAD / endpointing.** Utterance boundaries today = hotkey, voice command, or RMS threshold + fixed linger. Continuous flow needs real endpointing (Silero VAD, or semantic VAD à la Pipecat Smart Turn v2: ~400 ms, 99%) to segment speech hands-free. The local-transcription research doc already recommends Silero/TEN VAD and sherpa-onnx open-vocab KWS.
3. **Two-pass transcription.** Authoritative transcript = batch Whisper after stop; realtime is a preview. A continuous mode with no discrete "stop" must either trust streaming output (Moonshine v2 direction) or run rolling batch passes per utterance.
4. **Wake/command detection is plain string matching on ASR partials**, with two inconsistent matchers (openMic vs voiceCommands). One-shot per recording (`voiceCommandTriggered`), not re-armable per utterance.
5. **Audio plumbing is ScriptProcessorNode + JSON `number[]` over `invoke`** — deprecated API, high IPC overhead for an always-hot mic. AudioWorklet + binary channel eventually.
6. **No cross-session brain.** Sessions are independent; nothing holds a live picture of the fleet to route/prioritize. (Smart Queue is global but content-blind.)
7. Known bug: the layout calls `openMicLifecycle.update()` with shifted args (5 vs 6 params), so realtime-config-change auto-restart likely never fires. Fix before building on the lifecycle.

### Missing primitives (the real Flow work)

- **Utterance → intent router** (new `features.rs` feature): classify each utterance into `{follow-up to session X, answer to blocked session Y, new task, question, command, note/pile, ignore}`.
- **Voice routing to an existing session** — only repo-level routing exists today (`recommend_repo`). Needs a session-candidate list (names, outcomes, last messages) fed to the router. The uncommitted cleanup-vocabulary work ("repo names are used for voice routing") already leans this way.
- **Direct Q&A** — no primitive answers a spoken question without spawning a full Claude session.
- **Voice output (TTS)** — the app is entirely silent today except chimes. Flow's briefing/answer loop needs speech out (or at minimum, rich ambient display).
- **Structured extraction beyond a one-line `outcome`** — no decisions/follow-ups/changed-files extraction, no durable decision log.

---

## 3. Landscape research — what to steal, what to avoid

Full details in the research pass; the load-bearing findings:

**Steal:**
- **Blocking-question latency as the north-star metric** (Omnara: "resolve a blocking question in seconds, not hours"). Voice's genuine superpower is unblocking agents while you're away from the keyboard. AgentsRoom's "waiting-on-you turns red and pings" → in voice: *the blocked agent speaks first*.
- **Coordinator-digests-children as a spoken standup** (Devin's managed-Devins is the only production "brief many agents" pattern). "Two done, one blocked on a failing test and needs a decision, two running."
- **Backtrack-style invisible self-correction** (Wispr Flow): "meet Tuesday, wait no Friday" → "Friday". Our LLM cleanup layer is 80% of the way there; make it utterance-native.
- **Numbered pickers for disambiguation** (macOS Voice Control, Serenade): "which session? 1: auth refactor, 2: docker setup" → "two". Beats re-dictation everywhere.
- **Explicit validity/low-confidence signal** (Serenade's "x"): a misheard command must *visibly fail*, never silently fire the nearest match (Talon's worst trap — fatal when commands drive destructive agent actions).
- **Risk-tiered confirmation**: implicit for low-risk (chime + transcript flash), explicit read-back + verbal "yes" for destructive/irreversible (delete worktree, force push, batch-approve).
- **Verification artifact + one-sentence summary as the reviewable unit** (Cursor's auto screenshots/videos, PR summaries) — you can't read diffs by voice.
- **Agent-initiated voice questions** (Spokenly's MCP `ask_user_dictation`): the agent's question is spoken/shown, user answers by voice. We're better positioned than an MCP add-on — we *own* the `canUseTool` interception.
- **Semantic VAD + manual escape hatch always** (every vendor that shipped aggressive endpointing — ChatGPT AVM, Gemini Live — retreated to a hold/mute button).

**Avoid:**
- **Pure always-on as the only mode.** Every serious dictation product defaults to push-to-talk/wake; always-on is a liability (open offices alone rule it out for ~70% of devs).
- **Ambient intent-guessing.** No product solves "thinking aloud vs actionable command" ambiently — extraction hallucination stays >35% ("maybe we should…" gets promoted to a firm command). Winners make capture *intentional* (Plaud's press-to-highlight, Granola's human-seeded notes). Flow should require a cheap explicit commit signal, not guess.
- **The piling problem.** A voice inbox of 200 finished agents is worse than useless; throughput scales, review capacity doesn't. Triage must be tiered, batch-approve the trivial, lead with blockers.
- **Trust collapse.** Wispr's silent-screenshot scandal, Otter/Fireflies consent lawsuits. Always-listening + unclear data handling kills products. OpenWhisperer's local-first stack (Vosk/sherpa/Moonshine in Docker) is a genuine differentiator — lean in: on-device, visible mic state, no undisclosed capture.
- **Dictating exact tokens.** Voice is for intent; identifiers/paths mangle. Delegate syntax to the agent ("rename all fooVar to userCount"); keep the replacement-vocabulary work going.
- **Alexa's lesson:** continuous usage of trivial intents ≠ value. Flow must be built around the few *high-value* loops (unblock, delegate, triage), not voice-controlling everything.

---

## 4. The brainstorm — what Flow could be

### 4.1 The core loop: a conversation with the fleet

Flow session = open mic + a lightweight always-on **conductor** (LLM router, not a Claude session). Per utterance:

```
mic (persistent) → VAD segments utterance → streaming STT → cleanup/backtrack collapse
   → intent router (Flash-Lite, ~300ms) with context: session list + blocked questions + pile
   → route:
      ANSWER    → feed into blocked session's AskUserQuestion / pending plan approval
      FOLLOW-UP → sendPrompt(sessionId, …)  (steering an active or idle session)
      DELEGATE  → launchSession(...)  (repo/model/effort recs as today)
      QUESTION  → conductor answers directly (from session outcomes/status) via TTS/display
      COMMAND   → app action (pause, status, approve, switch)
      NOTE      → pile.addRecording(...)  (with auto-processing as today)
      DISCARD   → visible "not for me" indicator (never silent)
```

The conductor is *cheap and stateless-ish*: it holds a rolling context of session names/states/outcomes/blocked questions (a "fleet snapshot" — derivable today from `sdkSessions` + `aiMetadata`), not a full conversation.

### 4.2 The five interaction loops worth building (ranked)

1. **Unblock loop (highest value, build first).** Agent hits `AskUserQuestion`/`ExitPlanMode` → Flow announces it (chime + spoken/read question) → user answers by voice → answer routed via existing `submitAskUserAnswers`/`approvePlan`. This is Omnara's north star and we already have the structural hooks. Even *without* the rest of Flow, "answer blocked agents by voice" is a shippable feature.
2. **Delegate loop.** "Have someone add retry logic to the whisper client" → cleanup → repo/model recs → launch (or prepare, per confidence). This is today's flow minus the hotkey — the delta is wake-free utterance segmentation + intent detection.
3. **Standup/triage loop.** "What's the status?" → conductor digests fleet into a spoken brief, blockers first: "Auth refactor finished — outcome: migrated 12 endpoints. Docker setup is blocked asking whether to pin the image version. Two still running." Then: "approve the docker one" / "show me auth". Extends `analyzeSessionCompletion`; add a `generate_fleet_briefing` feature.
4. **Decision-capture loop.** During flow, decisions get made ("yes, pin the version — and let's standardize on compose v2"). Extract and log them durably (new `decisions` extraction on session completion + explicit "note that down" voice command → pile or a new decision log). Also the answer to "extraction from stopped sessions": on `done`, extract `{outcome, decisions[], followUps[]}` — follow-ups become pile items or quick-action prompts.
5. **Q&A loop (scope carefully).** "Did the auth session touch the middleware?" — answerable from session transcripts by the conductor. But general codebase Q&A = just delegate a read-only session; don't rebuild Claude inside the router.

### 4.3 Utterance boundaries & the commit problem

The research is unambiguous: don't guess intent ambiently. Proposed hybrid:

- **Semantic VAD** segments utterances (expose the silence threshold; Talon's fixed 0.3 s broke natural pauses).
- **Address-first convention** for actionable speech: utterances addressed to the fleet start with a name/route word — "Claude, …", "delegate …", session nicknames ("Falcon, also add tests"). Unaddressed speech defaults to NOTE or DISCARD (visible), never to an action.
- **Explicit commit for anything that costs**: launches happen after a short spoken read-back window ("Delegating to ClaudeWhisperer, Sonnet: 'add retry logic…' — say cancel to stop") — barge-in cancels. Destructive ops require verbal confirmation.
- **Session nicknames** (auto-generated, speakable, 1–2 syllables) make routing utterances tractable: "Is Falcon done?" beats "the session about auth refactoring". Add `nickname` to `aiMetadata`, generated with the session name.

### 4.4 Feedback & UI surface

- Today's surfaces are fragmented (overlay = recording-scoped, open-mic marquee = header-scoped). Flow wants **one persistent ambient surface** — likely an expanded overlay: mic state, live partial transcript, *last routed utterance + where it went* (the validity signal), fleet strip (N running / N blocked / N done), current mode.
- **68% of voice users feel uncertain without feedback** — every utterance gets a visible disposition, even DISCARD.
- Sound design: short distinct chimes per event class (blocked ping ≠ done chime ≠ routed tick) instead of verbal "okay".
- **TTS question:** speech out makes the unblock/standup loops truly hands-free, but is a new subsystem (Kokoro locally, per the VoiceMode pattern). Phase 1 can be display-only + chimes; TTS is the phase-2 multiplier.

### 4.5 What Flow is NOT (scope fences)

- **Not a replacement for the keyboard.** Blended mode; hotkeys and typing stay first-class. Voice for intent and triage, keyboard for surgical edits, identifiers, and diff review.
- **Not ambient/meeting capture.** Flow doesn't transcribe your day or your calls — it listens *for the fleet*. Unaddressed speech is dropped (or, opt-in, piled as notes). This is the trust line: local-first, mic state always visible, one tap/word to mute ("go quiet" / "flow off").
- **Not fine-grained code review by voice.** The reviewable unit is outcome summary + verification artifact; "show me" hands off to the screen.
- **Not a second chat product.** The conductor routes and briefs; it doesn't hold long conversations. Anything conversational becomes a session.
- **Not voice-controlling app settings/UI chrome.** Low value, high grammar surface — Alexa's trivial-intent trap.

### 4.6 Combining with existing systems

- **Sessions:** Flow is a *mode over* the existing session model, not a new one. Route targets = existing sessions; delegation = existing launch machinery; tags (`flowUtterance`) give provenance like `pileItem` does.
- **Pile:** becomes Flow's short-term memory — every NOTE and every failed/uncertain routing lands there (already the durable failure sink). Batch-launch from pile = "handle my pile" voice command.
- **LLM layer:** the router, briefing, nickname, and decision-extraction are 4 new `features.rs` methods on the existing harness — same cheap structured-call pattern as today.
- **Smart Queue:** the conductor and Smart Queue should merge perspectives eventually — one global driver that knows both rate-limit state and content state ("your Opus window resets in 20 min; two queued tasks will start then" is a great standup line).
- **Sequences/prompt chips:** chips become spoken modifiers ("…and search the web first").

### 4.7 Ambient Flow UI — not a view, a mode with three layers

The defining fact about *Ambient* Flow UI: **when it's working, the user isn't looking at OpenWhisperer.** They're in another app — possibly fullscreen (a game, a movie) — or across the room. So Flow cannot primarily be a view inside the main window; a view you must keep focused defeats the purpose. Flow is a **mode** (a state you toggle, like open mic today) whose UI is split across three layers by attention level:

**Layer 1 — Ambient HUD (always present while Flow is on).** A small persistent always-on-top window — the evolution of today's recording overlay, but permanent for the duration of Flow rather than recording-scoped. Contents, in priority order:
- Mic/mode state (listening / muted / processing) — big, unambiguous, the trust anchor
- Live partial transcript of the current utterance (the existing marquee)
- **Last disposition line**: what the previous utterance was heard as and where it went ("→ Falcon", "→ new session: retry logic", "→ pile", "✗ not for me") — this is the anti-silent-misfire surface and the single most important element
- Fleet strip: tiny status dots/counts (2 running · 1 blocked · 1 done), blocked in red
It should be glanceable in <1 s and never take keyboard focus. Today's overlay + open-mic marquee (currently split across two windows) merge into this one surface.

**Layer 2 — Interrupt cards (event-driven, transient).** Windows/cards that appear only when the fleet needs the user or the user just acted:
- The **voice answer window** for blocking questions (see `voice-answer-window-2026-07.md` — shippable standalone, becomes this layer)
- **Read-back/commit cards**: "Delegating to ClaudeWhisperer, Sonnet: 'add retry…' — say cancel" with a countdown
- Done-announcements during standup ("Falcon finished — outcome: …") when TTS is off
These are the only things that ever animate/chime; the ambient HUD never demands attention.

**Layer 3 — The Flow dashboard (in the main window, for when you *do* tab in).** Not required to operate Flow — it's the review surface. When Flow mode is on, the main window offers a fleet-first view (could evolve from `sessions-view`):
- Fleet board: session cards with nickname, status, one-line outcome, blocked-question preview — blockers pinned first
- **Utterance ledger**: a scrolling log of every utterance → disposition → result, with per-row undo/redo ("that went to the wrong session" → re-route). This is the audit trail that makes hands-free trustworthy, and the debugging surface for router misfires
- Decisions/follow-ups captured this Flow session
- Pile inbox (notes that accumulated)
The normal session detail view stays one click away — layer 3 is where "show me" lands.

**Why not always-on everywhere in the app?** Sprinkling voice-reactivity across every existing screen means every component needs voice states, and the user never knows what's listening for what. One ambient HUD + one interrupt surface + one dashboard keeps the contract simple: *the HUD hears everything, cards ask questions, the dashboard remembers.* The main window's normal views don't change behavior when Flow is on (beyond a visible Flow indicator in the header).

**Why not a separate full view as the primary surface?** Same reason the overlay exists for recording: the moments that matter happen while another app has focus. The dashboard is the least important of the three layers — Flow should be fully operable with the main window minimized.

Practical notes: this direction consolidates today's fragmented surfaces (recording overlay window + header open-mic marquee) into the layer-1 HUD, which fixes constraint #8 from §2 along the way. The HUD likely stays one Tauri window that grows/shrinks by state (like the overlay's resize machinery today) rather than multiple windows; the answer window is the one candidate for a genuinely separate window (so a question can show while an utterance is mid-flight).

### 4.8 The Cockpit — a voice-driven fleet view (the original vision)

A new main-window view (evolving from `sessions-view`) designed for conducting the fleet by voice while looking at it. The design principle: **the screen carries the context, so speech only carries the intent.** Everything on screen is speakable; every utterance's interpretation is visible before it executes.

**Layout sketch:**

- **Fleet board** — grid of session cards: nickname + number, status color (blocked = red, pinned first), one-line outcome/current activity, blocked-question preview inline, live token/progress hint. Cards are the addressable units.
- **Focus ring** — exactly one session is "focused" at a time, visibly highlighted. Voice moves it: a nickname ("Falcon"), "next" / "previous", "the blocked one", "number three". Focus is what makes short utterances unambiguous: with Falcon focused, "keep going", "stop", "what happened?", "approve" all have an obvious target. (This is the cockpit's replacement for the ambient intent router — deixis instead of classification.)
- **Command line** — a strip at the bottom showing the live partial transcript, and next to it the **parsed interpretation** ("→ Falcon: follow-up" / "→ new session in ClaudeWhisperer" / "✗ didn't catch that") rendered *before* execution. Serenade's validity signal, made central. Mishears die visibly here, not silently in a session.
- **Dispatch drawer** — speaking a new task pops a draft card (cleaned transcript, repo/model/effort recs, chips) exactly like today's prepared flow; "go" launches, "change repo to X" / "make it Opus" edits by voice, "pile it" parks. The read-back beat is visual, not spoken — faster than ambient mode's countdown.
- **Question cards** — blocked sessions expand their `AskUserQuestion` inline with numbered options; "two" answers. Plan approvals show the digest + "open it" to read.
- **Utterance ledger** — collapsible side rail logging utterance → interpretation → result, with per-row undo/re-route.

**Voice grammar:** verb-first commands over focused/named targets ("stop Falcon", "approve", "retry that", "status") plus free-form dictation wherever a prompt is expected (dispatch drawer, follow-up after "tell Falcon: …"). Command matching can start as the existing string-matched voice-command layer extended with target resolution (nickname/number/focus), with the LLM only cleaning dictation — the full semantic router is *not* required for v1.

**Mic model:** hot while the cockpit view is focused (visible state in the header), off otherwise — no wake words needed, no always-on trust burden, no VAD urgency (utterances can still end on short silence or an explicit "over"/enter-key hybrid). This sidesteps constraints #1–#4 from §2 almost entirely, which is why the cockpit ships before ambient mode.

**Batch verbs** (anti-piling-problem, from §3): "approve all trivial", "launch the pile", "dismiss the done ones", "what needs me?" — the fleet-level operations that make 10 parallel sessions tractable.

**What the cockpit deliberately doesn't do:** read diffs aloud, voice-control settings/navigation chrome, or hold conversations — same scope fences as §4.5. "Show me" opens the normal session view; the cockpit is for conducting, the session view for reading.

**Relationship to ambient mode:** the cockpit builds the fleet snapshot, nicknames, target resolution, dispatch drafts, question answering, and the ledger. Ambient Flow then reuses all of it, adding the persistent capture pipeline, VAD, the full intent router (because no focus ring exists when you're not looking), and TTS. The focus ring even carries over conceptually: ambient mode's "last addressed session" can act as an implicit focus for follow-ups ("also add tests" goes to whoever you last spoke to).

---

## 5. Phasing sketch (each phase independently shippable)

| Phase | Scope | New pieces |
|---|---|---|
| **0. Foundations** | Fix open-mic lifecycle arg bug; re-armable command detection; (for ambient later: VAD via Silero/sherpa-onnx, persistent capture pipeline) | Audio plumbing only — no new UX. Cockpit needs only the first two items |
| **1. Voice answer window** | Blocked-session announcements (chime + overlay/window card with the question, numbered options); wake or auto-arm → speak answer → routed to `AskUserQuestion`/plan approval | Blocked-question surface; answer routing; works with today's wake-word model. See `voice-answer-window-2026-07.md` |
| **2. The Cockpit** (§4.8) | Voice-driven fleet view: fleet board + focus ring + command line with parsed-intent preview; dispatch drawer; nicknames; batch verbs; utterance ledger. Mic hot while view focused — no always-on, no router needed | Fleet snapshot; nicknames; target resolution (nickname/number/focus); dispatch drafts; ledger |
| **3. Ambient Flow** (§4.7) | Mode toggle ("enter flow"); VAD utterance segmentation; full intent router (new LLM feature) over {answer, follow-up, delegate, note, command, discard}; address-first convention; ambient HUD (unified overlay); read-back-with-cancel commits | Router feature; persistent capture; HUD rework — everything else reused from cockpit |
| **4. Standup & steering** | "Status?" briefings (blockers first, in both cockpit and ambient); implicit-focus follow-ups in ambient mode; numbered-picker disambiguation everywhere | Briefing feature; ambient target routing |
| **5. Voice out + extraction** | Local TTS (spoken questions/briefings for away-from-desk); decision/follow-up extraction on session completion; durable decision log; "handle my pile" | TTS subsystem; extraction features; decision store |

Phase 1 is the wedge (highest value-per-effort, validates "agents talk to you"); phase 2 is the first full Flow experience and deliberately precedes ambient mode because eyes-on-screen dissolves the intent-routing, misroute-safety, and mic-trust problems (§1.1).

---

## 6. Open questions

1. **Endpointing quality bar** — is streaming STT + VAD good enough to segment technical speech, or do we need the semantic-VAD tier (Smart Turn v2 style) before Flow feels right? (Latency target: <800 ms from end-of-speech to routed disposition.)
2. **Trust the streaming transcript?** Per-utterance rolling Whisper passes vs. Moonshine-v2-style streaming-as-final. Affects router latency and accuracy.
3. **TTS locality** — Kokoro in the existing Docker pattern seems natural; is spoken output even wanted, or is chime + overlay enough for a desk user? (Probably user-configurable; away-from-desk is where TTS earns it.)
4. **Where does the conductor live?** Frontend store (like smartQueue) is simplest; Rust if the audio pipeline moves there anyway.
5. **Nickname collisions and speakability** — generate from a curated phonetic-friendly word list (Talon's lesson: sharp consonants recognize better)?
6. **Open-office / mute ergonomics** — how prominent does the mute/hold escape hatch need to be? (Research says: very. Ship it in phase 1.)
7. **Does DISCARD speech ever get retained?** Default no (trust line), opt-in "ambient notes to pile" as a separate, clearly-labeled setting.

---

## Appendix: source pointers

- Codebase maps: open mic / recording / realtime pipeline and sessions / LLM layer — see exploration notes in this doc's PR discussion; key files cited inline above.
- Local STT strategy: `docs/local-transcription-research-2026-07.md` (VAD, KWS, Moonshine v2 recommendations).
- External research (mid-2026): Wispr Flow (Backtrack, screenshot scandal), Superwhisper (modes), Aqua Voice (edit-router, v2 command walk-back), Talon/Serenade (correction UX, validity signals), Spokenly/VoiceMode (agent-initiated voice via MCP), Omnara/AgentsRoom (blocking-question latency, red-status ping), Devin managed-Devins (coordinator digest), Cursor 3 agents window (verification artifacts), ChatGPT AVM / Gemini Live endpointing regressions, LiveKit/Pipecat turn-detection, Plaud/Bee/Granola intentional capture, Otter/Fireflies consent lawsuits, Alexa post-mortem.
