import { get } from "svelte/store";
import { settings, VOICE_COMMAND_PRESETS, TRANSCRIBE_COMMAND_PRESETS, CANCEL_COMMAND_PRESETS, NOTE_COMMAND_PRESETS, SEQUENCE_COMMAND_PRESETS, APPROVE_COMMAND_PRESETS, REJECT_COMMAND_PRESETS } from "$lib/stores/settings";

/** Type of voice command action */
export type VoiceCommandType = 'send' | 'transcribe' | 'cancel' | 'note' | 'sequence' | 'approve' | 'reject' | null;

export interface VoiceCommandResult {
  /** The cleaned transcript with voice commands removed */
  cleanedTranscript: string;
  /** Whether a voice command was detected */
  commandDetected: boolean;
  /** The command that was detected (if any) */
  detectedCommand: string | null;
  /** Whether the command should trigger sending the prompt */
  shouldSend: boolean;
  /** Whether the command should trigger transcribe-to-input */
  shouldTranscribe: boolean;
  /** Whether the command should cancel/discard the recording */
  shouldCancel: boolean;
  /** Whether the command should trigger note-taking mode */
  shouldNote: boolean;
  /** Whether the command should trigger running a sequence */
  shouldRunSequence: boolean;
  /** Whether the command should approve a pending approval */
  shouldApprove: boolean;
  /** Whether the command should reject a pending approval */
  shouldReject: boolean;
  /** Sequence name extracted from the transcript (for sequence commands) */
  sequenceName?: string;
  /** The type of command detected */
  commandType: VoiceCommandType;
}

/**
 * Check if voice commands are enabled in settings
 */
export function isVoiceCommandsEnabled(): boolean {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.enabled;
}

/**
 * Get the list of active voice commands (for sending)
 */
export function getActiveVoiceCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.active_commands;
}

/**
 * Get the list of active transcription commands
 */
export function getActiveTranscribeCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.transcribe_commands ?? [];
}

/**
 * Get the list of active cancel commands
 */
export function getActiveCancelCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.cancel_commands ?? [];
}

/**
 * Get the list of active note commands
 */
export function getActiveNoteCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.note_commands ?? [];
}

/**
 * Get the list of active sequence commands
 */
export function getActiveSequenceCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.sequence_commands ?? [];
}

/**
 * Get the list of active approve commands
 */
export function getActiveApproveCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.approve_commands ?? [];
}

/**
 * Get the list of active reject commands
 */
export function getActiveRejectCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.reject_commands ?? [];
}

/**
 * Normalize a string for voice command matching:
 * - Lowercase
 * - Remove trailing punctuation
 * - Normalize internal punctuation/spaces (e.g., "go, go" -> "go go")
 */
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s,.!?;:\-]+$/, "") // Remove trailing punctuation
    .replace(/[,\-]+/g, " ") // Replace commas and hyphens with spaces
    .replace(/\s+/g, " ") // Normalize multiple spaces
    .trim();
}

/**
 * Process a transcript to detect and remove voice commands.
 * Voice commands are detected at the end of the transcript (case-insensitive).
 * Handles common transcription variations like trailing punctuation, commas, etc.
 * Checks both send commands and transcribe commands (send takes priority).
 *
 * @param transcript - The raw transcript text
 * @returns VoiceCommandResult with cleaned transcript and detection info
 */
export function processVoiceCommand(transcript: string): VoiceCommandResult {
  const result: VoiceCommandResult = {
    cleanedTranscript: transcript,
    commandDetected: false,
    detectedCommand: null,
    shouldSend: false,
    shouldTranscribe: false,
    shouldCancel: false,
    shouldNote: false,
    shouldRunSequence: false,
    shouldApprove: false,
    shouldReject: false,
    commandType: null,
  };

  // If voice commands are disabled, return original transcript
  if (!isVoiceCommandsEnabled()) {
    return result;
  }

  const sendCommands = getActiveVoiceCommands();
  const transcribeCommands = getActiveTranscribeCommands();
  const cancelCommands = getActiveCancelCommands();
  const noteCommands = getActiveNoteCommands();
  const sequenceCommands = getActiveSequenceCommands();
  const approveCommands = getActiveApproveCommands();
  const rejectCommands = getActiveRejectCommands();

  // Combine all commands with their types (cancel first for priority since it's destructive)
  const allCommands: { command: string; type: VoiceCommandType }[] = [
    ...cancelCommands.map(cmd => ({ command: cmd, type: 'cancel' as const })),
    ...approveCommands.map(cmd => ({ command: cmd, type: 'approve' as const })),
    ...rejectCommands.map(cmd => ({ command: cmd, type: 'reject' as const })),
    ...noteCommands.map(cmd => ({ command: cmd, type: 'note' as const })),
    ...sequenceCommands.map(cmd => ({ command: cmd, type: 'sequence' as const })),
    ...sendCommands.map(cmd => ({ command: cmd, type: 'send' as const })),
    ...transcribeCommands.map(cmd => ({ command: cmd, type: 'transcribe' as const })),
  ];

  if (allCommands.length === 0) {
    return result;
  }

  // Normalize the transcript for comparison
  const trimmedTranscript = transcript.trim();
  const normalizedTranscript = normalizeForMatching(trimmedTranscript);

  // Sort by command length (longest first) to avoid partial matches
  const sortedCommands = [...allCommands].sort(
    (a, b) => b.command.length - a.command.length
  );

  for (const { command, type } of sortedCommands) {
    const normalizedCommand = normalizeForMatching(command);

    // Check if normalized transcript ends with the normalized command
    if (normalizedTranscript.endsWith(normalizedCommand)) {
      // Find where to cut the original transcript
      // We need to find the command in the original (case-insensitive, with possible punctuation)
      const lowerTranscript = trimmedTranscript.toLowerCase();

      // Try to find the command with various patterns
      const patterns = [
        // Direct match (with possible trailing punctuation in original)
        new RegExp(`${escapeRegExp(normalizedCommand)}[\\s,.!?;:\\-]*$`, "i"),
        // With internal punctuation variations (e.g., "go, go" or "go-go")
        new RegExp(
          normalizedCommand
            .split(" ")
            .map(escapeRegExp)
            .join("[\\s,\\-]*") + "[\\s,.!?;:\\-]*$",
          "i"
        ),
      ];

      for (const pattern of patterns) {
        const match = trimmedTranscript.match(pattern);
        if (match) {
          const matchIndex = match.index!;
          let cleanedTranscript = trimmedTranscript.slice(0, matchIndex);

          // Clean up trailing punctuation and whitespace
          cleanedTranscript = cleanedTranscript.replace(/[\s,.!?;:\-]+$/, "").trim();

          result.cleanedTranscript = cleanedTranscript;
          result.commandDetected = true;
          result.detectedCommand = command;
          result.commandType = type;
          result.shouldSend = type === 'send';
          result.shouldTranscribe = type === 'transcribe';
          result.shouldCancel = type === 'cancel';
          result.shouldNote = type === 'note';
          result.shouldRunSequence = type === 'sequence';
          result.shouldApprove = type === 'approve';
          result.shouldReject = type === 'reject';
          // For sequence commands, the remaining transcript is the sequence name
          if (type === 'sequence' && cleanedTranscript.trim()) {
            result.sequenceName = cleanedTranscript.trim();
          }
          break;
        }
      }

      if (result.commandDetected) break;
    }

    // Also check with common punctuation/spacing before the command
    const punctuationVariants = [
      `. ${normalizedCommand}`,
      `, ${normalizedCommand}`,
      `! ${normalizedCommand}`,
      `? ${normalizedCommand}`,
      `; ${normalizedCommand}`,
      `: ${normalizedCommand}`,
      ` - ${normalizedCommand}`,
    ];

    for (const variant of punctuationVariants) {
      if (normalizedTranscript.endsWith(variant)) {
        // Find where to cut using regex
        const pattern = new RegExp(
          `[.!?;:\\-]\\s*${normalizedCommand
            .split(" ")
            .map(escapeRegExp)
            .join("[\\s,\\-]*")}[\\s,.!?;:\\-]*$`,
          "i"
        );
        const match = trimmedTranscript.match(pattern);

        if (match) {
          const matchIndex = match.index!;
          let cleanedTranscript = trimmedTranscript.slice(0, matchIndex);
          cleanedTranscript = cleanedTranscript.replace(/[\s,.!?;:\-]+$/, "").trim();

          result.cleanedTranscript = cleanedTranscript;
          result.commandDetected = true;
          result.detectedCommand = command;
          result.commandType = type;
          result.shouldSend = type === 'send';
          result.shouldTranscribe = type === 'transcribe';
          result.shouldCancel = type === 'cancel';
          result.shouldNote = type === 'note';
          result.shouldRunSequence = type === 'sequence';
          result.shouldApprove = type === 'approve';
          result.shouldReject = type === 'reject';
          // For sequence commands, the remaining transcript is the sequence name
          if (type === 'sequence' && cleanedTranscript.trim()) {
            result.sequenceName = cleanedTranscript.trim();
          }
          break;
        }
      }
    }

    if (result.commandDetected) break;
  }

  return result;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip voice commands from a transcript without checking if enabled.
 * Useful for cleaning up transcripts regardless of settings.
 * Handles common transcription variations like trailing punctuation, commas, etc.
 *
 * @param transcript - The raw transcript text
 * @param commands - List of commands to strip
 * @returns The cleaned transcript
 */
export function stripVoiceCommands(
  transcript: string,
  commands: string[]
): string {
  if (commands.length === 0) {
    return transcript;
  }

  const trimmedTranscript = transcript.trim();
  const normalizedTranscript = normalizeForMatching(trimmedTranscript);

  // Check each command (longest first)
  const sortedCommands = [...commands].sort((a, b) => b.length - a.length);

  for (const command of sortedCommands) {
    const normalizedCommand = normalizeForMatching(command);

    // Check if normalized transcript ends with the normalized command
    if (normalizedTranscript.endsWith(normalizedCommand)) {
      // Try to find the command with various patterns
      const patterns = [
        // Direct match (with possible trailing punctuation in original)
        new RegExp(`${escapeRegExp(normalizedCommand)}[\\s,.!?;:\\-]*$`, "i"),
        // With internal punctuation variations (e.g., "go, go" or "go-go")
        new RegExp(
          normalizedCommand
            .split(" ")
            .map(escapeRegExp)
            .join("[\\s,\\-]*") + "[\\s,.!?;:\\-]*$",
          "i"
        ),
      ];

      for (const pattern of patterns) {
        const match = trimmedTranscript.match(pattern);
        if (match) {
          let cleanedTranscript = trimmedTranscript.slice(0, match.index!);
          cleanedTranscript = cleanedTranscript.replace(/[\s,.!?;:\-]+$/, "").trim();
          return cleanedTranscript;
        }
      }
    }

    // Also check with common punctuation/spacing before the command
    const punctuationVariants = [
      `. ${normalizedCommand}`,
      `, ${normalizedCommand}`,
      `! ${normalizedCommand}`,
      `? ${normalizedCommand}`,
      `; ${normalizedCommand}`,
      `: ${normalizedCommand}`,
      ` - ${normalizedCommand}`,
    ];

    for (const variant of punctuationVariants) {
      if (normalizedTranscript.endsWith(variant)) {
        const pattern = new RegExp(
          `[.!?;:\\-]\\s*${normalizedCommand
            .split(" ")
            .map(escapeRegExp)
            .join("[\\s,\\-]*")}[\\s,.!?;:\\-]*$`,
          "i"
        );
        const match = trimmedTranscript.match(pattern);

        if (match) {
          let cleanedTranscript = trimmedTranscript.slice(0, match.index!);
          cleanedTranscript = cleanedTranscript.replace(/[\s,.!?;:\-]+$/, "").trim();
          return cleanedTranscript;
        }
      }
    }
  }

  return trimmedTranscript;
}

/**
 * Get all available voice command presets (for sending)
 */
export function getVoiceCommandPresets(): readonly string[] {
  return VOICE_COMMAND_PRESETS;
}

/**
 * Get all available transcribe command presets
 */
export function getTranscribeCommandPresets(): readonly string[] {
  return TRANSCRIBE_COMMAND_PRESETS;
}

/**
 * Get all available cancel command presets
 */
export function getCancelCommandPresets(): readonly string[] {
  return CANCEL_COMMAND_PRESETS;
}

/**
 * Get all available note command presets
 */
export function getNoteCommandPresets(): readonly string[] {
  return NOTE_COMMAND_PRESETS;
}

/**
 * Get all available sequence command presets
 */
export function getSequenceCommandPresets(): readonly string[] {
  return SEQUENCE_COMMAND_PRESETS;
}

/**
 * Get all available approve command presets
 */
export function getApproveCommandPresets(): readonly string[] {
  return APPROVE_COMMAND_PRESETS;
}

/**
 * Get all available reject command presets
 */
export function getRejectCommandPresets(): readonly string[] {
  return REJECT_COMMAND_PRESETS;
}

/**
 * Check if a custom command is valid (not empty, reasonable length)
 */
export function isValidVoiceCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length >= 2 && trimmed.length <= 30;
}
