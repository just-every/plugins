export const meta = {
  name: 'ultracode-parity-analysis',
  description: 'Gap analysis: compare the Codex ultracode plugin to Claude\'s Workflow tool and produce an implementation plan',
  phases: [
    { title: 'Inventory', detail: 'parallel: current engine, Claude Workflow features, Codex CLI feasibility' },
    { title: 'Design', detail: 'synthesize gap analysis + prioritized implementation plan' },
  ],
}

const REPO = '/Users/zemaj/www/just-every/ultracode'

// Concise but faithful spec of Claude Code's Workflow tool, supplied to agents
// (they cannot see the orchestrator's system prompt).
const CLAUDE_WORKFLOW_SPEC = `
Claude Code's Workflow tool runs a JS orchestration script that spawns subagents. Primitives:
- agent(prompt, opts?) -> Promise<string|object>. opts: {label, phase, schema (JSON Schema -> forces validated structured output via a StructuredOutput tool), model, isolation:'worktree', agentType}. Without schema returns final text; with schema returns validated object; returns null if user skips.
- pipeline(items, stage1, stage2, ...) -> Promise<any[]>. Each item flows through ALL stages independently with NO barrier between stages (item A can be in stage 3 while item B is in stage 1). Wall-clock = slowest single-item chain. Stage callback gets (prevResult, originalItem, index). A throwing stage drops that item to null. This is the DEFAULT for multi-stage work.
- parallel(thunks) -> Promise<any[]>. Runs thunks concurrently but is a BARRIER (awaits all). A throwing thunk resolves to null (never rejects). Use only when you need ALL results together (dedup/merge, early-exit on zero, cross-item comparison).
- log(message) -> emits a narrator progress line.
- phase(title) -> starts a phase; subsequent agent() calls group under it in progress UI.
- args -> the input value passed to the workflow.
- budget -> {total:number|null, spent():number, remaining():number}. Token target (hard ceiling). Enables loop-until-budget: while (budget.total && budget.remaining() > 50000) {...}.
- workflow(nameOrRef, args) -> run another workflow inline as a sub-step (one level deep).
- Concurrency cap: min(16, cores-2) concurrent agents; lifetime cap 1000 agents.
- meta = {name, description, phases, whenToUse, model} (pure literal) declares the workflow.
- Resume: relaunch with {scriptPath, resumeFromRunId}; unchanged prefix of agent() calls returns cached results instantly (journaling); first edited/new call onward re-runs live.
- Quality patterns baked into guidance: adversarial verify (N skeptics per finding, kill on majority-refute), perspective-diverse verify (distinct lens per verifier), judge panel (N attempts + parallel judges + synthesis), loop-until-dry (spawn finders until K dry rounds), multi-modal sweep (each agent searches a different way), completeness critic (final "what's missing" agent), no-silent-caps (log() anything dropped).
- Subagents: full agent with all tools; final text IS the return value (raw data, not human-facing). schema validation happens at tool-call layer with model retry on mismatch.
`

const INVENTORY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    components: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, role: { type: 'string' } },
      required: ['path', 'role'] } },
    capabilities: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    extension_points: { type: 'array', items: { type: 'string' } },
    persistence_and_state: { type: 'string' },
  },
  required: ['components', 'capabilities', 'limitations', 'extension_points', 'persistence_and_state'],
}

const FEATURES_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    features: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: ['primitive', 'concurrency', 'structured-output', 'state', 'quality-pattern', 'progress', 'budget'] },
        what_it_does: { type: 'string' },
        why_it_matters: { type: 'string' },
      },
      required: ['name', 'category', 'what_it_does', 'why_it_matters'] } },
  },
  required: ['features'],
}

const PROBE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    codex_version: { type: 'string' },
    relevant_exec_flags: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { flag: { type: 'string' }, purpose: { type: 'string' } }, required: ['flag', 'purpose'] } },
    feasibility: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        claude_feature: { type: 'string' },
        feasible_in_codex: { type: 'string', enum: ['yes', 'partial', 'no'] },
        approach: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['claude_feature', 'feasible_in_codex', 'approach', 'notes'] } },
  },
  required: ['codex_version', 'relevant_exec_flags', 'feasibility'],
}

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        claude_feature: { type: 'string' },
        current_state: { type: 'string' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        recommendation: { type: 'string' },
      },
      required: ['claude_feature', 'current_state', 'severity', 'recommendation'] } },
    proposed_engine_api: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { fn: { type: 'string' }, signature: { type: 'string' }, purpose: { type: 'string' } },
      required: ['fn', 'signature', 'purpose'] } },
    implementation_plan: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        files: { type: 'array', items: { type: 'string' } },
        design: { type: 'string' },
        risks: { type: 'string' },
      },
      required: ['id', 'title', 'priority', 'files', 'design', 'risks'] } },
    backward_compat_notes: { type: 'string' },
  },
  required: ['gaps', 'proposed_engine_api', 'implementation_plan', 'backward_compat_notes'],
}

phase('Inventory')
const [inventory, claudeFeatures, probe] = await parallel([
  () => agent(
    `Read every file under ${REPO} (especially scripts/ultracode-engine.js, mcp/server.js, scripts/ultracode-cli.js, hooks/, skills/ultracode/SKILL.md, .codex-plugin/plugin.json, .mcp.json). This is a Codex CLI plugin called "ultracode" that fans out 'codex exec' subprocess workers. Produce a precise capability inventory: components and their roles, what the engine can currently do, its concrete limitations vs a richer orchestration engine, where it is extensible, and how it persists state. Be specific about the fixed 8-role model, the single fan-out/fan-in shape, the single fixed WORKER_SCHEMA, Promise.all concurrency, and usage parsing.`,
    { label: 'inventory:current-engine', phase: 'Inventory', schema: INVENTORY_SCHEMA }
  ),
  () => agent(
    `Here is the spec of Claude Code's Workflow tool:\n${CLAUDE_WORKFLOW_SPEC}\n\nProduce a structured catalogue of its features (one entry per distinct capability) suitable for a parity comparison against a Codex subprocess fan-out engine. For each: name, category, what it does, why it matters for orchestration quality. Be exhaustive across primitives (agent/pipeline/parallel), concurrency control, structured output, state/resume, progress, budget, and quality patterns.`,
    { label: 'inventory:claude-features', phase: 'Inventory', schema: FEATURES_SCHEMA }
  ),
  () => agent(
    `Probe the locally installed Codex CLI to determine what the ultracode engine can actually drive. Run: \`codex --version\`, \`codex exec --help\` (and \`codex --help\` if useful). Capture the real flags relevant to subprocess orchestration (json output, output-schema, output-last-message, sandbox, model, reasoning effort, cd, ephemeral, skip-git-repo-check, approval policy, resume/session, etc.). Then assess feasibility in Codex of each of these Claude-Workflow features: multi-stage pipeline, barrier vs non-barrier parallel, per-agent arbitrary prompt, per-agent JSON schema, concurrency capping, token budget tracking (does turn.completed.usage exist?), loop-until-dry / loop-until-count, resume/journaling of completed workers, worktree isolation for parallel writes, progress logging, nested workflows. For each say yes/partial/no with the concrete approach. Note: codex exec already supports --output-schema and --output-last-message per the existing engine.`,
    { label: 'inventory:codex-probe', phase: 'Inventory', schema: PROBE_SCHEMA }
  ),
])

phase('Design')
const design = await agent(
  `You are designing how to upgrade the Codex "ultracode" plugin engine (at ${REPO}/scripts/ultracode-engine.js) so it matches the orchestration functionality of Claude Code's Workflow tool, WITHIN the constraints of driving 'codex exec' subprocesses.

CURRENT ENGINE INVENTORY (JSON):
${JSON.stringify(inventory, null, 2)}

CLAUDE WORKFLOW FEATURE CATALOGUE (JSON):
${JSON.stringify(claudeFeatures, null, 2)}

CODEX CLI FEASIBILITY PROBE (JSON):
${JSON.stringify(probe, null, 2)}

Produce:
1) gaps: for each meaningful Claude Workflow feature, the current state in this engine, a severity, and a recommendation.
2) proposed_engine_api: a concrete proposed JS API for the upgraded engine module (functions like runStep/runPipeline/runParallel/spawnWorker with arbitrary prompt+schema, concurrency limiter, budget/usage accounting, resume by workflow id, progress events). Keep it Node-only, no new npm deps, faithful to the existing module's style (CommonJS, fs/promises, child_process spawn of codex exec).
3) implementation_plan: prioritized (P0/P1/P2) concrete changes with files and design notes and risks. P0 = the core parity features that are highest value and low-risk to add (arbitrary per-worker prompt + schema, concurrency cap, budget/usage aggregation, richer multi-step/pipeline shape, progress/log events, resume by id). P1/P2 = nice-to-haves (worktree isolation, nested workflows, adversarial-verify helper, loop-until-dry helper).
4) backward_compat_notes: how to keep ultracode_plan/ultracode_run/ultracode_status and the fixed-role default working so existing callers don't break.

Be concrete and code-level. This plan will be implemented directly afterward.`,
  { label: 'design:gap-analysis-and-plan', phase: 'Design', schema: DESIGN_SCHEMA }
)

return { inventory, claudeFeatures, probe, design }
