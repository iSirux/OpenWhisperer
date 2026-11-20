/**
 * App-wide generation throughput: output tokens per second summed across every
 * session (main agents and subagents, Claude and Codex).
 *
 * The sidecar reports output-token growth (`sdk-output-tokens-${id}`) once per model
 * call / assistant message, not per streamed token, so the raw signal is bursty.
 * The rate is the sum over a rolling window divided by the window length, which
 * smooths those bursts out — it lags a little but is accurate on average.
 * In-memory only; nothing here is persisted.
 */
import { readable } from 'svelte/store';

export const THROUGHPUT_WINDOW_MS = 60_000;
const TICK_MS = 1_000;

export type ThroughputProvider = 'claude' | 'openai';

interface Sample {
  at: number;
  sessionId: string;
  provider: ThroughputProvider;
  tokens: number;
}

export interface ThroughputSnapshot {
  /** Output tokens per second over the rolling window, all sessions. */
  tokensPerSec: number;
  /** Output tokens generated within the window. */
  windowTokens: number;
  /** Distinct sessions that generated output within the window. */
  activeSessions: number;
  byProvider: Record<ThroughputProvider, number>;
}

const EMPTY: ThroughputSnapshot = {
  tokensPerSec: 0,
  windowTokens: 0,
  activeSessions: 0,
  byProvider: { claude: 0, openai: 0 },
};

let samples: Sample[] = [];
let emit: ((s: ThroughputSnapshot) => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function compute(now: number): ThroughputSnapshot {
  const cutoff = now - THROUGHPUT_WINDOW_MS;
  if (samples.length > 0 && samples[0].at <= cutoff) {
    samples = samples.filter(s => s.at > cutoff);
  }
  if (samples.length === 0) return EMPTY;
  const sessionIds = new Set<string>();
  const byProvider = { claude: 0, openai: 0 };
  let windowTokens = 0;
  for (const s of samples) {
    windowTokens += s.tokens;
    byProvider[s.provider] += s.tokens;
    sessionIds.add(s.sessionId);
  }
  const seconds = THROUGHPUT_WINDOW_MS / 1000;
  return {
    tokensPerSec: windowTokens / seconds,
    windowTokens,
    activeSessions: sessionIds.size,
    byProvider: { claude: byProvider.claude / seconds, openai: byProvider.openai / seconds },
  };
}

function refresh(): void {
  const snap = compute(Date.now());
  emit?.(snap);
  // Tick only while there is something in the window to age out.
  if (samples.length === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const throughput = readable<ThroughputSnapshot>(EMPTY, set => {
  emit = set;
  set(compute(Date.now()));
  return () => {
    emit = null;
    if (timer) clearInterval(timer);
    timer = null;
  };
});

/** Record output tokens a session just generated. */
export function recordOutputTokens(sessionId: string, provider: ThroughputProvider, tokens: number): void {
  if (!(tokens > 0)) return;
  samples.push({ at: Date.now(), sessionId, provider, tokens });
  if (!timer) timer = setInterval(refresh, TICK_MS);
  refresh();
}

/** "842" / "1.2k" / "15k" */
export function formatTokensPerSec(rate: number): string {
  if (rate < 1000) return rate < 10 ? rate.toFixed(1) : String(Math.round(rate));
  const k = rate / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}
