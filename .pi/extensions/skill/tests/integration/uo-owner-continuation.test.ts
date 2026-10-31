/** Complete public registered-skill path with compiled owners and provider-free cognition.
 * No SDK prompt/session mocks. Faux cognition is not production-model qualification,
 * semantic assessment, a private-resolver qualification, or an OS sandbox.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestrationService, initializePennyState, type SkillResult } from "@penny/orchestration";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import skillExtension from "../../index.js";
import {
  assessment,
  continuationFixture,
  repository,
  type ContinuationMode,
} from "../helpers/uo-continuation-fixture.js";

// Inject only offline model wiring into the actual compiled service. All owners,
// transitions, artifacts and compaction use the declared shipping package exports.
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
        const create = injection.client;
        if (create === undefined) throw new Error("Missing offline SDK wiring");
        super({ ...options, modelClient: create(options) });
      }
    },
  };
});
interface SkillTool {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}
function isSkillTool(value: unknown): value is SkillTool {
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
});
function fixture(mode: ContinuationMode) {
  const cancellation = new AbortController();
  const f = continuationFixture(mode, cancellation);
  cleanups.push(f.cleanup);
  vi.stubEnv("PROJECT_ROOT", f.projectRoot);
  vi.stubEnv("PENNY_STATE_ROOT", `${f.root}/state`);
  vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
  vi.stubEnv("PENNY_SKILLS_DIR", `${repository}/.pi/skills`);
  vi.stubEnv("PI_OBSERVABILITY_ENABLED", "false");
  vi.stubEnv("PI_OBSERVABILITY_API_KEY", "offline-fixture-only");
  vi.stubEnv("PI_OBSERVABILITY_REST_URL", "http://telemetry.invalid");
  vi.stubEnv("PENNY_TOOL_RESULT_MAX_BYTES", "6000");
  vi.stubEnv("PI_COMPACTION_SUMMARY_MODEL", "");
  const blockedRequests: string[] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
    blockedRequests.push(String(input));
    throw new Error("External network forbidden");
  });
  initializePennyState(f.projectRoot, { env: process.env });
  injection.client = f.client;
  let tool: SkillTool | undefined;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(value) {
        if (isSkillTool(value)) tool = value;
      },
    })
  );
  const publicTool = requireDefined(tool, "Public skill tool absent");
  const run = () =>
    publicTool.execute(
      "continuation",
      {
        skill_name: "assess",
        session_id: "owner-continuation",
        goal: assessment.goal,
        constraints: assessment.constraints,
        model: "faux/continuation",
      },
      cancellation.signal,
      undefined,
      {
        cwd: f.projectRoot,
        isProjectTrusted: () => true,
        ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
      }
    );
  return { ...f, run, blockedRequests };
}

function evidence(f: ReturnType<typeof fixture>, terminal: string) {
  process.stdout.write(
    `${JSON.stringify({
      suite: "uo-owner-continuation",
      terminal,
      provider_calls: f.faux.state.callCount,
      blocked_telemetry_attempts: f.blockedRequests.length,
      workers: f.observations.map((entry) => ({
        state: entry.invocation.stateId,
        inactivity_lease_ms: entry.invocation.livenessBudget?.inactivity_lease.interval_ms,
        compaction_reasons: entry.reasons,
        persisted_compactions: entry.session.sessionManager
          .getEntries()
          .filter((item) => item.type === "compaction").length,
        context_edits: entry.session.sessionManager
          .getEntries()
          .filter((item) => item.type === "context_edit").length,
        exact_inputs_read: entry.readIds.length,
        complete_continuity_artifacts_read: entry.handoffReads.size,
        artifact_ranges_consumed: entry.rangeReads,
        artifact_read_executions: entry.readExecutions,
        shutdowns: entry.shutdown,
      })),
    })}\n`
  );
}

describe("public registered-skill SDK continuation (compiled owners, offline)", () => {
  it.each(["penny-threshold", "native-overflow"] as const)(
    "%s: resumes the actual assignment, reads every exact range, captures complete output and admits honest completion",
    async (mode) => {
      const f = fixture(mode);
      const { details } = await f.run();
      expect(details).toMatchObject({ success: true, state: "complete" });
      expect(f.observations.map((entry) => entry.invocation.stateId)).toEqual([
        "analyzing_assessment",
        "authoring_assessment",
        "verifying_assessment",
      ]);
      const first = requireDefined(f.observations[0], "first worker absent");
      expect(first.reasons).toEqual(
        mode === "penny-threshold" ? ["threshold", "threshold"] : ["overflow"]
      );
      expect(first.resumed).toBeGreaterThan(0);
      const compactions = first.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(mode === "penny-threshold" ? 2 : 1);
      expect(compactions[0]?.fromHook === true).toBe(mode === "penny-threshold");
      if (mode === "penny-threshold") {
        expect(compactions[0]?.summary).toContain("Worker Continuity");
        expect(first.handoffReads.size).toBe(1);
        expect(compactions.at(-1)?.summary).toContain(first.handoffId);
        expect(first.handoffReads.has(first.handoffId)).toBe(true);
        expect(first.restoredOpening).toContain(first.invocation.task);
      } else
        expect(
          first.session.sessionManager.getEntries().some((entry) => entry.type === "context_edit")
        ).toBe(true);
      using owner = new OrchestrationService({
        projectRoot: f.projectRoot,
        playbookName: "assess",
      });
      for (const entry of f.observations) {
        for (const [id, bytes] of entry.handoffReads)
          expect(owner.artifacts.readById(id).toString("utf8")).toBe(bytes);
        expect(entry.shutdown).toBe(1);
        expect(entry.unexpectedTools).toEqual([]);
        expect(entry.rangeReads).toBeGreaterThanOrEqual(entry.readIds.length);
        expect(entry.readExecutions).toBeGreaterThanOrEqual(entry.rangeReads);
        expect(entry.readIds).toEqual(
          entry.invocation.inputArtifacts.map((ref) => ref.artifact_id)
        );
        for (const ref of entry.invocation.inputArtifacts)
          expect(entry.readBytes.get(ref.artifact_id)).toBe(
            owner.artifacts.read(ref).toString("utf8")
          );
        const runId = requireDefined(
          entry.invocation.workflowSession,
          "workflow correlation absent"
        ).run_id;
        const output = requireDefined(
          owner.checkpointer
            .loadRunById(runId)
            ?.selectedArtifacts.find(
              (ref) =>
                ref.phase === entry.invocation.stateId &&
                ref.producer === `agent:${entry.invocation.agent}`
            ),
          "captured stage output absent"
        );
        expect(owner.artifacts.read(output).toString("utf8")).toBe(entry.expected);
        const transcriptFile = requireDefined(
          entry.session.sessionManager.getSessionFile(),
          "durable SDK session absent"
        );
        expect(readFileSync(transcriptFile, "utf8")).toContain("excluded fixture reasoning");
      }
      const runId = requireDefined(
        first.invocation.workflowSession?.run_id,
        "terminal run ID absent"
      );
      const terminal = owner.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: "owner-continuation",
          playbook: "assess",
          engine_owner: "typescript",
        },
      });
      expect(terminal).toMatchObject({ action: "complete", met: true });
      expect(owner.checkpointer.completionAdmission(runId)).toBeDefined();
      const result = requireDefined(details.output_artifact_ref, "accepted product absent");
      expect(owner.artifacts.read(result).byteLength).toBe(result.byte_length);
      // The real unknown-effects disclosure must survive success; no sandbox claim.
      expect(JSON.stringify(details)).toContain("unknown");
      expect(f.blockedRequests).toHaveLength(mode === "penny-threshold" ? 2 : 0);
      expect(f.blockedRequests.every((url) => url === "http://telemetry.invalid/compactions")).toBe(
        true
      );
      evidence(f, mode + ":complete");
    }
  );

  it("does not promote a failed final provider message after real compaction, even with a success-shaped SUMMARY", async () => {
    const f = fixture("provider-error");
    const failure = await f.run().then(
      () => undefined,
      (error: unknown) => error
    );
    const first = requireDefined(f.observations[0], "worker absent");
    expect(failure).toMatchObject({
      name: "AgentTerminalError",
      stopReason: "error",
      partialText: first.expected,
    });
    expect(first.unexpectedTools).toEqual([]);
    expect(first.reasons).toEqual(["threshold", "threshold"]);
    expect(first.shutdown).toBe(1);
    using owner = new OrchestrationService({ projectRoot: f.projectRoot, playbookName: "assess" });
    const runId = requireDefined(first.invocation.workflowSession, "workflow absent").run_id;
    expect(owner.checkpointer.completionAdmission(runId)).toBeUndefined();
    expect(requireDefined(owner.checkpointer.loadRunById(runId), "run absent").status).not.toBe(
      "complete"
    );
    expect(f.observations).toHaveLength(1);
    expect(
      requireDefined(owner.checkpointer.loadRunById(runId), "run absent").selectedArtifacts.some(
        (ref) =>
          ref.phase === first.invocation.stateId &&
          ref.producer === `agent:${first.invocation.agent}`
      )
    ).toBe(false);
    const pending = requireDefined(
      owner.checkpointer.loadRunById(runId),
      "run absent"
    ).pendingDirective;
    if (pending?.action === "invoke_agent") {
      const meta = pending.output_artifact;
      expect(
        owner.artifacts.refFor(
          meta.run_id,
          meta.phase,
          meta.branch_id,
          meta.kind,
          meta.operation_id,
          meta.version
        )
      ).toBeNull();
    }
    evidence(f, requireDefined(owner.checkpointer.loadRunById(runId), "run absent").status);
    expect(f.blockedRequests.every((url) => url === "http://telemetry.invalid/compactions")).toBe(
      true
    );
  });

  it("cancellation after native threshold compaction cannot become successful completion", async () => {
    const f = fixture("cancel");
    const result = await f.run().then(
      (value) => value,
      (error: unknown) => error
    );
    if (isRecord(result) && isRecord(result.details)) expect(result.details.success).not.toBe(true);
    else expect(result).toBeInstanceOf(Error);
    const first = requireDefined(f.observations[0], "worker absent");
    expect(first.reasons).toEqual(["threshold"]);
    expect(first.invocation.signal?.aborted).toBe(true);
    expect(first.shutdown).toBe(1);
    using owner = new OrchestrationService({ projectRoot: f.projectRoot, playbookName: "assess" });
    const runId = requireDefined(first.invocation.workflowSession, "workflow absent").run_id;
    expect(owner.checkpointer.completionAdmission(runId)).toBeUndefined();
    expect(requireDefined(owner.checkpointer.loadRunById(runId), "run absent").status).not.toBe(
      "complete"
    );
    expect(f.observations).toHaveLength(1);
    expect(
      requireDefined(owner.checkpointer.loadRunById(runId), "run absent").selectedArtifacts.some(
        (ref) =>
          ref.phase === first.invocation.stateId &&
          ref.producer === `agent:${first.invocation.agent}`
      )
    ).toBe(false);
    const pending = requireDefined(
      owner.checkpointer.loadRunById(runId),
      "run absent"
    ).pendingDirective;
    if (pending?.action === "invoke_agent") {
      const meta = pending.output_artifact;
      expect(
        owner.artifacts.refFor(
          meta.run_id,
          meta.phase,
          meta.branch_id,
          meta.kind,
          meta.operation_id,
          meta.version
        )
      ).toBeNull();
    }
    evidence(f, requireDefined(owner.checkpointer.loadRunById(runId), "run absent").status);
    expect(f.blockedRequests.every((url) => url === "http://telemetry.invalid/compactions")).toBe(
      true
    );
  });
  it("expires a silent real native summary under the actual registered inactivity lease, without inventing an elapsed-work cap", async () => {
    const f = fixture("native-silent");
    // Keep filesystem/SDK setImmediate work real; advance only the owner's existing lease.
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const execution = f.run();
    const settled = execution.then(
      (value) => value,
      (error: unknown) => error
    );
    await f.started;
    const first = requireDefined(f.observations[0], "worker absent");
    const lease = requireDefined(
      first.invocation.livenessBudget,
      "registered lease absent"
    ).inactivity_lease;
    await vi.advanceTimersByTimeAsync(lease.interval_ms);
    const outcome = await settled;
    // Public owner maps measured liveness exhaustion to a durable non-positive result.
    if (!isRecord(outcome) || !isRecord(outcome.details))
      throw new Error("Missing liveness terminal result");
    expect(outcome.details).toMatchObject({ success: false, state: "incomplete" });
    expect(first.reasons).toEqual(["overflow"]);
    expect(
      first.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
    ).toHaveLength(0);
    expect(first.invocation.signal?.aborted).toBe(true);
    expect(f.summaryAborted()).toBe(true);
    expect(first.shutdown).toBe(1);
    using owner = new OrchestrationService({ projectRoot: f.projectRoot, playbookName: "assess" });
    const runId = requireDefined(first.invocation.workflowSession, "workflow absent").run_id;
    expect(requireDefined(owner.checkpointer.loadRunById(runId), "run absent").status).toBe(
      "incomplete"
    );
    expect(owner.checkpointer.completionAdmission(runId)).toBeUndefined();
    expect(f.blockedRequests).toEqual([]);
    evidence(f, "silent-summary:incomplete");
  });
});
