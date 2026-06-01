// ultracode example: parallel fan-out -> filter -> map -> sort reduction.
//
// Run it (against the real codex, or the mock for a dry run):
//   node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
//     --args '{"files":["src/a.js","src/b.js","src/c.js"]}'
//
// To exercise it for free against the mock codex:
//   CODEX_CLI_PATH=test/fixtures/mock-codex.js \
//   node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
//     --args '{"files":["a.js","b.js","c.js"]}' --concurrency 3
//
// WARNING: a script runs arbitrary Node.js in-process with full host
// privileges. It is NOT sandboxed. Only run scripts you trust.

const files = Array.isArray(args && args.files) && args.files.length
  ? args.files
  : ["alpha.js", "beta.js", "gamma.js"];

phase("inspect");
log(`fanning out over ${files.length} file(s)`, { count: files.length });

// One agent per file, all bounded by the shared concurrency limiter. Each
// agent() resolves to its structured value object (or null on failure).
const reports = await parallel(
  files.map((file) => () =>
    agent(`Inspect the file ${file}. Report a one-line summary, any risks, and a confidence.`)
  )
);

// Reduction: drop failures (null), tag each surviving report with its file,
// then sort deterministically by confidence (high > medium > low) and summary.
const rank = { high: 0, medium: 1, low: 2 };
const reduced = reports
  .map((report, index) => (report ? { file: files[index], ...report } : null))
  .filter(Boolean)
  .map((entry) => ({
    file: entry.file,
    summary: entry.summary,
    confidence: entry.confidence,
    risk_count: Array.isArray(entry.risks) ? entry.risks.length : 0
  }))
  .sort((a, b) => {
    const byConfidence = (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9);
    return byConfidence !== 0 ? byConfidence : String(a.summary).localeCompare(String(b.summary));
  });

log(`kept ${reduced.length} of ${files.length} report(s)`, {
  kept: reduced.length,
  dropped: files.length - reduced.length
});

export default {
  inspected: files.length,
  kept: reduced.length,
  reports: reduced
};
