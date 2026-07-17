import { writable, derived } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { LaunchCommand, LaunchProfile } from "$lib/types/launch";

// ---- Types ----

/** Per-repo validation command overrides (used by the Validation test/lint steps). */
export interface ValidationCommands {
  /** Shell command to run the repo's test suite. */
  test?: string;
  /** Shell command to run the repo's linter/formatter checks. */
  lint?: string;
}

export interface RepoConfig {
  /** Stable unique identifier for this repository (auto-generated UUID) */
  id?: string;
  path: string;
  name: string;
  /** Auto-generated description of the repository for auto-selection */
  description?: string;
  /** Domain-specific keywords for matching prompts to this repository (around 20 keywords) */
  keywords?: string[];
  /** Project-specific vocabulary/lingo for transcription cleanup and repo matching (20-50 words).
   * Unlike keywords which are categorical, vocabulary captures the actual terms/jargon used in the codebase */
  vocabulary?: string[];
  /** Icon key from the curated icon set (e.g., "globe", "terminal", "database") */
  icon?: string;
  /** Primary/brand color as hex string (e.g., "#6366f1") */
  color?: string;
  /** List of MCP server IDs to use for this repository (overrides global servers) */
  mcp_servers?: string[];
  /** Tags for multi-repo sequence filtering (e.g., "frontend", "backend", "infra") */
  tags: string[];
  /** Whether this repo is active (shown in selectors, eligible for auto-select). Defaults to true. */
  active?: boolean;
  /** Files to copy from main worktree when creating a new worktree (e.g., ".env", "settings.local.json") */
  worktree_copy_files?: string[];
  /** Commands to run in a new worktree after creation (e.g., "npm install") */
  worktree_post_create_commands?: string[];
  /** Base branch for new worktrees (e.g., "origin/main", "origin/dev"). If empty, auto-detects remote default. */
  worktree_base_branch?: string;
  /** Last selected worktree mode for this repo: "main", "new", or "existing" */
  worktree_mode?: 'main' | 'new' | 'existing';
  /** Launch commands available for this repository (dev servers, watchers, etc.) */
  launch_commands?: LaunchCommand[];
  /** Launch profiles - named groups of launch commands for one-click startup */
  launch_profiles?: LaunchProfile[];
  /** Auto-detected GitHub URL for this repo (e.g., "https://github.com/owner/repo") */
  github_url?: string;
  /** GitHub CLI account (username) to use for sessions in this repo. Unset = gh's active account */
  gh_user?: string;
  /** Whitelist of agent account IDs allowed for sessions in this repo. Empty/missing = all allowed. */
  account_ids?: string[];
  /** Last PR merge strategy used in this repo; the PR panel defaults to it. */
  last_merge_strategy?: 'squash' | 'merge' | 'rebase';
  /** Per-repo validation command overrides (test/lint) for the Validation pipeline. */
  validation_commands?: ValidationCommands;
  /** Extra review guidelines injected into the Validation review prompt. */
  review_guidelines?: string;
  /** Per-repo default validation step set (overrides the global default steps). */
  validation_steps?: string[];
}

/** Helper: treat undefined/missing active field as true for backward compatibility */
export function isRepoActive(repo: RepoConfig): boolean {
  return repo.active !== false;
}

/** Look up a RepoConfig by its stable unique ID. Returns null if not found. */
export function findRepoById(repos: RepoConfig[], id: string | undefined): RepoConfig | null {
  if (!id) return null;
  return repos.find((r) => r.id === id) ?? null;
}

// ---- Store State ----

export interface ReposState {
  list: RepoConfig[];
  activeIndex: number;
  autoMode: boolean;
}

const defaultState: ReposState = {
  list: [],
  activeIndex: 0,
  autoMode: false,
};

// ---- Store Implementation ----

function createReposStore() {
  const { subscribe, set, update } = writable<ReposState>(defaultState);

  return {
    subscribe,
    set,
    update,

    async load() {
      try {
        const config = await invoke<{
          repos: RepoConfig[];
          active_repo_index: number;
          auto_repo_mode: boolean;
        }>("get_config");
        set({
          list: config.repos,
          activeIndex: config.active_repo_index,
          autoMode: config.auto_repo_mode,
        });
      } catch (error) {
        console.error("[repos] Failed to load repos:", error);
      }
    },

    async addRepo(path: string, name: string) {
      try {
        await invoke("add_repo", { path, name });
        await this.load();
      } catch (error) {
        console.error("[repos] Failed to add repo:", error);
        throw error;
      }
    },

    async removeRepo(index: number) {
      try {
        await invoke("remove_repo", { index });
        await this.load();
      } catch (error) {
        console.error("[repos] Failed to remove repo:", error);
        throw error;
      }
    },

    async setActiveRepo(index: number) {
      try {
        await invoke("set_active_repo", { index });
        await this.load();
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to set active repo:", error);
        throw error;
      }
    },

    async setRepoActive(index: number, active: boolean) {
      try {
        await invoke("set_repo_active", { index, active });
        await this.load();
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to set repo active state:", error);
        throw error;
      }
    },

    async setAutoRepoMode(enabled: boolean) {
      try {
        await invoke("set_auto_repo_mode", { enabled });
        await this.load();
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to set auto repo mode:", error);
        throw error;
      }
    },

    /** Update the full repos list and persist via save_config */
    async updateList(repos: RepoConfig[]) {
      try {
        // Ensure all repos have IDs (handles frontend-created repos)
        const reposWithIds = repos.map((r) => ({
          ...r,
          id: r.id || crypto.randomUUID(),
        }));
        const fullConfig = await invoke<Record<string, unknown>>("get_config");
        fullConfig.repos = reposWithIds;
        await invoke("save_config", { newConfig: fullConfig });
        update((s) => ({ ...s, list: reposWithIds }));
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to update repos list:", error);
        throw error;
      }
    },

    /** Move a repo to a new position in the list, keeping active_repo_index pointing at the same repo */
    async moveRepo(fromIndex: number, toIndex: number) {
      try {
        const fullConfig = await invoke<Record<string, unknown>>("get_config");
        const list = fullConfig.repos as RepoConfig[];
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= list.length ||
          toIndex >= list.length
        ) {
          return;
        }
        const [moved] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, moved);
        const activeIdx = fullConfig.active_repo_index as number;
        let newActive = activeIdx;
        if (activeIdx === fromIndex) newActive = toIndex;
        else if (fromIndex < activeIdx && toIndex >= activeIdx) newActive = activeIdx - 1;
        else if (fromIndex > activeIdx && toIndex <= activeIdx) newActive = activeIdx + 1;
        fullConfig.active_repo_index = newActive;
        await invoke("save_config", { newConfig: fullConfig });
        update((s) => ({ ...s, list: [...list], activeIndex: newActive }));
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to move repo:", error);
        throw error;
      }
    },

    /** Update a single repo's metadata and persist */
    async updateRepo(index: number, updates: Partial<RepoConfig>) {
      try {
        const fullConfig = await invoke<Record<string, unknown>>("get_config");
        const repos = fullConfig.repos as RepoConfig[];
        repos[index] = { ...repos[index], ...updates };
        fullConfig.repos = repos;
        await invoke("save_config", { newConfig: fullConfig });
        update((s) => {
          const newList = [...s.list];
          newList[index] = { ...newList[index], ...updates };
          return { ...s, list: newList };
        });
        emit("settings-changed");
      } catch (error) {
        console.error("[repos] Failed to update repo:", error);
        throw error;
      }
    },
  };
}

export const repos = createReposStore();

// ---- Derived Stores ----

export const activeRepo = derived(repos, ($repos) => {
  if ($repos.autoMode) return null;
  return $repos.list[$repos.activeIndex] || null;
});

export const isAutoRepoSelected = derived(repos, ($repos) => {
  return $repos.autoMode;
});

export const activeReposList = derived(repos, ($repos) => {
  return $repos.list.filter(isRepoActive);
});
