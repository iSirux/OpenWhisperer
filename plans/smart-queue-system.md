# Feature: Smart Queue System

> **Status: implemented** (2026-07-04). All phases built. `cargo check`, sidecar build, and whole-project `svelte-check` pass with no new errors (3 remaining errors are pre-existing and unrelated: `vite.config.js` fs types, `+layout.svelte` openMicLifecycle arg-count, `sessions-view/+page.svelte` transformToDisplaySessions arg-count). Runtime end-to-end verification (actually hitting a rate limit / crossing a window) still pending — see Testing.

## Overview

When a provider's usage hits its rate limit (100% utilization), OpenWhisperer should stop failing and start **deferring**. New launches (recording sessions, pile items, Notion Kanban cards) and follow-up prompts get parked in a **queued** state in the session list and are dispatched automatically once the usage window resets (5-hour rolling or weekly, whichever is exhausted), with optional fuzzy delays to avoid a thundering-herd burst. Sessions that hit the limit *mid-run* are caught, kept alive in a recoverable **rate-limited** state, and can continue in-session — automatically at reset or manually.

This stands on two things that already exist: the `rateLimits` store (`five_hour`/`seven_day` `utilization` + `resets_at`, per provider) and the `prepared` session pattern (a fully-configured session that sits in the list and launches later via `launchPrepared`). A queued session is essentially a prepared session with an automatic launcher.

## Requirements (from user)

- **Trigger:** queue when the relevant provider window is at **100% utilization** (hardcoded, not configurable).
- **Sources queued:** new sessions, pile items, Notion Kanban items, **and follow-up prompts** to existing sessions.
- **Auto-start:** dispatch queued work automatically after the window resets (5-hour or weekly, per which window is exhausted).
- **Fuzzy delays (both optional, default on):**
  - a "couple of minutes" delay after reset before the first dispatch;
  - a delay between successive dispatches.
- **Mid-run rate limiting:** catch the SDK's rate-limit event; keep the session recoverable; let the user continue in-session (auto at reset or manual).
- **Master toggle:** optional feature, **default on**.
- **Sound:** play a new sound when a window resets and the first queued session is dispatched.
- **Queue indicator:** show queue status (count + next reset) in the header.
- **Schedule for next window:** from the prepare / new-session view, launch **now** or schedule for the **next 5h** or **next 7d** reset (even when not rate-limited) — fire-and-forget for the next usage window, reusing the same driver + fuzzy delays.

## Decisions Made

| Decision | Choice | Reasoning |
|---|---|---|
| Queue threshold | Hardcoded 100% utilization | User directive; simplest, matches "hard limit reached" |
| Queued state model | Reuse the `prepared` session pattern + `queueInfo` | Avoids inventing storage; `launchPrepared` already dispatches |
| Follow-up / mid-run waiting state | `rateLimited` turn-pending state on the live session | A pending turn to re-send; distinct from a never-launched queued session |
| Drain trigger | Live re-evaluation off the existing 3-min `rateLimits` poll + app-startup check | Self-heals across app restart / sleep; no fragile multi-day `setTimeout` |
| Mid-run detection | Wire the SDK `SDKRateLimitEvent` through the sidecar (+ error-string fallback) | Event carries `status: "rejected"` and `resetsAt`; currently dropped |
| Provider scope | Queue keyed by provider (Claude vs Codex) | Each waits on its own limits; two independent rate-limit stores exist |
| Smart pacing across windows | **Out of scope** (skipped) | User deferred; a re-rejection mid-drain naturally re-queues the rest |
| Provider failover | **Out of scope** | User deferred |

## Alternatives Considered

- **Fixed `setTimeout(resets_at - now)` per queued session** — rejected: weekly resets are ~7 days, won't survive sleep/restart. Drain off live poll data instead.
- **Gate only at the universal `sendPrompt` choke point** — rejected as the *primary* gate: it also handles every continuation turn and is deep/async. Used only for the deliberate follow-up-queueing path; first-launch gating happens one level up.
- **A separate queue panel UI** — rejected: user wants queued items in the session list (consistent with the `prepared` precedent).
- **Configurable threshold** — rejected per user (hardcoded 100%).

---

## Architecture at a glance

```
Launch / send requested
   │
   ├─ First launch (pile / notion / recording / prepared)
   │     shouldQueue(provider)?  → status:'queued' (+ prepared fields + queueInfo)
   │
   └─ Follow-up prompt (sendPrompt) OR mid-run SDK rejection
         shouldQueue(provider) / rate_limit_event → rateLimited turn-pending state

Drain driver (smartQueue.ts), ticks on rateLimits poll (~3 min) + app startup:
   for each provider whose exhausted window has reset (util < 100 or now > resets_at):
     wait fuzzy "after reset" delay (default ~2–4 min)
     play reset sound on first dispatch
     FIFO over that provider's queued + rateLimited sessions:
       queued     → launchPrepared(id)
       rateLimited→ re-send the stashed turn via sendPrompt(id, prompt, images)
       fuzzy "between runs" delay between each
     (if a dispatch is re-rejected, it re-enters rateLimited → rolls to next reset)
```

Two waiting shapes, one driver:
- **`status: 'queued'`** — never-launched session; dispatched with `launchPrepared`.
- **`rateLimited` state** — a live session with a pending turn to re-send; covers both mid-run rejection and proactively-queued follow-ups.

---

## Implementation Plan

### Phase 0 — Configuration (`QueueConfig`)

Follow the `OpenMicConfig` pattern (`src-tauri/src/config.rs:1046-1076`). **Bools default to `true`**, so use a `default_true` helper (one already exists at `config.rs:1256`), never bare `#[serde(default)]`.

- [ ] `src-tauri/src/config.rs`: add `QueueConfig` struct + `impl Default`:
  - `enabled: bool` (default **true**)
  - `fuzzy_delay_after_reset: bool` (default **true**)
  - `fuzzy_delay_after_reset_min_secs: u32` (default `120`)
  - `fuzzy_delay_after_reset_max_secs: u32` (default `240`)
  - `fuzzy_delay_between_runs: bool` (default **true**)
  - `fuzzy_delay_between_runs_min_secs: u32` (default `10`)
  - `fuzzy_delay_between_runs_max_secs: u32` (default `45`)
- [ ] Add `#[serde(default)] pub queue: QueueConfig,` to `AppConfig` (near `config.rs:1699`) and `queue: QueueConfig::default(),` to its `Default` impl (near `config.rs:2017`).
- [ ] `src/lib/stores/settings.ts`: mirror `interface QueueConfig`, add `queue: QueueConfig;` to `AppConfig` (near `:514`), add the `queue: {...}` default object to `defaultConfig` (near `:729`) matching the Rust defaults.
- [ ] No changes to `settings_cmds.rs` / `lib.rs` — `get_config`/`save_config` are generic over `AppConfig`.

### Phase 1 — Mid-run rate-limit event wiring (sidecar → Rust → frontend)

Today the SDK's `rate_limit_event` is silently dropped at the `default` branch of `handleSdkMessage` (`src-tauri/sidecar/src/index.ts:~4699`), and errors are opaque strings.

- [ ] `src-tauri/sidecar/src/index.ts`:
  - [ ] Add a new emitter `sendRateLimit(id, { status, resetsAt, utilization })` alongside `sendError` (`:726`): `send({ type: "rate_limit", id, status, resetsAt, utilization })`.
  - [ ] Add `case "rate_limit_event":` in `handleSdkMessage`. Read `msg.rate_limit_info.{status, resetsAt, utilization}`. On `status === "rejected"` (optionally also `"allowed_warning"` for a soft heads-up) call `sendRateLimit`.
  - [ ] Also inspect the assistant `error: 'rate_limit'` subtype (`SDKAssistantMessage.error`) and the query-loop `catch` (`:~4233`): classify 429 / rate-limit / billing-error error strings and route to `sendRateLimit` (fallback when no explicit event fires). Keep sending the normal error too if we can't classify.
- [ ] `src-tauri/src/sidecar.rs`:
  - [ ] Add `InboundMessage::RateLimit { id: String, status: String, #[serde(rename = "resetsAt")] resets_at: Option<f64>, utilization: Option<f64> }` to the enum (`:157`).
  - [ ] Handle it in the emit loop (next to `InboundMessage::Error` at `:742`): `app.emit(&format!("sdk-rate-limit-{}", id), payload)`.
- [ ] `src/lib/stores/sdkSessions.ts` (`setupEventListeners`, near the `sdk-error-${id}` listener at `:999`):
  - [ ] Add `listen('sdk-rate-limit-${id}')` → set the session's `rateLimited` state (see Phase 5), stash the in-flight prompt/images so it can be re-sent, set smart status `rate_limited`, and notify the drain driver.

### Phase 2 — `queued` session state + persistence

- [ ] `src/lib/stores/sdkSessions.ts`:
  - [ ] Add `'queued'` to the `status` union (`:316`).
  - [ ] Add `queueInfo?: QueueInfo | null` and `rateLimited?: RateLimitedState | null` to the `SdkSession` interface. Shapes:
    - `QueueInfo = { reason: 'rate_limit' | 'scheduled'; provider: SdkProvider; window?: '5h' | '7d'; queuedAt: number; targetStartAt?: number /* ms, snapshot of resets_at for display */ }`
    - `RateLimitedState = { reason: 'rate_limit' | 'scheduled'; provider: SdkProvider; window?: '5h' | '7d'; resetsAt?: number; targetStartAt?: number; prompt: string; images?: SdkImageContent[]; queuedAt: number }` — a pending turn on a *live* session. `reason:'rate_limit'` fires when the window resets; `reason:'scheduled'` fires when `now > targetStartAt` (the send-button "send on next reset" feature, Phase 11).
  - [ ] Store the queued prompt on the existing **`preparedPrompt`/`preparedChips`/`preparedSystemPrompt`** fields so `launchPrepared` works unchanged.
- [ ] Persistence (`src/lib/stores/sessionPersistence.ts`):
  - [ ] `queueInfo` and `rateLimited` are plain-serializable; do **not** add them to `NON_PERSISTABLE_FIELDS`. Add transient `inFlightPrompt`/`inFlightImages` (used to recover a mid-run turn) TO `NON_PERSISTABLE_FIELDS`.
  - [ ] `persistedToSdkSession` (`:322`) leaves `queued` intact (the `querying → idle` fixup only touches `querying`; `queued` isn't in the `isPending` branch — correct).
- [ ] **Rust persistence (required — the frontend auto-persist does NOT round-trip through the typed Rust struct).** `PersistedSdkSession` (`src-tauri/src/session_persistence.rs:187`, `rename_all = "camelCase"`) is a strict typed mirror; unknown fields are silently dropped on save. Add (done):
  ```rust
  #[serde(default)] pub queue_info: Option<serde_json::Value>,   // → queueInfo
  #[serde(default)] pub rate_limited: Option<serde_json::Value>, // → rateLimited
  ```

### Phase 3 — Launch-time interception (first launches)

Add a detection helper and gate the two clean launch-level entry points (not `sendPrompt`).

- [ ] New helper module `src/lib/stores/queueDetection.ts` (kept separate from the driver to avoid a circular import — it reads **only** `rateLimits` + `settings`, never `sdkSessions`): `providerExhaustion(provider): { exhausted: boolean; window?: '5h'|'7d'; resetsAt?: number }` reading `rateLimitData` (Claude) / `codexRateLimitData` (Codex), threshold **>= 100** on either window; when both exhausted, pick the later `resets_at`. `shouldQueue(provider) = settings.queue.enabled && providerExhaustion(provider).exhausted`. Also export `nextWindowResetAt(provider, window: '5h'|'7d'): number | undefined` for the scheduling feature (Phase 10). `sdkSessions.ts` imports from here; `smartQueue.ts` (the driver, which *does* import `sdkSessions`) also imports from here.
- [ ] Gate `startSetupSession` (`sdkSessions.ts:2153`) — covers pile + notion + setup view: if `shouldQueue(provider)`, transition to `status:'queued'` with `queueInfo` and prepared fields instead of `initializing`. (Pile/notion already flow through `launchSession` → `startSetupSession`.)
- [ ] Gate `initializeSession` (`sdkSessions.ts:2578`) — covers recording sends, prepared launches, approval, repo-selection: same detour to `queued`.
- [ ] Confirm no source bypasses these two. (`launchPrepared` calls `initializeSession`; recording sends go through `initializeSession`/`completePendingTranscription`.)

### Phase 4 — The drain driver (`src/lib/stores/smartQueue.ts`)

A single global module owning detection + draining. No per-component queues for the queued path.

- [ ] Subscribe to `rateLimitData` and `codexRateLimitData` (they poll every ~3 min with backoff already).
- [ ] Track per-provider "was exhausted" edge. When a window that was exhausted is now `utilization < 100` **or** `now > snapshot resets_at`, trigger `drain(provider)`.
- [ ] Also run `evaluateAll()` once on app startup, after `loadSessionsFromDisk`, so queued/rate-limited sessions restored from disk whose reset already passed dispatch immediately.
- [ ] `drain(provider)`:
  - [ ] Single in-flight guard per provider (ignore repeated store ticks while draining).
  - [ ] Apply the "after reset" fuzzy delay (default 120–240s, `Math.random()` in range) if enabled.
  - [ ] Gather that provider's sessions where `status==='queued'` or `rateLimited != null`, FIFO by `queuedAt`.
  - [ ] On the **first** dispatch, play the reset sound (Phase 8).
  - [ ] Dispatch each:
    - `queued` → `launchPrepared(id)`.
    - `rateLimited` → clear `rateLimited`, re-send via `sendPrompt(id, rl.prompt, rl.images)`.
  - [ ] Apply the "between runs" fuzzy delay (default 10–45s) between dispatches if enabled.
  - [ ] If a re-sent turn is rejected again, the Phase 5 handler re-marks it `rateLimited`; remaining items naturally roll to the next reset (this is the graceful degradation in lieu of smart pacing).
- [ ] Expose derived stores for the UI: `queuedCount`, `nextResetAt`, `isDraining` (Phase 7).
- [ ] Instantiate the driver once at app init (e.g. in `+layout.svelte` alongside the existing rate-limit auto-refresh start).

Note: app-runtime code may use `Math.random()`/`Date.now()` freely (the workflow-script restriction does not apply here).

### Phase 5 — Mid-run rate-limited state + in-session continue

- [ ] `sdkSessions.ts`: when `sdk-rate-limit-${id}` (rejected) fires for a live session, set `rateLimited` with `resetsAt` (from event, epoch→ms) and the in-flight turn's prompt/images; keep the session alive (do **not** set `status:'error'`). Derive smart status `rate_limited`.
- [ ] `src/lib/components/sdk/RateLimitBanner.svelte` — model on `ContextOverflowBanner.svelte`:
  - Message: "Rate limit reached — resets in {countdown}" with the window (5h/weekly).
  - Auto-continue note ("will continue automatically when the window resets") when `settings.queue.enabled`.
  - **Continue now** button → clears `rateLimited` and re-sends the stashed turn (`sendPrompt`); if still exhausted it simply re-queues.
  - **Dismiss** (leave as-is / treat as error) option.
- [ ] Render the banner in the SDK session view where `ContextOverflowBanner` is rendered.
- [ ] The Phase 4 driver auto-continues these at reset (same path as Continue-now).

### Phase 6 — Follow-up prompt queueing

Proactively queue follow-up turns to existing sessions instead of erroring.

- [ ] In `sendPrompt` (`sdkSessions.ts:1768`): before `invoke('send_sdk_prompt', …)` (`:1852`), if `shouldQueue(session.provider)`, do **not** invoke — instead set the `rateLimited` state with this prompt/images (reuses the Phase 5 state and the Phase 4 driver). Keep the user message already pushed to the transcript, and surface the banner. This unifies the reactive (mid-run) and proactive (follow-up) waiting paths.

### Phase 7 — UI: session list + header indicator

- [ ] `getSdkSmartStatus` (`src/lib/composables/useDisplaySessions.svelte.ts:38`): early-return `{ status: 'queued' }` (mirror the `prepared` branch at `:78`); derive `{ status: 'rate_limited' }` when `rateLimited != null`.
- [ ] `src/lib/utils/sessionStatus.ts`: add `queued` and `rate_limited` to `getStatusColor` (`:47`), `getStatusBgColor` (`:97`), `getStatusLabel` (`:247`), and `getStatusSortOrder` (`:352`, e.g. `queued` ≈ -0.4 just after `prepared`); ensure neither is in `isFinishedStatus` (`:344`).
- [ ] `src/lib/components/SessionListItem.svelte` (near the prepared badge at `:181`): add a `queued` badge with a live countdown to `queueInfo.targetStartAt`, and a `rate_limited` badge.
- [ ] `src/routes/(main)/settings/../+page.svelte` main-view routing (`:307`): route a `queued` session to a small view (reuse the prepared/`SessionPendingView` shape) with **Run now** (`launchPrepared`) and **Remove from queue** (delete/convert back to prepared) plus countdown + which window.
- [ ] `src/lib/components/QueueIndicator.svelte` — header indicator next to `RateLimitIndicator`: shows queued count and next reset (`formatTimeRemaining`); click reveals/scrolls to queued sessions. Only visible when `queuedCount > 0`.
- [ ] Wire `QueueIndicator` into `AppHeader.svelte`.

### Phase 8 — Reset sound

- [ ] Add a sound asset (e.g. `static/sounds/queue-resume.*`).
- [ ] Extend `src/lib/utils/sound.ts` with a `playQueueResume()` (mirror the existing completion-sound helper).
- [ ] Call it from `drain()` on the first dispatch of a reset cycle (Phase 4).

### Phase 9 — Settings tab

- [ ] `src/lib/components/settings/QueueTab.svelte` — bind `$settings.queue.*` (copy the toggle block from `GeneralTab.svelte:143-157`, `import "./toggle.css"`): master enable, "delay after reset" toggle + min/max seconds, "delay between runs" toggle + min/max seconds. Brief explainer that queued work waits for the usage window to reset.
- [ ] Export from `src/lib/components/settings/index.ts`.
- [ ] Register in the settings page (`+page.svelte`): import, add a `tabs` entry (`{ id: "queue", label: "Smart Queue" }`), add an `{:else if activeTab === "queue"}<QueueTab />` branch.

### Phase 10 — Schedule for next window ("fire and forget for the next window")

A **first-class** feature (not just a stretch): from the prepare / new-session view the user can choose to launch **now**, or schedule the launch for the **next 5h reset** or the **next 7d reset**, even when *not* currently rate-limited. This lets the user batch up work for the next usage window and walk away. It reuses the exact same `queued` state, driver, fuzzy delays, sound, and queue indicator.

Data model (already defined in Phase 2): `QueueInfo.reason: 'scheduled'`, `window: '5h' | '7d'`, `targetStartAt` = snapshot of that window's `resets_at` (via `nextWindowResetAt(provider, window)` from `queueDetection.ts`). Because `targetStartAt` is a snapshot, drift is absorbed by the after-reset fuzzy delay.

- [ ] `queueDetection.ts`: `nextWindowResetAt(provider, window)` returns the live `resets_at` (ms) for the chosen window from the provider's rate-limit store.
- [ ] Driver (`smartQueue.ts`): `evaluateAll()`/tick also dispatches any `queued` session whose `queueInfo.reason === 'scheduled'` once `now > targetStartAt` — **independent of rate-limit state** (a scheduled session fires at its window boundary whether or not the window was exhausted). Same after-reset + between-runs fuzzy delays, same reset sound, same FIFO ordering as rate-limit draining. If the provider happens to still be exhausted at that moment, it stays queued and rolls forward (consistent with the rest of the driver).
- [ ] A shared helper `scheduleForWindow(sessionId, window)` on the `sdkSessions` store: takes a `prepared` (or setup-with-draft) session, resolves `targetStartAt` via `nextWindowResetAt`, and transitions it to `status:'queued'` with `queueInfo = { reason:'scheduled', provider, window, queuedAt, targetStartAt }` (keeping the prepared prompt/chips/systemPrompt so `launchPrepared` dispatches it). "Unschedule" reverts to `prepared`.
- [ ] **UI — prepared session view** (the main-pane prepared view; the same place the existing **Launch** button lives, wired via `handleLaunchPrepared` → `launchPrepared` in `+layout.svelte`): add a split-button / dropdown next to Launch — "Launch now" | "Schedule → Next 5h reset (in {countdown})" | "Schedule → Next 7d reset (in {countdown})". Selecting a schedule calls `scheduleForWindow`. Countdown labels use `formatTimeRemaining(nextWindowResetAt(...))`.
- [ ] **UI — new session / recording-prepare flow:** where a recording is turned into a `prepared` session (the `prepare` `RecordAndSendAction` path and the setup/new-session compose UI), expose the same "Schedule for next window" option so a fresh recording can be fired-and-forgotten. Simplest: reuse the prepared-view control by routing "prepare + schedule" to `setPrepared` followed by `scheduleForWindow`.
- [ ] Scheduled queued sessions render with a distinct sub-label ("Scheduled · next 5h reset · in {countdown}") vs rate-limit-queued ("Queued · rate limited · resets in {countdown}") in the list badge and queued view, and count toward the header `QueueIndicator`.

### Phase 11 — Send button "Send on next reset" (active sessions)

In an **active** session, let the user defer a follow-up turn to the next window boundary via a dropdown on the send button — fire-and-forget within a live conversation. Reuses the `rateLimited` pending-turn state with `reason:'scheduled'`.

- [ ] `sdkSessions.ts`: `queueTurnForWindow(id, prompt, images, window)` — pushes the user message (so it's visible in the transcript), then sets `rateLimited = { reason:'scheduled', provider, window, targetStartAt: nextWindowResetAt(provider, window), resetsAt: same, prompt, images, queuedAt }` **without** invoking the backend. `continueRateLimited(id)` (already added) re-sends it and works for scheduled turns too.
- [ ] Driver (`smartQueue.ts`): when dispatching, treat a `rateLimited` turn with `reason:'scheduled'` as time-based (`now > targetStartAt`, independent of exhaustion) and `reason:'rate_limit'` as reset-based — same fuzzy delays, sound, FIFO. `continueRateLimited` is the dispatch call for all `rateLimited` turns.
- [ ] UI — `src/lib/components/sdk/SdkPromptInput.svelte`: add a dropdown/split affordance on the send button: "Send" | "Send on next 5h reset (in {countdown})" | "Send on next 7d reset (in {countdown})". The scheduled options call `queueTurnForWindow`. Countdown via `nextWindowResetAt` + `formatTimeRemaining`. Keep the primary click = send now. The queued turn then shows the same `RateLimitBanner`-style pending indicator ("will send in {countdown}") with a Cancel that reverts (clear `rateLimited`, drop the pending user bubble).

---

## Files touched (summary)

**Rust:** `src-tauri/src/config.rs` (QueueConfig), `src-tauri/src/sidecar.rs` (`InboundMessage::RateLimit` + emit).
**Sidecar:** `src-tauri/sidecar/src/index.ts` (`rate_limit_event` case, `sendRateLimit`, error classification).
**Stores:** `src/lib/stores/settings.ts` (QueueConfig mirror), `src/lib/stores/sdkSessions.ts` (`queued` status, `queueInfo`/`rateLimited`, gates in `startSetupSession`/`initializeSession`/`sendPrompt`, `sdk-rate-limit` listener, `scheduleForWindow`), **new** `src/lib/stores/queueDetection.ts` (`providerExhaustion`/`shouldQueue`/`nextWindowResetAt`, no `sdkSessions` dep), **new** `src/lib/stores/smartQueue.ts` (drain driver + derived stores, imports `sdkSessions`), `src/lib/stores/sessionPersistence.ts` (verify only).
**Composables/utils:** `useDisplaySessions.svelte.ts`, `sessionStatus.ts`, `sound.ts`.
**Components:** `SessionListItem.svelte`, main-view routing `+page.svelte`, `AppHeader.svelte`, `sdk/SdkPromptInput.svelte` (send-on-reset dropdown), the prepared-session view (schedule split-button), **new** `QueueIndicator.svelte`, **new** `sdk/RateLimitBanner.svelte`, **new** `settings/QueueTab.svelte`, `settings/index.ts`.

## Testing / verification

- [ ] Force `providerExhaustion` to return `exhausted:true` (temporary override) and confirm: a new recording/pile/notion launch lands as `queued`; a follow-up prompt banners as `rate_limited`; clearing the override + a poll tick drains them FIFO with the configured delays; reset sound plays once.
- [ ] Simulate a mid-run `sdk-rate-limit` event (inject an inbound `rate_limit` message) → session enters `rate_limited`, banner shows, Continue-now re-sends.
- [ ] Restart the app with queued + rate-limited sessions persisted and reset already passed → they dispatch on startup.
- [ ] Codex session queues on Codex limits independently of Claude.
- [ ] Master toggle off → current behavior (immediate launch; opaque error on 429).
- [ ] `npm run check` clean; `cargo build` clean.

## Open questions

- Between-runs default range (10–45s) and after-reset default range (120–240s) — reasonable starting values; tune after real use.
- Whether `allowed_warning` (soft) rate-limit events should surface a passive hint vs. be ignored (currently: ignore; only `rejected` acts).
