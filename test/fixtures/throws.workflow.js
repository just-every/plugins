// Tiny path-mode fixture that throws after logging. The runner must journal
// status:'failed' with the error message and partial events, without crashing
// the host. Compiles only through the runner transform.
log("about to throw");
throw new Error("boom from fixture");
