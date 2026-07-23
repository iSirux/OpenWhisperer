<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { ALL_MODELS } from "$lib/utils/models";
  import {
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import { invoke } from "@tauri-apps/api/core";
  import "./toggle.css";

  // Claude auth state
  let claudeAuthStatus = $state<{ hasEnvKey: boolean; hasOAuth: boolean; hasKeyringKey: boolean; authenticated: boolean } | null>(null);
  let apiKeyInput = $state('');
  let hasApiKey = $state(false);
  let showApiKeyInput = $state(false);

  $effect(() => {
    checkClaudeAuth();
  });

  async function checkClaudeAuth() {
    try {
      claudeAuthStatus = await invoke<{ hasEnvKey: boolean; hasOAuth: boolean; hasKeyringKey: boolean; authenticated: boolean }>('check_claude_auth');
      hasApiKey = await invoke<boolean>('has_claude_api_key');
    } catch {
      claudeAuthStatus = null;
    }
  }

  async function handleSaveApiKey() {
    if (!apiKeyInput.trim()) return;
    try {
      await invoke('save_claude_api_key', { apiKey: apiKeyInput.trim() });
      hasApiKey = true;
      apiKeyInput = '';
      showApiKeyInput = false;
      await checkClaudeAuth();
    } catch (e) {
      console.error('Failed to save API key:', e);
    }
  }

  async function handleDeleteApiKey() {
    try {
      await invoke('delete_claude_api_key');
      hasApiKey = false;
      await checkClaudeAuth();
    } catch (e) {
      console.error('Failed to delete API key:', e);
    }
  }

  function toggleModel(modelId: string) {
    const currentEnabled = $settings.enabled_models || [];
    const isEnabled = currentEnabled.includes(modelId);

    if (isEnabled) {
      // Don't allow disabling if it would leave less than 1 model enabled
      if (currentEnabled.length <= 1) {
        return;
      }
      // Remove the model
      const newEnabled = currentEnabled.filter((id: string) => id !== modelId);
      settings.update((s) => ({ ...s, enabled_models: newEnabled }));

      // If the default model was disabled, switch to the first enabled model
      if ($settings.default_model === modelId && newEnabled.length > 0) {
        settings.update((s) => ({ ...s, default_model: newEnabled[0] }));
      }
    } else {
      // Add the model
      settings.update((s) => ({
        ...s,
        enabled_models: [...currentEnabled, modelId],
      }));
    }
  }

  function isModelEnabled(modelId: string): boolean {
    return ($settings.enabled_models || []).includes(modelId);
  }

</script>

<div class="space-y-4">
  <!-- Authentication -->
  <div class="border-b border-border pb-4 mb-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">Authentication</h3>
    <div class="p-3 bg-surface rounded border border-border">
      <div class="flex items-center justify-between mb-2">
        <label class="text-sm font-medium text-text-secondary">Anthropic Authentication</label>
        {#if claudeAuthStatus?.authenticated}
          <span class="text-xs px-2 py-0.5 rounded-full bg-green-600/20 text-green-400">Connected</span>
        {:else}
          <span class="text-xs px-2 py-0.5 rounded-full bg-yellow-600/20 text-yellow-400">Not configured</span>
        {/if}
      </div>

      <div class="space-y-2">
        <div>
          <label class="block text-xs text-text-muted mb-1">Auth Method</label>
          <select
            class="w-full px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
            bind:value={$settings.claude_auth_method}
          >
            <option value="OAuth">OAuth - via Claude CLI login</option>
            <option value="ApiKey">API Key (ANTHROPIC_API_KEY)</option>
          </select>
        </div>

        {#if $settings.claude_auth_method === 'OAuth'}
          <div class="flex items-center gap-2">
            {#if claudeAuthStatus?.hasOAuth}
              <div class="flex items-center gap-1.5 text-xs text-green-400">
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
                Authenticated via Claude CLI
              </div>
            {:else if claudeAuthStatus?.hasEnvKey}
              <div class="flex items-center gap-1.5 text-xs text-green-400">
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
                ANTHROPIC_API_KEY found in environment
              </div>
            {:else}
              <span class="text-xs text-text-muted">
                Run <code class="px-1 py-0.5 bg-background rounded text-text-secondary">claude login</code> to authenticate, or switch to API Key mode.
              </span>
            {/if}
          </div>
        {:else}
          <!-- API Key -->
          <div>
            {#if hasApiKey || claudeAuthStatus?.hasEnvKey}
              <div class="flex items-center gap-2">
                {#if hasApiKey}
                  <span class="text-xs text-green-400">API key saved in keyring</span>
                  <button
                    class="text-xs text-red-400 hover:text-red-300"
                    onclick={handleDeleteApiKey}
                  >Remove</button>
                {:else}
                  <span class="text-xs text-green-400">ANTHROPIC_API_KEY found in environment</span>
                {/if}
              </div>
            {:else if showApiKeyInput}
              <div class="flex gap-2">
                <input
                  type="password"
                  class="flex-1 px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
                  placeholder="sk-ant-..."
                  bind:value={apiKeyInput}
                />
                <button
                  class="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-accent-hover transition-colors"
                  onclick={handleSaveApiKey}
                  disabled={!apiKeyInput.trim()}
                >Save</button>
                <button
                  class="px-2 py-1.5 text-xs text-text-muted hover:text-text-secondary"
                  onclick={() => { showApiKeyInput = false; apiKeyInput = ''; }}
                >Cancel</button>
              </div>
            {:else}
              <button
                class="text-xs text-accent hover:underline"
                onclick={() => showApiKeyInput = true}
              >Add API key</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="pt-1 pb-4 mb-4 border-b border-border">
    <h3 class="text-sm font-medium text-text-primary mb-2">
      Permission mode
    </h3>
    <p class="text-xs text-text-muted mb-3">
      Controls how new Claude sessions handle tool permissions.
      <strong class="text-text-secondary">Accept edits</strong> is the current behavior — file
      edits auto-apply and other tools (including Bash) run without prompts.
      <strong class="text-text-secondary">Auto</strong> opts into the SDK's research-preview
      mode: an AI classifier reviews each tool call and runs safe ones automatically while
      blocking risky ones server-side. Applies to new Claude sessions only.
    </p>
    <div class="p-3 bg-surface rounded border border-border">
      <label for="claude-permission-mode" class="block text-xs text-text-muted mb-1">Mode</label>
      <select
        id="claude-permission-mode"
        class="w-full px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
        bind:value={$settings.claude_permission_mode}
      >
        <option value="AcceptEdits">Accept edits (default)</option>
        <option value="Auto">Auto (AI-classified, research preview)</option>
      </select>
    </div>
  </div>

  <div class="pt-1 pb-4 mb-4 border-b border-border">
    <h3 class="text-sm font-medium text-text-primary mb-2">
      Auto-compaction
    </h3>
    <p class="text-xs text-text-muted mb-3">
      When on, Claude Code's built-in default applies — compaction fires at ~83.5%, with a
      33K-token buffer reserved for the summarization pass. That is the optimum: the
      <code class="px-1 py-0.5 bg-background rounded text-text-secondary">CLAUDE_AUTOCOMPACT_PCT_OVERRIDE</code>
      env var is silently clamped to this default, so we cannot raise it higher; lowering it only
      wastes context without preventing single-turn tool-result overflows.
      When off, sessions set
      <code class="px-1 py-0.5 bg-background rounded text-text-secondary">DISABLE_AUTO_COMPACT=1</code>
      (the only reliable way to disable). Applies to new Claude sessions.
    </p>
    <div class="flex items-center justify-between p-3 bg-surface rounded border border-border">
      <label for="default-autocompact-enabled" class="text-sm text-text-secondary">
        Enable auto-compaction for new sessions
      </label>
      <input
        id="default-autocompact-enabled"
        type="checkbox"
        class="toggle"
        bind:checked={$settings.default_autocompact_enabled}
      />
    </div>
  </div>

  <div class="pt-1">
    <h3 class="text-sm font-medium text-text-primary mb-2">
      Enabled Models
    </h3>
    <p class="text-xs text-text-muted mb-3">
      Select which models are available in the model selector and for
      hotkey cycling. At least one model must remain enabled.
    </p>
    <div class="space-y-2">
      {#each ALL_MODELS as model}
        {@const enabled = isModelEnabled(model.id)}
        {@const isOnlyEnabled =
          enabled && ($settings.enabled_models || []).length === 1}
        <button
          class="w-full flex items-center justify-between p-3 rounded border-2 transition-all {enabled
            ? 'border-accent bg-accent/10'
            : 'border-border opacity-50'}"
          class:cursor-not-allowed={isOnlyEnabled}
          onclick={() => toggleModel(model.id)}
          title={isOnlyEnabled
            ? "At least one model must remain enabled"
            : model.title}
        >
          <div class="flex items-center gap-3">
            <div
              class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors"
              class:border-accent={enabled}
              class:bg-accent={enabled}
              class:border-border={!enabled}
            >
              {#if enabled}
                <svg
                  class="w-3 h-3 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="3"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              {/if}
            </div>
            <div class="text-left">
              <div class="flex items-center gap-2">
                <span
                  class="text-sm font-medium px-2 py-0.5 rounded {getModelBadgeBgColor(
                    model.id
                  )} {getModelTextColor(model.id)}">{model.label}</span
                >
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                {model.title}
              </p>
            </div>
          </div>
          {#if isOnlyEnabled}
            <span class="text-xs text-text-muted">Required</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>
