<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import {
    sdkSessions,
    settingsToStoreEffort,
    type EffortLevel,
  } from "$lib/stores/sdkSessions";
  import { settings } from "$lib/stores/settings";
  import { activeRepo, type RepoConfig } from "$lib/stores/repos";

  interface NotionCard {
    id: string;
    title: string;
    status: string;
    priority: string | null;
    size: string | null;
    category: string[];
    feature_area: string[];
    groomed: string | null;
    url: string;
  }

  interface WorktreeCreationResult {
    worktree_path: string;
    branch: string;
  }

  const KANBAN_COLUMNS: { label: string; status: string; color: string }[] = [
    { label: "New", status: "New", color: "bg-zinc-500" },
    { label: "Backlog", status: "Backlog", color: "bg-zinc-400" },
    { label: "Planned", status: "Planned", color: "bg-yellow-500" },
    { label: "In Progress", status: "In progress", color: "bg-blue-500" },
    { label: "Completed", status: "Completed", color: "bg-emerald-500" },
    { label: "On Hold", status: "On Hold", color: "bg-orange-500" },
    { label: "Cancelled", status: "Cancelled", color: "bg-red-500" },
  ];

  const ACTIVE_STATUSES = ["New", "Backlog", "Planned", "In progress"];
  const DONE_STATUSES = ["Completed", "On Hold", "Cancelled"];

  let cards = $state<NotionCard[]>([]);
  let selectedIds = $state<Set<string>>(new Set());
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showDone = $state(false);
  let queueSize = $state(0);
  let queueProcessing = $state(false);
  let useWorktree = $state(true);
  let playwrightQa = $state(false);
  let pendingAction = $state<string | null>(null);

  const ACTION_DEFAULTS: Record<string, { worktree: boolean; playwrightQa: boolean }> = {
    implement: { worktree: true, playwrightQa: false },
    talk: { worktree: false, playwrightQa: false },
    groom: { worktree: false, playwrightQa: false },
    classify: { worktree: false, playwrightQa: false },
    split: { worktree: false, playwrightQa: false },
    flesh_out: { worktree: false, playwrightQa: false },
    plan: { worktree: false, playwrightQa: false },
  };

  function selectAction(action: string) {
    pendingAction = action;
    const defaults = ACTION_DEFAULTS[action];
    if (defaults) {
      useWorktree = defaults.worktree;
      playwrightQa = defaults.playwrightQa;
    }
  }

  function confirmAction() {
    if (!pendingAction) return;
    runAction(pendingAction);
    pendingAction = null;
  }

  function cancelAction() {
    pendingAction = null;
  }

  interface QueueConfig {
    repo: RepoConfig;
    model: string;
    effortLevel: EffortLevel;
    provider: "claude" | "openai";
  }

  type QueueItem =
    | {
        type: "card";
        card: NotionCard;
        prompt: string;
        useWorktree: boolean;
        playwrightQa: boolean;
        config: QueueConfig;
      }
    | {
        type: "board";
        prompt: string;
        config: QueueConfig;
      }
    | { type: "delay" };

  const queue: QueueItem[] = [];

  async function processQueue() {
    if (queueProcessing) return;
    queueProcessing = true;

    while (queue.length > 0) {
      const item = queue.shift()!;
      queueSize = queue.length;

      try {
        if (item.type === "card") {
          await createWorktreeSession(
            item.card,
            item.prompt,
            item.useWorktree,
            item.playwrightQa,
            item.config,
          );
        } else if (item.type === "board") {
          await launchBoardSession(item.prompt, item.config);
        } else if (item.type === "delay") {
          await randomDelay();
        }
      } catch (err) {
        console.error("[notion] Queue item failed:", err);
      }
    }

    queueSize = 0;
    queueProcessing = false;
  }

  function enqueue(...items: QueueItem[]) {
    queue.push(...items);
    queueSize = queue.length;
    processQueue();
  }
  let showFilters = $state(false);

  let searchQuery = $state("");
  let filterSizes = $state<Set<string>>(new Set());
  let filterCategories = $state<Set<string>>(new Set());
  let filterGroomed = $state<Set<string>>(new Set());
  let filterFeatureAreas = $state<Set<string>>(new Set());

  const GROOMED_OPTIONS = [
    "Groomed",
    "Needs Input",
    "In Progress",
    "Skipped",
    "Ungroomed",
  ];

  const cardSessionMap = $derived.by(() => {
    const sessions = $sdkSessions;
    const map = new Map<string, { count: number; hasActive: boolean }>();
    for (const s of sessions) {
      if (!s.notionCard) continue;
      const entry = map.get(s.notionCard.id) || { count: 0, hasActive: false };
      entry.count++;
      if (s.status === "querying" || s.status === "initializing")
        entry.hasActive = true;
      map.set(s.notionCard.id, entry);
    }
    return map;
  });

  const allCategories = $derived(
    [...new Set(cards.flatMap((c) => c.category))].sort(),
  );
  const allFeatureAreas = $derived(
    [...new Set(cards.flatMap((c) => c.feature_area))].sort(),
  );
  const allSizes = $derived(
    [...new Set(cards.map((c) => c.size).filter((s): s is string => !!s))].sort(
      (a, b) => {
        const order = ["XS", "S", "M", "L", "XL"];
        return order.indexOf(a) - order.indexOf(b);
      },
    ),
  );

  const hasActiveFilters = $derived(
    searchQuery.length > 0 ||
      filterSizes.size > 0 ||
      filterCategories.size > 0 ||
      filterGroomed.size > 0 ||
      filterFeatureAreas.size > 0,
  );

  function matchesFilters(card: NotionCard): boolean {
    if (
      searchQuery.length > 0 &&
      !card.title.toLowerCase().includes(searchQuery.toLowerCase())
    )
      return false;
    if (filterSizes.size > 0 && (!card.size || !filterSizes.has(card.size)))
      return false;
    if (
      filterCategories.size > 0 &&
      !card.category.some((c) => filterCategories.has(c))
    )
      return false;
    if (
      filterFeatureAreas.size > 0 &&
      !card.feature_area.some((f) => filterFeatureAreas.has(f))
    )
      return false;
    if (filterGroomed.size > 0) {
      const groomStatus = card.groomed || "Ungroomed";
      if (!filterGroomed.has(groomStatus)) return false;
    }
    return true;
  }

  function toggleFilter(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function clearFilters() {
    searchQuery = "";
    filterSizes = new Set();
    filterCategories = new Set();
    filterGroomed = new Set();
    filterFeatureAreas = new Set();
  }

  const filteredCards = $derived(cards.filter(matchesFilters));

  const selectedCards = $derived(
    filteredCards.filter((c) => selectedIds.has(c.id)),
  );
  const selectedCount = $derived(selectedIds.size);
  const visibleColumns = $derived(
    showDone
      ? KANBAN_COLUMNS
      : KANBAN_COLUMNS.filter((col) => ACTIVE_STATUSES.includes(col.status)),
  );

  function columnCards(status: string): NotionCard[] {
    return filteredCards.filter((c) => c.status === status);
  }

  async function fetchCards() {
    loading = true;
    error = null;
    try {
      const filter = showDone ? null : ACTIVE_STATUSES;
      cards = await invoke<NotionCard[]>("fetch_notion_cards", {
        statusFilter: filter,
      });
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function toggleCard(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds = next;
  }

  function clearSelection() {
    selectedIds = new Set();
  }

  async function createWorktreeSession(
    card: NotionCard,
    prompt: string,
    useWorktree: boolean,
    playwrightQa: boolean,
    config: QueueConfig,
  ) {
    const { repo, model, effortLevel, provider } = config;
    const sessionId = sdkSessions.createSetupSession(
      model,
      effortLevel,
      false,
      provider,
      repo.path,
    );

    sdkSessions.set(
      get(sdkSessions).map((s) =>
        s.id === sessionId
          ? { ...s, notionCard: { id: card.id, title: card.title } }
          : s,
      ),
    );

    let cwd = repo.path;
    let createdBranch: string | undefined;
    let worktreePostSetup:
      | { repoPath: string; copyFiles: string[]; postCreateCommands: string[] }
      | undefined;

    if (useWorktree) {
      try {
        const branchName = await invoke<string>(
          "generate_worktree_branch_name",
          {
            prompt: card.title,
            repoPath: repo.path,
          },
        );

        const result = await invoke<WorktreeCreationResult>(
          "create_git_worktree_only",
          {
            repoPath: repo.path,
            branchName,
            worktreePath: null,
            baseBranch: repo.worktree_base_branch || null,
          },
        );

        cwd = result.worktree_path;
        createdBranch = result.branch;

        const copyFiles = repo.worktree_copy_files || [];
        const postCreateCommands = repo.worktree_post_create_commands || [];
        if (copyFiles.length > 0 || postCreateCommands.length > 0) {
          worktreePostSetup = {
            repoPath: repo.path,
            copyFiles,
            postCreateCommands,
          };
        }
      } catch (err) {
        console.error(
          `[notion] Failed to create worktree for "${card.title}":`,
          err,
        );
      }
    }

    await sdkSessions.startSetupSession(sessionId, {
      prompt,
      cwd,
      model,
      effortLevel,
      planMode: false,
      provider,
      createdBranch,
      worktreePostSetup,
      playwrightQa,
    });

    return sessionId;
  }

  function randomDelay(): Promise<void> {
    const ms = 1000 + Math.random() * 4000;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPromptForAction(
    action: string,
    card: NotionCard,
  ): { prompt: string } {
    switch (action) {
      case "implement":
        return {
          prompt: `read card: ${card.title}.\nset the card status to "In progress", then implement`,
        };
      case "talk":
        return {
          prompt: `read card: ${card.title}.\nlets talk about this card - scan the codebase to get an understanding, then discuss`,
        };
      case "groom":
        return {
          prompt: `groom ${card.title}`,
        };
      case "classify":
        return {
          prompt: `read card: ${card.title}.\nclassify this card - read the card content, then set all missing properties: Size (XS/S/M/L/XL), Category, and Feature Area.`,
        };
      case "split":
        return {
          prompt: `read card: ${card.title}.\nscan the codebase to get an understanding, then split this card into multiple smaller, logical cards. prefer individually deployable. update the original card to cover one part of the split, and create new cards for the rest. classify all cards (set Size, Category, Feature Area).`,
        };
      case "flesh_out":
        return {
          prompt: `read card: ${card.title}.\nflesh out this card - read the card content, scan the codebase for relevant context, then rewrite the card body into a proper spec with: overview, acceptance criteria, technical notes, and synergies with other features. Keep any existing valuable content.`,
        };
      case "plan":
        return {
          prompt: `read card: ${card.title}.\ncreate an implementation plan - read the card, scan the codebase, research the web if applicable. produce a plan covering: approach, files to touch, risks, rough sequence. Use the notion skill to read the card and write the plan to it.`,
        };
      default:
        return { prompt: "" };
    }
  }

  function snapshotConfig(): QueueConfig | null {
    const repo = $activeRepo;
    if (!repo) return null;
    const s = $settings;
    const provider =
      s.sdk_provider === "OpenAI" ? "openai" : ("claude" as const);
    const model = provider === "openai" ? s.openai_model : s.default_model;
    const effortLevel = settingsToStoreEffort(s.default_effort_level);
    return { repo, model, effortLevel, provider };
  }

  function runAction(action: string) {
    if (selectedCards.length === 0) return;
    const config = snapshotConfig();
    if (!config) return;

    const cardsSnapshot = [...selectedCards];
    clearSelection();

    const items: QueueItem[] = [];
    for (let i = 0; i < cardsSnapshot.length; i++) {
      const { prompt } = getPromptForAction(action, cardsSnapshot[i]);
      items.push({
        type: "card",
        card: cardsSnapshot[i],
        prompt,
        useWorktree,
        playwrightQa,
        config,
      });
      if (i < cardsSnapshot.length - 1) {
        items.push({ type: "delay" });
      }
    }

    enqueue(...items);
  }

  function priorityBadge(p: string | null): string {
    switch (p) {
      case "High":
        return "bg-red-500/20 text-red-400";
      case "Medium":
        return "bg-amber-500/20 text-amber-400";
      case "Low":
        return "bg-emerald-500/20 text-emerald-400";
      default:
        return "bg-surface-elevated text-text-muted";
    }
  }

  function sizeBadge(s: string | null): string {
    switch (s) {
      case "XL":
        return "bg-red-500/20 text-red-400";
      case "L":
        return "bg-orange-500/20 text-orange-400";
      case "M":
        return "bg-yellow-500/20 text-yellow-400";
      case "S":
        return "bg-sky-500/20 text-sky-400";
      case "XS":
        return "bg-teal-500/20 text-teal-400";
      default:
        return "bg-surface-elevated text-text-muted";
    }
  }

  function categoryBadge(cat: string): string {
    switch (cat) {
      case "Bug Fix":
        return "bg-red-500/15 text-red-400";
      case "New Feature":
        return "bg-violet-500/15 text-violet-400";
      case "Enhancement":
        return "bg-blue-500/15 text-blue-400";
      case "UI/UX":
        return "bg-pink-500/15 text-pink-400";
      case "Core":
        return "bg-amber-500/15 text-amber-400";
      case "Performance Improvement":
        return "bg-emerald-500/15 text-emerald-400";
      default:
        return "bg-surface-elevated text-text-muted";
    }
  }

  function groomedBadge(
    g: string | null,
  ): { text: string; cls: string } | null {
    switch (g) {
      case "Groomed":
        return { text: "Groomed", cls: "bg-emerald-500/20 text-emerald-400" };
      case "Needs Input":
        return { text: "Needs Input", cls: "bg-amber-500/20 text-amber-400" };
      case "In Progress":
        return { text: "In Progress", cls: "bg-blue-500/20 text-blue-400" };
      case "Skipped":
        return { text: "Skipped", cls: "bg-zinc-500/20 text-zinc-400" };
      default:
        return null;
    }
  }

  async function launchBoardSession(
    prompt: string,
    config: QueueConfig,
  ) {
    const { repo, model, effortLevel, provider } = config;
    const sessionId = sdkSessions.createSetupSession(
      model,
      effortLevel,
      false,
      provider,
      repo.path,
    );

    await sdkSessions.startSetupSession(sessionId, {
      prompt,
      cwd: repo.path,
      model,
      effortLevel,
      planMode: false,
      provider,
    });
  }

  function boardAction(prompt: string) {
    const config = snapshotConfig();
    if (!config) return;
    enqueue({ type: "board", prompt, config });
  }

  function classifyAll() {
    boardAction(
      `classify all unclassified cards in active statuses (New, Backlog, Planned, In progress) - read each card, find those missing Size, Category, or Feature Area, and set all missing properties. Use the notion skill.`,
    );
  }

  function triageNew() {
    boardAction(
      `triage cards in "New" status created in the last two weeks. for each card: read it with the notion skill, then scan the codebase to find the relevant code and assess real complexity. if the card is genuinely simple (clear where to change, small blast radius, no design decisions needed), move it to Planned and classify it (set Size, Category, Feature Area). leave complex or ambiguous cards in New. skip cards older than two weeks. do NOT rewrite card content - only set properties and status. Use the notion skill.`,
    );
  }

  function findDupes() {
    boardAction(
      `scan all cards in active statuses (New, Backlog, Planned, In progress) for duplicates or overlapping work. read each card title and content, identify groups of related or duplicate cards, and report your findings. suggest which cards to merge, link, or remove. Use the notion skill.`,
    );
  }

  onMount(() => {
    fetchCards();
  });
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Header -->
  <div
    class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0"
  >
    <div class="flex items-center gap-3">
      <h2 class="text-sm font-semibold text-text-primary">Notion Board</h2>
      {#if !loading}
        <span class="text-[11px] text-text-muted"
          >{hasActiveFilters ? `${filteredCards.length}/` : ""}{cards.length} cards</span
        >
      {/if}
      <input
        type="text"
        placeholder="Search..."
        class="h-7 px-2.5 rounded text-[11px] border border-border bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-40"
        bind:value={searchQuery}
      />
    </div>
    <div class="flex items-center gap-2">
      {#if selectedCount > 0}
        <span class="text-[11px] text-accent font-medium"
          >{selectedCount} selected</span
        >
        <button
          class="text-[11px] text-text-muted hover:text-text-primary transition-colors"
          onclick={clearSelection}
        >
          Clear
        </button>
      {/if}
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border border-purple-500/40 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
        onclick={classifyAll}
        disabled={!$activeRepo}
        title="Classify all cards missing Size, Category, or Feature Area"
      >
        Classify All
      </button>
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
        onclick={triageNew}
        disabled={!$activeRepo}
        title="Triage New cards: classify, move easy bugs to Planned"
      >
        Triage New
      </button>
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border border-rose-500/40 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
        onclick={findDupes}
        disabled={!$activeRepo}
        title="Scan active cards for duplicates or overlapping work"
      >
        Find Dupes
      </button>
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border transition-colors {showFilters ||
        hasActiveFilters
          ? 'border-accent/40 bg-accent/15 text-accent'
          : 'border-border bg-surface-elevated text-text-secondary hover:bg-border'}"
        onclick={() => {
          showFilters = !showFilters;
        }}
      >
        Filters{hasActiveFilters ? "*" : ""}
      </button>
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border transition-colors {showDone
          ? 'border-accent/40 bg-accent/15 text-accent'
          : 'border-border bg-surface-elevated text-text-secondary hover:bg-border'}"
        onclick={() => {
          showDone = !showDone;
          fetchCards();
        }}
      >
        {showDone ? "Hide Done" : "Show Done"}
      </button>
      <button
        class="h-7 px-2.5 rounded text-[11px] font-medium border border-border bg-surface-elevated text-text-secondary hover:bg-border transition-colors"
        onclick={fetchCards}
        disabled={loading}
      >
        {loading ? "Loading..." : "Refresh"}
      </button>
    </div>
  </div>

  <!-- Filters -->
  {#if showFilters}
    <div
      class="px-4 py-3 border-b border-border bg-surface-elevated/50 space-y-2.5 shrink-0"
    >
      {#if hasActiveFilters}
        <div class="flex items-center">
          <button
            class="text-[10px] text-text-muted hover:text-text-primary transition-colors"
            onclick={clearFilters}
          >
            Clear all filters
          </button>
        </div>
      {/if}

      {#if allSizes.length > 0}
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-text-muted w-16 shrink-0">Size</span>
          {#each allSizes as size}
            <button
              class="h-5 px-1.5 rounded text-[10px] border transition-colors {filterSizes.has(
                size,
              )
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-surface text-text-secondary hover:border-text-muted/40'}"
              onclick={() => {
                filterSizes = toggleFilter(filterSizes, size);
              }}>{size}</button
            >
          {/each}
        </div>
      {/if}

      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-text-muted w-16 shrink-0">Groomed</span>
        {#each GROOMED_OPTIONS as g}
          <button
            class="h-5 px-1.5 rounded text-[10px] border transition-colors {filterGroomed.has(
              g,
            )
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-border bg-surface text-text-secondary hover:border-text-muted/40'}"
            onclick={() => {
              filterGroomed = toggleFilter(filterGroomed, g);
            }}>{g}</button
          >
        {/each}
      </div>

      {#if allCategories.length > 0}
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-[10px] text-text-muted w-16 shrink-0">Category</span
          >
          {#each allCategories as cat}
            <button
              class="h-5 px-1.5 rounded text-[10px] border transition-colors {filterCategories.has(
                cat,
              )
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-surface text-text-secondary hover:border-text-muted/40'}"
              onclick={() => {
                filterCategories = toggleFilter(filterCategories, cat);
              }}>{cat}</button
            >
          {/each}
        </div>
      {/if}

      {#if allFeatureAreas.length > 0}
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-[10px] text-text-muted w-16 shrink-0">Area</span>
          {#each allFeatureAreas as area}
            <button
              class="h-5 px-1.5 rounded text-[10px] border transition-colors {filterFeatureAreas.has(
                area,
              )
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border bg-surface text-text-secondary hover:border-text-muted/40'}"
              onclick={() => {
                filterFeatureAreas = toggleFilter(filterFeatureAreas, area);
              }}>{area}</button
            >
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Error -->
  {#if error}
    <div
      class="px-4 py-3 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs"
    >
      {error}
    </div>
  {/if}

  <!-- Kanban Board -->
  <div class="flex-1 overflow-x-auto overflow-y-hidden">
    <div class="flex gap-3 p-4 h-full min-w-0">
      {#each visibleColumns as column}
        {@const colCards = columnCards(column.status)}
        <div class="flex flex-col min-w-[220px] w-[260px] shrink-0">
          <div class="flex items-center gap-2 px-2 pb-2">
            <div class="w-2 h-2 rounded-full {column.color}"></div>
            <span class="text-xs font-semibold text-text-secondary"
              >{column.label}</span
            >
            <span
              class="text-[10px] text-text-muted bg-surface-elevated rounded-full px-1.5 py-0.5"
              >{colCards.length}</span
            >
          </div>
          <div class="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {#each colCards as card (card.id)}
              {@const isSelected = selectedIds.has(card.id)}
              {@const cardSessions = cardSessionMap.get(card.id)}
              <button
                class="w-full text-left p-2.5 rounded-lg border transition-all {isSelected
                  ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
                  : 'border-border bg-surface hover:border-text-muted/30 hover:bg-surface-elevated'}"
                onclick={() => toggleCard(card.id)}
              >
                <div class="flex items-start gap-2">
                  <div
                    class="mt-0.5 w-3.5 h-3.5 rounded border {isSelected
                      ? 'border-accent bg-accent'
                      : 'border-text-muted/40'} flex items-center justify-center shrink-0"
                  >
                    {#if isSelected}
                      <svg
                        class="w-2.5 h-2.5 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="3"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    {/if}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-1">
                      <p
                        class="text-[11px] font-medium text-text-primary leading-snug"
                      >
                        {card.title}
                      </p>
                      {#if cardSessions}
                        <div
                          class="flex items-center gap-1 shrink-0"
                          title="{cardSessions.count} session{cardSessions.count >
                          1
                            ? 's'
                            : ''}"
                        >
                          {#if cardSessions.hasActive}
                            <div class="relative">
                              <div
                                class="w-1.5 h-1.5 rounded-full bg-emerald-400"
                              ></div>
                              <div
                                class="absolute inset-0 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping opacity-75"
                              ></div>
                            </div>
                          {/if}
                          <span class="text-[9px] text-text-muted"
                            >{cardSessions.count}</span
                          >
                        </div>
                      {/if}
                    </div>
                    <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                      {#if card.priority}
                        <span
                          class="text-[9px] font-medium rounded px-1 py-0.5 {priorityBadge(
                            card.priority,
                          )}">{card.priority}</span
                        >
                      {/if}
                      {#if card.size}
                        <span
                          class="text-[9px] font-medium rounded px-1 py-0.5 {sizeBadge(
                            card.size,
                          )}">{card.size}</span
                        >
                      {/if}
                      {#if groomedBadge(card.groomed)}
                        {@const badge = groomedBadge(card.groomed)!}
                        <span class="text-[9px] rounded px-1 py-0.5 {badge.cls}"
                          >{badge.text}</span
                        >
                      {/if}
                    </div>
                    {#if card.category.length > 0}
                      <div class="flex items-center gap-1 mt-1 flex-wrap">
                        {#each card.category.slice(0, 2) as cat}
                          <span
                            class="text-[8px] rounded px-1 py-0.5 {categoryBadge(
                              cat,
                            )}">{cat}</span
                          >
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </button>
            {/each}
            {#if colCards.length === 0 && !loading}
              <div
                class="text-[11px] text-text-muted text-center py-6 opacity-50"
              >
                No cards
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Queue indicator -->
  {#if queueProcessing}
    <div
      class="flex items-center gap-2 px-4 py-1.5 border-t border-border bg-surface-elevated/50 shrink-0"
    >
      <div class="relative">
        <div class="w-2 h-2 rounded-full bg-accent"></div>
        <div
          class="absolute inset-0 w-2 h-2 rounded-full bg-accent animate-ping opacity-75"
        ></div>
      </div>
      <span class="text-[11px] text-text-muted"
        >Processing{queueSize > 0 ? ` (${queueSize} queued)` : ""}...</span
      >
    </div>
  {/if}

  <!-- Action Bar -->
  {#if selectedCount > 0}
    <div
      class="flex items-center gap-2 px-4 py-3 border-t border-border bg-surface shrink-0"
    >
      <span class="text-[11px] text-text-secondary mr-2">
        {selectedCount} card{selectedCount > 1 ? "s" : ""}:
      </span>
      {#each [
        { id: "implement", label: "Implement", color: "emerald" },
        { id: "groom", label: "Groom", color: "amber" },
        { id: "talk", label: "Talk About", color: "blue" },
        { id: "classify", label: "Classify", color: "purple" },
        { id: "split", label: "Split", color: "pink" },
        { id: "flesh_out", label: "Flesh Out", color: "cyan" },
        { id: "plan", label: "Plan", color: "indigo" },
      ] as btn}
        <button
          class="h-8 px-4 rounded text-xs font-medium transition-colors disabled:opacity-50 {pendingAction === btn.id
            ? `bg-${btn.color}-600 text-white ring-2 ring-${btn.color}-400 ring-offset-1 ring-offset-surface`
            : `bg-${btn.color}-600/40 hover:bg-${btn.color}-600 text-white`}"
          onclick={() => selectAction(btn.id)}
          disabled={!$activeRepo}
        >
          {btn.label}
        </button>
      {/each}

      {#if pendingAction}
        <div class="ml-auto flex items-center gap-3">
          <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
            <input type="checkbox" bind:checked={useWorktree} class="accent-accent" />
            Worktree
          </label>
          <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
            <input type="checkbox" bind:checked={playwrightQa} class="accent-purple-500" />
            Playwright
          </label>
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
      {:else if !$activeRepo}
        <span class="text-[10px] text-red-400 ml-2">Select a repo first</span>
      {/if}
    </div>
  {/if}
</div>
