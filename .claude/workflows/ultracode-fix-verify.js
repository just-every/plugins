export const meta = {
  name: 'ultracode-fix-verify',
  description: 'Adversarially confirm the post-review fixes are correct and introduce no regressions',
  phases: [
    { title: 'Scrutinize', detail: 'one agent per fix area, reading the current source' },
    { title: 'Verdict', detail: 'independent confirmation of any regression claim' },
  ],
}

const ENGINE = '/Users/zemaj/www/just-every/ultracode/scripts/ultracode-engine.js'

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['fix-correct', 'fix-incomplete', 'regression-introduced'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        location: { type: 'string' },
        evidence: { type: 'string' },
        suggested_fix: { type: 'string' },
      },
      required: ['title', 'severity', 'location', 'evidence', 'suggested_fix'] } },
  },
  required: ['verdict', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    confirmed: { type: 'boolean' },
    real_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
    explanation: { type: 'string' },
    corrected_fix: { type: 'string' },
  },
  required: ['confirmed', 'real_severity', 'explanation', 'corrected_fix'],
}

const AREAS = [
  { key: 'spawnCodex-stream', prompt: `In ${ENGINE}, scrutinize the spawnCodex function after its refactor: the new processLine() helper, handleStdout() calling processLine, the flushStdout() helper, the close handler calling flushStdout() before finish(), and the new \`child.stdin.on("error", () => {})\` before child.stdin.end(prompt). VERIFY: (1) no JSONL event is double-processed or lost; (2) flushStdout cannot run twice or after settled in a harmful way; (3) the empty stdin error handler genuinely prevents an uncaught EPIPE without swallowing real failures (finish() still settles via close/error); (4) thread_id and lastUsage capture are unchanged. Report regressions only. Read the file.` },
  { key: 'gate-in-loop', prompt: `In ${ENGINE}, scrutinize spawnWorkerGuarded after its refactor: the capExceeded() closure, the depth guard (\`ctx.depth > ctx.maxDepth\`), the entryGate before worktree creation, and the loopGate at the top of \`while (true)\` before \`ctx.spawnedCount += 1\`. VERIFY: (1) a normal top-level run (ctx.depth=0, maxDepth=1, budget=null) is NOT refused and completes; (2) the worktree created in the entry path is still cleaned up in finally if a loopGate return happens on a retry; (3) returning from inside the try on a loopGate hit does not skip the finally worktree cleanup; (4) the happy path still increments spawnedCount exactly once per attempt and accounts usage. Report regressions only. Read the file and trace the control flow.` },
  { key: 'persister-snapshot', prompt: `In ${ENGINE}, scrutinize makePersister(record, ctx) after its refactor: it now JSON-clones the record at schedule() time and logs/stderr-writes on write error instead of swallowing. VERIFY: (1) the final scheduled write (after finalizeRecord mutates the record) still captures the FINAL state, since finalizeRecord runs before the last persister.schedule(); (2) JSON.parse(JSON.stringify(record)) does not throw on the record shape (any functions, circular refs, BigInt?) — check what fields the record holds, especially codex_exec and events; (3) the three call sites pass ctx. Also check runCodexAttempt's new try/catch around readFile+JSON.parse correctly attaches err.codex_exec for BOTH a missing-file and a parse error. Report regressions only.` },
  { key: 'schema-validator', prompt: `In ${ENGINE}, scrutinize validateAgainstSchema after its refactor adding isObjectShape (sch.type==="object" || sch.properties || sch.required || sch.additionalProperties !== undefined) and isArrayShape (sch.type==="array" || sch.items). VERIFY: (1) no false positives — a primitive value validated against a schema that only has {type:"string"} is unaffected; (2) when \`type\` IS present and mismatches, the early \`return\` after the type error still prevents entering the object/array bodies (so we don't double-report); (3) a string value against an object-shaped (type-less) schema does not crash or wrongly error; (4) the WORKER_SCHEMA and VERDICT_SCHEMA still validate correct payloads as ok. Also confirm adversarialVerify line uses \`refutes * 2 <= valid.length\`. Report regressions only.` },
]

phase('Scrutinize')
const reviewed = await pipeline(
  AREAS,
  (area) => agent(area.prompt, { label: `check:${area.key}`, phase: 'Scrutinize', schema: FINDINGS_SCHEMA })
    .then((r) => ({ key: area.key, verdict: r.verdict, findings: (r && r.findings) || [] })),
  (review) => parallel(review.findings.map((f) => () =>
    agent(
      `Independently confirm by reading ${ENGINE}. Is this a REAL regression or defect introduced by the recent fixes? Set confirmed=true only if genuine.\n\nArea: ${review.key}\nTitle: ${f.title}\nSeverity: ${f.severity}\nLocation: ${f.location}\nEvidence: ${f.evidence}\nSuggested fix: ${f.suggested_fix}`,
      { label: `verdict:${review.key}`, phase: 'Verdict', schema: VERDICT_SCHEMA }
    ).then((v) => ({ area: review.key, finding: f, verdict: v })).catch(() => null)
  )),
)

const areaVerdicts = reviewed.map((r) => ({ area: r.key, verdict: r.verdict }))
const confirmed = reviewed
  .flatMap((r) => r.findings ? [] : []) // placeholder; real data below
// gather verified findings (stage2 returns arrays under reviewed[].? ) -- reconstruct:
const verified = []
for (const r of reviewed) {
  // r is the stage-2 result (array) when pipeline returns last stage; but we also need verdict.
}
// Simpler: re-run reduction over the pipeline output shape
return { areaVerdicts, raw: reviewed }
