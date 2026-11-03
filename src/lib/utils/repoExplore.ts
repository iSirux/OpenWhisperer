import { listen } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import { activeSdkSessionId, sdkSessions } from '$lib/stores/sdkSessions';
import { repos, type RepoConfig } from '$lib/stores/repos';
import type { LaunchCommand, LaunchProfile } from '$lib/types/launch';
import { newestModelInFamily } from '$lib/stores/modelCatalog';
import { DEFAULT_MODEL_ID, DEFAULT_OPENAI_MODEL_ID, type SdkProvider } from '$lib/utils/models';
import { REPO_ICON_NAMES } from '$lib/utils/repoIcons';
import { loadRepoIconImage } from '$lib/utils/repoIconImage';

/**
 * "Explore with Claude/Codex" as a real SDK session.
 *
 * Instead of the old headless sidecar generation, this creates a visible session
 * in the repo (it shows up in the session list and streams like any other),
 * prompts the agent to explore the codebase and emit a fenced JSON block, then
 * parses that block when the turn completes and applies it to the repo config.
 * One pass covers both halves of the repo's metadata: the identity fields
 * (description, keywords, vocabulary, icon, color) and the launch setup
 * (runnable commands + the profiles that group them) — the agent is already
 * reading package.json/Cargo.toml/compose files for the description, so asking
 * for the commands in the same turn is nearly free.
 */

interface RepoExploreCommand {
  name: string;
  command: string;
  working_dir?: string;
}

interface RepoExploreProfile {
  name: string;
  command_names: string[];
}

interface RepoExploreResult {
  description: string;
  keywords: string[];
  vocabulary: string[];
  icon?: string | null;
  /** Repo-relative path to the project's own favicon/logo, if it has one. */
  iconImagePath?: string | null;
  color?: string | null;
  commands: RepoExploreCommand[];
  profiles: RepoExploreProfile[];
}

function buildExplorePrompt(repoName: string, repoPath: string): string {
  return `You are analyzing a software repository to generate metadata for it. Explore the codebase, then output a JSON result.

Repository: ${repoName}
Path: ${repoPath}

## Your Task

1. **Explore the codebase** - Read key files like CLAUDE.md, README.md, package.json, Cargo.toml, docker-compose.yml, Makefile, pyproject.toml, Procfile, turbo.json, etc. to understand the project and how it is run. Check subdirectories too — monorepos often have separate frontend/, backend/, api/, packages/* folders with their own scripts. Do not modify any files.

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
   - **icon_image**: Repo-relative path to the project's OWN square logo/favicon image file, if it has one — this is used as the repo's avatar instead of the generic icon above. Look in the usual places (\`favicon.ico\`/\`favicon.png\`, \`static/\`, \`public/\`, \`assets/\`, \`src/assets/\`, \`app/icon.png\`, \`src-tauri/icons/\`, \`android/app/src/main/res/mipmap-*/\`, \`docs/\`, or an image referenced at the top of README.md). Rules: it must be a local file in this repo (not a URL), a real raster/vector image (\`.png\`, \`.svg\`, \`.ico\`, \`.jpg\`, \`.webp\`), roughly square, and actually the project's own brand mark — NOT a screenshot, a photo, a wide wordmark/banner, a CI/shields.io badge, a dependency's logo, or a stock framework logo (e.g. the default Vite/React/SvelteKit favicon that ships with a starter template). Prefer the largest clean version (e.g. a 512px PNG over a 16px ICO), and prefer \`.png\`/\`.svg\` over \`.ico\`. Verify the file exists before reporting it. If there is no such file, set it to null — that is a perfectly normal answer.
   - **color**: If you find a primary brand color (in README badges, CSS files, config files), provide it as a hex string like "#6366f1". Otherwise set to null.
   - **commands**: The runnable services/scripts a developer starts while working on this project (dev servers, watchers, databases, workers — not one-shot builds or CI-only tasks). Each entry has:
     - \`name\`: Short display name (e.g., "Frontend Dev", "API Server", "Database")
     - \`command\`: Shell command to run, using the project's package manager (e.g., "npm run dev", "docker compose up db")
     - \`working_dir\`: Relative path from the repo root for subdirectory commands (e.g., "frontend", "packages/api"). Omit for repo root.
   - **profiles**: Logical groups of those commands a user would launch together, each with:
     - \`name\`: Profile name (e.g., "Full Stack", "Frontend Only", "API + DB")
     - \`command_names\`: Names of commands to include, matching the \`name\` field above exactly

The keywords help match user prompts like "I want to add authentication" to the right repo.
The vocabulary helps speech-to-text correctly transcribe project-specific terms.
If the repo has nothing runnable, use empty arrays for commands and profiles.

**IMPORTANT**: Your final output MUST contain a JSON block wrapped in \`\`\`json ... \`\`\` fences with EXACTLY these fields:
\`\`\`json
{"description": "...", "keywords": ["..."], "vocabulary": ["..."], "icon": "...", "icon_image": "static/favicon.png" or null, "color": "#..." or null, "commands": [{"name": "...", "command": "...", "working_dir": "..."}], "profiles": [{"name": "...", "command_names": ["..."]}]}
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
    const parsed = JSON.parse(jsonStr) as Partial<RepoExploreResult> & { icon_image?: unknown };
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
      iconImagePath: typeof parsed.icon_image === 'string' ? parsed.icon_image : null,
      color: typeof parsed.color === 'string' ? parsed.color : null,
      // Launch fields are best-effort: a result that nails the description but
      // skips the commands is still worth applying.
      commands: Array.isArray(parsed.commands)
        ? parsed.commands.filter(
            (c): c is RepoExploreCommand =>
              !!c && typeof c.name === 'string' && typeof c.command === 'string'
          )
        : [],
      profiles: Array.isArray(parsed.profiles)
        ? parsed.profiles.filter(
            (p): p is RepoExploreProfile =>
              !!p && typeof p.name === 'string' && Array.isArray(p.command_names)
          )
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Merge generated launch commands/profiles into the repo's existing ones.
 *
 * Hand-written commands are kept (only auto-detected ones are replaced), and a
 * generated profile may reference a manual command by name. Profiles that still
 * resolve entirely against the surviving command set are kept too.
 */
function mergeLaunchSetup(
  repo: RepoConfig,
  result: RepoExploreResult
): Pick<RepoConfig, 'launch_commands' | 'launch_profiles'> {
  const manual = (repo.launch_commands ?? []).filter((command) => !command.auto_detected);
  const generated: LaunchCommand[] = result.commands.map((command) => ({
    id: crypto.randomUUID(),
    name: command.name,
    command: command.command,
    working_dir: command.working_dir || undefined,
    auto_detected: true,
  }));
  const commands = [...manual, ...generated];

  const idsByName = new Map(commands.map((command) => [command.name, command.id]));
  const validIds = new Set(commands.map((command) => command.id));
  const keptProfiles = (repo.launch_profiles ?? []).filter(
    (profile) =>
      profile.command_ids.length > 0 && profile.command_ids.every((id) => validIds.has(id))
  );
  const generatedProfiles: LaunchProfile[] = result.profiles
    .map((profile) => ({
      id: crypto.randomUUID(),
      name: profile.name,
      command_ids: profile.command_names
        .map((name) => idsByName.get(name))
        .filter((id): id is string => !!id),
    }))
    .filter((profile) => profile.command_ids.length > 0);

  return {
    launch_commands: commands,
    launch_profiles: [...keptProfiles, ...generatedProfiles],
  };
}

/** Apply a parsed explore result to the repo, preserving icon/color when absent or invalid. */
async function applyResultToRepo(repoId: string, result: RepoExploreResult): Promise<void> {
  const list = get(repos).list;
  const index = list.findIndex((repo) => repo.id === repoId);
  if (index < 0) return;
  const repo = list[index];

  const icon = result.icon && REPO_ICON_NAMES.includes(result.icon) ? result.icon : repo.icon;
  // The real logo is a bonus: a missing/unusable file just leaves the curated
  // icon in place, and a previously found one is kept rather than cleared.
  const iconImage = result.iconImagePath
    ? await loadRepoIconImage(repo.path, result.iconImagePath)
    : null;

  void repos.updateRepo(index, {
    description: result.description,
    keywords: result.keywords,
    vocabulary: result.vocabulary,
    icon,
    icon_image: iconImage || repo.icon_image,
    color: result.color || repo.color,
    ...(result.commands.length > 0 ? mergeLaunchSetup(repo, result) : {}),
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

  // A cheap mid-tier family, at its newest version in the live catalog, so
  // exploration picks up new releases without a code change.
  const model =
    provider === 'openai'
      ? (newestModelInFamily('openai', 'terra') ?? DEFAULT_OPENAI_MODEL_ID)
      : (newestModelInFamily('claude', 'sonnet') ?? DEFAULT_MODEL_ID);
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
      // Applying is async (the icon image is read off disk); settle only once
      // the repo has actually been updated.
      void applyResultToRepo(repoId, result).then(
        () => resolveSettled(true),
        (err) => {
          console.warn('[repoExplore] Failed to apply explore result', err);
          resolveSettled(false);
        }
      );
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
