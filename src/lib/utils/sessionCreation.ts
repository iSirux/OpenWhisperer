import { get } from 'svelte/store';
import { activeSessionId, sessions } from '$lib/stores/sessions';
import { activeSdkSessionId, sdkSessions, settingsToStoreEffort } from '$lib/stores/sdkSessions';
import { settings, getEffectiveTerminalMode } from '$lib/stores/settings';
import { DEFAULT_OPENAI_MODEL_ID } from '$lib/utils/models';

/**
 * Create and activate a new session using the current settings.
 * Works for both SDK and PTY modes.
 */
export async function createAndActivateNewSession(): Promise<void> {
  const currentSettings = get(settings);
  const terminalMode = getEffectiveTerminalMode(currentSettings);

  if (terminalMode === 'Sdk') {
    const provider = currentSettings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
    const model = provider === 'openai'
      ? (currentSettings.openai_model || DEFAULT_OPENAI_MODEL_ID)
      : currentSettings.default_model;
    const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);
    const sessionId = sdkSessions.createSetupSession(model, effortLevel, false, provider);
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    window.dispatchEvent(new CustomEvent('switch-to-sessions'));
    return;
  }

  try {
    const sessionId = await sessions.createInteractiveSession();
    activeSessionId.set(sessionId);
    activeSdkSessionId.set(null);
    window.dispatchEvent(new CustomEvent('switch-to-sessions'));
  } catch (error) {
    console.error('Failed to create session:', error);
  }
}
