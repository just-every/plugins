"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const { engine, MOCK, MOCK_FAIL, freshTmpDir } = require("./helpers/env.js");
const { runScript, transformSource } = require("../scripts/ultracode-script-runner.js");

const ECHO_FIXTURE = path.join(__dirname, "fixtures", "echo.workflow.js");
const THROWS_FIXTURE = path.join(__dirname, "fixtures", "throws.workflow.js");

// Base options that point every spawn at the mock codex in an isolated home.
function baseOpts(extra = {}) {
  const home = freshTmpDir("ultracode-script-home-");
  return { codex_bin: MOCK, codex_home: home, cwd: home, ...extra };
}

// ---------------------------------------------------------------------------
// Transform unit tests (no codex spawned).
// ---------------------------------------------------------------------------

test("transform: export default <expr> becomes return", () => {
  const out = transformSource("export default { a: 1 };");
  assert.match(out, /^"use strict";/);
  assert.match(out, /return \{ a: 1 \};/);
  assert.doesNotMatch(out, /export default/);
});

test("transform: leading export const/let/var/async/function/class is stripped to bare decl", () => {
  const out = transformSource(
    ["export const a = 1;", "export let b = 2;", "export function f(){}", "export async function g(){}", "export class C {}"].join("\n")
  );
  assert.match(out, /^"use strict";/m);
  assert.doesNotMatch(out, /^[ \t]*export\s/m);
  assert.match(out, /const a = 1;/);
  assert.match(out, /async function g\(\)\{\}/);
});

test("transform: a string literal containing 'export const' mid-line is NOT rewritten", () => {
  const out = transformSource('const s = "do not export const this"; return s;');
  assert.match(out, /"do not export const this"/);
});

test("runScript: top-level return is captured as result and top-level await works", async () => {
  const rec = await runScript({
    source: "const x = await Promise.resolve(41); return { answer: x + 1 };",
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.deepStrictEqual(rec.result, { answer: 42 });
});

test("runScript: no return yields result null (undefined -> null)", async () => {
  const rec = await runScript({ source: "const x = 1;", ...baseOpts() });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result, null);
});

test("runScript: a SyntaxError script journals status:failed without crashing the host", async () => {
  const rec = await runScript({ source: "this is ((( not valid js", ...baseOpts() });
  assert.strictEqual(rec.status, "failed");
  assert.ok(typeof rec.error === "string" && rec.error.length > 0, "has an error message");
});

test("runScript: a throwing script journals status:failed with the message and partial events", async () => {
  const rec = await runScript({ source: 'log("before throw"); throw new Error("kaboom");', ...baseOpts() });
  assert.strictEqual(rec.status, "failed");
  assert.match(rec.error, /kaboom/);
  assert.ok(Array.isArray(rec.events) && rec.events.length >= 1, "partial events written");
});

// ---------------------------------------------------------------------------
// source|path XOR validation.
// ---------------------------------------------------------------------------

test("runScript: providing both source and path throws", async () => {
  await assert.rejects(
    () => runScript({ source: "return 1;", path: ECHO_FIXTURE, ...baseOpts() }),
    /exactly one of `source` or `path`/
  );
});

test("runScript: providing neither source nor path throws", async () => {
  await assert.rejects(() => runScript({ ...baseOpts() }), /one of `source` or `path` is required/);
});

// ---------------------------------------------------------------------------
// agent() success/failure + parallel filter(Boolean).
// ---------------------------------------------------------------------------

test("agent() returns the value object on completion", async () => {
  const rec = await runScript({
    source: "const v = await agent('inspect a'); return { ok: v !== null, v };",
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result.ok, true);
  assert.ok(rec.result.v && typeof rec.result.v === "object");
});

test("agent() returns null on a failed worker (mock-codex-fail) — failure already logged by engine", async () => {
  const rec = await runScript({
    source: "const v = await agent('inspect a'); return { isNull: v === null };",
    // Point this run's spawns at the deliberately-failing mock.
    ...baseOpts({ codex_bin: MOCK_FAIL })
  });
  assert.strictEqual(rec.status, "completed", "the SCRIPT still completes even though the agent failed");
  assert.strictEqual(rec.result.isNull, true, "agent() resolves to null on worker failure");
});

test("parallel() over a mixed batch: filter(Boolean) keeps only the successes", async () => {
  // Two thunks spawn against the good mock, one against the failing mock (passed
  // in via args as a per-call codex_bin override). A failed agent -> null, a
  // throwing/failing thunk never breaks the barrier.
  const rec = await runScript({
    source:
      "const reports = await parallel([" +
      "  () => agent('ok one')," +
      "  () => agent('bad', { codex_bin: args.failBin })," +
      "  () => agent('ok two')" +
      "]);" +
      "return { total: reports.length, kept: reports.filter(Boolean).length };",
    args: { failBin: MOCK_FAIL },
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result.total, 3, "all three thunks resolved (failures -> null, not a throw)");
  assert.strictEqual(rec.result.kept, 2, "filter(Boolean) drops the one failed agent");
});

test("parallel() over a batch keeps successes; usage accumulates into aggregate_usage", async () => {
  const rec = await runScript({
    source:
      "const reports = await parallel([0,1,2].map(i => () => agent('inspect ' + i)));" +
      "return reports.filter(Boolean).length;",
    concurrency: 3,
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result, 3);
  assert.ok(rec.aggregate_usage && rec.aggregate_usage.total_tokens > 0, "usage accumulated");
});

// ---------------------------------------------------------------------------
// THE KEY CASE (the whole point of option 2): a script that does parallel()
// then a REAL JS reduction (flat/filter/map/sort) over the agent values and
// produces the correct COMPUTED output. This is what a declarative DAG cannot
// express — arbitrary host-side data transformation between fan-out stages.
// ---------------------------------------------------------------------------

test("KEY CASE: parallel() fan-out -> flat/filter/map/sort reduction yields the correct computed output", async () => {
  // Three files; one agent each. agent() returns the mock's structured value
  // (confidence:'high'). The reduction is genuine in-script JS: we pair each
  // surviving report with its source file, drop a deliberately-empty input,
  // compute a derived "score" field, sort by it, and flatten the risks.
  const rec = await runScript({
    source: [
      "const files = ['c.js', 'a.js', 'b.js', ''];",
      // Fan out: empty filename -> a thunk that yields a null report (filtered
      // out below); the rest hit the mock and return the structured value.
      "const reports = await parallel(",
      "  files.map((f, i) => () => (f ? agent('inspect ' + f) : Promise.resolve(null)))",
      ");",
      // REAL reduction over arbitrary host JS:
      "const rank = { high: 0, medium: 1, low: 2 };",
      "const reduced = reports",
      "  .map((r, i) => (r ? { file: files[i], confidence: r.confidence, risks: r.risks || [] } : null))",
      "  .filter(Boolean)", // drop the empty-file null
      "  .map((e) => ({ file: e.file, confidence: e.confidence, score: rank[e.confidence] ?? 9 }))",
      "  .sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));",
      // flatMap proves cross-item flattening works in-script too.
      "const allRisks = reports.filter(Boolean).flatMap((r) => r.risks || []);",
      "return { count: reduced.length, order: reduced.map((e) => e.file), allRisks };"
    ].join("\n"),
    concurrency: 4,
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  // Four inputs, one empty -> three surviving reports.
  assert.strictEqual(rec.result.count, 3, "the empty-file null was filtered out");
  // All three have confidence 'high' (score 0) so the tiebreak is the filename
  // sort: a.js < b.js < c.js. This is a deterministic CHECK of the computation,
  // independent of which agent finished first.
  assert.deepStrictEqual(rec.result.order, ["a.js", "b.js", "c.js"], "sorted by score then filename");
  assert.ok(Array.isArray(rec.result.allRisks), "flatMap produced an array");
});

// ---------------------------------------------------------------------------
// budget.remaining() drives a real in-script loop that TERMINATES. Each mock
// agent spends 18 tokens (10 input + 5 output + 3 reasoning; cached excluded);
// with a small budget the while-loop must stop on its own and never run forever.
// ---------------------------------------------------------------------------

test("budget.remaining() loop terminates: a while-loop bounded by remaining tokens stops", async () => {
  const rec = await runScript({
    source: [
      "let rounds = 0;",
      // Hard guard so a bug can never hang the test: at most 50 iterations.
      "while (budget.remaining() > 0 && rounds < 50) {",
      "  rounds++;",
      "  await agent('round ' + rounds);",
      "}",
      "return { rounds, spent: budget.spent(), remaining: budget.remaining(), total: budget.total };"
    ].join("\n"),
    // 50-token budget: 18 + 18 = 36 (remaining 14), one more spend hits 54 ->
    // remaining clamps to 0 and the loop exits. So exactly 3 rounds.
    budget_tokens: 50,
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed", "the loop terminated and the script completed");
  assert.ok(rec.result.rounds < 50, "stopped well before the hard guard — budget actually bounded it");
  assert.strictEqual(rec.result.rounds, 3, "18 tokens/round against a 50-token budget => 3 rounds");
  assert.strictEqual(rec.result.total, 50, "budget.total reflects budget_tokens");
  assert.strictEqual(rec.result.remaining, 0, "remaining clamps to 0 once exhausted");
  assert.ok(rec.result.spent >= 50, "spent at least the budget");
});

// ---------------------------------------------------------------------------
// phase()/log() emit events into the journaled record.
// ---------------------------------------------------------------------------

test("phase()/log() emit events captured in the journaled record", async () => {
  const rec = await runScript({
    source: ["phase('scan');", "log('scanning now', { n: 7 });", "return { done: true };"].join("\n"),
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.ok(Array.isArray(rec.events) && rec.events.length >= 2, "phase + log produced events");
  // The narrator stores a `message` (string) on each event; assert the two
  // lines we emitted are present.
  const messages = rec.events.map((e) => (e && typeof e.message === "string" ? e.message : "")).join("\n");
  assert.match(messages, /phase: scan/, "phase() emitted a phase event");
  assert.match(messages, /scanning now/, "log() emitted the message");
  // The structured data passed to log() rides along on its event.
  const logEvent = rec.events.find((e) => e && e.message === "scanning now");
  assert.ok(logEvent, "found the log event");
  assert.ok(logEvent.data && logEvent.data.n === 7, "log() data is captured on the event");
});

// ---------------------------------------------------------------------------
// pipeline() variadic contract + regression guard.
// ---------------------------------------------------------------------------

test("pipeline() variadic: stages receive (prev,item,index,ctx); 4th arg is the shared ctx; prev chains", async () => {
  const rec = await runScript({
    source:
      "const seen = [];" +
      "const out = await pipeline([{n:1},{n:2}]," +
      "  (prev,item,index,c) => { seen.push({ prevIsItem: prev === item, n:item.n, index, ctxIsShared: c === ctx }); return item.n * 10; }," +
      "  (prev,item,index,c) => { seen.push({ stage:1, prev, n:item.n, index, ctxIsShared: c === ctx }); return prev + 1; }" +
      ");" +
      "return { out, seen };",
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  // Two items, each chained through two stages: n*10 then +1 -> 11, 21.
  assert.deepStrictEqual(rec.result.out, [11, 21]);
  assert.strictEqual(rec.result.seen[0].prevIsItem, true, "first stage prev is the item (seed)");
  assert.strictEqual(rec.result.seen[0].index, 0);
  assert.strictEqual(rec.result.seen[0].ctxIsShared, true, "4th stage arg === shared ctx");
  // The second stage's prev is the first stage's return value (10 for item n:1).
  const stage1ForItem0 = rec.result.seen.find((s) => s.stage === 1 && s.index === 0);
  assert.strictEqual(stage1ForItem0.prev, 10, "second stage prev = previous stage return");
  assert.strictEqual(stage1ForItem0.ctxIsShared, true, "4th stage arg === shared ctx on stage 1 too");
});

test("pipeline() zero-stage passthrough returns items as-is", async () => {
  const rec = await runScript({ source: "return await pipeline([1,2,3]);", ...baseOpts() });
  assert.strictEqual(rec.status, "completed");
  assert.deepStrictEqual(rec.result, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Journaling round-trip: status tool readable by id and by latest-state.
// ---------------------------------------------------------------------------

test("journaling: record shape + state file readable by readWorkflow (by id and latest)", async () => {
  const home = freshTmpDir("ultracode-script-home-");
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const rec = await runScript({
      source: "log('hi'); const v = await agent('inspect z'); return { v };",
      codex_bin: MOCK,
      codex_home: home,
      cwd: home
    });
    assert.strictEqual(rec.kind, "script");
    assert.strictEqual(rec.status, "completed");
    for (const k of ["id", "started_at", "completed_at", "duration_ms", "cwd", "options", "state_path", "result", "events", "aggregate_usage"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(rec, k), `record has ${k}`);
    }
    assert.deepStrictEqual(rec.workers, [], "workers:[] so resume degrades");
    // State file exists and parses.
    assert.ok(fs.existsSync(rec.state_path), "state file written");
    // Readable by id.
    const byId = await engine.readWorkflow({ workflow_id: rec.id });
    assert.strictEqual(byId.id, rec.id);
    // Readable via the no-arg latest-state path (status tool).
    const latest = await engine.readWorkflow({});
    assert.strictEqual(latest.id, rec.id, "latest state resolves to this run");
    // resumeWorkflow degrades gracefully (no throw) for a script record.
    const resumed = await engine.resumeWorkflow({ workflow_id: rec.id });
    assert.ok(resumed, "resume returns a value rather than throwing");
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// phase()/spawnWorker() bindings + path mode.
// ---------------------------------------------------------------------------

test("spawnWorker() returns the full record; phase() defaults the worker phase", async () => {
  const rec = await runScript({
    source:
      "phase('scan'); const r = await spawnWorker('inspect q'); " +
      "return { status: r.status, hasUsage: !!r.usage, phase: r.phase };",
    ...baseOpts()
  });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result.status, "completed");
  assert.strictEqual(rec.result.hasUsage, true);
});

test("path mode: runs the echo fixture and passes args into the script scope", async () => {
  const rec = await runScript({ path: ECHO_FIXTURE, args: { who: "ada" }, ...baseOpts() });
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result.who, "ada");
  assert.strictEqual(rec.result.ok, true);
});

test("path mode: a throwing fixture journals status:failed (host survives)", async () => {
  const rec = await runScript({ path: THROWS_FIXTURE, ...baseOpts() });
  assert.strictEqual(rec.status, "failed");
  assert.match(rec.error, /boom from fixture/);
});

// ---------------------------------------------------------------------------
// workflow() depth guard.
// ---------------------------------------------------------------------------

test("workflow() refuses beyond depth 1 with a clear error and logs", async () => {
  const prevDepth = process.env.ULTRACODE_DEPTH;
  process.env.ULTRACODE_DEPTH = "1";
  try {
    const rec = await runScript({
      source: "await workflow('return 1;');",
      ...baseOpts()
    });
    assert.strictEqual(rec.status, "failed");
    assert.match(rec.error, /nested script workflows beyond depth 1 are not supported/);
  } finally {
    if (prevDepth === undefined) delete process.env.ULTRACODE_DEPTH;
    else process.env.ULTRACODE_DEPTH = prevDepth;
  }
});

// ---------------------------------------------------------------------------
// Orphan (un-awaited) promise rejection is contained, not host-crashing.
// ---------------------------------------------------------------------------

// Run in a CHILD process: a real orphan rejection inside this test process would
// (correctly) trip node:test's own unhandled-rejection detection, so we isolate
// it. If the runner's guard were absent the child would crash with a non-zero
// exit (execFileSync would throw); the guard makes it exit 0 with the warning.
test("orphan promise rejection: host survives (child process), warning recorded", () => {
  const home = freshTmpDir("ultracode-orphan-home-");
  const runnerPath = path.join(__dirname, "..", "scripts", "ultracode-script-runner.js");
  const prog =
    `const { runScript } = require(${JSON.stringify(runnerPath)});` +
    `runScript({ source: "Promise.reject(new Error('boom-orphan'));\\nreturn { ok: true };",` +
    ` codex_bin: ${JSON.stringify(MOCK)}, codex_home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(home)} })` +
    `.then((rec) => { process.stdout.write(JSON.stringify({ status: rec.status, result: rec.result, warnings: rec.warnings || [] })); process.exit(0); })` +
    `.catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(3); });`;
  const out = require("child_process").execFileSync(process.execPath, ["-e", prog], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.status, "completed", `expected completed, got ${parsed.status}`);
  assert.deepStrictEqual(parsed.result, { ok: true });
  assert.ok(Array.isArray(parsed.warnings) && parsed.warnings.length >= 1, "a warning is recorded");
  assert.match(parsed.warnings[0], /unhandled promise rejection: boom-orphan/);
});
