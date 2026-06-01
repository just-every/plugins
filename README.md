# Ultracode

A Codex CLI plugin that fans out `codex exec` subprocess workers for deep code investigation, planning, and
review — and brings the orchestration model of **Claude Code's Workflow tool** to Codex.

Workers run as real `codex exec` subprocesses (read-only by default), return schema-validated structured
findings to the parent thread, and the parent synthesizes and implements so the meaningful edits stay visible
in the Codex app/TUI.

## Components

| Path | Role |
| --- | --- |
| `scripts/ultracode-engine.js` | Orchestration engine: worker spawning, primitives, usage/budget, journaled state. No npm deps. |
| `mcp/server.js` | Hand-rolled MCP stdio server exposing `ultracode_plan` / `ultracode_run` / `ultracode_resume` / `ultracode_status`. |
| `scripts/ultracode-cli.js` | CLI over the same engine (`plan` / `run` / `resume` / `status`). |
| `scripts/run-node-tool.sh` | POSIX launcher that resolves Node + Codex and runs the MCP server or prompt hook. |
| `hooks/` | `UserPromptSubmit` hook that injects Ultracode guidance when a prompt mentions "ultracode". |
| `skills/ultracode/SKILL.md` | Usage guidance for the model. |

## Claude Workflow parity

Claude Code's Workflow tool orchestrates subagents with `agent()`, `pipeline()`, `parallel()`, `phase()`,
`log()`, `budget`, schema-forced output, concurrency caps, and resume. Ultracode now mirrors that model on top
of `codex exec` subprocesses:

| Claude Workflow feature | Ultracode equivalent | Status |
| --- | --- | --- |
| `agent(prompt, {schema})` — arbitrary prompt + per-agent schema | `spawnWorker(prompt, opts)` / `workers_spec[]` | ✅ |
| Validated structured output + retry on mismatch | `validateAgainstSchema` + `schemaRetries` (default 1) | ✅ |
| Raw-text return (no schema) | `schema: null` | ✅ |
| `parallel(thunks)` — barrier, throw → null | `runParallel(thunks, {ctx})` | ✅ † |
| `pipeline(items, stages)` — barrier-free streaming | `runPipeline(items, stages, {ctx})` | ✅ † |
| Concurrency cap `min(16, cores-2)` | shared `createLimiter` via `ctx` | ✅ |
| Lifetime agent cap (1000) | `ctx.maxAgents` (counts subprocess spawns incl. schema retries) | ✅ |
| `budget` — total / spent() / remaining() | `ctx.budget` + `budget_tokens` gate (best-effort soft cap, see below), cross-worker usage aggregation | ✅ |
| `log()` narrator + no-silent-caps | `log()` + `events[]` + `--progress` / `on_event` | ✅ |
| `phase()` grouping | per-worker `phase`, `record.phases` | ✅ |
| Resume (reuse completed; re-run failed/missing/forced) | `resumeWorkflow` / `ultracode_resume`, journaled state keyed by `step_id` — re-runs only failed, missing, or `force_steps` entries (no automatic content-change detection or downstream cascade) | ◐ partial |
| Quality: loop-until-dry | `loopUntilDry(makePrompt, opts)` | ✅ † |
| Quality: adversarial / perspective-diverse verify | `adversarialVerify(findings, {skeptics, lenses})` | ✅ † |
| `isolation: 'worktree'` for parallel writers | `spawnWorker({isolation:'worktree'})` (git worktree + diff capture) | ✅ |
| `args` threaded to stages | stage callbacks receive `(prev, item, index, ctx)` | ✅ † |
| `workflow()` nested sub-step | one-level nesting enforced via `ULTRACODE_DEPTH` depth guard (deeper nesting refused + logged) | ◐ partial |

**† Engine-API only.** These primitives are exported from `scripts/ultracode-engine.js` for scripted
orchestration (see _Scripted orchestration_ below); they are not selectable through the `ultracode_run` MCP tool,
which exposes the fixed-role and `workers_spec` fan-out. `ultracode_run` does run those fans through the shared
limiter, budget, and progress sink.

Two intentional behavioral differences from Claude's in-process Workflow tool:

- **Subprocess token budgeting.** Ultracode workers are separate `codex exec` subprocesses, so cross-worker
  budgeting depends on Codex reporting `turn.completed.usage` (it does). The `budget_tokens` gate is a
  best-effort **soft** cap: it is checked when a worker is admitted, with usage accounted after each worker
  completes, so with concurrency _N_ up to _N_ in-flight workers (plus their schema retries) can finish after
  the budget is logically exhausted. Worst-case overspend is bounded by roughly `concurrency × per-worker cost`.
- **No client-side streaming.** True token streaming to an MCP client is out of scope; the win is accurate
  on-disk journaled status plus an events log the parent reads via `ultracode_status`.

## Usage

### MCP (inside Codex)

```jsonc
// Default fixed-role fan-out
{ "name": "ultracode_run", "arguments": { "task": "Investigate the auth regression", "workers": 4 } }

// Arbitrary per-worker fan-out with custom schemas + a token budget
{ "name": "ultracode_run", "arguments": {
  "cwd": ".",
  "concurrency": 4,
  "budget_tokens": 500000,
  "workers_spec": [
    { "label": "bugs",  "prompt": "Find correctness bugs in src/.", "reasoning_effort": "high" },
    { "label": "perf",  "prompt": "Find perf hot spots in src/." },
    { "label": "notes", "prompt": "One-paragraph risk summary.", "schema": null }
  ]
}}

// Resume a run, forcing one step to re-run
{ "name": "ultracode_resume", "arguments": { "workflow_id": "ultra-...", "force_steps": ["1"] } }
```

### CLI

```bash
node scripts/ultracode-cli.js plan   --task "..." --workers 3
node scripts/ultracode-cli.js run    --task "..." --workers 4 --concurrency 4 --budget-tokens 500000 --progress
node scripts/ultracode-cli.js run    --workers-spec '[{"prompt":"...","label":"a"}]' --progress
node scripts/ultracode-cli.js resume --workflow-id ultra-... --force-steps '["1"]'
node scripts/ultracode-cli.js status --workflow-id ultra-...
```

### Scripted orchestration

```js
const uc = require("./scripts/ultracode-engine");
const ctx = uc.createContext({ concurrency: 4, budgetTokens: 500_000, onEvent: (e) => console.error(e.type) });

// pipeline: each finding verifies as soon as its review completes (no barrier between stages)
const results = await uc.runPipeline(
  [{ key: "bugs" }, { key: "perf" }],
  [
    (dim) => uc.spawnWorker(`Review for ${dim.key} issues.`, { ctx, schema: uc.WORKER_SCHEMA }),
    (review) => uc.adversarialVerify(review.value.findings, { ctx, skeptics: 3 }),
  ],
  { ctx }
);
```

## State

Runs are journaled to `$CODEX_HOME/ultracode/runs/<id>.json`, rewritten incrementally as workers settle (so
`ultracode_status` reflects progress) and carrying `workers[]`, `events[]`, `aggregate`, and `aggregate_usage`.
New fields are additive; existing readers are unaffected.

## Backward compatibility

`ultracode_plan`, `ultracode_run`, `ultracode_status`, and the CLI keep their original contracts. With only the
legacy fields, `ultracode_run` runs the identical fixed-role read-only fan-out (now limiter-scheduled with usage
aggregation and progress). All new fields are optional. The only scheduling change: on small-core machines the
≤8 legacy workers may no longer all run at once — set `concurrency` ≥ `workers` to opt out.
```
