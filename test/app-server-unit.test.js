"use strict";

// Pure-unit tests for the app-server transport: no subprocess, no engine run.
// Covers the dependency-free framing/normalization helpers in
// scripts/app-server-client.js and the engine's transport resolution + journal.

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const appServer = require("../scripts/app-server-client.js");

const { normalizeUsage, classifyMessage, extractThreadId, extractTurnId, embedSchema } = appServer._internal;

test("normalizeUsage maps camelCase TokenUsageBreakdown -> snake_case USAGE_KEYS", () => {
  const out = normalizeUsage({
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
    totalTokens: 18
  });
  assert.deepStrictEqual(out, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 3,
    total_tokens: 18
  });
});

test("normalizeUsage tolerates missing fields (=> 0) and rejects non-objects", () => {
  assert.strictEqual(normalizeUsage(null), null);
  assert.strictEqual(normalizeUsage(42), null);
  assert.deepStrictEqual(normalizeUsage({ inputTokens: 7 }), {
    input_tokens: 7,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  });
});

test("classifyMessage frames BARE JSON-RPC (no top-level jsonrpc field)", () => {
  // A result/error/notification/request, none carrying `jsonrpc`.
  assert.strictEqual(classifyMessage({ id: 0, result: { ok: true } }), "result");
  assert.strictEqual(classifyMessage({ id: 1, error: { code: -32601, message: "x" } }), "error");
  assert.strictEqual(classifyMessage({ method: "thread/started", params: {} }), "notification");
  assert.strictEqual(classifyMessage({ id: 2, method: "execCommandApproval", params: {} }), "request");
  assert.strictEqual(classifyMessage({}), "unknown");
  assert.strictEqual(classifyMessage(null), "unknown");
});

test("extractThreadId / extractTurnId tolerate object or string forms", () => {
  assert.strictEqual(extractThreadId({ thread: { id: "th_1" } }), "th_1");
  assert.strictEqual(extractThreadId({ thread: "th_2" }), "th_2");
  assert.strictEqual(extractThreadId({ threadId: "th_3" }), "th_3");
  assert.strictEqual(extractThreadId({}), null);
  assert.strictEqual(extractTurnId({ turn: { id: "tn_1" } }), "tn_1");
  assert.strictEqual(extractTurnId({ turn: "tn_2" }), "tn_2");
  assert.strictEqual(extractTurnId({}), null);
});

test("embedSchema appends the schema only when one is supplied", () => {
  assert.strictEqual(embedSchema("hi", null), "hi");
  const out = embedSchema("hi", { type: "object" });
  assert.ok(out.startsWith("hi\n"));
  assert.ok(out.includes('"type"'), "schema JSON embedded");
});

test("resolveTransport coerces unknown/empty values back to 'exec'", () => {
  const { resolveTransport } = engine._internal;
  assert.strictEqual(resolveTransport(undefined), "exec");
  assert.strictEqual(resolveTransport(""), "exec");
  assert.strictEqual(resolveTransport("nonsense"), "exec");
  assert.strictEqual(resolveTransport("exec"), "exec");
  assert.strictEqual(resolveTransport("app-server"), "app-server");
  assert.strictEqual(resolveTransport("exec-server"), "exec-server");
});

test("resolveWorkerOpts defaults transport to 'exec' and honors an explicit value", () => {
  const { resolveWorkerOpts } = engine._internal;
  assert.strictEqual(resolveWorkerOpts({}).transport, "exec");
  assert.strictEqual(resolveWorkerOpts({ transport: "app-server" }).transport, "app-server");
  assert.strictEqual(resolveWorkerOpts({ transport: "bogus" }).transport, "exec");
  assert.strictEqual(resolveWorkerOpts({ transport: "app-server" }).transportStrict, false);
  assert.strictEqual(
    resolveWorkerOpts({ transport: "app-server", transport_strict: true }).transportStrict,
    true
  );
});

test("ULTRACODE_TRANSPORT env selects app-server when option is unset", () => {
  const { resolveWorkerOpts } = engine._internal;
  const prev = process.env.ULTRACODE_TRANSPORT;
  process.env.ULTRACODE_TRANSPORT = "app-server";
  try {
    assert.strictEqual(resolveWorkerOpts({}).transport, "app-server");
    // An explicit option still wins over the env.
    assert.strictEqual(resolveWorkerOpts({ transport: "exec" }).transport, "exec");
  } finally {
    if (prev === undefined) delete process.env.ULTRACODE_TRANSPORT;
    else process.env.ULTRACODE_TRANSPORT = prev;
  }
});

test("transportJournal is empty for the default and present otherwise", () => {
  const { transportJournal } = engine._internal;
  assert.deepStrictEqual(transportJournal("exec", false), {});
  assert.deepStrictEqual(transportJournal(undefined, false), {});
  assert.deepStrictEqual(transportJournal("app-server", false), { transport: "app-server" });
  assert.deepStrictEqual(transportJournal("app-server", true), {
    transport: "app-server",
    transport_strict: true
  });
});
