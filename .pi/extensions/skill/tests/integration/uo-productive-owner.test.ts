/** Complete registered owner evidence; no live provider, event injection or policy override. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCurrentShippingBuild,
  OrchestrationService,
  initializePennyState,
  type SkillResult,
} from "@penny/orchestration";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import skillExtension from "../../index.js";
import { assessment, repository } from "../helpers/uo-continuation-fixture.js";
import {
  productiveSummaryFixture,
  type SummaryActivity,
} from "../helpers/uo-productive-summary-fixture.js";

// Bind to the verified current build once; never refresh the expected generation mid-run.
const compiledGeneration = requireDefined(
  assertCurrentShippingBuild(),
  "compiled identity absent"
).generation;

const injection = vi.hoisted(() => ({
  client: undefined as
    | ((
        options: ConstructorParameters<typeof OrchestrationService>[0]
      ) => NonNullable<ConstructorParameters<typeof OrchestrationService>[0]["modelClient"]>)
    | undefined,
}));
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        super({
          ...options,
          modelClient: requireDefined(injection.client, "offline client absent")(options),
        });
      }
    },
  };
});
interface PublicSkill {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}
function isPublicSkill(value: unknown): value is PublicSkill {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  injection.client = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(requireDefined(assertCurrentShippingBuild(), "compiled identity absent").generation).toBe(
    compiledGeneration
  );
});
function fixture(activity: SummaryActivity) {
  expect(requireDefined(assertCurrentShippingBuild(), "compiled identity absent").generation).toBe(
    compiledGeneration
  );
  const f = productiveSummaryFixture(activity);
  cleanups.push(f.cleanup);
  const env = {
    PROJECT_ROOT: f.projectRoot,
    PENNY_STATE_ROOT: `${f.root}/state`,
    PI_CODING_AGENT_DIR: f.agentDir,
    PENNY_SKILLS_DIR: `${repository}/.pi/skills`,
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_API_KEY: "offline-fixture-only",
    PI_OBSERVABILITY_REST_URL: "http://telemetry.invalid",
    PENNY_TOOL_RESULT_MAX_BYTES: "6000",
    PI_COMPACTION_SUMMARY_MODEL: "",
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const requests: string[] = [];
  vi.stubGlobal("fetch", async () => {
    requests.push("blocked fetch");
    throw new Error("External network forbidden");
  });
  initializePennyState(f.projectRoot, { env: process.env });
  injection.client = f.client;
  let selected: PublicSkill | undefined;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(tool) {
        if (isPublicSkill(tool)) selected = tool;
      },
    })
  );
  const tool = requireDefined(selected, "public skill absent");
  const run = () =>
    tool.execute(
      "productive-owner",
      {
        skill_name: "assess",
        session_id: "productive-owner",
        goal: assessment.goal,
        constraints: assessment.constraints,
        model: "faux/continuation",
      },
      undefined,
      undefined,
      {
        cwd: f.projectRoot,
        isProjectTrusted: () => true,
        ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
      }
    );
  // Only the test clock changes. Real fs/SQLite/SDK setImmediate work remains live.
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
  return { ...f, run, requests };
}
type Fixture = ReturnType<typeof fixture>;
function firstWorker(f: Fixture) {
  return requireDefined(f.observations[0], "worker absent");
}
function runId(f: Fixture) {
  return requireDefined(firstWorker(f).invocation.workflowSession).run_id;
}
function lease(f: Fixture) {
  return requireDefined(firstWorker(f).invocation.livenessBudget).inactivity_lease.interval_ms;
}
function owner(f: Fixture) {
  return new OrchestrationService({ projectRoot: f.projectRoot, playbookName: "assess" });
}
function assertRegisteredLease(f: Fixture, service: OrchestrationService) {
  expect(lease(f)).toBe(600_000); // Read the actual policy; never set a test deadline.
  const events = service.checkpointer.events(runId(f));
  expect(
    requireDefined(events.find((event) => event.eventType === "liveness_worker_lease_bound"))
      .payload.binding
  ).toMatchObject({
    provider_id: "faux",
    model_id: "continuation",
    inactivity_interval_ms: lease(f),
  });
  expect(
    requireDefined(events.find((event) => event.eventType === "liveness_policy_bound")).payload
      .policy
  ).toMatchObject({ renewal_policy: "trusted_host_activity_or_convergence_v1" });
}
function renewals(f: Fixture, service: OrchestrationService) {
  // Durable owner evidence, not a spy on constructor arguments or a synthetic sink.
  return service.checkpointer
    .events(runId(f))
    .filter(
      (event) =>
        event.eventType === "liveness_progress_observed" &&
        typeof event.payload.at_ms === "number" &&
        event.payload.at_ms > f.summaryStart() &&
        event.payload.at_ms < (f.summaryEnd() ?? Infinity)
    )
    .map((event) => ({
      at_ms: event.payload.at_ms,
      activity_class: event.payload.activity_class,
      observed_units: event.payload.observed_units,
    }));
}
function evidence(f: Fixture, service: OrchestrationService, outcome: string) {
  process.stdout.write(
    `${JSON.stringify({
      suite: "uo-productive-owner",
      outcome,
      lease_ms: lease(f),
      summary_span_ms: Date.now() - f.summaryStart(),
      summary_calls: f.summaries(),
      provider_deltas: f.deltas,
      durable_summary_progress: renewals(f, service),
      summary_message_updates: f.summaryMessageUpdates(),
      workers: f.observations.length,
      compaction_starts: f.observations.flatMap((entry) => entry.reasons),
      persisted_compactions: f.observations.reduce(
        (count, entry) =>
          count +
          entry.session.sessionManager.getEntries().filter((item) => item.type === "compaction")
            .length,
        0
      ),
      exact_inputs: f.observations.reduce((count, entry) => count + entry.readIds.length, 0),
      ranges: f.observations.reduce((count, entry) => count + entry.rangeReads, 0),
      shutdowns: f.observations.map((entry) => entry.shutdown),
      blocked_fetches: f.requests.length,
    })}\n`
  );
}
function assertIncomplete(
  f: Fixture,
  service: OrchestrationService,
  result: { details: SkillResult }
) {
  expect(result.details).toMatchObject({ success: false, state: "incomplete" });
  const first = firstWorker(f);
  expect(first.invocation.signal?.aborted).toBe(true);
  expect(first.invocation.signal?.reason).toMatchObject({
    name: "LivenessExhaustedError",
    reason: "worker_inactivity_lease_expired",
  });
  expect(f.summaryAborted()).toBe(true);
  expect(first.reasons).toEqual(["overflow"]);
  expect(
    first.session.sessionManager.getEntries().filter((item) => item.type === "compaction")
  ).toEqual([]);
  expect(f.observations).toHaveLength(1);
  expect(first.shutdown).toBe(1);
  const checkpoint = requireDefined(service.checkpointer.loadRunById(runId(f)));
  expect(checkpoint.status).toBe("incomplete");
  expect(
    checkpoint.selectedArtifacts.some(
      (ref) =>
        ref.phase === first.invocation.stateId && ref.producer === `agent:${first.invocation.agent}`
    )
  ).toBe(false);
  expect(service.checkpointer.completionAdmission(runId(f))).toBeUndefined();
  expect(f.requests).toEqual([]);
}

describe("complete registered owner productive native summary (frozen compiled generation)", () => {
  it("renews from actual nonempty SDK summary deltas beyond the original interval, then completes exact custody", async () => {
    const f = fixture("productive");
    const execution = f.run();
    await f.started;
    const first = firstWorker(f);
    using service = owner(f);
    assertRegisteredLease(f, service);
    const spacing = (lease(f) * 3) / 5;
    for (let n = 1; n <= 3; n++) {
      await vi.advanceTimersByTimeAsync(spacing);
      expect(f.deltas).toHaveLength(n);
      expect(renewals(f, service)).toEqual(
        f.deltas.map((delta) => ({
          ...delta,
          activity_class: "assistant_text_delta",
        }))
      );
      expect(f.deltas.every((delta) => delta.observed_units > 0)).toBe(true);
      expect(first.invocation.signal?.aborted).toBe(false);
      expect(first.session.isCompacting).toBe(true);
      expect(
        first.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
      ).toEqual([]);
      expect(service.checkpointer.completionAdmission(runId(f))).toBeUndefined();
    }
    expect(Date.now() - f.summaryStart()).toBeGreaterThan(lease(f));
    // Native result()-only summaries do NOT arrive as assistant message_update events.
    expect(f.summaryMessageUpdates()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    f.finish();
    const { details } = await execution;
    expect(details).toMatchObject({ success: true, state: "complete" });
    expect(f.observations.map((entry) => entry.invocation.stateId)).toEqual([
      "analyzing_assessment",
      "authoring_assessment",
      "verifying_assessment",
    ]);
    const compactions = first.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).not.toBe(true);
    expect(compactions[0]?.summary).toContain(first.invocation.task);
    expect(
      first.session.sessionManager.getEntries().some((entry) => entry.type === "context_edit")
    ).toBe(true);
    expect(first.resumed).toBeGreaterThan(0);
    expect(f.observations.some((entry) => entry.rangeReads > entry.readIds.length)).toBe(true);
    for (const entry of f.observations) {
      expect(entry.shutdown).toBe(1);
      expect(entry.unexpectedTools).toEqual([]);
      expect(entry.readIds).toEqual(entry.invocation.inputArtifacts.map((ref) => ref.artifact_id));
      expect(entry.rangeReads).toBeGreaterThanOrEqual(entry.readIds.length);
      for (const ref of entry.invocation.inputArtifacts)
        expect(entry.readBytes.get(ref.artifact_id)).toBe(
          service.artifacts.read(ref).toString("utf8")
        );
      const output = requireDefined(
        service.checkpointer
          .loadRunById(runId(f))
          ?.selectedArtifacts.find(
            (ref) =>
              ref.phase === entry.invocation.stateId &&
              ref.producer === `agent:${entry.invocation.agent}`
          )
      );
      expect(service.artifacts.read(output).toString("utf8")).toBe(entry.expected);
      const transcript = readFileSync(
        requireDefined(entry.session.sessionManager.getSessionFile()),
        "utf8"
      );
      expect(transcript).toContain("excluded fixture reasoning");
    }
    expect(
      service.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: {
          schema_version: 2,
          run_id: runId(f),
          session_id: "productive-owner",
          playbook: "assess",
          engine_owner: "typescript",
        },
      })
    ).toMatchObject({ action: "complete", met: true });
    expect(service.checkpointer.completionAdmission(runId(f))).toBeDefined();
    const product = requireDefined(details.output_artifact_ref);
    expect(service.artifacts.read(product).byteLength).toBe(product.byte_length);
    expect(JSON.stringify(details)).toContain("unknown");
    expect(f.requests).toEqual([]);
    expect(f.summaries()).toBe(1);
    expect(renewals(f, service)).toEqual(
      f.deltas.map((delta) => ({
        ...delta,
        activity_class: "assistant_text_delta",
      }))
    );
    evidence(f, service, "complete");
  });

  it.each(["silent", "empty"] as const)(
    "%s native provider activity cannot renew the registered lease",
    async (activity) => {
      const f = fixture(activity);
      const execution = f.run();
      await f.started;
      using service = owner(f);
      assertRegisteredLease(f, service);
      await vi.advanceTimersByTimeAsync(lease(f) - 1);
      expect(firstWorker(f).invocation.signal?.aborted).toBe(false);
      expect(renewals(f, service)).toEqual([]);
      expect(f.deltas).toHaveLength(activity === "empty" ? 3 : 0);
      expect(f.deltas.every((delta) => delta.observed_units === 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      assertIncomplete(f, service, await execution);
      expect(Date.now() - f.summaryStart()).toBe(lease(f));
      expect(renewals(f, service)).toEqual([]);
      evidence(f, service, `${activity}:incomplete`);
    }
  );

  it("expires exactly one interval after the last productive delta, not after total elapsed work", async () => {
    const f = fixture("productive");
    const execution = f.run();
    await f.started;
    using service = owner(f);
    assertRegisteredLease(f, service);
    await vi.advanceTimersByTimeAsync((lease(f) * 9) / 5);
    expect(f.deltas).toHaveLength(3);
    expect(renewals(f, service)).toHaveLength(3);
    const last = requireDefined(f.deltas.at(-1));
    await vi.advanceTimersByTimeAsync(lease(f) - 1);
    expect(firstWorker(f).invocation.signal?.aborted).toBe(false);
    expect(firstWorker(f).session.isCompacting).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    assertIncomplete(f, service, await execution);
    expect(Date.now() - last.at_ms).toBe(lease(f));
    expect(Date.now() - f.summaryStart()).toBe((lease(f) * 14) / 5);
    expect(renewals(f, service)).toEqual(
      f.deltas.map((delta) => ({
        ...delta,
        activity_class: "assistant_text_delta",
      }))
    );
    evidence(f, service, "productive-then-silent:incomplete");
  });
});
