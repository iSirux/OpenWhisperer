<script lang="ts">
  import {
    settings,
    type SdkProvider,
    type OpenAiAuthMethod,
  } from "$lib/stores/settings";
  import { OPENAI_MODELS } from "$lib/utils/models";
  import {
    getModelBadgeBgColor,
    getModelTextColor,
  } from "$lib/utils/modelColors";
  import { invoke } from "@tauri-apps/api/core";
  import "./toggle.css";

  // OpenAI auth state
  let openaiAuthStatus = $state<{
    hasAuthFile: boolean;
    hasCli: boolean;
    authenticated: boolean;
  } | null>(null);
  let isRunningLogin = $state(false);
  let apiKeyInput = $state("");
  let hasApiKey = $state(false);
  let showApiKeyInput = $state(false);

  $effect(() => {
    checkOpenAiAuth();
  });

  async function checkOpenAiAuth() {
    try {
      openaiAuthStatus = await invoke<{
        hasAuthFile: boolean;
        hasCli: boolean;
        authenticated: boolean;
      }>("check_openai_codex_auth");
      hasApiKey = await invoke<boolean>("has_openai_api_key");
    } catch {
      openaiAuthStatus = null;
    }
  }

  async function handleCodexLogin() {
    isRunningLogin = true;
    try {
      const success = await invoke<boolean>("run_codex_login");
      if (success) {
        await checkOpenAiAuth();
      }
    } catch (e) {
      console.error("Codex login failed:", e);
    } finally {
      isRunningLogin = false;
    }
  }

  async function handleSaveApiKey() {
    if (!apiKeyInput.trim()) return;
    try {
      await invoke("save_openai_api_key", { apiKey: apiKeyInput.trim() });
      hasApiKey = true;
      apiKeyInput = "";
      showApiKeyInput = false;
    } catch (e) {
      console.error("Failed to save API key:", e);
    }
  }

  async function handleDeleteApiKey() {
    try {
      await invoke("delete_openai_api_key");
      hasApiKey = false;
    } catch (e) {
      console.error("Failed to delete API key:", e);
    }
  }

  function toggleModel(modelId: string) {
    const currentEnabled = $settings.enabled_openai_models || [];
    const isEnabled = currentEnabled.includes(modelId);

    if (isEnabled) {
      if (currentEnabled.length <= 1) {
        return;
      }
      const newEnabled = currentEnabled.filter((id: string) => id !== modelId);
      settings.update((s) => ({ ...s, enabled_openai_models: newEnabled }));

      if ($settings.openai_model === modelId && newEnabled.length > 0) {
        settings.update((s) => ({ ...s, openai_model: newEnabled[0] }));
      }
    } else {
      settings.update((s) => ({
        ...s,
        enabled_openai_models: [...currentEnabled, modelId],
      }));
    }
  }

  function isModelEnabled(modelId: string): boolean {
    return ($settings.enabled_openai_models || []).includes(modelId);
  }
</script>

<div class="space-y-4">
  <!-- Authentication -->
  <div class="border-b border-border pb-4 mb-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">Authentication</h3>
    <div class="p-3 bg-surface rounded border border-border">
      <div class="flex items-center justify-between mb-2">
        <label class="text-sm font-medium text-text-secondary"
          >OpenAI Authentication</label
        >
        {#if openaiAuthStatus?.authenticated || hasApiKey}
          <span
            class="text-xs px-2 py-0.5 rounded-full bg-green-600/20 text-green-400"
            >Connected</span
          >
        {:else}
          <span
            class="text-xs px-2 py-0.5 rounded-full bg-yellow-600/20 text-yellow-400"
            >Not configured</span
          >
        {/if}
      </div>

      <div class="space-y-2">
        <div>
          <label class="block text-xs text-text-muted mb-1">Auth Method</label>
          <select
            class="w-full px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
            bind:value={$settings.openai_auth_method}
          >
            <option value="OAuth">OAuth (recommended) - via codex login</option>
            <option value="ApiKey">API Key</option>
          </select>
        </div>

        {#if $settings.openai_auth_method === "OAuth"}
          <div class="flex items-center gap-2">
            {#if openaiAuthStatus?.authenticated}
              <div class="flex items-center gap-1.5 text-xs text-green-400">
                <svg
                  class="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clip-rule="evenodd"
                  />
                </svg>
                Authenticated via Codex CLI
              </div>
            {:else}
              <button
                class="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-500 transition-colors disabled:opacity-50"
                onclick={handleCodexLogin}
                disabled={isRunningLogin}
              >
                {isRunningLogin ? "Logging in..." : "Login with OpenAI"}
              </button>
              {#if !openaiAuthStatus?.hasCli}
                <span class="text-xs text-text-muted"
                  >Codex CLI not found. Install with: npm i -g @openai/codex</span
                >
              {/if}
            {/if}
          </div>
        {:else}
          <div>
            {#if hasApiKey}
              <div class="flex items-center gap-2">
                <span class="text-xs text-green-400">API key saved</span>
                <button
                  class="text-xs text-red-400 hover:text-red-300"
                  onclick={handleDeleteApiKey}>Remove</button
                >
              </div>
            {:else if showApiKeyInput}
              <div class="flex gap-2">
                <input
                  type="password"
                  class="flex-1 px-2 py-1.5 bg-background border border-border rounded text-xs focus:outline-none focus:border-accent"
                  placeholder="sk-..."
                  bind:value={apiKeyInput}
                />
                <button
                  class="px-3 py-1.5 bg-accent text-white text-xs rounded hover:bg-accent-hover transition-colors"
                  onclick={handleSaveApiKey}
                  disabled={!apiKeyInput.trim()}>Save</button
                >
                <button
                  class="px-2 py-1.5 text-xs text-text-muted hover:text-text-secondary"
                  onclick={() => {
                    showApiKeyInput = false;
                    apiKeyInput = "";
                  }}>Cancel</button
                >
              </div>
            {:else}
              <button
                class="text-xs text-accent hover:underline"
                onclick={() => (showApiKeyInput = true)}>Add API key</button
              >
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="border-t border-border pt-4 mt-4">
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Terminal Mode</label
    >
    <select
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.codex_mode}
    >
      <option value="AppServer">Codex App Server (Recommended)</option>
      <option value="Sdk">SDK (Codex SDK, not recommended)</option>
    </select>
    <p class="text-xs text-text-muted mt-1">
      {#if $settings.codex_mode === "AppServer"}
        Uses Codex App Server JSON-RPC over stdio in the integrated session
        view.
      {:else if $settings.codex_mode === "Sdk"}
        Uses the integrated Codex SDK session view with structured tool events.
        Codex SDK mode is not recommended.
      {/if}
    </p>
  </div>

  <!-- Enabled Models -->
  <div>
    <h3 class="text-sm font-medium text-text-primary mb-2">Enabled Models</h3>
    <p class="text-xs text-text-muted mb-3">
      Select which Codex models are available in the model selector and for
      hotkey cycling. At least one model must remain enabled.
    </p>
    <div class="space-y-2">
      {#each OPENAI_MODELS as model}
        {@const enabled = isModelEnabled(model.id)}
        {@const isOnlyEnabled =
          enabled && ($settings.enabled_openai_models || []).length === 1}
        <button
          class="w-full flex items-center justify-between p-3 rounded border-2 transition-all {enabled
            ? 'border-green-600 bg-green-600/10'
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
              class:border-green-600={enabled}
              class:bg-green-600={enabled}
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
                    model.id,
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

  <!-- Default Model -->
  <div class="border-t border-border pt-4 mt-4">
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Default Model</label
    >
    <select
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.openai_model}
    >
      {#each OPENAI_MODELS.filter((m) => isModelEnabled(m.id)) as model}
        <option value={model.id}>{model.label} - {model.title}</option>
      {/each}
    </select>
    <p class="text-xs text-text-muted mt-1">
      Default model for new Codex sessions.
    </p>
  </div>
</div>
