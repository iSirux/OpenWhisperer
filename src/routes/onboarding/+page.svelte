<script lang="ts">
  // First-run onboarding wizard. Lives outside the (main) route group on
  // purpose: it renders chromeless (no AppHeader / rail) in the main window,
  // exactly like the overlay route. The (main) layout redirects here while
  // `onboarding_completed` is false.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import { settings, settingsLoaded } from '$lib/stores/settings';
  import WelcomeStep from '$lib/components/onboarding/WelcomeStep.svelte';
  import MicrophoneStep from '$lib/components/onboarding/MicrophoneStep.svelte';
  import TranscriptionStep from '$lib/components/onboarding/TranscriptionStep.svelte';
  import AgentStep from '$lib/components/onboarding/AgentStep.svelte';
  import LlmStep from '$lib/components/onboarding/LlmStep.svelte';
  import RepoStep from '$lib/components/onboarding/RepoStep.svelte';

  type StepId = 'welcome' | 'microphone' | 'transcription' | 'agent' | 'llm' | 'repository';

  let ready = $state(false);
  let currentIndex = $state(0);

  onMount(async () => {
    if (!get(settingsLoaded)) {
      await settings.load();
    }
    document.documentElement.setAttribute('data-theme', get(settings).theme);
    ready = true;
  });

  const voice = $derived(!$settings.system.voice_mode_disabled);
  const steps = $derived<StepId[]>(
    voice
      ? ['welcome', 'microphone', 'transcription', 'agent', 'llm', 'repository']
      : ['welcome', 'agent', 'llm', 'repository']
  );
  const currentStep = $derived(steps[Math.min(currentIndex, steps.length - 1)]);
  const isLast = $derived(currentIndex >= steps.length - 1);

  const STEP_TITLES: Record<StepId, { title: string; subtitle: string }> = {
    welcome: { title: '', subtitle: '' },
    microphone: { title: 'Microphone', subtitle: 'Pick your recording device and make sure it hears you' },
    transcription: { title: 'Transcription', subtitle: 'Local speech-to-text via Docker — recommended setup, one click' },
    agent: { title: 'Coding agent', subtitle: 'Choose which agent(s) you want to use' },
    llm: { title: 'Smart features', subtitle: 'A lightweight LLM cleans up transcripts, names sessions, and picks models' },
    repository: { title: 'Your first repository', subtitle: 'Point OpenWhisperer at a project to work in' },
  };

  // Persist wizard progress so choices survive an app restart mid-setup.
  async function persist() {
    try {
      await settings.save(get(settings));
    } catch (e) {
      console.error('[onboarding] Failed to save settings:', e);
    }
  }

  async function handleModeChosen(voiceMode: boolean) {
    settings.update((s) => ({
      ...s,
      system: { ...s.system, voice_mode_disabled: !voiceMode },
    }));
    await persist();
    currentIndex = 1;
  }

  async function next() {
    await persist();
    if (isLast) {
      await finish();
    } else {
      currentIndex += 1;
    }
  }

  function back() {
    if (currentIndex > 0) currentIndex -= 1;
  }

  async function finish() {
    settings.update((s) => ({ ...s, onboarding_completed: true }));
    await persist();
    goto('/');
  }
</script>

<div class="h-screen flex flex-col bg-background text-text-primary select-none overflow-hidden">
  {#if ready}
    <!-- Top bar: brand + skip -->
    <div class="flex items-center justify-between px-8 py-5 flex-shrink-0">
      <span class="text-sm font-semibold text-text-muted tracking-wide">OpenWhisperer</span>
      {#if currentIndex > 0}
        <button
          class="text-xs text-text-muted hover:text-text-secondary transition-colors"
          onclick={finish}
        >
          Skip setup
        </button>
      {/if}
    </div>

    <!-- Step content -->
    <div class="flex-1 overflow-y-auto flex justify-center px-6">
      <div class="w-full max-w-2xl py-4">
        {#if currentStep !== 'welcome'}
          <div class="mb-6">
            <h1 class="text-2xl font-bold mb-1">{STEP_TITLES[currentStep].title}</h1>
            <p class="text-sm text-text-muted">{STEP_TITLES[currentStep].subtitle}</p>
          </div>
        {/if}

        {#if currentStep === 'welcome'}
          <WelcomeStep onChoose={handleModeChosen} />
        {:else if currentStep === 'microphone'}
          <MicrophoneStep />
        {:else if currentStep === 'transcription'}
          <TranscriptionStep />
        {:else if currentStep === 'agent'}
          <AgentStep />
        {:else if currentStep === 'llm'}
          <LlmStep />
        {:else if currentStep === 'repository'}
          <RepoStep />
        {/if}
      </div>
    </div>

    <!-- Footer: progress + navigation -->
    <div class="flex items-center justify-between px-8 py-5 flex-shrink-0 border-t border-border/50">
      <div class="w-24">
        {#if currentIndex > 0}
          <button
            class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            onclick={back}
          >
            Back
          </button>
        {/if}
      </div>

      <!-- Progress dots -->
      <div class="flex items-center gap-2">
        {#each steps as _, i}
          <div
            class="rounded-full transition-all duration-300 {i === currentIndex
              ? 'w-6 h-2 bg-accent'
              : i < currentIndex
                ? 'w-2 h-2 bg-accent/60'
                : 'w-2 h-2 bg-border'}"
          ></div>
        {/each}
      </div>

      <div class="w-24 flex justify-end">
        {#if currentIndex > 0}
          <button
            class="px-5 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            onclick={next}
          >
            {isLast ? 'Finish' : 'Continue'}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
