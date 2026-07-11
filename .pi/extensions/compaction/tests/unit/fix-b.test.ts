import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _internals, llmMergeGoal, type MergeCaller } from "../../bridge.js";

// Fix B is config-gated on env. We flip the env per-test and restore after,
// and inject the merge caller so no network call is made.
const ENABLED_ENV = {
  PI_COMPACTION_FIXB_ENABLED: "1",
  PI_COMPACTION_LLM_URL: "https://llm.example/v1/chat/completions",
  PI_COMPACTION_LLM_API_KEY: "test-key",
  PI_COMPACTION_LLM_MODEL: "test-model",
};

const savedEnv: Record<string, string | undefined> = {};
const savedCaller = _internals.mergeCaller;

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  // Ensure a clean slate every test.
  for (const k of Object.keys(ENABLED_ENV)) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _internals.mergeCaller = savedCaller;
});

describe("llmMergeGoal (Fix B)", () => {
  const baseOpts = {
    previousSummary: "## Goal\nMigrate research skill onto engine\n",
    candidateGoal: "Fix the compaction goal-recency regression",
  };

  it("is OFF by default — returns null when the enable flag is unset", async () => {
    const caller = vi.fn();
    _internals.mergeCaller = caller as unknown as MergeCaller;
    const result = await llmMergeGoal(baseOpts);
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled(); // never even reaches the caller
  });

  it("returns null (fallback to Fix A) when enabled but config is incomplete", async () => {
    setEnv({ PI_COMPACTION_FIXB_ENABLED: "1" }); // no URL/key/model
    const caller = vi.fn();
    _internals.mergeCaller = caller as unknown as MergeCaller;
    const result = await llmMergeGoal(baseOpts);
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled();
  });

  it("returns the merged goal (clamped to 500 chars) when enabled and configured", async () => {
    setEnv(ENABLED_ENV);
    _internals.mergeCaller = (async () =>
      "Fix compaction goal-recency, carrying engine-migration context") as MergeCaller;
    const result = await llmMergeGoal(baseOpts);
    expect(result).toBe("Fix compaction goal-recency, carrying engine-migration context");
  });

  it("clamps an over-long merged goal to 500 chars", async () => {
    setEnv(ENABLED_ENV);
    _internals.mergeCaller = (async () => "x".repeat(900)) as MergeCaller;
    const result = await llmMergeGoal(baseOpts);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(500);
  });

  it("returns null immediately when the caller's signal is already aborted", async () => {
    setEnv(ENABLED_ENV);
    const caller = vi.fn(async () => "should not be used");
    _internals.mergeCaller = caller as unknown as MergeCaller;
    const controller = new AbortController();
    controller.abort();
    const result = await llmMergeGoal({ ...baseOpts, signal: controller.signal });
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled();
  });

  it("falls back to null (never throws) when the caller rejects", async () => {
    setEnv(ENABLED_ENV);
    _internals.mergeCaller = (async () => {
      throw new Error("provider 500");
    }) as MergeCaller;
    const result = await llmMergeGoal(baseOpts);
    expect(result).toBeNull();
  });

  it("falls back to null when the caller aborts mid-flight (timeout budget)", async () => {
    setEnv(ENABLED_ENV);
    _internals.mergeCaller = ((_cfg, _opts, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as MergeCaller;
    const result = await llmMergeGoal({ ...baseOpts, timeoutMs: 20 });
    expect(result).toBeNull();
  });

  it("cascades the caller's abort signal into the internal controller", async () => {
    setEnv(ENABLED_ENV);
    let observedAbort = false;
    _internals.mergeCaller = ((_cfg, _opts, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve(null);
          },
          { once: true }
        );
      })) as MergeCaller;
    const controller = new AbortController();
    const p = llmMergeGoal({ ...baseOpts, signal: controller.signal });
    controller.abort();
    const result = await p;
    expect(observedAbort).toBe(true);
    expect(result).toBeNull();
  });
});
