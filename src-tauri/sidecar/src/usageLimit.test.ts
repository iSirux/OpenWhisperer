// Run: npx tsx --test src/usageLimit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageLimitAtSuccess } from "./usageLimit";

const rejected = { status: "rejected", resetsAt: 1_795_503_600 };

test("rate_limit message last, then a success result: the turn was cut off, report the limit", () => {
  // 9ece8314, 11-17 17:20:21: tool result → rate_limit_event → assistant(error: rate_limit) → result(success)
  assert.deepEqual(usageLimitAtSuccess(rejected, true), rejected);
});

test("the turn recovered after the rate_limit message: a recorded limit is stale", () => {
  assert.equal(usageLimitAtSuccess(rejected, false), undefined);
});

test("no limit recorded: nothing to report", () => {
  assert.equal(usageLimitAtSuccess(undefined, true), undefined);
  assert.equal(usageLimitAtSuccess(undefined, false), undefined);
});
