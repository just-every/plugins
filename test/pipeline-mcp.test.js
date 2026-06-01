"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const SERVER = path.join(__dirname, "..", "mcp", "server.js");

// Drive the hand-rolled MCP stdio server over JSONL: send a batch of requests,
// collect line-delimited JSON responses, resolve once the last id is seen.
function rpc(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let stderr = "";
    const wantIds = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    const responses = [];
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
        responses.push(msg);
        if (msg.id !== undefined) wantIds.delete(msg.id);
        if (wantIds.size === 0) {
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve({ responses, stderr }));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

test("tools/list exposes ultracode_pipeline with additionalProperties:false and required steps", async () => {
  const { responses } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = responses.find((r) => r.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools));
  const names = list.result.tools.map((t) => t.name);
  // Existing tools preserved.
  for (const n of ["ultracode_plan", "ultracode_run", "ultracode_resume", "ultracode_status"]) {
    assert.ok(names.includes(n), `${n} still present`);
  }
  const pipe = list.result.tools.find((t) => t.name === "ultracode_pipeline");
  assert.ok(pipe, "ultracode_pipeline is listed");
  assert.strictEqual(pipe.inputSchema.additionalProperties, false);
  assert.deepStrictEqual(pipe.inputSchema.required, ["steps"]);
  assert.strictEqual(pipe.inputSchema.properties.steps.items.additionalProperties, false);
  assert.deepStrictEqual(pipe.inputSchema.properties.steps.items.required, ["id"]);
});

test("tools/call ultracode_pipeline with an invalid step (missing id) returns clean isError, not a crash", async () => {
  const home = freshTmpDir("ultracode-mcp-home-");
  const { responses } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_pipeline",
          arguments: {
            cwd: home,
            codex_bin: MOCK,
            codex_home: home,
            steps: [{ prompt: "no id here" }]
          }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result, "got a result envelope");
  assert.strictEqual(call.result.isError, true, "engine validation surfaces as a clean tool error");
  const text = call.result.content[0].text;
  assert.match(text, /id/, "error text mentions the missing id");
});

test("tools/call ultracode_pipeline runs a 2-step DAG end-to-end against the mock", async () => {
  const home = freshTmpDir("ultracode-mcp-home-");
  const { responses } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_pipeline",
          arguments: {
            cwd: home,
            codex_bin: MOCK,
            codex_home: home,
            concurrency: 2,
            steps: [
              { id: "a", prompt: "step a" },
              { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }
            ]
          }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result && !call.result.isError, "pipeline call succeeded");
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.options.pipeline, true);
  assert.strictEqual(record.workers.length, 2);
  assert.strictEqual(record.status, "completed");
});
