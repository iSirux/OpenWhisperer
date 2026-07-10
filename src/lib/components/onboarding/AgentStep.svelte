<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores/settings';

  interface ClaudeAuthStatus {
    hasEnvKey: boolean;
    hasOAuth: boolean;
    hasKeyringKey: boolean;
    authenticated: boolean;
  }
  interface CodexAuthStatus {
    hasAuthFile: boolean;
    hasCli: boolean;
    authenticated: boolean;
  }

  type Choice = 'claude' | 'codex' | 'both';

  let claudeAuth = $state<ClaudeAuthStatus | null>(null);
  let codexAuth = $state<CodexAuthStatus | null>(null);
  let runningCodexLogin = $state(false);
  let claudeApiKeyInput = $state('');
  let openaiApiKeyInput = $state('');
  let showClaudeKeyInput = $state(false);
  let showOpenaiKeyInput = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const choice = $derived<Choice>(
    $settings.enabled_providers.claude && $settings.enabled_providers.openai
      ? 'both'
      : $settings.enabled_providers.openai
        ? 'codex'
        : 'claude'
  );
  const claudeEnabled = $derived($settings.enabled_providers.claude);
  const openaiEnabled = $derived($settings.enabled_providers.openai);

  onMount(() => {
    void checkAuth();
    // Auth is a couple of cheap file/env checks — poll so a `claude login`
    // completed in the external terminal turns the card green by itself.
    pollTimer = setInterval(() => void checkAuth(), 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  async function checkAuth() {
    try {
      claudeAuth = await invoke<ClaudeAuthStatus>('check_claude_auth');
    } catch {
      claudeAuth = null;
    }
    try {
      codexAuth = await invoke<CodexAuthStatus>('check_openai_codex_auth');
    } catch {
      codexAuth = null;
    }
  }

  function select(next: Choice) {
    const enabled = {
      claude: next !== 'codex',
      openai: next !== 'claude',
    };
    settings.update((s) => ({
      ...s,
      enabled_providers: enabled,
      // Keep the default provider inside the enabled set.
      sdk_provider: !enabled.claude ? 'OpenAI' : !enabled.openai ? 'Claude' : s.sdk_provider,
    }));
  }

  async function openClaudeLogin() {
    try {
      await invoke('run_in_terminal', { command: 'claude login' });
    } catch (e) {
      console.error('Failed to open terminal:', e);
    }
  }

  async function runCodexLogin() {
    runningCodexLogin = true;
    try {
      await invoke<boolean>('run_codex_login');
      await checkAuth();
    } catch (e) {
      console.error('Codex login failed:', e);
    } finally {
      runningCodexLogin = false;
    }
  }

  async function saveClaudeApiKey() {
    if (!claudeApiKeyInput.trim()) return;
    try {
      await invoke('save_claude_api_key', { apiKey: claudeApiKeyInput.trim() });
      claudeApiKeyInput = '';
      showClaudeKeyInput = false;
      settings.update((s) => ({ ...s, claude_auth_method: 'ApiKey' }));
      await checkAuth();
    } catch (e) {
      console.error('Failed to save Claude API key:', e);
    }
  }

  async function saveOpenaiApiKey() {
    if (!openaiApiKeyInput.trim()) return;
    try {
      await invoke('save_openai_api_key', { apiKey: openaiApiKeyInput.trim() });
      openaiApiKeyInput = '';
      showOpenaiKeyInput = false;
      settings.update((s) => ({ ...s, openai_auth_method: 'ApiKey' }));
      await checkAuth();
    } catch (e) {
      console.error('Failed to save OpenAI API key:', e);
    }
  }
</script>

<div class="space-y-5">
  <!-- Provider choice -->
  <div class="grid grid-cols-3 gap-3">
    <button
      class="p-4 rounded-lg border-2 transition-all text-center {choice === 'claude'
        ? 'border-accent bg-accent/10'
        : 'border-border bg-surface-elevated hover:border-text-muted'}"
      onclick={() => select('claude')}
    >
      <div class="font-semibold text-sm text-text-primary">Claude</div>
      <p class="text-xs text-text-muted mt-1">Anthropic</p>
    </button>
    <button
      class="p-4 rounded-lg border-2 transition-all text-center {choice === 'codex'
        ? 'border-accent bg-accent/10'
        : 'border-border bg-surface-elevated hover:border-text-muted'}"
      onclick={() => select('codex')}
    >
      <div class="font-semibold text-sm text-text-primary">Codex</div>
      <p class="text-xs text-text-muted mt-1">OpenAI</p>
    </button>
    <button
      class="p-4 rounded-lg border-2 transition-all text-center {choice === 'both'
        ? 'border-accent bg-accent/10'
        : 'border-border bg-surface-elevated hover:border-text-muted'}"
      onclick={() => select('both')}
    >
      <div class="font-semibold text-sm text-text-primary">Both</div>
      <p class="text-xs text-text-muted mt-1">Switch anytime</p>
    </button>
  </div>
  <p class="text-xs text-text-muted -mt-2">
    Only what you pick here shows up in the app — no provider switcher clutter if you use just one.
  </p>

  <!-- Claude auth -->
  {#if claudeEnabled}
    <div class="p-4 bg-surface-elevated border border-border rounded-lg">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium text-text-primary">Claude</span>
        {#if claudeAuth?.authenticated}
          <span class="text-xs px-2 py-0.5 rounded-full bg-green-600/20 text-green-400">Connected</span>
        {:else}
          <span class="text-xs px-2 py-0.5 rounded-full bg-yellow-600/20 text-yellow-400">Not signed in</span>
        {/if}
      </div>
      {#if claudeAuth?.authenticated}
        <p class="text-xs text-text-muted">
          {#if claudeAuth.hasOAuth}
            Using your existing Claude CLI login.
          {:else if claudeAuth.hasEnvKey}
            Using ANTHROPIC_API_KEY from your environment.
          {:else}
            Using the API key saved in your keyring.
          {/if}
        </p>
      {:else}
        <p class="text-xs text-text-muted mb-3">
          Sign in with the Claude CLI — a terminal will open, and this card turns green once you're done.
        </p>
        <div class="flex items-center gap-2 flex-wrap">
          <button
            class="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            onclick={openClaudeLogin}
          >
            Open terminal to log in
          </button>
          <button
            class="px-3 py-1.5 text-sm bg-surface hover:bg-border rounded transition-colors"
            onclick={() => (showClaudeKeyInput = !showClaudeKeyInput)}
          >
            Use an API key instead
          </button>
        </div>
        {#if showClaudeKeyInput}
          <div class="flex gap-2 mt-3">
            <input
              type="password"
              class="flex-1 px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
              placeholder="sk-ant-..."
              bind:value={claudeApiKeyInput}
            />
            <button
              class="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
              onclick={saveClaudeApiKey}
              disabled={!claudeApiKeyInput.trim()}
            >
              Save
            </button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Codex auth -->
  {#if openaiEnabled}
    <div class="p-4 bg-surface-elevated border border-border rounded-lg">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium text-text-primary">Codex</span>
        {#if codexAuth?.authenticated}
          <span class="text-xs px-2 py-0.5 rounded-full bg-green-600/20 text-green-400">Connected</span>
        {:else}
          <span class="text-xs px-2 py-0.5 rounded-full bg-yellow-600/20 text-yellow-400">Not signed in</span>
        {/if}
      </div>
      {#if codexAuth?.authenticated}
        <p class="text-xs text-text-muted">Using your existing Codex CLI login.</p>
      {:else}
        <p class="text-xs text-text-muted mb-3">
          Sign in with your OpenAI account, or paste an API key.
        </p>
        <div class="flex items-center gap-2 flex-wrap">
          <button
            class="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-60"
            onclick={runCodexLogin}
            disabled={runningCodexLogin}
          >
            {runningCodexLogin ? 'Waiting for login…' : 'Log in with OpenAI'}
          </button>
          <button
            class="px-3 py-1.5 text-sm bg-surface hover:bg-border rounded transition-colors"
            onclick={() => (showOpenaiKeyInput = !showOpenaiKeyInput)}
          >
            Use an API key instead
          </button>
        </div>
        {#if showOpenaiKeyInput}
          <div class="flex gap-2 mt-3">
            <input
              type="password"
              class="flex-1 px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
              placeholder="sk-..."
              bind:value={openaiApiKeyInput}
            />
            <button
              class="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
              onclick={saveOpenaiApiKey}
              disabled={!openaiApiKeyInput.trim()}
            >
              Save
            </button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
