<script lang="ts">
  import { onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { settings, type AgentAccount, type SdkProvider } from "$lib/stores/settings";
  import { accountRateLimits, rateLimitStoreForAccount, formatTimeRemaining } from "$lib/stores/rateLimits";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";

  // Preset color palette for new accounts.
  const COLOR_PRESETS = [
    "#6366f1", // indigo
    "#ec4899", // pink
    "#f59e0b", // amber
    "#10b981", // emerald
    "#3b82f6", // blue
    "#ef4444", // red
    "#8b5cf6", // violet
    "#14b8a6", // teal
  ];

  const accounts = $derived($settings.accounts ?? []);
  const enabledProviders = $derived($settings.enabled_providers ?? { claude: true, openai: true });
  const providerChoices = $derived(
    [
      ...(enabledProviders.claude ? [{ value: "Claude" as SdkProvider, label: "Claude" }] : []),
      ...(enabledProviders.openai ? [{ value: "OpenAI" as SdkProvider, label: "Codex" }] : []),
    ]
  );

  // Per-account logged-in status. undefined = unknown/checking.
  let authStatus = $state<Record<string, boolean | undefined>>({});
  // Account ids currently in a login-and-poll loop.
  let loggingIn = $state<Record<string, boolean>>({});
  let busy = $state<Record<string, boolean>>({});
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Add-account form state.
  let newLabel = $state("");
  let newProvider = $state<SdkProvider>("Claude");
  let newColor = $state(COLOR_PRESETS[0]);
  let creating = $state(false);

  // Remove-confirmation state.
  let confirmRemoveId = $state<string | null>(null);
  let deleteDirOnRemove = $state(false);
  const confirmRemoveAccount = $derived(
    confirmRemoveId ? accounts.find((a) => a.id === confirmRemoveId) ?? null : null
  );

  $effect(() => {
    // Keep the new-account provider valid as enabled providers change.
    if (providerChoices.length > 0 && !providerChoices.some((p) => p.value === newProvider)) {
      newProvider = providerChoices[0].value;
    }
  });

  // Check auth status for every account once on mount and whenever the list changes.
  $effect(() => {
    for (const account of accounts) {
      if (authStatus[account.id] === undefined) {
        void checkAuth(account.id);
      }
    }
  });

  onDestroy(() => {
    for (const timer of pollTimers.values()) clearInterval(timer);
    pollTimers.clear();
  });

  /** Re-read accounts from backend config so the local settings store stays in sync. */
  async function refreshAccounts() {
    try {
      const cfg = await invoke<{ accounts?: AgentAccount[] }>("get_config");
      settings.update((s) => ({ ...s, accounts: cfg.accounts ?? [] }));
    } catch (e) {
      console.error("[accounts] Failed to refresh accounts:", e);
    }
  }

  async function checkAuth(id: string) {
    try {
      const ok = await invoke<boolean>("check_agent_account_auth", { id });
      authStatus = { ...authStatus, [id]: ok };
      return ok;
    } catch (e) {
      console.error("[accounts] Auth check failed:", e);
      authStatus = { ...authStatus, [id]: false };
      return false;
    }
  }

  async function handleCreate() {
    if (!newLabel.trim() || creating) return;
    creating = true;
    try {
      const account = await invoke<AgentAccount>("create_agent_account", {
        label: newLabel.trim(),
        provider: newProvider,
        color: newColor,
      });
      newLabel = "";
      await refreshAccounts();
      // Immediately drive the interactive login for the new profile.
      if (account?.id) {
        void startLogin(account.id);
      }
    } catch (e) {
      console.error("[accounts] Failed to create account:", e);
    } finally {
      creating = false;
    }
  }

  async function toggleDisabled(account: AgentAccount) {
    busy = { ...busy, [account.id]: true };
    try {
      await invoke("update_agent_account", { id: account.id, disabled: !account.disabled });
      await refreshAccounts();
    } catch (e) {
      console.error("[accounts] Failed to update account:", e);
    } finally {
      busy = { ...busy, [account.id]: false };
    }
  }

  /** Open the interactive login terminal, then poll for credentials. */
  async function startLogin(id: string) {
    loggingIn = { ...loggingIn, [id]: true };
    try {
      await invoke("login_agent_account", { id });
    } catch (e) {
      console.error("[accounts] Failed to open login:", e);
    }

    // Poll every ~3s for up to ~5 minutes, stopping early on success.
    const existing = pollTimers.get(id);
    if (existing) clearInterval(existing);
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      const ok = await checkAuth(id);
      if (ok || Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(timer);
        pollTimers.delete(id);
        loggingIn = { ...loggingIn, [id]: false };
      }
    }, 3000);
    pollTimers.set(id, timer);
  }

  function requestRemove(id: string) {
    confirmRemoveId = id;
    deleteDirOnRemove = false;
  }

  async function handleRemove() {
    const id = confirmRemoveId;
    if (!id) return;
    confirmRemoveId = null;
    try {
      await invoke("remove_agent_account", { id, deleteDir: deleteDirOnRemove });
      const timer = pollTimers.get(id);
      if (timer) {
        clearInterval(timer);
        pollTimers.delete(id);
      }
      await refreshAccounts();
    } catch (e) {
      console.error("[accounts] Failed to remove account:", e);
    }
  }

  function providerLabel(provider: SdkProvider): string {
    return provider === "OpenAI" ? "Codex" : "Claude";
  }

  /** Force an immediate per-account rate-limit fetch (lazily creates the store if needed). */
  function refreshUsage(account: AgentAccount) {
    void rateLimitStoreForAccount(
      account.id,
      account.provider === "OpenAI" ? "openai" : "claude",
    ).fetch();
  }
</script>

<div class="space-y-4">
  <div class="border-b border-border pb-4 mb-2">
    <h3 class="text-sm font-medium text-text-primary mb-1">Agent Accounts</h3>
    <p class="text-xs text-text-muted">
      Each account is an isolated login profile. Sessions are pinned to the account they start with and
      never switch accounts mid-conversation. Repos can restrict which accounts they allow.
    </p>
    <p class="text-xs text-text-muted mt-1.5">
      These must be your own accounts — running multiple accounts is at your own risk under your provider's terms.
    </p>
  </div>

  <!-- Existing accounts -->
  {#if accounts.length === 0}
    <p class="text-xs text-text-muted">No accounts configured yet. Add one below.</p>
  {:else}
    <div class="space-y-2">
      {#each accounts as account (account.id)}
        {@const usage = $accountRateLimits[account.id]?.data}
        {@const usageAuthExpired = $accountRateLimits[account.id]?.authExpired}
        <div class="p-3 bg-surface rounded border border-border flex items-start gap-3">
          <span
            class="mt-1 w-3 h-3 rounded-full flex-shrink-0"
            style="background: {account.color};"
          ></span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium text-text-primary">{account.label}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-elevated text-text-muted">
                {providerLabel(account.provider)}
              </span>
              {#if account.disabled}
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-600/20 text-yellow-400">Disabled</span>
              {/if}
              {#if authStatus[account.id] === true}
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-600/20 text-green-400">Logged in</span>
              {:else if authStatus[account.id] === false}
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-red-600/20 text-red-400">Not logged in</span>
              {:else}
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-elevated text-text-muted">Checking…</span>
              {/if}
            </div>
            {#if account.config_dir}
              <p class="text-[11px] text-text-muted mt-1 truncate" title={account.config_dir}>{account.config_dir}</p>
            {/if}
            {#if usage}
              <div class="mt-2 space-y-1">
                <div class="flex items-center gap-2">
                  <span class="text-[10px] text-text-muted w-5">5h</span>
                  <div class="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                    <div class="h-full rounded-full" style="width: {Math.min(100, usage.five_hour.utilization)}%; background: {account.color};"></div>
                  </div>
                  <span class="text-[10px] text-text-muted tabular-nums w-8 text-right">{Math.round(usage.five_hour.utilization)}%</span>
                  <span class="text-[10px] text-text-muted whitespace-nowrap">resets in {formatTimeRemaining(usage.five_hour.resets_at)}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-[10px] text-text-muted w-5">7d</span>
                  <div class="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                    <div class="h-full rounded-full" style="width: {Math.min(100, usage.seven_day.utilization)}%; background: {account.color};"></div>
                  </div>
                  <span class="text-[10px] text-text-muted tabular-nums w-8 text-right">{Math.round(usage.seven_day.utilization)}%</span>
                  <span class="text-[10px] text-text-muted whitespace-nowrap">resets in {formatTimeRemaining(usage.seven_day.resets_at)}</span>
                </div>
              </div>
            {:else if usageAuthExpired}
              <p class="text-[11px] text-text-muted mt-2">Usage unavailable — re-login required</p>
            {:else if authStatus[account.id] === false}
              <p class="text-[11px] text-text-muted mt-2">No usage data</p>
            {/if}
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button
              class="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-surface-elevated transition-colors"
              onclick={() => refreshUsage(account)}
            >
              Refresh
            </button>
            <button
              class="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
              onclick={() => startLogin(account.id)}
              disabled={loggingIn[account.id]}
            >
              {loggingIn[account.id] ? "Waiting…" : "Log in…"}
            </button>
            <button
              class="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-surface-elevated transition-colors disabled:opacity-50"
              onclick={() => toggleDisabled(account)}
              disabled={busy[account.id]}
            >
              {account.disabled ? "Enable" : "Disable"}
            </button>
            <button
              class="text-xs px-2 py-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              onclick={() => requestRemove(account.id)}
            >
              Remove
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Add account -->
  {#if providerChoices.length > 0}
    <div class="p-3 bg-surface rounded border border-border space-y-3">
      <h4 class="text-sm font-medium text-text-primary">Add account</h4>
      <div class="flex flex-wrap gap-3 items-end">
        <div class="flex-1 min-w-[10rem]">
          <label class="block text-xs text-text-muted mb-1" for="new-account-label">Label</label>
          <input
            id="new-account-label"
            class="w-full px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
            placeholder="e.g. Work"
            bind:value={newLabel}
          />
        </div>
        {#if providerChoices.length > 1}
          <div class="min-w-[8rem]">
            <label class="block text-xs text-text-muted mb-1" for="new-account-provider">Provider</label>
            <select
              id="new-account-provider"
              class="w-full px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
              bind:value={newProvider}
            >
              {#each providerChoices as choice}
                <option value={choice.value}>{choice.label}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>
      <div>
        <span class="block text-xs text-text-muted mb-1">Color</span>
        <div class="flex flex-wrap gap-2">
          {#each COLOR_PRESETS as color}
            <button
              class="w-6 h-6 rounded-full border-2 transition-transform"
              class:scale-110={newColor === color}
              style="background: {color}; border-color: {newColor === color ? 'var(--color-text-primary)' : 'transparent'};"
              onclick={() => (newColor = color)}
              aria-label={`Use color ${color}`}
            ></button>
          {/each}
        </div>
      </div>
      <button
        class="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
        onclick={handleCreate}
        disabled={!newLabel.trim() || creating}
      >
        {creating ? "Creating…" : "Add & log in"}
      </button>
    </div>
  {:else}
    <p class="text-xs text-text-muted">Enable a provider (Claude or Codex) to add accounts.</p>
  {/if}
</div>

<ConfirmDialog
  show={confirmRemoveId !== null}
  title="Remove account?"
  message={confirmRemoveAccount
    ? `Remove "${confirmRemoveAccount.label}"? Sessions already started under it keep running, but new sessions can no longer use it.`
    : ""}
  confirmLabel="Remove"
  variant="danger"
  onconfirm={handleRemove}
  oncancel={() => (confirmRemoveId = null)}
/>

{#if confirmRemoveId !== null}
  <!-- Second option surfaced with the confirm dialog, centered just beneath its card. -->
  <div class="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
    <label
      class="pointer-events-auto flex items-center gap-2 text-xs text-text-primary bg-surface border border-border rounded-md px-3 py-2 shadow-lg translate-y-[7.5rem] max-w-sm mx-4"
    >
      <input type="checkbox" bind:checked={deleteDirOnRemove} />
      Also delete the profile folder on disk
    </label>
  </div>
{/if}
