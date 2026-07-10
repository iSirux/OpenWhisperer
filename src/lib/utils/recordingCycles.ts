/**
 * Shared cycling logic for the pre-send recording context (repo, model).
 * Used by the global hotkeys (useHotkeyManager) and the overlay chip clicks
 * (cycle-repo / cycle-model events handled in the main window).
 */

import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { settings } from '$lib/stores/settings';
import { repos } from '$lib/stores/repos';
import { overlay } from '$lib/stores/overlay';
import { isModelRecommendationEnabled, isRepoAutoSelectEnabled } from '$lib/utils/llm';
import { DEFAULT_OPENAI_MODEL_ID } from '$lib/utils/models';

export function getSelectedToolbarModel(): string {
  const currentSettings = get(settings);
  const provider = currentSettings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
  return provider === 'openai'
    ? (currentSettings.openai_model || DEFAULT_OPENAI_MODEL_ID)
    : currentSettings.default_model;
}

/**
 * Cycle the active repository: auto-repo mode (if enabled) → each active repo → back.
 * Updates the overlay session info with the new repo's branch.
 */
export async function cycleRepo(): Promise<void> {
  const autoRepoEnabled = isRepoAutoSelectEnabled();

  // Build list of cyclable options: 'auto' (if enabled) + active repo indices
  const cyclableOptions: ('auto' | number)[] = [];
  if (autoRepoEnabled) {
    cyclableOptions.push('auto');
  }
  for (let i = 0; i < get(repos).list.length; i++) {
    if (get(repos).list[i].active !== false) {
      cyclableOptions.push(i);
    }
  }

  // Need at least 2 options to cycle
  if (cyclableOptions.length < 2) return;

  // Determine current position
  const currentOption: 'auto' | number = get(repos).autoMode ? 'auto' : get(repos).activeIndex;
  const currentIndex = cyclableOptions.indexOf(currentOption);
  const nextIndex = (currentIndex + 1) % cyclableOptions.length;
  const nextOption = cyclableOptions[nextIndex];

  console.log('[Cycle] Cycling repo from', currentOption, 'to', nextOption);

  if (nextOption === 'auto') {
    // Switch to auto-repo mode
    await repos.setAutoRepoMode(true);
    overlay.setSessionInfo(null, getSelectedToolbarModel(), false);
  } else {
    // Switch to specific repo
    if (get(repos).autoMode) {
      await repos.setAutoRepoMode(false);
    }
    await repos.setActiveRepo(nextOption);

    // Update overlay with new repo info
    const newRepo = get(repos).list[nextOption];
    if (newRepo) {
      let branch: string | null = null;
      try {
        branch = await invoke<string>('get_git_branch', { repoPath: newRepo.path });
      } catch (e) {
        console.error('Failed to get git branch:', e);
      }
      overlay.setSessionInfo(branch, getSelectedToolbarModel(), false);
    }
  }
}

/**
 * Cycle the default model through the enabled models ('auto' first if smart
 * model selection is enabled). Persists the setting and updates the overlay.
 */
export async function cycleModel(): Promise<void> {
  const currentSettings = get(settings);
  const currentOverlay = get(overlay);

  // Get enabled models for cycling
  let cyclableModels = [...currentSettings.enabled_models];

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
}
