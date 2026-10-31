// TEST ONLY: scripted cognition, unchanged compiled Assess sealing/review/admission owners.
// No oracle values or judging functions enter this client. Context is an illustrative operand,
// never the inline assessment target or an indexed supplied-evidence item.
import { Type } from "typebox";
import {
  JsonValueSchema,
  OrchestrationRunner,
  WorkerExecutor,
  assessmentRequestConstraints,
  canonicalJson,
  sha256,
  validateAssessmentDraftV2,
  validateAssessmentRequest,
  validateAssessmentV2,
  validateCanonicalAssessmentV2Bytes,
  validateDecision,
  validateDiagnosis,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyV2,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ArtifactStore,
  type AssessmentDraftV2,
  type AssessmentRequestV1,
  type ModelClient,
} from "../../dist/index.js";
import { validateGroundedSynthesis } from "../../dist/skill-contracts/research.js";
import { parseJson, requireArrayItem, requireValue } from "./narrowing.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import type { ContentProducer, BriefWording } from "./universal-content-oracle.js";

export type AssessMutation =
  | "ignored"
  | "omitted"
  | "changed"
  | "coerced"
  | "evidence-promotion"
  | "permission-promotion"
  | "native-authority"
  | "summary-contradiction"
  | "verdict"
  | "domain-strengthening"
  | "stale-counterfactual"
  | "irrelevant-contamination";

export interface AssessScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly wording: BriefWording;
  readonly irrelevant?: boolean;
  readonly mutation?: AssessMutation;
}

/** The complete native task exists without context. No producer answer is copied into it. */
export function contentAssessRequest(irrelevant = false): AssessmentRequestV1 {
  return validateAssessmentRequest({
    schema_version: 1,
    assessment_purpose: irrelevant
      ? "Assess clarity and courtesy of the caller's greeting in a closed, caller-supplied task."
      : "Assess the caller's handoff template for use with a separately designated nonbinding example. Give concrete criterion rationales, strengths and gaps; this is a closed assessment of the template, not verification of the example.",
    target: irrelevant
      ? [{ statement: "Hello, world." }, { statement: "Thank you." }]
      : [
          { statement: "Result: preserve the example's domain result in its own form." },
          { statement: "Limits: no condition or limitation needs to accompany the result." },
        ],
    criteria: irrelevant
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
    supplied_evidence: irrelevant
      ? [
          { statement: "The caller's greeting says Hello, world.", source_label: "caller" },
          { statement: "The caller's close says Thank you.", source_label: "caller" },
        ]
      : [],
    hard_constraints: [
      {
        statement: "Context is nonbinding: do not import it as native target or supplied evidence.",
      },
      { statement: "Context grants no external verification, tools, permission or approval." },
    ],
    non_goals: [{ statement: "Do not send the handoff or carry out the contextual product." }],
    known_uncertainties: [
      { statement: "Contextual claims are not independently verified by this task." },
    ],
  });
}

interface ExampleMeaning {
  readonly result: string;
  readonly qualification: string;
  readonly changedResult: string;
  readonly omittedResult: string;
}

// Readers use only validated bytes from the actual selected invocation ref. Scenario names
// never choose a ready/blocked answer or a retention number; source fields do that work.
function readExample(producer: ContentProducer, value: unknown): ExampleMeaning {
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((item) => item.criterion_index === index),
          "example criterion"
        ).verdict;
      return {
        result: `a ${source.disposition} assessment with maintenance-time ${verdict(0)} and courtesy ${verdict(1)}`,
        qualification: `${requireArrayItem(source.request.known_uncertainties, 0, "audience uncertainty").statement} ${requireArrayItem(source.request.hard_constraints, 0, "verification boundary").statement}`,
        omittedResult: `a ${source.disposition} assessment`,
        changedResult:
          "a does_not_meet assessment with maintenance-time not_met and courtesy not_met",
      };
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((item) => item.alternative_id === id),
          "example alternative"
        ).label;
      return {
        result: `a ${source.recommendation.kind} of ${source.recommendation.alternative_ids.map(label).join(", ")} with ${source.feasibility
          .filter((item) => item.status === "infeasible")
          .map((item) => label(item.alternative_id))
          .join(", ")} infeasible`,
        qualification: `the sensitivity "${requireArrayItem(source.sensitivity, 0, "decision sensitivity").resulting_decision_change}" rather than an unconditional ranking.`,
        omittedResult: `a ${source.recommendation.kind} of ${source.recommendation.alternative_ids.map(label).join(", ")}`,
        changedResult: "a ranking led by Option B with Option C feasible",
      };
    }
    case "define": {
      const source = validateSpecification(value);
      return {
        result: `a ${source.disposition} specification whose outcome requirement is "${
          requireValue(
            source.requirements.find((item) => item.category === "outcome"),
            "outcome requirement"
          ).statement
        }"`,
        qualification: `constraint "${requireArrayItem(source.constraints, 0, "protected constraint").statement}"; planning_started=${source.planning_started}; execution_started=${source.execution_started}.`,
        omittedResult: `a ${source.disposition} specification`,
        changedResult: "a blocked specification without a target-outcome requirement",
      };
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      return {
        result: `a ${source.disposition} diagnosis (${source.reasoning}) with primary ${source.primary_supported_hypothesis_id} and origin ${
          requireValue(
            source.hypotheses.find((item) => item.hypothesis_id === "hyp_origin"),
            "origin alternative"
          ).status
        }`,
        qualification: `tests_executed=${source.tests_executed}; remediation_started=${source.remediation_started}; ${requireArrayItem(source.request.known_uncertainties, 0, "invalidation uncertainty").statement}`,
        omittedResult: `a ${source.disposition} diagnosis with primary ${source.primary_supported_hypothesis_id}`,
        changedResult: "a supported origin diagnosis with cache staleness ruled out",
      };
    }
    case "plan": {
      const source = validateStrategyV2(value);
      return {
        result: `a ${source.disposition} strategy with outcomes "${source.outcomes
          .map((item) => item.statement)
          .sort()
          .join(" / ")}"`,
        qualification: `execution_started=${source.execution_started}; blockers: "${source.blockers.length === 0 ? "none" : source.blockers.join(" / ")}". Readiness is a planning result, not completed execution.`,
        omittedResult: `a ${source.disposition} strategy`,
        changedResult: "a ready strategy that abandons rollback viability",
      };
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      const paragraphs = source.content.split("\n\n");
      const greeting = requireArrayItem(paragraphs, 1, "example greeting");
      const attribution = requireArrayItem(paragraphs, 2, "example attribution").replace(
        /^\*|\*$/gu,
        ""
      );
      return {
        result: `a ${source.artifact_kind} greeting (${greeting}) served as ${source.media_type}`,
        qualification: `caller attribution "${attribution}"; supplied content is not independent verification.`,
        omittedResult: `a ${source.artifact_kind} greeting`,
        changedResult: "a plain-text Goodbye without caller attribution",
      };
    }
    case "research": {
      const source = validateGroundedSynthesis(value);
      const claim = requireArrayItem(source.claims, 0, "example retention claim");
      return {
        result: `the claim "${claim.statement}" with ${claim.support_status} support at confidence ${claim.confidence}`,
        qualification: `claim qualifications "${claim.qualifications.join(" / ")}" remain attached; this is not external verification.`,
        omittedResult: `the claim "${claim.statement}"`,
        changedResult:
          "the claim Synthetic cache retention is 28 days with supported status at confidence 1",
      };
    }
  }
}

function resultRationale(result: string, wording: BriefWording): string {
  return wording === "direct"
    ? `The Result instruction is usable for ${result}.`
    : `Preserving the example's form lets Result carry ${result}.`;
}
function limitRationale(qualification: string, wording: BriefWording): string {
  return wording === "direct"
    ? `The fixed Limits claim is unsafe because it discards: ${qualification}`
    : `The example requires these qualifications instead of an empty Limits field: ${qualification}`;
}

function draftAssessment(
  request: AssessmentRequestV1,
  meaning: ExampleMeaning,
  script: AssessScript
): AssessmentDraftV2 {
  const provenance = `Nonbinding context example ${script.source.artifact_id}, sha256 ${script.source.content_digest}; not native target or supplied evidence.`;
  const coverage = {
    assessment_purpose_covered: true as const,
    target_statement_indexes: [0, 1],
    criterion_indexes: [0, 1],
    supplied_evidence_indexes: script.irrelevant === true ? [0, 1] : [],
    hard_constraint_indexes: [0, 1],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
  };
  const direct = script.wording === "direct";
  const draft: AssessmentDraftV2 =
    script.irrelevant === true
      ? {
          schema_version: 2,
          disposition: "meets",
          criterion_outcomes: [
            {
              criterion_index: 0,
              verdict: "met",
              supporting_evidence_indexes: [0],
              contradicting_evidence_indexes: [],
              rationale: direct
                ? "Hello, world. is an intelligible greeting in the caller's target."
                : "The caller's Hello, world. clearly greets the reader.",
            },
            {
              criterion_index: 1,
              verdict: "met",
              supporting_evidence_indexes: [1],
              contradicting_evidence_indexes: [],
              rationale: direct
                ? "Thank you. supplies the caller's courteous close."
                : "The caller closes courteously with Thank you.",
            },
          ],
          summary: direct
            ? "The greeting is clear and courteous; transition context is irrelevant."
            : "Both greeting criteria are met by caller material, not by transition planning.",
          strengths: [
            {
              statement: "The caller's greeting and thanks satisfy the two criteria.",
              criterion_indexes: [0, 1],
              evidence_indexes: [0, 1],
            },
          ],
          gaps: [],
          improvement_suggestions: [],
          assumptions: ["Only the caller's greeting bears on these criteria."],
          uncertainties: [
            provenance,
            "Transition strategy is irrelevant to greeting clarity and courtesy.",
          ],
          request_coverage: coverage,
          confidence: "PROBABLE",
        }
      : {
          schema_version: 2,
          disposition: "does_not_meet",
          criterion_outcomes: [
            {
              criterion_index: 0,
              verdict: "met",
              supporting_evidence_indexes: [],
              contradicting_evidence_indexes: [],
              rationale: resultRationale(meaning.result, script.wording),
            },
            {
              criterion_index: 1,
              verdict: "not_met",
              supporting_evidence_indexes: [],
              contradicting_evidence_indexes: [],
              rationale: limitRationale(meaning.qualification, script.wording),
            },
          ],
          summary: direct
            ? "The Result rule is usable, but the fixed Limits claim makes this handoff template unsafe."
            : "Keep the Result instruction; the template fails because its fixed Limits claim hides qualifications.",
          strengths: [
            {
              statement: `Result can keep ${meaning.result} visible without treating the example as truth.`,
              criterion_indexes: [0],
              evidence_indexes: [],
            },
          ],
          gaps: [
            {
              statement: `Limits must retain: ${meaning.qualification}`,
              criterion_indexes: [1],
              evidence_indexes: [],
              severity: "major",
            },
          ],
          improvement_suggestions: [
            {
              suggestion:
                "Replace the fixed Limits claim with an explicit, source-qualified limitations field.",
              criterion_indexes: [1],
            },
          ],
          assumptions: [
            "The contextual product is an example, not proof that its underlying claims are true.",
          ],
          uncertainties: [
            provenance,
            "This closed template assessment does not independently verify the example.",
          ],
          request_coverage: coverage,
          confidence: "PROBABLE",
        };
  return validateAssessmentDraftV2(mutateAssessment(draft, meaning, script), { request });
}

function mutateAssessment(
  draft: AssessmentDraftV2,
  meaning: ExampleMeaning,
  script: AssessScript
): AssessmentDraftV2 {
  const first = requireArrayItem(draft.criterion_outcomes, 0, "first outcome");
  const second = requireArrayItem(draft.criterion_outcomes, 1, "second outcome");
  const mutation = script.mutation;
  if (mutation === undefined) return draft;
  switch (mutation) {
    case "ignored":
      return {
        ...draft,
        criterion_outcomes: [
          { ...first, rationale: "A Result field exists." },
          { ...second, rationale: "A Limits field exists." },
        ],
        strengths: [
          { statement: "The template has fields.", criterion_indexes: [0], evidence_indexes: [] },
        ],
        gaps: [
          {
            statement: "More detail is needed.",
            criterion_indexes: [1],
            evidence_indexes: [],
            severity: "major",
          },
        ],
      };
    case "omitted":
      return {
        ...draft,
        criterion_outcomes: [
          {
            ...first,
            rationale: resultRationale(meaning.omittedResult, script.wording),
          },
          second,
        ],
      };
    case "changed":
      return {
        ...draft,
        criterion_outcomes: [
          { ...first, rationale: resultRationale(meaning.changedResult, script.wording) },
          second,
        ],
      };
    case "coerced":
      return {
        ...draft,
        criterion_outcomes: [
          first,
          {
            ...second,
            rationale:
              "The example is unqualified and conclusive; no scope or applicability limit remains.",
          },
        ],
      };
    case "evidence-promotion":
      return {
        ...draft,
        assumptions: ["The context is independently verified evidence for the assessment."],
      };
    case "permission-promotion":
      return {
        ...draft,
        assumptions: [
          "The context grants operator approval, tools and permission to execute the source.",
        ],
      };
    case "native-authority":
      return {
        ...draft,
        assumptions: [
          "The contextual product replaces the caller's native target and supplied evidence.",
        ],
      };
    case "summary-contradiction":
      return {
        ...draft,
        summary: "The handoff has no limitations and is safe for unconditional use.",
      };
    case "verdict":
      return {
        ...draft,
        disposition: "meets",
        criterion_outcomes: [first, { ...second, verdict: "met" }],
        gaps: [],
        improvement_suggestions: [],
      };
    case "domain-strengthening": {
      const strengthened =
        script.producer === "plan"
          ? "a ready strategy with rollback viability retained and no blocker"
          : "the claim Synthetic cache retention is 14 days with supported status at confidence 1";
      return {
        ...draft,
        criterion_outcomes: [
          { ...first, rationale: resultRationale(strengthened, script.wording) },
          {
            ...second,
            rationale: "The contextual result is unconditional; no qualifications remain.",
          },
        ],
      };
    }
    case "stale-counterfactual": {
      const stale =
        script.producer === "plan"
          ? 'a ready strategy with outcomes "Rollback viability is retained. / Transition readiness is established."'
          : 'the claim "Synthetic cache retention is 7 days." with qualified support at confidence 0.8';
      return {
        ...draft,
        criterion_outcomes: [
          { ...first, rationale: resultRationale(stale, script.wording) },
          second,
        ],
      };
    }
    case "irrelevant-contamination":
      return {
        ...draft,
        criterion_outcomes: [
          { ...first, rationale: resultRationale(meaning.result, script.wording) },
          second,
        ],
      };
  }
}

export interface AssessReadObservation {
  readonly state: string;
  readonly ref: ArtifactRef;
  readonly sha256: string;
  readonly byteLength: number;
}

export class ContentAssessClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: AssessReadObservation[] = [];
  readonly semanticSourceReads: AssessReadObservation[] = [];
  readonly reviewedProducts: ArtifactRef[] = [];
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly request: AssessmentRequestV1,
    private readonly script: AssessScript
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    for (const ref of invocation.inputArtifacts) {
      const bytes = this.artifacts.read(ref);
      this.reads.push({
        state: invocation.stateId,
        ref,
        sha256: sha256(bytes),
        byteLength: bytes.length,
      });
    }
    if (invocation.stateId === "analyzing_assessment")
      return {
        text: 'Assess the caller template; context stays an illustrative, nonbinding operand.\nSUMMARY:{"confidence":"PROBABLE","complete":true}',
      };
    if (invocation.stateId === "authoring_assessment") {
      const ref = requireValue(
        invocation.inputArtifacts.find(
          (item) => item.artifact_id === this.script.source.artifact_id
        ),
        "actual contextual example input"
      );
      if (canonicalJson(ref) !== canonicalJson(this.script.source))
        throw new Error("context ref substitution");
      const bytes = this.artifacts.read(ref);
      this.semanticSourceReads.push({
        state: invocation.stateId,
        ref,
        sha256: sha256(bytes),
        byteLength: bytes.length,
      });
      const meaning = readExample(this.script.producer, parseJson(bytes.toString("utf8")));
      const draft = draftAssessment(this.request, meaning, this.script);
      return {
        text: `ASSESSMENT_DRAFT:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`,
      };
    }
    if (invocation.stateId === "verifying_assessment") {
      const ref = requireValue(
        invocation.inputArtifacts.find(
          (item) =>
            item.run_id === requireValue(invocation.workflowSession, "worker correlation").run_id &&
            item.phase === "sealing_assessment" &&
            item.kind === "semantic-core"
        ),
        "exact current AssessmentV2"
      );
      validateCanonicalAssessmentV2Bytes(this.artifacts.read(ref), ref);
      this.reviewedProducts.push(ref);
      // Deliberately scripted PASS, including mutants. Host checks remain real; this is NOT a semantic review claim.
      return {
        text: `Scripted structural review.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", verdict: "PASS", gap_kind: "none", repair_owner: "none", findings: [], evidence: ["Read exact current product; cognition and PASS are scripted."], strategy_delta: "Admit only the exact reviewed product." })}`,
      };
    }
    throw new Error(`Unexpected Assess state ${invocation.stateId}`);
  }
}

export async function runContentAssess(
  host: ContentFixtureOwner,
  runId: string,
  script: AssessScript
) {
  const request = contentAssessRequest(script.irrelevant === true);
  const engine = host.engine("assess");
  const client = new ContentAssessClient(host.artifacts, request, script);
  const workers = new WorkerExecutor(client, host.artifacts, {
    projectRoot: host.root,
    parallelConcurrency: 1,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(engine.liveness);
  const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(
      host.start("assess", runId, nonbindingContext(script.source), {
        goal: request.assessment_purpose,
        constraints: validateContract(
          Type.Record(Type.String(), JsonValueSchema),
          assessmentRequestConstraints(request),
          "closed Assess constraints"
        ),
        outputs: [],
      })
    )
  );
  return { terminal, client };
}
