"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const { engine, MOCK, withMockEnv, withCodexHome, freshCounterPath, freshTmpDir } = require("./helpers/env.js");

// runWorkflow / runExplicitWorkflow thread input.signal into createContext, and
// the loop-top abort gate makes queued-but-not-started workers resolve as
// 'cancelled' WITHOUT spawning a child.

test("workers_spec: aborting after the first slow worker starts cancels the queued rest", async () => {
  const counter = freshCounterPath();
  await withCodexHome(async () => {
    const controller = new AbortController();
    const cwd = freshTmpDir("ultracode-cancel-cwd-");
    const workers_spec = [
      { prompt: "spec 1", schema: null },
      { prompt: "spec 2", schema: null },
      { prompt: "spec 3", schema: null },
      { prompt: "spec 4", schema: null }
    ];
    const record = await withMockEnv(
      { MOCK_CODEX_SLEEP_MS: "1200", MOCK_CODEX_COUNTER: counter, MOCK_CODEX_RESPONSE: "ok" },
      async () => {
        // concurrency 1 => only the first worker starts; abort while it runs.
        const p = engine.runWorkflow({
          workers_spec,
          cwd,
          codex_bin: MOCK,
          concurrency: 1,
          signal: controller.signal
        });
        setTimeout(() => controller.abort("test"), 120);
        return p;
      }
    );
    assert.strictEqual(record.status, "cancelled", `workflow.status should be cancelled, got ${record.status}`);
    const cancelled = record.workers.filter((w) => w.status === "cancelled");
    assert.ok(cancelled.length >= 3, `at least the 3 queued workers are cancelled (got ${cancelled.length})`);
    // The slow first worker spawned at most one child; the queued 3 spawned none.
    // The counter file may not exist if the abort fired (under load) before the
    // first child's nextInvocation() wrote it — that simply means 0 invocations,
    // which still satisfies the "<4" invariant. Tolerate the missing file so the
    // timing race never flakes the assertion.
    let invocations = 0;
    try {
      invocations = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0;
    } catch {
      invocations = 0;
    }
    assert.ok(invocations < 4, `fewer than 4 children spawned (got ${invocations})`);
    assert.ok(
      record.events.some((e) => e.type === "cancelled"),
      "a top-level cancelled event is journaled"
    );
  });
});

test("aborting an entire run before it starts cancels every worker, spawns nothing", async () => {
  const counter = freshCounterPath();
  await withCodexHome(async () => {
    const controller = new AbortController();
    controller.abort("pre-abort");
    const cwd = freshTmpDir("ultracode-cancel-cwd2-");
    const record = await withMockEnv({ MOCK_CODEX_COUNTER: counter, MOCK_CODEX_RESPONSE: "ok" }, async () =>
      engine.runWorkflow({
        workers_spec: [
          { prompt: "a", schema: null },
          { prompt: "b", schema: null }
        ],
        cwd,
        codex_bin: MOCK,
        concurrency: 2,
        signal: controller.signal
      })
    );
    assert.strictEqual(record.status, "cancelled");
    assert.ok(record.workers.every((w) => w.status === "cancelled"), "all workers cancelled");
    assert.ok(!fs.existsSync(counter), "no children spawned at all");
  });
});

test("legacy fan-out with no signal still completes (zero behavior change)", async () => {
  await withCodexHome(async () => {
    const cwd = freshTmpDir("ultracode-nocancel-cwd-");
    const record = await withMockEnv({}, async () =>
      engine.runWorkflow({ task: "do a thing", workers: 2, cwd, codex_bin: MOCK })
    );
    assert.strictEqual(record.status, "completed");
    assert.ok(!("max_retries" in record.options), "no retry knobs journaled when unused");
  });
});

test("max_retries flows into runWorkflow and is journaled", async () => {
  const counter = freshCounterPath();
  await withCodexHome(async () => {
    const cwd = freshTmpDir("ultracode-retry-wf-cwd-");
    const record = await withMockEnv(
      {
        MOCK_CODEX_FAIL_TIMES: "1",
        MOCK_CODEX_EXIT: "1",
        MOCK_CODEX_STDERR: "429 rate limit",
        MOCK_CODEX_COUNTER: counter,
        MOCK_CODEX_RESPONSE: "ok"
      },
      async () =>
        engine.runWorkflow({
          workers_spec: [{ prompt: "retry me", schema: null }],
          cwd,
          codex_bin: MOCK,
          concurrency: 1,
          max_retries: 2,
          base_delay_ms: 1,
          max_delay_ms: 2,
          retry_jitter: false
        })
    );
    assert.strictEqual(record.status, "completed", "the single transient failure is retried then succeeds");
    assert.strictEqual(record.options.max_retries, 2, "retry knob journaled for resume");
    assert.strictEqual(parseInt(fs.readFileSync(counter, "utf8"), 10), 2, "1 fail + 1 success");
  });
});
