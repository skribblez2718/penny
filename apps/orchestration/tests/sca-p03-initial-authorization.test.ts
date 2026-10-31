import { Type } from "typebox";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signTrustedHumanEvent,
  registerTrustedQuestionnaireTransport,
  renderedQuestionsDigest,
  verifyExecutionOwnerSignature,
  withExecutionOwnerEnvironment,
} from "../../../.pi/extensions/skill/execution-receipts.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { respondToTrustedNativeGateV1 } from "../../../.pi/extensions/skill/trusted-gate-driver.js";
import { ScaP03InitialTransportV1Schema } from "../dist/sca/p03-initial-qualification.js";
import { ArtifactRefSchema, JsonValueSchema, validateContract } from "../dist/contracts.js";
import { ArtifactStore, previewArtifactRef } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import type { HostOperationAdapterV1 } from "../dist/host-operations/contracts.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  validateScaP03InitialProposalV1,
  deriveScaP03InitialCustodyV1,
  assertScaP03InitialControlRefV1,
  type ScaP03InitialProposalV1,
  type ScaP03InitialResourcesV1,
  type ScaP03TrustedInitialProfileV1,
} from "../dist/sca/p03-initial-authorization.js";
import {
  SCA_P03_INITIAL_NAME,
  SCA_P03_INITIAL_WORK_STATE,
  createScaP03InitialQualificationRegistrationV1,
  readScaP03InitialGate,
} from "../dist/sca/p03-initial-qualification.js";
import { createScaP03InitialUseValidatorV1 } from "../../sca-service/src/p03-initial-live.js";

const roots: string[] = [];
const disposables: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of disposables.splice(0).reverse()) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const resources: ScaP03InitialResourcesV1 = {
  cpus: 2,
  memory_bytes: 1_073_741_824,
  pids: 64,
  tmp_bytes: 8_388_608,
  work_bytes: 58_720_256,
  command_output_bytes: 1_048_576,
  concurrency: 1,
  inactivity_ms: 60_000,
  cleanup_grace_ms: 1000,
  max_commands: 128,
  max_source_bytes: 4096,
  max_source_files: 3,
  max_graph_bytes: 1024,
  max_query_bytes: 4096,
  max_query_items: 256,
  max_page_items: 64,
  max_pages_per_query: 4,
  max_ast_depth: 32,
  max_ast_nodes: 256,
  max_num_def: 1000,
  jvm_heap_bytes: 536_870_912,
  max_host_workspace_bytes: 1_048_576,
  max_evidence_bytes: 1_048_576,
};
function fixture(stateRoot?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "p03-initial-unit-"));
  roots.push(root);
  const state = stateRoot ?? path.join(root, "state");
  using catalog = new ProjectCatalog(state, { create: stateRoot === undefined });
  const project = catalog.registerProject(root);
  const store = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: project.projectId,
  });
  disposables.push(store);
  const cp = Checkpointer.provision(path.join(root, "orchestration.db"), undefined, {
    projectId: project.projectId,
  });
  disposables.push(cp);
  const leases = new HostOperationLeaseAuthority(state);
  disposables.push(leases);
  let revoked = false;
  let actor = "operator-test";
  let drift = false;
  let nowOffset = 0;
  const backend = sha256("test-only independently approved shared backend");
  const profile: ScaP03TrustedInitialProfileV1 = {
    now: () => new Date(Date.now() + nowOffset),
    current: () => ({
      principal_id: "operator-test",
      policy_id: "test-initial-only-policy",
      installation_id: "test-installation",
      project_id: project.projectId,
      state_authority_sha256: sha256(state),
      backend_resource_sha256: backend,
      revocation_generation: 1,
      revoked,
      permitted_effects: ["fixture_qualification"],
    }),
    authenticatedInteractivePrincipal: () => actor,
    assertCurrentInputs: () => {
      if (drift) throw new Error("test_current_input_drift");
    },
  };
  const persist = (
    runId: string,
    kind: string,
    content: unknown,
    upstream: ArtifactRef[] = [],
    operation = kind
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id: operation,
        version: 1,
        producer: "host:sca-p03-initial-authorization",
        media_type: "application/json",
        content_schema: {
          schema_id: kind.startsWith("sca-p03-initial-")
            ? `penny.${kind}.v1`
            : "penny.test-input.v1",
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content: canonicalJson(content),
    });
  const ordinal = 1;
  const runId = `initial-${ordinal}`;
  const input = persist(runId, "test-proof", { fixture: "not-live" });
  const proposal: ScaP03InitialProposalV1 = validateScaP03InitialProposalV1({
    schema_id: "penny.sca-p03-initial-proposal.v1",
    schema_version: 1,
    run_id: runId,
    invocation_nonce: `nonce-${ordinal}`,
    approval_id: `approval-${ordinal}`,
    project_id: project.projectId,
    principal_id: "operator-test",
    policy_id: "test-initial-only-policy",
    installation_id: "test-installation",
    revocation_generation: 1,
    state_authority_sha256: sha256(state),
    backend_resource_sha256: backend,
    deployment_sha256: sha256("test-deployment"),
    configuration_sha256: sha256("test-config"),
    evidence_destination_sha256: sha256(root),
    fixture_cohort_sha256: input.content_digest,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    not_before: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    effect: "fixture_qualification",
    resources,
    input_refs: [input],
  });
  const ref = persist(runId, "sca-p03-initial-proposal", proposal, [input]);
  const bindingPin = new ScaP03InitialProposalBindingV1(store, ref);
  const authorization = new ScaP03InitialAuthorizationV1(
    profile,
    {
      verify: verifyExecutionOwnerSignature,
    },
    bindingPin
  );
  const registration = createScaP03InitialQualificationRegistrationV1({
    authorization,
    binding: bindingPin,
  });
  const engine = new OrchestrationEngine(cp, {
    projectRoot: root,
    maxSteps: 20,
    receiptAuthority: ReceiptAuthority.provision(path.join(root, "receipt-key")),
    artifactStore: store,
    artifactReader: store,
    artifactRevisions: store,
    playbookRegistration: registration,
  });
  const start = () => {
    const gate = engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: runId,
        playbook: registration.name,
        engine_owner: "typescript",
      },
      goal: "isolated canonical initial authorization test",
      project_root: root,
      trust_profile: "trusted-interactive",
      constraints: { proposal_ref: ref },
    });
    if (gate.action !== "await_user") throw new Error("gate missing");
    const transport = cp
      .loadRun(gate.identity)
      .selectedArtifacts.find((r) => r.kind === "sca-p03-initial-transport");
    if (transport === undefined) throw new Error("transport missing");
    const binding = readScaP03InitialGate(store, ref, transport);
    const event = (response = "approve") =>
      signTrustedHumanEvent({
        runId,
        gateId: binding.gate_id,
        challenge: binding.challenge,
        artifactRef: ref,
        transportRef: transport,
        renderedQuestionsDigest: binding.rendered_questions_digest,
        response,
      });
    const respond = (response: unknown) => {
      // JsonValue schema narrows test values without assertions, just like native driver ingress.
      const raw: unknown = JSON.parse(canonicalJson(response));
      const json = validateContract(JsonValueSchema, raw, "test native gate response");
      return engine.handle({
        schema_version: 2,
        action: "respond",
        identity: gate.identity,
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        response: json,
      });
    };
    return { gate, proposal, ref, binding, event, respond };
  };
  let effects = 0;
  const runner = (
    fault?: "throw_after_guard" | "progress" | "output_exact" | "output_overflow",
    crash?: HostOperationFaultPointV1
  ) => {
    const adapter: HostOperationAdapterV1 = {
      adapter_id: registration.host_operations?.declarations[0]?.adapter_id ?? "missing",
      inspectRequest({ directive, request_bytes }) {
        const p = validateScaP03InitialProposalV1(
          JSON.parse(Buffer.from(request_bytes).toString())
        );
        return {
          schema_version: 1,
          operation_kind: directive.operation_kind,
          adapter_id: directive.policy_binding.adapter_id,
          backend_binding_id: directive.policy_binding.backend_binding_id,
          backend_key_sha256: p.backend_resource_sha256,
        };
      },
      async run(context) {
        const p = validateScaP03InitialProposalV1(
          JSON.parse(Buffer.from(context.request_bytes).toString())
        );
        const binding = readScaP03InitialGate(
          store,
          context.directive.request_ref,
          context.readInput("initial_transport").ref
        );
        authorization.assertEffect(context, p, binding);
        context.beginSubmission();
        expect(leases.inspect(backend)).toMatchObject({
          state: "active",
          active: { phase: "submission_guarded" },
        });
        effects++;
        if (fault === "throw_after_guard") throw new Error("test_uncertain_create");
        if (fault === "progress") {
          await new Promise<void>((resolve) => {
            const t = setInterval(() => context.reportActivity("test_real_work", 1), 40_000);
            setTimeout(() => {
              clearInterval(t);
              resolve();
            }, 125_000);
          });
        }
        const content =
          fault === "output_exact" || fault === "output_overflow"
            ? JSON.stringify(
                "x".repeat(resources.max_evidence_bytes - 2 + (fault === "output_overflow" ? 1 : 0))
              )
            : canonicalJson({
                schema_id: "penny.sca-p03-initial-evidence.v1",
                evidence_stage: "initial_only",
                fixture_observations: "simulated test only",
              });
        context.recordFetched({
          schema_version: 1,
          content_sha256: sha256(content),
          byte_length: Buffer.byteLength(content),
          item_count: 1,
          poll_count: 0,
        });
        const disposition = {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        } as const;
        return {
          disposition,
          ...context.persist({
            disposition,
            operation_result: {
              contract: context.declaration.result,
              media_type: "application/json",
              content,
            },
          }),
        };
      },
    };
    const owner = new HostOperationRuntimeOwner({
      projectId: project.projectId,
      checkpointer: cp,
      artifacts: store,
      leaseAuthority: leases,
      adapters: new Map([[adapter.adapter_id, adapter]]),
      ...(crash === undefined
        ? {}
        : {
            fault(point) {
              if (point === crash) throw new HostOperationSimulatedCrashError(point);
            },
          }),
      useValidator: createScaP03InitialUseValidatorV1({
        store,
        authorization,
        binding: bindingPin,
      }),
    });
    const workers = new WorkerExecutor(
      {
        async runAgent() {
          throw new Error("model forbidden");
        },
      },
      store,
      { projectRoot: root, parallelConcurrency: 1, registration }
    );
    return new OrchestrationRunner(engine, workers, undefined, owner);
  };
  return {
    root,
    state,
    store,
    persist,
    cp,
    engine,
    leases,
    backend,
    start,
    runner,
    registration,
    authorization,
    bindingPin,
    profile,
    get effects() {
      return effects;
    },
    revoke() {
      revoked = true;
    },
    wrongActor() {
      actor = "wrong-operator";
    },
    staleInputs() {
      drift = true;
    },
    expire() {
      nowOffset = 600_001;
    },
  };
}
function operation(
  value: ReturnType<ReturnType<typeof fixture>["start"]>["respond"] extends (
    ...a: never[]
  ) => infer R
    ? R
    : never
): InvokeHostOperationDirectiveV1 {
  if (value.action !== "invoke_host_operation") throw new Error("expected operation");
  return value;
}
describe("canonical P03 initial permission, not final authority", () => {
  it("closes sealed verification operands without widening the fixture permission", () => {
    const f = fixture();
    const current = f.start();
    const sealed = current.proposal.input_refs[0];
    if (sealed === undefined) throw new Error("exact operand absent");
    const proposal = validateScaP03InitialProposalV1({
      ...current.proposal,
      effect: "bootstrap_verification",
      sealed_bootstrap_inputs_ref: sealed,
    });
    expect(proposal.effect).toBe("bootstrap_verification");
    expect(() => f.authorization.assertProposal(proposal)).toThrow();
    for (const raw of [
      { ...proposal, sealed_bootstrap_inputs_ref: undefined },
      { ...proposal, input_refs: [] },
      { ...proposal, effect: "fixture_qualification" },
      { ...proposal, effect: "run_campaign" },
      { ...proposal, approved: true },
      { ...proposal, operation_id: "sca-p03-build-source-graph-php" },
    ])
      expect(() => validateScaP03InitialProposalV1(raw)).toThrow();
    expect(f.effects).toBe(0);
  });
  it("keeps the actual native command blocked without a configured authenticated host", async () => {
    const { createExtensionApiHarness, requireQuestionnaireCommand } = await vi.importActual<{
      createExtensionApiHarness(): { api: ExtensionAPI; registeredCommands: unknown[] };
      requireQuestionnaireCommand(value: unknown): {
        handler(args: unknown, context: unknown): Promise<void>;
      };
    }>("../../../.pi/extensions/questionnaire/tests/helpers.js");
    const { registerScaP03NativeOperatorV1 } = await vi.importActual<{
      registerScaP03NativeOperatorV1(pi: ExtensionAPI): void;
    }>("../../../.pi/extensions/sca/src/native-operator.js");
    const harness = createExtensionApiHarness();
    registerScaP03NativeOperatorV1(harness.api);
    const command = requireQuestionnaireCommand(harness.registeredCommands[0]);
    const notify = vi.fn();
    await command.handler(`start art_${sha256("not-an-authority")}`, {
      mode: "tui",
      hasUI: true,
      ui: { notify },
    });
    expect(notify).toHaveBeenCalledWith(
      "missing_input: trusted native authenticated operator/profile + canonical backend/state authority composition",
      "error"
    );
  });
  it("passes the actual questionnaire-signed witness through the native gate driver, engine, and owner", async () => {
    const f = fixture();
    const g = f.start();
    const transport = validateContract(
      ScaP03InitialTransportV1Schema,
      JSON.parse(f.store.read(g.binding.transport_ref).toString()),
      "test native transport"
    );
    const capability = registerTrustedQuestionnaireTransport(transport.questions, {
      runId: g.proposal.run_id,
      gateId: g.binding.gate_id,
      challenge: g.binding.challenge,
      artifactRef: g.ref,
      transportRef: g.binding.transport_ref,
      renderedQuestionsDigest: renderedQuestionsDigest(transport.questions),
    });
    if (capability === undefined) throw new Error("trusted transport not registered");
    // Load each extension under its OWN strict project, not orchestration's different
    // exact-optional/index-access compiler policy. Actual runtime modules, no signature mocks.
    const { default: questionnaire } = await vi.importActual<{
      default: (api: ExtensionAPI) => void;
    }>("../../../.pi/extensions/questionnaire/index.js");
    const { createExtensionApiHarness, requireQuestionnaireTool, requireQuestionnaireToolResult } =
      await vi.importActual<{
        createExtensionApiHarness(): { api: ExtensionAPI; registeredTools: unknown[] };
        requireQuestionnaireTool(value: unknown): { execute(...args: unknown[]): Promise<unknown> };
        requireQuestionnaireToolResult(value: unknown): { details?: Record<string, unknown> };
      }>("../../../.pi/extensions/questionnaire/tests/helpers.js");
    const harness = createExtensionApiHarness();
    questionnaire(harness.api);
    const tool = requireQuestionnaireTool(harness.registeredTools[0]);
    const result = requireQuestionnaireToolResult(
      await tool.execute(
        "native-gate-test",
        { trustedTransportCapability: capability },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: {
            notify: vi.fn(),
            custom: vi.fn().mockResolvedValue({
              questions: [],
              answers: [
                { id: "initial", value: "approve", label: "Approve", wasCustom: false, index: 2 },
              ],
              cancelled: false,
            }),
          },
        }
      )
    );
    const events = result.details?.trustedHumanEvents;
    if (!Array.isArray(events) || events.length !== 1)
      throw new Error("signed native witness absent");
    expect(verifyExecutionOwnerSignature(events[0])).toBe(true);
    const terminal = await respondToTrustedNativeGateV1({
      run_id: g.proposal.run_id,
      event: events[0],
      signal: new AbortController().signal,
      service: {
        checkpointer: f.cp,
        execute: async (request, signal) =>
          f.runner().runUntilBoundary(f.engine.handle(request), signal),
      },
    });
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)[0]?.lifecycle).toBe("consumed");
    expect(f.effects).toBe(1);
    // Real witness and canonical routing; this adapter still simulates effects, not live Docker.
  });
  it("registers zero-model gate then host work privately, consumes once, and cannot grant P04", async () => {
    const f = fixture();
    validateRegistrationContract(f.registration);
    expect(PLAYBOOK_REGISTRY.has(SCA_P03_INITIAL_NAME)).toBe(false);
    const g = f.start();
    expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toHaveLength(0);
    expect(() => g.respond(true)).toThrow();
    expect(() => g.respond("approve")).toThrow();
    const approvedEvent = g.event();
    const d = operation(g.respond(approvedEvent));
    expect(d.state_id).toBe(SCA_P03_INITIAL_WORK_STATE);
    const terminal = await f.runner().runUntilBoundary(d);
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: { evidence_stage: "initial_only", p04_dispatch_permitted: false },
    });
    expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)[0]?.lifecycle).toBe("consumed");
    expect(f.effects).toBe(1);
    expect(g.respond(approvedEvent)).toMatchObject({ action: "incomplete" });
    expect(f.effects).toBe(1);
  });
  it.each(["expired", "revoked", "wrong_actor", "stale_inputs"])(
    "refuses %s at the real canonical gate with no effects",
    (reason) => {
      const f = fixture();
      const g = f.start();
      if (reason === "expired") f.expire();
      if (reason === "revoked") f.revoke();
      if (reason === "wrong_actor") f.wrongActor();
      if (reason === "stale_inputs") f.staleInputs();
      expect(() => g.respond(g.event())).toThrow();
      expect(f.effects).toBe(0);
      expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
    }
  );
  it("refuses forged events, changed deep refs, stale challenges, client policy and child-env HMAC", () => {
    const f = fixture();
    const g = f.start();
    const signed = g.event();
    for (const changed of [
      { ...signed, signature: "0".repeat(64) },
      { ...signed, challenge: "other" },
      { ...signed, artifact_ref: { ...g.ref, producer: "host:forged" } },
      { ...signed, callback: true },
      { ...signed, run_id: "other" },
    ])
      expect(() => g.respond(changed)).toThrow();
    const env = withExecutionOwnerEnvironment({});
    const key = env.PENNY_APPROVAL_HMAC_KEY;
    if (key === undefined) throw new Error("compat key absent");
    const { signature, ...unsigned } = signed;
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    const childForged = {
      ...unsigned,
      signature: createHmac("sha256", Buffer.from(key, "hex"))
        .update(canonicalJson(unsigned))
        .digest("hex"),
    };
    expect(verifyExecutionOwnerSignature(childForged)).toBe(false);
    expect(() => g.respond(childForged)).toThrow();
    expect(() =>
      f.authorization.assertProposal({ ...g.proposal, policy_id: "client-policy" })
    ).toThrow();
    expect(() =>
      validateScaP03InitialProposalV1({
        ...g.proposal,
        resources: { ...resources, tmp_bytes: 67_108_864 },
      })
    ).toThrow();
    let deep: unknown = signed;
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(verifyExecutionOwnerSignature({ payload: deep, signature: "a".repeat(64) })).toBe(false);
  });
  it.each(["deny", "refine"])("%s keeps actual operation admission closed", (choice) => {
    const f = fixture();
    const g = f.start();
    expect(g.respond(g.event(choice))).toMatchObject({ action: "incomplete", met: false });
    expect(f.effects).toBe(0);
  });
  it("rechecks revoked authority at dispatch and preserves cross-project quarantine across fresh nonces", async () => {
    const f = fixture();
    const g = f.start();
    const d = operation(g.respond(g.event()));
    f.revoke();
    await expect(f.runner().runUntilBoundary(d)).rejects.toThrow();
    expect(f.effects).toBe(0);
    const a = fixture();
    const one = a.start();
    await a.runner("throw_after_guard").runUntilBoundary(operation(one.respond(one.event())));
    expect(a.leases.inspect(a.backend)).toMatchObject({ state: "quarantined" });
    const b = fixture(a.state);
    const other = b.start();
    await b.runner().runUntilBoundary(operation(other.respond(other.event())));
    expect(b.effects).toBe(0);
    expect(b.cp.hostOperationCallsForRun(other.proposal.run_id)[0]?.disposition?.reason_code).toBe(
      "backend_quarantined"
    );
  });
  it("rechecks expiry after signed approval before dispatch effects or journal admission", async () => {
    const f = fixture();
    const g = f.start();
    const d = operation(g.respond(g.event()));
    f.expire();
    await expect(f.runner().runUntilBoundary(d)).rejects.toThrow("p03_initial_authority_denied");
    expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toHaveLength(0);
    expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
    expect(f.effects).toBe(0);
  });
  it("continues past sixty seconds on owner-accepted work, not just backend heartbeats", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const g = f.start();
    const run = f.runner("progress").runUntilBoundary(operation(g.respond(g.event())));
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await run).toMatchObject({ action: "incomplete", met: false });
    expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)[0]?.disposition?.outcome).toBe(
      "completed"
    );
  });
});

function metadataRef(i: number, length: number, json = false): ArtifactRef {
  const ref = previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id: "custody-bounds",
      phase: "inspection",
      branch_id: null,
      kind: "opaque-proof",
      operation_id: `ref-${i}`,
      version: 1,
      producer: "host:test",
      media_type: json ? "application/json" : "application/octet-stream",
      parent_ref: null,
      upstream_refs: [],
    },
    content: "",
  });
  return { ...ref, byte_length: length };
}
const ordered = (refs: ArtifactRef[]) =>
  refs.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
describe("approved input custody contract", () => {
  it("derives exact inclusive hard ceilings without allocating opaque bodies", () => {
    expect(deriveScaP03InitialCustodyV1(ordered([metadataRef(1, 64 * 1_048_576)]))).toMatchObject({
      max_refs: 1,
      max_total_bytes: 64 * 1_048_576,
    });
    expect(
      deriveScaP03InitialCustodyV1([metadataRef(2, 4 * 1_048_576, true)]).max_total_bytes
    ).toBe(4 * 1_048_576);
    const maximum = ordered(
      Array.from({ length: 512 }, (_, i) => metadataRef(i, i < 4 ? 64 * 1_048_576 : 0))
    );
    expect(deriveScaP03InitialCustodyV1(maximum)).toEqual({
      max_refs: 512,
      max_total_bytes: 256 * 1_048_576,
      max_artifact_bytes: 64 * 1_048_576,
      max_json_bytes: 4 * 1_048_576,
    });
    const invalid = [
      [],
      [metadataRef(0, 0)],
      [...maximum, metadataRef(600, 0)],
      ordered([
        ...Array.from({ length: 4 }, (_, i) => metadataRef(i, 64 * 1_048_576)),
        metadataRef(600, 1),
      ]),
      [metadataRef(1, 64 * 1_048_576 + 1)],
      [metadataRef(1, 4 * 1_048_576 + 1, true)],
      [metadataRef(1, Number.MAX_SAFE_INTEGER + 1)],
      [metadataRef(1, -1)],
      [metadataRef(1, 1.5)],
      [maximum[0], maximum[0]],
      [...maximum].reverse(),
      [{ ...metadataRef(1, 1), store_ref: `artifact://sha256/${sha256("wrong")}` }],
      [{ ...metadataRef(1, 1), artifact_id: `art_${sha256("wrong")}` }],
    ];
    for (const refs of invalid)
      expect(() =>
        deriveScaP03InitialCustodyV1(
          validateContract(Type.Array(ArtifactRefSchema), refs, "test refs")
        )
      ).toThrow();
  });
  it("declares exact custody plus controls, while output and execution remain unchanged", () => {
    const f = fixture();
    const p = f.bindingPin.proposal;
    const d = f.registration.host_operations?.declarations[0];
    expect(d).toMatchObject({
      max_input_artifacts: p.input_refs.length + 3,
      max_input_bytes: p.input_refs.reduce((n, r) => n + r.byte_length, 0) + 3_145_728,
      max_output_bytes: resources.max_evidence_bytes,
      max_request_bytes: 1_048_576,
      max_progress_events: resources.max_commands * 4,
      max_pre_acceptance_retries: 0,
      operation_inactivity_ms: 60_000,
    });
    expect(f.bindingPin.proposal.resources).toEqual(resources);
    expect(() =>
      // @ts-expect-error negative compile contract: resources-only construction lacks a proposal pin
      createScaP03InitialQualificationRegistrationV1({ authorization: f.authorization, resources })
    ).toThrow();
  });
  it("large metadata-only custody changes only declaration input ceilings, not execution or public/model authority", () => {
    const f = fixture();
    const publicBefore = [...PLAYBOOK_REGISTRY].map(([name, registration]) => [
      name,
      runtimeRegistrationSha256(registration),
    ]);
    const refs = ordered([metadataRef(1, 35_162_428), metadataRef(2, 21_958_840)]);
    const proposal = validateScaP03InitialProposalV1({
      ...f.bindingPin.proposal,
      input_refs: refs,
    });
    const ref = f.persist(
      proposal.run_id,
      "sca-p03-initial-proposal",
      proposal,
      [],
      "large-custody"
    );
    const binding = new ScaP03InitialProposalBindingV1(f.store, ref);
    const authorization = new ScaP03InitialAuthorizationV1(
      f.profile,
      { verify: verifyExecutionOwnerSignature },
      binding
    );
    const registration = createScaP03InitialQualificationRegistrationV1({ authorization, binding });
    validateRegistrationContract(registration);
    const small = f.registration.host_operations?.declarations[0];
    const large = registration.host_operations?.declarations[0];
    if (small === undefined || large === undefined) throw new Error("declarations missing");
    expect(deriveScaP03InitialCustodyV1(refs).max_total_bytes).toBe(57_121_268);
    expect(large.max_input_artifacts).toBe(5);
    expect(large.max_input_bytes).toBe(57_121_268 + 3_145_728);
    // Compare the WHOLE remaining declaration: output, progress, retries, lease,
    // capabilities, request/result contracts, recovery and cancellation are all unchanged.
    expect(large).toEqual({
      ...small,
      max_input_artifacts: 5,
      max_input_bytes: 57_121_268 + 3_145_728,
    });
    expect(binding.proposal.resources).toEqual(resources);
    expect(registration.contract).toEqual(f.registration.contract);
    expect(registration.worker).toEqual(f.registration.worker);
    expect(registration.worker).toMatchObject({
      kind: "none",
      model_policy: "none",
      opening_policy: "none",
    });
    expect(registration.worker.phases.size).toBe(0);
    expect(registration.host_states).toEqual(f.registration.host_states);
    expect(PLAYBOOK_REGISTRY.has(SCA_P03_INITIAL_NAME)).toBe(false);
    expect(
      [...PLAYBOOK_REGISTRY].map(([name, entry]) => [name, runtimeRegistrationSha256(entry)])
    ).toEqual(publicBefore);
    expect(f.cp.hostOperationCallsForRun(proposal.run_id)).toHaveLength(0);
    expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
    // No bodies are invented for these refs: this tests declaration derivation,
    // not the separate real-closure/native execution regression.
  });
  it("refuses equal-sized foreign proposals at start/rebind and owner admission without body reads", async () => {
    const f = fixture();
    const g = f.start();
    const p = { ...g.proposal, approval_id: "foreign-approval" };
    const other = f.persist(
      g.proposal.run_id,
      "sca-p03-initial-proposal",
      p,
      g.proposal.input_refs,
      "foreign-proposal"
    );
    const read = vi.spyOn(f.store, "read"),
      byId = vi.spyOn(f.store, "readById");
    expect(() => f.bindingPin.read(f.store, other)).toThrow("foreign_proposal");
    expect(() =>
      f.engine.handle({
        schema_version: 2,
        action: "start",
        identity: { ...g.gate.identity, run_id: "foreign-run" },
        goal: "foreign",
        project_root: f.root,
        trust_profile: "trusted-interactive",
        constraints: { proposal_ref: other },
      })
    ).toThrow();
    const d = operation(g.respond(g.event()));
    read.mockClear();
    byId.mockClear();
    await expect(
      f
        .runner()
        .runUntilBoundary({ ...d, request_ref: other, request_sha256: other.content_digest })
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(f.effects).toBe(0);
    expect(f.cp.hostOperationCallsForRun(p.run_id)).toHaveLength(0);
  });
  it("rejects every changed slot set and excessive controls before request/proof bodies or journal admission", async () => {
    const f = fixture();
    const g = f.start();
    const d = operation(g.respond(g.event()));
    const slots = d.input_artifacts.artifacts;
    const proof = slots.find((s) => s.slot === "proof_000");
    const control = slots.find((s) => s.slot === "initial_witness");
    if (proof === undefined || control === undefined) throw new Error("fixture slots absent");
    const variants = [
      slots.slice(1),
      [...slots, { ...proof, slot: "extra" }],
      [...slots, { ...proof }],
      slots.map((s) => (s === proof ? { ...s, slot: "proof_001" } : s)),
      slots.map((s) => (s === control ? { ...s, ref: proof.ref } : s)),
      slots.map((s) => (s === proof ? { ...s, ref: { ...s.ref, producer: "host:foreign" } } : s)),
      slots.map((s) => (s === control ? { ...s, ref: { ...s.ref, byte_length: 1_048_577 } } : s)),
      slots.map((s) => (s === proof ? { ...s, ref: { ...s.ref, byte_length: 4_194_304 } } : s)),
    ];
    const read = vi.spyOn(f.store, "read"),
      byId = vi.spyOn(f.store, "readById");
    for (const artifacts of variants) {
      read.mockClear();
      byId.mockClear();
      await expect(
        f.runner().runUntilBoundary({ ...d, input_artifacts: { schema_version: 2, artifacts } })
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(byId).not.toHaveBeenCalled();
      expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toHaveLength(0);
      expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
    }
    expect(f.effects).toBe(0);
  });
  it("reconstructs exact custody questions and rejects old or altered correctly signed transports at use time", async () => {
    const f = fixture();
    const g = f.start();
    const t = validateContract(
      ScaP03InitialTransportV1Schema,
      JSON.parse(f.store.read(g.binding.transport_ref).toString()),
      "test transport"
    );
    const directive = operation(g.respond(g.event()));
    expect(t.questions[0]?.prompt).toContain(
      `${g.proposal.input_refs[0]?.byte_length} unique input bytes`
    );
    for (const questions of [
      t.questions.map((q) => ({ ...q, label: "old" })),
      t.questions.map((q) => ({ ...q, prompt: canonicalJson(g.proposal) })),
      t.questions.map((q) => ({ ...q, options: [...q.options].reverse() })),
      t.questions.map((q) => ({ ...q, allowOther: true })),
    ]) {
      const altered = f.persist(
        g.proposal.run_id,
        "sca-p03-initial-transport",
        { ...t, questions },
        [g.ref],
        `changed-${sha256(canonicalJson(questions))}`
      );
      const event = signTrustedHumanEvent({
        runId: g.proposal.run_id,
        gateId: t.gate_id,
        challenge: t.challenge,
        artifactRef: g.ref,
        transportRef: altered,
        renderedQuestionsDigest: sha256(canonicalJson(questions)),
        response: "approve",
      });
      expect(verifyExecutionOwnerSignature(event)).toBe(true);
      const refusal = questions.some((q) => q.allowOther)
        ? "P03 initial transport failed schema validation"
        : "p03_initial_transport_stale";
      expect(() => readScaP03InitialGate(f.store, g.ref, altered)).toThrow(refusal);
      const witness = f.persist(
        g.proposal.run_id,
        "sca-p03-initial-witness",
        event,
        [g.ref, altered],
        `changed-witness-${altered.content_digest}`
      );
      const read = vi.spyOn(f.store, "read");
      const byId = vi.spyOn(f.store, "readById");
      read.mockClear();
      byId.mockClear();
      await expect(
        f.runner().runUntilBoundary({
          ...directive,
          input_artifacts: {
            schema_version: 2,
            artifacts: directive.input_artifacts.artifacts.map((slot) =>
              slot.slot === "initial_transport"
                ? { ...slot, ref: altered }
                : slot.slot === "initial_witness"
                  ? { ...slot, ref: witness }
                  : slot
            ),
          },
        })
      ).rejects.toThrow(refusal);
      for (const proof of g.proposal.input_refs) {
        expect(read.mock.calls.some(([ref]) => ref.artifact_id === proof.artifact_id)).toBe(false);
        expect(byId.mock.calls.some(([id]) => id === proof.artifact_id)).toBe(false);
      }
      expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toHaveLength(0);
      expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
      expect(f.effects).toBe(0);
    }
    expect(() =>
      assertScaP03InitialControlRefV1({ ...g.ref, byte_length: 1_048_577 }, "proposal")
    ).toThrow();
  });
  it.each(["expired", "revoked", "wrong_actor", "stale_inputs"])(
    "rechecks %s after approval during settled journal recovery without consuming or rerunning",
    async (reason) => {
      const f = fixture();
      const g = f.start();
      const d = operation(g.respond(g.event()));
      await expect(f.runner(undefined, "before_consume").runUntilBoundary(d)).rejects.toThrow(
        "simulated host-operation crash"
      );
      const before = f.cp.hostOperationCallsForRun(g.proposal.run_id)[0];
      if (before === undefined) throw new Error("settled journal absent");
      expect(before.lifecycle).toBe("settled");
      expect(f.effects).toBe(1);
      if (reason === "expired") f.expire();
      if (reason === "revoked") f.revoke();
      if (reason === "wrong_actor") f.wrongActor();
      if (reason === "stale_inputs") f.staleInputs();
      const recovered = f.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: d.identity,
      });
      expect(recovered.action).toBe("invoke_host_operation");
      await expect(f.runner().runUntilBoundary(recovered)).rejects.toThrow();
      expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toEqual([before]);
      expect(f.effects).toBe(1);
    }
  );
  it.each(["expired", "revoked", "wrong_actor", "stale_inputs"])(
    "rechecks %s through consumed replay",
    async (reason) => {
      const f = fixture();
      const g = f.start();
      const d = operation(g.respond(g.event()));
      await f.runner().runUntilBoundary(d);
      if (reason === "expired") f.expire();
      if (reason === "revoked") f.revoke();
      if (reason === "wrong_actor") f.wrongActor();
      if (reason === "stale_inputs") f.staleInputs();
      await expect(f.runner().runUntilBoundary(d)).rejects.toThrow();
      expect(f.effects).toBe(1);
    }
  );
});

it.each(["output_exact", "output_overflow"] as const)(
  "P03 generated evidence boundary %s stays independent of input custody",
  async (fault) => {
    const f = fixture();
    const g = f.start();
    await f.runner(fault).runUntilBoundary(operation(g.respond(g.event())));
    const record = f.cp.hostOperationCallsForRun(g.proposal.run_id)[0];
    if (record === undefined) throw new Error("operation absent");
    expect(record.lifecycle).toBe("consumed");
    if (fault === "output_exact") {
      expect(record.disposition?.outcome).toBe("completed");
      expect(record.operation_result_ref?.byte_length).toBe(resources.max_evidence_bytes);
    } else {
      expect(record.disposition?.outcome).toBe("failed");
      expect(record.operation_result_ref).toBeNull();
    }
  }
);

it("refuses generated oversized transport before persistence, even for a bounded canonical proposal", () => {
  const f = fixture();
  const quoted = '"'.repeat(220);
  const refs = ordered(
    Array.from({ length: 360 }, (_, i) =>
      f.store.persist({
        metadata: {
          schema_version: 2,
          run_id: quoted,
          phase: quoted,
          branch_id: null,
          kind: "opaque-input",
          operation_id: `${i}${quoted}`,
          version: 1,
          producer: quoted,
          media_type: "application/octet-stream",
          parent_ref: null,
          upstream_refs: [],
        },
        content: "x",
      })
    )
  );
  const proposal = validateScaP03InitialProposalV1({ ...f.bindingPin.proposal, input_refs: refs });
  expect(Buffer.byteLength(canonicalJson(proposal))).toBeLessThanOrEqual(1_048_576);
  const ref = f.persist(
    proposal.run_id,
    "sca-p03-initial-proposal",
    proposal,
    [],
    "large-control-proposal"
  );
  const pin = new ScaP03InitialProposalBindingV1(f.store, ref);
  const authorization = new ScaP03InitialAuthorizationV1(
    {
      current: () => ({ ...proposal, revoked: false, permitted_effects: [proposal.effect] }),
      now: () => new Date(),
      authenticatedInteractivePrincipal: () => proposal.principal_id,
      assertCurrentInputs() {},
    },
    { verify: verifyExecutionOwnerSignature },
    pin
  );
  const registration = createScaP03InitialQualificationRegistrationV1({
    authorization,
    binding: pin,
  });
  const engine = new OrchestrationEngine(f.cp, {
    receiptAuthority: ReceiptAuthority.provision(path.join(f.root, "generated-receipt-key")),
    projectRoot: f.root,
    maxSteps: 20,
    artifactStore: f.store,
    playbookRegistration: registration,
  });
  const persist = vi.spyOn(f.store, "persist");
  expect(() =>
    engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: proposal.run_id,
        session_id: proposal.run_id,
        playbook: registration.name,
        engine_owner: "typescript",
      },
      goal: "bounded generated controls",
      project_root: f.root,
      trust_profile: "trusted-interactive",
      constraints: { proposal_ref: ref },
    })
  ).toThrow("p03_initial_control_limit");
  expect(persist).not.toHaveBeenCalled();
});

it("refuses an oversized generated witness before persistence when the trusted producer misbehaves", () => {
  const f = fixture();
  const g = f.start();
  const event = g.event();
  const admitted = f.authorization.admit(g.proposal, g.binding, event);
  // Valid ingress witnesses are schema-bounded far below 1 MiB. Inject a producer
  // fault AFTER admission to exercise the independent generated-control write guard.
  const oversized = { ...admitted, signature: "a".repeat(1_048_577) };
  expect(Buffer.byteLength(canonicalJson(oversized))).toBeGreaterThan(1_048_576);
  vi.spyOn(f.authorization, "admit").mockReturnValueOnce(oversized);
  const persist = vi.spyOn(f.store, "persist");
  const before = f.cp.loadRun(g.gate.identity).snapshot();
  expect(() => g.respond(event)).toThrow("p03_initial_control_limit");
  expect(persist).not.toHaveBeenCalled();
  expect(f.cp.loadRun(g.gate.identity).snapshot()).toEqual(before);
  expect(f.cp.hostOperationCallsForRun(g.proposal.run_id)).toHaveLength(0);
  expect(f.leases.inspect(f.backend)).toEqual({ state: "absent" });
  expect(f.effects).toBe(0);
});
