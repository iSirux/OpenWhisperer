import { test } from "node:test";
import assert from "node:assert/strict";
import { capToolOutput, TOOL_OUTPUT_DISPLAY_CAP as CAP } from "./toolOutputCap";

test("small and just-over-limit outputs pass through untouched", () => {
  assert.equal(capToolOutput("hello"), "hello");
  const nearLimit = "x".repeat(CAP.head + CAP.tail + CAP.minSaved);
  assert.equal(capToolOutput(nearLimit), nearLimit);
});

test("large output keeps head and tail with a size marker", () => {
  const input = "H".repeat(CAP.head) + "M".repeat(100 * 1024) + "T".repeat(CAP.tail);
  const out = capToolOutput(input);
  assert.ok(out.length < CAP.head + CAP.tail + 200);
  assert.ok(out.startsWith("H".repeat(CAP.head)));
  assert.ok(out.endsWith("T".repeat(CAP.tail)));
  assert.match(out, /\[100 KB truncated for display/);
  assert.ok(!out.includes("M"));
});

test("cuts snap to line breaks", () => {
  const line = "0123456789abcdef\n"; // 17 chars
  const input = line.repeat(Math.ceil((200 * 1024) / line.length));
  const out = capToolOutput(input);
  const [head, rest] = out.split("\n… [");
  const tail = rest.slice(rest.indexOf("] …\n") + 4);
  assert.ok(head.endsWith("\n"), "head ends on a whole line");
  assert.ok(tail.startsWith("0123"), "tail starts on a whole line");
  assert.ok(tail.endsWith(line));
});

test("never splits a surrogate pair at a cut", () => {
  // 2 UTF-16 units each, no newlines; pad to hit both cut parities.
  for (const [pre, post] of [["", ""], ["a", ""], ["", "a"], ["a", "a"]]) {
    const out = capToolOutput(pre + "😀".repeat(40 * 1024) + post);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out), "no lone high surrogate");
    assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), "no lone low surrogate");
  }
});
