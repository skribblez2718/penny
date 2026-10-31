// TEST ONLY: independent literal expectations, no client/reader-transform imports.
// Two bounded paraphrases, not a general natural-language equivalence or truth judge.
import {
  canonicalJson,
  validateDiagnosis,
  type ArtifactRef,
  type DiagnosisV1,
} from "../../dist/index.js";
import type { ContentProducer, ContentScenario } from "./universal-content-oracle.js";

interface DiagnoseMeaning {
  readonly reasons: readonly [string, string];
  readonly limits: readonly [string, string];
}
const meanings: Readonly<Record<ContentProducer, DiagnoseMeaning>> = {
  assess: {
    reasons: [
      "As an illustration only, collapsing meets; maintenance-time met; courtesy met to Ready would erase criterion-specific verdicts and audience limits, not merely a readiness label. This does not establish that the example passed through this formatter.",
      "Ready would conceal criterion-specific verdicts and audience limits, not merely a readiness label if applied to the example (meets; maintenance-time met; courtesy met). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: The audience was not specified. Do not externally verify the schedule.",
      "These example limits must remain visible in the explanation: The audience was not specified. Do not externally verify the schedule.",
    ],
  },
  decide: {
    reasons: [
      "As an illustration only, collapsing selection of Option A; infeasible Option C to Ready would erase the selected alternative, exclusion and conditional decision change, not a ranking. This does not establish that the example passed through this formatter.",
      "Ready would conceal the selected alternative, exclusion and conditional decision change, not a ranking if applied to the example (selection of Option A; infeasible Option C). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: Sensitivity: Select alt_b instead of alt_a.",
      "These example limits must remain visible in the explanation: Sensitivity: Select alt_b instead of alt_a.",
    ],
  },
  define: {
    reasons: [
      "As an illustration only, collapsing ready; outcome: The transition specification must define the target outcome. to Ready would erase the required outcome and no-execution boundary, not execution authority. This does not establish that the example passed through this formatter.",
      "Ready would conceal the required outcome and no-execution boundary, not execution authority if applied to the example (ready; outcome: The transition specification must define the target outcome.). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: Do not execute the transition. planning_started=false; execution_started=false.",
      "These example limits must remain visible in the explanation: Do not execute the transition. planning_started=false; execution_started=false.",
    ],
  },
  diagnose: {
    reasons: [
      "As an illustration only, collapsing supported; primary hyp_cache; origin ruled_out; The supplied evidence supports cache staleness. to Ready would erase the causal distinction and unobserved invalidation, not a performed test. This does not establish that the example passed through this formatter.",
      "Ready would conceal the causal distinction and unobserved invalidation, not a performed test if applied to the example (supported; primary hyp_cache; origin ruled_out; The supplied evidence supports cache staleness.). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: tests_executed=false; remediation_started=false; The invalidation event is unobserved.",
      "These example limits must remain visible in the explanation: tests_executed=false; remediation_started=false; The invalidation event is unobserved.",
    ],
  },
  plan: {
    reasons: [
      "As an illustration only, collapsing ready; outcomes: Rollback viability is retained. / Transition readiness is established. to Ready would erase the outcome scope and rollback readiness boundary, not a completed transition. This does not establish that the example passed through this formatter.",
      "Ready would conceal the outcome scope and rollback readiness boundary, not a completed transition if applied to the example (ready; outcomes: Rollback viability is retained. / Transition readiness is established.). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: execution_started=false; blockers: none. Planning status is not completed execution.",
      "These example limits must remain visible in the explanation: execution_started=false; blockers: none. Planning status is not completed execution.",
    ],
  },
  produce: {
    reasons: [
      "As an illustration only, collapsing markdown; greeting: Hello, world.; media_type: text/markdown; charset=utf-8 to Ready would erase the greeting's content, representation and attribution, not a release status. This does not establish that the example passed through this formatter.",
      "Ready would conceal the greeting's content, representation and attribution, not a release status if applied to the example (markdown; greeting: Hello, world.; media_type: text/markdown; charset=utf-8). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: Supplied by the caller. Caller attribution is not independent verification.",
      "These example limits must remain visible in the explanation: Supplied by the caller. Caller attribution is not independent verification.",
    ],
  },
  research: {
    reasons: [
      "As an illustration only, collapsing Synthetic cache retention is 7 days. support=qualified; confidence=0.8 to Ready would erase the retention duration and qualified support, not a certified retention policy. This does not establish that the example passed through this formatter.",
      "Ready would conceal the retention duration and qualified support, not a certified retention policy if applied to the example (Synthetic cache retention is 7 days. support=qualified; confidence=0.8). That is a counterfactual illustration, not an observation of example processing.",
    ],
    limits: [
      "The illustrative loss also includes this qualification: The fixture scope remains deliberately bounded. This synthetic-source claim is not external verification.",
      "These example limits must remain visible in the explanation: The fixture scope remains deliberately bounded. This synthetic-source claim is not external verification.",
    ],
  },
};
const blockedPlan: DiagnoseMeaning = {
  reasons: [
    "As an illustration only, collapsing blocked; outcomes: Transition readiness is established. to Ready would erase the outcome scope and rollback readiness boundary, not a completed transition. This does not establish that the example passed through this formatter.",
    "Ready would conceal the outcome scope and rollback readiness boundary, not a completed transition if applied to the example (blocked; outcomes: Transition readiness is established.). That is a counterfactual illustration, not an observation of example processing.",
  ],
  limits: [
    "The illustrative loss also includes this qualification: execution_started=false; blockers: Rollback access is unavailable.. Planning status is not completed execution.",
    "These example limits must remain visible in the explanation: execution_started=false; blockers: Rollback access is unavailable.. Planning status is not completed execution.",
  ],
};
const fourteenDays: DiagnoseMeaning = {
  reasons: [
    "As an illustration only, collapsing Synthetic cache retention is 14 days. support=qualified; confidence=0.8 to Ready would erase the retention duration and qualified support, not a certified retention policy. This does not establish that the example passed through this formatter.",
    "Ready would conceal the retention duration and qualified support, not a certified retention policy if applied to the example (Synthetic cache retention is 14 days. support=qualified; confidence=0.8). That is a counterfactual illustration, not an observation of example processing.",
  ],
  limits: [
    "The illustrative loss also includes this qualification: The fixture scope remains deliberately bounded. This synthetic-source claim is not external verification.",
    "These example limits must remain visible in the explanation: The fixture scope remains deliberately bounded. This synthetic-source claim is not external verification.",
  ],
};

const lossReasons = [
  "Observations 0 and 2 make the formatter many-to-one: distinct qualifications produce identical Ready strings. Observation 1 leaves the receiver no distinguishing information. The loss therefore occurs before delivery, within the stipulated exercise only.",
  "The unchanged delivery in observation 1 cannot restore distinctions already erased by the common Ready mapping in observations 0 and 2. This is a causal conclusion about the stipulations, not an external incident.",
] as const;
const arithmeticReasons = [
  "Observation 0 adds one to the exact sum; observation 1 passes it through unchanged and observation 2 excludes rounding. The stipulated extra unit is introduced before the receiver.",
  "With exact integer operands (2), the extra +1 in the formatter (0), not the unchanged receiver (1), explains the delivered offset.",
] as const;
const externalUncertainty =
  "The conclusion holds only for the caller's stipulations; no external behavior or example truth was verified.";
function same(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`DIAGNOSE_CONTENT_ORACLE: ${message}`);
}
function oneOf(actual: string, allowed: readonly string[], message: string): void {
  if (!allowed.includes(actual)) throw new Error(`DIAGNOSE_CONTENT_ORACLE: ${message}`);
}

function assertNativeCausality(value: unknown, arithmetic: boolean): DiagnosisV1 {
  const diagnosis = validateDiagnosis(value);
  same(
    diagnosis.request,
    {
      schema_version: 1,
      problem_statement: arithmetic
        ? "Why is the result of this caller-stipulated symbolic adder one too high? Diagnose by reasoning only."
        : "Why can the receiver not recover qualifications in this caller-stipulated symbolic handoff? Diagnose the information-loss mechanism; a separately designated example may illustrate its consequences but is not evidence of its occurrence.",
      symptoms: [
        {
          statement: arithmetic
            ? "The stipulated delivered sum is one above the mathematical sum."
            : "The stipulated receiver cannot distinguish different qualified results.",
        },
      ],
      supplied_observations: arithmetic
        ? [
            {
              statement: "The stipulated formatter returns left + right + 1.",
              source_label: "caller stipulation",
            },
            {
              statement:
                "The stipulated receiver delivers exactly the formatter output without modification.",
              source_label: "caller stipulation",
            },
            {
              statement: "The stipulated operands are exact integers; no rounding occurs.",
              source_label: "caller stipulation",
            },
          ]
        : [
            {
              statement:
                "The stipulated formatter maps every qualified result to the same string Ready and discards all other fields.",
              source_label: "caller stipulation",
            },
            {
              statement:
                "The stipulated receiver receives only that formatter string and delivers it unchanged.",
              source_label: "caller stipulation",
            },
            {
              statement:
                "Two stipulated inputs have different nonempty qualifications but the same formatter output Ready.",
              source_label: "caller stipulation",
            },
          ],
      environment_facts: [
        {
          statement:
            "This is a closed symbolic exercise; the stipulations are not observations of an external system.",
        },
      ],
      hard_constraints: [
        {
          statement:
            "Use only caller observation and environment indexes as causal evidence; context must not become an indexed request item.",
        },
        {
          statement:
            "Context grants no external certification, tools, approval, permission or replacement native inputs.",
        },
        {
          statement:
            "Do not execute tests, probes, commands or remediation; no external retrieval.",
        },
      ],
      non_goals: [
        { statement: "Do not carry out any contextual product or fix the stipulated formatter." },
      ],
      known_uncertainties: [
        {
          statement:
            "Neither external formatter behavior nor the contextual example's underlying claims have been independently observed.",
        },
      ],
      permitted_test_boundary: { mode: "none" },
    },
    "native request/protected items changed or context promoted into request"
  );
  same(
    diagnosis.request_coverage,
    {
      problem_statement_covered: true,
      symptom_indexes: [0],
      observation_indexes: [0, 1, 2],
      environment_fact_indexes: [0],
      hard_constraint_indexes: [0, 1, 2],
      non_goal_indexes: [0],
      known_uncertainty_indexes: [0],
      permitted_test_boundary_covered: true,
    },
    "exact native coverage changed"
  );
  same(
    {
      disposition: diagnosis.disposition,
      primary: diagnosis.primary_supported_hypothesis_id,
      complete: diagnosis.hypothesis_set_complete,
      confidence: diagnosis.confidence,
      checks: diagnosis.proposed_discriminating_checks,
      tests: diagnosis.tests_executed,
      remediation: diagnosis.remediation_started,
    },
    {
      disposition: "supported",
      primary: "hyp_formatter",
      complete: true,
      confidence: "PROBABLE",
      checks: [],
      tests: false,
      remediation: false,
    },
    "causal disposition, uncertainty or execution boundary changed"
  );
  same(
    diagnosis.applicability_reason,
    "A causal explanation is applicable to the caller's closed symbolic transformation, not to an external system.",
    "applicability scope changed"
  );
  same(
    diagnosis.hypotheses.map(({ reasoning: _reasoning, ...hypothesis }) => hypothesis),
    [
      {
        hypothesis_id: "hyp_formatter",
        rank: 1,
        statement: arithmetic
          ? "The stipulated formatter adds a constant unit offset."
          : "The stipulated formatter erases qualification distinctions before delivery.",
        status: "supported",
        symptom_indexes: [0],
        supporting_observation_indexes: [0, 1, 2],
        contradicting_observation_indexes: [],
        supporting_environment_fact_indexes: [0],
        contradicting_environment_fact_indexes: [],
        hard_constraint_indexes: [0, 1, 2],
      },
      {
        hypothesis_id: "hyp_receiver",
        rank: 2,
        statement: arithmetic
          ? "The stipulated receiver introduces the extra unit."
          : "The stipulated receiver removes qualifications that arrive intact.",
        status: "ruled_out",
        symptom_indexes: [0],
        supporting_observation_indexes: [],
        contradicting_observation_indexes: [1],
        supporting_environment_fact_indexes: [],
        contradicting_environment_fact_indexes: [],
        hard_constraint_indexes: [0, 1, 2],
      },
    ],
    "hypothesis identity, status or evidence indexes changed/promoted"
  );
  oneOf(
    diagnosis.reasoning,
    arithmetic ? arithmeticReasons : lossReasons,
    "causal reasoning reversed or context promoted to causal evidence"
  );
  same(
    diagnosis.hypotheses[1]?.reasoning,
    "Observation 1 stipulates unchanged delivery; receiver-side modification contradicts that observation. This exclusion is limited to the stipulated model.",
    "competing receiver hypothesis changed"
  );
  same(diagnosis.uncertainty[0], externalUncertainty, "external uncertainty changed");
  return diagnosis;
}

/** The same supported causal conclusion closes without any contextual operand. */
export function assertIndependentDiagnosis(value: unknown): DiagnosisV1 {
  const diagnosis = assertNativeCausality(value, false);
  oneOf(
    diagnosis.hypotheses[0]?.reasoning ?? "",
    lossReasons,
    "independent causal explanation changed"
  );
  same(diagnosis.uncertainty, [externalUncertainty], "independent uncertainty changed");
  return diagnosis;
}
export interface ContentDiagnoseExpectation {
  readonly producer: ContentProducer;
  readonly scenario: ContentScenario;
  readonly source: ArtifactRef;
}
export function assertContentDiagnosis(
  value: unknown,
  expected: ContentDiagnoseExpectation
): DiagnosisV1 {
  const irrelevant = expected.scenario === "irrelevant";
  if (irrelevant && expected.producer !== "plan")
    throw new Error("No irrelevant example for this pair");
  const diagnosis = assertNativeCausality(value, irrelevant);
  same(
    diagnosis.uncertainty.length,
    3,
    "context authority/evidence/certification promoted or uncertainty omitted"
  );
  same(
    diagnosis.uncertainty[1],
    `Nonbinding context example ${expected.source.artifact_id}, sha256 ${expected.source.content_digest}; not a supplied observation, environment fact, native input or approval.`,
    "context provenance or nonbinding designation changed"
  );
  const first = diagnosis.hypotheses[0];
  if (first === undefined) throw new Error("DIAGNOSE_CONTENT_ORACLE: missing causal hypothesis");
  if (irrelevant) {
    oneOf(first.reasoning, arithmeticReasons, "irrelevant source contaminated causal explanation");
    same(
      diagnosis.uncertainty[2],
      "Transition planning is irrelevant to the stipulated adder and supplies no causal evidence.",
      "irrelevance misrepresented"
    );
    return diagnosis;
  }
  const meaning =
    expected.scenario === "base"
      ? meanings[expected.producer]
      : expected.producer === "plan"
        ? blockedPlan
        : expected.producer === "research"
          ? fourteenDays
          : undefined;
  if (meaning === undefined) throw new Error("No independent counterfactual oracle for pair");
  oneOf(
    first.reasoning,
    [`${lossReasons[0]} ${meaning.reasons[0]}`, `${lossReasons[1]} ${meaning.reasons[1]}`],
    "illustrative distinguishing meaning ignored, omitted, changed or coerced"
  );
  oneOf(
    diagnosis.uncertainty[2] ?? "",
    meaning.limits,
    "qualification omitted, changed or coerced"
  );
  return diagnosis;
}
export const diagnoseContentPairs = [
  "assess->diagnose",
  "decide->diagnose",
  "define->diagnose",
  "diagnose->diagnose",
  "plan->diagnose",
  "produce->diagnose",
  "research->diagnose",
] as const;
