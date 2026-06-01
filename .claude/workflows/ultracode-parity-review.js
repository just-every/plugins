export const meta = {
  name: 'ultracode-parity-review',
  description: 'Adversarially review the upgraded Ultracode engine for bugs, regressions, and parity gaps',
  phases: [
    { title: 'Review', detail: 'parallel dimension reviewers over the new code + docs' },
    { title: 'Verify', detail: 'independently confirm each finding against the actual code' },
  ],
}

const REPO = '/Users/zemaj/www/just-every/ultracode'
const ENGINE = `${REPO}/scripts/ultracode-engine.js`
const SERVER = `${REPO}/mcp/server.js`
const CLI = `${REPO}/scripts/ultracode-cli.js`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        location: { type: 'string', description: 'file:line or function name' },
        evidence: { type: 'string', description: 'concrete quote/explanation of the problem' },
        suggested_fix: { type: 'string' },
      },
      required: ['title', 'severity', 'location', 'evidence', 'suggested_fix'] } },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    confirmed: { type: 'boolean', description: 'true only if the bug is real after reading the actual code' },
    real_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
    explanation: { type: 'string' },
    corrected_fix: { type: 'string' },
  },
  required: ['confirmed', 'real_severity', 'explanation', 'corrected_fix'],
}

const DIMENSIONS = [
  { key: 'correctness', prompt: `Review ${ENGINE} for CORRECTNESS BUGS in the new orchestration layer. Scrutinize: the createLimiter drain loop (deadlocks, lost slots, error paths), spawnWorker/spawnWorkerGuarded control flow (the while(true) retry loop, attempt counting, schema-accept-invalid path, worktree finally cleanup), runPipeline barrier-free semantics, runParallel null-degradation, accountUsage/sumUsageFromWorkers math, validateAgainstSchema edge cases (nested arrays of objects, additionalProperties, missing type), and the makePersister write-chain (lost updates, race between concurrent settles). Cite file:line and give a concrete fix. Read the file first.` },
  { key: 'backward-compat', prompt: `Review the upgraded engine for BACKWARD-COMPATIBILITY REGRESSIONS. Run \`git -C ${REPO} show HEAD:scripts/ultracode-engine.js\` to see the ORIGINAL, then diff behavior against the new ${ENGINE}. Verify: planWorkflow output is byte-identical; the legacy runWorkflow record shape (id,status,task,cwd,started_at,completed_at,duration_ms,options{},state_path,workers[],aggregate) is preserved; legacy worker records keep {index,id,title,focus,status,result,usage,duration_ms} and failed keep {status:'failed',error,codex_exec}; compactWorkflow output keeps its original keys; the codex exec arg list for the default path is equivalent (esp. --ephemeral still present, --output-schema present, approval_policy). Also check mcp/server.js (${SERVER}) and the CLI (${CLI}) keep their original contracts. Flag any divergence with file:line and a fix.` },
  { key: 'async-resource', prompt: `Review ${ENGINE} for ASYNC / RESOURCE / PROCESS-LIFECYCLE issues. Scrutinize: temp dir and git-worktree cleanup on every path including timeout/SIGKILL; the spawnCodex incremental line parser (partial lines, CRLF, huge output, buffering both full stdout AND line-splitting); unhandled promise rejections; the persister chain swallowing errors; whether ctx.spawnedCount increments correctly under retries and whether the lifetime cap can be bypassed; whether budget gating has TOCTOU races under concurrency (it is checked before spawn but usage accrues after — is that acceptable?). Cite file:line and give fixes.` },
  { key: 'parity-gap', prompt: `Compare the upgraded engine against Claude Code's Workflow tool semantics and find PARITY GAPS or SUBTLE SEMANTIC MISMATCHES. Claude's pipeline() has NO barrier between stages (item A can be in stage 3 while B is in stage 1) and the only concurrency gate is the global limiter; verify runPipeline in ${ENGINE} actually achieves this (each stage's spawnWorker re-enters the limiter, no stage-wide await). Claude's parallel() maps a throwing thunk to null; verify. Claude's budget.spent() is a hard ceiling; verify the gate. Claude resume returns cached results for unchanged steps and re-runs from the first change; verify resumeWorkflow's step_id keying and force_steps matching. Note anything claimed in ${REPO}/README.md that the code does NOT actually deliver. Cite file:line.` },
  { key: 'docs-consistency', prompt: `Check ${REPO}/README.md and ${REPO}/skills/ultracode/SKILL.md against the ACTUAL code in ${ENGINE}, ${SERVER}, and ${CLI}. Find any claim, flag name, argument name, tool name, CLI command, or example that is WRONG or does not match the implementation (e.g. wrong export names, wrong MCP arg names, wrong CLI flags, examples that would error, the parity matrix marking something done that is not). Verify the CLI examples' flag names map to real coerced keys. Cite the doc location and the code location.` },
]

phase('Review')
const reviewed = await pipeline(
  DIMENSIONS,
  (dim) => agent(dim.prompt, { label: `review:${dim.key}`, phase: 'Review', schema: FINDINGS_SCHEMA })
    .then((r) => ({ key: dim.key, findings: (r && r.findings) || [] })),
  (review) => parallel((review.findings).map((f) => () =>
    agent(
      `Independently verify this reported issue by READING the actual code at ${REPO}. Do not trust the report; confirm it against the source. Decide if it is a REAL defect that should be fixed.\n\nReported issue (dimension: ${review.key}):\nTitle: ${f.title}\nSeverity: ${f.severity}\nLocation: ${f.location}\nEvidence: ${f.evidence}\nSuggested fix: ${f.suggested_fix}\n\nSet confirmed=true only if it is a genuine bug/regression/inaccuracy. If it is a non-issue or already handled, set confirmed=false and explain.`,
      { label: `verify:${review.key}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    ).then((v) => ({ dimension: review.key, finding: f, verdict: v })).catch(() => null)
  )),
)

const confirmed = reviewed
  .flat()
  .filter(Boolean)
  .filter((x) => x.verdict && x.verdict.confirmed && x.verdict.real_severity !== 'not-a-bug')
  .map((x) => ({
    dimension: x.dimension,
    title: x.finding.title,
    severity: x.verdict.real_severity,
    location: x.finding.location,
    explanation: x.verdict.explanation,
    fix: x.verdict.corrected_fix,
  }))
  .sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 }
    return (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
  })

log(`Confirmed ${confirmed.length} real issues across ${DIMENSIONS.length} dimensions`)
return { confirmed, total_raw: reviewed.flat().filter(Boolean).length }
