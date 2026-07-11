import type { GitHubIssue, GitHubIssueDetail } from '$lib/stores/repoIssues';

/**
 * Turning GitHub issues into sessions (repo Issues view).
 * Mirrors pileActions.ts: action definitions + prompt composition.
 */

export type IssueLaunchAction = 'implement' | 'plan' | 'discuss';

export const ISSUE_ACTIONS: {
  id: IssueLaunchAction;
  label: string;
  description: string;
  worktree: boolean;
}[] = [
  {
    id: 'implement',
    label: 'Implement',
    description: 'Implement the issue and reference it from the PR',
    worktree: true,
  },
  {
    id: 'plan',
    label: 'Plan first',
    description: 'Ask for an implementation plan before any code',
    worktree: true,
  },
  {
    id: 'discuss',
    label: 'Discuss',
    description: 'Talk through the issue before touching code',
    worktree: false,
  },
];

const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 1200;
const MAX_BODY_CHARS = 6000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

/** The issue content block shared by all action prompts. */
function issueContent(issue: GitHubIssue, detail: GitHubIssueDetail | null): string {
  const lines: string[] = [issue.url];
  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
  }

  const body = detail?.body?.trim();
  lines.push('', '--- Issue description ---', body ? truncate(body, MAX_BODY_CHARS) : '(no description)');

  const comments = detail?.comments ?? [];
  if (comments.length > 0) {
    const shown = comments.slice(-MAX_COMMENTS);
    lines.push('', `--- Comments (${comments.length}${shown.length < comments.length ? `, last ${shown.length}` : ''}) ---`);
    for (const c of shown) {
      lines.push(`@${c.author || 'unknown'}:`, truncate(c.body.trim(), MAX_COMMENT_CHARS), '');
    }
  }
  return lines.join('\n');
}

/**
 * Compose the launch prompt for an issue action. `detail` carries the full
 * body/comments (fetched at launch time); when null, the prompt tells the
 * agent to read the issue itself via gh.
 */
export function composeIssuePrompt(
  action: IssueLaunchAction,
  issue: GitHubIssue,
  detail: GitHubIssueDetail | null
): string {
  const content = detail
    ? issueContent(issue, detail)
    : `${issue.url}\n\nRead the full issue (body and comments) with \`gh issue view ${issue.number} --comments\` first.`;

  switch (action) {
    case 'implement':
      return (
        `Implement GitHub issue #${issue.number}: ${issue.title}\n\n${content}\n\n` +
        `When you commit or open a PR for this work, include "Fixes #${issue.number}" in the message so GitHub links and closes the issue.`
      );
    case 'plan':
      return (
        `Implement GitHub issue #${issue.number}: ${issue.title}\n\n${content}\n\n` +
        `When you commit or open a PR for this work, include "Fixes #${issue.number}" in the message so GitHub links and closes the issue.\n\n` +
        `Before writing any code, make a detailed implementation plan and present it to me first.`
      );
    case 'discuss':
      return (
        `Let's discuss GitHub issue #${issue.number}: ${issue.title} — no code changes yet.\n\n${content}\n\n` +
        `Scan the codebase for relevant context, then share your read on the problem, possible approaches, and open questions.`
      );
  }
}
