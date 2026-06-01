"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine, MOCK, MOCK_FAIL, withCodexHome, withMockEnv, freshCounterPath } = require("./helpers/env.js");
const { runWorkflow, readWorkflow } = engine;

test("legacy fan-out: 2 workers complete, aggregate doubles, state re-readable", async () => {
  await withCodexHome(async (home) => {
    const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 3 };
    const wf = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, async () =>
      runWorkflow({
        task: "investigate the thing",
        workers: 2,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 2
      })
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.workers.length, 2);
    assert.ok(wf.workers.every((w) => w.status === "completed"));

    // aggregate_usage = 2x per-worker. total_tokens per worker = 10+5+3 = 18 => 36
    assert.strictEqual(wf.aggregate_usage.total_tokens, 36);
    assert.strictEqual(wf.aggregate_usage.input_tokens, 20);

    // state file written at wf.state_path and re-readable via readWorkflow.
    const reread = await readWorkflow({ workflow_id: wf.id });
    assert.strictEqual(reread.id, wf.id);
    assert.strictEqual(reread.status, "completed");
    assert.strictEqual(reread.workers.length, 2);
  });
});

test("workers_spec: explicit path runs both specs (incl schema:null), stores spec", async () => {
  await withCodexHome(async (home) => {
    const wf = await withMockEnv({}, async () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 2,
        workers_spec: [
          { prompt: "spec one", label: "alpha" },
          { prompt: "spec two", label: "beta", schema: null }
        ]
      })
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.options.explicit, true);
    assert.strictEqual(wf.workers.length, 2);
    assert.ok(wf.workers.every((w) => w.status === "completed"));
    // Each worker has a stored spec for resume.
    assert.ok(wf.workers.every((w) => w.spec && typeof w.spec.prompt === "string"));
    const beta = wf.workers.find((w) => w.label === "beta");
    assert.strictEqual(beta.spec.schema, null, "schema:null preserved in stored spec");
  });
});

test("partial status: exactly one of two workers fails => status 'partial'", async () => {
  await withCodexHome(async (home) => {
    // runExplicitWorkflow uses one shared codex_bin for every spec. To get a
    // genuine single-record partial (>=1 completed, >=1 failed) we force exactly
    // one invocation (index 0, per a fresh counter) of the mock to exit non-zero.
    const counter = freshCounterPath();
    const wf = await withMockEnv(
      { MOCK_CODEX_FAIL_ON_INVOCATION: "0", MOCK_CODEX_COUNTER: counter },
      async () =>
        runWorkflow({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          // Serialize so invocation indices are deterministic: the first worker
          // (index 0) fails, the second (index 1) completes.
          concurrency: 1,
          workers_spec: [
            { prompt: "a", label: "alpha" },
            { prompt: "b", label: "beta" }
          ]
        })
    );
    assert.strictEqual(wf.status, "partial");
    const failed = wf.workers.filter((w) => w.status === "failed");
    const completed = wf.workers.filter((w) => w.status === "completed");
    assert.strictEqual(failed.length, 1, "exactly one worker failed");
    assert.strictEqual(completed.length, 1, "exactly one worker completed");
  });
});

test("fully-failing workflow (shared failing bin) => status 'failed'", async () => {
  await withCodexHome(async (home) => {
    const failed = await withMockEnv({}, async () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK_FAIL,
        codex_home: home,
        concurrency: 2,
        workers_spec: [{ prompt: "a" }, { prompt: "b" }]
      })
    );
    assert.strictEqual(failed.status, "failed");
    assert.ok(failed.workers.every((w) => w.status === "failed"));
  });
});

test("journaled JSON contains workers status, aggregate_usage, events, aggregate", async () => {
  await withCodexHome(async (home) => {
    const wf = await withMockEnv({}, async () =>
      runWorkflow({
        task: "journal check",
        workers: 1,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 1
      })
    );
    const reread = await readWorkflow({ workflow_id: wf.id });
    assert.ok(Array.isArray(reread.workers));
    assert.ok(reread.workers.every((w) => typeof w.status === "string"));
    assert.ok(reread.aggregate_usage && typeof reread.aggregate_usage.total_tokens === "number");
    assert.ok(Array.isArray(reread.events), "events journaled");
    assert.ok(reread.aggregate && Array.isArray(reread.aggregate.summary), "compactWorkflow aggregate present");
  });
});
