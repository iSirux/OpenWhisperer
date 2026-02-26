# Non-Interrupting Message Queue Implementation

## Goal

Make prompt submission non-destructive while a response is in progress:

- Do **not** interrupt active work when a new user prompt arrives.
- Queue/append new input so it is processed in-order.
- Interrupt only on explicit user stop.

This should apply to:

1. OpenAI Codex app-server mode (`turn/steer` for active turn)
2. Claude SDK mode (queue prompts while query is in-flight)

---

## Current Status

### OpenAI app-server mode

This repo now has steer-first behavior implemented:

- File: `src-tauri/sidecar/src/index.ts`
- If `session.appServerTurnId` exists, send `turn/steer` with `expectedTurnId`.
- Fallback to `turn/start` if steer fails.

Relevant lines (approx):

- input builder helper: `buildCodexAppServerInputItems(...)`
- steer path inside `handleQuery(...)` openai/app_server branch

### Claude SDK mode

Still preempts active work:

- `handleQuery(...)` checks `session.queryIterator` and calls `interrupt()` before starting next query.
- This causes new user prompt to cancel in-progress generation.

---

## Reference Pattern (from `F:\Repos\opencode`)

Use the same model as `opencode` session loop:

- Keep a per-session "busy + callbacks queue" state.
- If loop is running, append new user message and queue callback/promise.
- Running loop continues and naturally consumes next queued user message.
- Only explicit abort cancels the active loop.

Reference file:

- `F:\Repos\opencode\packages\opencode\src\session\prompt.ts`

Key areas:

- queue state with `callbacks`
- `loop(...)` returns queued promise when already busy
- queued prompts are persisted and processed in order

---

## Required Changes In This Repo

## 1) Add per-session Claude prompt queue state

File: `src-tauri/sidecar/src/index.ts`

Extend `Session` with fields like:

- `claudeQueue: QueuedPrompt[]`
- `claudeProcessing: boolean`

Suggested queued item shape:

- `queryId: string`
- `prompt: string`
- `images?: ImageData[]`

Do **not** store callbacks unless needed; frontend already receives streamed events by session id.

## 2) Replace interrupt-on-new-prompt behavior for Claude

File: `src-tauri/sidecar/src/index.ts`, function `handleQuery(...)`

Current behavior to remove (Claude branch):

- If `session.queryIterator` exists -> call `interrupt()`.

New behavior:

1. Append the incoming prompt to `claudeQueue`.
2. If `claudeProcessing` is false, start a queue worker.
3. Queue worker processes one item at a time by invoking existing Claude query flow.
4. When one completes, pop next and continue.

Important:

- Keep streaming output unchanged.
- Keep `sendDone(id)` per processed prompt item.
- Preserve stop/error semantics per item.

## 3) Isolate existing Claude execution into a single-item runner

Refactor existing Claude branch in `handleQuery(...)` into helper:

- `runClaudeQueryItem(session, msgLike, queryId): Promise<void>`

This avoids logic duplication and makes queue worker simple.

## 4) Stop behavior for Claude

File: `src-tauri/sidecar/src/index.ts`, function `handleStop(...)`

When user stops:

1. Interrupt active `queryIterator` (existing behavior).
2. Clear pending `claudeQueue` items.
3. Reset `claudeProcessing = false` only after active run settles.

Decide and document whether cleared queued items emit:

- no events, or
- one synthetic `error/stopped` per dropped item.

Prefer: silent drop + one debug log line.

## 5) Close behavior for Claude

File: `src-tauri/sidecar/src/index.ts`, function `handleClose(...)`

On close:

- Clear pending queue items.
- Abort active query if present.
- Ensure no worker continues after session deletion.

---

## Invariants

1. At most one active Claude query execution per session.
2. Submitting prompt N+1 while N is running must not interrupt N.
3. Prompts are processed FIFO.
4. `stop` interrupts active run and clears queued runs.
5. `close` fully tears down active + queued work.

---

## Suggested Logging

Add debug logs:

- queue enqueue/dequeue with lengths
- worker start/idle transitions
- stop/close queue clear counts

Examples:

- `[claude queue] enqueue len=2 queryId=...`
- `[claude queue] start processing queryId=...`
- `[claude queue] completed queryId=... remaining=1`
- `[claude queue] cleared pending=3 due to stop`

---

## Verification Checklist

1. Start Claude session; submit prompt A.
2. While A is generating, submit prompt B.
3. Confirm A continues uninterrupted.
4. Confirm B starts only after A done.
5. Submit A/B/C quickly; verify FIFO processing.
6. During A, submit B/C then press stop:
   - A interrupted
   - B/C cleared
   - no stale done from dropped items
7. Repeat in OpenAI app-server mode:
   - second prompt during active turn uses `turn/steer`
   - no forced interrupt unless explicit stop

---

## Risks / Edge Cases

1. `currentQueryId` race handling:
   - existing stale-done guards are built around preemption.
   - recheck logic so queued executions do not suppress valid done events.
2. Image handling:
   - queued image payloads should preserve order and survive async delay.
3. System prompt behavior:
   - keep one-time system prompt prepend behavior on first actual query only.

---

## Optional Enhancement

Mirror `opencode` UX hinting:

- mark queued user messages in UI (e.g., "Queued") until execution starts.
- not required for backend correctness.

