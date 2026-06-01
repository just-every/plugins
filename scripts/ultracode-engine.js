#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fsSync = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const util = require("util");

const appServerClient = require("./app-server-client");

const execFileP = util.promisify(childProcess.execFile);

const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_AGENTS = 1000;
const MAX_NESTING_DEPTH = 1;
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
// Worker transports. 'exec' (default) = today's `codex exec --json` JSONL
// scraping, byte-for-byte unchanged. 'app-server' = opt-in versioned JSON-RPC
// app-server transport (with automatic fallback to exec). 'exec-server' = a
// reserved value that throws an explicit not-implemented error (the seam is kept
// open but the heavier ws/remote-executor integration is deferred).
const VALID_TRANSPORTS = new Set(["exec", "app-server", "exec-server"]);

const WORKER_ROLES = [
  {
    id: "context-scout",
    title: "Context Scout",
    focus:
      "Map the relevant files, entry points, existing patterns, and constraints. Avoid implementation unless asked."
  },
  {
    id: "implementation-planner",
    title: "Implementation Planner",
    focus:
      "Propose the smallest coherent implementation path that fits the existing codebase and avoids unnecessary infrastructure."
  },
  {
    id: "risk-reviewer",
    title: "Risk Reviewer",
    focus:
      "Look for regressions, hidden coupling, missing tests, unsafe assumptions, and behavioral edge cases."
  },
  {
    id: "test-strategist",
    title: "Test Strategist",
    focus:
      "Identify the most meaningful verification commands, fixtures, and focused tests for the task."
  },
  {
    id: "api-contract-reviewer",
    title: "API Contract Reviewer",
    focus:
      "Check schemas, public contracts, tool interfaces, and compatibility boundaries."
  },
  {
    id: "cleanup-reviewer",
    title: "Cleanup Reviewer",
    focus:
      "Find stale paths, redundant abstractions, deprecated code, and opportunities to keep the change lean."
  },
  {
    id: "docs-operator",
    title: "Docs Operator",
    focus:
      "Identify only durable documentation or instruction updates that are genuinely required."
  },
  {
    id: "final-verifier",
    title: "Final Verifier",
    focus:
      "Review the proposed path as if signing off on the work. Be concrete about remaining proof needed."
  }
];

const WORKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    recommended_actions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: ["summary", "findings", "recommended_actions", "risks", "verification", "confidence"]
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["refuted", "reason"]
};

function workflowId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `ultra-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function codexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return process.env.CODEX_HOME.trim();
  }
  return path.join(os.homedir(), ".codex");
}

function isExecutable(filePath) {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function defaultCodexBin() {
  if (process.env.CODEX_CLI_PATH && process.env.CODEX_CLI_PATH.trim()) {
    return process.env.CODEX_CLI_PATH.trim();
  }

  const candidates = [
    path.join(path.dirname(process.execPath), "codex"),
    "/Applications/Codex zemaj.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return "codex";
}

function stateDir() {
  return path.join(codexHome(), "ultracode", "runs");
}

function statePathFor(id) {
  return path.join(stateDir(), `${id}.json`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveInteger(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`workers must be an integer between 1 and ${max}.`);
  }
  return Math.min(number, max);
}

function normalizeOptions(input = {}) {
  const task = assertNonEmptyString(input.task, "task");
  const cwd = path.resolve(input.cwd || process.cwd());
  const workerCount = positiveInteger(input.workers, DEFAULT_WORKERS, MAX_WORKERS);
  const sandbox = input.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const reasoningEffort = input.reasoning_effort || input.reasoningEffort;
  if (reasoningEffort !== undefined && !VALID_EFFORTS.has(reasoningEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const timeoutMs =
    input.timeout_ms === undefined || input.timeout_ms === null
      ? DEFAULT_TIMEOUT_MS
      : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
  if (!Number.isFinite(timeoutMs)) {
    throw new Error("timeout_ms must be a finite number.");
  }

  return {
    task,
    cwd,
    workers: workerCount,
    sandbox,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
    reasoning_effort: reasoningEffort,
    timeout_ms: timeoutMs,
    // Opt-in transport (default 'exec' = unchanged). resolveTransport coerces an
    // unknown value back to 'exec', so a stray input never changes the default.
    transport: resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT)),
    transport_strict: resolveBool(firstDefined(input.transport_strict, input.transportStrict), false),
    codex_bin:
      typeof input.codex_bin === "string" && input.codex_bin.trim()
        ? input.codex_bin.trim()
        : defaultCodexBin(),
    codex_home:
      typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome()
  };
}

function selectRoles(count) {
  return WORKER_ROLES.slice(0, count).map((role, index) => ({
    index,
    id: role.id,
    title: role.title,
    focus: role.focus
  }));
}

function planWorkflow(input = {}) {
  const options = normalizeOptions(input);
  return {
    task: options.task,
    cwd: options.cwd,
    workers: selectRoles(options.workers),
    defaults: {
      sandbox: options.sandbox,
      timeout_ms: options.timeout_ms,
      model: options.model || null,
      reasoning_effort: options.reasoning_effort || null
    }
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function latestStatePath() {
  let entries;
  try {
    entries = await fs.readdir(stateDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(stateDir(), entry.name));
  if (files.length === 0) return null;
  const stats = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0].file;
}

async function readWorkflow(input = {}) {
  let filePath;
  if (input.state_path) {
    filePath = path.resolve(assertNonEmptyString(input.state_path, "state_path"));
  } else if (input.workflow_id) {
    filePath = statePathFor(assertNonEmptyString(input.workflow_id, "workflow_id"));
  } else {
    filePath = await latestStatePath();
  }
  if (!filePath) {
    return { status: "missing", message: "No Ultracode workflow state exists yet." };
  }
  return readJson(filePath);
}

// ---------------------------------------------------------------------------
// Orchestration primitives (Claude Workflow-tool parity layer)
// ---------------------------------------------------------------------------

function defaultConcurrency() {
  let cpus = 1;
  try {
    cpus = os.cpus().length || 1;
  } catch {
    cpus = 1;
  }
  return Math.max(1, Math.min(16, cpus - 2));
}

// Dependency-free promise pool / semaphore. Bounds the number of `codex exec`
// subprocesses that run at once across every primitive in a single run.
function createLimiter(maxConcurrent) {
  const max = Math.max(1, Math.floor(maxConcurrent) || 1);
  let active = 0;
  const queue = [];
  function drain() {
    while (active < max && queue.length > 0) {
      const { thunk, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(thunk)
        .then(
          (value) => {
            active -= 1;
            resolve(value);
            drain();
          },
          (error) => {
            active -= 1;
            reject(error);
            drain();
          }
        );
    }
  }
  return {
    run(thunk) {
      return new Promise((resolve, reject) => {
        queue.push({ thunk, resolve, reject });
        drain();
      });
    },
    active: () => active,
    queued: () => queue.length,
    max
  };
}

function emitEvent(ctx, event) {
  if (!ctx) return;
  const stamped = { at: new Date().toISOString(), ...event };
  ctx.events.push(stamped);
  if (ctx.onEvent) {
    try {
      ctx.onEvent(stamped);
    } catch {
      /* progress sink errors must never break a run */
    }
  }
}

// Narrator progress line. Mandatory on every drop / cap / timeout / budget stop
// so nothing is silently truncated.
function log(ctx, message, data) {
  emitEvent(ctx, { type: "log", message, ...(data ? { data } : {}) });
}

const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

function emptyUsage() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
}

function addUsageInto(totals, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const key of USAGE_KEYS) {
    if (typeof usage[key] === "number" && Number.isFinite(usage[key])) totals[key] += usage[key];
  }
  totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.reasoning_output_tokens;
}

function accountUsage(ctx, usage) {
  if (!ctx) return;
  addUsageInto(ctx.usageTotals, usage);
}

function sumUsageFromWorkers(workers) {
  const totals = emptyUsage();
  for (const worker of workers || []) addUsageInto(totals, worker && worker.usage);
  return totals;
}

// Per-run context: shared limiter, usage accumulator, budget gate, lifetime
// agent cap, and progress sink. Threaded into every spawn/primitive.
function createContext(opts = {}) {
  const concurrency = opts.concurrency ? Math.max(1, Math.floor(Number(opts.concurrency))) : defaultConcurrency();
  const usageTotals = emptyUsage();
  const budgetTotal =
    opts.budgetTokens === undefined || opts.budgetTokens === null || opts.budgetTokens === ""
      ? null
      : Math.max(0, Math.floor(Number(opts.budgetTokens)));

  // Cancellation: ctx owns an internal AbortController whose signal threads down
  // into every spawn. When no external signal is supplied, the controller is
  // never aborted, so ctx.signal.aborted stays false forever and every new abort
  // gate is a no-op — byte-identical to the pre-cancellation engine.
  const controller = new AbortController();
  const externalSignal = opts.signal && typeof opts.signal.addEventListener === "function" ? opts.signal : null;

  const ctx = {
    workflowId: opts.workflowId || null,
    limiter: createLimiter(concurrency),
    concurrency,
    usageTotals,
    events: [],
    spawnedCount: 0,
    maxAgents: opts.maxAgents ? Math.max(1, Math.floor(Number(opts.maxAgents))) : DEFAULT_MAX_AGENTS,
    depth: Number.isFinite(opts.depth) ? opts.depth : 0,
    maxDepth: Number.isFinite(opts.maxDepth) ? opts.maxDepth : MAX_NESTING_DEPTH,
    onEvent: typeof opts.onEvent === "function" ? opts.onEvent : null,
    signal: controller.signal,
    budget: {
      total: budgetTotal,
      spent: () => usageTotals.total_tokens,
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - usageTotals.total_tokens))
    }
  };
  ctx.cancelled = () => controller.signal.aborted;
  ctx.cancel = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason === undefined ? "cancelled" : reason);
    emitEvent(ctx, {
      type: "cancelled",
      reason: typeof reason === "string" ? reason : "cancelled"
    });
  };

  // Mirror an external AbortSignal into the internal controller (so ctx.cancel
  // still works and external aborts are observed). A pre-aborted external signal
  // is mirrored immediately; otherwise we listen once. Both paths emit a single
  // 'cancelled' journal event via ctx.cancel.
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
    } else {
      externalSignal.addEventListener(
        "abort",
        () => {
          ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
        },
        { once: true }
      );
    }
  }
  return ctx;
}

// Dependency-free validator for the JSON Schema subset the engine emits.
// Fails open on unknown keywords so valid Codex output is never wrongly rejected.
function validateAgainstSchema(value, schema) {
  const errors = [];
  function check(val, sch, p) {
    if (!sch || typeof sch !== "object") return;
    if (sch.type) {
      const t = sch.type;
      const ok =
        t === "object"
          ? val && typeof val === "object" && !Array.isArray(val)
          : t === "array"
          ? Array.isArray(val)
          : t === "string"
          ? typeof val === "string"
          : t === "integer"
          ? Number.isInteger(val)
          : t === "number"
          ? typeof val === "number" && Number.isFinite(val)
          : t === "boolean"
          ? typeof val === "boolean"
          : t === "null"
          ? val === null
          : true;
      if (!ok) {
        errors.push(`${p || "(root)"}: expected ${t}`);
        return;
      }
    }
    if (Array.isArray(sch.enum) && !sch.enum.includes(val)) {
      errors.push(`${p || "(root)"}: must be one of ${JSON.stringify(sch.enum)}`);
    }
    // Detect object/array shape by keyword presence too, not just `type`, so a
    // caller-supplied subschema that omits `type` is still validated.
    const isObjectShape =
      sch.type === "object" || sch.properties || sch.required || sch.additionalProperties !== undefined;
    if (isObjectShape && val && typeof val === "object" && !Array.isArray(val)) {
      const props = sch.properties || {};
      for (const req of sch.required || []) {
        if (!(req in val)) errors.push(`${p ? `${p}.` : ""}${req}: required`);
      }
      if (sch.additionalProperties === false) {
        for (const key of Object.keys(val)) {
          if (!(key in props)) errors.push(`${p ? `${p}.` : ""}${key}: unexpected property`);
        }
      }
      for (const [key, subSchema] of Object.entries(props)) {
        if (key in val) check(val[key], subSchema, `${p ? `${p}.` : ""}${key}`);
      }
    }
    const isArrayShape = sch.type === "array" || sch.items;
    if (isArrayShape && Array.isArray(val) && sch.items) {
      val.forEach((item, index) => check(item, sch.items, `${p}[${index}]`));
    }
  }
  check(value, schema, "");
  return { ok: errors.length === 0, errors };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function stepId(parts) {
  return crypto.createHash("sha1").update(stableStringify(parts)).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Transient-error classification + bounded exponential backoff
//
// A non-zero `codex exec` exit (or a spawn errno) is classified into transient
// (worth retrying with backoff) vs permanent (fail immediately, exactly as the
// engine did before this layer existed). The default is fail-closed: an unknown
// non-zero exit is treated as PERMANENT so behavior matches the pre-retry engine
// unless a pattern explicitly marks it transient. Retries are SEPARATE from the
// schema-validation retry loop (a schema-invalid-but-exit-0 run is never
// transient — it parsed fine and exited 0).
// ---------------------------------------------------------------------------

// errno codes that mean the binary itself is wrong / unrunnable — never retry.
const PERMANENT_SPAWN_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
// errno that can transiently happen when the freshly-written/locked bin is busy.
const TRANSIENT_SPAWN_CODES = new Set(["ETXTBSY"]);

// Permanent stderr/stdout signatures (auth / bad-flag / usage / schema). Checked
// FIRST so e.g. an "unauthorized" message is never mistaken for transient.
const PERMANENT_OUTPUT_RE = /unauthorized|invalid api key|authentication|forbidden\b|permission denied|unknown (option|argument|flag)|unrecognized|invalid value|schema|usage:/i;
// Retryable signatures: HTTP 429/5xx, rate-limit, known network errno, overload.
const RETRYABLE_OUTPUT_RE = /\b(429|5\d\d)\b|rate.?limit|too many requests|temporarily unavailable|timed? out|timeout|connection reset|connection refused|econnreset|econnrefused|etimedout|enetunreach|eai_again|socket hang up|network|server error|service unavailable|overloaded|please try again/i;

// Pure classifier. Inputs: the thrown Error (errno on error.code for spawn
// failures) and the attached exec result (error.codex_exec). Returns
// { transient, reason }.
function classifyCodexError(error, execResult) {
  const code = error && typeof error.code === "string" ? error.code : null;
  // Spawn-level errno is the most reliable signal — check it first.
  if (code && PERMANENT_SPAWN_CODES.has(code)) {
    return { transient: false, reason: `spawn ${code}` };
  }
  if (code && TRANSIENT_SPAWN_CODES.has(code)) {
    return { transient: true, reason: `spawn ${code}` };
  }
  const exec = execResult || (error && error.codex_exec) || null;
  // A timeout is treated as permanent: a retry would just re-burn the full
  // wall-clock timeout, multiplying cost for no benefit.
  if (exec && exec.timed_out === true) {
    return { transient: false, reason: "timed out" };
  }
  const haystack = exec ? `${exec.stderr || ""}\n${exec.stdout || ""}` : "";
  // Permanent patterns win over retryable ones.
  if (haystack && PERMANENT_OUTPUT_RE.test(haystack)) {
    return { transient: false, reason: "permanent error pattern" };
  }
  // Only a genuinely non-zero exit (not a schema/read failure on a clean exit)
  // qualifies as a retryable runtime error.
  const nonZero = exec && typeof exec.exit_code === "number" && exec.exit_code !== 0;
  if (nonZero && haystack && RETRYABLE_OUTPUT_RE.test(haystack)) {
    const m = RETRYABLE_OUTPUT_RE.exec(haystack);
    return { transient: true, reason: m ? `retryable: ${m[0]}` : "retryable error pattern" };
  }
  // Fail closed: unknown non-zero exits behave exactly as before (no retry).
  return { transient: false, reason: "non-transient" };
}

// Bounded exponential backoff. attempt is the zero-based transient-retry index.
// exp = min(max, base * 2**attempt); full-jitter randomizes within [0, exp].
function backoffDelay(attempt, base, max, jitter) {
  const safeBase = Math.max(0, Number(base) || 0);
  const safeMax = Math.max(0, Number(max) || 0);
  const exp = Math.min(safeMax, safeBase * Math.pow(2, attempt));
  if (!jitter) return Math.floor(exp);
  return Math.floor(Math.random() * (exp + 1));
}

// Promise wrapping setTimeout(ms) that short-circuits if the AbortSignal is
// (or becomes) aborted. Rejects with an abort Error so callers can stop a retry
// loop mid-backoff. Pure Node timers; clears the timer + removes the listener on
// every settle path so nothing leaks.
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    function cleanup() {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal) {
  const reason = signal && signal.reason !== undefined ? signal.reason : "aborted";
  const err = new Error(`cancelled: ${typeof reason === "string" ? reason : "aborted"}`);
  err.code = "ABORT_ERR";
  err.cancelled = true;
  return err;
}

// ---------------------------------------------------------------------------
// Codex subprocess layer
// ---------------------------------------------------------------------------

function workerPrompt({ task, workflow, worker, sandbox }) {
  return [
    `You are an Ultracode subprocess worker: ${worker.title}.`,
    `Workflow id: ${workflow.id}`,
    `Workspace: ${workflow.cwd}`,
    "",
    "Primary task:",
    task,
    "",
    "Your focus:",
    worker.focus,
    "",
    sandbox === "read-only"
      ? "You are running in a read-only worker lane. Inspect and reason; do not attempt to modify files."
      : "Only modify files if the user task explicitly requires this worker lane to do so.",
    "",
    "Return concrete evidence. Prefer paths, commands, risks, and next actions over generic advice.",
    "Your final response must satisfy the provided JSON schema exactly."
  ].join("\n");
}

function buildCodexArgs(opts, schemaPath, lastMessagePath) {
  const args = ["exec", "--json"];
  if (!opts.persistSession) args.push("--ephemeral");
  args.push("--skip-git-repo-check", "--sandbox", opts.sandbox, "-c", 'approval_policy="never"');
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push("--output-last-message", lastMessagePath, "--cd", opts.cwd);
  if (opts.model) args.push("-m", opts.model);
  if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  if (opts.profile) args.push("-p", opts.profile);
  for (const dir of opts.addDirs || []) args.push("--add-dir", dir);
  args.push("-");
  return args;
}

// Args for a WARM follow-up turn: `codex exec resume <session_id> <prompt>`.
// SPIKE CONSTRAINT (verified against real codex-cli via clap parse errors, no
// model calls): the `resume` subcommand REJECTS --output-schema, -s/--sandbox,
// -C/--cd, --add-dir, and -p/--profile. Sandbox, cwd, and profile are inherited
// from the original persisted session's session_meta, so they must NOT be
// re-passed here. Schema on a resume turn is enforced out-of-band: the JSON
// schema is injected into the prompt text AND validated post-hoc by the existing
// validateAgainstSchema + schema-retry loop — never via --output-schema.
//
// Emits ONLY resume-supported flags: exec resume --json --skip-git-repo-check
// <sessionId> -o <lastMessagePath>, plus -m model and
// -c model_reasoning_effort=... when set, then `-` (stdin prompt).
function buildResumeArgs(opts, sessionId, lastMessagePath) {
  const args = ["exec", "resume", "--json", "--skip-git-repo-check", sessionId, "-o", lastMessagePath];
  if (opts.model) args.push("-m", opts.model);
  if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  args.push("-");
  return args;
}

// Detectable signal (verified against real codex-cli, no model call) that a
// `codex exec resume <id>` turn cannot use the requested session: the resume
// rollout is gone / unknown. Also treats any non-zero exit / missing-last-message
// from a resume turn as "resume unavailable" so the worker can transparently fall
// back to a cold exec rather than failing the run.
const RESUME_UNAVAILABLE_RE = /no rollout found for thread id|thread\/resume|rollout not found|-32600/i;

function isResumeUnavailable(error, execResult) {
  const exec = execResult || (error && error.codex_exec) || null;
  const haystack = `${(error && error.message) || ""}\n${exec ? `${exec.stderr || ""}\n${exec.stdout || ""}` : ""}`;
  if (RESUME_UNAVAILABLE_RE.test(haystack)) return true;
  // A resume turn that exited non-zero (for any reason) or produced no readable
  // last-message is treated as resume-unavailable: warm context is a pure
  // optimization, so we degrade to cold rather than surface a resume-only error.
  if (exec && typeof exec.exit_code === "number" && exec.exit_code !== 0) return true;
  return false;
}

// Resume turns cannot pass --output-schema (the CLI rejects it). When a schema is
// required, inject it into the prompt text so the model still targets the shape;
// the existing post-hoc validateAgainstSchema + schema-retry loop enforces it.
function injectSchemaIntoPrompt(prompt, schema) {
  if (!schema) return prompt;
  return [
    prompt,
    "",
    "Your final response MUST be a single JSON object that satisfies this JSON schema exactly (no prose, no code fences):",
    JSON.stringify(schema, null, 2)
  ].join("\n");
}

function parseUsage(stdout) {
  let latest = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && event.type === "turn.completed" && event.usage) {
      latest = event.usage;
    }
  }
  return latest;
}

function spawnCodex({ bin, args, cwd, env, prompt, timeoutMs, onStreamEvent, signal }) {
  return new Promise((resolve, reject) => {
    // Abort before spawning: never create a child for an already-cancelled run.
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let threadId = null;
    let lastUsage = null;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer = null;
    let abortListener = null;
    const child = childProcess.spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5_000);
      }
    }, timeoutMs);

    // Cancellation: reuse the proven timeout kill ladder (SIGTERM -> 5s ->
    // SIGKILL). The child's natural close/error path then settles via finish(),
    // which reports cancelled:true. kill() is wrapped because the child may have
    // already exited (harmless ESRCH).
    if (signal) {
      abortListener = () => {
        if (settled) return;
        cancelled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* child may already be gone */
        }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            if (!settled) {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }
          }, 5_000);
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    function processLine(rawLine) {
      const line = rawLine.trim();
      if (!line) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      if (!threadId && typeof event.thread_id === "string") threadId = event.thread_id;
      if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
      if (event.type === "turn.completed" && event.usage) lastUsage = event.usage;
      if (onStreamEvent) {
        try {
          onStreamEvent(event);
        } catch {
          /* ignore */
        }
      }
    }

    function handleStdout(text) {
      stdout += text;
      lineBuf += text;
      let newline;
      while ((newline = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, newline);
        lineBuf = lineBuf.slice(newline + 1);
        processLine(line);
      }
    }

    function flushStdout() {
      if (lineBuf) {
        const remaining = lineBuf;
        lineBuf = "";
        processLine(remaining);
      }
    }

    function finish(error, code, exitSignal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      const result = {
        pid: child.pid || null,
        exit_code: code,
        signal: exitSignal,
        timed_out: timedOut,
        cancelled,
        duration_ms: Date.now() - startedAt,
        thread_id: threadId,
        usage: lastUsage,
        stdout,
        stderr
      };
      if (error) {
        error.codex_exec = result;
        if (cancelled) error.cancelled = true;
        reject(error);
      } else {
        resolve(result);
      }
    }

    child.stdout.on("data", (chunk) => handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error, null, null));
    child.on("close", (code, exitSignal) => {
      flushStdout();
      if (cancelled) {
        finish(new Error("Codex worker cancelled."), code, exitSignal);
        return;
      }
      if (timedOut) {
        finish(new Error(`Codex worker timed out after ${timeoutMs}ms.`), code, exitSignal);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || exitSignal || `exit code ${code}`;
        finish(new Error(`Codex worker exited with ${detail}.`), code, exitSignal);
        return;
      }
      finish(null, code, exitSignal);
    });
    // The child may exit / be killed (timeout SIGTERM/SIGKILL) before the prompt
    // finishes flushing, producing EPIPE on stdin. Without this listener that
    // would surface as an uncaught exception and take down the host process; the
    // child "close"/"error" handlers already settle the promise via finish().
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function resolveWorkerOpts(opts = {}) {
  const sandbox = opts.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const reasoningEffort = opts.reasoningEffort || opts.reasoning_effort;
  if (reasoningEffort !== undefined && reasoningEffort !== null && !VALID_EFFORTS.has(reasoningEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const schema = opts.schema === undefined ? WORKER_SCHEMA : opts.schema;
  // Warm-context executor selection. 'cold' (default) = unchanged cold exec
  // fan-out. 'resume' = keep a Codex session warm across turns via
  // `codex exec resume` (forces persistSession so a session id exists to resume).
  // 'fork' = forward-compat alias; the spike proved fork is interactive-TUI-only
  // with no --json, so it transparently degrades to cold (handled at the call
  // site that consults this value).
  const executor =
    opts.executor === "resume" || opts.executor === "fork" || opts.executor === "cold" ? opts.executor : "cold";
  const persistSession = !!opts.persistSession || executor === "resume";
  // Transport selection (opt-in, off-by-default). Sourced from the explicit
  // option, then the ULTRACODE_TRANSPORT env. Anything not exactly 'app-server'
  // or 'exec-server' resolves to 'exec' = today's path unchanged. 'strict' (off
  // by default) controls whether an app-server failure falls back to exec.
  const transport = resolveTransport(firstDefined(opts.transport, process.env.ULTRACODE_TRANSPORT));
  const transportStrict = resolveBool(firstDefined(opts.transport_strict, opts.transportStrict), false);
  return {
    sandbox,
    model: typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined,
    reasoningEffort: reasoningEffort || undefined,
    timeoutMs: opts.timeoutMs || opts.timeout_ms || DEFAULT_TIMEOUT_MS,
    cwd: path.resolve(opts.cwd || process.cwd()),
    bin: opts.codex_bin || defaultCodexBin(),
    codex_home: opts.codex_home || codexHome(),
    profile: typeof opts.profile === "string" && opts.profile.trim() ? opts.profile.trim() : undefined,
    addDirs: Array.isArray(opts.addDirs) ? opts.addDirs : [],
    persistSession,
    executor,
    transport,
    transportStrict,
    schema,
    schemaRetries:
      opts.schemaRetries === undefined ? (schema ? 1 : 0) : Math.max(0, Math.floor(Number(opts.schemaRetries))),
    // Transient-error retry knobs. maxRetries defaults to 0 => zero transient
    // retries => identical to the pre-retry engine on every non-zero exit.
    maxRetries: clampNonNegInt(firstDefined(opts.maxRetries, opts.max_retries), 0),
    baseDelayMs: clampNonNegInt(firstDefined(opts.baseDelayMs, opts.base_delay_ms), 500),
    maxDelayMs: clampNonNegInt(firstDefined(opts.maxDelayMs, opts.max_delay_ms), 30_000),
    retryJitter: resolveBool(firstDefined(opts.retryJitter, opts.retry_jitter), true),
    label: opts.label || opts.title || "worker",
    phase: opts.phase || null,
    isolation: opts.isolation === "worktree" ? "worktree" : undefined
  };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function clampNonNegInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function resolveBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(false|0|no|off)$/i.test(value.trim())) return false;
    if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
  }
  return Boolean(value);
}

// Resolve a worker transport. Defaults to 'exec' (today's path). Only the exact
// strings 'app-server' and 'exec-server' select an alternative; everything else
// (undefined, empty, unknown) stays 'exec' so a stray env/option can never
// silently change the default behavior.
function resolveTransport(value) {
  if (typeof value !== "string") return "exec";
  const v = value.trim();
  return VALID_TRANSPORTS.has(v) ? v : "exec";
}

// Normalize an app-server camelCase TokenUsageBreakdown into the engine's
// snake_case USAGE_KEYS shape. Re-exported via app-server-client so both layers
// agree; kept here too for callers that already hold the engine module.
function normalizeAppServerUsage(breakdown) {
  return appServerClient._internal.normalizeUsage(breakdown);
}

async function createWorktree(baseDir) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-wt-"));
  // `git worktree add` requires the target path to not already exist.
  await fs.rm(dir, { recursive: true, force: true });
  await execFileP("git", ["-C", baseDir, "worktree", "add", "--detach", dir, "HEAD"]);
  return { dir, base: baseDir };
}

async function removeWorktree(worktree) {
  try {
    await execFileP("git", ["-C", worktree.base, "worktree", "remove", "--force", worktree.dir]);
  } catch {
    await fs.rm(worktree.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function collectDiff(worktree) {
  const { stdout } = await execFileP("git", ["-C", worktree.dir, "diff", "HEAD"], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// resumeSessionId (default null): when null the byte-for-byte cold path runs
// (buildCodexArgs, still appends --ephemeral unless persistSession). When a
// session id is supplied the WARM path runs (buildResumeArgs) — no --output-schema
// is written even when `schema` is set, because the resume subcommand rejects it;
// the schema is enforced by the caller via prompt-injection + post-hoc validation.
// Run one worker turn over the opt-in app-server JSON-RPC transport, then
// post-process the accumulated assistant message EXACTLY as the exec path does:
// JSON.parse it when a schema is set (the engine's retry loop then validates),
// or trim it for raw-text workers. Returns the same { execResult, value }
// contract as the exec branch so spawnWorkerGuarded is transport-agnostic.
async function runAppServerAttempt({ prompt, schema, opts, onStreamEvent }) {
  const env = {
    ...process.env,
    CODEX_HOME: opts.codex_home,
    ULTRACODE_CHILD: "1",
    ULTRACODE_DEPTH: String((opts.depth || 0) + 1)
  };
  const { execResult, value: rawText } = await appServerClient.runAppServerTurn({
    prompt,
    schema,
    opts: {
      bin: opts.bin,
      cwd: opts.cwd,
      env,
      sandbox: opts.sandbox,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      baseInstructions: opts.baseInstructions,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal
    },
    onStreamEvent,
    abortError
  });
  let value;
  try {
    value = schema ? JSON.parse(rawText) : String(rawText || "").trim();
  } catch (error) {
    const err = new Error(
      schema
        ? `Worker did not return readable schema JSON: ${error.message}`
        : `Worker output could not be read: ${error.message}`
    );
    err.codex_exec = execResult;
    throw err;
  }
  return { execResult, value };
}

async function runCodexAttempt({ prompt, schema, opts, onStreamEvent, resumeSessionId = null }) {
  // 'exec-server' is reserved but not yet implemented — fail loudly so a caller
  // that opts into it gets a clear, actionable error rather than a silent
  // fallback. The seam (app-server-client) is generic enough to host it later.
  if (opts.transport === "exec-server") {
    throw new Error(
      "transport 'exec-server' is not yet implemented; use 'exec' (default) or 'app-server'."
    );
  }

  // OPT-IN app-server transport. Only used for a fresh (non-resume) cold turn —
  // warm resume is an exec-only concept. On ANY app-server failure we
  // transparently fall back to the exec path (unless transportStrict is set),
  // logging a narrator line via the supplied onStreamEvent/onLog sink.
  if (opts.transport === "app-server" && !resumeSessionId) {
    try {
      return await runAppServerAttempt({ prompt, schema, opts, onStreamEvent });
    } catch (error) {
      if (opts.transportStrict) {
        throw error;
      }
      if (typeof opts.onTransportFallback === "function") {
        try {
          opts.onTransportFallback(error);
        } catch {
          /* narrator errors never break a run */
        }
      }
      // Fall through to the exec path with the original prompt/schema/opts.
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-"));
  // The schema file is only ever passed to the cold builder. On a resume turn we
  // still keep `schema` (for post-hoc validation) but never write/pass the file.
  const schemaPath = !resumeSessionId && schema ? path.join(tempDir, "worker.schema.json") : null;
  const lastMessagePath = path.join(tempDir, "last-message.json");
  if (schemaPath) await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
  const args = resumeSessionId
    ? buildResumeArgs(opts, resumeSessionId, lastMessagePath)
    : buildCodexArgs(opts, schemaPath, lastMessagePath);
  const env = {
    ...process.env,
    CODEX_HOME: opts.codex_home,
    ULTRACODE_CHILD: "1",
    ULTRACODE_DEPTH: String((opts.depth || 0) + 1)
  };
  try {
    const execResult = await spawnCodex({
      bin: opts.bin,
      args,
      cwd: opts.cwd,
      env,
      prompt,
      timeoutMs: opts.timeoutMs,
      onStreamEvent,
      signal: opts.signal
    });
    let value;
    try {
      const raw = await fs.readFile(lastMessagePath, "utf8");
      value = schema ? JSON.parse(raw) : raw.trim();
    } catch (error) {
      // Attach the exec result so callers can still account token usage for a
      // run that completed but whose last-message file was missing/unparseable.
      const err = new Error(
        schema
          ? `Worker did not return readable schema JSON: ${error.message}`
          : `Worker output could not be read: ${error.message}`
      );
      err.codex_exec = execResult;
      throw err;
    }
    return { execResult, value };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function failedWorker(label, phase, error, codexExec, usage, durationMs, status) {
  return {
    status: status || "failed",
    value: null,
    usage: usage || null,
    thread_id: null,
    duration_ms: durationMs || 0,
    label,
    phase: phase || null,
    error,
    codex_exec: codexExec
  };
}

// A non-throwing "cancelled" worker record. Like failedWorker but status maps to
// 'cancelled' so finalizeRecord can mark a deliberately-aborted run distinctly
// from a genuine failure. Every primitive already treats non-'completed' as a
// drop, so runParallel/runPipeline/loopUntilDry keep working unchanged.
function cancelledWorker(label, phase, reason) {
  return failedWorker(label, phase, reason || "cancelled", undefined, null, 0, "cancelled");
}

// Atomic agent() equivalent. Spawns one `codex exec` with an arbitrary prompt,
// an optional per-call JSON schema (null => raw text), validates + retries on
// schema mismatch, accounts usage/caps into ctx, and emits progress events.
// Never throws: failures resolve to a {status:'failed'} record.
async function spawnWorker(prompt, opts = {}) {
  const ctx = opts.ctx || null;
  const resolved = resolveWorkerOpts({ ...opts, depth: ctx ? ctx.depth : 0 });
  // resumeSessionId is only honored when the caller opted into executor:'resume'.
  // For any other executor (cold/fork) it is forced null so the cold path runs
  // byte-for-byte as before — the warm path is purely additive and opt-in.
  const resumeSessionId =
    resolved.executor === "resume" && typeof opts.resumeSessionId === "string" && opts.resumeSessionId
      ? opts.resumeSessionId
      : null;
  const exec = () => spawnWorkerGuarded(prompt, resolved, ctx, resumeSessionId);
  return ctx ? ctx.limiter.run(exec) : exec();
}

async function spawnWorkerGuarded(prompt, opts, ctx, resumeSessionId = null) {
  const { label, phase } = opts;

  // Re-evaluated before every spawn (including schema retries) so neither the
  // token budget nor the lifetime agent cap can be overshot by retries.
  const capExceeded = () => {
    if (ctx && ctx.budget.total !== null && ctx.budget.remaining() <= 0) {
      log(ctx, `Skipping worker "${label}": token budget exhausted.`, { label, reason: "budget" });
      return failedWorker(label, phase, "token budget exhausted");
    }
    if (ctx && ctx.spawnedCount >= ctx.maxAgents) {
      log(ctx, `Skipping worker "${label}": lifetime agent cap (${ctx.maxAgents}) reached.`, {
        label,
        reason: "maxAgents"
      });
      return failedWorker(label, phase, `lifetime agent cap ${ctx.maxAgents} reached`);
    }
    return null;
  };

  if (ctx && ctx.depth > ctx.maxDepth) {
    log(ctx, `Skipping worker "${label}": nesting depth ${ctx.depth} exceeds max ${ctx.maxDepth}.`, {
      label,
      reason: "maxDepth"
    });
    return failedWorker(label, phase, `nesting depth ${ctx.depth} exceeds max ${ctx.maxDepth}`);
  }

  // Cancellation gate (entry): if the run was already aborted, never schedule a
  // child — return a non-throwing cancelled record. No-op when ctx.signal is
  // never aborted (the default), so the happy path is unchanged.
  if (ctx && ctx.signal && ctx.signal.aborted) {
    log(ctx, `Worker "${label}" cancelled before start.`, { label, reason: "cancelled" });
    return cancelledWorker(label, phase, "cancelled");
  }

  const entryGate = capExceeded();
  if (entryGate) return entryGate;

  let worktree = null;
  let runOpts = opts;
  if (opts.isolation === "worktree") {
    try {
      worktree = await createWorktree(opts.cwd);
      runOpts = {
        ...opts,
        cwd: worktree.dir,
        sandbox: opts.sandbox === "read-only" ? "workspace-write" : opts.sandbox
      };
    } catch (error) {
      log(ctx, `Worktree isolation failed for "${label}"; falling back to shared cwd: ${error.message}`, {
        label,
        reason: "worktree-fallback"
      });
    }
  }

  emitEvent(ctx, { type: "worker.started", label, phase });

  // fork executor stub: the spike proved `codex fork` is interactive-TUI-only
  // (no --json, no `codex exec fork`), so it cannot share a warm base session
  // non-interactively. We accept executor:'fork' for forward-compat but log it
  // and run the cold path (resumeSessionId is already null for fork).
  if (opts.executor === "fork") {
    log(ctx, "fork executor not supported by codex CLI (interactive-only); using cold exec", {
      label,
      reason: "fork-unsupported"
    });
  }

  try {
    let attempt = 0;
    // Independent of the schema-retry `attempt`: a transient retry never consumes
    // a schema retry and vice-versa.
    let transientAttempt = 0;
    // Warm-context state. `activeResume` is the session id we attempt this turn;
    // it is cleared (=> cold) when the resume subprocess signals unavailability,
    // so the very next loop iteration transparently re-runs the same prompt cold.
    // Only meaningful when executor:'resume' AND a session id was supplied.
    let activeResume = opts.executor === "resume" ? resumeSessionId || null : null;
    // On a resume turn the schema must be embedded in the prompt (the CLI rejects
    // --output-schema), so warm and cold use different base prompts.
    const buildPrompt = () =>
      activeResume ? injectSchemaIntoPrompt(prompt, opts.schema) : prompt;
    let currentPrompt = buildPrompt();
    while (true) {
      // Cancellation gate (loop top): stop scheduling new attempts once aborted.
      if (ctx && ctx.signal && ctx.signal.aborted) {
        log(ctx, `Worker "${label}" cancelled.`, { label, reason: "cancelled" });
        return cancelledWorker(label, phase, "cancelled");
      }
      const loopGate = capExceeded();
      if (loopGate) return loopGate;
      if (ctx) ctx.spawnedCount += 1;
      let attemptResult;
      try {
        attemptResult = await runCodexAttempt({
          prompt: currentPrompt,
          schema: opts.schema,
          opts: {
            ...runOpts,
            depth: ctx ? ctx.depth : 0,
            signal: ctx ? ctx.signal : undefined,
            // Narrator hook for the opt-in app-server transport: on any
            // app-server failure (with transportStrict off) the engine logs a
            // line, emits a worker.transport_fallback event, and re-runs this
            // same attempt over the exec path. No-op for the default exec
            // transport, so the happy path is unchanged.
            onTransportFallback: (error) => {
              log(ctx, `app-server transport failed for "${label}"; falling back to exec: ${error.message}`, {
                label,
                reason: "transport-fallback"
              });
              emitEvent(ctx, { type: "worker.transport_fallback", label, phase, error: error.message });
            }
          },
          resumeSessionId: activeResume,
          onStreamEvent: (event) => {
            if (event.type === "turn.completed" && event.usage) {
              emitEvent(ctx, { type: "turn.completed", label, phase });
            }
          }
        });
      } catch (error) {
        const execResult = error && error.codex_exec ? error.codex_exec : undefined;
        const usage = execResult ? execResult.usage || parseUsage(execResult.stdout) : null;
        accountUsage(ctx, usage);

        // Warm-context safety net: a resume attempt that the CLI could not honor
        // (unknown/expired rollout, non-zero exit, missing last-message) is NOT a
        // run failure — clear the session id, log resume-fallback, and re-run the
        // SAME prompt cold on the next loop iteration. This consumes neither a
        // schema retry nor a transient retry, so warm mode can only ever make a
        // run faster/cheaper, never change its correctness.
        if (activeResume && !(ctx && ctx.signal && ctx.signal.aborted) && isResumeUnavailable(error, execResult)) {
          log(ctx, "resume unavailable; fell back to cold exec", { label, reason: "resume-fallback" });
          emitEvent(ctx, { type: "worker.resume_fallback", label, phase });
          activeResume = null;
          currentPrompt = buildPrompt();
          continue;
        }

        // An abort that fired during the attempt surfaces as a cancelled error —
        // report it as cancelled, not a transient/permanent failure.
        const aborted = (error && error.cancelled === true) || (execResult && execResult.cancelled === true) ||
          (ctx && ctx.signal && ctx.signal.aborted);
        if (aborted) {
          emitEvent(ctx, { type: "worker.cancelled", label, phase });
          log(ctx, `Worker "${label}" cancelled.`, { label, reason: "cancelled" });
          return cancelledWorker(label, phase, "cancelled");
        }

        // Classify: transient (retry with backoff) vs permanent (fail now, as the
        // engine always did). maxRetries defaults to 0 so this branch is inert
        // unless a caller opts in.
        const classification = classifyCodexError(error, execResult);
        const canRetry =
          classification.transient &&
          transientAttempt < opts.maxRetries &&
          !(ctx && ctx.signal && ctx.signal.aborted) &&
          !capExceeded();
        if (canRetry) {
          const backoffMs = backoffDelay(transientAttempt, opts.baseDelayMs, opts.maxDelayMs, opts.retryJitter);
          transientAttempt += 1;
          emitEvent(ctx, {
            type: "worker.retry",
            label,
            phase,
            attempt: transientAttempt,
            max_retries: opts.maxRetries,
            reason: classification.reason,
            delay_ms: backoffMs
          });
          log(
            ctx,
            `Worker "${label}" transient failure (${classification.reason}); retry ${transientAttempt}/${opts.maxRetries} in ${backoffMs}ms.`,
            { label, reason: "transient-retry", attempt: transientAttempt, delay_ms: backoffMs }
          );
          try {
            await abortableDelay(backoffMs, ctx ? ctx.signal : undefined);
          } catch {
            // Aborted during backoff: stop retrying, report cancelled.
            emitEvent(ctx, { type: "worker.cancelled", label, phase });
            log(ctx, `Worker "${label}" cancelled during retry backoff.`, { label, reason: "cancelled" });
            return cancelledWorker(label, phase, "cancelled");
          }
          continue;
        }

        emitEvent(ctx, { type: "worker.failed", label, phase, error: error.message });
        log(ctx, `Worker "${label}" failed: ${error.message}`, { label, reason: "exec-error" });
        return failedWorker(label, phase, error.message, execResult, usage, execResult ? execResult.duration_ms : 0);
      }

      const { execResult, value } = attemptResult;
      const usage = execResult.usage || parseUsage(execResult.stdout);
      accountUsage(ctx, usage);

      let schemaValid = true;
      if (opts.schema) {
        const validation = validateAgainstSchema(value, opts.schema);
        schemaValid = validation.ok;
        if (!schemaValid && attempt < opts.schemaRetries) {
          attempt += 1;
          log(ctx, `Worker "${label}" output failed schema validation (retry ${attempt}/${opts.schemaRetries}).`, {
            label,
            errors: validation.errors,
            reason: "schema-retry"
          });
          // On a warm resume turn the schema cannot be passed via --output-schema,
          // so keep it embedded in the retry prompt too (cold turns keep the
          // original wording byte-for-byte).
          currentPrompt = `${buildPrompt()}\n\nYour previous response failed schema validation with these errors:\n- ${validation.errors.join(
            "\n- "
          )}\nReturn a corrected response that satisfies the schema exactly.`;
          continue;
        }
        if (!schemaValid) {
          log(ctx, `Worker "${label}" output still invalid after ${opts.schemaRetries} retries; accepting best effort.`, {
            label,
            errors: validation.errors,
            reason: "schema-accept-invalid"
          });
        }
      }

      let diff;
      if (worktree) {
        diff = await collectDiff(worktree).catch(() => null);
      }
      emitEvent(ctx, { type: "worker.completed", label, phase, schema_valid: schemaValid });
      return {
        status: "completed",
        value,
        usage,
        thread_id: execResult.thread_id || null,
        duration_ms: execResult.duration_ms,
        label,
        phase,
        schema_valid: schemaValid,
        ...(worktree ? { worktree: worktree.dir, diff } : {})
      };
    }
  } finally {
    if (worktree) await removeWorktree(worktree);
  }
}

// Warm-context worker handle. The first turn runs a normal PERSISTED cold exec
// (executor:'resume' forces persistSession=true) and captures its session id
// (thread_id). Every subsequent turn() resumes that same warm session via
// `codex exec resume <sessionId>` — reusing the prior conversation context
// instead of paying for a fresh cold exec. If the first turn yields no session id
// (or any later resume turn signals the rollout is gone), the handle transparently
// degrades to cold for that turn — warm is a pure latency/cost optimization that
// can never change correctness.
//
// Returns a handle synchronously-shaped object once awaited:
//   { sessionId, result, turn(prompt, perTurnOpts) }
// `result` is the first-turn spawnWorker record; `sessionId` is its thread_id (or
// null if none was captured). `turn()` is the explicit follow-up-turn API for
// multi-stage pipelines; turns are SEQUENTIAL by nature (a resume continues one
// conversation), so a single handle cannot run turns in parallel.
async function spawnWarmWorker(initialPrompt, opts = {}) {
  // Force the resume executor for this handle so persistSession is on and a
  // session id is captured. A caller may still pass executor:'cold' to disable
  // warming entirely (every turn then runs cold) — honored as an explicit opt-out.
  const executor = opts.executor === "cold" || opts.executor === "fork" ? opts.executor : "resume";
  const baseOpts = { ...opts, executor };

  const first = await spawnWorker(initialPrompt, baseOpts);
  const sessionId = executor === "resume" && first && first.status === "completed" && first.thread_id ? first.thread_id : null;

  const handle = {
    sessionId,
    result: first,
    async turn(prompt, perTurnOpts = {}) {
      // Each follow-up turn resumes the captured session. spawnWorker forces the
      // resumeSessionId to null unless executor:'resume' AND a session id exists,
      // and the guarded path auto-falls-back to cold on any resume failure — so a
      // missing/expired session id here simply runs a cold exec.
      const turnOpts = {
        ...baseOpts,
        ...perTurnOpts,
        executor: handle.sessionId ? "resume" : executor,
        resumeSessionId: handle.sessionId || undefined
      };
      const r = await spawnWorker(prompt, turnOpts);
      // Keep warming the SAME session: only adopt a new session id if we still
      // don't have one (e.g. the first turn fell back to cold and a later turn
      // managed to persist a session). Never overwrite a working warm session.
      if (!handle.sessionId && r && r.status === "completed" && r.thread_id) {
        handle.sessionId = r.thread_id;
      }
      return r;
    }
  };
  return handle;
}

// Barrier gather over arbitrary thunks. Any thunk that throws degrades to null
// (logged), so merge/dedup/quorum steps can rely on a stable-length array.
async function runParallel(thunks, opts = {}) {
  const ctx = opts.ctx || null;
  return Promise.all(
    thunks.map((thunk, index) =>
      Promise.resolve()
        .then(thunk)
        .catch((error) => {
          log(ctx, `parallel: task #${index} threw and was dropped to null: ${error.message}`, {
            index,
            reason: "exception"
          });
          return null;
        })
    )
  );
}

// A per-item warm session helper handed to stages as the 5th argument when
// runPipeline is invoked with opts.warm. Lazily creates a spawnWarmWorker handle
// on first start() and resumes it on every turn(), so one item's stages reuse ONE
// warm Codex session instead of N cold execs. base carries codex_bin/cwd/etc from
// runPipeline opts so stages don't have to re-thread them.
function createWarmStageHelper(base) {
  let handle = null;
  return {
    get sessionId() {
      return handle ? handle.sessionId : null;
    },
    // Start (or restart) the warm session with an initial prompt. Returns the
    // first-turn spawnWorker record.
    async start(prompt, perCallOpts = {}) {
      handle = await spawnWarmWorker(prompt, { ...base, ...perCallOpts });
      return handle.result;
    },
    // Resume the warm session for a follow-up stage. If start() was never called
    // (or yielded no session), this transparently runs a cold exec.
    async turn(prompt, perCallOpts = {}) {
      if (!handle) {
        // No warm base yet: degrade to a single cold worker for this stage.
        return spawnWorker(prompt, { ...base, ...perCallOpts, executor: "cold" });
      }
      return handle.turn(prompt, perCallOpts);
    }
  };
}

// Barrier-free multi-stage streaming. Each item flows through every stage
// independently (no inter-stage barrier) — item A can be in stage 3 while item
// B is still in stage 1. A throwing stage drops that one item to null.
//
// opt-in opts.warm: when true, each item gets a per-item warm-session helper
// (5th stage arg) so the item's stages reuse ONE warm Codex session across
// stages (warm turns are sequential, which the per-item chain already is). Warm
// reuse is per-item; fan-out ACROSS items stays parallel (independent sessions).
// When opts.warm is unset, stages are called with the exact 4-arg signature as
// before and the 5th arg is null — byte-for-byte the current behavior.
async function runPipeline(items, stages, opts = {}) {
  const ctx = opts.ctx || null;
  const warmBase = opts.warm
    ? {
        ctx,
        sandbox: opts.sandbox,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        timeoutMs: opts.timeoutMs,
        cwd: opts.cwd,
        codex_bin: opts.codex_bin,
        codex_home: opts.codex_home,
        schema: opts.schema
      }
    : null;
  const chains = items.map((item, index) =>
    (async () => {
      let acc = item;
      const warm = warmBase ? createWarmStageHelper(warmBase) : null;
      for (let stage = 0; stage < stages.length; stage += 1) {
        try {
          acc = await stages[stage](acc, item, index, ctx, warm);
        } catch (error) {
          log(ctx, `pipeline: item #${index} dropped at stage ${stage}: ${error.message}`, {
            index,
            stage,
            reason: "exception"
          });
          return null;
        }
      }
      return acc;
    })()
  );
  return Promise.all(chains);
}

// Discovery loop: repeatedly spawn finders until K consecutive dry rounds, or a
// round / budget / lifetime cap is hit (the stop reason is always logged).
async function loopUntilDry(makePrompt, opts = {}) {
  const ctx = opts.ctx || null;
  const schema = opts.schema === undefined ? WORKER_SCHEMA : opts.schema;
  const dryRounds = opts.dryRounds || 2;
  const maxRounds = opts.maxRounds || 10;
  const isDry =
    typeof opts.isDry === "function"
      ? opts.isDry
      : (result) => !result || (Array.isArray(result.findings) && result.findings.length === 0);
  const collected = [];
  let consecutiveDry = 0;
  let round = 0;
  while (round < maxRounds && consecutiveDry < dryRounds) {
    if (ctx && ctx.budget.total !== null && ctx.budget.remaining() <= 0) {
      log(ctx, `loopUntilDry stopped after ${round} rounds: token budget exhausted.`, { reason: "budget" });
      break;
    }
    if (ctx && ctx.spawnedCount >= ctx.maxAgents) {
      log(ctx, `loopUntilDry stopped after ${round} rounds: lifetime agent cap reached.`, { reason: "maxAgents" });
      break;
    }
    const result = await spawnWorker(makePrompt(round, ctx), {
      ctx,
      schema,
      sandbox: opts.sandbox,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      cwd: opts.cwd,
      label: `finder-round-${round + 1}`,
      phase: opts.phase
    });
    round += 1;
    if (result.status !== "completed" || isDry(result.value)) {
      consecutiveDry += 1;
      log(ctx, `loopUntilDry: round ${round} dry (${consecutiveDry}/${dryRounds}).`, { round });
      continue;
    }
    consecutiveDry = 0;
    collected.push(result.value);
  }
  if (round >= maxRounds) log(ctx, `loopUntilDry reached maxRounds=${maxRounds}.`, { reason: "maxRounds" });
  return collected;
}

// Quality helper: for each finding, fan out N skeptic workers (optionally with
// distinct lenses) and keep only findings that survive a majority refute vote.
async function adversarialVerify(findings, opts = {}) {
  const ctx = opts.ctx || null;
  const skeptics = Math.max(1, opts.skeptics || 3);
  const lenses = Array.isArray(opts.lenses) && opts.lenses.length ? opts.lenses : null;
  const schema = opts.schema || VERDICT_SCHEMA;
  const describe =
    typeof opts.describe === "function"
      ? opts.describe
      : (finding) => (typeof finding === "string" ? finding : JSON.stringify(finding, null, 2));

  const verdicts = await Promise.all(
    findings.map(async (finding) => {
      const votes = await Promise.all(
        Array.from({ length: skeptics }, (_, i) => {
          const lens = lenses ? lenses[i % lenses.length] : null;
          const prompt = [
            lens ? `Evaluate strictly from this perspective: ${lens}.` : "",
            "You are a skeptical reviewer. Try hard to REFUTE the following finding.",
            "If you cannot clearly confirm it is real and correct, set refuted=true.",
            "",
            "Finding:",
            describe(finding),
            opts.context ? `\nContext:\n${opts.context}` : ""
          ]
            .filter(Boolean)
            .join("\n");
          return spawnWorker(prompt, {
            ctx,
            schema,
            sandbox: opts.sandbox || "read-only",
            model: opts.model,
            reasoningEffort: opts.reasoningEffort,
            cwd: opts.cwd,
            label: `skeptic${lens ? `:${lens}` : ""}`,
            phase: opts.phase
          }).then((result) => (result.status === "completed" ? result.value : null));
        })
      );
      const valid = votes.filter(Boolean);
      const refutes = valid.filter((vote) => vote && vote.refuted === true).length;
      // A finding is killed only when refuters are a strict majority, so an even
      // split (e.g. 1 of 2, 2 of 4) survives — matching the documented rule.
      const survives = valid.length > 0 && refutes * 2 <= valid.length;
      if (!survives) {
        log(ctx, `adversarialVerify: finding refuted by majority (${refutes}/${valid.length || skeptics}).`, {
          finding: describe(finding).slice(0, 160)
        });
      }
      return { finding, survives };
    })
  );
  return verdicts.filter((entry) => entry.survives).map((entry) => entry.finding);
}

// ---------------------------------------------------------------------------
// Workflow records (fan-out / fan-in + explicit specs + resume)
// ---------------------------------------------------------------------------

function workerRecordFromResult(base, result) {
  if (result.status === "completed") {
    return {
      ...base,
      status: "completed",
      result: result.value,
      usage: result.usage,
      duration_ms: result.duration_ms,
      ...(result.schema_valid === false ? { schema_valid: false } : {}),
      ...(result.thread_id ? { thread_id: result.thread_id } : {}),
      ...(result.diff !== undefined ? { diff: result.diff } : {})
    };
  }
  if (result.status === "cancelled") {
    return {
      ...base,
      status: "cancelled",
      error: result.error || "cancelled"
    };
  }
  return {
    ...base,
    status: "failed",
    error: result.error,
    ...(result.codex_exec ? { codex_exec: result.codex_exec } : {})
  };
}

// Normalize the transient-retry knobs off a workflow-level input into both the
// per-worker option bag (worker) and a journalable snapshot (journal). Defaults
// reproduce the pre-retry behavior (maxRetries 0).
function resolveRetryInput(input = {}) {
  const maxRetries = clampNonNegInt(firstDefined(input.max_retries, input.maxRetries), 0);
  const baseDelayMs = clampNonNegInt(firstDefined(input.base_delay_ms, input.baseDelayMs), 500);
  const maxDelayMs = clampNonNegInt(firstDefined(input.max_delay_ms, input.maxDelayMs), 30_000);
  const retryJitter = resolveBool(firstDefined(input.retry_jitter, input.retryJitter), true);
  return {
    worker: { maxRetries, baseDelayMs, maxDelayMs, retryJitter },
    // Only journal the retry knobs when retries are actually enabled, so a plain
    // run's options object stays byte-identical to the pre-retry shape.
    journal:
      maxRetries > 0
        ? { max_retries: maxRetries, base_delay_ms: baseDelayMs, max_delay_ms: maxDelayMs, retry_jitter: retryJitter }
        : {}
  };
}

// Journal the transport ONLY when it is non-default, so a plain run's options
// object stays byte-identical to the pre-transport shape. transportStrict is
// only journaled alongside a non-default transport.
function transportJournal(transport, transportStrict) {
  if (!transport || transport === "exec") return {};
  return { transport, ...(transportStrict ? { transport_strict: true } : {}) };
}

async function runLegacyWorker(options, workflow, worker, ctx, retryWorker) {
  const prompt = workerPrompt({ task: options.task, workflow, worker, sandbox: options.sandbox });
  const result = await spawnWorker(prompt, {
    ctx,
    schema: WORKER_SCHEMA,
    sandbox: options.sandbox,
    model: options.model,
    reasoningEffort: options.reasoning_effort,
    timeoutMs: options.timeout_ms,
    cwd: options.cwd,
    codex_bin: options.codex_bin,
    codex_home: options.codex_home,
    transport: options.transport,
    transport_strict: options.transport_strict,
    label: worker.title,
    phase: worker.phase,
    ...(retryWorker || {})
  });
  return workerRecordFromResult(worker, result);
}

function compactWorkflow(workflow) {
  const completed = workflow.workers.filter((worker) => worker.status === "completed");
  const failed = workflow.workers.filter((worker) => worker.status === "failed");
  const labelOf = (worker) => worker.title || worker.label || worker.id;
  const collect = (field) =>
    completed.flatMap((worker) =>
      worker.result && typeof worker.result === "object" && Array.isArray(worker.result[field])
        ? worker.result[field].map((item) => `${labelOf(worker)}: ${item}`)
        : []
    );
  const summary = completed.map((worker) => {
    if (worker.result && typeof worker.result === "object" && typeof worker.result.summary === "string") {
      return `${labelOf(worker)}: ${worker.result.summary}`;
    }
    if (typeof worker.result === "string") return `${labelOf(worker)}: ${worker.result.slice(0, 500)}`;
    return `${labelOf(worker)}: (no summary)`;
  });
  return {
    summary,
    findings: collect("findings"),
    recommended_actions: collect("recommended_actions"),
    risks: collect("risks"),
    verification: collect("verification"),
    failed_workers: failed.map((worker) => `${labelOf(worker)}: ${worker.error}`),
    aggregate_usage: workflow.aggregate_usage || sumUsageFromWorkers(workflow.workers)
  };
}

function makePersister(record, ctx) {
  let chain = Promise.resolve();
  return {
    schedule() {
      // Snapshot the record at schedule time so each queued write captures the
      // progress as of when it was scheduled, rather than all writes racing to
      // serialize the same live (eventually final) object reference.
      const snapshot = JSON.parse(JSON.stringify(record));
      chain = chain
        .then(() => writeJson(record.state_path, snapshot))
        .catch((error) => {
          // Don't crash the run on a transient write error, but don't hide it.
          log(ctx, `Failed to persist workflow state: ${error.message}`, { reason: "persist-error" });
          process.stderr.write(`[ultracode] state persist error: ${error.message}\n`);
        });
      return chain;
    },
    flush() {
      return chain;
    }
  };
}

function finalizeRecord(workflow, ctx) {
  const completed = workflow.workers.filter((worker) => worker.status === "completed").length;
  const anyCancelled = workflow.workers.some((worker) => worker.status === "cancelled");
  const aborted = !!(ctx && ctx.signal && ctx.signal.aborted);
  if (aborted && anyCancelled) {
    // A deliberately-aborted run with at least one cancelled worker is reported
    // as 'cancelled' (distinct from a genuine failure). Additive: when nothing
    // is cancelled this branch is skipped and the math below is unchanged.
    workflow.status = "cancelled";
  } else {
    workflow.status = completed === workflow.workers.length ? "completed" : completed === 0 ? "failed" : "partial";
  }
  workflow.completed_at = new Date().toISOString();
  workflow.duration_ms = Date.parse(workflow.completed_at) - Date.parse(workflow.started_at);
  workflow.aggregate_usage = sumUsageFromWorkers(workflow.workers);
  workflow.events = ctx.events;
  workflow.aggregate = compactWorkflow(workflow);
}

function normalizeSpec(spec, index, defaults) {
  if (!spec || typeof spec !== "object") {
    throw new Error(`workers_spec[${index}] must be an object.`);
  }
  const prompt = assertNonEmptyString(spec.prompt, `workers_spec[${index}].prompt`);
  const label = typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : `worker-${index + 1}`;
  const sandbox = spec.sandbox || defaults.sandbox;
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error(`workers_spec[${index}].sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const effort = spec.reasoning_effort || defaults.reasoning_effort;
  if (effort !== undefined && effort !== null && !VALID_EFFORTS.has(effort)) {
    throw new Error(`workers_spec[${index}].reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const schema =
    spec.schema === null ? null : spec.schema && typeof spec.schema === "object" ? spec.schema : WORKER_SCHEMA;
  const cwd = spec.cwd ? path.resolve(spec.cwd) : defaults.cwd;
  return {
    index,
    id: stepId({ kind: "explicit", index, label, prompt, schema }),
    prompt,
    label,
    schema,
    phase: spec.phase || null,
    sandbox,
    model: typeof spec.model === "string" && spec.model.trim() ? spec.model.trim() : defaults.model,
    reasoning_effort: effort || undefined,
    timeout_ms: spec.timeout_ms ? Math.max(1_000, Math.floor(Number(spec.timeout_ms))) : defaults.timeout_ms,
    cwd,
    isolation: spec.isolation === "worktree" ? "worktree" : undefined
  };
}

async function runExplicitWorkflow(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const baseSandbox = input.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(baseSandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const baseEffort = input.reasoning_effort || input.reasoningEffort;
  if (baseEffort !== undefined && baseEffort !== null && !VALID_EFFORTS.has(baseEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const timeoutMs =
    input.timeout_ms === undefined || input.timeout_ms === null
      ? DEFAULT_TIMEOUT_MS
      : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
  const defaults = {
    cwd,
    sandbox: baseSandbox,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
    reasoning_effort: baseEffort,
    timeout_ms: timeoutMs
  };
  const specs = input.workers_spec.map((spec, index) => normalizeSpec(spec, index, defaults));
  const retryOpts = resolveRetryInput(input);

  const id = workflowId();
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });

  const now = new Date().toISOString();
  const codexBin =
    typeof input.codex_bin === "string" && input.codex_bin.trim() ? input.codex_bin.trim() : defaultCodexBin();
  const codexHomeValue =
    typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome();
  const transport = resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT));
  const transportStrict = resolveBool(firstDefined(input.transport_strict, input.transportStrict), false);
  const workflow = {
    id,
    status: "running",
    task: input.task || `${specs.length} explicit workers`,
    cwd,
    started_at: now,
    completed_at: null,
    options: {
      workers: specs.length,
      sandbox: baseSandbox,
      timeout_ms: timeoutMs,
      model: defaults.model || null,
      reasoning_effort: baseEffort || null,
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      explicit: true,
      ...retryOpts.journal,
      ...transportJournal(transport, transportStrict)
    },
    state_path: statePathFor(id),
    phases: Array.from(new Set(specs.map((spec) => spec.phase).filter(Boolean))),
    workers: specs.map((spec) => ({
      index: spec.index,
      id: spec.id,
      step_id: spec.id,
      title: spec.label,
      label: spec.label,
      phase: spec.phase,
      status: "pending",
      // Stored so the run can be resumed without the original call.
      spec: {
        prompt: spec.prompt,
        schema: spec.schema,
        sandbox: spec.sandbox,
        model: spec.model || null,
        reasoning_effort: spec.reasoning_effort || null,
        timeout_ms: spec.timeout_ms,
        cwd: spec.cwd,
        isolation: spec.isolation || null
      }
    })),
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };
  await writeJson(workflow.state_path, workflow);
  const persister = makePersister(workflow, ctx);

  const results = await Promise.all(
    specs.map((spec, i) =>
      spawnWorker(spec.prompt, {
        ctx,
        schema: spec.schema,
        sandbox: spec.sandbox,
        model: spec.model,
        reasoningEffort: spec.reasoning_effort,
        timeoutMs: spec.timeout_ms,
        cwd: spec.cwd,
        codex_bin: codexBin,
        codex_home: codexHomeValue,
        transport,
        transport_strict: transportStrict,
        label: spec.label,
        phase: spec.phase,
        isolation: spec.isolation,
        ...retryOpts.worker
      }).then((result) => {
        const base = workflow.workers[i];
        workflow.workers[i] = workerRecordFromResult(base, result);
        persister.schedule();
        return workflow.workers[i];
      })
    )
  );

  workflow.workers = results;
  finalizeRecord(workflow, ctx);
  persister.schedule();
  await persister.flush();
  return workflow;
}

async function runWorkflow(input = {}) {
  if (Array.isArray(input.workers_spec) && input.workers_spec.length > 0) {
    return runExplicitWorkflow(input);
  }

  const options = normalizeOptions(input);
  const retryOpts = resolveRetryInput(input);
  const id = workflowId();
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });

  const now = new Date().toISOString();
  const workflow = {
    id,
    status: "running",
    task: options.task,
    cwd: options.cwd,
    started_at: now,
    completed_at: null,
    options: {
      workers: options.workers,
      sandbox: options.sandbox,
      timeout_ms: options.timeout_ms,
      model: options.model || null,
      reasoning_effort: options.reasoning_effort || null,
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      ...retryOpts.journal,
      ...transportJournal(options.transport, options.transport_strict)
    },
    state_path: statePathFor(id),
    workers: selectRoles(options.workers).map((worker) => ({
      ...worker,
      step_id: stepId({ kind: "role", role: worker.id, index: worker.index }),
      phase: null,
      status: "pending"
    })),
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };
  await writeJson(workflow.state_path, workflow);
  const persister = makePersister(workflow, ctx);

  const results = await Promise.all(
    workflow.workers.map((worker, i) =>
      runLegacyWorker(options, workflow, worker, ctx, retryOpts.worker).then((record) => {
        workflow.workers[i] = record;
        persister.schedule();
        return record;
      })
    )
  );

  workflow.workers = results;
  finalizeRecord(workflow, ctx);
  persister.schedule();
  await persister.flush();
  return workflow;
}

// Journaled resume: reload a persisted record, keep completed steps, and only
// re-spawn missing / failed / explicitly-forced steps, then re-aggregate.
async function resumeWorkflow(input = {}) {
  const record = await readWorkflow({ workflow_id: input.workflow_id, state_path: input.state_path });
  if (!record || record.status === "missing") {
    throw new Error("No Ultracode workflow state to resume.");
  }
  // A kind:'script' record (from runScript) has no per-worker steps to re-run:
  // a script is an arbitrary imperative body, not a step DAG. Rather than try to
  // re-derive role/spec workers (which would throw on the missing `task`), resume
  // degrades to a clear no-op that returns the record unchanged.
  if (record.kind === "script") {
    return {
      ...record,
      message: "Script workflows are not step-resumable; re-run the script to produce a fresh record."
    };
  }
  const force = new Set(input.force_steps || []);
  const ctx = createContext({
    workflowId: record.id,
    concurrency: record.options && record.options.concurrency,
    budgetTokens: record.options && record.options.budget_tokens,
    maxAgents: record.options && record.options.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });
  // Retry knobs are sourced from the journaled options first, with any new input
  // values taking precedence (so a resume can change them).
  const retryOpts = resolveRetryInput({
    max_retries: firstDefined(input.max_retries, record.options && record.options.max_retries),
    base_delay_ms: firstDefined(input.base_delay_ms, record.options && record.options.base_delay_ms),
    max_delay_ms: firstDefined(input.max_delay_ms, record.options && record.options.max_delay_ms),
    retry_jitter: firstDefined(input.retry_jitter, record.options && record.options.retry_jitter)
  });

  const rerun = [];
  record.workers.forEach((worker, i) => {
    const idMatches = force.has(worker.step_id) || force.has(worker.id) || force.has(String(worker.index));
    if (idMatches || worker.status !== "completed") rerun.push(i);
  });

  record.status = "running";
  record.completed_at = null;
  record.resumed_at = new Date().toISOString();
  record.events = ctx.events;
  if (rerun.length === 0) {
    log(ctx, "resume: all steps already completed; nothing to re-run.");
  } else {
    log(ctx, `resume: re-running ${rerun.length} of ${record.workers.length} steps.`, { rerun: rerun.length });
  }
  await writeJson(record.state_path, record);
  const persister = makePersister(record, ctx);

  const baseOptions = normalizeOptions({
    task: record.task,
    cwd: record.cwd,
    workers: (record.options && record.options.workers) || 1,
    sandbox: (record.options && record.options.sandbox) || "read-only",
    model: record.options && record.options.model,
    reasoning_effort: record.options && record.options.reasoning_effort,
    timeout_ms: record.options && record.options.timeout_ms
  });

  await Promise.all(
    rerun.map((i) => {
      const worker = record.workers[i];
      const promise = worker.spec
        ? spawnWorker(worker.spec.prompt, {
            ctx,
            schema: worker.spec.schema,
            sandbox: worker.spec.sandbox,
            model: worker.spec.model || undefined,
            reasoningEffort: worker.spec.reasoning_effort || undefined,
            timeoutMs: worker.spec.timeout_ms,
            cwd: worker.spec.cwd,
            label: worker.label,
            phase: worker.phase,
            isolation: worker.spec.isolation || undefined,
            ...retryOpts.worker
          }).then((result) => workerRecordFromResult(worker, result))
        : runLegacyWorker(baseOptions, { id: record.id, cwd: record.cwd }, worker, ctx, retryOpts.worker);
      return promise.then((updated) => {
        record.workers[i] = updated;
        persister.schedule();
        return updated;
      });
    })
  );

  finalizeRecord(record, ctx);
  persister.schedule();
  await persister.flush();
  return record;
}

// ---------------------------------------------------------------------------
// Declarative pipeline DAG (kind: worker | parallel | verify | loop)
//
// A caller describes a directed acyclic graph of stages as pure JSON. The
// compiler validates ids/kinds/edges (Kahn pre-pass: duplicate id, unknown dep,
// cross-ref, cycle) BEFORE any spawn, normalizes per-step opts like
// normalizeSpec, then schedules barrier-free: each step starts the instant its
// own depends_on resolve, independent of unrelated branches, while the shared
// ctx keeps concurrency + budget globally bounded. Cross-stage data flows by
// rendering {{steps.<id>.output[...]}} tokens into the dependent prompt just
// before its spawn (subprocess workers share no memory).
// ---------------------------------------------------------------------------

const VALID_STEP_KINDS = new Set(["worker", "parallel", "verify", "loop"]);

// Dot-path drill-in: getPath({a:{b:[1,2]}}, "a.b") => [1,2]. Bare ""/null
// returns the object itself. Missing path => undefined (caller decides).
function getPath(obj, dotPath) {
  if (dotPath === undefined || dotPath === null || dotPath === "") return obj;
  let cur = obj;
  for (const part of String(dotPath).split(".")) {
    if (part === "") continue;
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Serialize a rendered value: objects/arrays => pretty JSON, strings verbatim,
// other scalars => String(). Used for {{steps.<id>.output[...]}} substitution.
function renderValue(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

// Resolve {{ ... }} tokens against a scope built from already-settled deps plus
// per-kind extras (round / item). Recognized tokens:
//   {{steps.<id>.output}}          full dep output (pretty JSON if object)
//   {{steps.<id>.output.<path>}}   dot-path drill-in
//   {{steps.<id>.summary}}         dep output.summary
//   {{round}}                      loop round index
//   {{item.<key>}}                 parallel item field
// Any unresolved/leftover {{ }} throws (no silent blanks).
function renderTemplate(str, scope) {
  if (typeof str !== "string") return str;
  const steps = (scope && scope.steps) || {};
  const out = str.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (match, rawExpr) => {
    const expr = rawExpr.trim();
    if (expr === "round") {
      if (scope && scope.round !== undefined) return String(scope.round);
      throw new Error(`renderTemplate: {{round}} used outside a loop step.`);
    }
    if (expr === "item" || expr.startsWith("item.")) {
      if (!scope || scope.item === undefined) {
        throw new Error(`renderTemplate: {{${expr}}} used outside a parallel item.`);
      }
      const value = expr === "item" ? scope.item : getPath(scope.item, expr.slice("item.".length));
      const rendered = renderValue(value);
      if (rendered === undefined) throw new Error(`renderTemplate: unresolved token {{${expr}}}.`);
      return rendered;
    }
    const stepMatch = /^steps\.([A-Za-z0-9_-]+)\.(output|summary)(?:\.(.+))?$/.exec(expr);
    if (stepMatch) {
      const [, id, kind, dotPath] = stepMatch;
      if (!(id in steps)) {
        throw new Error(`renderTemplate: unresolved token {{${expr}}} (step "${id}" is not a dependency).`);
      }
      const output = steps[id];
      let value;
      if (kind === "summary") {
        value = output && typeof output === "object" ? output.summary : undefined;
      } else {
        value = dotPath ? getPath(output, dotPath) : output;
      }
      const rendered = renderValue(value);
      if (rendered === undefined) throw new Error(`renderTemplate: unresolved token {{${expr}}}.`);
      return rendered;
    }
    throw new Error(`renderTemplate: unrecognized token {{${expr}}}.`);
  });
  // Defensive: reject any leftover braces the regex could not handle.
  if (/\{\{|\}\}/.test(out)) {
    throw new Error(`renderTemplate: unresolved template braces remain in: ${str}`);
  }
  return out;
}

// Collect every {{steps.<id>...}} id referenced by a string template. Used to
// enforce that a step only references ids in its own depends_on.
function referencedStepIds(str) {
  const ids = new Set();
  if (typeof str !== "string") return ids;
  const re = /\{\{\s*steps\.([A-Za-z0-9_-]+)\./g;
  let m;
  while ((m = re.exec(str)) !== null) ids.add(m[1]);
  return ids;
}

// Validate + normalize the JSON steps[] into compiled step descriptors. Throws
// (pre-spawn) on any structural error so a bad spec produces zero side effects.
function compileSteps(steps, defaults) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("steps must be a non-empty array.");
  }
  const byId = new Map();
  const compiled = steps.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`steps[${index}] must be an object.`);
    }
    const id = assertNonEmptyString(raw.id, `steps[${index}].id`);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`steps[${index}].id "${id}" must match [A-Za-z0-9_-]+.`);
    }
    if (byId.has(id)) {
      throw new Error(`steps[${index}].id "${id}" is duplicated.`);
    }
    const kind = raw.kind === undefined || raw.kind === null ? "worker" : raw.kind;
    if (!VALID_STEP_KINDS.has(kind)) {
      throw new Error(`steps[${index}].kind must be one of: ${Array.from(VALID_STEP_KINDS).join(", ")}.`);
    }
    const prompt = assertNonEmptyString(raw.prompt, `steps[${index}].prompt`);
    const dependsOn = Array.isArray(raw.depends_on) ? raw.depends_on.slice() : [];
    for (const dep of dependsOn) {
      if (typeof dep !== "string" || !dep.trim()) {
        throw new Error(`steps[${index}].depends_on entries must be non-empty strings.`);
      }
      if (dep === id) {
        throw new Error(`steps[${index}] "${id}" cannot depend on itself.`);
      }
    }
    const sandbox = raw.sandbox || defaults.sandbox;
    if (!VALID_SANDBOXES.has(sandbox)) {
      throw new Error(`steps[${index}].sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
    }
    const effort = raw.reasoning_effort || defaults.reasoning_effort;
    if (effort !== undefined && effort !== null && !VALID_EFFORTS.has(effort)) {
      throw new Error(`steps[${index}].reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
    }
    const schema =
      raw.schema === null ? null : raw.schema && typeof raw.schema === "object" ? raw.schema : WORKER_SCHEMA;
    // Optional warm executor per step. Defaults to the step-set default (cold).
    // 'fork' is accepted (forward-compat stub, degrades to cold). Validated here
    // so a bad value fails pre-spawn with zero side effects.
    const executor = raw.executor === undefined || raw.executor === null ? defaults.executor || "cold" : raw.executor;
    if (!["cold", "resume", "fork"].includes(executor)) {
      throw new Error(`steps[${index}].executor must be one of: cold, resume, fork.`);
    }
    const step = {
      index,
      id,
      kind,
      prompt,
      depends_on: dependsOn,
      schema,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      phase: raw.phase || null,
      sandbox,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaults.model,
      reasoning_effort: effort || undefined,
      timeout_ms: raw.timeout_ms ? Math.max(1_000, Math.floor(Number(raw.timeout_ms))) : defaults.timeout_ms,
      cwd: raw.cwd ? path.resolve(raw.cwd) : defaults.cwd,
      isolation: raw.isolation === "worktree" ? "worktree" : undefined,
      executor
    };
    if (kind === "verify") {
      step.findings_from = assertNonEmptyString(raw.findings_from, `steps[${index}].findings_from`);
      step.findings_path =
        typeof raw.findings_path === "string" && raw.findings_path.trim() ? raw.findings_path.trim() : "findings";
      step.skeptics = raw.skeptics ? Math.max(1, Math.floor(Number(raw.skeptics))) : 3;
      step.lenses = Array.isArray(raw.lenses) ? raw.lenses.filter((l) => typeof l === "string" && l.trim()) : [];
      step.context = typeof raw.context === "string" ? raw.context : "";
    } else if (kind === "loop") {
      step.dry_rounds = raw.dry_rounds ? Math.max(1, Math.floor(Number(raw.dry_rounds))) : 2;
      step.max_rounds = raw.max_rounds ? Math.max(1, Math.floor(Number(raw.max_rounds))) : 10;
    } else if (kind === "parallel") {
      if (Array.isArray(raw.items)) {
        for (const it of raw.items) {
          if (!it || typeof it !== "object" || Array.isArray(it)) {
            throw new Error(`steps[${index}].items entries must be objects.`);
          }
        }
        step.items = raw.items;
      } else if (raw.fanout !== undefined && raw.fanout !== null) {
        step.fanout = Math.max(1, Math.floor(Number(raw.fanout)));
      } else {
        step.fanout = 1;
      }
    }
    byId.set(id, step);
    return step;
  });

  // Edge validation: every depends_on / findings_from id must exist, and every
  // {{steps.<id>...}} token a step renders must be in that step's depends_on.
  for (const step of compiled) {
    for (const dep of step.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`steps "${step.id}" depends_on unknown step "${dep}".`);
      }
    }
    if (step.kind === "verify" && !step.depends_on.includes(step.findings_from)) {
      throw new Error(
        `steps "${step.id}" findings_from "${step.findings_from}" must be listed in its depends_on.`
      );
    }
    const depSet = new Set(step.depends_on);
    const refs = new Set([
      ...referencedStepIds(step.prompt),
      ...(step.kind === "verify" ? referencedStepIds(step.context) : [])
    ]);
    for (const ref of refs) {
      if (!byId.has(ref)) {
        throw new Error(`steps "${step.id}" template references unknown step "${ref}".`);
      }
      if (!depSet.has(ref)) {
        throw new Error(
          `steps "${step.id}" template references "${ref}" which is not in its depends_on.`
        );
      }
    }
  }

  // Kahn topological pre-pass: any remaining node after removing all
  // resolvable edges sits on a cycle.
  const indegree = new Map();
  for (const step of compiled) indegree.set(step.id, step.depends_on.length);
  const dependents = new Map();
  for (const step of compiled) dependents.set(step.id, []);
  for (const step of compiled) {
    for (const dep of step.depends_on) dependents.get(dep).push(step.id);
  }
  const queue = compiled.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== compiled.length) {
    const cyclic = compiled.filter((s) => indegree.get(s.id) > 0).map((s) => s.id);
    throw new Error(`steps form a cycle involving: ${cyclic.join(", ")}.`);
  }

  return { compiled, byId };
}

// Build the resolved-deps scope ({steps:{<id>:output}}) for a step from the
// already-settled results map. output is the worker's parsed value (or array of
// values for a parallel/verify/loop step).
function depScope(step, results) {
  const stepsScope = {};
  for (const dep of step.depends_on) {
    stepsScope[dep] = results.has(dep) ? results.get(dep).output : undefined;
  }
  return { steps: stepsScope };
}

// Execute a single compiled step given its resolved dep outputs. Returns
// { output, workerResults } where workerResults is the flat list of spawnWorker
// records this step produced (for journaling), and output is the value injected
// into dependents.
async function executeStep(step, results, ctx, codexBin, codexHomeValue, retryWorker, transportOpts) {
  const baseScope = depScope(step, results);
  const common = {
    ctx,
    sandbox: step.sandbox,
    model: step.model,
    reasoningEffort: step.reasoning_effort,
    timeoutMs: step.timeout_ms,
    cwd: step.cwd,
    codex_bin: codexBin,
    codex_home: codexHomeValue,
    phase: step.phase,
    // Opt-in transport cascades from the pipeline level to every step's worker.
    // verify/loop spawn through adversarialVerify/loopUntilDry which don't thread
    // transport, so those keep the default exec path — transport applies to
    // worker/parallel steps (the ones spawning directly here).
    ...(transportOpts && transportOpts.transport && transportOpts.transport !== "exec"
      ? { transport: transportOpts.transport, transport_strict: transportOpts.transportStrict }
      : {}),
    ...(retryWorker || {})
  };

  if (step.kind === "worker") {
    const prompt = renderTemplate(step.prompt, baseScope);
    const result = await spawnWorker(prompt, {
      ...common,
      schema: step.schema,
      label: step.label,
      isolation: step.isolation,
      // Opt-in warm executor (default 'cold'). A single-turn worker step with
      // executor:'resume' just persists its session for forward-compat; warm
      // reuse across stages is exercised by runPipeline(...,{warm:true}). 'fork'
      // degrades to cold with a log line.
      executor: step.executor
    });
    return { output: result.value, workerResults: [result] };
  }

  if (step.kind === "parallel") {
    const items = step.items || Array.from({ length: step.fanout || 1 }, (_, i) => ({ index: i }));
    const records = [];
    const thunks = items.map((item, i) => () =>
      spawnWorker(renderTemplate(step.prompt, { ...baseScope, item }), {
        ...common,
        schema: step.schema,
        label: `${step.label}#${i}`,
        isolation: step.isolation,
        executor: step.executor
      }).then((result) => {
        records[i] = result;
        return result.value;
      })
    );
    const output = await runParallel(thunks, { ctx });
    return { output, workerResults: records.filter(Boolean) };
  }

  if (step.kind === "verify") {
    const depResult = results.get(step.findings_from);
    const findingsSource = depResult ? depResult.output : undefined;
    let findings = getPath(findingsSource, step.findings_path);
    if (!Array.isArray(findings)) findings = findings === undefined || findings === null ? [] : [findings];
    const survivors = await adversarialVerify(findings, {
      ctx,
      skeptics: step.skeptics,
      lenses: step.lenses && step.lenses.length ? step.lenses : undefined,
      context: step.context ? renderTemplate(step.context, baseScope) : undefined,
      sandbox: step.sandbox,
      model: step.model,
      reasoningEffort: step.reasoning_effort,
      cwd: step.cwd,
      phase: step.phase
    });
    return { output: survivors, workerResults: [] };
  }

  if (step.kind === "loop") {
    const collected = await loopUntilDry(
      (round) => renderTemplate(step.prompt, { ...baseScope, round }),
      {
        ctx,
        schema: step.schema,
        dryRounds: step.dry_rounds,
        maxRounds: step.max_rounds,
        sandbox: step.sandbox,
        model: step.model,
        reasoningEffort: step.reasoning_effort,
        cwd: step.cwd,
        phase: step.phase,
        label: step.label
      }
    );
    return { output: collected, workerResults: [] };
  }

  throw new Error(`Unknown step kind: ${step.kind}`);
}

// Build a journaled worker-record entry for a settled step, mirroring the
// runExplicitWorkflow worker shape so ultracode_status/resume read it unchanged.
function stepRecordFromExecution(step, execution, durationMs) {
  const usage = sumUsageFromWorkers(execution.workerResults);
  const dropped = (r) => r && (r.status === "failed" || r.status === "cancelled");
  const anyFailed = execution.workerResults.some(dropped);
  const allFailed = execution.workerResults.length > 0 && execution.workerResults.every(dropped);
  const allCancelled =
    execution.workerResults.length > 0 && execution.workerResults.every((r) => r && r.status === "cancelled");
  return {
    index: step.index,
    id: step.id,
    step_id: step.id,
    kind: step.kind,
    depends_on: step.depends_on,
    title: step.label,
    label: step.label,
    phase: step.phase,
    status: allCancelled ? "cancelled" : allFailed ? "failed" : "completed",
    result: execution.output,
    usage,
    duration_ms: durationMs,
    ...(anyFailed && !allFailed ? { partial: true } : {}),
    spec: {
      kind: step.kind,
      prompt: step.prompt,
      schema: step.schema,
      sandbox: step.sandbox,
      model: step.model || null,
      reasoning_effort: step.reasoning_effort || null,
      timeout_ms: step.timeout_ms,
      cwd: step.cwd,
      isolation: step.isolation || null,
      depends_on: step.depends_on
    }
  };
}

function stepFailureRecord(step, error) {
  return {
    index: step.index,
    id: step.id,
    step_id: step.id,
    kind: step.kind,
    depends_on: step.depends_on,
    title: step.label,
    label: step.label,
    phase: step.phase,
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  };
}

// Compile a declarative steps[] DAG and run it barrier-free, producing the same
// journaled workflow record shape as runExplicitWorkflow.
async function runPipelineSpec(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const baseSandbox = input.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(baseSandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const baseEffort = input.reasoning_effort || input.reasoningEffort;
  if (baseEffort !== undefined && baseEffort !== null && !VALID_EFFORTS.has(baseEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const timeoutMs =
    input.timeout_ms === undefined || input.timeout_ms === null
      ? DEFAULT_TIMEOUT_MS
      : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
  const defaults = {
    cwd,
    sandbox: baseSandbox,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
    reasoning_effort: baseEffort,
    timeout_ms: timeoutMs,
    // Top-level executor cascades to every step that does not set its own.
    // Defaults to 'cold' so an omitted executor leaves the pipeline unchanged.
    executor:
      input.executor === "resume" || input.executor === "fork" || input.executor === "cold"
        ? input.executor
        : "cold"
  };

  // Compile + validate the whole DAG BEFORE any spawn. A bad spec throws here,
  // producing zero side effects / no orphaned worktrees.
  const { compiled } = compileSteps(input.steps, defaults);
  const retryOpts = resolveRetryInput(input);

  const id = workflowId();
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });

  const now = new Date().toISOString();
  const codexBin =
    typeof input.codex_bin === "string" && input.codex_bin.trim() ? input.codex_bin.trim() : defaultCodexBin();
  const codexHomeValue =
    typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome();
  const transport = resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT));
  const transportStrict = resolveBool(firstDefined(input.transport_strict, input.transportStrict), false);

  const indexById = new Map(compiled.map((s, i) => [s.id, i]));
  const workflow = {
    id,
    status: "running",
    task: input.task || `${compiled.length}-step pipeline`,
    cwd,
    started_at: now,
    completed_at: null,
    options: {
      workers: compiled.length,
      sandbox: baseSandbox,
      timeout_ms: timeoutMs,
      model: defaults.model || null,
      reasoning_effort: baseEffort || null,
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      pipeline: true,
      ...retryOpts.journal,
      ...transportJournal(transport, transportStrict)
    },
    state_path: statePathFor(id),
    phases: Array.from(new Set(compiled.map((s) => s.phase).filter(Boolean))),
    workers: compiled.map((step) => ({
      index: step.index,
      id: step.id,
      step_id: step.id,
      kind: step.kind,
      depends_on: step.depends_on,
      title: step.label,
      label: step.label,
      phase: step.phase,
      status: "pending"
    })),
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };
  await writeJson(workflow.state_path, workflow);
  const persister = makePersister(workflow, ctx);

  // Barrier-free topological scheduling: stepPromise[id] resolves once the step
  // executes, and a step's body only starts after Promise.all(its deps). The
  // shared ctx/limiter keeps total concurrency globally bounded across branches.
  const results = new Map(); // id -> { output }
  const stepPromise = new Map();
  for (const step of compiled) {
    const depPromises = step.depends_on.map((dep) => stepPromise.get(dep));
    const promise = Promise.all(depPromises).then(async () => {
      emitEvent(ctx, { type: "step.started", label: step.label, phase: step.phase, kind: step.kind });
      const startedAt = Date.now();
      let record;
      try {
        const execution = await executeStep(step, results, ctx, codexBin, codexHomeValue, retryOpts.worker, {
          transport,
          transportStrict
        });
        results.set(step.id, { output: execution.output });
        record = stepRecordFromExecution(step, execution, Date.now() - startedAt);
      } catch (error) {
        // A render/validation error inside a step (e.g. unresolved token) drops
        // just this step; dependents that referenced it will then also fail.
        log(ctx, `pipeline: step "${step.id}" failed: ${error instanceof Error ? error.message : error}`, {
          step_id: step.id,
          reason: "step-error"
        });
        record = stepFailureRecord(step, error);
        results.set(step.id, { output: undefined });
      }
      workflow.workers[indexById.get(step.id)] = record;
      emitEvent(ctx, { type: "step.completed", label: step.label, phase: step.phase, status: record.status });
      persister.schedule();
      return record;
    });
    stepPromise.set(step.id, promise);
  }

  await Promise.all(Array.from(stepPromise.values()));
  finalizeRecord(workflow, ctx);
  persister.schedule();
  await persister.flush();
  return workflow;
}

module.exports = {
  MAX_WORKERS,
  DEFAULT_MAX_AGENTS,
  WORKER_SCHEMA,
  VERDICT_SCHEMA,
  // workflow records
  planWorkflow,
  runWorkflow,
  runPipelineSpec,
  resumeWorkflow,
  // Convenience re-export of the opt-in script runner. This is a LAZY wrapper:
  // the runner top-level-requires this engine, so the engine must NOT top-level
  // require the runner (that would form a require cycle and hand the runner a
  // half-initialized engine). Requiring it at call time breaks the cycle. CLI/
  // MCP still require the runner directly; this exists purely for convenience.
  runScript: (...args) => require("./ultracode-script-runner").runScript(...args),
  readWorkflow,
  compactWorkflow,
  stateDir,
  statePathFor,
  // orchestration primitives
  spawnWorker,
  spawnWarmWorker,
  runParallel,
  runPipeline,
  loopUntilDry,
  adversarialVerify,
  createContext,
  createLimiter,
  defaultConcurrency,
  validateAgainstSchema,
  sumUsageFromWorkers,
  log,
  // Warm-context arg builders (exported so the resume-args contract can be
  // snapshot-tested and the cold default can be guarded). Stable in shape.
  buildCodexArgs,
  buildResumeArgs,
  // Internal/unstable helpers, surfaced for unit tests only. Not part of the
  // stable public contract; the supported entry point is runPipelineSpec.
  _internal: {
    compileSteps,
    renderTemplate,
    getPath,
    classifyCodexError,
    backoffDelay,
    abortableDelay,
    spawnWorkerGuarded,
    resolveWorkerOpts,
    resolveRetryInput,
    isResumeUnavailable,
    injectSchemaIntoPrompt,
    resolveTransport,
    normalizeAppServerUsage,
    transportJournal
  }
};
