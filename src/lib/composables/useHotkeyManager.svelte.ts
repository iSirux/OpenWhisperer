/**
 * Composable for managing global hotkey registration
 * Handles toggle_recording, transcribe_to_input, cycle_repo, and cycle_model hotkeys
 */

import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { settings, type HotkeyEnabledConfig } from '$lib/stores/settings';
import { repos } from '$lib/stores/repos';
import { isRecording } from '$lib/stores/recording';
import { isRepoAutoSelectEnabled } from '$lib/utils/llm';
import { cycleModel, cycleRepo } from '$lib/utils/recordingCycles';
import { get } from 'svelte/store';

export interface HotkeyCallbacks {
  /** Called when recording should start */
  onStartRecording: () => Promise<void>;
  /** Called when recording should stop and send */
  onStopAndSend: () => Promise<void>;
  /** Called when recording should stop and paste to input */
  onStopAndPaste: () => Promise<void>;
  /** Called when recording should stop and be saved to the pile */
  onStopAndPile: () => Promise<void>;
  /** Called when selected text should be copied and sent as a new prompt */
  onSendSelection: () => Promise<void>;
  /** Called when selected text should be copied and prepared as a session */
  onPrepareSelection: () => Promise<void>;
}

export function useHotkeyManager() {
  // Registration state
  let transcribeHotkeyRegistered = false;
  let pileHotkeyRegistered = false;
  let registeredPileHotkey: string | null = null;
  let cycleRepoHotkeyRegistered = false;
  let cycleModelHotkeyRegistered = false;
  let registeredCycleRepoHotkey: string | null = null;
  let registeredCycleModelHotkey: string | null = null;
  let registeredToggleRecordingHotkey: string | null = null;
  let sendSelectionHotkeyRegistered = false;
  let prepareSelectionHotkeyRegistered = false;
  let registeredSendSelectionHotkey: string | null = null;
  let registeredPrepareSelectionHotkey: string | null = null;

  // Debounce flags
  let isTogglingRecording = false;
  let isCyclingRepo = false;
  let isCyclingModel = false;
  let isSendingSelection = false;
  let isPreparingSelection = false;

  // Track last-known enabled state for change detection
  let lastEnabledState: string | null = null;
  // Track last-known No Voice Mode flag so toggling it re-registers hotkeys.
  let lastVoiceModeDisabled: boolean | null = null;

  // Callbacks stored from setup
  let callbacks: HotkeyCallbacks | null = null;

  /**
   * Setup the main toggle_recording hotkey
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
      registeredCycleRepoHotkey = null;
      registeredCycleModelHotkey = null;
      registeredToggleRecordingHotkey = null;

      const currentSettings = get(settings);
      const enabled = currentSettings.hotkeys_enabled;
      // No Voice Mode disables all voice/recording hotkeys (but keeps the
      // selection hotkeys, which drive text-only flows).
      const voiceDisabled = currentSettings.system.voice_mode_disabled;

      // Register toggle_recording hotkey (only if enabled)
      if (enabled.toggle_recording && !voiceDisabled) {
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
      } else {
        console.log('[Hotkey] toggle_recording is disabled, skipping registration');
      }

      // Collect already-registered hotkeys for collision detection
      const registeredHotkeys = new Set([
        currentSettings.hotkeys.toggle_recording,
      ].filter(Boolean));

      // Register send_selection hotkey (only if enabled)
      const sendSelectionHotkey = currentSettings.hotkeys.send_selection;
      if (enabled.send_selection && sendSelectionHotkey && !registeredHotkeys.has(sendSelectionHotkey)) {
        console.log('[Hotkey] Registering send_selection:', sendSelectionHotkey);
        await register(sendSelectionHotkey, async () => {
          if (isSendingSelection || get(isRecording)) return;
          isSendingSelection = true;

          try {
            await callbacks?.onSendSelection();
          } finally {
            setTimeout(() => {
              isSendingSelection = false;
            }, 200);
          }
        });

        registeredSendSelectionHotkey = sendSelectionHotkey;
        sendSelectionHotkeyRegistered = true;
        registeredHotkeys.add(sendSelectionHotkey);
        console.log('[Hotkey] Successfully registered send_selection:', sendSelectionHotkey);
      } else if (!enabled.send_selection) {
        console.log('[Hotkey] send_selection is disabled, skipping registration');
      }

      // Register prepare_selection hotkey (only if enabled)
      const prepareSelectionHotkey = currentSettings.hotkeys.prepare_selection;
      if (enabled.prepare_selection && prepareSelectionHotkey && !registeredHotkeys.has(prepareSelectionHotkey)) {
        console.log('[Hotkey] Registering prepare_selection:', prepareSelectionHotkey);
        await register(prepareSelectionHotkey, async () => {
          if (isPreparingSelection || get(isRecording)) return;
          isPreparingSelection = true;

          try {
            await callbacks?.onPrepareSelection();
          } finally {
            setTimeout(() => {
              isPreparingSelection = false;
            }, 200);
          }
        });

        registeredPrepareSelectionHotkey = prepareSelectionHotkey;
        prepareSelectionHotkeyRegistered = true;
        registeredHotkeys.add(prepareSelectionHotkey);
        console.log('[Hotkey] Successfully registered prepare_selection:', prepareSelectionHotkey);
      } else if (!enabled.prepare_selection) {
        console.log('[Hotkey] prepare_selection is disabled, skipping registration');
      }
    } catch (error) {
      console.error('Failed to register hotkeys:', error);
    }
  }

  /**
   * Check if the toggle_recording hotkey or enabled states have changed and re-register if needed
   */
  function checkForHotkeyChange(
    currentHotkey: string,
    enabledState?: HotkeyEnabledConfig,
    voiceModeDisabled?: boolean,
  ) {
    // Check if the No Voice Mode flag changed (it gates which hotkeys register)
    if (voiceModeDisabled !== undefined) {
      if (
        lastVoiceModeDisabled !== null &&
        voiceModeDisabled !== lastVoiceModeDisabled &&
        callbacks
      ) {
        console.log('[Hotkey] Detected No Voice Mode change, re-registering...');
        lastVoiceModeDisabled = voiceModeDisabled;
        return true;
      }
      lastVoiceModeDisabled = voiceModeDisabled;
    }

    // Check if enabled states changed
    if (enabledState) {
      const enabledStr = JSON.stringify(enabledState);
      if (lastEnabledState !== null && enabledStr !== lastEnabledState && callbacks) {
        console.log('[Hotkey] Detected enabled state change, re-registering...');
        lastEnabledState = enabledStr;
        return true;
      }
      lastEnabledState = enabledStr;
    }

    // Check if hotkey binding changed
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
    if (currentSettings.system.voice_mode_disabled) return;
    if (!currentSettings.hotkeys_enabled.transcribe_to_input) {
      console.log('[Hotkey] transcribe_to_input is disabled, skipping registration');
      return;
    }
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
   * Register the pile-recording hotkey (only while recording).
   * Stops the current recording and saves it to the pile.
   */
  async function registerPileHotkey() {
    if (pileHotkeyRegistered) return;

    const currentSettings = get(settings);
    if (currentSettings.system.voice_mode_disabled) return;
    if (!currentSettings.hotkeys_enabled.pile_recording) {
      console.log('[Hotkey] pile_recording is disabled, skipping registration');
      return;
    }
    const hotkeyString = currentSettings.hotkeys.pile_recording;
    if (!hotkeyString) return;
    try {
      await register(hotkeyString, async () => {
        if (!get(isRecording)) return;
        if (isTogglingRecording) return;
        isTogglingRecording = true;

        try {
          await callbacks?.onStopAndPile();
        } finally {
          setTimeout(() => {
            isTogglingRecording = false;
          }, 200);
        }
      });
      registeredPileHotkey = hotkeyString;
      pileHotkeyRegistered = true;
    } catch (error) {
      console.error('Failed to register pile hotkey:', error);
    }
  }

  /**
   * Unregister the pile-recording hotkey
   */
  async function unregisterPileHotkey() {
    if (!pileHotkeyRegistered || !registeredPileHotkey) return;

    try {
      await unregister(registeredPileHotkey);
      pileHotkeyRegistered = false;
      registeredPileHotkey = null;
    } catch (error) {
      console.error('Failed to unregister pile hotkey:', error);
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
    if (currentSettings.system.voice_mode_disabled) return;
    if (!currentSettings.hotkeys_enabled.cycle_repo) {
      console.log('[Hotkey] cycle_repo is disabled, skipping registration');
      return;
    }
    const autoRepoEnabled = isRepoAutoSelectEnabled();

    // Need at least 2 options to cycle: with auto-repo enabled, 1 repo is enough (auto + repo)
    const activeRepoCount = get(repos).list.filter((r) => r.active !== false).length;
    const minRepos = autoRepoEnabled ? 1 : 2;
    if (activeRepoCount < minRepos) {
      console.log(
        '[Hotkey] Only',
        activeRepoCount,
        'active repo(s) configured, auto-repo:',
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

          await cycleRepo();
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

    const currentSettings = get(settings);
    if (currentSettings.system.voice_mode_disabled) return;
    if (!currentSettings.hotkeys_enabled.cycle_model) {
      console.log('[Hotkey] cycle_model is disabled, skipping registration');
      return;
    }
    const hotkeyString = currentSettings.hotkeys.cycle_model;
    try {
      await register(hotkeyString, async () => {
        if (isCyclingModel) return;
        isCyclingModel = true;

        try {
          if (!get(isRecording)) return;

          await cycleModel();
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
    await registerPileHotkey();
    await registerCycleRepoHotkey();
    await registerCycleModelHotkey();
  }

  /**
   * Unregister all "while recording" hotkeys
   */
  async function unregisterRecordingHotkeys() {
    await unregisterTranscribeHotkey();
    await unregisterPileHotkey();
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
      pileHotkeyRegistered = false;
      registeredPileHotkey = null;
      cycleRepoHotkeyRegistered = false;
      cycleModelHotkeyRegistered = false;
      registeredCycleRepoHotkey = null;
      registeredCycleModelHotkey = null;
      registeredToggleRecordingHotkey = null;
      sendSelectionHotkeyRegistered = false;
      prepareSelectionHotkeyRegistered = false;
      registeredSendSelectionHotkey = null;
      registeredPrepareSelectionHotkey = null;
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
