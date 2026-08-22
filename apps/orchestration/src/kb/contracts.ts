/**
 * KB contracts — the sole normative TypeBox schemas for the private knowledge base.
 *
 * Implements the exact Section 5 contracts in `research/agents-md-research/IMPLEMENTATION_PLAN.md`.
 * Every schema is closed (additionalProperties: false), exact-key, and versioned.
 * TypeScript types derive through `Static<typeof Schema>`.
 *
 * These contracts are the data model the entire KB system builds on. No other
 * module may redefine these shapes — it imports them here.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { Type, type Static, type TString, type TSchema } from "typebox";
import { Value } from "typebox/value";

// ── Shared scalars ──────────────────────────────────────────────────────────

/** Exactly 64 lowercase hexadecimal characters. */
export const Sha256HexSchema = Type.String({
  pattern: /^[0-9a-f]{64}$/.source,
  minLength: 64,
  maxLength: 64,
});
export type Sha256Hex = Static<typeof Sha256HexSchema>;

/** 1–128 ASCII/UTF-8 bytes, path-free and with no traversal token. */
export const OpaqueIdSchema = Type.String({
  pattern: /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.source,
  minLength: 1,
  maxLength: 128,
});
export type OpaqueId = Static<typeof OpaqueIdSchema>;

/** Record keys additionally exclude JavaScript prototype-pollution names. */
export const SafeRecordKeySchema = Type.String({
  pattern: /^(?!(?:__proto__|prototype|constructor)$)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
    .source,
  minLength: 1,
  maxLength: 128,
});
export type SafeRecordKey = Static<typeof SafeRecordKeySchema>;

export interface HumanTextOptions {
  readonly minUtf8Bytes?: number;
  readonly maxUtf8Bytes?: number;
  /** Multiline text permits LF; CR, TAB, NUL, DEL, and other controls remain forbidden. */
  readonly multiline?: boolean;
}

/**
 * Human-readable text is NFC and bounded by UTF-8 bytes, not JavaScript code
 * units. JSON Schema's character bounds remain as an early conservative gate;
 * `validateKbContract` enforces the byte/NFC/control contract exactly.
 */
export function humanTextSchema(options: HumanTextOptions = {}): TString {
  const minUtf8Bytes = options.minUtf8Bytes ?? 0;
  const maxUtf8Bytes = options.maxUtf8Bytes;
  return Type.String({
    ...(minUtf8Bytes > 0 ? { minLength: 1 } : {}),
    ...(maxUtf8Bytes === undefined ? {} : { maxLength: maxUtf8Bytes }),
    pattern: options.multiline
      ? // eslint-disable-next-line no-control-regex
        /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/.source
      : // eslint-disable-next-line no-control-regex
        /^[^\u0000-\u001f\u007f]*$/.source,
    "x-kb-human-text": true,
    "x-kb-min-utf8-bytes": minUtf8Bytes,
    ...(maxUtf8Bytes === undefined ? {} : { "x-kb-max-utf8-bytes": maxUtf8Bytes }),
    "x-kb-multiline": options.multiline === true,
  } as Parameters<typeof Type.String>[0]);
}

/** RFC 3339 UTC with `Z` (fractional seconds ≤ 9 digits), with real calendar validation. */
export const Rfc3339UtcSchema = Type.String({
  pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/.source,
  minLength: 20,
  maxLength: 30,
  "x-kb-rfc3339-z": true,
} as Parameters<typeof Type.String>[0]);
export type Rfc3339Utc = Static<typeof Rfc3339UtcSchema>;

/** Host-minted opaque ULID or UUID; never a digest or caller value. */
export const SourceIdSchema = OpaqueIdSchema;
export type SourceId = Static<typeof SourceIdSchema>;

export const ArtifactKindSchema = Type.Union([
  Type.Literal("claims"),
  Type.Literal("page_draft"),
  Type.Literal("query_answer"),
  Type.Literal("lint_report"),
  Type.Literal("verification_report"),
  Type.Literal("promotion_plan"),
  Type.Literal("promotion_patch"),
]);
export type ArtifactKind = Static<typeof ArtifactKindSchema>;

export const ArtifactMediaTypeSchema = Type.Literal("application/json");
export type ArtifactMediaType = Static<typeof ArtifactMediaTypeSchema>;

export const ConfidenceSchema = Type.Union([
  Type.Literal("CERTAIN"),
  Type.Literal("PROBABLE"),
  Type.Literal("POSSIBLE"),
  Type.Literal("UNCERTAIN"),
]);
export type Confidence = Static<typeof ConfidenceSchema>;

export const ClaimKindSchema = Type.Union([
  Type.Literal("fact"),
  Type.Literal("inference"),
  Type.Literal("speculation"),
  Type.Literal("unknown"),
]);
export type ClaimKind = Static<typeof ClaimKindSchema>;

export const ClaimStateSchema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("contested"),
  Type.Literal("superseded"),
  Type.Literal("unverified_current"),
]);
export type ClaimState = Static<typeof ClaimStateSchema>;

export const PageKindSchema = Type.Union([
  Type.Literal("concept"),
  Type.Literal("decision"),
  Type.Literal("synthesis"),
  Type.Literal("question"),
  Type.Literal("promotion_candidate"),
]);
export type PageKind = Static<typeof PageKindSchema>;

export const PageLifecycleSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("validated"),
  Type.Literal("superseded"),
  Type.Literal("archived"),
]);
export type PageLifecycle = Static<typeof PageLifecycleSchema>;

export const SourceTypeSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("url_snapshot"),
  Type.Literal("research_artifact"),
  Type.Literal("manual"),
]);
export type SourceType = Static<typeof SourceTypeSchema>;

export const ProcessingModeSchema = Type.Union([
  Type.Literal("local_only"),
  Type.Literal("provider_permitted"),
]);
export type ProcessingMode = Static<typeof ProcessingModeSchema>;

// ── §5.2 host capabilities and immutable source admission ──────────────────

export const HostCapabilityKindV1Schema = Type.Union([
  Type.Literal("source_read"),
  Type.Literal("canonical_target"),
]);
export type HostCapabilityKindV1 = Static<typeof HostCapabilityKindV1Schema>;

export const HostCapabilityOperationV1Schema = Type.Union([
  Type.Literal("ingest"),
  Type.Literal("promote"),
]);
export type HostCapabilityOperationV1 = Static<typeof HostCapabilityOperationV1Schema>;

export const SourceCapabilityMetadataV1Schema = Type.Object(
  {
    source_type: SourceTypeSchema,
    captured_at: Rfc3339UtcSchema,
    published_at: Type.Optional(Rfc3339UtcSchema),
    title: humanTextSchema({ maxUtf8Bytes: 1_024 }),
    // Revision 7 does not require a non-empty author list. Empty is an exact,
    // honest host-reviewed value and is copied byte-for-byte into SourceRecordV1.
    authors: Type.Array(humanTextSchema({ maxUtf8Bytes: 256 })),
    redacted_locator: Type.Optional(humanTextSchema({ maxUtf8Bytes: 1_024 })),
  },
  { additionalProperties: false }
);
export type SourceCapabilityMetadataV1 = Static<typeof SourceCapabilityMetadataV1Schema>;

export const HostCapabilityEnvelopeV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    capability_id: OpaqueIdSchema,
    kind: HostCapabilityKindV1Schema,
    session_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    resolved_path: Type.String({ minLength: 1, maxLength: 4_096 }),
    authority_root: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    expected_sha256: Sha256HexSchema,
    media_type: Type.Optional(
      Type.Union([
        Type.Literal("text/plain"),
        Type.Literal("text/markdown"),
        Type.Literal("application/json"),
      ])
    ),
    source_metadata: Type.Optional(SourceCapabilityMetadataV1Schema),
    allowed_operation: HostCapabilityOperationV1Schema,
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type HostCapabilityEnvelopeV1 = Static<typeof HostCapabilityEnvelopeV1Schema>;

export const HostCapabilityStateV1Schema = Type.Union([
  Type.Literal("available"),
  Type.Literal("claimed"),
  Type.Literal("commit_reserved"),
  Type.Literal("apply_reserved"),
  Type.Literal("consumed"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type HostCapabilityStateV1 = Static<typeof HostCapabilityStateV1Schema>;

export const HostCapabilityLeaseV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    capability_id: OpaqueIdSchema,
    envelope_sha256: Sha256HexSchema,
    state: HostCapabilityStateV1Schema,
    run_id: Type.Optional(OpaqueIdSchema),
    transaction_id: Type.Optional(OpaqueIdSchema),
    claimed_at: Type.Optional(Rfc3339UtcSchema),
    reserved_at: Type.Optional(Rfc3339UtcSchema),
    terminal_at: Type.Optional(Rfc3339UtcSchema),
  },
  { additionalProperties: false }
);
export type HostCapabilityLeaseV1 = Static<typeof HostCapabilityLeaseV1Schema>;

export const SourceAdmissionStateV1Schema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("admitted"),
  Type.Literal("published"),
  Type.Literal("discarding"),
  Type.Literal("discarded"),
]);
export type SourceAdmissionStateV1 = Static<typeof SourceAdmissionStateV1Schema>;

export const SourceAdmissionRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_id: SourceIdSchema,
    capability_id: OpaqueIdSchema,
    envelope_sha256: Sha256HexSchema,
    run_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    sha256: Sha256HexSchema,
    media_type: Type.Union([
      Type.Literal("text/plain"),
      Type.Literal("text/markdown"),
      Type.Literal("application/json"),
    ]),
    byte_length: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    storage_key: Type.String({ minLength: 1, maxLength: 512 }),
    temporary_storage_key: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    state: SourceAdmissionStateV1Schema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type SourceAdmissionRecordV1 = Static<typeof SourceAdmissionRecordV1Schema>;

// Backward-compatible implementation names remain aliases of the one normative
// Revision 7 TypeBox definitions; no handwritten TypeScript shape exists.
export const CapabilityEnvelopeSchema = HostCapabilityEnvelopeV1Schema;
export type CapabilityEnvelope = HostCapabilityEnvelopeV1;
export const CapabilityLeaseSchema = HostCapabilityLeaseV1Schema;
export type CapabilityLease = HostCapabilityLeaseV1;
export const SourceAdmissionRecordSchema = SourceAdmissionRecordV1Schema;
export type SourceAdmissionRecord = SourceAdmissionRecordV1;

// ── §5.1 Host profile registry ─────────────────────────────────────────────

export const KbProfileSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_profile_id: OpaqueIdSchema,
    kb_root: Type.String({ minLength: 1 }),
    expected_kb_id: Type.Optional(OpaqueIdSchema),
    allow_create: Type.Boolean(),
    repository_admission: Type.Union([
      Type.Object({ mode: Type.Literal("outside_worktree") }, { additionalProperties: false }),
      Type.Object(
        {
          mode: Type.Literal("inside_allowlisted_scaffold"),
          worktree_root: Type.String({ minLength: 1 }),
          scaffold_root: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);
export type KbProfile = Static<typeof KbProfileSchema>;

export const KbProfileRegistrySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    profiles: Type.Array(KbProfileSchema, { uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type KbProfileRegistry = Static<typeof KbProfileRegistrySchema>;

// ── §5.3 Policy ─────────────────────────────────────────────────────────────

const ModelRuleSchema = Type.Object(
  {
    provider: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    model: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    locality: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
  },
  { additionalProperties: false }
);

export const KbPolicySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_id: OpaqueIdSchema,
    processing_mode: ProcessingModeSchema,
    allowed_parent_models: Type.Array(ModelRuleSchema),
    allowed_child_models: Type.Array(ModelRuleSchema),
    parent_result: Type.Object(
      {
        derived_query_answer: Type.Union([
          Type.Literal("deny"),
          Type.Literal("allow_explicit_derived_answer"),
        ]),
        max_utf8_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
      },
      { additionalProperties: false }
    ),
    artifact_limits: Type.Object(
      {
        max_artifact_utf8_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
        max_artifacts_per_phase: Type.Integer({ minimum: 1, maximum: 8 }),
        allowed_media_types: Type.Array(ArtifactMediaTypeSchema, {
          minItems: 1,
          maxItems: 1,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    reader_limits: Type.Object(
      {
        max_call_utf8_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
        max_phase_utf8_bytes: Type.Integer({ minimum: 1, maximum: 8_388_608 }),
        max_calls_per_phase: Type.Integer({ minimum: 1, maximum: 64 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type KbPolicy = Static<typeof KbPolicySchema>;

/** The generated default-deny policy for a new KB. */
export function defaultDenyPolicy(kbId: string): KbPolicy {
  return {
    schema_version: 1,
    kb_id: kbId,
    processing_mode: "local_only",
    allowed_parent_models: [],
    allowed_child_models: [],
    parent_result: { derived_query_answer: "deny", max_utf8_bytes: 16_384 },
    artifact_limits: {
      max_artifact_utf8_bytes: 262_144,
      max_artifacts_per_phase: 4,
      allowed_media_types: ["application/json"],
    },
    reader_limits: {
      max_call_utf8_bytes: 262_144,
      max_phase_utf8_bytes: 1_048_576,
      max_calls_per_phase: 16,
    },
  };
}

// ── §5.4 Manifest ───────────────────────────────────────────────────────────

export const KbManifestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_id: OpaqueIdSchema,
    title: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    authority: Type.Literal("advisory"),
    paths: Type.Object(
      {
        policy: Type.Literal(".kb/policy.json"),
        source_records: Type.Literal("sources/records"),
        source_objects: Type.Literal("sources/objects"),
        pages: Type.Literal("pages"),
        conflicts: Type.Literal("conflicts"),
        work: Type.Literal("work"),
        lock: Type.Literal(".kb/lock"),
        generations: Type.Literal(".kb/generations"),
        generation_catalog_filename: Type.Literal("catalog.json"),
        generation_index_filename: Type.Literal("index.sqlite"),
        current: Type.Literal(".kb/current.json"),
        root_index: Type.Literal("index.md"),
      },
      { additionalProperties: false }
    ),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type KbManifest = Static<typeof KbManifestSchema>;

// ── §5.5 Records ────────────────────────────────────────────────────────────

const EvidenceEntrySchema = Type.Object(
  {
    source_id: SourceIdSchema,
    locator: Type.Optional(humanTextSchema({ maxUtf8Bytes: 1_024 })),
    excerpt_sha256: Type.Optional(Sha256HexSchema),
  },
  { additionalProperties: false }
);

export const ClaimSchema = Type.Object(
  {
    claim_id: OpaqueIdSchema,
    text: humanTextSchema({ maxUtf8Bytes: 8_192, multiline: true }),
    kind: ClaimKindSchema,
    state: ClaimStateSchema,
    confidence: ConfidenceSchema,
    evidence: Type.Array(EvidenceEntrySchema, { uniqueItems: true }),
    contradicts_claim_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    canonical_verification_refs: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
  },
  { additionalProperties: false }
);

export const ClaimsSidecarSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    page_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    claims: Type.Array(ClaimSchema),
  },
  { additionalProperties: false }
);
export type ClaimsSidecar = Static<typeof ClaimsSidecarSchema>;

export const PageRevisionFrontmatterSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    page_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    previous_revision_id: Type.Optional(OpaqueIdSchema),
    kind: PageKindSchema,
    title: humanTextSchema({ maxUtf8Bytes: 256 }),
    summary: humanTextSchema({ maxUtf8Bytes: 1_024, multiline: true }),
    authority: Type.Literal("advisory"),
    lifecycle: PageLifecycleSchema,
    created_at: Rfc3339UtcSchema,
    derived_from: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    related_page_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type PageRevisionFrontmatter = Static<typeof PageRevisionFrontmatterSchema>;

export const SourceRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_id: SourceIdSchema,
    source_type: SourceTypeSchema,
    captured_at: Rfc3339UtcSchema,
    published_at: Type.Optional(Rfc3339UtcSchema),
    title: humanTextSchema({ maxUtf8Bytes: 1_024 }),
    authors: Type.Array(humanTextSchema({ maxUtf8Bytes: 256 })),
    media_type: Type.Union([
      Type.Literal("text/plain"),
      Type.Literal("text/markdown"),
      Type.Literal("application/json"),
    ]),
    sha256: Sha256HexSchema,
    object_ref: Type.String({
      pattern: /^sources\/objects\/[0-9a-f]{64}$/.source,
    }),
    provenance: Type.Object(
      {
        source_capability_digest: Sha256HexSchema,
        supplied_by: Type.Literal("host_capability"),
        originating_run_id: OpaqueIdSchema,
        redacted_locator: Type.Optional(humanTextSchema({ maxUtf8Bytes: 1_024 })),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type SourceRecord = Static<typeof SourceRecordSchema>;

export const ConflictRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    conflict_record_id: OpaqueIdSchema,
    claim_refs: Type.Array(
      Type.Object(
        {
          page_id: OpaqueIdSchema,
          revision_id: OpaqueIdSchema,
          claim_id: OpaqueIdSchema,
        },
        { additionalProperties: false }
      ),
      { uniqueItems: true }
    ),
    state: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("superseded")]),
    summary: humanTextSchema({ maxUtf8Bytes: 4_096, multiline: true }),
    evidence_refs: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    supersedes_conflict_record_id: Type.Optional(OpaqueIdSchema),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ConflictRecord = Static<typeof ConflictRecordSchema>;

// ── §5.5 Generations ────────────────────────────────────────────────────────

export const GenerationCatalogSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    generation_id: OpaqueIdSchema,
    parent_generation_id: Type.Optional(OpaqueIdSchema),
    kb_id: OpaqueIdSchema,
    manifest_sha256: Sha256HexSchema,
    policy_sha256: Sha256HexSchema,
    pages: Type.Record(
      SafeRecordKeySchema,
      Type.Object(
        {
          revision_id: OpaqueIdSchema,
          page_sha256: Sha256HexSchema,
          claims_sha256: Sha256HexSchema,
        },
        { additionalProperties: false }
      )
    ),
    source_records: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    source_objects: Type.Array(Sha256HexSchema, { uniqueItems: true }),
    conflict_records: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    index_sha256: Sha256HexSchema,
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type GenerationCatalog = Static<typeof GenerationCatalogSchema>;

export const CurrentGenerationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_id: OpaqueIdSchema,
    generation_id: OpaqueIdSchema,
    catalog_sha256: Sha256HexSchema,
    index_sha256: Sha256HexSchema,
    published_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type CurrentGeneration = Static<typeof CurrentGenerationSchema>;

// ── §5.10 transaction-owned generation publication ─────────────────────────

export const InitReservationStateSchema = Type.Union([
  Type.Literal("reserved"),
  Type.Literal("selector_committed"),
  Type.Literal("finalized"),
  Type.Literal("released"),
]);
export type InitReservationState = Static<typeof InitReservationStateSchema>;

/**
 * Profile-keyed authority for the sole base-none publication. The normalized
 * registry/profile/root stays outside the control DB; its canonical commitment
 * binds that host-only value without caching an absolute root here.
 */
export const InitReservationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_profile_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    request_sha256: Sha256HexSchema,
    profile_commitment_sha256: Sha256HexSchema,
    kb_id: OpaqueIdSchema,
    generation_id: OpaqueIdSchema,
    state: InitReservationStateSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type InitReservation = Static<typeof InitReservationSchema>;

export const PublicationFileRoleSchema = Type.Union([
  Type.Literal("manifest"),
  Type.Literal("policy"),
  Type.Literal("source_object"),
  Type.Literal("source_record"),
  Type.Literal("page_markdown"),
  Type.Literal("claims"),
  Type.Literal("conflict"),
  Type.Literal("catalog"),
  Type.Literal("index"),
  Type.Literal("selector"),
]);
export type PublicationFileRole = Static<typeof PublicationFileRoleSchema>;

export const PublicationFileRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    publication_file_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    role: PublicationFileRoleSchema,
    staging_key: Type.String({ minLength: 1, maxLength: 1_024 }),
    final_key: Type.String({ minLength: 1, maxLength: 1_024 }),
    sha256: Type.Optional(Sha256HexSchema),
    byte_length: Type.Optional(Type.Integer({ minimum: 0 })),
    state: Type.Union([Type.Literal("planned"), Type.Literal("staged"), Type.Literal("published")]),
  },
  { additionalProperties: false }
);
export type PublicationFileRecord = Static<typeof PublicationFileRecordSchema>;

export const PublicationLifecycleSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("staged"),
  Type.Literal("immutables_published"),
  Type.Literal("generation_published"),
  Type.Literal("selector_committed"),
  Type.Literal("finalizing"),
  Type.Literal("complete"),
  Type.Literal("discarding"),
  Type.Literal("discarded"),
]);
export type PublicationLifecycle = Static<typeof PublicationLifecycleSchema>;

export const KbPublicationTransactionSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    action: Type.Union([Type.Literal("init"), Type.Literal("ingest"), Type.Literal("save")]),
    base_generation_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    base_selector_sha256: Type.Union([Sha256HexSchema, Type.Null()]),
    candidate_generation_id: OpaqueIdSchema,
    staging_root: Type.String({ minLength: 1, maxLength: 1_024 }),
    generation_staging_key: Type.String({ minLength: 1, maxLength: 1_024 }),
    generation_final_key: Type.String({ minLength: 1, maxLength: 1_024 }),
    selector_jcs: Type.Optional(Type.String({ minLength: 2 })),
    selector_sha256: Type.Optional(Sha256HexSchema),
    lifecycle: PublicationLifecycleSchema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
    files: Type.Array(PublicationFileRecordSchema, { minItems: 3, uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type KbPublicationTransaction = Static<typeof KbPublicationTransactionSchema>;

// ── §5.6 Request/result (action types) ──────────────────────────────────────

export const KbActionSchema = Type.Union([
  Type.Literal("init"),
  Type.Literal("ingest"),
  Type.Literal("query"),
  Type.Literal("save"),
  Type.Literal("lint"),
  Type.Literal("promote"),
  Type.Literal("status"),
  Type.Literal("resume"),
]);
export type KbAction = Static<typeof KbActionSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("awaiting_user"),
  Type.Literal("complete"),
  Type.Literal("refused"),
  Type.Literal("error"),
  Type.Literal("exhausted"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

// ── Validation helper ───────────────────────────────────────────────────────

export class KbContractError extends Error {
  constructor(
    message: string,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = "KbContractError";
  }
}

const UNSAFE_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Real RFC 3339-Z calendar/time validation; the schema separately closes syntax. */
export function isRfc3339Utc(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (match === null) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  if (second === 60 && (hour !== 23 || minute !== 59)) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function pointer(path: string, key: string | number): string {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
}

function scalarIssues(schema: TSchema, value: unknown, path = "/"): string[] {
  const node = schema as TSchema & Record<string, unknown>;
  const issues: string[] = [];
  if (node["x-kb-human-text"] === true && typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    const min = Number(node["x-kb-min-utf8-bytes"] ?? 0);
    const max = node["x-kb-max-utf8-bytes"];
    if (value !== value.normalize("NFC")) issues.push(`${path}: must be NFC-normalized UTF-8`);
    if (bytes < min) issues.push(`${path}: must contain at least ${min} UTF-8 byte(s)`);
    if (typeof max === "number" && bytes > max) {
      issues.push(`${path}: must contain at most ${max} UTF-8 byte(s)`);
    }
  }
  if (node["x-kb-rfc3339-z"] === true && typeof value === "string" && !isRfc3339Utc(value)) {
    issues.push(`${path}: must be a real RFC 3339 UTC timestamp ending in Z`);
  }

  if (Array.isArray(node.anyOf)) {
    const branch = (node.anyOf as TSchema[]).find((candidate) => Value.Check(candidate, value));
    if (branch !== undefined) issues.push(...scalarIssues(branch, value, path));
    return issues;
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf as TSchema[]) issues.push(...scalarIssues(branch, value, path));
  }
  if (Array.isArray(value) && node.items !== undefined) {
    for (let index = 0; index < value.length; index++) {
      issues.push(...scalarIssues(node.items as TSchema, value[index], pointer(path, index)));
    }
    return issues;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (node.properties ?? {}) as Record<string, TSchema>;
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(record, key))
        issues.push(...scalarIssues(child, record[key], pointer(path, key)));
    }
    const patterns = (node.patternProperties ?? {}) as Record<string, TSchema>;
    for (const [key, childValue] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) continue;
      for (const [pattern, child] of Object.entries(patterns)) {
        if (new RegExp(pattern).test(key)) {
          issues.push(...scalarIssues(child, childValue, pointer(path, key)));
          break;
        }
      }
    }
  }
  return issues;
}

function unsafeRecordKeyIssues(value: unknown, path = "/"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unsafeRecordKeyIssues(item, pointer(path, index)));
  }
  if (value === null || typeof value !== "object") return [];
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (UNSAFE_RECORD_KEYS.has(key) || !/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      issues.push(`${pointer(path, key)}: unsafe record key`);
    }
    issues.push(
      ...unsafeRecordKeyIssues((value as Record<string, unknown>)[key], pointer(path, key))
    );
  }
  return issues;
}

function prototypeRecordKeyIssues(value: unknown, path = "/"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => prototypeRecordKeyIssues(item, pointer(path, index)));
  }
  if (value === null || typeof value !== "object") return [];
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (UNSAFE_RECORD_KEYS.has(key)) issues.push(`${pointer(path, key)}: unsafe record key`);
    issues.push(
      ...prototypeRecordKeyIssues((value as Record<string, unknown>)[key], pointer(path, key))
    );
  }
  return issues;
}

function duplicateIdentityIssues<T>(
  values: readonly T[],
  identity: (value: T) => string,
  path: string
): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) return [`${path}: duplicate identity '${key}'`];
    seen.add(key);
  }
  return [];
}

function requestIssues(request: KnowledgeBaseRequest): string[] {
  if (request.action === "init") {
    if (request.create !== ("title" in request && request.title !== undefined)) {
      return ["/title: required exactly when create is true"];
    }
  }
  if (request.action === "promote") {
    return duplicateIdentityIssues(
      request.page_revisions,
      (item) => `${item.page_id}\u0000${item.revision_id}`,
      "/page_revisions"
    );
  }
  return [];
}

function chronologyIssues(
  earlier: string,
  later: string,
  laterPath: string,
  relation = "must be after"
): string[] {
  return Date.parse(later) > Date.parse(earlier)
    ? []
    : [`${laterPath}: ${relation} the earlier time`];
}

function capabilityEnvelopeIssues(envelope: HostCapabilityEnvelopeV1): string[] {
  const issues = chronologyIssues(envelope.issued_at, envelope.expires_at, "/expires_at");
  if (
    !path.isAbsolute(envelope.resolved_path) ||
    path.resolve(envelope.resolved_path) !== envelope.resolved_path
  ) {
    issues.push("/resolved_path: must be an absolute normalized host path");
  }
  if (envelope.kind === "source_read") {
    if (envelope.allowed_operation !== "ingest") {
      issues.push('/allowed_operation: source_read requires "ingest"');
    }
    if (envelope.authority_root !== undefined) {
      issues.push("/authority_root: source_read forbids authority_root");
    }
    if (envelope.media_type === undefined) {
      issues.push("/media_type: source_read requires an admitted UTF-8 media type");
    }
    if (envelope.source_metadata === undefined) {
      issues.push("/source_metadata: source_read requires complete host-reviewed metadata");
    }
  } else {
    if (envelope.allowed_operation !== "promote") {
      issues.push('/allowed_operation: canonical_target requires "promote"');
    }
    if (envelope.source_metadata !== undefined) {
      issues.push("/source_metadata: canonical_target forbids source_metadata");
    }
    if (envelope.authority_root === undefined) {
      issues.push("/authority_root: canonical_target requires authority_root");
    } else {
      if (
        !path.isAbsolute(envelope.authority_root) ||
        path.resolve(envelope.authority_root) !== envelope.authority_root
      ) {
        issues.push("/authority_root: must be an absolute normalized host path");
      } else {
        const relative = path.relative(envelope.authority_root, envelope.resolved_path);
        if (
          relative.length === 0 ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          issues.push("/resolved_path: canonical target must be contained beneath authority_root");
        }
      }
    }
  }
  return issues;
}

function capabilityLeaseIssues(lease: HostCapabilityLeaseV1): string[] {
  const issues: string[] = [];
  const hasRun = lease.run_id !== undefined;
  const hasTransaction = lease.transaction_id !== undefined;
  const hasClaimed = lease.claimed_at !== undefined;
  const ownershipCount = Number(hasRun) + Number(hasTransaction) + Number(hasClaimed);
  const requireOwnership = (): void => {
    if (ownershipCount !== 3) {
      issues.push("/: lifecycle requires run_id, transaction_id, and claimed_at together");
    }
  };
  const forbidOwnership = (): void => {
    if (ownershipCount !== 0) {
      issues.push("/: available lifecycle forbids run/transaction/claim ownership");
    }
  };

  if (lease.state === "available") {
    forbidOwnership();
    if (lease.reserved_at !== undefined || lease.terminal_at !== undefined) {
      issues.push("/: available lifecycle forbids reservation and terminal timestamps");
    }
  } else if (lease.state === "claimed") {
    requireOwnership();
    if (lease.reserved_at !== undefined || lease.terminal_at !== undefined) {
      issues.push("/: claimed lifecycle forbids reservation and terminal timestamps");
    }
  } else if (lease.state === "commit_reserved" || lease.state === "apply_reserved") {
    requireOwnership();
    if (lease.reserved_at === undefined || lease.terminal_at !== undefined) {
      issues.push("/: reserved lifecycle requires reserved_at and forbids terminal_at");
    }
  } else {
    if (lease.terminal_at === undefined) {
      issues.push("/terminal_at: terminal lifecycle requires terminal_at");
    }
    if (lease.state === "consumed") {
      requireOwnership();
    } else if (ownershipCount !== 0 && ownershipCount !== 3) {
      issues.push("/: terminal lifecycle ownership fields must be all present or all absent");
    }
    if (lease.reserved_at !== undefined && ownershipCount !== 3) {
      issues.push("/reserved_at: requires complete prior claim ownership");
    }
  }

  if (
    lease.claimed_at !== undefined &&
    lease.reserved_at !== undefined &&
    Date.parse(lease.reserved_at) < Date.parse(lease.claimed_at)
  ) {
    issues.push("/reserved_at: must not precede claimed_at");
  }
  if (
    lease.claimed_at !== undefined &&
    lease.terminal_at !== undefined &&
    Date.parse(lease.terminal_at) < Date.parse(lease.claimed_at)
  ) {
    issues.push("/terminal_at: must not precede claimed_at");
  }
  if (
    lease.reserved_at !== undefined &&
    lease.terminal_at !== undefined &&
    Date.parse(lease.terminal_at) < Date.parse(lease.reserved_at)
  ) {
    issues.push("/terminal_at: must not precede reserved_at");
  }
  return issues;
}

function sourceAdmissionIssues(record: SourceAdmissionRecordV1): string[] {
  const issues: string[] = [];
  const expectedStorageKey = `work/${record.run_id}/transaction/sources/${record.source_id}`;
  const expectedTemporaryKey = `work/${record.run_id}/transaction/sources/.${record.source_id}.${record.transaction_id}.tmp`;
  if (record.storage_key !== expectedStorageKey) {
    issues.push(`/storage_key: must equal ${expectedStorageKey}`);
  }
  if (
    record.temporary_storage_key !== undefined &&
    record.temporary_storage_key !== expectedTemporaryKey
  ) {
    issues.push(`/temporary_storage_key: must equal ${expectedTemporaryKey}`);
  }
  if (record.state === "preparing" && record.temporary_storage_key === undefined) {
    issues.push(
      "/temporary_storage_key: preparing lifecycle requires the preindexed temporary key"
    );
  }
  if (
    !["preparing", "discarding"].includes(record.state) &&
    record.temporary_storage_key !== undefined
  ) {
    issues.push("/temporary_storage_key: must be absent outside preparing/discarding");
  }
  if (record.state === "preparing" && record.byte_length !== 0) {
    issues.push("/byte_length: preparing lifecycle requires zero before bytes are admitted");
  }
  if (Date.parse(record.updated_at) < Date.parse(record.created_at)) {
    issues.push("/updated_at: must not precede created_at");
  }
  return issues;
}

function parentDeliveryGrantIssues(grant: ParentDeliveryGrantV1): string[] {
  return chronologyIssues(grant.issued_at, grant.expires_at, "/expires_at");
}

function parentDeliveryRecordIssues(record: ParentDeliveryGrantStoreRecordV1): string[] {
  return (record.state === "consumed") === (record.run_id !== undefined)
    ? []
    : ["/run_id: required exactly when the grant is consumed"];
}

function parentDeliveryFileIssues(file: ParentDeliveryGrantFileV1): string[] {
  const issues = [
    ...parentDeliveryGrantIssues(file.grant),
    ...parentDeliveryRecordIssues(file.record),
  ];
  if (file.record.grant_id !== file.grant.grant_id) {
    issues.push("/record/grant_id: must equal grant.grant_id");
  }
  const digest = sha256Hex(canonicalJson(file.grant));
  if (file.record.grant_sha256 !== digest) {
    issues.push("/record/grant_sha256: must equal SHA-256(JCS(grant))");
  }
  return issues;
}

function hostInvocationContextIssues(context: KbHostInvocationContextV1): string[] {
  const issues: string[] = [];
  const grant = context.parent_delivery_grant;
  if (grant === undefined) return issues;
  issues.push(...parentDeliveryGrantIssues(grant));
  if (grant.session_id !== context.session_id) {
    issues.push("/parent_delivery_grant/session_id: must bind the host session");
  }
  if (grant.invocation_id !== context.invocation_id) {
    issues.push("/parent_delivery_grant/invocation_id: must bind the host invocation");
  }
  if (
    grant.parent_provider !== context.parent_provider ||
    grant.parent_model !== context.parent_model
  ) {
    issues.push("/parent_delivery_grant: parent provider/model must bind the host context");
  }
  if (!context.allowed_kb_profile_ids.includes(grant.kb_profile_id)) {
    issues.push(
      "/parent_delivery_grant/kb_profile_id: must be one of the session-granted profiles"
    );
  }
  return issues;
}

function resultIssues(result: KnowledgeBaseResult | ReplayableKnowledgeBaseResult): string[] {
  const issues: string[] = [];
  if (result.status === "running" && (result.met || result.next !== "resume")) {
    issues.push("/: running requires met=false,next=resume");
  } else if (result.status === "awaiting_user" && (result.met || result.next !== "review")) {
    issues.push("/: awaiting_user requires met=false,next=review");
  } else if (
    (result.status === "refused" || result.status === "error" || result.status === "exhausted") &&
    (result.met || result.next !== "none")
  ) {
    issues.push("/: refused/error/exhausted require met=false,next=none");
  } else if (result.status === "complete" && result.next !== "none") {
    issues.push("/: complete requires next=none");
  }

  issues.push(
    ...duplicateIdentityIssues(result.artifacts, (item) => item.artifact_id, "/artifacts"),
    ...duplicateIdentityIssues(result.evidence, (item) => item.evidence_id, "/evidence")
  );
  for (const [key, count] of Object.entries(result.counts)) {
    if (!/^(?!(?:__proto__|prototype|constructor)$)[a-z][a-z0-9_]{0,63}$/.test(key)) {
      issues.push(`/counts/${key}: unsafe metric key`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      issues.push(`/counts/${key}: metric must be a non-negative safe integer`);
    }
  }

  if ("derived_answer" in result && result.derived_answer !== undefined) {
    if (result.action !== "query" || result.status !== "complete" || !result.met) {
      issues.push("/derived_answer: allowed only on a complete met query result");
    }
    if (result.derived_answer.citations.length === 0) {
      issues.push("/derived_answer/citations: a delivered met answer requires a citation");
    }
  }

  const kinds = result.artifacts.map((artifact) => artifact.artifact_kind);
  const exactKinds = (expected: readonly ArtifactKind[]): boolean =>
    kinds.length === expected.length && kinds.every((kind, index) => kind === expected[index]);
  if (result.status === "complete" && result.action === "query" && !exactKinds(["query_answer"])) {
    issues.push("/artifacts: a complete query requires exactly one query_answer handle");
  }
  if (result.status === "complete" && result.action === "lint" && !exactKinds(["lint_report"])) {
    issues.push("/artifacts: a complete lint requires exactly one lint_report handle");
  }
  if (
    result.status === "awaiting_user" &&
    (result.action === "ingest" || result.action === "save") &&
    !exactKinds(["page_draft", "lint_report", "verification_report"])
  ) {
    issues.push("/artifacts: ingest/save review requires the exact three ordered review handles");
  }
  if (
    result.status === "awaiting_user" &&
    result.action === "promote" &&
    !exactKinds(["promotion_plan", "promotion_patch", "verification_report"])
  ) {
    issues.push("/artifacts: promotion review requires exact plan/patch/verification handles");
  }
  return issues;
}

function crossFieldIssues(schema: TSchema, value: unknown): string[] {
  if (schema === SourceRecordSchema) {
    const record = value as SourceRecord;
    const expectedObjectRef = `sources/objects/${record.sha256}`;
    return record.object_ref === expectedObjectRef
      ? []
      : [`/object_ref: must equal ${expectedObjectRef}`];
  }
  if (schema === HostCapabilityEnvelopeV1Schema) {
    return capabilityEnvelopeIssues(value as HostCapabilityEnvelopeV1);
  }
  if (schema === HostCapabilityLeaseV1Schema) {
    return capabilityLeaseIssues(value as HostCapabilityLeaseV1);
  }
  if (schema === SourceAdmissionRecordV1Schema) {
    return sourceAdmissionIssues(value as SourceAdmissionRecordV1);
  }
  if (schema === ParentDeliveryGrantV1Schema) {
    return parentDeliveryGrantIssues(value as ParentDeliveryGrantV1);
  }
  if (schema === ParentDeliveryGrantStoreRecordV1Schema) {
    return parentDeliveryRecordIssues(value as ParentDeliveryGrantStoreRecordV1);
  }
  if (schema === ParentDeliveryGrantFileV1Schema) {
    return parentDeliveryFileIssues(value as ParentDeliveryGrantFileV1);
  }
  if (schema === KbHostInvocationContextV1Schema) {
    return hostInvocationContextIssues(value as KbHostInvocationContextV1);
  }
  if (schema === KbProfileRegistrySchema) {
    return duplicateIdentityIssues(
      (value as KbProfileRegistry).profiles,
      (profile) => profile.kb_profile_id,
      "/profiles"
    );
  }
  if (schema === KbPolicySchema) {
    const policy = value as KbPolicy;
    const issues = [
      ...duplicateIdentityIssues(
        policy.allowed_parent_models,
        (rule) => `${rule.provider.normalize("NFC")}\u0000${rule.model.normalize("NFC")}`,
        "/allowed_parent_models"
      ),
      ...duplicateIdentityIssues(
        policy.allowed_child_models,
        (rule) => `${rule.provider.normalize("NFC")}\u0000${rule.model.normalize("NFC")}`,
        "/allowed_child_models"
      ),
    ];
    if (policy.reader_limits.max_phase_utf8_bytes < policy.reader_limits.max_call_utf8_bytes) {
      issues.push("/reader_limits/max_phase_utf8_bytes: must be at least max_call_utf8_bytes");
    }
    return issues;
  }
  if (
    schema === KnowledgeBaseRequestSchema ||
    schema === InitKbRequestSchema ||
    schema === IngestKbRequestSchema ||
    schema === QueryKbRequestSchema ||
    schema === SaveKbRequestSchema ||
    schema === LintKbRequestSchema ||
    schema === PromoteKbRequestSchema ||
    schema === StatusKbRequestSchema ||
    schema === ResumeKbRequestSchema
  ) {
    return requestIssues(value as KnowledgeBaseRequest);
  }
  if (schema === KnowledgeBaseResultSchema || schema === ReplayableKnowledgeBaseResultSchema) {
    return resultIssues(value as KnowledgeBaseResult | ReplayableKnowledgeBaseResult);
  }
  if (schema === KbPublicationTransactionSchema) {
    const publication = value as KbPublicationTransaction;
    const issues = [
      ...duplicateIdentityIssues(publication.files, (item) => item.publication_file_id, "/files"),
      ...duplicateIdentityIssues(publication.files, (item) => item.staging_key, "/files"),
      ...duplicateIdentityIssues(publication.files, (item) => item.final_key, "/files"),
    ];
    if (publication.files.some((item) => item.transaction_id !== publication.transaction_id)) {
      issues.push("/files: every publication file must bind the parent transaction_id");
    }
    return issues;
  }
  if (schema === KbComposeAuthoritySchema) {
    const authority = value as KbComposeAuthority;
    const allocations = authority.allocations;
    return [
      ...duplicateIdentityIssues(
        authority.selected_pages,
        (item) => item.page_id,
        "/selected_pages"
      ),
      ...duplicateIdentityIssues(allocations, (item) => item.page_id, "/allocations"),
      ...duplicateIdentityIssues(allocations, (item) => item.revision_id, "/allocations"),
      ...duplicateIdentityIssues(
        allocations.flatMap((item) => item.claim_allocations),
        (item) => item.candidate_ref,
        "/allocations/claim_allocations"
      ),
      ...duplicateIdentityIssues(
        allocations.flatMap((item) => item.claim_allocations),
        (item) => item.claim_id,
        "/allocations/claim_allocations"
      ),
    ];
  }
  if (schema === ContentReviewGatePacketSchema) {
    const packet = value as ContentReviewGatePacket;
    const artifactMap = packet.candidate_artifact_digests;
    const issues = duplicateIdentityIssues(
      packet.candidate_artifacts,
      (item) => item.artifact_id,
      "/candidate_artifacts"
    );
    const ids = packet.candidate_artifacts.map((item) => item.artifact_id).sort();
    const mapIds = Object.keys(artifactMap).sort();
    if (canonicalJson(ids) !== canonicalJson(mapIds)) {
      issues.push("/candidate_artifact_digests: must contain all and only candidate artifact IDs");
    } else if (
      packet.candidate_artifacts.some((item) => artifactMap[item.artifact_id] !== item.sha256)
    ) {
      issues.push("/candidate_artifact_digests: handle digests must match");
    }
    if (packet.action === "save") {
      if (
        packet.query_run_id === undefined ||
        Object.keys(packet.candidate_source_record_digests).length > 0
      ) {
        issues.push("/: save review requires query_run_id and an empty source-record map");
      }
    } else if (
      packet.query_run_id !== undefined ||
      Object.keys(packet.candidate_source_record_digests).length === 0
    ) {
      issues.push("/: ingest review forbids query_run_id and requires source-record digests");
    }
    return issues;
  }
  if (schema === PromotionGatePacketSchema) {
    const packet = value as PromotionGatePacket;
    const issues = [
      ...duplicateIdentityIssues(
        packet.page_revisions,
        (item) => `${item.page_id}\u0000${item.revision_id}`,
        "/page_revisions"
      ),
      ...duplicateIdentityIssues(
        packet.target_presentations,
        (item) => item.target_capability_id,
        "/target_presentations"
      ),
      ...duplicateIdentityIssues(
        packet.verification_evidence,
        (item) => item.evidence_id,
        "/verification_evidence"
      ),
    ];
    const presentationIds = packet.target_presentations.map((item) => item.target_capability_id);
    if (canonicalJson(presentationIds) !== canonicalJson(packet.target_capability_ids)) {
      issues.push("/target_presentations: must project target_capability_ids in exact order");
    }
    const digestIds = Object.keys(packet.preimage_digests);
    if (
      canonicalJson([...digestIds].sort()) !==
      canonicalJson([...packet.target_capability_ids].sort())
    ) {
      issues.push("/preimage_digests: must contain all and only target capability IDs");
    }
    if (
      packet.target_presentations.some(
        (item) => packet.preimage_digests[item.target_capability_id] !== item.preimage_sha256
      )
    ) {
      issues.push("/preimage_digests: must exactly project target presentation preimages");
    }
    if (
      packet.plan_artifact.artifact_kind !== "promotion_plan" ||
      packet.patch_artifact.artifact_kind !== "promotion_patch" ||
      packet.verification_artifact.artifact_kind !== "verification_report" ||
      packet.patch_digest !== packet.patch_artifact.sha256
    ) {
      issues.push("/: promotion artifact handles/kinds/digests do not match their exact roles");
    }
    if (
      sha256Hex(canonicalJson(packet.verification_evidence)) !== packet.verification_evidence_digest
    ) {
      issues.push("/verification_evidence_digest: must hash the complete non-empty evidence array");
    }
    return issues;
  }
  if (schema === PromotionApplyJournalSchema) {
    const journal = value as PromotionApplyJournal;
    const issues = [
      ...duplicateIdentityIssues(journal.targets, (item) => String(item.ordinal), "/targets"),
      ...duplicateIdentityIssues(journal.targets, (item) => item.target_capability_id, "/targets"),
      ...duplicateIdentityIssues(journal.targets, (item) => item.preimage_storage_key, "/targets"),
    ];
    if (journal.targets.some((target, ordinal) => target.ordinal !== ordinal)) {
      issues.push("/targets: ordinals must be contiguous in array order beginning at zero");
    }
    return issues;
  }
  if (schema === PromotionGateStoreRecordV1Schema) {
    const record = value as PromotionGateStoreRecordV1;
    const issues: string[] = [];
    if (
      (record.decision_intent_jcs === undefined) !==
      (record.decision_intent_sha256 === undefined)
    ) {
      issues.push("/: decision intent bytes and digest must be both present or both absent");
    }
    if (record.decision_intent_jcs !== undefined) {
      if (sha256Hex(record.decision_intent_jcs) !== record.decision_intent_sha256) {
        issues.push("/decision_intent_sha256: must hash decision_intent_jcs");
      }
    }
    if (
      record.state === "awaiting" &&
      (record.decision_intent_jcs !== undefined || record.decision_or_receipt_id !== undefined)
    ) {
      issues.push("/: awaiting gate cannot carry a decision projection");
    }
    if (["claimed", "approved", "refined", "denied"].includes(record.state)) {
      if (record.decision_intent_jcs === undefined) {
        issues.push("/: decided/claimed gate requires the exact decision intent");
      }
    }
    if (["approved", "refined", "denied"].includes(record.state)) {
      if (record.decision_or_receipt_id === undefined) {
        issues.push("/: terminal decision gate requires decision_or_receipt_id");
      }
    }
    return issues;
  }
  if (schema === PromotionApprovalStoreRecordV1Schema) {
    const record = value as PromotionApprovalStoreRecordV1;
    if ((record.state === "available") !== (record.transaction_id === undefined)) {
      return ["/transaction_id: absent exactly while the approval receipt is available"];
    }
    return [];
  }
  if (schema === PromotionDecisionOutcomeV1Schema) {
    const outcome = value as PromotionDecisionOutcomeV1;
    const approvalMembers = [outcome.receipt, outcome.receipt_jcs, outcome.receipt_sha256];
    const approvalCount = approvalMembers.filter((item) => item !== undefined).length;
    if (
      (outcome.gate.state === "approved" && approvalCount !== approvalMembers.length) ||
      (outcome.gate.state !== "approved" && approvalCount !== 0) ||
      (outcome.gate.state === "approved" && outcome.decision_record !== undefined) ||
      (["refined", "denied"].includes(outcome.gate.state) && outcome.decision_record === undefined)
    ) {
      return ["/: decision outcome members do not exactly match the gate decision state"];
    }
    return [];
  }
  if (schema === PromotionApplyOutcomeV1Schema) {
    const outcome = value as PromotionApplyOutcomeV1;
    if ((outcome.status === "complete") !== outcome.post_apply_verified) {
      return ["/post_apply_verified: true exactly for complete promotion apply"];
    }
    return [];
  }
  return [];
}

export function validateKbContract<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string
): Static<T> {
  const structuralIssues = Value.Check(schema, value)
    ? []
    : [...Value.Errors(schema, value)].map(
        (issue) => `${issue.instancePath || "/"}: ${issue.message}`
      );
  const issues =
    structuralIssues.length > 0
      ? structuralIssues
      : [
          ...(Object.is(schema, PackageSurfaceDecisionV1Schema) ||
          Object.is(schema, GateDecisionReceiptV1Schema)
            ? prototypeRecordKeyIssues(value)
            : unsafeRecordKeyIssues(value)),
          ...scalarIssues(schema, value),
          ...crossFieldIssues(schema, value),
        ];
  if (issues.length > 0) {
    throw new KbContractError(`${label} failed schema validation`, issues);
  }
  return value as Static<T>;
}

export function validateHostCapabilityEnvelope(value: unknown): HostCapabilityEnvelopeV1 {
  return validateKbContract(HostCapabilityEnvelopeV1Schema, value, "host capability envelope");
}

export function validateHostCapabilityLease(value: unknown): HostCapabilityLeaseV1 {
  return validateKbContract(HostCapabilityLeaseV1Schema, value, "host capability lease");
}

export function validateSourceAdmissionRecord(value: unknown): SourceAdmissionRecordV1 {
  return validateKbContract(SourceAdmissionRecordV1Schema, value, "source admission record");
}

export function validateParentDeliveryGrant(value: unknown): ParentDeliveryGrantV1 {
  return validateKbContract(ParentDeliveryGrantV1Schema, value, "parent delivery grant");
}

export function validateParentDeliveryGrantStoreRecord(
  value: unknown
): ParentDeliveryGrantStoreRecordV1 {
  return validateKbContract(
    ParentDeliveryGrantStoreRecordV1Schema,
    value,
    "parent delivery grant store record"
  );
}

export function validateParentDeliveryGrantFile(value: unknown): ParentDeliveryGrantFileV1 {
  return validateKbContract(ParentDeliveryGrantFileV1Schema, value, "parent delivery grant file");
}

export function validateKbHostInvocationContext(value: unknown): KbHostInvocationContextV1 {
  return validateKbContract(KbHostInvocationContextV1Schema, value, "KB host invocation context");
}

export function validateKnowledgeBaseRequest(value: unknown): KnowledgeBaseRequest {
  return validateKbContract(KnowledgeBaseRequestSchema, value, "knowledge-base request");
}

export function validateKnowledgeBaseResult(value: unknown): KnowledgeBaseResult {
  return validateKbContract(KnowledgeBaseResultSchema, value, "knowledge-base result");
}

/** RFC 8785 JCS canonical JSON (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(value: string): Sha256Hex {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256Hex;
}

// ── §5.6 public requests (closed, exact keys) ────────────────────────────────

export const InitKbRequestSchema = Type.Union([
  Type.Object(
    {
      schema_version: Type.Literal(1),
      action: Type.Literal("init"),
      kb_profile_id: OpaqueIdSchema,
      create: Type.Literal(true),
      title: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      schema_version: Type.Literal(1),
      action: Type.Literal("init"),
      kb_profile_id: OpaqueIdSchema,
      create: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
]);
export type InitKbRequest = Static<typeof InitKbRequestSchema>;

export const IngestKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("ingest"),
    kb_profile_id: OpaqueIdSchema,
    source_capability_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type IngestKbRequest = Static<typeof IngestKbRequestSchema>;

export const AnswerDeliverySchema = Type.Union([
  Type.Literal("artifact_ref"),
  Type.Literal("parent_tool_result"),
]);
export type AnswerDelivery = Static<typeof AnswerDeliverySchema>;

/** Host-owned, time-bounded grant binding one Pi session to one exact KB profile. */
export const KbSessionProfileGrantSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grant_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type KbSessionProfileGrant = Static<typeof KbSessionProfileGrantSchema>;

export const KbSessionProfileGrantStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);
export type KbSessionProfileGrantState = Static<typeof KbSessionProfileGrantStateSchema>;

export const KbSessionProfileGrantRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grant_id: OpaqueIdSchema,
    grant_sha256: Sha256HexSchema,
    state: KbSessionProfileGrantStateSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type KbSessionProfileGrantRecord = Static<typeof KbSessionProfileGrantRecordSchema>;

/** Immutable authorization-use row for one exact host tool invocation. */
export const KbSessionProfileGrantUseSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grant_id: OpaqueIdSchema,
    grant_sha256: Sha256HexSchema,
    session_id: OpaqueIdSchema,
    invocation_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    action: Type.Union([
      Type.Literal("init"),
      Type.Literal("ingest"),
      Type.Literal("query"),
      Type.Literal("save"),
      Type.Literal("lint"),
      Type.Literal("promote"),
      Type.Literal("status"),
      Type.Literal("resume"),
    ]),
    request_sha256: Sha256HexSchema,
    policy_sha256: Type.Union([Sha256HexSchema, Type.Null()]),
    consumed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type KbSessionProfileGrantUse = Static<typeof KbSessionProfileGrantUseSchema>;

/**
 * `QueryKbRequestV1` (§5.6). Closed validation: query 1–32,768; filter ID sets
 * 0–256 and unique; `max_candidates` 1–100; `verify_grounding` and
 * `answer_delivery` default true / `artifact_ref`. `answer_delivery` is a
 * request, never a grant: `parent_tool_result` additionally requires an exact
 * unconsumed `ParentDeliveryGrantV1` plus the policy allowance.
 */
export const QueryKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("query"),
    kb_profile_id: OpaqueIdSchema,
    query: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 32_768, multiline: true }),
    page_ids: Type.Optional(Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true })),
    source_ids: Type.Optional(Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true })),
    max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    verify_grounding: Type.Optional(Type.Boolean()),
    answer_delivery: Type.Optional(AnswerDeliverySchema),
  },
  { additionalProperties: false }
);
export type QueryKbRequest = Static<typeof QueryKbRequestSchema>;

/**
 * §5.6 `SaveKbRequestV1` — the closed public `save` request.
 *
 * `save` is not authorized by a useful query: it must name the exact prior query
 * run whose sealed answer it is proposing to publish, and that run's claim is
 * what actually authorizes the save.
 *
 * `promotion_candidate` is absent from `SavePageKindV1` by contract — a save can
 * never mint a promotion candidate, because promotion is an authority
 * transition rather than a KB write.
 */
export const SavePageKindSchema = Type.Union([
  Type.Literal("concept"),
  Type.Literal("decision"),
  Type.Literal("synthesis"),
  Type.Literal("question"),
]);
export type SavePageKind = Static<typeof SavePageKindSchema>;

export const SaveKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("save"),
    kb_profile_id: OpaqueIdSchema,
    query_run_id: OpaqueIdSchema,
    page_kind: SavePageKindSchema,
    title: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
  },
  { additionalProperties: false }
);
export type SaveKbRequest = Static<typeof SaveKbRequestSchema>;

export const LintKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("lint"),
    kb_profile_id: OpaqueIdSchema,
    mode: Type.Union([Type.Literal("deterministic"), Type.Literal("deterministic_and_semantic")]),
    page_ids: Type.Optional(Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true })),
  },
  { additionalProperties: false }
);
export type LintKbRequest = Static<typeof LintKbRequestSchema>;

export const StatusKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("status"),
    kb_profile_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type StatusKbRequest = Static<typeof StatusKbRequestSchema>;

export const ResumeKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("resume"),
    kb_profile_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ResumeKbRequest = Static<typeof ResumeKbRequestSchema>;

/**
 * §5.6 `SaveQueryClaimV1` — the single-use right to save one query's answer.
 *
 * A complete query with a sealed answer creates exactly one claim. The states
 * are a one-way ratchet toward a terminal:
 *
 * ```text
 *   available ──claim──> claimed ──reserve──> commit_reserved ──selector──> consumed
 *       ^                   │                        │
 *       └──deny/abort──────┘                        └──pre-selector abort──> invalidated
 *        (only while the sealed answer is still valid)
 * ```
 *
 * `commit_reserved` can never return to `available` or transfer to another save
 * run — that is what makes a save single-use across crashes and retries.
 */
export const SaveQueryClaimStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("claimed"),
  Type.Literal("commit_reserved"),
  Type.Literal("consumed"),
  Type.Literal("invalidated"),
]);
export type SaveQueryClaimState = Static<typeof SaveQueryClaimStateSchema>;

export const SaveQueryClaimSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    query_run_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    answer_artifact_id: OpaqueIdSchema,
    answer_sha256: Sha256HexSchema,
    state: SaveQueryClaimStateSchema,
    save_run_id: Type.Optional(OpaqueIdSchema),
    save_transaction_id: Type.Optional(OpaqueIdSchema),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type SaveQueryClaim = Static<typeof SaveQueryClaimSchema>;

// ── §5.1 authenticated content-review callback ─────────────────────────────

/** The exact path-free artifact handle stored in a content-review packet. */
export const KbArtifactHandleSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_id: OpaqueIdSchema,
    artifact_kind: ArtifactKindSchema,
    sha256: Sha256HexSchema,
    media_type: ArtifactMediaTypeSchema,
    byte_length: Type.Integer({ minimum: 0, maximum: 1_048_576 }),
  },
  { additionalProperties: false }
);
export type KbArtifactHandle = Static<typeof KbArtifactHandleSchema>;

/**
 * One host-minted stable claim identity assigned to a child-produced input
 * candidate. `candidate_ref` is only a transient correlation key from the
 * sealed prior artifact; it never becomes published claim identity.
 */
export const KbComposeClaimAllocationSchema = Type.Object(
  {
    candidate_ref: OpaqueIdSchema,
    claim_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type KbComposeClaimAllocation = Static<typeof KbComposeClaimAllocationSchema>;

/** Exact selected revision a host has authorized one new revision to supersede. */
export const KbComposeSupersedeBoundSchema = Type.Object(
  {
    page_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    page_sha256: Sha256HexSchema,
    claims_sha256: Sha256HexSchema,
  },
  { additionalProperties: false }
);
export type KbComposeSupersedeBound = Static<typeof KbComposeSupersedeBoundSchema>;

/**
 * One all-and-only page/revision/claim allocation for Synthia composition.
 * A null supersede bound means the allocated page id must not be selected in
 * the frozen base generation. The child cannot widen either case.
 */
export const KbComposePageAllocationSchema = Type.Object(
  {
    page_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    lifecycle: PageLifecycleSchema,
    source_ids: Type.Array(SourceIdSchema, { maxItems: 64, uniqueItems: true }),
    claim_allocations: Type.Array(KbComposeClaimAllocationSchema, {
      maxItems: 1_024,
      uniqueItems: true,
    }),
    supersedes: Type.Union([Type.Null(), KbComposeSupersedeBoundSchema]),
  },
  { additionalProperties: false }
);
export type KbComposePageAllocation = Static<typeof KbComposePageAllocationSchema>;

/**
 * Host-only compose authority frozen in the orchestration control DB before a
 * compose session exists. Bodies remain in the content plane; the allocation
 * reaches Synthia only through the version-only private phase-brief reader.
 */
export const KbComposeAuthoritySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kb_id: OpaqueIdSchema,
    base_generation_id: OpaqueIdSchema,
    base_catalog_sha256: Sha256HexSchema,
    private_input_sha256: Sha256HexSchema,
    selected_pages: Type.Array(KbComposeSupersedeBoundSchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    allocations: Type.Array(KbComposePageAllocationSchema, {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type KbComposeAuthority = Static<typeof KbComposeAuthoritySchema>;

export const CandidateConflictAllocationSchema = Type.Object(
  {
    candidate_conflict_id: OpaqueIdSchema,
    conflict_record_id: OpaqueIdSchema,
    conflict_record_sha256: Sha256HexSchema,
  },
  { additionalProperties: false }
);
export type CandidateConflictAllocation = Static<typeof CandidateConflictAllocationSchema>;

/**
 * `ContentReviewGatePacketV1` (§5.1). It contains authority metadata and
 * path-free handles only; private artifact bodies stay in the indexed content
 * plane and are resolved again before callback acceptance and publication.
 */
export const ContentReviewGatePacketSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    action: Type.Union([Type.Literal("ingest"), Type.Literal("save")]),
    base_generation_id: OpaqueIdSchema,
    base_selector_sha256: Sha256HexSchema,
    query_run_id: Type.Optional(OpaqueIdSchema),
    candidate_artifacts: Type.Array(KbArtifactHandleSchema, {
      minItems: 3,
      maxItems: 3,
      uniqueItems: true,
    }),
    candidate_artifact_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    candidate_source_record_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    candidate_conflict_allocations: Type.Array(CandidateConflictAllocationSchema, {
      maxItems: 256,
      uniqueItems: true,
    }),
    policy_sha256: Sha256HexSchema,
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ContentReviewGatePacket = Static<typeof ContentReviewGatePacketSchema>;

/** Complete host-authenticated decision metadata, copied from one exact packet. */
export const ContentReviewDecisionReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("refine"), Type.Literal("deny")]),
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    action: Type.Union([Type.Literal("ingest"), Type.Literal("save")]),
    base_generation_id: OpaqueIdSchema,
    base_selector_sha256: Sha256HexSchema,
    packet_sha256: Sha256HexSchema,
    candidate_artifact_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    candidate_source_record_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    candidate_conflict_allocations: Type.Array(CandidateConflictAllocationSchema, {
      maxItems: 256,
      uniqueItems: true,
    }),
    policy_sha256: Sha256HexSchema,
    reviewer_subject_id: OpaqueIdSchema,
    decided_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ContentReviewDecisionReceipt = Static<typeof ContentReviewDecisionReceiptSchema>;

export const ContentReviewStoreStateSchema = Type.Union([
  Type.Literal("awaiting"),
  Type.Literal("approved"),
  Type.Literal("claimed"),
  Type.Literal("commit_reserved"),
  Type.Literal("consumed"),
  Type.Literal("refined"),
  Type.Literal("denied"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type ContentReviewStoreState = Static<typeof ContentReviewStoreStateSchema>;

export const ContentReviewStoreRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    challenge_id: OpaqueIdSchema,
    packet_sha256: Sha256HexSchema,
    packet_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    state: ContentReviewStoreStateSchema,
    decision_receipt_jcs: Type.Optional(Type.String({ minLength: 2, maxLength: 1_048_576 })),
    decision_receipt_sha256: Type.Optional(Sha256HexSchema),
    receipt_id: Type.Optional(OpaqueIdSchema),
    transaction_id: Type.Optional(OpaqueIdSchema),
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ContentReviewStoreRecord = Static<typeof ContentReviewStoreRecordSchema>;

/**
 * §5.6 `PromoteKbRequestV1` — the closed public `promote` request.
 *
 * `promote` always means prepare/verify/gate. This request names an exact page
 * revision set and exact host-minted canonical-target capability IDs; it cannot
 * carry a target path, an approval decision, a receipt, or an intent to apply.
 * Approval and apply are host-only paths (§5.11), not fields.
 */
export const PageRevisionRefSchema = Type.Object(
  {
    page_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type PageRevisionRef = Static<typeof PageRevisionRefSchema>;

export const PromoteKbRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    action: Type.Literal("promote"),
    kb_profile_id: OpaqueIdSchema,
    page_revisions: Type.Array(PageRevisionRefSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    canonical_target_capability_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type PromoteKbRequest = Static<typeof PromoteKbRequestSchema>;

/** The complete and only eight model-visible KB request variants. */
export const KnowledgeBaseRequestSchema = Type.Union([
  InitKbRequestSchema,
  IngestKbRequestSchema,
  QueryKbRequestSchema,
  SaveKbRequestSchema,
  LintKbRequestSchema,
  PromoteKbRequestSchema,
  StatusKbRequestSchema,
  ResumeKbRequestSchema,
]);
export type KnowledgeBaseRequest = Static<typeof KnowledgeBaseRequestSchema>;

export const StartKbActionSchema = Type.Union([
  Type.Literal("init"),
  Type.Literal("ingest"),
  Type.Literal("query"),
  Type.Literal("save"),
  Type.Literal("lint"),
  Type.Literal("promote"),
]);
export type StartKbAction = Static<typeof StartKbActionSchema>;

/** Exact §5.6 control-DB projection for one indexed private request. */
export const PrivateRunInputRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    private_input_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    request_sha256: Sha256HexSchema,
    storage_key: Type.String({ minLength: 1, maxLength: 512 }),
    temporary_storage_key: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    state: Type.Union([
      Type.Literal("preparing"),
      Type.Literal("active"),
      Type.Literal("terminal"),
      Type.Literal("discarding"),
      Type.Literal("discarded"),
    ]),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PrivateRunInputRecord = Static<typeof PrivateRunInputRecordSchema>;

/** Exact §5.6 idempotency projection; invocation identity is host-owned. */
export const IdempotencyRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    session_id: OpaqueIdSchema,
    invocation_id: OpaqueIdSchema,
    request_sha256: Sha256HexSchema,
    kb_profile_id: OpaqueIdSchema,
    action: StartKbActionSchema,
    run_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    state: Type.Union([Type.Literal("running"), Type.Literal("terminal")]),
    terminal_result_id: Type.Optional(OpaqueIdSchema),
    terminal_result_sha256: Type.Optional(Sha256HexSchema),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type IdempotencyRecord = Static<typeof IdempotencyRecordSchema>;

/**
 * §5.11 promotion verification — the host's own finding, not an agent's.
 *
 * The plan and patch are advisory artifacts produced by children. What makes a
 * promotion packet trustworthy is this: the host independently re-resolved every
 * target capability, captured each target's CURRENT preimage digest, and
 * confirmed each named page revision is actually selected. `verified: false`
 * with a bounded reason is a normal, honest outcome — the packet is still
 * returned, and it still cannot apply anything.
 */
export const PromotionVerificationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("verification_report"),
    verified: Type.Boolean(),
    page_revisions: Type.Array(PageRevisionRefSchema, { maxItems: 64 }),
    targets: Type.Array(
      Type.Object(
        {
          capability_id: OpaqueIdSchema,
          // Absent only on an honest failed re-resolution. Host paths and
          // authority roots never enter a verification artifact.
          preimage_sha256: Type.Optional(Sha256HexSchema),
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    findings: Type.Array(humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 512 }), {
      maxItems: 64,
    }),
  },
  { additionalProperties: false }
);
export type PromotionVerification = Static<typeof PromotionVerificationSchema>;

// ── §5.11 signed host-only promotion approval/apply ─────────────────────────

export const EvidenceRefSchema = Type.Object(
  {
    evidence_id: OpaqueIdSchema,
    kind: Type.Union([
      Type.Literal("artifact"),
      Type.Literal("test"),
      Type.Literal("source"),
      Type.Literal("gate"),
      Type.Literal("digest"),
    ]),
    ref: OpaqueIdSchema,
    sha256: Type.Optional(Sha256HexSchema),
  },
  { additionalProperties: false }
);
export type EvidenceRef = Static<typeof EvidenceRefSchema>;

export const PromotionPlanArtifactSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("promotion_plan"),
    page_revisions: Type.Array(PageRevisionRefSchema, { minItems: 1, maxItems: 64 }),
    target_capability_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    verification_report_artifact_ids: Type.Array(OpaqueIdSchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    changes: Type.Array(
      Type.Object(
        {
          target_capability_id: OpaqueIdSchema,
          summary: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 4_096, multiline: true }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);
export type PromotionPlanArtifact = Static<typeof PromotionPlanArtifactSchema>;

export const PromotionPatchArtifactSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("promotion_patch"),
    targets: Type.Array(
      Type.Object(
        {
          target_capability_id: OpaqueIdSchema,
          preimage_sha256: Sha256HexSchema,
          postimage_sha256: Sha256HexSchema,
          replacement_utf8: humanTextSchema({ maxUtf8Bytes: 1_048_576, multiline: true }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
  },
  { additionalProperties: false }
);
export type PromotionPatchArtifact = Static<typeof PromotionPatchArtifactSchema>;

export const PromotionTargetPresentationSchema = Type.Object(
  {
    target_capability_id: OpaqueIdSchema,
    canonical_target: Type.String({ minLength: 1, maxLength: 4_096 }),
    preimage_sha256: Sha256HexSchema,
  },
  { additionalProperties: false }
);
export type PromotionTargetPresentation = Static<typeof PromotionTargetPresentationSchema>;

export const PromotionGatePacketSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    page_revisions: Type.Array(PageRevisionRefSchema, { minItems: 1, maxItems: 64 }),
    target_capability_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    target_presentations: Type.Array(PromotionTargetPresentationSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    preimage_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    plan_artifact: KbArtifactHandleSchema,
    patch_artifact: KbArtifactHandleSchema,
    verification_artifact: KbArtifactHandleSchema,
    patch_digest: Sha256HexSchema,
    verification_evidence: Type.Array(EvidenceRefSchema, { minItems: 1, maxItems: 64 }),
    verification_evidence_digest: Sha256HexSchema,
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PromotionGatePacket = Static<typeof PromotionGatePacketSchema>;

export const PromotionDecisionIntentSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    decision_id: OpaqueIdSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("refine"), Type.Literal("deny")]),
    challenge_id: OpaqueIdSchema,
    packet_sha256: Sha256HexSchema,
    reviewer_subject_id: OpaqueIdSchema,
    decided_at: Rfc3339UtcSchema,
    approval_nonce: Type.Optional(OpaqueIdSchema),
    approval_expires_at: Type.Optional(Rfc3339UtcSchema),
  },
  { additionalProperties: false }
);
export type PromotionDecisionIntent = Static<typeof PromotionDecisionIntentSchema>;

export const PromotionGateDecisionRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    decision_id: OpaqueIdSchema,
    decision: Type.Union([Type.Literal("refine"), Type.Literal("deny")]),
    challenge_id: OpaqueIdSchema,
    packet_sha256: Sha256HexSchema,
    reviewer_subject_id: OpaqueIdSchema,
    decided_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PromotionGateDecisionRecord = Static<typeof PromotionGateDecisionRecordSchema>;

export const Base64UrlNoPaddingSchema = Type.String({
  pattern: /^[A-Za-z0-9_-]{43}$/.source,
  minLength: 43,
  maxLength: 43,
});
export type Base64UrlNoPadding = Static<typeof Base64UrlNoPaddingSchema>;

export const PromotionApprovalReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    decision: Type.Literal("approve"),
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: OpaqueIdSchema,
    gate_packet_sha256: Sha256HexSchema,
    page_revisions: Type.Array(PageRevisionRefSchema, { minItems: 1, maxItems: 64 }),
    target_capability_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    canonical_targets: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 64,
    }),
    preimage_digests: Type.Record(SafeRecordKeySchema, Sha256HexSchema),
    patch_digest: Sha256HexSchema,
    verification_evidence_digest: Sha256HexSchema,
    approver_subject_id: OpaqueIdSchema,
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
    nonce: OpaqueIdSchema,
    key_id: Type.String({ pattern: /^[A-Za-z0-9_-]{16,64}$/.source, minLength: 16, maxLength: 64 }),
    signature: Base64UrlNoPaddingSchema,
  },
  { additionalProperties: false }
);
export type PromotionApprovalReceipt = Static<typeof PromotionApprovalReceiptSchema>;

export const PromotionGateStoreStateSchema = Type.Union([
  Type.Literal("awaiting"),
  Type.Literal("claimed"),
  Type.Literal("approved"),
  Type.Literal("refined"),
  Type.Literal("denied"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type PromotionGateStoreState = Static<typeof PromotionGateStoreStateSchema>;

export const PromotionApprovalStoreStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("claimed"),
  Type.Literal("apply_reserved"),
  Type.Literal("consumed"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type PromotionApprovalStoreState = Static<typeof PromotionApprovalStoreStateSchema>;

/** Exact §5.11 durable gate-row projection; parsed private values are not members. */
export const PromotionGateStoreRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    challenge_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    packet_sha256: Sha256HexSchema,
    packet_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    state: PromotionGateStoreStateSchema,
    decision_intent_jcs: Type.Optional(Type.String({ minLength: 2, maxLength: 1_048_576 })),
    decision_intent_sha256: Type.Optional(Sha256HexSchema),
    decision_or_receipt_id: Type.Optional(OpaqueIdSchema),
    transaction_id: Type.Optional(OpaqueIdSchema),
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PromotionGateStoreRecordV1 = Static<typeof PromotionGateStoreRecordV1Schema>;

/**
 * Owner-only parsed gate envelope. This is intentionally not a public/control
 * projection: it may contain canonical target presentations inside `packet`.
 */
export const PromotionGateStoreEnvelopeV1Schema = Type.Object(
  {
    ...PromotionGateStoreRecordV1Schema.properties,
    packet: PromotionGatePacketSchema,
    decision_intent: Type.Optional(PromotionDecisionIntentSchema),
    decision_record_jcs: Type.Optional(Type.String({ minLength: 2, maxLength: 1_048_576 })),
    decision_record: Type.Optional(PromotionGateDecisionRecordSchema),
  },
  { additionalProperties: false }
);
export type PromotionGateStoreEnvelopeV1 = Static<typeof PromotionGateStoreEnvelopeV1Schema>;

/** Exact §5.11 durable approval-receipt row projection; receipt bytes remain private. */
export const PromotionApprovalStoreRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    receipt_sha256: Sha256HexSchema,
    key_id: Type.String({ pattern: /^[A-Za-z0-9_-]{16,64}$/.source, minLength: 16, maxLength: 64 }),
    state: PromotionApprovalStoreStateSchema,
    transaction_id: Type.Optional(OpaqueIdSchema),
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PromotionApprovalStoreRecordV1 = Static<typeof PromotionApprovalStoreRecordV1Schema>;

/** Owner-only parsed approval envelope; never a public/control result. */
export const PromotionApprovalStoreEnvelopeV1Schema = Type.Object(
  {
    ...PromotionApprovalStoreRecordV1Schema.properties,
    challenge_id: OpaqueIdSchema,
    receipt_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    signed_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    receipt: PromotionApprovalReceiptSchema,
  },
  { additionalProperties: false }
);
export type PromotionApprovalStoreEnvelopeV1 = Static<
  typeof PromotionApprovalStoreEnvelopeV1Schema
>;

export const ParsedPromotionApprovalReceiptV1Schema = Type.Object(
  {
    receipt: PromotionApprovalReceiptSchema,
    receipt_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    receipt_sha256: Sha256HexSchema,
  },
  { additionalProperties: false }
);
export type ParsedPromotionApprovalReceiptV1 = Static<
  typeof ParsedPromotionApprovalReceiptV1Schema
>;

/** The complete and only approval metadata allowed into orchestration control state. */
export const PromotionControlApprovalBindingV1Schema = Type.Object(
  {
    run_id: OpaqueIdSchema,
    challenge_id: OpaqueIdSchema,
    packet_sha256: Sha256HexSchema,
    decision: Type.Literal("approve"),
    decision_intent_sha256: Sha256HexSchema,
    receipt_id: OpaqueIdSchema,
    receipt_sha256: Sha256HexSchema,
  },
  { additionalProperties: false }
);
export type PromotionControlApprovalBindingV1 = Static<
  typeof PromotionControlApprovalBindingV1Schema
>;

export const PromotionApplyOutcomeV1Schema = Type.Object(
  {
    transaction_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    receipt_id: OpaqueIdSchema,
    receipt_sha256: Sha256HexSchema,
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("failed"),
      Type.Literal("blocked_external_drift"),
    ]),
    post_apply_verified: Type.Boolean(),
    target_count: Type.Integer({ minimum: 1, maximum: 64 }),
  },
  { additionalProperties: false }
);
export type PromotionApplyOutcomeV1 = Static<typeof PromotionApplyOutcomeV1Schema>;

export const PromotionApplyJournalTargetSchema = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 0, maximum: 63 }),
    target_capability_id: OpaqueIdSchema,
    preimage_sha256: Sha256HexSchema,
    postimage_sha256: Sha256HexSchema,
    preimage_mode: Type.Integer({ minimum: 0, maximum: 0o7777 }),
    preimage_storage_key: Type.String({
      pattern:
        /^work\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/promotion\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/preimages\/[0-9]+$/
          .source,
      maxLength: 512,
    }),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("ready"),
      Type.Literal("written"),
      Type.Literal("verified"),
      Type.Literal("restored"),
    ]),
  },
  { additionalProperties: false }
);
export type PromotionApplyJournalTarget = Static<typeof PromotionApplyJournalTargetSchema>;

export const PromotionApplyJournalSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    transaction_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    receipt_id: OpaqueIdSchema,
    receipt_sha256: Sha256HexSchema,
    patch_artifact_id: OpaqueIdSchema,
    state: Type.Union([
      Type.Literal("claimed"),
      Type.Literal("capturing"),
      Type.Literal("applying"),
      Type.Literal("verifying"),
      Type.Literal("restoring"),
      Type.Literal("complete"),
      Type.Literal("failed"),
      Type.Literal("blocked_external_drift"),
    ]),
    targets: Type.Array(PromotionApplyJournalTargetSchema, { minItems: 1, maxItems: 64 }),
    post_apply_verified: Type.Boolean(),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type PromotionApplyJournal = Static<typeof PromotionApplyJournalSchema>;

export const PromotionDecisionOutcomeV1Schema = Type.Object(
  {
    gate: PromotionGateStoreEnvelopeV1Schema,
    receipt: Type.Optional(PromotionApprovalReceiptSchema),
    receipt_jcs: Type.Optional(Type.String({ minLength: 2, maxLength: 1_048_576 })),
    receipt_sha256: Type.Optional(Sha256HexSchema),
    decision_record: Type.Optional(PromotionGateDecisionRecordSchema),
  },
  { additionalProperties: false }
);
export type PromotionDecisionOutcomeV1 = Static<typeof PromotionDecisionOutcomeV1Schema>;

// ── §5.1 parent delivery grant (host-minted, single-use) ─────────────────────

/**
 * `ParentDeliveryGrantV1` (§5.1). Host-minted out of band, stored owner-only,
 * single-use: exactly one unexpired grant whose session, invocation, action,
 * profile, `request_sha256 = SHA-256(JCS(request))`, and byte maximum all match
 * the host invocation context admits derived parent delivery; the grant store
 * then atomically consumes it by the returned run, and retries never redeliver.
 */
export const ParentDeliveryGrantV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grant_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    invocation_id: OpaqueIdSchema,
    action: Type.Literal("query"),
    kb_profile_id: OpaqueIdSchema,
    request_sha256: Sha256HexSchema,
    policy_sha256: Sha256HexSchema,
    parent_provider: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    parent_model: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    max_utf8_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    issued_at: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ParentDeliveryGrantV1 = Static<typeof ParentDeliveryGrantV1Schema>;
export const ParentDeliveryGrantSchema = ParentDeliveryGrantV1Schema;
export type ParentDeliveryGrant = ParentDeliveryGrantV1;

/** Exact private extension-to-app authority object; never a tool parameter. */
export const KbHostInvocationContextV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    session_id: OpaqueIdSchema,
    invocation_id: OpaqueIdSchema,
    parent_provider: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    parent_model: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    parent_locality: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
    allowed_kb_profile_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    parent_delivery_grant: Type.Optional(ParentDeliveryGrantV1Schema),
  },
  { additionalProperties: false }
);
export type KbHostInvocationContextV1 = Static<typeof KbHostInvocationContextV1Schema>;

export const ParentDeliveryGrantStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("consumed"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type ParentDeliveryGrantState = Static<typeof ParentDeliveryGrantStateSchema>;

/** `ParentDeliveryGrantStoreRecordV1` (§5.1) — the durable state row. */
export const ParentDeliveryGrantStoreRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grant_id: OpaqueIdSchema,
    grant_sha256: Sha256HexSchema,
    state: ParentDeliveryGrantStateSchema,
    run_id: Type.Optional(OpaqueIdSchema),
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ParentDeliveryGrantStoreRecordV1 = Static<
  typeof ParentDeliveryGrantStoreRecordV1Schema
>;
export const ParentDeliveryGrantStoreRecordSchema = ParentDeliveryGrantStoreRecordV1Schema;
export type ParentDeliveryGrantStoreRecord = ParentDeliveryGrantStoreRecordV1;

/** The owner-only grant file: the state record plus the full grant. */
export const ParentDeliveryGrantFileV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    record: ParentDeliveryGrantStoreRecordV1Schema,
    grant: ParentDeliveryGrantV1Schema,
  },
  { additionalProperties: false }
);
export type ParentDeliveryGrantFileV1 = Static<typeof ParentDeliveryGrantFileV1Schema>;
export const ParentDeliveryGrantFileSchema = ParentDeliveryGrantFileV1Schema;
export type ParentDeliveryGrantFile = ParentDeliveryGrantFileV1;

// ── §5.6 derived answer (parent delivery payload only) ──────────────────────

/** `DerivedCitationV1` — exactly one union shape per citation object. */
export const DerivedCitationSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("page"), page_id: OpaqueIdSchema, revision_id: OpaqueIdSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("claim"),
      page_id: OpaqueIdSchema,
      revision_id: OpaqueIdSchema,
      claim_id: OpaqueIdSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("source"), source_id: OpaqueIdSchema },
    { additionalProperties: false }
  ),
]);
export type DerivedCitation = Static<typeof DerivedCitationSchema>;

/**
 * `DerivedQueryAnswerV1` — the ONLY content a parent may receive for a query.
 * Advisory authority, bounded text, opaque-ID citations, bounded advisory
 * uncertainty entries, and a mandatory canonical-verification reminder. Raw
 * source/page/claim/artifact/report/patch bodies never return.
 */
export const DerivedQueryAnswerSchema = Type.Object(
  {
    authority: Type.Literal("advisory"),
    text: humanTextSchema({ maxUtf8Bytes: 32_768, multiline: true }),
    // Empty is valid only for an honest unmet private artifact. Parent delivery
    // still independently requires a non-empty supported citation set.
    citations: Type.Array(DerivedCitationSchema, { maxItems: 64, uniqueItems: true }),
    contradictions: Type.Array(humanTextSchema({ maxUtf8Bytes: 1_024, multiline: true }), {
      maxItems: 16,
    }),
    unknowns: Type.Array(humanTextSchema({ maxUtf8Bytes: 1_024, multiline: true }), {
      maxItems: 16,
    }),
    canonical_verification_required: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type DerivedQueryAnswer = Static<typeof DerivedQueryAnswerSchema>;

// ── §5.5 operation event-group / receipt plane ─────────────────────────────

/** The seven and only seven receipt-producing public actions. `status` is absent. */
export const OperationActionSchema = Type.Union([
  Type.Literal("init"),
  Type.Literal("ingest"),
  Type.Literal("query"),
  Type.Literal("save"),
  Type.Literal("lint"),
  Type.Literal("promote"),
  Type.Literal("resume"),
]);
export type OperationAction = Static<typeof OperationActionSchema>;

export const OperationEventSchema = Type.Union([
  Type.Literal("prepared"),
  Type.Literal("published"),
  Type.Literal("completed"),
  Type.Literal("incomplete"),
  Type.Literal("failed"),
]);
export type OperationEvent = Static<typeof OperationEventSchema>;

export const OperationEventSourceSchema = Type.Union([
  Type.Literal("external_start"),
  Type.Literal("external_resume"),
  Type.Literal("content_review_decision"),
  Type.Literal("promotion_decision"),
  Type.Literal("promotion_apply"),
]);
export type OperationEventSource = Static<typeof OperationEventSourceSchema>;

const SafeMetricKeySchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^(?!(?:__proto__|prototype|constructor)$)[a-z][a-z0-9_]{0,63}$",
});
const SafeMetricMapSchema = Type.Record(
  SafeMetricKeySchema,
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);

const KnowledgeBaseResultProperties = {
  schema_version: Type.Literal(1),
  action: KbActionSchema,
  run_id: OpaqueIdSchema,
  kb_id: Type.Optional(OpaqueIdSchema),
  status: RunStatusSchema,
  met: Type.Boolean(),
  ids: Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true }),
  counts: SafeMetricMapSchema,
  artifacts: Type.Array(KbArtifactHandleSchema, { maxItems: 64, uniqueItems: true }),
  evidence: Type.Array(EvidenceRefSchema, { maxItems: 64, uniqueItems: true }),
  warnings: Type.Array(humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 1_024 }), {
    maxItems: 64,
  }),
  unresolved: Type.Array(humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 1_024 }), {
    maxItems: 64,
  }),
  next: Type.Union([Type.Literal("resume"), Type.Literal("review"), Type.Literal("none")]),
} as const;

/** Exact public result wire, including the ephemeral approved query answer variant. */
export const KnowledgeBaseResultSchema = Type.Object(
  {
    ...KnowledgeBaseResultProperties,
    derived_answer: Type.Optional(DerivedQueryAnswerSchema),
  },
  { additionalProperties: false }
);
export type KnowledgeBaseResult = Static<typeof KnowledgeBaseResultSchema>;

/**
 * Exact content-free replay wire. It deliberately omits `derived_answer`; a
 * delivered answer is an ephemeral single-use parent result and is never
 * durable replay state. All eight public actions, including `status`, are valid
 * replay projections even though status itself emits no operation receipt.
 */
export const ReplayableKnowledgeBaseResultSchema = Type.Object(KnowledgeBaseResultProperties, {
  additionalProperties: false,
});
export type ReplayableKnowledgeBaseResult = Static<typeof ReplayableKnowledgeBaseResultSchema>;

export const OperationReceiptSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    request_event_group_id: OpaqueIdSchema,
    event_sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    kb_profile_id: OpaqueIdSchema,
    kb_id: Type.Optional(OpaqueIdSchema),
    action: OperationActionSchema,
    event: OperationEventSchema,
    input_digests: Type.Array(Sha256HexSchema, { minItems: 1, maxItems: 64 }),
    output_refs: Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true }),
    base_generation_id: Type.Optional(OpaqueIdSchema),
    candidate_generation_id: Type.Optional(OpaqueIdSchema),
    policy_sha256: Type.Optional(Sha256HexSchema),
    safe_metrics: SafeMetricMapSchema,
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type OperationReceipt = Static<typeof OperationReceiptSchema>;

export const OperationEventGroupSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_event_group_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    transaction_id: OpaqueIdSchema,
    action: OperationActionSchema,
    source_kind: OperationEventSourceSchema,
    source_identity_sha256: Sha256HexSchema,
    event_sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    state: Type.Union([
      Type.Literal("reserved"),
      Type.Literal("outcome_preparing"),
      Type.Literal("committed"),
    ]),
    receipt_id: Type.Optional(OpaqueIdSchema),
    replay_result_jcs: Type.Optional(Type.String({ minLength: 2, maxLength: 1_048_576 })),
    replay_result_sha256: Type.Optional(Sha256HexSchema),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type OperationEventGroup = Static<typeof OperationEventGroupSchema>;

export const OperationReceiptIndexRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    session_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    kb_id: Type.Optional(OpaqueIdSchema),
    action: OperationActionSchema,
    event: OperationEventSchema,
    transaction_id: OpaqueIdSchema,
    request_event_group_id: OpaqueIdSchema,
    event_sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    source_kind: OperationEventSourceSchema,
    source_identity_sha256: Sha256HexSchema,
    receipt_jcs: Type.String({ minLength: 2, maxLength: 1_048_576 }),
    temporary_storage_key: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    final_storage_key: Type.String({ minLength: 1, maxLength: 512 }),
    sha256: Sha256HexSchema,
    byte_length: Type.Integer({ minimum: 2, maximum: 1_048_576 }),
    state: Type.Union([
      Type.Literal("preparing"),
      Type.Literal("staged"),
      Type.Literal("published"),
    ]),
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type OperationReceiptIndexRecord = Static<typeof OperationReceiptIndexRecordSchema>;

export const TerminalResultRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    terminal_result_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    idempotency_transaction_id: OpaqueIdSchema,
    operation_receipt_id: OpaqueIdSchema,
    result: ReplayableKnowledgeBaseResultSchema,
    result_sha256: Sha256HexSchema,
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type TerminalResultRecord = Static<typeof TerminalResultRecordSchema>;

/** The exact same-run artifact Synthia must produce for a grounded query. */
export const QueryAnswerArtifactSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("query_answer"),
    answer: DerivedQueryAnswerSchema,
  },
  { additionalProperties: false }
);
export type QueryAnswerArtifact = Static<typeof QueryAnswerArtifactSchema>;

/**
 * Vera's closed query-grounding report. The engine provenance binds this report
 * to the one `query` phase artifact it was allowed to read; the host additionally
 * requires one finding for every answer citation and no extras before `passed`
 * has any authority.
 */
export const QueryVerificationReportSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("verification_report"),
    passed: Type.Boolean(),
    answer_artifact_id: OpaqueIdSchema,
    // SHA-256 of the complete canonical QueryAnswerArtifactV1 JCS bytes, equal
    // to the exact sealed answer handle's sha256 (never a text-only digest).
    answer_sha256: Sha256HexSchema,
    answer_verdict: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]),
    citation_findings: Type.Array(
      Type.Object(
        {
          citation: DerivedCitationSchema,
          verdict: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]),
          notes: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 2_048, multiline: true }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64, uniqueItems: true }
    ),
  },
  { additionalProperties: false }
);
export type QueryVerificationReport = Static<typeof QueryVerificationReportSchema>;

// ── §5.7 exact child artifact payloads ──────────────────────────────────────

/**
 * Echo's closed extraction payload. `provisional_id` is a transient correlation
 * key only: the host assigns every stable advisory claim id before compose and
 * exposes that exact mapping through the private compose brief.
 */
export const ExtractedClaimSchema = Type.Object(
  {
    provisional_id: OpaqueIdSchema,
    text: humanTextSchema({ maxUtf8Bytes: 8_192, multiline: true }),
    kind: ClaimKindSchema,
    confidence: ConfidenceSchema,
    evidence: Type.Array(EvidenceEntrySchema),
  },
  { additionalProperties: false }
);
export type ExtractedClaim = Static<typeof ExtractedClaimSchema>;
const ClaimsArtifactProperties = {
  schema_version: Type.Literal(1),
  artifact_kind: Type.Literal("claims"),
  source_ids: Type.Array(SourceIdSchema, {
    minItems: 1,
    maxItems: 64,
    uniqueItems: true,
  }),
};
export const ClaimsArtifactSchema = Type.Object(
  { ...ClaimsArtifactProperties, claims: Type.Array(ExtractedClaimSchema, { maxItems: 1_024 }) },
  { additionalProperties: false }
);
export type ClaimsArtifact = Static<typeof ClaimsArtifactSchema>;
// Compatibility export name for callers that already used the provisional-only
// boundary. Both names intentionally identify the same one closed schema.
export const ExtractedClaimsArtifactSchema = ClaimsArtifactSchema;
export type ExtractedClaimsArtifact = ClaimsArtifact;

/** Synthia composition's one closed page bundle. */
export const PageDraftArtifactSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("page_draft"),
    pages: Type.Array(
      Type.Object(
        {
          frontmatter: PageRevisionFrontmatterSchema,
          markdown: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 1_048_576, multiline: true }),
          claims: ClaimsSidecarSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 8 }
    ),
  },
  { additionalProperties: false }
);
export type PageDraftArtifact = Static<typeof PageDraftArtifactSchema>;

const CandidateConflictSchema = Type.Object(
  {
    candidate_conflict_id: OpaqueIdSchema,
    claim_refs: Type.Array(
      Type.Object(
        {
          page_id: OpaqueIdSchema,
          revision_id: OpaqueIdSchema,
          claim_id: OpaqueIdSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 64 }
    ),
    summary: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 4_096, multiline: true }),
    evidence_refs: Type.Array(EvidenceRefSchema, { maxItems: 64 }),
  },
  { additionalProperties: false }
);

/** Carren's semantic report. Conflicts remain candidates until host review. */
export const LintReportArtifactSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("lint_report"),
    findings: Type.Array(
      Type.Object(
        {
          finding_id: OpaqueIdSchema,
          severity: Type.Union([
            Type.Literal("info"),
            Type.Literal("warning"),
            Type.Literal("blocking"),
          ]),
          summary: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 4_096, multiline: true }),
          evidence: Type.Array(EvidenceRefSchema, { maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_024 }
    ),
    candidate_conflicts: Type.Array(CandidateConflictSchema, { maxItems: 256 }),
  },
  { additionalProperties: false }
);
export type LintReportArtifact = Static<typeof LintReportArtifactSchema>;

/** Vera's ingest/save grounding report. Query verification has its own closed shape above. */
export const IngestVerificationReportSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: Type.Literal("verification_report"),
    verified_artifact_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    claim_findings: Type.Array(
      Type.Object(
        {
          page_id: OpaqueIdSchema,
          revision_id: OpaqueIdSchema,
          claim_id: OpaqueIdSchema,
          verdict: Type.Union([
            Type.Literal("supported"),
            Type.Literal("partially_supported"),
            Type.Literal("unsupported"),
          ]),
          evidence: Type.Array(EvidenceRefSchema, { maxItems: 64 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_024 }
    ),
  },
  { additionalProperties: false }
);
export type IngestVerificationReport = Static<typeof IngestVerificationReportSchema>;

/** Every work-plane JSON kind has one closed schema (verification has closed producer variants). */
export const ChildVerificationReportSchema = Type.Union([
  IngestVerificationReportSchema,
  QueryVerificationReportSchema,
]);
export type ChildVerificationReport = Static<typeof ChildVerificationReportSchema>;

/** Closed all-and-only verification union: ingest/save, query, or host promotion. */
export const VerificationReportArtifactSchema = Type.Union([
  IngestVerificationReportSchema,
  QueryVerificationReportSchema,
  PromotionVerificationSchema,
]);
export type VerificationReportArtifact = Static<typeof VerificationReportArtifactSchema>;

export const ArtifactPayloadSchema = Type.Union([
  ClaimsArtifactSchema,
  PageDraftArtifactSchema,
  QueryAnswerArtifactSchema,
  LintReportArtifactSchema,
  VerificationReportArtifactSchema,
  PromotionPlanArtifactSchema,
  PromotionPatchArtifactSchema,
]);
export type ArtifactPayload = Static<typeof ArtifactPayloadSchema>;

// ── §5.8 exact private-reader inputs/results ─────────────────────────────────

export const KbPhaseBriefSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("ingest"),
      source_ids: Type.Array(SourceIdSchema, { maxItems: 64, uniqueItems: true }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("query"),
      query: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 32_768, multiline: true }),
      page_ids: Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true }),
      source_ids: Type.Array(SourceIdSchema, { maxItems: 256, uniqueItems: true }),
      max_candidates: Type.Integer({ minimum: 1, maximum: 100 }),
      verify_grounding: Type.Boolean(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("save"),
      query_run_id: OpaqueIdSchema,
      page_kind: SavePageKindSchema,
      title: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 256 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("lint"),
      mode: Type.Union([Type.Literal("deterministic"), Type.Literal("deterministic_and_semantic")]),
      page_ids: Type.Array(OpaqueIdSchema, { maxItems: 256, uniqueItems: true }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("promote"),
      page_revisions: Type.Array(PageRevisionRefSchema, { minItems: 1, maxItems: 64 }),
      target_capability_ids: Type.Array(OpaqueIdSchema, {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false }
  ),
]);
export type KbPhaseBrief = Static<typeof KbPhaseBriefSchema>;

export const ReadPhaseBriefResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    state_id: OpaqueIdSchema,
    brief: KbPhaseBriefSchema,
    allowed_prior_artifacts: Type.Array(KbArtifactHandleSchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    allowed_selected_pages: Type.Array(PageRevisionRefSchema, { maxItems: 64 }),
    compose_authority: Type.Optional(KbComposeAuthoritySchema),
  },
  { additionalProperties: false }
);
export type ReadPhaseBriefResult = Static<typeof ReadPhaseBriefResultSchema>;

export const ReadPhaseBriefInputSchema = Type.Object(
  { schema_version: Type.Literal(1) },
  { additionalProperties: false }
);
export const ReadSourceSnapshotInputSchema = Type.Object(
  { schema_version: Type.Literal(1), source_id: SourceIdSchema },
  { additionalProperties: false }
);
export const ReadRunArtifactInputSchema = Type.Object(
  { schema_version: Type.Literal(1), artifact_id: OpaqueIdSchema },
  { additionalProperties: false }
);
export const SearchSelectedKbInputSchema = Type.Object(
  { schema_version: Type.Literal(1) },
  { additionalProperties: false }
);
export const ReadSelectedPageInputSchema = Type.Object(
  { schema_version: Type.Literal(1), page_id: OpaqueIdSchema, revision_id: OpaqueIdSchema },
  { additionalProperties: false }
);
export const ReadCanonicalTargetInputSchema = Type.Object(
  { schema_version: Type.Literal(1), capability_id: OpaqueIdSchema },
  { additionalProperties: false }
);

export const ReadSourceSnapshotResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_id: SourceIdSchema,
    sha256: Sha256HexSchema,
    media_type: Type.Union([
      Type.Literal("text/plain"),
      Type.Literal("text/markdown"),
      Type.Literal("application/json"),
    ]),
    content_utf8: humanTextSchema({ maxUtf8Bytes: 1_048_576, multiline: true }),
  },
  { additionalProperties: false }
);
export const ReadRunArtifactResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact: KbArtifactHandleSchema,
    payload: ArtifactPayloadSchema,
  },
  { additionalProperties: false }
);
export const SearchSelectedKbResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    generation_id: OpaqueIdSchema,
    candidates: Type.Array(
      Type.Object(
        {
          page_id: OpaqueIdSchema,
          revision_id: OpaqueIdSchema,
          score: Type.Number(),
          claim_ids: Type.Array(OpaqueIdSchema, { maxItems: 1_024, uniqueItems: true }),
          excerpt: humanTextSchema({ maxUtf8Bytes: 8_192, multiline: true }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 100 }
    ),
  },
  { additionalProperties: false }
);
export const ReadSelectedPageResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    generation_id: OpaqueIdSchema,
    frontmatter: PageRevisionFrontmatterSchema,
    markdown: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 1_048_576, multiline: true }),
    claims: ClaimsSidecarSchema,
  },
  { additionalProperties: false }
);
export const ReadCanonicalTargetResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    capability_id: OpaqueIdSchema,
    preimage_sha256: Sha256HexSchema,
    media_type: Type.Union([
      Type.Literal("text/plain"),
      Type.Literal("text/markdown"),
      Type.Literal("application/json"),
    ]),
    content_utf8: humanTextSchema({ maxUtf8Bytes: 1_048_576, multiline: true }),
  },
  { additionalProperties: false }
);

// ── §5.13 pre-code package/retrieval/observation decisions ──────────────────

const GateDecisionBaseProperties = {
  schema_version: Type.Literal(1),
  plan_id: Type.Literal("hybrid-kb-ts-plan-2026-08-13"),
  decision_id: OpaqueIdSchema,
  approved_by_subject_id: OpaqueIdSchema,
  approved_at: Rfc3339UtcSchema,
  reviewed_by_subject_id: OpaqueIdSchema,
  reviewed_at: Rfc3339UtcSchema,
  review_sha256: Sha256HexSchema,
  evidence_refs: Type.Array(EvidenceRefSchema, { maxItems: 256 }),
} as const;

export const GateDecisionBaseV1Schema = Type.Object(GateDecisionBaseProperties, {
  additionalProperties: false,
});
export type GateDecisionBaseV1 = Static<typeof GateDecisionBaseV1Schema>;

const PackageStringMapSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 256 }),
  Type.String({ minLength: 1, maxLength: 4_096 })
);

export const PackageSurfaceDecisionV1Schema = Type.Object(
  {
    ...GateDecisionBaseProperties,
    decision_kind: Type.Literal("package_surface"),
    package_name: Type.String({ minLength: 1, maxLength: 256 }),
    package_version: Type.String({ minLength: 1, maxLength: 128 }),
    package_private: Type.Literal(true),
    exports: PackageStringMapSchema,
    bin: PackageStringMapSchema,
    scripts: PackageStringMapSchema,
    expected_pack_files: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
      minItems: 1,
    }),
  },
  { additionalProperties: false }
);
export type PackageSurfaceDecisionV1 = Static<typeof PackageSurfaceDecisionV1Schema>;

export const RetrievalFixtureCaseV1Schema = Type.Object(
  {
    case_id: OpaqueIdSchema,
    query: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 32_768, multiline: true }),
    expected_relevant: Type.Array(PageRevisionRefSchema, { minItems: 1, maxItems: 256 }),
    expected_contradictions: Type.Array(
      Type.Object(
        {
          left: Type.Object(
            {
              page_id: OpaqueIdSchema,
              revision_id: OpaqueIdSchema,
              claim_id: OpaqueIdSchema,
            },
            { additionalProperties: false }
          ),
          right: Type.Object(
            {
              page_id: OpaqueIdSchema,
              revision_id: OpaqueIdSchema,
              claim_id: OpaqueIdSchema,
            },
            { additionalProperties: false }
          ),
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_024 }
    ),
    supported_citations: Type.Array(DerivedCitationSchema, { maxItems: 1_024 }),
  },
  { additionalProperties: false }
);
export type RetrievalFixtureCaseV1 = Static<typeof RetrievalFixtureCaseV1Schema>;

export const KbRetrievalFixtureV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    fixture_id: OpaqueIdSchema,
    corpus: Type.Array(
      Type.Object(
        {
          frontmatter: PageRevisionFrontmatterSchema,
          markdown: humanTextSchema({ minUtf8Bytes: 1, maxUtf8Bytes: 1_048_576, multiline: true }),
          claims: ClaimsSidecarSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 10_000 }
    ),
    cases: Type.Array(RetrievalFixtureCaseV1Schema, { minItems: 1, maxItems: 10_000 }),
  },
  { additionalProperties: false }
);
export type KbRetrievalFixtureV1 = Static<typeof KbRetrievalFixtureV1Schema>;

export const RetrievalBaselineDecisionV1Schema = Type.Object(
  {
    ...GateDecisionBaseProperties,
    decision_kind: Type.Literal("retrieval_baseline"),
    fixture_path: Type.Literal("apps/orchestration/tests/fixtures/kb-retrieval.json"),
    fixture_sha256: Sha256HexSchema,
    case_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
    k: Type.Integer({ minimum: 1, maximum: 100 }),
    minimum_hit_at_k: Type.Number({ minimum: 0.9, maximum: 1 }),
    minimum_mrr: Type.Number({ minimum: 0.8, maximum: 1 }),
    minimum_contradiction_recall: Type.Number({ minimum: 0.95, maximum: 1 }),
    maximum_unsupported_answer_rate: Type.Number({ minimum: 0, maximum: 0.05 }),
  },
  { additionalProperties: false }
);
export type RetrievalBaselineDecisionV1 = Static<typeof RetrievalBaselineDecisionV1Schema>;

const ObservationCountKeySchema = Type.String({ pattern: /^[a-z][a-z0-9_]{0,63}$/.source });

export const ResearchObservationProjectionV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    case_id: OpaqueIdSchema,
    terminal_status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("refused"),
      Type.Literal("error"),
      Type.Literal("exhausted"),
    ]),
    met: Type.Boolean(),
    terminal_code: OpaqueIdSchema,
    result_kind: OpaqueIdSchema,
    result_sha256: Sha256HexSchema,
    evidence_sha256: Type.Array(Sha256HexSchema, { uniqueItems: true, maxItems: 1_024 }),
    warning_codes: Type.Array(OpaqueIdSchema, { uniqueItems: true, maxItems: 1_024 }),
    unresolved_codes: Type.Array(OpaqueIdSchema, { uniqueItems: true, maxItems: 1_024 }),
    safe_counts: Type.Record(
      ObservationCountKeySchema,
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
    ),
  },
  { additionalProperties: false }
);
export type ResearchObservationProjectionV1 = Static<typeof ResearchObservationProjectionV1Schema>;

export const ObservationCohortManifestV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    cohort_id: OpaqueIdSchema,
    research_fixture_sha256: Sha256HexSchema,
    normalization_rules_path: Type.Literal(
      "apps/orchestration/tests/fixtures/research-observation-normalization.json"
    ),
    normalization_rules_sha256: Sha256HexSchema,
    runtime_config_sha256: Sha256HexSchema,
    model_set_sha256: Sha256HexSchema,
    scheduled_pair_count: Type.Integer({ minimum: 50, maximum: 1_000_000 }),
    cases: Type.Array(
      Type.Object(
        {
          case_id: OpaqueIdSchema,
          repetitions: Type.Integer({ minimum: 1, maximum: 1_000 }),
          fault_mode: Type.Union([
            Type.Literal("none"),
            Type.Literal("kill_after_checkpoint"),
            Type.Literal("kill_before_terminal"),
          ]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 10_000 }
    ),
    cost_unit: Type.Literal("provider_reported_usd"),
  },
  { additionalProperties: false }
);
export type ObservationCohortManifestV1 = Static<typeof ObservationCohortManifestV1Schema>;

export const ObservationWindowDecisionV1Schema = Type.Object(
  {
    ...GateDecisionBaseProperties,
    decision_kind: Type.Literal("research_observation"),
    cohort: ObservationCohortManifestV1Schema,
    cohort_sha256: Sha256HexSchema,
    minimum_duration_hours: Type.Number({ minimum: 168 }),
    minimum_paired_terminal_runs: Type.Integer({ minimum: 50, maximum: 1_000_000 }),
    maximum_unexplained_parity_mismatches: Type.Literal(0),
    maximum_privacy_incidents: Type.Literal(0),
    maximum_recovery_failures: Type.Literal(0),
    maximum_p95_latency_ratio: Type.Number({ minimum: 1, maximum: 1.25 }),
    maximum_mean_cost_ratio: Type.Number({ minimum: 1, maximum: 1.25 }),
  },
  { additionalProperties: false }
);
export type ObservationWindowDecisionV1 = Static<typeof ObservationWindowDecisionV1Schema>;

export const GateDecisionReceiptV1Schema = Type.Union([
  PackageSurfaceDecisionV1Schema,
  RetrievalBaselineDecisionV1Schema,
  ObservationWindowDecisionV1Schema,
]);
export type GateDecisionReceiptV1 = Static<typeof GateDecisionReceiptV1Schema>;
