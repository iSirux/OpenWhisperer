<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { get } from 'svelte/store';
  import { settings, type LlmProvider } from '$lib/stores/settings';

  interface LlmTestResult {
    success: boolean;
    error: string | null;
    model_info: string | null;
  }

  const PROVIDER_PRESETS: Record<string, { model: string; endpoint: string | null }> = {
    Groq: { model: 'openai/gpt-oss-120b', endpoint: null },
    Gemini: { model: 'gemini-3.1-flash-lite', endpoint: null },
    OpenAI: { model: 'gpt-5.4-mini', endpoint: null },
    Local: { model: 'local-model', endpoint: 'http://localhost:1234/v1/chat/completions' },
  };

  const KEY_LINKS: Record<string, { label: string; url: string }> = {
    Groq: { label: 'Get a free Groq API key', url: 'https://console.groq.com/keys' },
    Gemini: { label: 'Get a free Gemini API key', url: 'https://aistudio.google.com/apikey' },
    OpenAI: { label: 'Get an OpenAI API key', url: 'https://platform.openai.com/api-keys' },
  };

  let apiKey = $state('');
  let apiKeySet = $state(false);
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state<LlmTestResult | null>(null);

  const provider = $derived($settings.llm.provider);
  const needsKey = $derived(provider !== 'Local');
  const enabled = $derived($settings.llm.enabled);

  onMount(async () => {
    // Default fresh installs to Groq — free tier, fast, one key.
    if (!get(settings).llm.enabled && get(settings).llm.provider === 'Gemini') {
      applyProvider('Groq');
    }
    try {
      apiKeySet = await invoke<boolean>('has_gemini_api_key');
    } catch {
      apiKeySet = false;
    }
  });

  function applyProvider(next: LlmProvider) {
    const preset = PROVIDER_PRESETS[next];
    settings.update((s) => ({
      ...s,
      llm: {
        ...s.llm,
        provider: next,
        ...(preset ? { model: preset.model, endpoint: preset.endpoint } : {}),
      },
    }));
  }

  async function enableAndTest() {
    saving = true;
    testResult = null;
    try {
      if (needsKey && apiKey.trim()) {
        // One keyring slot serves every provider despite the legacy command name.
        await invoke('save_gemini_api_key', { apiKey: apiKey.trim() });
        apiKey = '';
        apiKeySet = true;
      }
      settings.update((s) => ({ ...s, llm: { ...s.llm, enabled: true } }));
      // The test reads the backend config, so persist before testing.
      await invoke('save_config', { newConfig: get(settings) });
      testing = true;
      testResult = await invoke<LlmTestResult>('test_gemini_connection');
      if (!testResult.success) {
        settings.update((s) => ({ ...s, llm: { ...s.llm, enabled: false } }));
        await invoke('save_config', { newConfig: get(settings) });
      }
    } catch (e) {
      testResult = { success: false, error: String(e), model_info: null };
    } finally {
      saving = false;
      testing = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="p-3 bg-surface rounded-lg border border-border/50 text-sm text-text-secondary">
    Optional but recommended. A small, fast model quietly improves everything:
    <ul class="mt-2 text-text-muted list-disc list-inside space-y-0.5">
      <li>Fixes transcription slips (homophones, technical terms)</li>
      <li>Names your sessions automatically</li>
      <li>Picks the right model, effort level, and repository for each prompt</li>
    </ul>
  </div>

  {#if enabled && testResult?.success}
    <div class="p-4 bg-surface-elevated border border-border rounded-lg">
      <p class="text-sm text-success flex items-center gap-1.5">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
            clip-rule="evenodd"
          />
        </svg>
        Smart features are on{testResult.model_info ? ` (${testResult.model_info})` : ''}.
      </p>
    </div>
  {:else}
    <div class="p-4 bg-surface-elevated border border-border rounded-lg space-y-3">
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Provider</label>
        <select
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
          value={provider}
          onchange={(e) => applyProvider((e.target as HTMLSelectElement).value as LlmProvider)}
        >
          <option value="Groq">Groq (free tier — recommended)</option>
          <option value="Gemini">Google Gemini (free tier — limited)</option>
          <option value="OpenAI">OpenAI</option>
          <option value="Local">Local (LM Studio, Ollama, etc.)</option>
        </select>
      </div>

      {#if needsKey}
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-sm font-medium text-text-secondary">API key</label>
            {#if KEY_LINKS[provider]}
              <a class="text-xs text-accent hover:underline" href={KEY_LINKS[provider].url}>
                {KEY_LINKS[provider].label} →
              </a>
            {/if}
          </div>
          <input
            type="password"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            placeholder={apiKeySet ? 'Key already saved — leave empty to keep it' : 'Paste your API key'}
            bind:value={apiKey}
          />
        </div>
      {:else}
        <div>
          <label class="block text-sm font-medium text-text-secondary mb-1">Endpoint</label>
          <input
            type="text"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
            bind:value={$settings.llm.endpoint}
            placeholder="http://localhost:1234/v1/chat/completions"
          />
        </div>
      {/if}

      <button
        class="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center gap-2"
        onclick={enableAndTest}
        disabled={saving || testing || (needsKey && !apiKey.trim() && !apiKeySet)}
      >
        {#if saving || testing}
          <div class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          Testing…
        {:else}
          Enable smart features
        {/if}
      </button>

      {#if testResult && !testResult.success}
        <p class="text-xs text-error">{testResult.error || 'Connection test failed'}</p>
      {/if}

      <p class="text-xs text-text-muted">
        Not now? Skip ahead — everything works without it, and it lives in Settings → LLM.
      </p>
    </div>
  {/if}
</div>
