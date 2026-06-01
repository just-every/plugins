#!/usr/bin/env node
"use strict";

const engine = require("./ultracode-engine");
// Require the runner DIRECTLY (not via engine) to keep the script contract
// clean and cycle-free (the runner requires the engine; the engine never
// top-level-requires the runner).
const scriptRunner = require("./ultracode-script-runner");

const NUMERIC_KEYS = new Set([
  "workers",
  "timeout_ms",
  "concurrency",
  "budget_tokens",
  "max_agents",
  "max_retries",
  "base_delay_ms",
  "max_delay_ms"
]);
const JSON_KEYS = new Set(["workers_spec", "force_steps", "steps", "args"]);

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};
  let index = 0;
  // A single leading positional (before any --flag) is collected as
  // options._positional. Existing commands never pass one, so their parse is
  // byte-identical; the `script` command maps it to a script `path`.
  if (rest.length > 0 && !rest[0].startsWith("--")) {
    options._positional = rest[0];
    index = 1;
  }
  for (; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-/g, "_");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function coerce(options) {
  for (const key of NUMERIC_KEYS) {
    if (typeof options[key] === "string") {
      const number = Number(options[key]);
      if (Number.isFinite(number)) options[key] = number;
    }
  }
  for (const key of JSON_KEYS) {
    if (typeof options[key] === "string") {
      try {
        options[key] = JSON.parse(options[key]);
      } catch (error) {
        throw new Error(`--${key} must be valid JSON: ${error.message}`);
      }
    }
  }
  if (options.progress) {
    options.on_event = (event) => {
      process.stderr.write(`[ultracode] ${event.type}${event.label ? ` ${event.label}` : ""}${event.message ? ` ${event.message}` : ""}\n`);
    };
    delete options.progress;
  }
  return options;
}

// Run an engine call that supports cancellation, wiring a one-shot SIGINT
// handler that aborts the in-flight run on the first Ctrl-C (the engine then
// returns the partially-completed, persisted workflow which main() prints) and
// hard-exits 130 on a second SIGINT. The handler is scoped to the awaited call
// and removed afterwards so it never swallows Ctrl-C for plan/status. Opt out
// with --no-cancel-on-sigint.
async function runCancellable(fn, options) {
  if (options.no_cancel_on_sigint || process.env.ULTRACODE_NO_SIGINT) {
    return fn(options);
  }
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write("\n[ultracode] cancelling run (Ctrl-C again to force quit)...\n");
      controller.abort("SIGINT");
    } else {
      process.stderr.write("\n[ultracode] force quit.\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    return await fn({ ...options, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  coerce(options);
  let result;
  if (command === "plan") {
    result = engine.planWorkflow(options);
  } else if (command === "run") {
    result = await runCancellable(engine.runWorkflow, options);
  } else if (command === "pipeline") {
    result = await runCancellable(engine.runPipelineSpec, options);
  } else if (command === "resume") {
    result = await runCancellable(engine.resumeWorkflow, options);
  } else if (command === "status") {
    result = await engine.readWorkflow(options);
  } else if (command === "script") {
    // `script` runs an imperative workflow script. SECURITY: this executes
    // ARBITRARY Node.js in-process with full host privileges and is NOT
    // sandboxed — only run scripts you trust (same trust as `node <file>`).
    // Accept a positional <path>, or --path / --source (--args is JSON).
    if (options._positional !== undefined && options.path === undefined) {
      options.path = options._positional;
    }
    delete options._positional;
    result = await runCancellable(scriptRunner.runScript, options);
  } else {
    throw new Error(`Unknown command: ${command} (expected plan|run|pipeline|resume|status|script)`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
