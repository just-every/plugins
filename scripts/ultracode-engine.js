#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fsSync = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
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

function buildCodexArgs(options, schemaPath, lastMessagePath) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    options.sandbox,
    "-c",
    "approval_policy=\"never\"",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "--cd",
    options.cwd
  ];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.reasoning_effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.reasoning_effort)}`);
  }
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

function spawnCodex({ bin, args, cwd, env, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error, null, null));
    child.on("close", (code, signal) => {
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
    child.stdin.end(prompt);
  });
}

async function runWorker(options, workflow, worker) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `ultracode-${workflow.id}-${worker.id}-`));
  const schemaPath = path.join(tempDir, "worker.schema.json");
  const lastMessagePath = path.join(tempDir, "last-message.json");
  await fs.writeFile(schemaPath, JSON.stringify(WORKER_SCHEMA, null, 2), "utf8");

  const prompt = workerPrompt({
    task: options.task,
    workflow,
    worker,
    sandbox: options.sandbox
  });
  const args = buildCodexArgs(options, schemaPath, lastMessagePath);
  const env = {
    ...process.env,
    CODEX_HOME: options.codex_home,
    ULTRACODE_CHILD: "1"
  };

  try {
    const execResult = await spawnCodex({
      bin: options.codex_bin,
      args,
      cwd: options.cwd,
      env,
      prompt,
      timeoutMs: options.timeout_ms
    });
    const raw = await fs.readFile(lastMessagePath, "utf8");
    let result;
    try {
      result = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Worker ${worker.title} did not return valid schema JSON: ${error.message}`);
    }
    return {
      ...worker,
      status: "completed",
      result,
      usage: parseUsage(execResult.stdout),
      duration_ms: execResult.duration_ms
    };
  } catch (error) {
    return {
      ...worker,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      codex_exec: error && error.codex_exec ? error.codex_exec : undefined
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function compactWorkflow(workflow) {
  const completed = workflow.workers.filter((worker) => worker.status === "completed");
  const failed = workflow.workers.filter((worker) => worker.status === "failed");
  const collect = (field) =>
    completed.flatMap((worker) =>
      Array.isArray(worker.result && worker.result[field])
        ? worker.result[field].map((item) => `${worker.title}: ${item}`)
        : []
    );
  return {
    summary: completed.map((worker) => `${worker.title}: ${worker.result.summary}`),
    findings: collect("findings"),
    recommended_actions: collect("recommended_actions"),
    risks: collect("risks"),
    verification: collect("verification"),
    failed_workers: failed.map((worker) => `${worker.title}: ${worker.error}`)
  };
}

async function runWorkflow(input = {}) {
  const options = normalizeOptions(input);
  const now = new Date().toISOString();
  const workflow = {
    id: workflowId(),
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
      reasoning_effort: options.reasoning_effort || null
    },
    state_path: null,
    workers: selectRoles(options.workers)
  };
  workflow.state_path = statePathFor(workflow.id);
  await writeJson(workflow.state_path, workflow);

  const results = await Promise.all(workflow.workers.map((worker) => runWorker(options, workflow, worker)));
  workflow.workers = results;
  const completed = results.filter((worker) => worker.status === "completed").length;
  workflow.status = completed === results.length ? "completed" : completed === 0 ? "failed" : "partial";
  workflow.completed_at = new Date().toISOString();
  workflow.duration_ms = Date.parse(workflow.completed_at) - Date.parse(workflow.started_at);
  workflow.aggregate = compactWorkflow(workflow);
  await writeJson(workflow.state_path, workflow);
  return workflow;
}

module.exports = {
  MAX_WORKERS,
  planWorkflow,
  readWorkflow,
  runWorkflow,
  stateDir,
  statePathFor
};
