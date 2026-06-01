"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { validateAgainstSchema, WORKER_SCHEMA, VERDICT_SCHEMA } = engine;

test("valid object passes with no errors", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"]
  };
  const r = validateAgainstSchema({ a: "hi" }, schema);
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test("wrong-type property reports 'a: expected string'", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"]
  };
  const r = validateAgainstSchema({ a: 123 }, schema);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes("a: expected string"), JSON.stringify(r.errors));
});

test("type-less object schema still enforces required => 'a: required'", () => {
  const schema = { properties: { a: { type: "string" } }, required: ["a"] };
  const r = validateAgainstSchema({}, schema);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes("a: required"), JSON.stringify(r.errors));
});

test("enum miss reports '(root): must be one of [...]'", () => {
  const schema = { enum: ["low", "high"] };
  const r = validateAgainstSchema("medium", schema);
  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.startsWith("(root): must be one of")),
    JSON.stringify(r.errors)
  );
});

test("additionalProperties:false reports 'b: unexpected property'", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" } }
  };
  const r = validateAgainstSchema({ a: "ok", b: "nope" }, schema);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes("b: unexpected property"), JSON.stringify(r.errors));
});

test("array items recursion validates each element", () => {
  const schema = { type: "array", items: { type: "string" } };
  const r = validateAgainstSchema(["a", 5, "c"], schema);
  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes("[1]: expected string")),
    JSON.stringify(r.errors)
  );
});

test("fails OPEN on an unknown keyword (minLength)", () => {
  // minLength is not implemented; the validator must not reject valid output.
  const schema = { type: "string", minLength: 100 };
  const r = validateAgainstSchema("short", schema);
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test("WORKER_SCHEMA round-trips good and bad data", () => {
  const good = {
    summary: "s",
    findings: [],
    recommended_actions: [],
    risks: [],
    verification: [],
    confidence: "high"
  };
  assert.strictEqual(validateAgainstSchema(good, WORKER_SCHEMA).ok, true);

  const badConfidence = { ...good, confidence: "extreme" };
  const r = validateAgainstSchema(badConfidence, WORKER_SCHEMA);
  assert.strictEqual(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.startsWith("confidence: must be one of")),
    JSON.stringify(r.errors)
  );

  const missing = { summary: "s" };
  const r2 = validateAgainstSchema(missing, WORKER_SCHEMA);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.includes("findings: required"), JSON.stringify(r2.errors));
});

test("VERDICT_SCHEMA round-trips good and bad data", () => {
  assert.strictEqual(
    validateAgainstSchema({ refuted: true, reason: "x" }, VERDICT_SCHEMA).ok,
    true
  );
  const r = validateAgainstSchema({ refuted: "yes", reason: "x" }, VERDICT_SCHEMA);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes("refuted: expected boolean"), JSON.stringify(r.errors));
});
