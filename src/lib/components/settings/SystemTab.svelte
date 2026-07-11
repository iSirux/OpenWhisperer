<script lang="ts">
  import {
    settings,
    type LaunchTerminal,
    type UpdateCheckMode,
  } from "$lib/stores/settings";
  import { invoke } from "@tauri-apps/api/core";
  import { goto } from "$app/navigation";
  import { get } from "svelte/store";
  import "./toggle.css";

  const isWindows = navigator.userAgent.includes("Windows");

  async function rerunOnboarding() {
    await settings.save({ ...get(settings), onboarding_completed: false });
    goto("/onboarding");
  }

  let resetRedoOnboarding = $state(false);
  let resetting = $state(false);

  async function restoreDefaults() {
    if (
      !confirm(
        "Restore all settings to their defaults? Your repositories are kept, " +
          "but everything else (providers, transcription, hotkeys, LLM, theme, …) " +
          "is reset. This cannot be undone."
      )
    ) {
      return;
    }
    resetting = true;
    try {
      const wasAutostart = get(settings).system.autostart;
      await settings.resetToDefaults(resetRedoOnboarding);
      // The config no longer says autostart, so drop the OS login entry too
      if (wasAutostart) {
        try {
          await invoke("toggle_autostart", { enabled: false });
        } catch (error) {
          console.error("Failed to disable autostart during reset:", error);
        }
      }
      if (resetRedoOnboarding) {
        goto("/onboarding");
      }
    } catch (error) {
      console.error("Failed to restore default settings:", error);
      alert(`Failed to restore default settings: ${error}`);
    } finally {
      resetting = false;
    }
  }
</script>

<div class="space-y-4">
  {#if isWindows}
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary"
          >Launch Terminal</label
        >
        <p class="text-xs text-text-muted">
          Terminal emulator for launch profiles
        </p>
      </div>
      <select
        class="bg-surface-elevated border border-border rounded px-2 py-1 text-sm text-text-primary"
        value={$settings.system.launch_terminal ?? "Cmd"}
        onchange={(e) => {
          const val = (e.target as HTMLSelectElement).value as LaunchTerminal;
          settings.update((s) => ({
            ...s,
            system: { ...s.system, launch_terminal: val },
          }));
        }}
      >
        <option value="Cmd">Command Prompt (cmd)</option>
        <option value="PowerShell">PowerShell (pwsh)</option>
        <option value="WindowsTerminal">Windows Terminal (wt)</option>
      </select>
    </div>
  {/if}

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
        Start minimized to system tray when launched on login
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

  <div class="flex items-center justify-between">
    <div>
      <label class="text-sm font-medium text-text-secondary"
        >App Updates</label
      >
      <p class="text-xs text-text-muted">
        How to handle new versions found on startup. Manual checks live in
        About.
      </p>
    </div>
    <select
      class="bg-surface-elevated border border-border rounded px-2 py-1 text-sm text-text-primary"
      value={$settings.system.update_check ?? "Auto"}
      onchange={(e) => {
        const val = (e.target as HTMLSelectElement).value as UpdateCheckMode;
        settings.update((s) => ({
          ...s,
          system: { ...s.system, update_check: val },
        }));
      }}
    >
      <option value="Off">Don't check</option>
      <option value="Notify">Notify me</option>
      <option value="Auto">Install automatically</option>
    </select>
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
            archive. This is also how many sessions are restored on startup.
          </p>
        </div>
        <div>
          <label
            class="block text-sm font-medium text-text-secondary mb-1"
            >Maximum Archived Sessions</label
          >
          {#if ($settings.session_persistence.max_archived_sessions ?? 500) === 0}
            <div class="flex items-center gap-3">
              <span class="flex-1 text-sm text-text-primary">No cap</span>
            </div>
          {:else}
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
          {/if}
          <label
            class="flex items-center gap-2 mt-2 text-xs text-text-muted cursor-pointer"
          >
            <input
              type="checkbox"
              class="accent-accent"
              checked={($settings.session_persistence
                .max_archived_sessions ?? 500) === 0}
              onchange={(e) => {
                const noCap = (e.target as HTMLInputElement).checked;
                settings.update((s) => ({
                  ...s,
                  session_persistence: {
                    ...s.session_persistence,
                    max_archived_sessions: noCap ? 0 : 500,
                  },
                }));
              }}
            />
            No cap (keep all archived sessions)
          </label>
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

  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">No Voice Mode</label>
        <p class="text-xs text-text-muted">
          Hide all voice, recording, and transcription features
        </p>
      </div>
      <input
        type="checkbox"
        class="toggle"
        bind:checked={$settings.system.voice_mode_disabled}
      />
    </div>
  </div>

  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary">Setup Wizard</label>
        <p class="text-xs text-text-muted">
          Re-run the first-launch setup (voice mode, transcription, agents, LLM)
        </p>
      </div>
      <button
        class="px-3 py-1.5 text-sm bg-surface hover:bg-border border border-border rounded transition-colors"
        onclick={rerunOnboarding}
      >
        Run Setup Again
      </button>
    </div>
  </div>

  <div class="border-t border-border pt-4 mt-4">
    <div class="flex items-center justify-between">
      <div>
        <label class="text-sm font-medium text-text-secondary"
          >Restore Default Settings</label
        >
        <p class="text-xs text-text-muted">
          Reset all settings to their defaults. Your repositories are kept.
        </p>
        <label
          class="flex items-center gap-2 mt-2 text-xs text-text-muted cursor-pointer"
        >
          <input
            type="checkbox"
            class="accent-accent"
            bind:checked={resetRedoOnboarding}
          />
          Also re-run the setup wizard afterwards
        </label>
      </div>
      <button
        class="px-3 py-1.5 text-sm text-error border border-error/30 hover:bg-error/10 rounded transition-colors disabled:opacity-50"
        disabled={resetting}
        onclick={restoreDefaults}
      >
        {resetting ? "Restoring…" : "Restore Defaults"}
      </button>
    </div>
  </div>
</div>
