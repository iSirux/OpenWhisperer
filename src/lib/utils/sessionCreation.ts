import { get } from 'svelte/store';
import { activeSdkSessionId, sdkSessions, settingsToStoreEffort } from '$lib/stores/sdkSessions';
import { settings } from '$lib/stores/settings';
import { repos, findRepoById } from '$lib/stores/repos';
import { DEFAULT_OPENAI_MODEL_ID } from '$lib/utils/models';

/**
 * Create and activate a new SDK setup session using the current settings.
 * `repoPath` preselects the repository in the setup view.
 */
export async function createAndActivateNewSession(repoPath?: string): Promise<void> {
  const currentSettings = get(settings);
  const provider = currentSettings.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
  const model = provider === 'openai'
    ? (currentSettings.openai_model || DEFAULT_OPENAI_MODEL_ID)
    : currentSettings.default_model;
  const effortLevel = settingsToStoreEffort(currentSettings.default_effort_level);
  const sessionId = sdkSessions.createSetupSession(model, effortLevel, provider, repoPath ?? '');
  activeSdkSessionId.set(sessionId);
  window.dispatchEvent(new CustomEvent('switch-to-sessions'));
}

/**
 * Create a new SDK setup session in the same repo/worktree as an existing session
 * (the active one by default), inheriting its provider, model, and effort level.
 * When the source session runs in a worktree, the setup form preselects that same
 * worktree via "existing" worktree mode. Falls back to a plain new session when
 * there's no usable source (no active SDK session or no cwd).
 */
export async function createSessionInSameRepo(sourceSessionId?: string): Promise<void> {
  const allSdkSessions = get(sdkSessions);
  const source = allSdkSessions.find(
    (s) => s.id === (sourceSessionId ?? get(activeSdkSessionId))
  );

  if (!source || !source.cwd || source.cwd === '.') {
    await createAndActivateNewSession();
    return;
  }

  // Canonical repo path: resolve via repoId (handles worktree cwds), then by exact
  // path match; a cwd not tied to any configured repo is used as the repo path itself.
  const repoList = get(repos).list || [];
  const repo =
    (source.repoId ? findRepoById(repoList, source.repoId) : undefined) ??
    repoList.find((r) => r.path === source.cwd);
  const repoPath = repo?.path || source.cwd;

  const sessionId = sdkSessions.createSetupSession(
    source.model,
    source.effortLevel,
    source.provider,
    repoPath
  );

  if (repoPath !== source.cwd) {
    // Source runs in a worktree — preselect that worktree in the setup form.
    sdkSessions.updateSetupConfig(sessionId, {
      setupWorktreeMode: 'existing',
      setupWorktreePath: source.cwd,
    });
  }

  activeSdkSessionId.set(sessionId);
  window.dispatchEvent(new CustomEvent('switch-to-sessions'));
}
