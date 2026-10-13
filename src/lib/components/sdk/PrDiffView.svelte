<script lang="ts">
  import { sessionPrs, type SessionPrEntry } from '$lib/stores/sessionPrs';
  import { sdkSessions, type SdkSession } from '$lib/stores/sdkSessions';
  import { persistScroll } from '$lib/actions/persistScroll';
  import { untrack } from 'svelte';
  import { parseUnifiedDiff, type DiffFile } from '$lib/utils/gitDiff';

  let {
    session,
    entry,
  }: {
    session: SdkSession;
    entry: SessionPrEntry;
  } = $props();

  /** Per-file render cap — one generated/minified file shouldn't lock the webview. */
  const MAX_LINES_PER_FILE = 2000;
  /** Above this, files start collapsed so opening the tab stays instant. */
  const AUTO_EXPAND_LINE_BUDGET = 1500;

  let files = $derived<DiffFile[]>(entry.diff ? parseUnifiedDiff(entry.diff) : []);
  let totalLines = $derived(files.reduce((n, f) => n + f.lines.length, 0));
  let totals = $derived({
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  });

  // Expansion is keyed by file path so it survives a refetch of the same diff
  // (and, persisted on the session, a restart); a missing entry means "not
  // decided by the user" and falls back to the size default.
  let expanded = $state<Record<string, boolean>>(
    untrack(() => session.dockUi?.prDiffExpanded ?? {})
  );
  let autoExpand = $derived(totalLines <= AUTO_EXPAND_LINE_BUDGET);

  function isOpen(file: DiffFile): boolean {
    return expanded[file.path] ?? autoExpand;
  }

  function toggle(file: DiffFile) {
    const change = { [file.path]: !isOpen(file) };
    expanded = { ...expanded, ...change };
    sdkSessions.setDockUi(session.id, { prDiffExpanded: change });
  }

  function setAll(open: boolean) {
    const next: Record<string, boolean> = {};
    for (const f of files) next[f.path] = open;
    expanded = next;
    sdkSessions.setDockUi(session.id, { prDiffExpanded: next });
  }

  const STATUS_LABEL: Record<DiffFile['status'], string> = {
    added: 'Added',
    deleted: 'Deleted',
    renamed: 'Renamed',
    modified: 'Modified',
  };
</script>

<div class="diff">
  <div class="diff-toolbar">
    {#if files.length > 0}
      <span class="diff-summary">
        {files.length} file{files.length === 1 ? '' : 's'}
        <span class="diff-add-count">+{totals.additions}</span>
        <span class="diff-del-count">−{totals.deletions}</span>
      </span>
      <button class="diff-link" onclick={() => setAll(true)}>Expand all</button>
      <button class="diff-link" onclick={() => setAll(false)}>Collapse all</button>
    {:else if !entry.diffLoading && !entry.diffError}
      <span class="diff-muted">No changes in this pull request</span>
    {/if}
    <button
      class="diff-link refresh"
      onclick={() => sessionPrs.loadDiff(session, true)}
      disabled={entry.diffLoading}
    >
      {entry.diffLoading ? 'Loading…' : 'Refresh'}
    </button>
  </div>

  <div
    class="diff-body"
    use:persistScroll={{
      sessionId: session.id,
      key: 'pr:diff',
      saved: session.dockUi?.scroll?.['pr:diff'],
    }}
  >
    {#if entry.diffError}
      <div class="diff-error">{entry.diffError}</div>
    {/if}

    {#if entry.diffLoading && !entry.diff}
      <div class="diff-muted">Loading diff…</div>
    {/if}

    {#each files as file (file.key)}
      {@const open = isOpen(file)}
      <div class="diff-file" class:open>
        <button class="diff-file-head" onclick={() => toggle(file)} aria-expanded={open}>
          <svg class="diff-chevron" class:open viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
          <span class="diff-status status-{file.status}" title={STATUS_LABEL[file.status]}>
            {STATUS_LABEL[file.status].charAt(0)}
          </span>
          <span class="diff-path" title={file.oldPath && file.status === 'renamed'
            ? `${file.oldPath} → ${file.path}`
            : file.path}>
            {#if file.status === 'renamed' && file.oldPath}
              <span class="diff-oldpath">{file.oldPath}</span>
              <span class="diff-rename-arrow">→</span>
            {/if}
            {file.path}
          </span>
          <span class="diff-file-stat">
            {#if file.binary}
              <span class="diff-muted">binary</span>
            {:else}
              <span class="diff-add-count">+{file.additions}</span>
              <span class="diff-del-count">−{file.deletions}</span>
            {/if}
          </span>
        </button>

        {#if open}
          {#if file.binary}
            <div class="diff-note">Binary file not shown</div>
          {:else if file.lines.length === 0}
            <div class="diff-note">No textual changes (mode or metadata only)</div>
          {:else}
            <!-- data-quote-source: label used when a hunk is selected and
                 quoted into the session prompt. -->
            <div
              class="diff-lines"
              data-quote-source="PR diff · {file.path}"
              data-quote-code
            >
              {#each file.lines.slice(0, MAX_LINES_PER_FILE) as line, i (i)}
                <div class="diff-line kind-{line.kind}">
                  <span class="diff-ln">{line.oldNo ?? ''}</span>
                  <span class="diff-ln">{line.newNo ?? ''}</span>
                  <span class="diff-marker"
                    >{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span
                  >
                  <span class="diff-text">{line.text}</span>
                </div>
              {/each}
            </div>
            {#if file.lines.length > MAX_LINES_PER_FILE}
              <div class="diff-note">
                Showing the first {MAX_LINES_PER_FILE} of {file.lines.length} lines — open the PR on
                GitHub for the rest.
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    {/each}

    {#if entry.diffTruncated}
      <div class="diff-note truncated">
        This diff is too large to show in full — open the pull request on GitHub to see the rest.
      </div>
    {/if}
  </div>
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .diff-toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
    padding: 0.35rem 0.85rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }

  .diff-summary {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }

  .diff-link {
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.1rem 0.2rem;
    border-radius: 4px;
  }

  .diff-link:hover:not(:disabled) {
    color: var(--color-text-primary);
  }

  .diff-link:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .diff-link.refresh {
    margin-left: auto;
  }

  .diff-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.5rem 0.85rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .diff-file {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-surface-elevated);
  }

  .diff-file-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.5rem;
    cursor: pointer;
    text-align: left;
    min-width: 0;
  }

  .diff-file-head:hover {
    background: var(--color-border);
  }

  .diff-chevron {
    width: 0.7rem;
    height: 0.7rem;
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.15s ease;
  }

  .diff-chevron.open {
    transform: rotate(90deg);
  }

  .diff-status {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    font-size: 0.62rem;
    font-weight: 700;
  }

  .status-added { color: rgb(74, 222, 128); background: rgba(74, 222, 128, 0.14); }
  .status-deleted { color: rgb(248, 113, 113); background: rgba(248, 113, 113, 0.14); }
  .status-renamed { color: rgb(96, 165, 250); background: rgba(96, 165, 250, 0.14); }
  .status-modified { color: rgb(251, 191, 36); background: rgba(251, 191, 36, 0.14); }

  .diff-path {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--color-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .diff-oldpath,
  .diff-rename-arrow {
    color: var(--color-text-muted);
  }

  .diff-file-stat {
    display: inline-flex;
    gap: 0.3rem;
    flex-shrink: 0;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.68rem;
  }

  .diff-add-count { color: rgb(74, 222, 128); }
  .diff-del-count { color: rgb(248, 113, 113); }

  .diff-lines {
    border-top: 1px solid var(--color-border);
    background: var(--color-background);
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.7rem;
    line-height: 1.45;
  }

  .diff-line {
    display: flex;
    min-width: max-content;
    color: var(--color-text-secondary);
  }

  .diff-ln {
    flex-shrink: 0;
    width: 2.7rem;
    padding: 0 0.35rem;
    text-align: right;
    color: var(--color-text-muted);
    opacity: 0.6;
    user-select: none;
  }

  .diff-marker {
    flex-shrink: 0;
    width: 1rem;
    text-align: center;
    user-select: none;
  }

  .diff-text {
    white-space: pre;
    padding-right: 0.6rem;
    tab-size: 4;
  }

  .kind-add {
    background: rgba(74, 222, 128, 0.1);
    color: rgb(134, 239, 172);
  }

  .kind-del {
    background: rgba(248, 113, 113, 0.1);
    color: rgb(252, 165, 165);
  }

  .kind-hunk {
    background: rgba(96, 165, 250, 0.08);
    color: rgb(96, 165, 250);
  }

  .kind-meta {
    color: var(--color-text-muted);
  }

  .diff-note {
    padding: 0.35rem 0.6rem;
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }

  .diff-note.truncated {
    border: 1px solid rgba(251, 191, 36, 0.25);
    background: rgba(251, 191, 36, 0.08);
    color: rgb(251, 191, 36);
    border-radius: 6px;
  }

  .diff-muted {
    color: var(--color-text-muted);
    font-size: 0.72rem;
  }

  .diff-error {
    font-size: 0.72rem;
    color: rgb(248, 113, 113);
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
