import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  validateContract,
  validateDirective,
  type ArtifactRef,
} from "../../orchestration/dist/contracts.js";
import { hostOperationPolicyBinding } from "../../orchestration/dist/host-operations/contracts.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/registry.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import { initializePennyState } from "../../orchestration/dist/state/setup.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  validateScaP03InitialProposalV1,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  createScaP03InitialQualificationRegistrationV1,
  readScaP03InitialGate,
  renderScaP03InitialQuestionsV1,
  scaP03InitialOperationInputs,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import { ScaP03NativeVerificationInvocationV1 } from "../src/p03-bootstrap-verification.js";
import { afterEach, expect, it, vi } from "vitest";
import * as files from "../src/p03-bootstrap-local-probe.js";
import {
  ScaP03InitialNativeHostV1,
  ScaP03PreLiveCapsuleV1Schema,
  type ScaP03PreLiveCapsuleV1,
} from "../src/p03-initial-host.js";
import {
  createScaP03InitialLiveAdapterV1,
  createScaP03InitialUseValidatorV1,
  ScaP03SealedBootstrapInputsV1Schema,
} from "../src/p03-initial-live.js";
import { assertScaP03ClosedDockerArgvV1 } from "../src/p03-live-transport.js";

afterEach(() => vi.restoreAllMocks());
it("refuses a missing native composition before file reads, probe effects or store provisioning", () => {
  const read = vi.spyOn(files, "readStableScaP03FileV1");
  const missing = () => {
    // @ts-expect-error -- negative compile contract: untrusted incomplete host construction must refuse before effects
    return new ScaP03InitialNativeHostV1({});
  };
  const missingAdapter = () => {
    // @ts-expect-error -- negative compile contract: callbacks and client approval cannot supply the native owners
    return createScaP03InitialLiveAdapterV1({ approval: true, assertAuthority: () => true });
  };
  expect(missing).toThrow("p03_initial_native_owners_required");
  expect(missingAdapter).toThrow("p03_initial_native_admission_required");
  expect(read).not.toHaveBeenCalled();
});
it("keeps the pre-live capsule CLOSED and excludes all final authority operands", () => {
  const digest = "a".repeat(64);
  const capsule = {
    schema_id: "penny.sca-p03-pre-live-capsule.v1",
    schema_version: 1,
    create_store: false,
    project_root: "/fixture/project",
    state_root: "/fixture/state",
    store_root: "/fixture/store",
    evidence_destination: "/fixture/evidence",
    source_manifest_sha256: digest,
    config: {
      docker_executable: "/fixture/bin/docker",
      image_ref: `example.invalid/fixture@sha256:${digest}`,
      expected_joern_version: "4.0.310",
      expected_docker_executable_sha256: digest,
      expected_docker_client_version: "test-only",
      expected_docker_server_version: "test-only",
      runtime_id: "fixture-runtime",
      isolation_id: "fixture-isolation",
      isolation_profile_sha256: digest,
      implementation_identity_sha256: digest,
      deployment_identity_sha256: digest,
      staging_parent: "/fixture/staging",
      memory_bytes: 1_073_741_824,
      cpus: 2,
      pids: 128,
      max_workspace_bytes: 67_108_864,
      max_num_def: 8000,
      max_command_output_bytes: 65_536,
      timeout_ms: 60_000,
    },
    docker_socket: "/fixture/docker.sock",
    node: { path: "/fixture/bin/node", sha256: digest },
    entrypoint: { path: "/fixture/host.mjs", sha256: digest },
    module_files: [{ path: "/fixture/host.mjs", sha256: digest }],
    deployment_roots: ["/fixture"],
    dependency_root: null,
    dependency_sha256: null,
    toolchain_version_commands: {
      php_frontend: [
        "find",
        "/opt/joern",
        "-type",
        "f",
        "-name",
        "io.joern.php2cpg-*.jar",
        "-printf",
        "%f\\n",
      ],
      javascript_frontend: [
        "find",
        "/opt/joern",
        "-type",
        "f",
        "-name",
        "io.joern.jssrc2cpg-*.jar",
        "-printf",
        "%f\\n",
      ],
      jvm: ["java", "--version"],
      php_runtime: ["php", "--version"],
      helper: ["python3", "--version"],
    },
  } satisfies ScaP03PreLiveCapsuleV1;
  // Establish an otherwise valid preimage: removing additionalProperties:false
  // must turn the unknown-field assertions red, not leave unrelated missing-field errors.
  expect(validateContract(ScaP03PreLiveCapsuleV1Schema, capsule, "valid pre-live capsule")).toEqual(
    capsule
  );
  const { source_manifest_sha256: sourceManifest, ...unboundCapsule } = capsule;
  expect(sourceManifest).toBe(digest);
  expect(() =>
    validateContract(ScaP03PreLiveCapsuleV1Schema, unboundCapsule, "unbound capsule")
  ).toThrow();
  for (const value of [null, "", "not-a-digest", "A".repeat(64)]) {
    expect(() =>
      validateContract(
        ScaP03PreLiveCapsuleV1Schema,
        { ...capsule, source_manifest_sha256: value },
        "invalid source commitment"
      )
    ).toThrow();
  }
  for (const field of [
    "final_p03_identity",
    "bootstrap_seal",
    "handoff",
    "selection",
    "final_issuance",
    "create_store",
  ]) {
    expect(() =>
      validateContract(
        ScaP03PreLiveCapsuleV1Schema,
        { ...capsule, [field]: true },
        "closed pre-live capsule"
      )
    ).toThrow();
  }
});
it("admits only reviewed fixed frontend and tool version probes, never target execution", () => {
  const id = "b".repeat(64),
    image = `example.invalid/fixture@sha256:${"a".repeat(64)}`;
  for (const component of ["joern-cli", "php2cpg", "jssrc2cpg"]) {
    expect(() =>
      assertScaP03ClosedDockerArgvV1(
        [
          "container",
          "exec",
          id,
          "find",
          "/opt/joern",
          "-type",
          "f",
          "-name",
          `io.joern.${component}-*.jar`,
          "-printf",
          "%f\\n",
        ],
        image
      )
    ).not.toThrow();
  }
  for (const tool of ["java", "php", "python3"])
    expect(() =>
      assertScaP03ClosedDockerArgvV1(["container", "exec", id, tool, "--version"], image)
    ).not.toThrow();
  for (const argv of [
    ["php", "/source/index.php"],
    ["python3", "-c", "arbitrary"],
    ["java", "-jar", "/source/application.jar"],
  ]) {
    expect(() =>
      assertScaP03ClosedDockerArgvV1(["container", "exec", id, ...argv], image)
    ).toThrow();
  }
});

const custodyRoots: string[] = [];
const custodyHandles: { close(): void }[] = [];
afterEach(() => {
  for (const handle of custodyHandles.splice(0).reverse()) handle.close();
  for (const root of custodyRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sealedCustodyFixture(defect: "none" | "parent" | "upstream" | "bytes" | "metadata") {
  const root = mkdtempSync(path.join(tmpdir(), "p03-sealed-custody-"));
  custodyRoots.push(root);
  const env = {
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_AUTO_START: "false",
  };
  const state = initializePennyState(root, { env });
  const store = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  custodyHandles.push(store);
  const run = "sealed-custody-run";
  const digest = sha256("offline sealed custody");
  const persist = (kind: string, content: unknown, upstream: ArtifactRef[] = []) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: run,
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id: `test:${kind}`,
        version: 1,
        producer: "host:sca-p03-initial-authorization",
        media_type: "application/json",
        content_schema: { schema_id: `penny.${kind}.v1`, schema_version: 1 },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content: canonicalJson(content),
    });
  const inert = persist("test-inert", { not_authority: true });
  const foreign = persist("test-foreign", { forbidden: true });
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
  // Schema-valid placeholders deliberately cannot establish native P02/P03 authority.
  // These tests must stop before the dependent native validator or recovery is invoked.
  const manifest = validateContract(
    ScaP03SealedBootstrapInputsV1Schema,
    {
      schema_id: "penny.sca-p03-sealed-bootstrap-inputs.v1",
      schema_version: 1,
      run_id: run,
      tenant_id: "test-tenant",
      project_id: state.projectId,
      accepted_p01: {
        request_ref: inert,
        obligation_ledger_ref: inert,
        campaign_manifest_core_ref: inert,
        admission_evidence_ref: inert,
        p01_gate_ref: inert,
        campaign_manifest_ref: inert,
        frozen_refs: [inert],
      },
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
        tenant_id: "test-tenant",
        project_id: state.projectId,
        phase_id: "SCA-P02",
        production_playbook_name: "sca-p02",
        qualification_run_id: "test-p02",
        activation_run_id: "test-p02-activation",
        proposed_start_sha256: digest,
        qualification_ref: inert,
        gate_ref: inert,
        authority_ref: inert,
      },
      root_tool_id: "test-root",
      toolchain_ref: inert,
      root_executable_ref: inert,
      root_measurement_ref: inert,
      deployment_sha256: digest,
      configuration_sha256: digest,
      evidence_destination_sha256: digest,
      resource_policy_sha256: sha256(canonicalJson(resources)),
      manifest_sha256: digest,
      source_manifest_sha256: digest,
      sealed_handoff_sha256: digest,
      production_record_ref: inert,
      record_ref: inert,
      binding_ref: inert,
      review_ref: inert,
      attestation_ref: inert,
    },
    "valid sealed custody fixture"
  );
  const first = persist(
    "sca-p03-sealed-bootstrap-inputs",
    manifest,
    defect === "upstream" ? [inert, foreign] : [inert]
  );
  const manifestRef =
    defect === "parent"
      ? store.persist({
          metadata: { ...store.metadata(first), version: 2, parent_ref: first },
          content: canonicalJson(manifest),
        })
      : first;
  const forbidden = defect === "parent" ? first : foreign;
  const spare = persist("test-spare", { unused: "x".repeat(forbidden.byte_length + 1) });
  const proofRefs = [inert, manifestRef, spare].sort((a, b) =>
    a.artifact_id.localeCompare(b.artifact_id)
  );
  const proposal = validateScaP03InitialProposalV1({
    schema_id: "penny.sca-p03-initial-proposal.v1",
    schema_version: 1,
    run_id: run,
    invocation_nonce: "test-nonce",
    approval_id: "test-approval",
    project_id: state.projectId,
    principal_id: "test-operator",
    policy_id: "test-policy",
    installation_id: "test-installation",
    revocation_generation: 1,
    state_authority_sha256: digest,
    backend_resource_sha256: digest,
    deployment_sha256: digest,
    configuration_sha256: digest,
    evidence_destination_sha256: digest,
    fixture_cohort_sha256: digest,
    issued_at: "2026-10-14T00:00:00Z",
    not_before: "2026-10-14T00:00:00Z",
    expires_at: "2026-10-14T01:00:00Z",
    effect: "bootstrap_verification",
    resources,
    input_refs: proofRefs,
    sealed_bootstrap_inputs_ref: manifestRef,
  });
  const proposalRef = persist("sca-p03-initial-proposal", proposal, proofRefs);
  const binding = new ScaP03InitialProposalBindingV1(store, proposalRef);
  const transportRef = persist(
    "sca-p03-initial-transport",
    {
      schema_id: "penny.sca-p03-initial-transport.v1",
      schema_version: 1,
      proposal_ref: proposalRef,
      gate_id: "test-gate",
      challenge: "test-challenge",
      questions: renderScaP03InitialQuestionsV1(proposal),
    },
    [proposalRef]
  );
  const gate = readScaP03InitialGate(store, proposalRef, transportRef);
  // A synthetic offline witness, not a private key/profile or real human approval.
  const witnessRef = persist(
    "sca-p03-initial-witness",
    {
      schema_version: 2,
      origin: "trusted-human-ui",
      run_id: run,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      artifact_ref: proposalRef,
      questionnaire_transport_ref: transportRef,
      rendered_questions_digest: gate.rendered_questions_digest,
      actor: "human:interactive-questionnaire",
      timestamp: "2026-10-14T00:01:00Z",
      decision: "approve",
      response: "approve",
      signature: digest,
    },
    [proposalRef, transportRef]
  );
  const authorization = new ScaP03InitialAuthorizationV1(
    {
      current: () => ({ ...proposal, revoked: false, permitted_effects: [proposal.effect] }),
      now: () => new Date("2026-10-14T00:02:00Z"),
      authenticatedInteractivePrincipal: () => proposal.principal_id,
      assertCurrentInputs: () => undefined,
    },
    { verify: () => true },
    binding
  );
  const registration = createScaP03InitialQualificationRegistrationV1({ authorization, binding });
  const declaration = registration.host_operations?.declarations[0];
  if (declaration === undefined) throw new Error("missing custody declaration");
  const directive = validateDirective({
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: {
      schema_version: 2,
      run_id: run,
      session_id: "test-session",
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
  if (directive.action !== "invoke_host_operation") throw new Error("invalid custody directive");
  const service = new OrchestrationService({
    projectRoot: root,
    env,
    playbookRegistration: registration,
    enableChildWorkflows: false,
    modelClient: {
      async runAgent() {
        throw new Error("model execution forbidden");
      },
    },
  });
  custodyHandles.push(service);
  // Inert dependent host: no constructor, measurements, authority or effects. The sentinel
  // makes omitted/late finish() discriminating instead of failing on placeholder authority.
  const native: unknown = Object.create(ScaP03InitialNativeHostV1.prototype);
  if (!(native instanceof ScaP03InitialNativeHostV1)) throw new Error("invalid test host");
  const dependent = vi.spyOn(native, "assertSealedInputs").mockImplementation(() => {
    throw new Error("dependent_sealed_inputs_reached");
  });
  const recover = vi.spyOn(service, "execute");
  const originalRead = service.artifacts.read.bind(service.artifacts);
  const reads = vi.spyOn(service.artifacts, "read");
  const byId = vi.spyOn(service.artifacts, "readById");
  const coordinate = vi.spyOn(service.artifacts, "refFor");
  const latest = vi.spyOn(service.artifacts, "lastVersion");
  if (defect === "bytes") {
    let manifestReads = 0;
    reads.mockImplementation((ref) => {
      const bytes = originalRead(ref);
      return ref.artifact_id === manifestRef.artifact_id && ++manifestReads > 1
        ? Buffer.concat([bytes, Buffer.from(" ")])
        : bytes;
    });
  }
  if (defect === "metadata") {
    const original = service.artifacts.metadata.bind(service.artifacts);
    let manifestReads = 0;
    vi.spyOn(service.artifacts, "metadata").mockImplementation((ref) => {
      const metadata = original(ref);
      return ref.artifact_id === manifestRef.artifact_id && ++manifestReads > 1
        ? { ...metadata, upstream_refs: [] }
        : metadata;
    });
  }
  return {
    service,
    authorization,
    binding,
    proposalRef,
    directive,
    declaration,
    native,
    dependent,
    recover,
    reads,
    byId,
    coordinate,
    latest,
    manifestRef,
    forbidden,
    inert,
  };
}

for (const path of ["initial-use", "consumed-verification"] as const) {
  it.each(["parent", "upstream", "bytes", "metadata", "none"] as const)(
    `${path} finishes sealed custody before dependent use (%s)`,
    async (defect) => {
      const f = sealedCustodyFixture(defect);
      const run = async () => {
        if (path === "initial-use") {
          const validator = createScaP03InitialUseValidatorV1({
            store: f.service.artifacts,
            authorization: f.authorization,
            binding: f.binding,
            native_host: f.native,
          });
          await validator.validateUse({
            directive: f.directive,
            declaration: f.declaration,
            request_bytes: f.service.artifacts.read(f.proposalRef),
            signal: new AbortController().signal,
            reportWorkMilestone: () => undefined,
          });
        } else {
          await new ScaP03NativeVerificationInvocationV1({
            service: f.service,
            directive: f.directive,
            authorization: f.authorization,
            native_host: f.native,
            binding: f.binding,
          }).collect();
        }
      };
      const expected =
        defect === "none"
          ? "dependent_sealed_inputs_reached"
          : defect === "bytes"
            ? "changed_bytes"
            : defect === "metadata"
              ? "changed_provenance"
              : "unapproved_ref";
      await expect(run()).rejects.toThrow(expected);
      expect(f.reads.mock.calls.some(([ref]) => ref.artifact_id === f.forbidden.artifact_id)).toBe(
        false
      );
      expect(f.byId.mock.calls.some(([id]) => id === f.forbidden.artifact_id)).toBe(false);
      expect(f.recover).not.toHaveBeenCalled();
      if (defect === "none") {
        expect(f.dependent).toHaveBeenCalledOnce();
        for (const ref of [f.manifestRef, f.inert])
          expect(
            f.reads.mock.calls.filter(([r]) => r.artifact_id === ref.artifact_id).length
          ).toBeGreaterThanOrEqual(2);
      } else expect(f.dependent).not.toHaveBeenCalled();
      if (defect === "parent") {
        expect(f.coordinate).not.toHaveBeenCalled();
        expect(f.latest).not.toHaveBeenCalled();
      }
    }
  );
}
