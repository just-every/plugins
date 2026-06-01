"use strict";

// End-to-end tests for the opt-in app-server transport, driven entirely by the
// mock `codex app-server` (no real CLI, no API cost). Asserts:
//   * transport:'app-server' returns the SAME workflow-record shape as exec, with
//     correctly normalized (camelCase->snake_case) aggregate usage.
//   * the assembled value (streamed agentMessage deltas -> parsed JSON) is right.
//   * a transport:'exec-server' worker throws the explicit not-implemented error.
//   * an app-server initialize failure transparently falls back to the exec path
//     (and emits a worker.transport_fallback event), unless transport_strict.

const test = require("node:test");
const assert = require("node:assert");

const { engine, MOCK, mockOpts, withMockEnv, withCodexHome, freshTmpDir } = require("./helpers/env.js");
const { spawnWorker, createContext, runWorkflow } = engine;

test("app-server transport: spawnWorker completes, parses streamed value, normalizes usage", async () => {
  const r = await withMockEnv({}, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), transport: "app-server", ctx });
  });
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.schema_valid, true);
  assert.strictEqual(r.thread_id, "th_appserver_mock_1");
  assert.strictEqual(r.value.summary, "mock summary");
  // DEFAULT_USAGE camelCase -> snake_case; total excludes cached per addUsageInto.
  assert.deepStrictEqual(r.usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 3,
    total_tokens: 18
  });
});

test("app-server transport: aggregate usage matches the exec-path math (cached excluded)", async () => {
  const r = await withCodexHome(async (home) => {
    return withMockEnv({}, async () =>
      runWorkflow({
        workers_spec: [
          { prompt: "a", schema: null },
          { prompt: "b", schema: null }
        ],
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 1,
        transport: "app-server"
      })
    );
  });
  assert.strictEqual(r.status, "completed");
  // Two workers, each input 10 / output 5 / reasoning 3 => totals double; the
  // engine's total_tokens excludes cached_input_tokens (10+5+3)*2 = 36.
  assert.strictEqual(r.aggregate_usage.input_tokens, 20);
  assert.strictEqual(r.aggregate_usage.output_tokens, 10);
  assert.strictEqual(r.aggregate_usage.reasoning_output_tokens, 6);
  assert.strictEqual(r.aggregate_usage.total_tokens, 36);
  // Non-default transport is journaled into options.
  assert.strictEqual(r.options.transport, "app-server");
});

test("app-server transport: raw-text worker (schema:null) value is the trimmed string", async () => {
  const r = await withMockEnv({ MOCK_CODEX_RESPONSE: "  raw app-server text  " }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts({ schema: null }), transport: "app-server", ctx });
  });
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.value, "raw app-server text");
});

test("app-server transport: schema validation + retry still apply on the assembled message", async () => {
  // Invalid JSON shape (wrong type) is accepted best-effort after the single
  // schema retry, exactly like the exec path — proving schema enforcement is
  // transport-agnostic (validateAgainstSchema runs on the accumulated message).
  const r = await withMockEnv({ MOCK_CODEX_RESPONSE: JSON.stringify({ summary: 42 }) }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), transport: "app-server", ctx });
  });
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.schema_valid, false);
});

test("exec-server transport throws the explicit not-implemented error (no spawn)", async () => {
  const r = await withMockEnv({}, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), transport: "exec-server", ctx });
  });
  // spawnWorker never throws; the not-implemented error surfaces as a failed
  // worker whose message names exec-server.
  assert.strictEqual(r.status, "failed");
  assert.ok(/exec-server.*not yet implemented/i.test(r.error), r.error);
});

test("app-server initialize failure transparently falls back to exec (event emitted)", async () => {
  const events = [];
  const r = await withMockEnv({ MOCK_APPSERVER_FAIL_INIT: "1" }, async () => {
    const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
    return spawnWorker("prompt", { ...mockOpts(), transport: "app-server", ctx });
  });
  // The exec path then completes normally with the default valid response.
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.schema_valid, true);
  assert.ok(
    events.some((e) => e.type === "worker.transport_fallback"),
    "a worker.transport_fallback event must fire"
  );
  assert.ok(
    events.some((e) => e.type === "log" && e.data && e.data.reason === "transport-fallback"),
    "a transport-fallback narrator log must fire"
  );
});

test("transport_strict: an app-server failure errors instead of falling back", async () => {
  const r = await withMockEnv({ MOCK_APPSERVER_FAIL_INIT: "1" }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", {
      ...mockOpts(),
      transport: "app-server",
      transport_strict: true,
      ctx
    });
  });
  assert.strictEqual(r.status, "failed");
  assert.ok(/app-server error/i.test(r.error), r.error);
});

test("app-server thread/start with no thread id rejects -> falls back to exec", async () => {
  const r = await withMockEnv({ MOCK_APPSERVER_NO_THREAD: "1" }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), transport: "app-server", ctx });
  });
  assert.strictEqual(r.status, "completed", "falls back to exec and completes");
});

test("the mock app-server records an 'app-server' invocation in the session log", async () => {
  const { freshSessionDir, readInvocations } = require("./helpers/env.js");
  const sessionDir = freshSessionDir();
  await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), transport: "app-server", ctx });
  });
  const invocations = readInvocations(sessionDir);
  assert.ok(
    invocations.some((i) => i.subcommand === "app-server"),
    "an app-server invocation was recorded"
  );
  // And NO exec invocation happened (the app-server path succeeded, no fallback).
  assert.ok(!invocations.some((i) => i.subcommand === "exec"), "no exec fallback occurred");
  freshTmpDir; // referenced to keep import tidy in case of future use
});
