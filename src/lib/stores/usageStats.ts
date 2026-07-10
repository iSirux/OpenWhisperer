import { writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export interface SessionStats {
  total_sessions: number;
  total_pty_sessions: number;
  total_sdk_sessions: number;
  total_prompts: number;
  total_tool_calls: number;
  total_recordings: number;
  total_recording_duration_ms: number;
  total_transcriptions: number;
  first_session_at: number | null;
  last_session_at: number | null;
}

export interface TokenStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
}

export interface LlmTokenStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_requests: number;
  // Per-feature breakdown (requests + input/output tokens)
  session_naming_requests: number;
  session_naming_input_tokens: number;
  session_naming_output_tokens: number;
  session_outcome_requests: number;
  session_outcome_input_tokens: number;
  session_outcome_output_tokens: number;
  interaction_analysis_requests: number;
  interaction_analysis_input_tokens: number;
  interaction_analysis_output_tokens: number;
  transcription_cleanup_requests: number;
  transcription_cleanup_input_tokens: number;
  transcription_cleanup_output_tokens: number;
  model_recommendation_requests: number;
  model_recommendation_input_tokens: number;
  model_recommendation_output_tokens: number;
  repo_description_requests: number;
  repo_description_input_tokens: number;
  repo_description_output_tokens: number;
  repo_recommendation_requests: number;
  repo_recommendation_input_tokens: number;
  repo_recommendation_output_tokens: number;
}

export interface ModelUsageStats {
  opus_sessions: number;
  sonnet_sessions: number;
  haiku_sessions: number;
  codex_56_sol_sessions: number;
  codex_56_terra_sessions: number;
  codex_56_luna_sessions: number;
  codex_54_sessions: number;
  codex_53_sessions: number;
  codex_53_spark_sessions: number;
  codex_52_sessions: number;
  codex_51_mini_sessions: number;
}

export interface RepoUsageStats {
  repo_path: string;
  session_count: number;
  prompt_count: number;
}

export interface DailyStats {
  date: string;
  sessions: number;
  prompts: number;
  recordings: number;
  tool_calls: number;
}

export interface UsageStats {
  session_stats: SessionStats;
  token_stats: TokenStats;
  llm_token_stats: LlmTokenStats;
  model_usage: ModelUsageStats;
  repo_usage: RepoUsageStats[];
  daily_stats: DailyStats[];
  streak_days: number;
  longest_streak: number;
  average_session_duration_ms: number;
  average_prompts_per_session: number;
  most_used_tools: [string, number][];
}

const defaultStats: UsageStats = {
  session_stats: {
    total_sessions: 0,
    total_pty_sessions: 0,
    total_sdk_sessions: 0,
    total_prompts: 0,
    total_tool_calls: 0,
    total_recordings: 0,
    total_recording_duration_ms: 0,
    total_transcriptions: 0,
    first_session_at: null,
    last_session_at: null,
  },
  token_stats: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cost_usd: 0,
  },
  llm_token_stats: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_requests: 0,
    session_naming_requests: 0,
    session_naming_input_tokens: 0,
    session_naming_output_tokens: 0,
    session_outcome_requests: 0,
    session_outcome_input_tokens: 0,
    session_outcome_output_tokens: 0,
    interaction_analysis_requests: 0,
    interaction_analysis_input_tokens: 0,
    interaction_analysis_output_tokens: 0,
    transcription_cleanup_requests: 0,
    transcription_cleanup_input_tokens: 0,
    transcription_cleanup_output_tokens: 0,
    model_recommendation_requests: 0,
    model_recommendation_input_tokens: 0,
    model_recommendation_output_tokens: 0,
    repo_description_requests: 0,
    repo_description_input_tokens: 0,
    repo_description_output_tokens: 0,
    repo_recommendation_requests: 0,
    repo_recommendation_input_tokens: 0,
    repo_recommendation_output_tokens: 0,
  },
  model_usage: {
    opus_sessions: 0,
    sonnet_sessions: 0,
    haiku_sessions: 0,
    codex_56_sol_sessions: 0,
    codex_56_terra_sessions: 0,
    codex_56_luna_sessions: 0,
    codex_54_sessions: 0,
    codex_53_sessions: 0,
    codex_53_spark_sessions: 0,
    codex_52_sessions: 0,
    codex_51_mini_sessions: 0,
  },
  repo_usage: [],
  daily_stats: [],
  streak_days: 0,
  longest_streak: 0,
  average_session_duration_ms: 0,
  average_prompts_per_session: 0,
  most_used_tools: [],
};

function createUsageStatsStore() {
  const { subscribe, set, update } = writable<UsageStats>(defaultStats);

  return {
    subscribe,
    set,
    update,

    async load() {
      try {
        const stats = await invoke<UsageStats>('get_usage_stats');
        set(stats);
      } catch (error) {
        console.error('Failed to load usage stats:', error);
      }
    },

    async trackSession(sessionType: 'pty' | 'sdk', model: string, repoPath?: string) {
      try {
        await invoke('track_session', {
          sessionType,
          model,
          repoPath: repoPath || null,
        });
        await this.load();
      } catch (error) {
        console.error('Failed to track session:', error);
      }
    },

    async trackPrompt(repoPath?: string) {
      try {
        await invoke('track_prompt', { repoPath: repoPath || null });
        // Don't reload for every prompt - too frequent
      } catch (error) {
        console.error('Failed to track prompt:', error);
      }
    },

    async trackToolCall(toolName: string) {
      try {
        await invoke('track_tool_call', { toolName });
        // Don't reload for every tool call
      } catch (error) {
        console.error('Failed to track tool call:', error);
      }
    },

    async trackRecording(durationMs: number) {
      try {
        await invoke('track_recording', { durationMs });
        // Don't reload for every recording
      } catch (error) {
        console.error('Failed to track recording:', error);
      }
    },

    async trackTranscription() {
      try {
        await invoke('track_transcription');
        // Don't reload for every transcription
      } catch (error) {
        console.error('Failed to track transcription:', error);
      }
    },

    async trackTokenUsage(
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheCreationTokens: number,
      costUsd: number
    ) {
      try {
        await invoke('track_token_usage', {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          costUsd,
        });
        // Don't reload for every token update - too frequent
      } catch (error) {
        console.error('Failed to track token usage:', error);
      }
    },

    async trackLlmTokenUsage(
      feature: string,
      inputTokens: number,
      outputTokens: number
    ) {
      try {
        await invoke('track_llm_token_usage', {
          feature,
          inputTokens,
          outputTokens,
        });
        // Don't reload for every LLM call
      } catch (error) {
        console.error('Failed to track LLM token usage:', error);
      }
    },

    async reset() {
      try {
        await invoke('reset_usage_stats');
        set(defaultStats);
      } catch (error) {
        console.error('Failed to reset usage stats:', error);
        throw error;
      }
    },
  };
}

export const usageStats = createUsageStatsStore();

// Helper functions for formatting
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0 && days === 0) parts.push(`${seconds % 60}s`); // Only show seconds if less than a day

  return parts.length > 0 ? parts.join(' ') : '0s';
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return formatDate(timestamp);
}

export function getWeeklyStats(dailyStats: DailyStats[]): DailyStats[] {
  // Get last 7 days
  return dailyStats.slice(-7);
}

export function getTotalForPeriod(
  dailyStats: DailyStats[],
  days: number
): { sessions: number; prompts: number; recordings: number; toolCalls: number } {
  const recentStats = dailyStats.slice(-days);
  return {
    sessions: recentStats.reduce((sum, d) => sum + d.sessions, 0),
    prompts: recentStats.reduce((sum, d) => sum + d.prompts, 0),
    recordings: recentStats.reduce((sum, d) => sum + d.recordings, 0),
    toolCalls: recentStats.reduce((sum, d) => sum + d.tool_calls, 0),
  };
}
