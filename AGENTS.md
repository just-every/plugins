# Ultracode Repository Guide

This repository is a Codex CLI plugin that gives Codex a parallel worker orchestration layer. Ultracode fans out real `codex exec` subprocesses for deep code investigation, planning, and review, then returns structured results to the parent Codex thread where the final synthesis and edits happen.

The plugin is designed to bring Claude Workflow-style orchestration primitives to Codex: arbitrary worker prompts, JSON schema validation, concurrency limits, budget tracking, progress events, journaled resume, `parallel`, `pipeline`, loop-until-dry checks, adversarial verification, and optional git worktree isolation.

## Main Components

- `.codex-plugin/plugin.json` declares the plugin metadata, skills, MCP server, hooks, and launcher.
- `scripts/ultracode-engine.js` is the core orchestration engine. It owns worker spawning, schema validation, concurrency, usage accounting, persisted workflow state, resume, and exported scripted primitives.
- `mcp/server.js` is a dependency-free MCP stdio server exposing `ultracode_plan`, `ultracode_run`, `ultracode_resume`, and `ultracode_status`.
- `scripts/ultracode-cli.js` is a CLI wrapper over the same engine with `plan`, `run`, `resume`, and `status` commands.
- `scripts/run-node-tool.sh` resolves the local Node and Codex binaries for MCP and hook execution.
- `hooks/` contains the prompt hook that injects Ultracode guidance when a prompt mentions Ultracode.
- `skills/ultracode/SKILL.md` is the model-facing usage guide for when and how to invoke Ultracode.
- `README.md` is the human-facing overview, parity matrix, and usage reference.

## Runtime Behavior

Ultracode workers are real Codex subprocesses, not mocked agents. Worker output is schema-validated when a schema is provided, usage is aggregated from Codex JSON events, and workflow state is written under `$CODEX_HOME/ultracode/runs/`.

Temporary schemas, last-message files, and isolated worktrees are created under the OS temp directory. They should not create tracked files in this repository.

## Development Notes

- Keep the engine dependency-free unless there is a strong reason to change that.
- Preserve the existing MCP and CLI contracts when adding new orchestration features.
- Prefer explicit failures and logged events over silent fallbacks.
- Keep worker execution parallel by default; add throttling only when limits have been measured.
- Do not commit local `.claude/` files or `.DS_Store`.
