"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { classifyCodexError, backoffDelay, abortableDelay, resolveWorkerOpts, resolveRetryInput } = engine._internal;

// ---------------------------------------------------------------------------
// classifyCodexError — pure classifier
// ---------------------------------------------------------------------------

function execOf(overrides = {}) {
  return { exit_code: 1, signal: null, timed_out: false, cancelled: false, stdout: "", stderr: "", ...overrides };
}

test("PERMANENT spawn errnos (ENOENT/EACCES/EPERM/ENOTDIR) are not transient", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "ENOTDIR"]) {
    const err = Object.assign(new Error("spawn fail"), { code });
    const c = classifyCodexError(err, null);
    assert.strictEqual(c.transient, false, `${code} must be permanent`);
  }
});

test("ETXTBSY spawn errno IS transient (text-file-busy on a fresh bin)", () => {
  const err = Object.assign(new Error("ETXTBSY"), { code: "ETXTBSY" });
  const c = classifyCodexError(err, null);
  assert.strictEqual(c.transient, true);
  assert.match(c.reason, /ETXTBSY/);
});

test("timed_out is treated as permanent (a retry would re-burn the timeout)", () => {
  const c = classifyCodexError(new Error("timeout"), execOf({ timed_out: true, exit_code: null }));
  assert.strictEqual(c.transient, false);
  assert.match(c.reason, /timed out/);
});

test("retryable patterns (429 / 5xx / rate-limit / network errno) are transient", () => {
  const cases = [
    "HTTP 429 rate limit exceeded",
    "503 Service Unavailable",
    "500 Internal server error",
    "Too Many Requests",
    "ECONNRESET socket hang up",
    "connection refused",
    "the upstream is overloaded, please try again",
    "ETIMEDOUT contacting api"
  ];
  for (const stderr of cases) {
    const c = classifyCodexError(new Error("x"), execOf({ stderr }));
    assert.strictEqual(c.transient, true, `"${stderr}" should be transient`);
  }
});

test("permanent patterns win over retryable ones (auth/schema/usage/bad-flag)", () => {
  const cases = [
    "Unauthorized: invalid api key",
    "authentication failed",
    "Forbidden",
    "permission denied",
    "error: unknown option --foo",
    "unrecognized argument",
    "invalid value for --bar",
    "Usage: codex exec [...]",
    "schema validation error"
  ];
  for (const stderr of cases) {
    const c = classifyCodexError(new Error("x"), execOf({ stderr }));
    assert.strictEqual(c.transient, false, `"${stderr}" should be permanent`);
  }
  // Even when a retryable token co-occurs, permanent wins.
  const mixed = classifyCodexError(new Error("x"), execOf({ stderr: "Unauthorized (429)" }));
  assert.strictEqual(mixed.transient, false);
});

test("retryable signal on stdout is caught (JSON-streamed error events)", () => {
  const c = classifyCodexError(new Error("x"), execOf({ stderr: "", stdout: '{"error":"503 overloaded"}' }));
  assert.strictEqual(c.transient, true);
});

test("fail-closed default: an unknown non-zero exit is NOT transient", () => {
  const c = classifyCodexError(new Error("x"), execOf({ stderr: "boom", exit_code: 1 }));
  assert.strictEqual(c.transient, false);
  assert.strictEqual(c.reason, "non-transient");
});

test("a retryable pattern on a zero-exit run is NOT transient (it parsed fine)", () => {
  const c = classifyCodexError(new Error("read fail"), execOf({ stderr: "429", exit_code: 0 }));
  assert.strictEqual(c.transient, false, "exit 0 => never transient");
});

// ---------------------------------------------------------------------------
// backoffDelay — bounded exponential backoff
// ---------------------------------------------------------------------------

test("backoffDelay without jitter is deterministic exponential, capped at max", () => {
  assert.strictEqual(backoffDelay(0, 10, 1000, false), 10);
  assert.strictEqual(backoffDelay(1, 10, 1000, false), 20);
  assert.strictEqual(backoffDelay(2, 10, 1000, false), 40);
  assert.strictEqual(backoffDelay(3, 10, 1000, false), 80);
  // Cap kicks in.
  assert.strictEqual(backoffDelay(10, 10, 100, false), 100);
});

test("backoffDelay with full jitter stays within [0, exp]", () => {
  for (let i = 0; i < 200; i += 1) {
    const d = backoffDelay(2, 10, 1000, true); // exp = 40
    assert.ok(d >= 0 && d <= 40, `jittered delay ${d} out of [0,40]`);
  }
});

// ---------------------------------------------------------------------------
// abortableDelay — timer that short-circuits on abort
// ---------------------------------------------------------------------------

test("abortableDelay resolves after the delay when not aborted", async () => {
  const start = Date.now();
  await abortableDelay(20, undefined);
  assert.ok(Date.now() - start >= 18, "waited roughly the delay");
});

test("abortableDelay rejects immediately if the signal is already aborted", async () => {
  const c = new AbortController();
  c.abort("nope");
  await assert.rejects(() => abortableDelay(5000, c.signal), /cancelled/);
});

test("abortableDelay rejects promptly when aborted mid-wait", async () => {
  const c = new AbortController();
  const start = Date.now();
  setTimeout(() => c.abort("mid"), 10);
  await assert.rejects(() => abortableDelay(5000, c.signal), /cancelled/);
  assert.ok(Date.now() - start < 1000, "did not wait the full 5s");
});

// ---------------------------------------------------------------------------
// resolveWorkerOpts / resolveRetryInput defaults
// ---------------------------------------------------------------------------

test("resolveWorkerOpts defaults make transient retries a no-op", () => {
  const o = resolveWorkerOpts({});
  assert.strictEqual(o.maxRetries, 0);
  assert.strictEqual(o.baseDelayMs, 500);
  assert.strictEqual(o.maxDelayMs, 30000);
  assert.strictEqual(o.retryJitter, true);
});

test("resolveWorkerOpts honors snake_case aliases and clamps to non-negative ints", () => {
  const o = resolveWorkerOpts({ max_retries: "3", base_delay_ms: -5, max_delay_ms: 2000, retry_jitter: "false" });
  assert.strictEqual(o.maxRetries, 3);
  assert.strictEqual(o.baseDelayMs, 0, "negative clamps to 0");
  assert.strictEqual(o.maxDelayMs, 2000);
  assert.strictEqual(o.retryJitter, false);
});

test("resolveRetryInput journals knobs only when retries are enabled", () => {
  assert.deepStrictEqual(resolveRetryInput({}).journal, {}, "no retries => empty journal (byte-identical options)");
  const j = resolveRetryInput({ max_retries: 2 }).journal;
  assert.strictEqual(j.max_retries, 2);
  assert.strictEqual(j.base_delay_ms, 500);
  assert.strictEqual(j.max_delay_ms, 30000);
  assert.strictEqual(j.retry_jitter, true);
});
