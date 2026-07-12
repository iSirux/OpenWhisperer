# Session Mining: Voice→Prompt Pipeline Quality (2026-07-12)

Findings from all 1,545 archived prompts, ~30 full sessions, `debug-recordings.json` (20 recent recordings with whisper/realtime/cleaned/corrections stages), and the relevant source (`llm/features.rs`, `utils/llm.ts`, `utils/voiceCommands.ts`).

Headline: the biggest wins are in **LLM cleanup quality** (it both drops content and *adds/duplicates* filler), the **cleanup vocabulary list** (missing high-frequency mangled terms), and **Whisper truncation that realtime already caught**. Voice-command leakage is a non-problem. The richest data source is `debug-recordings.json` — and it's losing data (see #7).

## Ranked opportunities

### 1. Cleanup ADDS and DUPLICATES filler when merging dual sources
The dual-source merge imports disfluencies from the realtime track and can double them:
- debug #7: Whisper `"Everything sounds good. Let's write it to a document..."`; realtime prepended `"Yeah."`. Cleaned output: `"Yeah. Yeah, everything sounds good..."` — corrections literally say *'Added filler "Yeah. Yeah," from Vosk transcription'*.
- debug #6: corrections include *"Inserted phrase 'be able to' for clarity"* — insertion despite the prompt forbidding it.

Root cause: `features.rs:238` says "Preserve ALL content" (added to stop clause-dropping) with no counter-instruction to strip filler or dedupe phrases present in both sources. **Fix:** add "remove speech disfluencies/filler; never duplicate a phrase that appears in both transcriptions" + an anti-insertion guard.

### 2. Cleanup DROPS trailing clauses / self-corrections (patched for one example, still a live mode)
Session `0b31b253`: user said `"Looks like we still don't clean up here. or doesn't it show here?"`, got only the first sentence — *"it deleted the whole 2nd part."* That exact phrasing is now hard-coded as the example in the cleanup prompt, so it's patched for that case only. **Fix:** regression suite with varied phrasings, not one memorized example.

### 3. Cleanup vocabulary missing the most-mangled terms
`BASE_CLEANUP_VOCABULARY` (`utils/llm.ts:245`) has only 11 entries. Real mangling of unlisted terms:
- "LLM" → "LLC" / "LLLM" (debug #13, #17)
- "webhook" → "web book" (debug #8; saved only because realtime had it right)
- "CRMs" silently dropped by Whisper (debug #8)
- "Vosk" → "Vusk" (debug #14)
- "Notion Skill" → "notion scale" (debug #6 — cleanup even "corrected" realtime's correct "Skill" to the wrong "scale")

**Fix:** add LLM, Tauri, Svelte, Codex, Whisper, Vosk, realtime, webhook, CRM, Notion, Skill, sidecar, kanban, TypeScript, GitHub, Gemini, Groq, Moonshine, sherpa-onnx.

### 4. "worktree" leaks as "work tree" despite being in the vocab
7 archived prompts contain the split form (`ebfe51a8`: "when we create a new **work tree** in a session…"; `0ba534a6`, `68a02139`). The phonetic-substitution instruction doesn't reliably join two-word splits. **Fix:** explicit "join split forms ('work tree' → 'worktree', 'sub agent' → 'subagent', 'type script' → 'typescript')" guidance, or space-insensitive vocab post-processing.

### 5. Whisper truncates mid-sentence; realtime had the full utterance
- debug #18: Whisper ends `"...when the agent session session"` (truncated + duplicated word); realtime had the complete `"...isn't actually done when using sub-agents and stuff."`
- debug #3: the reverse — realtime truncated, Whisper full. Each engine truncates unpredictably.
- Session `1c2033fd` U14: user directly reports *"the toolbar live transcript showed the correct text, but my recorded transcription was cut off."*

The merge prompt already says "prefer the more complete as base" but debug #18's cleaned output was empty — unclear it fires. **Fix:** verify completeness-preference works; detect/repair duplicated word runs ("session session").

### 6. Silence/muted mic produces junk sessions
- Session `0b31b253`: muted recording → Whisper hallucinated `"you're here"` (user: *"nvm i accidentally muted for this recording"*).
- **8 prompts are just `"."`**, 25 total junk (`hi`/`test`/`.`), 6 null-prompt sessions — accidental recordings that spawned real archived sessions (`90b76c51`, `37da766e`, `db634bf0`).

**Fix:** empty-audio guard (energy threshold or Whisper no-speech probability); route near-empty transcriptions to the pile/discard; treat lone punctuation as empty.

### 7. Recordings log loses the cleaned transcript on most paths
13 of 20 `debug-recordings.json` entries have empty `cleanedTranscript` (all with `destination: ""`); entries with `destination: append|session` carry it. The user already flagged this in a session (debug #13: *"the recordings log don't always get the cleanup transcript from the LLM, investigate and fix all paths"*). This log is the ONLY place original-vs-cleaned pairs exist, and only 20 are retained. **Fix:** log cleanup output on every path; consider larger/exportable retention for quality analysis.

### 8. Re-dictation rate argues for edit-before-send on low confidence
136 short correction messages found; a meaningful slice are re-dictations because the first prompt didn't land as spoken:
- `1958cc29`: *"no, **i said** use same styling as qual results"*
- The identical duplicated-phrase artifact *"...in that repository in that repository..."* was sent verbatim in TWO sessions (`e61c0412`, `c6ab8fed`) — cleanup didn't dedupe.

With unfocused auto-send, truncation/duplication/junk (#1, #5, #6) go out with no review. **Fix:** brief editable preview, or default to "prepare" mode for long/low-confidence transcriptions.

## Already good — don't touch

- **Voice-command leakage: zero** trigger phrases ("go go", "send it", "paste it", "pile it") leaked into any of 1,545 prompts. `voiceCommands.ts` normalization + trailing-only matching works.
- **Listed vocab terms** (Claude/Opus/subagent/Playwright…) show no mangling — the vocab bias works; it just needs more entries.
- **Swedish**: appears in 31 prompts but nearly all intentionally quoted content (Notion titles, Slack messages), not ASR bleed.
