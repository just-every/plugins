#!/usr/bin/env node
"use strict";

// ===========================================================================
// ultracode-script-runner — opt-in imperative JS workflow-script runner
//
// This is the Codex analogue of Claude Code's Workflow tool: it binds the
// engine's existing orchestration primitives (spawnWorker / runParallel /
// runPipeline / loopUntilDry / adversarialVerify) into a small, ergonomic
// "script scope" so an operator can express a multi-agent workflow as plain
// imperative JavaScript instead of a declarative DAG.
//
//   await runScript({ source: `
//     phase("scan");
//     const hits = await parallel(files.map(f => () => agent("inspect " + f)));
//     return hits.filter(Boolean);
//   ` })
//
// ---------------------------------------------------------------------------
// !!! SECURITY — READ THIS. THIS IS NOT A SANDBOX. !!!
// ---------------------------------------------------------------------------
// runScript() executes ARBITRARY Node.js IN-PROCESS in the host (the MCP
// server or the CLI) with FULL host privileges. The AsyncFunction transform
// below is PURELY ERGONOMIC and provides NO isolation whatsoever. A script
// can require() any module, read/write any file the host user can, read
// process.env (including Codex API keys / tokens, CODEX_HOME and every
// inherited secret), call process.exit, open sockets, and spawn Codex workers
// that themselves run shell (and it may request sandbox:'workspace-write' or
// 'danger-full-access' per call).
//
// Trust level: EXACTLY equal to the codex_bin and the worker sandbox you
// already grant — whoever can author/point at a script can already run code as
// the host user. The threat is therefore NOT "a script escaping a sandbox"
// (there is none) but "an UNTRUSTED script reaching the runner", which the
// CLI/MCP gating prevents:
//   - CLI `script <path>`            : allowed by default (operator ran a local
//                                      file from their own shell).
//   - MCP `ultracode_script`         : DISABLED unless ULTRACODE_ALLOW_SCRIPT=1,
//                                      and prefers an operator-controlled file
//                                      `path` over inline `source`.
//
// The persisted run record (under CODEX_HOME/ultracode/runs) and ctx.events
// may capture whatever the script logs/returns and whatever a worker prints to
// stderr — treat those files as SENSITIVE. We never auto-dump process.env.
//
// Future hardening (NOT done here): run the script in a forked child with a
// curated env allowlist, a frozen require, and resource caps.
// ===========================================================================

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

// Top-level require of the engine is intentional and safe: the engine must
// NOT top-level require this runner (it uses a lazy require wrapper), so there
// is no require cycle. See ultracode-engine.js runScript re-export.
const engine = require("./ultracode-engine");

// ---------------------------------------------------------------------------
// Local helpers (the engine does NOT export writeJson or its id minter, so we
// re-implement the same 3-line write and the same ultra-<stamp>-<hex> id shape
// here to avoid widening the engine surface or churning it beyond one line).
// The id shape MUST match engine.statePathFor()'s runs-dir convention so the
// status / resume tools can read script records.
// ---------------------------------------------------------------------------

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scriptId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `ultra-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Source transform.
//
// The script body is compiled with the AsyncFunction constructor whose NAMED
// PARAMETERS are the bound API. This gives us: top-level `await`, a captured
// top-level `return` value (becomes record.result), and host-level try/catch
// journaling of a throwing/syntactically-broken script. Orphan (un-awaited)
// promise rejections — which fire outside that try/catch — are separately
// captured by a scoped process listener and surfaced as record.warnings, so a
// fire-and-forget rejection can never crash a long-lived host. (A genuinely
// stray synchronous throw on a later timer tick — an uncaughtException — is the
// one residual that is NOT contained; that matches the "as trusted as
// `node <file>`" model and is documented in the security banner.)
//
// ES module sugar is tolerated so a `.workflow.js` file can be authored with
// editor module support:
//   - `export default <expr>`  -> `return <expr>` (line-anchored, FIRST so it
//     wins over the generic strip; a naive strip would turn this into a
//     SyntaxError).
//   - leading `export const|let|var|async|function|class` -> the bare decl
//     (line-anchored so a string literal containing "export const" mid-line is
//     NOT rewritten).
//
// A `"use strict";` prelude is prepended so an undeclared assignment throws
// ("x is not defined") instead of silently leaking a host global. This is a
// HYGIENE measure, not a security boundary — the script can still reach
// globalThis/require/process directly.
// ---------------------------------------------------------------------------

const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\s+/m;
const EXPORT_DECL_RE = /^[ \t]*export\s+(const|let|var|async|function|class)\b/gm;

function transformSource(source) {
  let body = String(source == null ? "" : source);
  body = body.replace(EXPORT_DEFAULT_RE, "return ");
  body = body.replace(EXPORT_DECL_RE, "$1");
  return `"use strict";\n${body}`;
}

// AsyncFunction constructor (function scope, not a fresh global). Intentional
// given the trusted model.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The ordered list of bound-scope parameter names. Kept as a single source of
// truth so the function signature and the call arguments never drift apart.
const SCOPE_PARAMS = [
  "agent",
  "spawnWorker",
  "parallel",
  "pipeline",
  "loopUntilDry",
  "adversarialVerify",
  "log",
  "phase",
  "workflow",
  "budget",
  "args",
  "ctx",
  "WORKER_SCHEMA",
  "VERDICT_SCHEMA"
];

// ---------------------------------------------------------------------------
// Bound script scope. ctx is auto-injected into every primitive so the user
// never has to thread it. `currentPhase` is closure-tracked and used as the
// default phase for agent()/spawnWorker().
// ---------------------------------------------------------------------------

function buildScope(ctx, input) {
  let currentPhase = null;

  // Defaults shared by every spawn: where the codex bin/home live and the cwd.
  // These come from the runScript input so a script never has to repeat them.
  const spawnDefaults = {};
  if (typeof input.codex_bin === "string" && input.codex_bin.trim()) {
    spawnDefaults.codex_bin = input.codex_bin.trim();
  }
  if (typeof input.codex_home === "string" && input.codex_home.trim()) {
    spawnDefaults.codex_home = input.codex_home.trim();
  }
  if (input.cwd) spawnDefaults.cwd = input.cwd;

  // spawnWorker(prompt, opts?) -> FULL engine record {status,value,usage,...}.
  // ctx + phase defaults are injected; never throws (engine resolves a failure
  // to a {status:'failed'} record).
  function spawnWorker(prompt, opts = {}) {
    return engine.spawnWorker(prompt, {
      ...spawnDefaults,
      phase: currentPhase,
      ...opts,
      ctx
    });
  }

  // agent(prompt, opts?) -> worker.value on completion, else null (the engine
  // already logged the failure). The ergonomic happy-path primitive.
  async function agent(prompt, opts = {}) {
    const record = await spawnWorker(prompt, opts);
    return record && record.status === "completed" ? record.value : null;
  }

  // parallel(thunks) -> barrier gather; a throwing thunk degrades to null.
  function parallel(thunks) {
    return engine.runParallel(thunks, { ctx });
  }

  // pipeline(items, ...stages) -> VARIADIC. engine.runPipeline takes stages as
  // an ARRAY; collecting the rest params here is MANDATORY. Passing stages
  // positionally would silently null every item (opts lands on a stage fn so
  // ctx becomes null and even the drop-log is a no-op). Each stage receives
  // (prev, item, index, ctx).
  function pipeline(items, ...stages) {
    return engine.runPipeline(items, stages, { ctx });
  }

  function loopUntilDry(makePrompt, opts = {}) {
    return engine.loopUntilDry(makePrompt, { ...spawnDefaults, ...opts, ctx });
  }

  function adversarialVerify(findings, opts = {}) {
    return engine.adversarialVerify(findings, { ...spawnDefaults, ...opts, ctx });
  }

  // log(message, data?) routes through the engine's narrator so script lines
  // land in ctx.events alongside primitive logs.
  function log(message, data) {
    return engine.log(ctx, message, data);
  }

  // phase(title) sets the closure-tracked currentPhase used as the default
  // phase for subsequent agent()/spawnWorker() calls.
  function phase(title) {
    currentPhase = typeof title === "string" && title.trim() ? title.trim() : null;
    engine.log(ctx, `phase: ${currentPhase || "(none)"}`, { phase: currentPhase });
    return currentPhase;
  }

  // workflow(pathOrSource, args?) -> one-level nested runScript, guarded by
  // ULTRACODE_DEPTH. Refuses (and logs) beyond depth 1 with a clear, explicit
  // throw rather than silently no-op'ing. The nested run inherits concurrency/
  // budget/cap knobs but creates its own ctx at depth+1 (the engine pattern).
  function workflow(pathOrSource, workflowArgs) {
    const depth = Number(process.env.ULTRACODE_DEPTH || 0);
    if (depth >= 1) {
      engine.log(ctx, "nested script workflow refused: depth limit reached", {
        reason: "maxDepth",
        depth
      });
      throw new Error("nested script workflows beyond depth 1 are not supported");
    }
    // A bare string with no newline and an existing-looking path is treated as
    // a path; anything containing a newline is inline source. Callers can be
    // explicit by passing { path } / { source }.
    const nested = {
      args: workflowArgs,
      cwd: input.cwd,
      concurrency: input.concurrency,
      budget_tokens: input.budget_tokens,
      max_agents: input.max_agents,
      max_retries: input.max_retries,
      base_delay_ms: input.base_delay_ms,
      max_delay_ms: input.max_delay_ms,
      retry_jitter: input.retry_jitter,
      signal: ctx.signal,
      on_event: ctx.onEvent || undefined,
      codex_bin: spawnDefaults.codex_bin,
      codex_home: spawnDefaults.codex_home
    };
    if (pathOrSource && typeof pathOrSource === "object") {
      Object.assign(nested, pathOrSource);
    } else if (typeof pathOrSource === "string" && pathOrSource.includes("\n")) {
      nested.source = pathOrSource;
    } else {
      nested.path = pathOrSource;
    }
    return runScript(nested);
  }

  return {
    agent,
    spawnWorker,
    parallel,
    pipeline,
    loopUntilDry,
    adversarialVerify,
    log,
    phase,
    workflow,
    budget: ctx.budget,
    args: input.args,
    ctx,
    WORKER_SCHEMA: engine.WORKER_SCHEMA,
    VERDICT_SCHEMA: engine.VERDICT_SCHEMA
  };
}

// ---------------------------------------------------------------------------
// runScript(input) -> Promise<workflowRecord>
// ---------------------------------------------------------------------------

async function runScript(input = {}) {
  // XOR-validate source|path: exactly one is required.
  const hasSource = typeof input.source === "string" && input.source.length > 0;
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
  if (hasSource && hasPath) {
    throw new Error("runScript: provide exactly one of `source` or `path`, not both.");
  }
  if (!hasSource && !hasPath) {
    throw new Error("runScript: one of `source` or `path` is required.");
  }

  const cwd = path.resolve(input.cwd || process.cwd());
  // Read the file by its contents only (dirname-independent): the script body
  // does not depend on where the file lives on disk.
  const source = hasSource ? input.source : await fs.readFile(path.resolve(input.path), "utf8");

  const id = scriptId();
  const ctx = engine.createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });

  const startedAt = new Date().toISOString();
  const statePath = engine.statePathFor(id);

  const record = {
    id,
    kind: "script",
    status: "running",
    started_at: startedAt,
    completed_at: null,
    duration_ms: 0,
    cwd,
    options: {
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      max_retries: input.max_retries === undefined ? null : input.max_retries,
      base_delay_ms: input.base_delay_ms === undefined ? null : input.base_delay_ms,
      max_delay_ms: input.max_delay_ms === undefined ? null : input.max_delay_ms,
      retry_jitter: input.retry_jitter === undefined ? null : input.retry_jitter
    },
    state_path: statePath,
    // A script record is NOT step-resumable. Set workers:[] explicitly so
    // engine.resumeWorkflow degrades to a clean "nothing to resume" (it iterates
    // record.workers) and engine.readWorkflow / the status tool still read it.
    workers: [],
    result: null,
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };

  // Persist a "running" snapshot up-front so an interrupted run still leaves a
  // readable record (mirrors runWorkflow).
  await writeJson(statePath, record);

  const scope = buildScope(ctx, { ...input, cwd });

  // Capture orphan (un-awaited) promise rejections from the script. A
  // fire-and-forget rejection (e.g. `Promise.reject(x)` with no await) fires on
  // a later tick — outside the try/await below — and would otherwise become a
  // process-level 'unhandledRejection' that crashes a long-lived host such as
  // the MCP server. A scoped listener installed only for the run both suppresses
  // Node's default crash and surfaces the rejection as a record warning.
  // (Under rare concurrent runs every listener sees every rejection; that
  // over-reports but never crashes — acceptable for the trusted-code model.)
  const orphanRejections = [];
  const onUnhandledRejection = (reason) => {
    orphanRejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  // Build the async body. A SyntaxError here is caught below and journaled as
  // status:'failed' so a broken script never crashes the host.
  let result = null;
  let error = null;
  try {
    let fn;
    try {
      fn = new AsyncFunction(...SCOPE_PARAMS, transformSource(source));
    } catch (compileError) {
      // SyntaxError from the AsyncFunction constructor.
      throw compileError;
    }
    const callArgs = SCOPE_PARAMS.map((name) => scope[name]);
    result = await fn(...callArgs);
  } catch (runError) {
    error = runError;
  } finally {
    // Yield one macrotask so any orphan rejection scheduled during the run is
    // delivered while the listener is still installed, then stop listening.
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }

  const completedAt = new Date().toISOString();
  record.completed_at = completedAt;
  record.duration_ms = Date.parse(completedAt) - Date.parse(startedAt);
  // aggregate_usage is the same object ctx mutated during the run; snapshot it
  // into the record explicitly to match the engine's finalized shape.
  record.aggregate_usage = ctx.usageTotals;
  record.events = ctx.events;
  if (error) {
    record.status = "failed";
    record.result = null;
    record.error = error instanceof Error ? error.message : String(error);
  } else {
    record.status = "completed";
    record.result = result === undefined ? null : result;
  }

  // A script that returned a value but also leaked an un-awaited rejection is
  // still 'completed' (its result is valid), but the leak is surfaced loudly as
  // a warning + a log event rather than silently swallowed.
  if (orphanRejections.length > 0) {
    record.warnings = orphanRejections.map((message) => `unhandled promise rejection: ${message}`);
    for (const message of orphanRejections) {
      engine.log(ctx, `script emitted an unhandled promise rejection: ${message}`, { reason: "unhandled-rejection" });
    }
    record.events = ctx.events;
  }

  // Final write. Wrapped so a serialization failure (e.g. a non-JSON-able
  // script return value) still journals a useful failure instead of throwing
  // out of runScript.
  try {
    await writeJson(statePath, record);
  } catch (writeError) {
    record.status = "failed";
    record.result = null;
    record.error = `result could not be journaled: ${writeError.message}`;
    // Best-effort second write of the now-sanitized record.
    try {
      await writeJson(statePath, record);
    } catch {
      /* nothing more we can do; return the in-memory record */
    }
  }

  return record;
}

module.exports = { runScript, transformSource };
