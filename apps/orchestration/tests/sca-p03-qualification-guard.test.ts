import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { StartRequestSchema, validateContract } from "../dist/contracts.js";
import { scaP03InputArtifacts } from "../dist/sca/p03-admission.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import {
  SCA_P03_CANDIDATE_REGISTRATION,
  SCA_P03_PHASE_REGISTRATION,
  SCA_P03_PHASE_PLAYBOOK_NAME,
} from "../dist/sca/p03-playbook.js";
import { resolveScaPhaseRegistration } from "../dist/sca/phase-registry.js";
import * as operational from "../dist/sca/p03-operational-replay.js";
import {
  setupScaP03QualificationFixture,
  fixtureScaP03Request,
} from "./helpers/sca-p03-qualification-fixture.js";

// This suite isolates persisted formal replay from the operational replay (which is tested
// independently and reuses P04's real cohort/query-page validators). It is not live evidence.
function formalFixture(gaps: readonly string[] = []) {
  const f = setupScaP03QualificationFixture({ gaps });
  const request = fixtureScaP03Request(f);
  vi.spyOn(operational, "requireScaP03OperationalCohort").mockImplementation((input) => {
    operational.readScaP03CurrentJson(input.store, input.gate_ref, "fixture operational gate");
    operational.readScaP03CurrentJson(input.store, input.transition_ref, "fixture transition");
    return { refs: [f.operational, f.transition], request };
  });
  return f;
}
afterEach(() => vi.restoreAllMocks());

const HISTORICAL_UNRECORDED_P03_CANDIDATE_SHA256 =
  "40cbcbb35bf69f351376c1106d2337a413704124547a4fbc63223871807bae06";
const REVIEWED_CURRENT_P03_CANDIDATE_SHA256 =
  "6634f667e4c19ac4c7cef5c71c995ecbc1b0f236e5967a78fb73cc33674d0211";

// Reviewed against p03Registration/p03SkillContract and runtime-registration-digest.ts.
// Unlike the historical HEAD serializer, current serialization includes sorted host-operation
// authority (input/output limits, typed outputs and lease profiles). The old golden has no
// recorded preimage: omitting host_operations from CURRENT contents yields 1d628..., NOT 40cbc.
// Exact P02 V3, source-oracle, sealed-verification and runtime-package input ports changed the
// contract digest; operation declarations and their independent authority digest are unchanged.
// Do not attribute that entire historical delta to sampler code or manufacture historical bytes.
function reviewedCurrentProjection(registration: PlaybookRegistration) {
  if (
    registration.worker.kind !== "none" ||
    registration.host_operations === undefined ||
    registration.start_admission === undefined
  )
    throw new Error("P03 reviewed deterministic authority missing");
  return {
    name: registration.name,
    contract: registration.contract,
    ingress: registration.ingress,
    start_admission: {
      schema_id: registration.start_admission.schema_id,
      schema_version: registration.start_admission.schema_version,
    },
    liveness: {
      resolver_id: registration.liveness.resolver_id,
      thinking_policy: registration.liveness.thinking_policy,
    },
    worker: {
      kind: "none",
      workflow_name: registration.name,
      guidance: { skill_root: "apps/orchestration/src/sca", resolution: "per_agent_phase" },
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: [],
    },
    host_states: [
      "sca_p03_qualifying_joern",
      "sca_p03_building_graph_php",
      "sca_p03_building_graph_javascript_typescript",
      "sca_p03_running_queries_php",
      "sca_p03_running_queries_javascript_typescript",
      "sca_p03_evaluating_gate",
    ],
    generic_child: null,
    host_operations: {
      ...registration.host_operations,
      declarations: [...registration.host_operations.declarations].sort((a, b) =>
        a.operation_kind.localeCompare(b.operation_kind)
      ),
    },
    completion_receipt_predicate_ids: [],
  };
}

describe("P03 accepted registration and exact persisted V3 snapshot", () => {
  it("pins the reviewed current candidate identity, distinguishes the unrecorded historical golden, and preserves the public registry", () => {
    const before = [...PLAYBOOK_REGISTRY.entries()];
    const projection = reviewedCurrentProjection(SCA_P03_CANDIDATE_REGISTRATION);
    expect(projection.contract.io.input_ports).toHaveLength(70);
    for (const name of [
      "accepted_p02_qualification_definition",
      "accepted_p02_qualification_gate",
      "sealed_bootstrap_inputs",
      "source_oracle",
      "source_oracle_validation",
    ]) {
      expect(projection.contract.io.input_ports.some((port) => port.name === name)).toBe(true);
    }
    expect(sha256(canonicalJson(projection.contract))).toBe(
      "e0500abdebb26335ca52ca9a0112dda129a66f5d1caad7fbde9d48ca7b5690a5"
    );
    expect(sha256(canonicalJson(projection.host_operations))).toBe(
      "99f7a47b99f81d5466b0cba4ede323884e7549b119e425504a91e77c2e640548"
    );
    expect(sha256(canonicalJson(projection))).toBe(REVIEWED_CURRENT_P03_CANDIDATE_SHA256);
    expect(runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION)).toBe(
      REVIEWED_CURRENT_P03_CANDIDATE_SHA256
    );
    expect(REVIEWED_CURRENT_P03_CANDIDATE_SHA256).not.toBe(
      HISTORICAL_UNRECORDED_P03_CANDIDATE_SHA256
    );
    const { host_operations: _operations, ...withoutOperations } = SCA_P03_CANDIDATE_REGISTRATION;
    expect(runtimeRegistrationSha256(withoutOperations)).toBe(
      "1d628813dd64e716a8c42bd39dcb6d7ce1784639144fe10ae8cca211cbf543ef"
    );
    expect(resolveScaPhaseRegistration(SCA_P03_PHASE_PLAYBOOK_NAME)).toBe(
      SCA_P03_PHASE_REGISTRATION
    );
    expect(PLAYBOOK_REGISTRY.has("sca-p03")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("sca-p03-candidate")).toBe(false);
    expect(PLAYBOOK_REGISTRY.get("sca")?.name).toBe("sca");
    for (const registration of [SCA_P03_CANDIDATE_REGISTRATION, SCA_P03_PHASE_REGISTRATION]) {
      expect(() => validateRegistrationContract(registration)).not.toThrow();
      expect(registration.worker.kind).toBe("none");
      expect(registration.worker.phases.size).toBe(0);
      expect(runtimeRegistrationSha256(registration)).toBe(
        sha256(canonicalJson(reviewedCurrentProjection(registration)))
      );
    }
    expect(runtimeRegistrationSha256(SCA_P03_PHASE_REGISTRATION)).not.toBe(
      runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION)
    );
    for (const field of ["policy_id", "resolver_id", "admission_id", "snapshot_id"] as const)
      expect(SCA_P03_PHASE_REGISTRATION.contract.budget_policy[field]).not.toBe(
        SCA_P03_CANDIDATE_REGISTRATION.contract.budget_policy[field]
      );
    expect([...PLAYBOOK_REGISTRY.entries()]).toEqual(before);
  });

  it("binds execution-affecting mutations while canonicalizing declaration order without mutating either registry", () => {
    const registration = SCA_P03_CANDIDATE_REGISTRATION;
    const operations = registration.host_operations;
    if (operations === undefined) throw new Error("P03 host authority missing");
    const before = [...PLAYBOOK_REGISTRY.entries()].map(([name, r]) => [
      name,
      runtimeRegistrationSha256(r),
    ]);
    const original = runtimeRegistrationSha256(registration);
    const mutations = [
      { ...registration, name: "changed-candidate" },
      {
        ...registration,
        contract: {
          ...registration.contract,
          budget_policy: { ...registration.contract.budget_policy, policy_id: "changed-policy" },
        },
      },
      ...["backend", "input", "output", "schema", "lease"].map((change) => ({
        ...registration,
        host_operations: {
          ...operations,
          declarations: operations.declarations.map((declaration, i) =>
            i !== 0
              ? declaration
              : {
                  ...declaration,
                  ...(change === "backend" ? { backend_binding_id: "changed-backend" } : {}),
                  ...(change === "input"
                    ? { max_input_bytes: (declaration.max_input_bytes ?? 0) + 1 }
                    : {}),
                  ...(change === "output"
                    ? { max_output_bytes: declaration.max_output_bytes + 1 }
                    : {}),
                  ...(change === "schema"
                    ? { result: { ...declaration.result, schema_id: "penny.changed-output.v1" } }
                    : {}),
                  ...(change === "lease"
                    ? {
                        lease_profile: {
                          ...declaration.lease_profile,
                          profile_id: "changed-lease",
                          profile_sha256: sha256(
                            canonicalJson({
                              profile_id: "changed-lease",
                              profile_version: declaration.lease_profile.profile_version,
                              duration_ms: declaration.lease_profile.duration_ms,
                              renew_after_ms: declaration.lease_profile.renew_after_ms,
                              queue_inactivity_ms: declaration.lease_profile.queue_inactivity_ms,
                            })
                          ),
                        },
                      }
                    : {}),
                }
          ),
        },
      })),
    ];
    for (const mutated of mutations) expect(runtimeRegistrationSha256(mutated)).not.toBe(original);
    expect(
      runtimeRegistrationSha256({
        ...registration,
        host_operations: { ...operations, declarations: [...operations.declarations].reverse() },
      })
    ).toBe(original);
    expect(runtimeRegistrationSha256(registration)).toBe(REVIEWED_CURRENT_P03_CANDIDATE_SHA256);
    expect(resolveScaPhaseRegistration(SCA_P03_PHASE_PLAYBOOK_NAME)).toBe(
      SCA_P03_PHASE_REGISTRATION
    );
    expect(
      [...PLAYBOOK_REGISTRY.entries()].map(([name, r]) => [name, runtimeRegistrationSha256(r)])
    ).toEqual(before);
    expect(PLAYBOOK_REGISTRY.has("sca-p03")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("sca-p03-candidate")).toBe(false);
  });

  it("admits only the registration-specific production or candidate start name", () => {
    const f = setupScaP03QualificationFixture();
    const p03Request = fixtureScaP03Request(f);
    for (const registration of [SCA_P03_CANDIDATE_REGISTRATION, SCA_P03_PHASE_REGISTRATION]) {
      const admission = registration.start_admission;
      if (admission === undefined) throw new Error("missing P03 start admission");
      const start = validateContract(
        StartRequestSchema,
        {
          schema_version: 2,
          action: "start",
          identity: {
            schema_version: 2,
            run_id: f.run,
            session_id: "p03-start-session",
            playbook: registration.name,
            engine_owner: "typescript",
          },
          goal: "Prepare exact P03 start without execution",
          constraints: { p03_request: p03Request },
          project_root: f.root,
          trust_profile: "hardened-untrusted",
          input_artifacts: scaP03InputArtifacts(p03Request),
        },
        "P03 test start"
      );
      expect(admission.prepare(start, {}).admission_data).toEqual(p03Request);
      expect(() =>
        admission.prepare(
          {
            ...start,
            identity: {
              ...start.identity,
              playbook: registration.name === "sca-p03" ? "sca-p03-candidate" : "sca-p03",
            },
          },
          {}
        )
      ).toThrow();
      expect(() =>
        admission.prepare({ ...start, input_artifacts: { schema_version: 2, artifacts: [] } }, {})
      ).toThrow();
    }
  });

  it("replays the exact four-criterion subject without activation or registration", () => {
    const f = formalFixture();
    expect(f.check().subject_sha256).toBe(f.snapshot.subject_sha256);
    expect(f.check().gate_ref).toEqual(f.gateRef);
    expect(f.check().operational_cohort).toEqual({
      summary_ref: f.summary,
      gate_ref: f.operational,
      transition_ref: f.transition,
    });
  });

  it("rejects re-digested policy, source, reviewer, subject, contract and operational substitution", () => {
    const f = formalFixture();
    const s = f.snapshot;
    for (const change of [
      () => ({ ...s, extra: true }),
      () => ({ ...s, max_unique_artifact_bytes: 32 * 1_048_576 }),
      () => ({ ...s, max_json_artifact_bytes: 1_048_576 }),
      () => ({ ...s, activation_performed: true }),
      () => ({ ...s, registration_performed: true }),
      () => ({ ...s, p04_admission_performed: true }),
      () => ({ ...s, source_policy_module: "../escape" }),
      () => ({ ...s, reviewer_lineage_id: "impostor" }),
      () => ({ ...s, reviewer_identity_id: "p03-implementer" }),
      () => ({ ...s, current_host_binding_sha256: sha256("stale") }),
      () => ({ ...s, current_source_manifest_sha256: sha256("stale") }),
      () => ({ ...s, implementation_revision: "stale" }),
      () => ({ ...s, gate_ref: f.operational }),
      () => ({ ...s, qualification_ref: f.operational }),
      () => ({ ...s, formal_review_ref: f.operational }),
      () => ({ ...s, subject_sha256: sha256("other") }),
      () => ({ ...s, qualified_inputs: [...s.qualified_inputs].reverse() }),
      () => ({ ...s, qualified_inputs: s.qualified_inputs.slice(1) }),
      () => ({
        ...s,
        operational_cohort: { ...s.operational_cohort, transition_ref: f.operational },
      }),
      () => ({
        ...s,
        contracts: { ...s.contracts, gate: { ...s.contracts.gate, producer: "host:impostor" } },
      }),
      () => ({
        ...s,
        criterion_definition_refs: {
          ...s.criterion_definition_refs,
          "AC-P03.zero-model-ordering": f.operational,
        },
      }),
    ])
      expect(f.altered(change)).toThrow();
    expect(() => f.check(f.snapshotRef, f.operational)).toThrow();
  });

  it("rejects gaps, stale revisions, missing custody and wrong snapshot provenance", () => {
    expect(() => formalFixture(["outstanding"]).check()).toThrow();
    const f = formalFixture();
    const metadata = f.store.metadata(f.snapshotRef);
    const wrong = f.store.persist({
      metadata: { ...metadata, operation_id: "wrong-provenance", upstream_refs: [f.operational] },
      content: canonicalJson(f.snapshot),
    });
    expect(() => f.check(wrong)).toThrow();
    f.store.persist({
      metadata: { ...f.store.metadata(f.gateRef), version: 2, parent_ref: f.gateRef },
      content: canonicalJson({ superseded: true }),
    });
    expect(() => f.check()).toThrow(/current revision/u);
  });

  it("rejects an absent object even when its exact manifest and revision still exist", () => {
    const f = formalFixture();
    const digest = f.formal.content_digest;
    rmSync(path.join(f.store.root, "objects", "sha256", digest.slice(0, 2), digest.slice(2)));
    expect(f.store.refById(f.formal.artifact_id)).toEqual(f.formal);
    expect(() => f.check()).toThrow();
  });

  it("real operational replay rejects labels-only gate/transition artifacts", () => {
    const f = setupScaP03QualificationFixture();
    expect(() =>
      operational.requireScaP03OperationalCohort({
        store: f.store,
        transition_ref: f.transition,
        gate_ref: f.operational,
        tenant_id: f.tenant,
        project_id: f.project,
        trusted_clock: () => new Date("2026-09-26T00:03:00Z"),
      })
    ).toThrow();
    expect(() =>
      operational.requireScaP03OperationalSummary({
        store: f.store,
        summary_ref: { ...f.summary, producer: "agent:impostor" },
        gate_ref: f.operational,
        transition_ref: f.transition,
        tenant_id: f.tenant,
        project_id: f.project,
      })
    ).toThrow();
  });
});
