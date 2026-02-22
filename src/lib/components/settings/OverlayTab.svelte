<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Show Overlay When Focused</label
      >
      <p class="text-xs text-text-muted mt-0.5">
        Show the recording overlay even when the app is in focus
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.overlay.show_when_focused}
    />
  </div>

  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Show Active Sessions</label
      >
      <p class="text-xs text-text-muted mt-0.5">
        Display active session and sequence counts in the overlay
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.overlay.show_active_sessions}
    />
  </div>
</div>
