// ultracode example: a budget-bounded discovery loop.
//
// loopUntilDry() repeatedly spawns a "finder" agent until it sees a run of dry
// rounds OR a guard trips (max rounds / token budget / lifetime agent cap). The
// shared ctx enforces ONE budget across every spawn, so passing --budget-tokens
// caps the total spend of the whole loop, not per-agent.
//
// Run it for free against the mock codex:
//   CODEX_CLI_PATH=test/fixtures/mock-codex.js \
//   node scripts/ultracode-cli.js script examples/budget-loop.workflow.js \
//     --budget-tokens 5000 --max-agents 6 --concurrency 2
//
// WARNING: a script runs arbitrary Node.js in-process with full host
// privileges. It is NOT sandboxed. Only run scripts you trust.

const topic = (args && typeof args.topic === "string" && args.topic) || "potential bugs in this workspace";
const maxRounds = (args && Number(args.max_rounds)) || 4;

phase("discover");
log(`budget=${budget.total === null ? "unbounded" : budget.total} tokens; topic="${topic}"`, {
  budget: budget.total,
  topic
});

// Each round asks for a fresh batch of findings. The loop stops on 2 dry rounds,
// maxRounds, or when the shared token budget is exhausted (all logged in events).
const findings = await loopUntilDry(
  (round) =>
    `Discovery round ${round + 1}. Find NEW ${topic} not reported before. ` +
    `Return findings (possibly empty) with summaries and confidence.`,
  { maxRounds, dryRounds: 2 }
);

const flat = findings
  .flatMap((batch) => (batch && Array.isArray(batch.findings) ? batch.findings : []))
  .filter((f) => typeof f === "string" && f.trim());

log(`discovered ${flat.length} finding(s) across ${findings.length} productive round(s)`, {
  findings: flat.length,
  rounds: findings.length
});

export default {
  topic,
  rounds_with_findings: findings.length,
  findings: flat,
  spent_tokens: budget.spent(),
  remaining_tokens: budget.remaining() === Infinity ? null : budget.remaining()
};
