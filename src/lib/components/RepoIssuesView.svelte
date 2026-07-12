<script lang="ts">
  import { get } from 'svelte/store';
  import RepoIcon from '$lib/components/RepoIcon.svelte';
  import { navigation } from '$lib/stores/navigation';
  import { repos } from '$lib/stores/repos';
  import { sdkSessions, activeSdkSessionId } from '$lib/stores/sdkSessions';
  import {
    repoIssues,
    fetchIssueDetail,
    EMPTY_REPO_ISSUES,
    type GitHubIssue,
    type GitHubIssueDetail,
    type IssueStateFilter,
  } from '$lib/stores/repoIssues';
  import { formatRelativeTime } from '$lib/stores/usageStats';
  import {
    createSessionQueue,
    launchSession,
    snapshotLaunchConfigForRepo,
  } from '$lib/utils/sessionLaunch';
  import {
    ISSUE_ACTIONS,
    composeIssuePrompt,
    type IssueLaunchAction,
  } from '$lib/utils/issueActions';

  interface Props {
    repoId?: string | null;
  }

  let { repoId = null }: Props = $props();

  const repo = $derived(repoId ? ($repos.list.find((r) => r.id === repoId) ?? null) : null);
  const entry = $derived((repoId && $repoIssues.get(repoId)) || EMPTY_REPO_ISSUES);

  let selectedNumbers = $state<Set<number>>(new Set());
  let searchQuery = $state('');
  let filterLabels = $state<Set<string>>(new Set());
  let pendingAction = $state<IssueLaunchAction | null>(null);
  let useWorktree = $state(true);

  const launchQueue = createSessionQueue();
  const queueSizeStore = launchQueue.size;
  const queueProcessingStore = launchQueue.processing;

  // Fetch on entry (staleness-gated), and when the viewed repo changes.
  $effect(() => {
    const r = repo;
    if (r?.id) void repoIssues.fetchIfStale(r);
  });

  // Sessions linked to each issue (by issue URL — unique across repos).
  const issueSessionMap = $derived.by(() => {
    const map = new Map<string, { count: number; hasActive: boolean }>();
    for (const s of $sdkSessions) {
      if (!s.githubIssue) continue;
      const e = map.get(s.githubIssue.url) || { count: 0, hasActive: false };
      e.count++;
      if (s.status === 'querying' || s.status === 'initializing') e.hasActive = true;
      map.set(s.githubIssue.url, e);
    }
    return map;
  });

  const allLabels = $derived(
    [...new Set(entry.issues.flatMap((i) => i.labels.map((l) => l.name)))].sort()
  );

  function matchesFilters(issue: GitHubIssue): boolean {
    if (searchQuery.length > 0) {
      const q = searchQuery.toLowerCase();
      if (
        !issue.title.toLowerCase().includes(q) &&
        !`#${issue.number}`.includes(q) &&
        !issue.author.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    if (filterLabels.size > 0 && !issue.labels.some((l) => filterLabels.has(l.name))) {
      return false;
    }
    return true;
  }

  const filteredIssues = $derived(entry.issues.filter(matchesFilters));
  const selectedIssues = $derived(filteredIssues.filter((i) => selectedNumbers.has(i.number)));
  const selectedCount = $derived(selectedNumbers.size);
  const hasActiveFilters = $derived(searchQuery.length > 0 || filterLabels.size > 0);

  function toggleIssue(number: number) {
    const next = new Set(selectedNumbers);
    if (next.has(number)) next.delete(number);
    else next.add(number);
    selectedNumbers = next;
  }

  function clearSelection() {
    selectedNumbers = new Set();
  }

  function toggleLabelFilter(name: string) {
    const next = new Set(filterLabels);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    filterLabels = next;
  }

  function setStateFilter(state: IssueStateFilter) {
    if (!repo) return;
    clearSelection();
    void repoIssues.setStateFilter(repo, state);
  }

  function refresh() {
    if (repo) void repoIssues.fetch(repo);
  }

  function selectAction(action: IssueLaunchAction) {
    pendingAction = action;
    const def = ISSUE_ACTIONS.find((a) => a.id === action);
    if (def) useWorktree = def.worktree;
  }

  /** Fetch the full issue at launch time; fall back to list data on failure. */
  async function detailOrNull(issue: GitHubIssue): Promise<GitHubIssueDetail | null> {
    if (!repo) return null;
    try {
      return await fetchIssueDetail(repo, issue.number);
    } catch (err) {
      console.warn(`[issues] Failed to fetch detail for #${issue.number}:`, err);
      return null;
    }
  }

  function issueTag(issue: GitHubIssue) {
    return { githubIssue: { number: issue.number, title: issue.title, url: issue.url } };
  }

  function confirmAction() {
    if (!pendingAction || !repo || selectedIssues.length === 0) return;
    const action = pendingAction;
    const config = snapshotLaunchConfigForRepo(repo);
    const issuesSnapshot = [...selectedIssues];
    const worktree = useWorktree;
    clearSelection();
    pendingAction = null;

    launchQueue.enqueue(
      issuesSnapshot.map((issue) => async () => {
        const detail = await detailOrNull(issue);
        await launchSession({
          prompt: composeIssuePrompt(action, issue, detail),
          repo: config.repo,
          model: config.model,
          effortLevel: config.effortLevel,
          provider: config.provider,
          useWorktree: worktree,
          branchNameHint: `issue-${issue.number} ${issue.title}`,
          tag: issueTag(issue),
        });
      }),
      { stagger: true }
    );
  }

  /**
   * Draft sessions from the selected issues without starting them: each issue
   * becomes a New Session draft with the prompt pre-written, for review before
   * launch (mirrors NotionKanban's draftAction).
   */
  async function confirmDraft() {
    if (!pendingAction || !repo || selectedIssues.length === 0) return;
    const action = pendingAction;
    const config = snapshotLaunchConfigForRepo(repo);
    const issuesSnapshot = [...selectedIssues];
    const worktree = useWorktree;
    clearSelection();
    pendingAction = null;

    let firstId: string | null = null;
    for (const issue of issuesSnapshot) {
      const detail = await detailOrNull(issue);
      const sessionId = sdkSessions.createSetupSession(
        config.model,
        config.effortLevel,
        config.provider,
        config.repo.path
      );
      sdkSessions.updateSetupConfig(sessionId, {
        setupWorktreeMode: worktree ? 'new' : 'main',
      });
      sdkSessions.set(
        get(sdkSessions).map((s) => (s.id === sessionId ? { ...s, ...issueTag(issue) } : s))
      );
      sdkSessions.updateDraft(sessionId, composeIssuePrompt(action, issue, detail));
      if (!firstId) firstId = sessionId;
    }

    if (firstId) {
      sdkSessions.selectSession(firstId);
      activeSdkSessionId.set(firstId);
      navigation.setView('sessions');
    }
  }

  function cancelAction() {
    pendingAction = null;
  }

  async function openUrl(url: string) {
    try {
      const { openUrl: open } = await import('@tauri-apps/plugin-opener');
      await open(url);
    } catch (err) {
      console.error('[issues] Failed to open URL:', err);
    }
  }

  /** GitHub label colors arrive as bare hex ("d73a4a"). */
  function labelStyle(color: string): string {
    const hex = /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : 'var(--color-accent)';
    return `color: ${hex}; border-color: ${hex}66; background: ${hex}1a;`;
  }
</script>

<div class="flex flex-col h-full overflow-hidden">
  {#if !repo}
    <div class="flex-1 flex items-center justify-center text-sm text-text-muted">
      Repository not found
    </div>
  {:else}
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <button
          class="h-7 w-7 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors shrink-0"
          onclick={() => navigation.showRepository(repo.id ?? null)}
          title="Back to repository"
          aria-label="Back to repository"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <RepoIcon {repo} size="xs" />
        <h2 class="text-sm font-semibold text-text-primary truncate">{repo.name} — Issues</h2>
        {#if !entry.loading}
          <span class="text-[11px] text-text-muted shrink-0">
            {hasActiveFilters ? `${filteredIssues.length}/` : ''}{entry.issues.length}
          </span>
        {/if}
        {#if repo.github_url}
          {@const githubUrl = repo.github_url}
          <button
            class="text-[11px] text-text-muted hover:text-text-primary transition-colors truncate"
            onclick={() => openUrl(`${githubUrl}/issues`)}
            title="Open issues on GitHub"
          >
            {githubUrl.replace(/^https:\/\/github\.com\//, '')}
          </button>
        {/if}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <input
          type="text"
          placeholder="Search..."
          class="h-7 px-2.5 rounded text-[11px] border border-border bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-40"
          bind:value={searchQuery}
        />
        <div class="flex rounded border border-border overflow-hidden">
          {#each ['open', 'closed', 'all'] as const as state}
            <button
              class="h-7 px-2.5 text-[11px] font-medium transition-colors capitalize {entry.stateFilter === state
                ? 'bg-accent/15 text-accent'
                : 'bg-surface-elevated text-text-secondary hover:bg-border'}"
              onclick={() => setStateFilter(state)}
            >
              {state}
            </button>
          {/each}
        </div>
        <button
          class="h-7 px-2.5 rounded text-[11px] font-medium border border-border bg-surface-elevated text-text-secondary hover:bg-border transition-colors"
          onclick={refresh}
          disabled={entry.loading}
        >
          {entry.loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
    </div>

    <!-- Label filters -->
    {#if allLabels.length > 0}
      <div class="flex items-center gap-1.5 px-4 py-2 border-b border-border flex-wrap shrink-0">
        <span class="text-[10px] text-text-muted shrink-0">Labels</span>
        {#each allLabels as label}
          <button
            class="h-5 px-1.5 rounded text-[10px] border transition-colors {filterLabels.has(label)
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-border bg-surface text-text-secondary hover:border-text-muted/40'}"
            onclick={() => toggleLabelFilter(label)}
          >
            {label}
          </button>
        {/each}
        {#if filterLabels.size > 0}
          <button
            class="text-[10px] text-text-muted hover:text-text-primary transition-colors ml-1"
            onclick={() => (filterLabels = new Set())}
          >
            Clear
          </button>
        {/if}
      </div>
    {/if}

    <!-- Error -->
    {#if entry.error}
      <div class="px-4 py-3 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs shrink-0">
        {entry.error}
      </div>
    {/if}

    <!-- Issue list -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-3 space-y-1.5 max-w-3xl">
        {#each filteredIssues as issue (issue.number)}
          {@const isSelected = selectedNumbers.has(issue.number)}
          {@const linked = issueSessionMap.get(issue.url)}
          <div
            class="w-full flex items-start gap-2.5 p-2.5 rounded-lg border transition-all {isSelected
              ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
              : 'border-border bg-surface hover:border-text-muted/30 hover:bg-surface-elevated'}"
          >
            <button
              class="mt-0.5 w-3.5 h-3.5 rounded border {isSelected
                ? 'border-accent bg-accent'
                : 'border-text-muted/40'} flex items-center justify-center shrink-0"
              onclick={() => toggleIssue(issue.number)}
              aria-label={isSelected ? 'Deselect issue' : 'Select issue'}
            >
              {#if isSelected}
                <svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              {/if}
            </button>
            <button class="flex-1 min-w-0 text-left" onclick={() => toggleIssue(issue.number)}>
              <div class="flex items-center gap-2">
                <span class="text-[11px] text-text-muted shrink-0">#{issue.number}</span>
                <p class="text-[12px] font-medium text-text-primary leading-snug truncate">
                  {issue.title}
                </p>
                {#if issue.state === 'closed'}
                  <span class="text-[9px] font-medium rounded px-1 py-0.5 bg-violet-500/20 text-violet-400 shrink-0">
                    Closed{issue.state_reason === 'not_planned' ? ' (not planned)' : ''}
                  </span>
                {/if}
                {#if issue.linked_pr_numbers.length > 0}
                  <span
                    class="text-[9px] font-medium rounded px-1 py-0.5 bg-emerald-500/20 text-emerald-400 shrink-0"
                    title="Linked PR{issue.linked_pr_numbers.length > 1 ? 's' : ''}: {issue.linked_pr_numbers.map((n) => `#${n}`).join(', ')}"
                  >
                    PR
                  </span>
                {/if}
                {#if linked}
                  <span class="flex items-center gap-1 shrink-0" title="{linked.count} session{linked.count > 1 ? 's' : ''}">
                    {#if linked.hasActive}
                      <span class="relative flex w-1.5 h-1.5">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        <span class="absolute inset-0 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping opacity-75"></span>
                      </span>
                    {/if}
                    <span class="text-[9px] text-text-muted">{linked.count}</span>
                  </span>
                {/if}
              </div>
              <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                {#each issue.labels as label}
                  <span class="text-[9px] font-medium rounded px-1 py-0.5 border" style={labelStyle(label.color)}>
                    {label.name}
                  </span>
                {/each}
                {#if issue.milestone}
                  <span class="text-[9px] rounded px-1 py-0.5 bg-surface-elevated text-text-muted">
                    {issue.milestone}
                  </span>
                {/if}
                <span class="text-[9px] text-text-muted">
                  {issue.author} · updated {formatRelativeTime(Date.parse(issue.updated_at))}
                </span>
                {#if issue.assignees.length > 0}
                  <span class="text-[9px] text-text-muted">→ {issue.assignees.join(', ')}</span>
                {/if}
              </div>
            </button>
            <button
              class="mt-0.5 h-5 w-5 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-border transition-colors shrink-0"
              onclick={() => openUrl(issue.url)}
              title="Open on GitHub"
              aria-label="Open issue on GitHub"
            >
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          </div>
        {/each}
        {#if filteredIssues.length === 0 && !entry.loading}
          <div class="text-[11px] text-text-muted text-center py-10 opacity-60">
            {entry.issues.length === 0 ? `No ${entry.stateFilter === 'all' ? '' : entry.stateFilter + ' '}issues` : 'No issues match the filters'}
          </div>
        {/if}
      </div>
    </div>

    <!-- Queue indicator -->
    {#if $queueProcessingStore}
      <div class="flex items-center gap-2 px-4 py-1.5 border-t border-border bg-surface-elevated/50 shrink-0">
        <span class="relative flex w-2 h-2">
          <span class="w-2 h-2 rounded-full bg-accent"></span>
          <span class="absolute inset-0 w-2 h-2 rounded-full bg-accent animate-ping opacity-75"></span>
        </span>
        <span class="text-[11px] text-text-muted">
          Launching{$queueSizeStore > 0 ? ` (${$queueSizeStore} queued)` : ''}...
        </span>
      </div>
    {/if}

    <!-- Action bar -->
    {#if selectedCount > 0}
      <div class="flex items-center gap-2 px-4 py-3 border-t border-border bg-surface shrink-0">
        <span class="text-[11px] text-text-secondary mr-2">
          {selectedCount} issue{selectedCount > 1 ? 's' : ''}:
        </span>
        {#each ISSUE_ACTIONS as action}
          <button
            class="h-8 px-4 rounded text-xs font-medium transition-colors {pendingAction === action.id
              ? 'bg-accent text-white ring-2 ring-accent/50 ring-offset-1 ring-offset-surface'
              : 'bg-accent/40 hover:bg-accent text-white'}"
            onclick={() => selectAction(action.id)}
            title={action.description}
          >
            {action.label}
          </button>
        {/each}
        <button
          class="text-[11px] text-text-muted hover:text-text-primary transition-colors ml-1"
          onclick={clearSelection}
        >
          Clear
        </button>

        {#if pendingAction}
          <div class="ml-auto flex items-center gap-3">
            <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
              <input type="checkbox" bind:checked={useWorktree} class="accent-accent" />
              Worktree
            </label>
            <button
              class="h-8 px-4 rounded text-xs font-semibold border border-border bg-surface-elevated hover:bg-border text-text-primary transition-colors"
              onclick={confirmDraft}
              title="Create draft sessions with the prompt pre-written, without sending"
            >
              Draft
            </button>
            <button
              class="h-8 px-5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
              onclick={confirmAction}
            >
              Go
            </button>
            <button
              class="h-8 px-3 rounded text-xs font-medium bg-surface-elevated hover:bg-surface text-text-secondary transition-colors"
              onclick={cancelAction}
            >
              Cancel
            </button>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
