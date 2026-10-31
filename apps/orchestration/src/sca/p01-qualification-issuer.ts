import { randomUUID } from "node:crypto";

import { Type, type Static } from "typebox";

import {
  currentArtifactRef,
  previewArtifactRef,
  type ArtifactHostStore,
  type PersistArtifactInput,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  assertOpaqueId,
  assertRfc3339Utc,
} from "../skill-contracts/common.js";
import {
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
  SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
  SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
  SCA_P01_QUALIFICATION_VARIANT_IDS,
  SCA_P01_REQUIRED_CRITERION_IDS,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS as PRODUCERS,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
  SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
  SCA_QUALIFICATION_LOG_V1_SCHEMA,
  SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_REVIEW_RECEIPT_V1_SCHEMA,
  scaPhaseQualificationRefs,
  validateScaCampaignSourceSnapshotV2,
  validateScaHostBoundaryReceiptV1,
  validateScaImplementationIdentityV1,
  validateScaP01QualificationProfileV1,
  validateScaP01QualificationDispatchV1,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  validateScaPhaseQualificationRecordV2,
  validateScaQualificationEvidenceV1,
  validateScaQualificationFixtureV1,
  validateScaQualificationLogV1,
  validateScaReviewerAuthorityV1,
  validateScaReviewReceiptV1,
} from "./p01-contracts.js";

const PHASE = "SCA-P01-qualification";
const MAX_JSON = 4 * 1_048_576;
const MAX_BUNDLE = 64 * 1_048_576;
const MAX_CASE_BYTES = 1_048_576;
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sorted = (refs: readonly ArtifactRef[]): ArtifactRef[] =>
  [...refs].sort((a, b) => compare(a.artifact_id, b.artifact_id));
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const CaseSchema = Type.Object(
  {
    criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
    variant_id: Type.String({ minLength: 1, maxLength: 64 }),
    fixture_id: Type.String({ minLength: 1, maxLength: 128 }),
    command_id: Type.String({ minLength: 1, maxLength: 128 }),
    job_id: Type.String({ minLength: 1, maxLength: 128 }),
    configuration_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    expected_result: Type.String({ minLength: 1, maxLength: 4096 }),
    fixture_content: Type.Unknown(),
  },
  { additionalProperties: false }
);
const ExecutionSchema = Type.Object(
  {
    invocation_id: Type.String({ minLength: 1, maxLength: 128 }),
    observed_result: Type.String({ minLength: 1, maxLength: 4096 }),
    status: Type.Union([
      Type.Literal("PASS"),
      Type.Literal("FAIL"),
      Type.Literal("BLOCKED"),
      Type.Literal("NOT RUN"),
    ]),
    log_content: Type.Unknown(),
    dispatch_measurement: Type.Object(
      {
        baseline: Type.Object(
          {
            model: Type.Integer({ minimum: 0 }),
            scanner: Type.Integer({ minimum: 0 }),
            application: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false }
        ),
        final: Type.Object(
          {
            model: Type.Integer({ minimum: 0 }),
            scanner: Type.Integer({ minimum: 0 }),
            application: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false }
        ),
        delta: Type.Object(
          {
            model: Type.Integer({ minimum: 0 }),
            scanner: Type.Integer({ minimum: 0 }),
            application: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
const ReviewSchema = Type.Object(
  {
    authority_id: Type.String({ minLength: 1, maxLength: 128 }),
    receipt_id: Type.String({ minLength: 1, maxLength: 128 }),
    reviewer_identity_id: Type.String({ minLength: 1, maxLength: 128 }),
    reviewer_lineage_id: Type.String({ minLength: 1, maxLength: 128 }),
    authority_decision: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
    decision: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("BLOCKED")]),
    reviewed_at: Type.String({ minLength: 20, maxLength: 40 }),
  },
  { additionalProperties: false }
);

/** Closed, JSON-round-trippable handoff. No review claim is part of the draft. */
export const P01QualificationDraftV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p01-qualification-draft.v1"),
    schema_version: Type.Literal(1),
    draft_ref: ArtifactRefSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementer_identity_id: OpaqueIdSchema,
    implementer_lineage_id: OpaqueIdSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_file_manifest_ref: ArtifactRefSchema,
    source_custody_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    implementation_ref: ArtifactRefSchema,
    implementation_source_ref: ArtifactRefSchema,
    implementation_build_ref: ArtifactRefSchema,
    criteria: Type.Array(
      Type.Object(
        {
          criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
          status: Type.Literal("PASS"),
          variants: Type.Array(
            Type.Object(
              {
                variant_id: Type.String({ minLength: 1, maxLength: 64 }),
                fixture_ref: ArtifactRefSchema,
                evidence_ref: ArtifactRefSchema,
                applicability: Type.Literal("applicable"),
                status: Type.Literal("PASS"),
              },
              { additionalProperties: false }
            ),
            { minItems: 11, maxItems: 11 }
          ),
        },
        { additionalProperties: false }
      ),
      { minItems: 4, maxItems: 4 }
    ),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type P01QualificationDraftV1 = Readonly<Static<typeof P01QualificationDraftV1Schema>>;

export interface P01QualificationCase {
  readonly criterion_id: string;
  readonly variant_id: string;
  readonly fixture_id: string;
  readonly command_id: string;
  readonly job_id: string;
  readonly configuration_sha256: string;
  readonly expected_result: string;
  readonly fixture_content: Uint8Array;
}
export interface P01QualificationExecution {
  readonly invocation_id: string;
  readonly observed_result: string;
  readonly status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
  readonly log_content: Uint8Array;
  readonly dispatch_measurement: {
    readonly baseline: {
      readonly model: number;
      readonly scanner: number;
      readonly application: number;
    };
    readonly final: {
      readonly model: number;
      readonly scanner: number;
      readonly application: number;
    };
    readonly delta: {
      readonly model: number;
      readonly scanner: number;
      readonly application: number;
    };
  };
}
export interface P01QualificationReview {
  readonly authority_id: string;
  readonly receipt_id: string;
  readonly reviewer_identity_id: string;
  readonly reviewer_lineage_id: string;
  readonly authority_decision: "authorized" | "denied";
  readonly decision: "PASS" | "FAIL" | "BLOCKED";
  readonly reviewed_at: string;
}
export interface P01QualificationIssuerInput {
  readonly store: ArtifactHostStore;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly implementation_revision: string;
  readonly build_identity: string;
  readonly profile_id: string;
  readonly implementer_identity_id: string;
  readonly implementer_lineage_id: string;
  readonly source_snapshot_ref: ArtifactRef;
  readonly implementation_source: Uint8Array;
  readonly implementation_build: Uint8Array;
  readonly cases: readonly P01QualificationCase[];
  readonly recorded_at: string;
  readonly execute: (input: {
    readonly invocation_id: string;
    readonly case: P01QualificationCase;
    readonly implementation_ref: ArtifactRef;
    readonly qualification_profile_ref: ArtifactRef;
  }) => Promise<unknown>;
  readonly review: (input: {
    readonly evidence_refs: readonly ArtifactRef[];
    readonly implementation_ref: ArtifactRef;
    readonly qualification_profile_ref: ArtifactRef;
  }) => Promise<unknown>;
}

export interface P01QualificationFinalizeInput {
  readonly store: ArtifactHostStore;
  readonly draft: unknown;
  /** Supplied by a separate authority; alternatively review is invoked after exact verification. */
  readonly review?: P01QualificationReview;
  readonly review_callback?: (input: {
    readonly evidence_refs: readonly ArtifactRef[];
    readonly implementation_ref: ArtifactRef;
    readonly qualification_profile_ref: ArtifactRef;
  }) => Promise<unknown>;
}

function bytes(value: unknown, limit: number, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > limit) {
    throw new Error(`${label} must contain bounded nonempty bytes`);
  }
  return Buffer.from(value);
}

function exact(
  store: ArtifactHostStore,
  refValue: ArtifactRef,
  kind: string,
  schema: string,
  version: number,
  producer: string,
  media = "application/json",
  limit = MAX_JSON
): Buffer {
  const ref = currentArtifactRef(refValue);
  if (!equal(ref, refValue)) throw new Error(`noncanonical ${kind} ref`);
  if (
    ref.kind !== kind ||
    ref.content_schema?.schema_id !== schema ||
    ref.content_schema.schema_version !== version ||
    ref.producer !== producer ||
    ref.media_type !== media
  )
    throw new Error(`wrong ${kind} artifact contract`);
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !equal(stored, ref))
    throw new Error(`missing or changed ${kind} ref`);
  const content = store.readById(ref.artifact_id);
  const metadata = store.metadata(ref);
  if (
    content.byteLength < 1 ||
    content.byteLength > limit ||
    content.byteLength !== ref.byte_length ||
    sha256(content) !== ref.content_digest ||
    !equal(previewArtifactRef({ metadata, content }), ref)
  )
    throw new Error(`invalid exact ${kind} bytes`);
  return content;
}
function json(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  schema: string,
  version: number,
  producer: string
): unknown {
  const content = exact(store, ref, kind, schema, version, producer);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`${kind} is not canonical JSON`);
  return value;
}
function persist(
  store: ArtifactHostStore,
  run: string,
  kind: string,
  schema: string,
  version: number,
  producer: string,
  operation: string,
  content: string | Uint8Array,
  refs: readonly ArtifactRef[] = [],
  media = "application/json"
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: run,
    phase: PHASE,
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    producer,
    media_type: media,
    content_schema: { schema_id: schema, schema_version: version },
    parent_ref: null,
    upstream_refs: sorted(refs),
  };
  const input: PersistArtifactInput = { metadata, content };
  const planned = previewArtifactRef(input);
  const occupied = store.refFor(run, PHASE, null, kind, operation, 1);
  if (occupied !== null && !equal(occupied, planned))
    throw new Error(`conflicting ${kind} operation already exists`);
  const ref = store.persist(input);
  exact(
    store,
    ref,
    kind,
    schema,
    version,
    producer,
    media,
    media === "application/json" ? MAX_JSON : MAX_BUNDLE
  );
  if (!equal(ref, planned) || !equal(store.metadata(ref), metadata))
    throw new Error(`failed exact ${kind} readback`);
  return ref;
}
function putJson(
  store: ArtifactHostStore,
  run: string,
  kind: string,
  schema: string,
  version: number,
  producer: string,
  operation: string,
  value: unknown,
  refs: readonly ArtifactRef[] = []
): ArtifactRef {
  return persist(
    store,
    run,
    kind,
    schema,
    version,
    producer,
    operation,
    canonicalJson(value),
    refs
  );
}
function requireDistinct(values: readonly string[], label: string): void {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length)
    throw new Error(`reused ${label}`);
}

/** Host-only evidence collection. Execution callbacks are trusted host authorities; failures retain earlier evidence without review or PASS synthesis. */
export async function collectP01QualificationEvidenceV2(
  input: Omit<P01QualificationIssuerInput, "review">
): Promise<P01QualificationDraftV1> {
  for (const [label, id] of [
    ["tenant", input.tenant_id],
    ["project", input.project_id],
    ["run", input.run_id],
    ["revision", input.implementation_revision],
    ["build", input.build_identity],
    ["profile", input.profile_id],
    ["implementer", input.implementer_identity_id],
    ["lineage", input.implementer_lineage_id],
  ] as const)
    assertOpaqueId(id, label);
  assertRfc3339Utc(input.recorded_at, "recorded_at");
  requireDistinct(
    [input.implementer_identity_id, input.implementer_lineage_id],
    "implementer identity/lineage"
  );
  const sourceBytes = bytes(input.implementation_source, MAX_BUNDLE, "implementation source");
  const buildBytes = bytes(input.implementation_build, MAX_BUNDLE, "implementation build");
  if (sha256(sourceBytes) === sha256(buildBytes)) throw new Error("reused source/build material");
  if (
    !Array.isArray(input.cases) ||
    input.cases.length !==
      SCA_P01_REQUIRED_CRITERION_IDS.length * SCA_P01_QUALIFICATION_VARIANT_IDS.length
  )
    throw new Error("incomplete P01 case matrix");
  const cases = input.cases.map((candidate) => {
    const cell = validateContract(CaseSchema, candidate, "P01 case");
    return { ...cell, fixture_content: bytes(cell.fixture_content, MAX_CASE_BYTES, "fixture") };
  });
  const expectedKeys = SCA_P01_REQUIRED_CRITERION_IDS.flatMap((criterion) =>
    SCA_P01_QUALIFICATION_VARIANT_IDS.map((variant) => `${criterion}\0${variant}`)
  );
  if (
    !equal(
      cases.map((cell) => `${cell.criterion_id}\0${cell.variant_id}`),
      expectedKeys
    )
  )
    throw new Error("P01 cases must cover the canonical matrix once each");
  requireDistinct(
    cases.flatMap((cell) => [cell.fixture_id, cell.command_id, cell.job_id]),
    "case identity"
  );
  requireDistinct(
    cases.map((cell) => sha256(cell.fixture_content)),
    "fixture content"
  );
  for (const cell of cases)
    for (const id of [cell.fixture_id, cell.command_id, cell.job_id]) assertOpaqueId(id, "case ID");
  const snapshotRef = currentArtifactRef(input.source_snapshot_ref);
  if (!equal(snapshotRef, input.source_snapshot_ref))
    throw new Error("noncanonical source snapshot ref");
  if (snapshotRef.run_id !== input.run_id)
    throw new Error("source snapshot is from another qualification run");
  const snapshot = validateScaCampaignSourceSnapshotV2(
    json(
      input.store,
      snapshotRef,
      "source-snapshot",
      SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      2,
      PRODUCERS.source
    )
  );
  const manifest = validateScaP01SourceFileManifestV1(
    json(
      input.store,
      snapshot.file_manifest_ref,
      "sca-p01-source-file-manifest",
      SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      1,
      PRODUCERS.source
    )
  );
  const custody = validateScaP01SourceCustodyCorpusV1(
    json(
      input.store,
      snapshot.custody_ref,
      "sca-p01-source-custody-corpus",
      SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      1,
      PRODUCERS.source
    )
  );
  if (
    snapshot.file_manifest_ref.run_id !== input.run_id ||
    snapshot.custody_ref.run_id !== input.run_id
  )
    throw new Error("source material is from another run");
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: snapshot.file_manifest_ref,
    file_manifest: manifest,
    custody_ref: snapshot.custody_ref,
    custody,
  });
  const run = input.run_id;
  const profile = validateScaP01QualificationProfileV1({
    schema_id: SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
    schema_version: 1,
    profile_id: input.profile_id,
    phase_id: "SCA-P01",
    trust_status: "host-issued",
    implementation_revision: input.implementation_revision,
    criterion_ids: SCA_P01_REQUIRED_CRITERION_IDS,
    variant_ids: SCA_P01_QUALIFICATION_VARIANT_IDS,
  });
  const profileRef = putJson(
    input.store,
    run,
    "sca-p01-qualification-profile",
    SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
    1,
    PRODUCERS.qualification_profile,
    "qualification-profile",
    profile,
    [snapshotRef]
  );
  const sourceRef = persist(
    input.store,
    run,
    "sca-p01-implementation-source-bundle",
    SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
    1,
    PRODUCERS.implementation_source,
    "implementation-source-bundle",
    sourceBytes,
    [snapshotRef, snapshot.file_manifest_ref, snapshot.custody_ref],
    "application/octet-stream"
  );
  const buildRef = persist(
    input.store,
    run,
    "sca-p01-implementation-build-bundle",
    SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
    1,
    PRODUCERS.implementation_build,
    "implementation-build-bundle",
    buildBytes,
    [sourceRef],
    "application/octet-stream"
  );
  const implementation = validateScaImplementationIdentityV1({
    schema_id: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    implementation_revision: input.implementation_revision,
    source_ref: sourceRef,
    source_sha256: sourceRef.content_digest,
    build_ref: buildRef,
    build_sha256: buildRef.content_digest,
    build_identity: input.build_identity,
    status: "frozen",
  });
  const implementationRef = putJson(
    input.store,
    run,
    "sca-implementation-identity",
    SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    1,
    PRODUCERS.implementation,
    "implementation-identity",
    implementation,
    [sourceRef, buildRef]
  );
  const criteria: Array<{
    criterion_id: string;
    status: "PASS";
    variants: Array<{
      variant_id: string;
      fixture_ref: ArtifactRef;
      evidence_ref: ArtifactRef;
      applicability: "applicable";
      status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
    }>;
  }> = [];
  const evidenceRefs: ArtifactRef[] = [];
  const observedHashes = new Set<string>();
  const logHashes = new Set<string>();
  for (const [ci, criterion] of SCA_P01_REQUIRED_CRITERION_IDS.entries()) {
    const variants: (typeof criteria)[number]["variants"] = [];
    for (const [vi, variant] of SCA_P01_QUALIFICATION_VARIANT_IDS.entries()) {
      const cell = cases[ci * SCA_P01_QUALIFICATION_VARIANT_IDS.length + vi];
      if (cell === undefined) throw new Error("sparse case matrix");
      const suffix = `${String(ci + 1).padStart(2, "0")}-${String(vi + 1).padStart(2, "0")}`;
      const fixtureContentRef = persist(
        input.store,
        run,
        "sca-p01-qualification-fixture-content",
        SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
        1,
        PRODUCERS.fixture_content,
        `fixture-content-${suffix}`,
        cell.fixture_content,
        [],
        "application/octet-stream"
      );
      const fixture = validateScaQualificationFixtureV1({
        schema_id: SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
        schema_version: 1,
        fixture_id: cell.fixture_id,
        criterion_id: criterion,
        variant_id: variant,
        fixture_content_ref: fixtureContentRef,
        fixture_sha256: fixtureContentRef.content_digest,
        status: "frozen",
      });
      const fixtureRef = putJson(
        input.store,
        run,
        "sca-qualification-fixture",
        SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
        1,
        PRODUCERS.fixture,
        `fixture-${suffix}`,
        fixture,
        [fixtureContentRef]
      );
      const invocationId = randomUUID();
      const result = validateContract(
        ExecutionSchema,
        await input.execute({
          invocation_id: invocationId,
          case: { ...cell, fixture_content: Buffer.from(cell.fixture_content) },
          implementation_ref: implementationRef,
          qualification_profile_ref: profileRef,
        }),
        "P01 execution"
      );
      const logContent = bytes(result.log_content, MAX_CASE_BYTES, "execution log");
      new TextDecoder("utf-8", { fatal: true }).decode(logContent);
      if (result.invocation_id !== invocationId)
        throw new Error("reused or malformed execution response");
      const measurement = validateScaP01QualificationDispatchV1(result.dispatch_measurement);
      const observedHash = sha256(result.observed_result);
      const logHash = sha256(logContent);
      if (observedHashes.has(observedHash) || logHashes.has(logHash))
        throw new Error("reused execution result or log");
      observedHashes.add(observedHash);
      logHashes.add(logHash);
      const logContentRef = persist(
        input.store,
        run,
        "sca-p01-qualification-log-content",
        SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
        1,
        PRODUCERS.log_content,
        `log-content-${suffix}`,
        logContent,
        [],
        "text/plain; charset=utf-8"
      );
      const log = validateScaQualificationLogV1({
        schema_id: SCA_QUALIFICATION_LOG_V1_SCHEMA,
        schema_version: 1,
        log_id: `log-${suffix}`,
        job_id: cell.job_id,
        criterion_id: criterion,
        variant_id: variant,
        log_content_ref: logContentRef,
        log_sha256: logContentRef.content_digest,
        truncated: false,
      });
      const logRef = putJson(
        input.store,
        run,
        "sca-qualification-log",
        SCA_QUALIFICATION_LOG_V1_SCHEMA,
        1,
        PRODUCERS.log,
        `log-${suffix}`,
        log,
        [logContentRef]
      );
      const receipt = validateScaHostBoundaryReceiptV1({
        schema_id: SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
        schema_version: 1,
        receipt_id: `receipt-${suffix}`,
        boundary: "orchestration-host-artifact-boundary",
        operation_kind: "sca-p01-candidate-admission",
        job_id: cell.job_id,
        attempt: 1,
        implementation_revision: input.implementation_revision,
        configuration_sha256: cell.configuration_sha256,
        command_sha256: sha256(cell.command_id),
        execution_lineage_id: input.implementer_lineage_id,
        implementation_ref: implementationRef,
        implementation_source_ref: sourceRef,
        implementation_build_ref: buildRef,
        fixture_ref: fixtureRef,
        fixture_content_ref: fixtureContentRef,
        log_ref: logRef,
        log_content_ref: logContentRef,
        expected_result_sha256: sha256(cell.expected_result),
        observed_result_sha256: observedHash,
        terminal_status: result.status,
        dispatch_measurement: measurement,
      });
      const receiptRef = putJson(
        input.store,
        run,
        "sca-host-boundary-receipt",
        SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
        1,
        PRODUCERS.boundary_receipt,
        `receipt-${suffix}`,
        receipt,
        [
          implementationRef,
          sourceRef,
          buildRef,
          fixtureRef,
          fixtureContentRef,
          logRef,
          logContentRef,
        ]
      );
      const evidence = validateScaQualificationEvidenceV1({
        schema_id: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
        schema_version: 1,
        evidence_id: `evidence-${suffix}`,
        qualification_run_id: run,
        phase_id: "SCA-P01",
        criterion_id: criterion,
        variant_id: variant,
        implementation_revision: input.implementation_revision,
        implementation_ref: implementationRef,
        qualification_profile_ref: profileRef,
        fixture_ref: fixtureRef,
        fixture_content_ref: fixtureContentRef,
        applicability: "applicable",
        applicability_rationale: null,
        command_id: cell.command_id,
        job_id: cell.job_id,
        execution_lineage_id: input.implementer_lineage_id,
        configuration_sha256: cell.configuration_sha256,
        expected_result: cell.expected_result,
        expected_result_sha256: sha256(cell.expected_result),
        observed_result: result.observed_result,
        observed_result_sha256: observedHash,
        result: result.status,
        log_ref: logRef,
        log_content_ref: logContentRef,
        boundary_receipt_ref: receiptRef,
        dispatch_measurement: measurement,
      });
      const evidenceRef = putJson(
        input.store,
        run,
        "sca-qualification-evidence",
        SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
        1,
        PRODUCERS.evidence,
        `evidence-${suffix}`,
        evidence,
        [
          implementationRef,
          profileRef,
          fixtureRef,
          fixtureContentRef,
          logRef,
          logContentRef,
          receiptRef,
        ]
      );
      evidenceRefs.push(evidenceRef);
      variants.push({
        variant_id: variant,
        fixture_ref: fixtureRef,
        evidence_ref: evidenceRef,
        applicability: "applicable",
        status: result.status,
      });
      if (
        result.status !== "PASS" ||
        measurement.delta.model !== 0 ||
        measurement.delta.scanner !== 0 ||
        measurement.delta.application !== 0
      )
        throw new Error("non-PASS or dispatched P01 execution; evidence retained without closure");
    }
    criteria.push({ criterion_id: criterion, status: "PASS", variants });
  }
  const payload = {
    schema_id: "penny.sca-p01-qualification-draft.v1",
    schema_version: 1,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: run,
    implementation_revision: input.implementation_revision,
    implementer_identity_id: input.implementer_identity_id,
    implementer_lineage_id: input.implementer_lineage_id,
    source_snapshot_ref: snapshotRef,
    source_file_manifest_ref: snapshot.file_manifest_ref,
    source_custody_ref: snapshot.custody_ref,
    qualification_profile_ref: profileRef,
    implementation_ref: implementationRef,
    implementation_source_ref: sourceRef,
    implementation_build_ref: buildRef,
    criteria,
    recorded_at: input.recorded_at,
  };
  validateContract(
    Type.Omit(P01QualificationDraftV1Schema, ["draft_ref"]),
    payload,
    "P01 draft payload"
  );
  const draftRef = putJson(
    input.store,
    run,
    "sca-p01-qualification-draft",
    "penny.sca-p01-qualification-draft.v1",
    1,
    PRODUCERS.qualification,
    "qualification-draft",
    payload,
    [
      snapshotRef,
      snapshot.file_manifest_ref,
      snapshot.custody_ref,
      profileRef,
      implementationRef,
      sourceRef,
      buildRef,
      ...criteria.flatMap((criterion) =>
        criterion.variants.flatMap((variant) => [variant.fixture_ref, variant.evidence_ref])
      ),
    ]
  );
  return validateContract(
    P01QualificationDraftV1Schema,
    { ...payload, draft_ref: draftRef },
    "P01 qualification draft"
  );
}

function checked(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  run: string,
  phase: string,
  kind: string,
  schema: string,
  producer: string,
  operation: string,
  upstream: readonly ArtifactRef[],
  media = "application/json",
  limit = MAX_JSON,
  version = 1
): Buffer {
  if (
    ref.run_id !== run ||
    ref.phase !== phase ||
    ref.branch_id !== null ||
    ref.operation_id !== operation ||
    ref.version !== 1 ||
    !equal(store.refFor(run, phase, null, kind, operation, 1), ref)
  )
    throw new Error(`substituted or cross-run ${kind} ref`);
  const content = exact(store, ref, kind, schema, version, producer, media, limit);
  const metadata = store.metadata(ref);
  if (metadata.parent_ref !== null || !equal(metadata.upstream_refs, sorted(upstream)))
    throw new Error(`invalid ${kind} provenance`);
  return content;
}

function checkedJson(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  run: string,
  phase: string,
  kind: string,
  schema: string,
  producer: string,
  operation: string,
  upstream: readonly ArtifactRef[],
  version = 1
): unknown {
  const content = checked(
    store,
    ref,
    run,
    phase,
    kind,
    schema,
    producer,
    operation,
    upstream,
    "application/json",
    MAX_JSON,
    version
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`noncanonical ${kind} content`);
  return parsed;
}

function verifyDraft(store: ArtifactHostStore, draft: P01QualificationDraftV1): void {
  assertRfc3339Utc(draft.recorded_at, "recorded_at");
  requireDistinct([draft.implementer_identity_id, draft.implementer_lineage_id], "implementer");
  const run = draft.run_id;
  const { draft_ref, ...payload } = draft;
  const storedDraft = checkedJson(
    store,
    draft_ref,
    run,
    PHASE,
    "sca-p01-qualification-draft",
    "penny.sca-p01-qualification-draft.v1",
    PRODUCERS.qualification,
    "qualification-draft",
    [
      draft.source_snapshot_ref,
      draft.source_file_manifest_ref,
      draft.source_custody_ref,
      draft.qualification_profile_ref,
      draft.implementation_ref,
      draft.implementation_source_ref,
      draft.implementation_build_ref,
      ...draft.criteria.flatMap((criterion) =>
        criterion.variants.flatMap((variant) => [variant.fixture_ref, variant.evidence_ref])
      ),
    ]
  );
  if (!equal(storedDraft, payload)) throw new Error("substituted qualification draft");
  const sourcePhase = "SCA-P01-source";
  const manifest = validateScaP01SourceFileManifestV1(
    checkedJson(
      store,
      draft.source_file_manifest_ref,
      run,
      sourcePhase,
      "sca-p01-source-file-manifest",
      SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      PRODUCERS.source,
      `source-manifest:${draft.source_file_manifest_ref.operation_id.slice("source-manifest:".length)}`,
      []
    )
  );
  const snapshotId = manifest.snapshot_id;
  if (draft.source_file_manifest_ref.operation_id !== `source-manifest:${snapshotId}`)
    throw new Error("substituted source manifest");
  const custody = validateScaP01SourceCustodyCorpusV1(
    checkedJson(
      store,
      draft.source_custody_ref,
      run,
      sourcePhase,
      "sca-p01-source-custody-corpus",
      SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      PRODUCERS.source,
      `source-custody:${snapshotId}`,
      [draft.source_file_manifest_ref]
    )
  );
  const snapshot = validateScaCampaignSourceSnapshotV2(
    checkedJson(
      store,
      draft.source_snapshot_ref,
      run,
      sourcePhase,
      "source-snapshot",
      SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      PRODUCERS.source,
      `source-snapshot:${snapshotId}`,
      [draft.source_file_manifest_ref, draft.source_custody_ref],
      2
    )
  );
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: draft.source_file_manifest_ref,
    file_manifest: manifest,
    custody_ref: draft.source_custody_ref,
    custody,
  });
  const profile = validateScaP01QualificationProfileV1(
    checkedJson(
      store,
      draft.qualification_profile_ref,
      run,
      PHASE,
      "sca-p01-qualification-profile",
      SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
      PRODUCERS.qualification_profile,
      "qualification-profile",
      [draft.source_snapshot_ref]
    )
  );
  if (
    profile.implementation_revision !== draft.implementation_revision ||
    !equal(profile.criterion_ids, SCA_P01_REQUIRED_CRITERION_IDS) ||
    !equal(profile.variant_ids, SCA_P01_QUALIFICATION_VARIANT_IDS)
  )
    throw new Error("substituted qualification profile");
  const sourceBytes = checked(
    store,
    draft.implementation_source_ref,
    run,
    PHASE,
    "sca-p01-implementation-source-bundle",
    SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
    PRODUCERS.implementation_source,
    "implementation-source-bundle",
    [draft.source_snapshot_ref, draft.source_file_manifest_ref, draft.source_custody_ref],
    "application/octet-stream",
    MAX_BUNDLE
  );
  const buildBytes = checked(
    store,
    draft.implementation_build_ref,
    run,
    PHASE,
    "sca-p01-implementation-build-bundle",
    SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
    PRODUCERS.implementation_build,
    "implementation-build-bundle",
    [draft.implementation_source_ref],
    "application/octet-stream",
    MAX_BUNDLE
  );
  if (sha256(sourceBytes) === sha256(buildBytes)) throw new Error("reused source/build material");
  const implementation = validateScaImplementationIdentityV1(
    checkedJson(
      store,
      draft.implementation_ref,
      run,
      PHASE,
      "sca-implementation-identity",
      SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
      PRODUCERS.implementation,
      "implementation-identity",
      [draft.implementation_source_ref, draft.implementation_build_ref]
    )
  );
  if (
    implementation.implementation_revision !== draft.implementation_revision ||
    !equal(implementation.source_ref, draft.implementation_source_ref) ||
    !equal(implementation.build_ref, draft.implementation_build_ref)
  )
    throw new Error("substituted implementation identity");

  if (
    !equal(
      draft.criteria.map((c) => c.criterion_id),
      SCA_P01_REQUIRED_CRITERION_IDS
    )
  )
    throw new Error("incomplete P01 draft criteria");
  const identities: string[] = [];
  const fixtures: string[] = [];
  const logs: string[] = [];
  const observations: string[] = [];
  const refs: string[] = [];
  for (const [ci, criterion] of draft.criteria.entries()) {
    if (
      criterion.status !== "PASS" ||
      !equal(
        criterion.variants.map((v) => v.variant_id),
        SCA_P01_QUALIFICATION_VARIANT_IDS
      )
    )
      throw new Error("incomplete P01 draft variants");
    for (const [vi, variant] of criterion.variants.entries()) {
      if (variant.status !== "PASS" || variant.applicability !== "applicable")
        throw new Error("non-PASS draft variant");
      const suffix = `${String(ci + 1).padStart(2, "0")}-${String(vi + 1).padStart(2, "0")}`;
      const evidence = validateScaQualificationEvidenceV1(
        json(
          store,
          variant.evidence_ref,
          "sca-qualification-evidence",
          SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
          1,
          PRODUCERS.evidence
        )
      );
      const fixture = validateScaQualificationFixtureV1(
        checkedJson(
          store,
          variant.fixture_ref,
          run,
          PHASE,
          "sca-qualification-fixture",
          SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
          PRODUCERS.fixture,
          `fixture-${suffix}`,
          [evidence.fixture_content_ref]
        )
      );
      const fixtureContentRef = fixture.fixture_content_ref;
      const logRef = evidence.log_ref;
      const logContentRef = evidence.log_content_ref;
      const receiptRef = evidence.boundary_receipt_ref;
      checked(
        store,
        fixtureContentRef,
        run,
        PHASE,
        "sca-p01-qualification-fixture-content",
        SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
        PRODUCERS.fixture_content,
        `fixture-content-${suffix}`,
        [],
        "application/octet-stream",
        MAX_CASE_BYTES
      );
      const log = validateScaQualificationLogV1(
        checkedJson(
          store,
          logRef,
          run,
          PHASE,
          "sca-qualification-log",
          SCA_QUALIFICATION_LOG_V1_SCHEMA,
          PRODUCERS.log,
          `log-${suffix}`,
          [logContentRef]
        )
      );
      const logBytes = checked(
        store,
        logContentRef,
        run,
        PHASE,
        "sca-p01-qualification-log-content",
        SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
        PRODUCERS.log_content,
        `log-content-${suffix}`,
        [],
        "text/plain; charset=utf-8",
        MAX_CASE_BYTES
      );
      new TextDecoder("utf-8", { fatal: true }).decode(logBytes);
      const receipt = validateScaHostBoundaryReceiptV1(
        checkedJson(
          store,
          receiptRef,
          run,
          PHASE,
          "sca-host-boundary-receipt",
          SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
          PRODUCERS.boundary_receipt,
          `receipt-${suffix}`,
          [
            draft.implementation_ref,
            draft.implementation_source_ref,
            draft.implementation_build_ref,
            variant.fixture_ref,
            fixtureContentRef,
            logRef,
            logContentRef,
          ]
        )
      );
      checkedJson(
        store,
        variant.evidence_ref,
        run,
        PHASE,
        "sca-qualification-evidence",
        SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
        PRODUCERS.evidence,
        `evidence-${suffix}`,
        [
          draft.implementation_ref,
          draft.qualification_profile_ref,
          variant.fixture_ref,
          fixtureContentRef,
          logRef,
          logContentRef,
          receiptRef,
        ]
      );
      if (
        fixture.criterion_id !== criterion.criterion_id ||
        fixture.variant_id !== variant.variant_id ||
        log.criterion_id !== criterion.criterion_id ||
        log.variant_id !== variant.variant_id ||
        log.job_id !== evidence.job_id ||
        log.log_id !== `log-${suffix}` ||
        log.truncated ||
        evidence.evidence_id !== `evidence-${suffix}` ||
        evidence.qualification_run_id !== run ||
        evidence.criterion_id !== criterion.criterion_id ||
        evidence.variant_id !== variant.variant_id ||
        evidence.implementation_revision !== draft.implementation_revision ||
        evidence.execution_lineage_id !== draft.implementer_lineage_id ||
        evidence.result !== "PASS" ||
        !equal(evidence.implementation_ref, draft.implementation_ref) ||
        !equal(evidence.qualification_profile_ref, draft.qualification_profile_ref) ||
        !equal(evidence.fixture_ref, variant.fixture_ref) ||
        !equal(evidence.fixture_content_ref, fixtureContentRef) ||
        receipt.receipt_id !== `receipt-${suffix}` ||
        receipt.job_id !== evidence.job_id ||
        receipt.attempt !== 1 ||
        receipt.implementation_revision !== draft.implementation_revision ||
        receipt.execution_lineage_id !== draft.implementer_lineage_id ||
        receipt.configuration_sha256 !== evidence.configuration_sha256 ||
        receipt.command_sha256 !== sha256(evidence.command_id) ||
        receipt.expected_result_sha256 !== evidence.expected_result_sha256 ||
        receipt.observed_result_sha256 !== evidence.observed_result_sha256 ||
        receipt.terminal_status !== "PASS" ||
        receipt.dispatch_measurement === undefined ||
        evidence.dispatch_measurement === undefined ||
        !equal(receipt.dispatch_measurement, evidence.dispatch_measurement) ||
        receipt.dispatch_measurement.delta.model !== 0 ||
        receipt.dispatch_measurement.delta.scanner !== 0 ||
        receipt.dispatch_measurement.delta.application !== 0 ||
        !equal(receipt.implementation_ref, draft.implementation_ref) ||
        !equal(receipt.implementation_source_ref, draft.implementation_source_ref) ||
        !equal(receipt.implementation_build_ref, draft.implementation_build_ref) ||
        !equal(receipt.fixture_ref, variant.fixture_ref) ||
        !equal(receipt.fixture_content_ref, fixtureContentRef) ||
        !equal(receipt.log_ref, logRef) ||
        !equal(receipt.log_content_ref, logContentRef) ||
        !equal(evidence.log_ref, logRef) ||
        !equal(evidence.log_content_ref, logContentRef) ||
        !equal(evidence.boundary_receipt_ref, receiptRef)
      )
        throw new Error(`invalid P01 evidence closure ${suffix}`);
      identities.push(fixture.fixture_id, evidence.command_id, evidence.job_id);
      fixtures.push(fixtureContentRef.content_digest);
      logs.push(logContentRef.content_digest);
      observations.push(evidence.observed_result_sha256);
      refs.push(
        ...[
          variant.fixture_ref,
          variant.evidence_ref,
          fixtureContentRef,
          logRef,
          logContentRef,
          receiptRef,
        ].map((ref) => ref.artifact_id)
      );
    }
  }
  requireDistinct(identities, "case identity");
  requireDistinct(fixtures, "fixture content");
  requireDistinct(logs, "execution log");
  requireDistinct(observations, "execution result");
  requireDistinct(refs, "cell artifact refs");
}

/** Host-only finalization. Verify the sealed closure before either review path; reviewer identifiers are checked for separation, while real-world independence remains the host's responsibility. */
export async function finalizeP01QualificationV2(
  input: P01QualificationFinalizeInput
): Promise<ArtifactRef> {
  if ((input.review === undefined) === (input.review_callback === undefined))
    throw new Error("supply exactly one independent review or review callback");
  const draft = validateContract(
    P01QualificationDraftV1Schema,
    input.draft,
    "P01 qualification draft"
  );
  verifyDraft(input.store, draft);
  const run = draft.run_id;
  const profileRef = draft.qualification_profile_ref;
  const implementationRef = draft.implementation_ref;
  const snapshotRef = draft.source_snapshot_ref;
  const criteria = draft.criteria;
  const evidenceRefs = criteria.flatMap((criterion) =>
    criterion.variants.map((v) => v.evidence_ref)
  );
  const review = validateContract(
    ReviewSchema,
    input.review === undefined
      ? await input.review_callback?.({
          evidence_refs: sorted(evidenceRefs),
          implementation_ref: implementationRef,
          qualification_profile_ref: profileRef,
        })
      : input.review,
    "P01 independent review"
  );
  for (const id of [
    review.authority_id,
    review.receipt_id,
    review.reviewer_identity_id,
    review.reviewer_lineage_id,
  ])
    assertOpaqueId(id, "review ID");
  assertRfc3339Utc(review.reviewed_at, "reviewed_at");
  if (
    Date.parse(review.reviewed_at) < Date.parse(draft.recorded_at) ||
    new Set(
      [
        review.reviewer_identity_id,
        review.reviewer_lineage_id,
        draft.implementer_identity_id,
        draft.implementer_lineage_id,
      ].map((id) => id.toLowerCase())
    ).size !== 4
  )
    throw new Error("reviewer lineage, identity or time is invalid");
  const authority = validateScaReviewerAuthorityV1({
    schema_id: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    authority_id: review.authority_id,
    reviewer_identity_id: review.reviewer_identity_id,
    reviewer_lineage_id: review.reviewer_lineage_id,
    phase_id: "SCA-P01",
    implementation_revision: draft.implementation_revision,
    decision: review.authority_decision,
  });
  const authorityRef = putJson(
    input.store,
    run,
    "sca-reviewer-authority",
    SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
    1,
    PRODUCERS.reviewer_authority,
    "reviewer-authority",
    authority
  );
  const reviewReceipt = validateScaReviewReceiptV1({
    schema_id: SCA_REVIEW_RECEIPT_V1_SCHEMA,
    schema_version: 1,
    receipt_id: review.receipt_id,
    reviewer_authority_ref: authorityRef,
    reviewer_identity_id: review.reviewer_identity_id,
    reviewer_lineage_id: review.reviewer_lineage_id,
    qualification_profile_ref: profileRef,
    implementation_revision: draft.implementation_revision,
    evidence_refs: sorted(evidenceRefs),
    decision: review.decision,
    reviewed_at: review.reviewed_at,
  });
  const reviewReceiptRef = putJson(
    input.store,
    run,
    "sca-review-receipt",
    SCA_REVIEW_RECEIPT_V1_SCHEMA,
    1,
    PRODUCERS.review_receipt,
    "review-receipt",
    reviewReceipt,
    [authorityRef, profileRef, ...evidenceRefs]
  );
  if (review.authority_decision !== "authorized" || review.decision !== "PASS")
    throw new Error("independent review did not authorize PASS; receipt retained without closure");
  // A review callback can be asynchronous: fail closed if any input changed during review.
  verifyDraft(input.store, draft);
  const record = validateScaPhaseQualificationRecordV2({
    schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schema_version: 2,
    record_kind: "implementation_qualification",
    tenant_id: draft.tenant_id,
    project_id: draft.project_id,
    run_id: run,
    phase_id: "SCA-P01",
    implementation_revision: draft.implementation_revision,
    qualification_profile_ref: profileRef,
    source_snapshot_ref: snapshotRef,
    implementation_ref: implementationRef,
    implementer_identity_id: draft.implementer_identity_id,
    implementer_lineage_id: draft.implementer_lineage_id,
    reviewer_authority_ref: authorityRef,
    reviewer_receipt_ref: reviewReceiptRef,
    criteria,
    remaining_gaps: [],
    status: "PASS",
    recorded_at: review.reviewed_at,
  });
  const recordRef = putJson(
    input.store,
    run,
    "sca-phase-qualification",
    SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    2,
    PRODUCERS.qualification,
    "p01-qualification",
    record,
    scaPhaseQualificationRefs(record)
  );
  if (
    !equal(
      validateScaPhaseQualificationRecordV2(
        json(
          input.store,
          recordRef,
          "sca-phase-qualification",
          SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
          2,
          PRODUCERS.qualification
        )
      ),
      record
    )
  )
    throw new Error("qualification record failed exact readback");
  return recordRef;
}

/** Legacy single-call convenience, deliberately not activated at the package root. */
export async function issueP01QualificationV2(
  input: P01QualificationIssuerInput
): Promise<ArtifactRef> {
  const draft = await collectP01QualificationEvidenceV2(input);
  return finalizeP01QualificationV2({ store: input.store, draft, review_callback: input.review });
}
