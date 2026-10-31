import { describe, expect, it } from "vitest";

import { canonicalJson } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import { validateSourceRoutingSummary } from "../dist/source-routing-summary.js";
import { ASSESS_PLAYBOOK_REGISTRATION } from "../dist/playbooks/assess.js";
import { DIAGNOSE_PLAYBOOK_REGISTRATION } from "../dist/playbooks/diagnose.js";
import {
  MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES,
  parsePersistedAssessmentDraftV2,
  validateAssessmentDraftV2,
  type AssessmentDraftV2,
  type AssessmentRequestV1,
} from "../dist/skill-contracts/assess.js";
import {
  MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES,
  parsePersistedDiagnosisDraft,
  validateDiagnosisDraft,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
} from "../dist/skill-contracts/diagnose.js";

describe.each([
  { registration: ASSESS_PLAYBOOK_REGISTRATION, state: "verifying_assessment" },
  { registration: DIAGNOSE_PLAYBOOK_REGISTRATION, state: "verifying_diagnosis" },
])("$state closed review judgment", ({ registration, state }) => {
  function phase() {
    if (registration.worker.kind !== "catalog-agent")
      throw new Error("catalog registration absent");
    const value = registration.worker.phases.get(state);
    if (value === undefined) throw new Error("review schema absent");
    return value;
  }
  const details = {
    verdict: "UNVERIFIABLE",
    gap_kind: "verification_incomplete",
    repair_owner: "none",
    findings: ["A required validity claim lacks verification support."],
    evidence: ["Required support is absent from the supplied basis."],
    strategy_delta: "Stop incomplete, not an author repair.",
  };

  it("opts into both shared policies and admits only the closed UNVERIFIABLE branch", () => {
    expect(registration.repair_progress_policy).toBe("exact_fingerprint_v1");
    expect(phase().routing_repair_policy).toBe("preserve_source_summary_v1");
    expect(validateContract(phase().schema, details, "review")).toEqual(details);
    for (const invalid of [
      { ...details, repair_owner: "annie" },
      { ...details, gap_kind: "evidence_gap" },
      { ...details, verdict: "PASS" },
      { ...details, findings: [] },
      { ...details, evidence: [] },
      { ...details, new_review_core: {} },
    ])
      expect(() => validateContract(phase().schema, invalid, "review")).toThrow();
  });

  it("preserves all source judgment fields and confidence, refusing strengthening or omission", () => {
    const source = Buffer.from(
      `Review limitations.\nSUMMARY:${JSON.stringify({ confidence: "UNCERTAIN", ...details })}`
    );
    expect(validateSourceRoutingSummary(source, phase().schema)).toEqual({
      confidence: "UNCERTAIN",
      details,
    });
    expect(
      validateSourceRoutingSummary(source, phase().schema, { confidence: "UNCERTAIN", details })
    ).toBeDefined();
    for (const proposal of [
      { confidence: "CERTAIN" as const, details },
      {
        confidence: "UNCERTAIN" as const,
        details: { ...details, verdict: "PASS", gap_kind: "none" },
      },
      {
        confidence: "UNCERTAIN" as const,
        details: { ...details, evidence: ["Fabricated support."] },
      },
      { confidence: "UNCERTAIN" as const, details: { ...details, findings: [] } },
      {
        confidence: "UNCERTAIN" as const,
        details: { ...details, strategy_delta: "Invent author repair." },
      },
    ])
      expect(validateSourceRoutingSummary(source, phase().schema, proposal)).toBeUndefined();
    expect(
      validateSourceRoutingSummary(
        Buffer.from('Report.\nSUMMARY:{"confidence":"PROBABLE"}'),
        phase().schema
      )
    ).toBeUndefined();
  });
});

const ASSESS_REQUEST: AssessmentRequestV1 = {
  schema_version: 1,
  assessment_purpose: "Assess a supplied greeting.",
  target: "Hello.",
  criteria: [{ statement: "The target is a greeting.", importance: "required" }],
  supplied_evidence: [{ statement: "The text says Hello." }],
  hard_constraints: [],
  non_goals: [],
  known_uncertainties: [],
};

function assessment(text: string): AssessmentDraftV2 {
  return {
    schema_version: 2,
    disposition: "meets",
    criterion_outcomes: [
      {
        criterion_index: 0,
        verdict: "met",
        supporting_evidence_indexes: [0],
        contradicting_evidence_indexes: [],
        rationale: text,
      },
    ],
    summary: text,
    strengths: [],
    gaps: [],
    improvement_suggestions: [],
    assumptions: [],
    uncertainties: [],
    request_coverage: {
      assessment_purpose_covered: true,
      target_statement_indexes: [0],
      criterion_indexes: [0],
      supplied_evidence_indexes: [0],
      hard_constraint_indexes: [],
      non_goal_indexes: [],
      known_uncertainty_indexes: [],
    },
    confidence: "PROBABLE",
  };
}

const DIAGNOSE_REQUEST: DiagnosisRequestV1 = {
  schema_version: 1,
  problem_statement: "Explain the supplied stale-read observation.",
  symptoms: [{ statement: "Cached reads return the old value." }],
  supplied_observations: [{ statement: "Origin reads return the new value." }],
  environment_facts: [{ statement: "The read path includes a cache." }],
  hard_constraints: [],
  non_goals: [],
  known_uncertainties: [],
  permitted_test_boundary: { mode: "none" },
};

function diagnosis(text: string): DiagnosisDraftV1 {
  return {
    schema_version: 1,
    disposition: "supported",
    applicability_reason: "The supplied observation calls for a causal explanation.",
    hypothesis_set_complete: true,
    hypotheses: [
      {
        hypothesis_id: "hyp_cache",
        rank: 1,
        statement: "Cache staleness explains the old value.",
        status: "supported",
        symptom_indexes: [0],
        supporting_observation_indexes: [0],
        contradicting_observation_indexes: [],
        supporting_environment_fact_indexes: [0],
        contradicting_environment_fact_indexes: [],
        hard_constraint_indexes: [],
        reasoning: text,
      },
    ],
    primary_supported_hypothesis_id: "hyp_cache",
    reasoning: text,
    uncertainty: [],
    proposed_discriminating_checks: [],
    request_coverage: {
      problem_statement_covered: true,
      symptom_indexes: [0],
      observation_indexes: [0],
      environment_fact_indexes: [0],
      hard_constraint_indexes: [],
      non_goal_indexes: [],
      known_uncertainty_indexes: [],
      permitted_test_boundary_covered: true,
    },
    confidence: "PROBABLE",
    remediation_started: false,
    tests_executed: false,
  };
}

const SUMMARY = 'SUMMARY:{"confidence":"PROBABLE","complete":true}';
const CASES = [
  {
    name: "active Assess V2",
    prefix: "ASSESSMENT_DRAFT:",
    draft: assessment,
    maximumBytes: MAX_PERSISTED_ASSESSMENT_DRAFT_BYTES,
    validate: (value: unknown) => validateAssessmentDraftV2(value, { request: ASSESS_REQUEST }),
    parse: (bytes: Uint8Array) =>
      parsePersistedAssessmentDraftV2(bytes, { request: ASSESS_REQUEST }),
    invalidCoverage: {
      ...assessment("The supplied evidence supports the greeting criterion."),
      request_coverage: {
        ...assessment("Coverage fixture.").request_coverage,
        supplied_evidence_indexes: [],
      },
    },
    invalidDisposition: {
      ...assessment("The supplied evidence supports the greeting criterion."),
      disposition: "does_not_meet",
    },
  },
  {
    name: "Diagnose V1",
    prefix: "DIAGNOSIS_CORE:",
    draft: diagnosis,
    maximumBytes: MAX_PERSISTED_DIAGNOSIS_DRAFT_BYTES,
    validate: (value: unknown) => validateDiagnosisDraft(value, { request: DIAGNOSE_REQUEST }),
    parse: (bytes: Uint8Array) =>
      parsePersistedDiagnosisDraft(bytes, { request: DIAGNOSE_REQUEST }),
    invalidCoverage: {
      ...diagnosis("Origin and cached reads differ, supporting cache staleness."),
      request_coverage: {
        ...diagnosis("Coverage fixture.").request_coverage,
        observation_indexes: [],
      },
    },
    invalidDisposition: {
      ...diagnosis("Origin and cached reads differ, supporting cache staleness."),
      primary_supported_hypothesis_id: "unknown_hypothesis",
    },
  },
];

describe.each(CASES)("$name framing versus JSON content", (contract) => {
  function wire(value: unknown): string {
    return `${contract.prefix}${canonicalJson(value)}\n${SUMMARY}`;
  }

  it.each([
    "Ordinary supplied-evidence reasoning.",
    "Use `value` as inline code.",
    "Literal `` and ``` and ```` runs are content.",
    'Quotes " and backslashes \\ with `code` remain JSON string content.',
    '```json\n{"value":"`literal`"}\n```\nSUMMARY: is content here.',
  ])("preserves schema-valid text exactly: %s", (text) => {
    const draft = contract.draft(text);
    // This independent schema/semantic check passes even before the framing fix.
    expect(contract.validate(draft)).toEqual(draft);
    const output = wire(draft);
    expect(output.split("\n")).toHaveLength(2);
    expect(contract.parse(Buffer.from(output))).toEqual({
      draft,
      summary: { confidence: "PROBABLE", complete: true },
    });
    expect(contract.parse(Buffer.from(`${output}\n`)).draft).toEqual(draft);
  });

  it("still rejects outer fences, physical multiline output, extra prose and duplicate prefixes", () => {
    const value = contract.draft("Valid reasoning.");
    const core = `${contract.prefix}${canonicalJson(value)}`;
    const output = wire(value);
    for (const invalid of [
      `\`\`\`json\n${output}\n\`\`\``,
      `${contract.prefix}\`\`\`json ${canonicalJson(value)}\`\`\`\n${SUMMARY}`,
      `\`${core}\`\n${SUMMARY}`,
      `${core}\n\`${SUMMARY}\``,
      `${contract.prefix}${JSON.stringify(value, null, 2)}\n${SUMMARY}`,
      `Prose\n${output}`,
      `${output}\nProse`,
      `${core}\n\n${SUMMARY}`,
      `${output}\n\n`,
      ` ${output}`,
      `${core} \n${SUMMARY}`,
      `${output} `,
      `${contract.prefix}${output}`,
      `${core}\nSUMMARY:${SUMMARY}`,
      `${core}\n${core}\n${SUMMARY}`,
      `${output}\n${SUMMARY}`,
      `${core}${SUMMARY}\n${SUMMARY}`,
      `${core}\n${SUMMARY}${SUMMARY}`,
      `${SUMMARY}\n${core}`,
    ]) {
      expect(() => contract.parse(Buffer.from(invalid)), invalid).toThrow();
    }
  });

  it("still rejects invalid JSON and malformed, duplicate, open or conflicting SUMMARY", () => {
    const value = contract.draft("Valid reasoning.");
    const core = `${contract.prefix}${canonicalJson(value)}`;
    for (const payload of ["", "not-json", "`{}`", "{} trailing", "{", '{"summary":`code`}']) {
      expect(() =>
        contract.parse(Buffer.from(`${contract.prefix}${payload}\n${SUMMARY}`))
      ).toThrow();
    }
    for (const summary of [
      "SUMMARY:not-json",
      'SUMMARY:{"confidence":"PROBABLE","complete":true',
      'SUMMARY:{"confidence":"PROBABLE","complete":true} trailing',
      'SUMMARY:{"confidence":"PROBABLE","complete":true,"report":"`code`"}',
      'SUMMARY:{"confidence":"PROBABLE","complete":false,"complete":true}',
      'SUMMARY:{"confidence":"CERTAIN","confidence":"PROBABLE","complete":true}',
      'SUMMARY:{"confidence":"PROBABLE"}',
      'SUMMARY:{"confidence":"probable","complete":true}',
      'SUMMARY:{"confidence":"PROBABLE","complete":"true"}',
      'SUMMARY:{"confidence":"PROBABLE","complete":false}',
      'SUMMARY:{"confidence":"CERTAIN","complete":true}',
    ]) {
      expect(() => contract.parse(Buffer.from(`${core}\n${summary}`)), summary).toThrow();
    }
  });

  it("still enforces strict encoding and the existing output-byte bound", () => {
    const output = wire(contract.draft("Valid reasoning."));
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.alloc(contract.maximumBytes + 1, 0x61),
      Buffer.from(`\ufeff${output}`),
      Buffer.from(output.replace("\n", "\r\n")),
      Buffer.concat([Buffer.from([0xff]), Buffer.from(output)]),
      Buffer.concat([Buffer.from(output), Buffer.from([0])]),
    ]) {
      expect(() => contract.parse(bytes)).toThrow(/FRAMING_INVALID/u);
    }
  });

  it("still enforces closed schemas, text rules, coverage and disposition semantics", () => {
    for (const value of [
      { ...contract.draft("Valid reasoning."), tests_executed: true },
      { ...contract.draft("Valid reasoning."), score: 100 },
      contract.draft("A control character: \u0000"),
      contract.draft("A decomposed accent: e\u0301"),
      contract.invalidCoverage,
      contract.invalidDisposition,
    ]) {
      expect(() => contract.parse(Buffer.from(wire(value)))).toThrow(
        /SCHEMA_INVALID|SEMANTIC_INVALID/u
      );
    }
  });
});

it("keeps the active Assess V2 canonical-core and version contract", () => {
  const draft = assessment("The supplied evidence supports the greeting criterion.");
  const output = `ASSESSMENT_DRAFT:${canonicalJson(draft)}\n${SUMMARY}`;
  for (const invalid of [
    output.replace('"schema_version":2', '"schema_version":2,"schema_version":2'),
    output.replace('"schema_version":2', '"schema_version": 2'),
    output.replace('"schema_version":2', '"schema_version":1'),
    `ASSESSMENT_DRAFT:${canonicalJson({ ...draft, external_actions_performed: false })}\n${SUMMARY}`,
  ]) {
    expect(() =>
      parsePersistedAssessmentDraftV2(Buffer.from(invalid), { request: ASSESS_REQUEST })
    ).toThrow();
  }
});
