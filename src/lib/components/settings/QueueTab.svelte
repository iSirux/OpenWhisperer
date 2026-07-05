<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <!-- Master toggle -->
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary">Smart Queue</label>
      <p class="text-xs text-text-muted">
        When your usage limit is reached, new sessions wait in the queue and
        launch automatically after the usage window resets.
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.queue.enabled}
    />
  </div>

  <!-- Delay after reset -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">Delay after reset</label>
        <p class="text-xs text-text-muted">
          Wait a random amount before launching the first queued session after a reset.
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.queue.fuzzy_delay_after_reset}
      />
    </div>

    <div class="grid grid-cols-2 gap-3 mt-3">
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Min seconds</label>
        <input
          type="number"
          min="0"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          bind:value={$settings.queue.fuzzy_delay_after_reset_min_secs}
          disabled={!$settings.queue.fuzzy_delay_after_reset}
        />
      </div>
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Max seconds</label>
        <input
          type="number"
          min="0"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          bind:value={$settings.queue.fuzzy_delay_after_reset_max_secs}
          disabled={!$settings.queue.fuzzy_delay_after_reset}
        />
      </div>
    </div>
  </div>

  <!-- Delay between runs -->
  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">Delay between runs</label>
        <p class="text-xs text-text-muted">
          Random gap between successive queued launches.
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.queue.fuzzy_delay_between_runs}
      />
    </div>

    <div class="grid grid-cols-2 gap-3 mt-3">
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Min seconds</label>
        <input
          type="number"
          min="0"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          bind:value={$settings.queue.fuzzy_delay_between_runs_min_secs}
          disabled={!$settings.queue.fuzzy_delay_between_runs}
        />
      </div>
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">Max seconds</label>
        <input
          type="number"
          min="0"
          class="w-full px-3 py-2 bg-background border border-border rounded text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          bind:value={$settings.queue.fuzzy_delay_between_runs_max_secs}
          disabled={!$settings.queue.fuzzy_delay_between_runs}
        />
      </div>
    </div>
  </div>
</div>
