<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import "./toggle.css";
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
