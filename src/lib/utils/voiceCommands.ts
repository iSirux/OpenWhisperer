import { get } from "svelte/store";
import { settings, VOICE_COMMAND_PRESETS, TRANSCRIBE_COMMAND_PRESETS, CANCEL_COMMAND_PRESETS, SEQUENCE_COMMAND_PRESETS, APPROVE_COMMAND_PRESETS, REJECT_COMMAND_PRESETS, PREPARE_COMMAND_PRESETS, PILE_COMMAND_PRESETS } from "$lib/stores/settings";

/** Type of voice command action */
export type VoiceCommandType = 'send' | 'transcribe' | 'cancel' | 'sequence' | 'approve' | 'reject' | 'prepare' | 'pile' | null;

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
  /** Whether the command should trigger running a sequence */
  shouldRunSequence: boolean;
  /** Whether the command should approve a pending approval */
  shouldApprove: boolean;
  /** Whether the command should reject a pending approval */
  shouldReject: boolean;
  /** Whether the command should prepare a session without starting it */
  shouldPrepare: boolean;
  /** Whether the command should save the recording to the pile */
  shouldPile: boolean;
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
 * Get the list of active prepare commands
 */
export function getActivePrepareCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.prepare_commands ?? [];
}

/**
 * Get the list of active pile commands
 */
export function getActivePileCommands(): string[] {
  const currentSettings = get(settings);
  return currentSettings.audio.voice_commands.pile_commands ?? [];
}

// Apostrophe variants (straight, curly, modifier-letter) that transcribers use
// interchangeably. Collapsed to nothing so "don't" and "dont" — and "let's" and
// "lets" — normalize identically instead of splitting into "don t" / "let s".
const APOSTROPHES = /['‘’ʼ]+/g;

/**
 * Normalize a string for voice command matching. Transcribers disagree on
 * punctuation (some emit "Send it." or "Hey, Claude", others "send it") and on
 * apostrophes ("don't" vs "dont"), so we collapse apostrophes and strip all
 * other punctuation/symbols down to lowercase words separated by single spaces.
 * Both the transcript and the command run through this, making matching
 * punctuation-agnostic.
 */
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(APOSTROPHES, "") // Collapse apostrophes: don't -> dont
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // Drop all other punctuation/symbols
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

/**
 * Whether `transcript` ends with `command`, ignoring case, punctuation, and
 * spacing differences (e.g. transcript "Hey, Claude." matches command
 * "hey claude"). Used for wake-command detection where the transcript is kept
 * as-is and only a boolean match is needed.
 */
export function transcriptEndsWithCommand(transcript: string, command: string): boolean {
  const normalizedCommand = normalizeForMatching(command);
  if (!normalizedCommand) return false;
  return normalizeForMatching(transcript).endsWith(normalizedCommand);
}

// Matches any run of non-alphanumeric characters (punctuation, symbols,
// whitespace). Used to tolerate transcriber punctuation when locating a command
// in the original transcript.
const CMD_SEP = "[^\\p{L}\\p{N}]*";

// Optional apostrophes allowed inside a word when locating a command in the
// original transcript — the normalized command drops them ("dont"), but the raw
// transcript may still spell it "don't".
const CMD_APOS = "['\\u2018\\u2019\\u02BC]*";

/**
 * If `transcript` ends with `command` (ignoring case, punctuation, and spacing
 * differences), return the transcript with the trailing command removed and any
 * leftover trailing punctuation cleaned up. Returns null if the command is not
 * found at the end.
 */
function stripTrailingCommand(transcript: string, command: string): string | null {
  const normalizedCommand = normalizeForMatching(command);
  if (!normalizedCommand) return null;

  const normalizedTranscript = normalizeForMatching(transcript);
  if (!normalizedTranscript.endsWith(normalizedCommand)) return null;

  // Locate the command at the end of the ORIGINAL transcript, tolerating any
  // punctuation/whitespace before, between, and after the command words, plus
  // optional apostrophes inside a word (transcript "don't" vs command "dont").
  const wordPattern = (word: string) =>
    [...word].map(escapeRegExp).join(CMD_APOS);
  const words = normalizedCommand.split(" ").map(wordPattern);
  const pattern = new RegExp(CMD_SEP + words.join(CMD_SEP) + CMD_SEP + "$", "iu");
  const match = transcript.match(pattern);
  if (!match) return null;

  return transcript
    .slice(0, match.index!)
    .replace(/[^\p{L}\p{N}]+$/u, "") // Strip trailing punctuation/whitespace
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
    shouldRunSequence: false,
    shouldApprove: false,
    shouldReject: false,
    shouldPrepare: false,
    shouldPile: false,
    commandType: null,
  };

  // If voice commands are disabled, return original transcript
  if (!isVoiceCommandsEnabled()) {
    return result;
  }

  const sendCommands = getActiveVoiceCommands();
  const transcribeCommands = getActiveTranscribeCommands();
  const cancelCommands = getActiveCancelCommands();
  const sequenceCommands = getActiveSequenceCommands();
  const approveCommands = getActiveApproveCommands();
  const rejectCommands = getActiveRejectCommands();
  const prepareCommands = getActivePrepareCommands();
  const pileCommands = getActivePileCommands();

  // Combine all commands with their types (cancel first for priority since it's destructive)
  const allCommands: { command: string; type: VoiceCommandType }[] = [
    ...cancelCommands.map(cmd => ({ command: cmd, type: 'cancel' as const })),
    ...approveCommands.map(cmd => ({ command: cmd, type: 'approve' as const })),
    ...rejectCommands.map(cmd => ({ command: cmd, type: 'reject' as const })),
    ...sequenceCommands.map(cmd => ({ command: cmd, type: 'sequence' as const })),
    ...prepareCommands.map(cmd => ({ command: cmd, type: 'prepare' as const })),
    ...pileCommands.map(cmd => ({ command: cmd, type: 'pile' as const })),
    ...sendCommands.map(cmd => ({ command: cmd, type: 'send' as const })),
    ...transcribeCommands.map(cmd => ({ command: cmd, type: 'transcribe' as const })),
  ];

  if (allCommands.length === 0) {
    return result;
  }

  // Normalize the transcript for comparison
  const trimmedTranscript = transcript.trim();

  // Sort by command length (longest first) to avoid partial matches
  const sortedCommands = [...allCommands].sort(
    (a, b) => b.command.length - a.command.length
  );

  for (const { command, type } of sortedCommands) {
    const cleanedTranscript = stripTrailingCommand(trimmedTranscript, command);
    if (cleanedTranscript === null) continue;

    result.cleanedTranscript = cleanedTranscript;
    result.commandDetected = true;
    result.detectedCommand = command;
    result.commandType = type;
    result.shouldSend = type === 'send';
    result.shouldTranscribe = type === 'transcribe';
    result.shouldCancel = type === 'cancel';
    result.shouldRunSequence = type === 'sequence';
    result.shouldApprove = type === 'approve';
    result.shouldReject = type === 'reject';
    result.shouldPrepare = type === 'prepare';
    result.shouldPile = type === 'pile';
    // For sequence commands, the remaining transcript is the sequence name
    if (type === 'sequence' && cleanedTranscript.trim()) {
      result.sequenceName = cleanedTranscript.trim();
    }
    break;
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

  // Check each command (longest first)
  const sortedCommands = [...commands].sort((a, b) => b.length - a.length);

  for (const command of sortedCommands) {
    const cleanedTranscript = stripTrailingCommand(trimmedTranscript, command);
    if (cleanedTranscript !== null) return cleanedTranscript;
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
 * Get all available prepare command presets
 */
export function getPrepareCommandPresets(): readonly string[] {
  return PREPARE_COMMAND_PRESETS;
}

/**
 * Get all available pile command presets
 */
export function getPileCommandPresets(): readonly string[] {
  return PILE_COMMAND_PRESETS;
}

/**
 * Check if a custom command is valid (not empty, reasonable length)
 */
export function isValidVoiceCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length >= 2 && trimmed.length <= 30;
}
