---
name: ultracode
description: Use when the user asks for Ultracode, deep parallel code investigation, multiple Codex worker passes, fan-out/fan-in analysis, subprocess-backed code review, multi-stage pipelines, budgeted/concurrency-capped worker runs, or a Claude-style under-the-surface workflow in Codex.
---

# Ultracode

Use Ultracode when the user wants deeper-than-usual code work with parallel worker passes. Ultracode gives
Codex an orchestration engine that mirrors the primitives of Claude Code's Workflow tool — `spawnWorker`
(agent), `runParallel` (barrier), `runPipeline` (barrier-free stages), schema-validated structured output,
a shared concurrency cap, token-budget gating, progress events, journaled resume, and quality helpers — all
driven by `codex exec` subprocesses. For imperative multi-agent control flow there is also an opt-in
**Workflow scripts** runner (`ultracode_script` / `ultracode-cli.js script`) that binds those primitives into a
plain async-JavaScript scope — see _Workflow scripts_ below (it runs arbitrary in-process Node and is gated).

## Workflow

1. Use the `ultracode` MCP tools when they are available.
2. If `ultracode_plan`, `ultracode_run`, `ultracode_pipeline`, `ultracode_resume`, or `ultracode_status` are
   not directly visible, call `tool_search` with `ultracode_run` or `ultracode` to expose them for the next
   model step. (`ultracode_script` also exists but is gated — see _Workflow scripts_.)
3. Prefer `ultracode_run` for a bounded fan-out/fan-in pass. Reach for `ultracode_pipeline` when stages must
   feed each other (a `depends_on` DAG with `{{steps.<id>.output}}` data flow, verify/loop stages).
4. Keep workers read-only unless the user explicitly asks for writable child Codex runs.
5. Treat worker failures as real failures. Do not replace them with guessed output.
6. If the skill is visible but `tool_search` cannot find Ultracode, stop and report that the current thread
   needs the plugin tools refreshed; do not imitate an Ultracode run manually.
7. Synthesize worker results in the parent Codex thread, then perform any edits yourself so the app/TUI keeps
   the meaningful implementation visible.
8. If the task is small, skip Ultracode and work directly.

## MCP Tools

Six tools are registered: `ultracode_plan`, `ultracode_run`, `ultracode_pipeline`, `ultracode_resume`,
`ultracode_status`, and `ultracode_script`.

- `ultracode_plan`: produce the worker plan without running subprocesses.
- `ultracode_run`: run Codex subprocess workers in parallel and return structured findings.
- `ultracode_pipeline`: run a declarative `steps[]` DAG of Codex stages (the barrier-free `runPipeline` /
  `runParallel` parity path) — see _ultracode_pipeline arguments_ below.
- `ultracode_resume`: resume a persisted workflow — completed steps are reused from the journal, only
  missing/failed/forced steps re-run.
- `ultracode_status`: inspect the latest persisted workflow state (now journaled, so it reflects mid-flight
  progress) or a specific workflow id. A deliberately cancelled run (first Ctrl-C) is recorded with status
  `cancelled`, distinct from `failed`/`partial`/`completed`.
- `ultracode_script`: run an imperative Workflow script (the Codex analogue of Claude Code's Workflow tool).
  **DISABLED unless `ULTRACODE_ALLOW_SCRIPT=1`** is set for the MCP server, and it runs arbitrary in-process
  Node with full host privileges (NOT a sandbox). See _Workflow scripts_ below.

### `ultracode_run` arguments

Default fixed-role fan-out:

- `task`: natural-language objective (required unless `workers_spec` is given).
- `cwd`: repository or workspace path. Use the current working directory when possible.
- `workers`: 1-8. Use 3 for normal deep work, 5-6 for broad audits.
- `model`: optional Codex model for child workers.
- `reasoning_effort`: optional `low`, `medium`, `high`, or `xhigh`.
- `sandbox`: default `read-only`. Use `workspace-write` or `danger-full-access` only when the user explicitly
  wants child workers to modify files.

- `timeout_ms`: per-worker timeout (default 1,200,000 = 20 min; min 1000). The kill ladder is SIGTERM then
  SIGKILL after 5s.
- `codex_bin`: optional Codex binary path (else `CODEX_CLI_PATH`, else app-bundle candidates / bare `codex`).
- `codex_home`: optional `CODEX_HOME` for child workers (else inherited; defaults to `~/.codex`).

Orchestration controls (all optional, all backward-compatible):

- `concurrency`: max simultaneous Codex subprocesses. Defaults to `min(16, cores-2)`.
- `budget_tokens`: best-effort total token budget — a pre-spawn gate checked when a worker is admitted, with
  usage accounted after each worker completes. New workers are skipped (and the cap logged) once exceeded, but
  with concurrency N up to N in-flight workers may still finish past the budget. It is a soft cap, not a hard
  per-token kill switch. Default `null` (unbounded); budget is shared across all spawns in the run.
- `max_agents`: lifetime cap on spawned workers for the run (default 1000).

Transient-retry knobs (all optional; retries fire **only** on classified transient errors — HTTP 429/5xx,
rate-limit, network errno — never on auth/bad-flag/schema/timeout/unknown failures):

- `max_retries`: per-worker transient retries. Default `0` (no retry, byte-identical to the pre-retry engine).
- `base_delay_ms`: base backoff delay. Default `500`.
- `max_delay_ms`: backoff cap. Default `30000`.
- `retry_jitter`: full-jitter in `[0, min(max, base*2^attempt)]`. Default `true`.

Schema-mismatch retries are a separate counter (default `1` when a schema is set, else `0`) and never consume
the transient-retry budget.

Transport (opt-in; also settable via the `ULTRACODE_TRANSPORT` env var):

- `transport`: `exec` (default — shells `codex exec --json`), `app-server` (the versioned `codex app-server`
  JSON-RPC path, which **auto-falls-back to exec** on any failure), or `exec-server` (reserved — throws a
  not-yet-implemented error). Any unrecognized value coerces back to `exec`.
- `transport_strict`: when `true`, an `app-server` failure errors instead of silently falling back. Default
  `false`. See _Worker transport_ in `README.md`.

Arbitrary per-worker fan-out (the `agent()` parity path) — `workers_spec`: an array of worker specs that
replaces the fixed roles. Each spec:

- `prompt` (required): the worker's full instructions.
- `label`: display label used in progress and aggregation.
- `schema`: a JSON Schema object for this worker's output. Omit for the default structured schema; pass
  `null` for raw free-text output.
- `sandbox`, `model`, `reasoning_effort`, `phase`, `timeout_ms`, `cwd`: per-worker overrides.
- `isolation: "worktree"`: run a writable worker in an isolated git worktree (its diff is collected back).

### `ultracode_pipeline` arguments

A declarative directed-acyclic graph of stages. Scheduling is **barrier-free**: a step starts the instant its
own `depends_on` resolve, while the shared context keeps concurrency and token budget globally bounded. The
whole DAG is validated **before any spawn** (duplicate id, unknown/self dependency, and cycles all throw).

Top-level args mirror `ultracode_run`'s orchestration controls — `cwd`, `sandbox`, `model`, `reasoning_effort`,
`timeout_ms`, `codex_bin`, `codex_home`, `concurrency`, `budget_tokens`, `max_agents`, the retry knobs
(`max_retries`, `base_delay_ms`, `max_delay_ms`, `retry_jitter`), `transport`, `transport_strict`, and an
optional descriptive `task` — plus:

- `steps` (required): array of step objects (at least one).
- `executor`: default warm executor for every step — `cold` (default, independent cold execs), `resume` (keeps
  a Codex session warm across turns via `codex exec resume`), or `fork` (forward-compat stub that degrades to
  cold; `codex fork` is TUI-only). See _Warm-context executor_ below.

Each step:

- `id` (required): unique step id, referenced by other steps' `depends_on` and by `{{steps.<id>....}}` tokens.
- `kind`: `worker` (default), `parallel`, `verify`, or `loop`.
- `prompt`: the prompt template. Cross-stage data flows by rendering tokens (resolved just before spawn; an
  unresolved token throws rather than emitting a blank): `{{steps.<id>.output}}`, `{{steps.<id>.output.<path>}}`
  (drill-in), `{{steps.<id>.summary}}`, `{{round}}` (inside a `loop`), and `{{item.<key>}}` (inside a
  `parallel`). A step may only reference ids in its own `depends_on`.
- `schema`: per-step JSON Schema (omit for the default schema; `null` for raw text).
- `depends_on`: array of upstream step ids.
- `label`, `phase`, `sandbox`, `model`, `reasoning_effort`, `timeout_ms`, `cwd`, `isolation: "worktree"`:
  per-step overrides.
- `executor`: per-step warm-executor override (defaults to the top-level `executor`).
- `verify`-only (`kind: "verify"`, wraps `adversarialVerify`): `findings_from` (upstream step id whose findings
  to vote on), `findings_path` (dot-path into that output, default `findings`), `skeptics` (default 3),
  `lenses`, `context`.
- `loop`-only (`kind: "loop"`, wraps `loopUntilDry`): `dry_rounds` (default 2), `max_rounds` (default 10);
  exposes `{{round}}`.
- `parallel`-only (`kind: "parallel"`): `fanout` (int, default 1 when no items) **or** `items` (array, each
  exposed via `{{item.<key>}}`).

The result is the same journaled record shape as `ultracode_run`, so `ultracode_status` and `ultracode_resume`
read it unchanged. Pipeline resume is **partial**: re-running an upstream step does not re-render or cascade to
downstream dependents.

### `ultracode_resume` arguments

- `workflow_id` (or `state_path`): the run to resume.
- `force_steps`: array of step ids / role ids / indices to re-run even if already completed.

## Engine primitives (for scripted orchestration)

`scripts/ultracode-engine.js` exports composable primitives, faithful to the Workflow tool, for callers that
drive Ultracode from Node (`node -e`, CLI, or another script). All share one `ctx` (concurrency limiter,
usage accumulator, `budget`, lifetime cap, progress sink) from `createContext(opts)`:

- `spawnWorker(prompt, opts)` → one `codex exec` worker; returns `{status, value, usage, ...}`. With
  `opts.schema` it validates and retries on mismatch; with `schema: null` it returns raw text. Never throws.
- `spawnWarmWorker(prompt, opts)` → like `spawnWorker` but returns a handle whose `.turn(prompt)` resumes the
  **same** warm Codex session (`executor: "resume"`); any resume the CLI cannot honor falls back to a cold exec.
- `runParallel(thunks, {ctx})` → barrier gather; a throwing thunk degrades to `null` (logged).
- `runPipeline(items, stages, {ctx})` → barrier-free multi-stage streaming; each item flows through all
  stages independently; a throwing stage drops that item to `null`.
- `loopUntilDry(makePrompt, {schema, dryRounds, ctx})` → keep spawning finders until K dry rounds / budget /
  lifetime cap.
- `adversarialVerify(findings, {skeptics, lenses, ctx})` → keep only findings that survive a majority refute
  vote from N skeptic workers (optionally with distinct lenses).
- `validateAgainstSchema`, `createLimiter`, `sumUsageFromWorkers`, `log` are also exported.

CLI: `node scripts/ultracode-cli.js {plan|run|pipeline|resume|status|script} [--flags]` (`plan` is the default
when no command is given). Add `--progress` to stream events to stderr. `--workers-spec '<json>'`,
`--steps '<json>'`, `--force-steps '<json>'`, and `--args '<json>'` accept JSON; numeric flags are coerced. The
MCP arg names map to kebab-case flags (e.g. `--budget-tokens`, `--max-retries`, `--reasoning-effort`,
`--transport`, `--transport-strict`, `--executor`).

**Cancellation.** For `run`, `pipeline`, `resume`, and `script`, the first Ctrl-C aborts the in-flight run and
prints the partially-completed persisted workflow (status `cancelled`, resumable from its journal); a second
Ctrl-C hard-exits 130. Opt out with `--no-cancel-on-sigint` or the `ULTRACODE_NO_SIGINT` env var. (`plan` and
`status` are fast and never intercept Ctrl-C.)

The warm-context executor (`--executor cold|resume|fork` for `pipeline`, also per step) keeps a Codex session
warm across turns; `cold` is the default and `fork` degrades to cold. See _Warm-context workers_ and _Worker
transport_ in `README.md` for the full semantics and fallback guarantees.

## Workflow scripts (`ultracode_script` / `script`)

When the user wants imperative multi-agent control flow — fan out, then reduce/filter/sort the results in plain
JavaScript, or loop agents under a budget — use a Workflow script. It is the closest analogue to Claude Code's
in-process Workflow tool. The script is plain async JavaScript with the engine primitives pre-bound into scope:
`agent(prompt, opts?)` (returns the worker `value` or `null`), `spawnWorker` (full record), `parallel(thunks)`,
`pipeline(items, ...stages)` (variadic; stages get `(prev, item, index, ctx)`), `loopUntilDry`,
`adversarialVerify`, `log`, `phase`, `workflow` (depth-guarded nested run), plus `budget`, `args`, `ctx`,
`WORKER_SCHEMA`, `VERDICT_SCHEMA`. Top-level `await` and a top-level `return` (or `export default <expr>`)
become `record.result`. The result is a journaled `kind: "script"` record readable by `ultracode_status`.

**SECURITY — this is NOT a sandbox.** A Workflow script runs arbitrary Node.js in-process with full host
privileges (it can `require()` anything, read `process.env` secrets, write files, spawn shell-running workers).
Treat it as equivalent to `node <file>.js`.

- The MCP `ultracode_script` tool is **disabled unless `ULTRACODE_ALLOW_SCRIPT=1`** is set for the server, and
  it prefers an operator-controlled file `path` over inline `source`. When disabled it returns an `isError`
  result naming the env var. Do not ask to enable it unless the user explicitly trusts the script.
- The CLI `script <path>` command is allowed by default (same trust as the user running `node <path>`).
- Only run scripts the user authored or trusts. The persisted record/events may capture whatever the script
  logs or returns; treat run files as sensitive.

CLI examples: `node scripts/ultracode-cli.js script <path> --args '<json>'` (positional path, or `--path` /
`--source`). See `examples/parallel-reduce.workflow.js` and `examples/budget-loop.workflow.js`.

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
