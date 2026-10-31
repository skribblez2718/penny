/** Complete direct public owner evidence, not private/workflow parity or an OS sandbox. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCurrentShippingBuild, resolveWorkerLeaseProfile } from "@penny/orchestration";
import { readArtifactById } from "../../../artifacts/owner-client.js";
import { getFinalOutput } from "../../agent-runner.js";
import { isRecord, requireDefined, requireRecord } from "../../../../lib/tests/test-narrowers.js";
import { directFixture, compiledGeneration } from "./uo-direct-fixture.js";
import { inputBytes, finalBytes, failedBytes, cancelledBytes } from "./uo-direct-child.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(
      requireDefined(assertCurrentShippingBuild(), "compiled identity absent").generation
    ).toBe(compiledGeneration);
  }
});
async function fixture(mode: Parameters<typeof directFixture>[0]) {
  const f = await directFixture(mode, (cleanup) => cleanups.push(cleanup));
  return f;
}
function verifyContinuation(f: Awaited<ReturnType<typeof fixture>>, reason: string) {
  const observations = f.observations();
  expect(
    observations.filter(
      (entry) => entry.type === "forbidden_fetch" || entry.type === "forbidden_network"
    )
  ).toEqual([]);
  const starts = observations.filter((entry) => entry.type === "before_compact");
  expect(starts.length).toBeGreaterThan(0);
  expect(starts.every((entry) => entry.reason === reason)).toBe(true);
  const compacted = f.entries().filter((entry) => entry.type === "compaction");
  expect(compacted.length).toBe(starts.length);
  expect(compacted.every((entry) => entry.fromHook !== true)).toBe(true);
  expect(observations.filter((entry) => entry.type === "compacted")).toHaveLength(compacted.length);
  expect(observations.filter((entry) => entry.type === "native_summary").length).toBeGreaterThan(0);
  expect(
    observations.some(
      (entry) =>
        entry.type === "resumed" && entry.exactAssignment === true && entry.roleAndFrame === true
    )
  ).toBe(true);
  expect(
    requireDefined(observations.find((entry) => entry.type === "assignment")).activeTools
  ).toEqual(f.names);
  const ranges = observations.filter((entry) => entry.type === "range");
  expect(ranges.length).toBeGreaterThan(1);
  expect(ranges[0]?.start).toBe(0);
  let position = 0;
  let text = "";
  for (const entry of ranges) {
    expect(entry.start).toBe(position);
    if (typeof entry.content !== "string" || typeof entry.end !== "number")
      throw new Error("Invalid observed range");
    position += Buffer.byteLength(entry.content);
    expect(entry.end).toBe(position);
    text += entry.content;
    if (entry.truncated === true) expect(requireRecord(entry.next).start).toBe(position);
  }
  expect(ranges.at(-1)?.truncated).toBe(false);
  expect(position).toBe(f.input.byte_length);
  expect(Buffer.from(text)).toEqual(Buffer.from(inputBytes));
  const entries = f.entries();
  expect(
    entries.some(
      (entry) =>
        entry.type === "custom" &&
        typeof entry.customType === "string" &&
        entry.customType.includes("continuity")
    )
  ).toBe(false);
  return { starts: starts.length, persisted: compacted.length, ranges: ranges.length };
}
async function verifyDelivery(
  f: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<typeof f.run>>,
  bytes: string
) {
  const worker = requireDefined(result.details.results[0], "public owner worker absent");
  expect(worker).toMatchObject({
    processState: "closed",
    processExitObserved: true,
    processCloseObserved: true,
    outputArtifactState: "persisted",
  });
  expect(getFinalOutput(worker.messages)).toBe(bytes);
  const ref = requireDefined(result.details.finalOutputArtifactRef, "exact output delivery absent");
  expect(worker.outputArtifactRef).toEqual(ref);
  expect(result.details.outputArtifactRefs).toEqual([ref]);
  expect(result.content.map((part) => part.text).join("\n")).toContain(ref.artifact_id);
  const read = await readArtifactById({
    artifactId: ref.artifact_id,
    projectRoot: f.projectRoot,
    env: process.env,
  });
  expect(read.ref).toEqual(ref);
  expect(read.content).toEqual(Buffer.from(bytes));
  expect(ref.byte_length).toBe(Buffer.byteLength(bytes));
  expect(read.content.toString()).not.toContain("excluded direct fixture reasoning");
  return worker;
}
function evidence(
  mode: string,
  counts: { starts: number; persisted: number; ranges: number },
  status: unknown
) {
  process.stdout.write(
    JSON.stringify({
      suite: "uo-direct-owner-continuation",
      generation: compiledGeneration,
      mode,
      ...counts,
      status,
    }) + "\n"
  );
}

describe("public direct subagent continuation (real SDK child, offline compiled owners)", () => {
  it.each(["threshold", "overflow"] as const)(
    "%s: succeeds after native continuation with exact final delivery and no abandoned error",
    async (mode) => {
      const f = await fixture(mode);
      const result = await f.run();
      const worker = await verifyDelivery(f, result, finalBytes);
      expect(worker.exitCode).toBe(0);
      expect(worker.stopReason).toBe("stop");
      expect(worker.errorMessage).toBeUndefined();
      expect(worker.inactivityExpired).toBe(false);
      expect(result.isError).not.toBe(true);
      expect(result.details.outcome).toMatchObject({
        status: "succeeded",
        completed: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        delivered: 1,
        deliveryFailed: 0,
      });
      expect(worker.terminalOutcome).toMatchObject({
        status: "completed",
        reason: "assistant_completed",
      });
      const counts = verifyContinuation(f, mode);
      expect(f.observations().filter((entry) => entry.type === "shutdown")).toHaveLength(1);
      const final = requireDefined(
        f
          .entries()
          .filter(
            (entry) =>
              entry.type === "message" &&
              isRecord(entry.message) &&
              entry.message.role === "assistant"
          )
          .at(-1)
      );
      expect(JSON.stringify(final)).toContain("excluded direct fixture reasoning");
      if (mode === "overflow") {
        expect(f.entries().some((entry) => entry.type === "context_edit")).toBe(true);
        expect(
          worker.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.errorMessage === "This model's maximum context length is 131072 tokens"
          )
        ).toBe(true);
      }
      evidence(mode, counts, worker.terminalOutcome);
    }
  );

  it("preserves exact success-shaped failed-provider partial bytes without promoting them", async () => {
    const f = await fixture("provider-error");
    const result = await f.run();
    const worker = await verifyDelivery(f, result, failedBytes);
    expect(result.isError).toBe(true);
    expect(worker.terminalOutcome).toMatchObject({ status: "failed", reason: "assistant_error" });
    expect(worker.stopReason).toBe("error");
    expect(worker.errorMessage).toBe("Offline provider terminal failure");
    expect(result.details.outcome).toMatchObject({
      status: "failed",
      succeeded: 0,
      delivered: 1,
      failed: 1,
    });
    const counts = verifyContinuation(f, "threshold");
    evidence("provider-error", counts, worker.terminalOutcome);
  });

  it("caller cancellation after real compaction retains exact completed partial message, never success", async () => {
    const f = await fixture("cancel");
    const result = await f.run();
    const worker = await verifyDelivery(f, result, cancelledBytes);
    expect(result.isError).toBe(true);
    expect(worker.wasAborted).toBe(true);
    expect(worker.inactivityExpired).toBe(false);
    expect(worker.terminalOutcome).toMatchObject({
      status: "cancelled",
      reason: "caller_cancelled",
    });
    expect(result.details.outcome).toMatchObject({
      status: "cancelled",
      succeeded: 0,
      delivered: 1,
      cancelled: 1,
    });
    const counts = verifyContinuation(f, "threshold");
    evidence("cancel", counts, worker.terminalOutcome);
  });

  it("expires a silent actual native summary using the production direct inactivity policy and only a fake parent clock", async () => {
    const f = await fixture("silent");
    const started = f.summaryStarted();
    // Child clocks, SDK, print mode, provider, pipes and filesystem remain real.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const execution = f.run();
    await Promise.race([
      started,
      execution.then((result) => {
        throw new Error(
          `Child settled before native summary: ${JSON.stringify(result.details.outcome)}; observations=${f
            .observations()
            .map((entry) => entry.type)
            .join(",")}`
        );
      }),
    ]);
    const lease = resolveWorkerLeaseProfile({
      providerId: "faux",
      modelId: "direct-continuation",
      purpose: "phase",
    });
    let settled = false;
    void execution.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(lease.inactivity_interval_ms - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Restore real lifecycle grace timers after firing the actual owner lease.
    vi.useRealTimers();
    const result = await execution;
    expect(result.isError).toBe(true);
    const worker = await verifyDelivery(f, result, "Abandoned overflow attempt");
    expect(worker.processExitObserved).toBe(true);
    expect(worker.processCloseObserved).toBe(true);
    expect(worker.wasAborted).toBe(true);
    expect(worker.inactivityExpired).toBe(true);
    expect(worker.stopReason).toBe("error");
    expect(
      worker.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.errorMessage === "This model's maximum context length is 131072 tokens"
      )
    ).toBe(true);
    // Owner inactivity is an execution/lifecycle failure, not caller cancellation or an
    // assistant error; the abandoned attempt remains captured but is no longer diagnostic truth.
    expect(worker.errorMessage).toBe("Agent inactivity lease expired without trusted progress");
    expect(worker.terminalOutcome).toMatchObject({
      status: "failed",
      reason: "process_lifecycle",
    });
    expect(result.details.outcome).toMatchObject({
      status: "failed",
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      delivered: 1,
      deliveryFailed: 0,
    });
    const starts = f.observations().filter((entry) => entry.type === "before_compact");
    expect(starts.map((entry) => entry.reason)).toEqual(["overflow"]);
    expect(f.entries().filter((entry) => entry.type === "compaction")).toEqual([]);
    expect(f.entries().some((entry) => entry.type === "context_edit")).toBe(true);
    expect(f.observations().some((entry) => entry.type === "native_summary")).toBe(true);
    expect(
      f
        .observations()
        .filter((entry) => entry.type === "forbidden_fetch" || entry.type === "forbidden_network")
    ).toEqual([]);
    evidence(
      `silent:lease=${lease.inactivity_interval_ms}`,
      { starts: starts.length, persisted: 0, ranges: 0 },
      worker.terminalOutcome
    );
  });
});
