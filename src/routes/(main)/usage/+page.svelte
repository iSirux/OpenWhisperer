<script lang="ts">
  import { onMount } from 'svelte';
  import { usageStats, formatDuration, formatDate, formatRelativeTime, getWeeklyStats, getTotalForPeriod, formatTokens, formatCost } from '$lib/stores/usageStats';
  import { appSessionUsage } from '$lib/stores/sdkSessions';
  import { settings } from '$lib/stores/settings';
  import { rateLimits, rateLimitData, isRateLimitLoading, codexRateLimits, codexRateLimitData, isCodexRateLimitLoading, formatTimeRemaining, calculatePace, formatCents } from '$lib/stores/rateLimits';

  // App session usage - cumulative across all SDK sessions since app launch
  let appUsage = $derived($appSessionUsage);
  let appInputTokens = $derived(
    appUsage.totalInputTokens + appUsage.progressiveInputTokens
  );
  let appOutputTokens = $derived(
    appUsage.totalOutputTokens + appUsage.progressiveOutputTokens
  );
  let appTotalTokens = $derived(appInputTokens + appOutputTokens);
  let appCost = $derived(appUsage.totalCostUsd);
  let appCacheRead = $derived(appUsage.totalCacheReadTokens);
  let appCacheCreation = $derived(appUsage.totalCacheCreationTokens);
  let hasAppUsage = $derived(appTotalTokens > 0 || appCost > 0);

  let resettingStats = $state(false);

  // Claude API rate limit data
  let rl = $derived($rateLimitData);
  let rlLoading = $derived($isRateLimitLoading);
  let claude7dPace = $derived(
    rl ? calculatePace(rl.seven_day.utilization, rl.seven_day.resets_at, 168) : null
  );

  // Codex API rate limit data
  let cx = $derived($codexRateLimitData);
  let cxLoading = $derived($isCodexRateLimitLoading);
  let codex7dPace = $derived(
    cx ? calculatePace(cx.seven_day.utilization, cx.seven_day.resets_at, 168) : null
  );

  function getPaceDiff(utilization: number, expectedPercent: number): string {
    const diff = Math.abs(utilization - expectedPercent).toFixed(1);
    if (utilization > expectedPercent + 5) return `+${diff}% ahead`;
    if (utilization < expectedPercent - 5) return `${diff}% behind`;
    return 'on pace';
  }

  function getPaceColor(utilization: number, expectedPercent: number): string {
    if (utilization > expectedPercent + 5) return 'text-warning';
    if (utilization < expectedPercent - 5) return 'text-success';
    return 'text-text-secondary';
  }

  function getPaceColorClasses(paceRatio: number): string {
    if (paceRatio >= 1.5) return 'bg-red-500/20 text-red-400';
    if (paceRatio >= 1.2) return 'bg-yellow-500/20 text-yellow-400';
    return 'bg-green-500/20 text-green-400';
  }

  function getUtilColor(pct: number): string {
    if (pct > 90) return 'text-error';
    if (pct > 70) return 'text-warning';
    return 'text-text-primary';
  }

  onMount(() => {
    usageStats.load();
    rateLimits.fetchIfStale();
    codexRateLimits.fetchIfStale();
  });

  async function resetStats() {
    if (!confirm('Are you sure you want to reset all usage statistics? This cannot be undone.')) {
      return;
    }
    resettingStats = true;
    try {
      await usageStats.reset();
    } catch (error) {
      console.error('Failed to reset stats:', error);
    }
    resettingStats = false;
  }

  // Helper to get model distribution percentages
  function getModelPercentage(count: number, total: number): number {
    if (total === 0) return 0;
    return Math.round((count / total) * 100);
  }

  // Get repo name from path
  function getRepoName(path: string): string {
    const repo = $settings.repos.find(r => r.path === path);
    return repo?.name || path.split(/[/\\]/).pop() || path;
  }
</script>

<div class="usage-view flex-1 flex flex-col overflow-hidden bg-background">
  <div class="flex items-center px-4 py-2 border-b border-border bg-surface">
    <h2 class="text-sm font-medium text-text-primary">Usage Statistics</h2>
  </div>

  <div class="flex-1 overflow-y-auto p-6">
    <div class="max-w-4xl mx-auto space-y-6">
      <!-- API Rate Limits -->
      {#if rl || cx}
        <div>
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium text-text-primary">API Rate Limits</h3>
            <button
              class="text-[10px] text-text-muted hover:text-text-primary transition-colors"
              onclick={() => { rateLimits.fetch(); codexRateLimits.fetch(); }}
              disabled={rlLoading || cxLoading}
            >
              {rlLoading || cxLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
          <div class="p-4 bg-surface-elevated rounded-lg border border-border space-y-5">
            {#if rl}
              {@const claude5hPace = calculatePace(rl.five_hour.utilization, rl.five_hour.resets_at, 5)}
              <div class="space-y-4">
                <div class="text-xs font-medium text-text-secondary">Claude</div>
                <!-- 5-Hour Window -->
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-sm text-text-secondary">5-Hour Window</span>
                    <div class="flex items-center gap-3">
                      {#if claude5hPace && claude5hPace.paceLabel !== 'idle'}
                        <span class="text-[10px] px-1.5 py-0.5 rounded {getPaceColorClasses(claude5hPace.paceRatio)}">{claude5hPace.paceLabel}</span>
                      {/if}
                      <span class="text-xs text-text-muted">resets in {formatTimeRemaining(rl.five_hour.resets_at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all duration-500"
                        class:bg-accent={rl.five_hour.utilization <= 70}
                        class:bg-warning={rl.five_hour.utilization > 70 && rl.five_hour.utilization <= 90}
                        class:bg-error={rl.five_hour.utilization > 90}
                        style="width: {Math.min(100, rl.five_hour.utilization)}%"
                      ></div>
                    </div>
                    <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      {rl.five_hour.utilization.toFixed(1)}%
                    </span>
                  </div>
                </div>
                <!-- 7-Day Window -->
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-sm text-text-secondary">7-Day Window</span>
                    <div class="flex items-center gap-3">
                      {#if claude7dPace && claude7dPace.paceLabel !== 'idle'}
                        <span class="text-[10px] px-1.5 py-0.5 rounded {getPaceColorClasses(claude7dPace.paceRatio)}">{claude7dPace.paceLabel}</span>
                      {/if}
                      <span class="text-xs text-text-muted">resets in {formatTimeRemaining(rl.seven_day.resets_at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all duration-500"
                        class:bg-accent={rl.seven_day.utilization <= 70}
                        class:bg-warning={rl.seven_day.utilization > 70 && rl.seven_day.utilization <= 90}
                        class:bg-error={rl.seven_day.utilization > 90}
                        style="width: {Math.min(100, rl.seven_day.utilization)}%"
                      ></div>
                    </div>
                    <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      {rl.seven_day.utilization.toFixed(1)}%
                    </span>
                  </div>
                  {#if claude7dPace}
                    <div class="flex items-center justify-between mt-1.5 text-[10px] text-text-muted" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      <span>Expected: {claude7dPace.expectedPercent.toFixed(1)}% (linear)</span>
                      <span>Actual: {rl.seven_day.utilization.toFixed(1)}%</span>
                    </div>
                  {/if}
                </div>
                <!-- Extra Usage -->
                {#if rl.extra_usage.is_enabled}
                  <div class="pt-3 border-t border-border">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-sm text-text-secondary">Extra Usage (Monthly)</span>
                      <span class="text-xs text-text-muted" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                        {rl.extra_usage.used_credits != null ? formatCents(rl.extra_usage.used_credits) : '$0.00'}
                        / {rl.extra_usage.monthly_limit != null ? formatCents(rl.extra_usage.monthly_limit) : '---'}
                      </span>
                    </div>
                    {#if rl.extra_usage.utilization != null}
                      <div class="flex items-center gap-3">
                        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                          <div
                            class="h-full rounded-full transition-all duration-500"
                            class:bg-accent={rl.extra_usage.utilization <= 70}
                            class:bg-warning={rl.extra_usage.utilization > 70 && rl.extra_usage.utilization <= 90}
                            class:bg-error={rl.extra_usage.utilization > 90}
                            style="width: {Math.min(100, rl.extra_usage.utilization)}%"
                          ></div>
                        </div>
                        <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                          {rl.extra_usage.utilization.toFixed(1)}%
                        </span>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}

            {#if cx}
              {@const codex5hPace = calculatePace(cx.five_hour.utilization, cx.five_hour.resets_at, 5)}
              <div class="space-y-4" class:pt-5={rl} class:border-t={rl} class:border-border={rl}>
                <div class="text-xs font-medium text-text-secondary">Codex</div>
                <!-- 5-Hour Window -->
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-sm text-text-secondary">5-Hour Window</span>
                    <div class="flex items-center gap-3">
                      {#if codex5hPace && codex5hPace.paceLabel !== 'idle'}
                        <span class="text-[10px] px-1.5 py-0.5 rounded {getPaceColorClasses(codex5hPace.paceRatio)}">{codex5hPace.paceLabel}</span>
                      {/if}
                      <span class="text-xs text-text-muted">resets in {formatTimeRemaining(cx.five_hour.resets_at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all duration-500"
                        class:bg-accent={cx.five_hour.utilization <= 70}
                        class:bg-warning={cx.five_hour.utilization > 70 && cx.five_hour.utilization <= 90}
                        class:bg-error={cx.five_hour.utilization > 90}
                        style="width: {Math.min(100, cx.five_hour.utilization)}%"
                      ></div>
                    </div>
                    <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      {cx.five_hour.utilization.toFixed(1)}%
                    </span>
                  </div>
                </div>
                <!-- 7-Day Window -->
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-sm text-text-secondary">7-Day Window</span>
                    <div class="flex items-center gap-3">
                      {#if codex7dPace && codex7dPace.paceLabel !== 'idle'}
                        <span class="text-[10px] px-1.5 py-0.5 rounded {getPaceColorClasses(codex7dPace.paceRatio)}">{codex7dPace.paceLabel}</span>
                      {/if}
                      <span class="text-xs text-text-muted">resets in {formatTimeRemaining(cx.seven_day.resets_at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all duration-500"
                        class:bg-accent={cx.seven_day.utilization <= 70}
                        class:bg-warning={cx.seven_day.utilization > 70 && cx.seven_day.utilization <= 90}
                        class:bg-error={cx.seven_day.utilization > 90}
                        style="width: {Math.min(100, cx.seven_day.utilization)}%"
                      ></div>
                    </div>
                    <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      {cx.seven_day.utilization.toFixed(1)}%
                    </span>
                  </div>
                  {#if codex7dPace}
                    <div class="flex items-center justify-between mt-1.5 text-[10px] text-text-muted" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                      <span>Expected: {codex7dPace.expectedPercent.toFixed(1)}% (linear)</span>
                      <span>Actual: {cx.seven_day.utilization.toFixed(1)}%</span>
                    </div>
                  {/if}
                </div>
                <!-- Extra Usage / Credits -->
                {#if cx.extra_usage.is_enabled}
                  <div class="pt-3 border-t border-border">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-sm text-text-secondary">Credits (Monthly)</span>
                      <span class="text-xs text-text-muted" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                        {cx.extra_usage.used_credits != null ? formatCents(cx.extra_usage.used_credits) : '$0.00'}
                        / {cx.extra_usage.monthly_limit != null ? formatCents(cx.extra_usage.monthly_limit) : '---'}
                      </span>
                    </div>
                    {#if cx.extra_usage.utilization != null}
                      <div class="flex items-center gap-3">
                        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                          <div
                            class="h-full rounded-full transition-all duration-500"
                            class:bg-accent={cx.extra_usage.utilization <= 70}
                            class:bg-warning={cx.extra_usage.utilization > 70 && cx.extra_usage.utilization <= 90}
                            class:bg-error={cx.extra_usage.utilization > 90}
                            style="width: {Math.min(100, cx.extra_usage.utilization)}%"
                          ></div>
                        </div>
                        <span class="text-sm font-medium text-text-primary min-w-[3rem] text-right" style="font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;">
                          {cx.extra_usage.utilization.toFixed(1)}%
                        </span>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- App Session Usage -->
      {#if hasAppUsage}
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">This App Session</h3>
          <div class="p-4 bg-surface-elevated rounded-lg border border-accent/30">
            <!-- App Session Cost Banner -->
            <div class="flex items-center justify-between mb-4 pb-4 border-b border-border">
              <div>
                <div class="text-3xl font-bold text-accent">{formatCost(appCost)}</div>
                <div class="text-xs text-text-muted">App Session Cost (USD)</div>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold text-text-primary">{formatTokens(appTotalTokens)}</div>
                <div class="text-xs text-text-muted">App Session Tokens</div>
              </div>
            </div>

            <!-- Token Breakdown -->
            <div class="grid grid-cols-2 gap-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-blue-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 8a.5.5 0 0 1 .5-.5h5.793L8.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H4.5A.5.5 0 0 1 4 8z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens(appInputTokens)}</div>
                  <div class="text-xs text-text-muted">Input Tokens</div>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-purple-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12 8a.5.5 0 0 1-.5.5H5.707l2.147 2.146a.5.5 0 0 1-.708.708l-3-3a.5.5 0 0 1 0-.708l3-3a.5.5 0 1 1 .708.708L5.707 7.5H11.5a.5.5 0 0 1 .5.5z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens(appOutputTokens)}</div>
                  <div class="text-xs text-text-muted">Output Tokens</div>
                </div>
              </div>
            </div>

            <!-- Cache Stats (if any) -->
            {#if appCacheRead > 0 || appCacheCreation > 0}
              <div class="mt-4 pt-4 border-t border-border">
                <div class="text-xs text-text-muted mb-2">Prompt Caching</div>
                <div class="grid grid-cols-2 gap-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                      <svg class="w-4 h-4 text-green-400" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM6.79 5.093A.5.5 0 0 0 6 5.5v5a.5.5 0 0 0 .79.407l3.5-2.5a.5.5 0 0 0 0-.814l-3.5-2.5z"/>
                      </svg>
                    </div>
                    <div>
                      <div class="text-sm font-medium text-success">{formatTokens(appCacheRead)}</div>
                      <div class="text-xs text-text-muted">Cache Reads (90% savings)</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center">
                      <svg class="w-4 h-4 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 3a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 3zm4 8a4 4 0 0 1-8 0V5a4 4 0 1 1 8 0v6z"/>
                      </svg>
                    </div>
                    <div>
                      <div class="text-sm font-medium text-text-primary">{formatTokens(appCacheCreation)}</div>
                      <div class="text-xs text-text-muted">Cache Writes</div>
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Token Usage & Cost (Most Important) -->
      {#if $usageStats.token_stats && ($usageStats.token_stats.total_input_tokens > 0 || $usageStats.token_stats.total_output_tokens > 0)}
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">Token Usage & Cost</h3>
          <div class="p-4 bg-surface-elevated rounded-lg">
            <!-- Total Cost Banner -->
            <div class="flex items-center justify-between mb-4 pb-4 border-b border-border">
              <div>
                <div class="text-3xl font-bold text-warning">{formatCost($usageStats.token_stats.total_cost_usd)}</div>
                <div class="text-xs text-text-muted">Estimated API Cost (USD)</div>
                <div class="text-[10px] text-text-muted mt-0.5">Only applies to API usage, not subscriptions</div>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold text-text-primary">{formatTokens($usageStats.token_stats.total_input_tokens + $usageStats.token_stats.total_output_tokens)}</div>
                <div class="text-xs text-text-muted">Total Tokens</div>
              </div>
            </div>

            <!-- Token Breakdown -->
            <div class="grid grid-cols-2 gap-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-blue-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 8a.5.5 0 0 1 .5-.5h5.793L8.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H4.5A.5.5 0 0 1 4 8z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens($usageStats.token_stats.total_input_tokens)}</div>
                  <div class="text-xs text-text-muted">Input Tokens</div>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-purple-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12 8a.5.5 0 0 1-.5.5H5.707l2.147 2.146a.5.5 0 0 1-.708.708l-3-3a.5.5 0 0 1 0-.708l3-3a.5.5 0 1 1 .708.708L5.707 7.5H11.5a.5.5 0 0 1 .5.5z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens($usageStats.token_stats.total_output_tokens)}</div>
                  <div class="text-xs text-text-muted">Output Tokens</div>
                </div>
              </div>
            </div>

            <!-- Cache Stats (if any) -->
            {#if $usageStats.token_stats.total_cache_read_tokens > 0 || $usageStats.token_stats.total_cache_creation_tokens > 0}
              <div class="mt-4 pt-4 border-t border-border">
                <div class="text-xs text-text-muted mb-2">Prompt Caching</div>
                <div class="grid grid-cols-2 gap-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                      <svg class="w-4 h-4 text-green-400" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM6.79 5.093A.5.5 0 0 0 6 5.5v5a.5.5 0 0 0 .79.407l3.5-2.5a.5.5 0 0 0 0-.814l-3.5-2.5z"/>
                      </svg>
                    </div>
                    <div>
                      <div class="text-sm font-medium text-success">{formatTokens($usageStats.token_stats.total_cache_read_tokens)}</div>
                      <div class="text-xs text-text-muted">Cache Reads (90% savings)</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center">
                      <svg class="w-4 h-4 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 3a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 3zm4 8a4 4 0 0 1-8 0V5a4 4 0 1 1 8 0v6z"/>
                      </svg>
                    </div>
                    <div>
                      <div class="text-sm font-medium text-text-primary">{formatTokens($usageStats.token_stats.total_cache_creation_tokens)}</div>
                      <div class="text-xs text-text-muted">Cache Writes</div>
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- LLM Integration Layer Token Usage -->
      {#if $usageStats.llm_token_stats && $usageStats.llm_token_stats.total_requests > 0}
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">LLM Integration Layer</h3>
          <div class="p-4 bg-surface-elevated rounded-lg">
            <!-- Total LLM Stats -->
            <div class="flex items-center justify-between mb-4 pb-4 border-b border-border">
              <div>
                <div class="text-2xl font-bold text-cyan-400">{$usageStats.llm_token_stats.total_requests}</div>
                <div class="text-xs text-text-muted">Total LLM Requests</div>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold text-text-primary">{formatTokens($usageStats.llm_token_stats.total_input_tokens + $usageStats.llm_token_stats.total_output_tokens)}</div>
                <div class="text-xs text-text-muted">Total LLM Tokens</div>
              </div>
            </div>

            <!-- Token Breakdown -->
            <div class="grid grid-cols-2 gap-4 mb-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-cyan-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 8a.5.5 0 0 1 .5-.5h5.793L8.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L10.293 8.5H4.5A.5.5 0 0 1 4 8z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens($usageStats.llm_token_stats.total_input_tokens)}</div>
                  <div class="text-xs text-text-muted">Input Tokens</div>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-teal-500/20 flex items-center justify-center">
                  <svg class="w-4 h-4 text-teal-400" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M12 8a.5.5 0 0 1-.5.5H5.707l2.147 2.146a.5.5 0 0 1-.708.708l-3-3a.5.5 0 0 1 0-.708l3-3a.5.5 0 1 1 .708.708L5.707 7.5H11.5a.5.5 0 0 1 .5.5z"/>
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-text-primary">{formatTokens($usageStats.llm_token_stats.total_output_tokens)}</div>
                  <div class="text-xs text-text-muted">Output Tokens</div>
                </div>
              </div>
            </div>

            <!-- Per-Feature Breakdown -->
            <div class="pt-4 border-t border-border">
              <div class="text-xs text-text-muted mb-3">Feature Breakdown</div>
              <div class="space-y-2">
                {#if $usageStats.llm_token_stats.session_naming_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Session Naming</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.session_naming_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.session_naming_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.session_naming_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.session_outcome_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Session Outcome</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.session_outcome_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.session_outcome_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.session_outcome_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.interaction_analysis_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Interaction Analysis</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.interaction_analysis_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.interaction_analysis_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.interaction_analysis_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.transcription_cleanup_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Transcription Cleanup</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.transcription_cleanup_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.transcription_cleanup_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.transcription_cleanup_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.model_recommendation_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Model Recommendation</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.model_recommendation_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.model_recommendation_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.model_recommendation_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.repo_description_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Repo Description</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.repo_description_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.repo_description_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.repo_description_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
                {#if $usageStats.llm_token_stats.repo_recommendation_requests > 0}
                  <div class="flex justify-between items-center text-sm">
                    <span class="text-text-secondary">Repo Recommendation</span>
                    <div class="flex gap-3 text-xs">
                      <span class="text-text-muted">{$usageStats.llm_token_stats.repo_recommendation_requests} req</span>
                      <span class="text-cyan-400">{formatTokens($usageStats.llm_token_stats.repo_recommendation_input_tokens)} in</span>
                      <span class="text-teal-400">{formatTokens($usageStats.llm_token_stats.repo_recommendation_output_tokens)} out</span>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/if}

      <!-- Overview Stats -->
      <div>
        <h3 class="text-sm font-medium text-text-primary mb-3">Overview</h3>
        <div class="grid grid-cols-4 gap-3">
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="text-2xl font-bold text-accent">{$usageStats.session_stats.total_sessions}</div>
            <div class="text-xs text-text-muted">Total Sessions</div>
          </div>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="text-2xl font-bold text-accent">{$usageStats.session_stats.total_prompts}</div>
            <div class="text-xs text-text-muted">Total Prompts</div>
          </div>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="text-2xl font-bold text-accent">{$usageStats.session_stats.total_recordings}</div>
            <div class="text-xs text-text-muted">Voice Recordings</div>
          </div>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="text-2xl font-bold text-accent">{$usageStats.session_stats.total_tool_calls}</div>
            <div class="text-xs text-text-muted">Tool Calls</div>
          </div>
        </div>
      </div>

      <!-- Streak & Activity -->
      <div>
        <h3 class="text-sm font-medium text-text-primary mb-3">Activity</h3>
        <div class="grid grid-cols-2 gap-3">
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="flex items-center gap-2">
              <span class="text-xl">🔥</span>
              <div>
                <div class="text-lg font-bold text-text-primary">{$usageStats.streak_days} days</div>
                <div class="text-xs text-text-muted">Current Streak</div>
              </div>
            </div>
          </div>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="flex items-center gap-2">
              <span class="text-xl">🏆</span>
              <div>
                <div class="text-lg font-bold text-text-primary">{$usageStats.longest_streak} days</div>
                <div class="text-xs text-text-muted">Longest Streak</div>
              </div>
            </div>
          </div>
        </div>

        {#if $usageStats.session_stats.first_session_at}
          <div class="mt-3 p-3 bg-surface-elevated rounded-lg">
            <div class="flex justify-between text-sm">
              <span class="text-text-muted">Using since</span>
              <span class="text-text-primary">{formatDate($usageStats.session_stats.first_session_at)}</span>
            </div>
            {#if $usageStats.session_stats.last_session_at}
              <div class="flex justify-between text-sm mt-1">
                <span class="text-text-muted">Last activity</span>
                <span class="text-text-primary">{formatRelativeTime($usageStats.session_stats.last_session_at)}</span>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="grid grid-cols-2 gap-6">
        <!-- Session Types -->
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">Session Types</h3>
          <div class="p-3 bg-surface-elevated rounded-lg space-y-2">
            <div class="flex justify-between items-center">
              <span class="text-sm text-text-secondary">SDK Sessions</span>
              <span class="text-sm font-medium text-text-primary">{$usageStats.session_stats.total_sdk_sessions}</span>
            </div>
            <div class="w-full bg-border rounded-full h-2">
              <div
                class="bg-accent h-2 rounded-full transition-all"
                style="width: {getModelPercentage($usageStats.session_stats.total_sdk_sessions, $usageStats.session_stats.total_sessions)}%"
              ></div>
            </div>
            <div class="flex justify-between items-center mt-2">
              <span class="text-sm text-text-secondary">PTY Sessions</span>
              <span class="text-sm font-medium text-text-primary">{$usageStats.session_stats.total_pty_sessions}</span>
            </div>
            <div class="w-full bg-border rounded-full h-2">
              <div
                class="bg-success h-2 rounded-full transition-all"
                style="width: {getModelPercentage($usageStats.session_stats.total_pty_sessions, $usageStats.session_stats.total_sessions)}%"
              ></div>
            </div>
          </div>
        </div>

        <!-- Model Usage -->
        {#if $usageStats.model_usage.opus_sessions + $usageStats.model_usage.sonnet_sessions + $usageStats.model_usage.haiku_sessions > 0}
          {@const totalModels = $usageStats.model_usage.opus_sessions + $usageStats.model_usage.sonnet_sessions + $usageStats.model_usage.haiku_sessions}
          <div>
            <h3 class="text-sm font-medium text-text-primary mb-3">Model Usage</h3>
            <div class="p-3 bg-surface-elevated rounded-lg space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-16 text-sm text-text-secondary">Opus</div>
                <div class="flex-1 bg-border rounded-full h-2">
                  <div class="bg-purple-500 h-2 rounded-full" style="width: {getModelPercentage($usageStats.model_usage.opus_sessions, totalModels)}%"></div>
                </div>
                <div class="w-10 text-right text-sm text-text-primary">{$usageStats.model_usage.opus_sessions}</div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-16 text-sm text-text-secondary">Sonnet</div>
                <div class="flex-1 bg-border rounded-full h-2">
                  <div class="bg-blue-500 h-2 rounded-full" style="width: {getModelPercentage($usageStats.model_usage.sonnet_sessions, totalModels)}%"></div>
                </div>
                <div class="w-10 text-right text-sm text-text-primary">{$usageStats.model_usage.sonnet_sessions}</div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-16 text-sm text-text-secondary">Haiku</div>
                <div class="flex-1 bg-border rounded-full h-2">
                  <div class="bg-green-500 h-2 rounded-full" style="width: {getModelPercentage($usageStats.model_usage.haiku_sessions, totalModels)}%"></div>
                </div>
                <div class="w-10 text-right text-sm text-text-primary">{$usageStats.model_usage.haiku_sessions}</div>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Recording Stats -->
      {#if $usageStats.session_stats.total_recordings > 0}
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">Voice Recording</h3>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <div class="text-lg font-bold text-text-primary">{formatDuration($usageStats.session_stats.total_recording_duration_ms)}</div>
                <div class="text-xs text-text-muted">Total Recording Time</div>
              </div>
              <div>
                <div class="text-lg font-bold text-text-primary">{$usageStats.session_stats.total_transcriptions}</div>
                <div class="text-xs text-text-muted">Transcriptions</div>
              </div>
            </div>
          </div>
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-6">
        <!-- Top Tools -->
        {#if $usageStats.most_used_tools.length > 0}
          <div>
            <h3 class="text-sm font-medium text-text-primary mb-3">Top Tools</h3>
            <div class="p-3 bg-surface-elevated rounded-lg">
              <div class="space-y-2">
                {#each $usageStats.most_used_tools.slice(0, 8) as [tool, count]}
                  <div class="flex justify-between items-center">
                    <span class="text-sm text-text-secondary font-mono">{tool}</span>
                    <span class="text-sm font-medium text-text-primary">{count}</span>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}

        <!-- Repo Usage -->
        {#if $usageStats.repo_usage.length > 0}
          <div>
            <h3 class="text-sm font-medium text-text-primary mb-3">Repository Activity</h3>
            <div class="p-3 bg-surface-elevated rounded-lg">
              <div class="space-y-2">
                {#each $usageStats.repo_usage.sort((a, b) => b.session_count - a.session_count).slice(0, 5) as repo}
                  <div class="flex justify-between items-center">
                    <span class="text-sm text-text-secondary truncate flex-1">{getRepoName(repo.repo_path)}</span>
                    <div class="flex gap-3 text-sm">
                      <span class="text-text-muted">{repo.session_count} sessions</span>
                      <span class="text-text-primary">{repo.prompt_count} prompts</span>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Weekly Activity Chart (simple bars) -->
      {#if $usageStats.daily_stats.length > 0}
        {@const weeklyStats = getWeeklyStats($usageStats.daily_stats)}
        {@const maxSessions = Math.max(...weeklyStats.map(d => d.sessions), 1)}
        {@const weekTotals = getTotalForPeriod($usageStats.daily_stats, 7)}
        <div>
          <h3 class="text-sm font-medium text-text-primary mb-3">Last 7 Days</h3>
          <div class="p-3 bg-surface-elevated rounded-lg">
            <div class="flex items-end justify-between gap-2 h-24">
              {#each weeklyStats as day}
                <div class="flex-1 flex flex-col items-center gap-1">
                  <div
                    class="w-full bg-accent rounded-t transition-all min-h-[4px]"
                    style="height: {(day.sessions / maxSessions) * 100}%"
                    title="{day.sessions} sessions, {day.prompts} prompts"
                  ></div>
                  <div class="text-[10px] text-text-muted">{day.date.slice(-2)}</div>
                </div>
              {/each}
            </div>
            <div class="mt-3 pt-3 border-t border-border grid grid-cols-4 gap-2 text-center">
              <div>
                <div class="text-sm font-medium text-text-primary">{weekTotals.sessions}</div>
                <div class="text-[10px] text-text-muted">Sessions</div>
              </div>
              <div>
                <div class="text-sm font-medium text-text-primary">{weekTotals.prompts}</div>
                <div class="text-[10px] text-text-muted">Prompts</div>
              </div>
              <div>
                <div class="text-sm font-medium text-text-primary">{weekTotals.recordings}</div>
                <div class="text-[10px] text-text-muted">Recordings</div>
              </div>
              <div>
                <div class="text-sm font-medium text-text-primary">{weekTotals.toolCalls}</div>
                <div class="text-[10px] text-text-muted">Tool Calls</div>
              </div>
            </div>
          </div>
        </div>
      {/if}

      <!-- Reset Stats -->
      <div class="border-t border-border pt-4">
        <button
          class="px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors flex items-center gap-2"
          onclick={resetStats}
          disabled={resettingStats}
        >
          {#if resettingStats}
            <div class="w-3 h-3 border-2 border-error border-t-transparent rounded-full animate-spin"></div>
          {/if}
          Reset All Statistics
        </button>
        <p class="text-xs text-text-muted mt-2">This will permanently delete all usage statistics.</p>
      </div>
    </div>
  </div>
</div>
