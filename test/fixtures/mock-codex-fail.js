#!/usr/bin/env node
"use strict";

// A deliberately-failing mock `codex` binary. It drains stdin (so the engine's
// stdin.end(prompt) never EPIPEs), emits the usual JSONL events so usage is
// still accounted, then exits non-zero with a clean stderr message. Used by the
// workflow "partial status" test where one worker spec must fail while the
// others (driven by mock-codex.js) succeed.

const fs = require("fs");

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
});
process.stdin.on("error", () => {});
process.stdin.on("end", () => {
  emit({ type: "thread.started", thread_id: "th_fail_0" });

  const lastMessagePath = flag("--output-last-message");
  if (lastMessagePath) {
    // Write a valid body anyway; the non-zero exit is what fails the worker.
    fs.writeFileSync(
      lastMessagePath,
      JSON.stringify({
        summary: "fail",
        findings: [],
        recommended_actions: [],
        risks: [],
        verification: [],
        confidence: "low"
      }),
      "utf8"
    );
  }

  emit({
    type: "turn.completed",
    usage: { input_tokens: 7, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 }
  });

  process.stderr.write("mock-codex-fail: intentional failure");
  process.stdout.write("", () => process.exit(2));
});
process.stdin.resume();
