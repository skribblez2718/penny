import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../../../../apps/orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../../../../apps/orchestration/dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
} from "../../../../../apps/orchestration/dist/contracts.js";
import { SqliteScaActivationOwner } from "../../../../../apps/orchestration/dist/sca/activation-owner.js";
import { SqliteScaPhaseActivationRegistry } from "../../../../../apps/orchestration/dist/sca/phase-activation.js";
import {
  validateScaP03InitialProposalV1,
  type ScaP03InitialProposalV1,
} from "../../../../../apps/orchestration/dist/sca/p03-initial-authorization.js";
import { initializePennyState } from "../../../../../apps/orchestration/dist/state/setup.js";
import type { ScaP03InitialNativeHostV1 } from "../../../../../apps/sca-service/src/p03-initial-host.js";
import {
  ScaP03PreLiveInputsV1Schema,
  ScaP03SealedBootstrapInputsV1Schema,
} from "../../../../../apps/sca-service/src/p03-initial-live.js";
import { createScaP03NativeOperatorHostV1 } from "../../src/native-operator.js";

// Keep real proposal/profile admission, typed manifests, store metadata and approved-reader
// traversal. Only protected native deployment construction/checks are observation doubles:
// no capsule/private setup, operator authentication, keys, live work or P02 admission occurs.
const native = vi.hoisted(() => ({
  capsule: vi.fn<ScaP03InitialNativeHostV1["assertCapsule"]>(),
  sealed: vi.fn<ScaP03InitialNativeHostV1["assertSealedInputs"]>(),
  predecessor: vi.fn<ScaP03InitialNativeHostV1["assertPredecessorClosure"]>(),
  currentP02: vi.fn<ScaP03InitialNativeHostV1["assertCurrentP02"]>(),
}));
vi.mock("../../../../../apps/sca-service/src/p03-initial-host.js", () => ({
  ScaP03InitialNativeHostV1: class {
    assertCapsule = native.capsule;
    assertSealedInputs = native.sealed;
    assertPredecessorClosure = native.predecessor;
    assertCurrentP02 = native.currentP02;
  },
}));

beforeEach(() => {
  for (const check of Object.values(native)) check.mockReset();
});
afterEach(() => vi.restoreAllMocks());

type Effect = ScaP03InitialProposalV1["effect"];
type Closure = "approved" | "parent" | "upstream";

async function withAdmissionFixture(
  effect: Effect,
  closure: Closure,
  work: (fixture: {
    host: Awaited<ReturnType<typeof createScaP03NativeOperatorHostV1>>;
    proposal: ScaP03InitialProposalV1;
    manifest: ArtifactRef;
    forbidden: ArtifactRef;
    linked: ArtifactRef;
    profileCheck: ReturnType<typeof vi.fn<(proposal: ScaP03InitialProposalV1) => void>>;
  }) => void,
  malformed = false
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "p03-native-closure-"));
  try {
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    const state = initializePennyState(root, { env });
    using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const persist = (
      kind: string,
      content: unknown,
      upstream_refs: ArtifactRef[] = [],
      parent_ref: ArtifactRef | null = null
    ) =>
      store.persist({
        metadata: {
          schema_version: 2,
          run_id: "pinned-run",
          phase: "SCA-P03",
          branch_id: null,
          kind,
          operation_id: kind,
          version: parent_ref === null ? 1 : parent_ref.version + 1,
          producer: "host:sca-p03-initial-authorization",
          media_type: "application/json",
          content_schema: { schema_id: `penny.${kind}.v1`, schema_version: 1 },
          parent_ref,
          upstream_refs,
        },
        content: canonicalJson(content),
      });
    const inert = persist("test-inert-p02", { not_authority: true });
    const forbidden = persist("test-closure-link", { unapproved: true });
    // A direct unapproved manifest parent rejects during json(), so it cannot catch
    // the finish() ordering bug. Reach an approved v2 through manifest provenance;
    // only finish() encounters its unapproved v1 parent, before native parent lookup.
    const linked =
      closure === "parent"
        ? persist("test-closure-link", { approved: true }, [], forbidden)
        : closure === "upstream"
          ? forbidden
          : inert;
    const common = {
      schema_version: 1,
      run_id: "pinned-run",
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
        qualification_definition_ref: inert,
        qualification_gate_ref: inert,
        m1_ref: inert,
        coverage_matrix_ref: inert,
        evidence_manifest_ref: inert,
        successor_ledger_ref: inert,
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
        proposed_start_sha256: sha256("inert-not-authority"),
        qualification_ref: inert,
        gate_ref: inert,
        authority_ref: inert,
      },
      root_tool_id: "test-root",
      toolchain_ref: inert,
      root_executable_ref: inert,
      root_measurement_ref: inert,
      deployment_sha256: sha256("deployment"),
      configuration_sha256: sha256("config"),
      evidence_destination_sha256: sha256("evidence"),
      resource_policy_sha256: sha256("resource-policy"),
    };
    const sealed = effect === "bootstrap_verification";
    const kind = sealed ? "sca-p03-sealed-bootstrap-inputs" : "sca-p03-pre-live-inputs";
    const value = sealed
      ? validateContract(
          ScaP03SealedBootstrapInputsV1Schema,
          {
            ...common,
            schema_id: `penny.${kind}.v1`,
            manifest_sha256: sha256("manifest"),
            source_manifest_sha256: sha256("source"),
            sealed_handoff_sha256: sha256("handoff"),
            production_record_ref: inert,
            record_ref: inert,
            binding_ref: inert,
            review_ref: inert,
            attestation_ref: inert,
          },
          "test sealed manifest"
        )
      : validateContract(
          ScaP03PreLiveInputsV1Schema,
          {
            ...common,
            schema_id: `penny.${kind}.v1`,
            fixture_corpus_ref: inert,
            fixture_content_refs: Array.from({ length: 3 }, () => inert),
            source_oracle_ref: inert,
            source_oracle_review_ref: inert,
            source_oracle_validation_ref: inert,
            qualification_profile_ref: inert,
            baseline_query_set_ref: inert,
            query_script_refs: Array.from({ length: 7 }, () => inert),
            query_plan_refs: Array.from({ length: 7 }, () => inert),
          },
          "test pre-live manifest"
        );
    const manifest = persist(kind, malformed ? { ...value, run_id: null } : value, [linked]);
    const catalog = lstatSync(path.join(env.PENNY_STATE_ROOT, "catalog.db"));
    const proposal = validateScaP03InitialProposalV1({
      schema_id: "penny.sca-p03-initial-proposal.v1",
      schema_version: 1,
      run_id: common.run_id,
      project_id: common.project_id,
      deployment_sha256: common.deployment_sha256,
      configuration_sha256: common.configuration_sha256,
      evidence_destination_sha256: common.evidence_destination_sha256,
      invocation_nonce: "nonce",
      approval_id: "approval",
      principal_id: "test-principal",
      policy_id: "test-policy",
      installation_id: "test-installation",
      revocation_generation: 1,
      state_authority_sha256: sha256(
        canonicalJson({
          state_root: env.PENNY_STATE_ROOT,
          catalog_dev: catalog.dev,
          catalog_ino: catalog.ino,
        })
      ),
      backend_resource_sha256: sha256("backend"),
      fixture_cohort_sha256: inert.content_digest,
      issued_at: "2026-01-01T00:00:00Z",
      not_before: "2026-01-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      effect,
      ...(sealed ? { sealed_bootstrap_inputs_ref: manifest } : {}),
      input_refs: [
        ...new Map(
          [manifest, inert, ...(closure === "parent" ? [linked] : [])].map((ref) => [
            ref.artifact_id,
            ref,
          ])
        ).values(),
      ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
      resources: {
        cpus: 1,
        memory_bytes: 1024,
        pids: 1,
        tmp_bytes: 1,
        work_bytes: 100,
        command_output_bytes: 100,
        concurrency: 1,
        inactivity_ms: 60_000,
        cleanup_grace_ms: 100,
        max_commands: 1,
        max_source_bytes: 1,
        max_source_files: 1,
        max_graph_bytes: 1,
        max_query_bytes: 1,
        max_query_items: 1,
        max_page_items: 1,
        max_pages_per_query: 1,
        max_ast_depth: 1,
        max_ast_nodes: 1,
        max_num_def: 1,
        jvm_heap_bytes: 1,
        max_host_workspace_bytes: 1,
        max_evidence_bytes: 1,
      },
    });
    const proposalRef = persist("sca-p03-initial-proposal", proposal);
    using owner = new SqliteScaActivationOwner({
      directory: path.join(root, "p02-owner"),
      issuer_policy_id: proposal.policy_id,
      operator_principal_id: proposal.principal_id,
      revocation_generation: 1,
      installation_authenticator_id: proposal.installation_id,
      installation_authenticator: {
        authenticator_id: proposal.installation_id,
        withLock<T>(): T {
          throw new Error("P02 authentication forbidden");
        },
        authenticate() {
          throw new Error("P02 authentication forbidden");
        },
      },
      max_admission_age_ms: 60_000,
    });
    using registry = new SqliteScaPhaseActivationRegistry({
      directory: path.join(root, "p02-registry"),
    });
    const profileCheck = vi.fn<(proposal: ScaP03InitialProposalV1) => void>();
    const contract = {
      artifact_kind: inert.kind,
      schema_id: "penny.test-inert-p02.v1",
      schema_version: 1,
      producer: inert.producer,
      media_type: inert.media_type,
      max_bytes: 1024,
    };
    using host = await createScaP03NativeOperatorHostV1({
      project_root: root,
      env,
      approved_state_root: env.PENNY_STATE_ROOT,
      approved_backend_resource_sha256: proposal.backend_resource_sha256,
      capsule_path: path.join(root, "absent-capsule"),
      capsule_sha256: sha256("no-private-capsule"),
      proposal_ref: proposalRef,
      profile: {
        current: () => ({ ...proposal, revoked: false, permitted_effects: [effect] }),
        now: () => new Date("2026-10-14T00:00:00Z"),
        authenticatedInteractivePrincipal: () => undefined,
        assertCurrentInputs: profileCheck,
      },
      p02_owner: owner,
      p02_registry: registry,
      p02_host: {
        project_root: root,
        partition_project_id: state.projectId,
        tenant_id: common.tenant_id,
        project_id: state.projectId,
        definition_ref: inert,
        gate_ref: inert,
        operational_summary_ref: inert,
        issuer_policy_id: proposal.policy_id,
        issuance_contract: contract,
        authority_contract: contract,
        revocation_generation: 1,
      },
    });
    work({ host, proposal, manifest, forbidden, linked, profileCheck });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const effect of ["fixture_qualification", "bootstrap_verification"] as const) {
  describe(`native operator ${effect} manifest custody`, () => {
    for (const closure of ["parent", "upstream"] as const) {
      it(`rejects an unapproved ${closure} before dependent native checks or forbidden lookup`, async () => {
        await withAdmissionFixture(
          effect,
          closure,
          ({ host, proposal, manifest, forbidden, linked, profileCheck }) => {
            const byId = vi.spyOn(ArtifactStore.prototype, "refById");
            const read = vi.spyOn(ArtifactStore.prototype, "read");
            const readById = vi.spyOn(ArtifactStore.prototype, "readById");
            const metadata = vi.spyOn(ArtifactStore.prototype, "metadata");
            const coordinate = vi.spyOn(ArtifactStore.prototype, "refFor");
            const latest = vi.spyOn(ArtifactStore.prototype, "lastVersion");
            expect(() => host.authorization.assertProposal(proposal)).toThrow(
              "ref_mismatch: unapproved_ref"
            );
            expect(profileCheck).toHaveBeenCalledTimes(1);
            expect(profileCheck).toHaveBeenCalledWith(proposal);
            expect(native.capsule).toHaveBeenCalledTimes(1);
            expect(native.capsule).toHaveBeenCalledWith(proposal);
            expect(native.sealed).not.toHaveBeenCalled();
            expect(native.predecessor).not.toHaveBeenCalled();
            expect(native.currentP02).not.toHaveBeenCalled();
            expect(read.mock.calls.map(([ref]) => ref.artifact_id)).toEqual(
              closure === "parent"
                ? [manifest.artifact_id, linked.artifact_id]
                : [manifest.artifact_id]
            );
            expect(byId).not.toHaveBeenCalledWith(forbidden.artifact_id);
            expect(readById).not.toHaveBeenCalled();
            expect(
              metadata.mock.calls.every(([ref]) => ref.artifact_id !== forbidden.artifact_id)
            ).toBe(true);
            expect(coordinate).not.toHaveBeenCalled();
            expect(latest).not.toHaveBeenCalled();
          }
        );
      });
    }

    it("allows dependent checks only after closure traversal and drift readback", async () => {
      await withAdmissionFixture(
        effect,
        "approved",
        ({ host, proposal, manifest, linked, profileCheck }) => {
          const read = vi.spyOn(ArtifactStore.prototype, "read");
          const expectClosed = () =>
            expect(read.mock.calls.map(([ref]) => ref.artifact_id)).toEqual([
              manifest.artifact_id,
              linked.artifact_id,
              manifest.artifact_id,
              linked.artifact_id,
            ]);
          native.sealed.mockImplementation(expectClosed);
          native.predecessor.mockImplementation(expectClosed);
          native.currentP02.mockImplementation(expectClosed);
          host.authorization.assertProposal(proposal);
          expect(profileCheck).toHaveBeenCalledTimes(1);
          expect(profileCheck).toHaveBeenCalledWith(proposal);
          expect(native.capsule).toHaveBeenCalledTimes(1);
          expect(native.capsule).toHaveBeenCalledWith(proposal);
          expect(native.sealed).toHaveBeenCalledTimes(effect === "bootstrap_verification" ? 1 : 0);
          expect(native.predecessor).toHaveBeenCalledTimes(
            effect === "fixture_qualification" ? 1 : 0
          );
          expect(native.currentP02).toHaveBeenCalledTimes(
            effect === "fixture_qualification" ? 1 : 0
          );
        }
      );
    });

    it("validates the typed manifest before closure traversal or dependent checks", async () => {
      await withAdmissionFixture(
        effect,
        "upstream",
        ({ host, proposal, manifest }) => {
          const read = vi.spyOn(ArtifactStore.prototype, "read");
          expect(() => host.authorization.assertProposal(proposal)).toThrow(
            /P03 native (sealed|pre-live) inputs/
          );
          expect(read.mock.calls.map(([ref]) => ref.artifact_id)).toEqual([manifest.artifact_id]);
          expect(native.sealed).not.toHaveBeenCalled();
          expect(native.predecessor).not.toHaveBeenCalled();
          expect(native.currentP02).not.toHaveBeenCalled();
        },
        true
      );
    });
  });
}
