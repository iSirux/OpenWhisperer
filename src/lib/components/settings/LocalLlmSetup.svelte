<script lang="ts">
  /**
   * One-click local LLM setup (llama.cpp): probe → pick a model → install
   * runtime + model → start → test → wire into the routing chains. Shared by
   * Settings → LLM and the onboarding LLM step.
   */
  import { onMount, untrack } from "svelte";
  import { settings } from "$lib/stores/settings";
  import {
    initLocalLlm,
    probeLocalLlm,
    getLocalLlmPresets,
    installLocalLlm,
    cancelLocalLlm,
    startLocalLlm,
    stopLocalLlm,
    benchmarkLocalLlm,
    setLocalLlmRouting,
    uninstallLocalLlm,
    localLlmStatus,
    localLlmProgress,
    localLlmBenchmark,
    localLlmError,
    formatGb,
    formatBytes,
    type LocalLlmProbe,
    type LocalLlmPreset,
    type LocalLlmStage,
  } from "$lib/stores/localLlm";
  import "./toggle.css";

  interface Props {
    /** Onboarding hides advanced controls (models folder, uninstall). */
    variant?: "settings" | "onboarding";
    /** Called after a successful setup. */
    onReady?: () => void;
  }

  let { variant = "settings", onReady }: Props = $props();

  const EXISTING = "__existing__";

  let probe = $state<LocalLlmProbe | null>(null);
  let probeError = $state<string | null>(null);
  let presets = $state<LocalLlmPreset[]>([]);
  let choice = $state<string>("");
  let existingPath = $state("");
  let useForQuality = $state(true);
  let useForFast = $state(false);
  let reconfigure = $state(false);
  let busy = $state<null | "start" | "stop" | "bench" | "uninstall">(null);
  let actionError = $state<string | null>(null);
  let removeModels = $state(false);
  let confirmUninstall = $state(false);

  const cfg = $derived($settings.local_llm);
  const setUp = $derived(!!cfg?.runtime_dir && !!cfg?.model_path);
  const installing = $derived($localLlmStatus.installing);
  const showSetup = $derived(installing || !setUp || reconfigure);
  const selectedPreset = $derived(presets.find((p) => p.id === choice) ?? null);
  const recommendedId = $derived(probe?.recommendation.preset_id ?? null);

  // Download rate from successive progress events.
  let lastSample: { t: number; bytes: number; file: string | null } | null = null;
  let rate = $state<number | null>(null);
  $effect(() => {
    const p = $localLlmProgress;
    if (!p || (p.stage !== "runtime" && p.stage !== "model") || !p.total) {
      rate = null;
      lastSample = null;
      return;
    }
    const now = performance.now();
    if (lastSample && lastSample.file === p.file && now - lastSample.t > 800) {
      const r = ((p.downloaded - lastSample.bytes) / (now - lastSample.t)) * 1000;
      const prev = untrack(() => rate);
      rate = prev == null ? r : prev * 0.7 + r * 0.3;
      lastSample = { t: now, bytes: p.downloaded, file: p.file };
    } else if (!lastSample || lastSample.file !== p.file) {
      lastSample = { t: now, bytes: p.downloaded, file: p.file };
    }
  });

  const STAGES: { key: "runtime" | "model" | "starting" | "test"; label: string }[] = [
    { key: "runtime", label: "Runtime" },
    { key: "model", label: "Model" },
    { key: "starting", label: "Start" },
    { key: "test", label: "Test" },
  ];

  function mainStage(stage: LocalLlmStage | undefined, file: string | null | undefined) {
    if (stage === "verifying") return file?.endsWith(".gguf") ? "model" : "runtime";
    return stage;
  }
  const currentStage = $derived(mainStage($localLlmProgress?.stage, $localLlmProgress?.file));
  const stageIndex = $derived(STAGES.findIndex((s) => s.key === currentStage));
  const pct = $derived(
    $localLlmProgress?.total ? Math.min(100, ($localLlmProgress.downloaded / $localLlmProgress.total) * 100) : null
  );

  onMount(async () => {
    await initLocalLlm();
    useForQuality = cfg?.use_for_quality ?? true;
    useForFast = cfg?.use_for_fast ?? false;
    try {
      presets = await getLocalLlmPresets();
    } catch (e) {
      console.error("[LocalLlmSetup] presets failed:", e);
    }
    await runProbe();
  });

  async function runProbe() {
    probeError = null;
    try {
      probe = await probeLocalLlm();
      if (!choice) choice = cfg?.preset_id && !reconfigure ? cfg.preset_id : probe.recommendation.preset_id;
    } catch (e) {
      probeError = String(e);
      if (!choice && presets[0]) choice = presets[0].id;
    }
  }

  async function browseModel() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "GGUF model", extensions: ["gguf"] }],
    });
    if (typeof picked === "string") existingPath = picked;
  }

  async function browseModelsDir() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      settings.update((s) => ({ ...s, local_llm: { ...s.local_llm, models_dir: picked } }));
      await runProbe();
    }
  }

  async function resetModelsDir() {
    settings.update((s) => ({ ...s, local_llm: { ...s.local_llm, models_dir: null } }));
    await runProbe();
  }

  async function setup() {
    actionError = null;
    try {
      await installLocalLlm({
        presetId: choice === EXISTING ? null : choice,
        existingPath: choice === EXISTING ? existingPath : null,
        useForQuality,
        useForFast,
      });
      reconfigure = false;
      onReady?.();
    } catch (e) {
      console.warn("[LocalLlmSetup] setup failed:", e);
    }
  }

  async function run(kind: "start" | "stop" | "bench", fn: () => Promise<unknown>) {
    busy = kind;
    actionError = null;
    try {
      await fn();
    } catch (e) {
      actionError = String(e);
    } finally {
      busy = null;
    }
  }

  async function changeRouting(q: boolean, f: boolean) {
    useForQuality = q;
    useForFast = f;
    if (setUp) {
      try {
        await setLocalLlmRouting(q, f);
      } catch (e) {
        actionError = String(e);
      }
    }
  }

  async function uninstall() {
    busy = "uninstall";
    actionError = null;
    try {
      await uninstallLocalLlm(removeModels);
      confirmUninstall = false;
      reconfigure = false;
    } catch (e) {
      actionError = String(e);
    } finally {
      busy = null;
    }
  }

  function presetOptionLabel(p: LocalLlmPreset) {
    const rec = p.id === recommendedId ? " — recommended" : "";
    return `${p.label} · ${formatBytes(p.size_bytes)}${rec}`;
  }

  const statusColor = $derived(
    {
      running: "bg-success",
      starting: "bg-warning animate-pulse",
      stopped: "bg-text-muted",
      error: "bg-error",
    }[$localLlmStatus.state]
  );
</script>

<div class="space-y-3">
  {#if probe}
    {@const hw = probe.hardware}
    <div class="text-xs text-text-muted flex flex-wrap gap-x-3 gap-y-1">
      <span>
        <span class="text-text-secondary">GPU:</span>
        {#if hw.gpu}
          {hw.gpu.name}
          {#if hw.gpu.unified_memory}
            · {formatGb(hw.gpu.vram_total_mib)} usable (unified memory)
          {:else if hw.gpu.vram_total_mib}
            · {hw.gpu.vram_free_mib != null ? `${formatGb(hw.gpu.vram_free_mib)} free of ` : ""}{formatGb(hw.gpu.vram_total_mib)}
          {/if}
        {:else}
          none detected (CPU only)
        {/if}
      </span>
      {#if hw.ram_total_mib}
        <span><span class="text-text-secondary">RAM:</span> {formatGb(hw.ram_total_mib)}</span>
      {/if}
      {#if hw.disk_free_mib != null}
        <span title={hw.models_dir}><span class="text-text-secondary">Disk:</span> {formatGb(hw.disk_free_mib)} free</span>
      {/if}
    </div>
  {:else if probeError}
    <p class="text-xs text-warning">Hardware probe failed: {probeError}</p>
  {/if}

  {#if showSetup}
    <!-- ============ Setup ============ -->
    {#if !installing}
      <div class="space-y-2">
        <div>
          <label class="block text-xs font-medium text-text-secondary mb-1" for="local-llm-model">Model</label>
          <select
            id="local-llm-model"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            bind:value={choice}
          >
            {#each presets as p (p.id)}
              <option value={p.id}>{presetOptionLabel(p)}</option>
            {/each}
            <option value={EXISTING}>Use an existing .gguf file…</option>
          </select>
          {#if probe?.recommendation && choice === probe.recommendation.preset_id}
            <p class="text-xs text-text-muted mt-1">{probe.recommendation.reason}</p>
          {/if}
        </div>

        {#if choice === EXISTING}
          <div class="flex gap-2">
            <input
              type="text"
              class="flex-1 px-3 py-2 bg-background border border-border rounded text-sm font-mono focus:outline-none focus:border-accent"
              placeholder="C:\models\model.gguf"
              bind:value={existingPath}
            />
            <button
              class="px-3 py-2 text-sm bg-surface-elevated hover:bg-border border border-border rounded transition-colors"
              onclick={browseModel}
            >
              Browse…
            </button>
          </div>
          <p class="text-xs text-text-muted">
            Any GGUF chat model works. The file is used in place, never copied or deleted.
          </p>
        {:else if selectedPreset}
          <p class="text-xs text-text-muted">{selectedPreset.description}</p>
          {#if selectedPreset.license_note}
            <p class="text-xs text-warning">License ({selectedPreset.license}): {selectedPreset.license_note}</p>
          {/if}
          {#if probe?.hardware.disk_free_mib != null && probe.hardware.disk_free_mib * 1024 * 1024 < selectedPreset.size_bytes + 1024 ** 3}
            <p class="text-xs text-error">
              Not enough free disk space in the models folder for this model ({formatBytes(selectedPreset.size_bytes)} + runtime).
            </p>
          {/if}
        {/if}

        {#if variant === "settings" && choice !== EXISTING}
          <div class="flex items-center gap-2 text-xs text-text-muted">
            <span class="shrink-0">Models folder:</span>
            <code class="truncate" title={probe?.hardware.models_dir}>{probe?.hardware.models_dir ?? "…"}</code>
            <button class="shrink-0 text-accent hover:underline" onclick={browseModelsDir}>Change</button>
            {#if cfg?.models_dir}
              <button class="shrink-0 text-text-muted hover:text-text-primary" onclick={resetModelsDir}>Reset</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="space-y-1.5">
      <label class="flex items-center justify-between gap-3 text-sm">
        <span>
          <span class="text-text-primary">Use for background features</span>
          <span class="block text-xs text-text-muted">First in the quality chain: cleanup, interaction detection, quick actions, drafts, meeting triage.</span>
        </span>
        <input type="checkbox" class="toggle" checked={useForQuality} onchange={() => changeRouting(!useForQuality, useForFast)} />
      </label>
      <label class="flex items-center justify-between gap-3 text-sm">
        <span>
          <span class="text-text-primary">Also use for instant features</span>
          <span class="block text-xs text-text-muted">First in the fast chain: naming, model/repo recommendation, branch names. Your other profiles stay as fallbacks.</span>
        </span>
        <input type="checkbox" class="toggle" checked={useForFast} onchange={() => changeRouting(useForQuality, !useForFast)} />
      </label>
    </div>

    {#if installing || $localLlmProgress?.stage === "done"}
      <!-- Progress -->
      <div class="p-3 bg-background rounded border border-border space-y-2">
        <div class="flex items-center gap-1.5 text-xs">
          {#each STAGES as s, i (s.key)}
            <span
              class="px-2 py-0.5 rounded {i < stageIndex || $localLlmProgress?.stage === 'done'
                ? 'bg-success/15 text-success'
                : i === stageIndex
                  ? 'bg-accent/15 text-accent'
                  : 'bg-surface-elevated text-text-muted'}"
            >
              {s.label}
            </span>
            {#if i < STAGES.length - 1}<span class="text-text-muted">›</span>{/if}
          {/each}
        </div>
        {#if installing}
          <div class="h-2 bg-surface-elevated rounded overflow-hidden">
            {#if pct != null}
              <div class="h-full bg-accent transition-all" style="width: {pct}%"></div>
            {:else}
              <div class="h-full w-1/3 bg-accent/60 animate-pulse"></div>
            {/if}
          </div>
          <div class="flex items-center justify-between gap-2 text-xs text-text-muted">
            <span class="truncate">
              {#if $localLlmProgress?.stage === "verifying"}
                {$localLlmProgress.message}
              {:else if $localLlmProgress?.total}
                {$localLlmProgress.file ?? ""} · {formatBytes($localLlmProgress.downloaded)} / {formatBytes($localLlmProgress.total)}{rate
                  ? ` · ${(rate / 1024 ** 2).toFixed(1)} MB/s`
                  : ""}
              {:else}
                {$localLlmProgress?.message ?? "Working…"}
              {/if}
            </span>
            <button
              class="shrink-0 px-2 py-1 text-xs text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
              onclick={cancelLocalLlm}
            >
              Cancel
            </button>
          </div>
          <p class="text-xs text-text-muted">Downloads resume where they left off if cancelled or interrupted.</p>
        {/if}
      </div>
    {/if}

    {#if $localLlmError}
      <p class="text-xs text-error break-words">Setup failed: {$localLlmError}</p>
    {/if}

    {#if !installing}
      <div class="flex items-center gap-2">
        <button
          class="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          onclick={setup}
          disabled={!choice || (choice === EXISTING && !existingPath.trim())}
        >
          {setUp ? "Switch model" : $localLlmError ? "Retry setup" : "Set up"}
        </button>
        {#if reconfigure}
          <button
            class="px-3 py-2 text-sm text-text-muted hover:text-text-primary"
            onclick={() => (reconfigure = false)}
          >
            Back
          </button>
        {/if}
        {#if !setUp}
          <span class="text-xs text-text-muted">
            Downloads llama.cpp{choice !== EXISTING && selectedPreset ? ` and ${formatBytes(selectedPreset.size_bytes)} of model` : ""}, then starts it on this machine. No terminal needed.
          </span>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- ============ Installed ============ -->
    <div class="flex items-center gap-2 flex-wrap">
      <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-background border border-border text-xs">
        <span class="w-2 h-2 rounded-full {statusColor}"></span>
        <span class="text-text-primary capitalize">{$localLlmStatus.state}</span>
        {#if $localLlmStatus.state === "running" && $localLlmStatus.port}
          <span class="text-text-muted">· port {$localLlmStatus.port}</span>
        {/if}
      </span>
      <span class="text-xs text-text-secondary truncate" title={cfg?.model_path ?? ""}>
        {cfg?.model_name}
      </span>
      {#if $localLlmStatus.state === "running"}
        {#if $localLlmStatus.vram_used_mib}
          <span class="text-xs text-text-muted">· {formatGb($localLlmStatus.vram_used_mib)} VRAM</span>
        {/if}
        {#if $localLlmStatus.full_gpu === false}
          <span class="text-xs text-warning" title="The model didn't fit in free VRAM, so llama.cpp split it between GPU and CPU (slower)">· partly on CPU</span>
        {/if}
      {/if}
      <span class="text-xs text-text-muted">· llama.cpp {cfg?.runtime_version} ({cfg?.runtime_variant})</span>
    </div>
    {#if $localLlmStatus.message && $localLlmStatus.state !== "running"}
      <p class="text-xs {$localLlmStatus.state === 'error' ? 'text-error' : 'text-text-muted'} break-words">
        {$localLlmStatus.message}
      </p>
    {/if}

    <div class="flex items-center gap-2 flex-wrap">
      {#if $localLlmStatus.state === "running" || $localLlmStatus.state === "starting"}
        <button
          class="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-border border border-border rounded transition-colors disabled:opacity-50"
          disabled={busy !== null}
          onclick={() => run("stop", stopLocalLlm)}
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      {:else}
        <button
          class="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          disabled={busy !== null}
          onclick={() => run("start", startLocalLlm)}
        >
          {busy === "start" ? "Starting…" : "Start"}
        </button>
      {/if}
      <button
        class="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-border border border-border rounded transition-colors disabled:opacity-50"
        disabled={busy !== null || $localLlmStatus.state !== "running"}
        onclick={() => run("bench", benchmarkLocalLlm)}
      >
        {busy === "bench" ? "Testing…" : "Test speed"}
      </button>
      {#if $localLlmBenchmark}
        <span class="text-xs {$localLlmBenchmark.valid_json ? 'text-success' : 'text-warning'}">
          {$localLlmBenchmark.tokens_per_second != null
            ? `${$localLlmBenchmark.tokens_per_second.toFixed(0)} tokens/s`
            : "—"} · {($localLlmBenchmark.latency_ms / 1000).toFixed(1)} s{$localLlmBenchmark.valid_json
            ? ""
            : " · invalid JSON"}
        </span>
      {/if}
      <span class="flex-1"></span>
      <button class="text-xs text-accent hover:underline" onclick={() => (reconfigure = true)}>Change model</button>
    </div>

    <div class="space-y-1.5">
      <label class="flex items-center justify-between gap-3 text-sm">
        <span class="text-text-primary">Start automatically with the app</span>
        <input
          type="checkbox"
          class="toggle"
          checked={cfg?.auto_start ?? true}
          onchange={() =>
            settings.update((s) => ({ ...s, local_llm: { ...s.local_llm, auto_start: !s.local_llm.auto_start } }))}
        />
      </label>
      <label class="flex items-center justify-between gap-3 text-sm">
        <span class="text-text-primary">Use for background features <span class="text-xs text-text-muted">(quality chain)</span></span>
        <input type="checkbox" class="toggle" checked={cfg?.use_for_quality ?? true} onchange={() => changeRouting(!cfg.use_for_quality, cfg.use_for_fast)} />
      </label>
      <label class="flex items-center justify-between gap-3 text-sm">
        <span class="text-text-primary">Also use for instant features <span class="text-xs text-text-muted">(fast chain)</span></span>
        <input type="checkbox" class="toggle" checked={cfg?.use_for_fast ?? false} onchange={() => changeRouting(cfg.use_for_quality, !cfg.use_for_fast)} />
      </label>
    </div>

    {#if variant === "settings"}
      <div class="pt-1">
        {#if confirmUninstall}
          <div class="p-2.5 bg-error/5 border border-error/30 rounded space-y-2">
            <p class="text-xs text-text-secondary">
              Stops the server, removes llama.cpp and the "Local (llama.cpp)" profile.
            </p>
            {#if cfg?.preset_id}
              <label class="flex items-center gap-2 text-xs text-text-secondary">
                <input type="checkbox" bind:checked={removeModels} />
                Also delete downloaded models
              </label>
            {/if}
            <div class="flex gap-2">
              <button
                class="px-3 py-1 text-xs text-white bg-error hover:bg-error/90 rounded disabled:opacity-50"
                disabled={busy !== null}
                onclick={uninstall}
              >
                {busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
              </button>
              <button class="px-3 py-1 text-xs text-text-muted hover:text-text-primary" onclick={() => (confirmUninstall = false)}>
                Cancel
              </button>
            </div>
          </div>
        {:else}
          <button class="text-xs text-text-muted hover:text-error" onclick={() => (confirmUninstall = true)}>
            Uninstall…
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  {#if actionError}
    <p class="text-xs text-error break-words">{actionError}</p>
  {/if}
</div>
