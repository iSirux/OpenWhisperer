<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";

  // Whole minutes, 0 = unlimited; an emptied field must not save null (the
  // backend field is a u32).
  function setMaxRecordingMinutes(event: Event) {
    const raw = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10);
    const minutes = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 600) : 0;
    $settings.audio.max_recording_minutes = minutes;
    (event.currentTarget as HTMLInputElement).value = String(minutes);
  }
</script>

<div class="space-y-4">
  <!-- Recording Section -->
  <div>
    <h3 class="text-sm font-medium text-text-primary mb-3">Recording</h3>
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Capture Screenshot on Record</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Grab a screenshot of the screen under the cursor when recording starts and attach it
            to the prompt as optional context (Claude is told it may be unrelated)
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.capture_screenshot_on_record}
        />
      </div>
      <div class="flex items-center justify-between gap-4">
        <div>
          <label class="text-sm font-medium text-text-secondary" for="max-recording-minutes"
            >Maximum Recording Length</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Automatically stop a recording after this many minutes (0 = unlimited). A recording
            you started is finished with the current stop mode; an open-mic recording is saved to
            the pile instead of being sent
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <input
            id="max-recording-minutes"
            type="number"
            min="0"
            max="600"
            step="1"
            class="w-20 px-2 py-1 bg-surface-elevated border border-border rounded text-sm text-right focus:outline-none focus:border-accent"
            value={$settings.audio.max_recording_minutes ?? 15}
            onchange={setMaxRecordingMinutes}
          />
          <span class="text-xs text-text-muted">min</span>
        </div>
      </div>
    </div>
  </div>

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
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm font-medium text-text-secondary"
            >Play Sound on Question</label
          >
          <p class="text-xs text-text-muted mt-0.5">
            Play a distinct sound when the agent asks a question and needs your input
          </p>
        </div>
        <input
          type="checkbox"
          class="toggle"
          bind:checked={$settings.audio.play_sound_on_question}
        />
      </div>
    </div>
  </div>
</div>
