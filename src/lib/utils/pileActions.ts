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
 * Create a draft (setup) session from a pile item without starting it. The transcript becomes the
 * New Session view's prompt draft, opening with the full setup controls (model/effort/repo/worktree/
 * schedule). Any pre-toggled prompt chips are folded into the draft prompt so nothing is lost, and
 * the recording screenshot is attached as a draft image. Returns the session ID, or null if no repo
 * could be resolved.
 */
export async function preparePileItem(item: PileItem, select: boolean = true): Promise<string | null> {
  const params = resolveLaunchParams(item);
  if (!params || !item.transcript.trim()) return null;

  // Load the recording screenshot up-front so it's part of the draft before the setup view mounts.
  const screenshot = item.hasScreenshot ? await pile.getScreenshotImage(item.id) : null;

  const sessionId = sdkSessions.createSetupSession(
    params.model,
    params.effortLevel,
    params.provider,
    params.repo.path
  );

  sdkSessions.set(
    get(sdkSessions).map((s) =>
      s.id === sessionId
        ? { ...s, pileItem: { id: item.id, title: pileItemTitle(item) } }
        : s
    )
  );

  const draftPrompt = appendChips(item.transcript.trim(), item.selectedChips ?? []);
  sdkSessions.updateDraft(sessionId, draftPrompt, screenshot ? [screenshot] : undefined);
  pile.linkSession(item.id, sessionId);

  if (select) {
    selectPreparedSession(sessionId);
  }

  return sessionId;
}

/**
 * Create one draft (setup) session covering several pile items.
 * Returns the session ID, or null if no repo could be resolved.
 */
export async function preparePileItemsTogether(items: PileItem[], select: boolean = true): Promise<string | null> {
  const usable = items.filter((i) => i.transcript.trim());
  if (usable.length === 0) return null;
  if (usable.length === 1) return preparePileItem(usable[0], select);

  const params = resolveLaunchParams(usable[0]);
  if (!params) return null;

  // Load every item's screenshot up-front so they're attached to the draft before it mounts.
  const withScreenshots = usable.filter((i) => i.hasScreenshot);
  const loaded = await Promise.all(withScreenshots.map((i) => pile.getScreenshotImage(i.id)));
  const screenshots = loaded.filter((s): s is NonNullable<typeof s> => s !== null);

  const title = combinedPileTitle(usable);
  const sessionId = sdkSessions.createSetupSession(
    params.model,
    params.effortLevel,
    params.provider,
    params.repo.path
  );

  sdkSessions.set(
    get(sdkSessions).map((s) =>
      s.id === sessionId ? { ...s, pileItem: { id: usable[0].id, title } } : s
    )
  );

  const draftPrompt = appendChips(
    buildCombinedTranscript(usable),
    mergeChips(...usable.map((i) => i.selectedChips))
  );
  sdkSessions.updateDraft(sessionId, draftPrompt, screenshots.length > 0 ? screenshots : undefined);
  for (const item of usable) {
    pile.linkSession(item.id, sessionId);
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
