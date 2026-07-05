import { writable, derived } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { dev } from "$app/environment";


export type WhisperProvider = "Local" | "OpenAI" | "Groq" | "Custom";

export type RealtimeProvider = "Vosk" | "VoiceStreamAI" | "SherpaOnnx" | "Speaches";

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

export interface VoiceStreamAIConfig {
  /** WebSocket endpoint for VoiceStreamAI server */
  endpoint: string;
  /** Audio sample rate (default: 16000) */
  sample_rate: number;
  /** Chunk length in seconds for processing */
  chunk_length_seconds: number;
  /** Chunk offset in seconds (silence duration before processing) */
  chunk_offset_seconds: number;
  /** Language code for transcription (e.g., "en", "multilanguage") */
  language: string;
  /** Docker configuration for VoiceStreamAI server */
  docker: DockerConfig;
}

export interface SherpaOnnxConfig {
  /** WebSocket endpoint for sherpa-onnx online server */
  endpoint: string;
  /** Audio sample rate (default: 16000) */
  sample_rate: number;
  /** Docker configuration for sherpa-onnx server */
  docker: DockerConfig;
}

export interface SpeachesConfig {
  /** WebSocket endpoint for Speaches realtime API */
  endpoint: string;
  /** Audio sample rate (default: 16000) */
  sample_rate: number;
  /** Transcription model */
  model: string;
  /** Optional API key for protected deployments */
  api_key: string | null;
  /** Docker configuration for Speaches server */
  docker: DockerConfig;
}

export interface VoskConfig {
  /** Whether real-time transcription is enabled */
  enabled: boolean;
  /** Which real-time transcription provider to use */
  provider: RealtimeProvider;
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
  /** VoiceStreamAI-specific configuration */
  voice_stream_ai: VoiceStreamAIConfig;
  /** sherpa-onnx-specific configuration */
  sherpa_onnx: SherpaOnnxConfig;
  /** Speaches-specific configuration */
  speaches: SpeachesConfig;
}

/** @deprecated Legacy GitConfig kept only for deserialization of old configs */
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
  /** In-app hotkey to create a new session while the app is focused */
  new_session: string;
  /** Hotkey to start recording in note-taking mode */
  note_mode: string;
  /** Hotkey to copy selected text and immediately send as a new SDK session prompt */
  send_selection: string;
  /** Hotkey to copy selected text and create a prepared session for review */
  prepare_selection: string;
  /** Hotkey to stop the current recording and save it to the pile (while recording) */
  pile_recording: string;
}

/** Per-hotkey enabled/disabled state. Allows temporarily deactivating a hotkey without clearing its binding. */
export interface HotkeyEnabledConfig {
  toggle_recording: boolean;
  transcribe_to_input: boolean;
  cycle_repo: boolean;
  cycle_model: boolean;
  new_session: boolean;
  note_mode: boolean;
  send_selection: boolean;
  prepare_selection: boolean;
  pile_recording: boolean;
}

export interface OverlayConfig {
  show_when_focused: boolean;
  position_x: number | null;
  position_y: number | null;
  show_active_sessions: boolean;
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
  /** List of voice commands that will save the recording to the pile */
  pile_commands: string[];
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

/** Default voice command presets for saving recordings to the pile */
export const PILE_COMMAND_PRESETS = [
  "pile it",
  "to the pile",
  "save it",
  "handle later",
  "park it",
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

export type RecordAndSendAction = "send" | "prepare" | "pile";

/** Cycle order for the recording stop-mode (what happens when the recording hotkey stops a recording) */
export const RECORD_STOP_MODES: RecordAndSendAction[] = ["send", "prepare", "pile"];

export function nextRecordStopMode(current: RecordAndSendAction): RecordAndSendAction {
  const idx = RECORD_STOP_MODES.indexOf(current);
  return RECORD_STOP_MODES[(idx + 1) % RECORD_STOP_MODES.length];
}

export interface AudioConfig {
  device_id: string | null;
  use_hotkey: boolean;
  /** Hold Space in an active SDK session to record inline while the app is focused */
  hold_space_to_record_inline: boolean;
  play_sound_on_completion: boolean;
  play_sound_on_repo_select: boolean;
  /** Play sound when open mic wake command is detected and recording starts */
  play_sound_on_open_mic_trigger: boolean;
  /** Play sound when a voice command (like "send it") is detected */
  play_sound_on_voice_command: boolean;
  recording_linger_ms: number;
  include_transcription_notice: boolean;
  require_transcription_approval: boolean;
  /** What "Record & Send" should do when recording stops */
  record_and_send_action: RecordAndSendAction;
  /** Capture a screenshot when a recording starts and attach it to the prompt */
  capture_screenshot_on_record: boolean;
  /** Voice command configuration for triggering prompt send */
  voice_commands: VoiceCommandConfig;
  /** Open mic configuration for passive voice listening */
  open_mic: OpenMicConfig;
}

export type LaunchTerminal = "Cmd" | "PowerShell" | "WindowsTerminal";

export interface SystemConfig {
  minimize_to_tray: boolean;
  start_minimized: boolean;
  autostart: boolean;
  launch_terminal: LaunchTerminal;
}

export interface SessionPersistenceConfig {
  enabled: boolean;
  max_sessions: number;
  restore_sessions: number;
  max_archived_sessions: number;
}

// Import and re-export repo types from dedicated repos store
import type { RepoConfig } from './repos';
export { type RepoConfig, isRepoActive, activeRepo, isAutoRepoSelected } from './repos';

// Import and re-export MCP types
import type { McpServerType, McpServerConfig, McpConfig } from '$lib/types/mcp';
export type { McpServerType, McpServerConfig, McpConfig };

export type SdkProvider = "Claude" | "OpenAI";
export type OpenAiAuthMethod = "OAuth" | "ApiKey";
export type ClaudeAuthMethod = "OAuth" | "ApiKey";

export type ClaudeTerminalMode = "Interactive" | "Prompt" | "Sdk";
export type CodexMode = "Sdk" | "AppServer";
export type TerminalMode = ClaudeTerminalMode | CodexMode;

export type Theme =
  | "Midnight"
  | "Slate"
  | "Void"
  | "Ember"
  | "Forest"
  | "Ocean"
  | "Rose"
  | "Storm"
  | "Aurora"
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
export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
/** @deprecated Use EffortLevel instead */
export type ThinkingLevel = EffortLevel;

export type LlmProvider = "Gemini" | "OpenAI" | "Groq" | "Local" | "Custom";
// Alias for backwards compatibility
export type GeminiProvider = LlmProvider;

// Model selection priority for LLM provider
// Speed: prioritizes 3.1 Flash-Lite -> 3.5 Flash -> 2.5 Flash-Lite
// Accuracy: prioritizes 3.5 Flash -> 3.1 Flash-Lite -> 2.5 Flash
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
// low/medium/high/xhigh/max: Always use that effort level
// dynamic: Let the LLM decide based on prompt complexity
export type AutoModelEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max" | "dynamic";
export type SelectableAutoModelEffort = "low" | "medium" | "high" | "xhigh" | "max" | "dynamic";
/** @deprecated Use AutoModelEffort instead */
export type AutoModelThinking = AutoModelEffort;

export function normalizeAutoModelEffort(
  effort: AutoModelEffort | null | undefined,
): SelectableAutoModelEffort {
  if (!effort || effort === "off") return "low";
  return effort;
}

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
  /** Use LLM to generate descriptive branch names for new worktrees */
  generate_branch_names: boolean;
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

/** Smart Queue configuration for deferring launches when the usage window is exhausted */
export interface QueueConfig {
  /** Whether the smart queue feature is enabled */
  enabled: boolean;
  /** Wait a random amount before launching the first queued session after a reset */
  fuzzy_delay_after_reset: boolean;
  /** Minimum seconds to wait after a reset before the first dispatch */
  fuzzy_delay_after_reset_min_secs: number;
  /** Maximum seconds to wait after a reset before the first dispatch */
  fuzzy_delay_after_reset_max_secs: number;
  /** Insert a random gap between successive queued launches */
  fuzzy_delay_between_runs: boolean;
  /** Minimum seconds to wait between successive queued launches */
  fuzzy_delay_between_runs_min_secs: number;
  /** Maximum seconds to wait between successive queued launches */
  fuzzy_delay_between_runs_max_secs: number;
}

export interface AppConfig {
  whisper: WhisperConfig;
  vosk: VoskConfig;
  git: GitConfig;
  hotkeys: HotkeyConfig;
  hotkeys_enabled: HotkeyEnabledConfig;
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
  /** Terminal mode used when sdk_provider is Claude */
  terminal_mode: ClaudeTerminalMode;
  /** OpenAI Codex mode used when sdk_provider is OpenAI */
  codex_mode: CodexMode;
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
  /** Claude-only: default auto-compaction toggle for new sessions.
   *  When false, sidecar sets DISABLE_AUTO_COMPACT=1 (PCT_OVERRIDE cannot disable — it's clamped to ~83%).
   *  When true, no override is set; Claude's built-in default (~83.5%, 33K-token buffer) applies, which IS
   *  the optimum — PCT_OVERRIDE is clamped to this value so we can't raise it higher. */
  default_autocompact_enabled: boolean;
  theme: Theme;
  system: SystemConfig;
  show_branch_in_sessions: boolean;
  session_persistence: SessionPersistenceConfig;
  session_sort_order: SessionSortOrder;
  mark_sessions_unread: boolean;
  show_latest_message_preview: boolean;
  show_session_summary: boolean;
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
  /** Smart queue configuration */
  queue: QueueConfig;
  /** Inject a system message notifying agents that other agents may be working in parallel */
  notify_parallel_agents: boolean;
  /** User-defined quick action prompts shown in SDK sessions */
  quick_actions: string[];
  /** User-defined toggleable prompt chips appended to prompts before sending */
  prompt_chips: string[];
}

const defaultConfig: AppConfig = {
  whisper: {
    provider: "Local",
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "dropbox-dash/faster-whisper-large-v3-turbo",
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
    provider: "Vosk",
    endpoint: "ws://localhost:2700",
    sample_rate: 16000,
    docker: {
      compute_type: "CPU",
      auto_restart: false,
      container_name: "open-whisperer-vosk",
    },
    show_realtime_transcript: true,
    accumulate_transcript: false,
    voice_stream_ai: {
      endpoint: "ws://localhost:8765",
      sample_rate: 16000,
      chunk_length_seconds: 3,
      chunk_offset_seconds: 0.1,
      language: "en",
      docker: {
        compute_type: "CPU",
        auto_restart: false,
        container_name: "open-whisperer-voicestreamai",
      },
    },
    sherpa_onnx: {
      endpoint: "ws://localhost:6006",
      sample_rate: 16000,
      docker: {
        compute_type: "CPU",
        auto_restart: false,
        container_name: "open-whisperer-sherpa-onnx",
      },
    },
    speaches: {
      endpoint: "ws://localhost:2701/v1/realtime",
      sample_rate: 16000,
      model: "Systran/faster-distil-whisper-small.en",
      api_key: null,
      docker: {
        compute_type: "CPU",
        auto_restart: false,
        container_name: "open-whisperer-speaches",
      },
    },
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
    new_session: "CommandOrControl+N",
    note_mode: "CommandOrControl+Shift+N",
    send_selection: "CommandOrControl+Shift+E",
    prepare_selection: "CommandOrControl+Shift+J",
    pile_recording: "CommandOrControl+Shift+P",
  },
  hotkeys_enabled: {
    toggle_recording: true,
    transcribe_to_input: true,
    cycle_repo: true,
    cycle_model: true,
    new_session: true,
    note_mode: false,
    send_selection: true,
    prepare_selection: true,
    pile_recording: true,
  },
  overlay: {
    show_when_focused: true,
    position_x: null,
    position_y: null,
    show_active_sessions: true,
  },
  audio: {
    device_id: null,
    use_hotkey: true,
    hold_space_to_record_inline: true,
    play_sound_on_completion: false,
    play_sound_on_repo_select: true,
    play_sound_on_open_mic_trigger: true,
    play_sound_on_voice_command: true,
    recording_linger_ms: 500,
    include_transcription_notice: true,
    require_transcription_approval: false,
    record_and_send_action: "send",
    capture_screenshot_on_record: false,
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
      pile_commands: ["pile it", "to the pile"],
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
  default_model: "claude-opus-4-8",
  default_effort_level: "high",
  enabled_models: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ],
  terminal_mode: "Sdk",
  codex_mode: "AppServer",
  sdk_provider: "Claude",
  openai_model: "gpt-5.4",
  enabled_openai_models: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
  ],
  openai_auth_method: "OAuth",
  claude_auth_method: "OAuth",
  skip_permissions: false,
  default_autocompact_enabled: true,
  theme: "Midnight",
  system: {
    minimize_to_tray: false,
    start_minimized: false,
    autostart: false,
    launch_terminal: "Cmd",
  },
  show_branch_in_sessions: true,
  session_persistence: {
    enabled: true,
    max_sessions: 50,
    restore_sessions: 5,
    max_archived_sessions: 500,
  },
  session_sort_order: "Chronological",
  mark_sessions_unread: true,
  show_latest_message_preview: true,
  show_session_summary: true,
  sidebar_width: 282,
  sessions_view: {
    layout: "grid",
    grid_columns: 3,
    card_size: "medium",
  },
  tool_display_mode: "list",
  llm: {
    enabled: false,
    provider: "Gemini",
    model: "gemini-3.1-flash-lite",
    endpoint: null,
    auto_model: true,
    model_priority: "speed",
    features: {
      auto_name_sessions: true,
      detect_interaction_needed: true,
      generate_quick_actions: true,
      clean_transcription: true,
      use_dual_transcription: true,
      recommend_model: true,
      auto_model_effort: "dynamic",
      auto_select_repo: true,
      generate_branch_names: true,
    },
    confirm_repo_selection: false,
    min_auto_select_confidence: "high",
  },
  mcp: {
    servers: [],
  },
  sequences: {
    max_concurrent_executions: 3,
    default_timeout: 300,
    execution_history_days: 30,
    notification_channels: [],
    max_concurrent_prompts: 3,
    default_provider_rpm: 50,
  },
  queue: {
    enabled: true,
    fuzzy_delay_after_reset: true,
    fuzzy_delay_after_reset_min_secs: 120,
    fuzzy_delay_after_reset_max_secs: 240,
    fuzzy_delay_between_runs: true,
    fuzzy_delay_between_runs_min_secs: 10,
    fuzzy_delay_between_runs_max_secs: 45,
  },
  notify_parallel_agents: true,
  quick_actions: [
    "Implement this",
    "Fix the issues",
    "Keep going",
  ],
  prompt_chips: [
    "search web",
    "scan codebase",
    "brainstorm",
  ],
};

/** Whether the config was successfully loaded from disk (vs fell back to defaults) */
export const configLoadedOk = writable<boolean>(true);

/** Whether settings have been loaded from disk at least once this session */
export const settingsLoaded = writable<boolean>(false);

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
        settingsLoaded.set(true);

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
        // Repo state (repos list, active index, auto mode) is owned by the
        // separate `repos` store, which mutates it directly via dedicated
        // backend commands (add/remove/set-active). The settings store's copy
        // of these fields can be stale (e.g. a repo deleted via the repos
        // store is still present in $settings.repos). Persisting that stale
        // copy here would clobber those changes — e.g. resurrecting a deleted
        // repo. Re-read the authoritative repo fields from the backend right
        // before saving so we never overwrite them with stale data.
        let merged = config;
        try {
          const current = await invoke<AppConfig>("get_config");
          merged = {
            ...config,
            repos: current.repos,
            active_repo_index: current.active_repo_index,
            auto_repo_mode: current.auto_repo_mode,
          };
        } catch (e) {
          console.error("[settings] Failed to re-read repo state before save:", e);
        }
        await invoke("save_config", { newConfig: merged });
        set(merged);
        // Notify other windows (e.g., overlay) that settings changed
        emit("settings-changed");
      } catch (error) {
        console.error("Failed to save config:", error);
        throw error;
      }
    },

  };
}

export const settings = createSettingsStore();

export function isNoteModeAvailable(): boolean {
  return dev;
}

export function isPlanNewSessionAvailable(): boolean {
  return dev;
}

export function getEffectiveTerminalMode(config: AppConfig): TerminalMode {
  // Session work always uses SDK-style flows.
  return 'Sdk';
}
