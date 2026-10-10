// Formatting for "reply to a selection" quotes.
//
// A quote is plain draft text — not a structured attachment — so it rides every
// existing send path for free (send now, session/repo idle, 5h reset, scheduled
// turns, record-and-send, quick-action combines) and persists with the draft.
//
// Deliberate shape: a quote is always exactly ONE new row. Newlines and
// indentation inside the selection collapse to single spaces so quoting a long
// stack trace never buries the prompt the user is about to write.

/** Characters kept from a selection before the quote is truncated. */
export const QUOTE_MAX_CHARS = 1200;

/**
 * Cap for a whole-message reply. The agent already has the message in context,
 * so the quote only needs to say which one — the full text would bury the draft.
 */
export const QUOTE_MESSAGE_MAX_CHARS = 300;

/** Minimum selection length that produces a reply affordance (suppresses stray drags). */
export const QUOTE_MIN_CHARS = 3;

export interface QuoteFormatOptions {
  /** Selection came from a <pre>/<code> subtree — render as inline code. */
  isCode?: boolean;
  /** Short provenance label, e.g. "Bash output". */
  sourceLabel?: string;
  maxChars?: number;
}

/**
 * Turn a raw selection into the single blockquote row inserted into the draft.
 * Returns an empty string when the selection is only whitespace.
 */
export function formatQuote(
  text: string,
  opts: QuoteFormatOptions = {}
): string {
  const { isCode = false, sourceLabel, maxChars = QUOTE_MAX_CHARS } = opts;

  let body = text.replace(/\s+/g, " ").trim();
  if (!body) return "";
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars).trimEnd()}…`;
  }
  if (isCode) body = inlineCode(body);

  return `> ${sourceLabel ? `${sourceLabel}: ` : ""}${body}`;
}

/**
 * Wrap code in an inline span whose backtick fence is longer than any run inside
 * it (and padded when the code itself starts/ends with a backtick), so quoted
 * code containing backticks doesn't break out of the span.
 */
function inlineCode(code: string): string {
  const longestRun = (code.match(/`+/g) ?? []).reduce(
    (n, run) => Math.max(n, run.length),
    0
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}
