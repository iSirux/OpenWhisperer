<script lang="ts">
  import {
    normalizeAutoModelEffort,
    settings,
    type LlmProvider,
    type LlmProfile,
  } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import "./toggle.css";

  interface LlmTestResult {
    success: boolean;
    error: string | null;
    model_info: string | null;
  }

  type ChainKey = "fast_chain" | "quality_chain";

  const PROVIDER_LABEL: Record<LlmProvider, string> = {
    Groq: "Groq",
    Gemini: "Google Gemini",
    OpenAI: "OpenAI",
    Xai: "xAI (Grok)",
    Local: "Local",
    Custom: "Custom",
  };

  const PROVIDER_PRESETS: Record<LlmProvider, { model: string; endpoint: string | null }> = {
    Groq: { model: "openai/gpt-oss-120b", endpoint: null },
    Gemini: { model: "gemini-3.1-flash-lite", endpoint: null },
    OpenAI: { model: "gpt-5.4-mini", endpoint: null },
    Xai: { model: "grok-4-fast", endpoint: null },
    Local: { model: "local-model", endpoint: "http://localhost:1234/v1/chat/completions" },
    Custom: { model: "", endpoint: "" },
  };

  const MODEL_OPTIONS: Partial<Record<LlmProvider, { value: string; label: string }[]>> = {
    Gemini: [
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (Recommended)" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash (smartest)" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3-flash", label: "Gemini 3 Flash" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    ],
    OpenAI: [
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini (Recommended)" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano (cheapest)" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    ],
    Groq: [
      { value: "openai/gpt-oss-120b", label: "GPT-OSS 120B (Recommended)" },
      { value: "qwen/qwen3.6-27b", label: "Qwen3.6 27B (262K context, agentic)" },
      { value: "openai/gpt-oss-20b", label: "GPT-OSS 20B (fast)" },
    ],
    Xai: [
      { value: "grok-4-fast", label: "Grok 4 Fast (Recommended)" },
      { value: "grok-4", label: "Grok 4" },
      { value: "grok-3-mini", label: "Grok 3 Mini" },
    ],
  };

  const KEY_LINKS: Partial<Record<LlmProvider, { label: string; url: string }>> = {
    Groq: { label: "Get API key", url: "https://console.groq.com/keys" },
    Gemini: { label: "Get API key", url: "https://aistudio.google.com/apikey" },
    OpenAI: { label: "Get API key", url: "https://platform.openai.com/api-keys" },
    Xai: { label: "Get API key", url: "https://console.x.ai" },
  };

  const CHAINS: { key: ChainKey; title: string; desc: string }[] = [
    {
      key: "fast_chain",
      title: "Fast tasks",
      desc: "Latency-sensitive & low-stakes calls: model recommendation, repository selection, session naming & outcomes, and branch names.",
    },
    {
      key: "quality_chain",
      title: "Quality tasks",
      desc: "Correctness-critical calls: transcription cleanup, interaction detection, quick actions, commit/PR drafts, and sequence AI nodes.",
    },
  ];

  // Per-profile UI state keyed by profile id
  let keySet = $state<Record<string, boolean>>({});
  let keyInput = $state<Record<string, string>>({});
  let savingKey = $state<Record<string, boolean>>({});
  let testing = $state<Record<string, boolean>>({});
  let testResult = $state<Record<string, LlmTestResult | null>>({});
  let testStatus = $state<Record<string, "idle" | "success" | "error">>({});

  let normalizedAutoModelEffort = $derived(
    normalizeAutoModelEffort($settings.llm.features.auto_model_effort)
  );

  onMount(() => {
    for (const p of $settings.llm.profiles) refreshKey(p.id);
  });

  async function refreshKey(id: string) {
    try {
      keySet[id] = await invoke<boolean>("has_llm_api_key", { profileId: id });
    } catch (error) {
      console.error("Failed to check API key:", error);
      keySet[id] = false;
    }
  }

  async function persist() {
    // Persist immediately so the backend always has the latest routing/profile
    // config (mirrors the existing tab's save-on-change behavior).
    await invoke("save_config", { newConfig: get(settings) });
  }

  function updateProfile(id: string, patch: Partial<LlmProfile>) {
    settings.update((s) => ({
      ...s,
      llm: {
        ...s.llm,
        profiles: s.llm.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      },
    }));
  }

  async function changeProvider(id: string, provider: LlmProvider) {
    const current = $settings.llm.profiles.find((p) => p.id === id);
    const preset = PROVIDER_PRESETS[provider];
    const patch: Partial<LlmProfile> = { provider };
    if (provider === "Custom") {
      // Keep the current model; just ensure the endpoint field is editable.
      patch.endpoint = current?.endpoint ?? "";
    } else {
      patch.model = preset.model;
      patch.endpoint = preset.endpoint;
    }
    updateProfile(id, patch);
    await persist();
  }

  async function addProfile() {
    const id = crypto.randomUUID();
    const preset = PROVIDER_PRESETS.Groq;
    const profile: LlmProfile = {
      id,
      label: `Profile ${$settings.llm.profiles.length + 1}`,
      provider: "Groq",
      model: preset.model,
      endpoint: preset.endpoint,
      auto_model: true,
      model_priority: "speed",
    };
    settings.update((s) => ({
      ...s,
      llm: { ...s.llm, profiles: [...s.llm.profiles, profile] },
    }));
    keySet[id] = false;
    await persist();
  }

  async function deleteProfile(id: string) {
    if ($settings.llm.profiles.length <= 1) return;
    if (
      !confirm(
        "Delete this profile? Its API key will be removed and it will be dropped from both routing chains."
      )
    )
      return;
    settings.update((s) => ({
      ...s,
      llm: {
        ...s.llm,
        profiles: s.llm.profiles.filter((p) => p.id !== id),
        fast_chain: s.llm.fast_chain.filter((x) => x !== id),
        quality_chain: s.llm.quality_chain.filter((x) => x !== id),
      },
    }));
    await persist();
    try {
      await invoke("delete_gemini_api_key", { profileId: id });
    } catch (error) {
      console.error("Failed to delete API key for removed profile:", error);
    }
  }

  async function saveKey(id: string) {
    const val = (keyInput[id] ?? "").trim();
    if (!val) return;
    savingKey[id] = true;
    try {
      await invoke("save_gemini_api_key", { apiKey: val, profileId: id });
      keySet[id] = true;
      keyInput[id] = "";
      testStatus[id] = "idle";
    } catch (error) {
      console.error("Failed to save API key:", error);
    }
    savingKey[id] = false;
  }

  async function deleteKey(id: string) {
    if (!confirm("Remove this profile's API key?")) return;
    try {
      await invoke("delete_gemini_api_key", { profileId: id });
      keySet[id] = false;
      testStatus[id] = "idle";
      testResult[id] = null;
    } catch (error) {
      console.error("Failed to delete API key:", error);
    }
  }

  async function testConnection(id: string) {
    testing[id] = true;
    testStatus[id] = "idle";
    testResult[id] = null;
    try {
      // The backend test reads config from disk, so persist first.
      await persist();
      const r = await invoke<LlmTestResult>("test_gemini_connection", { profileId: id });
      testResult[id] = r;
      testStatus[id] = r.success ? "success" : "error";
    } catch (error) {
      console.error("Failed to test LLM connection:", error);
      testStatus[id] = "error";
      testResult[id] = { success: false, error: String(error), model_info: null };
    }
    testing[id] = false;
  }

  function profileById(id: string) {
    return $settings.llm.profiles.find((p) => p.id === id);
  }

  function availableForChain(key: ChainKey) {
    const inChain = new Set($settings.llm[key]);
    return $settings.llm.profiles.filter((p) => !inChain.has(p.id));
  }

  function moveInChain(key: ChainKey, idx: number, dir: -1 | 1) {
    settings.update((s) => {
      const arr = [...s.llm[key]];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return s;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...s, llm: { ...s.llm, [key]: arr } };
    });
    persist();
  }

  function removeFromChain(key: ChainKey, id: string) {
    settings.update((s) => ({
      ...s,
      llm: { ...s.llm, [key]: s.llm[key].filter((x) => x !== id) },
    }));
    persist();
  }

  function addToChain(key: ChainKey, id: string) {
    if (!id) return;
    settings.update((s) => ({
      ...s,
      llm: { ...s.llm, [key]: [...s.llm[key], id] },
    }));
    persist();
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
      detection, transcription cleanup, and note structuring. Define one or more
      provider profiles (Google Gemini, OpenAI, Groq, xAI, or local models), then
      route Fast and Quality tasks through them with cross-provider fallback.
    </p>
  </div>

  <!-- Enable toggle -->
  <div class="flex items-center justify-between p-3 bg-surface-elevated rounded border border-border">
    <div>
      <label class="text-sm font-medium text-text-secondary">Enable LLM Features</label>
      <p class="text-xs text-text-muted">
        Master switch for all LLM-powered features below
      </p>
    </div>
    <input type="checkbox" class="toggle" bind:checked={$settings.llm.enabled} />
  </div>

  <!-- ============ Section 1: Provider profiles ============ -->
  <div class="border-t border-border pt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="text-sm font-medium text-text-primary">Provider profiles</h3>
        <p class="text-xs text-text-muted">
          Each profile is one provider + model + API key. Reference them from the
          routing chains below.
        </p>
      </div>
      <button
        class="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-border rounded transition-colors flex items-center gap-1.5 flex-shrink-0"
        onclick={addProfile}
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        Add profile
      </button>
    </div>

    <div class="space-y-3">
      {#each $settings.llm.profiles as profile (profile.id)}
        <div class="p-3 bg-surface-elevated rounded border border-border space-y-3">
          <!-- Label + delete -->
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm font-medium focus:outline-none focus:border-accent"
              value={profile.label}
              placeholder="Profile name"
              oninput={(e) =>
                updateProfile(profile.id, { label: (e.target as HTMLInputElement).value })}
              onblur={persist}
            />
            <button
              class="px-2 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              onclick={() => deleteProfile(profile.id)}
              disabled={$settings.llm.profiles.length <= 1}
              title={$settings.llm.profiles.length <= 1
                ? "Can't delete the last profile"
                : "Delete profile"}
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>

          <!-- Provider -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">Provider</label>
            <select
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              value={profile.provider}
              onchange={(e) =>
                changeProvider(profile.id, (e.target as HTMLSelectElement).value as LlmProvider)}
            >
              <option value="Groq">Groq (free tier — recommended)</option>
              <option value="Gemini">Google Gemini (free tier — limited)</option>
              <option value="OpenAI">OpenAI</option>
              <option value="Xai">xAI (Grok)</option>
              <option value="Local">Local (LM Studio, Ollama, etc.)</option>
              <option value="Custom">Custom OpenAI-compatible</option>
            </select>
          </div>

          <!-- Endpoint (Local/Custom) -->
          {#if profile.provider === "Local" || profile.provider === "Custom"}
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">Endpoint</label>
              <input
                type="text"
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono focus:outline-none focus:border-accent"
                value={profile.endpoint ?? ""}
                placeholder="http://localhost:1234/v1/chat/completions"
                oninput={(e) =>
                  updateProfile(profile.id, { endpoint: (e.target as HTMLInputElement).value })}
                onblur={persist}
              />
            </div>
          {/if}

          <!-- Model -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">Model</label>
            {#if profile.provider === "Gemini"}
              <!-- Auto model toggle (Gemini) -->
              <div class="flex items-center justify-between mb-3 p-2.5 bg-background rounded border border-border">
                <div>
                  <span class="text-sm font-medium text-text-primary">Auto Model Selection</span>
                  <p class="text-xs text-text-muted">Automatically select model with fallbacks</p>
                </div>
                <input
                  type="checkbox"
                  class="toggle"
                  checked={profile.auto_model}
                  onchange={() => {
                    updateProfile(profile.id, { auto_model: !profile.auto_model });
                    persist();
                  }}
                />
              </div>

              {#if profile.auto_model}
                <div class="flex gap-2">
                  <button
                    class="flex-1 py-2 px-3 rounded text-sm font-medium transition-all {profile.model_priority ===
                    'speed'
                      ? 'bg-accent text-white'
                      : 'bg-background text-text-secondary hover:bg-border'}"
                    onclick={() => {
                      updateProfile(profile.id, { model_priority: "speed" });
                      persist();
                    }}
                  >
                    Speed
                  </button>
                  <button
                    class="flex-1 py-2 px-3 rounded text-sm font-medium transition-all {profile.model_priority ===
                    'accuracy'
                      ? 'bg-accent text-white'
                      : 'bg-background text-text-secondary hover:bg-border'}"
                    onclick={() => {
                      updateProfile(profile.id, { model_priority: "accuracy" });
                      persist();
                    }}
                  >
                    Accuracy
                  </button>
                </div>
                <p class="text-xs text-text-muted mt-2">
                  {#if profile.model_priority === "speed"}
                    Prioritizes 3.1 Flash-Lite for faster responses, falls back to 3.5 Flash then
                    2.5 Flash-Lite
                  {:else}
                    Prioritizes 3.5 Flash for better quality, falls back to 3.1 Flash-Lite then 2.5
                    Flash
                  {/if}
                </p>
              {:else}
                <select
                  class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                  value={profile.model}
                  onchange={(e) => {
                    updateProfile(profile.id, { model: (e.target as HTMLSelectElement).value });
                    persist();
                  }}
                >
                  {#each MODEL_OPTIONS.Gemini ?? [] as opt}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                </select>
                <p class="text-xs text-text-muted mt-1">
                  Only 3.1 Flash-Lite has real free headroom (500/day); the Flash models are capped
                  at 20/day
                </p>
              {/if}
            {:else if MODEL_OPTIONS[profile.provider]}
              <select
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                value={profile.model}
                onchange={(e) => {
                  updateProfile(profile.id, { model: (e.target as HTMLSelectElement).value });
                  persist();
                }}
              >
                {#each MODEL_OPTIONS[profile.provider] ?? [] as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                value={profile.model}
                placeholder="model-name"
                oninput={(e) =>
                  updateProfile(profile.id, { model: (e.target as HTMLInputElement).value })}
                onblur={persist}
              />
              <p class="text-xs text-text-muted mt-1">
                Enter the model name as expected by your endpoint
              </p>
            {/if}
          </div>

          <!-- API key (not Local) -->
          {#if profile.provider !== "Local"}
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-xs font-medium text-text-secondary">API key</label>
                {#if KEY_LINKS[profile.provider]}
                  <a
                    class="text-xs text-accent hover:underline"
                    href={KEY_LINKS[profile.provider]?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {KEY_LINKS[profile.provider]?.label} →
                  </a>
                {/if}
              </div>
              {#if keySet[profile.id]}
                <div class="flex items-center justify-between p-2.5 bg-success/10 border border-success/30 rounded">
                  <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    <span class="text-sm text-text-primary">API key configured</span>
                  </div>
                  <button
                    class="px-3 py-1 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
                    onclick={() => deleteKey(profile.id)}
                  >
                    Remove
                  </button>
                </div>
              {:else}
                <div class="flex gap-2">
                  <input
                    type="password"
                    class="flex-1 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
                    placeholder="Enter your API key"
                    bind:value={keyInput[profile.id]}
                  />
                  <button
                    class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                    onclick={() => saveKey(profile.id)}
                    disabled={!(keyInput[profile.id] ?? "").trim() || savingKey[profile.id]}
                  >
                    {#if savingKey[profile.id]}
                      <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    {:else}
                      Save
                    {/if}
                  </button>
                </div>
              {/if}
            </div>
          {/if}

          <!-- Test -->
          <div class="flex items-center gap-3">
            <button
              class="px-3 py-1.5 bg-background hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
              onclick={() => testConnection(profile.id)}
              disabled={testing[profile.id]}
            >
              {#if testing[profile.id]}
                <div class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
                Testing…
              {:else}
                Test
              {/if}
            </button>
            {#if testStatus[profile.id] === "success"}
              <span class="text-sm text-success">
                Connection successful{testResult[profile.id]?.model_info
                  ? ` (${testResult[profile.id]?.model_info})`
                  : ""}!
              </span>
            {:else if testStatus[profile.id] === "error"}
              <span class="text-sm text-error">
                Failed: {testResult[profile.id]?.error || "Unknown error"}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- ============ Section 2: Routing ============ -->
  <div class="border-t border-border pt-4">
    <h3 class="text-sm font-medium text-text-primary mb-1">Routing</h3>
    <p class="text-xs text-text-muted mb-3">
      Route each task class through an ordered chain of profiles. Profiles are
      tried in order; the first that succeeds wins.
    </p>

    <div class="space-y-4">
      {#each CHAINS as chain (chain.key)}
        <div class="p-3 bg-surface-elevated rounded border border-border">
          <div class="mb-2">
            <span class="text-sm font-medium text-text-primary">{chain.title}</span>
            <p class="text-xs text-text-muted">{chain.desc}</p>
          </div>

          {#if $settings.llm[chain.key].length === 0}
            <p class="text-xs text-warning mb-2">
              No profiles in this chain — the app will fall back to every profile in order.
            </p>
          {:else}
            <div class="space-y-1.5 mb-2">
              {#each $settings.llm[chain.key] as id, idx (id)}
                {@const p = profileById(id)}
                <div class="flex items-center gap-2 p-2 bg-background rounded border border-border">
                  <span class="text-xs text-text-muted w-4 text-center">{idx + 1}</span>
                  <div class="flex-1 min-w-0">
                    <span class="text-sm text-text-primary truncate">
                      {p ? p.label : id}
                    </span>
                    {#if p}
                      <span class="text-xs text-text-muted ml-1.5">· {PROVIDER_LABEL[p.provider]}</span>
                    {:else}
                      <span class="text-xs text-error ml-1.5">· missing profile</span>
                    {/if}
                  </div>
                  <button
                    class="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                    onclick={() => moveInChain(chain.key, idx, -1)}
                    disabled={idx === 0}
                    title="Move up"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    class="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                    onclick={() => moveInChain(chain.key, idx, 1)}
                    disabled={idx === $settings.llm[chain.key].length - 1}
                    title="Move down"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    class="p-1 text-text-muted hover:text-error"
                    onclick={() => removeFromChain(chain.key, id)}
                    title="Remove from chain"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if availableForChain(chain.key).length > 0}
            <select
              class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
              value=""
              onchange={(e) => {
                const el = e.target as HTMLSelectElement;
                addToChain(chain.key, el.value);
                el.value = "";
              }}
            >
              <option value="" disabled>Add a profile…</option>
              {#each availableForChain(chain.key) as p (p.id)}
                <option value={p.id}>{p.label} · {PROVIDER_LABEL[p.provider]}</option>
              {/each}
            </select>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <!-- ============ Section 3: Features (unchanged) ============ -->
  {#if $settings.llm.enabled}
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-2">Features</h3>
      <p class="text-xs text-text-muted mb-3">
        Choose which LLM-powered features to enable. Each feature uses API calls
        against your provider quota.
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
              class:border-accent={$settings.llm.features.auto_name_sessions}
              class:bg-accent={$settings.llm.features.auto_name_sessions}
              class:border-border={!$settings.llm.features.auto_name_sessions}
            >
              {#if $settings.llm.features.auto_name_sessions}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Auto-name Sessions</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Generate descriptive names and categories for sessions based on the conversation
                content
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
                  detect_interaction_needed: !s.llm.features.detect_interaction_needed,
                },
              },
            }))}
        >
          <div class="flex items-center gap-3">
            <div
              class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
              class:border-accent={$settings.llm.features.detect_interaction_needed}
              class:bg-accent={$settings.llm.features.detect_interaction_needed}
              class:border-border={!$settings.llm.features.detect_interaction_needed}
            >
              {#if $settings.llm.features.detect_interaction_needed}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Detect Interaction Needed</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Analyze AI responses to detect when your input is required (questions, approvals,
                decisions)
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
              class:border-accent={$settings.llm.features.generate_quick_actions}
              class:bg-accent={$settings.llm.features.generate_quick_actions}
              class:border-border={!$settings.llm.features.generate_quick_actions}
            >
              {#if $settings.llm.features.generate_quick_actions}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Generate Quick Actions</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Generate contextual quick action buttons based on the AI response to suggest helpful
                next steps
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
                  clean_transcription: !s.llm.features.clean_transcription,
                },
              },
            }))}
        >
          <div class="flex items-center gap-3">
            <div
              class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
              class:border-accent={$settings.llm.features.clean_transcription}
              class:bg-accent={$settings.llm.features.clean_transcription}
              class:border-border={!$settings.llm.features.clean_transcription}
            >
              {#if $settings.llm.features.clean_transcription}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Clean Transcription</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Fix homophones, technical terms, and punctuation in voice transcriptions before
                sending the prompt
              </p>
            </div>
          </div>
        </button>

        <!-- Dual-source transcription sub-option -->
        {#if $settings.llm.features.clean_transcription && $settings.realtime?.enabled}
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
                    use_dual_transcription: !s.llm.features.use_dual_transcription,
                  },
                },
              }))}
          >
            <div class="flex items-center gap-3">
              <div
                class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
                class:border-purple-500={$settings.llm.features.use_dual_transcription}
                class:bg-purple-500={$settings.llm.features.use_dual_transcription}
                class:border-border={!$settings.llm.features.use_dual_transcription}
              >
                {#if $settings.llm.features.use_dual_transcription}
                  <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                {/if}
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  <span class="text-sm font-medium text-text-primary">Use Dual-Source Cleanup</span>
                </div>
                <p class="text-xs text-text-muted mt-0.5">
                  Compare both real-time and Whisper (accurate) transcriptions for maximum accuracy
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
              class:border-border={!$settings.llm.features.recommend_model}
            >
              {#if $settings.llm.features.recommend_model}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Smart Model Selection</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Automatically choose the best model based on prompt complexity to optimize cost
              </p>
            </div>
          </div>
        </button>

        <!-- Sub-options for Smart Model Selection -->
        {#if $settings.llm.features.recommend_model}
          <div class="mt-3 ml-8 pl-3 border-l-2 border-border space-y-2">
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1.5">Thinking Mode</label>
              <div class="flex gap-1">
                <button
                  class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {normalizedAutoModelEffort ===
                  'low'
                    ? 'bg-accent text-white'
                    : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                  onclick={() =>
                    settings.update((s) => ({
                      ...s,
                      llm: {
                        ...s.llm,
                        features: { ...s.llm.features, auto_model_effort: "low" },
                      },
                    }))}
                >
                  Low
                </button>
                <button
                  class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {normalizedAutoModelEffort ===
                  'high'
                    ? 'bg-accent text-white'
                    : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                  onclick={() =>
                    settings.update((s) => ({
                      ...s,
                      llm: {
                        ...s.llm,
                        features: { ...s.llm.features, auto_model_effort: "high" },
                      },
                    }))}
                >
                  High
                </button>
                <button
                  class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {normalizedAutoModelEffort ===
                  'dynamic'
                    ? 'bg-accent text-white'
                    : 'bg-surface-secondary text-text-secondary hover:bg-surface-secondary/80'}"
                  onclick={() =>
                    settings.update((s) => ({
                      ...s,
                      llm: {
                        ...s.llm,
                        features: { ...s.llm.features, auto_model_effort: "dynamic" },
                      },
                    }))}
                >
                  Dynamic
                </button>
              </div>
              <p class="text-xs text-text-muted mt-1">
                {#if normalizedAutoModelEffort === "dynamic"}
                  LLM decides effort level based on prompt complexity
                {:else}
                  Effort is always set to {normalizedAutoModelEffort} when using auto model
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
              class:border-accent={$settings.llm.features.auto_select_repo}
              class:bg-accent={$settings.llm.features.auto_select_repo}
              class:border-border={!$settings.llm.features.auto_select_repo}
            >
              {#if $settings.llm.features.auto_select_repo}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Auto-select Repository</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Automatically select the best repository based on prompt content. Requires repo
                descriptions to be generated.
              </p>
            </div>
          </div>
        </button>

        <!-- Sub-options for auto-select repo -->
        {#if $settings.llm.features.auto_select_repo}
          <div class="mt-3 ml-8 pl-3 border-l-2 border-border space-y-3">
            <div>
              <label class="block text-sm font-medium text-text-secondary mb-1"
                >Minimum Confidence for Auto-Select</label
              >
              <p class="text-xs text-text-muted mb-2">
                Only auto-select repos when LLM confidence meets this threshold
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
                <label class="text-sm font-medium text-text-secondary">Confirm Repo Selection</label>
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
                  generate_branch_names: !s.llm.features.generate_branch_names,
                },
              },
            }))}
        >
          <div class="flex items-center gap-3">
            <div
              class="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0"
              class:border-accent={$settings.llm.features.generate_branch_names}
              class:bg-accent={$settings.llm.features.generate_branch_names}
              class:border-border={!$settings.llm.features.generate_branch_names}
            >
              {#if $settings.llm.features.generate_branch_names}
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span class="text-sm font-medium text-text-primary">Generate Branch Names</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                Use AI to generate descriptive branch names when creating new worktrees
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  {/if}
</div>
