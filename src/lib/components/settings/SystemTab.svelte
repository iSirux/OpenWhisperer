<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Minimize to Tray</label
      >
      <p class="text-xs text-text-muted">
        Keep running in system tray when window is closed
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.system.minimize_to_tray}
    />
  </div>
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Start Minimized</label
      >
      <p class="text-xs text-text-muted">
        Start app minimized to system tray
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      bind:checked={$settings.system.start_minimized}
    />
  </div>
  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >Start on Login</label
      >
      <p class="text-xs text-text-muted">
        Automatically start when you log in to your computer
      </p>
    </div>
    <input
      type="checkbox"
      class="toggle"
      checked={$settings.system.autostart}
      onchange={async (e) => {
        const enabled = (e.target as HTMLInputElement).checked;
        try {
          await invoke("toggle_autostart", { enabled });
          settings.update((s) => ({
            ...s,
            system: { ...s.system, autostart: enabled },
          }));
        } catch (error) {
          console.error("Failed to toggle autostart:", error);
          (e.target as HTMLInputElement).checked = !enabled;
        }
      }}
    />
  </div>

  <div class="border-t border-border pt-4 mt-4">
    <h3 class="text-sm font-medium text-text-primary mb-3">
      Session Persistence
    </h3>
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Restore Sessions on Startup</label
          >
          <p class="text-xs text-text-muted">
            Save and restore session history between app restarts
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.session_persistence.enabled}
        />
      </div>
      {#if $settings.session_persistence.enabled}
        <div>
          <label
            class="block text-sm font-medium text-text-secondary mb-1"
            >Sessions to Restore on Startup</label
          >
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              class="flex-1 accent-accent"
              bind:value={
                $settings.session_persistence.restore_sessions
              }
            />
            <span class="text-sm text-text-primary w-12 text-right"
              >{$settings.session_persistence.restore_sessions}</span
            >
          </div>
          <p class="text-xs text-text-muted mt-1">
            Number of recent sessions to load when the app starts
          </p>
        </div>
        <div>
          <label
            class="block text-sm font-medium text-text-secondary mb-1"
            >Maximum Sessions to Keep</label
          >
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="10"
              max="200"
              step="10"
              class="flex-1 accent-accent"
              bind:value={$settings.session_persistence.max_sessions}
            />
            <span class="text-sm text-text-primary w-12 text-right"
              >{$settings.session_persistence.max_sessions}</span
            >
          </div>
          <p class="text-xs text-text-muted mt-1">
            Sessions exceeding this limit are automatically moved to the
            archive
          </p>
        </div>
        <div>
          <label
            class="block text-sm font-medium text-text-secondary mb-1"
            >Maximum Archived Sessions</label
          >
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="50"
              max="2000"
              step="50"
              class="flex-1 accent-accent"
              bind:value={
                $settings.session_persistence.max_archived_sessions
              }
            />
            <span class="text-sm text-text-primary w-12 text-right"
              >{$settings.session_persistence.max_archived_sessions ??
                500}</span
            >
          </div>
          <p class="text-xs text-text-muted mt-1">
            Closed sessions are moved to the archive. Oldest archived
            sessions are permanently removed when this limit is exceeded.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
            onclick={async () => {
              if (
                confirm(
                  "Are you sure you want to clear all saved sessions? This cannot be undone."
                )
              ) {
                const { clearPersistedSessions } = await import(
                  "$lib/stores/sessionPersistence"
                );
                await clearPersistedSessions();
              }
            }}
          >
            Clear Saved Sessions
          </button>
          <button
            class="px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors"
            onclick={async () => {
              if (
                confirm(
                  "Are you sure you want to clear the entire archive? This cannot be undone."
                )
              ) {
                const { archive } = await import("$lib/stores/archive");
                await archive.clearAll();
              }
            }}
          >
            Clear Archive
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
