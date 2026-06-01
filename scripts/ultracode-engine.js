#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fsSync = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const util = require("util");

const execFileP = util.promisify(childProcess.execFile);

const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_AGENTS = 1000;
const MAX_NESTING_DEPTH = 1;
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

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
    budget: {
      total: budgetTotal,
      spent: () => usageTotals.total_tokens,
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - usageTotals.total_tokens))
    }
  };
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

function spawnCodex({ bin, args, cwd, env, prompt, timeoutMs, onStreamEvent }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let threadId = null;
    let lastUsage = null;
    let settled = false;
    let timedOut = false;
    let killTimer = null;
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

    function finish(error, code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const result = {
        pid: child.pid || null,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        thread_id: threadId,
        usage: lastUsage,
        stdout,
        stderr
      };
      if (error) {
        error.codex_exec = result;
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
    child.on("close", (code, signal) => {
      flushStdout();
      if (timedOut) {
        finish(new Error(`Codex worker timed out after ${timeoutMs}ms.`), code, signal);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || signal || `exit code ${code}`;
        finish(new Error(`Codex worker exited with ${detail}.`), code, signal);
        return;
      }
      finish(null, code, signal);
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
    persistSession: !!opts.persistSession,
    schema,
    schemaRetries:
      opts.schemaRetries === undefined ? (schema ? 1 : 0) : Math.max(0, Math.floor(Number(opts.schemaRetries))),
    label: opts.label || opts.title || "worker",
    phase: opts.phase || null,
    isolation: opts.isolation === "worktree" ? "worktree" : undefined
  };
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

async function runCodexAttempt({ prompt, schema, opts, onStreamEvent }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-"));
  const schemaPath = schema ? path.join(tempDir, "worker.schema.json") : null;
  const lastMessagePath = path.join(tempDir, "last-message.json");
  if (schemaPath) await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
  const args = buildCodexArgs(opts, schemaPath, lastMessagePath);
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
      onStreamEvent
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

function failedWorker(label, phase, error, codexExec, usage, durationMs) {
  return {
    status: "failed",
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

// Atomic agent() equivalent. Spawns one `codex exec` with an arbitrary prompt,
// an optional per-call JSON schema (null => raw text), validates + retries on
// schema mismatch, accounts usage/caps into ctx, and emits progress events.
// Never throws: failures resolve to a {status:'failed'} record.
async function spawnWorker(prompt, opts = {}) {
  const ctx = opts.ctx || null;
  const resolved = resolveWorkerOpts({ ...opts, depth: ctx ? ctx.depth : 0 });
  const exec = () => spawnWorkerGuarded(prompt, resolved, ctx);
  return ctx ? ctx.limiter.run(exec) : exec();
}

async function spawnWorkerGuarded(prompt, opts, ctx) {
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

  try {
    let attempt = 0;
    let currentPrompt = prompt;
    while (true) {
      const loopGate = capExceeded();
      if (loopGate) return loopGate;
      if (ctx) ctx.spawnedCount += 1;
      let attemptResult;
      try {
        attemptResult = await runCodexAttempt({
          prompt: currentPrompt,
          schema: opts.schema,
          opts: { ...runOpts, depth: ctx ? ctx.depth : 0 },
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
          currentPrompt = `${prompt}\n\nYour previous response failed schema validation with these errors:\n- ${validation.errors.join(
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

// Barrier-free multi-stage streaming. Each item flows through every stage
// independently (no inter-stage barrier) — item A can be in stage 3 while item
// B is still in stage 1. A throwing stage drops that one item to null.
async function runPipeline(items, stages, opts = {}) {
  const ctx = opts.ctx || null;
  const chains = items.map((item, index) =>
    (async () => {
      let acc = item;
      for (let stage = 0; stage < stages.length; stage += 1) {
        try {
          acc = await stages[stage](acc, item, index, ctx);
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
  return {
    ...base,
    status: "failed",
    error: result.error,
    ...(result.codex_exec ? { codex_exec: result.codex_exec } : {})
  };
}

async function runLegacyWorker(options, workflow, worker, ctx) {
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
    label: worker.title,
    phase: worker.phase
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
  workflow.status = completed === workflow.workers.length ? "completed" : completed === 0 ? "failed" : "partial";
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

  const id = workflowId();
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null
  });

  const now = new Date().toISOString();
  const codexBin =
    typeof input.codex_bin === "string" && input.codex_bin.trim() ? input.codex_bin.trim() : defaultCodexBin();
  const codexHomeValue =
    typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome();
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
      explicit: true
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
        label: spec.label,
        phase: spec.phase,
        isolation: spec.isolation
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
  const id = workflowId();
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null
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
      max_agents: ctx.maxAgents
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
      runLegacyWorker(options, workflow, worker, ctx).then((record) => {
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
  const force = new Set(input.force_steps || []);
  const ctx = createContext({
    workflowId: record.id,
    concurrency: record.options && record.options.concurrency,
    budgetTokens: record.options && record.options.budget_tokens,
    maxAgents: record.options && record.options.max_agents,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null
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
            isolation: worker.spec.isolation || undefined
          }).then((result) => workerRecordFromResult(worker, result))
        : runLegacyWorker(baseOptions, { id: record.id, cwd: record.cwd }, worker, ctx);
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

module.exports = {
  MAX_WORKERS,
  DEFAULT_MAX_AGENTS,
  WORKER_SCHEMA,
  VERDICT_SCHEMA,
  // workflow records
  planWorkflow,
  runWorkflow,
  resumeWorkflow,
  readWorkflow,
  compactWorkflow,
  stateDir,
  statePathFor,
  // orchestration primitives
  spawnWorker,
  runParallel,
  runPipeline,
  loopUntilDry,
  adversarialVerify,
  createContext,
  createLimiter,
  defaultConcurrency,
  validateAgainstSchema,
  sumUsageFromWorkers,
  log
};
