import { writable, derived } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

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

interface RateLimitState {
	data: ProviderRateLimits | null;
	loading: boolean;
	error: string | null;
	lastFetched: number | null; // timestamp ms
}

const REFRESH_INTERVAL_MS = 60_000; // 60 seconds

function createProviderRateLimitStore(commandName: string) {
	const { subscribe, set, update } = writable<RateLimitState>({
		data: null,
		loading: false,
		error: null,
		lastFetched: null
	});

	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	const store = {
		subscribe,

		async fetch() {
			console.log(`[RateLimits] Fetching ${commandName}...`);
			update((s) => ({ ...s, loading: true, error: null }));
			try {
				const data = await invoke<ProviderRateLimits>(commandName);
				console.log(`[RateLimits] ${commandName} OK:`, data);
				set({
					data,
					loading: false,
					error: null,
					lastFetched: Date.now()
				});
			} catch (error) {
				console.error(`[RateLimits] ${commandName} FAILED:`, error);
				update((s) => ({
					...s,
					loading: false,
					error: String(error)
				}));
			}
		},

		/** Fetch only if data is stale (older than REFRESH_INTERVAL_MS) */
		async fetchIfStale() {
			let currentState: RateLimitState | null = null;
			const unsub = subscribe((s) => {
				currentState = s;
			});
			unsub();
			if (
				currentState &&
				!(currentState as RateLimitState).loading &&
				(!(currentState as RateLimitState).lastFetched ||
					Date.now() - (currentState as RateLimitState).lastFetched! > REFRESH_INTERVAL_MS)
			) {
				await store.fetch();
			}
		},

		/** Start periodic auto-refresh */
		startAutoRefresh() {
			if (refreshTimer) return;
			store.fetch();
			refreshTimer = setInterval(() => store.fetch(), REFRESH_INTERVAL_MS);
		},

		/** Stop periodic auto-refresh */
		stopAutoRefresh() {
			if (refreshTimer) {
				clearInterval(refreshTimer);
				refreshTimer = null;
			}
		},

		/** Reset state */
		reset() {
			store.stopAutoRefresh();
			set({ data: null, loading: false, error: null, lastFetched: null });
		}
	};

	return store;
}

// --- Claude ---
export const rateLimits = createProviderRateLimitStore('fetch_claude_rate_limits');
export const rateLimitData = derived(rateLimits, ($rl) => $rl.data);
export const rateLimitError = derived(rateLimits, ($rl) => $rl.error);
export const isRateLimitLoading = derived(rateLimits, ($rl) => $rl.loading);

// --- Codex ---
export const codexRateLimits = createProviderRateLimitStore('fetch_codex_rate_limits');
export const codexRateLimitData = derived(codexRateLimits, ($rl) => $rl.data);
export const codexRateLimitError = derived(codexRateLimits, ($rl) => $rl.error);
export const isCodexRateLimitLoading = derived(codexRateLimits, ($rl) => $rl.loading);

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
