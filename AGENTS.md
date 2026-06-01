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

By default every worker is a fresh, ephemeral `codex exec` (no session persisted). An opt-in warm executor keeps a Codex session warm across turns via `codex exec resume <session_id>`: `spawnWarmWorker(initialPrompt, opts)` returns a `{ sessionId, result, turn(prompt) }` handle, and `runPipeline(items, stages, { warm: true })` reuses one warm session per item across stages (warm reuse is per item; cross-item fan-out stays parallel). The pipeline DAG (`ultracode_pipeline` / `pipeline`) takes an `executor` (`cold` | `resume` | `fork`) at the top level and per step. Warm context is a pure latency/cost optimization: a resume turn the CLI cannot honor (unknown/expired rollout via `no rollout found for thread id`, non-zero exit, or missing last-message) transparently falls back to the identical cold `codex exec` and logs `resume-fallback`. The `resume` subcommand rejects `--output-schema`/`-s`/`-C`/`--add-dir`/`-p`, so schema is enforced via prompt-injection + the existing post-hoc validation/retry and sandbox/cwd are inherited from the original persisted session. `executor: 'fork'` is a documented stub: `codex fork` is interactive-TUI-only, so it logs `fork-unsupported` and runs cold. With nothing opted in, the cold fan-out (still `--ephemeral`) is byte-for-byte unchanged.

The worker **transport** is independently opt-in. `transport: 'exec'` (default; also `ULTRACODE_TRANSPORT` env) is today's `codex exec --json` JSONL scraping, unchanged. `transport: 'app-server'` instead spawns the versioned `codex app-server` JSON-RPC server (`scripts/app-server-client.js`), drives `initialize -> initialized -> thread/start -> turn/start`, accumulates `item/agentMessage/delta` text, and normalizes the camelCase `thread/tokenUsage/updated` breakdown into the engine's snake_case usage shape — returning the same `{ execResult, value }` contract so usage accounting, schema retries, worktree isolation, and persistence are untouched. The app-server emits BARE JSON-RPC objects (no top-level `jsonrpc` field), so the client frames leniently. Any app-server failure (initialize/protocol/timeout) transparently falls back to the exec path and emits a `worker.transport_fallback` event, unless `transport_strict: true`. `transport: 'exec-server'` is reserved and throws an explicit not-implemented error (the client seam is generic enough to host it later). The transport is journaled into `workflow.options` only when non-default, so a plain run's options object is byte-identical to before.

`mcp/server.js` honors MCP progress: when a `tools/call` for `ultracode_run` / `ultracode_pipeline` supplies `params._meta.progressToken`, the server builds an `on_event` sink that emits `notifications/progress` `{ progressToken, progress, message }` on the same connection (with a monotonically increasing `progress` integer, `total` omitted) until the final result. Absent the token, no `on_event` is wired and behavior is identical to before.

## Development Notes

- Keep the engine dependency-free unless there is a strong reason to change that.
- Preserve the existing MCP and CLI contracts when adding new orchestration features.
- Prefer explicit failures and logged events over silent fallbacks.
- Keep worker execution parallel by default; add throttling only when limits have been measured.
- Do not commit local `.claude/` files or `.DS_Store`.
