import { writable, derived } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import type { AgentAccount } from './settings';
import { isDefaultAccountId } from '$lib/utils/accounts';

export interface RateLimitWindow {
	utilization: number; // 0-100
	resets_at: string; // ISO timestamp
}

export interface ExtraUsage {
	is_enabled: boolean;
	monthly_limit: number | null; // cents
	used_credits: number | null; // cents
	utilization: number | null;
}

/** Unified rate limit data shape used by both Claude and Codex */
export interface ProviderRateLimits {
	five_hour: RateLimitWindow;
	seven_day: RateLimitWindow;
	extra_usage: ExtraUsage;
}

// Keep backward compat alias
export type ClaudeRateLimits = ProviderRateLimits;

export interface RateLimitState {
	data: ProviderRateLimits | null;
	loading: boolean;
	error: string | null;
	lastError: string | null;
	lastFetched: number | null; // timestamp ms
	consecutiveFailures: number;
	authExpired: boolean; // true when the provider's auth token is expired/unauthorized
}

/** Detect whether an error string indicates the provider's auth token is expired/invalid */
function isAuthError(errorText: string): boolean {
	return /401|unauthorized|token_expired|token is expired|authentication token is expired/i.test(
		errorText
	);
}

const DEFAULT_REFRESH_INTERVAL_MS = 3 * 60_000; // 3 minutes
const CLAUDE_BASE_REFRESH_INTERVAL_MS = 3 * 60_000; // 3 minutes
const CLAUDE_MAX_BACKOFF_MS = 15 * 60_000; // 15 minutes
const CODEX_BASE_REFRESH_INTERVAL_MS = 3 * 60_000; // 3 minutes
const CODEX_MAX_BACKOFF_MS = 15 * 60_000; // 15 minutes
const INVOKE_TIMEOUT_MS = 15_000; // 15 seconds — JS safety net in case Rust hangs
const STALE_AFTER_CONSECUTIVE_FAILURES = 2;
const STALE_AFTER_MS = 5 * 60_000; // don't show stale until data is 5+ minutes old

interface RateLimitStoreOptions {
	refreshIntervalMs?: number;
	maxBackoffMs?: number;
	/** Extra invoke args threaded into every fetch (e.g. `{ accountId }` for per-account stores). */
	invokeArgs?: Record<string, unknown>;
}

/** Wrap an invoke call with a timeout so it never hangs forever */
function invokeWithTimeout<T>(
	command: string,
	timeoutMs: number,
	args?: Record<string, unknown>
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(new Error(`Invoke '${command}' timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		invoke<T>(command, args)
			.then((result) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(result);
				}
			})
			.catch((err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err);
				}
			});
	});
}

function createProviderRateLimitStore(
	commandName: string,
	options: RateLimitStoreOptions = {}
) {
	const baseRefreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	const maxBackoffMs = Math.max(options.maxBackoffMs ?? baseRefreshIntervalMs, baseRefreshIntervalMs);
	const invokeArgs = options.invokeArgs;

	const { subscribe, set, update } = writable<RateLimitState>({
		data: null,
		loading: false,
		error: null,
		lastError: null,
		lastFetched: null,
		consecutiveFailures: 0,
		authExpired: false
	});

	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let fetchInFlight = false; // guard against concurrent fetches
	let autoRefreshEnabled = false;
	let currentRefreshIntervalMs = baseRefreshIntervalMs;

	function shouldShowStale(state: Pick<RateLimitState, 'lastFetched' | 'consecutiveFailures'>): boolean {
		if (state.consecutiveFailures < STALE_AFTER_CONSECUTIVE_FAILURES) return false;
		if (state.lastFetched == null) return true;
		return Date.now() - state.lastFetched >= STALE_AFTER_MS;
	}

	function scheduleNextFetch(delayMs = currentRefreshIntervalMs) {
		if (!autoRefreshEnabled) return;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			void store.fetch();
		}, delayMs);
	}

	const store = {
		subscribe,

		async fetch() {
			// Skip if a fetch is already in-flight (prevents stacking after sleep/wake)
			if (fetchInFlight) {
				console.log(`[RateLimits] Skipping ${commandName} — fetch already in-flight`);
				return;
			}
			fetchInFlight = true;
			console.log(`[RateLimits] Fetching ${commandName}...`);
			update((s) => ({ ...s, loading: true, error: shouldShowStale(s) ? s.lastError : null }));
			try {
				const data = await invokeWithTimeout<ProviderRateLimits>(
					commandName,
					INVOKE_TIMEOUT_MS,
					invokeArgs
				);
				currentRefreshIntervalMs = baseRefreshIntervalMs;
				console.log(`[RateLimits] ${commandName} OK:`, data);
				set({
					data,
					loading: false,
					error: null,
					lastError: null,
					lastFetched: Date.now(),
					consecutiveFailures: 0,
					authExpired: false
				});
			} catch (error) {
				const errorText = String(error);
				console.error(`[RateLimits] ${commandName} FAILED:`, error);
				update((s) => {
					const consecutiveFailures = s.consecutiveFailures + 1;
					const nextInterval = Math.min(
						maxBackoffMs,
						baseRefreshIntervalMs * 2 ** (consecutiveFailures - 1)
					);
					currentRefreshIntervalMs = nextInterval;
					console.warn(
						`[RateLimits] ${commandName} failed ${consecutiveFailures}x; next retry in ${Math.round(currentRefreshIntervalMs / 1000)}s`
					);
					const nextState = {
						...s,
						loading: false,
						lastError: errorText,
						consecutiveFailures,
						authExpired: isAuthError(errorText)
					};
					return {
						...nextState,
						error: shouldShowStale(nextState) ? errorText : null
					};
				});
			} finally {
				fetchInFlight = false;
				scheduleNextFetch();
			}
		},

		/** Fetch only if data is stale (older than current refresh interval) */
		async fetchIfStale() {
			let currentState: RateLimitState | null = null;
			const unsub = subscribe((s) => {
				currentState = s;
			});
			unsub();
			const snapshot = currentState as RateLimitState | null;
			if (
				snapshot &&
				!snapshot.loading &&
				(!snapshot.lastFetched ||
					Date.now() - snapshot.lastFetched > currentRefreshIntervalMs)
			) {
				await store.fetch();
			}
		},

		/** Start periodic auto-refresh */
		startAutoRefresh() {
			if (autoRefreshEnabled) return;
			autoRefreshEnabled = true;
			void store.fetch();
		},

		/** Stop periodic auto-refresh */
		stopAutoRefresh() {
			autoRefreshEnabled = false;
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
		},

		/** Restart the auto-refresh interval (e.g. after sleep/wake) */
		restartAutoRefresh() {
			store.stopAutoRefresh();
			store.startAutoRefresh();
		},

		/** Reset state */
		reset() {
			store.stopAutoRefresh();
			fetchInFlight = false;
			currentRefreshIntervalMs = baseRefreshIntervalMs;
			set({
				data: null,
				loading: false,
				error: null,
				lastError: null,
				lastFetched: null,
				consecutiveFailures: 0,
				authExpired: false
			});
		}
	};

	return store;
}

// --- Claude ---
export const rateLimits = createProviderRateLimitStore(
	'fetch_claude_rate_limits',
	{
		refreshIntervalMs: CLAUDE_BASE_REFRESH_INTERVAL_MS,
		maxBackoffMs: CLAUDE_MAX_BACKOFF_MS
	}
);
export const rateLimitData = derived(rateLimits, ($rl) => $rl.data);
export const rateLimitError = derived(rateLimits, ($rl) => $rl.error);
export const isRateLimitLoading = derived(rateLimits, ($rl) => $rl.loading);
export const rateLimitAuthExpired = derived(rateLimits, ($rl) => $rl.authExpired);

// --- Codex ---
export const codexRateLimits = createProviderRateLimitStore(
	'fetch_codex_rate_limits',
	{
		refreshIntervalMs: CODEX_BASE_REFRESH_INTERVAL_MS,
		maxBackoffMs: CODEX_MAX_BACKOFF_MS
	}
);
export const codexRateLimitData = derived(codexRateLimits, ($rl) => $rl.data);
export const codexRateLimitError = derived(codexRateLimits, ($rl) => $rl.error);
export const isCodexRateLimitLoading = derived(codexRateLimits, ($rl) => $rl.loading);
export const codexRateLimitAuthExpired = derived(codexRateLimits, ($rl) => $rl.authExpired);

// --- Per-account rate-limit stores ---
//
// Rate limits are per-account. Sessions with `accountId` undefined or a virtual
// `default-*` id use the provider singletons above (identical pre-feature
// behavior). Each configured, non-disabled account gets its own lazily-created
// store that fetches THAT account's usage (backend reads the profile's creds via
// the `accountId` invoke arg). `accountRateLimits` is a reactive mirror of every
// account store's state, keyed by account id, so components can subscribe once.

export const accountRateLimits = writable<Record<string, RateLimitState>>({});

interface AccountStoreEntry {
	store: ReturnType<typeof createProviderRateLimitStore>;
	unsub: () => void;
}

const accountStores = new Map<string, AccountStoreEntry>();

function commandForAccountProvider(provider: AgentAccount['provider']): string {
	return provider === 'OpenAI' ? 'fetch_codex_rate_limits' : 'fetch_claude_rate_limits';
}

function refreshOptionsForProvider(provider: AgentAccount['provider']): RateLimitStoreOptions {
	return provider === 'OpenAI'
		? { refreshIntervalMs: CODEX_BASE_REFRESH_INTERVAL_MS, maxBackoffMs: CODEX_MAX_BACKOFF_MS }
		: { refreshIntervalMs: CLAUDE_BASE_REFRESH_INTERVAL_MS, maxBackoffMs: CLAUDE_MAX_BACKOFF_MS };
}

/** Get (or lazily create) the per-account store for a configured account id. */
function getOrCreateAccountStore(accountId: string, provider: AgentAccount['provider']) {
	let entry = accountStores.get(accountId);
	if (!entry) {
		const store = createProviderRateLimitStore(commandForAccountProvider(provider), {
			...refreshOptionsForProvider(provider),
			invokeArgs: { accountId }
		});
		// Mirror this store's state into the reactive registry on every change.
		const unsub = store.subscribe((state) => {
			accountRateLimits.update((rec) => ({ ...rec, [accountId]: state }));
		});
		entry = { store, unsub };
		accountStores.set(accountId, entry);
	}
	return entry.store;
}

/** Stop, unsubscribe, and forget a per-account store (account disabled/removed). */
function retireAccountStore(accountId: string): void {
	const entry = accountStores.get(accountId);
	if (!entry) return;
	entry.store.stopAutoRefresh();
	entry.unsub();
	accountStores.delete(accountId);
	accountRateLimits.update((rec) => {
		if (!(accountId in rec)) return rec;
		const next = { ...rec };
		delete next[accountId];
		return next;
	});
}

/**
 * Resolve the rate-limit store a session should read/poll:
 * - undefined/null/`default-*` account → the provider singleton (unchanged behavior).
 * - a configured account id → its lazily-created per-account store.
 */
export function rateLimitStoreForAccount(
	accountId: string | null | undefined,
	provider: 'claude' | 'openai'
): ReturnType<typeof createProviderRateLimitStore> {
	if (!accountId || isDefaultAccountId(accountId)) {
		return provider === 'openai' ? codexRateLimits : rateLimits;
	}
	return getOrCreateAccountStore(accountId, provider === 'openai' ? 'OpenAI' : 'Claude');
}

/**
 * Reconcile the per-account store registry against the configured accounts:
 * create + auto-refresh a store for every configured, non-disabled account, and
 * retire stores for accounts that disappeared or became disabled. Cheap to call
 * repeatedly (`startAutoRefresh` is idempotent).
 */
export function syncAccountRateLimitStores(accounts: AgentAccount[]): void {
	const active = new Set<string>();
	for (const account of accounts) {
		if (account.disabled || isDefaultAccountId(account.id)) continue;
		active.add(account.id);
		getOrCreateAccountStore(account.id, account.provider).startAutoRefresh();
	}
	for (const id of [...accountStores.keys()]) {
		if (!active.has(id)) retireAccountStore(id);
	}
}

// --- Visibility change handler ---
// When the app regains focus (e.g. after sleep/wake or tab switch), restart
// the refresh timers and force an immediate fetch so data is never stale.

let visibilityHandlerRegistered = false;

export function registerVisibilityHandler() {
	if (visibilityHandlerRegistered) return;
	visibilityHandlerRegistered = true;

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			console.log('[RateLimits] App became visible — restarting auto-refresh');
			rateLimits.restartAutoRefresh();
			codexRateLimits.restartAutoRefresh();
			for (const entry of accountStores.values()) entry.store.restartAutoRefresh();
		}
	});
}

// --- Shared helpers ---

/** Format time remaining until an ISO reset timestamp, e.g. "2h 15m" */
export function formatTimeRemaining(isoTimestamp: string): string {
	if (!isoTimestamp) return '';
	const resetTime = new Date(isoTimestamp).getTime();
	const now = Date.now();
	const diffMs = resetTime - now;
	if (diffMs <= 0) return 'now';
	const days = Math.floor(diffMs / 86_400_000);
	const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
	const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** Calculate pace: actual usage vs what's expected given elapsed time */
export function calculatePace(
	utilization: number,
	resetsAt: string,
	windowHours: number
): {
	expectedPercent: number;
	paceRatio: number;
	paceLabel: string;
} {
	if (!resetsAt) return { expectedPercent: 0, paceRatio: 1, paceLabel: 'unknown' };

	const resetTime = new Date(resetsAt).getTime();
	const now = Date.now();
	const windowMs = windowHours * 3_600_000;
	const windowStart = resetTime - windowMs;
	const elapsed = now - windowStart;
	const elapsedFraction = Math.max(0, Math.min(1, elapsed / windowMs));
	const expectedPercent = elapsedFraction * 100;

	const paceRatio = expectedPercent > 0 ? utilization / expectedPercent : 0;

	let paceLabel: string;
	if (utilization < 1) paceLabel = 'idle';
	else if (paceRatio < 0.8) paceLabel = 'low';
	else if (paceRatio < 1.2) paceLabel = 'on pace';
	else if (paceRatio < 1.5) paceLabel = 'elevated';
	else paceLabel = 'high';

	return { expectedPercent, paceRatio, paceLabel };
}

/** Format cents to dollar string, e.g. 1250 → "$12.50" */
export function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}
