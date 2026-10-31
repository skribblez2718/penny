import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateDirective, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  type HostOperationExecutionContextV1,
  hostOperationPolicyBinding,
} from "../../orchestration/dist/host-operations/contracts.js";
import { createPreparedHostOperationCallRecord } from "../../orchestration/dist/host-operations/storage.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/registry.js";
import { scaProposedStartSha256 } from "../../orchestration/dist/sca/qualification-activation.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  validateScaP03InitialProposalV1,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  createScaP03InitialQualificationRegistrationV1,
  renderScaP03InitialQuestionsV1,
  readScaP03InitialGate,
  scaP03InitialOperationInputs,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import {
  signTrustedHumanEvent,
  verifyExecutionOwnerSignature,
} from "../../../.pi/extensions/skill/execution-receipts.js";
import { createScaP03DockerOwnedInitialCandidateV1 } from "../src/p03-docker-runtime.js";
import * as initial from "../src/p03-initial-live.js";
import {
  ScaP03CliProductionFreezeHandoffSchema,
  parseScaP03CliCanonical,
} from "../src/p03-bootstrap-cli-contracts.js";
import {
  productionSamplerFixture,
  disposeSamplerFixtures,
} from "./p03-production-sampler-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  disposeSamplerFixtures();
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
  max_source_bytes: 1_048_576,
  max_source_files: 3,
  max_graph_bytes: 1024,
  max_query_bytes: 4096,
  max_query_items: 256,
  max_page_items: 64,
  max_pages_per_query: 4,
  max_ast_depth: 256,
  max_ast_nodes: 4096,
  max_num_def: 1000,
  jvm_heap_bytes: 536_870_912,
  max_host_workspace_bytes: 4_194_304,
  max_evidence_bytes: 1_048_576,
};
async function fixture(change?: (value: initial.ScaP03PreLiveInputsV1) => unknown) {
  // Existing disposable contract fixture supplies actual native oracle/preimage bytes.
  // Its post-live refs/files NEVER enter this operation's bound closure. No Docker is run.
  const f = await productionSamplerFixture();
  using store = new ArtifactStore(f.storeRoot, { projectId: f.project_id }, "existing");
  const handoff = parseScaP03CliCanonical(
    ScaP03CliProductionFreezeHandoffSchema,
    readFileSync(f.freezePath)
  );
  const b = handoff.bindings;
  const roots = handoff.production_bindings.roots;
  const persist = (kind: string, schema: string, content: unknown, upstream: ArtifactRef[] = []) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: f.run_id,
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id: `prepared:${kind}`,
        version: 1,
        producer: "host:sca-p03-initial-authorization",
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: 1 },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content: canonicalJson(content),
    });
  // Intentionally inert P02 placeholders. The preparation MUST report native admission
  // not_performed rather than accepting this fixture's claims as current authority.
  const inert = persist("test-inert-p02", "penny.test-inert-p02.v1", { not_authority: true });
  const startProjection = {
    tenant_id: "test-tenant",
    project_id: f.project_id,
    phase_id: "SCA-P02" as const,
    production_playbook_name: "sca-p02" as const,
    qualification_run_id: "test-p02",
    activation_run_id: "test-p02-activation",
    qualification_ref: inert,
    gate_ref: inert,
  };
  const manifest: initial.ScaP03PreLiveInputsV1 = {
    schema_id: "penny.sca-p03-pre-live-inputs.v1",
    schema_version: 1,
    run_id: f.run_id,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    ...roots,
    accepted_p02: {
      transition_ref: inert,
      p02_request_ref: inert,
      gate_ref: inert,
      m1_ref: inert,
      coverage_matrix_ref: inert,
      evidence_manifest_ref: inert,
      successor_ledger_ref: inert,
      qualification_definition_ref: inert,
      qualification_gate_ref: inert,
      evidence_refs: Array.from({ length: 26 }, () => inert),
    },
    p02_authority_ref: inert,
    p02_issuance_ref: inert,
    p02_proposed_start: {
      ...startProjection,
      authority_ref: inert,
      proposed_start_sha256: scaProposedStartSha256(startProjection),
    },
    fixture_corpus_ref: b.fixture_corpus_ref,
    fixture_content_refs: [...b.fixture_content_refs],
    source_oracle_ref: b.source_oracle_ref,
    source_oracle_review_ref: b.source_oracle_review_ref,
    source_oracle_validation_ref: b.source_oracle_validation_ref,
    qualification_profile_ref: b.qualification_profile_ref,
    baseline_query_set_ref: b.baseline_query_set_ref,
    query_script_refs: [...b.query_script_refs],
    query_plan_refs: [...b.query_plan_refs],
    deployment_sha256: sha256("test-protected-deployment-not-measured"),
    configuration_sha256: sha256("test-private-config-not-measured"),
    evidence_destination_sha256: sha256("test-private-destination"),
    resource_policy_sha256: sha256(canonicalJson(resources)),
  };
  const source = change === undefined ? manifest : change(manifest);
  const manifestRef = persist(
    "sca-p03-pre-live-inputs",
    "penny.sca-p03-pre-live-inputs.v1",
    source
  );
  const refs = [
    manifestRef,
    inert,
    ...Object.values(roots.accepted_p01).flatMap((v) => (Array.isArray(v) ? v : [v])),
    roots.toolchain_ref,
    roots.root_executable_ref,
    roots.root_measurement_ref,
    b.fixture_corpus_ref,
    ...b.fixture_content_refs,
    b.source_oracle_ref,
    b.source_oracle_review_ref,
    b.source_oracle_validation_ref,
    b.qualification_profile_ref,
    b.baseline_query_set_ref,
    ...b.query_script_refs,
    ...b.query_plan_refs,
  ];
  const proofRefs = [...new Map(refs.map((ref) => [ref.artifact_id, ref])).values()].sort((a, b) =>
    a.artifact_id.localeCompare(b.artifact_id)
  );
  const proposal = validateScaP03InitialProposalV1({
    schema_id: "penny.sca-p03-initial-proposal.v1",
    schema_version: 1,
    run_id: f.run_id,
    invocation_nonce: "test-prepared-nonce",
    approval_id: "test-prepared-approval",
    project_id: f.project_id,
    principal_id: "test-operator",
    policy_id: "test-policy",
    installation_id: "test-installation",
    revocation_generation: 1,
    state_authority_sha256: sha256("test-state"),
    backend_resource_sha256: sha256("test-shared-backend"),
    deployment_sha256: manifest.deployment_sha256,
    configuration_sha256: manifest.configuration_sha256,
    evidence_destination_sha256: manifest.evidence_destination_sha256,
    fixture_cohort_sha256: b.fixture_corpus_ref.content_digest,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    not_before: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    effect: "fixture_qualification",
    resources,
    input_refs: proofRefs,
  });
  const proposalRef = persist("sca-p03-initial-proposal", proposal.schema_id, proposal, proofRefs);
  const questions = renderScaP03InitialQuestionsV1(proposal);
  const pin = new ScaP03InitialProposalBindingV1(store, proposalRef);
  const transportRef = persist(
    "sca-p03-initial-transport",
    "penny.sca-p03-initial-transport.v1",
    {
      schema_id: "penny.sca-p03-initial-transport.v1",
      schema_version: 1,
      proposal_ref: proposalRef,
      gate_id: "test-initial-gate",
      challenge: "test-challenge",
      questions,
    },
    [proposalRef]
  );
  const binding = readScaP03InitialGate(store, proposalRef, transportRef);
  const event = signTrustedHumanEvent({
    runId: f.run_id,
    gateId: binding.gate_id,
    challenge: binding.challenge,
    artifactRef: proposalRef,
    transportRef,
    renderedQuestionsDigest: binding.rendered_questions_digest,
    response: "approve",
  });
  const witnessRef = persist("sca-p03-initial-witness", "penny.sca-p03-initial-witness.v1", event, [
    proposalRef,
    transportRef,
  ]);
  const authorization = new ScaP03InitialAuthorizationV1(
    {
      current: () => ({
        ...proposal,
        revoked: false,
        permitted_effects: ["fixture_qualification"],
      }),
      now: () => new Date(),
      authenticatedInteractivePrincipal: () => proposal.principal_id,
      // Test-only profile permits PREPARATION, never native P02 admission or live effects.
      assertCurrentInputs: () => undefined,
    },
    { verify: verifyExecutionOwnerSignature },
    pin
  );
  const registration = createScaP03InitialQualificationRegistrationV1({
    authorization,
    binding: pin,
  });
  const declaration = registration.host_operations?.declarations[0];
  if (declaration === undefined) throw new Error("test operation declaration missing");
  const directive = validateDirective({
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: {
      schema_version: 2,
      run_id: f.run_id,
      session_id: "test-prepared",
      playbook: registration.name,
      engine_owner: "typescript",
    },
    state_id: "sca_p03_initial_qualification",
    attempt: 1,
    operation_id: `initial:${proposal.approval_id}:${proposal.invocation_nonce}`,
    operation_kind: declaration.operation_kind,
    registration_sha256: runtimeRegistrationSha256(registration),
    request_ref: proposalRef,
    request_sha256: proposalRef.content_digest,
    input_artifacts: scaP03InitialOperationInputs(proposalRef, transportRef, witnessRef, proofRefs),
    expected_result: declaration.result,
    policy_binding: hostOperationPolicyBinding(declaration, proposal.backend_resource_sha256),
  });
  if (directive.action !== "invoke_host_operation") throw new Error("test directive invalid");
  const noEffect = vi.fn(() => {
    throw new Error("prepared probe must not create effects");
  });
  const context: HostOperationExecutionContextV1 = {
    directive,
    declaration,
    request_bytes: store.read(proposalRef),
    signal: new AbortController().signal,
    journal: createPreparedHostOperationCallRecord({
      project_id: f.project_id,
      directive,
      timestamp: new Date().toISOString(),
      queue_inactivity_expires_at_ms: Date.now() + 60_000,
      operation_inactivity_expires_at_ms: Date.now() + 60_000,
    }),
    readInput(slot) {
      const bound = directive.input_artifacts.artifacts.find((b) => b.slot === slot);
      if (bound === undefined) throw new Error("test exact slot absent");
      return { ref: bound.ref, bytes: store.read(bound.ref) };
    },
    beginSubmission: noEffect,
    reportActivity: noEffect,
    emitProgress: noEffect,
    recordRemoteAccepted: noEffect,
    cacheResult: noEffect,
    readCachedResult: noEffect,
    recordFetched: noEffect,
    persist: noEffect,
    registerRemoteCancellation: noEffect,
  };
  // Even counterfeit caller callbacks cannot open the disabled initial candidate.
  await expect(
    createScaP03DockerOwnedInitialCandidateV1(f.manifest.config, noEffect, {
      context,
      resources,
      authorization,
      proposal,
      gate: binding,
      pre_live: manifest,
      store,
    })
  ).rejects.toThrow("p03_initial_native_admission_required");
  expect(noEffect).not.toHaveBeenCalled();
  const reads = vi.spyOn(store, "read");
  const run = () =>
    initial.prepareScaP03InitialProbeV1({ store, authorization, proposal, context });
  try {
    return {
      result: run(),
      readRefs: reads.mock.calls.map(([r]) => r),
      noEffect,
      manifestRef,
      manifest,
      blockedRefs: [f.record_ref, b.runtime_identity_ref],
    };
  } finally {
    expect(noEffect).not.toHaveBeenCalled();
  }
}

it("prepares reviewed exact preimages without ANY sealed/current/final input, and remains typed blocked", async () => {
  const f = await fixture();
  expect(f.result).toMatchObject({
    status: "blocked",
    predecessor_current_admission: "not_performed",
    environment_measurement: "not_performed",
    fixture_execution: "not_performed",
    cleanup: "no_effects_created",
    activation_granted: false,
    p04_dispatch_permitted: false,
  });
  expect(f.result.missing_input).toContain("initial_owned_environment_and_fixture_collector");
  for (const ref of f.blockedRefs) expect(f.readRefs).not.toContainEqual(ref);
  expect(initial).toHaveProperty("createScaP03InitialLiveAdapterV1");
  expect(initial).not.toHaveProperty("createScaP03InitialLiveOwnerV1");
});
it.each([
  "production_bindings",
  "sealed_handoff_ref",
  "selection_ref",
  "current_p03_authority_ref",
])("rejects post-live field %s before any effect", async (name) => {
  await expect(fixture((m) => ({ ...m, [name]: { status: "PASS" } }))).rejects.toThrow(
    "P03 pre-live inputs"
  );
});
it("rejects substituted query preimages and protected policy commitments without effects", async () => {
  await expect(
    fixture((m) => ({ ...m, query_script_refs: [...m.query_script_refs].reverse() }))
  ).rejects.toThrow("p03_initial");
  await expect(
    fixture((m) => ({ ...m, resource_policy_sha256: sha256("changed policy") }))
  ).rejects.toThrow("p03_initial_pre_live_binding_mismatch");
});
