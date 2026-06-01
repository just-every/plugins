"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { compileSteps, renderTemplate, getPath } = engine._internal;

const DEFAULTS = { cwd: process.cwd(), sandbox: "read-only", model: undefined, reasoning_effort: undefined, timeout_ms: 60000 };

function compile(steps, defaults = DEFAULTS) {
  return compileSteps(steps, defaults);
}

// ---------------------------------------------------------------------------
// compileSteps validation (all must throw BEFORE any spawn)
// ---------------------------------------------------------------------------

test("compileSteps rejects an empty / non-array steps", () => {
  assert.throws(() => compile([]), /non-empty array/);
  assert.throws(() => compile(null), /non-empty array/);
});

test("compileSteps rejects duplicate ids", () => {
  assert.throws(
    () =>
      compile([
        { id: "a", prompt: "p1" },
        { id: "a", prompt: "p2" }
      ]),
    /"a" is duplicated/
  );
});

test("compileSteps rejects unknown depends_on id", () => {
  assert.throws(
    () => compile([{ id: "a", prompt: "p", depends_on: ["ghost"] }]),
    /depends_on unknown step "ghost"/
  );
});

test("compileSteps rejects a cycle A->B->A via Kahn", () => {
  assert.throws(
    () =>
      compile([
        { id: "a", prompt: "pa", depends_on: ["b"] },
        { id: "b", prompt: "pb", depends_on: ["a"] }
      ]),
    /form a cycle/
  );
});

test("compileSteps rejects a self-dependency", () => {
  assert.throws(() => compile([{ id: "a", prompt: "p", depends_on: ["a"] }]), /cannot depend on itself/);
});

test("compileSteps rejects a template referencing an id NOT in depends_on", () => {
  assert.throws(
    () =>
      compile([
        { id: "a", prompt: "make findings" },
        { id: "b", prompt: "use {{steps.a.output}}" } // no depends_on:[a]
      ]),
    /references "a" which is not in its depends_on/
  );
});

test("compileSteps rejects verify whose findings_from is not in depends_on", () => {
  assert.throws(
    () =>
      compile([
        { id: "review", prompt: "review" },
        { id: "v", kind: "verify", prompt: "verify", findings_from: "review", depends_on: [] }
      ]),
    /findings_from "review" must be listed in its depends_on/
  );
});

test("compileSteps rejects a bad id charset and missing prompt", () => {
  assert.throws(() => compile([{ id: "bad id", prompt: "p" }]), /must match/);
  assert.throws(() => compile([{ id: "a" }]), /prompt/);
});

test("compileSteps accepts a valid DAG and normalizes per-step opts", () => {
  const { compiled, byId } = compile([
    { id: "scout", prompt: "scout {{round}} not used here? no" },
    { id: "review", prompt: "review using {{steps.scout.output}}", depends_on: ["scout"] },
    {
      id: "verify",
      kind: "verify",
      prompt: "n/a",
      findings_from: "review",
      findings_path: "findings",
      skeptics: 5,
      lenses: ["security"],
      depends_on: ["review"]
    }
  ]);
  assert.strictEqual(compiled.length, 3);
  assert.strictEqual(byId.get("scout").kind, "worker");
  assert.strictEqual(byId.get("verify").kind, "verify");
  assert.strictEqual(byId.get("verify").skeptics, 5);
  assert.deepStrictEqual(byId.get("verify").lenses, ["security"]);
  assert.strictEqual(byId.get("review").schema, engine.WORKER_SCHEMA);
});

test("compileSteps loop/parallel defaults", () => {
  const { byId } = compile([
    { id: "loop", kind: "loop", prompt: "find round {{round}}" },
    { id: "par", kind: "parallel", prompt: "do {{item.k}}", items: [{ k: "x" }, { k: "y" }] }
  ]);
  assert.strictEqual(byId.get("loop").dry_rounds, 2);
  assert.strictEqual(byId.get("loop").max_rounds, 10);
  assert.deepStrictEqual(byId.get("par").items, [{ k: "x" }, { k: "y" }]);
});

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

test("renderTemplate {{steps.x.output}} pretty-prints an object", () => {
  const scope = { steps: { x: { summary: "s", findings: ["f1", "f2"] } } };
  const out = renderTemplate("OUT:\n{{steps.x.output}}", scope);
  assert.ok(out.includes('"summary": "s"'));
  assert.ok(out.includes('"f1"'));
});

test("renderTemplate {{steps.x.output.findings}} serializes an array", () => {
  const scope = { steps: { x: { findings: ["f1", "f2"] } } };
  const out = renderTemplate("F:{{steps.x.output.findings}}", scope);
  assert.ok(out.includes('"f1"') && out.includes('"f2"'));
});

test("renderTemplate {{steps.x.summary}} pulls output.summary", () => {
  const scope = { steps: { x: { summary: "the gist" } } };
  assert.strictEqual(renderTemplate("S:{{steps.x.summary}}", scope), "S:the gist");
});

test("renderTemplate {{round}} and {{item.key}}", () => {
  assert.strictEqual(renderTemplate("round={{round}}", { round: 3, steps: {} }), "round=3");
  assert.strictEqual(renderTemplate("k={{item.k}}", { item: { k: "v" }, steps: {} }), "k=v");
});

test("renderTemplate raw-string dep output is inserted verbatim", () => {
  const scope = { steps: { x: "raw text result" } };
  assert.strictEqual(renderTemplate("X:{{steps.x.output}}", scope), "X:raw text result");
});

test("renderTemplate throws on an unresolved step token (no silent blank)", () => {
  assert.throws(() => renderTemplate("{{steps.y.output}}", { steps: {} }), /unresolved token \{\{steps\.y\.output\}\}/);
});

test("renderTemplate throws on an unrecognized token", () => {
  assert.throws(() => renderTemplate("{{nonsense}}", { steps: {} }), /unrecognized token/);
});

test("renderTemplate throws when {{round}} used without a round scope", () => {
  assert.throws(() => renderTemplate("{{round}}", { steps: {} }), /outside a loop step/);
});

// ---------------------------------------------------------------------------
// getPath
// ---------------------------------------------------------------------------

test("getPath drills dot-paths and returns base on empty path", () => {
  const obj = { a: { b: [10, 20] }, summary: "s" };
  assert.deepStrictEqual(getPath(obj, "a.b"), [10, 20]);
  assert.strictEqual(getPath(obj, "summary"), "s");
  assert.strictEqual(getPath(obj, ""), obj);
  assert.strictEqual(getPath(obj, "a.missing"), undefined);
  assert.strictEqual(getPath(undefined, "a"), undefined);
});
