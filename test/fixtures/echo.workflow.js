// Tiny path-mode fixture for the script-runner tests. Spawns exactly one agent
// against the mock codex and returns a small structured result. Uses the
// runner's bound scope (agent/log/phase/args) + `export default`, so it only
// compiles through the runner's transform (NOT node --check-able standalone).
phase("echo");
log("echo workflow start", { who: args && args.who });
const value = await agent(`echo hello ${args && args.who ? args.who : "world"}`);
export default {
  ok: value !== null,
  who: (args && args.who) || "world",
  value
};
