/**
 * Builds the `intent` string handed to a validation run: the user's objective /
 * decisions / constraints for the work on this session's branch.
 *
 * Composed from the session's AI metadata (name + outcome, when available) plus
 * ALL of the session's user messages verbatim (most recent last). The result is
 * capped (~6000 chars); oldest whole segments are dropped first, with a marker.
 * Unlike a one-line summary, user messages keep their original formatting so the
 * reviewer sees the real intent. Never returns empty.
 */
import type { SdkSession } from '$lib/stores/sdkSessions';

const CAP = 6000;
const SEP = '\n\n';
const MARKER = '[earlier context truncated]\n\n';
const FALLBACK = 'Validate and ship the committed changes on this branch.';

export function buildValidationIntent(session: SdkSession): string {
  const segments: string[] = [];

  // Lead with whatever summary-ish metadata we have (name + outcome).
  const meta = session.aiMetadata;
  const metaSummary = [meta?.name, meta?.outcome]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .map((v) => v.trim())
    .join(' — ');
  if (metaSummary) segments.push(metaSummary);

  // Then the user's own messages, verbatim, in order (most recent last).
  for (const msg of session.messages) {
    if (msg.type === 'user' && msg.content && msg.content.trim()) {
      segments.push(msg.content.trim());
    }
  }

  if (segments.length === 0) return FALLBACK;

  let truncated = false;
  // Drop oldest whole segments until we fit, always keeping the most recent.
  while (segments.length > 1 && segments.join(SEP).length > CAP) {
    segments.shift();
    truncated = true;
  }

  let intent = segments.join(SEP);
  if (intent.length > CAP) {
    // A single remaining segment is still too long — keep its tail.
    intent = intent.slice(intent.length - (CAP - MARKER.length));
    truncated = true;
  }
  if (truncated) intent = MARKER + intent;

  intent = intent.trim();
  return intent.length > 0 ? intent : FALLBACK;
}
