"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { sumUsageFromWorkers } = engine;

test("sumUsageFromWorkers sums per-key and excludes cached from total_tokens", () => {
  const workers = [
    {
      usage: {
        input_tokens: 2,
        cached_input_tokens: 1,
        output_tokens: 3,
        reasoning_output_tokens: 4
      }
    },
    {
      usage: {
        input_tokens: 3,
        cached_input_tokens: 2,
        output_tokens: 4,
        reasoning_output_tokens: 5
      }
    },
    { usage: null }, // worker with null usage
    null // null worker
  ];
  const totals = sumUsageFromWorkers(workers);
  assert.strictEqual(totals.input_tokens, 5);
  assert.strictEqual(totals.cached_input_tokens, 3);
  assert.strictEqual(totals.output_tokens, 7);
  assert.strictEqual(totals.reasoning_output_tokens, 9);
  // total_tokens = input + output + reasoning (NOT cached) = 5 + 7 + 9 = 21
  assert.strictEqual(totals.total_tokens, 21);
});

test("emptyUsage shape is stable: summing [] yields all-zero usage", () => {
  const totals = sumUsageFromWorkers([]);
  assert.deepStrictEqual(totals, {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  });
});

test("sumUsageFromWorkers tolerates undefined input", () => {
  const totals = sumUsageFromWorkers(undefined);
  assert.strictEqual(totals.total_tokens, 0);
});
