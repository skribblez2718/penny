import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import { SCA_REQUIRED_MODEL } from "../dist/sca/ordinary-model-guard.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive } from "../dist/contracts.js";
import {
  RemoteModelOutcomeUnknownError,
  buildAgentOpening,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../dist/model-client.js";
import {
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../dist/required-model.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  validateRegistrationContract,
} from "../dist/playbooks/registry.js";
import {
  SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  validateScaModelDataPolicyV1,
  type ScaModelDataPolicyV1,
} from "../dist/sca/p01-policy-contracts.js";
import { PreDispatchPolicyDeniedError } from "../dist/sca/p04-dispatch-guard.js";
import {
  SCA_P04_CANDIDATE_REGISTRATION,
  SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  buildScaP04CognitivePayload,
  buildScaP04DisclosureAdmission,
} from "../dist/sca/p04-playbook.js";
import {
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
  scaP04SpecialistTask,
  scaP04StableItemId,
  validateScaP04SelectionPopulationV1,
  withSelfDigest,
  type ScaP04DisclosureAdmissionV1,
  type ScaP04SelectionPopulationV1,
} from "../dist/sca/p04-contracts.js";
import { WorkerExecutor } from "../dist/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const roots: string[] = [];

const MODEL_POLICY: ScaModelDataPolicyV1 = {
  schema_id: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  schema_version: 1 as const,
  policy_id: "p04-test-model-policy",
  trust_status: "host-declared" as const,
  status: "approved" as const,
  model_alias: "deepseek-flash",
  provider: "ollama",
  model: "deepseek-v4.1-flash:cloud",
  destination_class: "cloud" as const,
  provider_retention_status: "known" as const,
  provider_retention_days: 0,
  provider_training_use: "prohibited" as const,
  data_classes: [
    { data_class: "source-code" as const, treatment: "allow-minimized" as const },
    { data_class: "scanner-evidence" as const, treatment: "allow-minimized" as const },
    {
      data_class: "dependency-coordinates" as const,
      treatment: "allow-minimized" as const,
    },
    { data_class: "secrets" as const, treatment: "deny" as const },
    { data_class: "personal-data" as const, treatment: "deny" as const },
  ],
  payload_limit_bytes: 1_000_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p04-model-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

class CountingArtifactStore extends ArtifactStore {
  readonly readsByArtifactId = new Map<string, number>();

  override readById(artifactId: string): Buffer {
    this.readsByArtifactId.set(artifactId, (this.readsByArtifactId.get(artifactId) ?? 0) + 1);
    return super.readById(artifactId);
  }
}

function temporaryCountingStore(): CountingArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p04-counting-model-"));
  roots.push(root);
  return new CountingArtifactStore(path.join(root, "artifacts"));
}

function persist(
  store: ArtifactStore,
  input: {
    readonly run_id: string;
    readonly branch_id: string | null;
    readonly kind: string;
    readonly operation_id: string;
    readonly producer: string;
    readonly media_type?: string;
    readonly schema_id?: string;
    readonly content: string | Buffer;
    readonly upstream_refs?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "SCA-P04",
      branch_id: input.branch_id,
      kind: input.kind,
      operation_id: input.operation_id,
      version: 1,
      producer: input.producer,
      media_type: input.media_type ?? "application/json",
      ...(input.schema_id === undefined
        ? {}
        : { content_schema: { schema_id: input.schema_id, schema_version: 1 } }),
      parent_ref: null,
      upstream_refs: [...(input.upstream_refs ?? [])],
    },
    content: input.content,
  });
}

interface ProviderFixture {
  readonly population: ScaP04SelectionPopulationV1;
  readonly evidence_ref: ArtifactRef;
  readonly policy_ref: ArtifactRef;
  readonly payload_ref: ArtifactRef;
  readonly disclosure_ref: ArtifactRef;
}

function providerFixture(
  store: ArtifactStore,
  runId: string,
  options: {
    readonly policy?: unknown;
    readonly openingLimitHeadroom?: number;
    readonly itemCount?: number;
    readonly conflictingEvidenceRefOnLastItem?: boolean;
    readonly disclosurePatch?: (
      disclosure: ScaP04DisclosureAdmissionV1
    ) => ScaP04DisclosureAdmissionV1;
  } = {}
): ProviderFixture {
  const evidenceRef = persist(store, {
    run_id: "run-p03-evidence",
    branch_id: null,
    kind: "sca-p04-test-evidence",
    operation_id: `sca-p04-test-evidence-${runId}`,
    producer: "host:test",
    media_type: "application/octet-stream",
    content: Buffer.from([0, 255, 17, 34, 128]),
  });
  const itemCount = options.itemCount ?? 1;
  const items = Array.from({ length: itemCount }, (_, index) => {
    const suffix = index.toString().padStart(4, "0");
    const upstreamId = `test-observation-${suffix}`;
    const normalizedLocator = `scanner:src/example-${suffix}.ts:1:test`;
    const itemEvidenceRef =
      options.conflictingEvidenceRefOnLastItem && index === itemCount - 1
        ? { ...evidenceRef, byte_length: evidenceRef.byte_length + 1 }
        : evidenceRef;
    return {
      stable_id: scaP04StableItemId({
        source_snapshot_sha256: evidenceRef.content_digest,
        item_kind: "scanner_lead",
        normalized_locator: normalizedLocator,
        upstream_ids: [upstreamId],
      }),
      item_kind: "scanner_lead" as const,
      normalized_locator: normalizedLocator,
      source_path: `src/example-${suffix}.ts`,
      package_coordinate: null,
      alert_state: "scanner_alert" as const,
      aliases: [],
      upstream_ids: [upstreamId],
      evidence_refs: [itemEvidenceRef],
      assigned_specialists: [SCA_P04_SCANNER_SPECIALIST, "underdetected_no_alert" as const].sort(),
      selection_metadata: {
        metadata_kind: "scanner_observation" as const,
        operation_kind: "semgrep_js_ts",
        observation_id: upstreamId,
        analyzer_id: "semgrep-js-ts",
        category: "security-rule",
        subject: `test scanner lead ${suffix}`,
        start_line: 1,
        advisory_id: null,
        correlation_id: `test-correlation-${suffix}`,
        duplicate_group_id: null,
      },
      description: "Bounded scanner lead for provider-boundary tests",
    };
  }).sort((left, right) => left.stable_id.localeCompare(right.stable_id));
  const sharedPopulation = validateScaP04SelectionPopulationV1(
    withSelfDigest(
      {
        schema_id: "penny.sca-p04-selection-population.v1" as const,
        schema_version: 1 as const,
        phase_id: "SCA-P04" as const,
        run_id: runId,
        source_snapshot_ref: evidenceRef,
        source_snapshot_sha256: evidenceRef.content_digest,
        accepted_cohort_ref: evidenceRef,
        items,
        item_count: items.length,
        max_selected_items: items.length,
        specialist_ids: [SCA_P04_SCANNER_SPECIALIST, "underdetected_no_alert" as const],
      },
      "population_sha256"
    )
  );
  const populationRef = persist(store, {
    run_id: runId,
    branch_id: null,
    kind: "sca-p04-selection-population",
    operation_id: `sca-p04-selection-population-${runId}`,
    producer: "host:sca-p04-candidate",
    schema_id: "penny.sca-p04-selection-population.v1",
    content: canonicalJson(sharedPopulation),
    upstream_refs: [evidenceRef],
  });
  const payload = buildScaP04CognitivePayload({
    admission: { request: { run_id: runId } },
    population: sharedPopulation,
    population_ref: populationRef,
    specialist_id: SCA_P04_SCANNER_SPECIALIST,
  });
  const payloadRef = persist(store, {
    run_id: runId,
    branch_id: SCA_P04_SCANNER_SPECIALIST,
    kind: "sca-p04-cognitive-payload",
    operation_id: `sca-p04-${SCA_P04_SCANNER_SPECIALIST}-payload`,
    producer: "host:sca-p04-candidate",
    schema_id: "penny.sca-p04-cognitive-payload.v1",
    content: canonicalJson(payload),
    upstream_refs: [populationRef],
  });
  const limit =
    options.openingLimitHeadroom === undefined
      ? MODEL_POLICY.payload_limit_bytes
      : payloadRef.byte_length + options.openingLimitHeadroom;
  const policyValue = options.policy ?? {
    ...MODEL_POLICY,
    payload_limit_bytes: limit,
  };
  const policyRef = persist(store, {
    run_id: "run-p01-policy",
    branch_id: null,
    kind: "sca-model-data-policy",
    operation_id: `sca-model-data-policy-${runId}`,
    producer: "host:test",
    schema_id: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
    content: canonicalJson(policyValue),
  });
  let admissionPolicy: ScaModelDataPolicyV1 = MODEL_POLICY;
  try {
    const parsed = validateScaModelDataPolicyV1(policyValue);
    if (parsed.destination_class === "cloud") admissionPolicy = parsed;
  } catch {
    // Some denial fixtures intentionally persist a malformed or unsupported policy. The
    // disclosure remains otherwise valid so the provider-boundary guard is what rejects it.
  }
  const disclosure = buildScaP04DisclosureAdmission({
    admission: {
      request: { run_id: runId },
      runtime_policy: { max_payload_bytes_per_call: limit },
      p01_request: { model_data_policy_ref: policyRef },
      model_data_policy: {
        payload_limit_bytes: limit,
        destination_class: admissionPolicy.destination_class,
        provider_retention_status: admissionPolicy.provider_retention_status,
        provider_retention_days: admissionPolicy.provider_retention_days,
        provider_training_use: admissionPolicy.provider_training_use,
        data_classes: admissionPolicy.data_classes,
      },
    },
    payload,
    payload_ref: payloadRef,
    agent: "annie",
  });
  const finalDisclosure = options.disclosurePatch?.(disclosure) ?? disclosure;
  const disclosureRef = persist(store, {
    run_id: runId,
    branch_id: SCA_P04_SCANNER_SPECIALIST,
    kind: "sca-p04-disclosure-admission",
    operation_id: `sca-p04-${SCA_P04_SCANNER_SPECIALIST}-disclosure-admission`,
    producer: "host:sca-p04-candidate",
    schema_id: "penny.sca-p04-disclosure-admission.v1",
    content: canonicalJson(finalDisclosure),
    upstream_refs: [payloadRef, policyRef],
  });
  return {
    population: sharedPopulation,
    evidence_ref: evidenceRef,
    policy_ref: policyRef,
    payload_ref: payloadRef,
    disclosure_ref: disclosureRef,
  };
}

function branchDirective(
  runId: string,
  fixture: ProviderFixture,
  options: {
    readonly modelOverride?: string;
    readonly branchId?: string;
    readonly task?: string;
  } = {}
): Extract<Directive, { action: "invoke_agents_parallel" }> {
  const branchId = options.branchId ?? SCA_P04_SCANNER_SPECIALIST;
  return {
    schema_version: 2,
    action: "invoke_agents_parallel",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    state_id: "selecting_surfaces",
    branches: [
      {
        branch_id: branchId,
        state_id: "selecting_surfaces",
        agent: "annie",
        attempt: 1,
        trust_profile: "hardened-untrusted",
        task: options.task ?? scaP04SpecialistTask(SCA_P04_SCANNER_SPECIALIST),
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "cognitive_payload", ref: fixture.payload_ref },
            { slot: "disclosure_admission", ref: fixture.disclosure_ref },
          ],
        },
        output_artifact: {
          schema_version: 2,
          run_id: runId,
          phase: "selecting_surfaces",
          branch_id: branchId,
          kind: "sca-p04-specialist-output",
          operation_id: `sca-p04-${branchId}-required-model-output`,
          version: 1,
          producer: "agent:annie",
          media_type: "text/plain",
          content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
          parent_ref: null,
          upstream_refs: [fixture.payload_ref, fixture.disclosure_ref],
        },
        model_override: options.modelOverride ?? SCA_P04_REQUIRED_MODEL.override,
      },
    ],
  };
}

function validResult(fixture: ProviderFixture): Record<string, unknown> {
  const item = fixture.population.items[0];
  if (item === undefined) throw new Error("provider fixture item absent");
  return {
    schema_id: SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
    schema_version: 1,
    specialist_id: SCA_P04_SCANNER_SPECIALIST,
    role: "scanner_and_dependency_leads",
    population_sha256: fixture.population.population_sha256,
    assigned_item_ids: [item.stable_id],
    results: [
      {
        stable_id: item.stable_id,
        recommendation: "select",
        reason_code: "select_for_p05",
        evidence_status: "bounded_but_usable",
        evidence_refs: [fixture.evidence_ref],
        p05_question_codes: ["inspect_source_surface"],
        uncertainty_code: "bounded_metadata_only",
      },
    ],
    discoveries: [],
    branch_gap_codes: [],
    complete: true,
  };
}

class FencedClient implements ModelClient {
  providerPrompts = 0;
  lastOpening: string | undefined;

  constructor(private readonly response: string) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.admitResolvedModel?.({
      provider: SCA_P04_REQUIRED_MODEL.provider,
      model: SCA_P04_REQUIRED_MODEL.model,
    });
    const appendix = invocation.providerOpeningAppendix?.();
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "registration-bound",
      domainGuidance: "registration-bound",
      activeToolNames: [],
      ...(appendix === undefined ? {} : { providerOpeningAppendix: appendix }),
    });
    invocation.guardModelDispatch?.(opening);
    this.lastOpening = opening;
    this.providerPrompts += 1;
    return { text: this.response };
  }
}

function workers(store: ArtifactStore, client: ModelClient): WorkerExecutor {
  const executor = new WorkerExecutor(client, store, {
    projectRoot: PROJECT_ROOT,
    parallelConcurrency: 1,
    registration: SCA_P04_CANDIDATE_REGISTRATION,
  });
  executor.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
  return executor;
}

describe("SCA P04 registration-owned required model and provider opening", () => {
  it("keeps inactive zero-tool specialists distinct from ordinary artifact-only phases", () => {
    expect(resolvePlaybook(SCA_P04_CANDIDATE_PLAYBOOK_NAME)).toBeUndefined();
    expect(() =>
      validateRegistrationContract(SCA_P04_CANDIDATE_REGISTRATION, PROJECT_ROOT)
    ).not.toThrow();
    const worker = SCA_P04_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("expected P04 catalog worker");
    expect([...worker.phases.values()].map((phase) => phase.agent).sort()).toEqual([
      "annie",
      "echo",
    ]);
    expect(
      [...worker.phases.values()].every(
        (phase) =>
          canonicalJson(phase.required_model) === canonicalJson(SCA_P04_REQUIRED_MODEL) &&
          canonicalJson(phase.allowed_tools) === "[]" &&
          phase.provider_opening_guard === "sca_p04_payload_disclosure_v1"
      )
    ).toBe(true);
    const digest = runtimeRegistrationSha256(SCA_P04_CANDIDATE_REGISTRATION);
    const first = [...worker.phases.entries()][0];
    if (first === undefined) throw new Error("P04 phase absent");
    const drifted = {
      ...SCA_P04_CANDIDATE_REGISTRATION,
      worker: {
        ...worker,
        phases: new Map([
          ...[...worker.phases.entries()].filter(([state]) => state !== first[0]),
          [
            first[0],
            {
              ...first[1],
              required_model: { ...SCA_P04_REQUIRED_MODEL, alias: "drifted-alias" },
            },
          ],
        ]),
      },
    } as typeof SCA_P04_CANDIDATE_REGISTRATION;
    expect(runtimeRegistrationSha256(drifted)).not.toBe(digest);
    // Shared state names do not make the dormant candidate's inline/zero-tool
    // contract authoritative over the current ordinary registration or its prompts.
    expect(resolvePlaybook("sca")).toBe(SCA_PLAYBOOK_REGISTRATION);
    const ordinary = SCA_PLAYBOOK_REGISTRATION.worker;
    if (ordinary.kind !== "catalog-agent") throw new Error("expected ordinary SCA catalog worker");
    for (const state of worker.phases.keys()) {
      const phase = ordinary.phases.get(state);
      expect(phase?.allowed_tools).toEqual(["artifact_read"]);
      expect(phase?.required_model).toEqual(SCA_REQUIRED_MODEL);
      expect(phase?.provider_opening_guard).toBeUndefined();
    }
  });

  it("rejects model override and observed identity drift before private reads or provider calls", async () => {
    using store = temporaryStore();
    const fixture = providerFixture(store, "run-p04-model-drift");
    const client = new FencedClient("unused");
    await expect(
      workers(store, client).execute(
        branchDirective("run-p04-model-drift", fixture, {
          modelOverride: "ollama/not-the-required-model",
        })
      )
    ).rejects.toMatchObject({
      name: "PreDispatchPolicyDeniedError",
      blockerCode: "opening_policy_denied",
      message: "SCA P04 pre-dispatch required-model policy was denied",
    });
    expect(client.providerPrompts).toBe(0);

    let providerPrompts = 0;
    const wrongIdentity: ModelClient = {
      async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
        invocation.admitResolvedModel?.({ provider: "ollama", model: "wrong-model" });
        providerPrompts += 1;
        return { text: "unreachable" };
      },
    };
    await expect(
      workers(store, wrongIdentity).execute(branchDirective("run-p04-model-drift", fixture))
    ).rejects.toMatchObject({
      name: "PreDispatchPolicyDeniedError",
      blockerCode: "opening_policy_denied",
      message: "SCA P04 pre-dispatch resolved-model policy was denied",
    });
    expect(providerPrompts).toBe(0);
  });

  it("authorizes only the exact serialized opening, records its digest/bytes, and preserves raw-JSON fallback", async () => {
    using store = temporaryStore();
    const runId = "run-p04-model-exact";
    const fixture = providerFixture(store, runId);
    const rawJson = canonicalJson(validResult(fixture));
    const client = new FencedClient(rawJson);
    const executor = workers(store, client);
    const work = branchDirective(runId, fixture);

    const [result] = await executor.execute(work);
    expect(result?.details).toEqual(validResult(fixture));
    expect(result?.worker_receipt.requested_model).toEqual(SCA_P04_REQUIRED_MODEL);
    expect(result?.worker_receipt.observed_model).toEqual({
      provider: SCA_P04_REQUIRED_MODEL.provider,
      model: SCA_P04_REQUIRED_MODEL.model,
    });
    expect(client.providerPrompts).toBe(1);
    expect(client.lastOpening).toContain("P04 INLINE COGNITIVE INPUT (host-verified):");
    expect(client.lastOpening).not.toMatch(
      /artifact_read|sca_source_query|sca_graph_query|sca_application_test/u
    );

    const coordinate = {
      run_id: runId,
      state_id: "selecting_surfaces",
      branch_id: SCA_P04_SCANNER_SPECIALIST,
      agent: "annie",
      attempt: 1,
    };
    const guardRef = store.refFor(
      runId,
      "selecting_surfaces",
      SCA_P04_SCANNER_SPECIALIST,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = store.refFor(
      runId,
      "selecting_surfaces",
      SCA_P04_SCANNER_SPECIALIST,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    if (guardRef === null || receiptRef === null) throw new Error("model evidence refs absent");
    const guard = validateModelDispatchGuardV1(
      JSON.parse(store.readById(guardRef.artifact_id).toString("utf8"))
    );
    expect(guard.provider_opening_guard).toBe("sca_p04_payload_disclosure_v1");
    expect(guard.serialized_opening_byte_length).toBeGreaterThan(fixture.payload_ref.byte_length);
    expect(guard.serialized_opening_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const wrapper = validateModelExecutionReceiptV1(
      JSON.parse(store.readById(receiptRef.artifact_id).toString("utf8"))
    );
    expect(wrapper.schema_id).toBe(MODEL_EXECUTION_RECEIPT_V1_SCHEMA);

    await expect(executor.execute(work)).rejects.toBeInstanceOf(RemoteModelOutcomeUnknownError);
    expect(client.providerPrompts).toBe(1);
  });

  it("does not admit prose wrapped around an otherwise valid specialist summary", async () => {
    using store = temporaryStore();
    const runId = "run-p04-prose-wrapper";
    const fixture = providerFixture(store, runId);
    const client = new FencedClient(
      `This surface is vulnerable.\nSUMMARY:${canonicalJson(validResult(fixture))}`
    );
    const [result] = await workers(store, client).execute(branchDirective(runId, fixture));
    expect(result?.details).toEqual({});
    expect(client.providerPrompts).toBe(1);
  });

  it("deduplicates representative-scale exact evidence reads by full canonical artifact identity", async () => {
    using store = temporaryCountingStore();
    const runId = "run-p04-deduplicated-evidence";
    const fixture = providerFixture(store, runId, { itemCount: 128 });
    const client = new FencedClient(canonicalJson(validResult(fixture)));
    store.readsByArtifactId.clear();

    await workers(store, client).execute(branchDirective(runId, fixture));

    expect(client.providerPrompts).toBe(1);
    expect(store.readsByArtifactId.get(fixture.evidence_ref.artifact_id)).toBe(1);
  });

  it("rejects conflicting metadata for one evidence artifact ID before evidence reads or dispatch", async () => {
    using store = temporaryCountingStore();
    const runId = "run-p04-conflicting-evidence-ref";
    const fixture = providerFixture(store, runId, {
      itemCount: 2,
      conflictingEvidenceRefOnLastItem: true,
    });
    const client = new FencedClient(canonicalJson(validResult(fixture)));
    store.readsByArtifactId.clear();

    let denial: unknown;
    try {
      await workers(store, client).execute(branchDirective(runId, fixture));
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(PreDispatchPolicyDeniedError);
    expect(denial).toHaveProperty("blockerCode", "opening_policy_denied");
    expect(denial).toHaveProperty(
      "cause.message",
      expect.stringMatching(/conflicting canonical metadata/u)
    );
    expect(store.readsByArtifactId.get(fixture.evidence_ref.artifact_id) ?? 0).toBe(0);
    expect(client.providerPrompts).toBe(0);
  });

  it.each([
    {
      name: "wrong branch",
      fixture: (store: ArtifactStore, runId: string) => providerFixture(store, runId),
      directive: (runId: string, fixture: ProviderFixture) =>
        branchDirective(runId, fixture, { branchId: "underdetected_no_alert" }),
    },
    {
      name: "wrong task",
      fixture: (store: ArtifactStore, runId: string) => providerFixture(store, runId),
      directive: (runId: string, fixture: ProviderFixture) =>
        branchDirective(runId, fixture, { task: "Adjudicate this surface." }),
    },
    {
      name: "payload digest splice",
      fixture: (store: ArtifactStore, runId: string) =>
        providerFixture(store, runId, {
          disclosurePatch: (disclosure) => {
            const { admission_sha256: _digest, ...body } = disclosure;
            return withSelfDigest({ ...body, payload_sha256: "0".repeat(64) }, "admission_sha256");
          },
        }),
      directive: branchDirective,
    },
    {
      name: "policy destination drift",
      fixture: (store: ArtifactStore, runId: string) =>
        providerFixture(store, runId, {
          policy: { ...MODEL_POLICY, destination_class: "local" },
        }),
      directive: branchDirective,
    },
    {
      name: "denied source data class",
      fixture: (store: ArtifactStore, runId: string) =>
        providerFixture(store, runId, {
          policy: {
            ...MODEL_POLICY,
            data_classes: MODEL_POLICY.data_classes.map((entry) =>
              entry.data_class === "source-code" ? { ...entry, treatment: "deny" as const } : entry
            ),
          },
        }),
      directive: branchDirective,
    },
    {
      name: "oversized complete opening",
      fixture: (store: ArtifactStore, runId: string) =>
        providerFixture(store, runId, { openingLimitHeadroom: 64 }),
      directive: branchDirective,
    },
  ])("denies $name with zero provider calls", async ({ fixture: makeFixture, directive: make }) => {
    using store = temporaryStore();
    const runId = `run-p04-deny-${sha256(expect.getState().currentTestName ?? "case").slice(0, 12)}`;
    const fixture = makeFixture(store, runId);
    const client = new FencedClient(canonicalJson(validResult(fixture)));
    const work = make(runId, fixture);
    await expect(workers(store, client).execute(work)).rejects.toThrow();
    expect(client.providerPrompts).toBe(0);
    const branch = work.branches[0];
    if (branch === undefined) throw new Error("denial fixture branch absent");
    expect(
      store.refFor(
        runId,
        branch.state_id,
        branch.branch_id,
        "model-dispatch-guard",
        modelDispatchGuardOperationId({
          run_id: runId,
          state_id: branch.state_id,
          branch_id: branch.branch_id,
          agent: branch.agent,
          attempt: branch.attempt,
        }),
        1
      )
    ).toBeNull();
  });
});
