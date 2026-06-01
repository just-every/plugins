"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

function spawnCli(args, env = {}) {
  return childProcess.spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("CLI run: first SIGINT cancels, prints notice, exits 0 with a persisted cancelled/partial state", async () => {
  const home = freshTmpDir("ultracode-sigint-home-");
  const workers_spec = JSON.stringify([
    { prompt: "slow one", schema: null },
    { prompt: "slow two", schema: null },
    { prompt: "slow three", schema: null }
  ]);
  const child = spawnCli(
    ["run", "--workers-spec", workers_spec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--concurrency", "1"],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK, MOCK_CODEX_SLEEP_MS: "1500", MOCK_CODEX_RESPONSE: "ok" }
  );
  const done = collect(child);
  // Give the run a moment to start the first worker, then Ctrl-C once.
  await new Promise((r) => setTimeout(r, 400));
  child.kill("SIGINT");
  const { code, stdout, stderr } = await done;

  assert.match(stderr, /cancelling run/i, "prints the cancel notice");
  assert.strictEqual(code, 0, `exits 0 after a graceful cancel (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.ok(
    record.status === "cancelled" || record.status === "partial",
    `status should be cancelled/partial, got ${record.status}`
  );
  // The persisted state file exists and matches.
  assert.ok(fs.existsSync(record.state_path), "state file persisted");
  const persisted = JSON.parse(fs.readFileSync(record.state_path, "utf8"));
  assert.strictEqual(persisted.id, record.id);
});

test("CLI run: a second SIGINT forces exit 130", async () => {
  const home = freshTmpDir("ultracode-sigint2-home-");
  const workers_spec = JSON.stringify([{ prompt: "very slow", schema: null }]);
  const child = spawnCli(
    ["run", "--workers-spec", workers_spec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--concurrency", "1"],
    {
      CODEX_HOME: home,
      CODEX_CLI_PATH: MOCK,
      MOCK_CODEX_SLEEP_MS: "6000",
      MOCK_CODEX_RESPONSE: "ok",
      // The child ignores SIGTERM so the engine's kill ladder must escalate; this
      // keeps the run in-flight long enough for a second SIGINT to be observed.
      MOCK_CODEX_IGNORE_SIGTERM: "1"
    }
  );
  const done = collect(child);
  await new Promise((r) => setTimeout(r, 400));
  child.kill("SIGINT");
  // Second SIGINT while the first abort is still tearing down => hard-exit 130.
  await new Promise((r) => setTimeout(r, 150));
  child.kill("SIGINT");
  const { code, stderr } = await done;
  assert.strictEqual(code, 130, `force-quit exit code 130 (stderr: ${stderr})`);
  assert.match(stderr, /force quit/i);
});

test("CLI plan does NOT install the SIGINT handler (unaffected by Ctrl-C wiring)", async () => {
  // plan is synchronous and returns immediately; just assert it works and prints.
  const { code, stdout } = await collect(spawnCli(["plan", "--task", "hello", "--workers", "2"], {}));
  assert.strictEqual(code, 0);
  const plan = JSON.parse(stdout);
  assert.strictEqual(plan.workers.length, 2);
});
