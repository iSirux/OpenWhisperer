<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <div
    class="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 p-3"
  >
    <svg
      class="w-4 h-4 mt-0.5 shrink-0 text-warning"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
    <p class="text-xs text-text-secondary">
      Developer mode is not recommended. It surfaces experimental,
      unfinished features that may be unstable or change without notice.
      Only enable it if you know what you're doing.
    </p>
  </div>

  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Developer Mode</label
      >
      <p class="text-xs text-text-muted">Surfaces experimental features</p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.system.dev_mode}
    />
  </div>
</div>
