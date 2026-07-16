/**
 * Bridge resilience — retry policy.
 *
 * The memory bridge is a per-call Python process (ChromaDB + embeddings). Under
 * heavy load it was observed to die intermittently by SIGNAL during startup
 * (Node reports exit code `null`, empty stderr). These pure helpers decide which
 * failures are transient (retryable) vs terminal, and the backoff schedule.
 */
import { describe, it, expect, vi } from "vitest";
import { isRetryableBridgeExit, bridgeRetryBackoffMs, retryTransient } from "../../index.js";

const RETRYABLE = Object.assign(new Error("signal-killed"), { retryable: true });
const TERMINAL = Object.assign(new Error("clean error exit"), { retryable: false });
const isRetryable = (e: unknown) => (e as { retryable?: boolean } | null)?.retryable === true;
const noSleep = () => Promise.resolve();

describe("isRetryableBridgeExit", () => {
  it("RETRIES a signal-kill (code null) — the observed native-crash symptom", () => {
    expect(isRetryableBridgeExit(null, "SIGKILL")).toBe(true);
    expect(isRetryableBridgeExit(null, "SIGSEGV")).toBe(true);
    expect(isRetryableBridgeExit(null, null)).toBe(true); // code null with no signal is still a non-clean death
  });

  it("RETRIES when a non-null signal is reported even if a code is present", () => {
    expect(isRetryableBridgeExit(137, "SIGKILL")).toBe(true);
  });

  it("does NOT retry a clean non-zero exit (the bridge ran and reported an error)", () => {
    expect(isRetryableBridgeExit(1, null)).toBe(false);
    expect(isRetryableBridgeExit(2, null)).toBe(false);
  });
});

describe("bridgeRetryBackoffMs", () => {
  it("uses an increasing schedule, capped", () => {
    expect(bridgeRetryBackoffMs(0)).toBe(150);
    expect(bridgeRetryBackoffMs(1)).toBe(400);
  });

  it("defaults to the cap for out-of-range attempts", () => {
    expect(bridgeRetryBackoffMs(2)).toBe(400);
    expect(bridgeRetryBackoffMs(99)).toBe(400);
  });
});

describe("retryTransient (retry behavior)", () => {
  const opts = (over = {}) => ({
    maxAttempts: 3,
    isRetryable,
    backoffMs: bridgeRetryBackoffMs,
    sleep: noSleep,
    ...over,
  });

  it("retries a transient failure then returns the success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(RETRYABLE)
      .mockRejectedValueOnce(RETRYABLE)
      .mockResolvedValueOnce({ ok: true });
    const out = await retryTransient(fn, opts());
    expect(out).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a terminal (non-retryable) failure", async () => {
    const fn = vi.fn().mockRejectedValue(TERMINAL);
    await expect(retryTransient(fn, opts())).rejects.toBe(TERMINAL);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(RETRYABLE);
    const onRetry = vi.fn();
    await expect(retryTransient(fn, opts({ onRetry }))).rejects.toBe(RETRYABLE);
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2); // only between attempts
  });

  it("succeeds on the first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: 1 });
    expect(await retryTransient(fn, opts())).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
