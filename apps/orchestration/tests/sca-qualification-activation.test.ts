import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScaHostKeyInstallation } from "../dist/sca/activation-host-key.js";
import { SqliteScaActivationOwner } from "../dist/sca/activation-owner.js";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../dist/contracts.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { SCA_P02_PHASE_REGISTRATION } from "../dist/sca/p02-playbook.js";
import {
  ScaPhaseActivationError,
  SqliteScaPhaseActivationRegistry,
} from "../dist/sca/phase-activation.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import {
  SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
  SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
  sealScaActivationAuthorityV1,
  sealScaActivationIssuanceV1,
  type ScaActivationAuthorityV1,
  type ScaActivationIssuanceV1,
} from "../dist/sca/qualification-activation-contracts.js";
import {
  requireScaActivationAdmissionV1,
  ScaActivationAdmissionError,
  scaProposedStartSha256,
  scaQualificationPolicyDataSha256,
  type ScaActivationHostSnapshotV1,
  type ScaActivationHostV1,
  type ScaProposedActivationStartV1,
} from "../dist/sca/qualification-activation.js";
import {
  SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseCriterionDefinitionV1,
  sealScaPhaseReviewerAuthorityV1,
  sealScaPhaseReviewReceiptV1,
} from "../dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  type ScaArtifactContractV1,
  type ScaCriterionEvidenceContractV1,
  type ScaPhaseQualificationDefinitionV1,
} from "../dist/sca/qualification-gate.js";

const TENANT = "tenant-test";
const PROJECT = "project-test";
const PARTITION = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUAL_RUN = "qualification-run";
const START_RUN = "activation-run";
const PHASE = "SCA-P02";
const BINDING = sha256("host code and adapters");
// Actual current active registration; qualification/issuer artifacts below are test-only.
const REGISTRATION = (() => {
  const registration = PLAYBOOK_REGISTRY.get("sca");
  if (registration === undefined) throw new Error("active sca registration is missing");
  return registration;
})();
const T0 = "2026-09-22T10:00:00Z";
const T1 = "2026-09-22T10:01:00Z";
const T2 = "2026-09-22T10:02:00Z";
const T3 = "2026-09-22T10:03:00Z";
const T4 = "2026-09-22T10:04:00Z";
const T5 = "2026-09-22T10:05:00Z";
const T6 = "2026-09-22T10:06:00Z";
const SCHEMA = "penny.test-activation-observation.v1";
const ID_SCHEMA = "penny.test-activation-identity.v1";
const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
function contract(
  kind: string,
  schema_id: string,
  producer = "host:test-qualification",
  schema_version = 1
): ScaArtifactContractV1 {
  return {
    artifact_kind: kind,
    schema_id,
    schema_version,
    producer,
    media_type: "application/json",
    max_bytes: 1_048_576,
  };
}
function persist(
  store: ArtifactStore,
  kind: string,
  schemaId: string,
  value: unknown,
  upstream: readonly ArtifactRef[] = [],
  run = QUAL_RUN,
  operation = kind,
  producer = "host:test-qualification",
  version = 1
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: run,
    phase: run === QUAL_RUN ? "sca-qualification-test" : "sca-activation-admission",
    branch_id: null,
    kind,
    operation_id: operation,
    version,
    producer,
    media_type: "application/json",
    content_schema: {
      schema_id: schemaId,
      schema_version: Number(schemaId.slice(schemaId.lastIndexOf(".v") + 2)),
    },
    parent_ref: null,
    upstream_refs: sorted(upstream),
  };
  return store.persist({ metadata, content: canonicalJson(value) });
}
const IdentitySchema = Type.Object(
  {
    tenant_id: Type.String(),
    project_id: Type.String(),
    run_id: Type.String(),
    phase_id: Type.String(),
    implementation_revision: Type.String(),
    assurance_scope: Type.Union([
      Type.Literal("host_derived_binding"),
      Type.Literal("declaration_only"),
    ]),
    host_binding_sha256: Type.Union([Type.String(), Type.Null()]),
    implementer_identity_id: Type.String(),
    implementer_lineage_id: Type.String(),
  },
  { additionalProperties: false }
);
const EvidenceSchema = Type.Object(
  {
    ...IdentitySchema.properties,
    criterion_id: Type.String(),
    subject_sha256: Type.String(),
    observed: Type.Boolean(),
  },
  { additionalProperties: false }
);

interface Fixture {
  readonly store: ArtifactStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly snapshot: ScaActivationHostSnapshotV1;
  readonly proposed: ScaProposedActivationStartV1;
  readonly authority: ScaActivationAuthorityV1;
  readonly issuance: ScaActivationIssuanceV1;
  readonly root: string;
}
function fixture(
  evidenceClass: "live" | "fixture" = "live",
  assurance: "host_derived_binding" | "declaration_only" = "host_derived_binding",
  times: {
    readonly gate?: string;
    readonly issued?: string;
    readonly notBefore?: string;
    readonly now?: string;
  } = {},
  registration: PlaybookRegistration = REGISTRATION,
  ids: {
    readonly authority?: string;
    readonly run?: string;
    readonly issuance?: string;
    readonly nonce?: string;
  } = {}
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-activation-"));
  roots.push(root);
  const store = new ArtifactStore(path.join(root, "artifacts"), { projectId: PARTITION });
  stores.push(store);
  const identity = {
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: QUAL_RUN,
    phase_id: PHASE,
    implementation_revision: "revision-1",
    assurance_scope: assurance,
    host_binding_sha256: assurance === "declaration_only" ? null : BINDING,
    implementer_identity_id: "implementer",
    implementer_lineage_id: "implementer-lineage",
  };
  // A declaration-only V3 gate can pass, but must never confer activation authority.
  const identityRef = persist(store, "implementation-identity", ID_SCHEMA, identity);
  const inputRef = persist(store, "qualified-input", "penny.test-input.v1", { bytes: "input" });
  const definitionRef = persist(
    store,
    "criterion-definition",
    SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
    sealScaPhaseCriterionDefinitionV1({
      schema_id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA,
      schema_version: 1,
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: QUAL_RUN,
      phase_id: PHASE,
      implementation_revision: "revision-1",
      required_assurance_scope: assurance,
      criterion_id: "AC-1",
      required_evidence_class: evidenceClass,
      required_evidence_count: 1,
    }),
    [identityRef, inputRef]
  );
  const evidenceContract: ScaCriterionEvidenceContractV1 = {
    ...contract("criterion-evidence", SCHEMA),
    evidence_class: evidenceClass,
    validate: (value) => {
      const claim = validateContract(EvidenceSchema, value, "test evidence");
      return {
        ...claim,
        observations: [{ check_id: "observed", observed: claim.observed }],
      };
    },
    evaluate: (claims) =>
      claims.every((claim) => claim.observations[0]?.observed === true) ? "PASS" : "FAIL",
  };
  const definition: ScaPhaseQualificationDefinitionV1 = {
    schema_version: 1,
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: QUAL_RUN,
    phase_id: PHASE,
    implementation_revision: "revision-1",
    required_assurance_scope: assurance,
    current_host_binding_sha256: assurance === "declaration_only" ? null : BINDING,
    max_unique_artifact_bytes: 1_048_576,
    reviewer_authority_id: "reviewer-authority",
    reviewer_identity_id: "reviewer",
    reviewer_lineage_id: "reviewer-lineage",
    implementation_identity: { ref: identityRef, parent_ref: null, upstream_refs: [] },
    implementation_identity_contract: {
      ...contract("implementation-identity", ID_SCHEMA),
      validate: (value) => validateContract(IdentitySchema, value, "test identity"),
    },
    qualified_inputs: [{ ref: inputRef, parent_ref: null, upstream_refs: [] }],
    criteria: [
      {
        criterion_id: "AC-1",
        definition_ref: definitionRef,
        definition_contract: contract(
          "criterion-definition",
          SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA
        ),
        evidence_contract: evidenceContract,
      },
    ],
    reviewer_authority_contract: contract(
      "reviewer-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA
    ),
    reviewer_receipt_contract: contract("reviewer-receipt", SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA),
    qualification_record_contract: contract(
      "qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      "host:test-qualification",
      3
    ),
    gate_record_contract: contract(
      "gate-v3",
      SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      "host:test-qualification",
      3
    ),
  };
  const subject = inspectScaQualificationSubjectV1({ store, definition });
  const evidenceRef = persist(
    store,
    "criterion-evidence",
    SCHEMA,
    {
      ...identity,
      criterion_id: "AC-1",
      subject_sha256: subject.subject_sha256,
      observed: true,
    },
    [identityRef, inputRef, definitionRef]
  );
  const subjectRefs = [identityRef, inputRef, definitionRef, evidenceRef];
  const reviewerAuthorityRef = persist(
    store,
    "reviewer-authority",
    SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
    sealScaPhaseReviewerAuthorityV1({
      schema_id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      authority_id: "reviewer-authority",
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: QUAL_RUN,
      phase_id: PHASE,
      implementation_revision: "revision-1",
      implementation_assurance_scope: assurance,
      reviewer_identity_id: "reviewer",
      reviewer_lineage_id: "reviewer-lineage",
      subject_sha256: subject.subject_sha256,
      evidence_refs: [evidenceRef],
      decision: "authorized",
      issued_at: T0,
    }),
    subjectRefs
  );
  const receiptRef = persist(
    store,
    "reviewer-receipt",
    SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
    sealScaPhaseReviewReceiptV1({
      schema_id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      receipt_id: "receipt-1",
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: QUAL_RUN,
      phase_id: PHASE,
      implementation_revision: "revision-1",
      implementation_assurance_scope: assurance,
      reviewer_authority_ref: reviewerAuthorityRef,
      reviewer_identity_id: "reviewer",
      reviewer_lineage_id: "reviewer-lineage",
      subject_sha256: subject.subject_sha256,
      evidence_refs: [evidenceRef],
      criterion_results: [{ criterion_id: "AC-1", status: "PASS" }],
      decision: "PASS",
      reviewed_at: T1,
    }),
    [...subjectRefs, reviewerAuthorityRef]
  );
  const qualification = evaluateScaPhaseQualificationV3({
    store,
    definition,
    criterion_evidence: [{ criterion_id: "AC-1", evidence_refs: [evidenceRef] }],
    reviewer_authority_ref: reviewerAuthorityRef,
    reviewer_receipt_ref: receiptRef,
    remaining_gaps: [],
    recorded_at: T2,
  });
  const qualificationRef = persist(
    store,
    "qualification-v3",
    SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
    qualification,
    [...subjectRefs, reviewerAuthorityRef, receiptRef]
  );
  const gate = evaluateScaPhaseGateV3({
    store,
    definition,
    qualification_ref: qualificationRef,
    evaluated_at: times.gate ?? T3,
  });
  const gateRef = persist(store, "gate-v3", SCA_PHASE_GATE_RECORD_V3_SCHEMA, gate, [
    qualificationRef,
  ]);
  const proposedCore = {
    tenant_id: TENANT,
    project_id: PROJECT,
    phase_id: PHASE,
    production_playbook_name: registration.name,
    qualification_run_id: QUAL_RUN,
    activation_run_id: ids.run ?? START_RUN,
    qualification_ref: qualificationRef,
    gate_ref: gateRef,
  };
  const proposedStartSha256 = scaProposedStartSha256(proposedCore);
  const scope = {
    authority_id: ids.authority ?? "activation-authority",
    nonce: ids.nonce ?? "nonce-1",
    tenant_id: TENANT,
    project_id: PROJECT,
    phase_id: PHASE,
    production_playbook_name: registration.name,
    qualification_run_id: QUAL_RUN,
    activation_run_id: proposedCore.activation_run_id,
    decision: "authorize_activation_admission" as const,
    qualification_ref: qualificationRef,
    gate_ref: gateRef,
    implementation_identity_ref: identityRef,
    qualification_policy_data_sha256: scaQualificationPolicyDataSha256(definition),
    registration_contract_sha256: skillContractSha256(registration.contract),
    runtime_registration_sha256: runtimeRegistrationSha256(registration),
    host_implementation_binding_sha256: BINDING,
    operator_principal_id: "operator",
    issuer_policy_id: "operator-policy",
    proposed_start_sha256: proposedStartSha256,
    issued_at: times.issued ?? T4,
    not_before: times.notBefore ?? T4,
    expires_at: T6,
    revocation_generation: 4,
  };
  const issuance = sealScaActivationIssuanceV1({
    schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    schema_version: 1,
    issuance_id: ids.issuance ?? "issuance-1",
    authority_id: scope.authority_id,
    operator_principal_id: scope.operator_principal_id,
    issuer_policy_id: scope.issuer_policy_id,
    scope_sha256: sha256(canonicalJson(scope)),
    issued_at: scope.issued_at,
  });
  const upstream = [qualificationRef, gateRef, identityRef];
  const issuanceRef = persist(
    store,
    "activation-issuance",
    SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    issuance,
    upstream,
    scope.activation_run_id,
    ids.issuance ?? "issuance-1",
    "host:operator-issuer"
  );
  const authority = sealScaActivationAuthorityV1({
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    scope,
    issuance_record_ref: issuanceRef,
  });
  const authorityRef = persist(
    store,
    "activation-authority",
    SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    authority,
    [...upstream, issuanceRef],
    scope.activation_run_id,
    "authority-1",
    "host:operator-issuer"
  );
  const snapshot: ScaActivationHostSnapshotV1 = {
    store,
    partition_project_id: PARTITION,
    tenant_id: TENANT,
    project_id: PROJECT,
    phase_id: PHASE,
    production_playbook_name: scope.production_playbook_name,
    registration,
    registration_class: "production",
    qualified_subject_class: "production",
    host_implementation_binding_sha256: BINDING,
    qualification_definition: definition,
    issuer_policy_id: "operator-policy",
    revocation_generation: 4,
    now: times.now ?? T5,
    issuance_contract: contract(
      "activation-issuance",
      SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      "host:operator-issuer"
    ),
    authority_contract: contract(
      "activation-authority",
      SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      "host:operator-issuer"
    ),
  };
  return {
    store,
    definition,
    snapshot,
    authority,
    issuance,
    root,
    proposed: {
      ...proposedCore,
      proposed_start_sha256: proposedStartSha256,
      authority_ref: authorityRef,
    },
  };
}

function check(
  f: Fixture,
  overrides: {
    readonly snapshot?: Partial<ScaActivationHostSnapshotV1>;
    readonly proposed?: Partial<ScaProposedActivationStartV1>;
    readonly authorized?: boolean;
    readonly verifier?: "missing" | "throw";
    readonly onSecondSample?: () => Partial<ScaActivationHostSnapshotV1>;
  } = {}
) {
  let samples = 0;
  const host: ScaActivationHostV1 = {
    sample: () => {
      samples += 1;
      return {
        ...f.snapshot,
        ...overrides.snapshot,
        ...(samples === 2 ? overrides.onSecondSample?.() : {}),
      };
    },
    verifyIssuance: ({ record, ref, scope, policy_id }) => {
      if (overrides.verifier === "throw") throw new Error("issuer unavailable");
      return (
        overrides.authorized !== false &&
        ref.artifact_id === f.authority.issuance_record_ref.artifact_id &&
        record.issuance_sha256 === f.issuance.issuance_sha256 &&
        record.scope_sha256 === sha256(canonicalJson(scope)) &&
        policy_id === "operator-policy"
      );
    },
  };
  if (overrides.verifier === "missing") Reflect.deleteProperty(host, "verifyIssuance");
  return requireScaActivationAdmissionV1({
    host,
    proposed: { ...f.proposed, ...overrides.proposed },
  });
}
function code(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaActivationAdmissionError);
    if (!(error instanceof ScaActivationAdmissionError)) throw error;
    expect(error.code).toBe(expected);
    expect(error.message).toBe(expected);
    return;
  }
  throw new Error("expected admission denial");
}
function replacedAuthority(
  f: Fixture,
  changes: Partial<ScaActivationAuthorityV1["scope"]>,
  upstream?: readonly ArtifactRef[]
): ArtifactRef {
  const authority = sealScaActivationAuthorityV1({
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    scope: { ...f.authority.scope, ...changes },
    issuance_record_ref: f.authority.issuance_record_ref,
  });
  return persist(
    f.store,
    "activation-authority",
    SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    authority,
    upstream ?? [
      f.proposed.qualification_ref,
      f.proposed.gate_ref,
      f.definition.implementation_identity.ref,
      f.authority.issuance_record_ref,
    ],
    START_RUN,
    `forged-${sha256(canonicalJson(changes)).slice(0, 16)}`,
    "host:operator-issuer"
  );
}

function storageObservation(f: Fixture): { readonly manifest: string; readonly objects: string } {
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (sqlite === undefined || !("DatabaseSync" in sqlite)) throw new Error("SQLite unavailable");
  const Database = sqlite.DatabaseSync;
  const db: DatabaseSync = new Database(path.join(f.store.root, "manifest.db"), { readOnly: true });
  try {
    const manifest = JSON.stringify({
      artifacts: db.prepare("SELECT * FROM artifacts ORDER BY artifact_id").all(),
      selections: db.prepare("SELECT * FROM artifact_selections ORDER BY artifact_id").all(),
    });
    const objectsRoot = path.join(f.store.root, "objects");
    const objects = readdirSync(objectsRoot, { recursive: true, encoding: "utf8" })
      .filter((name) => statSync(path.join(objectsRoot, name)).isFile())
      .sort()
      .map((name) => [name, sha256(readFileSync(path.join(objectsRoot, name)))]);
    return { manifest, objects: JSON.stringify(objects) };
  } finally {
    db.close();
  }
}

// Closed test-only seam: no production fault fields, unchecked casts or fake consumption.
function nativeStore(
  owner: SqliteScaActivationOwner | SqliteScaPhaseActivationRegistry
): OwnerSqliteDatabase {
  const value: unknown = Reflect.get(owner, "store");
  if (!(value instanceof OwnerSqliteDatabase)) throw new Error("native owner store unavailable");
  return value;
}
function realActivation(
  f = fixture("live", "host_derived_binding", {}, SCA_P02_PHASE_REGISTRATION)
) {
  const clock = { now: Date.parse(T5) };
  const verifier = ScaHostKeyInstallation.provision(
    path.join(f.root, "keys"),
    "isolated-host",
    () => clock.now
  );
  const keyId = verifier.provisionKey();
  const options = {
    directory: path.join(f.root, "owner"),
    issuer_policy_id: "operator-policy",
    operator_principal_id: "operator",
    revocation_generation: 4,
    installation_authenticator_id: verifier.authenticator_id,
    installation_authenticator: verifier,
    max_admission_age_ms: 30_000,
    now: () => clock.now,
  };
  let owner = new SqliteScaActivationOwner(options);
  let phases = new SqliteScaPhaseActivationRegistry({
    directory: path.join(f.root, "phases"),
    now: () => clock.now,
  });
  function install(candidate: Fixture, grant: string): void {
    const operands = {
      authority: candidate.authority,
      record: candidate.issuance,
      ref: candidate.authority.issuance_record_ref,
      scope: candidate.authority.scope,
    };
    verifier.signGrant(grant, operands);
    owner.install(operands);
  }
  install(f, "initial-grant");
  return {
    f,
    clock,
    verifier,
    keyId,
    get owner() {
      return owner;
    },
    get phases() {
      return phases;
    },
    host(candidate: Fixture = f): ScaActivationHostV1 {
      return {
        sample: () => ({ ...candidate.snapshot, now: new Date(clock.now).toISOString() }),
        verifyIssuance: (claim) => owner.verifyIssuance(claim),
      };
    },
    activate(candidate: Fixture = f) {
      return phases.activate({ host: this.host(candidate), proposed: candidate.proposed, owner });
    },
    candidate(sameRun = false): Fixture {
      const candidate = fixture("live", "host_derived_binding", {}, SCA_P02_PHASE_REGISTRATION, {
        authority: "next-authority",
        run: sameRun ? START_RUN : "next-run",
        issuance: "next-issuance",
        nonce: "next-nonce",
      });
      install(candidate, "next-grant");
      return candidate;
    },
    reopen() {
      phases.close();
      owner.close();
      owner = new SqliteScaActivationOwner(options);
      phases = new SqliteScaPhaseActivationRegistry({
        directory: path.join(f.root, "phases"),
        now: () => clock.now,
      });
    },
    close() {
      phases.close();
      owner.close();
      verifier.close();
    },
  };
}
function ownerState(
  h: ReturnType<typeof realActivation>,
  authority = h.f.authority.scope.authority_id
) {
  const row = nativeStore(h.owner)
    .db.prepare(
      "SELECT state,consumed_run_id,consumed_at FROM sca_activation_issuances WHERE authority_id=?"
    )
    .get(authority);
  if (row === undefined) throw new Error("installed authority missing");
  return row;
}
function phaseRow(h: ReturnType<typeof realActivation>) {
  const row = nativeStore(h.phases)
    .db.prepare("SELECT * FROM activations WHERE authority_id=?")
    .get(h.f.authority.scope.authority_id);
  if (row === undefined) throw new Error("activation missing");
  return row;
}
function phaseError(
  action: () => unknown,
  expected: ScaPhaseActivationError["code"]
): ScaPhaseActivationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaPhaseActivationError);
    if (!(error instanceof ScaPhaseActivationError)) throw error;
    expect(error.code).toBe(expected);
    return error;
  }
  throw new Error("expected phase refusal");
}

describe("SCA qualification-to-activation read-only admission", () => {
  it("activates and resolves the accepted P02 phase without replacing the user-facing SCA registration", () => {
    const f = fixture("live", "host_derived_binding", {}, SCA_P02_PHASE_REGISTRATION);
    const h = realActivation(f);
    const host = h.host(f);
    const owner = h.owner;
    const phases = new SqliteScaPhaseActivationRegistry({
      directory: path.join(f.root, "phase-activation"),
      now: () => Date.parse(T5),
    });
    try {
      expect(PLAYBOOK_REGISTRY.get("sca-p02")).toBeUndefined();
      expect(phases.activate({ host, proposed: f.proposed, owner })).toMatchObject({
        decision: "activated",
        phase_id: PHASE,
        playbook_name: "sca-p02",
      });
      expect(phases.resolve({ host, proposed: f.proposed })).toBe(SCA_P02_PHASE_REGISTRATION);
      expect(phases.activate({ host, proposed: f.proposed, owner })).toMatchObject({
        decision: "resumed",
      });
      phases.revoke({
        authority_id: f.authority.scope.authority_id,
        reason: "operator_revoke",
        evidence_sha256: sha256("operator revocation evidence"),
      });
      expect(() => phases.resolve({ host, proposed: f.proposed })).toThrow(
        "SCA phase is not durably active"
      );
      expect(PLAYBOOK_REGISTRY.get("sca")?.name).toBe("sca");
    } finally {
      phases.close();
      h.close();
    }
  });

  it("accepts test-only live custody twice and after reopening without writing or selecting candidates", () => {
    const f = fixture();
    const before = [...PLAYBOOK_REGISTRY.entries()];
    const beforeKeys = [...PLAYBOOK_REGISTRY.keys()];
    const registrationBindings = () =>
      [...PLAYBOOK_REGISTRY.entries()].map(([key, value]) => [
        key,
        skillContractSha256(value.contract),
        runtimeRegistrationSha256(value),
      ]);
    const beforeBindings = registrationBindings();
    const stored = storageObservation(f);
    const checkpointPath = path.join(f.root, "orchestration", "orchestration.db");
    expect(existsSync(checkpointPath)).toBe(false);
    const first = check(f);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(check(f));
    expect(first).toMatchObject({
      qualification_run_id: QUAL_RUN,
      activation_run_id: START_RUN,
      authority_id: "activation-authority",
      checked_at: T5,
      qualification_artifact_content_sha256: f.proposed.qualification_ref.content_digest,
      gate_artifact_content_sha256: f.proposed.gate_ref.content_digest,
      implementation_identity_artifact_content_sha256:
        f.definition.implementation_identity.ref.content_digest,
    });
    expect(Object.values(first).every((value) => typeof value !== "function")).toBe(true);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = ArtifactStore.openExisting(path.join(f.root, "artifacts"), {
      projectId: PARTITION,
    });
    stores.push(reopened);
    expect(check({ ...f, store: reopened, snapshot: { ...f.snapshot, store: reopened } })).toEqual(
      first
    );
    expect([...PLAYBOOK_REGISTRY.entries()]).toEqual(before);
    expect([...PLAYBOOK_REGISTRY.keys()]).toEqual(beforeKeys);
    expect(registrationBindings()).toEqual(beforeBindings);
    expect(beforeKeys).toContain("sca");
    expect(beforeKeys).not.toContain("sca-p02-candidate");
    expect(storageObservation({ ...f, store: reopened })).toEqual(stored);
    expect(existsSync(checkpointPath)).toBe(false);
  });
  it("requires distinct qualification and activation runs and a bounded V3 custody closure", () => {
    const f = fixture();
    code(() => check(f, { proposed: { activation_run_id: QUAL_RUN } }), "evidence_denied");
    expect(() =>
      sealScaActivationAuthorityV1({
        schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
        schema_version: 1,
        scope: { ...f.authority.scope, activation_run_id: QUAL_RUN },
        issuance_record_ref: f.authority.issuance_record_ref,
      })
    ).toThrow();
    code(
      () =>
        check(f, {
          snapshot: {
            qualification_definition: {
              ...f.definition,
              max_unique_artifact_bytes: 256 * 1_048_576,
            },
          },
        }),
      "evidence_denied"
    );
  });
  it("denies a self-digested forgery without independent issuance", () => {
    const f = fixture();
    code(() => check(f, { authorized: false }), "authority_denied");
    code(() => check(f, { verifier: "missing" }), "authority_denied");
    code(() => check(f, { verifier: "throw" }), "authority_denied");
    const ref = replacedAuthority(f, { nonce: "forged-nonce" });
    code(() => check(f, { proposed: { authority_ref: ref } }), "authority_denied");
  });
  it.each([
    ["missing registration", { registration: null }, "evidence_denied"],
    [
      "other active registration",
      { registration: PLAYBOOK_REGISTRY.get("research") ?? null },
      "evidence_denied",
    ],
    [
      "other active name and registration",
      {
        registration: PLAYBOOK_REGISTRY.get("research") ?? null,
        production_playbook_name: "research",
      },
      "evidence_denied",
    ],
    ["unregistered copy", { registration: { ...REGISTRATION } }, "evidence_denied"],
    [
      "host implementation",
      { host_implementation_binding_sha256: sha256("drift") },
      "evidence_denied",
    ],
    ["candidate class", { registration_class: "candidate" as const }, "evidence_denied"],
    [
      "candidate-only evidence",
      { qualified_subject_class: "candidate" as const },
      "evidence_denied",
    ],
    ["candidate name", { production_playbook_name: "sca-p02-candidate" }, "evidence_denied"],
    ["revocation", { revocation_generation: 5 }, "authority_denied"],
    ["tenant", { tenant_id: "another-tenant" }, "evidence_denied"],
    ["project", { project_id: "another-project" }, "evidence_denied"],
    ["phase", { phase_id: "SCA-P03" }, "evidence_denied"],
  ] as const)("denies changed host %s", (_label, snapshot, expected) => {
    const f = fixture();
    code(() => check(f, { snapshot }), expected);
  });
  it.each([
    ["activation run", { activation_run_id: "another-run" }, "evidence_denied"],
    ["qualification run", { qualification_run_id: "another-run" }, "evidence_denied"],
    ["tenant", { tenant_id: "another-tenant" }, "evidence_denied"],
    ["project", { project_id: "another-project" }, "evidence_denied"],
    ["phase", { phase_id: "SCA-P03" }, "evidence_denied"],
    ["start digest", { proposed_start_sha256: sha256("another start") }, "evidence_denied"],
  ] as const)("denies proposed %s substitution", (_label, proposed, expected) => {
    const f = fixture();
    code(() => check(f, { proposed }), expected);
  });
  it("derives policy data and start projections, never callback bodies or host digest labels", () => {
    const f = fixture();
    const changedData = {
      ...f.definition,
      criteria: f.definition.criteria.map((criterion) => ({
        ...criterion,
        evidence_contract: { ...criterion.evidence_contract, evidence_class: "fixture" as const },
      })),
    };
    expect(scaQualificationPolicyDataSha256(changedData)).not.toBe(
      scaQualificationPolicyDataSha256(f.definition)
    );
    const changedCallback = {
      ...f.definition,
      criteria: f.definition.criteria.map((criterion) => ({
        ...criterion,
        evidence_contract: { ...criterion.evidence_contract, evaluate: () => "FAIL" as const },
      })),
    };
    // Executable evaluator and admission identity belongs to the separate host binding.
    expect(scaQualificationPolicyDataSha256(changedCallback)).toBe(
      scaQualificationPolicyDataSha256(f.definition)
    );
    expect(scaProposedStartSha256(f.proposed)).toBe(f.proposed.proposed_start_sha256);
    expect(scaProposedStartSha256({ ...f.proposed, activation_run_id: "new-run" })).not.toBe(
      f.proposed.proposed_start_sha256
    );
    const wrongRuntime = replacedAuthority(f, { runtime_registration_sha256: sha256("drift") });
    code(() => check(f, { proposed: { authority_ref: wrongRuntime } }), "authority_denied");
    const wrongPolicy = replacedAuthority(f, { qualification_policy_data_sha256: sha256("drift") });
    code(() => check(f, { proposed: { authority_ref: wrongPolicy } }), "authority_denied");
  });
  it("denies pre-gate issuance and future gate/issuance; admits inclusive issued/not-before boundary", () => {
    code(() => check(fixture("live", "host_derived_binding", { issued: T2 })), "authority_denied");
    code(
      () => check(fixture("live", "host_derived_binding", { issued: T5, notBefore: T5, now: T4 })),
      "authority_denied"
    );
    code(
      () =>
        check(
          fixture("live", "host_derived_binding", { gate: T5, issued: T5, notBefore: T5, now: T4 })
        ),
      "authority_denied"
    );
    expect(
      check(fixture("live", "host_derived_binding", { issued: T3, notBefore: T3, now: T3 }))
        .checked_at
    ).toBe(T3);
  });
  it("denies an independently matched issuer record whose issued_at differs from scope", () => {
    const f = fixture();
    const issuance = sealScaActivationIssuanceV1({
      schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      schema_version: 1,
      issuance_id: "issuance-different-time",
      authority_id: f.authority.scope.authority_id,
      operator_principal_id: f.authority.scope.operator_principal_id,
      issuer_policy_id: f.authority.scope.issuer_policy_id,
      scope_sha256: sha256(canonicalJson(f.authority.scope)),
      issued_at: T3,
    });
    const upstream = [
      f.proposed.qualification_ref,
      f.proposed.gate_ref,
      f.definition.implementation_identity.ref,
    ];
    const issuanceRef = persist(
      f.store,
      "activation-issuance",
      SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      issuance,
      upstream,
      START_RUN,
      "issuance-different-time",
      "host:operator-issuer"
    );
    const authority = sealScaActivationAuthorityV1({
      schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      scope: f.authority.scope,
      issuance_record_ref: issuanceRef,
    });
    const authorityRef = persist(
      f.store,
      "activation-authority",
      SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      authority,
      [...upstream, issuanceRef],
      START_RUN,
      "authority-different-time",
      "host:operator-issuer"
    );
    code(
      () =>
        check({
          ...f,
          authority,
          issuance,
          proposed: { ...f.proposed, authority_ref: authorityRef },
        }),
      "authority_denied"
    );
  });
  it("denies future, expiry and issuer drift, and a race before return", () => {
    const f = fixture();
    code(() => check(f, { snapshot: { now: T3 } }), "authority_denied");
    expect(check(f, { snapshot: { now: T4 } }).checked_at).toBe(T4);
    code(() => check(f, { snapshot: { now: T6 } }), "authority_denied");
    code(() => check(f, { onSecondSample: () => ({ now: T6 }) }), "authority_denied");
    code(() => check(f, { snapshot: { issuer_policy_id: "changed" } }), "authority_denied");
    code(
      () => check(f, { onSecondSample: () => ({ revocation_generation: 5 }) }),
      "stale_host_state"
    );
    code(
      () =>
        check(f, {
          onSecondSample: () => ({ registration: null }),
        }),
      "stale_host_state"
    );
  });
  it("denies fixture and declaration-only evidence even when its V3 gate is passed", () => {
    code(() => check(fixture("fixture")), "evidence_denied");
    code(() => check(fixture("live", "declaration_only")), "evidence_denied");
  });
  it("denies mismatched authority scope and persisted upstreams", () => {
    const f = fixture();
    const wrong = replacedAuthority(f, {}, [f.proposed.gate_ref]);
    code(() => check(f, { proposed: { authority_ref: wrong } }), "authority_denied");
    const changed = replacedAuthority(f, { registration_contract_sha256: sha256("stale") });
    code(() => check(f, { proposed: { authority_ref: changed } }), "authority_denied");
    const wrongGate = persist(
      f.store,
      "gate-v3",
      SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      { wrong: "gate" },
      [f.proposed.qualification_ref],
      QUAL_RUN,
      "bad-gate"
    );
    code(() => check(f, { proposed: { gate_ref: wrongGate } }), "evidence_denied");
  });
  it("denies changed issuance provenance, reviewer overlap, and wrong qualification ref", () => {
    const f = fixture();
    const noIssuanceUpstream = persist(
      f.store,
      "activation-issuance",
      SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      f.issuance,
      [f.proposed.gate_ref],
      START_RUN,
      "issuance-forged-metadata",
      "host:operator-issuer"
    );
    const swapped = sealScaActivationAuthorityV1({
      schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      scope: f.authority.scope,
      issuance_record_ref: noIssuanceUpstream,
    });
    const swappedRef = persist(
      f.store,
      "activation-authority",
      SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      swapped,
      [
        f.proposed.qualification_ref,
        f.proposed.gate_ref,
        f.definition.implementation_identity.ref,
        noIssuanceUpstream,
      ],
      START_RUN,
      "authority-swapped-issuance",
      "host:operator-issuer"
    );
    code(() => check(f, { proposed: { authority_ref: swappedRef } }), "authority_denied");
    const overlap = replacedAuthority(f, { operator_principal_id: "reviewer" });
    code(() => check(f, { proposed: { authority_ref: overlap } }), "authority_denied");
    const other = persist(
      f.store,
      "qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      { wrong: "record" },
      [],
      QUAL_RUN,
      "wrong-qualification"
    );
    code(() => check(f, { proposed: { qualification_ref: other } }), "evidence_denied");
    code(
      () => check(f, { proposed: { authority_ref: f.proposed.qualification_ref } }),
      "authority_denied"
    );
  });

  it("denies malformed selectors and missing host project partition", () => {
    const f = fixture();
    code(() => check(f, { proposed: { project_id: "../escape" } }), "invalid_request");
    code(
      () =>
        check(f, { snapshot: { partition_project_id: "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }),
      "authority_denied"
    );
  });

  it("denies changed object bytes without writing on failure", () => {
    const f = fixture();
    const ref = f.proposed.authority_ref;
    const object = path.join(
      f.store.root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    writeFileSync(object, "{}");
    const afterCorruption = storageObservation(f);
    code(() => check(f), "authority_denied");
    expect(storageObservation(f)).toEqual(afterCorruption);
    expect(existsSync(path.join(f.root, "orchestration", "orchestration.db"))).toBe(false);
  });
  it("uses the signed host-key ledger through owner installation, SCA-02, and consumption", () => {
    const f = fixture();
    const verifier = ScaHostKeyInstallation.provision(
      path.join(f.root, "host-keys"),
      "host-one",
      () => Date.parse(T5)
    );
    const key = verifier.provisionKey();
    const options = {
      directory: path.join(f.root, "activation-owner"),
      issuer_policy_id: "operator-policy",
      operator_principal_id: "operator",
      revocation_generation: 4,
      installation_authenticator_id: verifier.authenticator_id,
      installation_authenticator: verifier,
      max_admission_age_ms: 30_000,
      now: () => Date.parse(T5),
    };
    const owner = new SqliteScaActivationOwner(options);
    try {
      const input = {
        authority: f.authority,
        record: f.issuance,
        ref: f.authority.issuance_record_ref,
        scope: f.authority.scope,
      };
      const host: ScaActivationHostV1 = {
        sample: () => f.snapshot,
        verifyIssuance: (claim) => owner.verifyIssuance(claim),
      };
      code(
        () => requireScaActivationAdmissionV1({ host, proposed: f.proposed }),
        "authority_denied"
      );
      expect(verifier.signGrant("grant-one", input).key_id).toBe(key);
      owner.install(input);
      const view = requireScaActivationAdmissionV1({ host, proposed: f.proposed });
      expect(owner.consume(view).decision).toBe("consumed");
      verifier.revokeGrant("grant-one");
      code(
        () => requireScaActivationAdmissionV1({ host, proposed: f.proposed }),
        "authority_denied"
      );
      expect(() => owner.consume(view)).toThrow("authentication denied");
    } finally {
      owner.close();
      verifier.close();
    }
  });
});

describe("real SCA phase activation serialization and recovery", () => {
  it("resumes real consumed/resumed receipts across reopen without rewriting history", () => {
    const h = realActivation();
    try {
      const first = h.activate();
      const stored = phaseRow(h);
      const consumed = ownerState(h);
      expect(JSON.parse(String(stored["consumption_receipt_json"]))).toMatchObject({
        decision: "consumed",
      });
      // Preserve an older activated_at even when it differs from consumed_at.
      nativeStore(h.phases)
        .db.prepare("UPDATE activations SET activated_at=?")
        .run("2026-09-22T10:05:01Z");
      const original = phaseRow(h);
      h.clock.now += 2_000;
      expect(h.activate()).toEqual({
        ...first,
        decision: "resumed",
        activated_at: "2026-09-22T10:05:01Z",
      });
      h.reopen();
      expect(h.activate().decision).toBe("resumed");
      expect(phaseRow(h)).toEqual(original);
      expect(ownerState(h)).toEqual(consumed);
      expect(h.phases.resolve({ host: h.host(), proposed: h.f.proposed })).toBe(
        SCA_P02_PHASE_REGISTRATION
      );
    } finally {
      h.close();
    }
  });

  it.each(["insert", "commit", "lost_commit_ack"] as const)(
    "adopts exact committed owner receipt after phase %s failure and reopen",
    (fault) => {
      const h = realActivation();
      try {
        const db = nativeStore(h.phases).db;
        const prepare = db.prepare.bind(db);
        const exec = db.exec.bind(db);
        const spy =
          fault === "insert"
            ? vi.spyOn(db, "prepare").mockImplementation((sql) => {
                if (sql.startsWith("INSERT INTO activations"))
                  throw new Error("SQLITE_IOERR phase write");
                return prepare(sql);
              })
            : vi.spyOn(db, "exec").mockImplementation((sql) => {
                if (sql === "COMMIT") {
                  if (fault === "lost_commit_ack") exec(sql);
                  throw new Error("SQLITE_IOERR phase commit");
                }
                exec(sql);
              });
        phaseError(() => h.activate(), "recovery_needed");
        spy.mockRestore();
        const originalOwner = ownerState(h);
        expect(originalOwner).toMatchObject({ state: "consumed", consumed_run_id: START_RUN });
        const before = db.prepare("SELECT * FROM activations").all();
        expect(before).toHaveLength(fault === "lost_commit_ack" ? 1 : 0);
        h.clock.now += 1_000;
        h.reopen();
        const resumed = h.activate();
        expect(resumed.decision).toBe(fault === "lost_commit_ack" ? "resumed" : "activated");
        expect(resumed.activated_at).toBe(originalOwner["consumed_at"]);
        const stored = phaseRow(h);
        const receipt: unknown = JSON.parse(String(stored["consumption_receipt_json"]));
        expect(receipt).toMatchObject({
          decision: fault === "lost_commit_ack" ? "consumed" : "resumed",
          admitted_at: originalOwner["consumed_at"],
        });
        expect(ownerState(h)).toEqual(originalOwner);
        expect(h.activate().decision).toBe("resumed");
        expect(phaseRow(h)).toEqual(stored);
        expect(() =>
          h.owner.install({
            authority: h.f.authority,
            record: h.f.issuance,
            ref: h.f.authority.issuance_record_ref,
          })
        ).toThrow("cannot be rearmed");
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
  );

  it("reconciles owner commit acknowledgement loss without reconsuming", () => {
    const h = realActivation();
    try {
      const db = nativeStore(h.owner).db;
      const exec = db.exec.bind(db);
      const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql === "COMMIT") throw new Error("SQLITE_IOERR owner commit acknowledgement");
      });
      phaseError(() => h.activate(), "recovery_needed");
      spy.mockRestore();
      const consumed = ownerState(h);
      expect(consumed["state"]).toBe("consumed");
      expect(nativeStore(h.phases).db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
      h.reopen();
      expect(h.activate().activated_at).toBe(consumed["consumed_at"]);
      expect(ownerState(h)).toEqual(consumed);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it.each(["active_phase", "active_name", "duplicate_run", "retired_authority"] as const)(
    "rejects %s before consuming fresh issuance",
    (conflict) => {
      const h = realActivation();
      try {
        h.activate();
        const db = nativeStore(h.phases).db;
        const candidate =
          conflict === "retired_authority" ? h.f : h.candidate(conflict === "duplicate_run");
        if (conflict === "active_phase")
          db.prepare("UPDATE activations SET playbook_name='other-name'").run();
        if (conflict === "active_name")
          db.prepare("UPDATE activations SET phase_id='other-phase'").run();
        if (conflict === "duplicate_run") {
          expect(candidate.proposed.activation_run_id).toBe(START_RUN);
          db.prepare(
            "UPDATE activations SET phase_id='other-phase',playbook_name='other-name'"
          ).run();
        }
        if (conflict === "retired_authority")
          h.phases.revoke({
            authority_id: h.f.authority.scope.authority_id,
            reason: "operator_retire",
            evidence_sha256: sha256("retire"),
          });
        const original = ownerState(h, candidate.authority.scope.authority_id);
        const consume = vi.spyOn(h.owner, "consume");
        let failure: unknown;
        try {
          h.activate(candidate);
        } catch (error) {
          failure = error;
        }
        // Assert actual durable custody before error taxonomy: old consume-before-check
        // code must fail for spending the fresh issuance, not merely for an untyped error.
        expect(ownerState(h, candidate.authority.scope.authority_id)).toEqual(original);
        expect(consume).not.toHaveBeenCalled();
        expect(failure).toBeInstanceOf(ScaPhaseActivationError);
        if (!(failure instanceof ScaPhaseActivationError)) throw failure;
        expect(failure.code).toBe("conflict");
        expect(original["state"]).toBe(conflict === "retired_authority" ? "consumed" : "installed");
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
  );

  it("requires explicit retirement and retains original authority history", () => {
    const h = realActivation();
    try {
      h.activate();
      const before = phaseRow(h);
      const candidate = h.candidate();
      phaseError(() => h.activate(candidate), "conflict");
      h.phases.revoke({
        authority_id: h.f.authority.scope.authority_id,
        reason: "operator_retire",
        evidence_sha256: sha256("explicit retirement"),
      });
      expect(h.activate(candidate).decision).toBe("activated");
      expect(phaseRow(h)).toMatchObject({
        state: "revoked",
        activated_at: before["activated_at"],
        consumption_receipt_json: before["consumption_receipt_json"],
      });
      expect(ownerState(h)["consumed_at"]).toBe(before["activated_at"]);
    } finally {
      h.close();
    }
  });

  it.each(["active", "revoked"] as const)(
    "rejects malformed canonical receipt in retained %s row before consumption",
    (state) => {
      const h = realActivation();
      try {
        h.activate();
        if (state === "revoked")
          h.phases.revoke({
            authority_id: h.f.authority.scope.authority_id,
            reason: "retire",
            evidence_sha256: sha256("retire"),
          });
        const candidate = h.candidate();
        nativeStore(h.phases)
          .db.prepare("UPDATE activations SET consumption_receipt_json=?")
          .run(canonicalJson({ schema_version: 1, decision: "consumed" }));
        const original = ownerState(h, candidate.authority.scope.authority_id);
        phaseError(() => h.activate(candidate), "invalid_state");
        expect(ownerState(h, candidate.authority.scope.authority_id)).toEqual(original);
      } finally {
        h.close();
      }
    }
  );

  it.each([
    "authority_id",
    "run_id",
    "receipt_id",
    "admitted_at",
    "schema_version",
    "extra",
  ] as const)("rejects foreign or changed receipt %s without phase adoption", (field) => {
    const h = realActivation();
    try {
      const foreign = h.candidate();
      const foreignReceipt = h.owner.consume(
        requireScaActivationAdmissionV1({ host: h.host(foreign), proposed: foreign.proposed })
      );
      const consume = h.owner.consume.bind(h.owner);
      vi.spyOn(h.owner, "consume").mockImplementation((view) => {
        const real = consume(view);
        // Named type admits extra keys statically, so the runtime closed parser must reject them.
        if (field === "extra") return { ...real, extra: "not allowed" };
        if (field === "schema_version") return Object.assign({}, real, { schema_version: 2 });
        return { ...real, [field]: field === "admitted_at" ? T6 : foreignReceipt[field] };
      });
      phaseError(() => h.activate(), "recovery_needed");
      expect(nativeStore(h.phases).db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
      expect(ownerState(h)["state"]).toBe("consumed");
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it.each(["stale", "expired", "owner_revoked", "grant_revoked", "key_revoked"] as const)(
    "rechecks %s after phase lock acquisition without consuming",
    (fault) => {
      const h = realActivation();
      try {
        const db = nativeStore(h.phases).db;
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          exec(sql);
          if (sql !== "BEGIN IMMEDIATE") return;
          if (fault === "stale") h.clock.now += 30_001;
          if (fault === "expired") h.clock.now = Date.parse(T6);
          if (fault === "owner_revoked")
            h.owner.revoke({
              authority_id: h.f.authority.scope.authority_id,
              reason: "operator_revoke",
              evidence_sha256: sha256("revoke"),
            });
          if (fault === "grant_revoked") h.verifier.revokeGrant("initial-grant");
          if (fault === "key_revoked") h.verifier.revokeKey(h.keyId);
        });
        const host = h.host();
        const sample = host.sample.bind(host);
        vi.spyOn(host, "sample").mockImplementation(() => {
          expect(db.isTransaction).toBe(false);
          return sample();
        });
        phaseError(
          () => h.phases.activate({ host, proposed: h.f.proposed, owner: h.owner }),
          "recovery_needed"
        );
        expect(ownerState(h)).toMatchObject({
          state: fault === "owner_revoked" ? "revoked" : "installed",
          consumed_at: null,
          consumed_run_id: null,
        });
        expect(db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
  );
  it("checks conflict after acquisition when another authority wins before BEGIN", () => {
    const h = realActivation();
    try {
      const competing = h.candidate();
      const db = nativeStore(h.phases).db;
      const exec = db.exec.bind(db);
      let won = false;
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && !won) {
          won = true;
          h.activate(competing);
        }
        exec(sql);
      });
      phaseError(() => h.activate(), "conflict");
      expect(ownerState(h)).toMatchObject({ state: "installed", consumed_at: null });
      expect(ownerState(h, competing.authority.scope.authority_id)["state"]).toBe("consumed");
      const rows = db.prepare("SELECT authority_id FROM activations").all();
      expect(rows).toEqual([{ authority_id: competing.authority.scope.authority_id }]);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("rejects two active rows without consuming a fresh third authority", () => {
    const h = realActivation();
    try {
      h.activate();
      h.phases.revoke({
        authority_id: h.f.authority.scope.authority_id,
        reason: "retire",
        evidence_sha256: sha256("retire"),
      });
      h.activate(h.candidate());
      const db = nativeStore(h.phases).db;
      db.prepare(
        "UPDATE activations SET state='active',revoked_at=NULL,revocation_reason=NULL,revocation_evidence_sha256=NULL"
      ).run();
      const third = fixture("live", "host_derived_binding", {}, SCA_P02_PHASE_REGISTRATION, {
        authority: "third-authority",
        run: "third-run",
        issuance: "third-issuance",
        nonce: "third-nonce",
      });
      const operands = {
        authority: third.authority,
        record: third.issuance,
        ref: third.authority.issuance_record_ref,
        scope: third.authority.scope,
      };
      h.verifier.signGrant("third-grant", operands);
      h.owner.install(operands);
      phaseError(() => h.activate(third), "conflict");
      expect(ownerState(h, third.authority.scope.authority_id)).toMatchObject({
        state: "installed",
        consumed_at: null,
      });
      expect(db.prepare("SELECT * FROM activations WHERE state='active'").all()).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it.each(["receipt_id", "admitted_at"] as const)(
    "rejects stable resumed receipt %s drift and retains stored bytes",
    (field) => {
      const h = realActivation();
      try {
        h.activate();
        const original = phaseRow(h);
        h.clock.now += 2_000;
        const consume = h.owner.consume.bind(h.owner);
        vi.spyOn(h.owner, "consume").mockImplementation((view) => ({
          ...consume(view),
          [field]:
            field === "receipt_id" ? `scac_${sha256("foreign identity")}` : "2026-09-22T10:05:01Z",
        }));
        phaseError(() => h.activate(), "recovery_needed");
        expect(phaseRow(h)).toEqual(original);
      } finally {
        vi.restoreAllMocks();
        h.close();
      }
    }
  );

  it("leaves the issuance installed after phase transaction acquisition failure", () => {
    const h = realActivation();
    try {
      const db = nativeStore(h.phases).db;
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE") throw new Error("SQLITE_IOERR phase begin");
        exec(sql);
      });
      phaseError(() => h.activate(), "storage_failed");
      expect(ownerState(h)).toMatchObject({ state: "installed", consumed_at: null });
      expect(db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });
  it("refuses a real receipt consumed by another authority and adopts only its own", () => {
    const h = realActivation();
    try {
      const foreign = h.candidate();
      const receipt = h.owner.consume(
        requireScaActivationAdmissionV1({ host: h.host(foreign), proposed: foreign.proposed })
      );
      const spy = vi.spyOn(h.owner, "consume").mockReturnValue(receipt);
      phaseError(() => h.activate(), "recovery_needed");
      expect(ownerState(h)).toMatchObject({ state: "installed", consumed_at: null });
      expect(nativeStore(h.phases).db.prepare("SELECT * FROM activations").all()).toHaveLength(0);
      spy.mockRestore();
      expect(h.activate().authority_id).toBe(h.f.authority.scope.authority_id);
      expect(ownerState(h, foreign.authority.scope.authority_id)["state"]).toBe("consumed");
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });
});
