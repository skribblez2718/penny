import { describe, expect, it } from "vitest";

import {
  assertDecisionLineage,
  canonicalJson,
  canonicalizeDecisionRequest,
  decisionDraftPromptContract,
  DecisionCoreV2Schema,
  DecisionDraftValidationError,
  MAX_DECISION_RATIONALE_REPORT_BYTES,
  MAX_PERSISTED_DECISION_DRAFT_BYTES,
  decisionRequestSha256,
  decisionSourceLineageSha256,
  parsePersistedDecisionDraft,
  parsePersistedDecisionRoutingSummary,
  projectDecisionDraft,
  sealDecisionDraft,
  sha256,
  validateCanonicalDecisionBytes,
  validateDecision,
  validateDecisionDraft,
  validateDecisionRequest,
  type DecisionDraftV2,
} from "../src/index.js";
import {
  decisionDraft,
  decisionRequest,
  persistedDecisionDraft,
} from "./fixtures/decision-fixtures.js";

const REQUEST_ID = `art_${"9".repeat(64)}`;
const DRAFT_ID = `art_${"a".repeat(64)}`;
const PRIOR_ID = `art_${"b".repeat(64)}`;
const WRONG_REQUEST_ID = `art_${"d".repeat(64)}`;
const FEEDBACK_ID = `art_${"e".repeat(64)}`;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function unknownString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function persisted(draft: DecisionDraftV2, summaryConfidence = draft.confidence): string {
  const { rationale_report: rationaleReport, ...core } = draft;
  return `${rationaleReport}\nDECISION_CORE:${JSON.stringify(core)}\nSUMMARY:{"confidence":"${summaryConfidence}","complete":true}`;
}

function sealed(draft: DecisionDraftV2 = decisionDraft("selected")) {
  const request = decisionRequest();
  return sealDecisionDraft({
    request,
    draft,
    requestSha256: decisionRequestSha256(request),
    sourceRequestArtifactId: REQUEST_ID,
    sourceDraftArtifactId: DRAFT_ID,
    exactInputArtifactIds: [],
  });
}

function sourceLineageWithDraftSha(decision: ReturnType<typeof sealed>, draftSha256: string) {
  const preimage = {
    request_artifact_id: decision.source_lineage.request_artifact_id,
    draft_artifact_id: decision.source_lineage.draft_artifact_id,
    draft_sha256: draftSha256,
    input_artifact_ids: decision.source_lineage.input_artifact_ids,
  };
  return { ...preimage, lineage_sha256: decisionSourceLineageSha256(preimage) };
}

function decisionRef(content: string) {
  const digest = sha256(content);
  return {
    schema_version: 2 as const,
    artifact_id: `art_${"c".repeat(64)}`,
    run_id: "run-decision-contract",
    phase: "sealing_decision",
    branch_id: null,
    kind: "semantic-core",
    operation_id: "sealed-decision:test",
    version: 1,
    producer: "host:decision-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function expectIssues(action: () => unknown): readonly string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof DecisionDraftValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected DecisionDraftValidationError");
}

describe("closed DecisionRequestV1", () => {
  it("canonicalizes the inline start vocabulary and rejects unknown fields", () => {
    const request = decisionRequest();
    const { decision_question: goal, ...constraints } = request;
    expect(canonicalizeDecisionRequest({ goal, constraints })).toEqual(request);
    expect(() => validateDecisionRequest({ ...request, domain_method: "weighted-sum" })).toThrow();
    expect(() =>
      canonicalizeDecisionRequest({ goal, constraints: { ...constraints, scheduling: true } })
    ).toThrow();
  });

  it("rejects bounds, duplicate IDs, unsafe IDs, and malformed text", () => {
    const request = decisionRequest();
    expect(() =>
      validateDecisionRequest({
        ...request,
        alternatives: Array.from({ length: 25 }, (_unused, index) => ({
          alternative_id: `alt_${index}`,
          label: `Alternative ${index}`,
          description: "Bounded description.",
        })),
      })
    ).toThrow();
    expect(() =>
      validateDecisionRequest({
        ...request,
        evidence: [{ evidence_id: "constraint_budget", statement: "Duplicate cross-kind ID." }],
      })
    ).toThrow(/unique/u);
    expect(() =>
      validateDecisionRequest({
        ...request,
        alternatives: [
          ...request.alternatives.slice(0, 2),
          { ...request.alternatives[2], alternative_id: "__proto__" },
        ],
      })
    ).toThrow();
    expect(() => validateDecisionRequest({ ...request, decision_question: "  " })).toThrow();
  });
});

describe("closed DecisionDraftV2 core invariants", () => {
  it.each(["selected", "ranked", "no_feasible_option", "unresolved", "not_applicable"] as const)(
    "validates the %s outcome",
    (outcome) => {
      expect(
        validateDecisionDraft(decisionDraft(outcome), {
          request: decisionRequest(),
          exactInputArtifactIds: [],
        }).outcome
      ).toBe(outcome);
    }
  );

  it("requires dimensions only when selected or ranked outcomes have multiple feasible survivors", () => {
    const request = decisionRequest();
    const selected = decisionDraft("selected");
    const uniqueSurvivor: DecisionDraftV2 = {
      ...selected,
      feasibility: selected.feasibility.map((entry) =>
        entry.alternative_id === "alt_a"
          ? { ...entry, status: "feasible" }
          : { ...entry, status: "infeasible" }
      ),
      comparison_dimension_ids: [],
    };

    expect(
      validateDecisionDraft(uniqueSurvivor, {
        request,
        exactInputArtifactIds: [],
      })
    ).toEqual(uniqueSurvivor);
    expect(validateDecision(sealed(uniqueSurvivor))).toMatchObject({
      outcome: "selected",
      recommendation: { kind: "selection", alternative_ids: ["alt_a"] },
      comparison_dimension_ids: [],
      sensitivity: uniqueSurvivor.sensitivity,
    });

    for (const multipleSurvivor of [
      { ...selected, comparison_dimension_ids: [] },
      { ...decisionDraft("ranked"), comparison_dimension_ids: [] },
    ]) {
      expect(() =>
        validateDecisionDraft(multipleSurvivor, {
          request,
          exactInputArtifactIds: [],
        })
      ).toThrow(/multiple feasible alternatives require comparison dimensions/u);
    }
    expect(() =>
      validateDecisionDraft(
        { ...uniqueSurvivor, sensitivity: [] },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/require sensitivity/u);
    expect(() =>
      validateDecisionDraft(
        { ...uniqueSurvivor, comparison_dimension_ids: ["dimension_invented"] },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/comparison_dimension_ids/u);
  });

  it("reports every stacked critical semantic issue in one validation result", () => {
    const invalid: DecisionDraftV2 = {
      ...decisionDraft("selected"),
      feasibility: [
        { alternative_id: "alt_unknown", status: "infeasible" },
        { alternative_id: "alt_b", status: "feasible" },
      ],
      recommendation: { kind: "selection", alternative_ids: ["alt_unknown"] },
      comparison_dimension_ids: ["dimension_invented"],
      basis_ids_used: ["alt_a"],
      sensitivity: [
        {
          basis_ids: ["basis_invented"],
          resulting_decision_change: "Change the decision.",
        },
      ],
      has_blocking_unresolved: true,
      blocking_questions: ["What remains unresolved?"],
    };
    const issues = expectIssues(() =>
      validateDecisionDraft(invalid, {
        request: decisionRequest(),
        exactInputArtifactIds: [],
      })
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/cover every alternative/u),
        expect.stringMatching(/feasibility\[\]\.alternative_id/u),
        expect.stringMatching(/recommendation\.alternative_ids/u),
        expect.stringMatching(/exactly one feasible/u),
        expect.stringMatching(/cannot hide a blocking/u),
        expect.stringMatching(/cannot carry blocking_questions/u),
        expect.stringMatching(/comparison_dimension_ids/u),
        expect.stringMatching(/basis_ids_used/u),
        expect.stringMatching(/sensitivity\[\]\.basis_ids/u),
      ])
    );
  });

  it("allows supplied N/A bases and sensitivity while enforcing every other N/A prohibition", () => {
    const request = decisionRequest();
    const suppliedBasisNa: DecisionDraftV2 = {
      ...decisionDraft("not_applicable"),
      basis_ids_used: ["objective_cost", PRIOR_ID],
      sensitivity: [
        {
          basis_ids: ["uncertainty_quote", PRIOR_ID],
          resulting_decision_change: "If planning becomes applicable, compare the alternatives.",
        },
      ],
    };
    expect(() =>
      validateDecisionDraft(suppliedBasisNa, {
        request,
        exactInputArtifactIds: [PRIOR_ID],
      })
    ).not.toThrow();
    expect(() =>
      validateDecisionDraft(
        {
          ...suppliedBasisNa,
          sensitivity: [
            {
              basis_ids: [FEEDBACK_ID],
              resulting_decision_change: "An unadmitted feedback ID must not become a basis.",
            },
          ],
        },
        { request, exactInputArtifactIds: [PRIOR_ID] }
      )
    ).toThrow(/sensitivity/u);
    for (const mutation of [
      { feasibility: [{ alternative_id: "alt_a", status: "feasible" as const }] },
      { recommendation: { kind: "selection" as const, alternative_ids: ["alt_a"] } },
      { comparison_dimension_ids: ["objective_cost"] },
      { has_blocking_unresolved: true },
      { blocking_questions: ["Should execution start?"] },
    ]) {
      expect(() =>
        validateDecisionDraft(
          { ...decisionDraft("not_applicable"), ...mutation },
          { request, exactInputArtifactIds: [] }
        )
      ).toThrow(/not_applicable|non-selection/u);
    }
    expect(() =>
      validateDecisionDraft(
        { ...decisionDraft("selected"), sensitivity: [], comparison_dimension_ids: [] },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/dimensions.*sensitivity|sensitivity.*dimensions/u);
    expect(() =>
      validateDecisionDraft(
        {
          ...decisionDraft("ranked"),
          recommendation: { kind: "ranking", alternative_ids: ["alt_a"] },
        },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/complete feasible set/u);
    expect(() =>
      validateDecisionDraft(
        {
          ...decisionDraft("no_feasible_option"),
          feasibility: decisionDraft("no_feasible_option").feasibility.map((entry, index) =>
            index === 0 ? { ...entry, status: "feasible" } : entry
          ),
        },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/every alternative infeasible/u);
    expect(() =>
      validateDecisionDraft(
        {
          ...decisionDraft("unresolved"),
          has_blocking_unresolved: false,
          blocking_questions: undefined,
        },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/has_blocking_unresolved.*blocking_questions/u);
  });

  it("uses field-specific supplied ID namespaces and accepts exact input artifacts only as bases", () => {
    const request = decisionRequest();
    const selected = decisionDraft("selected");
    const withPrior: DecisionDraftV2 = {
      ...selected,
      basis_ids_used: [...selected.basis_ids_used, PRIOR_ID],
      sensitivity: selected.sensitivity.map((entry) => ({ ...entry, basis_ids: [PRIOR_ID] })),
    };
    expect(() =>
      validateDecisionDraft(withPrior, { request, exactInputArtifactIds: [PRIOR_ID] })
    ).not.toThrow();
    const withRequestBasis: DecisionDraftV2 = {
      ...selected,
      basis_ids_used: [...selected.basis_ids_used, REQUEST_ID],
      sensitivity: selected.sensitivity.map((entry) => ({ ...entry, basis_ids: [REQUEST_ID] })),
    };
    expect(() =>
      validateDecisionDraft(withRequestBasis, {
        request,
        exactInputArtifactIds: [],
        requestArtifactId: REQUEST_ID,
      })
    ).toThrow(/basis/u);
    expect(() =>
      validateDecisionDraft(withRequestBasis, {
        request,
        exactInputArtifactIds: [],
        requestArtifactId: WRONG_REQUEST_ID,
      })
    ).toThrow(/basis/u);
    expect(() => validateDecisionDraft(withPrior, { request, exactInputArtifactIds: [] })).toThrow(
      /basis/u
    );
    expect(() =>
      validateDecisionDraft(
        { ...selected, comparison_dimension_ids: ["uncertainty_quote"] },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/comparison_dimension_ids/u);
    expect(() =>
      validateDecisionDraft(
        { ...selected, recommendation: { kind: "selection", alternative_ids: ["objective_cost"] } },
        { request, exactInputArtifactIds: [] }
      )
    ).toThrow(/recommendation\.alternative_ids/u);
  });
});

describe("provider-free decision conformance", () => {
  it("rejects a stale draft after a material request mutation and admits the matching draft", () => {
    const originalRequest = decisionRequest();
    const mutatedRequest = validateDecisionRequest({
      ...originalRequest,
      alternatives: [
        ...originalRequest.alternatives,
        {
          alternative_id: "alt_d",
          label: "Option D",
          description: "A newly supplied option that exceeds the hard budget.",
        },
      ],
    });
    const stale = decisionDraft("selected");
    expect(() =>
      validateDecisionDraft(stale, { request: mutatedRequest, exactInputArtifactIds: [] })
    ).toThrow(DecisionDraftValidationError);

    const matching: DecisionDraftV2 = {
      ...stale,
      feasibility: [...stale.feasibility, { alternative_id: "alt_d", status: "infeasible" }],
    };
    expect(
      validateDecisionDraft(matching, { request: mutatedRequest, exactInputArtifactIds: [] })
    ).toEqual(matching);
  });
});

describe("DecisionDraftV2 transport and deterministic DecisionV2 sealing", () => {
  const parseInput = {
    request: decisionRequest(),
    exactInputArtifactIds: [] as string[],
  };
  const parseDraft = (text: string | Uint8Array) =>
    parsePersistedDecisionDraft(
      typeof text === "string" ? Buffer.from(text, "utf8") : text,
      parseInput
    );

  it("exports the minimal core, exact framing, namespace, and outcome contract", () => {
    const parsed: unknown = JSON.parse(decisionDraftPromptContract());
    const contract = unknownRecord(parsed, "Decision draft prompt contract");
    const transport = unknownRecord(contract.transport, "Decision draft transport");
    const rationaleBytes = unknownRecord(
      transport.rationale_report_bytes,
      "Decision rationale byte contract"
    );
    const idNamespaces = unknownRecord(contract.id_namespaces, "Decision ID namespaces");
    const outcomeRules = unknownRecord(contract.outcome_rules, "Decision outcome rules");
    expect(contract.schema).toEqual(DecisionCoreV2Schema);
    expect(transport.maximum_output_bytes).toBe(MAX_PERSISTED_DECISION_DRAFT_BYTES);
    expect(rationaleBytes.maximum).toBe(MAX_DECISION_RATIONALE_REPORT_BYTES);
    expect(transport.forbidden).toEqual(
      expect.arrayContaining([
        "backticks or code fences outside rationale prose",
        "alternate framing",
      ])
    );
    expect(unknownString(transport.accepted_rationale_prose, "accepted rationale prose")).toContain(
      "transport-neutral"
    );
    expect(
      unknownString(idNamespaces["feasibility[].alternative_id"], "alternative namespace")
    ).toContain("alternatives");
    expect(unknownString(idNamespaces.comparison_dimension_ids, "dimension namespace")).toContain(
      "constraint_id"
    );
    expect(unknownString(idNamespaces.basis_ids_used, "basis namespace")).toContain("artifact");
    expect(unknownString(outcomeRules.not_applicable, "not-applicable outcome rule")).toContain(
      "empty"
    );
    expect(unknownString(outcomeRules.ranked, "ranked outcome rule")).toContain(
      "complete feasible set"
    );
    expect(
      unknownString(outcomeRules.selected_or_ranked, "selected/ranked outcome rule")
    ).toContain("feasible survivor set");
    expect(contract.aliases_or_coercions).toBe(false);
    expect(unknownString(contract.execution, "Decision execution rule")).toContain("false");
    expect(contract.host_semantic_validator).toBe("validateDecisionDraft");
  });

  it("accepts only bounded prose plus one core footer and one SUMMARY", () => {
    const draft = decisionDraft("selected");
    expect(parseDraft(persistedDecisionDraft()).draft).toEqual(draft);
    const { rationale_report: rationaleReport, ...core } = draft;
    const reordered = {
      confidence: core.confidence,
      has_blocking_unresolved: core.has_blocking_unresolved,
      sensitivity: core.sensitivity,
      basis_ids_used: core.basis_ids_used,
      comparison_dimension_ids: core.comparison_dimension_ids,
      recommendation: core.recommendation,
      feasibility: core.feasibility,
      applicability_reason: core.applicability_reason,
      outcome: core.outcome,
      schema_version: core.schema_version,
    };
    expect(
      parseDraft(
        `${rationaleReport}\nDECISION_CORE:${JSON.stringify(reordered)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}\n`
      ).draft
    ).toEqual(draft);
    expect(parseDraft(persistedDecisionDraft()).summary).toEqual({
      confidence: "PROBABLE",
      complete: true,
    });
    const canonical = persistedDecisionDraft();
    for (const blankCount of [1, 4]) {
      const separators = "\n".repeat(blankCount + 1);
      const recovered = canonical
        .replace("\nDECISION_CORE:", `${separators}DECISION_CORE:`)
        .replace("\nSUMMARY:", `${separators}SUMMARY:`);
      expect(parseDraft(recovered).draft).toEqual(draft);
      expect(parsePersistedDecisionRoutingSummary(recovered)).toEqual({
        confidence: "PROBABLE",
        complete: true,
      });
    }
  });

  it("treats inline code and closed CommonMark fences as opaque bounded rationale", () => {
    const base = decisionDraft("selected");
    const rationaleReports = [
      [
        "The command `artifact_read` is quoted as rationale, not interpreted.",
        "```bash",
        "printf 'transport prose only' && rm -rf /not-executed",
        "```",
        "The fenced content remains exact decision prose.",
      ].join("\n"),
      [
        "Tilde fences are equally inert rationale.",
        "~~~json",
        '{"not":"a machine footer"}',
        "~~~~   ",
        "The longer closer may have trailing spaces.",
      ].join("\n"),
      [
        "Up to three leading spaces preserve CommonMark fence semantics.",
        "   ````typescript",
        "const inert = `inline code inside a fence`;",
        "  `````",
        "The fence is closed before the machine footer.",
      ].join("\n"),
      [
        "Inline `code` does not open a fence.",
        "    ~~~ four leading spaces make this ordinary rationale prose",
        "A backtick ` remains ordinary inline prose too.",
      ].join("\n"),
    ];
    for (const rationaleReport of rationaleReports) {
      const markdownDraft: DecisionDraftV2 = {
        ...base,
        rationale_report: rationaleReport,
      };
      const parsed = parseDraft(persisted(markdownDraft));
      expect(parsed.draft).toEqual(markdownDraft);
      expect(parsePersistedDecisionRoutingSummary(persisted(markdownDraft))).toEqual({
        confidence: "PROBABLE",
        complete: true,
      });
    }

    const markdownDraft: DecisionDraftV2 = {
      ...base,
      rationale_report: rationaleReports[0] ?? "",
    };
    const decision = sealDecisionDraft({
      request: decisionRequest(),
      draft: markdownDraft,
      requestSha256: decisionRequestSha256(decisionRequest()),
      sourceRequestArtifactId: REQUEST_ID,
      sourceDraftArtifactId: DRAFT_ID,
      exactInputArtifactIds: [],
    });
    expect(decision.execution_started).toBe(false);
    expect(decision.rationale_report).toContain("rm -rf /not-executed");
  });

  it("rejects unclosed, mismatched, short, or malformed CommonMark fence closers", () => {
    const base = decisionDraft("selected");
    const malformedRationales = [
      ["Unclosed backtick fence.", "```json", "payload"],
      ["Unclosed tilde fence.", "~~~json", "payload"],
      ["Short backtick closer.", "````json", "payload", "```"],
      ["Short tilde closer.", "~~~~json", "payload", "~~~"],
      ["Mismatched backtick closer.", "```json", "payload", "~~~"],
      ["Mismatched tilde closer.", "~~~json", "payload", "```"],
      ["Trailing text forbids this closer.", "~~~json", "payload", "~~~ trailing"],
      ["Four-space indentation forbids this closer.", "~~~json", "payload", "    ~~~"],
      ["Only spaces may trail a closer.", "~~~json", "payload", "~~~\t"],
    ];
    for (const lines of malformedRationales) {
      const malformed = persisted({ ...base, rationale_report: lines.join("\n") });
      expect(() => parseDraft(malformed)).toThrow(/FRAMING_INVALID/u);
      expect(parsePersistedDecisionRoutingSummary(malformed)).toBeUndefined();
    }
  });

  it("rejects wrapped, duplicated, or fenced marker-looking lines", () => {
    const valid = persistedDecisionDraft();
    const wrappedCore = valid.replace("\nDECISION_CORE:", "\n`DECISION_CORE:");
    const suffixedCore = valid.replace("\nSUMMARY:", "`\nSUMMARY:");
    const wrappedSummary = valid.replace("\nSUMMARY:", "\n`SUMMARY:").concat("`");
    const duplicateWrappedCore = valid.replace(
      "\nDECISION_CORE:",
      "\n`DECISION_CORE:{}`\nDECISION_CORE:"
    );
    const duplicateFencedSummary = valid.replace(
      "\nDECISION_CORE:",
      '\n```json\nSUMMARY:{"confidence":"PROBABLE","complete":true}\n```\nDECISION_CORE:'
    );
    const duplicateTildeFencedCore = valid.replace(
      "\nDECISION_CORE:",
      "\n~~~json\nDECISION_CORE:{}\n~~~\nDECISION_CORE:"
    );
    const duplicateLiteralCore = valid.replace(
      "\nDECISION_CORE:",
      "\nDECISION_CORE:{}\nDECISION_CORE:"
    );
    const duplicateLiteralSummary = `${valid}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`;
    const fencedCore = valid.replace("\nDECISION_CORE:", "\n```json\nDECISION_CORE:");
    const tildeFencedCore = valid.replace("\nDECISION_CORE:", "\n~~~json\nDECISION_CORE:");
    const tildeWrappedCore = valid.replace(
      /\nDECISION_CORE:(.*)\nSUMMARY:/u,
      "\n~~~DECISION_CORE:$1~~~\nSUMMARY:"
    );
    const tildeWrappedSummary = valid.replace(/\nSUMMARY:(.*)$/u, "\n~~~SUMMARY:$1~~~");
    const tildeSuffixedCore = valid.replace("\nSUMMARY:", "~~~\nSUMMARY:");
    const tildeSuffixedSummary = `${valid}~~~`;
    for (const malformed of [
      wrappedCore,
      suffixedCore,
      wrappedSummary,
      duplicateWrappedCore,
      duplicateFencedSummary,
      duplicateTildeFencedCore,
      duplicateLiteralCore,
      duplicateLiteralSummary,
      fencedCore,
      tildeFencedCore,
      tildeWrappedCore,
      tildeWrappedSummary,
      tildeSuffixedCore,
      tildeSuffixedSummary,
    ]) {
      expect(() => parseDraft(malformed)).toThrow(/FRAMING_INVALID/u);
    }
    expect(parsePersistedDecisionRoutingSummary(duplicateFencedSummary)).toBeUndefined();
    expect(parsePersistedDecisionRoutingSummary(wrappedSummary)).toBeUndefined();
  });

  it("rejects fences around products, alternate framing, duplicate footers, hazards, unknown fields, and confidence drift", () => {
    const draft = decisionDraft("selected");
    const { rationale_report: rationaleReport, ...core } = draft;
    const valid = persistedDecisionDraft();
    expect(() => parseDraft(`\`\`\`text\n${valid}\n\`\`\``)).toThrow(/FRAMING_INVALID/u);
    expect(() =>
      parseDraft(`${canonicalJson(core)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`)
    ).toThrow(/FRAMING_INVALID/u);
    expect(() => parseDraft(`${valid}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`)).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() => parseDraft(new Uint8Array(MAX_PERSISTED_DECISION_DRAFT_BYTES + 1))).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() => parseDraft(new Uint8Array([0xc3, 0x28]))).toThrow(/FRAMING_INVALID/u);
    expect(() =>
      parseDraft(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)]))
    ).toThrow(/FRAMING_INVALID/u);
    expect(() => parseDraft(valid.replace("DECISION_CORE:", "DECISION_CORE:\u0000"))).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() =>
      parseDraft(
        `${rationaleReport}\nDECISION_CORE:${canonicalJson({ ...core, tradeoffs: [] })}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`
      )
    ).toThrow(/SCHEMA_INVALID/u);
    expect(() => parseDraft(persisted(draft, "CERTAIN"))).toThrow(/SEMANTIC_INVALID/u);
    expect(() => parseDraft(valid.replace("\nDECISION_CORE:", "\n \nDECISION_CORE:"))).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() => parseDraft(valid.replace("\nSUMMARY:", "\n\t\nSUMMARY:"))).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() => parseDraft(valid.replace("DECISION_CORE:", "`DECISION_CORE:`"))).toThrow(
      /FRAMING_INVALID/u
    );
    expect(() =>
      parseDraft(valid.replace("\nSUMMARY:", "\ncontent-between-markers\nSUMMARY:"))
    ).toThrow(/FRAMING_INVALID/u);
    expect(() => parseDraft(`${valid}\ntrailing text`)).toThrow(/FRAMING_INVALID/u);
    expect(() =>
      parseDraft(
        valid.replace(
          "\nDECISION_CORE:",
          '\nSUMMARY:{"confidence":"PROBABLE","complete":true}\nDECISION_CORE:'
        )
      )
    ).toThrow(/FRAMING_INVALID/u);
    expect(
      parsePersistedDecisionRoutingSummary(valid.replace("\nSUMMARY:", "\n\nSUMMARY:"))
    ).toEqual({ confidence: "PROBABLE", complete: true });
    expect(parsePersistedDecisionRoutingSummary(`${valid}\n\n`)).toBeUndefined();
  });

  it("returns every stacked semantic issue in the one repair payload", () => {
    const invalid: DecisionDraftV2 = {
      ...decisionDraft("selected"),
      feasibility: decisionDraft("selected").feasibility.slice(0, 2),
      recommendation: { kind: "selection", alternative_ids: ["alt_c"] },
      comparison_dimension_ids: ["invented_dimension"],
      sensitivity: [],
    };
    const issues = expectIssues(() => parseDraft(persisted(invalid)));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/cover every alternative/u),
        expect.stringMatching(/exactly one feasible/u),
        expect.stringMatching(/require sensitivity/u),
        expect.stringMatching(/comparison_dimension_ids/u),
      ])
    );
  });

  it("seals unresolved as a valid terminal DecisionV2 assessment with blocking questions", () => {
    const decision = sealed(decisionDraft("unresolved"));
    expect(validateDecision(decision)).toMatchObject({
      outcome: "unresolved",
      recommendation: { kind: "none", alternative_ids: [] },
      has_blocking_unresolved: true,
      blocking_questions: ["What is Option B's final quote?"],
      execution_started: false,
    });
  });

  it("seals exact rationale, canonical request, source lineage, input IDs, and execution=false", () => {
    const request = decisionRequest();
    const draft = decisionDraft("selected");
    const decision = sealed(draft);
    expect(decision).toMatchObject({
      ...draft,
      request,
      request_sha256: decisionRequestSha256(request),
      source_lineage: {
        request_artifact_id: REQUEST_ID,
        draft_artifact_id: DRAFT_ID,
        draft_sha256: sha256(canonicalJson(draft)),
        input_artifact_ids: [],
      },
      execution_started: false,
    });
    expect(projectDecisionDraft(decision)).toEqual(draft);
    expect(
      assertDecisionLineage({
        decision,
        request,
        requestArtifactId: REQUEST_ID,
        draftArtifactId: DRAFT_ID,
        draft,
        exactInputArtifactIds: [],
      })
    ).toEqual(decision);
    expect(() => validateDecision({ ...decision, rationale_report: "Changed rationale." })).toThrow(
      /source draft lineage/u
    );
    expect(() => validateDecision({ ...decision, request_sha256: "0".repeat(64) })).toThrow(
      /request digest/u
    );
    expect(() =>
      validateDecision({
        ...decision,
        source_lineage: {
          ...decision.source_lineage,
          request_artifact_id: `art_${"d".repeat(64)}`,
        },
      })
    ).toThrow(/source lineage digest/u);
    expect(() => validateDecision({ ...decision, execution_started: true })).toThrow();

    const requestBasisDraft: DecisionDraftV2 = {
      ...draft,
      basis_ids_used: [...draft.basis_ids_used, REQUEST_ID],
      sensitivity: draft.sensitivity.map((entry) => ({ ...entry, basis_ids: [REQUEST_ID] })),
    };
    expect(() => sealed(requestBasisDraft)).toThrow(/basis/u);
    for (const inadmissibleId of [REQUEST_ID, WRONG_REQUEST_ID, DRAFT_ID, FEEDBACK_ID]) {
      const invalidDraft: DecisionDraftV2 = {
        ...draft,
        basis_ids_used: [...draft.basis_ids_used, inadmissibleId],
        sensitivity: draft.sensitivity.map((entry) => ({
          ...entry,
          basis_ids: [inadmissibleId],
        })),
      };
      expect(() => sealed(invalidDraft)).toThrow(/basis/u);
    }
  });

  it("re-reads only canonical DecisionV2 bytes and rejects selected-infeasible products", () => {
    const product = sealed();
    const content = canonicalJson(product);
    expect(
      validateCanonicalDecisionBytes(Buffer.from(content, "utf8"), decisionRef(content))
    ).toEqual(product);
    expect(() =>
      validateCanonicalDecisionBytes(Buffer.from(`${content}\n`, "utf8"), decisionRef(content))
    ).toThrow(/stale/u);

    const invalidDraft: DecisionDraftV2 = {
      ...decisionDraft("selected"),
      feasibility: decisionDraft("selected").feasibility.map((entry) =>
        entry.alternative_id === "alt_a" ? { ...entry, status: "infeasible" } : entry
      ),
    };
    const selectedInfeasibleProduct = {
      ...product,
      ...invalidDraft,
      source_lineage: sourceLineageWithDraftSha(product, sha256(canonicalJson(invalidDraft))),
    };
    const invalidContent = canonicalJson(selectedInfeasibleProduct);
    expect(() =>
      validateCanonicalDecisionBytes(
        Buffer.from(invalidContent, "utf8"),
        decisionRef(invalidContent)
      )
    ).toThrow(/feasible alternative/u);
  });
});
