import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import {
  SCA_P11_BASE_METRICS,
  SCA_P11_SCORER_QUALIFICATION_SCHEMA,
  SCA_P11_SCORING_RECORDS_SCHEMA,
  ScaP11CvssScorerQualificationV1Schema,
  scaP11SeverityTokenForScore,
  validateScaP11CvssScorerQualificationV1,
  validateScaP11ScoringRecordsV1,
  withP11Digest,
  type ScaP11BaseMetricV1,
  type ScaP11CvssScorerQualificationV1,
  type ScaP11ExceptionShapeV1,
  type ScaP11NomenclatureV1,
  type ScaP11ScoringPolicyEntryV1,
  type ScaP11ScoringPolicyV1,
  type ScaP11ScoringRecordsV1,
  type ScaP11SeverityTokenV1,
} from "./p11-contracts.js";

/**
 * Deterministic, exact-receipt-bound CVSS v4.0 scoring (`SCA-P11` R08). The numeric result comes
 * from a scorer authority that is bound to an exact admitted qualification receipt; a model may
 * propose metric rationale but never the number. There is no fallback and no live scorer: production
 * composition re-reads the exact receipt artifact from the host store rather than trusting an object
 * shape, and the provider-free fixture is pinned to the same official FIRST reference corpus.
 */
export const SCA_P11_CVSS_VECTOR_PREFIX = "CVSS:4.0" as const;

export const SCA_P11_OFFICIAL_CVSS_REFERENCES = Object.freeze([
  "https://www.first.org/cvss/v4.0/specification-document",
  "https://www.first.org/cvss/v4.0/user-guide",
  "https://www.first.org/cvss/v4.0/implementation-guide",
  "https://www.first.org/cvss/v4.0/examples",
  "https://www.first.org/cvss/calculator/4.0",
] as const);

export interface ScaP11CvssScoreV1 {
  readonly score: number;
  readonly nomenclature: ScaP11NomenclatureV1;
}

/**
 * Exact CVSS v4.0 scorer authority. `qualification` is the exact admitted receipt binding the
 * scorer identity, build, official FIRST reference corpus, and the reference vectors the scorer
 * must reproduce. `qualification_ref` binds that receipt to its immutable artifact when the
 * authority was resolved from the host store (production); it is `null` only for the pinned
 * provider-free fixture, whose receipt digest is still carried exactly.
 */
export interface ScaP11CvssScorerAuthorityV1 {
  readonly qualification: ScaP11CvssScorerQualificationV1;
  readonly qualification_ref: ArtifactRef | null;
  /** Score one canonical vector string; never a model-proposed number. */
  score(canonical_vector: string): ScaP11CvssScoreV1;
}

function nomenclatureFor(input: {
  readonly threat: boolean;
  readonly environmental: boolean;
}): ScaP11NomenclatureV1 {
  if (input.threat && input.environmental) return "CVSS-BTE";
  if (input.threat) return "CVSS-BT";
  if (input.environmental) return "CVSS-BE";
  return "CVSS-B";
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** One official FIRST CVSS v4.0 reference vector and its published score. */
export interface ScaP11CvssReferenceVectorV1 {
  readonly vector: string;
  readonly score: number;
  readonly nomenclature: ScaP11NomenclatureV1;
}

/**
 * The immutable, host-owned pinned official FIRST CVSS v4.0 reference corpus. It is defined here in
 * source, independent of any qualification receipt, and is the only source of truth for the scores a
 * qualified scorer must reproduce. A receipt that disagrees with it is rejected; the receipt never
 * defines truth.
 */
export const SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS: readonly ScaP11CvssReferenceVectorV1[] =
  Object.freeze([
    {
      vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
      score: 10,
      nomenclature: "CVSS-B",
    },
    {
      vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
      score: 9.3,
      nomenclature: "CVSS-B",
    },
    {
      vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N",
      score: 0,
      nomenclature: "CVSS-B",
    },
  ]);

export const SCA_P11_CVSS_IMPLEMENTATION_ID =
  "penny.sca-p11.cvss-v4-reference-implementation.v1" as const;

interface ScaP11CvssScorerImplementationV1 {
  readonly implementation_id: string;
  readonly build_sha256: string;
  readonly supported_vectors: readonly string[];
  score(canonical_vector: string): ScaP11CvssScoreV1;
}

function implementationBuildSha256(
  implementation_id: string,
  supported_vectors: readonly string[]
): string {
  return sha256(canonicalJson({ implementation_id, supported_vectors: [...supported_vectors] }));
}

const SCA_P11_CVSS_IMPLEMENTATION_BUILD_SHA256 = implementationBuildSha256(
  SCA_P11_CVSS_IMPLEMENTATION_ID,
  SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS.map((entry) => entry.vector)
);

/**
 * The admitted, host-owned reference implementation. A general CVSS v4.0 scorer is not present in
 * this provider-free candidate, so the implementation is deliberately bounded to the pinned official
 * corpus and fails closed for any vector outside it — it never consults a receipt and never invents a
 * score. It is resolved by identity at use time (a current-authority binding), never read from the
 * receipt.
 */
const SCA_P11_CVSS_HOST_IMPLEMENTATION: ScaP11CvssScorerImplementationV1 = Object.freeze({
  implementation_id: SCA_P11_CVSS_IMPLEMENTATION_ID,
  build_sha256: SCA_P11_CVSS_IMPLEMENTATION_BUILD_SHA256,
  supported_vectors: Object.freeze(
    SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS.map((entry) => entry.vector)
  ),
  score(canonicalVector: string): ScaP11CvssScoreV1 {
    if (!canonicalVector.startsWith(`${SCA_P11_CVSS_VECTOR_PREFIX}/`)) {
      throw new Error("SCA P11 CVSS scorer requires a canonical CVSS:4.0 vector");
    }
    const entry = SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS.find(
      (reference) => reference.vector === canonicalVector
    );
    if (entry === undefined) {
      throw new Error(
        `SCA P11 CVSS scorer fails closed: '${canonicalVector}' is outside the pinned official corpus and no general scorer implementation is admitted`
      );
    }
    const expected = nomenclatureFor({
      threat: canonicalVector.includes("/E:"),
      environmental: canonicalVector.includes("/CR:"),
    });
    if (entry.nomenclature !== expected) {
      throw new Error(
        `SCA P11 pinned CVSS nomenclature disagrees with vector composition '${canonicalVector}'`
      );
    }
    return { score: entry.score, nomenclature: entry.nomenclature };
  },
});

/** Resolve the exact admitted scorer implementation by identity (never from a receipt body). */
function resolveScaP11CvssImplementation(
  implementationId: string
): ScaP11CvssScorerImplementationV1 {
  if (implementationId === SCA_P11_CVSS_IMPLEMENTATION_ID) {
    return SCA_P11_CVSS_HOST_IMPLEMENTATION;
  }
  throw new Error("SCA P11 CVSS scorer qualification names an unadmitted implementation");
}

/**
 * Build one exact qualification receipt. Its build digest binds the *host-owned admitted scorer
 * implementation* (never a digest of the receipt body), and its reference vectors must exactly equal
 * the pinned official FIRST corpus before the receipt carries any authority.
 */
export function buildScaP11CvssScorerQualificationV1(input: {
  readonly scorer_id: string;
  readonly implementation_id: string;
  readonly official_references: readonly string[];
  readonly reference_vectors: readonly {
    readonly vector: string;
    readonly score: number;
    readonly nomenclature: ScaP11NomenclatureV1;
  }[];
}): ScaP11CvssScorerQualificationV1 {
  const implementation = resolveScaP11CvssImplementation(input.implementation_id);
  const body = {
    scorer_id: input.scorer_id,
    implementation_id: implementation.implementation_id,
    build_sha256: implementation.build_sha256,
    official_references: [...input.official_references].sort(),
    reference_vectors: [...input.reference_vectors]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => (left.vector < right.vector ? -1 : 1)),
  };
  return validateScaP11CvssScorerQualificationV1(
    withP11Digest(
      {
        schema_id: SCA_P11_SCORER_QUALIFICATION_SCHEMA,
        schema_version: 1 as const,
        ...body,
      },
      "qualification_sha256"
    )
  );
}

/**
 * Rebuild a deterministic scorer from an exact qualification receipt. The `score` function is the
 * host-owned admitted implementation, resolved by identity and re-checked against the pinned corpus —
 * it is not generated from the receipt, so a fabricated receipt cannot define a score. It performs no
 * network or provider call, so it is safe for provider-free qualification tests.
 */
export function buildScaP11CvssScorerFromQualification(input: {
  readonly qualification: ScaP11CvssScorerQualificationV1;
  readonly qualification_ref: ArtifactRef | null;
}): ScaP11CvssScorerAuthorityV1 {
  const qualification = validateScaP11CvssScorerQualificationV1(input.qualification);
  const implementation = resolveScaP11CvssImplementation(qualification.implementation_id);
  const authority: ScaP11CvssScorerAuthorityV1 = {
    qualification,
    qualification_ref: input.qualification_ref,
    score: implementation.score,
  };
  return assertScaP11CvssScorerAuthority(authority);
}

/**
 * Reject any authority whose embedded qualification is malformed, names an unadmitted or stale
 * implementation build, fails to exactly equal the pinned official FIRST corpus, or whose scoring
 * function does not reproduce the pinned official reference corpus. The receipt is checked *against*
 * the host-owned corpus and implementation, so a receipt that rewrites 9.3 to 1.1 is rejected before
 * any score can be published.
 */
export function assertScaP11CvssScorerAuthority(
  value: ScaP11CvssScorerAuthorityV1
): ScaP11CvssScorerAuthorityV1 {
  const qualification = validateContract(
    ScaP11CvssScorerQualificationV1Schema,
    value.qualification,
    "SCA P11 CVSS scorer qualification"
  );
  const officialReferences = new Set<string>(SCA_P11_OFFICIAL_CVSS_REFERENCES);
  if (!qualification.official_references.every((reference) => officialReferences.has(reference))) {
    throw new Error("SCA P11 CVSS scorer qualification references a non-official source");
  }
  const implementation = resolveScaP11CvssImplementation(qualification.implementation_id);
  if (implementation.build_sha256 !== qualification.build_sha256) {
    throw new Error(
      "SCA P11 CVSS scorer qualification build digest does not bind the admitted implementation"
    );
  }
  if (!same(qualification.reference_vectors, SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS)) {
    throw new Error(
      "SCA P11 CVSS scorer qualification does not exactly equal the pinned official FIRST corpus"
    );
  }
  if (typeof value.score !== "function") {
    throw new Error("SCA P11 CVSS scorer authority must expose a deterministic score function");
  }
  for (const reference of SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS) {
    const produced = value.score(reference.vector);
    if (produced.score !== reference.score || produced.nomenclature !== reference.nomenclature) {
      throw new Error(
        `SCA P11 CVSS scorer does not reproduce the pinned official reference '${reference.vector}'`
      );
    }
  }
  return value;
}

/**
 * Production resolution: exact-read the admitted qualification receipt artifact and rebuild the
 * authority from its bytes. This is a current-authority re-read, never an object-shape check.
 */
export function resolveScaP11CvssScorerAuthority(input: {
  readonly store: ArtifactHostStore;
  readonly ref: ArtifactRef;
}): ScaP11CvssScorerAuthorityV1 {
  const stored = input.store.refById(input.ref.artifact_id);
  if (stored === undefined || !same(stored, input.ref)) {
    throw new Error("SCA P11 CVSS scorer qualification ref is absent or substituted");
  }
  const bytes = input.store.readById(input.ref.artifact_id);
  if (bytes.byteLength !== input.ref.byte_length || sha256(bytes) !== input.ref.content_digest) {
    throw new Error("SCA P11 CVSS scorer qualification exact bytes drifted");
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) {
    throw new Error("SCA P11 CVSS scorer qualification is not canonical JSON");
  }
  const qualification = validateScaP11CvssScorerQualificationV1(parsed);
  return buildScaP11CvssScorerFromQualification({
    qualification,
    qualification_ref: input.ref,
  });
}

/**
 * The published official FIRST CVSS v4.0 reference corpus used by the provider-free fixture. Every
 * row is drawn from the FIRST specification/user-guide examples and is reproduced by the admitted
 * host implementation. The qualification below is built against the immutable pinned corpus, so its
 * reference vectors must exactly equal the host-owned corpus.
 */
export const SCA_P11_FIXTURE_CVSS_QUALIFICATION: ScaP11CvssScorerQualificationV1 =
  buildScaP11CvssScorerQualificationV1({
    scorer_id: "penny.sca-p11.cvss-v4-fixture",
    implementation_id: SCA_P11_CVSS_IMPLEMENTATION_ID,
    official_references: SCA_P11_OFFICIAL_CVSS_REFERENCES,
    reference_vectors: SCA_P11_PINNED_OFFICIAL_CVSS_REFERENCE_CORPUS,
  });

/**
 * Deterministic provider-free qualified fixture. It is bound to the exact official FIRST reference
 * receipt above and fails closed on any vector outside the corpus. It performs no network or
 * provider call. Production composition never falls back to this fixture.
 */
export const SCA_P11_QUALIFIED_CVSS_FIXTURE: ScaP11CvssScorerAuthorityV1 =
  buildScaP11CvssScorerFromQualification({
    qualification: SCA_P11_FIXTURE_CVSS_QUALIFICATION,
    qualification_ref: null,
  });

/** Reject any vector that does not carry all eleven Base metrics in the exact required order. */
export function validateScaP11BaseVector(
  base: readonly { readonly metric: ScaP11BaseMetricV1; readonly value: string }[]
): void {
  if (base.length !== SCA_P11_BASE_METRICS.length) {
    throw new Error("SCA P11 CVSS vector must carry exactly eleven Base metrics");
  }
  for (const [index, metric] of SCA_P11_BASE_METRICS.entries()) {
    const entry = base[index];
    if (entry === undefined || entry.metric !== metric) {
      throw new Error("SCA P11 CVSS Base metrics are not in the exact required order");
    }
    if (entry.value === "X" || entry.value.length === 0) {
      throw new Error("SCA P11 CVSS Base metric cannot be left unset");
    }
  }
}

export function scaP11CanonicalVectorString(input: {
  readonly base: readonly { readonly metric: ScaP11BaseMetricV1; readonly value: string }[];
  readonly threat: readonly { readonly metric: "E"; readonly value: string }[];
  readonly environmental: readonly { readonly metric: string; readonly value: string }[];
}): string {
  validateScaP11BaseVector(input.base);
  const parts = input.base.map((entry) => `${entry.metric}:${entry.value}`);
  for (const metric of input.threat) {
    if (metric.value === "X") throw new Error("SCA P11 threat metric cannot be unset when present");
    parts.push(`${metric.metric}:${metric.value}`);
  }
  for (const metric of input.environmental) {
    if (metric.value === "X") throw new Error("SCA P11 environmental metric cannot be unset");
    parts.push(`${metric.metric}:${metric.value}`);
  }
  return `${SCA_P11_CVSS_VECTOR_PREFIX}/${parts.join("/")}`;
}

export function scaP11BaseVectorString(
  base: readonly { readonly metric: ScaP11BaseMetricV1; readonly value: string }[]
): string {
  return scaP11CanonicalVectorString({ base, threat: [], environmental: [] });
}

export interface ScaP11ScoringTargetV1 {
  readonly target_id: string;
  readonly evidence_refs: readonly ArtifactRef[];
}

export interface ScaP11ScoringInputV1 {
  readonly run_id: string;
  readonly revision: number;
  readonly targets: readonly ScaP11ScoringTargetV1[];
  readonly policy: ScaP11ScoringPolicyV1;
  readonly scorer: ScaP11CvssScorerAuthorityV1 | null;
}

export interface ScaP11ScoringResultV1 {
  readonly records: ScaP11ScoringRecordsV1;
  readonly severity_token_by_identity: ReadonlyMap<string, ScaP11SeverityTokenV1>;
  readonly exception_shape_by_identity: ReadonlyMap<string, ScaP11ExceptionShapeV1>;
  readonly score_by_identity: ReadonlyMap<
    string,
    {
      readonly score: number;
      readonly vector: string;
      readonly nomenclature: ScaP11NomenclatureV1;
      readonly base_vector: string | null;
      readonly base_score: number | null;
    }
  >;
}

/**
 * Deterministic scoring records. Every target lands in exactly one closed exception shape; a scored
 * target with no admitted scorer authority, or with a metric vector the authority does not qualify,
 * fails closed rather than inventing a number. A model-proposed number is structurally impossible.
 */
export function buildScaP11ScoringRecordsV1(input: ScaP11ScoringInputV1): ScaP11ScoringResultV1 {
  const policyByIdentity = new Map<string, ScaP11ScoringPolicyEntryV1>();
  for (const entry of input.policy.entries) policyByIdentity.set(entry.target_id, entry);
  if (input.scorer !== null) assertScaP11CvssScorerAuthority(input.scorer);

  const severityByIdentity = new Map<string, ScaP11SeverityTokenV1>();
  const shapeByIdentity = new Map<string, ScaP11ExceptionShapeV1>();
  const scoreByIdentity = new Map<
    string,
    {
      readonly score: number;
      readonly vector: string;
      readonly nomenclature: ScaP11NomenclatureV1;
      readonly base_vector: string | null;
      readonly base_score: number | null;
    }
  >();
  const records: ScaP11ScoringRecordsV1["records"][number][] = [];

  for (const target of input.targets) {
    const entry = policyByIdentity.get(target.target_id);
    if (entry === undefined) {
      shapeByIdentity.set(target.target_id, "unscored_incomplete");
      severityByIdentity.set(target.target_id, "Unscored");
      records.push({
        target_id: target.target_id,
        exception_shape: "unscored_incomplete",
        metric_vector: null,
        nomenclature: null,
        score: null,
        severity_token: "Unscored",
        base_vector: null,
        base_score: null,
        rationale:
          "no admitted scoring-policy entry; the finding is retained as Unscored — incomplete",
        evidence_refs: [...target.evidence_refs],
        model_proposed_number: false,
      });
      continue;
    }
    shapeByIdentity.set(target.target_id, entry.exception_shape);
    if (entry.exception_shape === "informational") {
      severityByIdentity.set(target.target_id, "Informational");
      records.push({
        target_id: target.target_id,
        exception_shape: "informational",
        metric_vector: null,
        nomenclature: null,
        score: null,
        severity_token: "Informational",
        base_vector: null,
        base_score: null,
        rationale: entry.rationale,
        evidence_refs: [...entry.evidence_refs],
        model_proposed_number: false,
      });
      continue;
    }
    if (entry.exception_shape === "dismissed_non_vulnerability") {
      severityByIdentity.set(target.target_id, "Not applicable");
      records.push({
        target_id: target.target_id,
        exception_shape: "dismissed_non_vulnerability",
        metric_vector: null,
        nomenclature: null,
        score: null,
        severity_token: "Not applicable",
        base_vector: null,
        base_score: null,
        rationale: entry.rationale,
        evidence_refs: [...entry.evidence_refs],
        model_proposed_number: false,
      });
      continue;
    }
    if (entry.exception_shape === "unscored_incomplete") {
      severityByIdentity.set(target.target_id, "Unscored");
      records.push({
        target_id: target.target_id,
        exception_shape: "unscored_incomplete",
        metric_vector: null,
        nomenclature: null,
        score: null,
        severity_token: "Unscored",
        base_vector: null,
        base_score: null,
        rationale: entry.rationale,
        evidence_refs: [...entry.evidence_refs],
        model_proposed_number: false,
      });
      continue;
    }
    // scored / none_zero
    if (input.scorer === null) {
      throw new Error("SCA P11 scored policy entry requires an admitted CVSS scorer authority");
    }
    const threat = entry.threat_metrics.map((metric) => ({
      metric: metric.metric,
      value: metric.value,
    }));
    const environmental = entry.environmental_metrics.map((metric) => ({
      metric: metric.metric,
      value: metric.value,
    }));
    const contextual = threat.length > 0 || environmental.length > 0;
    const vector = scaP11CanonicalVectorString({ base: entry.base_metrics, threat, environmental });
    const scored = input.scorer.score(vector);
    const shape: ScaP11ExceptionShapeV1 = scored.score === 0 ? "none_zero" : entry.exception_shape;
    const baseVector = contextual ? scaP11BaseVectorString(entry.base_metrics) : null;
    const baseScore = contextual ? input.scorer.score(baseVector ?? "").score : null;
    const severity = scaP11SeverityTokenForScore(scored.score);
    if (shape === "none_zero" && scored.score !== 0) {
      throw new Error("SCA P11 None exception shape disagrees with the qualified score");
    }
    severityByIdentity.set(target.target_id, severity);
    shapeByIdentity.set(target.target_id, shape);
    scoreByIdentity.set(target.target_id, {
      score: scored.score,
      vector,
      nomenclature: scored.nomenclature,
      base_vector: baseVector,
      base_score: baseScore,
    });
    records.push({
      target_id: target.target_id,
      exception_shape: shape,
      metric_vector: entry.base_metrics.map((metric) => `${metric.metric}:${metric.value}`),
      nomenclature: scored.nomenclature,
      score: scored.score,
      severity_token: severity,
      base_vector:
        baseVector === null
          ? null
          : entry.base_metrics.map((metric) => `${metric.metric}:${metric.value}`),
      base_score: baseScore,
      rationale: entry.rationale,
      evidence_refs: [...entry.evidence_refs],
      model_proposed_number: false,
    });
  }

  const sorted = [...records].sort((left, right) =>
    left.target_id < right.target_id ? -1 : left.target_id > right.target_id ? 1 : 0
  );
  const scoredCount = sorted.filter((record) => record.score !== null).length;
  const value = validateScaP11ScoringRecordsV1(
    withP11Digest(
      {
        schema_id: SCA_P11_SCORING_RECORDS_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        run_id: input.run_id,
        revision: input.revision,
        scorer_id: input.scorer === null ? null : input.scorer.qualification.scorer_id,
        scorer_build_sha256: input.scorer === null ? null : input.scorer.qualification.build_sha256,
        scorer_authority_admitted: input.scorer !== null,
        scorer_qualification_ref: input.scorer === null ? null : input.scorer.qualification_ref,
        scorer_qualification_sha256:
          input.scorer === null ? null : input.scorer.qualification.qualification_sha256,
        records: sorted,
        record_count: sorted.length,
        scored_count: scoredCount,
        unscored_count: sorted.length - scoredCount,
      },
      "records_sha256"
    )
  );
  return {
    records: value,
    severity_token_by_identity: severityByIdentity,
    exception_shape_by_identity: shapeByIdentity,
    score_by_identity: scoreByIdentity,
  };
}
