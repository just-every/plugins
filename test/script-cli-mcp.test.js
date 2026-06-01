"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const SERVER = path.join(__dirname, "..", "mcp", "server.js");
const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");
const ECHO_FIXTURE = path.join(__dirname, "fixtures", "echo.workflow.js");

// Drive the MCP stdio server over JSONL (same pattern as pipeline-mcp.test.js).
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
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve({ responses, stderr }));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// tools/list: original 5 tools PLUS ultracode_script; existing tools unchanged.
// ---------------------------------------------------------------------------

test("tools/list exposes the 5 original tools PLUS ultracode_script (additionalProperties:false)", async () => {
  const { responses } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const list = responses.find((r) => r.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools));
  const names = list.result.tools.map((t) => t.name);
  // Every original tool still present.
  for (const n of ["ultracode_plan", "ultracode_run", "ultracode_pipeline", "ultracode_resume", "ultracode_status"]) {
    assert.ok(names.includes(n), `${n} still present`);
  }
  // The new tool is additive.
  assert.ok(names.includes("ultracode_script"), "ultracode_script listed");
  assert.strictEqual(names.length, 6, "exactly the 5 originals + ultracode_script");
  const script = list.result.tools.find((t) => t.name === "ultracode_script");
  assert.strictEqual(script.inputSchema.additionalProperties, false);
  // Schema surface is exactly the documented additive set.
  assert.deepStrictEqual(
    Object.keys(script.inputSchema.properties).sort(),
    ["args", "budget_tokens", "concurrency", "cwd", "max_agents", "path", "source"].sort()
  );
  // Description names the env var and the not-a-sandbox warning.
  assert.match(script.description, /ULTRACODE_ALLOW_SCRIPT=1/);
  assert.match(script.description, /NOT sandboxed/i);
});

// ---------------------------------------------------------------------------
// MCP gate OFF (default): refuses with isError + enable instructions, spawns
// nothing.
// ---------------------------------------------------------------------------

test("MCP ultracode_script disabled by default returns isError with enable instructions", async () => {
  const home = freshTmpDir("ultracode-script-mcp-");
  const { responses } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_script",
          arguments: { path: ECHO_FIXTURE, cwd: home }
        }
      }
    ],
    // Explicitly ensure the flag is NOT set for this child.
    { CODEX_HOME: home, ULTRACODE_ALLOW_SCRIPT: "" }
  );
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result, "got a result envelope");
  assert.strictEqual(call.result.isError, true, "disabled tool returns isError");
  const text = call.result.content[0].text;
  assert.match(text, /ULTRACODE_ALLOW_SCRIPT=1/, "names the env var");
  assert.match(text, /not sandboxed/i, "states it is not a sandbox");
  assert.match(text, /path/i, "recommends path over source");
});

// ---------------------------------------------------------------------------
// MCP gate ON: path mode runs against the mock and journals a script record.
// ---------------------------------------------------------------------------

test("MCP ultracode_script with ULTRACODE_ALLOW_SCRIPT=1 runs a path-mode script against the mock", async () => {
  const home = freshTmpDir("ultracode-script-mcp-");
  const { responses } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_script",
          arguments: { path: ECHO_FIXTURE, args: { who: "mcp" }, cwd: home }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, ULTRACODE_ALLOW_SCRIPT: "1" }
  );
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result && !call.result.isError, `enabled script call succeeded: ${call && JSON.stringify(call.result)}`);
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.status, "completed");
  assert.strictEqual(record.result.who, "mcp");
  assert.ok(Array.isArray(record.events) && record.events.length > 0, "events populated");

  // The journaled record is readable by ultracode_status.
  const { responses: statusResp } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ultracode_status", arguments: { workflow_id: record.id } }
      }
    ],
    { CODEX_HOME: home }
  );
  const status = statusResp.find((r) => r.id === 2);
  const statusRecord = JSON.parse(status.result.content[0].text);
  assert.strictEqual(statusRecord.id, record.id, "status reads the script record by id");
});

test("MCP ultracode_script with ULTRACODE_ALLOW_SCRIPT=1 accepts inline source", async () => {
  const home = freshTmpDir("ultracode-script-mcp-");
  const { responses } = await rpc(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ultracode_script",
          arguments: { source: "const v = await agent('inspect inline'); return { ok: v !== null };", cwd: home }
        }
      }
    ],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, ULTRACODE_ALLOW_SCRIPT: "1" }
  );
  const call = responses.find((r) => r.id === 2);
  assert.ok(call && call.result && !call.result.isError, "inline source accepted when enabled");
  const record = JSON.parse(call.result.content[0].text);
  assert.strictEqual(record.status, "completed");
  assert.strictEqual(record.result.ok, true);
});

// ---------------------------------------------------------------------------
// CLI: allowed by default; positional path, --path, --source, --args (JSON).
// ---------------------------------------------------------------------------

test("CLI script <positional-path> --args runs via the mock and reaches the script scope", async () => {
  const home = freshTmpDir("ultracode-script-cli-");
  const { code, stdout, stderr } = await runCli(
    ["script", ECHO_FIXTURE, "--args", '{"who":"cli"}', "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.status, "completed");
  assert.strictEqual(record.result.who, "cli", "--args JSON reached the script scope");
});

test("CLI script --path and --source both work; --source runs inline", async () => {
  const home = freshTmpDir("ultracode-script-cli-");
  const byPath = await runCli(
    ["script", "--path", ECHO_FIXTURE, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(byPath.code, 0, `--path exited 0 (stderr: ${byPath.stderr})`);
  assert.strictEqual(JSON.parse(byPath.stdout).status, "completed");

  const home2 = freshTmpDir("ultracode-script-cli-");
  const bySource = await runCli(
    ["script", "--source", "return { hi: 1 };", "--cwd", home2, "--codex-bin", MOCK, "--codex-home", home2],
    { CODEX_HOME: home2, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(bySource.code, 0, `--source exited 0 (stderr: ${bySource.stderr})`);
  assert.deepStrictEqual(JSON.parse(bySource.stdout).result, { hi: 1 });
});

test("CLI script with malformed --args reports a clean JSON error", async () => {
  const { code, stderr } = await runCli(["script", "--source", "return 1;", "--args", "{not json"], {});
  assert.notStrictEqual(code, 0, "non-zero exit on bad JSON");
  assert.match(stderr, /--args must be valid JSON/);
});

test("CLI unknown-command hint includes script", async () => {
  const { code, stderr } = await runCli(["frobnicate"], {});
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /plan\|run\|pipeline\|resume\|status\|script/);
});
