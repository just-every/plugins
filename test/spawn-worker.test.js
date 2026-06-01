"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine, mockOpts, withMockEnv, freshCounterPath } = require("./helpers/env.js");
const { spawnWorker, createContext } = engine;

test("happy path: completed, schema_valid, thread_id, usage from mock", async () => {
  const usage = { input_tokens: 11, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 2 };
  const r = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, async () => {
    const ctx = createContext({ concurrency: 2 });
    return spawnWorker("prompt", { ...mockOpts(), ctx });
  });
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.schema_valid, true);
  assert.ok(/^th_mock_/.test(r.thread_id), `thread_id ${r.thread_id}`);
  assert.deepStrictEqual(r.usage, usage);
});

test("schema-retry recovers: invalid first, valid after, logs schema-retry", async () => {
  const counter = freshCounterPath();
  const events = [];
  const r = await withMockEnv(
    { MOCK_CODEX_INVALID_FIRST: "1", MOCK_CODEX_COUNTER: counter },
    async () => {
      const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
      return spawnWorker("prompt", { ...mockOpts(), ctx });
    }
  );
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.schema_valid, true, "recovers to valid after retry");
  const retryLog = events.find((e) => e.type === "log" && e.data && e.data.reason === "schema-retry");
  assert.ok(retryLog, "a schema-retry log must fire");
});

test("retries exhausted: schema invalid every time => schema_valid false but completed", async () => {
  const r = await withMockEnv(
    { MOCK_CODEX_RESPONSE: JSON.stringify({ summary: 42 }) },
    async () => {
      const ctx = createContext({ concurrency: 1 });
      // schemaRetries default for WORKER_SCHEMA is 1; invalid persists.
      return spawnWorker("prompt", { ...mockOpts(), ctx });
    }
  );
  assert.strictEqual(r.status, "completed", "best-effort accept keeps status completed");
  assert.strictEqual(r.schema_valid, false);
});

test("failure: exit!=0 => failed, error contains stderr, usage still accounted", async () => {
  const usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
  const ctx = createContext({ concurrency: 1 });
  const r = await withMockEnv(
    {
      MOCK_CODEX_EXIT: "3",
      MOCK_CODEX_STDERR: "boom-from-stderr",
      MOCK_CODEX_USAGE: JSON.stringify(usage)
    },
    async () => spawnWorker("prompt", { ...mockOpts(), ctx })
  );
  assert.strictEqual(r.status, "failed");
  assert.ok(/boom-from-stderr/.test(r.error), `error should contain stderr: ${r.error}`);
  // Events emitted before exit => usage accounted even on failure.
  assert.strictEqual(ctx.usageTotals.input_tokens, 100);
  assert.strictEqual(ctx.usageTotals.output_tokens, 5);
});

test("budget cap: second worker fails with 'token budget exhausted'", async () => {
  const usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const results = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, async () => {
    const ctx = createContext({ concurrency: 1, budgetTokens: 50 });
    const first = await spawnWorker("p1", { ...mockOpts(), ctx });
    const second = await spawnWorker("p2", { ...mockOpts(), ctx });
    return [first, second];
  });
  assert.strictEqual(results[0].status, "completed");
  assert.strictEqual(results[1].status, "failed");
  assert.ok(/token budget exhausted/.test(results[1].error), results[1].error);
});

test("maxAgents cap: second worker fails with 'lifetime agent cap 1 reached'", async () => {
  const results = await withMockEnv({}, async () => {
    const ctx = createContext({ concurrency: 1, maxAgents: 1 });
    const first = await spawnWorker("p1", { ...mockOpts(), ctx });
    const second = await spawnWorker("p2", { ...mockOpts(), ctx });
    return [first, second];
  });
  assert.strictEqual(results[0].status, "completed");
  assert.strictEqual(results[1].status, "failed");
  assert.ok(/lifetime agent cap 1 reached/.test(results[1].error), results[1].error);
});

test("raw-text worker (schema:null): value is the trimmed string", async () => {
  const r = await withMockEnv({ MOCK_CODEX_RESPONSE: "  just raw text  " }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts({ schema: null }), ctx });
  });
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.value, "just raw text");
});
