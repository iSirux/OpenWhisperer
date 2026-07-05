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
import { appendChips, mergeChips } from '$lib/utils/promptChips';

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

/** Merge several pile item transcripts into one multi-task prompt. */
function buildCombinedTranscript(items: PileItem[]): string {
  const parts = items.map(
    (item, i) => `### Task ${i + 1}: ${pileItemTitle(item)}\n\n${item.transcript.trim()}`
  );
  return `Handle the following ${items.length} voice-recorded tasks in this session:\n\n${parts.join('\n\n')}`;
}

function combinedPileTitle(items: PileItem[]): string {
  return `${pileItemTitle(items[0])} +${items.length - 1} more`;
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
    prompt: appendChips(buildPilePrompt(action, item.transcript), item.selectedChips),
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
 * Launch a single session that handles several pile items together. Repo,
 * model, and effort come from the first item; all screenshots are attached
 * and every item gets the session linked.
 */
export async function launchPileItemsTogether(
  items: PileItem[],
  action: PileLaunchAction,
  opts: { useWorktree?: boolean; playwrightQa?: boolean } = {}
): Promise<string | null> {
  const usable = items.filter((i) => i.transcript.trim());
  if (usable.length === 0) return null;
  if (usable.length === 1) return launchPileItem(usable[0], action, opts);

  const params = resolveLaunchParams(usable[0]);
  if (!params) return null;

  const screenshots = (
    await Promise.all(
      usable.map((i) => (i.hasScreenshot ? pile.getScreenshotImage(i.id) : null))
    )
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const title = combinedPileTitle(usable);
  const chips = mergeChips(...usable.map((i) => i.selectedChips));
  const sessionId = await launchSession({
    prompt: appendChips(buildPilePrompt(action, buildCombinedTranscript(usable)), chips),
    images: screenshots.length > 0 ? screenshots : undefined,
    repo: params.repo,
    model: params.model,
    effortLevel: params.effortLevel,
    provider: params.provider,
    useWorktree: opts.useWorktree,
    branchNameHint: title,
    playwrightQa: opts.playwrightQa,
    systemPrompt: params.systemPrompt,
    tag: { pileItem: { id: usable[0].id, title } },
  });

  for (const item of usable) {
    pile.linkSession(item.id, sessionId);
  }
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

  sdkSessions.setPrepared(
    sessionId,
    item.transcript.trim(),
    params.repo.path,
    params.systemPrompt,
    undefined,
    item.selectedChips
  );
  pile.linkSession(item.id, sessionId);

  // Carry the recording screenshot over so it's attached when the draft launches
  if (item.hasScreenshot) {
    void pile.getScreenshotImage(item.id).then((screenshot) => {
      if (screenshot) {
        sdkSessions.updatePendingTranscription(sessionId, { screenshots: [screenshot] });
      }
    });
  }

  if (select) {
    selectPreparedSession(sessionId);
  }

  return sessionId;
}

/**
 * Create one prepared (draft) session covering several pile items.
 * Returns the session ID, or null if no repo could be resolved.
 */
export function preparePileItemsTogether(items: PileItem[], select: boolean = true): string | null {
  const usable = items.filter((i) => i.transcript.trim());
  if (usable.length === 0) return null;
  if (usable.length === 1) return preparePileItem(usable[0], select);

  const params = resolveLaunchParams(usable[0]);
  if (!params) return null;

  const title = combinedPileTitle(usable);
  const sessionId = sdkSessions.createPendingTranscriptionSession(
    params.model,
    params.effortLevel,
    params.provider
  );

  sdkSessions.set(
    get(sdkSessions).map((s) =>
      s.id === sessionId ? { ...s, pileItem: { id: usable[0].id, title } } : s
    )
  );

  sdkSessions.setPrepared(
    sessionId,
    buildCombinedTranscript(usable),
    params.repo.path,
    params.systemPrompt,
    undefined,
    mergeChips(...usable.map((i) => i.selectedChips))
  );
  for (const item of usable) {
    pile.linkSession(item.id, sessionId);
  }

  // Carry every item's screenshot into the draft so all are attached at launch
  const withScreenshots = usable.filter((i) => i.hasScreenshot);
  if (withScreenshots.length > 0) {
    void Promise.all(withScreenshots.map((i) => pile.getScreenshotImage(i.id))).then((loaded) => {
      const screenshots = loaded.filter((s): s is NonNullable<typeof s> => s !== null);
      if (screenshots.length > 0) {
        sdkSessions.updatePendingTranscription(sessionId, { screenshots });
      }
    });
  }

  if (select) {
    selectPreparedSession(sessionId);
  }

  return sessionId;
}

function selectPreparedSession(sessionId: string) {
  sdkSessions.selectSession(sessionId);
  activeSdkSessionId.set(sessionId);
  activeSessionId.set(null);
  navigation.setView('sessions');
}
