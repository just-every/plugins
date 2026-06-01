#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// Dependency-free Codex app-server JSON-RPC client (OPT-IN transport).
//
// The default Ultracode worker transport shells `codex exec --json` and scrapes
// JSONL events (see scripts/ultracode-engine.js spawnCodex/parseUsage). This
// module is an ALTERNATIVE transport, selected only when a worker opts into
// transport:'app-server'. It spawns `codex app-server` once per worker, drives
// the versioned JSON-RPC handshake over stdio, runs a single turn, and returns
// the SAME { execResult, value } contract runCodexAttempt() returns — so every
// downstream consumer (usage accounting, schema retries, worktree isolation,
// persistence) is untouched.
//
// SPIKE-CONFIRMED PROTOCOL NOTES (codex-cli 0.130.0, no API cost on handshake):
//   * The server emits BARE JSON-RPC objects WITHOUT a top-level `jsonrpc`
//     field. A strict client would reject them. We frame leniently: a message is
//     a RESULT/ERROR if it has an `id` + (`result`|`error`), a NOTIFICATION if it
//     has a `method` and no `id`, a SERVER REQUEST if it has a `method` AND an
//     `id`. We never require `jsonrpc`.
//   * Framing is newline-delimited JSON (one object per line) on stdout.
//   * The server proactively emits unsolicited notifications (e.g.
//     remoteControl/status/changed) before/after our handshake — these are
//     ignored unless they belong to our active turn.
//   * Handshake: initialize -> (wait result) -> `initialized` notification ->
//     thread/start -> capture threadId -> turn/start -> consume notifications
//     until turn/completed for our turnId (or an error).
//   * approvalPolicy is forced to 'never' so the server never sends an approval
//     request back (execCommandApproval/applyPatchApproval/...).
//
// COST SAFETY: only initialize + thread/start are free; turn/start makes a REAL
// model call. Tests MUST point `bin` at a mock app-server, never the real CLI.
// ---------------------------------------------------------------------------

const childProcess = require("child_process");

// Normalize the app-server's camelCase TokenUsageBreakdown into the engine's
// snake_case USAGE_KEYS shape (input_tokens/cached_input_tokens/output_tokens/
// reasoning_output_tokens). The engine recomputes total_tokens itself, but we
// pass it through when present for parity with the exec-path usage object.
function normalizeUsage(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(breakdown.inputTokens),
    cached_input_tokens: num(breakdown.cachedInputTokens),
    output_tokens: num(breakdown.outputTokens),
    reasoning_output_tokens: num(breakdown.reasoningOutputTokens),
    total_tokens: num(breakdown.totalTokens)
  };
}

// Lenient JSON-RPC message classification (see header). Returns one of
// 'result' | 'error' | 'notification' | 'request' | 'unknown'.
function classifyMessage(msg) {
  if (!msg || typeof msg !== "object") return "unknown";
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null && msg.id !== undefined;
  const hasMethod = typeof msg.method === "string";
  if (hasId && hasMethod) return "request";
  if (hasId && Object.prototype.hasOwnProperty.call(msg, "error")) return "error";
  if (hasId && Object.prototype.hasOwnProperty.call(msg, "result")) return "result";
  if (hasMethod) return "notification";
  return "unknown";
}

// A small newline-delimited JSON-RPC peer over a child process's stdio.
// Pending requests are keyed by integer id. Notifications fan out to a single
// handler. Errors on the wire / process exit settle all in-flight requests.
class AppServerConnection {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map(); // id -> { resolve, reject }
    this.onNotification = null;
    this.onServerRequest = null;
    this.lineBuf = "";
    this.stderr = "";
    this.closed = false;
    this.closeError = null;

    child.stdout.on("data", (chunk) => this._onStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => this._fail(error));
    child.on("close", (code, signal) => {
      this.closed = true;
      const err =
        this.closeError ||
        new Error(
          `codex app-server exited (code ${code}${signal ? `, signal ${signal}` : ""})` +
            (this.stderr.trim() ? `: ${this.stderr.trim()}` : "")
        );
      // Reject any still-pending requests so callers never hang.
      for (const [, pendingEntry] of this.pending) pendingEntry.reject(err);
      this.pending.clear();
    });
    // Never let an stdin EPIPE crash the host (the child may exit early).
    child.stdin.on("error", () => {});
  }

  _onStdout(text) {
    this.lineBuf += text;
    let newline;
    while ((newline = this.lineBuf.indexOf("\n")) !== -1) {
      const line = this.lineBuf.slice(0, newline);
      this.lineBuf = this.lineBuf.slice(newline + 1);
      this._processLine(line);
    }
  }

  _processLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise (banners etc.) is ignored
    }
    const kind = classifyMessage(msg);
    if (kind === "result" || kind === "error") {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // stray / duplicate response
      this.pending.delete(msg.id);
      if (kind === "error") {
        const e = msg.error || {};
        const err = new Error(`app-server error: ${e.message || JSON.stringify(e)}`);
        err.rpcError = e;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (kind === "request") {
      if (this.onServerRequest) {
        try {
          this.onServerRequest(msg);
        } catch {
          /* a server-request handler error must never break the run */
        }
      }
      return;
    }
    if (kind === "notification") {
      if (this.onNotification) {
        try {
          this.onNotification(msg);
        } catch {
          /* ignore notification handler errors */
        }
      }
    }
  }

  _fail(error) {
    this.closeError = error;
  }

  // Fire-and-forget JSON-RPC notification (no id, no response expected).
  notify(method, params) {
    if (this.closed) return;
    this._write({ jsonrpc: "2.0", method, params: params || {} });
  }

  // JSON-RPC request -> Promise of its result. We still SEND a `jsonrpc` field
  // (harmless, spec-compliant); we just do not REQUIRE it on inbound messages.
  request(method, params) {
    if (this.closed) {
      return Promise.reject(this.closeError || new Error("codex app-server connection closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params: params || {} });
    });
  }

  _write(obj) {
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* child gone; pending requests settle via the close handler */
    }
  }

  kill(signal) {
    try {
      this.child.kill(signal || "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// Pull the thread id out of a ThreadStartResponse, tolerating either a bare
// string `thread` or a `{ thread: { id } }` object (the schema marks `thread`
// required; the spike showed it can be either an id string or a thread object).
function extractThreadId(result) {
  if (!result || typeof result !== "object") return null;
  const t = result.thread;
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof t.id === "string") return t.id;
  if (typeof result.threadId === "string") return result.threadId;
  return null;
}

// Pull a turn id out of a TurnStartResponse (analogous tolerance).
function extractTurnId(result) {
  if (!result || typeof result !== "object") return null;
  const t = result.turn;
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof t.id === "string") return t.id;
  if (typeof result.turnId === "string") return result.turnId;
  return null;
}

// Run a single worker turn over a freshly-spawned `codex app-server`.
//
// opts mirrors the resolveWorkerOpts shape used by the exec path: bin, cwd, env,
// sandbox, model, reasoningEffort, baseInstructions(optional), timeoutMs, signal.
// onStreamEvent (optional) receives engine-vocabulary events ('turn.completed'
// carrying usage, plus item.* progress) so usage accounting stays identical.
//
// Resolves with { execResult, value }:
//   execResult = { exit_code, thread_id, usage, stdout, stderr, duration_ms,
//                  timed_out, cancelled, transport:'app-server' }
//   value      = the accumulated assistant message text (engine then JSON.parses
//                it when a schema is set, or trims it for raw-text workers — the
//                SAME post-processing runCodexAttempt does for the exec path).
//
// Rejects (with err.codex_exec attached when possible) on initialize failure,
// unsupported method, protocol error, server error notification, timeout, or
// abort — so the engine's runCodexAttempt wrapper can transparently fall back to
// the exec path (or surface the error in strict mode).
function runAppServerTurn({ prompt, schema, opts, onStreamEvent, abortError }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const env = opts.env || process.env;
    const signal = opts.signal || null;

    if (signal && signal.aborted) {
      reject(abortError ? abortError(signal) : new Error("cancelled before app-server start"));
      return;
    }

    let child;
    try {
      child = childProcess.spawn(opts.bin, ["app-server"], {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    const conn = new AppServerConnection(child);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let assistantText = "";
    let lastUsage = null;
    let threadId = null;
    let timer = null;
    let killTimer = null;
    let abortListener = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    };

    const buildExecResult = (exitCodeOverride) => ({
      pid: child.pid || null,
      exit_code: exitCodeOverride === undefined ? (cancelled || timedOut ? null : 0) : exitCodeOverride,
      signal: null,
      timed_out: timedOut,
      cancelled,
      duration_ms: Date.now() - startedAt,
      thread_id: threadId,
      usage: lastUsage,
      stdout: "",
      stderr: conn.stderr,
      transport: "app-server"
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      conn.kill("SIGTERM");
      resolve({ execResult: buildExecResult(0), value: assistantText });
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      conn.kill("SIGTERM");
      if (error && !error.codex_exec) error.codex_exec = buildExecResult(cancelled || timedOut ? null : 1);
      if (cancelled && error) error.cancelled = true;
      reject(error);
    };

    // Wall-clock timeout: reuse the exec path's semantics (kill the server).
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      conn.kill("SIGTERM");
      killTimer = setTimeout(() => conn.kill("SIGKILL"), 5_000);
      settleReject(new Error(`Codex app-server worker timed out after ${opts.timeoutMs}ms.`));
    }, opts.timeoutMs);

    if (signal) {
      abortListener = () => {
        if (settled) return;
        cancelled = true;
        conn.kill("SIGTERM");
        killTimer = setTimeout(() => conn.kill("SIGKILL"), 5_000);
        settleReject(abortError ? abortError(signal) : new Error("cancelled"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    // Auto-deny any approval request from the server (we set approvalPolicy=never,
    // so this should not fire — but be defensive so the run never deadlocks).
    conn.onServerRequest = (msg) => {
      conn._write({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } });
    };

    let activeTurnId = null;
    conn.onNotification = (msg) => {
      if (settled) return;
      const method = msg.method;
      const params = msg.params || {};
      switch (method) {
        case "item/agentMessage/delta":
          if (typeof params.delta === "string") assistantText += params.delta;
          break;
        case "thread/tokenUsage/updated": {
          const usageObj = params.tokenUsage || params.usage || {};
          // Prefer the cumulative `total` breakdown; fall back to `last`.
          const normalized = normalizeUsage(usageObj.total) || normalizeUsage(usageObj.last);
          if (normalized) {
            lastUsage = normalized;
            if (onStreamEvent) {
              try {
                onStreamEvent({ type: "turn.completed", usage: normalized });
              } catch {
                /* ignore */
              }
            }
          }
          break;
        }
        case "item/started":
        case "item/completed":
          if (onStreamEvent) {
            try {
              onStreamEvent({ type: method === "item/started" ? "item.started" : "item.completed" });
            } catch {
              /* ignore */
            }
          }
          break;
        case "turn/completed":
          if (params.turnId === undefined || activeTurnId === null || params.turnId === activeTurnId) {
            settleResolve();
          }
          break;
        case "error":
          settleReject(new Error(`app-server error notification: ${params.message || JSON.stringify(params)}`));
          break;
        default:
          break;
      }
    };

    // Drive the handshake. Any rejection here is surfaced (and the engine can
    // fall back to the exec path).
    (async () => {
      const initResult = await conn.request("initialize", {
        clientInfo: { name: "ultracode", version: "0.1.0" },
        capabilities: {}
      });
      if (settled) return;
      // Version-gate: a usable initialize response is an object. Anything else
      // is treated as an unsupported/incompatible server -> reject -> fallback.
      if (!initResult || typeof initResult !== "object") {
        throw new Error("app-server initialize returned an unexpected result.");
      }
      conn.notify("initialized", {});

      const threadConfig = {};
      if (opts.reasoningEffort) threadConfig.model_reasoning_effort = opts.reasoningEffort;
      const startParams = {
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: opts.sandbox,
        config: threadConfig
      };
      if (opts.model) startParams.model = opts.model;
      if (opts.baseInstructions) startParams.baseInstructions = opts.baseInstructions;

      const threadResult = await conn.request("thread/start", startParams);
      if (settled) return;
      threadId = extractThreadId(threadResult);
      if (!threadId) {
        throw new Error("app-server thread/start did not return a thread id.");
      }

      // The resume subcommand of exec rejects --output-schema; the app-server has
      // no documented stable output-schema knob either, so we keep schema
      // enforcement out-of-band: embed the schema in the prompt text and let the
      // engine's existing validateAgainstSchema + retry loop enforce it.
      const turnText = schema ? embedSchema(prompt, schema) : prompt;
      const turnParams = {
        threadId,
        input: [{ type: "text", text: turnText }],
        cwd: opts.cwd
      };
      if (opts.reasoningEffort) turnParams.effort = opts.reasoningEffort;

      const turnResult = await conn.request("turn/start", turnParams);
      if (settled) return;
      activeTurnId = extractTurnId(turnResult);
      // From here, turn/completed (matched by activeTurnId, or unkeyed) resolves.
    })().catch((error) => {
      settleReject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

// Embed a JSON schema into the worker prompt for app-server turns (the
// transport has no stable --output-schema equivalent; schema is enforced
// post-hoc by validateAgainstSchema). Mirrors injectSchemaIntoPrompt in the
// engine but kept local so this module stays dependency-free of the engine.
function embedSchema(prompt, schema) {
  if (!schema) return prompt;
  return [
    prompt,
    "",
    "Your final response MUST be a single JSON object that satisfies this JSON schema exactly (no prose, no code fences):",
    JSON.stringify(schema, null, 2)
  ].join("\n");
}

module.exports = {
  runAppServerTurn,
  // Exported for unit tests of the pure pieces (no subprocess required).
  _internal: {
    normalizeUsage,
    classifyMessage,
    extractThreadId,
    extractTurnId,
    embedSchema,
    AppServerConnection
  }
};
