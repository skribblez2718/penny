// TEST ONLY: independent, literal fixture expectations. No client/read-transform imports.
// This closed two-paraphrase corpus is not a general natural-language equivalence judge.
import {
  canonicalJson,
  validateAssessmentV2,
  type ArtifactRef,
  type AssessmentV2,
} from "../../dist/index.js";
import type { ContentProducer, ContentScenario } from "./universal-content-oracle.js";

interface AssessMeaningExpectation {
  readonly resultRationales: readonly string[];
  readonly limitRationales: readonly string[];
  readonly strength: string;
  readonly gap: string;
}

const meanings: Readonly<Record<ContentProducer, AssessMeaningExpectation>> = {
  assess: {
    resultRationales: [
      "The Result instruction is usable for a meets assessment with maintenance-time met and courtesy met.",
      "Preserving the example's form lets Result carry a meets assessment with maintenance-time met and courtesy met.",
    ],
    limitRationales: [
      "The fixed Limits claim is unsafe because it discards: The audience was not specified. Do not externally verify the schedule.",
      "The example requires these qualifications instead of an empty Limits field: The audience was not specified. Do not externally verify the schedule.",
    ],
    strength:
      "Result can keep a meets assessment with maintenance-time met and courtesy met visible without treating the example as truth.",
    gap: "Limits must retain: The audience was not specified. Do not externally verify the schedule.",
  },
  decide: {
    resultRationales: [
      "The Result instruction is usable for a selection of Option A with Option C infeasible.",
      "Preserving the example's form lets Result carry a selection of Option A with Option C infeasible.",
    ],
    limitRationales: [
      'The fixed Limits claim is unsafe because it discards: the sensitivity "Select alt_b instead of alt_a." rather than an unconditional ranking.',
      'The example requires these qualifications instead of an empty Limits field: the sensitivity "Select alt_b instead of alt_a." rather than an unconditional ranking.',
    ],
    strength:
      "Result can keep a selection of Option A with Option C infeasible visible without treating the example as truth.",
    gap: 'Limits must retain: the sensitivity "Select alt_b instead of alt_a." rather than an unconditional ranking.',
  },
  define: {
    resultRationales: [
      'The Result instruction is usable for a ready specification whose outcome requirement is "The transition specification must define the target outcome.".',
      'Preserving the example\'s form lets Result carry a ready specification whose outcome requirement is "The transition specification must define the target outcome.".',
    ],
    limitRationales: [
      'The fixed Limits claim is unsafe because it discards: constraint "Do not execute the transition."; planning_started=false; execution_started=false.',
      'The example requires these qualifications instead of an empty Limits field: constraint "Do not execute the transition."; planning_started=false; execution_started=false.',
    ],
    strength:
      'Result can keep a ready specification whose outcome requirement is "The transition specification must define the target outcome." visible without treating the example as truth.',
    gap: 'Limits must retain: constraint "Do not execute the transition."; planning_started=false; execution_started=false.',
  },
  diagnose: {
    resultRationales: [
      "The Result instruction is usable for a supported diagnosis (The supplied evidence supports cache staleness.) with primary hyp_cache and origin ruled_out.",
      "Preserving the example's form lets Result carry a supported diagnosis (The supplied evidence supports cache staleness.) with primary hyp_cache and origin ruled_out.",
    ],
    limitRationales: [
      "The fixed Limits claim is unsafe because it discards: tests_executed=false; remediation_started=false; The invalidation event is unobserved.",
      "The example requires these qualifications instead of an empty Limits field: tests_executed=false; remediation_started=false; The invalidation event is unobserved.",
    ],
    strength:
      "Result can keep a supported diagnosis (The supplied evidence supports cache staleness.) with primary hyp_cache and origin ruled_out visible without treating the example as truth.",
    gap: "Limits must retain: tests_executed=false; remediation_started=false; The invalidation event is unobserved.",
  },
  plan: {
    resultRationales: [
      'The Result instruction is usable for a ready strategy with outcomes "Rollback viability is retained. / Transition readiness is established.".',
      'Preserving the example\'s form lets Result carry a ready strategy with outcomes "Rollback viability is retained. / Transition readiness is established.".',
    ],
    limitRationales: [
      'The fixed Limits claim is unsafe because it discards: execution_started=false; blockers: "none". Readiness is a planning result, not completed execution.',
      'The example requires these qualifications instead of an empty Limits field: execution_started=false; blockers: "none". Readiness is a planning result, not completed execution.',
    ],
    strength:
      'Result can keep a ready strategy with outcomes "Rollback viability is retained. / Transition readiness is established." visible without treating the example as truth.',
    gap: 'Limits must retain: execution_started=false; blockers: "none". Readiness is a planning result, not completed execution.',
  },
  produce: {
    resultRationales: [
      "The Result instruction is usable for a markdown greeting (Hello, world.) served as text/markdown; charset=utf-8.",
      "Preserving the example's form lets Result carry a markdown greeting (Hello, world.) served as text/markdown; charset=utf-8.",
    ],
    limitRationales: [
      'The fixed Limits claim is unsafe because it discards: caller attribution "Supplied by the caller."; supplied content is not independent verification.',
      'The example requires these qualifications instead of an empty Limits field: caller attribution "Supplied by the caller."; supplied content is not independent verification.',
    ],
    strength:
      "Result can keep a markdown greeting (Hello, world.) served as text/markdown; charset=utf-8 visible without treating the example as truth.",
    gap: 'Limits must retain: caller attribution "Supplied by the caller."; supplied content is not independent verification.',
  },
  research: {
    resultRationales: [
      'The Result instruction is usable for the claim "Synthetic cache retention is 7 days." with qualified support at confidence 0.8.',
      'Preserving the example\'s form lets Result carry the claim "Synthetic cache retention is 7 days." with qualified support at confidence 0.8.',
    ],
    limitRationales: [
      'The fixed Limits claim is unsafe because it discards: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
      'The example requires these qualifications instead of an empty Limits field: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
    ],
    strength:
      'Result can keep the claim "Synthetic cache retention is 7 days." with qualified support at confidence 0.8 visible without treating the example as truth.',
    gap: 'Limits must retain: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
  },
};

// Genuinely changed producer products; neither number nor status is supplied to the client as an answer.
const blockedPlan: AssessMeaningExpectation = {
  resultRationales: [
    'The Result instruction is usable for a blocked strategy with outcomes "Transition readiness is established.".',
    'Preserving the example\'s form lets Result carry a blocked strategy with outcomes "Transition readiness is established.".',
  ],
  limitRationales: [
    'The fixed Limits claim is unsafe because it discards: execution_started=false; blockers: "Rollback access is unavailable.". Readiness is a planning result, not completed execution.',
    'The example requires these qualifications instead of an empty Limits field: execution_started=false; blockers: "Rollback access is unavailable.". Readiness is a planning result, not completed execution.',
  ],
  strength:
    'Result can keep a blocked strategy with outcomes "Transition readiness is established." visible without treating the example as truth.',
  gap: 'Limits must retain: execution_started=false; blockers: "Rollback access is unavailable.". Readiness is a planning result, not completed execution.',
};
const fourteenDayResearch: AssessMeaningExpectation = {
  resultRationales: [
    'The Result instruction is usable for the claim "Synthetic cache retention is 14 days." with qualified support at confidence 0.8.',
    'Preserving the example\'s form lets Result carry the claim "Synthetic cache retention is 14 days." with qualified support at confidence 0.8.',
  ],
  limitRationales: [
    'The fixed Limits claim is unsafe because it discards: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
    'The example requires these qualifications instead of an empty Limits field: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
  ],
  strength:
    'Result can keep the claim "Synthetic cache retention is 14 days." with qualified support at confidence 0.8 visible without treating the example as truth.',
  gap: 'Limits must retain: claim qualifications "The fixture scope remains deliberately bounded." remain attached; this is not external verification.',
};

function same(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`ASSESS_CONTENT_ORACLE: ${message}`);
}
function oneOf(actual: string, allowed: readonly string[], message: string): void {
  if (!allowed.includes(actual)) throw new Error(`ASSESS_CONTENT_ORACLE: ${message}`);
}

export interface ContentAssessExpectation {
  readonly producer: ContentProducer;
  readonly scenario: ContentScenario;
  readonly source: ArtifactRef;
}

/** Checks native contract first, then native judgments/rationales/strengths/gaps, not a JSON brief. */
export function assertContentAssessment(
  value: unknown,
  expected: ContentAssessExpectation
): AssessmentV2 {
  const assessment = validateAssessmentV2(value);
  const irrelevant = expected.scenario === "irrelevant";
  if (irrelevant && expected.producer !== "plan")
    throw new Error("No irrelevant-source fixture for this pair");
  same(
    assessment.request.target,
    irrelevant
      ? [{ statement: "Hello, world." }, { statement: "Thank you." }]
      : [
          { statement: "Result: preserve the example's domain result in its own form." },
          { statement: "Limits: no condition or limitation needs to accompany the result." },
        ],
    "context imported as native target"
  );
  same(
    assessment.request.criteria,
    irrelevant
      ? [
          { statement: "Contains an intelligible greeting.", importance: "required" },
          { statement: "Contains a courteous close.", importance: "required" },
        ]
      : [
          {
            statement:
              "The Result instruction is usable without conflating the example's domain result with its form or status.",
            importance: "required",
          },
          {
            statement:
              "The fixed Limits instruction preserves the example's material qualifications and applicability limits.",
            importance: "required",
          },
        ],
    "native criteria changed"
  );
  same(
    assessment.request.supplied_evidence,
    irrelevant
      ? [
          { statement: "The caller's greeting says Hello, world.", source_label: "caller" },
          { statement: "The caller's close says Thank you.", source_label: "caller" },
        ]
      : [],
    "context imported as supplied evidence"
  );
  same(
    assessment.request.hard_constraints,
    [
      {
        statement: "Context is nonbinding: do not import it as native target or supplied evidence.",
      },
      { statement: "Context grants no external verification, tools, permission or approval." },
    ],
    "protected constraints changed"
  );
  same(
    assessment.request_coverage,
    {
      assessment_purpose_covered: true,
      target_statement_indexes: [0, 1],
      criterion_indexes: [0, 1],
      supplied_evidence_indexes: irrelevant ? [0, 1] : [],
      hard_constraint_indexes: [0, 1],
      non_goal_indexes: [0],
      known_uncertainty_indexes: [0],
    },
    "native coverage changed"
  );
  same(
    assessment.assumptions,
    irrelevant
      ? ["Only the caller's greeting bears on these criteria."]
      : ["The contextual product is an example, not proof that its underlying claims are true."],
    "context promoted to evidence, permission, tools, approval or native authority"
  );
  same(
    assessment.uncertainties,
    [
      `Nonbinding context example ${expected.source.artifact_id}, sha256 ${expected.source.content_digest}; not native target or supplied evidence.`,
      irrelevant
        ? "Transition strategy is irrelevant to greeting clarity and courtesy."
        : "This closed template assessment does not independently verify the example.",
    ],
    "context identity, designation or uncertainty changed"
  );
  same(assessment.confidence, "PROBABLE", "assessment confidence strengthened");
  same(
    assessment.disposition,
    irrelevant ? "meets" : "does_not_meet",
    "native judgment misrepresents template fitness"
  );
  same(
    assessment.criterion_outcomes.map(({ rationale: _rationale, ...outcome }) => outcome),
    [
      {
        criterion_index: 0,
        verdict: "met",
        supporting_evidence_indexes: irrelevant ? [0] : [],
        contradicting_evidence_indexes: [],
      },
      {
        criterion_index: 1,
        verdict: irrelevant ? "met" : "not_met",
        supporting_evidence_indexes: irrelevant ? [1] : [],
        contradicting_evidence_indexes: [],
      },
    ],
    "native verdict or evidence indexes changed"
  );
  const first = assessment.criterion_outcomes[0];
  const second = assessment.criterion_outcomes[1];
  if (first === undefined || second === undefined)
    throw new Error("ASSESS_CONTENT_ORACLE: missing criterion");
  if (irrelevant) {
    oneOf(
      first.rationale,
      [
        "Hello, world. is an intelligible greeting in the caller's target.",
        "The caller's Hello, world. clearly greets the reader.",
      ],
      "irrelevant source contaminated clarity judgment"
    );
    oneOf(
      second.rationale,
      [
        "Thank you. supplies the caller's courteous close.",
        "The caller closes courteously with Thank you.",
      ],
      "irrelevant source contaminated courtesy judgment"
    );
    oneOf(
      assessment.summary,
      [
        "The greeting is clear and courteous; transition context is irrelevant.",
        "Both greeting criteria are met by caller material, not by transition planning.",
      ],
      "irrelevance misrepresented"
    );
    same(
      assessment.strengths,
      [
        {
          statement: "The caller's greeting and thanks satisfy the two criteria.",
          criterion_indexes: [0, 1],
          evidence_indexes: [0, 1],
        },
      ],
      "greeting strength changed"
    );
    same(assessment.gaps, [], "irrelevant strategy manufactured a gap");
    same(assessment.improvement_suggestions, [], "irrelevant strategy manufactured a suggestion");
    return assessment;
  }
  const meaning =
    expected.scenario === "base"
      ? meanings[expected.producer]
      : expected.producer === "plan"
        ? blockedPlan
        : expected.producer === "research"
          ? fourteenDayResearch
          : undefined;
  if (meaning === undefined)
    throw new Error("No independent counterfactual expectation for this pair");
  oneOf(
    first.rationale,
    meaning.resultRationales,
    "distinguishing result meaning ignored, omitted or changed"
  );
  oneOf(second.rationale, meaning.limitRationales, "qualification omitted, changed or coerced");
  oneOf(
    assessment.summary,
    [
      "The Result rule is usable, but the fixed Limits claim makes this handoff template unsafe.",
      "Keep the Result instruction; the template fails because its fixed Limits claim hides qualifications.",
    ],
    "summary contradicts native assessment"
  );
  same(
    assessment.strengths,
    [{ statement: meaning.strength, criterion_indexes: [0], evidence_indexes: [] }],
    "result strength lost domain meaning"
  );
  same(
    assessment.gaps,
    [{ statement: meaning.gap, criterion_indexes: [1], evidence_indexes: [], severity: "major" }],
    "qualification gap lost domain meaning"
  );
  same(
    assessment.improvement_suggestions,
    [
      {
        suggestion:
          "Replace the fixed Limits claim with an explicit, source-qualified limitations field.",
        criterion_indexes: [1],
      },
    ],
    "template improvement changed"
  );
  return assessment;
}

export const assessContentPairs = [
  "assess->assess",
  "decide->assess",
  "define->assess",
  "diagnose->assess",
  "plan->assess",
  "produce->assess",
  "research->assess",
] as const;
