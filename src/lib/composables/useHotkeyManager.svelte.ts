/**
 * Composable for managing global hotkey registration
 * Handles toggle_recording, transcribe_to_input, cycle_repo, and cycle_model hotkeys
 */

import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { settings } from '$lib/stores/settings';
import { isRecording } from '$lib/stores/recording';
import { overlay } from '$lib/stores/overlay';
import { isModelRecommendationEnabled, isRepoAutoSelectEnabled } from '$lib/utils/llm';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export interface HotkeyCallbacks {
  /** Called when recording should start */
  onStartRecording: () => Promise<void>;
  /** Called when recording should stop and send */
  onStopAndSend: () => Promise<void>;
  /** Called when recording should stop and paste to input */
  onStopAndPaste: () => Promise<void>;
  /** Called when recording should start in note mode */
  onStartNoteRecording: () => Promise<void>;
}

export function useHotkeyManager() {
  // Registration state
  let transcribeHotkeyRegistered = false;
  let cycleRepoHotkeyRegistered = false;
  let cycleModelHotkeyRegistered = false;
  let noteModeHotkeyRegistered = false;
  let registeredCycleRepoHotkey: string | null = null;
  let registeredCycleModelHotkey: string | null = null;
  let registeredToggleRecordingHotkey: string | null = null;
  let registeredNoteModeHotkey: string | null = null;

  // Debounce flags
  let isTogglingRecording = false;
  let isCyclingRepo = false;
  let isCyclingModel = false;
  let isStartingNoteMode = false;

  // Callbacks stored from setup
  let callbacks: HotkeyCallbacks | null = null;

  /**
   * Setup the main toggle_recording and note_mode hotkeys
   * @param cb Callbacks for recording actions
   */
  async function setup(cb: HotkeyCallbacks) {
    callbacks = cb;

    try {
      console.log('[Hotkey] Unregistering all hotkeys...');
      await unregisterAll();
      transcribeHotkeyRegistered = false;
      cycleRepoHotkeyRegistered = false;
      cycleModelHotkeyRegistered = false;
      noteModeHotkeyRegistered = false;
      registeredCycleRepoHotkey = null;
      registeredCycleModelHotkey = null;
      registeredToggleRecordingHotkey = null;
      registeredNoteModeHotkey = null;

      const currentSettings = get(settings);
      console.log('[Hotkey] Registering toggle_recording:', currentSettings.hotkeys.toggle_recording);

      await register(currentSettings.hotkeys.toggle_recording, async () => {
        if (isTogglingRecording) return;
        isTogglingRecording = true;

        try {
          if (get(isRecording)) {
            await callbacks?.onStopAndSend();
          } else {
            await callbacks?.onStartRecording();
          }
        } finally {
          setTimeout(() => {
            isTogglingRecording = false;
          }, 200);
        }
      });

      registeredToggleRecordingHotkey = currentSettings.hotkeys.toggle_recording;
      console.log('[Hotkey] Successfully registered toggle_recording:', registeredToggleRecordingHotkey);

      // Register note mode hotkey
      const noteModeHotkey = currentSettings.hotkeys.note_mode;
      if (noteModeHotkey && noteModeHotkey !== currentSettings.hotkeys.toggle_recording) {
        console.log('[Hotkey] Registering note_mode:', noteModeHotkey);
        await register(noteModeHotkey, async () => {
          if (isStartingNoteMode || get(isRecording)) return;
          isStartingNoteMode = true;

          try {
            await callbacks?.onStartNoteRecording();
          } finally {
            setTimeout(() => {
              isStartingNoteMode = false;
            }, 200);
          }
        });

        registeredNoteModeHotkey = noteModeHotkey;
        noteModeHotkeyRegistered = true;
        console.log('[Hotkey] Successfully registered note_mode:', noteModeHotkey);
      }
    } catch (error) {
      console.error('Failed to register hotkeys:', error);
    }
  }

  /**
   * Check if the toggle_recording hotkey has changed and re-register if needed
   */
  function checkForHotkeyChange(currentHotkey: string) {
    if (!currentHotkey || currentHotkey === registeredToggleRecordingHotkey) {
      return false;
    }

    if (registeredToggleRecordingHotkey !== null && callbacks) {
      console.log('[Hotkey] Detected hotkey change, re-registering...', {
        old: registeredToggleRecordingHotkey,
        new: currentHotkey,
      });
      return true;
    }

    return false;
  }

  /**
   * Register the transcribe-to-input hotkey (only while recording)
   */
  async function registerTranscribeHotkey() {
    if (transcribeHotkeyRegistered) return;

    const currentSettings = get(settings);
    try {
      await register(currentSettings.hotkeys.transcribe_to_input, async () => {
        if (!get(isRecording)) return;
        if (isTogglingRecording) return;
        isTogglingRecording = true;

        try {
          await callbacks?.onStopAndPaste();
        } finally {
          setTimeout(() => {
            isTogglingRecording = false;
          }, 200);
        }
      });
      transcribeHotkeyRegistered = true;
    } catch (error) {
      console.error('Failed to register transcribe hotkey:', error);
    }
  }

  /**
   * Unregister the transcribe-to-input hotkey
   */
  async function unregisterTranscribeHotkey() {
    if (!transcribeHotkeyRegistered) return;

    const currentSettings = get(settings);
    try {
      await unregister(currentSettings.hotkeys.transcribe_to_input);
      transcribeHotkeyRegistered = false;
    } catch (error) {
      console.error('Failed to unregister transcribe hotkey:', error);
    }
  }

  /**
   * Register the cycle-repo hotkey (only while recording)
   * Supports cycling through repos and auto-repo mode
   */
  async function registerCycleRepoHotkey() {
    if (cycleRepoHotkeyRegistered) {
      console.log('[Hotkey] Cycle repo hotkey already registered, skipping');
      return;
    }

    const currentSettings = get(settings);
    const autoRepoEnabled = isRepoAutoSelectEnabled();

    // Need at least 2 options to cycle: with auto-repo enabled, 1 repo is enough (auto + repo)
    const minRepos = autoRepoEnabled ? 1 : 2;
    if (currentSettings.repos.length < minRepos) {
      console.log(
        '[Hotkey] Only',
        currentSettings.repos.length,
        'repo(s) configured, auto-repo:',
        autoRepoEnabled,
        '- skipping cycle repo hotkey'
      );
      return;
    }

    const hotkeyString = currentSettings.hotkeys.cycle_repo;
    console.log('[Hotkey] Registering cycle repo hotkey:', hotkeyString);

    try {
      await register(hotkeyString, async () => {
        console.log('[Hotkey] Cycle repo hotkey pressed!');
        if (isCyclingRepo) {
          console.log('[Hotkey] Debouncing cycle repo');
          return;
        }
        isCyclingRepo = true;

        try {
          if (!get(isRecording)) {
            console.log('[Hotkey] Not recording, ignoring cycle repo');
            return;
          }

          const s = get(settings);
          const autoRepoEnabled = isRepoAutoSelectEnabled();

          // Build list of cyclable options: 'auto' (if enabled) + repo indices
          const cyclableOptions: ('auto' | number)[] = [];
          if (autoRepoEnabled) {
            cyclableOptions.push('auto');
          }
          for (let i = 0; i < s.repos.length; i++) {
            cyclableOptions.push(i);
          }

          // Need at least 2 options to cycle
          if (cyclableOptions.length < 2) return;

          // Determine current position
          const currentOption: 'auto' | number = s.auto_repo_mode ? 'auto' : s.active_repo_index;
          const currentIndex = cyclableOptions.indexOf(currentOption);
          const nextIndex = (currentIndex + 1) % cyclableOptions.length;
          const nextOption = cyclableOptions[nextIndex];

          console.log('[Hotkey] Cycling repo from', currentOption, 'to', nextOption);

          if (nextOption === 'auto') {
            // Switch to auto-repo mode
            await settings.setAutoRepoMode(true);
            overlay.setSessionInfo(null, get(settings).default_model, false);
          } else {
            // Switch to specific repo
            if (s.auto_repo_mode) {
              await settings.setAutoRepoMode(false);
            }
            await settings.setActiveRepo(nextOption);

            // Update overlay with new repo info
            const newRepo = s.repos[nextOption];
            if (newRepo) {
              let branch: string | null = null;
              try {
                branch = await invoke<string>('get_git_branch', { repoPath: newRepo.path });
              } catch (e) {
                console.error('Failed to get git branch:', e);
              }
              overlay.setSessionInfo(branch, get(settings).default_model, false);
            }
          }
        } finally {
          setTimeout(() => {
            isCyclingRepo = false;
          }, 200);
        }
      });
      registeredCycleRepoHotkey = hotkeyString;
      cycleRepoHotkeyRegistered = true;
      console.log('[Hotkey] Successfully registered cycle repo hotkey:', hotkeyString);
    } catch (error) {
      console.error('Failed to register cycle repo hotkey:', error);
    }
  }

  /**
   * Unregister the cycle-repo hotkey
   */
  async function unregisterCycleRepoHotkey() {
    if (!cycleRepoHotkeyRegistered || !registeredCycleRepoHotkey) return;

    try {
      await unregister(registeredCycleRepoHotkey);
      console.log('[Hotkey] Unregistered cycle repo hotkey:', registeredCycleRepoHotkey);
      cycleRepoHotkeyRegistered = false;
      registeredCycleRepoHotkey = null;
    } catch (error) {
      console.error('Failed to unregister cycle repo hotkey:', error);
    }
  }

  /**
   * Register the cycle-model hotkey (only while recording)
   */
  async function registerCycleModelHotkey() {
    if (cycleModelHotkeyRegistered) return;

    const hotkeyString = get(settings).hotkeys.cycle_model;
    try {
      await register(hotkeyString, async () => {
        if (isCyclingModel) return;
        isCyclingModel = true;

        try {
          if (!get(isRecording)) return;

          const currentSettings = get(settings);
          const currentOverlay = get(overlay);

          // Get enabled models for cycling (exclude 1M context variant)
          let cyclableModels = currentSettings.enabled_models.filter(
            (id: string) => !id.includes('[1m]')
          );

          // Add 'auto' to cyclable models if smart model selection is enabled
          if (isModelRecommendationEnabled()) {
            cyclableModels = ['auto', ...cyclableModels];
          }

          if (cyclableModels.length < 2) return;

          const currentIndex = cyclableModels.indexOf(currentSettings.default_model);
          const nextIndex = (currentIndex + 1) % cyclableModels.length;
          const nextModel = cyclableModels[nextIndex];

          settings.update(s => ({ ...s, default_model: nextModel }));
          await settings.save({ ...currentSettings, default_model: nextModel });

          overlay.setSessionInfo(currentOverlay.sessionInfo.branch, nextModel, false);
        } finally {
          setTimeout(() => {
            isCyclingModel = false;
          }, 200);
        }
      });
      registeredCycleModelHotkey = hotkeyString;
      cycleModelHotkeyRegistered = true;
      console.log('[Hotkey] Registered cycle model hotkey:', hotkeyString);
    } catch (error) {
      console.error('Failed to register cycle model hotkey:', error);
    }
  }

  /**
   * Unregister the cycle-model hotkey
   */
  async function unregisterCycleModelHotkey() {
    if (!cycleModelHotkeyRegistered || !registeredCycleModelHotkey) return;

    try {
      await unregister(registeredCycleModelHotkey);
      console.log('[Hotkey] Unregistered cycle model hotkey:', registeredCycleModelHotkey);
      cycleModelHotkeyRegistered = false;
      registeredCycleModelHotkey = null;
    } catch (error) {
      console.error('Failed to unregister cycle model hotkey:', error);
    }
  }

  /**
   * Register all "while recording" hotkeys
   */
  async function registerRecordingHotkeys() {
    await registerTranscribeHotkey();
    await registerCycleRepoHotkey();
    await registerCycleModelHotkey();
  }

  /**
   * Unregister all "while recording" hotkeys
   */
  async function unregisterRecordingHotkeys() {
    await unregisterTranscribeHotkey();
    await unregisterCycleRepoHotkey();
    await unregisterCycleModelHotkey();
  }

  /**
   * Cleanup all hotkeys - call this on component destroy
   * This is critical for HMR to work properly, as hotkeys are registered at the OS level
   */
  async function cleanup() {
    console.log('[Hotkey] Cleaning up all hotkeys...');
    try {
      await unregisterAll();
      transcribeHotkeyRegistered = false;
      cycleRepoHotkeyRegistered = false;
      cycleModelHotkeyRegistered = false;
      noteModeHotkeyRegistered = false;
      registeredCycleRepoHotkey = null;
      registeredCycleModelHotkey = null;
      registeredToggleRecordingHotkey = null;
      registeredNoteModeHotkey = null;
      callbacks = null;
      console.log('[Hotkey] Cleanup complete');
    } catch (error) {
      console.error('[Hotkey] Failed to cleanup hotkeys:', error);
    }
  }

  return {
    get registeredToggleHotkey() { return registeredToggleRecordingHotkey; },
    setup,
    checkForHotkeyChange,
    registerRecordingHotkeys,
    unregisterRecordingHotkeys,
    cleanup,
  };
}
