"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const { engine, MOCK, withCodexHome, withMockEnv, withCodexCliPath, freshCounterPath } = require("./helpers/env.js");
const { runWorkflow, resumeWorkflow, readWorkflow } = engine;

function readCounter(counterPath) {
  try {
    return parseInt(fs.readFileSync(counterPath, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

async function run3WorkerWorkflow(home) {
  return runWorkflow({
    cwd: home,
    codex_bin: MOCK,
    codex_home: home,
    concurrency: 1, // serialize so thread_id indices are stable / inspectable
    workers_spec: [
      { prompt: "w0", label: "w0" },
      { prompt: "w1", label: "w1" },
      { prompt: "w2", label: "w2" }
    ]
  });
}

// resumeWorkflow's per-spec spawnWorker does NOT accept codex_bin, so the re-run
// workers fall back to defaultCodexBin() (which honors CODEX_CLI_PATH) and to
// codexHome() (which honors CODEX_HOME, already sandboxed by withCodexHome).
// Every resume test therefore runs inside withCodexCliPath(MOCK, ...).

test("resume forces exactly one step by step_id: only it re-runs", async () => {
  await withCodexHome(async (home) => {
    const counter = freshCounterPath();
    await withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
      withCodexCliPath(MOCK, async () => {
        const wf = await run3WorkerWorkflow(home);
        assert.strictEqual(wf.status, "completed");
        const afterRun = readCounter(counter);
        assert.strictEqual(afterRun, 3, "3 workers spawned exactly once each");

        const originalThreads = wf.workers.map((w) => w.thread_id);
        const forcedStep = wf.workers[1].step_id;

        const resumed = await resumeWorkflow({ workflow_id: wf.id, force_steps: [forcedStep] });
        const afterResume = readCounter(counter);
        assert.strictEqual(afterResume - afterRun, 1, "exactly one step re-ran");
        assert.strictEqual(resumed.status, "completed");

        // Forced worker got a fresh thread_id; the others kept their originals.
        assert.notStrictEqual(resumed.workers[1].thread_id, originalThreads[1], "forced step re-ran");
        assert.strictEqual(resumed.workers[0].thread_id, originalThreads[0], "step 0 untouched");
        assert.strictEqual(resumed.workers[2].thread_id, originalThreads[2], "step 2 untouched");
      })
    );
  });
});

test("resume force by index string and by id both re-run their step", async () => {
  await withCodexHome(async (home) => {
    const counter = freshCounterPath();
    await withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
      withCodexCliPath(MOCK, async () => {
        const wf = await run3WorkerWorkflow(home);
        const afterRun = readCounter(counter);

        // Force by index string "0" and by worker id of index 2.
        const idOfTwo = wf.workers[2].id;
        const resumed = await resumeWorkflow({ workflow_id: wf.id, force_steps: ["0", idOfTwo] });
        const afterResume = readCounter(counter);
        assert.strictEqual(afterResume - afterRun, 2, "two forced steps re-ran");
        assert.notStrictEqual(resumed.workers[0].thread_id, wf.workers[0].thread_id, "index-string force re-ran step 0");
        assert.notStrictEqual(resumed.workers[2].thread_id, wf.workers[2].thread_id, "id force re-ran step 2");
        assert.strictEqual(resumed.workers[1].thread_id, wf.workers[1].thread_id, "step 1 untouched");
      })
    );
  });
});

test("resume with nothing to re-run logs 'all steps already completed'", async () => {
  await withCodexHome(async (home) => {
    const counter = freshCounterPath();
    await withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
      withCodexCliPath(MOCK, async () => {
        const wf = await run3WorkerWorkflow(home);
        const afterRun = readCounter(counter);

        const events = [];
        const resumed = await resumeWorkflow({ workflow_id: wf.id, on_event: (e) => events.push(e) });
        assert.strictEqual(readCounter(counter), afterRun, "no step re-ran");
        assert.strictEqual(resumed.status, "completed");
        const log = events.find((e) => e.type === "log" && /all steps already completed/.test(e.message));
        assert.ok(log, "no-op branch must log 'all steps already completed'");
      })
    );
  });
});

test("resume re-runs a previously-failed worker without a force flag", async () => {
  await withCodexHome(async (home) => {
    const counter = freshCounterPath();
    await withCodexCliPath(MOCK, async () => {
      // First run: force invocation index 0 to fail => one failed worker.
      const wf = await withMockEnv(
        { MOCK_CODEX_COUNTER: counter, MOCK_CODEX_FAIL_ON_INVOCATION: "0" },
        async () => run3WorkerWorkflow(home)
      );
      assert.strictEqual(wf.status, "partial");
      const failedIdx = wf.workers.findIndex((w) => w.status === "failed");
      assert.ok(failedIdx >= 0, "one worker should have failed");
      const afterRun = readCounter(counter);

      // Resume with NO force and the failing condition cleared: the failed worker
      // auto-reruns and now completes.
      const resumed = await withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
        resumeWorkflow({ workflow_id: wf.id })
      );
      assert.strictEqual(readCounter(counter) - afterRun, 1, "only the failed worker re-ran");
      assert.strictEqual(resumed.workers[failedIdx].status, "completed");
      assert.strictEqual(resumed.status, "completed");

      // Confirm the persisted record reflects the recovered status.
      const reread = await readWorkflow({ workflow_id: wf.id });
      assert.strictEqual(reread.status, "completed");
    });
  });
});
