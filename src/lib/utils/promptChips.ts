/**
 * Toggleable prompt chips ("search web", "scan codebase", ...) that get
 * appended to a prompt on a new line, comma-separated, right before sending.
 * The chip set is user-defined in Settings (`settings.prompt_chips`).
 */

/** Append the selected chip labels to a prompt on a new line, comma-separated. */
export function appendChips(prompt: string, chips: string[] | undefined | null): string {
  const selected = (chips ?? []).map((c) => c.trim()).filter(Boolean);
  if (selected.length === 0) return prompt;
  return `${prompt.trimEnd()}\n\n${selected.join(', ')}`;
}

/** Union of chip selections across several sources, preserving first-seen order. */
export function mergeChips(...groups: (string[] | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const chip of group ?? []) {
      if (!seen.has(chip)) {
        seen.add(chip);
        out.push(chip);
      }
    }
  }
  return out;
}
