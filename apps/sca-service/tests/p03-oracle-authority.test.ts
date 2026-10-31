import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  projectSourceOracleCases,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  sealSourceOracleValidationReceipt,
  parseSourceOracleValidationReceiptBytes,
  validateScaP03QualificationFixtureCorpusV2,
  withScaP03Digest,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { revalidateP03SourceOracle } from "../src/p03-oracle-authority.js";
import { readSourceOracle } from "./p03-source-oracle.js";

const run_id = "p03-oracle-replay";
function ref(kind: string, schema: string, producer: string, bytes: Uint8Array): ArtifactRef {
  const digest = sha256(bytes);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`${kind}:${digest}`)}`,
    run_id,
    phase: "SCA-P03",
    branch_id: null,
    kind,
    operation_id: kind,
    version: 1,
    producer,
    media_type: "application/json",
    content_schema: { schema_id: schema, schema_version: schema.endsWith(".v2") ? 2 : 1 },
    byte_length: bytes.byteLength,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
async function cohort(decoy = false, parserDrift = false) {
  const reviewed = await readSourceOracle();
  const source = reviewed.fixtures.map((fixture) =>
    fixture.language === "javascript" && decoy
      ? (() => {
          const bytes = Buffer.from(
            Buffer.from(fixture.bytes)
              .toString("utf8")
              .replace(
                'router.get("/decoy", decoyHandler);',
                'router.get("/decoy", handleRecord /* decoyHandler */);'
              )
          );
          return {
            ...fixture,
            bytes,
            byte_length: bytes.byteLength,
            content_sha256: sha256(bytes),
          };
        })()
      : fixture
  );
  const editedFixtures = reviewed.oracle.fixtures.map((fixture) => {
    if (!decoy || fixture.language !== "javascript") return fixture;
    const changed = source.find((entry) => entry.language === fixture.language);
    if (!changed) throw new Error("changed fixture absent");
    return {
      ...fixture,
      byte_length: changed.bytes.byteLength,
      content_sha256: sha256(changed.bytes),
      registration: {
        ...fixture.registration,
        negative: {
          ...fixture.registration.negative,
          text: 'router.get("/decoy", handleRecord /* decoyHandler */);',
        },
      },
    };
  });
  const { oracle_sha256: _oldDigest, ...unsigned } = reviewed.oracle;
  void _oldDigest;
  const parser = parserDrift
    ? (() => {
        const runtime = { ...unsigned.parser.runtime, version: "0.0.0" };
        return {
          ...unsigned.parser,
          runtime,
          identity_sha256: sha256(canonicalJson({ runtime, grammars: unsigned.parser.grammars })),
        };
      })()
    : unsigned.parser;
  const changed = { ...unsigned, fixtures: editedFixtures, parser };
  const oracle =
    decoy || parserDrift
      ? { ...changed, oracle_sha256: sha256(canonicalJson(changed)) }
      : reviewed.oracle;
  const oracle_bytes = Buffer.from(canonicalJson(oracle));
  const oracle_ref = ref(
    "sca-p03-source-oracle",
    SCA_P03_SOURCE_ORACLE_SCHEMA,
    SCA_P03_SOURCE_ORACLE_PRODUCER,
    oracle_bytes
  );
  const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
    const fixture = source.find((entry) => entry.language === language);
    if (fixture === undefined) throw new Error("fixture missing");
    const content = {
      schema_id: "penny.sca-p03-qualification-fixture-content.v1",
      schema_version: 1,
      fixture_id: fixture.fixture_id,
      language,
      path: fixture.path,
      encoding: "base64",
      content_base64: Buffer.from(fixture.bytes).toString("base64"),
      byte_length: fixture.bytes.length,
      content_sha256: fixture.content_sha256,
    };
    return {
      ref: ref(
        "sca-p03-fixture-content",
        content.schema_id,
        "host:sca-p03-qualification-authority",
        Buffer.from(canonicalJson(content))
      ),
      fixture_id: fixture.fixture_id,
      language,
      path: fixture.path,
      content_sha256: fixture.content_sha256,
      bytes: fixture.bytes,
    };
  });
  const expected_cases = projectSourceOracleCases(oracle);
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    withScaP03Digest(
      {
        schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
        schema_version: 2,
        corpus_id: "reviewed-corpus",
        fixture_content_refs: fixtures.map((f) => f.ref),
        fixture_ids: fixtures.map((f) => f.fixture_id),
        languages: ["php", "javascript", "typescript"] as const,
        expected_cases,
      },
      "corpus_sha256"
    )
  );
  const corpus_ref = ref(
    "sca-p03-qualification-fixture-corpus",
    corpus.schema_id,
    "host:sca-p03-qualification-authority",
    Buffer.from(canonicalJson(corpus))
  );
  const reviewBody = {
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    oracle_sha256: oracle.oracle_sha256,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixture_content_sha256: fixtures.map((f) => f.content_sha256),
    expected_cases,
  };
  const review_bytes = Buffer.from(
    canonicalJson({ ...reviewBody, review_sha256: sha256(canonicalJson(reviewBody)) })
  );
  const review_ref = ref(
    "sca-p03-source-oracle-review",
    SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    review_bytes
  );
  const [php, javascript, typescript] = fixtures;
  if (!php || !javascript || !typescript) throw new Error("fixtures missing");
  const receipt = sealSourceOracleValidationReceipt({
    oracle_ref,
    oracle_sha256: oracle.oracle_sha256,
    review_ref,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixtures: [
      {
        fixture_id: php.fixture_id,
        language: php.language,
        content_ref: php.ref,
        content_sha256: php.content_sha256,
      },
      {
        fixture_id: javascript.fixture_id,
        language: javascript.language,
        content_ref: javascript.ref,
        content_sha256: javascript.content_sha256,
      },
      {
        fixture_id: typescript.fixture_id,
        language: typescript.language,
        content_ref: typescript.ref,
        content_sha256: typescript.content_sha256,
      },
    ],
    corpus_ref,
    corpus_sha256: corpus.corpus_sha256,
    expected_cases,
    validated_at: "2026-09-28T00:00:00Z",
  });
  const receipt_bytes = Buffer.from(canonicalJson(receipt));
  const receipt_ref = ref(
    "sca-p03-source-oracle-validation",
    SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    SCA_P03_SOURCE_ORACLE_VALIDATOR,
    receipt_bytes
  );
  return {
    run_id,
    oracle_ref,
    oracle_bytes,
    receipt_ref,
    receipt_bytes,
    review_ref,
    review_bytes,
    corpus_ref,
    corpus,
    fixtures,
  };
}

describe("production P03 oracle replay", () => {
  it("rechecks exact canonical receipt, parser identity, all three ASTs and 21 projected cases", async () => {
    const input = await cohort();
    expect(revalidateP03SourceOracle(input)).toMatchObject({
      receipt_sha256: input.receipt_ref.content_digest,
      parser_identity_sha256: parseSourceOracleValidationReceiptBytes(input.receipt_bytes)
        .parser_identity_sha256,
    });
  });
  it("rejects a recomputed oracle and receipt whose native parser identity has drifted", async () => {
    const input = await cohort(false, true);
    expect(() => revalidateP03SourceOracle(input)).toThrow("P03 oracle parser identity drift");
  });
  it("rejects a decoy endpoint even after coherent fixture, oracle, review, corpus and receipt digest recomputation", async () => {
    const changed = await cohort(true);
    expect(() => revalidateP03SourceOracle(changed)).toThrow(
      "P03 registration negative relation drift"
    );
  });
  it("rejects changed expected cases even with recomputed corpus and receipt digests", async () => {
    const input = await cohort();
    const first = input.corpus.expected_cases[0];
    if (!first) throw new Error("case missing");
    const changed = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          schema_id: input.corpus.schema_id,
          schema_version: input.corpus.schema_version,
          corpus_id: input.corpus.corpus_id,
          fixture_content_refs: input.corpus.fixture_content_refs,
          fixture_ids: input.corpus.fixture_ids,
          languages: input.corpus.languages,
          expected_cases: [
            {
              ...first,
              oracle_assertions: first.oracle_assertions.map((assertion) => ({
                ...assertion,
                start: assertion.start
                  ? { ...assertion.start, name: "changedSelector" }
                  : undefined,
              })),
            },
            ...input.corpus.expected_cases.slice(1),
          ],
        },
        "corpus_sha256"
      )
    );
    const corpus_ref = ref(
      "sca-p03-qualification-fixture-corpus",
      changed.schema_id,
      "host:sca-p03-qualification-authority",
      Buffer.from(canonicalJson(changed))
    );
    const old = parseSourceOracleValidationReceiptBytes(input.receipt_bytes);
    const receipt = sealSourceOracleValidationReceipt({
      oracle_ref: input.oracle_ref,
      oracle_sha256: old.oracle_sha256,
      review_ref: input.review_ref,
      parser_identity_sha256: old.parser_identity_sha256,
      fixtures: old.fixtures,
      corpus_ref,
      corpus_sha256: changed.corpus_sha256,
      expected_cases: changed.expected_cases,
      validated_at: old.validated_at,
    });
    const receipt_bytes = Buffer.from(canonicalJson(receipt));
    const receipt_ref = ref(
      "sca-p03-source-oracle-validation",
      SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      SCA_P03_SOURCE_ORACLE_VALIDATOR,
      receipt_bytes
    );
    expect(() =>
      revalidateP03SourceOracle({
        ...input,
        corpus: changed,
        corpus_ref,
        receipt_ref,
        receipt_bytes,
      })
    ).toThrow("p03_source_oracle_corpus_mismatch");
  });
  it("rejects foreign refs, fixture substitution, corpus splice and receipt splice before runtime", async () => {
    const input = await cohort();
    expect(() => revalidateP03SourceOracle({ ...input, run_id: "other-run" })).toThrow(
      "p03_oracle_foreign_or_stale_ref"
    );
    const first = input.fixtures[0];
    if (!first) throw new Error("fixture missing");
    expect(() =>
      revalidateP03SourceOracle({
        ...input,
        fixtures: [
          { ...first, bytes: Buffer.from(first.bytes).fill(0) },
          ...input.fixtures.slice(1),
        ],
      })
    ).toThrow(/P03 fixture byte drift/);
    expect(() => revalidateP03SourceOracle({ ...input, corpus_ref: input.review_ref })).toThrow();
    expect(() =>
      revalidateP03SourceOracle({
        ...input,
        oracle_ref: { ...input.oracle_ref, version: 2 },
      })
    ).toThrow("p03_oracle_foreign_or_stale_ref");
    const swapped = await cohort(true);
    expect(() =>
      revalidateP03SourceOracle({
        ...input,
        receipt_ref: swapped.receipt_ref,
        receipt_bytes: swapped.receipt_bytes,
      })
    ).toThrow("p03_oracle_review_cross_splice");
    expect(() =>
      revalidateP03SourceOracle({ ...input, receipt_bytes: input.review_bytes })
    ).toThrow("p03_oracle_foreign_or_stale_ref");
  });
});
