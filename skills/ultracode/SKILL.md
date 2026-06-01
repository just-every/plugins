---
name: ultracode
description: Use when the user asks for Ultracode, deep parallel code investigation, multiple Codex worker passes, fan-out/fan-in analysis, subprocess-backed code review, or a Claude-style under-the-surface workflow in Codex.
---

# Ultracode

Use Ultracode when the user wants deeper-than-usual code work with parallel worker passes.

## Workflow

1. Use the `ultracode` MCP tools when they are available.
2. If `ultracode_plan`, `ultracode_run`, or `ultracode_status` are not directly visible, call `tool_search` with `ultracode_run` or `ultracode` to expose them for the next model step.
3. Prefer `ultracode_run` for a bounded fan-out/fan-in pass.
4. Keep workers read-only unless the user explicitly asks for writable child Codex runs.
5. Treat worker failures as real failures. Do not replace them with guessed output.
6. If the skill is visible but `tool_search` cannot find Ultracode, stop and report that the current thread needs the plugin tools refreshed; do not imitate an Ultracode run manually.
7. Synthesize worker results in the parent Codex thread, then perform any edits yourself so the app/TUI keeps the meaningful implementation visible.
8. If the task is small, skip Ultracode and work directly.

## Tool Guidance

- `ultracode_plan`: produce the worker plan without running subprocesses.
- `ultracode_run`: run Codex subprocess workers in parallel and return structured findings.
- `ultracode_status`: inspect the latest persisted workflow state or a specific workflow id.

Useful `ultracode_run` arguments:

- `task`: required natural-language objective.
- `cwd`: repository or workspace path. Use the current working directory when possible.
- `workers`: 1-8. Use 3 for normal deep work, 5-6 for broad audits.
- `model`: optional Codex model for child workers.
- `reasoning_effort`: optional `low`, `medium`, `high`, or `xhigh`.
- `sandbox`: default `read-only`. Use `workspace-write` or `danger-full-access` only when the user explicitly wants child workers to modify files.

## Parent Responsibilities

After `ultracode_run` returns:

- Read every worker result, including failures and low-confidence notes.
- Merge duplicate findings.
- Prefer concrete file/path evidence over generic recommendations.
- Implement changes in the parent thread when edits are needed.
- Run normal verification after applying changes.

## Limits

Ultracode subprocesses do not render as native Codex app/TUI sub-agents. The MCP tool result is the visible bridge back into the parent thread.
