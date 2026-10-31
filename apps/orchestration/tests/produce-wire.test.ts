import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/checkpointer.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  artifactApproachDecisionPromptContract,
  artifactApproachPromptContract,
  parsePersistedArtifactApproach,
  parsePersistedProduceReview,
  parsePersistedArtifactApproachDecision,
  parsePersistedProducedArtifactDraftV2,
  producedArtifactDraftPromptContractV2,
  produceReviewPromptContract,
  validateProduceRequest,
} from "../dist/skill-contracts/produce.js";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "produce-real-output");
function captured(name: "request" | "approach" | "decision" | "draft"): string {
  return readFileSync(path.join(FIXTURE_ROOT, `${name}.txt`), "utf8");
}
function request() {
  const value: unknown = JSON.parse(captured("request"));
  return validateProduceRequest(value);
}
function core(text: string): string {
  const line = text.split("\n")[0];
  if (line === undefined) throw new Error("fixture core is absent");
  return line;
}
function withSummary(text: string, summary: unknown): Buffer {
  return Buffer.from(`${core(text)}\nSUMMARY:${JSON.stringify(summary)}`);
}
function approach() {
  return parsePersistedArtifactApproach(Buffer.from(captured("approach"))).approach;
}
function decision() {
  return parsePersistedArtifactApproachDecision(Buffer.from(captured("decision")), {
    approach: approach(),
  }).decision;
}

const reviewProductRef: ArtifactRef = {
  schema_version: 2,
  artifact_id: `art_${"a".repeat(64)}`,
  run_id: "review-wire-run",
  phase: "sealing_artifact",
  branch_id: null,
  kind: "semantic-core",
  operation_id: "review-wire-product",
  version: 1,
  producer: "host:artifact-sealer",
  media_type: "application/json",
  content_schema: { schema_id: "penny.produced-artifact.v2", schema_version: 2 },
  byte_length: 2,
  content_digest: "b".repeat(64),
  store_ref: `artifact://sha256/${"b".repeat(64)}`,
};
const reviewHostRef: ArtifactRef = {
  ...reviewProductRef,
  artifact_id: `art_${"c".repeat(64)}`,
  kind: "produce-mechanical-checks",
  producer: "host:produce-product-validator",
  branch_id: "mechanical",
  content_schema: { schema_id: "penny.produce-mechanical-checks.v1", schema_version: 1 },
};
const reviewValue = {
  schema_version: 1,
  review_kind: "validity",
  product_ref: reviewProductRef,
  host_check_ref: reviewHostRef,
  confidence: "CERTAIN",
  review: {
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: ["First finding.", "Second finding."],
    evidence: [
      "First exact evidence.",
      "Second exact evidence with `code`, SUMMARY: and braces {}.",
    ],
    strategy_delta: "Preserve exact strings, arrays and their order.\nNo new verification.",
  },
};
const reviewSummary = { confidence: reviewValue.confidence, ...reviewValue.review };
const reviewWire = `PRODUCE_REVIEW:${canonicalJson(reviewValue)}`;
function parseReview(bytes: Uint8Array, routingRepairSummary?: unknown) {
  return parsePersistedProduceReview(bytes, {
    state: "verifying_artifact",
    productRef: reviewProductRef,
    hostCheckRef: reviewHostRef,
    ...(routingRepairSummary === undefined ? {} : { routingRepairSummary }),
  });
}

describe("Produce host-owned review normalization", () => {
  it("preserves complete review values across whitespace/order and optional redundant SUMMARY", () => {
    const numericVariant = reviewWire.replace('"schema_version":1', '"schema_version":1.0e0');
    expect(parseReview(Buffer.from(numericVariant)).core).toEqual(reviewValue);
    const reordered = {
      review: reviewValue.review,
      confidence: reviewValue.confidence,
      host_check_ref: reviewHostRef,
      product_ref: reviewProductRef,
      review_kind: "validity",
      schema_version: 1,
    };
    for (const core of [
      canonicalJson(reviewValue),
      JSON.stringify(reordered),
      JSON.stringify(reordered, null, 2),
    ]) {
      for (const footer of [
        "",
        `\nSUMMARY: ${JSON.stringify(reviewSummary, null, 2)}`,
        `  \r\nSUMMARY:\t${JSON.stringify(reviewSummary)}  \n`,
      ]) {
        const bytes = Buffer.from(`PRODUCE_REVIEW: \t${core}${footer}`);
        const before = Buffer.from(bytes);
        expect(parseReview(bytes)).toEqual({ core: reviewValue, summary: reviewSummary });
        expect(bytes).toEqual(before);
      }
    }
  });

  it("accepts semantic-only V2 quality and validity judgments without copying references", () => {
    for (const kind of ["quality", "validity"] as const) {
      const review =
        kind === "quality"
          ? { ...reviewValue.review, verdict: "APPROVE", findings: [] }
          : reviewValue.review;
      const value = { schema_version: 2, review_kind: kind, confidence: "CERTAIN", review };
      const bytes = Buffer.from(`PRODUCE_REVIEW:${canonicalJson(value)}`);
      const before = Buffer.from(bytes);
      const parsed = parsePersistedProduceReview(bytes, {
        state: kind === "quality" ? "critiquing_artifact" : "verifying_artifact",
        productRef: reviewProductRef,
        ...(kind === "validity" ? { hostCheckRef: reviewHostRef } : {}),
      });
      expect(parsed).toEqual({ core: value, summary: { confidence: "CERTAIN", ...review } });
      expect(bytes).toEqual(before);
      // This parser establishes meaning only, not current-product approval/custody.
      for (const [key, extra] of Object.entries({
        product_ref: reviewProductRef,
        host_check_ref: kind === "quality" ? null : reviewHostRef,
        artifact_id: reviewHostRef.artifact_id,
        content_digest: reviewHostRef.content_digest,
        metadata: {},
      }))
        expect(() =>
          parsePersistedProduceReview(
            Buffer.from(`PRODUCE_REVIEW:${canonicalJson({ ...value, [key]: extra })}`),
            {
              state: kind === "quality" ? "critiquing_artifact" : "verifying_artifact",
              productRef: reviewProductRef,
              ...(kind === "validity" ? { hostCheckRef: reviewHostRef } : {}),
            }
          )
        ).toThrow();
      const contract = produceReviewPromptContract(kind);
      expect(contract).toContain(`"review_kind":{"const":"${kind}"`);
      expect(contract).not.toContain(`"const":"${kind === "quality" ? "validity" : "quality"}"`);
      expect(contract).not.toContain('"product_ref":');
      expect(contract).not.toContain('"host_check_ref":');
      expect(contract).toContain('"schema_version":{"const":2');
    }
  });

  it("preserves strict historical V1 bindings, including the observed truncated host-check ID defect", () => {
    expect(parseReview(Buffer.from(reviewWire)).core).toEqual(reviewValue);
    for (const key of ["product_ref", "host_check_ref"] as const) {
      for (const invalid of [
        { ...reviewValue[key], artifact_id: `art_${"a".repeat(45)}` },
        { ...reviewValue[key], artifact_id: `art_${"a".repeat(64)}` },
        { ...reviewValue[key], content_digest: "a".repeat(45) },
        null,
      ]) {
        const original = Buffer.from(
          `PRODUCE_REVIEW:${canonicalJson({ ...reviewValue, [key]: invalid })}`
        );
        // The valid repair projection cannot erase or correct an original reference field.
        if (canonicalJson(invalid) !== canonicalJson(reviewValue[key]))
          expect(() => parseReview(original, reviewSummary)).toThrow();
      }
    }
    const quality = {
      ...reviewValue,
      review_kind: "quality",
      host_check_ref: null,
      review: { ...reviewValue.review, verdict: "APPROVE", findings: [] },
    };
    expect(
      parsePersistedProduceReview(Buffer.from(`PRODUCE_REVIEW:${canonicalJson(quality)}`), {
        state: "critiquing_artifact",
        productRef: reviewProductRef,
      }).core
    ).toEqual(quality);
  });

  it("never salvages a malformed V2 core or contradictory footer through routing-only repair", () => {
    const value = {
      schema_version: 2,
      review_kind: "validity",
      confidence: "CERTAIN",
      review: reviewValue.review,
    };
    const wire = `PRODUCE_REVIEW:${canonicalJson(value)}`;
    for (const raw of [
      wire.slice(0, -1),
      wire.replace('"verdict":"PASS"', '"verdict":"FAIL"'),
      wire.replace('"review_kind":"validity"', '"review_kind":"quality"'),
      wire + "\nSUMMARY:not-json",
      wire + `\nSUMMARY:${canonicalJson({ ...reviewSummary, confidence: "PROBABLE" })}`,
      wire +
        `\nSUMMARY:${canonicalJson({ ...reviewSummary, evidence: [...reviewSummary.evidence].reverse() })}`,
    ])
      expect(() => parseReview(Buffer.from(raw), reviewSummary)).toThrow();
  });

  it("refuses duplicate decoded keys at every level including escaped and redundant keys", () => {
    for (const text of [
      reviewWire.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      reviewWire.replace('"verdict":"PASS"', '"verdict":"FAIL","verdict":"PASS"'),
      reviewWire.replace('"verdict":"PASS"', '"verdict":"PASS","ver\\u0064ict":"PASS"'),
      reviewWire.replace('"byte_length":2', '"byte_length":2,"byte_length":2'),
      `${reviewWire}\nSUMMARY:${JSON.stringify(reviewSummary).replace('"confidence":"CERTAIN"', '"confidence":"CERTAIN","confidence":"CERTAIN"')}`,
      `${reviewWire}\nSUMMARY:${JSON.stringify(reviewSummary).replace('"verdict":"PASS"', '"verdict":"PASS","ver\\u0064ict":"PASS"')}`,
    ])
      expect(() => parseReview(Buffer.from(text))).toThrow();
  });

  it("refuses malformed, incomplete, ambiguous, nonfinite, complex and oversized original bytes", () => {
    for (const bytes of [
      Buffer.from("PRODUCE_REVIEW:{}"),
      Buffer.from(reviewWire.slice(0, -1)),
      Buffer.from(`${reviewWire} prose`),
      Buffer.from(`${reviewWire}\n${reviewWire}`),
      Buffer.from(`Prose\n${reviewWire}`),
      Buffer.from(`\ufeff${reviewWire}`),
      Buffer.from(reviewWire.replace("First finding.", "First\\u0000finding.")),
      Buffer.from(reviewWire.replace("First finding.", "First\\ufefffinding.")),
      Buffer.concat([Buffer.from(reviewWire), Buffer.from([0])]),
      Buffer.concat([Buffer.from(reviewWire), Buffer.from([0xff])]),
      Buffer.from(reviewWire.replace('"schema_version":1', '"schema_version":1e309')),
      Buffer.from(reviewWire.replace('"schema_version":1', '"schema_version":NaN')),
      Buffer.from(
        reviewWire.replace('"schema_version":1', '"schema_version":1.00000000000000000001')
      ),
      Buffer.from(reviewWire.replace('"byte_length":2', '"byte_length":9007199254740993')),
      Buffer.from(reviewWire.replace('"byte_length":2', '"byte_length":1e-999')),
      Buffer.from(reviewWire.replace('"schema_version":1', '"schema_version":01')),
      Buffer.from(
        reviewWire.replace(
          '"schema_version":1',
          `"extra":${"[".repeat(32)}0${"]".repeat(32)},"schema_version":1`
        )
      ),
      Buffer.from(`PRODUCE_REVIEW:[${"0,".repeat(4096)}0]`),
      Buffer.alloc(262145, 0x20),
      Buffer.from(`${reviewWire}\nSUMMARY:not-json`),
      Buffer.from(
        `${reviewWire}\nSUMMARY:${JSON.stringify(reviewSummary)}\nSUMMARY:${JSON.stringify(reviewSummary)}`
      ),
      Buffer.from(`${reviewWire}\nSUMMARY:${JSON.stringify(reviewSummary)} trailing`),
      Buffer.from(`${reviewWire} SUMMARY:${JSON.stringify(reviewSummary)}`),
      Buffer.from(reviewWire.replace('"schema_version":1', '"extra":true,"schema_version":1')),
      Buffer.from(reviewWire.replace('"strategy_delta":', '"missing_strategy_delta":')),
    ])
      expect(() => parseReview(bytes)).toThrow();
  });

  it("never discards a malformed/contradictory present SUMMARY even with repaired routing", () => {
    for (const footer of [
      "not-json",
      JSON.stringify({ ...reviewSummary, confidence: "PROBABLE" }),
      JSON.stringify({ ...reviewSummary, evidence: ["Invented stronger evidence."] }),
      JSON.stringify({ ...reviewSummary, findings: [...reviewSummary.findings].reverse() }),
      JSON.stringify({ ...reviewSummary, strategy_delta: "Different strategy." }),
      JSON.stringify({
        ...reviewSummary,
        verdict: "UNVERIFIABLE",
        gap_kind: "verification_incomplete",
      }),
      JSON.stringify({ ...reviewSummary, extra: true }),
    ])
      expect(() =>
        parseReview(Buffer.from(`${reviewWire}\nSUMMARY:${footer}`), reviewSummary)
      ).toThrow();
    expect(() =>
      parseReview(Buffer.from(reviewWire), { ...reviewSummary, confidence: "PROBABLE" })
    ).toThrow();
    for (const field of ["product_ref", "host_check_ref"] as const) {
      expect(() =>
        parseReview(
          Buffer.from(
            `PRODUCE_REVIEW:${JSON.stringify({
              ...reviewValue,
              [field]: { ...reviewValue[field], run_id: "wrong-run" },
            })}`
          )
        )
      ).toThrow();
    }
  });
});

describe("Produce closed captured wire contracts", () => {
  it("reproduces the exact real outputs, including Ida's complete-before-confidence SUMMARY", () => {
    for (const [name, length, digest] of [
      ["request", 1243, "635a8af321d2c23c25e0da4f6f800d4e7138ca8bc0944df816b2f91b781f2308"],
      ["approach", 566, "a6fe7622db655bfc279622d1fc12367374d62f3b6f0ffcb42076257a51fd3a73"],
      ["decision", 840, "be354571b81c73afe86f307b51d4851104ab0010b49e99bc06d905d16f4b6b5e"],
      ["draft", 695, "cad0dec0d09c3ab6b8ee3b05962e2275671ff2cb0e016df34704454683d75c8a"],
    ] as const) {
      expect(Buffer.byteLength(captured(name))).toBe(length);
      expect(sha256(captured(name))).toBe(digest);
    }
    expect(approach().approaches).toHaveLength(1);
    expect(decision()).toMatchObject({ disposition: "selected", confidence: "CERTAIN" });
    expect(
      parsePersistedProducedArtifactDraftV2(Buffer.from(captured("draft")), { request: request() })
        .draft
    ).toMatchObject({
      schema_version: 2,
      content: '{"doors":"18:00","entry":"free","start":"18:30"}',
    });
  });

  it("accepts every SUMMARY property order across all active two-line formats", () => {
    for (const summary of [
      { confidence: "CERTAIN", complete: true },
      { complete: true, confidence: "CERTAIN" },
    ]) {
      expect(
        parsePersistedArtifactApproach(withSummary(captured("approach"), summary)).summary
      ).toEqual(summary);
      expect(
        parsePersistedProducedArtifactDraftV2(withSummary(captured("draft"), summary), {
          request: request(),
        }).summary
      ).toEqual(summary);
    }
    for (const keys of [
      ["confidence", "complete", "disposition"],
      ["confidence", "disposition", "complete"],
      ["complete", "confidence", "disposition"],
      ["complete", "disposition", "confidence"],
      ["disposition", "confidence", "complete"],
      ["disposition", "complete", "confidence"],
    ]) {
      const values: Record<string, unknown> = {
        confidence: "CERTAIN",
        complete: true,
        disposition: "selected",
      };
      const summary = Object.fromEntries(keys.map((key) => [key, values[key]]));
      expect(
        parsePersistedArtifactApproachDecision(withSummary(captured("decision"), summary), {
          approach: approach(),
        }).summary
      ).toEqual(summary);
    }
  });

  it("refuses unknown, duplicate, missing, aliased and conflicting routing fields", () => {
    for (const summary of [
      { complete: true, confidence: "CERTAIN", approved: true },
      { complete: true },
      { complete: "true", confidence: "CERTAIN" },
      { complete: true, confidence: "certain" },
      { complete: false, confidence: "CERTAIN" },
      { complete: true, confidence: "PROBABLE" },
    ]) {
      expect(() =>
        parsePersistedArtifactApproach(withSummary(captured("approach"), summary))
      ).toThrow();
      expect(() =>
        parsePersistedProducedArtifactDraftV2(withSummary(captured("draft"), summary), {
          request: request(),
        })
      ).toThrow();
    }
    expect(() =>
      parsePersistedArtifactApproach(
        Buffer.from(
          `${core(captured("approach"))}\nSUMMARY:{"complete":false,"complete":true,"confidence":"CERTAIN"}`
        )
      )
    ).toThrow();
    expect(() =>
      parsePersistedArtifactApproachDecision(
        withSummary(captured("decision"), {
          confidence: "CERTAIN",
          complete: true,
          disposition: "unresolved",
        }),
        { approach: approach() }
      )
    ).toThrow(/disposition/u);
  });

  it("refuses free text, fences, duplicate core keys, noncanonical cores and invalid encoding", () => {
    const text = captured("approach");
    for (const bytes of [
      Buffer.from(`Prose\n${text}`),
      Buffer.from(`\`\`\`json\n${text}\n\`\`\``),
      Buffer.from(`${text}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`),
      Buffer.from(`${text}\n\n`),
      Buffer.from(text.replace("\n", "\r\n")),
      Buffer.from(`\ufeff${text}`),
      Buffer.from(text.replace('"schema_version":1', '"schema_version":1,"schema_version":1')),
      Buffer.from(text.replace('"approaches":', '"approaches": ')),
      Buffer.concat([Buffer.from(text), Buffer.from([0])]),
      Buffer.concat([Buffer.from([0xff]), Buffer.from(text)]),
      Buffer.alloc(65_537, 0x61),
    ])
      expect(() => parsePersistedArtifactApproach(bytes)).toThrow();
    expect(parsePersistedArtifactApproach(Buffer.from(`${text}\n`)).approach).toEqual(approach());
  });

  it("preserves backticks inside schema-valid prose, Markdown and code strings", () => {
    const original = approach();
    const value = {
      ...original,
      approaches: original.approaches.map((item) => ({
        ...item,
        description: "Use `content` without an outer fence.",
      })),
    };
    expect(
      parsePersistedArtifactApproach(
        Buffer.from(
          `ARTIFACT_APPROACH:${canonicalJson(value)}\nSUMMARY:{"complete":true,"confidence":"CERTAIN"}`
        )
      ).approach
    ).toEqual(value);
    const originalDecision = decision();
    const selected = {
      ...originalDecision,
      rationale: "The `content` field satisfies the exact brief.",
    };
    expect(
      parsePersistedArtifactApproachDecision(
        Buffer.from(
          `ARTIFACT_APPROACH_DECISION:${canonicalJson(selected)}\nSUMMARY:{"disposition":"selected","complete":true,"confidence":"CERTAIN"}`
        ),
        { approach: value }
      ).decision
    ).toEqual(selected);
    const originalDraft = parsePersistedProducedArtifactDraftV2(Buffer.from(captured("draft")), {
      request: request(),
    }).draft;
    for (const [kind, content] of [
      ["markdown", "# Example\n\nUse `value`.\n\n```ts\nconst value = 1;\n```"],
      ["typescript", "const greeting = `Hello, ${name}`;"],
      ["shell", "printf '%s' '`literal`'"],
    ] as const) {
      const mediaType =
        kind === "markdown"
          ? "text/markdown; charset=utf-8"
          : kind === "typescript"
            ? "text/typescript; charset=utf-8"
            : "text/x-shellscript; charset=utf-8";
      const brief = { ...request(), artifact_kind: kind };
      const draft = { ...originalDraft, artifact_kind: kind, media_type: mediaType, content };
      expect(
        parsePersistedProducedArtifactDraftV2(
          Buffer.from(
            `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(draft)}\nSUMMARY:{"complete":true,"confidence":"CERTAIN"}`
          ),
          { request: brief }
        ).draft.content
      ).toBe(content);
    }
  });

  it("keeps decisions closed, exact-set bound and truthful for unresolved negatives", () => {
    const original = decision();
    for (const invalid of [
      { ...original, selected_approach_id: "unknown" },
      { ...original, approach_assessments: [] },
      {
        ...original,
        approach_assessments: [...original.approach_assessments, ...original.approach_assessments],
      },
      { ...original, blocking_questions: ["A blocking question remains."] },
      { ...original, disposition: "unresolved" },
      { ...original, recommended_approach_id: original.selected_approach_id },
    ]) {
      expect(() =>
        parsePersistedArtifactApproachDecision(
          Buffer.from(
            `ARTIFACT_APPROACH_DECISION:${canonicalJson(invalid)}\nSUMMARY:{"confidence":"CERTAIN","complete":true,"disposition":"selected"}`
          ),
          { approach: approach() }
        )
      ).toThrow();
    }
    const unresolved = {
      ...original,
      disposition: "unresolved",
      selected_approach_id: null,
      blocking_questions: ["Which missing source should be supplied?"],
      confidence: "UNCERTAIN",
    };
    expect(
      parsePersistedArtifactApproachDecision(
        Buffer.from(
          `ARTIFACT_APPROACH_DECISION:${canonicalJson(unresolved)}\nSUMMARY:{"disposition":"unresolved","complete":true,"confidence":"UNCERTAIN"}`
        ),
        { approach: approach() }
      ).decision
    ).toEqual(unresolved);
  });

  it("allows host-bound routing repair without repairing or fabricating semantic content", () => {
    const summary = { confidence: "CERTAIN", complete: true };
    for (const suffix of ["", '\nSUMMARY:{"confidence":"CERTAIN"}', "\nSUMMARY:not-json"]) {
      const bytes = Buffer.from(`${core(captured("approach"))}${suffix}`);
      expect(() => parsePersistedArtifactApproach(bytes)).toThrow();
      expect(
        parsePersistedArtifactApproach(bytes, { routingRepairSummary: summary }).approach
      ).toEqual(approach());
    }
    const malformed = core(captured("approach")).replace(
      '"schema_version":1',
      '"schema_version":2'
    );
    expect(() =>
      parsePersistedArtifactApproach(Buffer.from(malformed), { routingRepairSummary: summary })
    ).toThrow(/SCHEMA_INVALID/u);
    expect(() =>
      parsePersistedArtifactApproach(Buffer.from(core(captured("approach"))), {
        routingRepairSummary: { ...summary, ignore_validation: true },
      })
    ).toThrow();
    expect(() =>
      parsePersistedArtifactApproach(Buffer.from(core(captured("approach"))), {
        routingRepairSummary: { ...summary, confidence: "UNCERTAIN" },
      })
    ).toThrow(/confidence/u);
  });

  it("projects the closed SUMMARY contract and refuses old-version materialization aliases", () => {
    for (const contract of [
      artifactApproachPromptContract(),
      artifactApproachDecisionPromptContract(),
      producedArtifactDraftPromptContractV2(),
    ]) {
      expect(contract).toContain('"summary_schema":');
      expect(contract).toContain("property order is immaterial");
      expect(contract).toContain('"additionalProperties":false');
    }
    const draft = parsePersistedProducedArtifactDraftV2(Buffer.from(captured("draft")), {
      request: request(),
    }).draft;
    for (const invalid of [
      { ...draft, schema_version: 1 },
      { ...draft, external_actions_performed: false },
      { ...draft, content_sha256: "0".repeat(64) },
    ]) {
      expect(() =>
        parsePersistedProducedArtifactDraftV2(
          Buffer.from(
            `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(invalid)}\nSUMMARY:{"complete":true,"confidence":"CERTAIN"}`
          ),
          { request: request() }
        )
      ).toThrow(/SCHEMA_INVALID/u);
    }
  });
});
