import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_PHP_LANGUAGE_VERSION,
  SCA_PHP_PARSER_NAME,
  SCA_PHP_PARSER_VERSION,
  createScaFindingFingerprint,
  normalizeScaFindingPath,
  resolveScaStructuralWitness,
} from "./active-symbol-resolution.js";

export const SCA_ACTIVE_MAX_CANDIDATES = 4_096;
const MAX_FILES = 100_000;
const MAX_TEXT = 4_096;
const MAX_QUOTE = 32_768;
const MAX_CITATIONS = 128;
const MAX_COVERAGE_EVIDENCE = 8;

const TextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT });
const PathSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const RawCandidateIdSchema = Type.String({ minLength: 3, maxLength: 512 });
const CanonicalCandidateIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const VulnerabilityClassSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});
const SeveritySchema = Type.Union([
  Type.Literal("critical"),
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("informational"),
]);

export const ScaSourcePointerV2Schema = Type.Object(
  {
    path: PathSchema,
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    exact_quote: Type.String({ maxLength: MAX_QUOTE }),
  },
  { additionalProperties: false }
);
export type ScaSourcePointerV2 = Readonly<Static<typeof ScaSourcePointerV2Schema>>;

export const ScaResolvedSourceCitationV2Schema = Type.Object(
  {
    path: PathSchema,
    start_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    end_line: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    source_sha256: Sha256Schema,
    cited_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaResolvedSourceCitationV2 = Readonly<
  Static<typeof ScaResolvedSourceCitationV2Schema>
>;

const SubmittedStructuralEvidenceSchema = Type.Object(
  {
    identity: ScaSourcePointerV2Schema,
    reachability: Type.Object(
      {
        explanation: TextSchema,
        entrypoint: ScaSourcePointerV2Schema,
        sink: ScaSourcePointerV2Schema,
        path: Type.Array(ScaSourcePointerV2Schema, {
          minItems: 2,
          maxItems: MAX_CITATIONS,
        }),
      },
      { additionalProperties: false }
    ),
    trust_boundary: Type.Object(
      {
        explanation: TextSchema,
        source: ScaSourcePointerV2Schema,
        sink: ScaSourcePointerV2Schema,
      },
      { additionalProperties: false }
    ),
    impact: Type.Object(
      {
        explanation: TextSchema,
        sink: ScaSourcePointerV2Schema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
type SubmittedStructuralEvidence = Readonly<Static<typeof SubmittedStructuralEvidenceSchema>>;

const StructuralWitnessSchema = Type.Object(
  {
    citation: ScaResolvedSourceCitationV2Schema,
    parser_id: Type.String({ minLength: 1, maxLength: 128 }),
    parser_language: Type.Union([
      Type.Literal("javascript"),
      Type.Literal("typescript"),
      Type.Literal("php"),
    ]),
    symbol: Type.String({ minLength: 1, maxLength: 1_024 }),
    syntax_kinds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 128,
      uniqueItems: true,
    }),
    has_data_flow_node: Type.Boolean(),
    has_effect_node: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const ScaStructuralEvidenceV2Schema = Type.Object(
  {
    identity: ScaResolvedSourceCitationV2Schema,
    reachability: Type.Object(
      {
        explanation: TextSchema,
        entrypoint: ScaResolvedSourceCitationV2Schema,
        sink: ScaResolvedSourceCitationV2Schema,
        path: Type.Array(ScaResolvedSourceCitationV2Schema, {
          minItems: 2,
          maxItems: MAX_CITATIONS,
        }),
      },
      { additionalProperties: false }
    ),
    trust_boundary: Type.Object(
      {
        explanation: TextSchema,
        source: ScaResolvedSourceCitationV2Schema,
        sink: ScaResolvedSourceCitationV2Schema,
      },
      { additionalProperties: false }
    ),
    impact: Type.Object(
      {
        explanation: TextSchema,
        sink: ScaResolvedSourceCitationV2Schema,
      },
      { additionalProperties: false }
    ),
    host_witnesses: Type.Object(
      {
        identity: StructuralWitnessSchema,
        reachability_entrypoint: StructuralWitnessSchema,
        reachability_sink: StructuralWitnessSchema,
        trust_boundary_source: StructuralWitnessSchema,
        trust_boundary_sink: StructuralWitnessSchema,
        impact_sink: StructuralWitnessSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaStructuralEvidenceV2 = Readonly<Static<typeof ScaStructuralEvidenceV2Schema>>;

const AnalyzedCoverageRecordSchema = Type.Object(
  {
    path: PathSchema,
    status: Type.Literal("analyzed"),
    analysis_summary: TextSchema,
    evidence: Type.Array(ScaSourcePointerV2Schema, { maxItems: MAX_COVERAGE_EVIDENCE }),
    candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    limitations: Type.Array(TextSchema, { maxItems: 32 }),
  },
  { additionalProperties: false }
);

const UnsuccessfulCoverageRecordSchema = Type.Object(
  {
    path: PathSchema,
    status: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("unread"),
      Type.Literal("unsupported"),
    ]),
    reason: TextSchema,
  },
  { additionalProperties: false }
);

export const ScaCoverageRecordV2Schema = Type.Union([
  AnalyzedCoverageRecordSchema,
  UnsuccessfulCoverageRecordSchema,
]);
export type ScaCoverageRecordV2 = Readonly<Static<typeof ScaCoverageRecordV2Schema>>;

export const ScaAnalysisSummaryV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    complete: Type.Literal(true),
    profile_id: Type.Union([Type.Literal("primary_a"), Type.Literal("primary_b")]),
    candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    confirmed_candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    rejected_candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    inconclusive_candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    coverage_records: Type.Array(ScaCoverageRecordV2Schema, { maxItems: MAX_FILES }),
    gaps: Type.Array(TextSchema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaAnalysisSummaryV2 = Readonly<Static<typeof ScaAnalysisSummaryV2Schema>>;

const ConfirmedCandidateSchema = Type.Object(
  {
    canonical_id: CanonicalCandidateIdSchema,
    raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
      minItems: 1,
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    disposition: Type.Literal("confirmed"),
    title: TextSchema,
    vulnerability_class: VulnerabilityClassSchema,
    severity: SeveritySchema,
    explanation: TextSchema,
    impact: TextSchema,
    prerequisites: Type.Array(TextSchema, { maxItems: 32 }),
    limitations: Type.Array(TextSchema, { maxItems: 32 }),
    application_specific_remediation: TextSchema,
    structural_evidence: SubmittedStructuralEvidenceSchema,
  },
  { additionalProperties: false }
);

const RejectedCandidateSchema = Type.Object(
  {
    canonical_id: CanonicalCandidateIdSchema,
    raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
      minItems: 1,
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    disposition: Type.Literal("rejected"),
    reason: TextSchema,
  },
  { additionalProperties: false }
);

const InconclusiveCandidateSchema = Type.Object(
  {
    canonical_id: CanonicalCandidateIdSchema,
    raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
      minItems: 1,
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    disposition: Type.Literal("inconclusive"),
    reason: TextSchema,
  },
  { additionalProperties: false }
);

const CoverageAssessmentSchema = Type.Object(
  {
    obligation_id: Type.String({ pattern: "^scacov_[a-f0-9]{64}$" }),
    profile_id: Type.Union([Type.Literal("primary_a"), Type.Literal("primary_b")]),
    coverage_record_sha256: Sha256Schema,
    assessment: Type.Union([Type.Literal("credible"), Type.Literal("not_credible")]),
    reason: TextSchema,
  },
  { additionalProperties: false }
);
export type ScaCoverageAssessmentV2 = Readonly<Static<typeof CoverageAssessmentSchema>>;

export const ScaReviewSummaryV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("GAP")]),
    coverage_assessments: Type.Array(CoverageAssessmentSchema, { maxItems: MAX_FILES * 2 }),
    canonical_candidates: Type.Array(
      Type.Union([ConfirmedCandidateSchema, RejectedCandidateSchema, InconclusiveCandidateSchema]),
      { maxItems: SCA_ACTIVE_MAX_CANDIDATES }
    ),
    gaps: Type.Array(TextSchema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaReviewSummaryV2 = Readonly<Static<typeof ScaReviewSummaryV2Schema>>;
type ConfirmedCandidate = Extract<
  ScaReviewSummaryV2["canonical_candidates"][number],
  { disposition: "confirmed" }
>;

const InventoryFileSchema = Type.Object(
  {
    path: PathSchema,
    byte_length: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const StructuralParserBlockerSchema = Type.Object(
  {
    path: PathSchema,
    language: Type.Literal("php"),
    reason_code: Type.Literal("parser_dependency_unavailable"),
    detail: TextSchema,
  },
  { additionalProperties: false }
);

export const ScaHostStaticInventoryV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-host-static-inventory.v2"),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    computed_source_snapshot_sha256: Sha256Schema,
    scope: Type.Object(
      {
        include: Type.Array(PathSchema, { maxItems: 256 }),
        exclude: Type.Array(PathSchema, { maxItems: 256 }),
      },
      { additionalProperties: false }
    ),
    model_invocation_count: Type.Literal(0),
    discovery_mode: Type.Literal("independent_full_source_analysis"),
    file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
    byte_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    files: Type.Array(InventoryFileSchema, { maxItems: MAX_FILES }),
    source_corpus_text_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
    source_corpus_exclusions: Type.Array(
      Type.Object(
        { path: PathSchema, reason: Type.Literal("binary_or_non_utf8") },
        { additionalProperties: false }
      ),
      { maxItems: MAX_FILES }
    ),
    structural_parser_blockers: Type.Array(StructuralParserBlockerSchema, { maxItems: MAX_FILES }),
    source_corpus_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    source_corpus_sha256: Sha256Schema,
    analysis_gaps: Type.Array(TextSchema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaHostStaticInventoryV2 = Readonly<Static<typeof ScaHostStaticInventoryV2Schema>>;

const ResolvedAnalyzedCoverageRecordSchema = Type.Object(
  {
    path: PathSchema,
    status: Type.Literal("analyzed"),
    analysis_summary: TextSchema,
    evidence: Type.Array(ScaResolvedSourceCitationV2Schema, {
      maxItems: MAX_COVERAGE_EVIDENCE,
    }),
    candidate_ids: Type.Array(RawCandidateIdSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      uniqueItems: true,
    }),
    limitations: Type.Array(TextSchema, { maxItems: 32 }),
    coverage_record_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ResolvedCoverageDispositionSchema = Type.Union([
  ResolvedAnalyzedCoverageRecordSchema,
  UnsuccessfulCoverageRecordSchema,
  Type.Object(
    { path: PathSchema, status: Type.Literal("missing"), reason: TextSchema },
    { additionalProperties: false }
  ),
]);
type ResolvedCoverageDisposition = Readonly<Static<typeof ResolvedCoverageDispositionSchema>>;

const CoverageReviewSchema = Type.Union([
  Type.Null(),
  Type.Object(
    {
      coverage_record_sha256: Sha256Schema,
      assessment: Type.Union([Type.Literal("credible"), Type.Literal("not_credible")]),
      reason: TextSchema,
    },
    { additionalProperties: false }
  ),
]);

const HostStructuralStatusSchema = Type.Union([
  Type.Object(
    { status: Type.Literal("available_or_not_required") },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("blocked"),
      reason_code: Type.Literal("parser_dependency_unavailable"),
      detail: TextSchema,
    },
    { additionalProperties: false }
  ),
]);

export const ScaCoverageLedgerV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    obligations: Type.Array(
      Type.Object(
        {
          obligation_id: Type.String({ pattern: "^scacov_[a-f0-9]{64}$" }),
          path: PathSchema,
          host_inventory_status: Type.Literal("captured"),
          source_context_status: Type.Union([
            Type.Literal("available"),
            Type.Literal("unsupported"),
          ]),
          host_structural_status: HostStructuralStatusSchema,
          primary_a: ResolvedCoverageDispositionSchema,
          primary_b: ResolvedCoverageDispositionSchema,
          primary_a_review: CoverageReviewSchema,
          primary_b_review: CoverageReviewSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: MAX_FILES }
    ),
    analysis_admission_gate: Type.Object(
      {
        owner: Type.Literal("host"),
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
        issue_count: Type.Integer({ minimum: 0, maximum: MAX_FILES * 8 }),
      },
      { additionalProperties: false }
    ),
    completeness_gate: Type.Object(
      {
        owner: Type.Literal("host"),
        status: Type.Union([
          Type.Literal("pending_independent_review"),
          Type.Literal("passed"),
          Type.Literal("failed"),
        ]),
        admitted_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        accounted_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        issue_count: Type.Integer({ minimum: 0, maximum: MAX_FILES * 10 }),
      },
      { additionalProperties: false }
    ),
    no_candidate_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
  },
  { additionalProperties: false }
);
export type ScaCoverageLedgerV1 = Readonly<Static<typeof ScaCoverageLedgerV1Schema>>;

const FingerprintSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    path: PathSchema,
    symbol: Type.String({ minLength: 1, maxLength: 1_024 }),
    vulnerability_class: VulnerabilityClassSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ExploitationStatusSchema = Type.Object(
  {
    status: Type.Literal("not_run"),
    exploited: Type.Literal(false),
    independent_reproduction_receipt_refs: Type.Array(Type.Never(), { maxItems: 0 }),
  },
  { additionalProperties: false }
);

const PromotedFindingSchema = Type.Object(
  {
    finding_id: Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }),
    fingerprint: FingerprintSchema,
    title: TextSchema,
    severity: SeveritySchema,
    explanation: TextSchema,
    impact: TextSchema,
    prerequisites: Type.Array(TextSchema, { maxItems: 32 }),
    limitations: Type.Array(TextSchema, { maxItems: 32 }),
    application_specific_remediation: TextSchema,
    evidence_revision: Type.Object(
      {
        source_snapshot_sha256: Sha256Schema,
        parser_id: Type.String({ minLength: 1, maxLength: 128 }),
        parser_language: Type.Union([
          Type.Literal("javascript"),
          Type.Literal("typescript"),
          Type.Literal("php"),
        ]),
        structural_evidence: ScaStructuralEvidenceV2Schema,
      },
      { additionalProperties: false }
    ),
    exploitation: ExploitationStatusSchema,
  },
  { additionalProperties: false }
);

const DemotionReasonSchema = Type.Union([
  Type.Literal("citation_path_unresolved"),
  Type.Literal("citation_range_invalid"),
  Type.Literal("citation_quote_mismatch"),
  Type.Literal("unsupported_language"),
  Type.Literal("parser_dependency_unavailable"),
  Type.Literal("parser_diagnostics"),
  Type.Literal("unresolvable_symbol"),
  Type.Literal("structural_evidence_insufficient"),
  Type.Literal("duplicate_structural_fingerprint"),
]);

const HostCandidateSchema = Type.Union([
  Type.Object(
    {
      canonical_id: CanonicalCandidateIdSchema,
      raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
        minItems: 1,
        maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      }),
      disposition: Type.Literal("confirmed"),
      finding: PromotedFindingSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      canonical_id: CanonicalCandidateIdSchema,
      raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
        minItems: 1,
        maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      }),
      disposition: Type.Literal("rejected"),
      review_reason: TextSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      canonical_id: CanonicalCandidateIdSchema,
      raw_candidate_ids: Type.Array(RawCandidateIdSchema, {
        minItems: 1,
        maxItems: SCA_ACTIVE_MAX_CANDIDATES,
      }),
      disposition: Type.Literal("inconclusive"),
      review_reason: TextSchema,
      demotion: Type.Union([
        Type.Null(),
        Type.Object(
          { reason_code: DemotionReasonSchema, detail: TextSchema },
          { additionalProperties: false }
        ),
      ]),
      submitted_confirmation: Type.Union([ConfirmedCandidateSchema, Type.Null()]),
    },
    { additionalProperties: false }
  ),
]);

const DispositionTotalsSchema = Type.Object(
  {
    confirmed: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    rejected: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    inconclusive: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
  },
  { additionalProperties: false }
);

const ArtifactDigestRefSchema = Type.Object(
  {
    artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaEvidenceProvenanceV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    source_corpus: ArtifactDigestRefSchema,
    inventory: ArtifactDigestRefSchema,
    analyses: Type.Array(
      Type.Object(
        {
          profile_id: Type.Union([Type.Literal("primary_a"), Type.Literal("primary_b")]),
          artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 2, maxItems: 2 }
    ),
    candidate_ledger: ArtifactDigestRefSchema,
    review: ArtifactDigestRefSchema,
    structural_engine: Type.Object(
      {
        name: Type.Literal("typescript-compiler-api"),
        version: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false }
    ),
    php_structural_parser: Type.Union([
      Type.Object(
        {
          status: Type.Literal("available"),
          name: Type.Literal(SCA_PHP_PARSER_NAME),
          version: Type.Literal(SCA_PHP_PARSER_VERSION),
          php_language_version: Type.Literal(SCA_PHP_LANGUAGE_VERSION),
          parse_api: Type.Literal("parseCode"),
          ast_positions: Type.Literal(true),
          evaluates_source: Type.Literal(false),
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          status: Type.Literal("unavailable"),
          reason_code: Type.Literal("parser_dependency_unavailable"),
          detail: TextSchema,
        },
        { additionalProperties: false }
      ),
    ]),
    protocol_ids: Type.Tuple([
      Type.Literal("penny.sca-independent-full-source-analysis.v1"),
      Type.Literal("penny.sca-host-quoted-structural-evidence.v1"),
    ]),
  },
  { additionalProperties: false }
);
export type ScaEvidenceProvenanceV1 = Readonly<Static<typeof ScaEvidenceProvenanceV1Schema>>;

export const ScaDispositionLedgerV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-disposition-ledger.v2"),
    schema_version: Type.Literal(2),
    source_snapshot_sha256: Sha256Schema,
    raw_candidate_count: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    canonical_candidate_count: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    finding_count: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    disposition_totals: DispositionTotalsSchema,
    coverage: ScaCoverageLedgerV1Schema,
    adjudication_gate: Type.Object(
      {
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
        host_demoted_confirmation_count: Type.Integer({
          minimum: 0,
          maximum: SCA_ACTIVE_MAX_CANDIDATES,
        }),
      },
      { additionalProperties: false }
    ),
    provenance: ScaEvidenceProvenanceV1Schema,
    canonical_candidates: Type.Array(HostCandidateSchema, {
      maxItems: SCA_ACTIVE_MAX_CANDIDATES,
    }),
    reviewer_gaps: Type.Array(TextSchema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaDispositionLedgerV2 = Readonly<Static<typeof ScaDispositionLedgerV2Schema>>;

const AggregateGapSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("blocked_source_units"),
      Type.Literal("unread_source_units"),
      Type.Literal("unsupported_source_units"),
      Type.Literal("inconclusive_candidates"),
    ]),
    count: Type.Integer({ minimum: 0, maximum: MAX_FILES * 2 }),
  },
  { additionalProperties: false }
);

export const ScaReleaseProjectionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-release-projection.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    disposition_ledger_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    disposition_ledger_sha256: Sha256Schema,
    promoted_finding_count: Type.Integer({ minimum: 0, maximum: SCA_ACTIVE_MAX_CANDIDATES }),
    findings: Type.Array(PromotedFindingSchema, { maxItems: SCA_ACTIVE_MAX_CANDIDATES }),
    provenance: ScaEvidenceProvenanceV1Schema,
    coverage: Type.Object(
      {
        completeness_gate: Type.Literal("passed"),
        admitted_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        no_candidate_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
        analyzed_profile_records: Type.Integer({ minimum: 0, maximum: MAX_FILES * 2 }),
        disposition_totals: DispositionTotalsSchema,
        aggregate_gaps: Type.Array(AggregateGapSchema, { minItems: 4, maxItems: 4 }),
      },
      { additionalProperties: false }
    ),
    evidence_limit: Type.Literal(
      "host_verified_pointers_and_syntax_require_independent_semantic_review"
    ),
  },
  { additionalProperties: false }
);
export type ScaReleaseProjectionV1 = Readonly<Static<typeof ScaReleaseProjectionV1Schema>>;

const CorpusMetadataSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-source-corpus.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Sha256Schema,
    text_file_count: Type.Integer({ minimum: 0, maximum: MAX_FILES }),
    excluded_files: Type.Array(
      Type.Object(
        { path: PathSchema, reason: Type.Literal("binary_or_non_utf8") },
        { additionalProperties: false }
      ),
      { maxItems: MAX_FILES }
    ),
    frame_format: TextSchema,
  },
  { additionalProperties: false }
);

const CorpusFrameMetadataSchema = Type.Object(
  {
    path: PathSchema,
    byte_length: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

interface SealedSourceFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly content_sha256: string;
}

export interface ParsedScaSourceCorpusV1 {
  readonly source_snapshot_sha256: string;
  readonly excluded_paths: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, SealedSourceFile>;
}

export class ScaActiveComplianceError extends Error {
  constructor(
    readonly code:
      | "invalid_corpus"
      | "inventory_binding_mismatch"
      | "coverage_incomplete"
      | "candidate_mapping_invalid"
      | "citation_path_unresolved"
      | "citation_range_invalid"
      | "citation_quote_mismatch"
      | "unsupported_language"
      | "parser_dependency_unavailable"
      | "parser_diagnostics"
      | "unresolvable_symbol"
      | "structural_evidence_insufficient"
      | "duplicate_structural_fingerprint",
    message: string
  ) {
    super(message);
    this.name = "ScaActiveComplianceError";
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ScaActiveComplianceError("invalid_corpus", `${label} is not valid JSON`);
  }
}

function readHeaderLine(
  bytes: Buffer,
  offset: number,
  label: string
): { text: string; next: number } {
  const newline = bytes.indexOf(0x0a, offset);
  if (newline < 0) {
    throw new ScaActiveComplianceError("invalid_corpus", `${label} has no terminating newline`);
  }
  return { text: bytes.subarray(offset, newline).toString("utf8"), next: newline + 1 };
}

/** Parse host framing by declared byte length so delimiter-like source text cannot alter structure. */
export function parseSealedScaSourceCorpusV1(bytes: Buffer): ParsedScaSourceCorpusV1 {
  const top = readHeaderLine(bytes, 0, "SCA corpus metadata");
  const metadata = validateContract(
    CorpusMetadataSchema,
    parseJson(top.text, "SCA corpus metadata"),
    "SCA corpus metadata"
  );
  const prefix = "SCA_SOURCE_FILE ";
  const suffix = Buffer.from("\nSCA_SOURCE_FILE_END\n", "utf8");
  const files = new Map<string, SealedSourceFile>();
  let offset = top.next;
  while (offset < bytes.byteLength) {
    const header = readHeaderLine(bytes, offset, "SCA source frame");
    if (!header.text.startsWith(prefix)) {
      throw new ScaActiveComplianceError("invalid_corpus", "SCA source frame prefix is invalid");
    }
    const frame = validateContract(
      CorpusFrameMetadataSchema,
      parseJson(header.text.slice(prefix.length), "SCA source frame metadata"),
      "SCA source frame metadata"
    );
    normalizeScaFindingPath(frame.path);
    const bodyEnd = header.next + frame.byte_length;
    const suffixEnd = bodyEnd + suffix.byteLength;
    if (bodyEnd > bytes.byteLength || suffixEnd > bytes.byteLength) {
      throw new ScaActiveComplianceError(
        "invalid_corpus",
        `SCA source frame '${frame.path}' is truncated`
      );
    }
    const body = bytes.subarray(header.next, bodyEnd);
    if (!bytes.subarray(bodyEnd, suffixEnd).equals(suffix)) {
      throw new ScaActiveComplianceError(
        "invalid_corpus",
        `SCA source frame '${frame.path}' suffix is invalid`
      );
    }
    if (sha256(body) !== frame.content_sha256) {
      throw new ScaActiveComplianceError(
        "invalid_corpus",
        `SCA source frame '${frame.path}' digest is invalid`
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new ScaActiveComplianceError(
        "invalid_corpus",
        `SCA source frame '${frame.path}' is not UTF-8`
      );
    }
    if (files.has(frame.path)) {
      throw new ScaActiveComplianceError(
        "invalid_corpus",
        `SCA source frame '${frame.path}' is duplicated`
      );
    }
    files.set(frame.path, {
      path: frame.path,
      bytes: Buffer.from(body),
      text,
      content_sha256: frame.content_sha256,
    });
    offset = suffixEnd;
  }
  if (files.size !== metadata.text_file_count) {
    throw new ScaActiveComplianceError(
      "invalid_corpus",
      "SCA corpus text-file count is inconsistent"
    );
  }
  const excludedPaths = new Set(metadata.excluded_files.map((entry) => entry.path));
  if (excludedPaths.size !== metadata.excluded_files.length) {
    throw new ScaActiveComplianceError(
      "invalid_corpus",
      "SCA corpus exclusion paths are duplicated"
    );
  }
  return {
    source_snapshot_sha256: metadata.source_snapshot_sha256,
    excluded_paths: excludedPaths,
    files,
  };
}

export function validateScaInventoryCorpusBinding(input: {
  readonly inventory: unknown;
  readonly corpus: ParsedScaSourceCorpusV1;
  readonly expected_source_snapshot_sha256: string;
}): ScaHostStaticInventoryV2 {
  const inventory = validateContract(
    ScaHostStaticInventoryV2Schema,
    input.inventory,
    "SCA host static inventory"
  );
  if (
    inventory.source_snapshot_sha256 !== input.expected_source_snapshot_sha256 ||
    inventory.computed_source_snapshot_sha256 !== input.expected_source_snapshot_sha256 ||
    input.corpus.source_snapshot_sha256 !== input.expected_source_snapshot_sha256
  ) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory, corpus, and admitted snapshot digests differ"
    );
  }
  if (inventory.file_count !== inventory.files.length) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory file count differs from its file records"
    );
  }
  if (
    inventory.byte_count !== inventory.files.reduce((total, file) => total + file.byte_length, 0)
  ) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory byte count differs from its file records"
    );
  }
  const derivedSnapshotSha256 = sha256(
    canonicalJson({
      schema_id: "penny.sca-source-snapshot.v1",
      schema_version: 1,
      scope: inventory.scope,
      files: inventory.files,
    })
  );
  if (derivedSnapshotSha256 !== input.expected_source_snapshot_sha256) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory file records do not derive the admitted snapshot digest"
    );
  }
  const paths = inventory.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory file paths are duplicated"
    );
  }
  const exclusions = new Set(inventory.source_corpus_exclusions.map((entry) => entry.path));
  if (
    exclusions.size !== inventory.source_corpus_exclusions.length ||
    exclusions.size !== input.corpus.excluded_paths.size ||
    [...exclusions].some((candidate) => !input.corpus.excluded_paths.has(candidate))
  ) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA inventory and corpus exclusions differ"
    );
  }
  for (const file of inventory.files) {
    normalizeScaFindingPath(file.path);
    const source = input.corpus.files.get(file.path);
    if (source === undefined) {
      if (!exclusions.has(file.path)) {
        throw new ScaActiveComplianceError(
          "inventory_binding_mismatch",
          `SCA inventory path '${file.path}' is absent from corpus and exclusions`
        );
      }
      continue;
    }
    if (
      source.bytes.byteLength !== file.byte_length ||
      source.content_sha256 !== file.content_sha256
    ) {
      throw new ScaActiveComplianceError(
        "inventory_binding_mismatch",
        `SCA inventory path '${file.path}' differs from the sealed corpus`
      );
    }
  }
  if (
    input.corpus.files.size + exclusions.size !== inventory.files.length ||
    inventory.source_corpus_text_file_count !== input.corpus.files.size
  ) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA corpus coverage does not equal the admitted file set"
    );
  }
  const declaredBlockers = new Map(
    inventory.structural_parser_blockers.map((blocker) => [blocker.path, blocker])
  );
  if (declaredBlockers.size !== inventory.structural_parser_blockers.length) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA structural parser blocker paths are duplicated"
    );
  }
  if (declaredBlockers.size !== 0) {
    throw new ScaActiveComplianceError(
      "inventory_binding_mismatch",
      "SCA structural parser blocker inventory does not match host capabilities"
    );
  }
  return inventory;
}

export function validateScaAnalysisSummaryV2(value: unknown, label: string): ScaAnalysisSummaryV2 {
  const summary = validateContract(ScaAnalysisSummaryV2Schema, value, label);
  const candidates = new Set(summary.candidate_ids);
  const partitions = [
    ...summary.confirmed_candidate_ids,
    ...summary.rejected_candidate_ids,
    ...summary.inconclusive_candidate_ids,
  ];
  if (
    partitions.length !== candidates.size ||
    new Set(partitions).size !== partitions.length ||
    partitions.some((candidate) => !candidates.has(candidate))
  ) {
    throw new Error(`${label} candidate dispositions must partition candidate_ids exactly once`);
  }
  const prefix = `${summary.profile_id}:`;
  if (summary.candidate_ids.some((candidate) => !candidate.startsWith(prefix))) {
    throw new Error(`${label} candidate IDs must use ${prefix} ownership`);
  }
  const coveredCandidates = new Set(
    summary.coverage_records.flatMap((record) =>
      record.status === "analyzed" ? record.candidate_ids : []
    )
  );
  if (
    coveredCandidates.size !== candidates.size ||
    [...coveredCandidates].some((candidate) => !candidates.has(candidate))
  ) {
    throw new Error(`${label} coverage records must map every candidate to a source unit`);
  }
  return summary;
}

function sourceLines(source: string): readonly string[] {
  return source.split(/\r\n|\n|\r/u);
}

function resolveCitation(
  pointer: ScaSourcePointerV2,
  corpus: ParsedScaSourceCorpusV1
): ScaResolvedSourceCitationV2 {
  let normalized: string;
  try {
    normalized = normalizeScaFindingPath(pointer.path);
  } catch (error) {
    throw new ScaActiveComplianceError(
      "citation_path_unresolved",
      error instanceof Error ? error.message : "Citation path is invalid"
    );
  }
  const source = corpus.files.get(normalized);
  if (source === undefined) {
    throw new ScaActiveComplianceError(
      "citation_path_unresolved",
      `Citation path '${normalized}' is not readable in the sealed source corpus.`
    );
  }
  const lines = sourceLines(source.text);
  if (pointer.end_line < pointer.start_line || pointer.end_line > lines.length) {
    throw new ScaActiveComplianceError(
      "citation_range_invalid",
      `Citation range ${normalized}:${pointer.start_line}-${pointer.end_line} does not resolve.`
    );
  }
  const cited = lines.slice(pointer.start_line - 1, pointer.end_line).join("\n");
  if (cited !== pointer.exact_quote) {
    throw new ScaActiveComplianceError(
      "citation_quote_mismatch",
      `Citation quote ${normalized}:${pointer.start_line}-${pointer.end_line} does not match sealed bytes.`
    );
  }
  return {
    path: normalized,
    start_line: pointer.start_line,
    end_line: pointer.end_line,
    source_sha256: source.content_sha256,
    cited_sha256: sha256(cited),
  };
}

function coverageRecordsByPath(summary: ScaAnalysisSummaryV2): {
  readonly records: ReadonlyMap<string, ScaCoverageRecordV2>;
  readonly issues: number;
} {
  const records = new Map<string, ScaCoverageRecordV2>();
  let issues = 0;
  for (const record of summary.coverage_records) {
    try {
      normalizeScaFindingPath(record.path);
    } catch {
      issues += 1;
      continue;
    }
    if (records.has(record.path)) issues += 1;
    else records.set(record.path, record);
  }
  return { records, issues };
}

function resolveCoverageRecord(input: {
  readonly record: ScaCoverageRecordV2;
  readonly corpus: ParsedScaSourceCorpusV1;
  readonly profileId: "primary_a" | "primary_b";
}): { readonly value: ResolvedCoverageDisposition; readonly issues: number } {
  const { record } = input;
  if (record.status !== "analyzed") return { value: record, issues: 1 };
  const source = input.corpus.files.get(record.path);
  if (source === undefined) {
    return {
      value: {
        path: record.path,
        status: "unsupported",
        reason: "The source unit is unavailable in the sealed text corpus.",
      },
      issues: 1,
    };
  }
  let issues = 0;
  const evidence: ScaResolvedSourceCitationV2[] = [];
  for (const pointer of record.evidence) {
    if (pointer.path !== record.path) {
      issues += 1;
      continue;
    }
    try {
      evidence.push(resolveCitation(pointer, input.corpus));
    } catch {
      issues += 1;
    }
  }
  if (source.bytes.byteLength > 0 && evidence.length === 0) issues += 1;
  const stableRecord = {
    path: record.path,
    status: "analyzed" as const,
    analysis_summary: record.analysis_summary,
    evidence,
    candidate_ids: record.candidate_ids,
    limitations: record.limitations,
  };
  return {
    value: {
      ...stableRecord,
      coverage_record_sha256: sha256(
        canonicalJson({ profile_id: input.profileId, coverage_record: stableRecord })
      ),
    },
    issues,
  };
}

/** Build source-bound per-unit records. Independent review must still finalize credibility. */
export function buildScaCoverageLedgerV1(input: {
  readonly inventory: ScaHostStaticInventoryV2;
  readonly corpus: ParsedScaSourceCorpusV1;
  readonly summaries: readonly ScaAnalysisSummaryV2[];
}): ScaCoverageLedgerV1 {
  const a = input.summaries.find((summary) => summary.profile_id === "primary_a");
  const b = input.summaries.find((summary) => summary.profile_id === "primary_b");
  if (a === undefined || b === undefined || input.summaries.length !== 2) {
    throw new ScaActiveComplianceError(
      "coverage_incomplete",
      "SCA coverage requires both primary profiles"
    );
  }
  const maps = { primary_a: coverageRecordsByPath(a), primary_b: coverageRecordsByPath(b) };
  const admitted = new Set(input.inventory.files.map((file) => file.path));
  let issueCount = maps.primary_a.issues + maps.primary_b.issues;
  for (const map of [maps.primary_a.records, maps.primary_b.records]) {
    issueCount += [...map.keys()].filter((candidate) => !admitted.has(candidate)).length;
  }
  const blockers = new Map(
    input.inventory.structural_parser_blockers.map((blocker) => [blocker.path, blocker])
  );
  const obligations = input.inventory.files.map((file) => {
    const excluded = input.inventory.source_corpus_exclusions.some(
      (entry) => entry.path === file.path
    );
    const select = (profile: "primary_a" | "primary_b"): ResolvedCoverageDisposition => {
      const record = maps[profile].records.get(file.path);
      if (record === undefined) {
        issueCount += 1;
        return {
          path: file.path,
          status: "missing",
          reason: `Host did not receive a ${profile} coverage record for this admitted source unit.`,
        };
      }
      if (excluded) {
        issueCount += 1;
        return record.status === "analyzed"
          ? {
              path: file.path,
              status: "unsupported",
              reason:
                "The admitted source unit is binary or non-UTF-8 and has no sealed text context.",
            }
          : record;
      }
      const resolved = resolveCoverageRecord({ record, corpus: input.corpus, profileId: profile });
      issueCount += resolved.issues;
      return resolved.value;
    };
    const blocker = blockers.get(file.path);
    if (blocker !== undefined) issueCount += 1;
    return {
      obligation_id: `scacov_${sha256(
        canonicalJson({
          source_snapshot_sha256: input.inventory.source_snapshot_sha256,
          path: file.path,
        })
      )}`,
      path: file.path,
      host_inventory_status: "captured" as const,
      source_context_status: excluded ? ("unsupported" as const) : ("available" as const),
      host_structural_status:
        blocker === undefined
          ? ({ status: "available_or_not_required" } as const)
          : ({
              status: "blocked",
              reason_code: blocker.reason_code,
              detail: blocker.detail,
            } as const),
      primary_a: select("primary_a"),
      primary_b: select("primary_b"),
      primary_a_review: null,
      primary_b_review: null,
    };
  });
  const accounted = obligations.filter(
    (obligation) =>
      obligation.primary_a.status !== "missing" && obligation.primary_b.status !== "missing"
  ).length;
  const candidatePaths = new Set(
    obligations.flatMap((obligation) =>
      [obligation.primary_a, obligation.primary_b].flatMap((record) =>
        record.status === "analyzed" && record.candidate_ids.length > 0 ? [obligation.path] : []
      )
    )
  );
  return validateContract(
    ScaCoverageLedgerV1Schema,
    {
      schema_version: 1,
      obligations,
      analysis_admission_gate: {
        owner: "host",
        status: issueCount === 0 ? "passed" : "failed",
        issue_count: issueCount,
      },
      completeness_gate: {
        owner: "host",
        status: issueCount === 0 ? "pending_independent_review" : "failed",
        admitted_file_count: input.inventory.files.length,
        accounted_file_count: accounted,
        issue_count: issueCount,
      },
      no_candidate_file_count: input.inventory.files.filter(
        (file) => !candidatePaths.has(file.path)
      ).length,
    },
    "SCA host coverage ledger"
  );
}

export function finalizeScaCoverageLedgerV1(input: {
  readonly coverage: ScaCoverageLedgerV1;
  readonly assessments: readonly ScaCoverageAssessmentV2[];
}): ScaCoverageLedgerV1 {
  const expected = new Map<
    string,
    {
      readonly obligationId: string;
      readonly profileId: "primary_a" | "primary_b";
      readonly recordSha256: string;
    }
  >();
  for (const obligation of input.coverage.obligations) {
    for (const profileId of ["primary_a", "primary_b"] as const) {
      const record = obligation[profileId];
      if (record.status !== "analyzed") continue;
      expected.set(`${obligation.obligation_id}:${profileId}`, {
        obligationId: obligation.obligation_id,
        profileId,
        recordSha256: record.coverage_record_sha256,
      });
    }
  }
  const received = new Map<string, ScaCoverageAssessmentV2>();
  let issueCount = input.coverage.analysis_admission_gate.issue_count;
  for (const assessment of input.assessments) {
    const key = `${assessment.obligation_id}:${assessment.profile_id}`;
    const expectedAssessment = expected.get(key);
    if (
      received.has(key) ||
      expectedAssessment === undefined ||
      expectedAssessment.recordSha256 !== assessment.coverage_record_sha256
    ) {
      issueCount += 1;
      continue;
    }
    received.set(key, assessment);
    if (assessment.assessment !== "credible") issueCount += 1;
  }
  issueCount += [...expected.keys()].filter((key) => !received.has(key)).length;
  const obligations = input.coverage.obligations.map((obligation) => {
    const review = (profileId: "primary_a" | "primary_b") => {
      const record = obligation[profileId];
      if (record.status !== "analyzed") return null;
      const assessment = received.get(`${obligation.obligation_id}:${profileId}`);
      return assessment === undefined
        ? null
        : {
            coverage_record_sha256: assessment.coverage_record_sha256,
            assessment: assessment.assessment,
            reason: assessment.reason,
          };
    };
    return {
      ...obligation,
      primary_a_review: review("primary_a"),
      primary_b_review: review("primary_b"),
    };
  });
  return validateContract(
    ScaCoverageLedgerV1Schema,
    {
      ...input.coverage,
      obligations,
      completeness_gate: {
        ...input.coverage.completeness_gate,
        status: issueCount === 0 ? "passed" : "failed",
        issue_count: issueCount,
      },
    },
    "SCA independently reviewed coverage ledger"
  );
}

function pointerEquals(left: ScaSourcePointerV2, right: ScaSourcePointerV2): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function structuralWitness(input: {
  readonly pointer: ScaSourcePointerV2;
  readonly corpus: ParsedScaSourceCorpusV1;
}): Static<typeof StructuralWitnessSchema> {
  const citation = resolveCitation(input.pointer, input.corpus);
  const source = input.corpus.files.get(citation.path);
  if (source === undefined) {
    throw new ScaActiveComplianceError(
      "citation_path_unresolved",
      `Structural witness path '${citation.path}' is absent from the sealed source corpus.`
    );
  }
  const resolution = resolveScaStructuralWitness({
    path: citation.path,
    source: source.text,
    start_line: citation.start_line,
    end_line: citation.end_line,
  });
  if (resolution.status === "unsupported") {
    throw new ScaActiveComplianceError(resolution.reason_code, resolution.detail);
  }
  return {
    citation,
    parser_id: resolution.parser_id,
    parser_language: resolution.language,
    symbol: resolution.symbol,
    syntax_kinds: [...resolution.syntax_kinds],
    has_data_flow_node: resolution.has_data_flow_node,
    has_effect_node: resolution.has_effect_node,
  };
}

function resolveStructuralEvidence(
  evidence: SubmittedStructuralEvidence,
  corpus: ParsedScaSourceCorpusV1
): ScaStructuralEvidenceV2 {
  const firstPath = evidence.reachability.path[0];
  const lastPath = evidence.reachability.path.at(-1);
  if (
    firstPath === undefined ||
    lastPath === undefined ||
    !pointerEquals(firstPath, evidence.reachability.entrypoint) ||
    !pointerEquals(lastPath, evidence.reachability.sink)
  ) {
    throw new ScaActiveComplianceError(
      "structural_evidence_insufficient",
      "Reachability path must begin at the exact entrypoint pointer and end at the exact sink pointer."
    );
  }
  const identity = structuralWitness({ pointer: evidence.identity, corpus });
  const entrypoint = structuralWitness({ pointer: evidence.reachability.entrypoint, corpus });
  const sink = structuralWitness({ pointer: evidence.reachability.sink, corpus });
  const trustSource = structuralWitness({ pointer: evidence.trust_boundary.source, corpus });
  const trustSink = structuralWitness({ pointer: evidence.trust_boundary.sink, corpus });
  const impactSink = structuralWitness({ pointer: evidence.impact.sink, corpus });
  const resolvedPath = evidence.reachability.path.map((pointer) =>
    resolveCitation(pointer, corpus)
  );
  if (!entrypoint.has_data_flow_node || !trustSource.has_data_flow_node) {
    throw new ScaActiveComplianceError(
      "structural_evidence_insufficient",
      "Entrypoint and trust-boundary source citations must contain parser-observed data-flow syntax."
    );
  }
  if (!sink.has_effect_node || !trustSink.has_effect_node || !impactSink.has_effect_node) {
    throw new ScaActiveComplianceError(
      "structural_evidence_insufficient",
      "Sink, boundary-crossing, and impact citations must contain parser-observed effect syntax."
    );
  }
  return validateContract(
    ScaStructuralEvidenceV2Schema,
    {
      identity: identity.citation,
      reachability: {
        explanation: evidence.reachability.explanation,
        entrypoint: entrypoint.citation,
        sink: sink.citation,
        path: resolvedPath,
      },
      trust_boundary: {
        explanation: evidence.trust_boundary.explanation,
        source: trustSource.citation,
        sink: trustSink.citation,
      },
      impact: { explanation: evidence.impact.explanation, sink: impactSink.citation },
      host_witnesses: {
        identity,
        reachability_entrypoint: entrypoint,
        reachability_sink: sink,
        trust_boundary_source: trustSource,
        trust_boundary_sink: trustSink,
        impact_sink: impactSink,
      },
    },
    "SCA host-resolved structural evidence"
  );
}

function demotedCandidate(
  candidate: ConfirmedCandidate,
  error: ScaActiveComplianceError
): Static<typeof HostCandidateSchema> {
  return validateContract(
    HostCandidateSchema,
    {
      canonical_id: candidate.canonical_id,
      raw_candidate_ids: candidate.raw_candidate_ids,
      disposition: "inconclusive",
      review_reason: `Host demoted the submitted confirmation: ${error.message}`,
      demotion: { reason_code: error.code, detail: error.message },
      submitted_confirmation: candidate,
    },
    "SCA demoted candidate"
  );
}

/**
 * Resolve quoted pointers, generic syntax witnesses, and fingerprints. Host checks prove pointer
 * and structural facts only; Vera's independent semantic review remains a separate prerequisite.
 */
export function adjudicateScaReviewV2(input: {
  readonly review: unknown;
  readonly raw_candidate_ids: readonly string[];
  readonly coverage: ScaCoverageLedgerV1;
  readonly inventory: ScaHostStaticInventoryV2;
  readonly corpus: ParsedScaSourceCorpusV1;
  readonly provenance: ScaEvidenceProvenanceV1;
}): ScaDispositionLedgerV2 {
  const review = validateContract(ScaReviewSummaryV2Schema, input.review, "SCA review summary");
  const coverage = finalizeScaCoverageLedgerV1({
    coverage: input.coverage,
    assessments: review.coverage_assessments,
  });
  const expected = new Set(input.raw_candidate_ids);
  const canonicalIds = review.canonical_candidates.map((candidate) => candidate.canonical_id);
  const mapped = review.canonical_candidates.flatMap((candidate) => candidate.raw_candidate_ids);
  if (
    new Set(canonicalIds).size !== canonicalIds.length ||
    mapped.length !== expected.size ||
    new Set(mapped).size !== mapped.length ||
    mapped.some((candidate) => !expected.has(candidate))
  ) {
    throw new ScaActiveComplianceError(
      "candidate_mapping_invalid",
      "SCA canonical mapping must cover every raw candidate exactly once"
    );
  }
  const fingerprints = new Set<string>();
  const candidates = review.canonical_candidates.map(
    (candidate): Static<typeof HostCandidateSchema> => {
      if (candidate.disposition === "rejected") {
        return {
          canonical_id: candidate.canonical_id,
          raw_candidate_ids: candidate.raw_candidate_ids,
          disposition: "rejected",
          review_reason: candidate.reason,
        };
      }
      if (candidate.disposition === "inconclusive") {
        return {
          canonical_id: candidate.canonical_id,
          raw_candidate_ids: candidate.raw_candidate_ids,
          disposition: "inconclusive",
          review_reason: candidate.reason,
          demotion: null,
          submitted_confirmation: null,
        };
      }
      try {
        const structuralEvidence = resolveStructuralEvidence(
          candidate.structural_evidence,
          input.corpus
        );
        const identityWitness = structuralEvidence.host_witnesses.identity;
        const fingerprint = createScaFindingFingerprint({
          path: structuralEvidence.identity.path,
          symbol: identityWitness.symbol,
          vulnerability_class: candidate.vulnerability_class,
        });
        if (fingerprints.has(fingerprint.sha256)) {
          throw new ScaActiveComplianceError(
            "duplicate_structural_fingerprint",
            `Structural fingerprint '${fingerprint.sha256}' was submitted more than once.`
          );
        }
        fingerprints.add(fingerprint.sha256);
        return validateContract(
          HostCandidateSchema,
          {
            canonical_id: candidate.canonical_id,
            raw_candidate_ids: candidate.raw_candidate_ids,
            disposition: "confirmed",
            finding: {
              finding_id: `scafind_${fingerprint.sha256}`,
              fingerprint,
              title: candidate.title,
              severity: candidate.severity,
              explanation: candidate.explanation,
              impact: candidate.impact,
              prerequisites: candidate.prerequisites,
              limitations: candidate.limitations,
              application_specific_remediation: candidate.application_specific_remediation,
              evidence_revision: {
                source_snapshot_sha256: input.inventory.source_snapshot_sha256,
                parser_id: identityWitness.parser_id,
                parser_language: identityWitness.parser_language,
                structural_evidence: structuralEvidence,
              },
              exploitation: {
                status: "not_run",
                exploited: false,
                independent_reproduction_receipt_refs: [],
              },
            },
          },
          "SCA promoted finding"
        );
      } catch (error) {
        if (error instanceof ScaActiveComplianceError) return demotedCandidate(candidate, error);
        throw error;
      }
    }
  );
  const totals = { confirmed: 0, rejected: 0, inconclusive: 0 };
  for (const candidate of candidates)
    totals[candidate.disposition] += candidate.raw_candidate_ids.length;
  const hostDemotions = candidates.filter(
    (candidate) => candidate.disposition === "inconclusive" && candidate.demotion !== null
  ).length;
  return validateContract(
    ScaDispositionLedgerV2Schema,
    {
      schema_id: "penny.sca-disposition-ledger.v2",
      schema_version: 2,
      source_snapshot_sha256: input.inventory.source_snapshot_sha256,
      raw_candidate_count: input.raw_candidate_ids.length,
      canonical_candidate_count: candidates.length,
      finding_count: candidates.filter((candidate) => candidate.disposition === "confirmed").length,
      disposition_totals: totals,
      coverage,
      adjudication_gate: {
        status: hostDemotions === 0 ? "passed" : "failed",
        host_demoted_confirmation_count: hostDemotions,
      },
      provenance: input.provenance,
      canonical_candidates: candidates,
      reviewer_gaps: review.gaps,
    },
    "SCA adjudicated disposition ledger"
  );
}

export function buildScaReleaseProjectionV1(input: {
  readonly ledger: ScaDispositionLedgerV2;
  readonly ledger_artifact_id: string;
  readonly ledger_sha256: string;
}): ScaReleaseProjectionV1 {
  const ledger = validateContract(
    ScaDispositionLedgerV2Schema,
    input.ledger,
    "SCA adjudicated disposition ledger"
  );
  if (ledger.coverage.completeness_gate.status !== "passed") {
    throw new ScaActiveComplianceError(
      "coverage_incomplete",
      "SCA release projection requires independently reviewed complete coverage"
    );
  }
  if (ledger.adjudication_gate.status !== "passed") {
    throw new ScaActiveComplianceError(
      "structural_evidence_insufficient",
      "SCA release projection refuses host-demoted submitted confirmations"
    );
  }
  const dispositions = ledger.coverage.obligations.flatMap((obligation) => [
    obligation.primary_a,
    obligation.primary_b,
  ]);
  const count = (status: "analyzed" | "blocked" | "unread" | "unsupported") =>
    dispositions.filter((record) => record.status === status).length;
  const findings = ledger.canonical_candidates.flatMap((candidate) =>
    candidate.disposition === "confirmed" ? [candidate.finding] : []
  );
  return validateContract(
    ScaReleaseProjectionV1Schema,
    {
      schema_id: "penny.sca-release-projection.v1",
      schema_version: 1,
      source_snapshot_sha256: ledger.source_snapshot_sha256,
      disposition_ledger_artifact_id: input.ledger_artifact_id,
      disposition_ledger_sha256: input.ledger_sha256,
      promoted_finding_count: findings.length,
      findings,
      provenance: ledger.provenance,
      coverage: {
        completeness_gate: "passed",
        admitted_file_count: ledger.coverage.completeness_gate.admitted_file_count,
        no_candidate_file_count: ledger.coverage.no_candidate_file_count,
        analyzed_profile_records: count("analyzed"),
        disposition_totals: ledger.disposition_totals,
        aggregate_gaps: [
          { kind: "blocked_source_units", count: count("blocked") },
          { kind: "unread_source_units", count: count("unread") },
          { kind: "unsupported_source_units", count: count("unsupported") },
          { kind: "inconclusive_candidates", count: ledger.disposition_totals.inconclusive },
        ],
      },
      evidence_limit: "host_verified_pointers_and_syntax_require_independent_semantic_review",
    },
    "SCA public release projection"
  );
}

function inlineCode(value: string): string {
  const runs = value.match(/`+/gu) ?? [];
  const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  return `${fence}${value}${fence}`;
}

function location(citation: ScaResolvedSourceCitationV2): string {
  return `${inlineCode(citation.path)}:${citation.start_line}-${citation.end_line}`;
}

function proseList(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.map((value) => `  - ${value}`).join("\n");
}

/** Deterministic public rendering copies only the closed release projection, never internal prose. */
export function renderScaPublicReportV2(value: unknown): string {
  const projection = validateContract(
    ScaReleaseProjectionV1Schema,
    value,
    "SCA public release projection"
  );
  const findings =
    projection.findings.length === 0
      ? "No promoted findings survived the evidence and review gates."
      : projection.findings
          .map((finding) => {
            const evidence = finding.evidence_revision.structural_evidence;
            return [
              `### ${finding.title}`,
              "",
              `- **Finding ID:** ${inlineCode(finding.finding_id)}`,
              `- **Severity:** ${finding.severity}`,
              `- **Class:** ${inlineCode(finding.fingerprint.vulnerability_class)}`,
              `- **Structural location:** ${inlineCode(finding.fingerprint.path)} · ${inlineCode(finding.fingerprint.symbol)}`,
              `- **Fingerprint:** ${inlineCode(finding.fingerprint.sha256)}`,
              "",
              "**Why this matters**",
              "",
              finding.explanation,
              "",
              "**Impact**",
              "",
              finding.impact,
              "",
              "**Reachability and trust boundary**",
              "",
              `- ${evidence.reachability.explanation}`,
              `- Source to sink: ${location(evidence.reachability.entrypoint)} → ${location(evidence.reachability.sink)} (${evidence.reachability.path.length} host-resolved path citations)`,
              `- ${evidence.trust_boundary.explanation}`,
              `- Boundary evidence: ${location(evidence.trust_boundary.source)} → ${location(evidence.trust_boundary.sink)}`,
              `- ${evidence.impact.explanation}`,
              `- Impact evidence: ${location(evidence.impact.sink)}`,
              "",
              "**Prerequisites**",
              "",
              proseList(finding.prerequisites, "  - None identified from static evidence."),
              "",
              "**Limitations**",
              "",
              proseList(
                finding.limitations,
                "  - No finding-specific limitation beyond the static-evidence boundary was identified."
              ),
              "",
              "**Application-specific remediation**",
              "",
              finding.application_specific_remediation,
              "",
              `- **Exploitation:** not run; ${inlineCode("exploited=false")}. No proof-of-concept or live impact reproduction was performed.`,
              `- **Evidence revision:** snapshot ${inlineCode(finding.evidence_revision.source_snapshot_sha256)}; parser ${inlineCode(finding.evidence_revision.parser_id)}`,
            ].join("\n");
          })
          .join("\n\n");
  const gaps = projection.coverage.aggregate_gaps
    .map((gap) => `- ${gap.kind}: ${gap.count}`)
    .join("\n");
  return [
    "# Source-Composition Analysis Report",
    "",
    "## Executive summary",
    "",
    `The host promoted ${projection.promoted_finding_count} finding${projection.promoted_finding_count === 1 ? "" : "s"} from the admitted static snapshot. The independently reviewed coverage gate passed for ${projection.coverage.admitted_file_count} admitted file${projection.coverage.admitted_file_count === 1 ? "" : "s"}; ${projection.coverage.no_candidate_file_count} file${projection.coverage.no_candidate_file_count === 1 ? "" : "s"} produced no source-derived candidate in either primary branch. Completion does not establish that the repository is vulnerability-free.`,
    "",
    "## Promoted findings",
    "",
    findings,
    "",
    "## Aggregate coverage and gaps",
    "",
    `- analyzed profile records: ${projection.coverage.analyzed_profile_records}`,
    gaps,
    "",
    "## Immutable provenance",
    "",
    `- source snapshot: ${inlineCode(projection.source_snapshot_sha256)}`,
    `- sealed corpus: ${inlineCode(projection.provenance.source_corpus.artifact_id)} · ${inlineCode(projection.provenance.source_corpus.sha256)}`,
    `- static inventory: ${inlineCode(projection.provenance.inventory.artifact_id)} · ${inlineCode(projection.provenance.inventory.sha256)}`,
    ...projection.provenance.analyses.map(
      (analysis) =>
        `- ${analysis.profile_id}: ${inlineCode(analysis.artifact_id)} · ${inlineCode(analysis.sha256)}`
    ),
    `- candidate ledger: ${inlineCode(projection.provenance.candidate_ledger.artifact_id)} · ${inlineCode(projection.provenance.candidate_ledger.sha256)}`,
    `- independent review: ${inlineCode(projection.provenance.review.artifact_id)} · ${inlineCode(projection.provenance.review.sha256)}`,
    `- structural engine: ${inlineCode(`${projection.provenance.structural_engine.name}@${projection.provenance.structural_engine.version}`)}`,
    projection.provenance.php_structural_parser.status === "available"
      ? `- PHP structural parser: ${inlineCode(`${projection.provenance.php_structural_parser.name}@${projection.provenance.php_structural_parser.version}`)} via ${inlineCode(projection.provenance.php_structural_parser.parse_api)} for PHP ${inlineCode(projection.provenance.php_structural_parser.php_language_version)}; source evaluation disabled`
      : `- PHP structural parser: unavailable (${projection.provenance.php_structural_parser.reason_code})`,
    ...projection.provenance.protocol_ids.map(
      (protocolId) => `- protocol: ${inlineCode(protocolId)}`
    ),
    "",
    "## Evidence boundary",
    "",
    "The host verified that every quoted pointer resolves to exact sealed bytes, computed the source and range hashes, and confirmed generic parser-observed data-flow/effect syntax. Those checks establish pointer and structural witness validity, not the vulnerability semantics. Independent semantic review remains required, and static analysis did not demonstrate exploitation.",
    "",
    "## Machine-readable promoted findings",
    "",
    `SCA_RELEASE_PROJECTION:${canonicalJson(projection)}`,
    "",
  ].join("\n");
}
