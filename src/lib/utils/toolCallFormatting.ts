export interface PowerShellFileSlice {
  filePath: string;
  startLine: number;
  endLine: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isShellTool(tool: string): boolean {
  const normalized = tool.toLowerCase();
  return normalized === 'bash' || normalized.includes('shell');
}

function normalizeCommand(command: string): string {
  return command.replace(/\\"/g, '"').trim();
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatPath(path: string | undefined): string {
  if (!path) return '';
  const parts = path.replace(/\\/g, '/').split('/');
  const filename = parts.pop() || path;
  if (parts.length > 0) {
    const parent = parts.pop();
    return `${parent}/${filename}`;
  }
  return filename;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

function parsePowerShellFileSlice(command: string): PowerShellFileSlice | null {
  const normalized = normalizeCommand(command);
  const pathMatch = normalized.match(/['"]((?:src|\.\/src)[\\/][^'"]+?)['"]/i);
  if (!pathMatch) return null;

  const startMatch = normalized.match(/\$start\s*=\s*(\d+)/i);
  const endMinMatch = normalized.match(
    /\$end\s*=\s*\[Math\]::Min\(\$c\.Length-1,\s*(\d+)\)/i
  );
  const endMatch = normalized.match(/\$end\s*=\s*(\d+)/i);

  if (!startMatch) return null;

  const start = Number(startMatch[1]);
  const end = Number((endMinMatch || endMatch)?.[1] ?? start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  // The common Codex-generated PowerShell snippet prints using ($i + 1),
  // so these offsets are zero-based in the script and one-based to display.
  return {
    filePath: pathMatch[1],
    startLine: start + 1,
    endLine: end + 1,
  };
}

function getBashSummary(input: Record<string, unknown>, maxLen: number): string {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return '';

  const fileSlice = parsePowerShellFileSlice(command);
  if (fileSlice) {
    return `${formatPath(fileSlice.filePath)}:${fileSlice.startLine}-${fileSlice.endLine}`;
  }

  return truncate(normalizeInlineWhitespace(normalizeCommand(command)), maxLen);
}

export function getToolCallSummary(
  tool: string,
  input: Record<string, unknown> | undefined,
  maxLen = 60
): string {
  if (!input) return '';

  if (isShellTool(tool)) {
    return getBashSummary(input, maxLen);
  }

  switch (tool) {
    case 'Read':
      return formatPath(input.file_path as string);
    case 'Write':
      return formatPath(input.file_path as string);
    case 'Edit':
      return formatPath(input.file_path as string);
    case 'Grep':
      return `"${truncate(String(input.pattern || ''), Math.max(1, maxLen - 2))}"`;
    case 'Glob':
      return truncate(String(input.pattern || ''), maxLen);
    case 'WebFetch':
      return truncate(String(input.url || ''), maxLen);
    case 'WebSearch':
      return `"${truncate(String(input.query || ''), Math.max(1, maxLen - 2))}"`;
    case 'Skill':
      return truncate(String(input.skill || ''), maxLen);
    case 'Task':
      return truncate(
        String(input.description || input.prompt || ''),
        maxLen
      );
    case 'TodoWrite': {
      const todos = input.todos as Array<{ content: string }> | undefined;
      return todos?.length
        ? `${todos.length} item${todos.length > 1 ? 's' : ''}`
        : '';
    }
    case 'NotebookEdit':
      return formatPath(input.notebook_path as string);
    default:
      return '';
  }
}

export function formatToolCallInput(
  tool: string | undefined,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return '';

  if (tool && isShellTool(tool) && typeof input.command === 'string') {
    const command = normalizeCommand(input.command);
    const fileSlice = parsePowerShellFileSlice(command);

    if (!fileSlice) return command;

    return [
      command,
      '',
      'Detected file slice:',
      `File: ${fileSlice.filePath}`,
      `Lines: ${fileSlice.startLine}-${fileSlice.endLine}`,
    ].join('\n');
  }

  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return isRecord(input) ? String(input) : '';
  }
}
