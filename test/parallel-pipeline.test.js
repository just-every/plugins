"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { runParallel, runPipeline, createContext } = engine;

test("runParallel degrades a throwing slot to null with stable length + drop log", async () => {
  const ctx = createContext({ concurrency: 4 });
  const thunks = [
    async () => "zero",
    async () => {
      throw new Error("slot one boom");
    },
    async () => "two"
  ];
  const results = await runParallel(thunks, { ctx });
  assert.strictEqual(results.length, 3, "array length stays stable");
  assert.strictEqual(results[0], "zero");
  assert.strictEqual(results[1], null, "throwing slot becomes null");
  assert.strictEqual(results[2], "two");

  const dropLog = ctx.events.find(
    (e) => e.type === "log" && /dropped to null/.test(e.message) && e.data && e.data.index === 1
  );
  assert.ok(dropLog, "a drop log must be emitted for the throwing slot");
});

test("runPipeline drops one item at a failing stage, others flow to completion", async () => {
  const ctx = createContext({ concurrency: 4 });
  const items = ["a", "b", "c"]; // indices 0,1,2

  const stages = [
    // stage 0: throws only for item index 1
    async (acc, item, index) => {
      if (index === 1) throw new Error("stage0 fail for item 1");
      return `${acc}-s0`;
    },
    async (acc) => `${acc}-s1`,
    async (acc) => `${acc}-s2`
  ];

  const results = await runPipeline(items, stages, { ctx });
  assert.strictEqual(results.length, 3, "ordering and length preserved");
  assert.strictEqual(results[0], "a-s0-s1-s2");
  assert.strictEqual(results[1], null, "item 1 dropped to null at the failing stage");
  assert.strictEqual(results[2], "c-s0-s1-s2");

  const dropLog = ctx.events.find(
    (e) => e.type === "log" && /dropped at stage 0/.test(e.message) && e.data && e.data.index === 1
  );
  assert.ok(dropLog, "a pipeline drop log must be emitted for item 1 at stage 0");
});
