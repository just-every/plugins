"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine } = require("./helpers/env.js");
const { createLimiter } = engine;

function defer(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("createLimiter bounds peak concurrency to max", async () => {
  const lim = createLimiter(2);
  assert.strictEqual(lim.max, 2);

  let cur = 0;
  let peak = 0;
  const thunk = () => async () => {
    cur += 1;
    peak = Math.max(peak, cur);
    await defer(15);
    cur -= 1;
    return "ok";
  };

  const results = await Promise.all(Array.from({ length: 6 }, () => lim.run(thunk())));
  assert.strictEqual(results.length, 6);
  assert.ok(peak <= 2, `peak ${peak} should not exceed 2`);
  assert.ok(peak === 2, `peak should reach the bound (got ${peak})`);
});

test("active()/queued() reflect backpressure", async () => {
  const lim = createLimiter(2);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  // Three slow thunks: 2 run immediately, 1 queues.
  const p = [
    lim.run(() => gate),
    lim.run(() => gate),
    lim.run(() => gate)
  ];
  // Let the limiter drain synchronously-scheduled work.
  await defer(5);
  assert.strictEqual(lim.active(), 2, "two tasks should be active");
  assert.strictEqual(lim.queued(), 1, "one task should be queued");

  release();
  await Promise.all(p);
  assert.strictEqual(lim.active(), 0);
  assert.strictEqual(lim.queued(), 0);
});

test("a rejecting thunk still drains the queue", async () => {
  const lim = createLimiter(1);
  const order = [];

  const a = lim.run(async () => {
    order.push("a");
    throw new Error("boom");
  });
  const b = lim.run(async () => {
    order.push("b");
    return "b-done";
  });

  await assert.rejects(a, /boom/);
  const bResult = await b;
  assert.strictEqual(bResult, "b-done");
  assert.deepStrictEqual(order, ["a", "b"], "b must run after a rejected");
});
