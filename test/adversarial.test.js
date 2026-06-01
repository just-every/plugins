"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine, MOCK, withCodexCliPath, withMockEnv, freshCounterPath } = require("./helpers/env.js");
const { adversarialVerify, VERDICT_SCHEMA, createContext } = engine;

// adversarialVerify does NOT accept a codex_bin option; its internal spawnWorker
// calls fall back to defaultCodexBin(), which honors CODEX_CLI_PATH first. So
// these tests wire the mock through CODEX_CLI_PATH, not codex_bin.

const NOT_REFUTED = JSON.stringify({ refuted: false, reason: "looks real" });
const REFUTED = JSON.stringify({ refuted: true, reason: "cannot confirm" });

test("default verdicts (not refuted), 3 skeptics: finding survives", async () => {
  const survivors = await withCodexCliPath(MOCK, async () =>
    withMockEnv({ MOCK_CODEX_RESPONSE: NOT_REFUTED }, async () => {
      const ctx = createContext({ concurrency: 3 });
      return adversarialVerify(["a real finding"], { ctx, skeptics: 3, schema: VERDICT_SCHEMA });
    })
  );
  assert.deepStrictEqual(survivors, ["a real finding"]);
});

test("1-of-2 tie SURVIVES (refutes*2 <= valid.length)", async () => {
  // Alternate refuted across the 2 skeptic spawns of the single finding via the
  // counter file: even invocation => not refuted, odd invocation => refuted.
  // That yields exactly 1 refute of 2 valid votes; 1*2 <= 2 => survives.
  const counter = freshCounterPath();
  const survivors = await withCodexCliPath(MOCK, async () =>
    withMockEnv(
      {
        MOCK_CODEX_COUNTER: counter,
        MOCK_CODEX_RESPONSE: NOT_REFUTED,
        MOCK_CODEX_ALT_RESPONSE: REFUTED
      },
      async () => {
        const ctx = createContext({ concurrency: 2 });
        return adversarialVerify(["tie finding"], { ctx, skeptics: 2, schema: VERDICT_SCHEMA });
      }
    )
  );
  assert.deepStrictEqual(survivors, ["tie finding"], "a 1-of-2 tie must survive");
});

test("2-of-2 refutes: finding DIES (strict majority refute)", async () => {
  const survivors = await withCodexCliPath(MOCK, async () =>
    withMockEnv({ MOCK_CODEX_RESPONSE: REFUTED }, async () => {
      const ctx = createContext({ concurrency: 2 });
      return adversarialVerify(["doomed finding"], { ctx, skeptics: 2, schema: VERDICT_SCHEMA });
    })
  );
  assert.deepStrictEqual(survivors, [], "2-of-2 refutes kills the finding");
});
