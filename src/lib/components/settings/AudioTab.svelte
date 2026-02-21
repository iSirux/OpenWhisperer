<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";
</script>

<div class="space-y-4">
  <!-- Sound Notifications Section -->
  <div>
    <h3 class="text-sm font-medium text-text-primary mb-3">Sound Notifications</h3>
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Play Sound on Completion</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Play a notification sound when SDK session completes
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.play_sound_on_completion}
        />
      </div>
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Play Sound on Repo Select</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Play a confirmation sound when selecting a repository
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.play_sound_on_repo_select}
        />
      </div>
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Play Sound on Open Mic Trigger</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Play a sound when a wake command starts recording
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.play_sound_on_open_mic_trigger}
        />
      </div>
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Play Sound on Voice Command</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Play a sound when a voice command (like "go go") is detected
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.play_sound_on_voice_command}
        />
      </div>
    </div>
  </div>

  <!-- Sequence Voice Commands Section -->
  {#if $settings.sequences.enabled}
    <div class="border-t border-border pt-4">
      <h3 class="text-sm font-medium text-text-primary mb-3">Sequence Voice Commands</h3>
      <p class="text-xs text-text-muted mb-3">
        Voice commands for controlling sequences. Requires voice commands to be enabled above.
      </p>

      <div class="space-y-4">
        <!-- Run Sequence Commands -->
        <div>
          <label class="text-xs font-medium text-text-secondary block mb-1">Run Sequence Commands</label>
          <p class="text-[10px] text-text-muted mb-1.5">
            Say these followed by a sequence name to start it (e.g., "run sequence deploy")
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each $settings.audio.voice_commands.sequence_commands ?? [] as cmd}
              <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent rounded text-xs">
                {cmd}
                <button class="hover:text-red-400" onclick={() => {
                  const cmds = ($settings.audio.voice_commands.sequence_commands ?? []).filter(c => c !== cmd);
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, sequence_commands: cmds } } });
                }}>&times;</button>
              </span>
            {/each}
            <input
              type="text"
              class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
              placeholder="Add command..."
              onkeydown={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                if (e.key === 'Enter' && input.value.trim()) {
                  const cmds = [...($settings.audio.voice_commands.sequence_commands ?? []), input.value.trim()];
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, sequence_commands: cmds } } });
                  input.value = '';
                }
              }}
            />
          </div>
        </div>

        <!-- Approve Commands -->
        <div>
          <label class="text-xs font-medium text-text-secondary block mb-1">Approve Commands</label>
          <p class="text-[10px] text-text-muted mb-1.5">
            Say these to approve a pending approval node
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each $settings.audio.voice_commands.approve_commands ?? [] as cmd}
              <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 rounded text-xs">
                {cmd}
                <button class="hover:text-red-400" onclick={() => {
                  const cmds = ($settings.audio.voice_commands.approve_commands ?? []).filter(c => c !== cmd);
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, approve_commands: cmds } } });
                }}>&times;</button>
              </span>
            {/each}
            <input
              type="text"
              class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
              placeholder="Add command..."
              onkeydown={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                if (e.key === 'Enter' && input.value.trim()) {
                  const cmds = [...($settings.audio.voice_commands.approve_commands ?? []), input.value.trim()];
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, approve_commands: cmds } } });
                  input.value = '';
                }
              }}
            />
          </div>
        </div>

        <!-- Reject Commands -->
        <div>
          <label class="text-xs font-medium text-text-secondary block mb-1">Reject Commands</label>
          <p class="text-[10px] text-text-muted mb-1.5">
            Say these to reject a pending approval node
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each $settings.audio.voice_commands.reject_commands ?? [] as cmd}
              <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 rounded text-xs">
                {cmd}
                <button class="hover:text-red-400" onclick={() => {
                  const cmds = ($settings.audio.voice_commands.reject_commands ?? []).filter(c => c !== cmd);
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, reject_commands: cmds } } });
                }}>&times;</button>
              </span>
            {/each}
            <input
              type="text"
              class="w-32 px-2 py-0.5 text-xs rounded border border-border bg-background focus:outline-none focus:border-accent"
              placeholder="Add command..."
              onkeydown={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                if (e.key === 'Enter' && input.value.trim()) {
                  const cmds = [...($settings.audio.voice_commands.reject_commands ?? []), input.value.trim()];
                  settings.save({ ...$settings, audio: { ...$settings.audio, voice_commands: { ...$settings.audio.voice_commands, reject_commands: cmds } } });
                  input.value = '';
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
