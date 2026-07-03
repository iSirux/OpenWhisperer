/**
 * Actions for turning pile items into sessions.
 * Shared between the pile sidebar list (batch launch) and the detail view.
 */

import { get } from 'svelte/store';
import {
  sdkSessions,
  activeSdkSessionId,
  settingsToStoreEffort,
  type EffortLevel,
} from '$lib/stores/sdkSessions';
import { activeSessionId } from '$lib/stores/sessions';
import { settings } from '$lib/stores/settings';
import { repos, activeRepo, isRepoActive, findRepoById, type RepoConfig } from '$lib/stores/repos';
import { pile, pileItemTitle, type PileItem } from '$lib/stores/pile';
import { launchSession } from '$lib/utils/sessionLaunch';
import { buildSystemPrompt } from '$lib/composables/useTranscriptionProcessor.svelte';
import { navigation } from '$lib/stores/navigation';

export type PileLaunchAction = 'start' | 'plan' | 'discuss';

export const PILE_ACTIONS: { id: PileLaunchAction | 'prepare'; label: string; description: string }[] = [
  { id: 'start', label: 'Start', description: 'Send the prompt as a new session' },
  { id: 'prepare', label: 'Prepare', description: 'Create a draft session for review before sending' },
  { id: 'plan', label: 'Plan first', description: 'Ask for an implementation plan before any code' },
  { id: 'discuss', label: 'Discuss', description: 'Scan the codebase and talk it through first' },
];

export function buildPilePrompt(action: PileLaunchAction, transcript: string): string {
  const text = transcript.trim();
  switch (action) {
    case 'plan':
      return `${text}\n\nBefore writing any code, make a detailed implementation plan and present it to me first.`;
    case 'discuss':
      return `Scan the codebase to get an understanding, then let's discuss this - don't implement anything yet:\n\n${text}`;
    default:
      return text;
  }
}

/** Resolve the repo for a pile item (item's repoId → active repo fallback). */
export function resolvePileRepo(item: PileItem): RepoConfig | null {
  const repoList = get(repos).list;
  if (item.repoId) {
    const repo = findRepoById(repoList, item.repoId);
    if (repo) return repo;
  }
  return get(activeRepo) ?? null;
}

interface PileLaunchParams {
  repo: RepoConfig;
  model: string;
  effortLevel: EffortLevel;
  provider: 'claude' | 'openai';
  systemPrompt?: string;
}

function resolveLaunchParams(item: PileItem): PileLaunchParams | null {
  const repo = resolvePileRepo(item);
  if (!repo) return null;

  const s = get(settings);
  const provider: 'claude' | 'openai' = s.sdk_provider === 'OpenAI' ? 'openai' : 'claude';
  const defaultModel = provider === 'openai' ? s.openai_model : s.default_model;
  // Item models are Claude recommendations; ignore them when running Codex
  const model = (provider === 'claude' && item.model) || defaultModel;
  const effortLevel = item.effortLevel ?? settingsToStoreEffort(s.default_effort_level);

  const allRepos = get(repos).list.filter(isRepoActive);
  const systemPrompt = buildSystemPrompt({
    repoPath: repo.path,
    repoName: repo.name,
    includeTranscriptionNotice: true,
    allRepos,
  });

  return { repo, model, effortLevel, provider, systemPrompt };
}

/**
 * Launch a session from a pile item. Returns the session ID, or null if no
 * repo could be resolved. The item stays in the pile with the session linked.
 */
export async function launchPileItem(
  item: PileItem,
  action: PileLaunchAction,
  opts: { useWorktree?: boolean; playwrightQa?: boolean } = {}
): Promise<string | null> {
  const params = resolveLaunchParams(item);
  if (!params || !item.transcript.trim()) return null;

  const screenshot = await pile.getScreenshotImage(item.id);

  const sessionId = await launchSession({
    prompt: buildPilePrompt(action, item.transcript),
    images: screenshot ? [screenshot] : undefined,
    repo: params.repo,
    model: params.model,
    effortLevel: params.effortLevel,
    provider: params.provider,
    useWorktree: opts.useWorktree,
    branchNameHint: pileItemTitle(item),
    playwrightQa: opts.playwrightQa,
    systemPrompt: params.systemPrompt,
    tag: { pileItem: { id: item.id, title: pileItemTitle(item) } },
  });

  pile.linkSession(item.id, sessionId);
  return sessionId;
}

/**
 * Create a prepared (draft) session from a pile item without starting it.
 * Returns the session ID, or null if no repo could be resolved.
 */
export function preparePileItem(item: PileItem, select: boolean = true): string | null {
  const params = resolveLaunchParams(item);
  if (!params || !item.transcript.trim()) return null;

  const sessionId = sdkSessions.createPendingTranscriptionSession(
    params.model,
    params.effortLevel,
    params.provider
  );

  sdkSessions.set(
    get(sdkSessions).map((s) =>
      s.id === sessionId
        ? { ...s, pileItem: { id: item.id, title: pileItemTitle(item) } }
        : s
    )
  );

  sdkSessions.setPrepared(sessionId, item.transcript.trim(), params.repo.path, params.systemPrompt);
  pile.linkSession(item.id, sessionId);

  // Carry the recording screenshot over so it's attached when the draft launches
  if (item.hasScreenshot) {
    void pile.getScreenshotImage(item.id).then((screenshot) => {
      if (screenshot) {
        sdkSessions.updatePendingTranscription(sessionId, { screenshot });
      }
    });
  }

  if (select) {
    sdkSessions.selectSession(sessionId);
    activeSdkSessionId.set(sessionId);
    activeSessionId.set(null);
    navigation.setView('sessions');
  }

  return sessionId;
}
