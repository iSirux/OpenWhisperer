<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import "./toggle.css";

  interface LlmTestResult {
    success: boolean;
    error: string | null;
    model_info: string | null;
  }

  let geminiApiKey = $state("");
  let geminiApiKeySet = $state(false);
  let testingGemini = $state(false);
  let savingGeminiKey = $state(false);
  let geminiStatus: "idle" | "success" | "error" = $state("idle");
  let geminiTestResult: LlmTestResult | null = $state(null);

  onMount(() => {
    checkGeminiApiKey();
  });

  async function checkGeminiApiKey() {
    try {
      geminiApiKeySet = await invoke<boolean>("has_gemini_api_key");
    } catch (error) {
      console.error("Failed to check Gemini API key:", error);
      geminiApiKeySet = false;
    }
  }

  async function saveGeminiApiKey() {
    if (!geminiApiKey.trim()) return;
    savingGeminiKey = true;
    try {
      await invoke("save_gemini_api_key", { apiKey: geminiApiKey.trim() });
      geminiApiKeySet = true;
      geminiApiKey = "";
      geminiStatus = "idle";
    } catch (error) {
      console.error("Failed to save Gemini API key:", error);
    }
    savingGeminiKey = false;
  }

  async function deleteGeminiApiKey() {
    if (!confirm("Are you sure you want to remove your Gemini API key?"))
      return;
    try {
      await invoke("delete_gemini_api_key");
      geminiApiKeySet = false;
      geminiStatus = "idle";
      geminiTestResult = null;
      // Disable Gemini when key is removed
      settings.update((s) => ({ ...s, llm: { ...s.llm, enabled: false } }));
    } catch (error) {
      console.error("Failed to delete Gemini API key:", error);
    }
  }

  async function testGeminiConnection() {
    testingGemini = true;
    geminiStatus = "idle";
    geminiTestResult = null;
    try {
      // Save current settings first to ensure backend has latest config
      // This fixes the race condition with the debounced auto-save
      await invoke("save_config", { newConfig: $settings });

      const result = await invoke<LlmTestResult>("test_gemini_connection");
      geminiTestResult = result;
      geminiStatus = result.success ? "success" : "error";
    } catch (error) {
      console.error("Failed to test LLM connection:", error);
      geminiStatus = "error";
      geminiTestResult = {
        success: false,
        error: String(error),
        model_info: null,
      };
    }
    testingGemini = false;
  }
</script>

<div class="space-y-4">
  <div class="p-3 bg-surface-elevated rounded border border-border">
    <div class="flex items-center gap-2 mb-2">
      <svg class="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <span class="text-sm font-medium text-text-primary">LLM Integration</span>
    </div>
    <p class="text-xs text-text-muted">
      Use a lightweight LLM for auxiliary tasks like session naming, interaction
      detection, and note structuring. Supports Google Gemini, OpenAI, Groq, or
      local models (LM Studio, Ollama, etc.).
    </p>
  </div>

  <!-- Provider Selection -->
  <div>
    <label class="block text-sm font-medium text-text-secondary mb-1"
      >Provider</label
    >
    <select
      class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
      bind:value={$settings.llm.provider}
      onchange={async (e) => {
        const provider = (e.target as HTMLSelectElement).value;
        // Apply provider presets
        if (provider === "Gemini") {
          $settings.llm.model = "gemini-2.5-flash-lite";
          $settings.llm.endpoint = null;
        } else if (provider === "OpenAI") {
          $settings.llm.model = "gpt-4o-mini";
          $settings.llm.endpoint = null;
        } else if (provider === "Groq") {
          $settings.llm.model = "meta-llama/llama-4-maverick-17b-128e-instruct";
          $settings.llm.endpoint = null;
        } else if (provider === "Local") {
          $settings.llm.model = "local-model";
          $settings.llm.endpoint = "http://localhost:1234/v1/chat/completions";
        }
        // Save immediately so backend has the new provider right away
        await invoke("save_config", { newConfig: $settings });
      }}
    >
      <option value="Groq">Groq (free tier - recommended)</option>
      <option value="Gemini">Google Gemini (free tier - limited)</option>
      <option value="OpenAI">OpenAI</option>
      <option value="Local">Local (LM Studio, Ollama, etc.)</option>
      <option value="Custom">Custom OpenAI-compatible</option>
    </select>
    <p class="text-xs text-text-muted mt-1">
      {#if $settings.llm.provider === "Gemini"}
        Free tier: 20 requests/day (reduced Dec 2025) - <a
          href="https://aistudio.google.com/apikey"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer">Get API key</a
        >
      {:else if $settings.llm.provider === "OpenAI"}
        Paid API - <a
          href="https://platform.openai.com/api-keys"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer">Get API key</a
        >
      {:else if $settings.llm.provider === "Groq"}
        Free tier available - <a
          href="https://console.groq.com/keys"
          class="text-accent hover:underline"
          target="_blank"
          rel="noopener noreferrer">Get API key</a
        >
      {:else if $settings.llm.provider === "Local"}
        No API key needed for local models
      {:else}
        Any OpenAI-compatible chat completions endpoint
      {/if}
    </p>
  </div>

  <!-- Endpoint (for Local/Custom) -->
  {#if $settings.llm.provider === "Local" || $settings.llm.provider === "Custom"}
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1"
        >Endpoint</label
      >
      <input
        type="text"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.llm.endpoint}
        placeholder="http://localhost:1234/v1/chat/completions"
        onblur={() => invoke("save_config", { newConfig: $settings })}
      />
    </div>
  {/if}

  <!-- API Key (not for Local) -->
  {#if $settings.llm.provider !== "Local"}
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-3">API Key</h3>
      {#if geminiApiKeySet}
        <div
          class="flex items-center justify-between p-3 bg-success/10 border border-success/30 rounded"
        >
          <div class="flex items-center gap-2">
            <svg
              class="w-4 h-4 text-success"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span class="text-sm text-text-primary">API key configured</span>
          </div>
          <button
            class="px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
            onclick={deleteGeminiApiKey}
          >
            Remove
          </button>
        </div>
      {:else}
        <div class="space-y-2">
          <input
            type="password"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            bind:value={geminiApiKey}
            placeholder="Enter your API key"
          />
          <button
            class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm transition-colors flex items-center gap-2"
            onclick={saveGeminiApiKey}
            disabled={!geminiApiKey.trim() || savingGeminiKey}
          >
            {#if savingGeminiKey}
              <div
                class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
              ></div>
              Saving...
            {:else}
              Save API Key
            {/if}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if geminiApiKeySet || $settings.llm.provider === "Local"}
    <div class="border-t border-border pt-4">
      <div class="flex items-center justify-between mb-4">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Enable LLM Features</label
          >
          <p class="text-xs text-text-muted">
            Use for session naming and interaction detection
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.llm.enabled}
        />
      </div>

      {#if $settings.llm.enabled}
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-1"
              >Model</label
            >
            {#if $settings.llm.provider === "Gemini"}
              <!-- Auto Model Toggle for Gemini -->
              <div
                class="flex items-center justify-between mb-3 p-3 bg-surface-elevated rounded border border-border"
              >
                <div>
                  <span class="text-sm font-medium text-text-primary"
                    >Auto Model Selection</span
                  >
                  <p class="text-xs text-text-muted">
                    Automatically select model with fallbacks
                  </p>
                </div>
                <input
                  type="checkbox"
                  class="toggle"
                  checked={$settings.llm.auto_model}
                  onchange={() =>
                    settings.update((s) => ({
                      ...s,
                      llm: { ...s.llm, auto_model: !s.llm.auto_model },
                    }))}
                />
              </div>

              {#if $settings.llm.auto_model}
                <!-- Speed vs Accuracy Toggle -->
                <div class="mb-3">
                  <label
                    class="block text-xs font-medium text-text-secondary mb-2"
                    >Priority</label
                  >
                  <div class="flex gap-2">
                    <button
                      class="flex-1 py-2 px-3 rounded text-sm font-medium transition-all {$settings
                        .llm.model_priority === 'speed'
                        ? 'bg-accent text-white'
                        : 'bg-surface-elevated text-text-secondary hover:bg-border'}"
                      onclick={() =>
                        settings.update((s) => ({
                          ...s,
                          llm: { ...s.llm, model_priority: "speed" },
                        }))}
                    >
                      <div class="flex items-center justify-center gap-2">
                        <svg
                          class="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        Speed
                      </div>
                    </button>
                    <button
                      class="flex-1 py-2 px-3 rounded text-sm font-medium transition-all {$settings
                        .llm.model_priority === 'accuracy'
                        ? 'bg-accent text-white'
                        : 'bg-surface-elevated text-text-secondary hover:bg-border'}"
                      onclick={() =>
                        settings.update((s) => ({
                          ...s,
                          llm: { ...s.llm, model_priority: "accuracy" },
                        }))}
                    >
                      <div class="flex items-center justify-center gap-2">
                        <svg
                          class="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        Accuracy
                      </div>
                    </button>
                  </div>
                  <p class="text-xs text-text-muted mt-2">
                    {#if $settings.llm.model_priority === "speed"}
                      Prioritizes 2.5 Flash-Lite for faster responses, falls
                      back to 2.5 Flash
                    {:else}
                      Prioritizes 2.5 Flash for better quality, falls back to
                      2.5 Flash-Lite
                    {/if}
                  </p>
                </div>
              {:else}
                <!-- Manual Model Selection -->
                <select
                  class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                  bind:value={$settings.llm.model}
                  onchange={() => invoke("save_config", { newConfig: $settings })}
                >
                  <option value="gemini-2.5-flash-lite"
                    >Gemini 2.5 Flash-Lite (Recommended)</option
                  >
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                </select>
                <p class="text-xs text-text-muted mt-1">
                  Both models limited to 20 requests/day on free tier
                </p>
              {/if}
            {:else if $settings.llm.provider === "OpenAI"}
              <select
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                bind:value={$settings.llm.model}
                onchange={() => invoke("save_config", { newConfig: $settings })}
              >
                <option value="gpt-4o-mini">GPT-4o Mini (Recommended)</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
              </select>
            {:else if $settings.llm.provider === "Groq"}
              <select
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                bind:value={$settings.llm.model}
                onchange={() => invoke("save_config", { newConfig: $settings })}
              >
                <option value="meta-llama/llama-4-maverick-17b-128e-instruct"
                  >Llama 4 Maverick 17B (Recommended)</option
                >
                <option value="moonshotai/kimi-k2-instruct-0905"
                  >Kimi K2 (262K context, agentic)</option
                >
                <option value="openai/gpt-oss-120b">GPT-OSS 120B</option>
                <option value="llama-3.3-70b-versatile">Llama 3.3 70B</option>
                <option value="qwen/qwen3-32b">Qwen3 32B</option>
                <option value="meta-llama/llama-4-scout-17b-16e-instruct"
                  >Llama 4 Scout 17B</option
                >
                <option value="openai/gpt-oss-20b">GPT-OSS 20B</option>
                <option value="llama-3.1-8b-instant"
                  >Llama 3.1 8B Instant (fast)</option
                >
              </select>
            {:else}
              <input
                type="text"
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                bind:value={$settings.llm.model}
                placeholder="model-name"
                onblur={() => invoke("save_config", { newConfig: $settings })}
              />
              <p class="text-xs text-text-muted mt-1">
                Enter the model name as expected by your endpoint
              </p>
            {/if}
          </div>

          <button
            class="px-4 py-2 bg-surface-elevated hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
            onclick={testGeminiConnection}
            disabled={testingGemini}
          >
            {#if testingGemini}
              <div
                class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"
              ></div>
              Testing...
            {:else}
              Test Connection
            {/if}
          </button>

          {#if geminiStatus === "success"}
            <p class="text-sm text-success">Connection successful!</p>
          {:else if geminiStatus === "error"}
            <p class="text-sm text-error">
              Connection failed: {geminiTestResult?.error || "Unknown error"}
            </p>
          {/if}

          <div class="border-t border-border pt-4">
            <h3 class="text-sm font-medium text-text-primary mb-2">Features</h3>
            <p class="text-xs text-text-muted mb-3">
              Choose which LLM-powered features to enable. Each feature uses API
              calls against your provider quota.
            </p>
            <div class="space-y-2">
              <!-- Auto-name Sessions -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.auto_name_sessions
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        auto_name_sessions: !s.llm.features.auto_name_sessions,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .auto_name_sessions}
                    class:bg-accent={$settings.llm.features.auto_name_sessions}
                    class:border-border={!$settings.llm.features
                      .auto_name_sessions}
                  >
                    {#if $settings.llm.features.auto_name_sessions}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Auto-name Sessions</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Generate descriptive names and categories for sessions
                      based on the conversation content
                    </p>
                  </div>
                </div>
              </button>

              <!-- Detect Interaction Needed -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.detect_interaction_needed
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        detect_interaction_needed:
                          !s.llm.features.detect_interaction_needed,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .detect_interaction_needed}
                    class:bg-accent={$settings.llm.features
                      .detect_interaction_needed}
                    class:border-border={!$settings.llm.features
                      .detect_interaction_needed}
                  >
                    {#if $settings.llm.features.detect_interaction_needed}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Detect Interaction Needed</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Analyze AI responses to detect when your input is
                      required (questions, approvals, decisions)
                    </p>
                  </div>
                </div>
              </button>

              <!-- Generate Quick Actions -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.generate_quick_actions
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        generate_quick_actions: !s.llm.features.generate_quick_actions,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .generate_quick_actions}
                    class:bg-accent={$settings.llm.features.generate_quick_actions}
                    class:border-border={!$settings.llm.features
                      .generate_quick_actions}
                  >
                    {#if $settings.llm.features.generate_quick_actions}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Generate Quick Actions</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Generate contextual quick action buttons based on the AI
                      response to suggest helpful next steps
                    </p>
                  </div>
                </div>
              </button>

              <!-- Clean Transcription -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.clean_transcription
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        clean_transcription:
                          !s.llm.features.clean_transcription,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .clean_transcription}
                    class:bg-accent={$settings.llm.features.clean_transcription}
                    class:border-border={!$settings.llm.features
                      .clean_transcription}
                  >
                    {#if $settings.llm.features.clean_transcription}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Clean Transcription</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Fix homophones, technical terms, and punctuation in voice
                      transcriptions before sending the prompt
                    </p>
                  </div>
                </div>
              </button>

              <!-- Dual-source transcription sub-option -->
              {#if $settings.llm.features.clean_transcription && $settings.vosk?.enabled}
                <button
                  class="w-full flex items-center justify-between p-3 pl-8 rounded border-2 transition-all text-left {$settings
                    .llm.features.use_dual_transcription
                    ? 'border-purple-500 bg-purple-500/10'
                    : 'border-border hover:border-border/80'}"
                  onclick={() =>
                    settings.update((s) => ({
                      ...s,
                      llm: {
                        ...s.llm,
                        features: {
                          ...s.llm.features,
                          use_dual_transcription:
                            !s.llm.features.use_dual_transcription,
                        },
                      },
                    }))}
                >
                  <div class="flex items-center gap-3">
                    <div
                      class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                      class:border-purple-500={$settings.llm.features
                        .use_dual_transcription}
                      class:bg-purple-500={$settings.llm.features
                        .use_dual_transcription}
                      class:border-border={!$settings.llm.features
                        .use_dual_transcription}
                    >
                      {#if $settings.llm.features.use_dual_transcription}
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
                    <div>
                      <div class="flex items-center gap-2">
                        <svg
                          class="w-4 h-4 text-text-secondary"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                          />
                        </svg>
                        <span class="text-sm font-medium text-text-primary"
                          >Use Dual-Source Cleanup</span
                        >
                      </div>
                      <p class="text-xs text-text-muted mt-0.5">
                        Compare both Vosk (real-time) and Whisper (accurate)
                        transcriptions for maximum accuracy
                      </p>
                    </div>
                  </div>
                </button>
              {/if}

              <!-- Smart Model Selection -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.recommend_model
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        recommend_model: !s.llm.features.recommend_model,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features.recommend_model}
                    class:bg-accent={$settings.llm.features.recommend_model}
                    class:border-border={!$settings.llm.features
                      .recommend_model}
                  >
                    {#if $settings.llm.features.recommend_model}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Smart Model Selection</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Automatically choose the best model based on prompt
                      complexity to optimize cost
                    </p>
                  </div>
                </div>
              </button>

              <!-- Sub-options for Smart Model Selection -->
              {#if $settings.llm.features.recommend_model}
                <div class="mt-3 ml-8 pl-3 border-l-2 border-border space-y-2">
                  <div>
                    <label
                      class="block text-xs font-medium text-text-secondary mb-1.5"
                      >Thinking Mode</label
                    >
                    <div class="flex gap-1">
                      <button
                        class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {$settings
                          .llm.features.auto_model_effort === 'off'
                          ? 'bg-accent text-white'
                          : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                        onclick={() =>
                          settings.update((s) => ({
                            ...s,
                            llm: {
                              ...s.llm,
                              features: {
                                ...s.llm.features,
                                auto_model_effort: "off",
                              },
                            },
                          }))}
                      >
                        Off
                      </button>
                      <button
                        class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {$settings
                          .llm.features.auto_model_effort === 'high'
                          ? 'bg-accent text-white'
                          : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                        onclick={() =>
                          settings.update((s) => ({
                            ...s,
                            llm: {
                              ...s.llm,
                              features: {
                                ...s.llm.features,
                                auto_model_effort: "high",
                              },
                            },
                          }))}
                      >
                        High
                      </button>
                      <button
                        class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {$settings
                          .llm.features.auto_model_effort === 'dynamic'
                          ? 'bg-accent text-white'
                          : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                        onclick={() =>
                          settings.update((s) => ({
                            ...s,
                            llm: {
                              ...s.llm,
                              features: {
                                ...s.llm.features,
                                auto_model_effort: "dynamic",
                              },
                            },
                          }))}
                      >
                        Dynamic
                      </button>
                    </div>
                    <p class="text-xs text-text-muted mt-1">
                      {#if $settings.llm.features.auto_model_effort === 'off'}
                        Effort is always disabled when using auto model
                      {:else if $settings.llm.features.auto_model_effort === 'dynamic'}
                        LLM decides effort level based on prompt complexity
                      {:else}
                        Effort is always set to {$settings.llm.features.auto_model_effort} when using auto model
                      {/if}
                    </p>
                  </div>
                </div>
              {/if}

              <!-- Auto-select Repository -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.auto_select_repo
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        auto_select_repo: !s.llm.features.auto_select_repo,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .auto_select_repo}
                    class:bg-accent={$settings.llm.features.auto_select_repo}
                    class:border-border={!$settings.llm.features
                      .auto_select_repo}
                  >
                    {#if $settings.llm.features.auto_select_repo}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Auto-select Repository</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Automatically select the best repository based on prompt
                      content. Requires repo descriptions to be generated.
                    </p>
                  </div>
                </div>
              </button>

              <!-- Generate Branch Names -->
              <button
                class="w-full flex items-center justify-between p-3 rounded border-2 transition-all text-left {$settings
                  .llm.features.generate_branch_names
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border/80'}"
                onclick={() =>
                  settings.update((s) => ({
                    ...s,
                    llm: {
                      ...s.llm,
                      features: {
                        ...s.llm.features,
                        generate_branch_names:
                          !s.llm.features.generate_branch_names,
                      },
                    },
                  }))}
              >
                <div class="flex items-center gap-3">
                  <div
                    class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                    class:border-accent={$settings.llm.features
                      .generate_branch_names}
                    class:bg-accent={$settings.llm.features
                      .generate_branch_names}
                    class:border-border={!$settings.llm.features
                      .generate_branch_names}
                  >
                    {#if $settings.llm.features.generate_branch_names}
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
                  <div>
                    <div class="flex items-center gap-2">
                      <svg
                        class="w-4 h-4 text-text-secondary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                        />
                      </svg>
                      <span class="text-sm font-medium text-text-primary"
                        >Generate Branch Names</span
                      >
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      Use AI to generate descriptive branch names when creating
                      new worktrees
                    </p>
                  </div>
                </div>
              </button>
            </div>

            <!-- Sub-options for auto-select repo -->
            {#if $settings.llm.features.auto_select_repo}
              <div class="mt-3 ml-8 pl-3 border-l-2 border-border space-y-3">
                <div>
                  <label
                    class="block text-sm font-medium text-text-secondary mb-1"
                    >Minimum Confidence for Auto-Select</label
                  >
                  <p class="text-xs text-text-muted mb-2">
                    Only auto-select repos when LLM confidence meets this
                    threshold
                  </p>
                  <select
                    class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                    bind:value={$settings.llm.min_auto_select_confidence}
                  >
                    <option value="high">High only (most prompts)</option>
                    <option value="medium">Medium or higher</option>
                    <option value="low">Any confidence (fewest prompts)</option>
                  </select>
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <label class="text-sm font-medium text-text-secondary"
                      >Confirm Repo Selection</label
                    >
                    <p class="text-xs text-text-muted">
                      The AI will question the repo selection if it seems wrong
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    class="toggle"
                    bind:checked={$settings.llm.confirm_repo_selection}
                  />
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if $settings.llm.provider === "Gemini"}
    <div class="border-t border-border pt-4 mt-4">
      <h3 class="text-sm font-medium text-text-secondary mb-2">
        Free Tier Limits
      </h3>
      <div class="text-xs text-text-muted space-y-1">
        <p>
          <strong>Gemini 2.5 Flash:</strong> 20 requests/day
        </p>
        <p>
          <strong>Gemini 2.5 Flash-Lite:</strong> 20 requests/day
        </p>
        <p class="mt-2 text-warning">
          ⚠️ Free tier was severely reduced in Dec 2025(previously 250-1,500
          RPD). Consider using Groq for higher limits.
        </p>
        <p class="mt-2 text-text-muted">
          Limits reset at midnight Pacific Time. No credit card required.
        </p>
      </div>
    </div>
  {:else if $settings.llm.provider === "Groq"}
    <div class="border-t border-border pt-4 mt-4">
      <h3 class="text-sm font-medium text-text-secondary mb-2">
        Free Tier Limits
      </h3>
      <div class="text-xs text-text-muted space-y-1">
        <p>
          <strong>Llama 4 Maverick 17B:</strong> 1K RPD - Best quality, multimodal
        </p>
        <p><strong>Kimi K2:</strong> 1K RPD - 262K context, agentic/tool use</p>
        <p><strong>GPT-OSS 120B:</strong> 1K RPD - Solid tool calling</p>
        <p><strong>Llama 3.3 70B:</strong> 1K RPD - Proven reliable</p>
        <p><strong>Qwen3 32B:</strong> 1K RPD - Strong reasoning</p>
        <p><strong>Llama 3.1 8B:</strong> 14.4K RPD - Fast, simple tasks</p>
        <p class="mt-2 text-text-muted">
          Free tier with no credit card required.
        </p>
      </div>
    </div>
  {:else if $settings.llm.provider === "Local"}
    <div class="border-t border-border pt-4 mt-4">
      <h3 class="text-sm font-medium text-text-secondary mb-2">Local Setup</h3>
      <div class="text-xs text-text-muted space-y-1">
        <p>
          <strong>LM Studio:</strong> Download from
          <a
            href="https://lmstudio.ai"
            class="text-accent hover:underline"
            target="_blank">lmstudio.ai</a
          >, load a model, and start the server
        </p>
        <p>
          <strong>Ollama:</strong> Install from
          <a
            href="https://ollama.ai"
            class="text-accent hover:underline"
            target="_blank">ollama.ai</a
          >
          and run
          <code class="bg-background px-1 rounded">ollama serve</code>
        </p>
        <p class="mt-2 text-text-muted">
          Recommended models: Llama 3.1 8B, Mistral 7B, Qwen 2.5
        </p>
      </div>
    </div>
  {/if}
</div>
