/**
 * Builds the fix prompt handed to the session's own agent when the validation
 * pipeline requests a fix (spec §6). Lists the findings (id, severity,
 * file:line, description, any per-finding user instructions) and appends the
 * fixer discipline that keeps fixes small, correct, and scoped.
 */
import type { ValidationFinding } from '$lib/stores/validation';

const FIXER_DISCIPLINE =
  'First double-check each finding is legitimate — if one is wrong, say so and leave the code alone. ' +
  'Prefer the smallest correct root-cause fix. Never resolve a finding by deleting intentional behavior; ' +
  'fix forward. Apply all fixes, then run ONE focused verification of the changed area only — do NOT run ' +
  'the full test or lint suite (the validation pipeline runs them next). Do not add comments explaining the fixes.';

function location(finding: ValidationFinding): string {
  if (!finding.file) return 'no specific file';
  return finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
}

export function buildFixPrompt(findings: ValidationFinding[], instructions?: string): string {
  const lines: string[] = [];
  lines.push(
    'The validation pipeline flagged the following on the changes in this branch. Address them.',
  );
  lines.push('');

  findings.forEach((finding, index) => {
    lines.push(
      `${index + 1}. [${finding.severity}] (${location(finding)}) ${finding.description}`,
    );
    const perFinding = finding.userInstructions?.trim();
    if (perFinding) {
      lines.push(`   Instructions: ${perFinding}`);
    }
  });

  const shared = instructions?.trim();
  if (shared) {
    lines.push('');
    lines.push(`Additional instructions: ${shared}`);
  }

  lines.push('');
  lines.push(FIXER_DISCIPLINE);

  return lines.join('\n');
}
