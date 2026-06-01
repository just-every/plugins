"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

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

test("CLI pipeline --steps parses JSON, runs the DAG, prints the record", async () => {
  const home = freshTmpDir("ultracode-cli-home-");
  const steps = JSON.stringify([
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }
  ]);
  const { code, stdout, stderr } = await runCli(
    ["pipeline", "--steps", steps, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--concurrency", "2", "--progress"],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.options.pipeline, true);
  assert.strictEqual(record.workers.length, 2);
  assert.strictEqual(record.status, "completed");
  // --progress writes events to stderr.
  assert.match(stderr, /\[ultracode\]/, "progress lines emitted to stderr");
});

test("CLI pipeline with malformed --steps reports a clean JSON error", async () => {
  const { code, stderr } = await runCli(["pipeline", "--steps", "{not json"], {});
  assert.notStrictEqual(code, 0, "non-zero exit on bad JSON");
  assert.match(stderr, /--steps must be valid JSON/);
});

test("CLI rejects an unknown command with the updated plan|run|pipeline|resume|status hint", async () => {
  const { code, stderr } = await runCli(["frobnicate"], {});
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /plan\|run\|pipeline\|resume\|status/);
});
