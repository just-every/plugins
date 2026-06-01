---
name: ultracode
description: Use when the user asks for Ultracode, deep parallel code investigation, multiple Codex worker passes, fan-out/fan-in analysis, subprocess-backed code review, multi-stage pipelines, budgeted/concurrency-capped worker runs, or a Claude-style under-the-surface workflow in Codex.
---

# Ultracode

Use Ultracode when the user wants deeper-than-usual code work with parallel worker passes. Ultracode gives
Codex an orchestration engine that mirrors the primitives of Claude Code's Workflow tool — `spawnWorker`
(agent), `runParallel` (barrier), `runPipeline` (barrier-free stages), schema-validated structured output,
a shared concurrency cap, token-budget gating, progress events, journaled resume, and quality helpers — all
driven by `codex exec` subprocesses.

## Workflow

1. Use the `ultracode` MCP tools when they are available.
2. If `ultracode_plan`, `ultracode_run`, `ultracode_resume`, or `ultracode_status` are not directly visible,
   call `tool_search` with `ultracode_run` or `ultracode` to expose them for the next model step.
3. Prefer `ultracode_run` for a bounded fan-out/fan-in pass.
4. Keep workers read-only unless the user explicitly asks for writable child Codex runs.
5. Treat worker failures as real failures. Do not replace them with guessed output.
6. If the skill is visible but `tool_search` cannot find Ultracode, stop and report that the current thread
   needs the plugin tools refreshed; do not imitate an Ultracode run manually.
7. Synthesize worker results in the parent Codex thread, then perform any edits yourself so the app/TUI keeps
   the meaningful implementation visible.
8. If the task is small, skip Ultracode and work directly.

## MCP Tools

- `ultracode_plan`: produce the worker plan without running subprocesses.
- `ultracode_run`: run Codex subprocess workers in parallel and return structured findings.
- `ultracode_resume`: resume a persisted workflow — completed steps are reused from the journal, only
  missing/failed/forced steps re-run.
- `ultracode_status`: inspect the latest persisted workflow state (now journaled, so it reflects mid-flight
  progress) or a specific workflow id.

### `ultracode_run` arguments

Default fixed-role fan-out:

- `task`: natural-language objective (required unless `workers_spec` is given).
- `cwd`: repository or workspace path. Use the current working directory when possible.
- `workers`: 1-8. Use 3 for normal deep work, 5-6 for broad audits.
- `model`: optional Codex model for child workers.
- `reasoning_effort`: optional `low`, `medium`, `high`, or `xhigh`.
- `sandbox`: default `read-only`. Use `workspace-write` or `danger-full-access` only when the user explicitly
  wants child workers to modify files.

Orchestration controls (all optional, all backward-compatible):

- `concurrency`: max simultaneous Codex subprocesses. Defaults to `min(16, cores-2)`.
- `budget_tokens`: best-effort total token budget — a pre-spawn gate checked when a worker is admitted, with
  usage accounted after each worker completes. New workers are skipped (and the cap logged) once exceeded, but
  with concurrency N up to N in-flight workers may still finish past the budget. It is a soft cap, not a hard
  per-token kill switch.
- `max_agents`: lifetime cap on spawned workers for the run (default 1000).

Arbitrary per-worker fan-out (the `agent()` parity path) — `workers_spec`: an array of worker specs that
replaces the fixed roles. Each spec:

- `prompt` (required): the worker's full instructions.
- `label`: display label used in progress and aggregation.
- `schema`: a JSON Schema object for this worker's output. Omit for the default structured schema; pass
  `null` for raw free-text output.
- `sandbox`, `model`, `reasoning_effort`, `phase`, `timeout_ms`, `cwd`: per-worker overrides.
- `isolation: "worktree"`: run a writable worker in an isolated git worktree (its diff is collected back).

### `ultracode_resume` arguments

- `workflow_id` (or `state_path`): the run to resume.
- `force_steps`: array of step ids / role ids / indices to re-run even if already completed.

## Engine primitives (for scripted orchestration)

`scripts/ultracode-engine.js` exports composable primitives, faithful to the Workflow tool, for callers that
drive Ultracode from Node (`node -e`, CLI, or another script). All share one `ctx` (concurrency limiter,
usage accumulator, `budget`, lifetime cap, progress sink) from `createContext(opts)`:

- `spawnWorker(prompt, opts)` → one `codex exec` worker; returns `{status, value, usage, ...}`. With
  `opts.schema` it validates and retries on mismatch; with `schema: null` it returns raw text. Never throws.
- `runParallel(thunks, {ctx})` → barrier gather; a throwing thunk degrades to `null` (logged).
- `runPipeline(items, stages, {ctx})` → barrier-free multi-stage streaming; each item flows through all
  stages independently; a throwing stage drops that item to `null`.
- `loopUntilDry(makePrompt, {schema, dryRounds, ctx})` → keep spawning finders until K dry rounds / budget /
  lifetime cap.
- `adversarialVerify(findings, {skeptics, lenses, ctx})` → keep only findings that survive a majority refute
  vote from N skeptic workers (optionally with distinct lenses).
- `validateAgainstSchema`, `createLimiter`, `sumUsageFromWorkers`, `log` are also exported.

CLI: `node scripts/ultracode-cli.js {plan|run|resume|status} [--flags]`. Add `--progress` to stream events to
stderr. `--workers-spec '<json>'` and `--force-steps '<json>'` accept JSON; numeric flags are coerced.

## Parent Responsibilities

After `ultracode_run` returns:

- Read every worker result, including failures and low-confidence notes.
- Merge duplicate findings.
- Prefer concrete file/path evidence over generic recommendations.
- Implement changes in the parent thread when edits are needed.
- Run normal verification after applying changes.

## Limits

Ultracode subprocesses do not render as native Codex app/TUI sub-agents. The MCP tool result is the visible
bridge back into the parent thread. Token-budget gating depends on Codex reporting `turn.completed.usage`;
worktree isolation requires a git repository. See `README.md` for the full Claude-Workflow parity matrix.
