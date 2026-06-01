#!/usr/bin/env node
"use strict";

const engine = require("./ultracode-engine");

const NUMERIC_KEYS = new Set(["workers", "timeout_ms", "concurrency", "budget_tokens", "max_agents"]);
const JSON_KEYS = new Set(["workers_spec", "force_steps"]);

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  coerce(options);
  let result;
  if (command === "plan") {
    result = engine.planWorkflow(options);
  } else if (command === "run") {
    result = await engine.runWorkflow(options);
  } else if (command === "resume") {
    result = await engine.resumeWorkflow(options);
  } else if (command === "status") {
    result = await engine.readWorkflow(options);
  } else {
    throw new Error(`Unknown command: ${command} (expected plan|run|resume|status)`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
