#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// Mock `codex` binary for the Ultracode test suite.
//
// The real engine (scripts/ultracode-engine.js) drives a worker by:
//   const child = childProcess.spawn(bin, args, ...);
//   child.stdin.end(prompt);
// where `bin` is the `codex_bin` option, the `CODEX_CLI_PATH` env var, or the
// platform default. This script stands in for that binary so the suite never
// invokes the real, paid `codex exec`.
//
// Behavior is fully driven by env vars so individual tests can shape one
// invocation without touching the others:
//   MOCK_CODEX_RESPONSE   raw string written verbatim to --output-last-message
//                         (lets a test inject invalid JSON / wrong types / raw
//                          text for schema:null workers). Defaults to a
//                          WORKER_SCHEMA-valid object.
//   MOCK_CODEX_USAGE      raw JSON for the turn.completed usage object.
//   MOCK_CODEX_EXIT       process exit code (default 0).
//   MOCK_CODEX_SLEEP_MS   delay before writing the response / exiting
//                         (drives concurrency + timeout tests).
//   MOCK_CODEX_STDERR     text written to stderr (the engine builds its failure
//                         message from stderr.trim() || stdout.trim(), so a
//                         clean assertable error message needs this set).
//   MOCK_CODEX_INVALID_FIRST  if set, return an invalid response on the FIRST
//                         invocation (per counter file), valid thereafter — for
//                         the schema-retry test. Needs a counter file because
//                         each retry is a fresh process.
//   MOCK_CODEX_COUNTER    path to the cross-process counter file used by
//                         INVALID_FIRST and by alternating-verdict tests.
//   MOCK_CODEX_THREAD_PREFIX  prefix for the synthesized thread_id (default
//                         th_mock).
//   MOCK_CODEX_FAIL_ON_INVOCATION  comma-separated invocation indices (per the
//                         counter file) that must exit non-zero. Lets exactly
//                         one of N concurrent workers in a single workflow fail
//                         so the record lands on status "partial".
//   MOCK_CODEX_ALT_RESPONSE  when set, ODD invocations (per the counter file)
//                         use this raw response and EVEN invocations use
//                         MOCK_CODEX_RESPONSE. Drives alternating-verdict tests
//                         (e.g. one skeptic refutes, the next does not).
//   MOCK_CODEX_FAIL_TIMES  the first N invocations (0-indexed per the counter
//                         file) exit non-zero (with MOCK_CODEX_STDERR), and the
//                         (N+1)th and beyond succeed. Drives transient
//                         retry-then-succeed tests deterministically.
//   MOCK_CODEX_SIGTERM_MARKER  path the SIGTERM handler writes before exiting,
//                         so a cancellation test can assert the child actually
//                         received SIGTERM (the engine's kill ladder).
//   MOCK_CODEX_SESSION_DIR  directory used to record warm-context state:
//                         (a) every non-ephemeral `exec` writes a file named
//                             after its emitted thread_id (the "rollout"), and
//                         (b) every invocation appends one JSON line (its full
//                             argv + subcommand) to `invocations.log` so warm
//                             tests can assert resume vs cold and which session
//                             id was resumed.
//                         An `exec resume <id>` invocation succeeds only if the
//                         <id> rollout file exists; otherwise it FAILS with
//                         `no rollout found for thread id <id>` + exit 1,
//                         mirroring the real CLI's -32600.
//   MOCK_CODEX_REJECT_RESUME  if set, EVERY `exec resume` invocation fails with
//                         the `no rollout found for thread id` signal (drives the
//                         fallback-to-cold test regardless of the recorded id).
//
// Events are emitted on stdout as JSONL — one JSON.stringify(obj)+"\n" per
// line — exactly as the engine's line parser expects. Critically, the usage
// event is emitted BEFORE any non-zero exit so the engine still accounts the
// tokens of a failed worker.
//
// RESUME SUBCOMMAND HARD-ASSERTS (mirror the real clap rejection): under
// `exec resume`, the mock asserts it was NEVER passed --output-schema, -s/
// --sandbox, -C/--cd, --add-dir, or -p/--profile. If any appears it exits 64 with
// a clear stderr so a regression in buildResumeArgs fails loudly.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function has(name) {
  return argv.includes(name);
}

// Subcommand detection. The engine invokes either `exec ... ` (cold),
// `exec resume <id> ...` (warm), or `app-server` (opt-in JSON-RPC transport).
const isResume = argv[0] === "exec" && argv[1] === "resume";
const isAppServer = argv[0] === "app-server";

// For `exec resume`, the session id is the first non-flag positional after
// "resume" (buildResumeArgs places it right after the subcommand). The engine
// uses `-o` (not `--output-last-message`) for the resume last-message path.
function resumeSessionId() {
  // args: exec resume --json --skip-git-repo-check <id> -o <path> [...] -
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-o" || a === "--output-last-message") {
      i += 1; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

function sessionDir() {
  const d = process.env.MOCK_CODEX_SESSION_DIR;
  return d && d.trim() ? d.trim() : null;
}

function recordInvocation(extra) {
  const dir = sessionDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const subcommand = isAppServer ? "app-server" : isResume ? "resume" : "exec";
    const entry = { subcommand, argv, ...extra };
    fs.appendFileSync(path.join(dir, "invocations.log"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

const DEFAULT_RESPONSE = {
  summary: "mock summary",
  findings: [],
  recommended_actions: [],
  risks: [],
  verification: [],
  confidence: "high"
};

const DEFAULT_USAGE = {
  input_tokens: 10,
  cached_input_tokens: 2,
  output_tokens: 5,
  reasoning_output_tokens: 3
};

// Cross-process invocation counter. Each fresh spawn (retry, skeptic, resume)
// reads-increments-writes so tests can branch on "which call is this".
function nextInvocation() {
  const counterPath =
    process.env.MOCK_CODEX_COUNTER && process.env.MOCK_CODEX_COUNTER.trim()
      ? process.env.MOCK_CODEX_COUNTER.trim()
      : path.join(os.tmpdir(), "mock-codex-default-counter");
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(counterPath, "utf8"), 10);
    if (!Number.isInteger(n)) n = 0;
  } catch {
    n = 0;
  }
  try {
    fs.mkdirSync(path.dirname(counterPath), { recursive: true });
    fs.writeFileSync(counterPath, String(n + 1), "utf8");
  } catch {
    /* best effort */
  }
  return n;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function writeLine(line) {
  // Cold exec uses --output-last-message; warm resume uses -o (per buildResumeArgs).
  const lastMessagePath = flag("--output-last-message") || flag("-o");
  if (lastMessagePath) {
    fs.writeFileSync(lastMessagePath, line, "utf8");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cancellation support: when the engine aborts a run it sends SIGTERM (then a 5s
// SIGKILL). A test can assert cancellation reached the child by pointing
// MOCK_CODEX_SIGTERM_MARKER at a file the handler touches before exiting.
function installSigtermMarker() {
  const marker = process.env.MOCK_CODEX_SIGTERM_MARKER;
  const ignore = !!process.env.MOCK_CODEX_IGNORE_SIGTERM;
  if (!marker && !ignore) return;
  process.on("SIGTERM", () => {
    if (marker) {
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, `sigterm ${process.pid}`, "utf8");
      } catch {
        /* best effort */
      }
    }
    // When IGNORE is set, swallow SIGTERM so the engine's kill ladder must
    // escalate to SIGKILL (keeps the run in-flight long enough to test a second
    // SIGINT at the CLI level). Otherwise exit on the signal.
    if (!ignore) process.exit(143);
  });
}

// ---------------------------------------------------------------------------
// app-server transport (opt-in JSON-RPC over stdio).
//
// The engine's app-server-client spawns `codex app-server` and drives a bare
// JSON-RPC handshake (no top-level `jsonrpc` required on inbound). This mock
// mirrors the SPIKE-confirmed protocol:
//   initialize -> result {userAgent,...}
//   initialized (notification) -> ignored
//   thread/start -> result {thread:{id}}
//   turn/start -> result {turn:{id}}, then we stream:
//     item/started, item/agentMessage/delta (the response text in chunks),
//     item/completed, thread/tokenUsage/updated (camelCase breakdown),
//     turn/completed{turnId}
// We emit BARE objects (no `jsonrpc` field) to exercise the lenient framing.
//
// Env knobs (reused where sensible):
//   MOCK_CODEX_RESPONSE       streamed as the agentMessage text (default = a
//                             WORKER_SCHEMA-valid JSON object).
//   MOCK_CODEX_USAGE          camelCase OR snake_case usage; converted to the
//                             app-server camelCase TokenUsageBreakdown.
//   MOCK_APPSERVER_FAIL_INIT  if set, `initialize` returns a JSON-RPC error so
//                             the engine falls back to the exec path (or errors
//                             in strict mode).
//   MOCK_APPSERVER_NO_THREAD  if set, thread/start returns an empty result so the
//                             client rejects with "did not return a thread id".
//   MOCK_CODEX_SESSION_DIR    if set, the app-server invocation is recorded in
//                             invocations.log (subcommand:"app-server").
// ---------------------------------------------------------------------------
function toCamelUsage(usageRaw) {
  // Accept either snake_case (engine shape) or camelCase and produce the
  // app-server camelCase TokenUsageBreakdown.
  const pick = (camel, snake) => {
    if (typeof usageRaw[camel] === "number") return usageRaw[camel];
    if (typeof usageRaw[snake] === "number") return usageRaw[snake];
    return 0;
  };
  const inputTokens = pick("inputTokens", "input_tokens");
  const cachedInputTokens = pick("cachedInputTokens", "cached_input_tokens");
  const outputTokens = pick("outputTokens", "output_tokens");
  const reasoningOutputTokens = pick("reasoningOutputTokens", "reasoning_output_tokens");
  const totalTokens =
    typeof usageRaw.totalTokens === "number"
      ? usageRaw.totalTokens
      : typeof usageRaw.total_tokens === "number"
      ? usageRaw.total_tokens
      : inputTokens + outputTokens + reasoningOutputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function runAppServer() {
  recordInvocation({});
  const writeMsg = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const failInit = !!process.env.MOCK_APPSERVER_FAIL_INIT;
  const noThread = !!process.env.MOCK_APPSERVER_NO_THREAD;

  let usageRaw = DEFAULT_USAGE;
  if (process.env.MOCK_CODEX_USAGE && process.env.MOCK_CODEX_USAGE.trim()) {
    try {
      usageRaw = JSON.parse(process.env.MOCK_CODEX_USAGE);
    } catch {
      usageRaw = DEFAULT_USAGE;
    }
  }
  const responseText =
    typeof process.env.MOCK_CODEX_RESPONSE === "string"
      ? process.env.MOCK_CODEX_RESPONSE
      : JSON.stringify(DEFAULT_RESPONSE);

  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let newline;
    while ((newline = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, newline).trim();
      buf = buf.slice(newline + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handleRpc(msg);
    }
  });
  process.stdin.resume();

  function handleRpc(msg) {
    const method = msg.method;
    const id = msg.id;
    if (method === "initialize") {
      if (failInit) {
        // Emit a bare JSON-RPC error (no top-level jsonrpc field).
        writeMsg({ id, error: { code: -32601, message: "initialize unsupported (mock)" } });
        return;
      }
      writeMsg({
        id,
        result: {
          userAgent: "mock-codex-app-server/0.0.0",
          codexHome: process.env.CODEX_HOME || "",
          platformFamily: "unix",
          platformOs: "mock"
        }
      });
      // Proactive unsolicited notification, exactly like the real server.
      writeMsg({ method: "remoteControl/status/changed", params: { status: "disabled", environmentId: null } });
      return;
    }
    if (method === "initialized") {
      return; // notification, no response
    }
    if (method === "thread/start") {
      if (noThread) {
        writeMsg({ id, result: {} });
        return;
      }
      writeMsg({ id, result: { thread: { id: "th_appserver_mock_1" } } });
      return;
    }
    if (method === "turn/start") {
      const turnId = "turn_mock_1";
      writeMsg({ id, result: { turn: { id: turnId } } });
      // Stream the response as deltas, then usage, then completion.
      writeMsg({ method: "item/started", params: { itemId: "i1", threadId: "th_appserver_mock_1", turnId } });
      // Chunk the text into two deltas to exercise accumulation.
      const mid = Math.ceil(responseText.length / 2);
      writeMsg({
        method: "item/agentMessage/delta",
        params: { delta: responseText.slice(0, mid), itemId: "i1", turnId }
      });
      writeMsg({
        method: "item/agentMessage/delta",
        params: { delta: responseText.slice(mid), itemId: "i1", turnId }
      });
      writeMsg({ method: "item/completed", params: { itemId: "i1", turnId } });
      writeMsg({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "th_appserver_mock_1",
          turnId,
          tokenUsage: { last: toCamelUsage(usageRaw), total: toCamelUsage(usageRaw) }
        }
      });
      writeMsg({ method: "turn/completed", params: { threadId: "th_appserver_mock_1", turnId } });
      return;
    }
    // Unknown server-bound request: respond with an empty result so nothing hangs.
    if (id !== undefined && id !== null) {
      writeMsg({ id, result: {} });
    }
  }
}

async function main() {
  installSigtermMarker();
  if (isAppServer) {
    runAppServer();
    return;
  }
  // Drain stdin fully (the prompt) before doing anything. The engine does
  // child.stdin.end(prompt); exiting before reading risks an EPIPE race.
  await new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    // If stdin is already closed (no data), resolve on next tick.
    process.stdin.resume();
  });

  const invocation = nextInvocation();

  // -------------------------------------------------------------------------
  // Warm-context: `exec resume` subcommand.
  // -------------------------------------------------------------------------
  if (isResume) {
    // Hard-assert the resume arg set matches the real clap rejection: none of
    // these flags may appear under `exec resume`. A regression in buildResumeArgs
    // fails loudly here (exit 64) instead of silently passing.
    const forbidden = [
      "--output-schema",
      "-s",
      "--sandbox",
      "-C",
      "--cd",
      "--add-dir",
      "-p",
      "--profile"
    ].filter((f) => has(f));
    if (forbidden.length) {
      process.stderr.write(`mock-codex resume: unexpected argument(s) ${forbidden.join(", ")} found`);
      recordInvocation({ rejected: "forbidden-flag", forbidden });
      process.exit(64);
      return;
    }

    const sid = resumeSessionId();
    recordInvocation({ session_id: sid });

    const dir = sessionDir();
    const rolloutExists = dir && sid ? fs.existsSync(path.join(dir, `rollout-${sid}`)) : false;
    const reject = !!process.env.MOCK_CODEX_REJECT_RESUME || !rolloutExists;
    if (reject) {
      // Mirror the real CLI's detectable fallback signal (verified, code -32600).
      process.stderr.write(
        `Error: thread/resume: thread/resume failed: no rollout found for thread id ${sid} (code -32600)`
      );
      process.exit(1);
      return;
    }

    // A valid resume turn: emit thread.started (same id) + turn.completed, write
    // the last-message, succeed. Honors MOCK_CODEX_RESPONSE so schema-on-resume
    // tests can inject invalid-then-valid output via the counter.
    emit({ type: "thread.started", thread_id: sid });
    let resumeUsage = DEFAULT_USAGE;
    if (process.env.MOCK_CODEX_USAGE && process.env.MOCK_CODEX_USAGE.trim()) {
      try {
        resumeUsage = JSON.parse(process.env.MOCK_CODEX_USAGE);
      } catch {
        resumeUsage = DEFAULT_USAGE;
      }
    }
    let resumeLine;
    if (process.env.MOCK_CODEX_INVALID_FIRST && invocation === 0) {
      resumeLine = JSON.stringify({ summary: 123 });
    } else if (typeof process.env.MOCK_CODEX_RESPONSE === "string") {
      resumeLine = process.env.MOCK_CODEX_RESPONSE;
    } else {
      resumeLine = JSON.stringify(DEFAULT_RESPONSE);
    }
    writeLine(resumeLine);
    emit({ type: "turn.completed", usage: resumeUsage });
    process.stdout.write("", () => process.exit(0));
    return;
  }

  const threadPrefix =
    process.env.MOCK_CODEX_THREAD_PREFIX && process.env.MOCK_CODEX_THREAD_PREFIX.trim()
      ? process.env.MOCK_CODEX_THREAD_PREFIX.trim()
      : "th_mock";
  // Append a unique per-process suffix (pid + random) so concurrent persisted
  // base execs never collide on a thread_id even when they race on the shared
  // counter file. The `<prefix>_<n>` lead-in is preserved (tests match a prefix
  // regex and equality/inequality, never the exact suffix).
  const uniqueSuffix = `${process.pid}${Math.random().toString(16).slice(2, 8)}`;
  const threadId = `${threadPrefix}_${invocation}_${uniqueSuffix}`;

  // Record the invocation (cold). If this is a non-ephemeral (persisted) exec,
  // register its thread_id as a resumable rollout so a later `exec resume <id>`
  // can find it (the real CLI only persists a session when NOT --ephemeral).
  const ephemeral = has("--ephemeral");
  recordInvocation({ thread_id: threadId, ephemeral });
  if (!ephemeral) {
    const dir = sessionDir();
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `rollout-${threadId}`), threadId, "utf8");
      } catch {
        /* best effort */
      }
    }
  }

  let usage = DEFAULT_USAGE;
  if (process.env.MOCK_CODEX_USAGE && process.env.MOCK_CODEX_USAGE.trim()) {
    try {
      usage = JSON.parse(process.env.MOCK_CODEX_USAGE);
    } catch {
      usage = DEFAULT_USAGE;
    }
  }

  // thread.started first — the engine reads thread_id from it.
  emit({ type: "thread.started", thread_id: threadId });

  const sleepMs = Number(process.env.MOCK_CODEX_SLEEP_MS || 0);
  if (Number.isFinite(sleepMs) && sleepMs > 0) await sleep(sleepMs);

  // Decide the response body.
  let responseLine;
  if (process.env.MOCK_CODEX_INVALID_FIRST && invocation === 0) {
    // Deliberately invalid against WORKER_SCHEMA (wrong type on summary).
    responseLine = JSON.stringify({ summary: 123 });
  } else if (typeof process.env.MOCK_CODEX_ALT_RESPONSE === "string" && invocation % 2 === 1) {
    // Odd invocation in alternation mode.
    responseLine = process.env.MOCK_CODEX_ALT_RESPONSE;
  } else if (typeof process.env.MOCK_CODEX_RESPONSE === "string") {
    // Written verbatim — may be raw text, invalid JSON, etc.
    responseLine = process.env.MOCK_CODEX_RESPONSE;
  } else {
    responseLine = JSON.stringify(DEFAULT_RESPONSE);
  }
  writeLine(responseLine);

  // Usage event is emitted before exit so it is accounted even on failure.
  emit({ type: "turn.completed", usage });

  // A specific invocation may be forced to fail (for partial-status tests),
  // independent of the global MOCK_CODEX_EXIT.
  let forcedFail = false;
  if (process.env.MOCK_CODEX_FAIL_ON_INVOCATION) {
    const failSet = new Set(
      process.env.MOCK_CODEX_FAIL_ON_INVOCATION.split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n))
    );
    if (failSet.has(invocation)) forcedFail = true;
  }

  // Transient-retry driver: the first N invocations (0-indexed by the counter
  // file) fail with a non-zero exit + MOCK_CODEX_STDERR; the (N+1)th and beyond
  // succeed. Drives retry-then-succeed deterministically with no real network.
  const failTimes = Number(process.env.MOCK_CODEX_FAIL_TIMES || 0);
  const failingNow = Number.isFinite(failTimes) && failTimes > 0 && invocation < failTimes;

  if (process.env.MOCK_CODEX_STDERR || forcedFail || failingNow) {
    process.stderr.write(process.env.MOCK_CODEX_STDERR || `mock-codex: forced failure on invocation ${invocation}`);
  }

  let exitCode;
  if (forcedFail) {
    exitCode = 9;
  } else if (failingNow) {
    // Use the configured failure exit if any (so the stderr pattern + exit both
    // look like a real transient error), else default to 1.
    exitCode = Number(process.env.MOCK_CODEX_EXIT || 1) || 1;
  } else if (Number.isFinite(failTimes) && failTimes > 0) {
    // In FAIL_TIMES mode, invocations past the failure window always succeed
    // (exit 0), regardless of MOCK_CODEX_EXIT which only shapes the failing ones.
    exitCode = 0;
  } else {
    exitCode = Number(process.env.MOCK_CODEX_EXIT || 0);
  }
  // Flush stdout before exiting so the engine sees every JSONL line.
  process.stdout.write("", () => {
    process.exit(Number.isInteger(exitCode) ? exitCode : 0);
  });
}

main();
