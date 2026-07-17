<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { getEnabledModels } from "$lib/utils/models";
  import type { EffortLevel } from "$lib/stores/sdkSessions";
  import EffortToggle from "$lib/components/EffortToggle.svelte";
  import "./toggle.css";

  // Only the user's active Claude models (Settings → Claude) are offered.
  const models = $derived(getEnabledModels($settings.enabled_models));

  const STEP_ORDER = ["review", "test", "docs", "lint", "ship", "ci"] as const;
  const STEP_LABELS: Record<string, string> = {
    review: "Review",
    test: "Test",
    docs: "Docs",
    lint: "Lint",
    ship: "Ship",
    ci: "CI",
  };
  // Steps that support an auto-fix round limit (ship has no auto-fix loop).
  const FIX_LIMIT_STEPS = ["review", "test", "docs", "lint", "ci"] as const;

  function toggleDefaultStep(step: string, on: boolean) {
    const current = new Set($settings.validation.default_steps);
    if (on) current.add(step);
    else current.delete(step);
    $settings.validation.default_steps = STEP_ORDER.filter((s) => current.has(s));
  }

  function setLimit(step: string, value: number) {
    $settings.validation.auto_fix_limits = {
      ...$settings.validation.auto_fix_limits,
      [step]: Math.max(0, Math.floor(value || 0)),
    };
  }
</script>

<div class="space-y-4">
  <!-- Default steps -->
  <div>
    <label class="text-sm font-medium text-text-secondary">Default steps</label>
    <p class="text-xs text-text-muted mb-2">
      The steps pre-selected when you start a new validation run. You can change
      the set per run.
    </p>
    <div class="grid grid-cols-2 gap-2">
      {#each STEP_ORDER as step}
        <label class="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={$settings.validation.default_steps.includes(step)}
            onchange={(e) => toggleDefaultStep(step, e.currentTarget.checked)}
          />
          {STEP_LABELS[step]}
        </label>
      {/each}
    </div>
  </div>

  <!-- Reviewer model / effort -->
  <div class="border-t border-border pt-4 mt-4 grid grid-cols-2 gap-3">
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1" for="val-model">Reviewer model</label>
      <select
        id="val-model"
        class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.validation.reviewer_model}
      >
        <option value="session">Session model</option>
        {#each models as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </div>
    <div>
      <span class="block text-sm font-medium text-text-secondary mb-1">Reviewer effort</span>
      <div class="flex items-center min-h-[38px]">
        <EffortToggle
          effortLevel={($settings.validation.reviewer_effort ?? "medium") as EffortLevel}
          onchange={(l) => ($settings.validation.reviewer_effort = l)}
          modelId={$settings.validation.reviewer_model === "session" ? "" : $settings.validation.reviewer_model}
          size="md"
        />
      </div>
    </div>
  </div>

  <!-- Adversarial verify -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">Adversarial verify</label>
        <p class="text-xs text-text-muted">
          Give each error finding a verify pass that tries to refute it before it gates.
        </p>
      </div>
      <input type="checkbox" class="toggle" bind:checked={$settings.validation.adversarial_verify} />
    </div>
  </div>

  <!-- Evidence -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">Gather evidence</label>
        <p class="text-xs text-text-muted">
          Run an evidence agent in the test step to demonstrate the intent is satisfied.
        </p>
      </div>
      <input type="checkbox" class="toggle" bind:checked={$settings.validation.evidence_enabled} />
    </div>
  </div>

  <!-- Auto-fix limits -->
  <div class="border-t border-border pt-4 mt-4">
    <label class="text-sm font-medium text-text-secondary">Auto-fix round limits</label>
    <p class="text-xs text-text-muted mb-2">
      How many auto-fix rounds a step may run before it parks at a gate for your decision.
    </p>
    <div class="grid grid-cols-3 gap-3">
      {#each FIX_LIMIT_STEPS as step}
        <div>
          <label class="block text-xs font-medium text-text-secondary mb-1" for="val-limit-{step}">{STEP_LABELS[step]}</label>
          <input
            id="val-limit-{step}"
            type="number"
            min="0"
            max="10"
            class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
            value={$settings.validation.auto_fix_limits[step] ?? 0}
            onchange={(e) => setLimit(step, Number(e.currentTarget.value))}
          />
        </div>
      {/each}
    </div>
  </div>

  <!-- Timeouts -->
  <div class="border-t border-border pt-4 mt-4 grid grid-cols-2 gap-3">
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1" for="val-agent-timeout">Agent time cap (minutes)</label>
      <p class="text-xs text-text-muted mb-2">
        Overall cap per agent call. Agents never time out while actively working
        (10-minute idle window, reset on every tool call).
      </p>
      <input
        id="val-agent-timeout"
        type="number"
        min="1"
        max="240"
        class="w-40 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.validation.agent_timeout_minutes}
      />
    </div>
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1" for="val-ci-timeout">CI idle timeout (minutes)</label>
      <p class="text-xs text-text-muted mb-2">
        Gate the CI step if no check changes state for this long.
      </p>
      <input
        id="val-ci-timeout"
        type="number"
        min="1"
        max="240"
        class="w-40 px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent"
        bind:value={$settings.validation.ci_timeout_minutes}
      />
    </div>
  </div>
</div>
