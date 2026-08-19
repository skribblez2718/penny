/**
 * KB contracts — the sole normative TypeBox schemas for the private knowledge base.
 *
 * Implements §§5.1–5.5 of `research/agents-md-research/IMPLEMENTATION_PLAN.md`.
 * Every schema is closed (additionalProperties: false), exact-key, and versioned.
 * TypeScript types derive through `Static<typeof Schema>`.
 *
 * These contracts are the data model the entire KB system builds on. No other
 * module may redefine these shapes — it imports them here.
 */

import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// ── Shared scalars ──────────────────────────────────────────────────────────

/** Exactly 64 lowercase hexadecimal characters. */
export const Sha256HexSchema = Type.String({
  pattern: /^[0-9a-f]{64}$/.source,
  minLength: 64,
  maxLength: 64,
});
export type Sha256Hex = Static<typeof Sha256HexSchema>;

/** 1–128 UTF-8 bytes matching [A-Za-z0-9][A-Za-z0-9._:-]{0,127} — no /, \, whitespace, or .. */
export const OpaqueIdSchema = Type.String({
  pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.source,
  minLength: 1,
  maxLength: 128,
});
export type OpaqueId = Static<typeof OpaqueIdSchema>;

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
    profiles: Type.Array(KbProfileSchema),
  },
  { additionalProperties: false }
);
export type KbProfileRegistry = Static<typeof KbProfileRegistrySchema>;

// ── §5.3 Policy ─────────────────────────────────────────────────────────────

const ModelRuleSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
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
        allowed_media_types: Type.Array(ArtifactMediaTypeSchema, { minItems: 1 }),
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
    title: Type.String({ minLength: 1, maxLength: 256 }),
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
    created_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
  },
  { additionalProperties: false }
);
export type KbManifest = Static<typeof KbManifestSchema>;

// ── §5.5 Records ────────────────────────────────────────────────────────────

const EvidenceEntrySchema = Type.Object(
  {
    source_id: SourceIdSchema,
    locator: Type.Optional(Type.String({ maxLength: 1_024 })),
    excerpt_sha256: Type.Optional(Sha256HexSchema),
  },
  { additionalProperties: false }
);

export const ClaimSchema = Type.Object(
  {
    claim_id: OpaqueIdSchema,
    text: Type.String({ minLength: 1, maxLength: 8_192 }),
    kind: ClaimKindSchema,
    state: ClaimStateSchema,
    confidence: ConfidenceSchema,
    evidence: Type.Array(EvidenceEntrySchema),
    contradicts_claim_ids: Type.Array(OpaqueIdSchema),
    canonical_verification_refs: Type.Array(OpaqueIdSchema),
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
    title: Type.String({ minLength: 1, maxLength: 256 }),
    summary: Type.String({ minLength: 1, maxLength: 1_024 }),
    authority: Type.Literal("advisory"),
    lifecycle: PageLifecycleSchema,
    created_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
    derived_from: Type.Array(OpaqueIdSchema),
    related_page_ids: Type.Array(OpaqueIdSchema),
  },
  { additionalProperties: false }
);
export type PageRevisionFrontmatter = Static<typeof PageRevisionFrontmatterSchema>;

export const SourceRecordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_id: SourceIdSchema,
    source_type: SourceTypeSchema,
    captured_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
    published_at: Type.Optional(
      Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source })
    ),
    title: Type.String({ minLength: 1, maxLength: 1_024 }),
    authors: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1 }),
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
        redacted_locator: Type.Optional(Type.String({ maxLength: 1_024 })),
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
      )
    ),
    state: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("superseded")]),
    summary: Type.String({ minLength: 1, maxLength: 4_096 }),
    evidence_refs: Type.Array(Type.String({ maxLength: 128 })),
    supersedes_conflict_record_id: Type.Optional(OpaqueIdSchema),
    created_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
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
      Type.String(),
      Type.Object(
        {
          revision_id: OpaqueIdSchema,
          page_sha256: Sha256HexSchema,
          claims_sha256: Sha256HexSchema,
        },
        { additionalProperties: false }
      )
    ),
    source_records: Type.Record(Type.String(), Sha256HexSchema),
    source_objects: Type.Array(Sha256HexSchema),
    conflict_records: Type.Record(Type.String(), Sha256HexSchema),
    index_sha256: Sha256HexSchema,
    created_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
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
    published_at: Type.String({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.source }),
  },
  { additionalProperties: false }
);
export type CurrentGeneration = Static<typeof CurrentGenerationSchema>;

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

export function validateKbContract<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string
): Static<T> {
  if (Value.Check(schema, value)) {
    return value as Static<T>;
  }
  const issues = [...Value.Errors(schema, value)].map(
    (issue) => `${issue.instancePath || "/"}: ${issue.message}`
  );
  throw new KbContractError(`${label} failed schema validation`, issues);
}

import { createHash } from "node:crypto";

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

// ── §5.6 query request (closed, exact keys) ──────────────────────────────────

export const AnswerDeliverySchema = Type.Union([
  Type.Literal("artifact_ref"),
  Type.Literal("parent_tool_result"),
]);
export type AnswerDelivery = Static<typeof AnswerDeliverySchema>;

/** RFC 3339 UTC with `Z` (fractional seconds ≤ 9 digits). */
export const Rfc3339UtcSchema = Type.String({
  pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/.source,
  minLength: 20,
  maxLength: 32,
});
export type Rfc3339Utc = Static<typeof Rfc3339UtcSchema>;

/**
 * `QueryKbRequestV1` (§5.6). Closed validation: query 1–32,768; filter ID sets
 * 0–256 and unique; `max_candidates` 1–100; `verify_grounding` and
 * `answer_delivery` default true / `artifact_ref`. `answer_delivery` is a
 * request, never a grant: `parent_tool_result` additionally requires an exact
 * unconsumed `ParentDeliveryGrantV1` plus the policy allowance.
 */
export const QueryKbRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  action: Type.Literal("query"),
  kb_profile_id: OpaqueIdSchema,
  query: Type.String({ minLength: 1, maxLength: 32_768 }),
  page_ids: Type.Optional(Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 256, uniqueItems: true })),
  source_ids: Type.Optional(Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 256, uniqueItems: true })),
  max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  verify_grounding: Type.Optional(Type.Boolean()),
  answer_delivery: Type.Optional(AnswerDeliverySchema),
}, { additionalProperties: false });
export type QueryKbRequest = Static<typeof QueryKbRequestSchema>;

// ── §5.1 parent delivery grant (host-minted, single-use) ─────────────────────

/**
 * `ParentDeliveryGrantV1` (§5.1). Host-minted out of band, stored owner-only,
 * single-use: exactly one unexpired grant whose session, invocation, action,
 * profile, `request_sha256 = SHA-256(JCS(request))`, and byte maximum all match
 * the host invocation context admits derived parent delivery; the grant store
 * then atomically consumes it by the returned run, and retries never redeliver.
 */
export const ParentDeliveryGrantSchema = Type.Object({
  schema_version: Type.Literal(1),
  grant_id: OpaqueIdSchema,
  session_id: OpaqueIdSchema,
  invocation_id: OpaqueIdSchema,
  action: Type.Literal("query"),
  kb_profile_id: OpaqueIdSchema,
  request_sha256: Sha256HexSchema,
  max_utf8_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
  issued_at: Rfc3339UtcSchema,
  expires_at: Rfc3339UtcSchema,
}, { additionalProperties: false });
export type ParentDeliveryGrant = Static<typeof ParentDeliveryGrantSchema>;

export const ParentDeliveryGrantStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("consumed"),
  Type.Literal("invalidated"),
  Type.Literal("expired"),
]);
export type ParentDeliveryGrantState = Static<typeof ParentDeliveryGrantStateSchema>;

/** `ParentDeliveryGrantStoreRecordV1` (§5.1) — the durable state row. */
export const ParentDeliveryGrantStoreRecordSchema = Type.Object({
  schema_version: Type.Literal(1),
  grant_id: OpaqueIdSchema,
  grant_sha256: Sha256HexSchema,
  state: ParentDeliveryGrantStateSchema,
  run_id: Type.Optional(OpaqueIdSchema),
  updated_at: Rfc3339UtcSchema,
}, { additionalProperties: false });
export type ParentDeliveryGrantStoreRecord = Static<typeof ParentDeliveryGrantStoreRecordSchema>;

/** The owner-only grant file: the state record plus the full grant. */
export const ParentDeliveryGrantFileSchema = Type.Object({
  schema_version: Type.Literal(1),
  record: ParentDeliveryGrantStoreRecordSchema,
  grant: ParentDeliveryGrantSchema,
}, { additionalProperties: false });
export type ParentDeliveryGrantFile = Static<typeof ParentDeliveryGrantFileSchema>;
