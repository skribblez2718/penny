import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseCriterionDefinitionV1,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
} from "../dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  requireScaPhaseGatePassV3,
  type ScaArtifactBindingV1,
  type ScaArtifactContractV1,
  type ScaPhaseQualificationDefinitionV1,
} from "../dist/sca/qualification-gate.js";
import {
  SCA_P02_IMPLEMENTATION_SOURCE_PATHS,
  SCA_P02_QUALIFICATION_ARTIFACTS,
  SCA_P02_QUALIFICATION_CHECKS,
  SCA_P02_QUALIFICATION_CRITERION_IDS,
  ScaP02ImplementationIdentityV1Schema,
  ScaP02QualificationEvidenceV1Schema,
  buildScaP02CriterionDefinitionV1,
  buildScaP02ImplementationIdentityV1,
  buildScaP02QualificationEvidenceV1,
  createScaP02QualificationDefinitionV1,
  scaP02SourceManifestSha256,
  validateScaP02ImplementationIdentityV1,
  validateScaP02QualificationEvidenceV1,
  type ScaP02ImplementationIdentityV1,
  type ScaP02QualificationEvidenceV1,
  type ScaP02QualificationCriterionId,
} from "../dist/sca/p02-qualification.js";

const RUN = "p02-qualification-run";
const REVISION = "p02-revision-1";
const HOST_BINDING = sha256("host-measured-P02-implementation");
const TENANT = "p02-tenant";
const PROJECT = "p02-project";
const TIME = [
  "2026-09-25T00:00:00Z",
  "2026-09-25T00:01:00Z",
  "2026-09-25T00:02:00Z",
  "2026-09-25T00:03:00Z",
] as const;
const stores: ArtifactStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "p02-qualification-"));
  roots.push(root);
  const result = new ArtifactStore(path.join(root, "artifacts"), {
    projectId: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  stores.push(result);
  return result;
}
function sorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
function persist(input: {
  readonly store: ArtifactStore;
  readonly operation: string;
  readonly kind: string;
  readonly producer: string;
  readonly schema?: string;
  readonly version?: number;
  readonly value: unknown;
  readonly upstream?: readonly ArtifactRef[];
  readonly run?: string;
  readonly phase?: string;
  readonly parent?: ArtifactRef;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run ?? RUN,
    phase: input.phase ?? "sca-p02-qualification-test",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation,
    version: input.parent === undefined ? 1 : 2,
    parent_ref: input.parent ?? null,
    producer: input.producer,
    media_type: "application/json",
    ...(input.schema === undefined
      ? {}
      : { content_schema: { schema_id: input.schema, schema_version: input.version ?? 1 } }),
    upstream_refs: sorted(input.upstream ?? []),
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}
function bind(s: ArtifactStore, ref: ArtifactRef): ScaArtifactBindingV1 {
  const metadata = s.metadata(ref);
  return { ref, parent_ref: metadata.parent_ref, upstream_refs: [...metadata.upstream_refs] };
}
function framework(kind: string, schema: string, version = 1): ScaArtifactContractV1 {
  return {
    artifact_kind: kind,
    schema_id: schema,
    schema_version: version,
    producer: "host:p02-independent-review",
    media_type: "application/json",
    max_bytes: 1_048_576,
  };
}
const files = SCA_P02_IMPLEMENTATION_SOURCE_PATHS.map((file) => ({
  path: file,
  sha256: sha256(`bytes:${file}`),
  byte_length: Buffer.byteLength(`bytes:${file}`),
}));
function identity(): ScaP02ImplementationIdentityV1 {
  return buildScaP02ImplementationIdentityV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    host_binding_sha256: HOST_BINDING,
    implementer_identity_id: "p02-implementer",
    implementer_lineage_id: "p02-implementation-lineage",
    source_files: files,
  });
}
function evidenceBase(
  criterion: ScaP02QualificationCriterionId,
  subject: string,
  refs: readonly ArtifactRef[]
): ScaP02QualificationEvidenceV1 {
  return buildScaP02QualificationEvidenceV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    host_binding_sha256: HOST_BINDING,
    implementer_identity_id: "p02-implementer",
    implementer_lineage_id: "p02-implementation-lineage",
    criterion_id: criterion,
    subject_sha256: subject,
    observations: SCA_P02_QUALIFICATION_CHECKS[criterion].map((check_id) => ({
      check_id,
      observed: true,
    })),
    supporting_refs: [...refs],
  });
}
interface Fixture {
  readonly store: ArtifactStore;
  readonly definition: ScaPhaseQualificationDefinitionV1;
  readonly subject: ReturnType<typeof inspectScaQualificationSubjectV1>;
  readonly inputs: readonly ArtifactRef[];
  readonly evidence: readonly {
    readonly criterion_id: string;
    readonly evidence_refs: readonly ArtifactRef[];
  }[];
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly authorityRef: ArtifactRef;
  readonly receiptRef: ArtifactRef;
}
function setup(
  options: {
    readonly badUpstream?: boolean;
    readonly evidenceChange?: (value: ScaP02QualificationEvidenceV1) => unknown;
    readonly reviewer?: string;
    readonly identityChange?: (value: ScaP02ImplementationIdentityV1) => unknown;
    readonly revision?: string;
    readonly sourceManifest?: string;
    readonly definitionCount?: number;
    readonly evidenceProducer?: string;
  } = {}
): Fixture {
  const s = store();
  const implementation = identity();
  const implementationRef = persist({
    store: s,
    operation: "identity",
    kind: SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
    producer: SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer,
    schema: implementation.schema_id,
    value: options.identityChange?.(implementation) ?? implementation,
  });
  const inputRef = persist({
    store: s,
    operation: "p01-current-input",
    kind: "sca-p02-qualified-input",
    producer: "host:p01-custody",
    value: { predecessor: "current" },
    phase: "sca-p01-custody",
  });
  const otherRef = persist({
    store: s,
    operation: "p02-host-input",
    kind: "sca-p02-qualified-input",
    producer: "host:p02-custody",
    value: { host: "current" },
  });
  const inputs = sorted([inputRef, otherRef]);
  const definitionRefs = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => {
    const sealed = buildScaP02CriterionDefinitionV1({
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: RUN,
      implementation_revision: REVISION,
      criterion_id,
    });
    const { definition_sha256: _digest, ...unsigned } = sealed;
    return {
      criterion_id,
      ref: persist({
        store: s,
        operation: `definition-${criterion_id}`,
        kind: SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
        producer: SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer,
        schema: SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id,
        value:
          options.definitionCount === undefined
            ? sealed
            : sealScaPhaseCriterionDefinitionV1({
                ...unsigned,
                required_evidence_count: options.definitionCount,
              }),
        upstream: [implementationRef, ...inputs],
      }),
    };
  });
  const refs = Object.fromEntries(definitionRefs.map((entry) => [entry.criterion_id, entry.ref]));
  // Explicit full record keeps criterion-ID exhaustiveness visible to TypeScript.
  const criterion_definition_refs = {
    "p02-current-predecessor-and-implementation":
      refs["p02-current-predecessor-and-implementation"] ?? inputRef,
    "p02-six-operation-deterministic-coverage":
      refs["p02-six-operation-deterministic-coverage"] ?? inputRef,
    "p02-containment-egress-and-minimization":
      refs["p02-containment-egress-and-minimization"] ?? inputRef,
    "p02-required-variants-and-lifecycle": refs["p02-required-variants-and-lifecycle"] ?? inputRef,
  };
  const definition = createScaP02QualificationDefinitionV1({
    current_source_manifest_sha256: options.sourceManifest ?? implementation.source_manifest_sha256,
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: options.revision ?? REVISION,
    current_host_binding_sha256: HOST_BINDING,
    max_unique_artifact_bytes: 32 * 1_048_576,
    max_json_artifact_bytes: 1_048_576,
    reviewer_authority_id: "p02-review-authority",
    reviewer_identity_id: options.reviewer ?? "p02-reviewer",
    reviewer_lineage_id: "p02-review-lineage",
    implementation_identity: bind(s, implementationRef),
    qualified_inputs: inputs.map((ref) => bind(s, ref)),
    criterion_definition_refs,
    reviewer_authority_contract: framework(
      "sca-p02-review-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA
    ),
    reviewer_receipt_contract: framework(
      "sca-p02-review-receipt",
      SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA
    ),
    qualification_record_contract: framework(
      "sca-p02-qualification-record",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      3
    ),
    gate_record_contract: framework("sca-p02-gate-record", SCA_PHASE_GATE_RECORD_V3_SCHEMA, 3),
  });
  const subject = inspectScaQualificationSubjectV1({ store: s, definition });
  // The host inspects persisted definitions after pure construction; P02's builder
  // seals these fields, but a substituted persisted definition must not widen them.
  if (
    subject.criteria.length !== SCA_P02_QUALIFICATION_CRITERION_IDS.length ||
    subject.criteria.some(
      (criterion) =>
        criterion.required_evidence_count !== 1 || criterion.required_evidence_class !== "live"
    )
  ) {
    throw new Error("P02 host requires exactly one live evidence per criterion");
  }
  const evidence = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    evidence_refs: [
      persist({
        store: s,
        operation: `evidence-${criterion_id}`,
        kind: SCA_P02_QUALIFICATION_ARTIFACTS.evidence.artifact_kind,
        producer: options.evidenceProducer ?? SCA_P02_QUALIFICATION_ARTIFACTS.evidence.producer,
        schema: SCA_P02_QUALIFICATION_ARTIFACTS.evidence.schema_id,
        value:
          options.evidenceChange?.(evidenceBase(criterion_id, subject.subject_sha256, inputs)) ??
          evidenceBase(criterion_id, subject.subject_sha256, inputs),
        upstream: options.badUpstream
          ? [implementationRef, ...inputs]
          : [implementationRef, ...inputs, criterion_definition_refs[criterion_id]],
      }),
    ],
  }));
  const evidenceRefs = sorted(evidence.flatMap((entry) => entry.evidence_refs));
  const subjectRefs = [implementationRef, ...inputs, ...definitionRefs.map((entry) => entry.ref)];
  const reviewFields = {
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P02",
    implementation_revision: REVISION,
    implementation_assurance_scope: "host_derived_binding" as const,
    reviewer_identity_id: options.reviewer ?? "p02-reviewer",
    reviewer_lineage_id: "p02-review-lineage",
    subject_sha256: subject.subject_sha256,
    evidence_refs: evidenceRefs,
  };
  const authorityRef = persist({
    store: s,
    operation: "authority",
    kind: definition.reviewer_authority_contract.artifact_kind,
    producer: definition.reviewer_authority_contract.producer,
    schema: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
    value: sealScaPhaseReviewerAuthorityV1({
      schema_id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      authority_id: "p02-review-authority",
      ...reviewFields,
      decision: "authorized",
      issued_at: TIME[0],
    }),
    upstream: [...subjectRefs, ...evidenceRefs],
  });
  const receiptRef = persist({
    store: s,
    operation: "receipt",
    kind: definition.reviewer_receipt_contract.artifact_kind,
    producer: definition.reviewer_receipt_contract.producer,
    schema: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
    value: sealScaPhaseReviewReceiptV1({
      schema_id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      receipt_id: "p02-review-receipt",
      ...reviewFields,
      reviewer_authority_ref: authorityRef,
      criterion_results: SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
        criterion_id,
        status: "PASS",
      })),
      decision: "PASS",
      reviewed_at: TIME[1],
    }),
    upstream: [...subjectRefs, ...evidenceRefs, authorityRef],
  });
  return {
    store: s,
    definition,
    subject,
    inputs,
    evidence,
    evidenceRefs,
    authorityRef,
    receiptRef,
  };
}
function qualify(f: Fixture, gaps: readonly string[] = []) {
  return evaluateScaPhaseQualificationV3({
    store: f.store,
    definition: f.definition,
    criterion_evidence: f.evidence,
    reviewer_authority_ref: f.authorityRef,
    reviewer_receipt_ref: f.receiptRef,
    remaining_gaps: gaps,
    recorded_at: TIME[2],
  });
}

describe("inactive P02 trusted V3 qualification definition", () => {
  it("cannot tamper with nested checks, paths, criterion IDs, schemas, or artifact policy", () => {
    const criterion = SCA_P02_QUALIFICATION_CRITERION_IDS[0];
    const check = SCA_P02_QUALIFICATION_CHECKS[criterion][0];
    expect(check).toBeDefined();
    expect(Reflect.set(SCA_P02_QUALIFICATION_CHECKS[criterion], 0, "substituted-check")).toBe(
      false
    );
    expect(Reflect.deleteProperty(SCA_P02_QUALIFICATION_CHECKS[criterion], "1")).toBe(false);
    expect(Reflect.set(SCA_P02_QUALIFICATION_CRITERION_IDS, 0, "p02-substituted")).toBe(false);
    expect(Reflect.set(SCA_P02_IMPLEMENTATION_SOURCE_PATHS, 0, "changed-path")).toBe(false);
    for (const descriptor of Object.values(SCA_P02_QUALIFICATION_ARTIFACTS)) {
      expect(Reflect.set(descriptor, "producer", "host:impostor")).toBe(false);
      expect(Reflect.set(descriptor, "schema_id", "penny.impostor.v1")).toBe(false);
    }
    expect(
      Reflect.set(
        ScaP02QualificationEvidenceV1Schema.properties.observations.items.properties.observed,
        "type",
        "null"
      )
    ).toBe(false);
    expect(
      Reflect.set(ScaP02ImplementationIdentityV1Schema.properties.source_files, "minItems", 0)
    ).toBe(false);

    const f = setup();
    const valid = evidenceBase(criterion, f.subject.subject_sha256, f.inputs);
    expect(() =>
      validateScaP02QualificationEvidenceV1({
        ...valid,
        observations: valid.observations.slice(1),
      })
    ).toThrow();
    expect(
      f.definition.criteria[0]?.evidence_contract.evaluate([
        { ...valid, observations: valid.observations.slice(1) },
      ])
    ).toBe("BLOCKED");
    expect(() => scaP02SourceManifestSha256(files.slice(1))).toThrow();
    expect(() => qualify(setup({ evidenceProducer: "host:impostor" }))).toThrow();
  });

  it("constructs without a store or storage calls, then leaves persisted inspection to the host", () => {
    const f = setup();
    const [first, second, third, fourth] = f.definition.criteria;
    if (!first || !second || !third || !fourth) throw new Error("missing P02 criteria");
    const input = {
      tenant_id: TENANT,
      project_id: PROJECT,
      run_id: RUN,
      implementation_revision: REVISION,
      current_host_binding_sha256: HOST_BINDING,
      current_source_manifest_sha256: identity().source_manifest_sha256,
      max_unique_artifact_bytes: 32 * 1_048_576,
      max_json_artifact_bytes: 1_048_576,
      reviewer_authority_id: "p02-review-authority",
      reviewer_identity_id: "p02-reviewer",
      reviewer_lineage_id: "p02-review-lineage",
      implementation_identity: {
        ...f.definition.implementation_identity,
        ref: { ...f.definition.implementation_identity.ref },
      },
      qualified_inputs: f.definition.qualified_inputs.map((binding) => ({
        ...binding,
        ref: { ...binding.ref },
      })),
      criterion_definition_refs: {
        "p02-containment-egress-and-minimization": first.definition_ref,
        "p02-current-predecessor-and-implementation": second.definition_ref,
        "p02-required-variants-and-lifecycle": third.definition_ref,
        "p02-six-operation-deterministic-coverage": fourth.definition_ref,
      },
      reviewer_authority_contract: { ...f.definition.reviewer_authority_contract },
      reviewer_receipt_contract: f.definition.reviewer_receipt_contract,
      qualification_record_contract: f.definition.qualification_record_contract,
      gate_record_contract: f.definition.gate_record_contract,
    };
    const read = vi.spyOn(f.store, "read");
    const metadata = vi.spyOn(f.store, "metadata");
    try {
      const definition = createScaP02QualificationDefinitionV1(input);
      expect(read).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
      expect(definition.criteria.map((c) => c.criterion_id)).toEqual(
        SCA_P02_QUALIFICATION_CRITERION_IDS
      );
      const firstCriterion = definition.criteria[0];
      const firstInput = definition.qualified_inputs[0];
      if (!firstCriterion || !firstInput) throw new Error("missing P02 policy");
      expect(Reflect.set(firstCriterion.evidence_contract, "producer", "host:impostor")).toBe(
        false
      );
      expect(
        Reflect.set(firstCriterion.definition_contract, "schema_id", "penny.impostor.v1")
      ).toBe(false);
      expect(
        Reflect.set(definition.implementation_identity_contract, "producer", "host:impostor")
      ).toBe(false);
      expect(Reflect.set(firstInput.ref, "producer", "host:impostor")).toBe(false);
      expect(Reflect.set(definition.criteria, 0, fourth)).toBe(false);
      const callerInputRef = input.qualified_inputs[0]?.ref;
      if (!callerInputRef) throw new Error("missing caller P02 input");
      expect(Reflect.set(input.implementation_identity.ref, "producer", "host:impostor")).toBe(
        true
      );
      expect(Reflect.set(callerInputRef, "producer", "host:impostor")).toBe(true);
      expect(Reflect.set(input.reviewer_authority_contract, "producer", "host:impostor")).toBe(
        true
      );
      expect(definition.implementation_identity.ref.producer).not.toBe("host:impostor");
      expect(firstInput.ref.producer).not.toBe("host:impostor");
      expect(definition.reviewer_authority_contract.producer).not.toBe("host:impostor");
      expect(
        firstCriterion.evidence_contract.validate(
          evidenceBase(SCA_P02_QUALIFICATION_CRITERION_IDS[0], f.subject.subject_sha256, f.inputs)
        ).criterion_id
      ).toBe(firstCriterion.criterion_id);
      expect(read).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      metadata.mockRestore();
    }
    expect(
      inspectScaQualificationSubjectV1({ store: f.store, definition: f.definition }).criteria
    ).toHaveLength(4);
  });
  it("binds a persisted subject, four independent live evidences and review to a persisted passing V3 gate", () => {
    const f = setup();
    expect(f.subject.criteria.map((c) => c.required_evidence_count)).toEqual([1, 1, 1, 1]);
    expect(f.subject.criteria.map((c) => c.required_evidence_class)).toEqual([
      "live",
      "live",
      "live",
      "live",
    ]);
    const qualification = qualify(f);
    expect(qualification.status).toBe("PASS");
    const qualificationRef = persist({
      store: f.store,
      operation: "qualification",
      kind: f.definition.qualification_record_contract.artifact_kind,
      producer: f.definition.qualification_record_contract.producer,
      schema: SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      version: 3,
      value: qualification,
      upstream: [
        f.subject.implementation_identity_ref,
        ...f.inputs,
        ...f.subject.criteria.map((c) => c.definition_ref),
        ...f.evidenceRefs,
        f.authorityRef,
        f.receiptRef,
      ],
    });
    const gate = evaluateScaPhaseGateV3({
      store: f.store,
      definition: f.definition,
      qualification_ref: qualificationRef,
      evaluated_at: TIME[3],
    });
    const gateRef = persist({
      store: f.store,
      operation: "gate",
      kind: f.definition.gate_record_contract.artifact_kind,
      producer: f.definition.gate_record_contract.producer,
      schema: SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      version: 3,
      value: gate,
      upstream: [qualificationRef],
    });
    expect(
      requireScaPhaseGatePassV3({ store: f.store, definition: f.definition, gate_ref: gateRef })
        .status
    ).toBe("passed");
    expect(() =>
      requireScaPhaseGatePassV3({
        store: f.store,
        definition: {
          ...f.definition,
          current_host_binding_sha256: sha256("stale-current-host"),
        },
        gate_ref: gateRef,
      })
    ).toThrow();
    expect(() =>
      requireScaPhaseGatePassV3({
        store: f.store,
        definition: {
          ...f.definition,
          implementation_revision: "p02-revision-2",
        },
        gate_ref: gateRef,
      })
    ).toThrow();
  });

  it("requires the fixed canonical source census and its exact manifest digest", () => {
    const valid = identity();
    expect(scaP02SourceManifestSha256(files)).toBe(valid.source_manifest_sha256);
    expect(() =>
      validateScaP02ImplementationIdentityV1({ ...valid, source_manifest_sha256: sha256("stale") })
    ).toThrow();
    const first = files[0];
    if (first === undefined) throw new Error("missing fixed source paths");
    for (const source_files of [
      [],
      [...files].reverse(),
      [first, ...files],
      [{ ...first, path: "../escape" }, ...files.slice(1)],
      [{ ...first, path: "/absolute" }, ...files.slice(1)],
      [{ ...first, path: "a\\b" }, ...files.slice(1)],
    ]) {
      expect(() => scaP02SourceManifestSha256(source_files)).toThrow();
    }
    expect(() =>
      validateScaP02ImplementationIdentityV1({ ...valid, assurance_scope: "declaration_only" })
    ).toThrow();
    expect(() =>
      validateScaP02ImplementationIdentityV1({ ...valid, phase_id: "SCA-P03" })
    ).toThrow();
    expect(() => validateScaP02ImplementationIdentityV1({ ...valid, extra: true })).toThrow();
  });

  it("refuses missing, extra, duplicate, unknown, false and null live checks without accepting a status label", () => {
    const f = setup();
    const value = evidenceBase(
      SCA_P02_QUALIFICATION_CRITERION_IDS[0],
      f.subject.subject_sha256,
      f.inputs
    );
    const first = value.observations[0];
    if (first === undefined) throw new Error("missing first check");
    for (const observations of [
      [],
      value.observations.slice(1),
      [...value.observations, first],
      [...value.observations, { check_id: "unknown", observed: true }],
      [{ ...first, observed: false }, ...value.observations.slice(1)],
      [{ ...first, observed: null }, ...value.observations.slice(1)],
    ]) {
      expect(() => validateScaP02QualificationEvidenceV1({ ...value, observations })).toThrow();
    }
    for (const bad of [
      { ...value, status: "PASS" },
      { ...value, criterion_id: "p02-unknown" },
      { ...value, supporting_refs: [f.inputs[0], f.inputs[0]] },
      { ...value, supporting_refs: [...f.inputs].reverse() },
      { ...value, supporting_refs: [{ ...f.inputs[0], phase: "SCA-P03" }, f.inputs[1]] },
      { ...value, phase_id: "SCA-P03" },
      { ...value, assurance_scope: "declaration_only" },
      { ...value, host_binding_sha256: null },
      { ...value, schema_id: "penny.wrong.v1" },
    ]) {
      expect(() => validateScaP02QualificationEvidenceV1(bad)).toThrow();
    }
  });

  it("refuses stale bindings, cross-spliced criterion/subject/run, wrong support refs and provenance", () => {
    expect(() =>
      setup({ identityChange: (v) => ({ ...v, host_binding_sha256: sha256("old") }) })
    ).toThrow();
    expect(() => setup({ revision: "revised" })).toThrow();
    expect(() => setup({ sourceManifest: sha256("changed-live-file") })).toThrow();
    expect(() => setup({ definitionCount: 2 })).toThrow();
    for (const evidenceChange of [
      (v: ScaP02QualificationEvidenceV1) => ({
        ...v,
        criterion_id: SCA_P02_QUALIFICATION_CRITERION_IDS.find((id) => id !== v.criterion_id),
      }),
      (v: ScaP02QualificationEvidenceV1) => ({ ...v, subject_sha256: sha256("other-subject") }),
      (v: ScaP02QualificationEvidenceV1) => ({ ...v, run_id: "other-run" }),
      (v: ScaP02QualificationEvidenceV1) => ({ ...v, supporting_refs: v.supporting_refs.slice(1) }),
    ]) {
      expect(() => qualify(setup({ evidenceChange }))).toThrow();
    }
    expect(() => qualify(setup({ badUpstream: true }))).toThrow();
    expect(() => qualify(setup({ reviewer: "p02-implementer" }))).toThrow();
    const f = setup();
    expect(() =>
      evaluateScaPhaseQualificationV3({
        store: f.store,
        definition: f.definition,
        criterion_evidence: f.evidence.slice(1),
        reviewer_authority_ref: f.authorityRef,
        reviewer_receipt_ref: f.receiptRef,
        remaining_gaps: [],
        recorded_at: TIME[2],
      })
    ).toThrow();
    const firstEvidence = f.evidence[0];
    const firstRef = firstEvidence?.evidence_refs[0];
    if (firstEvidence === undefined || firstRef === undefined)
      throw new Error("missing first evidence");
    expect(() =>
      evaluateScaPhaseQualificationV3({
        store: f.store,
        definition: f.definition,
        criterion_evidence: [...f.evidence, firstEvidence],
        reviewer_authority_ref: f.authorityRef,
        reviewer_receipt_ref: f.receiptRef,
        remaining_gaps: [],
        recorded_at: TIME[2],
      })
    ).toThrow();
    expect(() =>
      evaluateScaPhaseQualificationV3({
        store: f.store,
        definition: f.definition,
        criterion_evidence: f.evidence.map((entry, index) =>
          index === 0 ? { ...entry, evidence_refs: [firstRef, firstRef] } : entry
        ),
        reviewer_authority_ref: f.authorityRef,
        reviewer_receipt_ref: f.receiptRef,
        remaining_gaps: [],
        recorded_at: TIME[2],
      })
    ).toThrow();
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: f.store,
        definition: {
          ...f.definition,
          criteria: f.definition.criteria.map((entry, i) =>
            i === 0
              ? {
                  ...entry,
                  definition_ref: f.inputs[0] ?? entry.definition_ref,
                }
              : entry
          ),
        },
      })
    ).toThrow();
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: f.store,
        definition: {
          ...f.definition,
          implementation_identity_contract: {
            ...f.definition.implementation_identity_contract,
            producer: "host:wrong-producer",
          },
        },
      })
    ).toThrow();
    // An immutable source input may acquire a new revision. The old subject does not
    // silently upgrade: selecting the new ref with old definitions fails provenance.
    const prior = f.inputs[0];
    if (prior === undefined) throw new Error("missing predecessor input");
    const newer = persist({
      store: f.store,
      operation: prior.operation_id,
      kind: prior.kind,
      producer: prior.producer,
      phase: prior.phase,
      ...(prior.content_schema === undefined
        ? {}
        : { schema: prior.content_schema.schema_id, version: prior.content_schema.schema_version }),
      parent: prior,
      value: { predecessor: "mutated" },
      upstream: [prior],
    });
    expect(() =>
      inspectScaQualificationSubjectV1({
        store: f.store,
        definition: {
          ...f.definition,
          qualified_inputs: f.definition.qualified_inputs.map((binding) =>
            binding.ref.artifact_id === prior.artifact_id ? bind(f.store, newer) : binding
          ),
        },
      })
    ).toThrow();
  });

  it("cannot issue a PASS from failed/blocked live observations or an unresolved gap", () => {
    for (const observed of [false, null]) {
      const f = setup({
        evidenceChange: (v) => ({
          ...v,
          observations: v.observations.map((o, i) => (i === 0 ? { ...o, observed } : o)),
        }),
      });
      expect(() => qualify(f)).toThrow();
    }
    const f = setup();
    const blocked = qualify(f, ["pending-live-variant"]);
    expect(blocked.status).toBe("BLOCKED");
    const blockedRef = persist({
      store: f.store,
      operation: "blocked-qualification",
      kind: f.definition.qualification_record_contract.artifact_kind,
      producer: f.definition.qualification_record_contract.producer,
      schema: SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      version: 3,
      value: blocked,
      upstream: [
        f.subject.implementation_identity_ref,
        ...f.inputs,
        ...f.subject.criteria.map((c) => c.definition_ref),
        ...f.evidenceRefs,
        f.authorityRef,
        f.receiptRef,
      ],
    });
    const blockedGate = evaluateScaPhaseGateV3({
      store: f.store,
      definition: f.definition,
      qualification_ref: blockedRef,
      evaluated_at: TIME[3],
    });
    const blockedGateRef = persist({
      store: f.store,
      operation: "blocked-gate",
      kind: f.definition.gate_record_contract.artifact_kind,
      producer: f.definition.gate_record_contract.producer,
      schema: SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      version: 3,
      value: blockedGate,
      upstream: [blockedRef],
    });
    expect(blockedGate.status).toBe("blocked");
    expect(() =>
      requireScaPhaseGatePassV3({
        store: f.store,
        definition: f.definition,
        gate_ref: blockedGateRef,
      })
    ).toThrow();
    const criterion = f.definition.criteria[0];
    if (criterion === undefined) throw new Error("missing criterion");
    expect(
      criterion.evidence_contract.evaluate([
        {
          ...evidenceBase(
            SCA_P02_QUALIFICATION_CRITERION_IDS[0],
            f.subject.subject_sha256,
            f.inputs
          ),
          observations: [{ check_id: "x", observed: false }],
        },
      ])
    ).toBe("FAIL");
    expect(
      criterion.evidence_contract.evaluate([
        {
          ...evidenceBase(
            SCA_P02_QUALIFICATION_CRITERION_IDS[0],
            f.subject.subject_sha256,
            f.inputs
          ),
          observations: [{ check_id: "x", observed: null }],
        },
      ])
    ).toBe("BLOCKED");
  });
});
