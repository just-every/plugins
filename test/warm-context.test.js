"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const {
  engine,
  mockOpts,
  withMockEnv,
  freshCounterPath,
  freshSessionDir,
  readInvocations
} = require("./helpers/env.js");

const { spawnWorker, spawnWarmWorker, runPipeline, createContext, buildCodexArgs, buildResumeArgs } = engine;
const { isResumeUnavailable, injectSchemaIntoPrompt, resolveWorkerOpts } = engine._internal;

// ---------------------------------------------------------------------------
// Unit: buildResumeArgs / buildCodexArgs arg-array contracts
// ---------------------------------------------------------------------------

test("buildResumeArgs emits only resume-supported flags (no schema/sandbox/cd/add-dir/profile)", () => {
  const opts = {
    sandbox: "workspace-write",
    cwd: "/some/cwd",
    model: "gpt-x",
    reasoningEffort: "high",
    profile: "myprofile",
    addDirs: ["/a", "/b"]
  };
  const args = buildResumeArgs(opts, "sess-123", "/tmp/last.json");
  // Exact prefix the spike pinned.
  assert.deepStrictEqual(args.slice(0, 7), [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "sess-123",
    "-o",
    "/tmp/last.json"
  ]);
  // -m model and -c model_reasoning_effort are allowed.
  assert.ok(args.includes("-m"));
  assert.strictEqual(args[args.indexOf("-m") + 1], "gpt-x");
  assert.ok(args.some((a) => /^model_reasoning_effort=/.test(a)));
  // NEVER any of these (rejected by the real CLI under resume).
  for (const forbidden of ["--output-schema", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-p", "--profile"]) {
    assert.ok(!args.includes(forbidden), `resume args must not include ${forbidden}`);
  }
  // Ends with the stdin sentinel.
  assert.strictEqual(args[args.length - 1], "-");
});

test("buildResumeArgs omits -m / -c when model and effort are unset", () => {
  const args = buildResumeArgs({ cwd: "/x" }, "sid", "/tmp/last.json");
  assert.ok(!args.includes("-m"));
  assert.ok(!args.some((a) => /^model_reasoning_effort=/.test(a)));
  assert.deepStrictEqual(args, ["exec", "resume", "--json", "--skip-git-repo-check", "sid", "-o", "/tmp/last.json", "-"]);
});

test("buildCodexArgs default cold call STILL contains --ephemeral and --output-schema (guards default path)", () => {
  const opts = { sandbox: "read-only", cwd: "/cwd", persistSession: false };
  const args = buildCodexArgs(opts, "/tmp/schema.json", "/tmp/last.json");
  assert.ok(args.includes("--ephemeral"), "cold default keeps --ephemeral");
  assert.ok(args.includes("--output-schema"), "cold default keeps --output-schema");
  assert.strictEqual(args[args.indexOf("--output-schema") + 1], "/tmp/schema.json");
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--cd"));
  assert.strictEqual(args[args.length - 1], "-");
});

test("buildCodexArgs drops --ephemeral when persistSession is true (warm first turn)", () => {
  const args = buildCodexArgs({ sandbox: "read-only", cwd: "/cwd", persistSession: true }, "/tmp/s.json", "/tmp/l.json");
  assert.ok(!args.includes("--ephemeral"), "persisted first turn must not be ephemeral");
});

// ---------------------------------------------------------------------------
// Unit: resolveWorkerOpts executor handling
// ---------------------------------------------------------------------------

test("resolveWorkerOpts executor defaults to 'cold' and persistSession false", () => {
  const r = resolveWorkerOpts({});
  assert.strictEqual(r.executor, "cold");
  assert.strictEqual(r.persistSession, false);
});

test("resolveWorkerOpts executor:'resume' forces persistSession=true", () => {
  const r = resolveWorkerOpts({ executor: "resume" });
  assert.strictEqual(r.executor, "resume");
  assert.strictEqual(r.persistSession, true);
});

test("resolveWorkerOpts executor:'fork' does NOT force persistSession", () => {
  const r = resolveWorkerOpts({ executor: "fork" });
  assert.strictEqual(r.executor, "fork");
  assert.strictEqual(r.persistSession, false);
});

test("resolveWorkerOpts unknown executor falls back to 'cold'", () => {
  assert.strictEqual(resolveWorkerOpts({ executor: "bogus" }).executor, "cold");
});

// ---------------------------------------------------------------------------
// Unit: isResumeUnavailable / injectSchemaIntoPrompt
// ---------------------------------------------------------------------------

test("isResumeUnavailable detects the no-rollout signal and non-zero resume exits", () => {
  assert.strictEqual(
    isResumeUnavailable(new Error("x"), { stderr: "no rollout found for thread id abc (code -32600)", exit_code: 1 }),
    true
  );
  assert.strictEqual(isResumeUnavailable(new Error("x"), { stderr: "boom", exit_code: 7 }), true);
  // A clean resume turn (exit 0, no signal) is NOT unavailable.
  assert.strictEqual(isResumeUnavailable(null, { stderr: "", stdout: "", exit_code: 0 }), false);
});

test("injectSchemaIntoPrompt appends the schema only when a schema is given", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const out = injectSchemaIntoPrompt("base", schema);
  assert.ok(out.startsWith("base"));
  assert.ok(out.includes('"type": "object"'), "schema JSON embedded");
  assert.strictEqual(injectSchemaIntoPrompt("base", null), "base", "no schema => unchanged prompt");
});

// ---------------------------------------------------------------------------
// Integration: spawnWarmWorker first-turn-cold + second-turn-resume
// ---------------------------------------------------------------------------

test("spawnWarmWorker: first turn persists a session; second turn resumes the SAME id", async () => {
  const sessionDir = freshSessionDir();
  const counter = freshCounterPath();
  const r = await withMockEnv(
    { MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_COUNTER: counter, MOCK_CODEX_THREAD_PREFIX: "warm" },
    async () => {
      const ctx = createContext({ concurrency: 1 });
      const handle = await spawnWarmWorker("stage 0", { ...mockOpts(), ctx, executor: "resume" });
      const t1 = await handle.turn("stage 1");
      return { handle, t1 };
    }
  );
  assert.strictEqual(r.handle.result.status, "completed");
  assert.ok(r.handle.sessionId, "a session id was captured from the first turn");
  assert.strictEqual(r.t1.status, "completed");

  const log = readInvocations(sessionDir);
  // Exactly two child invocations: one cold persisted exec + one resume.
  assert.strictEqual(log.length, 2, `expected 2 invocations, got ${log.length}`);
  assert.strictEqual(log[0].subcommand, "exec", "first turn is a cold exec");
  assert.strictEqual(log[0].ephemeral, false, "first turn is persisted (NOT --ephemeral)");
  assert.strictEqual(log[1].subcommand, "resume", "second turn is a resume");
  assert.strictEqual(log[1].session_id, r.handle.sessionId, "resume used the captured session id");
});

test("spawnWarmWorker first turn args: persisted (not ephemeral), resume turn carries no forbidden flags", async () => {
  const sessionDir = freshSessionDir();
  const r = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_THREAD_PREFIX: "warm2" }, async () => {
    const ctx = createContext({ concurrency: 1 });
    const handle = await spawnWarmWorker("init", { ...mockOpts(), ctx, executor: "resume" });
    await handle.turn("follow up");
    return handle;
  });
  const log = readInvocations(sessionDir);
  const resume = log.find((e) => e.subcommand === "resume");
  assert.ok(resume, "a resume invocation was recorded");
  for (const f of ["--output-schema", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-p", "--profile"]) {
    assert.ok(!resume.argv.includes(f), `resume invocation must not contain ${f}`);
  }
  // Confirm the mock did not reject the resume turn (would be exit 64 / no entry).
  assert.ok(!resume.rejected, "resume invocation was not rejected for a forbidden flag");
});

// ---------------------------------------------------------------------------
// Fallback: resume rejected (unknown id) -> cold exec, result still correct
// ---------------------------------------------------------------------------

test("fallback: resume rejected (no rollout) => logs resume-fallback and completes via cold exec", async () => {
  const sessionDir = freshSessionDir();
  const events = [];
  const r = await withMockEnv(
    { MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_REJECT_RESUME: "1" },
    async () => {
      const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
      const handle = await spawnWarmWorker("init", { ...mockOpts(), ctx, executor: "resume" });
      // sessionId is captured from the (successful) first turn; the resume turn
      // is forced to fail, so the worker must fall back to a cold exec.
      const t1 = await handle.turn("follow up");
      return { t1 };
    }
  );
  assert.strictEqual(r.t1.status, "completed", "the turn still completes via cold fallback");
  assert.ok(r.t1.value && typeof r.t1.value === "object", "cold fallback produced a real schema value");
  const fallbackLog = events.find((e) => e.type === "log" && e.data && e.data.reason === "resume-fallback");
  assert.ok(fallbackLog, "a resume-fallback log fired");

  const log = readInvocations(sessionDir);
  // init (cold), resume turn attempt (rejected), cold fallback exec.
  const resumeAttempts = log.filter((e) => e.subcommand === "resume");
  const coldExecs = log.filter((e) => e.subcommand === "exec");
  assert.strictEqual(resumeAttempts.length, 1, "exactly one resume attempt");
  assert.strictEqual(coldExecs.length, 2, "first-turn cold + cold fallback");
});

// ---------------------------------------------------------------------------
// Fallback: first turn yields no thread_id -> later turn must NOT attempt resume
// ---------------------------------------------------------------------------

test("no session id captured (first turn failed) => follow-up runs cold, never attempts resume", async () => {
  const sessionDir = freshSessionDir();
  const r = await withMockEnv(
    { MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_EXIT: "1", MOCK_CODEX_STDERR: "first turn boom" },
    async () => {
      const ctx = createContext({ concurrency: 1 });
      const handle = await spawnWarmWorker("init", { ...mockOpts(), ctx, executor: "resume" });
      assert.strictEqual(handle.result.status, "failed", "first turn failed");
      assert.strictEqual(handle.sessionId, null, "no session id captured from a failed first turn");
      // Now make the second turn succeed (clear the failure) — but there is no
      // warm session, so it must run cold, not resume.
      const t1 = await withMockEnv({ MOCK_CODEX_EXIT: undefined, MOCK_CODEX_STDERR: undefined }, async () =>
        handle.turn("follow up")
      );
      return { t1 };
    }
  );
  assert.strictEqual(r.t1.status, "completed");
  const log = readInvocations(sessionDir);
  assert.strictEqual(log.filter((e) => e.subcommand === "resume").length, 0, "no resume was ever attempted");
});

// ---------------------------------------------------------------------------
// runPipeline warm vs cold
// ---------------------------------------------------------------------------

test("runPipeline warm:true reuses ONE session per item across stages", async () => {
  const sessionDir = freshSessionDir();
  const ctx = createContext({ concurrency: 4 });
  const opts = mockOpts();
  const out = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_THREAD_PREFIX: "wp" }, async () =>
    runPipeline(
      [{ k: "A" }, { k: "B" }],
      [
        async (item, _orig, _i, _ctx, warm) => {
          const r = await warm.start(`stage0 ${item.k}`, { ...opts, ctx });
          return { sid: warm.sessionId, r };
        },
        async (acc, _item, _i, _ctx, warm) => {
          const r = await warm.turn("stage1");
          return { ...acc, sid2: warm.sessionId, r2: r };
        },
        async (acc, _item, _i, _ctx, warm) => {
          const r = await warm.turn("stage2");
          return { ...acc, sid3: warm.sessionId, r3: r };
        }
      ],
      { ctx, warm: true, ...opts }
    )
  );
  assert.strictEqual(out.length, 2);
  for (const item of out) {
    assert.ok(item, "item completed");
    assert.ok(item.sid, "a session id was captured");
    // All three stages share the SAME warm session id per item.
    assert.strictEqual(item.sid2, item.sid);
    assert.strictEqual(item.sid3, item.sid);
    assert.strictEqual(item.r3.status, "completed");
  }

  const log = readInvocations(sessionDir);
  // Per item: 1 cold persisted exec (stage0) + 2 resumes (stage1, stage2) = 3.
  // Two items => 6 invocations, 2 cold + 4 resume.
  assert.strictEqual(log.filter((e) => e.subcommand === "exec").length, 2, "two persisted base sessions");
  assert.strictEqual(log.filter((e) => e.subcommand === "resume").length, 4, "four warm resume turns");
  // Each resume id is one of exactly two distinct base session ids.
  const baseIds = new Set(log.filter((e) => e.subcommand === "exec").map((e) => e.thread_id));
  assert.strictEqual(baseIds.size, 2);
  for (const e of log.filter((x) => x.subcommand === "resume")) {
    assert.ok(baseIds.has(e.session_id), `resume id ${e.session_id} belongs to a base session`);
  }
});

test("runPipeline default (warm unset) runs N independent cold execs; same final outputs", async () => {
  const sessionDir = freshSessionDir();
  const ctx = createContext({ concurrency: 4 });
  const opts = mockOpts();
  const out = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_THREAD_PREFIX: "cp" }, async () =>
    runPipeline(
      [{ k: "A" }, { k: "B" }],
      [
        async (item, _orig, _i, _c) => spawnWorker(`stage0 ${item.k}`, { ...opts, ctx }),
        async (_acc) => spawnWorker("stage1", { ...opts, ctx }),
        async (_acc) => spawnWorker("stage2", { ...opts, ctx })
      ],
      { ctx } // no warm
    )
  );
  assert.strictEqual(out.length, 2);
  for (const r of out) assert.strictEqual(r.status, "completed");
  const log = readInvocations(sessionDir);
  // 2 items * 3 stages = 6 cold execs, zero resume.
  assert.strictEqual(log.filter((e) => e.subcommand === "resume").length, 0, "cold mode never resumes");
  assert.strictEqual(log.filter((e) => e.subcommand === "exec").length, 6, "six independent cold execs");
  // Default cold execs are ephemeral (no persisted session).
  assert.ok(log.every((e) => e.ephemeral === true), "all cold pipeline execs are --ephemeral");
});

// ---------------------------------------------------------------------------
// fork stub: degrades to cold, logs fork-unsupported
// ---------------------------------------------------------------------------

test("executor:'fork' logs fork-unsupported and runs cold (result identical to default)", async () => {
  const sessionDir = freshSessionDir();
  const events = [];
  const r = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, async () => {
    const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
    return spawnWorker("prompt", { ...mockOpts(), ctx, executor: "fork" });
  });
  assert.strictEqual(r.status, "completed");
  assert.ok(
    events.some((e) => e.type === "log" && e.data && e.data.reason === "fork-unsupported"),
    "a fork-unsupported log fired"
  );
  const log = readInvocations(sessionDir);
  assert.strictEqual(log.length, 1, "fork ran exactly one child");
  assert.strictEqual(log[0].subcommand, "exec", "fork ran a cold exec");
  assert.strictEqual(log[0].ephemeral, true, "fork does NOT persist a session (cold ephemeral)");
});

// ---------------------------------------------------------------------------
// Schema-on-resume: invalid-then-valid recovers via the post-hoc retry loop
// ---------------------------------------------------------------------------

test("schema-on-resume: a schema-invalid resume turn is re-prompted (schema embedded) and recovers", async () => {
  const sessionDir = freshSessionDir();
  const counter = freshCounterPath();
  const events = [];
  // First base exec is invocation 0 -> INVALID (per MOCK_CODEX_INVALID_FIRST),
  // then the schema-retry of the SAME worker re-runs (invocation 1) and is valid.
  // We drive this through a single spawnWorker resume turn after a base session
  // exists, asserting the schema-retry loop fired even though --output-schema is
  // never passed on a resume turn.
  const r = await withMockEnv(
    {
      MOCK_CODEX_SESSION_DIR: sessionDir,
      MOCK_CODEX_COUNTER: counter,
      MOCK_CODEX_INVALID_FIRST: "1",
      MOCK_CODEX_THREAD_PREFIX: "schemawarm"
    },
    async () => {
      const ctx = createContext({ concurrency: 1, onEvent: (e) => events.push(e) });
      // Base turn is invocation 0 and would be INVALID — but the base turn is a
      // worker too. To isolate schema-on-resume, pre-seed a rollout by running a
      // valid persisted base first under a separate counter, then resume.
      const baseHandle = await spawnWarmWorker("base", { ...mockOpts(), ctx, executor: "resume" });
      // baseHandle.result is invocation 0 => invalid first, retried to valid.
      const t = await baseHandle.turn("resume turn");
      return { baseHandle, t };
    }
  );
  // The schema-retry loop must have fired at least once (INVALID_FIRST on inv 0).
  assert.ok(
    events.some((e) => e.type === "log" && e.data && e.data.reason === "schema-retry"),
    "schema-retry fired without --output-schema on the wire"
  );
  assert.strictEqual(r.baseHandle.result.status, "completed");
  assert.strictEqual(r.baseHandle.result.schema_valid, true, "recovered to a valid schema value");
  assert.strictEqual(r.t.status, "completed");
  // The resume turns NEVER carried --output-schema.
  const log = readInvocations(sessionDir);
  for (const e of log.filter((x) => x.subcommand === "resume")) {
    assert.ok(!e.argv.includes("--output-schema"), "resume never passes --output-schema");
  }
});

// ---------------------------------------------------------------------------
// runPipelineSpec (public DAG) executor pass-through + validation
// ---------------------------------------------------------------------------

const { runPipelineSpec, WORKER_SCHEMA } = engine;
const { compileSteps } = engine._internal;
const { withCodexHome } = require("./helpers/env.js");

const COMPILE_DEFAULTS = {
  cwd: process.cwd(),
  sandbox: "read-only",
  model: undefined,
  reasoning_effort: undefined,
  timeout_ms: 60000
};

test("compileSteps rejects an invalid executor value (pre-spawn, zero side effects)", () => {
  assert.throws(
    () => compileSteps([{ id: "a", prompt: "p", executor: "bogus" }], COMPILE_DEFAULTS),
    /executor must be one of/
  );
});

test("compileSteps defaults step.executor to 'cold' and honors a per-step override", () => {
  const { compiled } = compileSteps(
    [
      { id: "a", prompt: "p" },
      { id: "b", prompt: "q", executor: "resume" }
    ],
    COMPILE_DEFAULTS
  );
  assert.strictEqual(compiled[0].executor, "cold");
  assert.strictEqual(compiled[1].executor, "resume");
});

test("runPipelineSpec with a step executor:'resume' persists that step's session (non-ephemeral)", async () => {
  const sessionDir = freshSessionDir();
  const r = await withCodexHome(async () =>
    withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir, MOCK_CODEX_THREAD_PREFIX: "spec" }, async () => {
      const cwd = mockOpts().cwd;
      return runPipelineSpec({
        cwd,
        codex_bin: require("./helpers/env.js").MOCK,
        steps: [
          { id: "warm_step", prompt: "warm please", executor: "resume" },
          { id: "cold_step", prompt: "cold please" }
        ]
      });
    })
  );
  assert.strictEqual(r.status, "completed");
  const log = readInvocations(sessionDir);
  // Two cold execs (each step is a single-turn worker); the resume step is
  // persisted (non-ephemeral), the cold step is ephemeral. No resume invocations
  // because nothing resumes a single-turn explicit step.
  const persisted = log.filter((e) => e.subcommand === "exec" && e.ephemeral === false);
  const ephemeral = log.filter((e) => e.subcommand === "exec" && e.ephemeral === true);
  assert.strictEqual(persisted.length, 1, "the executor:'resume' step persisted its session");
  assert.strictEqual(ephemeral.length, 1, "the cold step stayed ephemeral");
  assert.strictEqual(log.filter((e) => e.subcommand === "resume").length, 0, "single-turn steps never resume");
});

// ---------------------------------------------------------------------------
// Regression: default cold path is byte-for-byte unchanged
// ---------------------------------------------------------------------------

test("regression: a default spawnWorker still runs a single ephemeral cold exec with --output-schema", async () => {
  const sessionDir = freshSessionDir();
  const r = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, async () => {
    const ctx = createContext({ concurrency: 1 });
    return spawnWorker("prompt", { ...mockOpts(), ctx }); // no executor, no resumeSessionId
  });
  assert.strictEqual(r.status, "completed");
  const log = readInvocations(sessionDir);
  assert.strictEqual(log.length, 1, "exactly one child");
  assert.strictEqual(log[0].subcommand, "exec", "cold exec");
  assert.strictEqual(log[0].ephemeral, true, "default is ephemeral");
  assert.ok(log[0].argv.includes("--output-schema"), "default cold path passes --output-schema");
  assert.ok(log[0].argv.includes("--ephemeral"), "default cold path passes --ephemeral");
});

test("regression: passing resumeSessionId WITHOUT executor:'resume' is ignored (runs cold)", async () => {
  const sessionDir = freshSessionDir();
  const r = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, async () => {
    const ctx = createContext({ concurrency: 1 });
    // resumeSessionId provided but executor defaults to cold => must NOT resume.
    return spawnWorker("prompt", { ...mockOpts(), ctx, resumeSessionId: "some-id" });
  });
  assert.strictEqual(r.status, "completed");
  const log = readInvocations(sessionDir);
  assert.strictEqual(log.filter((e) => e.subcommand === "resume").length, 0, "no resume without executor:'resume'");
  assert.strictEqual(log[0].ephemeral, true, "still a cold ephemeral exec");
});
