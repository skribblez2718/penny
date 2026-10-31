/** Scripted cognition and process/VM observations; NOT native isolation/provider evidence. */
import { readdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationService } from "../dist/service.js";
import { validateContract } from "../dist/contracts.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { ScaSemanticDiagnosticSchema } from "../dist/sca/ordinary-semantic.js";
import * as shared from "../dist/sca/ordinary-advanced-contracts.js";
import * as nativeApp from "../../sca-service/src/ordinary-application-tests.js";
import * as nativeLearning from "../../sca-service/src/ordinary-rule-learning-contracts.js";
import {
  environment,
  roots,
  PROJECT_ROOT,
  start,
  identity,
  fixtureAdapters,
} from "./helpers/sca-local-workflow.js";
import type {
  HostOperationCachedResultV1,
  HostOperationResultCacheV1,
} from "../dist/host-operations/result-cache.js";
import { AdvancedScriptedClient, advancedFixture } from "./helpers/sca-advanced-workflow.js";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness(
  result: "completed" | "unknown" | "unsupported" = "completed",
  promotion = true,
  rescan = true
) {
  const env = environment(),
    fixture = advancedFixture(result, promotion, rescan),
    client = new AdvancedScriptedClient();
  const options = {
    projectRoot: PROJECT_ROOT,
    playbookName: "sca",
    env,
    modelClient: client,
    hostOperationAdapters: fixtureAdapters("noalert"),
    scaAdvanced: fixture.host,
  };
  const runId = `advanced-${result}-${promotion}-${rescan}`;
  const request = {
    ...start(runId),
    constraints: {
      ...start(runId).constraints,
      execution_mode: "propose_stronger_evidence",
      advanced: fixture.advanced,
    },
  };
  return { env, fixture, client, options, runId, request };
}
function bind(service: OrchestrationService, client: AdvancedScriptedClient) {
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
}
function report(service: OrchestrationService, runId: string) {
  const ref = service.checkpointer
    .loadRunById(runId)
    ?.selectedArtifacts.find((x) => x.kind === "semantic-core");
  if (ref === undefined) throw new Error("Missing report");
  return validateContract(
    ScaReportProductSchema,
    JSON.parse(service.artifacts.readById(ref.artifact_id).toString("utf8")),
    "Exact report"
  );
}
describe("ordinary advanced schema handshakes", () => {
  it("requires explicit closed container profile/resources rather than reinterpreting VM consent", () => {
    environment();
    const vm = advancedFixture("completed", false, false).advanced.application_tests[0];
    if (
      vm === undefined ||
      !("vm_timeout_seconds" in vm.resources) ||
      !("vm_timeout_seconds" in vm.maxima)
    )
      throw new Error("Missing VM input");
    const { vm_timeout_seconds, ...r } = vm.resources,
      { vm_timeout_seconds: maximum, ...m } = vm.maxima;
    const container = {
      ...vm,
      isolation: "container",
      profile: "docker-local-no-network-v1",
      resources: { ...r, operation_timeout_seconds: vm_timeout_seconds },
      maxima: { ...m, operation_timeout_seconds: maximum },
    };
    expect(() =>
      validateContract(shared.ScaApplicationInputSchema, vm, "Legacy caller")
    ).not.toThrow();
    expect(() =>
      validateContract(shared.ScaApplicationInputSchema, container, "Explicit caller")
    ).not.toThrow();
    const { profile, ...absentProfile } = container;
    for (const mutant of [
      absentProfile,
      { ...container, profile: profile + "-other" },
      { ...container, resources: vm.resources },
      { ...container, isolation: undefined },
      { ...container, isolation: "vm" },
      { ...container, host_image: "unadmitted" },
    ])
      expect(() =>
        validateContract(shared.ScaApplicationInputSchema, mutant, "Rejected caller")
      ).toThrow();
  });
  it("pins native application and empirical wire schemas", () => {
    for (const [a, b] of [
      [shared.OrdinaryApplicationTestPlanSchema, nativeApp.OrdinaryApplicationTestPlanSchema],
      [shared.OrdinaryApplicationTestPolicySchema, nativeApp.OrdinaryApplicationTestPolicySchema],
      [shared.OrdinaryApplicationTestRequestSchema, nativeApp.OrdinaryApplicationTestRequestSchema],
      [
        shared.OrdinaryApplicationContainerResourcesSchema,
        nativeApp.OrdinaryApplicationContainerResourcesSchema,
      ],
      [
        shared.OrdinaryApplicationContainerPlanSchema,
        nativeApp.OrdinaryApplicationContainerPlanSchema,
      ],
      [
        shared.OrdinaryApplicationContainerPolicySchema,
        nativeApp.OrdinaryApplicationContainerPolicySchema,
      ],
      [
        shared.OrdinaryApplicationExecutionPlanSchema,
        nativeApp.OrdinaryApplicationExecutionPlanSchema,
      ],
      [
        shared.OrdinaryApplicationExecutionPolicySchema,
        nativeApp.OrdinaryApplicationExecutionPolicySchema,
      ],
      [
        shared.OrdinaryApplicationRuntimeConfigSchema,
        nativeApp.OrdinaryApplicationRuntimeConfigSchema,
      ],
      [
        shared.OrdinaryApplicationContainerConfigSchema,
        nativeApp.OrdinaryApplicationContainerConfigSchema,
      ],
      [shared.OrdinaryApplicationVmConfigSchema, nativeApp.OrdinaryApplicationVmConfigSchema],
      [shared.OrdinaryApplicationTestResultSchema, nativeApp.OrdinaryApplicationTestResultSchema],
      [shared.ScaRuleLearningRequestSchema, nativeLearning.ScaRuleLearningRequestSchema],
      [shared.ScaRuleLearningRecordSchema, nativeLearning.ScaRuleLearningRecordSchema],
      [shared.ScaRulePromotionRequestSchema, nativeLearning.ScaRulePromotionRequestSchema],
      [shared.ScaRuleRescanRequestSchema, nativeLearning.ScaRuleRescanRequestSchema],
    ])
      expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
describe("registered advanced host lifecycle with explicitly scripted observations", () => {
  it("journals created-container correlation without a service suffix and seals exact V2 caller closure", async () => {
    const h = harness("completed", false, false),
      vm = h.fixture.advanced.application_tests[0],
      factory = h.fixture.host.applicationFactory;
    if (
      vm === undefined ||
      factory === undefined ||
      !("vm_timeout_seconds" in vm.resources) ||
      !("vm_timeout_seconds" in vm.maxima)
    )
      throw new Error("Missing fixture operands");
    const { vm_timeout_seconds, ...r } = vm.resources,
      { vm_timeout_seconds: maximum, ...m } = vm.maxima;
    h.fixture.advanced.application_tests[0] = {
      ...vm,
      isolation: "container",
      profile: "docker-local-no-network-v1",
      resources: { ...r, operation_timeout_seconds: vm_timeout_seconds },
      maxima: { ...m, operation_timeout_seconds: maximum },
    };
    let correlation = "";
    using service = new OrchestrationService({
      ...h.options,
      scaAdvanced: {
        applicationFactory: (authority) => ({
          async run(request, owner) {
            correlation = `penny-app-${sha256(canonicalJson(request))}`;
            const result = await factory(authority).run(request, {
              ...owner,
              beforeSubmit: () => owner.beforeSubmit(correlation),
              accepted: () => owner.accepted(correlation),
            });
            return {
              ...validateContract(
                shared.OrdinaryApplicationTestResultSchema,
                result,
                "Scripted observation"
              ),
              isolation: "CONTAINER",
              evidence_scope:
                "untrusted_container_observation_not_vulnerability_or_isolation_attestation",
            };
          },
        }),
      },
    });
    bind(service, h.client);
    await service.execute(h.request);
    const call = service.checkpointer
      .hostOperationCallsForRun(h.runId)
      .find((x) => x.operation_kind === "sca.application.v1");
    expect(call?.remote_correlation_id).toBe(correlation);
    expect(correlation).toMatch(/^penny-app-[a-f0-9]{64}$/u);
    expect(call?.lifecycle).toBe("consumed");
    const selected = service.checkpointer.loadRunById(h.runId)?.selectedArtifacts ?? [];
    const plan = selected.find((x) => x.kind === "sca-execution-plan"),
      policy = selected.find((x) => x.kind === "sca-execution-policy");
    if (plan === undefined || policy === undefined) throw new Error("Missing V2 artifacts");
    expect(plan.content_schema).toEqual({
      schema_id: "penny.sca-ordinary-application-plan.v2",
      schema_version: 2,
    });
    expect(policy.content_schema).toEqual({
      schema_id: "penny.sca-ordinary-application-policy.v2",
      schema_version: 2,
    });
    const parsed = validateContract(
      shared.OrdinaryApplicationContainerPlanSchema,
      JSON.parse(service.artifacts.readById(plan.artifact_id).toString("utf8")),
      "V2 plan"
    );
    expect(parsed.resources).toEqual({ ...r, operation_timeout_seconds: vm_timeout_seconds });
    expect(parsed.source_corpus_ref).toEqual(selected.find((x) => x.kind === "sca-source-corpus"));
    expect(report(service, h.runId).advanced?.operations[0]).toMatchObject({
      stage: "application",
      isolation: "CONTAINER",
      execution: "RUN",
    });
  });
  it("preserves ambiguous execution after cancellation without replay", async () => {
    const h = harness("completed", false, false),
      controller = new AbortController(),
      factory = h.fixture.host.applicationFactory;
    if (factory === undefined) throw new Error("Missing factory");
    const host = {
      ...h.fixture.host,
      applicationFactory: ((authority) => ({
        async run(value, owner) {
          const result = await factory(authority).run(value, owner);
          controller.abort(new Error("Explicit test cancellation after acceptance"));
          return result;
        },
      })) satisfies NonNullable<typeof factory>,
    };
    using service = new OrchestrationService({ ...h.options, scaAdvanced: host });
    bind(service, h.client);
    const terminal = await service.execute(h.request, controller.signal);
    expect(terminal.action).toBe("cancelled");
    expect(h.fixture.counts().applications).toBe(1);
    expect(report(service, h.runId).reproduction).toBe("UNKNOWN");
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(h.runId) })
    ).toEqual(terminal);
    expect(h.fixture.counts().applications).toBe(1);
  });
  it("retains explicit unsupported application status without claiming execution", async () => {
    const h = harness("unsupported", false, false),
      client = new AdvancedScriptedClient(true, false);
    using service = new OrchestrationService({ ...h.options, modelClient: client });
    bind(service, client);
    const terminal = await service.execute(h.request);
    expect(terminal.action).toBe("incomplete");
    const product = report(service, h.runId);
    expect(product.reproduction).toBe("NOT RUN");
    expect(product.advanced?.operations[0]?.status).toBe("unsupported");
    expect(product.target_executed).toBe(false);
  });

  it.each(["source", "harness", "maxima"] as const)(
    "rejects wrong caller %s binding before application execution",
    async (field) => {
      const h = harness();
      const input = h.fixture.advanced.application_tests[0];
      if (input === undefined) throw new Error("Missing caller test");
      if (field === "source") input.source_snapshot_sha256 = "0".repeat(64);
      if (field === "harness") input.harness.sha256 = "0".repeat(64);
      if (field === "maxima")
        input.resources = { ...input.resources, cpu_seconds: input.maxima.cpu_seconds + 1 };
      using service = new OrchestrationService(h.options);
      bind(service, h.client);
      await expect(service.execute(h.request)).rejects.toThrow();
      expect(h.fixture.counts()).toEqual({ applications: 0, processes: 0 });
      expect(h.client.invocations).toHaveLength(0);
    }
  );
  it("denies a mismatched promotion candidate without release or rescan mutation", async () => {
    const h = harness();
    const grant = h.fixture.advanced.promotions[0];
    if (grant === undefined) throw new Error("Missing grant");
    grant.candidate_sha256 = "0".repeat(64);
    using service = new OrchestrationService(h.options);
    bind(service, h.client);
    const terminal = await service.execute(h.request);
    expect(terminal.action).toBe("incomplete");
    const product = report(service, h.runId);
    expect(product.advanced?.operations.find((x) => x.stage === "promotion")?.status).toBe(
      "denied"
    );
    expect(product.advanced?.operations.find((x) => x.stage === "rescan")?.status).toBe("denied");
    expect(readdirSync(h.fixture.namespace)).toEqual([]);
    expect(h.fixture.counts().processes).toBe(20);
  });
  it("preserves a no-rule outcome without launching an empirical process", async () => {
    const h = harness("completed", false, false),
      client = new AdvancedScriptedClient(true, true, false, true);
    const learning = h.fixture.advanced.learning[0];
    if (learning === undefined) throw new Error("Missing learning input");
    learning.fixtures = [];
    learning.fixture_truth_sha256 = sha256(canonicalJson([]));
    using service = new OrchestrationService({ ...h.options, modelClient: client });
    bind(service, client);
    await service.execute(h.request);
    const product = report(service, h.runId);
    expect(product.advanced?.operations.find((x) => x.stage === "validation")?.status).toBe(
      "not_feasible"
    );
    expect(h.fixture.counts().processes).toBe(0);
    expect(readdirSync(h.fixture.namespace)).toEqual([]);
  });
  it("does not replay an accepted application when the fetch cache is missing", async () => {
    const h = harness("completed", false, false),
      values = new Map<string, HostOperationCachedResultV1>();
    const cache: HostOperationResultCacheV1 = {
      async read(key) {
        return values.get(key) ?? null;
      },
      async write(key, bytes) {
        const value = {
          schema_version: 1 as const,
          request_sha256: key,
          content_sha256: sha256(bytes),
          byte_length: bytes.byteLength,
          bytes,
        };
        values.set(key, value);
        return value;
      },
    };
    using first = new OrchestrationService({
      ...h.options,
      hostOperationResultCache: cache,
      hostOperationFault(point, kind) {
        if (point === "after_fetch" && kind === "sca.application.v1")
          throw new HostOperationSimulatedCrashError(point);
      },
    });
    bind(first, h.client);
    await expect(first.execute(h.request)).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    first.close();
    values.clear();
    using second = new OrchestrationService({ ...h.options, hostOperationResultCache: cache });
    bind(second, h.client);
    const terminal = await second.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(h.runId),
    });
    expect(terminal.action).toBe("incomplete");
    expect(h.fixture.counts().applications).toBe(1);
    expect(report(second, h.runId).reproduction).toBe("UNKNOWN");
    expect(
      second.checkpointer
        .hostOperationCallsForRun(h.runId)
        .find((x) => x.operation_kind === "sca.application.v1")?.disposition?.lease_disposition
    ).toBe("quarantined");
  });
  it("does not expose or run unadmitted application input artifacts", async () => {
    const h = harness("completed", false, false),
      factory = h.fixture.host.applicationFactory;
    if (factory === undefined) throw new Error("Missing scripted factory");
    const host = {
      ...h.fixture.host,
      applicationFactory: ((authority) => ({
        async run(value, owner) {
          const request = validateContract(
            shared.OrdinaryApplicationTestRequestSchema,
            value,
            "Test request"
          );
          owner.readArtifact({ ...request.policy_ref, version: request.policy_ref.version + 1 });
          return factory(authority).run(value, owner);
        },
      })) satisfies NonNullable<typeof factory>,
    };
    using service = new OrchestrationService({ ...h.options, scaAdvanced: host });
    bind(service, h.client);
    const terminal = await service.execute(h.request);
    expect(terminal.action).toBe("incomplete");
    expect(h.fixture.counts().applications).toBe(0);
  });

  it("runs isolated application adapter, empirical validation, immutable promotion and separately admitted rescan", async () => {
    const h = harness();
    using service = new OrchestrationService(h.options);
    bind(service, h.client);
    const terminal = await service.execute(h.request);
    const product = report(service, h.runId);
    expect(product.advanced?.operations.map((x) => [x.stage, x.status])).toEqual([
      ["application", "completed"],
      ["validation", "validated"],
      ["promotion", "promoted"],
      ["rescan", "completed"],
    ]);
    expect(terminal.action).toBe("incomplete");
    expect(product.reproduction).toBe("RUN");
    expect(product.target_executed).toBe(true);
    expect(h.fixture.counts()).toEqual({ applications: 1, processes: 21 });
    expect(readdirSync(h.fixture.namespace)).not.toHaveLength(0);
    const operations = service.checkpointer.hostOperationCallsForRun(h.runId);
    expect(operations).toHaveLength(6);
    expect(operations.every((x) => x.lifecycle === "consumed")).toBe(true);
    const validationCall = operations.find((x) => x.operation_kind === "sca.validation.v1");
    if (validationCall === undefined) throw new Error("Missing original validation");
    const original = validateContract(
      shared.ScaAdvancedRequestSchema,
      JSON.parse(
        service.artifacts.readById(validationCall.request_ref.artifact_id).toString("utf8")
      ),
      "Original validation"
    );
    for (const call of operations.filter((x) =>
      ["sca.validation.v1", "sca.promotion.v1", "sca.rescan.v1"].includes(x.operation_kind)
    )) {
      const request = validateContract(
        shared.ScaAdvancedRequestSchema,
        JSON.parse(service.artifacts.readById(call.request_ref.artifact_id).toString("utf8")),
        "Replay closure"
      );
      expect(request.input_sha256).toBe(sha256(canonicalJson(request.input_bindings)));
      expect(new Set(request.input_bindings.map((x) => x.ref.artifact_id)).size).toBe(
        request.input_bindings.length
      );
      expect(request.input_bindings).toEqual(expect.arrayContaining(original.input_bindings));
      expect(request.input_bindings.map((x) => x.slot)).toEqual(
        expect.arrayContaining([
          "caller",
          "corpus",
          "reconciliation",
          "hypotheses",
          "evidence",
          "assessment",
          "candidate",
        ])
      );
      if (request.stage !== "validation") {
        expect(request.input_bindings.find((x) => x.slot === "validation_request")?.ref).toEqual(
          validationCall.request_ref
        );
        expect(request.input_bindings.find((x) => x.slot === "validation")?.ref).toEqual(
          validationCall.operation_result_ref
        );
      }
    }
    for (const invocation of h.client.invocations) {
      for (const ref of invocation.inputArtifacts) {
        const bytes = service.artifacts.readById(ref.artifact_id).toString("utf8");
        expect(bytes).not.toContain("SCRIPTED_RECEIPT_PRIVATE_ONLY");
        expect(bytes).not.toContain(h.fixture.namespace);
        expect(bytes).not.toContain('"fixture_truth_sha256"');
      }
    }
    const reviews = h.client.invocations.filter(
      (x) => x.stateId === "reviewing_report" || x.stateId === "verifying_final_product"
    );
    expect(
      reviews.every((x) => x.inputArtifacts.some((r) => r.kind === "sca-advanced-summary"))
    ).toBe(true);
  });
  it.each(["sca.application.v1", "sca.validation.v1", "sca.promotion.v1", "sca.rescan.v1"])(
    "recovers exact cached %s without replay",
    async (operation) => {
      const h = harness();
      using first = new OrchestrationService({
        ...h.options,
        hostOperationFault(point, kind) {
          if (point === "after_fetch" && kind === operation)
            throw new HostOperationSimulatedCrashError(point);
        },
      });
      bind(first, h.client);
      await expect(first.execute(h.request)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      first.close();
      const before = h.fixture.counts();
      using second = new OrchestrationService(h.options);
      bind(second, h.client);
      const terminal = await second.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(h.runId),
      });
      expect(terminal.action).toBe("incomplete");
      expect(h.fixture.counts().applications).toBe(1);
      expect(h.fixture.counts().processes).toBe(21);
      if (operation === "sca.rescan.v1") expect(h.fixture.counts()).toEqual(before);
      expect(
        await second.execute({ schema_version: 2, action: "recover", identity: identity(h.runId) })
      ).toEqual(terminal);
    }
  );
  it("retains UNKNOWN with quarantine and a useful partial report", async () => {
    const h = harness("unknown", false, false);
    using service = new OrchestrationService(h.options);
    bind(service, h.client);
    const terminal = await service.execute(h.request);
    expect(terminal.action).toBe("incomplete");
    const product = report(service, h.runId);
    expect(product.reproduction).toBe("UNKNOWN");
    expect(product.target_executed).toBeNull();
    const operation = service.checkpointer
      .hostOperationCallsForRun(h.runId)
      .find((x) => x.operation_kind === "sca.application.v1");
    expect(operation?.disposition?.lease_disposition).toBe("quarantined");
    expect(h.fixture.counts().applications).toBe(1);
  });
  it.each([
    [false, false],
    [true, false],
  ] as const)(
    "does not infer promotion/rescan authority (promotion=%s rescan=%s)",
    async (promotion, rescan) => {
      const h = harness("completed", promotion, rescan);
      using service = new OrchestrationService(h.options);
      bind(service, h.client);
      await service.execute(h.request);
      const product = report(service, h.runId);
      expect(product.advanced?.operations.find((x) => x.stage === "rescan")?.status).toBe(
        "not_requested"
      );
      expect(
        service.checkpointer
          .hostOperationCallsForRun(h.runId)
          .some((x) => x.operation_kind === "sca.rescan.v1")
      ).toBe(false);
      if (!promotion) {
        expect(readdirSync(h.fixture.namespace)).toEqual([]);
        expect(
          service.checkpointer
            .hostOperationCallsForRun(h.runId)
            .some((x) => x.operation_kind === "sca.promotion.v1")
        ).toBe(false);
      }
    }
  );
  it("rejects a model-selected foreign plan without application dispatch", async () => {
    const h = harness();
    const client = new AdvancedScriptedClient(true, true, true);
    using service = new OrchestrationService({ ...h.options, modelClient: client });
    bind(service, client);
    // The client deliberately remains invalid. With no operator iteration limit,
    // the contract is a same-stage revision, not an eventual negative terminal.
    expect(service.config.maxIterations).toBeNull();
    expect(service.config.maxSteps).toBeNull();
    let current = service.engine.handle(h.request);
    const step = async (expected: string) => {
      expect(current).toHaveProperty("state_id", expected);
      current = service.engine.authorizeDispatch(current);
      if (current.action === "invoke_host_operation") {
        expect(current.operation_kind).toBe("sca.preparation.v1");
        const owner = service.hostOperations;
        if (owner === undefined) throw new Error("Missing real host owner");
        current = service.engine.authorizeDispatch(await owner.dispatch(service.engine, current));
        return;
      }
      if (current.action !== "invoke_agent") throw new Error("Expected one finite worker step");
      const settled = await service.workers.executeSettled(current);
      expect(settled.errors).toEqual([]);
      expect(settled.results).toHaveLength(1);
      current = service.engine.authorizeDispatch(
        service.engine.acceptWorkerResults(current.identity, settled.results)
      );
      for (const result of settled.results) service.workers.acceptArtifact(result);
      return settled.results[0];
    };
    for (const state of [
      "preparing_analysis",
      "selecting_scanner_dependency_leads",
      "selecting_underdetected_no_alert_surfaces",
      "forming_hypotheses",
      "challenging_hypotheses",
    ])
      await step(state);
    if (current.action !== "invoke_agent") throw new Error("Missing original action selection");
    expect(current.state_id).toBe("selecting_evidence_actions");
    const original = current;
    const originals = original.input_artifacts.artifacts.map((entry) => entry.ref);
    const originalBytes = originals.map((ref) => service.artifacts.read(ref));
    const rejected = await step("selecting_evidence_actions");
    if (rejected?.output_artifact === undefined) throw new Error("Missing captured foreign plan");
    const context = service.checkpointer.loadRunById(h.runId);
    if (context === undefined) throw new Error("Missing first-rejection checkpoint");
    const diagnosticRef = context.selectedArtifacts.find(
      (ref) => ref.kind === "sca-semantic-diagnostic"
    );
    if (diagnosticRef === undefined) throw new Error("Missing typed first rejection");
    const diagnosticBytes = service.artifacts.read(diagnosticRef);
    expect(sha256(diagnosticBytes)).toBe(diagnosticRef.content_digest);
    expect(diagnosticBytes.byteLength).toBe(diagnosticRef.byte_length);
    const diagnostic = validateContract(
      ScaSemanticDiagnosticSchema,
      JSON.parse(diagnosticBytes.toString("utf8")),
      "First foreign-plan rejection"
    );
    expect(diagnostic).toEqual({
      schema_version: 1,
      state: "selecting_evidence_actions",
      rejected_artifact: rejected.output_artifact,
      original_input_refs: originals,
      predecessor_diagnostic: null,
      rejection_ordinal: 1,
      revision_limit: null,
      failure: {
        code: "input_binding",
        location: "/actions/1/application_plan_id",
        expected_ids: ["admitted-test"],
        expected_pointer: null,
        allowed_ranges: [],
      },
    });
    expect(current).toMatchObject({
      action: "invoke_agent",
      state_id: original.state_id,
      agent: original.agent,
      attempt: original.attempt + 1,
    });
    if (current.action !== "invoke_agent") throw new Error("Missing same-stage revision");
    expect(current.execution_purpose).not.toBe("routing_repair");
    expect(current.task).toContain("SAME-STAGE semantic revision");
    expect(current.input_artifacts.artifacts.map((entry) => entry.ref)).toEqual([
      ...originals,
      diagnostic.rejected_artifact,
      diagnosticRef,
    ]);
    for (const ref of [...originals, diagnostic.rejected_artifact]) {
      const bytes = service.artifacts.read(ref);
      expect(sha256(bytes)).toBe(ref.content_digest);
      expect(bytes.byteLength).toBe(ref.byte_length);
    }
    originals.forEach((ref, index) => {
      expect(service.artifacts.read(ref)).toEqual(originalBytes[index]);
    });
    expect(context.maxIterations).toBeNull();
    expect(context.pendingDirective).toEqual(current);
    expect(context.terminalDirective).toBeNull();
    expect(
      service.checkpointer
        .hostOperationCallsForRun(h.runId)
        .map((call) => [call.operation_kind, call.lifecycle])
    ).toEqual([["sca.preparation.v1", "consumed"]]);
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "selecting_scanner_dependency_leads",
      "selecting_underdetected_no_alert_surfaces",
      "forming_hypotheses",
      "challenging_hypotheses",
      "selecting_evidence_actions",
    ]);
    expect(h.fixture.counts()).toEqual({ applications: 0, processes: 0 });
    expect(
      service.engine.handle({ schema_version: 2, action: "recover", identity: identity(h.runId) })
    ).toEqual(current);
  });
});
