/**
 * Builds the `--intent` string handed to the no-mistakes pipeline: the user's
 * objective / decisions / constraints for the work on this session's branch.
 *
 * Composed from the session's AI metadata (a short summary of what it did, when
 * available) plus the session's user messages (most recent last). The whole
 * thing is collapsed to a single line and capped; oldest context is truncated
 * first. Never returns empty.
 */
import type { SdkSession } from '$lib/stores/sdkSessions';

const CAP = 1500;
const SEP = ' — ';
const MARKER = '[earlier context truncated] ';
const FALLBACK = 'Validate and ship the committed changes on this branch.';

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildIntent(session: SdkSession): string {
  const segments: string[] = [];

  // Lead with whatever summary-ish metadata we have (title + outcome).
  const meta = session.aiMetadata;
  const metaSummary = [meta?.name, meta?.outcome]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .map(collapse)
    .join(SEP);
  if (metaSummary) segments.push(metaSummary);

  // Then the user's own messages, in order (most recent last).
  for (const msg of session.messages) {
    if (msg.type === 'user' && msg.content && msg.content.trim()) {
      segments.push(collapse(msg.content));
    }
  }

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
