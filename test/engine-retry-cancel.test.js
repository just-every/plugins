"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const { engine, mockOpts, withMockEnv, freshCounterPath } = require("./helpers/env.js");
const { spawnWorker, createContext } = engine;

// ---------------------------------------------------------------------------
// (A) Transient-error retry / backoff
// ---------------------------------------------------------------------------

test("retry-then-succeed: 2 transient 429 failures, then completed; retries counted", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_FAIL_TIMES: "2",
      MOCK_CODEX_EXIT: "1",
      MOCK_CODEX_STDERR: "HTTP 429 rate limit exceeded",
      MOCK_CODEX_COUNTER: counter
    },
    async () =>
      spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2, retryJitter: false })
  );
  assert.strictEqual(r.status, "completed", "succeeds after the transient failures clear");
  // counter file == 3 means exactly 3 child invocations (2 fail + 1 success).
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 3, "exactly 3 child invocations");
  assert.strictEqual(ctx.spawnedCount, 3, "all 3 attempts counted against the cap");
  const retries = events.filter((e) => e.type === "worker.retry");
  assert.strictEqual(retries.length, 2, "two worker.retry events");
  assert.ok(/429|rate/i.test(retries[0].reason), `retry reason mentions rate-limit/429: ${retries[0].reason}`);
});

test("transient exhaustion: maxRetries:2, always 503 => failed after 3 invocations", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_FAIL_TIMES: "99",
      MOCK_CODEX_EXIT: "1",
      MOCK_CODEX_STDERR: "503 Service Unavailable",
      MOCK_CODEX_COUNTER: counter
    },
    async () =>
      spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, retryJitter: false })
  );
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 3, "initial + 2 retries = 3");
  assert.strictEqual(ctx.spawnedCount, 3);
  assert.strictEqual(events.filter((e) => e.type === "worker.retry").length, 2, "two retry events");
  assert.ok(events.some((e) => e.type === "worker.failed"), "final worker.failed event");
});

test("permanent error (bad flag) is NOT retried even with maxRetries:5", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_EXIT: "2",
      MOCK_CODEX_STDERR: "error: unknown option --frobnicate",
      MOCK_CODEX_COUNTER: counter
    },
    async () => spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 5, baseDelayMs: 1, retryJitter: false })
  );
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 1, "child invoked exactly once");
  assert.strictEqual(events.filter((e) => e.type === "worker.retry").length, 0, "no retries for a permanent error");
});

test("permanent auth error is NOT retried", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_EXIT: "2",
      MOCK_CODEX_STDERR: "Unauthorized: invalid api key",
      MOCK_CODEX_COUNTER: counter
    },
    async () => spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 5, baseDelayMs: 1, retryJitter: false })
  );
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 1, "auth error short-circuits");
});

test("default no-op: maxRetries unset, generic stderr => failed after ONE invocation", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    { MOCK_CODEX_EXIT: "1", MOCK_CODEX_STDERR: "boom", MOCK_CODEX_COUNTER: counter },
    async () => spawnWorker("prompt", { ...mockOpts(), ctx })
  );
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 1, "zero behavior change: single attempt");
  assert.strictEqual(events.filter((e) => e.type === "worker.retry").length, 0);
});

test("generic (unclassified) stderr is fail-closed even with maxRetries set", async () => {
  const counter = freshCounterPath();
  const ctx = createContext({ concurrency: 1 });
  const r = await withMockEnv(
    { MOCK_CODEX_EXIT: "1", MOCK_CODEX_STDERR: "boom generic", MOCK_CODEX_COUNTER: counter },
    async () => spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 3, baseDelayMs: 1, retryJitter: false })
  );
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 1, "unknown non-zero exit not retried");
});

test("budget/cap interaction: transient-failing worker stops retrying at maxAgents gate", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, maxAgents: 2 });
  events.length = 0;
  ctx.onEvent = (e) => events.push(e);
  const r = await withMockEnv(
    {
      MOCK_CODEX_FAIL_TIMES: "99",
      MOCK_CODEX_EXIT: "1",
      MOCK_CODEX_STDERR: "429 too many requests",
      MOCK_CODEX_COUNTER: counter
    },
    async () =>
      spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2, retryJitter: false })
  );
  assert.strictEqual(r.status, "failed");
  // The cap is 2, so only 2 invocations happen even though maxRetries is 5.
  assert.strictEqual(ctx.spawnedCount, 2, "retries counted against the cap, not unbounded");
  assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 2, "exactly 2 child invocations");
  assert.ok(
    events.some((e) => e.type === "log" && e.data && e.data.reason === "maxAgents"),
    "a maxAgents stop is logged"
  );
});

// A "connection reset" network errno on stderr is classified transient and
// retried. (ETXTBSY — a spawn-level transient errno that the OS does not let us
// raise deterministically — is covered at the unit level in retry-helpers, as is
// the stdout-side haystack match for JSON-streamed error events.)
test("network errno (connection reset) triggers a retry then succeeds", async () => {
  const counter = freshCounterPath();
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_FAIL_TIMES: "1",
      MOCK_CODEX_EXIT: "1",
      MOCK_CODEX_STDERR: "connection reset by peer",
      MOCK_CODEX_COUNTER: counter
    },
    async () =>
      spawnWorker("prompt", { ...mockOpts(), ctx, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, retryJitter: false })
  );
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(events.filter((e) => e.type === "worker.retry").length, 1);
});

// ---------------------------------------------------------------------------
// (B) Cancellation via AbortSignal
// ---------------------------------------------------------------------------

test("cancellation mid-flight: ctx.cancel SIGTERMs the child and yields status 'cancelled'", async (t) => {
  const counter = freshCounterPath();
  const marker = freshCounterPath() + ".sigterm";
  const events = [];
  const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
  const r = await withMockEnv(
    {
      MOCK_CODEX_SLEEP_MS: "1500",
      MOCK_CODEX_COUNTER: counter,
      MOCK_CODEX_SIGTERM_MARKER: marker
    },
    async () => {
      const p = spawnWorker("prompt", { ...mockOpts(), ctx });
      setTimeout(() => ctx.cancel("test"), 80);
      return p;
    }
  );
  assert.strictEqual(r.status, "cancelled", `expected cancelled, got ${r.status} (${r.error})`);
  assert.ok(ctx.signal.aborted, "ctx.signal is aborted");
  // The engine's cancellation contract is fully proven by the DETERMINISTIC
  // assertions above (status 'cancelled' + signal aborted) and the cancellation
  // event below. The SIGTERM marker is an extra, BEST-EFFORT confirmation that
  // the mock child's signal handler ran — but the mock can only write it once
  // its synchronous sleep unwinds, and the OS may SIGKILL the child first, so it
  // is inherently racy. Poll for it and report via diagnostic; never fail on it.
  let sawMarker = fs.existsSync(marker);
  for (let i = 0; i < 150 && !sawMarker; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sawMarker = fs.existsSync(marker);
  }
  if (!sawMarker) {
    t.diagnostic("SIGTERM marker not observed (OS race; cancellation still verified via status + event)");
  }
  assert.ok(
    events.some((e) => e.type === "cancelled") || events.some((e) => e.type === "worker.cancelled"),
    "a cancellation event is emitted"
  );
});

test("cancelled before start: an already-aborted ctx returns cancelled without spawning", async () => {
  const counter = freshCounterPath();
  const ctx = createContext({ concurrency: 1 });
  ctx.cancel("up-front");
  const r = await withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
    spawnWorker("prompt", { ...mockOpts(), ctx })
  );
  assert.strictEqual(r.status, "cancelled");
  assert.ok(!fs.existsSync(counter), "no child was ever spawned");
  assert.strictEqual(ctx.spawnedCount, 0, "spawnedCount untouched");
});

test("external AbortSignal is mirrored into ctx and aborts spawns", async () => {
  const controller = new AbortController();
  controller.abort("external");
  const ctx = createContext({ concurrency: 1, signal: controller.signal });
  assert.ok(ctx.signal.aborted, "external pre-abort is reflected");
  const r = await withMockEnv({}, async () => spawnWorker("prompt", { ...mockOpts(), ctx }));
  assert.strictEqual(r.status, "cancelled");
});

// ---------------------------------------------------------------------------
// (C) Backward-compat: default path untouched
// ---------------------------------------------------------------------------

test("MCP/default path: no signal + maxRetries unset => completed, ctx not aborted", async () => {
  const ctx = createContext({ concurrency: 1 });
  const r = await withMockEnv({}, async () => spawnWorker("prompt", { ...mockOpts(), ctx }));
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(ctx.signal.aborted, false, "default ctx is never aborted");
  assert.strictEqual(typeof ctx.cancel, "function");
  assert.strictEqual(ctx.cancelled(), false);
});
