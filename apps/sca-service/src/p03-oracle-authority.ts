import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  parseSourceOracleReviewV1Bytes,
  parseSourceOracleValidationReceiptBytes,
  projectSourceOracleCases,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  type ScaP03QualificationFixtureCorpusV2,
  type SourceOracleValidationReceipt,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { validateAndSealSourceOracle, validateSourceOracleBytes } from "./p03-source-oracle.js";

const revalidatedReceipts = new WeakSet<object>();

/** An object is approved only after exact native replay and independent review correspondence. */
export function isRevalidatedP03SourceOracleReceipt(
  receipt: SourceOracleValidationReceipt
): boolean {
  return revalidatedReceipts.has(receipt);
}

/** Replay native parser/grammar measurement and all three exact source ASTs at every authority use. */
export function revalidateP03SourceOracle(input: {
  readonly run_id: string;
  readonly oracle_ref: ArtifactRef;
  readonly oracle_bytes: Uint8Array;
  readonly receipt_ref: ArtifactRef;
  readonly receipt_bytes: Uint8Array;
  readonly review_ref: ArtifactRef;
  readonly review_bytes: Uint8Array;
  readonly corpus_ref: ArtifactRef;
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
  readonly fixtures: readonly {
    readonly ref: ArtifactRef;
    readonly fixture_id: string;
    readonly language: "php" | "javascript" | "typescript";
    readonly path: string;
    readonly content_sha256: string;
    readonly bytes: Uint8Array;
  }[];
}): {
  readonly oracle_sha256: string;
  readonly receipt_sha256: string;
  readonly parser_identity_sha256: string;
  readonly validated_receipt: SourceOracleValidationReceipt;
} {
  const refCheck = (
    ref: ArtifactRef,
    bytes: Uint8Array,
    kind: string,
    schema: string,
    producer: string
  ) => {
    if (
      ref.run_id !== input.run_id ||
      ref.phase !== "SCA-P03" ||
      ref.branch_id !== null ||
      ref.version !== 1 ||
      ref.kind !== kind ||
      ref.content_schema?.schema_id !== schema ||
      ref.producer !== producer ||
      ref.media_type !== "application/json" ||
      ref.byte_length !== bytes.byteLength ||
      ref.content_digest !== sha256(bytes) ||
      ref.store_ref !== `artifact://sha256/${ref.content_digest}`
    )
      throw new Error("p03_oracle_foreign_or_stale_ref");
  };
  refCheck(
    input.oracle_ref,
    input.oracle_bytes,
    "sca-p03-source-oracle",
    SCA_P03_SOURCE_ORACLE_SCHEMA,
    SCA_P03_SOURCE_ORACLE_PRODUCER
  );
  refCheck(
    input.receipt_ref,
    input.receipt_bytes,
    "sca-p03-source-oracle-validation",
    SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    SCA_P03_SOURCE_ORACLE_VALIDATOR
  );
  refCheck(
    input.review_ref,
    input.review_bytes,
    "sca-p03-source-oracle-review",
    SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER
  );
  const oracle = validateSourceOracleBytes(input.oracle_bytes);
  const receipt = parseSourceOracleValidationReceiptBytes(input.receipt_bytes);
  const review = parseSourceOracleReviewV1Bytes(input.review_bytes);
  if (
    canonicalJson(receipt.oracle_ref) !== canonicalJson(input.oracle_ref) ||
    canonicalJson(receipt.review_ref) !== canonicalJson(input.review_ref) ||
    review.oracle_sha256 !== oracle.oracle_sha256 ||
    review.parser_identity_sha256 !== oracle.parser.identity_sha256 ||
    canonicalJson(review.fixture_content_sha256) !==
      canonicalJson(
        (["php", "javascript", "typescript"] as const).map(
          (language) => oracle.fixtures.find((f) => f.language === language)?.content_sha256
        )
      ) ||
    canonicalJson(review.expected_cases) !== canonicalJson(projectSourceOracleCases(oracle))
  )
    throw new Error("p03_oracle_review_cross_splice");
  const replayed = validateAndSealSourceOracle({
    oracle_bytes: input.oracle_bytes,
    oracle_ref: input.oracle_ref,
    review_ref: input.review_ref,
    corpus_ref: input.corpus_ref,
    corpus: input.corpus,
    fixtures: input.fixtures,
    validated_at: receipt.validated_at,
  });
  if (canonicalJson(replayed) !== canonicalJson(receipt))
    throw new Error("p03_oracle_receipt_cross_splice");
  revalidatedReceipts.add(receipt);
  return {
    validated_receipt: receipt,
    oracle_sha256: oracle.oracle_sha256,
    receipt_sha256: input.receipt_ref.content_digest,
    parser_identity_sha256: oracle.parser.identity_sha256,
  };
}
