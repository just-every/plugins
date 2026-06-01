"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../../scripts/ultracode-engine.js");

const MOCK = path.join(__dirname, "..", "fixtures", "mock-codex.js");
const MOCK_FAIL = path.join(__dirname, "..", "fixtures", "mock-codex-fail.js");

// All MOCK_CODEX_* keys we may set, so we can snapshot + cleanly restore them.
const MOCK_KEYS = [
  "MOCK_CODEX_RESPONSE",
  "MOCK_CODEX_EXIT",
  "MOCK_CODEX_SLEEP_MS",
  "MOCK_CODEX_STDERR",
  "MOCK_CODEX_USAGE",
  "MOCK_CODEX_INVALID_FIRST",
  "MOCK_CODEX_COUNTER",
  "MOCK_CODEX_THREAD_PREFIX",
  "MOCK_CODEX_FAIL_ON_INVOCATION",
  "MOCK_CODEX_ALT_RESPONSE",
  "MOCK_CODEX_FAIL_TIMES",
  "MOCK_CODEX_SIGTERM_MARKER",
  "MOCK_CODEX_IGNORE_SIGTERM",
  "MOCK_CODEX_SESSION_DIR",
  "MOCK_CODEX_REJECT_RESUME",
  "MOCK_APPSERVER_FAIL_INIT",
  "MOCK_APPSERVER_NO_THREAD"
];

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "ultracode-test-"));
}

// A fresh, never-before-used counter file path under the OS temp dir. The mock
// reads-increments-writes this so cross-process state (retries, skeptics,
// resume re-runs) never bleeds between cases.
function freshCounterPath() {
  return path.join(freshTmpDir("ultracode-counter-"), "counter");
}

// A fresh session dir for warm-context tests. The mock records resumable rollouts
// (rollout-<thread_id>) and an invocations.log (one JSON line per child spawn)
// under it, so a test can assert resume vs cold and which session id was used.
function freshSessionDir() {
  return freshTmpDir("ultracode-session-");
}

// Read the mock's invocations.log (JSON-per-line) for a session dir. Returns []
// if the log does not exist yet.
function readInvocations(sessionDir) {
  const file = path.join(sessionDir, "invocations.log");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Sandbox CODEX_HOME into a temp dir so journaled-state tests never touch
// ~/.codex. stateDir() = $CODEX_HOME/ultracode/runs (confirmed isolatable).
async function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = freshTmpDir("ultracode-home-");
  process.env.CODEX_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Snapshot the MOCK_CODEX_* env keys, apply `vars`, run, then restore. Any key
// set to undefined in `vars` is deleted. Restoration is total: every MOCK_KEY
// is returned to its prior presence/value.
async function withMockEnv(vars, fn) {
  const snapshot = {};
  for (const key of MOCK_KEYS) snapshot[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars || {})) {
      if (value === undefined || value === null) delete process.env[key];
      else process.env[key] = String(value);
    }
    return await fn();
  } finally {
    for (const key of MOCK_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

// Snapshot + set CODEX_CLI_PATH (the env path the higher-order primitives —
// adversarialVerify, loopUntilDry — fall back to, since they do not accept a
// codex_bin option). Restores afterwards.
async function withCodexCliPath(binPath, fn) {
  const prev = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = binPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = prev;
  }
}

// Default option bag pointing spawnWorker/runWorkflow at the mock binary, with
// an isolated cwd. Pass overrides to change schema, codex_bin, etc.
function mockOpts(overrides = {}) {
  const tmp = freshTmpDir("ultracode-cwd-");
  return {
    codex_bin: MOCK,
    codex_home: tmp,
    cwd: tmp,
    schema: engine.WORKER_SCHEMA,
    timeoutMs: 10_000,
    ...overrides
  };
}

module.exports = {
  engine,
  MOCK,
  MOCK_FAIL,
  MOCK_KEYS,
  freshTmpDir,
  freshCounterPath,
  freshSessionDir,
  readInvocations,
  withCodexHome,
  withMockEnv,
  withCodexCliPath,
  mockOpts
};
