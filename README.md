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
| `scripts/ultracode-script-runner.js` | Opt-in imperative [Workflow scripts](#workflow-scripts) runner (`runScript`): binds the engine primitives into a bound script scope. **Runs arbitrary in-process Node — not a sandbox.** |
| `scripts/app-server-client.js` | Dependency-free `codex app-server` JSON-RPC client for the opt-in `transport: 'app-server'` worker path (handshake, lenient bare-JSON-RPC framing, usage normalization). |
| `mcp/server.js` | Hand-rolled MCP stdio server exposing `ultracode_plan` / `ultracode_run` / `ultracode_pipeline` / `ultracode_resume` / `ultracode_status` / `ultracode_script` (gated). Emits `notifications/progress` for `ultracode_run` / `ultracode_pipeline` / `ultracode_script` when a `tools/call` supplies `_meta.progressToken`. Auto-detects LSP `Content-Length` framing vs. newline-delimited JSON. |
| `scripts/ultracode-cli.js` | CLI over the same engine (`plan` / `run` / `pipeline` / `resume` / `status` / `script`). |
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
| `parallel(thunks)` — barrier, throw → null | `runParallel(thunks, {ctx})` / `ultracode_pipeline` `kind:parallel` | ✅ |
| `pipeline(items, stages)` — barrier-free streaming | `runPipeline(items, stages, {ctx})` / `ultracode_pipeline` DAG | ✅ |
| Concurrency cap `min(16, cores-2)` | shared `createLimiter` via `ctx` | ✅ |
| Lifetime agent cap (1000) | `ctx.maxAgents` (counts subprocess spawns incl. schema retries) | ✅ |
| `budget` — total / spent() / remaining() | `ctx.budget` + `budget_tokens` gate (best-effort soft cap, see below), cross-worker usage aggregation | ✅ |
| `log()` narrator + no-silent-caps | `log()` + `events[]` + `--progress` / `on_event` | ✅ |
| `phase()` grouping | per-worker `phase`, `record.phases` | ✅ |
| Resume (reuse completed; re-run failed/missing/forced) | `resumeWorkflow` / `ultracode_resume`, journaled state keyed by `step_id` — re-runs only failed, missing, or `force_steps` entries (no automatic content-change detection or downstream cascade) | ◐ partial |
| Quality: loop-until-dry | `loopUntilDry(makePrompt, opts)` / `ultracode_pipeline` `kind:loop` | ✅ |
| Quality: adversarial / perspective-diverse verify | `adversarialVerify(findings, {skeptics, lenses})` / `ultracode_pipeline` `kind:verify` | ✅ |
| `isolation: 'worktree'` for parallel writers | `spawnWorker({isolation:'worktree'})` (git worktree + diff capture) | ✅ |
| `args` threaded to stages | `args` in the script scope + stage callbacks receive `(prev, item, index, ctx)` | ✅ |
| Imperative `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `budget` script | **`ultracode_script` MCP tool + `ultracode-cli.js script`** (the [_Workflow scripts_](#workflow-scripts) runner) | ✅ |
| `workflow()` nested sub-step | one-level nesting enforced via `ULTRACODE_DEPTH` depth guard (deeper nesting refused + logged) | ◐ partial |

**Reachability.** Every primitive above is exported from `scripts/ultracode-engine.js` and is now reachable
through three layered surfaces, in increasing order of expressiveness:

1. **`ultracode_run`** — the fixed-role and `workers_spec` flat fan-out (all peers at once, no data flow).
2. **`ultracode_pipeline`** — a declarative `steps[]` DAG that compiles `parallel` / `pipeline` / `verify` / `loop`
   into the engine primitives with token-substitution edges between steps.
3. **`ultracode_script` / `ultracode-cli.js script`** — the imperative [_Workflow scripts_](#workflow-scripts)
   runner: plain async JavaScript with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget`, and
   `args` bound into scope. This is the closest analogue to Claude Code's in-process Workflow tool and is the only
   surface that combines the primitives with arbitrary host-side control flow and reductions.

All three paths run through the same shared limiter, budget, and progress sink. The `pipeline()` / `parallel()` /
`args`-to-stages rows that were previously engine-API-only are now reachable end-to-end via the script runner.

### Declarative pipeline DAG (`ultracode_pipeline`)

`ultracode_pipeline` takes a `steps[]` array describing a directed acyclic graph. Each step has a unique `id`, a
`kind` (`worker` | `parallel` | `verify` | `loop`, default `worker`), a `prompt` template, and optional
`depends_on` edges. Scheduling is **barrier-free**: a step starts the instant *its own* `depends_on` resolve,
independent of unrelated branches, while the shared context keeps concurrency + token budget globally bounded.
The whole DAG is validated **before any spawn** — duplicate id, unknown dependency, self/cross-reference, and
cycles (Kahn pre-pass) all throw with a clear error and zero side effects.

Because workers are separate `codex exec` subprocesses that share no memory, cross-stage data is injected by
rendering tokens into the dependent prompt just before its spawn:

| Token | Resolves to |
| --- | --- |
| `{{steps.<id>.output}}` | the full output of dependency `<id>` (pretty JSON if an object, else raw string) |
| `{{steps.<id>.output.<dot.path>}}` | a drill-in (e.g. `{{steps.review.output.findings}}`) |
| `{{steps.<id>.summary}}` | `output.summary` of dependency `<id>` |
| `{{round}}` | the current round index inside a `loop` step |
| `{{item.<key>}}` | a field of the current item inside a `parallel` step |

A step may only reference ids listed in its own `depends_on` (compile-time enforced), and any unresolved token
throws rather than emitting a blank. Per-kind fields: `verify` adds `findings_from` / `findings_path` (default
`findings`) / `skeptics` (default 3) / `lenses` / `context`; `loop` adds `dry_rounds` (default 2) / `max_rounds`
(default 10) and exposes `{{round}}`; `parallel` adds `fanout` (int) **or** `items` (array, each exposed as
`{{item.<key>}}`). The result record is the same journaled shape as `ultracode_run`, so `ultracode_status` and
`ultracode_resume` read it unchanged (with each worker entry carrying `step_id` / `kind` / `depends_on`).

> Pipeline resume is **partial** (same caveat as `ultracode_resume`): a re-run leaf replays its already-rendered
> prompt faithfully, but re-running an upstream step does **not** re-render or cascade to downstream dependents.

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

// Declarative DAG: review, then adversarially verify its findings, plus an independent loop
{ "name": "ultracode_pipeline", "arguments": {
  "cwd": ".",
  "concurrency": 4,
  "steps": [
    { "id": "review", "prompt": "Review src/ for correctness bugs." },
    { "id": "verify", "kind": "verify", "prompt": "n/a",
      "findings_from": "review", "findings_path": "findings", "skeptics": 3,
      "depends_on": ["review"] },
    { "id": "hunt", "kind": "loop", "prompt": "Round {{round}}: find one more missing test." }
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
node scripts/ultracode-cli.js pipeline --steps '[{"id":"a","prompt":"..."},{"id":"b","prompt":"use {{steps.a.summary}}","depends_on":["a"]}]' --progress
node scripts/ultracode-cli.js resume --workflow-id ultra-... --force-steps '["1"]'
node scripts/ultracode-cli.js status --workflow-id ultra-...
node scripts/ultracode-cli.js script <path> --args '{"files":["a.js"]}'   # imperative Workflow script (see below)
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

## Workflow scripts

`ultracode_script` (MCP) and `node scripts/ultracode-cli.js script` (CLI) run an **imperative workflow script** —
the Codex analogue of Claude Code's in-process Workflow tool. Instead of a declarative `steps[]` DAG, you write
plain async JavaScript and the engine's orchestration primitives are pre-bound into the script scope, so a
multi-agent workflow reads like ordinary code with `await`, `map`/`filter`/`sort`, and arbitrary host-side
reductions between agent calls.

> ### ⚠️ SECURITY — this is NOT a sandbox
>
> A workflow script executes **arbitrary Node.js IN-PROCESS** in the host (the MCP server or the CLI) with
> **full host privileges**. The bound scope is purely ergonomic and provides **no isolation whatsoever**. A
> script can `require()` any module, read/write any file the host user can, read `process.env` (including Codex
> API keys/tokens, `CODEX_HOME`, and every inherited secret), call `process.exit`, open network sockets, and
> spawn Codex workers that run shell (it may even request `sandbox: 'workspace-write'` / `'danger-full-access'`
> per call). **Trust level is exactly equal to `node <file>.js`** — whoever can author or point at a script can
> already run code as the host user.
>
> Because of this:
>
> - **MCP `ultracode_script` is DISABLED by default.** It refuses unless the environment variable
>   **`ULTRACODE_ALLOW_SCRIPT=1`** is set for the MCP server process. When disabled it returns an `isError`
>   content result naming the env var (it does **not** throw and spawns nothing). When enabled, it **prefers an
>   operator-controlled file `path`** over inline `source`; inline `source` is only accepted while the flag is
>   set. Set `ULTRACODE_ALLOW_SCRIPT=1` only on an MCP server you fully trust — a client that can reach an
>   enabled server has RCE-as-host-user.
> - **CLI `script <path>` is allowed by default** (an env gate there would be theater: you already ran a local
>   file from your own shell, identical trust to `node <path>`).
> - The persisted run record (under `$CODEX_HOME/ultracode/runs`) and `events[]` may capture whatever the script
>   logs/returns and whatever a worker prints to stderr — **treat those files as sensitive.** The runner never
>   auto-dumps `process.env`.
> - The bound caps (one shared concurrency limiter, `budget_tokens` gate, `max_agents` lifetime cap, and the
>   `ULTRACODE_DEPTH` nesting guard) bound the blast radius of the **workers** a script spawns, but a trusted
>   script still chooses its own budget and may pass `danger-full-access` per call — by design.
> - No `vm` / `child_process` / `worker_threads` isolation layer exists today; true isolation is noted as
>   future hardening.

### API surface

`runScript(input)` — exported from `scripts/ultracode-script-runner.js` — resolves to a journaled record. `input`:

| Field | Meaning |
| --- | --- |
| `source` **xor** `path` | the script body inline, **or** a path to a `.js`/`.workflow.js` file. Exactly one is required (both/neither throws). `path` is read by **contents** (dirname-independent). |
| `args` | arbitrary object exposed to the script as the bound `args`. |
| `cwd` | workspace directory for child workers. |
| `concurrency` / `budget_tokens` / `max_agents` | the shared limiter / soft token cap / lifetime spawn cap (same semantics as `ultracode_run`). |
| `max_retries` / `base_delay_ms` / `max_delay_ms` / `retry_jitter` | journaled into `options`. |
| `signal` / `on_event` | abort signal and progress sink (wired by the CLI's Ctrl-C and the MCP progress token). |
| `codex_bin` / `codex_home` | spawn defaults threaded into every agent. |

**Bound script scope** (`ctx` is auto-injected into every primitive — you never pass it):

| Binding | Behavior |
| --- | --- |
| `agent(prompt, opts?)` | spawns one worker and returns its `value` on completion, else `null` (the failure is already logged). The ergonomic happy-path primitive. |
| `spawnWorker(prompt, opts?)` | the raw engine call returning the full `{status, value, usage, thread_id, ...}` record (advanced). |
| `parallel(thunks)` | barrier gather; a throwing thunk degrades to `null`. |
| `pipeline(items, ...stages)` | **variadic** — each stage is a positional argument and receives `(prev, item, index, ctx)`; barrier-free streaming. |
| `loopUntilDry(makePrompt, opts?)` | keep spawning finders until K dry rounds / budget / lifetime cap. |
| `adversarialVerify(findings, opts?)` | keep only findings that survive a majority refute vote. |
| `log(message, data?)` | narrator line into `events[]`. |
| `phase(title)` | sets a closure-tracked phase used as the default `phase` for subsequent `agent()`/`spawnWorker()`. |
| `workflow(pathOrSource, args?)` | one-level **nested** `runScript`, guarded by `ULTRACODE_DEPTH`; beyond depth 1 it throws `nested script workflows beyond depth 1 are not supported`. |
| `budget` | `{ total, spent(), remaining() }`. |
| `args` | the `input.args` object. |
| `ctx` | the shared context (advanced). |
| `WORKER_SCHEMA` / `VERDICT_SCHEMA` | the engine schemas. |

A script may use top-level `await` and a top-level `return` (the returned value becomes `record.result`). ES
module sugar is tolerated by a small source transform: `export default <expr>` becomes the captured return value,
and a leading `export const|let|var|async|function|class` is stripped to the bare declaration (so a
`.workflow.js` file is editor-friendly). A `"use strict";` prelude is prepended as hygiene (an undeclared
assignment throws instead of leaking a host global). **Note:** because the body is wrapped in an `AsyncFunction`,
a journaled `error` line/position is offset from the original file — the message is still accurate but line
numbers will not match the source.

### Returned record

```jsonc
{ "id": "ultra-<stamp>-<hex>", "kind": "script", "status": "completed" /* | "failed" */,
  "started_at": "...", "completed_at": "...", "duration_ms": 0, "cwd": "...",
  "options": { "concurrency": 4, "budget_tokens": null, "max_agents": 1000,
               "max_retries": null, "base_delay_ms": null, "max_delay_ms": null, "retry_jitter": null },
  "state_path": "$CODEX_HOME/ultracode/runs/ultra-....json",
  "workers": [],            // always [] — a script record is not step-resumable
  "result": { /* the script's return value */ },
  "events": [ /* narrator log */ ],
  "aggregate_usage": { /* cross-worker token totals */ },
  "error": "<message, only when status:failed>" }
```

A throwing or syntactically broken script never crashes the host: execution is wrapped in `try`/`catch`, so the
record is journaled with `status: "failed"`, the `error` message, and the partial `events` written so far. The
record is read by `ultracode_status` (and `readWorkflow`) unchanged; `ultracode_resume` degrades to a clean
"nothing to resume" message because `workers` is `[]` (a script is not step-resumable).

### Example (mirroring a Claude workflow)

A fan-out → filter → reduce pass, the imperative shape of a Claude `parallel()` workflow
(see `examples/parallel-reduce.workflow.js`):

```js
// inspect.workflow.js
const files = args.files;            // injected via --args / the `args` MCP field

phase("inspect");
log(`fanning out over ${files.length} file(s)`, { count: files.length });

// one agent per file, all bounded by the shared concurrency limiter;
// agent() resolves to the structured value (or null on failure)
const reports = await parallel(
  files.map((file) => () => agent(`Inspect ${file}; report a one-line summary and a confidence.`))
);

// arbitrary host-side reduction between agent calls
const rank = { high: 0, medium: 1, low: 2 };
const reduced = reports
  .map((r, i) => (r ? { file: files[i], ...r } : null))
  .filter(Boolean)
  .sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9));

export default { inspected: files.length, kept: reduced.length, reports: reduced };
```

Drive it via the CLI (allowed by default), or via MCP once the gate is set:

```bash
# CLI — allowed by default (positional <path>, or --path / --source / --args; Ctrl-C aborts)
node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["src/a.js","src/b.js","src/c.js"]}' --concurrency 3

# Free dry run against the mock codex
CODEX_CLI_PATH=test/fixtures/mock-codex.js \
node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["a.js","b.js"]}'
```

```jsonc
// MCP — DISABLED unless ULTRACODE_ALLOW_SCRIPT=1 on the server; prefers `path` over `source`
{ "name": "ultracode_script", "arguments": {
  "path": "examples/parallel-reduce.workflow.js",
  "args": { "files": ["src/a.js", "src/b.js"] },
  "concurrency": 3
}}
```

The MCP tool accepts exactly `{ path?, source?, args?, cwd?, concurrency?, budget_tokens?, max_agents? }`
(`additionalProperties: false`). A second example, `examples/budget-loop.workflow.js`, shows a
`budget`-bounded `loopUntilDry` discovery surfacing `budget.spent()` / `budget.remaining()`.

### Warm-context workers (opt-in)

By default every worker is a fresh, **ephemeral** `codex exec` subprocess (no session persisted). For a multi-stage
chain where the *same* worker keeps reasoning across turns, the warm executor avoids re-paying the cold-start /
context cost on every stage by keeping a Codex session warm via `codex exec resume <session_id>`:

```js
const handle = await uc.spawnWarmWorker("Read the auth module and summarize it.", {
  ctx,
  executor: "resume", // forces a persisted (non-ephemeral) first turn so a session id exists
});
// handle.sessionId is the resumable session (the first turn's thread_id)
const r2 = await handle.turn("Now list the security risks you noticed.");   // resumes the SAME session
const r3 = await handle.turn("Propose minimal fixes for the top risk.");     // still warm
```

`runPipeline` accepts `warm: true` to give each item its own warm session reused across stages (warm reuse is
**per item**; fan-out *across* items stays parallel with independent sessions):

```js
await uc.runPipeline(items, [
  (item, _i, _idx, _ctx, warm) => warm.start(`Analyze ${item.key}.`),   // stage 0 opens the warm session
  (acc, _i, _idx, _ctx, warm) => warm.turn("Now critique your analysis."), // later stages resume it
], { ctx, warm: true, codex_bin, cwd });
```

The pipeline DAG (`ultracode_pipeline` / `pipeline`) accepts an `executor` (`cold` | `resume` | `fork`) at the top
level and per step.

Guarantees and limits:

- **Pure optimization, never a correctness change.** A resume turn that the CLI cannot honor (unknown/expired
  rollout — detected via `no rollout found for thread id`, or any non-zero exit / missing last-message) transparently
  falls back to the identical cold `codex exec`, logging `resume-fallback`. If the first turn yields no session id,
  follow-up turns simply run cold. With nothing opted in (`executor` defaults to `'cold'`, `persistSession` stays
  `false`, `runPipeline.warm` defaults to `false`), the cold fan-out is byte-for-byte unchanged (still `--ephemeral`).
- **Resume turns are sequential.** `codex exec resume` continues one conversation, so warm turns within a single
  worker/item cannot run in parallel — only the cross-item fan-out parallelizes.
- **Schema / sandbox / cwd on a resume turn.** The `resume` subcommand rejects `--output-schema`, `-s/--sandbox`,
  `-C/--cd`, `--add-dir`, and `-p/--profile`. Sandbox/cwd/profile are inherited from the original persisted session;
  the JSON schema is enforced by injecting it into the prompt plus the existing post-hoc validation + schema-retry
  loop. If a stage needs a *different* sandbox/cwd, use cold for that stage.
- **Disk.** A persisted session writes a rollout under `$CODEX_HOME/sessions` instead of `--ephemeral`; this happens
  only when you opt in.
- **`executor: 'fork'` is a documented stub.** `codex fork` is interactive-TUI-only (no `--json`, no
  `codex exec fork`), so true shared-context fan-out is not possible via the non-interactive CLI. `fork` is accepted
  for forward-compat, logs `fork-unsupported`, and runs the cold path.

### Worker transport (opt-in)

The default worker **transport** shells `codex exec --json` and scrapes JSONL events. An opt-in alternative consumes
the versioned **`codex app-server`** JSON-RPC protocol instead, while returning the exact same worker result so usage
accounting, schema validation/retry, worktree isolation, and persistence are unchanged.

| `transport` | Behavior |
| --- | --- |
| `'exec'` *(default)* | Today's `codex exec --json` JSONL path. Also selected by `ULTRACODE_TRANSPORT=exec` or anything unrecognized. |
| `'app-server'` | Spawns `codex app-server`, runs `initialize → initialized → thread/start → turn/start`, accumulates `item/agentMessage/delta` text, and normalizes the `thread/tokenUsage/updated` camelCase breakdown into the engine's usage shape. |
| `'exec-server'` | Reserved. Throws an explicit *not yet implemented* error (the client seam is generic enough to host it later). |

```jsonc
// MCP: ultracode_run / ultracode_pipeline
{ "task": "...", "transport": "app-server" }          // opt in; falls back to exec on any failure
{ "task": "...", "transport": "app-server", "transport_strict": true }  // error instead of falling back
```

```bash
ULTRACODE_TRANSPORT=app-server node scripts/ultracode-cli.js run --task "..." --progress
node scripts/ultracode-cli.js run --task "..." --transport app-server --progress
```

Notes:

- **Opt-in, with automatic fallback.** Any app-server failure (initialize / unsupported method / protocol error /
  timeout) transparently falls back to the identical exec path and emits a `worker.transport_fallback` event plus a
  narrator log. Pass `transport_strict: true` to surface the error instead of falling back.
- **Lenient framing.** The app-server emits *bare* JSON-RPC objects (no top-level `jsonrpc` field) and proactive
  unsolicited notifications; the client classifies messages by `id`/`result`/`error`/`method`, never by `jsonrpc`.
- **Schema enforcement is transport-agnostic.** The schema is embedded in the turn prompt and enforced by the same
  post-hoc `validateAgainstSchema` + schema-retry loop used by the exec path (no `--output-schema` on the wire).
- **`approvalPolicy` is forced to `never`** so the server never blocks on an approval request.
- **Byte-for-byte default.** `transport` is journaled into `workflow.options` only when non-default, so a plain run's
  record is unchanged. Warm `executor: 'resume'` turns always use the exec path (resume is an exec-only concept).

### MCP progress notifications (opt-in by the client)

Per the MCP spec, a `tools/call` request MAY carry `_meta.progressToken`. When `ultracode_run`, `ultracode_pipeline`,
or `ultracode_script` is called with one, the server emits `notifications/progress` on the same connection until it
returns the final result (`ultracode_plan` / `ultracode_resume` / `ultracode_status` are fast and unwired):

```jsonc
{ "method": "notifications/progress",
  "params": { "progressToken": "<token>", "progress": 0, "message": "worker.started Context Scout" } }
```

`progress` is a monotonically increasing integer (`total` is omitted when unknown). The notifications mirror the
engine's existing `on_event` stream (the same sink the CLI's `--progress` flag uses). When no `progressToken` is
supplied, **zero** progress notifications are emitted and the result is identical to before.

## Testing & development

The engine and runners have **no npm dependencies**, so the test suite runs on the Node built-in test runner with
no install step. Tests never call real Codex — every spawn is redirected at a **mock** Codex binary, so the whole
suite (and the example workflows below) runs **offline and free**.

```bash
npm test                              # node --test "test/**/*.test.js" (all 23 *.test.js files)
node --test "test/**/*.test.js"       # the same, without the package.json script
node --test test/script-runner.test.js   # run a single test file
```

The suite covers the limiter, schema validation/retry, `spawnWorker`, workflow / resume / pipeline, retry &
cancel, warm-context, the app-server transport, MCP progress, the script runner, and CLI SIGINT handling.

**Running CLI commands and example workflows for free.** Point `CODEX_CLI_PATH` at the mock Codex binary
(`test/fixtures/mock-codex.js`, with `mock-codex-fail.js` for the failure path) and use a throwaway `CODEX_HOME`
so the run never touches your real `~/.codex`:

```bash
CODEX_HOME=$(mktemp -d) CODEX_CLI_PATH=test/fixtures/mock-codex.js \
  node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["a.js","b.js"]}'

CODEX_HOME=$(mktemp -d) CODEX_CLI_PATH=test/fixtures/mock-codex.js \
  node scripts/ultracode-cli.js script examples/budget-loop.workflow.js \
  --budget-tokens 5000 --max-agents 6 --concurrency 2
```

The `examples/` directory ships two ready-to-run scripts: `parallel-reduce.workflow.js` (a fan-out → filter →
reduce pass) and `budget-loop.workflow.js` (a `budget`-bounded `loopUntilDry` that surfaces `budget.spent()` /
`budget.remaining()`). The mock honors `MOCK_CODEX_*` env knobs (e.g. `MOCK_CODEX_RESPONSE`, `MOCK_CODEX_EXIT`,
`MOCK_CODEX_SLEEP_MS`, `MOCK_CODEX_FAIL_TIMES`) — see `test/fixtures/mock-codex.js` and `test/helpers/env.js`.

> **Operational note.** The stdio MCP server exits when its stdin reaches `end`. A real client keeps the
> connection open for the lifetime of the call, but a naïve one-shot pipe that closes stdin immediately can cut
> off an in-flight async `tools/call` (`ultracode_run` / `ultracode_pipeline` / `ultracode_script`) before its
> result is written — keep stdin open until the response arrives.

## State

Runs are journaled to `$CODEX_HOME/ultracode/runs/<id>.json`, rewritten incrementally as workers settle (so
`ultracode_status` reflects progress) and carrying `workers[]`, `events[]`, `aggregate`, and `aggregate_usage`.
New fields are additive; existing readers are unaffected.

## Backward compatibility

`ultracode_plan`, `ultracode_run`, `ultracode_resume`, `ultracode_status`, and the CLI keep their original
contracts. With only the legacy fields, `ultracode_run` runs the identical fixed-role read-only fan-out (now
limiter-scheduled with usage aggregation and progress). All new fields are optional. The only scheduling change:
on small-core machines the ≤8 legacy workers may no longer all run at once — set `concurrency` ≥ `workers` to opt
out.

`ultracode_pipeline` is fully additive: it is a sibling MCP tool / CLI command that reuses the same engine
machinery (context, limiter, budget, journaled record shape) and does not change any existing tool schema, CLI
command, or engine export. The `workers_spec` and fixed-role paths are byte-for-byte unchanged.

The warm-context executor (`executor`, `spawnWarmWorker`, `runPipeline.warm`) is likewise additive and opt-in: it
defaults to the cold ephemeral fan-out and falls back to it on any resume failure, so existing flows are unaffected.

The `ultracode_script` MCP tool and the CLI `script` command are purely additive: the five prior MCP tools and the
existing CLI commands keep byte-identical schemas/contracts, and `ultracode_script` is added with
`additionalProperties: false`. The MCP tool refuses unless `ULTRACODE_ALLOW_SCRIPT=1`, and the engine only gains a
single lazy `runScript` re-export (call-time `require`, no require cycle), so existing engine exports are unchanged.
Script records (`kind: "script"`) journal into the same `$CODEX_HOME/ultracode/runs/` directory and are read by
`ultracode_status` unchanged; `ultracode_resume` returns a clean no-op message for them (they carry `workers: []`).
```
