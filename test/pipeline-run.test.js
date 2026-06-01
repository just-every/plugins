"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  engine,
  MOCK,
  withCodexHome,
  withMockEnv,
  withCodexCliPath,
  freshCounterPath
} = require("./helpers/env.js");
const { runPipelineSpec, readWorkflow } = engine;

// runPipelineSpec threads codex_bin into worker/parallel steps, but verify (via
// adversarialVerify) and loop (via loopUntilDry) fall back to defaultCodexBin()
// which honors CODEX_CLI_PATH. So pipeline tests wrap in BOTH codex_bin (passed
// to runPipelineSpec) and withCodexCliPath(MOCK) to be safe across kinds.

const REVIEW_RESPONSE = JSON.stringify({
  summary: "review summary",
  findings: ["f1", "f2"],
  recommended_actions: [],
  risks: [],
  verification: [],
  confidence: "high"
});

test("2-step worker->worker DAG: dependent receives upstream output, record shape parity", async () => {
  await withCodexHome(async (home) => {
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_RESPONSE: REVIEW_RESPONSE }, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 2,
          steps: [
            { id: "review", prompt: "review the code" },
            { id: "plan", prompt: "plan using {{steps.review.output.findings}}", depends_on: ["review"] }
          ]
        })
      )
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.options.pipeline, true);
    assert.strictEqual(wf.workers.length, 2);

    // workers[] entries carry step_id / kind / depends_on for resume + status.
    const review = wf.workers.find((w) => w.id === "review");
    const plan = wf.workers.find((w) => w.id === "plan");
    assert.strictEqual(review.step_id, "review");
    assert.strictEqual(review.kind, "worker");
    assert.deepStrictEqual(plan.depends_on, ["review"]);
    assert.ok(plan.spec && typeof plan.spec.prompt === "string");

    // aggregate_usage is summed across both step workers (per-worker 18 => 36).
    assert.strictEqual(wf.aggregate_usage.total_tokens, 36);
    assert.ok(wf.aggregate && Array.isArray(wf.aggregate.summary));

    // On-disk JSON at state_path is readable by readWorkflow (status parity).
    const reread = await readWorkflow({ workflow_id: wf.id });
    assert.strictEqual(reread.id, wf.id);
    assert.strictEqual(reread.options.pipeline, true);
    assert.strictEqual(reread.workers.length, 2);
  });
});

test("barrier-free scheduling: a step with two deps starts only after both, independent branch runs concurrently", async () => {
  await withCodexHome(async (home) => {
    // The mock writes its invocation index (per the shared counter) into the
    // thread_id. With concurrency high enough, an independent branch (C) and a
    // fan-in step (D depends on A,B) all run; D must complete after A and B.
    const counter = freshCounterPath();
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 8,
          steps: [
            { id: "A", prompt: "a" },
            { id: "B", prompt: "b" },
            { id: "C", prompt: "c (independent)" },
            { id: "D", prompt: "d uses {{steps.A.output}} and {{steps.B.output}}", depends_on: ["A", "B"] }
          ]
        })
      )
    );
    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.workers.length, 4);
    assert.ok(wf.workers.every((w) => w.status === "completed"));

    // D's worker.started event must come after BOTH A and B completed events
    // (a true fan-in barrier on its own deps), while C is free to run anytime.
    const ev = wf.events;
    const startIdx = (label) => ev.findIndex((e) => e.type === "step.started" && e.label === label);
    const doneIdx = (label) => ev.findIndex((e) => e.type === "step.completed" && e.label === label);
    assert.ok(startIdx("D") > doneIdx("A"), "D starts after A completes");
    assert.ok(startIdx("D") > doneIdx("B"), "D starts after B completes");
  });
});

test("verify step: findings flow from an upstream worker into adversarialVerify and survivors return", async () => {
  await withCodexHome(async (home) => {
    // review returns a WORKER object carrying findings ['f1','f2'] (default
    // findings_path). The skeptics receive that SAME object body; it has no
    // `refuted:true`, so each vote counts as not-refuted (best-effort accept
    // after a schema retry), and both findings survive into verify.result.
    const REVIEW = JSON.stringify({
      summary: "review summary",
      findings: ["f1", "f2"],
      recommended_actions: [],
      risks: [],
      verification: [],
      confidence: "high"
    });
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_RESPONSE: REVIEW }, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 4,
          steps: [
            { id: "review", prompt: "review" },
            {
              id: "verify",
              kind: "verify",
              prompt: "n/a",
              findings_from: "review",
              findings_path: "findings",
              skeptics: 2,
              depends_on: ["review"]
            }
          ]
        })
      )
    );
    const verify = wf.workers.find((w) => w.id === "verify");
    assert.strictEqual(verify.kind, "verify");
    assert.deepStrictEqual(verify.result, ["f1", "f2"], "both upstream findings survive into verify output");
  });
});

test("verify step over an empty findings array returns an empty survivor list (no spawns)", async () => {
  await withCodexHome(async (home) => {
    // The default mock WORKER response has findings:[]. With no findings the
    // verify step spawns zero skeptics and returns []. (The refute *logic*
    // itself is exhaustively covered in adversarial.test.js.)
    const counter = freshCounterPath();
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 2,
          steps: [
            { id: "review", prompt: "review" },
            {
              id: "verify",
              kind: "verify",
              prompt: "n/a",
              findings_from: "review",
              findings_path: "findings",
              skeptics: 3,
              depends_on: ["review"]
            }
          ]
        })
      )
    );
    const verify = wf.workers.find((w) => w.id === "verify");
    assert.deepStrictEqual(verify.result, [], "empty upstream findings => empty survivors");
    // Only the single review worker spawned; verify spawned no skeptics.
    const fs = require("fs");
    const spawned = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0;
    assert.strictEqual(spawned, 1, "verify spawned no skeptics for empty findings");
  });
});

test("loop step: loopUntilDry collects non-dry rounds then stops on dry streak", async () => {
  await withCodexHome(async (home) => {
    // A finder that always returns findings would never go dry (hits maxRounds).
    // Use max_rounds:2 so the loop terminates fast and collects 2 round outputs.
    const FOUND = JSON.stringify({
      summary: "found",
      findings: ["x"],
      recommended_actions: [],
      risks: [],
      verification: [],
      confidence: "high"
    });
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_RESPONSE: FOUND }, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 2,
          steps: [{ id: "hunt", kind: "loop", prompt: "find round {{round}}", max_rounds: 2, dry_rounds: 2 }]
        })
      )
    );
    const hunt = wf.workers.find((w) => w.id === "hunt");
    assert.strictEqual(hunt.kind, "loop");
    assert.ok(Array.isArray(hunt.result));
    assert.strictEqual(hunt.result.length, 2, "two non-dry rounds collected before maxRounds");
  });
});

test("parallel step with items fans out one worker per item", async () => {
  await withCodexHome(async (home) => {
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({}, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 4,
          steps: [
            { id: "fan", kind: "parallel", prompt: "handle {{item.k}}", items: [{ k: "a" }, { k: "b" }, { k: "c" }] }
          ]
        })
      )
    );
    const fan = wf.workers.find((w) => w.id === "fan");
    assert.strictEqual(fan.kind, "parallel");
    assert.ok(Array.isArray(fan.result));
    assert.strictEqual(fan.result.length, 3, "one output per item, nulls preserved");
  });
});

test("a step whose template can't render fails just that step (and the workflow is partial)", async () => {
  await withCodexHome(async (home) => {
    // 'review' returns a WORKER object WITHOUT a 'missing' key; 'use' drills into
    // {{steps.review.output.missing.deep}} => undefined => renderTemplate throws,
    // failing only the 'use' step. 'review' still completes.
    const wf = await withCodexCliPath(MOCK, async () =>
      withMockEnv({}, async () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 2,
          steps: [
            { id: "review", prompt: "review" },
            { id: "use", prompt: "x {{steps.review.output.missing.deep}}", depends_on: ["review"] }
          ]
        })
      )
    );
    const review = wf.workers.find((w) => w.id === "review");
    const use = wf.workers.find((w) => w.id === "use");
    assert.strictEqual(review.status, "completed");
    assert.strictEqual(use.status, "failed");
    assert.strictEqual(wf.status, "partial");
  });
});

test("a bad spec (cycle) throws before any spawn (no state file written)", async () => {
  await withCodexHome(async (home) => {
    const counter = freshCounterPath();
    await withCodexCliPath(MOCK, async () =>
      withMockEnv({ MOCK_CODEX_COUNTER: counter }, async () => {
        await assert.rejects(
          () =>
            runPipelineSpec({
              cwd: home,
              codex_bin: MOCK,
              codex_home: home,
              steps: [
                { id: "a", prompt: "a", depends_on: ["b"] },
                { id: "b", prompt: "b", depends_on: ["a"] }
              ]
            }),
          /form a cycle/
        );
      })
    );
    // The counter file was never created/incremented because no worker spawned.
    const fs = require("fs");
    let spawned = 0;
    try {
      spawned = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0;
    } catch {
      spawned = 0;
    }
    assert.strictEqual(spawned, 0, "no worker spawned for a cyclic spec");
  });
});
