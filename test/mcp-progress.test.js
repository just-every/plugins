"use strict";

// MCP progress-notification tests (no live server / no real codex).
//
// Per the MCP spec, a tools/call request carrying _meta.progressToken MAY cause
// the server to emit `notifications/progress` {progressToken, progress, ...} on
// the same connection until it returns the final result, with strictly
// increasing `progress`. Absent the token, ZERO progress notifications fire and
// behavior is identical to before. The engine is stubbed via the mock codex bin.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const SERVER = path.join(__dirname, "..", "mcp", "server.js");

// Drive the stdio MCP server: send `requests`, collect every stdout JSON message
// (results AND notifications), and resolve once all request ids have a result.
function rpc(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let stderr = "";
    const wantIds = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    const messages = [];
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        messages.push(msg);
        if (msg.id !== undefined && msg.id !== null) wantIds.delete(msg.id);
        if (wantIds.size === 0) child.stdin.end();
      }
    });
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve({ messages, stderr }));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

function progressNotifications(messages) {
  return messages.filter((m) => m.method === "notifications/progress");
}

test("ultracode_run with _meta.progressToken emits >=1 progress notification, strictly increasing", async () => {
  const home = freshTmpDir("ultracode-mcp-prog-");
  const TOKEN = "tok-123";
  const { messages } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          _meta: { progressToken: TOKEN },
          name: "ultracode_run",
          arguments: {
            workers_spec: [{ prompt: "hello", schema: null }],
            cwd: home,
            codex_bin: MOCK,
            codex_home: home,
            concurrency: 1
          }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, MOCK_CODEX_RESPONSE: "ok" }
  );

  const notes = progressNotifications(messages);
  assert.ok(notes.length >= 1, `expected >=1 progress notification, got ${notes.length}`);
  // All carry the matching token.
  for (const n of notes) {
    assert.strictEqual(n.params.progressToken, TOKEN);
    assert.strictEqual(typeof n.params.progress, "number");
    assert.strictEqual(typeof n.params.message, "string");
    assert.ok(!("total" in n.params), "total omitted when unknown");
  }
  // Strictly increasing progress (monotonic per the spec).
  for (let i = 1; i < notes.length; i += 1) {
    assert.ok(
      notes[i].params.progress > notes[i - 1].params.progress,
      `progress must strictly increase: ${notes[i - 1].params.progress} -> ${notes[i].params.progress}`
    );
  }
  // The final result still arrives.
  const call = messages.find((m) => m.id === 2);
  assert.ok(call && call.result && !call.result.isError, "the final tools/call result arrives");
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.status, "completed");
});

test("ultracode_run WITHOUT _meta emits ZERO progress notifications, same final result", async () => {
  const home = freshTmpDir("ultracode-mcp-noprog-");
  const { messages } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_run",
          arguments: {
            workers_spec: [{ prompt: "hello", schema: null }],
            cwd: home,
            codex_bin: MOCK,
            codex_home: home,
            concurrency: 1
          }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, MOCK_CODEX_RESPONSE: "ok" }
  );

  assert.strictEqual(progressNotifications(messages).length, 0, "no progress notifications without a token");
  const call = messages.find((m) => m.id === 2);
  assert.ok(call && call.result && !call.result.isError);
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.status, "completed");
});

test("ultracode_pipeline with _meta.progressToken emits progress notifications too", async () => {
  const home = freshTmpDir("ultracode-mcp-pipe-prog-");
  const TOKEN = 7; // numeric tokens are allowed by the spec
  const { messages } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          _meta: { progressToken: TOKEN },
          name: "ultracode_pipeline",
          arguments: {
            cwd: home,
            codex_bin: MOCK,
            codex_home: home,
            concurrency: 1,
            steps: [{ id: "a", prompt: "do a", schema: null }]
          }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, MOCK_CODEX_RESPONSE: "ok" }
  );
  const notes = progressNotifications(messages);
  assert.ok(notes.length >= 1, `expected progress for pipeline, got ${notes.length}`);
  assert.strictEqual(notes[0].params.progressToken, TOKEN);
  const call = messages.find((m) => m.id === 2);
  assert.ok(call && call.result && !call.result.isError, "pipeline result arrives");
});

test("tools/list additively exposes the transport knob on ultracode_run", async () => {
  const { messages } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = messages.find((m) => m.id === 2);
  const run = list.result.tools.find((t) => t.name === "ultracode_run");
  assert.deepStrictEqual(run.inputSchema.properties.transport.enum, ["exec", "app-server", "exec-server"]);
  assert.strictEqual(run.inputSchema.properties.transport_strict.type, "boolean");
  // Existing contract preserved.
  assert.ok(run.inputSchema.properties.workers_spec, "workers_spec still present");
});
