import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  makeScaP03QueryCandidateV2,
  validateScaP03QueryCandidateV2,
  validateScaP03QualificationFixtureCorpusV2,
  withScaP03Digest,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  matchesSourceMark,
  matchesSourceRelationship,
  validateAndSealSourceOracle,
  validateSourceFixture,
  validateSourceSemantics,
  validateSourceOracleBytes,
} from "../src/p03-source-oracle.js";
import { readSourceOracle } from "./p03-source-oracle.js";
import {
  parseSourceOracleValidationReceiptBytes,
  assertSourceOracleReceiptCorrespondence,
} from "../src/p03-source-oracle-receipt.js";

const digest = sha256("offline graph identity");

describe("P03 independently authored source-level oracle", () => {
  it("rejects noncanonical bytes, duplicate keys, unknown fields and incorrect self-digests", async () => {
    const bytes = await readFile(new URL("./fixtures/p03-v2/oracle.json", import.meta.url));
    const oracle = validateSourceOracleBytes(bytes);
    expect(
      sha256(
        canonicalJson(
          Object.fromEntries(Object.entries(oracle).filter(([key]) => key !== "oracle_sha256"))
        )
      )
    ).toBe(oracle.oracle_sha256);
    expect(() => validateSourceOracleBytes(Buffer.from(`${bytes.toString("utf8")}\n`))).toThrow(
      "noncanonical"
    );
    expect(() =>
      validateSourceOracleBytes(
        Buffer.from(
          bytes
            .toString("utf8")
            .replace('"schema_version":2', '"schema_version":2,"schema_version":2')
        )
      )
    ).toThrow("duplicate keys");
    expect(() =>
      validateSourceOracleBytes(Buffer.from(canonicalJson({ ...oracle, unknown: true })))
    ).toThrow();
    expect(() =>
      validateSourceOracleBytes(
        Buffer.from(canonicalJson({ ...oracle, oracle_sha256: sha256("wrong") }))
      )
    ).toThrow("digest drift");
  });
  it("rejects syntax-valid callee, assignment, branch and callback mutations even when bytes are re-hashed", async () => {
    const { fixtures } = await readSourceOracle();
    for (const fixture of fixtures) {
      const source = fixture.bytes.toString("utf8");
      const replacements =
        fixture.language === "javascript"
          ? [
              ["persistRecord(sinkValue)", "persistDecoy(sinkValue)"],
              ["const sinkValue = guardedAction", "const sinkValue = assignedValue"],
              ["} else {\n    persistDecoy", "}\n  persistDecoy"],
              ['router.get("/records", handleRecord)', 'router.get("/records", decoyHandler)'],
            ]
          : fixture.language === "typescript"
            ? [
                ["persistRecord(sinkValue)", "persistDecoy(sinkValue)"],
                ["const sinkValue = guardedAction", "const sinkValue = assignedValue"],
                ["} else {\n      return persistDecoy", "}\n    return persistDecoy"],
                ['@Get("one")\n  handleRecord', '@Get("one")\n  decoyHandler'],
              ]
            : [
                ["persist_record($sink_value)", "persist_decoy($sink_value)"],
                ["$sink_value = $guarded_action", "$sink_value = $assigned_value"],
                ["} else {\n        persist_decoy", "}\n    persist_decoy"],
                ["add_action('init', 'handle_record')", "add_action('init', 'decoy_handler')"],
              ];
      for (const [before, after] of replacements) {
        if (before === undefined || after === undefined || !source.includes(before))
          throw new Error("mutation target missing");
        const bytes = Buffer.from(source.replace(before, after));
        const rebound = {
          ...fixture,
          bytes,
          byte_length: bytes.length,
          content_sha256: sha256(bytes),
        };
        expect(() => validateSourceSemantics(rebound, bytes)).toThrow(/P03/);
      }
    }
  });
  it("maps the reviewed source selectors to all 21 persisted query-case assertions without live hashes", async () => {
    const { fixtures } = await readSourceOracle();
    const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
      const fixture = fixtures.find((item) => item.language === language);
      if (!fixture) throw new Error("missing source fixture");
      return fixture;
    });
    const ref = (index: number) => ({
      schema_version: 2 as const,
      artifact_id: `art_${sha256(`fixture-${index}`)}`,
      run_id: "source-oracle",
      phase: "SCA-P03",
      branch_id: null,
      kind: "fixture",
      operation_id: `fixture-${index}`,
      version: 1,
      producer: "host:fixture",
      media_type: "application/json",
      byte_length: 1,
      content_digest: sha256(`fixture-${index}`),
      store_ref: `artifact://sha256/${sha256(`fixture-${index}`)}`,
    });
    const corpus = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
          schema_version: 2,
          corpus_id: "source-oracle-corpus",
          fixture_content_refs: ordered.map((_, index) => ref(index)),
          fixture_ids: ordered.map((item) => item.fixture_id),
          languages: ["php", "javascript", "typescript"],
          expected_cases: ordered.flatMap((f) =>
            f.material_cases.map((c) => ({
              case_id: `p03-${f.language}-${c.query_id.replaceAll(".", "-")}`,
              language: f.language,
              query_id: c.query_id,
              expected_observed_sha256: null,
              oracle_assertions: c.assertions,
            }))
          ),
        },
        "corpus_sha256"
      )
    );
    expect(corpus.expected_cases).toHaveLength(21);
    expect(corpus.expected_cases.every((c) => c.expected_observed_sha256 === null)).toBe(true);
  });

  it("seals the projected 21 cases only after native validation, including a rehashed PHP call substitution", async () => {
    const { fixtures, oracle } = await readSourceOracle();
    const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
      const fixture = fixtures.find((entry) => entry.language === language);
      if (fixture === undefined) throw new Error("missing fixture");
      return fixture;
    });
    const ref = (label: string, content: Uint8Array) => {
      const digest = sha256(content);
      return {
        schema_version: 2 as const,
        artifact_id: `art_${sha256(`artifact:${label}:${digest}`)}`,
        run_id: "p03-reviewed-cohort",
        phase: "SCA-P03",
        branch_id: null,
        kind: "fixture",
        operation_id: label,
        version: 1,
        producer: "host:fixture",
        media_type: "application/json",
        byte_length: content.byteLength,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      };
    };
    const fixtureInputs = ordered.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      language: fixture.language,
      path: fixture.path,
      content_sha256: fixture.content_sha256,
      bytes: fixture.bytes,
      ref: ref(fixture.fixture_id, fixture.bytes),
    }));
    const corpus = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
          schema_version: 2,
          corpus_id: "source-oracle-corpus",
          fixture_content_refs: fixtureInputs.map((fixture) => fixture.ref),
          fixture_ids: fixtureInputs.map((fixture) => fixture.fixture_id),
          languages: ["php", "javascript", "typescript"],
          expected_cases: ordered.flatMap((f) =>
            f.material_cases.map((c) => ({
              case_id: `p03-${f.language}-${c.query_id.replaceAll(".", "-")}`,
              language: f.language,
              query_id: c.query_id,
              expected_observed_sha256: null,
              oracle_assertions: c.assertions,
            }))
          ),
        },
        "corpus_sha256"
      )
    );
    const oracleBytes = Buffer.from(canonicalJson(oracle));
    const input = {
      oracle_bytes: oracleBytes,
      oracle_ref: ref("oracle", oracleBytes),
      review_ref: ref("review", Buffer.from("review")),
      corpus_ref: ref("corpus", Buffer.from(canonicalJson(corpus))),
      corpus,
      fixtures: fixtureInputs,
      validated_at: "2026-09-28T00:00:00Z",
    };
    const receipt = validateAndSealSourceOracle(input);
    const { corpus_sha256: _previousCorpus, ...corpusCore } = corpus;
    void _previousCorpus;
    const omitted = validateScaP03QualificationFixtureCorpusV2(
      withScaP03Digest(
        {
          ...corpusCore,
          expected_cases: corpus.expected_cases.map((entry) =>
            entry.language === "php" && entry.query_id === "p03.dataflow-source-sink.v2"
              ? {
                  ...entry,
                  oracle_assertions: entry.oracle_assertions.filter(
                    (assertion) => assertion.expectation !== "absent"
                  ),
                }
              : entry
          ),
        },
        "corpus_sha256"
      )
    );
    expect(() =>
      validateAndSealSourceOracle({
        ...input,
        corpus: omitted,
        corpus_ref: ref("omitted-corpus", Buffer.from(canonicalJson(omitted))),
      })
    ).toThrow(/corpus_mismatch/u);
    expect(receipt.status).toBe("PASS");
    expect(receipt.expected_cases).toHaveLength(21);
    const receiptBytes = Buffer.from(canonicalJson(receipt));
    expect(parseSourceOracleValidationReceiptBytes(receiptBytes)).toEqual(receipt);
    expect(() =>
      parseSourceOracleValidationReceiptBytes(Buffer.concat([receiptBytes, Buffer.from("\n")]))
    ).toThrow("noncanonical");
    expect(() =>
      parseSourceOracleValidationReceiptBytes(
        Buffer.from(
          receiptBytes
            .toString("utf8")
            .replace('"status":"PASS"', '"status":"PASS","status":"PASS"')
        )
      )
    ).toThrow("noncanonical");
    expect(() =>
      parseSourceOracleValidationReceiptBytes(
        Buffer.from(canonicalJson({ ...receipt, receipt_sha256: sha256("wrong") }))
      )
    ).toThrow("digest_mismatch");
    expect(() =>
      assertSourceOracleReceiptCorrespondence({
        ...input,
        oracle,
        receipt,
        review_ref: ref("foreign-review", Buffer.from("foreign")),
      })
    ).toThrow("p03_source_oracle_corpus_mismatch");
    const { corpus_sha256: originalCorpusDigest, ...unsignedCorpus } = corpus;
    expect(originalCorpusDigest).toBe(corpus.corpus_sha256);
    expect(() =>
      assertSourceOracleReceiptCorrespondence({
        ...input,
        oracle,
        receipt,
        corpus: validateScaP03QualificationFixtureCorpusV2(
          withScaP03Digest(
            {
              ...unsignedCorpus,
              expected_cases: corpus.expected_cases.map((c) =>
                c.query_id === "p03.call-resolution.v2" && c.language === "php"
                  ? {
                      ...c,
                      oracle_assertions: c.oracle_assertions.map((a) =>
                        a.expectation === "present"
                          ? { ...a, end: { ...a.end, name: "persist_decoy" } }
                          : a
                      ),
                    }
                  : c
              ),
            },
            "corpus_sha256"
          )
        ),
      })
    ).toThrow("p03_source_oracle_corpus_mismatch");
    const php = ordered[0];
    if (php === undefined) throw new Error("missing PHP fixture");
    const mutated = Buffer.from(
      php.bytes
        .toString("utf8")
        .replace("persist_record($sink_value)", "persist_decoy($sink_value)")
    );
    const { bytes: originalPhpBytes, ...phpMaterial } = php;
    expect(originalPhpBytes).toEqual(php.bytes);
    const changed = {
      ...phpMaterial,
      content_sha256: sha256(mutated),
      byte_length: mutated.length,
      call: {
        ...php.call,
        site: {
          ...php.call.site,
          name: "persist_decoy",
          text: "        persist_decoy($sink_value);",
        },
      },
      reaching_definition: {
        ...php.reaching_definition,
        sink: { ...php.reaching_definition.sink, text: "        persist_decoy($sink_value);" },
      },
    };
    const unsignedOracle = {
      ...oracle,
      fixtures: oracle.fixtures.map((f) => (f.language === "php" ? changed : f)),
    };
    const { oracle_sha256: ignoredDigest, ...unsigned } = unsignedOracle;
    expect(ignoredDigest).toBe(oracle.oracle_sha256);
    const rebound = { ...unsigned, oracle_sha256: sha256(canonicalJson(unsigned)) };
    const driftParser = {
      ...oracle.parser,
      runtime: { ...oracle.parser.runtime, version: "99.0.0" },
    };
    const { identity_sha256: oldIdentityDigest, ...parserUnsigned } = driftParser;
    expect(oldIdentityDigest).toBe(oracle.parser.identity_sha256);
    const parser = { ...parserUnsigned, identity_sha256: sha256(canonicalJson(parserUnsigned)) };
    const { oracle_sha256: originalOracleDigest, ...originalUnsigned } = oracle;
    expect(originalOracleDigest).toBe(oracle.oracle_sha256);
    const driftUnsigned = { ...originalUnsigned, parser };
    expect(() =>
      validateSourceOracleBytes(
        Buffer.from(
          canonicalJson({
            ...driftUnsigned,
            oracle_sha256: sha256(canonicalJson(driftUnsigned)),
          })
        )
      )
    ).toThrow("parser identity drift");
    expect(() =>
      validateAndSealSourceOracle({
        ...input,
        oracle_bytes: Buffer.from(canonicalJson(rebound)),
        oracle_ref: ref("oracle-changed", Buffer.from(canonicalJson(rebound))),
        fixtures: fixtureInputs.map((f) =>
          f.language === "php"
            ? {
                ...f,
                bytes: mutated,
                content_sha256: sha256(mutated),
                ref: ref("php-changed", mutated),
              }
            : f
        ),
      })
    ).toThrow(/P03/);
  });

  it("binds exact bytes and every positive and negative line; detects drift", async () => {
    const { fixtures, oracle } = await readSourceOracle();
    expect(oracle.material_dimensions).toEqual([
      "symbol",
      "call",
      "guard",
      "reaching_definition",
      "registration",
    ]);
    for (const f of fixtures) {
      validateSourceFixture(f, f.bytes);
      const symbol = f.symbols[0];
      if (symbol === undefined) throw new Error("missing symbol oracle");
      expect(
        matchesSourceMark({ path: f.path, line: symbol.line, name: symbol.name }, f, symbol)
      ).toBe(true);
      expect(
        matchesSourceMark(
          { path: f.path, line: f.symbol_negative.line, name: f.symbol_negative.name },
          f,
          symbol
        )
      ).toBe(false);
      expect(() => validateSourceFixture(f, Buffer.concat([f.bytes, Buffer.from(" ")]))).toThrow(
        "byte drift"
      );
      expect(() =>
        validateSourceFixture(
          { ...f, call: { ...f.call, site: { ...f.call.site, line: f.call.negative.line } } },
          f.bytes
        )
      ).toThrow(/drift/u);
      expect(
        matchesSourceMark(
          { path: f.path, line: f.call.site.line, name: f.call.site.name },
          f,
          f.call.site
        )
      ).toBe(true);
      expect(
        matchesSourceMark(
          { path: f.path, line: f.call.negative.line, name: f.call.negative.name },
          f,
          f.call.site
        )
      ).toBe(false);
      expect(
        matchesSourceMark(
          {
            path: f.path,
            line: f.reaching_definition.negative.line,
            name: f.reaching_definition.negative.name,
          },
          f,
          f.reaching_definition.sink
        )
      ).toBe(false);
      expect(
        matchesSourceMark(
          { path: f.path, line: f.registration.negative.line, name: f.registration.negative.name },
          f,
          f.registration.site
        )
      ).toBe(false);
      expect(f.guard.expected_branch).toBe("true");
    }
  });

  it("accepts only accounted named relationship endpoints, not wrong callee/sink, CFG or dispatch", async () => {
    const { fixtures } = await readSourceOracle();
    for (const f of fixtures) {
      const vertex = (
        id: string,
        role: "call_site" | "callee" | "source" | "sink",
        label: string,
        mark: { line: number; name: string }
      ) => ({
        node_id: id,
        role,
        label,
        name: mark.name,
        full_name: null,
        path: f.path,
        line: mark.line,
        column: null,
        location_provenance: "direct" as const,
        location_owner_node_id: null,
        location_evidence: null,
      });
      const base = {
        candidate_kind: "call_or_unresolved_call" as const,
        query_id: "p03.call-resolution.v2" as const,
        claim: "call_resolution" as const,
        disposition: "supported" as const,
        reason_code: null,
        source_selector: null,
        sink_selector: null,
        framework: null,
        registration_form: null,
        callback_resolution: null,
        assumptions: [],
        graph_component_sha256: digest,
        source_snapshot_sha256: f.content_sha256,
        query_release_sha256: digest,
        hop_count: 1,
        truncated: false,
        path: f.path,
        line: f.call.site.line,
        stable_locator: "offline-source-selector",
        summary: "Exact offline source selector",
      };
      const first = vertex("call", "call_site", "call", f.call.site);
      const last = vertex("callee", "callee", "method", f.call.callee);
      const edge = {
        src_index: 0,
        dst_index: 1,
        src_node_id: "call",
        dst_node_id: "callee",
        kind: "call" as const,
        direction: "forward" as const,
        provenance: "observed_cpg" as const,
        branch_orientation: null,
        complement_ref: null,
      };
      const check = (core: Parameters<typeof makeScaP03QueryCandidateV2>[0]) =>
        validateScaP03QueryCandidateV2(makeScaP03QueryCandidateV2(core), {
          query_id: core.query_id,
          accounted_paths: [f.path],
          graph_component_sha256: digest,
          source_snapshot_sha256: f.content_sha256,
          query_release_sha256: digest,
        });
      expect(matchesSourceRelationship(f, "call", first, last)).toBe(true);
      expect(
        matchesSourceRelationship(f, "call", first, { ...last, name: f.call.negative.name })
      ).toBe(false);
      expect(() => check({ ...base, vertices: [first, last], edges: [edge] })).not.toThrow();
      expect(matchesSourceMark({ ...last, name: f.call.negative.name }, f, f.call.callee)).toBe(
        false
      );
      const source = vertex("call", "source", "identifier", f.reaching_definition.source);
      const sink = vertex("callee", "sink", "identifier", f.reaching_definition.sink);
      const flow = {
        ...base,
        candidate_kind: "source_to_sink_flow" as const,
        query_id: "p03.dataflow-source-sink.v2" as const,
        claim: "reaching_definition" as const,
        source_selector: source.name,
        sink_selector: sink.name,
        line: source.line,
        vertices: [source, sink],
        edges: [{ ...edge, kind: "reaching_def" as const }],
      };
      expect(matchesSourceRelationship(f, "reaching_definition", source, sink)).toBe(true);
      expect(
        matchesSourceRelationship(f, "reaching_definition", source, {
          ...sink,
          name: f.reaching_definition.negative.name,
        })
      ).toBe(false);
      expect(
        matchesSourceRelationship(
          f,
          "registration",
          { path: f.path, line: f.registration.site.line, name: f.registration.site.name },
          { path: f.path, line: f.registration.callback.line, name: f.registration.callback.name }
        )
      ).toBe(true);
      expect(() => check(flow)).not.toThrow();
      expect(() =>
        check({ ...flow, sink_selector: f.reaching_definition.negative.name })
      ).toThrow();
      expect(
        matchesSourceMark(
          { ...sink, name: f.reaching_definition.negative.name },
          f,
          f.reaching_definition.sink
        )
      ).toBe(false);
      expect(() =>
        check({
          ...flow,
          vertices: [
            source,
            {
              ...sink,
              path: null,
              line: null,
              name: null,
              location_provenance: "external_unaccounted" as const,
            },
          ],
          disposition: "supported",
        })
      ).toThrow();
      expect(() =>
        check({
          ...base,
          query_id: "p03.control-guard.v2",
          claim: "control_reachability",
          candidate_kind: "guard_or_control_relationship",
          vertices: [
            { ...first, role: "guard", label: "control_structure" },
            { ...last, role: "action" },
          ],
          edges: [{ ...edge, kind: "cfg" }],
        })
      ).toThrow();
      expect(() =>
        check({
          ...base,
          query_id: "p03.framework-dispatch.v2",
          claim: "framework_dispatch",
          candidate_kind: "route_or_framework_surface",
          framework: f.registration.framework,
          registration_form: f.registration.form,
          callback_resolution: "observed",
          vertices: [
            { ...first, role: "registration" },
            { ...last, role: "handler" },
          ],
          edges: [edge],
        })
      ).toThrow();
    }
  });
});
