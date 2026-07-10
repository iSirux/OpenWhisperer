# Voice Answer Window — side-feature brainstorm (2026-07)

> **Status: tabled (2026-07-08).** The Cockpit (`flow-mode-brainstorm-2026-07.md` §4.8) ships first; this doc is kept as the design for a later phase.

A standalone feature extracted from the Flow-mode brainstorm (`flow-mode-brainstorm-2026-07.md`, §4.2 loop 1): capture agents' blocking question calls and surface them in a **separate always-on-top window** (like the recording overlay), so the user can answer by voice — open-mic style, single utterance — **without tabbing out of whatever app they're in**.

This is the "unblock loop" as a product of its own. It needs none of the Flow conductor/intent-router machinery, and everything it builds (the window, the answer routing, spoken option picking) is reused by Flow later.

---

## Why this works as a standalone

- **The hooks already exist.** The sidecar's `canUseTool` interception of `AskUserQuestion` and `ExitPlanMode` genuinely *blocks* the agent and hands us the structured payload; the frontend already stores `askUserQuestion` / `pendingPlanApproval` on the session and has `submitAskUserAnswers` / `approvePlan` / `rejectPlan` to feed answers back. Today those only render inside the main window's session view — the agent sits blocked until the user tabs in and notices.
- **The window pattern exists.** The recording overlay is already a separate transparent always-on-top Tauri WebviewWindow synced via events. This is a second instance of the same pattern.
- **The voice plumbing exists.** Open mic (wake detection), realtime STT sessions, and `approve`/`reject` voice-command presets are all live code.
- **It attacks the right metric.** Blocking-question latency is the north-star for agent supervision (Omnara's whole pitch; AgentsRoom's "red = waiting on you"). Answering in 5 seconds instead of 20 minutes is the single biggest throughput win for a multi-session user.

## UX flow

1. A session hits `AskUserQuestion` (or `ExitPlanMode`). Distinct chime plays (≠ done-chime, ≠ recording chime).
2. The **answer window** slides in at a screen edge (position/persistence like the overlay): session name/nickname + model badge, the question text, and — because `AskUserQuestion` carries structured options — the options rendered as a **numbered list**.
3. The mic arms for an **answer window** (e.g. 8–15 s, configurable), indicated by a clear listening state. Two arming variants (setting):
   - **Auto-arm** — mic opens immediately on question arrival (true hands-free; best with headset/solo office).
   - **Wake-arm** — window shows but mic waits for the wake word or hotkey (safe default; no false accepts from a phone call).
4. The user speaks:
   - **"one" / "the second one" / option keyword** → picks that option (numbered pickers beat re-dictation; matching an option label keyword also works since options are short).
   - **Free-form utterance** → sent as the custom answer text (AskUserQuestion supports "Other").
   - **"approve" / "reject"** → plan approval verdicts (already existing voice-command presets).
   - **"skip" / "later"** → window dismisses, question stays pending on the session (badge in main window), agent stays blocked.
   - **"show me" / "open it"** → focuses the main window on that session (the escape hatch to screen for anything that needs reading, e.g. a full plan).
5. **Read-back beat before submit** for consequential answers: the chosen option flashes with a ~1.5 s cancel window ("Picked: *pin the version* — say cancel"). Trivial multiple-choice can submit instantly (risk-tiered, per the research).
6. Answer routes through the existing callbacks; window shows a brief confirmation ("→ sent to Falcon") and slides out. Agent resumes immediately.

### Multiple blocked sessions

Questions queue in the window, **blockers-first is trivial here since everything is a blocker — order by urgency (`interactionUrgency` where available) then age**. Header shows "1 of 3"; "next" / "skip" advances. Never stack multiple windows.

### Timeout / no answer

If the answer window lapses with no speech: window collapses to a small persistent **badge chip** (count of waiting questions) rather than disappearing — the agent is still blocked and the user must eventually see it. Optional OS notification on timeout for minimized/fullscreen cases.

### Plan approvals (`ExitPlanMode`)

Plans are long — don't render the whole plan in a floating window. Show the plan's title/first heading + "N steps"; voice verbs: "approve", "reject", "open it" (focus main window to read). Optionally run the plan through the existing LLM layer for a one-sentence digest ("Wants to refactor auth into 3 modules, touches 12 files") — cheap, and makes voice-only approval actually informed.

## States

`hidden → announcing (chime + slide-in) → armed/listening → heard (read-back, cancelable) → submitting → confirmed → hidden`
plus `parked` (badge chip after timeout) and `queued (1 of N)`.

## Reuse / touchpoints

- New WebviewWindow (clone of overlay setup in `tauri.conf.json` + a `answer-window` route) or — simpler v1 — a new **mode of the existing overlay window** (`OverlayMode = 'question'`), since overlay already has mode plumbing and position persistence. Start there; split into its own window only if simultaneous recording+question display is needed.
- Mic: reuse the open-mic capture path with a dedicated realtime session id (`answer_capture`); it's the same "listen for one utterance" shape as wake detection, but with the utterance routed to the question instead of matched against wake words. (Flow's persistent-capture work later replaces this.)
- Answer routing: `submitAskUserAnswers`, `approvePlan`, existing approve/reject voice commands.
- Interaction metadata: `analyzeInteractionNeeded` urgency for queue ordering (nice-to-have).

## Risks / design guards

- **False accepts** while the user is talking to a human → wake-arm default, auto-arm opt-in; read-back cancel beat on submissions; hard mute always visible on the window.
- **Silent misroute** (utterance matched to wrong option) → always display what was heard *and* what was picked before submit (Serenade's validity-signal lesson).
- **Interrupting deep work is a cost too** — the whole point is *less* disruption than tabbing out, so: no focus stealing (window never takes keyboard focus), chime volume setting, DND toggle ("quiet mode" parks everything to the badge).
- **Whisper vs realtime transcript for the answer**: answers are short; realtime STT alone is probably fine (latency matters more than perfection here), with the batch pass as an accuracy option. Worth an A/B during dogfooding.

## Open questions

1. Overlay-mode v1 vs separate window — does a question ever need to show *while* recording is in progress? (Probably yes eventually → separate window; but v1 as overlay mode ships faster.)
2. Should the question be **spoken** (TTS) for away-from-desk? Fits the Flow phase-4 TTS work; v1 is chime + visual.
3. Auto-arm safety: require headset/audio-device heuristic, or just leave it as an explicit setting?
4. Do we announce *non-blocking* events here too (session done, needs-review)? Recommendation: no — keep this window strictly for blockers; done-triage belongs to Flow's standup loop. One purpose per surface.
