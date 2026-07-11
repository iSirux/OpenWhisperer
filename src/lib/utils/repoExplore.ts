import { listen } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import { activeSdkSessionId, sdkSessions } from '$lib/stores/sdkSessions';
import { repos, type RepoConfig } from '$lib/stores/repos';
import { DEFAULT_OPENAI_MODEL_ID, type SdkProvider } from '$lib/utils/models';
import { REPO_ICON_NAMES } from '$lib/utils/repoIcons';

/**
 * "Explore with Claude/Codex" as a real SDK session.
 *
 * Instead of the old headless sidecar generation, this creates a visible session
 * in the repo (it shows up in the session list and streams like any other),
 * prompts the agent to explore the codebase and emit a fenced JSON metadata
 * block, then parses that block when the turn completes and applies it to the
 * repo config (description, keywords, vocabulary, icon, color).
 */

interface RepoExploreResult {
  description: string;
  keywords: string[];
  vocabulary: string[];
  icon?: string | null;
  color?: string | null;
}

const EXPLORE_MODEL_CLAUDE = 'claude-haiku-4-5-20251001';

function buildExplorePrompt(repoName: string, repoPath: string): string {
  return `You are analyzing a software repository to generate metadata for it. Explore the codebase, then output a JSON result.

Repository: ${repoName}
Path: ${repoPath}

## Your Task

1. **Explore the codebase** - Read key files like CLAUDE.md, README.md, package.json, Cargo.toml, etc. to understand the project. Do not modify any files.

2. **End your response with a JSON block** containing:
   - **description**: A concise 1-2 sentence description of what the project does and its main technologies
   - **keywords**: ~20 categorical/conceptual terms for matching user intent:
     - Technology categories (e.g., "frontend", "backend", "database", "authentication")
     - Domain concepts (e.g., "e-commerce", "real-time", "streaming", "desktop app")
     - Feature types (e.g., "CRUD", "API", "dashboard", "CLI")
     - Action verbs users might say (e.g., "deploy", "migrate", "refactor", "test")
   - **vocabulary**: 20-50 project-specific lingo/jargon from the actual codebase:
     - Function/class/module names (e.g., "SdkSession", "useSettings", "transcribeAudio")
     - Custom types and interfaces (e.g., "RepoConfig", "WhisperProvider")
     - Project-specific terminology (e.g., "sidecar", "PTY", "hotkey")
     - Abbreviations and acronyms used (e.g., "SDK", "LLM", "MCP")
     - Library/framework specific terms (e.g., "Tauri", "Svelte", "xterm")
   - **icon**: Choose the best icon from this set: ${REPO_ICON_NAMES.join(', ')}
   - **color**: If you find a primary brand color (in README badges, CSS files, config files), provide it as a hex string like "#6366f1". Otherwise set to null.

The keywords help match user prompts like "I want to add authentication" to the right repo.
The vocabulary helps speech-to-text correctly transcribe project-specific terms.

**IMPORTANT**: Your final output MUST contain a JSON block wrapped in \`\`\`json ... \`\`\` fences with EXACTLY these fields:
\`\`\`json
{"description": "...", "keywords": ["..."], "vocabulary": ["..."], "icon": "...", "color": "#..." or null}
\`\`\``;
}

/** Extract the repo metadata JSON block from the assistant's final answer. */
export function parseRepoExploreResult(text: string): RepoExploreResult | null {
  let jsonStr: string | null = null;
  // Prefer the LAST fenced json block (the final answer may follow exploration notes)
  const fenceMatches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fenceMatches.length > 0) {
    jsonStr = fenceMatches[fenceMatches.length - 1][1].trim();
  } else {
    const rawMatch = text.match(/\{[\s\S]*"description"[\s\S]*\}/);
    if (rawMatch) jsonStr = rawMatch[0];
  }
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as Partial<RepoExploreResult>;
    if (
      typeof parsed.description !== 'string' ||
      !Array.isArray(parsed.keywords) ||
      !Array.isArray(parsed.vocabulary)
    ) {
      return null;
    }
    return {
      description: parsed.description,
      keywords: parsed.keywords.filter((k): k is string => typeof k === 'string'),
      vocabulary: parsed.vocabulary.filter((v): v is string => typeof v === 'string'),
      icon: typeof parsed.icon === 'string' ? parsed.icon : null,
      color: typeof parsed.color === 'string' ? parsed.color : null,
    };
  } catch {
    return null;
  }
}

/** Apply a parsed explore result to the repo, preserving icon/color when absent or invalid. */
function applyResultToRepo(repoId: string, result: RepoExploreResult): void {
  const list = get(repos).list;
  const index = list.findIndex((repo) => repo.id === repoId);
  if (index < 0) return;
  const repo = list[index];

  const icon = result.icon && REPO_ICON_NAMES.includes(result.icon) ? result.icon : repo.icon;
  void repos.updateRepo(index, {
    description: result.description,
    keywords: result.keywords,
    vocabulary: result.vocabulary,
    icon,
    color: result.color || repo.color,
  });
}

/** Concatenate the assistant text produced after the last user message. */
function collectFinalAnswerText(sessionId: string): string {
  const session = get(sdkSessions).find((s) => s.id === sessionId);
  if (!session) return '';
  let lastUserIndex = -1;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].type === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  return session.messages
    .slice(lastUserIndex + 1)
    .filter((m) => m.type === 'text' && m.content && !m.parentToolUseId)
    .map((m) => m.content)
    .join('\n');
}

/**
 * Launch an exploration session for the repo and resolve once its first turn
 * settles. Resolves `true` when metadata was parsed and applied to the repo,
 * `false` when the turn ended without a usable result (error, stop, no JSON).
 */
export async function startRepoExploreSession(
  repo: RepoConfig,
  provider: SdkProvider
): Promise<boolean> {
  const repoId = repo.id;
  if (!repoId) throw new Error('Repository has no id');

  const model = provider === 'openai' ? DEFAULT_OPENAI_MODEL_ID : EXPLORE_MODEL_CLAUDE;
  const sessionId = await sdkSessions.createSession(repo.path, model, 'low', undefined, provider);
  sdkSessions.setSessionName(sessionId, `Explore ${repo.name}`);

  // Show the session like any other newly created one
  activeSdkSessionId.set(sessionId);
  window.dispatchEvent(new CustomEvent('switch-to-sessions'));

  let resolveSettled: (applied: boolean) => void;
  const settled = new Promise<boolean>((resolve) => {
    resolveSettled = resolve;
  });

  // Register listeners before sending so a fast turn can't slip past them.
  // Text content is appended to the store by sdk-text events, which arrive
  // before sdk-done, so the final answer is already in the store here.
  const unlistenDone = await listen(`sdk-done-${sessionId}`, () => {
    cleanup();
    const result = parseRepoExploreResult(collectFinalAnswerText(sessionId));
    if (result) {
      applyResultToRepo(repoId, result);
      resolveSettled(true);
    } else {
      console.warn('[repoExplore] Explore session finished without a parseable JSON metadata block');
      resolveSettled(false);
    }
  });
  const unlistenError = await listen(`sdk-error-${sessionId}`, () => {
    cleanup();
    resolveSettled(false);
  });
  const cleanup = () => {
    unlistenDone();
    unlistenError();
  };

  try {
    await sdkSessions.sendPrompt(sessionId, buildExplorePrompt(repo.name, repo.path));
  } catch (err) {
    cleanup();
    throw err;
  }

  return settled;
}
