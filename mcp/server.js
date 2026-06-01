#!/usr/bin/env node
"use strict";

const engine = require("../scripts/ultracode-engine");
// Require the runner DIRECTLY (not via engine) so the script contract stays
// clean and we avoid relying on the engine's lazy re-export. The runner
// top-level-requires the engine; the engine must NOT top-level-require the
// runner — so requiring the runner here is cycle-free.
const scriptRunner = require("../scripts/ultracode-script-runner");

const PROTOCOL_VERSION = "2025-06-18";

const tools = [
  {
    name: "ultracode_plan",
    description: "Plan a parallel Ultracode worker workflow without launching Codex subprocesses.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "The objective to fan out across workers." },
        cwd: { type: "string", description: "Workspace directory for child workers." },
        workers: { type: "integer", minimum: 1, maximum: engine.MAX_WORKERS },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Child worker sandbox mode. Defaults to read-only."
        },
        model: { type: "string", description: "Optional child Codex model." },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        timeout_ms: { type: "integer", minimum: 1000 }
      },
      required: ["task"]
    }
  },
  {
    name: "ultracode_run",
    description:
      "Run Codex subprocess workers in parallel and return structured fan-out findings to the parent thread. " +
      "Supply `task` for the default fixed-role fan-out, or `workers_spec` for arbitrary per-worker prompts and schemas " +
      "(the agent()-style parity path). Concurrency is capped, token usage is aggregated, and a token budget can gate spawns.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "The objective to fan out across workers. Required unless workers_spec is given." },
        cwd: { type: "string", description: "Workspace directory for child workers." },
        workers: { type: "integer", minimum: 1, maximum: engine.MAX_WORKERS },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Child worker sandbox mode. Defaults to read-only."
        },
        model: { type: "string", description: "Optional child Codex model." },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        timeout_ms: { type: "integer", minimum: 1000 },
        codex_bin: { type: "string", description: "Optional Codex binary path." },
        codex_home: { type: "string", description: "Optional CODEX_HOME for child workers." },
        concurrency: {
          type: "integer",
          minimum: 1,
          description: "Max simultaneous Codex subprocesses. Defaults to min(16, cores-2)."
        },
        budget_tokens: {
          type: "integer",
          minimum: 0,
          description: "Optional total token ceiling. New workers are skipped (and logged) once exceeded."
        },
        max_agents: {
          type: "integer",
          minimum: 1,
          description: "Lifetime cap on spawned workers for this run. Defaults to 1000."
        },
        max_retries: {
          type: "integer",
          minimum: 0,
          description:
            "Transient-error retries per worker (classified: HTTP 429/5xx, rate-limit, network). Defaults to 0 (no retry)."
        },
        base_delay_ms: {
          type: "integer",
          minimum: 0,
          description: "Base backoff delay for transient retries. Defaults to 500."
        },
        max_delay_ms: {
          type: "integer",
          minimum: 0,
          description: "Max backoff delay cap for transient retries. Defaults to 30000."
        },
        retry_jitter: {
          type: "boolean",
          description: "Apply full-jitter to backoff delays. Defaults to true."
        },
        transport: {
          type: "string",
          enum: ["exec", "app-server", "exec-server"],
          description:
            "Worker transport. 'exec' (default) shells `codex exec --json`. 'app-server' uses the opt-in versioned " +
            "JSON-RPC app-server (auto-falls-back to exec on failure). 'exec-server' is reserved (not yet implemented)."
        },
        transport_strict: {
          type: "boolean",
          description: "When true, an app-server failure errors instead of falling back to exec. Defaults to false."
        },
        workers_spec: {
          type: "array",
          description:
            "Explicit per-worker specs (arbitrary prompt + optional per-worker schema). When present, replaces the fixed-role fan-out.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              prompt: { type: "string", description: "The worker's full prompt." },
              label: { type: "string", description: "Display label for progress/aggregation." },
              schema: {
                type: ["object", "null"],
                description: "Optional JSON Schema for this worker's output. Omit for the default schema; pass null for raw text."
              },
              sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
              model: { type: "string" },
              reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
              phase: { type: "string", description: "Optional phase label for grouping." },
              timeout_ms: { type: "integer", minimum: 1000 },
              cwd: { type: "string" },
              isolation: { type: "string", enum: ["worktree"], description: "Run this writable worker in an isolated git worktree." }
            },
            required: ["prompt"]
          }
        }
      }
    }
  },
  {
    name: "ultracode_pipeline",
    description:
      "Run a declarative DAG of Codex worker stages described as pure JSON. Each step has an id, a kind " +
      "(worker | parallel | verify | loop), a prompt template, and optional depends_on edges. Steps run " +
      "barrier-free: each starts the instant its own dependencies resolve. Cross-stage data flows by rendering " +
      "{{steps.<id>.output}} / {{steps.<id>.output.<path>}} / {{steps.<id>.summary}} tokens (plus {{round}} for " +
      "loop, {{item.<key>}} for parallel) into the dependent prompt. verify wraps adversarialVerify over an " +
      "upstream findings array; loop wraps loopUntilDry. Produces the same journaled record as ultracode_run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        cwd: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
        model: { type: "string" },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        timeout_ms: { type: "integer", minimum: 1000 },
        codex_bin: { type: "string" },
        codex_home: { type: "string" },
        concurrency: { type: "integer", minimum: 1 },
        budget_tokens: { type: "integer", minimum: 0 },
        max_agents: { type: "integer", minimum: 1 },
        max_retries: { type: "integer", minimum: 0 },
        base_delay_ms: { type: "integer", minimum: 0 },
        max_delay_ms: { type: "integer", minimum: 0 },
        retry_jitter: { type: "boolean" },
        transport: {
          type: "string",
          enum: ["exec", "app-server", "exec-server"],
          description:
            "Default worker transport for every step. 'exec' (default) | 'app-server' (opt-in JSON-RPC, falls back) | " +
            "'exec-server' (reserved)."
        },
        transport_strict: { type: "boolean" },
        executor: {
          type: "string",
          enum: ["cold", "resume", "fork"],
          description:
            "Default warm executor for every step. 'cold' (default) = independent cold execs. 'resume' keeps a Codex " +
            "session warm across turns. 'fork' is a forward-compat stub that degrades to cold (codex fork is TUI-only)."
        },
        task: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: ["worker", "parallel", "verify", "loop"] },
              prompt: { type: "string" },
              schema: { type: ["object", "null"] },
              depends_on: { type: "array", items: { type: "string" } },
              label: { type: "string" },
              phase: { type: "string" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
              model: { type: "string" },
              reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
              timeout_ms: { type: "integer", minimum: 1000 },
              cwd: { type: "string" },
              isolation: { type: "string", enum: ["worktree"] },
              executor: {
                type: "string",
                enum: ["cold", "resume", "fork"],
                description: "Per-step warm executor override. Defaults to the top-level executor (cold)."
              },
              findings_from: { type: "string" },
              findings_path: { type: "string" },
              skeptics: { type: "integer", minimum: 1 },
              lenses: { type: "array", items: { type: "string" } },
              context: { type: "string" },
              dry_rounds: { type: "integer", minimum: 1 },
              max_rounds: { type: "integer", minimum: 1 },
              fanout: { type: "integer", minimum: 1 },
              items: { type: "array", items: { type: "object" } }
            }
          }
        }
      }
    }
  },
  {
    name: "ultracode_resume",
    description:
      "Resume a persisted Ultracode workflow by id: completed steps are reused from the journal and only missing, failed, " +
      "or explicitly forced steps are re-run, then results are re-aggregated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow_id: { type: "string", description: "Workflow id to resume." },
        state_path: { type: "string", description: "Explicit state file path (alternative to workflow_id)." },
        force_steps: {
          type: "array",
          items: { type: "string" },
          description: "Step ids / role ids / indices to force re-run even if already completed."
        }
      }
    }
  },
  {
    name: "ultracode_status",
    description: "Read the latest Ultracode workflow state or a specific workflow result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflow_id: { type: "string" },
        state_path: { type: "string" }
      }
    }
  },
  {
    name: "ultracode_script",
    description:
      "Run an imperative Ultracode workflow script — the Codex analogue of Claude Code's Workflow tool. " +
      "The script is plain async JavaScript with a bound scope (agent, spawnWorker, parallel, pipeline, " +
      "loopUntilDry, adversarialVerify, log, phase, workflow, budget, args) and produces a journaled record. " +
      "SECURITY: this runs ARBITRARY Node.js IN-PROCESS with full host privileges and is NOT sandboxed. It is " +
      "DISABLED unless the environment variable ULTRACODE_ALLOW_SCRIPT=1 is set for the MCP server process. " +
      "Prefer passing a file `path` you control over inline `source`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Path to a workflow script file (preferred over inline source)." },
        source: { type: "string", description: "Inline workflow script source (only accepted when ULTRACODE_ALLOW_SCRIPT=1)." },
        args: { type: "object", description: "Arbitrary arguments object exposed to the script as `args`." },
        cwd: { type: "string", description: "Workspace directory for child workers." },
        concurrency: { type: "integer", minimum: 1, description: "Max simultaneous Codex subprocesses." },
        budget_tokens: { type: "integer", minimum: 0, description: "Optional total token ceiling for spawns." },
        max_agents: { type: "integer", minimum: 1, description: "Lifetime cap on spawned workers for this run." }
      }
    }
  }
];

let buffer = Buffer.alloc(0);
let transportMode = null;

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (transportMode === "lsp") {
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
    return;
  }
  process.stdout.write(`${payload.toString("utf8")}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function contentResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ],
    isError
  };
}

// Build an on_event progress emitter for a tools/call carrying an MCP
// _meta.progressToken. Per the MCP spec, the server MAY send
// `notifications/progress` {progressToken, progress, total?, message?} on the
// same connection until it returns the final result; `progress` MUST be
// monotonically increasing. We use a per-call integer counter and omit `total`
// (unknown). When no progressToken is supplied, callers pass undefined and the
// engine receives no on_event — byte-for-byte identical to before.
function makeProgressEmitter(progressToken) {
  if (progressToken === undefined || progressToken === null) return undefined;
  let counter = 0;
  return (event) => {
    const parts = [event && event.type ? String(event.type) : "event"];
    if (event && event.label) parts.push(String(event.label));
    if (event && event.message) parts.push(String(event.message));
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress: counter++,
        message: parts.join(" ")
      }
    });
  };
}

async function callTool(name, args, onEvent) {
  if (name === "ultracode_plan") {
    return contentResult(engine.planWorkflow(args || {}));
  }
  if (name === "ultracode_run") {
    // Only the long-running run tool wires progress; plan/status/resume are fast
    // and unchanged. on_event is undefined unless the client supplied a token.
    return contentResult(await engine.runWorkflow({ ...(args || {}), ...(onEvent ? { on_event: onEvent } : {}) }));
  }
  if (name === "ultracode_pipeline") {
    return contentResult(
      await engine.runPipelineSpec({ ...(args || {}), ...(onEvent ? { on_event: onEvent } : {}) })
    );
  }
  if (name === "ultracode_resume") {
    return contentResult(await engine.resumeWorkflow(args || {}));
  }
  if (name === "ultracode_status") {
    return contentResult(await engine.readWorkflow(args || {}));
  }
  if (name === "ultracode_script") {
    // SECURITY GATE (read at call time so tests can toggle it): ultracode_script
    // runs ARBITRARY Node.js in-process with full host privileges and is NOT a
    // sandbox. It is disabled unless ULTRACODE_ALLOW_SCRIPT=1. When disabled we
    // return an isError content result (NOT a JSON-RPC error) explaining how to
    // enable — we never throw and never spawn anything.
    if (process.env.ULTRACODE_ALLOW_SCRIPT !== "1") {
      return contentResult(
        "ultracode_script is disabled. This tool runs ARBITRARY Node.js in-process with full host " +
          "privileges and is NOT sandboxed. To enable, set environment variable ULTRACODE_ALLOW_SCRIPT=1 " +
          "for the MCP server process, and prefer passing a file `path` you control over inline `source`.",
        true
      );
    }
    return contentResult(
      await scriptRunner.runScript({ ...(args || {}), ...(onEvent ? { on_event: onEvent } : {}) })
    );
  }
  return contentResult(`Unknown Ultracode tool: ${name}`, true);
}

async function handle(message) {
  if (message.method === "initialize") {
    sendResult(message.id, {
      protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ultracode", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "ping") {
    sendResult(message.id, {});
    return;
  }

  if (message.method === "tools/list") {
    sendResult(message.id, { tools });
    return;
  }

  if (message.method === "tools/call") {
    try {
      const params = message.params || {};
      // MCP progress: _meta.progressToken sits beside `arguments` on params. When
      // present we emit notifications/progress on the same connection; when
      // absent, onEvent is undefined and behavior is identical to before.
      const progressToken = params._meta ? params._meta.progressToken : undefined;
      const onEvent = makeProgressEmitter(progressToken);
      sendResult(message.id, await callTool(params.name, params.arguments || {}, onEvent));
    } catch (error) {
      sendResult(message.id, contentResult(error instanceof Error ? error.message : String(error), true));
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    sendError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function headerEndIndex(data) {
  const crlf = data.indexOf("\r\n\r\n");
  if (crlf !== -1) return { index: crlf, length: 4 };
  const lf = data.indexOf("\n\n");
  if (lf !== -1) return { index: lf, length: 2 };
  return null;
}

function parseContentLength(header) {
  for (const line of header.split(/\r?\n/)) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function handleParsedMessage(message) {
  handle(message).catch((error) => {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  });
}

function pumpLspFrames() {
  while (buffer.length > 0) {
    const end = headerEndIndex(buffer.toString("utf8"));
    if (!end) return;
    const header = buffer.slice(0, end.index).toString("utf8");
    const length = parseContentLength(header);
    if (!Number.isInteger(length)) {
      throw new Error("Missing Content-Length header.");
    }
    const bodyStart = end.index + end.length;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      sendError(null, -32700, `Parse error: ${error.message}`);
      continue;
    }
    handleParsedMessage(message);
  }
}

function pumpJsonLines() {
  while (buffer.length > 0) {
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    const raw = buffer.slice(0, newline).toString("utf8").trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      sendError(null, -32700, `Parse error: ${error.message}`);
      continue;
    }
    handleParsedMessage(message);
  }
}

function pump() {
  if (!transportMode) {
    const trimmed = buffer.toString("utf8", 0, Math.min(buffer.length, 32)).trimStart();
    if (!trimmed) return;
    transportMode = /^content-length:/i.test(trimmed) ? "lsp" : "jsonl";
  }

  if (transportMode === "lsp") {
    pumpLspFrames();
  } else {
    pumpJsonLines();
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});

process.stdin.on("end", () => {
  process.exit(0);
});
