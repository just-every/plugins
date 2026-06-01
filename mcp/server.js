#!/usr/bin/env node
"use strict";

const engine = require("../scripts/ultracode-engine");

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
      "Run Codex subprocess workers in parallel and return structured fan-out findings to the parent thread.",
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
        timeout_ms: { type: "integer", minimum: 1000 },
        codex_bin: { type: "string", description: "Optional Codex binary path." },
        codex_home: { type: "string", description: "Optional CODEX_HOME for child workers." }
      },
      required: ["task"]
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

async function callTool(name, args) {
  if (name === "ultracode_plan") {
    return contentResult(engine.planWorkflow(args || {}));
  }
  if (name === "ultracode_run") {
    return contentResult(await engine.runWorkflow(args || {}));
  }
  if (name === "ultracode_status") {
    return contentResult(await engine.readWorkflow(args || {}));
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
      sendResult(message.id, await callTool(params.name, params.arguments || {}));
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
