import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import * as operational from "../../orchestration/dist/sca/p03-operational-replay.js";
import * as predecessor from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import * as admission from "../../orchestration/dist/sca/qualification-activation.js";
import { SCA_P02_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p02-playbook.js";
import { validateScaP03BootstrapQualificationRecordV3 } from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  setupScaP03QualificationFixture,
  fixtureScaP03Request,
} from "../../orchestration/tests/helpers/sca-p03-qualification-fixture.js";
import {
  parseScaP03CliCanonical,
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionSealedHandoffSchema,
} from "../src/p03-bootstrap-cli-contracts.js";
import { createScaP03ProductionActivationHostV1 } from "../src/p03-production-activation.js";
import {
  productionSamplerFixture,
  disposeSamplerFixtures,
  verificationChild,
  samplerAuthorityFixture,
} from "./p03-production-sampler-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  disposeSamplerFixtures();
});

/** Only separately qualified formal/operational/P02 prerequisites are fixtures.
 * Bootstrap sampler, child transport, signature/custody/proof reconstruction and source
 * measurement are real. Docker observations are fixture-only. Nothing here qualifies a host. */
async function compositionFixture() {
  const f = await productionSamplerFixture();
  const q = setupScaP03QualificationFixture();
  const sealed = parseScaP03CliCanonical(
    ScaP03CliProductionSealedHandoffSchema,
    readFileSync(f.sealedPath)
  );
  const frozen = parseScaP03CliCanonical(
    ScaP03CliProductionFreezeHandoffSchema,
    readFileSync(f.freezePath)
  );
  const store = ArtifactStore.openExisting(f.storeRoot, { projectId: f.project_id });
  const record = validateScaP03BootstrapQualificationRecordV3(
    operational.readScaP03CurrentJson(store, sealed.record_ref, "test bootstrap")
  );
  const request = {
    ...fixtureScaP03Request(q),
    accepted_p01: frozen.production_bindings.roots.accepted_p01,
    source_oracle_ref: record.source_oracle_ref,
    source_oracle_validation_ref: record.source_oracle_validation_ref,
    joern_runtime_identity_ref: record.runtime_identity_ref,
    implementation_identity_ref: record.implementation_identity_ref,
    qualification_profile_ref: record.qualification_profile_ref,
    baseline_query_set_ref: record.baseline_query_set_ref,
    runtime_policy_ref: record.runtime_policy_ref,
    host_isolation_attestation_ref: sealed.host_attestation_ref,
  };
  vi.spyOn(operational, "requireScaP03OperationalCohort").mockReturnValue({
    request,
    refs: [q.operational, q.transition],
  });
  const p02 = Object.fromEntries(
    Object.entries(q.snapshot).filter(
      ([key]) => key !== "operational_cohort" && key !== "p04_admission_performed"
    )
  );
  const p02Snapshot = validateContract(
    predecessor.ScaP02V3DefinitionSnapshotSchema,
    {
      ...p02,
      schema_id: "penny.sca-p02-v3-definition-snapshot.v1",
      phase_id: "SCA-P02",
      source_policy_module: "apps/orchestration/src/sca/p02-qualification.ts",
      p03_admission_performed: false,
      criterion_ids: [
        "p02-containment-egress-and-minimization",
        "p02-current-predecessor-and-implementation",
        "p02-required-variants-and-lifecycle",
        "p02-six-operation-deterministic-coverage",
      ],
      criterion_definition_refs: Object.fromEntries(
        [
          "p02-containment-egress-and-minimization",
          "p02-current-predecessor-and-implementation",
          "p02-required-variants-and-lifecycle",
          "p02-six-operation-deterministic-coverage",
        ].map((id) => [id, q.operational])
      ),
    },
    "separate P02 prerequisite fixture"
  );
  vi.spyOn(predecessor, "requireScaP03AcceptedP02Qualification").mockReturnValue(p02Snapshot);
  vi.spyOn(admission, "requireScaActivationAdmissionV1").mockReturnValue({
    authority_id: "fixture-p02-authority",
    authority_sha256: sha256("P02 fixture authority"),
    issuance_sha256: sha256("issuance"),
    tenant_id: q.tenant,
    project_id: q.project,
    phase_id: "SCA-P02",
    production_playbook_name: "sca-p02",
    qualification_run_id: q.run,
    activation_run_id: "fixture-p02-activation",
    qualification_artifact_content_sha256: q.qualificationRef.content_digest,
    gate_artifact_content_sha256: request.accepted_p02.qualification_gate_ref.content_digest,
    implementation_identity_artifact_content_sha256: sha256("identity"),
    qualification_policy_data_sha256: sha256("policy"),
    registration_contract_sha256: sha256("contract"),
    runtime_registration_sha256: sha256("registration"),
    host_implementation_binding_sha256: sha256("P02 fixture host"),
    proposed_start_sha256: sha256("start"),
    revocation_generation: 0,
    checked_at: "2026-09-26T00:03:00Z",
    expires_at: "2026-09-27T00:00:00Z",
  });
  const summary = store.persist({
    metadata: { ...q.store.metadata(q.summary), operation_id: "sampler-composition-summary" },
    content: canonicalJson({
      ...operational.requireScaP03OperationalSummary({
        store: q.store,
        summary_ref: q.summary,
        gate_ref: q.operational,
        transition_ref: q.transition,
        tenant_id: q.tenant,
        project_id: q.project,
      }),
      bootstrap_handoff_sha256: sha256(readFileSync(f.sealedPath)),
      bootstrap_proof_sha256: sealed.proof_sha256,
      deployment_identity_sha256: f.manifest.config.deployment_identity_sha256,
    }),
  });
  const { config, counter } = verificationChild(f);
  const input = {
    project_root: fileURLToPath(new URL("../../..", import.meta.url)),
    store,
    tenant_id: q.tenant,
    project_id: q.project,
    operational_summary_ref: summary,
    operational_gate_ref: q.operational,
    p04_transition_ref: q.transition,
    p02_activation: {
      host: {
        sample() {
          throw new Error("separate P02 admission fixture only");
        },
        verifyIssuance: () => false,
      },
      proposed: {
        tenant_id: q.tenant,
        project_id: q.project,
        phase_id: "SCA-P02",
        production_playbook_name: "sca-p02",
        qualification_run_id: q.run,
        activation_run_id: "fixture-p02-activation",
        proposed_start_sha256: sha256("start"),
        qualification_ref: q.qualificationRef,
        gate_ref: request.accepted_p02.qualification_gate_ref,
        authority_ref: request.accepted_p02.qualification_definition_ref,
      },
      registry: { resolve: () => SCA_P02_PHASE_REGISTRATION },
    },
    now: () => new Date("2026-09-26T00:03:00Z"),
    partition_project_id: f.project_id,
    definition_ref: q.snapshotRef,
    gate_ref: q.gateRef,
    issuer_policy_id: "test-issuer-policy",
    revocation_generation: 0,
    issuance_contract: q.snapshot.contracts.reviewer_authority,
    authority_contract: q.snapshot.contracts.reviewer_authority,
    owner: { verifyIssuance: () => false },
    sampler: config,
  };
  // Explicit test-only installed identity; not initial qualification, human approval, or a gate.
  const sampling_authority = samplerAuthorityFixture(f.root, {
    tenant_id: q.tenant,
    project_id: q.project,
    qualification_run_id: q.run,
    issuer_policy_id: input.issuer_policy_id,
    gate_ref: q.gateRef,
  });
  return { f, input: { ...input, sampling_authority }, counter, store };
}

describe("P03 operational host fail-closed boundary (offline)", () => {
  it("never measures through the retired direct child or accepts a callback replacement", async () => {
    const f = await compositionFixture();
    try {
      const host = createScaP03ProductionActivationHostV1(f.input);
      expect(() => host.sample()).toThrow("p03_guarded_bootstrap_verification_unavailable");
      expect(() => host.sample()).toThrow("p03_guarded_bootstrap_verification_unavailable");
      const restarted = createScaP03ProductionActivationHostV1({
        ...f.input,
        sampling_authority: f.input.sampling_authority.reopen(),
      });
      expect(() => restarted.sample()).toThrow("p03_guarded_bootstrap_verification_unavailable");
      expect(existsSync(f.counter)).toBe(false);
      const override = { ...f.input, sample_current_bootstrap: () => ({}) };
      expect(() => createScaP03ProductionActivationHostV1(override)).toThrow("override_denied");
    } finally {
      f.store.close();
    }
  });
});
