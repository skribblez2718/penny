import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import { assertSourceOracleAuthority } from "../dist/sca/p03-admission.js";
import {
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  projectSourceOracleCases,
  parseSourceOracleBytes,
  parseSourceOracleValidationReceiptBytes,
  sealSourceOracleValidationReceipt,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03RequestV2,
  withScaP03Digest,
  type ScaP03QualificationFixtureCorpusV2,
} from "../dist/sca/p03-contracts.js";

const RUN = "p03-source-oracle-test-run";
const root = new URL("../../sca-service/tests/fixtures/p03-v2/", import.meta.url);
const stores: ArtifactStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function persist(
  store: ArtifactStore,
  input: {
    operation: string;
    kind: string;
    producer: string;
    schema: string;
    version?: number;
    run?: string;
    body: unknown;
    upstream?: readonly ArtifactRef[];
    raw?: string;
    parent?: ArtifactRef;
  }
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run ?? RUN,
    phase: "SCA-P03",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation,
    version: input.version ?? 1,
    parent_ref: input.parent ?? null,
    producer: input.producer,
    media_type: "application/json",
    content_schema: {
      schema_id: input.schema,
      schema_version: input.schema.endsWith(".v2") ? 2 : 1,
    },
    upstream_refs: [...(input.upstream ?? [])].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
  };
  return store.persist({ metadata, content: input.raw ?? canonicalJson(input.body) });
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "p03-oracle-authority-"));
  directories.push(directory);
  const store = new ArtifactStore(path.join(directory, "artifacts"));
  stores.push(store);
  const oracleBytes = readFileSync(new URL("oracle.json", root));
  const oracle = parseSourceOracleBytes(oracleBytes);
  const oracleRef = persist(store, {
    operation: "oracle",
    kind: "sca-p03-source-oracle",
    producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
    schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
    body: oracle,
  });
  const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
    const source = oracle.fixtures.find((item) => item.language === language);
    if (source === undefined) throw new Error("fixture missing");
    const bytes = readFileSync(new URL(source.file, root));
    const ref = persist(store, {
      operation: `fixture-${language}`,
      kind: "sca-p03-qualification-fixture-content",
      producer: "host:sca-p03-qualification-authority",
      schema: "penny.sca-p03-qualification-fixture-content.v1",
      body: {
        schema_id: "penny.sca-p03-qualification-fixture-content.v1",
        schema_version: 1,
        fixture_id: source.fixture_id,
        language,
        path: source.path,
        encoding: "base64",
        content_base64: bytes.toString("base64"),
        byte_length: bytes.length,
        content_sha256: sha256(bytes),
      },
    });
    return { source, ref };
  });
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    withScaP03Digest(
      {
        schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
        schema_version: 2,
        corpus_id: "p03-source-oracle-corpus",
        fixture_content_refs: ordered.map((f) => f.ref),
        fixture_ids: ordered.map((f) => f.source.fixture_id),
        languages: ["php", "javascript", "typescript"] as const,
        expected_cases: projectSourceOracleCases(oracle),
      },
      "corpus_sha256"
    )
  );
  const corpusRef = persist(store, {
    operation: "corpus",
    kind: "sca-p03-qualification-fixture-corpus",
    producer: "host:sca-p03-qualification-authority",
    schema: "penny.sca-p03-qualification-fixture-corpus.v2",
    body: corpus,
    upstream: ordered.map((f) => f.ref),
  });
  const [php, javascript, typescript] = ordered;
  if (php === undefined || javascript === undefined || typescript === undefined)
    throw new Error("fixture roster missing");
  const review = {
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1 as const,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    oracle_sha256: oracle.oracle_sha256,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixture_content_sha256: [
      php.source.content_sha256,
      javascript.source.content_sha256,
      typescript.source.content_sha256,
    ],
    expected_cases: projectSourceOracleCases(oracle),
  };
  const reviewRef = persist(store, {
    operation: "review",
    kind: "sca-p03-source-oracle-review",
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    schema: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    body: { ...review, review_sha256: sha256(canonicalJson(review)) },
    upstream: [oracleRef],
  });
  const seal = (
    overrides: {
      oracle_ref?: ArtifactRef;
      corpus_ref?: ArtifactRef;
      corpus?: ScaP03QualificationFixtureCorpusV2;
      review_ref?: ArtifactRef;
      parser_identity_sha256?: string;
      upstream?: readonly ArtifactRef[];
    } = {}
  ) => {
    const receipt = sealSourceOracleValidationReceipt({
      oracle_ref: overrides.oracle_ref ?? oracleRef,
      oracle_sha256: oracle.oracle_sha256,
      review_ref: overrides.review_ref ?? reviewRef,
      parser_identity_sha256: overrides.parser_identity_sha256 ?? oracle.parser.identity_sha256,
      fixtures: [
        {
          fixture_id: php.source.fixture_id,
          language: php.source.language,
          content_ref: php.ref,
          content_sha256: php.source.content_sha256,
        },
        {
          fixture_id: javascript.source.fixture_id,
          language: javascript.source.language,
          content_ref: javascript.ref,
          content_sha256: javascript.source.content_sha256,
        },
        {
          fixture_id: typescript.source.fixture_id,
          language: typescript.source.language,
          content_ref: typescript.ref,
          content_sha256: typescript.source.content_sha256,
        },
      ],
      corpus_ref: overrides.corpus_ref ?? corpusRef,
      corpus_sha256: (overrides.corpus ?? corpus).corpus_sha256,
      expected_cases: (overrides.corpus ?? corpus).expected_cases,
      validated_at: "2026-09-28T00:00:00Z",
    });
    return persist(store, {
      operation: `receipt-${stores.length}-${sha256(canonicalJson(receipt)).slice(0, 8)}`,
      kind: "sca-p03-source-oracle-validation",
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
      schema: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      body: receipt,
      upstream: overrides.upstream ?? [
        overrides.oracle_ref ?? oracleRef,
        overrides.corpus_ref ?? corpusRef,
        ...ordered.map((f) => f.ref),
        overrides.review_ref ?? reviewRef,
      ],
    });
  };
  const receiptRef = seal();
  const request = {
    run_id: RUN,
    source_oracle_ref: oracleRef,
    source_oracle_validation_ref: receiptRef,
    fixture_corpus_ref: corpusRef,
    fixture_content_refs: ordered.map((f) => f.ref),
  };
  const verify = (next = request, nextCorpus = corpus) =>
    assertSourceOracleAuthority({
      store,
      request: next,
      corpus: nextCorpus,
    });
  return {
    store,
    oracle,
    oracleRef,
    reviewRef,
    corpusRef,
    corpus,
    ordered,
    receiptRef,
    request,
    seal,
    verify,
  };
}

describe("P03 exact source-oracle admission", () => {
  it("accepts the independently reviewed 21-case fixture and exact sorted lineage", () => {
    const f = fixture();
    expect(() => f.verify()).not.toThrow();
    expect(f.corpus.expected_cases).toHaveLength(21);
  });
  it("rejects missing oracle fields and legacy request wire bytes", () => {
    expect(() =>
      validateScaP03RequestV2({ schema_id: "penny.sca-p03-request.v1", schema_version: 1 })
    ).toThrow();
    const f = fixture();
    expect(() => f.verify({ ...f.request, source_oracle_validation_ref: f.corpusRef })).toThrow();
  });
  it("rejects noncanonical and duplicate-key oracle bytes", () => {
    const f = fixture();
    for (const raw of [
      canonicalJson(f.oracle) + "\n",
      canonicalJson(f.oracle).replace(
        '"schema_version":2',
        '"schema_version":2,"schema_version":2'
      ),
    ]) {
      const ref = persist(f.store, {
        operation: sha256(raw).slice(0, 10),
        kind: "sca-p03-source-oracle",
        producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
        schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
        body: f.oracle,
        raw,
      });
      const receipt = f.seal({ oracle_ref: ref });
      expect(() =>
        f.verify({ ...f.request, source_oracle_ref: ref, source_oracle_validation_ref: receipt })
      ).toThrow();
    }
  });
  it("rejects an incorrect oracle self digest", () => {
    const f = fixture();
    const ref = persist(f.store, {
      operation: "bad-digest",
      kind: "sca-p03-source-oracle",
      producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
      schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
      body: { ...f.oracle, oracle_sha256: sha256("wrong") },
    });
    expect(() =>
      f.verify({
        ...f.request,
        source_oracle_ref: ref,
        source_oracle_validation_ref: f.seal({ oracle_ref: ref }),
      })
    ).toThrow(/digest/);
  });
  it("rejects an invalid receipt self-digest and a duplicated review provenance", () => {
    const f = fixture();
    const receipt = parseSourceOracleValidationReceiptBytes(
      f.store.readById(f.receiptRef.artifact_id)
    );
    const bad = persist(f.store, {
      operation: "bad-receipt-digest",
      kind: "sca-p03-source-oracle-validation",
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
      schema: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      body: { ...receipt, receipt_sha256: sha256("wrong") },
      upstream: [f.oracleRef, f.corpusRef, ...f.ordered.map((entry) => entry.ref), f.reviewRef],
    });
    expect(() => f.verify({ ...f.request, source_oracle_validation_ref: bad })).toThrow(/digest/);
    expect(() =>
      f.verify({ ...f.request, source_oracle_validation_ref: f.seal({ review_ref: f.oracleRef }) })
    ).toThrow();
  });

  it("rejects a foreign producer, run, review and stale revision", () => {
    const f = fixture();
    for (const change of [
      { producer: "host:foreign", run: RUN },
      { producer: SCA_P03_SOURCE_ORACLE_PRODUCER, run: "foreign-run" },
    ]) {
      const ref = persist(f.store, {
        operation: `foreign-${change.producer}-${change.run}`,
        kind: "sca-p03-source-oracle",
        schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
        producer: change.producer,
        run: change.run,
        body: f.oracle,
      });
      expect(() =>
        f.verify({
          ...f.request,
          source_oracle_ref: ref,
          source_oracle_validation_ref: f.seal({ oracle_ref: ref }),
        })
      ).toThrow();
    }
    const review = persist(f.store, {
      operation: "foreign-review",
      kind: "sca-p03-source-oracle-review",
      producer: "host:foreign",
      schema: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
      body: { schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA },
    });
    expect(() =>
      f.verify({ ...f.request, source_oracle_validation_ref: f.seal({ review_ref: review }) })
    ).toThrow();
    const stale = persist(f.store, {
      operation: "oracle",
      kind: "sca-p03-source-oracle",
      producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
      schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
      version: 2,
      parent: f.oracleRef,
      body: f.oracle,
    });
    expect(() =>
      f.verify({
        ...f.request,
        source_oracle_ref: stale,
        source_oracle_validation_ref: f.seal({ oracle_ref: stale }),
      })
    ).toThrow();
  });
  it("rejects parser, fixture, corpus, projection and upstream substitutions", () => {
    const f = fixture();
    expect(() =>
      f.verify({
        ...f.request,
        source_oracle_validation_ref: f.seal({ parser_identity_sha256: sha256("drift") }),
      })
    ).toThrow();
    const { corpus_sha256: _oldCorpusDigest, ...corpusWithoutDigest } = f.corpus;
    const alteredCorpus = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          ...corpusWithoutDigest,
          expected_cases: f.corpus.expected_cases.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  oracle_assertions: item.oracle_assertions.map((assertion) =>
                    assertion.start === undefined
                      ? assertion
                      : { ...assertion, start: { ...assertion.start, name: "decoy_handler" } }
                  ),
                }
              : item
          ),
        },
        "corpus_sha256"
      )
    );
    const changedRef = persist(f.store, {
      operation: "substituted-corpus",
      kind: "sca-p03-qualification-fixture-corpus",
      producer: "host:sca-p03-qualification-authority",
      schema: "penny.sca-p03-qualification-fixture-corpus.v2",
      body: alteredCorpus,
      upstream: f.ordered.map((entry) => entry.ref),
    });
    expect(() =>
      f.verify(
        {
          ...f.request,
          fixture_corpus_ref: changedRef,
          source_oracle_validation_ref: f.seal({ corpus_ref: changedRef, corpus: alteredCorpus }),
        },
        alteredCorpus
      )
    ).toThrow();
    expect(() =>
      f.verify({
        ...f.request,
        fixture_content_refs: [...f.request.fixture_content_refs].reverse(),
      })
    ).toThrow();
    expect(() =>
      f.verify({
        ...f.request,
        source_oracle_validation_ref: f.seal({ upstream: [f.oracleRef, f.corpusRef, f.reviewRef] }),
      })
    ).toThrow();
  });
  it("rejects a validly rehashed PHP decoy endpoint against immutable independent review", () => {
    const f = fixture();
    const php = f.ordered.find((item) => item.source.language === "php");
    if (php === undefined) throw new Error("PHP fixture missing");
    const original = readFileSync(new URL(php.source.file, root)).toString("utf8");
    const changedSource = original.replace(
      "add_action('init', 'handle_record')",
      "add_action('init', 'decoy_handler')"
    );
    if (changedSource === original) throw new Error("decoy mutation did not apply");
    const sourceBytes = Buffer.from(changedSource);
    const fixtureRef = persist(f.store, {
      operation: "php-decoy-content",
      kind: "sca-p03-qualification-fixture-content",
      producer: "host:sca-p03-qualification-authority",
      schema: "penny.sca-p03-qualification-fixture-content.v1",
      body: {
        schema_id: "penny.sca-p03-qualification-fixture-content.v1",
        schema_version: 1,
        fixture_id: php.source.fixture_id,
        language: "php",
        path: php.source.path,
        encoding: "base64",
        content_base64: sourceBytes.toString("base64"),
        byte_length: sourceBytes.length,
        content_sha256: sha256(sourceBytes),
      },
    });
    const nextFixtures = f.request.fixture_content_refs.map((ref) =>
      ref.artifact_id === php.ref.artifact_id ? fixtureRef : ref
    );
    const changed = {
      ...f.oracle,
      fixtures: f.oracle.fixtures.map((item) =>
        item.language === "php"
          ? {
              ...item,
              content_sha256: sha256(sourceBytes),
              registration: {
                ...item.registration,
                site: {
                  ...item.registration.site,
                  text: item.registration.site.text.replace("'handle_record'", "'decoy_handler'"),
                },
                callback: item.registration.negative,
              },
            }
          : item
      ),
    };
    const { oracle_sha256: _oldDigest, ...unsigned } = changed;
    const reboundOracle = { ...unsigned, oracle_sha256: sha256(canonicalJson(unsigned)) };
    const oracleRef = persist(f.store, {
      operation: "php-decoy-oracle",
      kind: "sca-p03-source-oracle",
      producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
      schema: SCA_P03_SOURCE_ORACLE_SCHEMA,
      body: reboundOracle,
    });
    const { corpus_sha256: _oldCorpusDigest, ...corpusUnsigned } = f.corpus;
    const corpus = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          ...corpusUnsigned,
          fixture_content_refs: nextFixtures,
          expected_cases: projectSourceOracleCases(reboundOracle),
        },
        "corpus_sha256"
      )
    );
    const corpusRef = persist(f.store, {
      operation: "php-decoy-corpus",
      kind: "sca-p03-qualification-fixture-corpus",
      producer: "host:sca-p03-qualification-authority",
      schema: "penny.sca-p03-qualification-fixture-corpus.v2",
      body: corpus,
      upstream: nextFixtures,
    });
    const fixtureBindings = (["php", "javascript", "typescript"] as const).map((language) => {
      const entry = reboundOracle.fixtures.find((item) => item.language === language);
      const fixture = f.ordered.find((item) => item.source.language === language);
      if (entry === undefined || fixture === undefined) throw new Error("fixture roster missing");
      return {
        fixture_id: entry.fixture_id,
        language,
        content_ref: language === "php" ? fixtureRef : fixture.ref,
        content_sha256: entry.content_sha256,
      };
    });
    const [phpBinding, jsBinding, tsBinding] = fixtureBindings;
    if (phpBinding === undefined || jsBinding === undefined || tsBinding === undefined)
      throw new Error("fixture bindings missing");
    const receipt = sealSourceOracleValidationReceipt({
      oracle_ref: oracleRef,
      oracle_sha256: reboundOracle.oracle_sha256,
      review_ref: f.reviewRef,
      parser_identity_sha256: reboundOracle.parser.identity_sha256,
      fixtures: [phpBinding, jsBinding, tsBinding],
      corpus_ref: corpusRef,
      corpus_sha256: corpus.corpus_sha256,
      expected_cases: corpus.expected_cases,
      validated_at: "2026-09-28T00:00:00Z",
    });
    const receiptRef = persist(f.store, {
      operation: "php-decoy-receipt",
      kind: "sca-p03-source-oracle-validation",
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
      schema: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      body: receipt,
      upstream: [oracleRef, corpusRef, ...nextFixtures, f.reviewRef],
    });
    expect(() =>
      f.verify(
        {
          ...f.request,
          source_oracle_ref: oracleRef,
          source_oracle_validation_ref: receiptRef,
          fixture_corpus_ref: corpusRef,
          fixture_content_refs: nextFixtures,
        },
        corpus
      )
    ).toThrow(/independent review/);
  });
});
