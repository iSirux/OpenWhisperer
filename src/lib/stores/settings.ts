import { writable, derived } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";


export type WhisperProvider = "Local" | "OpenAI" | "Groq" | "Custom";

export type DockerComputeType = "CPU" | "GPU";

export interface DockerConfig {
  /** Whether to use GPU (CUDA) or CPU */
  compute_type: DockerComputeType;
  /** Start container automatically when Docker daemon starts */
  auto_restart: boolean;
  /** Custom container name */
  container_name: string;
}

export interface WhisperConfig {
  provider: WhisperProvider;
  endpoint: string;
  model: string;
  language: string;
  api_key: string | null;
  docker: DockerConfig;
}

export interface VoskConfig {
  /** Whether Vosk real-time transcription is enabled */
  enabled: boolean;
  /** WebSocket endpoint for Vosk server */
  endpoint: string;
  /** Audio sample rate (default: 16000) */
  sample_rate: number;
  /** Docker configuration for Vosk server */
  docker: DockerConfig;
  /** Whether to show real-time transcript in overlay */
  show_realtime_transcript: boolean;
  /** Whether to accumulate transcript text across pauses (vs reset on each pause) */
  accumulate_transcript: boolean;
}

export interface GitConfig {
  create_branch: boolean;
  auto_merge: boolean;
  create_pr: boolean;
  use_worktrees: boolean;
}

export interface HotkeyConfig {
  toggle_recording: string;
  transcribe_to_input: string;
  cycle_repo: string;
  cycle_model: string;
  /** Hotkey to start recording in note-taking mode */
  note_mode: string;
}

export interface OverlayConfig {
  show_when_focused: boolean;
  position_x: number | null;
  position_y: number | null;
}

/** Voice command configuration for triggering prompt send */
export interface VoiceCommandConfig {
  /** Whether voice commands are enabled */
  enabled: boolean;
  /** List of active voice commands that will trigger send */
  active_commands: string[];
  /** List of active voice commands that will trigger transcribe-to-input */
  transcribe_commands: string[];
  /** List of active voice commands that will cancel/discard the recording */
  cancel_commands: string[];
  /** List of voice commands that will trigger note-taking mode */
  note_commands: string[];
  /** List of voice commands that will trigger running a sequence */
  sequence_commands: string[];
  /** List of voice commands that will approve a pending approval node */
  approve_commands: string[];
  /** List of voice commands that will reject a pending approval node */
  reject_commands: string[];
  /** List of voice commands that will prepare a session without starting it */
  prepare_commands: string[];
}

/** Default voice command presets for sending prompts */
export const VOICE_COMMAND_PRESETS = [
  "go go",
  "send it",
  "execute",
  "make it so",
  "do it",
  "run it",
] as const;

/** Default voice command presets for transcribe-to-input */
export const TRANSCRIBE_COMMAND_PRESETS = [
  "paste it",
  "type it",
  "transcribe",
  "copy it",
  "text it",
] as const;

/** Default voice command presets for canceling/discarding recordings */
export const CANCEL_COMMAND_PRESETS = [
  "cancel that",
  "never mind",
  "discard recording",
  "scratch that",
  "abort abort",
] as const;

/** Default voice command presets for note-taking mode */
export const NOTE_COMMAND_PRESETS = [
  "take a note",
  "new note",
  "note this",
  "make a note",
  "jot this down",
] as const;

/** Default voice command presets for running sequences */
export const SEQUENCE_COMMAND_PRESETS = [
  "run sequence",
  "start sequence",
  "execute sequence",
  "launch sequence",
] as const;

/** Default voice command presets for approving approval nodes */
export const APPROVE_COMMAND_PRESETS = [
  "approve",
  "approved",
  "looks good",
  "go ahead",
] as const;

/** Default voice command presets for rejecting approval nodes */
export const REJECT_COMMAND_PRESETS = [
  "reject",
  "rejected",
  "deny",
  "stop that",
] as const;

/** Default voice command presets for preparing sessions without starting */
export const PREPARE_COMMAND_PRESETS = [
  "go prepare",
  "prep it",
  "prepare this",
  "queue it",
  "save for later",
] as const;

/** Open mic configuration for passive voice listening */
export interface OpenMicConfig {
  /** Whether open mic mode is enabled */
  enabled: boolean;
  /** List of active wake commands that will trigger recording */
  wake_commands: string[];
  /** Minimum volume threshold (0.0-1.0) to send audio to Vosk (saves resources when silent) */
  volume_threshold: number;
}

/** Default open mic wake command presets */
export const OPEN_MIC_PRESETS = [
  "hey claude",
  "okay claude",
  "start recording",
  "listen up",
  "hey assistant",
  "wake up",
] as const;

export interface AudioConfig {
  device_id: string | null;
  use_hotkey: boolean;
  play_sound_on_completion: boolean;
  play_sound_on_repo_select: boolean;
  /** Play sound when open mic wake command is detected and recording starts */
  play_sound_on_open_mic_trigger: boolean;
  /** Play sound when a voice command (like "send it") is detected */
  play_sound_on_voice_command: boolean;
  recording_linger_ms: number;
  include_transcription_notice: boolean;
  require_transcription_approval: boolean;
  /** Voice command configuration for triggering prompt send */
  voice_commands: VoiceCommandConfig;
  /** Open mic configuration for passive voice listening */
  open_mic: OpenMicConfig;
}

export interface SystemConfig {
  minimize_to_tray: boolean;
  start_minimized: boolean;
  autostart: boolean;
}

export interface SessionPersistenceConfig {
  enabled: boolean;
  max_sessions: number;
  restore_sessions: number;
}

export interface RepoConfig {
  path: string;
  name: string;
  /** Auto-generated description of the repository for auto-selection */
  description?: string;
  /** Domain-specific keywords for matching prompts to this repository (around 20 keywords) */
  keywords?: string[];
  /** Project-specific vocabulary/lingo for transcription cleanup and repo matching (20-50 words).
   * Unlike keywords which are categorical, vocabulary captures the actual terms/jargon used in the codebase */
  vocabulary?: string[];
  /** List of MCP server IDs to use for this repository (overrides global servers) */
  mcp_servers?: string[];
  /** List of MCP server IDs to use for note-taking mode in this repository */
  note_mcp_servers?: string[];
  /** Tags for multi-repo sequence filtering (e.g., "frontend", "backend", "infra") */
  tags: string[];
}

// Import and re-export MCP types
import type { McpServerType, McpServerConfig, McpConfig } from '$lib/types/mcp';
export type { McpServerType, McpServerConfig, McpConfig };

export type SdkProvider = "Claude" | "OpenAI";
export type OpenAiAuthMethod = "OAuth" | "ApiKey";
export type ClaudeAuthMethod = "OAuth" | "ApiKey";

export type TerminalMode = "Interactive" | "Prompt" | "Sdk";

export type Theme =
  | "Midnight"
  | "Slate"
  | "Void"
  | "Ember"
  | "Pearl"
  | "Latte";

export type SessionSortOrder = "Chronological" | "StatusThenChronological";

// Sessions view layout options
export type SessionsViewLayout = "list" | "grid";
export type SessionsGridSize = "small" | "medium" | "large";

// Tool call display mode in SDK view
export type ToolDisplayMode = "list" | "grid";

export interface SessionsViewConfig {
  layout: SessionsViewLayout;
  grid_columns: number;
  card_size: SessionsGridSize;
}

// Effort level for reasoning depth control
export type EffortLevel = "off" | "low" | "medium" | "high" | "max";
/** @deprecated Use EffortLevel instead */
export type ThinkingLevel = EffortLevel;

export type LlmProvider = "Gemini" | "OpenAI" | "Groq" | "Local" | "Custom";
// Alias for backwards compatibility
export type GeminiProvider = LlmProvider;

// Model selection priority for LLM provider
// Speed: prioritizes 2.5 Flash-Lite -> 2.5 Flash -> 2.0 Flash
// Accuracy: prioritizes 2.5 Flash -> 2.5 Flash-Lite -> 2.0 Flash
export type LlmModelPriority = "speed" | "accuracy";
// Alias for backwards compatibility
export type GeminiModelPriority = LlmModelPriority;

// Minimum confidence level required for auto-selecting a repository
// high: Only auto-select when LLM is highly confident
// medium: Auto-select when LLM has medium or high confidence
// low: Auto-select for any confidence level
export type RepoAutoSelectConfidence = "high" | "medium" | "low";

// Controls how effort level is determined when using smart model selection
// off: Always disable effort
// low/medium/high/max: Always use that effort level
// dynamic: Let the LLM decide based on prompt complexity
export type AutoModelEffort = "off" | "low" | "medium" | "high" | "max" | "dynamic";
/** @deprecated Use AutoModelEffort instead */
export type AutoModelThinking = AutoModelEffort;

export interface LlmFeaturesConfig {
  auto_name_sessions: boolean;
  detect_interaction_needed: boolean;
  /** Generate contextual quick actions based on session completion */
  generate_quick_actions: boolean;
  clean_transcription: boolean;
  /** Use both Vosk and Whisper transcriptions for cleanup (requires both to be enabled) */
  use_dual_transcription: boolean;
  recommend_model: boolean;
  /** Controls effort level behavior when smart model selection is enabled */
  auto_model_effort: AutoModelEffort;
  /** @deprecated Use auto_model_effort instead - kept for config backward compat */
  auto_model_thinking?: AutoModelEffort;
  /** Auto-select repository based on prompt content */
  auto_select_repo: boolean;
}
// Alias for backwards compatibility
export type GeminiFeaturesConfig = LlmFeaturesConfig;

export interface LlmConfig {
  enabled: boolean;
  provider: LlmProvider;
  /** Model name (varies by provider) - used when auto_model is false */
  model: string;
  endpoint: string | null;
  /** When enabled for Gemini provider, automatically select model with fallbacks */
  auto_model: boolean;
  /** Model priority when auto_model is enabled (Speed or Accuracy) */
  model_priority: LlmModelPriority;
  features: LlmFeaturesConfig;
  /** When enabled, Claude will question the repo selection if it seems wrong */
  confirm_repo_selection: boolean;
  /** Minimum confidence level required for auto-selecting a repository */
  min_auto_select_confidence: RepoAutoSelectConfidence;
}
// Alias for backwards compatibility
export type GeminiConfig = LlmConfig;

/** Notification channel type for sequences (external integrations only) */
export type NotificationChannelType = "slack" | "discord" | "webhook";

/** Configuration for a notification channel */
export interface NotificationChannelConfig {
  id: string;
  name: string;
  channel_type: NotificationChannelType;
  webhook_url: string | null;
  headers: Record<string, string> | null;
  enabled: boolean;
}

/** Sequence automation configuration */
export interface SequenceConfig {
  /** Whether sequence automation is enabled */
  enabled: boolean;
  /** Maximum number of concurrent sequence executions */
  max_concurrent_executions: number;
  /** Default timeout for nodes in seconds */
  default_timeout: number;
  /** How many days to keep execution history */
  execution_history_days: number;
  /** Configured notification channels */
  notification_channels: NotificationChannelConfig[];
  /** Maximum number of concurrent prompt nodes across all sequences */
  max_concurrent_prompts: number;
  /** Default requests-per-minute limit per provider */
  default_provider_rpm: number;
}

export interface AppConfig {
  whisper: WhisperConfig;
  vosk: VoskConfig;
  git: GitConfig;
  hotkeys: HotkeyConfig;
  overlay: OverlayConfig;
  audio: AudioConfig;
  repos: RepoConfig[];
  active_repo_index: number;
  /** When true, repo is auto-selected based on prompt content */
  auto_repo_mode: boolean;
  default_model: string;
  default_effort_level: EffortLevel;
  /** @deprecated Use default_effort_level instead */
  default_thinking_level?: string;
  enabled_models: string[];
  terminal_mode: TerminalMode;
  /** SDK provider for the main coding agent (Claude or OpenAI Codex) */
  sdk_provider: SdkProvider;
  /** Default OpenAI model for Codex SDK sessions */
  openai_model: string;
  /** Which OpenAI models are shown in the selector */
  enabled_openai_models: string[];
  /** OpenAI authentication method (OAuth via Codex CLI or API key) */
  openai_auth_method: OpenAiAuthMethod;
  /** Claude authentication method (OAuth via Claude CLI or API key) */
  claude_auth_method: ClaudeAuthMethod;
  skip_permissions: boolean;
  theme: Theme;
  system: SystemConfig;
  show_branch_in_sessions: boolean;
  session_persistence: SessionPersistenceConfig;
  session_sort_order: SessionSortOrder;
  mark_sessions_unread: boolean;
  show_latest_message_preview: boolean;
  session_prompt_rows: number;
  session_response_rows: number;
  sidebar_width: number;
  sessions_view: SessionsViewConfig;
  tool_display_mode: ToolDisplayMode;
  llm: LlmConfig;
  /** @deprecated Use llm instead */
  gemini?: LlmConfig;
  /** MCP server configuration */
  mcp: McpConfig;
  /** Sequence automation configuration */
  sequences: SequenceConfig;
}

const defaultConfig: AppConfig = {
  whisper: {
    provider: "Local",
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "Systran/faster-whisper-large-v3-turbo",
    language: "en",
    api_key: null,
    docker: {
      compute_type: "CPU",
      auto_restart: false,
      container_name: "whisper",
    },
  },
  vosk: {
    enabled: false,
    endpoint: "ws://localhost:2700",
    sample_rate: 16000,
    docker: {
      compute_type: "CPU",
      auto_restart: false,
      container_name: "claude-whisperer-vosk",
    },
    show_realtime_transcript: true,
    accumulate_transcript: false,
  },
  git: {
    create_branch: false,
    auto_merge: false,
    create_pr: false,
    use_worktrees: false,
  },
  hotkeys: {
    toggle_recording: "CommandOrControl+Shift+Space",
    transcribe_to_input: "CommandOrControl+Shift+T",
    cycle_repo: "CommandOrControl+Shift+R",
    cycle_model: "CommandOrControl+Shift+M",
    note_mode: "CommandOrControl+Shift+N",
  },
  overlay: {
    show_when_focused: true,
    position_x: null,
    position_y: null,
  },
  audio: {
    device_id: null,
    use_hotkey: true,
    play_sound_on_completion: false,
    play_sound_on_repo_select: true,
    play_sound_on_open_mic_trigger: true,
    play_sound_on_voice_command: true,
    recording_linger_ms: 500,
    include_transcription_notice: true,
    require_transcription_approval: false,
    voice_commands: {
      enabled: false,
      active_commands: ["go go"],
      transcribe_commands: [],
      cancel_commands: [],
      note_commands: ["take a note", "new note"],
      sequence_commands: ["run sequence"],
      approve_commands: ["approve"],
      reject_commands: ["reject"],
      prepare_commands: ["go prepare", "prep it"],
    },
    open_mic: {
      enabled: false,
      wake_commands: ["hey claude"],
      volume_threshold: 0.01,
    },
  },
  repos: [],
  active_repo_index: 0,
  auto_repo_mode: false,
  default_model: "claude-opus-4-6",
  default_effort_level: "high",
  enabled_models: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
  terminal_mode: "Interactive",
  sdk_provider: "Claude",
  openai_model: "gpt-5.3-codex",
  enabled_openai_models: [
    "codex-mini-latest",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "gpt-5.1-codex-mini",
  ],
  openai_auth_method: "OAuth",
  claude_auth_method: "OAuth",
  skip_permissions: false,
  theme: "Midnight",
  system: {
    minimize_to_tray: false,
    start_minimized: false,
    autostart: false,
  },
  show_branch_in_sessions: true,
  session_persistence: {
    enabled: true,
    max_sessions: 50,
    restore_sessions: 5,
  },
  session_sort_order: "Chronological",
  mark_sessions_unread: true,
  show_latest_message_preview: true,
  session_prompt_rows: 2,
  session_response_rows: 2,
  sidebar_width: 256,
  sessions_view: {
    layout: "grid",
    grid_columns: 3,
    card_size: "medium",
  },
  tool_display_mode: "list",
  llm: {
    enabled: false,
    provider: "Gemini",
    model: "gemini-2.0-flash",
    endpoint: null,
    auto_model: true,
    model_priority: "speed",
    features: {
      auto_name_sessions: true,
      detect_interaction_needed: true,
      generate_quick_actions: false,
      clean_transcription: false,
      use_dual_transcription: false,
      recommend_model: false,
      auto_model_effort: "dynamic",
      auto_select_repo: false,
    },
    confirm_repo_selection: false,
    min_auto_select_confidence: "high",
  },
  mcp: {
    servers: [],
  },
  sequences: {
    enabled: false,
    max_concurrent_executions: 3,
    default_timeout: 300,
    execution_history_days: 30,
    notification_channels: [],
    max_concurrent_prompts: 3,
    default_provider_rpm: 50,
  },
};

/** Whether the config was successfully loaded from disk (vs fell back to defaults) */
export const configLoadedOk = writable<boolean>(true);

function createSettingsStore() {
  const { subscribe, set, update } = writable<AppConfig>(defaultConfig);

  return {
    subscribe,
    set,
    update,

    async load() {
      try {
        const config = await invoke<AppConfig>("get_config");
        set(config);

        // Check if config was loaded successfully from disk
        try {
          const loadStatus = await invoke<boolean>("get_config_load_status");
          configLoadedOk.set(loadStatus);
          if (!loadStatus) {
            console.warn(
              "[settings] Config was loaded from defaults due to a parse error. " +
              "Saves are blocked to prevent overwriting your config file."
            );
          }
        } catch (e) {
          console.error("[settings] Failed to check config load status:", e);
        }
      } catch (error) {
        console.error("Failed to load config:", error);
      }
    },

    async save(config: AppConfig) {
      try {
        await invoke("save_config", { newConfig: config });
        set(config);
        // Notify other windows (e.g., overlay) that settings changed
        emit("settings-changed");
      } catch (error) {
        console.error("Failed to save config:", error);
        throw error;
      }
    },

    async addRepo(path: string, name: string) {
      console.log(
        "[settings.addRepo] Invoking backend add_repo with path:",
        path,
        "name:",
        name
      );
      try {
        await invoke("add_repo", { path, name });
        console.log(
          "[settings.addRepo] Backend add_repo succeeded, reloading config..."
        );
        await this.load();
        console.log("[settings.addRepo] Config reloaded successfully");
      } catch (error) {
        console.error("[settings.addRepo] Failed to add repo:", error);
        throw error;
      }
    },

    async removeRepo(index: number) {
      console.log(
        "[settings.removeRepo] Invoking backend remove_repo with index:",
        index
      );
      try {
        await invoke("remove_repo", { index });
        console.log(
          "[settings.removeRepo] Backend remove_repo succeeded, reloading config..."
        );
        await this.load();
        console.log("[settings.removeRepo] Config reloaded successfully");
      } catch (error) {
        console.error("[settings.removeRepo] Failed to remove repo:", error);
        throw error;
      }
    },

    async setActiveRepo(index: number) {
      try {
        await invoke("set_active_repo", { index });
        await this.load();
        // Notify other windows (e.g., overlay) that settings changed
        emit("settings-changed");
      } catch (error) {
        console.error("Failed to set active repo:", error);
        throw error;
      }
    },

    async setAutoRepoMode(enabled: boolean) {
      try {
        await invoke("set_auto_repo_mode", { enabled });
        await this.load();
        // Notify other windows (e.g., overlay) that settings changed
        emit("settings-changed");
      } catch (error) {
        console.error("Failed to set auto repo mode:", error);
        throw error;
      }
    },
  };
}

export const settings = createSettingsStore();

export const activeRepo = derived(settings, ($settings) => {
  // If auto repo mode is enabled, return null (repo will be determined per-prompt)
  if ($settings.auto_repo_mode) {
    return null;
  }
  return $settings.repos[$settings.active_repo_index] || null;
});

// Check if auto repo selection is currently active
export const isAutoRepoSelected = derived(settings, ($settings) => {
  return $settings.auto_repo_mode;
});
