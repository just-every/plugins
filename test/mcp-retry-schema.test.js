"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const SERVER = path.join(__dirname, "..", "mcp", "server.js");

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
        if (wantIds.size === 0) child.stdin.end();
      }
    });
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve({ responses, stderr }));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

test("ultracode_run inputSchema additively exposes the retry knobs", async () => {
  const { responses } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = responses.find((r) => r.id === 2);
  const run = list.result.tools.find((t) => t.name === "ultracode_run");
  const props = run.inputSchema.properties;
  assert.strictEqual(props.max_retries.type, "integer");
  assert.strictEqual(props.max_retries.minimum, 0);
  assert.strictEqual(props.base_delay_ms.type, "integer");
  assert.strictEqual(props.max_delay_ms.type, "integer");
  assert.strictEqual(props.retry_jitter.type, "boolean");
  // Existing contract preserved: workers_spec still required-free and present.
  assert.ok(props.workers_spec, "workers_spec still present");
});

test("MCP ultracode_run default path is unchanged: no signal, no retries => completed", async () => {
  const home = freshTmpDir("ultracode-mcp-default-");
  const { responses } = await rpc(
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
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result && !call.result.isError, `run succeeded (${call && JSON.stringify(call.result)})`);
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.status, "completed");
  assert.ok(!("max_retries" in record.options), "no retry knobs journaled on the default path");
});
