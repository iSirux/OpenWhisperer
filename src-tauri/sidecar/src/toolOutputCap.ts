/**
 * Display cap for tool-result text forwarded to the app.
 *
 * The agent has already consumed the full result by the time we forward it, so
 * this only trims the copy the app renders and persists with the session. Left
 * uncapped, single results (a big Read, a verbose test run) reach ~200 KB and a
 * busy session carries 10+ MB of tool output that every save re-serializes.
 *
 * Nothing downstream parses tool_result text: the frontend only renders it (and
 * restores it into history, which `formatConversationHistory` truncates to 500 chars
 * anyway); plan approval / AskUserQuestion answers ride their own events, and
 * validation agents read results straight off the SDK stream. Images are
 * separate (`images`) and shrunk by the backend, never touched here.
 */
export const TOOL_OUTPUT_DISPLAY_CAP = {
  /** Leading characters kept. */
  head: 40 * 1024,
  /** Trailing characters kept (errors and summaries usually land at the end). */
  tail: 8 * 1024,
  /** Only truncate when it saves at least this much — avoids a marker for a few bytes. */
  minSaved: 4 * 1024,
  /** How far a cut may move to land on a line break. */
  lineSnap: 1024,
} as const;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Cap `output` to head + tail with a marker in between; returns it unchanged when small. */
export function capToolOutput(output: string, cap = TOOL_OUTPUT_DISPLAY_CAP): string {
  if (output.length <= cap.head + cap.tail + cap.minSaved) return output;

  // Snap the head cut back to a line break, and the tail cut forward to one, so
  // the kept halves read as whole lines.
  let headEnd = cap.head;
  const nl = output.lastIndexOf("\n", headEnd);
  if (nl > headEnd - cap.lineSnap) headEnd = nl + 1;
  else if (isHighSurrogate(output.charCodeAt(headEnd - 1))) headEnd--;

  let tailStart = output.length - cap.tail;
  const tnl = output.indexOf("\n", tailStart);
  if (tnl !== -1 && tnl < tailStart + cap.lineSnap) tailStart = tnl + 1;
  else if (isHighSurrogate(output.charCodeAt(tailStart - 1))) tailStart++;

  const droppedKb = Math.max(1, Math.round((tailStart - headEnd) / 1024));
  return (
    output.slice(0, headEnd) +
    `\n… [${droppedKb} KB truncated for display — the agent saw the full output] …\n` +
    output.slice(tailStart)
  );
}
