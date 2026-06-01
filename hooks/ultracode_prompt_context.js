#!/usr/bin/env node
"use strict";

const fs = require("fs");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function main() {
  if (process.env.ULTRACODE_CHILD === "1") {
    return;
  }

  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!/\bultracode\b/i.test(prompt)) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "Ultracode is available in this thread. If ultracode MCP tools are not directly visible, call tool_search for ultracode_run or ultracode first, then use the exposed MCP tools. Plan first when useful, run read-only workers by default, then synthesize and implement in the parent thread so important edits remain visible. If tool_search cannot find Ultracode, report a plugin/tool refresh problem instead of imitating a run manually."
      }
    })
  );
}

main();
