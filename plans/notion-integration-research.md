# Notion Integration Research for OpenWhisperer

## Goal

Add a "transcribe to Notion" feature - speak from the overlay and save the transcription directly as a Notion note, with optional AI-powered cleanup and smart routing.

---

## User Flow

### Basic Flow
1. User presses a hotkey (e.g., `Ctrl+Shift+N`)
2. Overlay shows recording indicator
3. User speaks their note
4. Audio is transcribed via Whisper API
5. Transcription is sent directly to Notion as a new page/block
6. Overlay shows success confirmation

### Enhanced Flow (with Gemini)
1. User presses hotkey, speaks note
2. Whisper transcribes audio → raw text
3. **Gemini cleans up** the transcription (grammar, filler words, formatting)
4. **Gemini suggests** where to place the note (which page/database)
5. Note is saved to Notion with proper formatting
6. Overlay confirms with destination info

This bypasses the SDK/Claude entirely - it's a quick voice-to-note capture.

---

## Official SDK

**Package:** `@notionhq/client`

```bash
npm install @notionhq/client
```

**Basic Usage:**
```typescript
import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});
```

---

## Authentication (Internal Integration)

For a desktop app, use **Internal Integration**:

1. User creates integration at [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. User copies the "Internal Integration Secret"
3. User pastes token into OpenWhisperer settings
4. User shares target page/database with the integration in Notion UI

**Tokens don't expire** - set once and forget.

---

## Core API: Create a Quick Note

### Option A: Append to an Existing Page (Daily Notes Style)

Best for collecting notes in one place:

```typescript
await notion.blocks.children.append({
  block_id: "target-page-id",
  children: [
    {
      object: "block",
      type: "callout",
      callout: {
        icon: { emoji: "🎤" },
        rich_text: [{
          type: "text",
          text: { content: transcription }
        }],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{
          type: "text",
          text: { content: new Date().toLocaleString() },
          annotations: { color: "gray" }
        }],
      },
    },
  ],
});
```

### Option B: Create a New Page Per Note

Best for individual searchable notes:

```typescript
await notion.pages.create({
  parent: { page_id: "parent-page-id" },
  properties: {
    title: {
      title: [{ text: { content: transcription.slice(0, 50) + "..." } }]
    },
  },
  children: [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: transcription } }],
      },
    },
  ],
});
```

### Option C: Add to a Database (Best for Organization)

Best for tagged, filterable notes:

```typescript
await notion.pages.create({
  parent: { database_id: "database-id" },
  properties: {
    // "Name" is typical title property in databases
    Name: {
      title: [{ text: { content: transcription.slice(0, 50) } }]
    },
    // Optional: add tags, date, etc.
    Tags: {
      multi_select: [{ name: "Voice Note" }]
    },
    Date: {
      date: { start: new Date().toISOString().split('T')[0] }
    },
  },
  children: [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: transcription } }],
      },
    },
  ],
});
```

---

## API Limits

| Limit | Value |
|-------|-------|
| Rate limit | 3 requests/second |
| Rich text element | 2000 characters max |

For voice notes, 2000 chars is plenty (~400 words).

---

## Proposed Implementation

### 1. Settings Addition

```typescript
// In settings.ts
export interface NotionConfig {
  enabled: boolean;
  token: string;              // Internal integration secret
  target_type: "page" | "database";
  target_id: string;          // Page ID or Database ID to save notes to
  note_style: "append" | "new_page";  // Append to page vs create new
}

export interface HotkeyConfig {
  toggle_recording: string;
  transcribe_to_input: string;
  transcribe_to_notion: string;  // NEW: direct to Notion
  cycle_repo: string;
  cycle_model: string;
}
```

### 2. Rust Backend (Simple HTTP)

Since this is just an HTTP call, it can be done directly in Rust without the sidecar:

```rust
// src-tauri/src/notion.rs
use reqwest::Client;
use serde_json::json;

pub async fn append_to_notion(
    token: &str,
    page_id: &str,
    content: &str,
) -> Result<(), String> {
    let client = Client::new();

    let response = client
        .patch(format!(
            "https://api.notion.com/v1/blocks/{}/children",
            page_id
        ))
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "children": [{
                "object": "block",
                "type": "callout",
                "callout": {
                    "icon": { "emoji": "🎤" },
                    "rich_text": [{
                        "type": "text",
                        "text": { "content": content }
                    }]
                }
            }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Notion API error: {}", response.status()));
    }

    Ok(())
}
```

### 3. Tauri Command

```rust
// src-tauri/src/commands/notion_cmds.rs
#[tauri::command]
pub async fn save_to_notion(
    state: State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    let config = state.config.lock();
    let notion = &config.notion;

    if !notion.enabled {
        return Err("Notion integration not enabled".to_string());
    }

    crate::notion::append_to_notion(
        &notion.token,
        &notion.target_id,
        &content,
    ).await
}
```

### 4. Frontend: New Recording Mode

```typescript
// In recording.ts - add a new function
export async function transcribeToNotion() {
  // 1. Record audio (reuse existing logic)
  const audioBlob = await recordAudio();

  // 2. Transcribe via Whisper
  const transcription = await invoke<string>("transcribe_audio", {
    audioData: Array.from(new Uint8Array(await audioBlob.arrayBuffer())),
  });

  // 3. Send to Notion
  await invoke("save_to_notion", { content: transcription });

  // 4. Show success in overlay
  overlayStatus.set("Saved to Notion!");
}
```

### 5. Hotkey Registration

Add to existing hotkey setup:

```typescript
// Register the new hotkey
await register(config.hotkeys.transcribe_to_notion, async () => {
  await transcribeToNotion();
});
```

### 6. Overlay UI Update

Show Notion status in overlay:

```svelte
{#if recordingMode === 'notion'}
  <div class="flex items-center gap-2">
    <span class="text-purple-400">📝</span>
    <span>Recording for Notion...</span>
  </div>
{/if}
```

---

## Settings UI

Add a "Notion" tab in settings:

```
┌─────────────────────────────────────────┐
│ Notion Integration                       │
├─────────────────────────────────────────┤
│ ☑ Enable Notion Integration             │
│                                          │
│ Integration Token:                       │
│ ┌─────────────────────────────────────┐ │
│ │ secret_abc123...                    │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ Save notes to:                           │
│ ○ Append to page                         │
│ ● Add to database                        │
│                                          │
│ Page/Database ID:                        │
│ ┌─────────────────────────────────────┐ │
│ │ abc123def456...                     │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ [Test Connection]                        │
└─────────────────────────────────────────┘
```

---

## Getting the Page/Database ID

Users can get the ID from the Notion URL:

```
https://notion.so/My-Page-abc123def456...
                        └── This is the ID
```

Or for databases:
```
https://notion.so/abc123?v=xyz
              └── Database ID
```

---

## Gemini Integration for Smart Processing

### Why Gemini?

- **Cheap & fast** - Gemini 2.0 Flash is very cost-effective for text processing
- **Good at cleanup** - Handles grammar, punctuation, filler word removal well
- **Structured output** - Can return JSON with cleaned text + routing suggestion

### Official SDK

**Package:** `@google/genai` (new unified SDK, GA as of 2025)

```bash
npm install @google/genai
```

**Note:** The old `@google/generative-ai` package is deprecated (EOL: Nov 2025).

### Basic Usage

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-2.0-flash",
  contents: "Clean up this transcription...",
});

console.log(response.text);
```

### Use Case 1: Transcription Cleanup

```typescript
async function cleanupTranscription(rawText: string): Promise<string> {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `Clean up this voice transcription. Fix grammar, remove filler words (um, uh, like), add punctuation, but preserve the original meaning and tone. Return only the cleaned text, nothing else.

Transcription: "${rawText}"`,
  });

  return response.text;
}
```

**Example:**
- Input: `"um so I was thinking we should like maybe add a new feature to the app uh for tracking time"`
- Output: `"I was thinking we should add a new feature to the app for tracking time."`

### Use Case 2: Smart Routing (Where to Save)

```typescript
interface NotionTarget {
  page_id: string;
  name: string;
  description: string;
}

interface RoutingResult {
  cleaned_text: string;
  suggested_target: string;  // page_id
  confidence: number;
  suggested_title?: string;
}

async function processAndRoute(
  rawText: string,
  targets: NotionTarget[]
): Promise<RoutingResult> {
  const targetList = targets
    .map(t => `- ${t.name} (${t.page_id}): ${t.description}`)
    .join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `You are a note routing assistant. Given a voice transcription and a list of Notion pages/databases, clean up the transcription and suggest where it should be saved.

Available destinations:
${targetList}

Voice transcription: "${rawText}"

Respond in JSON format:
{
  "cleaned_text": "the cleaned up transcription",
  "suggested_target": "page_id of best destination",
  "confidence": 0.0-1.0,
  "suggested_title": "short title for the note if creating new page"
}`,
    generationConfig: {
      responseMimeType: "application/json",
    },
  });

  return JSON.parse(response.text);
}
```

**Example targets:**
```typescript
const targets: NotionTarget[] = [
  { page_id: "abc123", name: "Work Tasks", description: "Tasks and todos for work projects" },
  { page_id: "def456", name: "Personal Ideas", description: "Random ideas and thoughts" },
  { page_id: "ghi789", name: "Meeting Notes", description: "Notes from meetings" },
  { page_id: "jkl012", name: "Shopping List", description: "Things to buy" },
];
```

**Example routing:**
- Input: `"remind me to buy milk and eggs tomorrow"`
- Output: `{ cleaned_text: "Buy milk and eggs tomorrow", suggested_target: "jkl012", confidence: 0.95 }`

### Settings Addition for Gemini

```typescript
export interface GeminiConfig {
  enabled: boolean;
  api_key: string;
  cleanup_enabled: boolean;      // Clean up transcriptions
  routing_enabled: boolean;      // Smart destination routing
  model: string;                 // "gemini-2.0-flash" recommended
}

export interface NotionTarget {
  page_id: string;
  name: string;
  description: string;  // Helps Gemini understand what goes where
}

export interface NotionConfig {
  enabled: boolean;
  token: string;
  default_target_id: string;     // Fallback destination
  targets: NotionTarget[];       // Multiple destinations for routing
}
```

### Implementation in Rust

Since Gemini is just an HTTP API, it can be called directly from Rust:

```rust
// src-tauri/src/gemini.rs
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    content: Content,
}

#[derive(Deserialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    text: String,
}

pub async fn cleanup_transcription(
    api_key: &str,
    raw_text: &str,
) -> Result<String, String> {
    let client = Client::new();

    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
            api_key
        ))
        .header("Content-Type", "application/json")
        .json(&json!({
            "contents": [{
                "parts": [{
                    "text": format!(
                        "Clean up this voice transcription. Fix grammar, remove filler words, add punctuation. Return only the cleaned text.\n\nTranscription: \"{}\"",
                        raw_text
                    )
                }]
            }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data: GeminiResponse = response.json().await.map_err(|e| e.to_string())?;

    data.candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or_else(|| "No response from Gemini".to_string())
}
```

### Updated Flow with Gemini

```typescript
// In recording.ts
export async function transcribeToNotion() {
  // 1. Record and transcribe
  const audioBlob = await recordAudio();
  let text = await invoke<string>("transcribe_audio", { audioData: ... });

  // 2. Optional: Clean up with Gemini
  if (settings.gemini.cleanup_enabled) {
    text = await invoke<string>("cleanup_transcription", { text });
  }

  // 3. Optional: Smart routing with Gemini
  let targetId = settings.notion.default_target_id;
  if (settings.gemini.routing_enabled && settings.notion.targets.length > 1) {
    const result = await invoke<RoutingResult>("route_note", {
      text,
      targets: settings.notion.targets,
    });
    text = result.cleaned_text;
    targetId = result.suggested_target;
  }

  // 4. Save to Notion
  await invoke("save_to_notion", { content: text, targetId });

  // 5. Confirm
  overlayStatus.set(`Saved to ${getTargetName(targetId)}`);
}
```

### Cost Estimate (Gemini 2.0 Flash)

| Usage | Tokens | Cost |
|-------|--------|------|
| Cleanup prompt | ~100 input | ~$0.00001 |
| Routing prompt | ~300 input | ~$0.00003 |
| Response | ~50 output | ~$0.00001 |

**Per note: ~$0.00005** (essentially free)

### Settings UI Addition

```
┌─────────────────────────────────────────┐
│ AI Processing (Gemini)                   │
├─────────────────────────────────────────┤
│ ☑ Enable Gemini Processing              │
│                                          │
│ API Key:                                 │
│ ┌─────────────────────────────────────┐ │
│ │ AIza...                             │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ ☑ Clean up transcriptions               │
│   Remove filler words, fix grammar       │
│                                          │
│ ☑ Smart routing                          │
│   Suggest which page to save to          │
│                                          │
│ [Test Connection]                        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Notion Destinations                      │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ 📝 Work Tasks          [Default] ✕ │ │
│ │    Tasks and todos for work         │ │
│ ├─────────────────────────────────────┤ │
│ │ 💡 Personal Ideas               ✕ │ │
│ │    Random ideas and thoughts        │ │
│ ├─────────────────────────────────────┤ │
│ │ 🛒 Shopping List                ✕ │ │
│ │    Things to buy                    │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ [+ Add Destination]                      │
└─────────────────────────────────────────┘
```

---

## Resources

### Notion
- [Official SDK](https://github.com/makenotion/notion-sdk-js)
- [npm: @notionhq/client](https://www.npmjs.com/package/@notionhq/client)
- [API Reference: Append Block Children](https://developers.notion.com/reference/patch-block-children)
- [API Reference: Create Page](https://developers.notion.com/reference/post-page)
- [Notion Integrations Dashboard](https://www.notion.so/my-integrations)

### Gemini
- [Official SDK](https://github.com/googleapis/js-genai)
- [npm: @google/genai](https://www.npmjs.com/package/@google/genai)
- [Gemini API Quickstart](https://ai.google.dev/gemini-api/docs/quickstart)
- [Get API Key](https://aistudio.google.com/apikey)
