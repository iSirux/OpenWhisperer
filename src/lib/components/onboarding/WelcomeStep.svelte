<script lang="ts">
  let {
    onChoose,
  }: {
    onChoose: (voiceMode: boolean) => void;
  } = $props();
</script>

<div class="flex flex-col items-center text-center pt-8">
  <h1 class="text-3xl font-bold mb-2">Welcome to OpenWhisperer</h1>
  <p class="text-text-muted mb-10 max-w-md">
    Talk to your coding agents. Record a prompt, get it transcribed, and send it
    straight to Claude or Codex.
  </p>

  <p class="text-sm font-medium text-text-secondary mb-4">How do you want to drive it?</p>

  <div class="grid grid-cols-2 gap-4 w-full max-w-xl">
    <button
      class="group flex flex-col items-center gap-3 p-6 bg-surface-elevated border-2 border-accent/40 hover:border-accent rounded-xl transition-all text-left"
      onclick={() => onChoose(true)}
    >
      <div class="p-3 bg-accent/10 rounded-full group-hover:bg-accent/20 transition-colors">
        <svg class="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
          />
        </svg>
      </div>
      <div class="text-center">
        <div class="font-semibold text-text-primary">
          Voice
          <span class="ml-1 text-[10px] font-medium px-1.5 py-0.5 bg-accent/15 text-accent rounded-full align-middle">Recommended</span>
        </div>
        <p class="text-xs text-text-muted mt-1.5">
          Record prompts with a hotkey, see live transcription, go hands-free
        </p>
      </div>
    </button>

    <button
      class="group flex flex-col items-center gap-3 p-6 bg-surface-elevated border-2 border-border hover:border-text-muted rounded-xl transition-all text-left"
      onclick={() => onChoose(false)}
    >
      <div class="p-3 bg-surface rounded-full group-hover:bg-border transition-colors">
        <svg class="w-8 h-8 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 6h16M4 12h16M4 18h7"
          />
        </svg>
      </div>
      <div class="text-center">
        <div class="font-semibold text-text-primary">Text</div>
        <p class="text-xs text-text-muted mt-1.5">
          Type your prompts. Voice stays hidden — enable it anytime in Settings
        </p>
      </div>
    </button>
  </div>
</div>
