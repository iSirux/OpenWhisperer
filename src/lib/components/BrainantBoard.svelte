<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import {
    sdkSessions,
    activeSdkSessionId,
    settingsToStoreEffort,
    type EffortLevel,
  } from "$lib/stores/sdkSessions";
  import { navigation } from "$lib/stores/navigation";
  import { activeRepo } from "$lib/stores/repos";
  import {
    createSessionQueue,
    launchSession,
    type LaunchConfig,
  } from "$lib/utils/sessionLaunch";
  import { sendTimingFromEvent, launchScheduleFromTiming } from "$lib/utils/sendTiming";
  import { modifierCombo } from "$lib/stores/ctrlHint";
  import SendTimingIcon from "./sdk/SendTimingIcon.svelte";
  import EffortToggle from "./EffortToggle.svelte";
  import { settings } from "$lib/stores/settings";
  import {
    getEnabledModels,
    modelSupportsEffort,
    type SdkProvider,
  } from "$lib/utils/models";
  import { allowedAccountsForRepo } from "$lib/utils/accounts";
  import {
    autoAccountOptionLabel,
    paceStateLookup,
    pickAccountIdForRepo,
  } from "$lib/utils/accountAutoSelect";

  // A Kanban board in Brainant (an instance of its Kanban app), read and changed over Brainant's
  // REST API with a personal access token (Settings → Access tokens in Brainant), kept in the OS
  // keyring by the backend (`brainant_cmds.rs`). Calls act as the token's person.
  interface BrainantBoardRef {
    id: string;
    name: string;
    label: string;
  }

  interface BoardColumn {
    name: string;
    /** `todo`, `in_progress` or `done`. */
    kind: string;
  }

  interface BoardCard {
    id: number;
    title: string;
    column: string;
    /** The board's own fields by name (Size, Category, Feature Area, AI Groomed, …). */
    fields: Record<string, unknown>;
    link: string;
    updated: string | null;
  }

  interface BoardSnapshot {
    board: string;
    columns: BoardColumn[];
    cards: BoardCard[];
    link: string;
  }

  const BOARD_KEY = "ow.brainant.board";

  let connected = $state<boolean | null>(null);
  let baseUrl = $state("https://brainant.ai");
  let tokenInput = $state("");
  let connecting = $state(false);
  let boards = $state<BrainantBoardRef[]>([]);
  let boardId = $state<string>(localStorage.getItem(BOARD_KEY) ?? "");
  let boardName = $state("");
  let columns = $state<BoardColumn[]>([]);
  let cards = $state<BoardCard[]>([]);
  let selectedIds = $state<Set<number>>(new Set());
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showDone = $state(false);
  const launchQueue = createSessionQueue();
  const queueSizeStore = launchQueue.size;
  const queueProcessingStore = launchQueue.processing;
  let useWorktree = $state(true);
  let pendingAction = $state<string | null>(null);
  let launchProvider = $state<SdkProvider>(
    $settings.sdk_provider === 'OpenAI' ? 'openai' : 'claude',
  );
  let launchModel = $state(
    launchProvider === 'openai' ? $settings.openai_model : $settings.default_model,
  );
  let launchEffort = $state<EffortLevel>(settingsToStoreEffort($settings.default_effort_level));
  // '' = Auto (pace auto-select resolves the account per launch, so a batch spreads).
  let launchAccountId = $state('');

  const showProviderChoice = $derived(
    $settings.enabled_providers.claude && $settings.enabled_providers.openai,
  );
  const launchModels = $derived(
    launchProvider === 'openai'
      ? getEnabledModels($settings.enabled_openai_models, 'openai')
      : getEnabledModels($settings.enabled_models, 'claude'),
  );
  const accountProvider = $derived(launchProvider === 'openai' ? 'OpenAI' : 'Claude');
  const launchAccounts = $derived(
    allowedAccountsForRepo($settings.accounts, $activeRepo, accountProvider),
  );

  $effect(() => {
    if (launchProvider === 'openai' && !$settings.enabled_providers.openai) launchProvider = 'claude';
    if (launchProvider === 'claude' && !$settings.enabled_providers.claude) launchProvider = 'openai';
  });

  $effect(() => {
    if (launchModels.some((model) => model.id === launchModel)) return;
    launchModel = launchModels[0]?.id ??
      (launchProvider === 'openai' ? $settings.openai_model : $settings.default_model);
  });

  const paceAuto = $derived(
    $settings.account_auto_select === 'pace' && launchAccounts.length > 1,
  );

  $effect(() => {
    const ids = launchAccounts.map((account) => account.id);
    if (launchAccountId && ids.includes(launchAccountId)) return;
    const next = paceAuto
      ? ''
      : pickAccountIdForRepo($settings.accounts, $activeRepo, accountProvider);
    if (launchAccountId !== next) launchAccountId = next;
  });

  function selectLaunchProvider(provider: SdkProvider) {
    if (provider === launchProvider) return;
    launchProvider = provider;
    launchModel = provider === 'openai' ? $settings.openai_model : $settings.default_model;
    launchAccountId = '';
  }

  function selectedLaunchConfig(): LaunchConfig | null {
    if (!$activeRepo) return null;
    return {
      repo: $activeRepo,
      provider: launchProvider,
      model: launchModel,
      effortLevel: launchEffort,
      // A machine-default pick stays its reserved id so pace auto-select doesn't re-route it.
      accountId: launchAccountId || undefined,
    };
  }

  const ACTION_DEFAULTS: Record<string, { worktree: boolean }> = {
    implement: { worktree: true },
    talk: { worktree: false },
    investigate: { worktree: false },
    groom: { worktree: false },
    classify: { worktree: false },
    split: { worktree: false },
    flesh_out: { worktree: false },
    plan: { worktree: false },
  };

  function selectAction(action: string) {
    pendingAction = action;
    const defaults = ACTION_DEFAULTS[action];
    if (defaults) {
      useWorktree = defaults.worktree;
    }
  }

  function confirmAction(e?: MouseEvent) {
    if (!pendingAction) return;
    runAction(pendingAction, e);
    pendingAction = null;
  }

  function cancelAction() {
    pendingAction = null;
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

  /** A field as text (a select), or null. */
  function textField(card: BoardCard, name: string): string | null {
    const value = card.fields[name];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return null;
  }

  /** A field as a list (a multi-select), or empty. */
  function listField(card: BoardCard, name: string): string[] {
    const value = card.fields[name];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string") return [value];
    return [];
  }

  const sizeOf = (card: BoardCard) => textField(card, "Size");
  const categoriesOf = (card: BoardCard) => listField(card, "Category");
  const areasOf = (card: BoardCard) => listField(card, "Feature Area");
  const groomedOf = (card: BoardCard) => textField(card, "AI Groomed");
  const rankOf = (card: BoardCard) => textField(card, "Wishlist rank");

  /** A session's tag key for a card: the board and the card's id. */
  const cardKey = (board: string, id: number | string) => `${board}:${id}`;

  const cardSessionMap = $derived.by(() => {
    const sessions = $sdkSessions;
    const map = new Map<string, { count: number; hasActive: boolean }>();
    for (const s of sessions) {
      if (!s.boardCard) continue;
      const key = cardKey(s.boardCard.board, s.boardCard.id);
      const entry = map.get(key) || { count: 0, hasActive: false };
      entry.count++;
      if (s.status === "querying" || s.status === "initializing")
        entry.hasActive = true;
      map.set(key, entry);
    }
    return map;
  });

  const allCategories = $derived(
    [...new Set(cards.flatMap(categoriesOf))].sort(),
  );
  const allFeatureAreas = $derived(
    [...new Set(cards.flatMap(areasOf))].sort(),
  );
  const allSizes = $derived(
    [...new Set(cards.map(sizeOf).filter((s): s is string => !!s))].sort(
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

  function matchesFilters(card: BoardCard): boolean {
    const query = searchQuery.trim().toLowerCase();
    if (
      query.length > 0 &&
      !card.title.toLowerCase().includes(query) &&
      `#${card.id}` !== query
    )
      return false;
    const size = sizeOf(card);
    if (filterSizes.size > 0 && (!size || !filterSizes.has(size)))
      return false;
    if (
      filterCategories.size > 0 &&
      !categoriesOf(card).some((c) => filterCategories.has(c))
    )
      return false;
    if (
      filterFeatureAreas.size > 0 &&
      !areasOf(card).some((f) => filterFeatureAreas.has(f))
    )
      return false;
    if (filterGroomed.size > 0) {
      const groomStatus = groomedOf(card) || "Ungroomed";
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
    showDone ? columns : columns.filter((col) => col.kind !== "done"),
  );

  function columnColor(column: BoardColumn): string {
    switch (column.kind) {
      case "in_progress":
        return "bg-blue-500";
      case "done":
        return "bg-emerald-500";
      default:
        return "bg-zinc-400";
    }
  }

  function columnCards(name: string): BoardCard[] {
    return filteredCards.filter((c) => c.column === name);
  }

  /** The column a started card moves to: the board's first in-progress column. */
  const workingColumn = $derived(columns.find((c) => c.kind === "in_progress")?.name ?? null);

  async function loadConnection() {
    try {
      const info = await invoke<{ connected: boolean; baseUrl: string }>("brainant_connection");
      connected = info.connected;
      baseUrl = info.baseUrl;
      if (connected) await loadBoards();
      else loading = false;
    } catch (e) {
      error = String(e);
      loading = false;
    }
  }

  async function connect() {
    connecting = true;
    error = null;
    try {
      boards = await invoke<BrainantBoardRef[]>("brainant_connect", {
        baseUrl,
        token: tokenInput,
      });
      tokenInput = "";
      connected = true;
      pickBoard();
      await fetchCards();
    } catch (e) {
      error = String(e);
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    await invoke("brainant_disconnect");
    connected = false;
    boards = [];
    cards = [];
    columns = [];
  }

  function pickBoard() {
    if (boards.some((b) => b.id === boardId)) return;
    boardId = boards[0]?.id ?? "";
    localStorage.setItem(BOARD_KEY, boardId);
  }

  function selectBoard(id: string) {
    boardId = id;
    localStorage.setItem(BOARD_KEY, id);
    clearSelection();
    fetchCards();
  }

  async function loadBoards() {
    try {
      boards = await invoke<BrainantBoardRef[]>("brainant_boards");
      pickBoard();
      await fetchCards();
    } catch (e) {
      error = String(e);
      loading = false;
    }
  }

  async function fetchCards() {
    if (!boardId) {
      loading = false;
      return;
    }
    loading = true;
    error = null;
    try {
      const snapshot = await invoke<BoardSnapshot>("brainant_board_cards", {
        board: boardId,
        includeDone: showDone,
      });
      boardName = snapshot.board;
      columns = snapshot.columns;
      cards = snapshot.cards;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function toggleCard(id: number) {
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

  /** How a prompt names a card: the board, its id, title and link, and the tool to read it. */
  function cardRef(card: BoardCard): string {
    return `Brainant card #${card.id} "${card.title}" on the board "${boardName}" (${card.link}). Read it with Brainant's kanban__card_get tool (instance "${boardName}", card ${card.id}).`;
  }

  function getPromptForAction(
    action: string,
    card: BoardCard,
  ): { prompt: string } {
    const ref = cardRef(card);
    switch (action) {
      case "implement":
        return { prompt: `${ref}\nimplement it` };
      case "talk":
        return {
          prompt: `${ref}\nlets talk about this card - scan the codebase to get an understanding, then discuss`,
        };
      case "investigate":
        return { prompt: `${ref}\ninvestigate` };
      case "groom":
        return { prompt: `${ref}\ngroom it` };
      case "classify":
        return {
          prompt: `${ref}\nclassify this card - read the card content, then set every missing field with kanban__card_update: Size (XS/S/M/L/XL), Category and Feature Area.`,
        };
      case "split":
        return {
          prompt: `${ref}\nscan the codebase to get an understanding, then split this card into multiple smaller, logical cards. prefer individually deployable. update the original card to cover one part of the split, and create new cards for the rest (kanban__card_update, kanban__card_create). classify all cards (set Size, Category, Feature Area).`,
        };
      case "flesh_out":
        return {
          prompt: `${ref}\nflesh out this card - read the card content, scan the codebase for relevant context, then rewrite the card's description into a proper spec with: overview, acceptance criteria, technical notes, and synergies with other features (kanban__card_update). Keep any existing valuable content.`,
        };
      case "plan":
        return {
          prompt: `${ref}\ncreate an implementation plan - read the card, scan the codebase, research the web if applicable. produce a plan covering: approach, files to touch, risks, rough sequence. Post the plan as a comment on the card with kanban__card_comment.`,
        };
      default:
        return { prompt: "" };
    }
  }

  function runAction(action: string, e?: MouseEvent) {
    if (selectedCards.length === 0) return;
    const config = selectedLaunchConfig();
    if (!config) return;

    const cardsSnapshot = [...selectedCards];
    const worktree = useWorktree;
    const board = boardId;
    // Send-timing modifiers: plain = launch now, Ctrl+Shift = when the repo/worktree is
    // idle, Ctrl+Shift+Alt = next 5h reset. Deferred launches park as `queued`.
    const schedule = e ? launchScheduleFromTiming(sendTimingFromEvent(e)) : undefined;
    clearSelection();

    launchQueue.enqueue(
      cardsSnapshot.map((card) => () => {
        const { prompt } = getPromptForAction(action, card);
        // Implementing moves the card to the board's in-progress column first, as this person.
        const moved =
          action === "implement" && workingColumn && card.column !== workingColumn
            ? invoke("brainant_move_card", { board, card: card.id, column: workingColumn }).catch(
                (e) => console.warn("Could not move the card on Brainant", e),
              )
            : Promise.resolve();
        return moved.then(() => launchSession({
          prompt,
          repo: config.repo,
          model: config.model,
          effortLevel: config.effortLevel,
          provider: config.provider,
          accountId: config.accountId,
          useWorktree: worktree,
          branchNameHint: card.title,
          tag: { boardCard: { board, id: String(card.id), title: card.title, link: card.link } },
          schedule,
        })).then(() => {});
      }),
      { stagger: true },
    );
  }

  /**
   * Draft sessions from the selected cards without starting them. Each card becomes a New Session
   * (setup) draft with the action's prompt pre-written, tagged with the card, opening in the New
   * Session view with the full controls (model/effort/repo/worktree/schedule) so it can be
   * reviewed, tweaked, and launched — or scheduled for later — when ready.
   */
  function draftAction(action: string) {
    if (selectedCards.length === 0) return;
    const config = selectedLaunchConfig();
    if (!config) return;

    const cardsSnapshot = [...selectedCards];
    const worktree = useWorktree;
    const board = boardId;
    clearSelection();

    let firstId: string | null = null;
    for (const card of cardsSnapshot) {
      const { prompt } = getPromptForAction(action, card);
      const sessionId = sdkSessions.createSetupSession(
        config.model,
        config.effortLevel,
        config.provider,
        config.repo.path,
      );
      sdkSessions.updateSetupConfig(sessionId, {
        setupWorktreeMode: worktree ? 'new' : 'main',
        accountId: config.accountId,
      });
      sdkSessions.set(
        get(sdkSessions).map((s) =>
          s.id === sessionId
            ? { ...s, boardCard: { board, id: String(card.id), title: card.title, link: card.link } }
            : s,
        ),
      );
      sdkSessions.updateDraft(sessionId, prompt);
      if (!firstId) firstId = sessionId;
    }

    if (firstId) {
      sdkSessions.selectSession(firstId);
      activeSdkSessionId.set(firstId);
      navigation.setView("sessions");
    }
  }

  function confirmDraft() {
    if (!pendingAction) return;
    draftAction(pendingAction);
    pendingAction = null;
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

  function boardAction(prompt: string) {
    const config = selectedLaunchConfig();
    if (!config) return;
    launchQueue.enqueue([
      () =>
        launchSession({
          prompt,
          repo: config.repo,
          model: config.model,
          effortLevel: config.effortLevel,
          provider: config.provider,
          accountId: config.accountId,
        }).then(() => {}),
    ]);
  }

  /** How board-wide prompts name the board and its tools. */
  function boardRef(): string {
    return `Use Brainant's kanban__* tools on the board "${boardName}" (instance "${boardName}"); read kanban__board first for its columns and fields.`;
  }

  function classifyAll() {
    boardAction(
      `classify all unclassified open cards - find those missing Size, Category, or Feature Area (kanban__cards_search), read each card, and set every missing field with kanban__card_update. ${boardRef()}`,
    );
  }

  function triageNew() {
    boardAction(
      `triage the cards in the board's first column created in the last two weeks. for each card: read it, then scan the codebase to find the relevant code and assess real complexity. if the card is genuinely simple (clear where to change, small blast radius, no design decisions needed), move it to Planned and classify it (set Size, Category, Feature Area). leave complex or ambiguous cards where they are. skip cards older than two weeks. do NOT rewrite card content - only set fields and the column. ${boardRef()}`,
    );
  }

  function findDupes() {
    boardAction(
      `scan all open cards for duplicates or overlapping work. read each card title and content, identify groups of related or duplicate cards, and report your findings. suggest which cards to merge, link, or archive; change nothing. ${boardRef()}`,
    );
  }

  onMount(() => {
    loadConnection();
  });
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Header -->
  <div
    class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0"
  >
    <div class="flex items-center gap-3">
      <h2 class="text-sm font-semibold text-text-primary">Brainant Board</h2>
      {#if boards.length > 1}
        <select
          class="h-7 px-2 rounded border border-border bg-surface text-[11px] text-text-primary focus:outline-none focus:border-accent"
          value={boardId}
          onchange={(e) => selectBoard((e.currentTarget as HTMLSelectElement).value)}
          title="Which Brainant board"
        >
          {#each boards as b (b.id)}
            <option value={b.id}>{b.label}</option>
          {/each}
        </select>
      {:else if boardName}
        <span class="text-[11px] text-text-secondary">{boardName}</span>
      {/if}
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
        disabled={loading || !connected}
      >
        {loading ? "Loading..." : "Refresh"}
      </button>
      {#if connected}
        <button
          class="h-7 px-2.5 rounded text-[11px] text-text-muted hover:text-text-primary transition-colors"
          onclick={disconnect}
          title="Forget the Brainant access token on this computer"
        >
          Disconnect
        </button>
      {/if}
    </div>
  </div>

  {#if connected === false}
    <!-- Not connected: a personal access token from Brainant (Settings → Access tokens). -->
    <div class="px-4 py-4 border-b border-border bg-surface-elevated/30 space-y-2 shrink-0">
      <p class="text-[11px] text-text-secondary">
        Connect a Brainant board: in Brainant, open Settings → Access tokens and make a token that may
        read and change your apps, then paste it here. It is kept in this computer's keyring.
      </p>
      <div class="flex items-center gap-2">
        <input
          type="password"
          placeholder="bra_…"
          class="h-7 px-2.5 rounded text-[11px] border border-border bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-80"
          bind:value={tokenInput}
        />
        <input
          type="text"
          class="h-7 px-2.5 rounded text-[11px] border border-border bg-surface text-text-primary focus:outline-none focus:border-accent w-48"
          bind:value={baseUrl}
          title="Brainant's address"
        />
        <button
          class="h-7 px-3 rounded text-[11px] font-semibold bg-accent text-white disabled:opacity-50"
          onclick={connect}
          disabled={connecting || !tokenInput.trim()}
        >
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  {:else if connected && !loading && boards.length === 0}
    <div class="px-4 py-3 border-b border-border text-[11px] text-text-secondary shrink-0">
      This token's person reaches no Kanban board in Brainant.
    </div>
  {/if}

  <!-- Launch configuration shared by card actions and board-wide actions. -->
  <div class="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-elevated/30 shrink-0">
    <span class="text-[10px] uppercase tracking-wide text-text-muted">Run with</span>
    {#if showProviderChoice}
      <div class="flex rounded border border-border overflow-hidden">
        <button
          class="h-7 px-2.5 text-[11px] transition-colors {launchProvider === 'claude' ? 'bg-accent text-white' : 'text-text-secondary hover:bg-surface-elevated'}"
          onclick={() => selectLaunchProvider('claude')}
        >Claude</button>
        <button
          class="h-7 px-2.5 text-[11px] border-l border-border transition-colors {launchProvider === 'openai' ? 'bg-emerald-600 text-white' : 'text-text-secondary hover:bg-surface-elevated'}"
          onclick={() => selectLaunchProvider('openai')}
        >Codex</button>
      </div>
    {:else}
      <span class="text-[11px] text-text-secondary">{launchProvider === 'openai' ? 'Codex' : 'Claude'}</span>
    {/if}
    <label class="flex items-center gap-1.5 text-[10px] text-text-muted">
      Model
      <select
        class="h-7 px-2 rounded border border-border bg-surface text-[11px] text-text-primary focus:outline-none focus:border-accent"
        bind:value={launchModel}
      >
        {#each launchModels as model (model.id)}
          <option value={model.id}>{model.label}</option>
        {/each}
      </select>
    </label>
    {#if modelSupportsEffort(launchModel)}
      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-text-muted">Effort</span>
        <EffortToggle
          effortLevel={launchEffort}
          onchange={(level) => (launchEffort = level)}
          modelId={launchModel}
          size="sm"
        />
      </div>
    {/if}
    {#if launchAccounts.length > 1}
      <label class="flex items-center gap-1.5 text-[10px] text-text-muted">
        Account
        <select
          class="h-7 px-2 rounded border border-border bg-surface text-[11px] text-text-primary focus:outline-none focus:border-accent"
          bind:value={launchAccountId}
        >
          {#if paceAuto}
            <option value="">{autoAccountOptionLabel(launchAccounts, $paceStateLookup)}</option>
          {/if}
          {#each launchAccounts as account (account.id)}
            <option value={account.id}>{account.label}</option>
          {/each}
        </select>
      </label>
    {/if}
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
        {@const colCards = columnCards(column.name)}
        <div class="flex flex-col min-w-[220px] w-[260px] shrink-0">
          <div class="flex items-center gap-2 px-2 pb-2">
            <div class="w-2 h-2 rounded-full {columnColor(column)}"></div>
            <span class="text-xs font-semibold text-text-secondary"
              >{column.name}</span
            >
            <span
              class="text-[10px] text-text-muted bg-surface-elevated rounded-full px-1.5 py-0.5"
              >{colCards.length}</span
            >
          </div>
          <div class="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {#each colCards as card (card.id)}
              {@const isSelected = selectedIds.has(card.id)}
              {@const cardSessions = cardSessionMap.get(cardKey(boardId, card.id))}
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
                        <span class="text-text-muted">#{card.id}</span>
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
                      {#if rankOf(card)}
                        <span
                          class="text-[9px] font-medium rounded px-1 py-0.5 bg-amber-500/20 text-amber-400"
                          title="Oscar's wishlist">★{rankOf(card)}</span
                        >
                      {/if}
                      {#if sizeOf(card)}
                        <span
                          class="text-[9px] font-medium rounded px-1 py-0.5 {sizeBadge(
                            sizeOf(card),
                          )}">{sizeOf(card)}</span
                        >
                      {/if}
                      {#if groomedBadge(groomedOf(card))}
                        {@const badge = groomedBadge(groomedOf(card))!}
                        <span class="text-[9px] rounded px-1 py-0.5 {badge.cls}"
                          >{badge.text}</span
                        >
                      {/if}
                    </div>
                    {#if categoriesOf(card).length > 0}
                      <div class="flex items-center gap-1 mt-1 flex-wrap">
                        {#each categoriesOf(card).slice(0, 2) as cat}
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
  {#if $queueProcessingStore}
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
        >Processing{$queueSizeStore > 0 ? ` (${$queueSizeStore} queued)` : ""}...</span
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
        { id: "investigate", label: "Investigate", color: "orange" },
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
          <button
            class="h-8 px-4 rounded text-xs font-semibold border border-border bg-surface-elevated hover:bg-border text-text-primary transition-colors"
            onclick={confirmDraft}
            title="Create draft sessions with the prompt pre-written, without sending"
          >
            Draft
          </button>
          <button
            class="h-8 px-5 inline-flex items-center gap-1 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
            onclick={(e) => confirmAction(e)}
            title="Launch now. Ctrl+Shift = when the worktree is idle · Ctrl+Shift+Alt = next 5h reset"
          >
            Go
            {#if $modifierCombo === 'ctrl+shift' || $modifierCombo === 'ctrl+shift+alt'}
              <span class="inline-flex items-center text-white/90">
                <SendTimingIcon timing={$modifierCombo === 'ctrl+shift+alt' ? 'reset_5h' : 'repo_idle'} />
              </span>
            {/if}
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
