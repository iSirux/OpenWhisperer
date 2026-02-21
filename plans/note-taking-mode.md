# Feature: Note-Taking Mode

## Overview
Add a specialized note-taking mode that uses voice transcriptions to create notes via MCP tools (e.g., Notion). The mode has read-only repo access, configurable MCP servers per repo, and can be triggered via hotkey (while recording or dedicated) or voice command.

## Requirements
- **Multiple trigger methods**: Hotkey while recording, dedicated hotkey, and voice command
- **Auto-create notes**: Claude processes transcription and creates note immediately
- **Post-creation chat**: User can refine/chat in the session after initial note creation
- **Read-only repo access**: Only Read, Glob, Grep tools allowed (no file modifications)
- **Per-repo MCP config**: Different repos can have different note-taking MCP servers
- **Mixed UI**: Note sessions appear in main list with distinct icon/badge
- **Always use Haiku**: Note-taking sessions always use claude-haiku for speed and cost efficiency

## Decisions Made
| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Session Type | New `noteMode` flag on SdkSession | Follows planMode pattern, allows specialized behavior |
| Trigger Methods | All three (hotkey-while-recording, dedicated, voice) | Maximum flexibility for voice-first workflow |
| Tool Access | allowedTools filter in sidecar | SDK supports this pattern, clean enforcement |
| MCP Config | Per-repo `note_mcp_servers` field | Mirrors existing `mcp_servers` pattern |
| System Prompt | Dedicated prompt in `src/lib/prompts/noteMode.ts` | Follows planMode pattern |
| Model | Always Haiku (`claude-haiku-4-5-20251001`) | Fast, cheap, sufficient for note-taking tasks |

## Alternatives Considered
- **Separate note-taking app**: Too fragmented, loses context of codebase
- **Always use all MCP servers**: Less control, might confuse Claude with irrelevant tools
- **No repo access at all**: Limits usefulness for code-related notes

---

## Implementation Plan

### Phase 1: Configuration & Types
Add the configuration and type definitions needed for note-taking mode.

- [ ] **1.1** Add `note_mode` hotkey to `HotkeyConfig` in `src-tauri/src/config.rs`
  ```rust
  pub struct HotkeyConfig {
      // ... existing fields
      #[serde(default = "default_note_mode")]
      pub note_mode: String,  // e.g., "CommandOrControl+Shift+N"
  }
  ```

- [ ] **1.2** Add `note_mcp_servers` field to `RepoConfig` in `src-tauri/src/config.rs`
  ```rust
  pub struct RepoConfig {
      // ... existing fields
      #[serde(default)]
      pub note_mcp_servers: Option<Vec<String>>,  // MCP server IDs for note mode
  }
  ```

- [ ] **1.3** Add `note_wake_commands` to voice commands config (for voice trigger)
  ```rust
  pub struct VoiceCommandConfig {
      // ... existing fields
      #[serde(default = "default_note_wake_commands")]
      pub note_commands: Vec<String>,  // e.g., ["take a note", "new note"]
  }
  ```

- [ ] **1.4** Add `noteMode` field to `SdkSession` type in `src/lib/stores/sdkSessions.ts`
  ```typescript
  export interface NoteModeState {
    isActive: boolean;
    noteCreated: boolean;  // Track if initial note was created
  }

  export interface SdkSession {
    // ... existing fields
    noteMode?: NoteModeState;
  }
  ```

- [ ] **1.5** Update `settings.ts` store with TypeScript types for new config fields

### Phase 2: System Prompt & Sidecar Support
Create the note-taking system prompt and update sidecar to support read-only mode.

- [ ] **2.1** Create `src/lib/prompts/noteMode.ts` with note-taking system prompt
  ```typescript
  export const NOTE_MODE_SYSTEM_PROMPT = `You are in NOTE-TAKING MODE...

  ## Your Role
  Help the user capture notes from their voice transcription using the available
  note-taking tools (Notion, etc.).

  ## Available Tools
  - Note-taking MCP tools (create pages, append to databases, etc.)
  - Read-only codebase access (Read, Glob, Grep) for referencing code

  ## Process
  1. Analyze the transcription to understand the note content
  2. Create/update a note using the appropriate MCP tool
  3. Confirm what was created and offer to refine

  ## Guidelines
  - Create the note immediately without asking for confirmation
  - Use appropriate formatting (headings, lists, code blocks)
  - If referencing code, include relevant snippets
  - After creating, summarize what was done and ask if changes needed
  `;
  ```

- [ ] **2.2** Update sidecar `handleCreate` in `src-tauri/sidecar/src/index.ts` to support note mode
  - Add `note_mode?: boolean` to `CreateMessage` interface
  - Filter `allowedTools` to only include: `Read`, `Glob`, `Grep`, and `mcp__*` patterns for note MCP servers
  - Apply system prompt for note mode

- [ ] **2.3** Update `create_sdk_session` Rust command to accept `noteMode` parameter
  - Pass note-specific MCP servers based on repo config
  - Pass `note_mode: true` to sidecar

### Phase 3: Hotkey Support
Add the hotkey triggers for note-taking mode.

- [ ] **3.1** Update `useHotkeyManager.svelte.ts` to register note mode hotkey
  - Add `registerNoteModeHotkey()` function (registered while recording)
  - When pressed while recording: set flag to process as note mode
  - Similar pattern to `transcribe_to_input` hotkey

- [ ] **3.2** Add dedicated note mode toggle hotkey
  - Register in `setup()` alongside `toggle_recording`
  - Starts recording directly in note mode (skips regular session flow)

- [ ] **3.3** Update `useRecordingFlow.svelte.ts` to support note mode
  - Add `startRecordingNoteMode()` function for dedicated hotkey
  - Add `isRecordingForNoteMode` state
  - Modify session creation to pass `noteMode: true`

- [ ] **3.4** Update overlay to show note mode indicator
  - Different color/icon when in note-taking mode
  - Show "Note Mode" text

### Phase 4: Voice Command Support
Add voice command trigger for note-taking mode.

- [ ] **4.1** Update `voiceCommands.ts` to detect note commands
  - Add `detectNoteCommand(transcript: string): boolean`
  - Check against configured `note_commands` phrases

- [ ] **4.2** Update open mic handling to support note wake commands
  - In `useOpenMic.svelte.ts`, detect note-specific wake commands
  - Trigger `startRecordingNoteMode()` instead of regular recording

- [ ] **4.3** Update `useTranscriptionProcessor.svelte.ts` to check for note voice commands
  - After transcription, check if ends with note command phrase
  - If detected, process as note mode session

### Phase 5: Session Creation & Store
Implement the note mode session creation flow.

- [ ] **5.1** Add `createNoteModeSession()` method to `sdkSessions` store
  ```typescript
  // Note: Always uses Haiku model, no thinking level
  async createNoteModeSession(
    cwd: string,
    noteMcpServers: string[]
  ): Promise<string>
  ```

- [ ] **5.2** Add `createPendingNoteSession()` for the recording flow
  - Similar to `createPendingTranscriptionSession()` but with `noteMode` flag

- [ ] **5.3** Update `registerSessionWithBackend()` to handle note mode
  - Pass note-specific MCP servers
  - Pass `noteMode: true` to sidecar

- [ ] **5.4** Update `completePendingTranscription()` to handle note mode sessions
  - Use note mode system prompt
  - Pass appropriate flags to backend

### Phase 6: UI Updates
Update the UI to display note mode sessions distinctly.

- [ ] **6.1** Add note mode icon/badge to `SessionList.svelte`
  - Detect `session.noteMode?.isActive`
  - Show notebook/note icon instead of terminal icon
  - Different accent color (e.g., amber/yellow for notes)

- [ ] **6.2** Add note mode indicator to `SdkSessionHeader.svelte`
  - Show "Note" badge next to model selector
  - Indicate read-only mode

- [ ] **6.3** Update `SessionCard.svelte` for sessions-view grid
  - Note mode visual distinction
  - Category badge "Note"

- [ ] **6.4** Update overlay component for note mode
  - Different background color when in note mode
  - Show note icon

### Phase 7: Settings UI
Add settings for configuring note-taking mode.

- [ ] **7.1** Add Note Mode section to `HotkeysTab.svelte`
  - Input for `note_mode` hotkey
  - Description of functionality

- [ ] **7.2** Add note MCP servers selector to `ReposTab.svelte`
  - Multi-select for which MCP servers to use in note mode
  - Separate from regular `mcp_servers` association

- [ ] **7.3** Add note commands to `AudioTab.svelte` (Voice Commands section)
  - Input for note wake/trigger phrases
  - Similar UI to existing wake commands

---

## Open Questions
1. Should note sessions auto-name based on note content (like regular sessions)?
2. Should there be a "quick note" mode that doesn't show the session at all (just confirms success)?
3. Should note mode work without any repo selected (for general notes)?

## File Changes Summary

### New Files
- `src/lib/prompts/noteMode.ts` - Note mode system prompt

### Modified Files
- `src-tauri/src/config.rs` - Add hotkey, repo config, voice command fields
- `src-tauri/sidecar/src/index.ts` - Add note mode handling with tool filtering
- `src/lib/stores/sdkSessions.ts` - Add noteMode state and creation methods
- `src/lib/stores/settings.ts` - TypeScript types for new config
- `src/lib/composables/useHotkeyManager.svelte.ts` - Note mode hotkeys
- `src/lib/composables/useRecordingFlow.svelte.ts` - Note mode recording flow
- `src/lib/composables/useOpenMic.svelte.ts` - Note wake commands
- `src/lib/utils/voiceCommands.ts` - Note command detection
- `src/lib/components/SessionList.svelte` - Note mode icon/badge
- `src/lib/components/sdk/SdkSessionHeader.svelte` - Note mode indicator
- `src/lib/components/SessionCard.svelte` - Note mode styling
- `src/lib/components/Overlay.svelte` - Note mode indicator
- `src/lib/components/settings/HotkeysTab.svelte` - Note hotkey setting
- `src/lib/components/settings/ReposTab.svelte` - Note MCP servers
- `src/lib/components/settings/AudioTab.svelte` - Note voice commands
