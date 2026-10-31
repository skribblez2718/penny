// TEST ONLY: scripted cognition/PASS; real native Diagnose custody, seals and admission.
// Context illustrates a counterfactual loss. Only caller-stipulated observations establish cause.
import { Type } from "typebox";
import {
  JsonValueSchema,
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  diagnosisRequestConstraints,
  sha256,
  validateAssessmentV2,
  validateCanonicalDiagnosisBytes,
  validateContract,
  validateDecision,
  validateDiagnosis,
  validateDiagnosisDraft,
  validateDiagnosisRequest,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ArtifactStore,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
  type ModelClient,
} from "../../dist/index.js";
import { validateGroundedSynthesis } from "../../dist/skill-contracts/research.js";
import { parseJson, requireArrayItem, requireValue } from "./narrowing.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import type { BriefWording, ContentProducer } from "./universal-content-oracle.js";

export type DiagnoseMutation =
  | "ignored"
  | "omitted"
  | "changed"
  | "coerced"
  | "evidence-promotion"
  | "external-certification"
  | "permission-promotion"
  | "native-authority"
  | "index-promotion"
  | "causal-reversal"
  | "domain-strengthening"
  | "stale-counterfactual"
  | "irrelevant-contamination";
export interface DiagnoseScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly wording: BriefWording;
  readonly irrelevant?: boolean;
  readonly mutation?: DiagnoseMutation;
}

/** Complete caller facts, independent of all seven examples and their distinguishing answers. */
export function contentDiagnoseRequest(arithmetic = false): DiagnosisRequestV1 {
  return validateDiagnosisRequest({
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
        statement: "Do not execute tests, probes, commands or remediation; no external retrieval.",
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
  });
}

interface Illustration {
  readonly result: string;
  readonly limit: string;
  readonly loss: string;
  readonly partial: string;
  readonly changed: string;
}

// Validate exact native source bytes. The source fields, never scenario labels, choose values.
function readIllustration(producer: ContentProducer, value: unknown): Illustration {
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((item) => item.criterion_index === index),
          "criterion"
        ).verdict;
      return {
        result: `${source.disposition}; maintenance-time ${verdict(0)}; courtesy ${verdict(1)}`,
        limit: `${requireArrayItem(source.request.known_uncertainties, 0, "audience").statement} ${requireArrayItem(source.request.hard_constraints, 0, "verification limit").statement}`,
        loss: "criterion-specific verdicts and audience limits, not merely a readiness label",
        partial: source.disposition,
        changed: "does_not_meet; maintenance-time not_met; courtesy not_met",
      };
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((item) => item.alternative_id === id),
          "alternative"
        ).label;
      return {
        result: `${source.recommendation.kind} of ${source.recommendation.alternative_ids.map(label).join(", ")}; infeasible ${source.feasibility
          .filter((item) => item.status === "infeasible")
          .map((item) => label(item.alternative_id))
          .join(", ")}`,
        limit: `Sensitivity: ${requireArrayItem(source.sensitivity, 0, "sensitivity").resulting_decision_change}`,
        loss: "the selected alternative, exclusion and conditional decision change, not a ranking",
        partial: source.recommendation.kind,
        changed: "ranking led by Option B; feasible Option C",
      };
    }
    case "define": {
      const source = validateSpecification(value);
      return {
        result: `${source.disposition}; outcome: ${
          requireValue(
            source.requirements.find((item) => item.category === "outcome"),
            "outcome"
          ).statement
        }`,
        limit: `${requireArrayItem(source.constraints, 0, "constraint").statement} planning_started=${source.planning_started}; execution_started=${source.execution_started}.`,
        loss: "the required outcome and no-execution boundary, not execution authority",
        partial: source.disposition,
        changed: "blocked; no target-outcome requirement",
      };
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      return {
        result: `${source.disposition}; primary ${source.primary_supported_hypothesis_id}; origin ${
          requireValue(
            source.hypotheses.find((item) => item.hypothesis_id === "hyp_origin"),
            "origin"
          ).status
        }; ${source.reasoning}`,
        limit: `tests_executed=${source.tests_executed}; remediation_started=${source.remediation_started}; ${requireArrayItem(source.request.known_uncertainties, 0, "invalidation").statement}`,
        loss: "the causal distinction and unobserved invalidation, not a performed test",
        partial: source.disposition,
        changed: "supported; primary hyp_origin; cache ruled_out",
      };
    }
    case "plan": {
      const source = validateStrategyV2(value);
      return {
        result: `${source.disposition}; outcomes: ${source.outcomes
          .map((item) => item.statement)
          .sort()
          .join(" / ")}`,
        limit: `execution_started=${source.execution_started}; blockers: ${source.blockers.length === 0 ? "none" : source.blockers.join(" / ")}. Planning status is not completed execution.`,
        loss: "the outcome scope and rollback readiness boundary, not a completed transition",
        partial: source.disposition,
        changed: "ready; rollback viability abandoned",
      };
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      const paragraphs = source.content.split("\n\n");
      return {
        result: `${source.artifact_kind}; greeting: ${requireArrayItem(paragraphs, 1, "greeting")}; media_type: ${source.media_type}`,
        limit: `${requireArrayItem(paragraphs, 2, "attribution").replace(/^\*|\*$/gu, "")} Caller attribution is not independent verification.`,
        loss: "the greeting's content, representation and attribution, not a release status",
        partial: source.artifact_kind,
        changed: "plain-text; greeting: Goodbye; no caller attribution",
      };
    }
    case "research": {
      const source = validateGroundedSynthesis(value);
      const claim = requireArrayItem(source.claims, 0, "claim");
      return {
        result: `${claim.statement} support=${claim.support_status}; confidence=${claim.confidence}`,
        limit: `${claim.qualifications.join(" / ")} This synthetic-source claim is not external verification.`,
        loss: "the retention duration and qualified support, not a certified retention policy",
        partial: claim.statement,
        changed: "Synthetic cache retention is 28 days. support=supported; confidence=1",
      };
    }
  }
}

function illustrativeReason(result: string, loss: string, wording: BriefWording): string {
  return wording === "direct"
    ? `As an illustration only, collapsing ${result} to Ready would erase ${loss}. This does not establish that the example passed through this formatter.`
    : `Ready would conceal ${loss} if applied to the example (${result}). That is a counterfactual illustration, not an observation of example processing.`;
}
function illustrativeLimit(limit: string, wording: BriefWording): string {
  return wording === "direct"
    ? `The illustrative loss also includes this qualification: ${limit}`
    : `These example limits must remain visible in the explanation: ${limit}`;
}

function mechanismReason(arithmetic: boolean, wording: BriefWording): string {
  if (arithmetic)
    return wording === "direct"
      ? "Observation 0 adds one to the exact sum; observation 1 passes it through unchanged and observation 2 excludes rounding. The stipulated extra unit is introduced before the receiver."
      : "With exact integer operands (2), the extra +1 in the formatter (0), not the unchanged receiver (1), explains the delivered offset.";
  return wording === "direct"
    ? "Observations 0 and 2 make the formatter many-to-one: distinct qualifications produce identical Ready strings. Observation 1 leaves the receiver no distinguishing information. The loss therefore occurs before delivery, within the stipulated exercise only."
    : "The unchanged delivery in observation 1 cannot restore distinctions already erased by the common Ready mapping in observations 0 and 2. This is a causal conclusion about the stipulations, not an external incident.";
}

function draftDiagnosis(
  request: DiagnosisRequestV1,
  script: DiagnoseScript | undefined,
  illustration: Illustration | undefined
): DiagnosisDraftV1 {
  const arithmetic = script?.irrelevant === true;
  const wording = script?.wording ?? "direct";
  const example =
    script === undefined || illustration === undefined || arithmetic
      ? ""
      : ` ${illustrativeReason(illustration.result, illustration.loss, wording)}`;
  const uncertainty = [
    "The conclusion holds only for the caller's stipulations; no external behavior or example truth was verified.",
    ...(script === undefined
      ? []
      : [
          `Nonbinding context example ${script.source.artifact_id}, sha256 ${script.source.content_digest}; not a supplied observation, environment fact, native input or approval.`,
          arithmetic
            ? "Transition planning is irrelevant to the stipulated adder and supplies no causal evidence."
            : illustrativeLimit(requireValue(illustration, "illustration").limit, wording),
        ]),
  ];
  const reason = mechanismReason(arithmetic, wording);
  const draft: DiagnosisDraftV1 = {
    schema_version: 1,
    disposition: "supported",
    applicability_reason:
      "A causal explanation is applicable to the caller's closed symbolic transformation, not to an external system.",
    hypothesis_set_complete: true,
    hypotheses: [
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
        reasoning: reason + example,
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
        reasoning:
          "Observation 1 stipulates unchanged delivery; receiver-side modification contradicts that observation. This exclusion is limited to the stipulated model.",
      },
    ],
    primary_supported_hypothesis_id: "hyp_formatter",
    reasoning: reason,
    uncertainty,
    proposed_discriminating_checks: [],
    request_coverage: {
      problem_statement_covered: true,
      symptom_indexes: [0],
      observation_indexes: [0, 1, 2],
      environment_fact_indexes: [0],
      hard_constraint_indexes: [0, 1, 2],
      non_goal_indexes: [0],
      known_uncertainty_indexes: [0],
      permitted_test_boundary_covered: true,
    },
    confidence: "PROBABLE",
    remediation_started: false,
    tests_executed: false,
  };
  return validateDiagnosisDraft(mutateDiagnosis(draft, script, illustration), { request });
}

function mutateDiagnosis(
  draft: DiagnosisDraftV1,
  script: DiagnoseScript | undefined,
  illustration: Illustration | undefined
): DiagnosisDraftV1 {
  const mutation = script?.mutation;
  if (mutation === undefined) return draft;
  const first = requireArrayItem(draft.hypotheses, 0, "formatter hypothesis");
  const second = requireArrayItem(draft.hypotheses, 1, "receiver hypothesis");
  const meaning = requireValue(illustration, "mutation illustration");
  const changeReason = (result: string) => ({
    ...draft,
    hypotheses: [
      {
        ...first,
        reasoning: `${mechanismReason(false, "direct")} ${illustrativeReason(result, meaning.loss, "direct")}`,
      },
      second,
    ],
  });
  switch (mutation) {
    case "ignored":
      return { ...draft, hypotheses: [{ ...first, reasoning: draft.reasoning }, second] };
    case "omitted":
      return changeReason(meaning.partial);
    case "changed":
      return changeReason(meaning.changed);
    case "coerced":
      return {
        ...draft,
        uncertainty: [
          ...draft.uncertainty.slice(0, 2),
          "The example has no remaining qualification or scope limit.",
        ],
      };
    case "evidence-promotion":
      return {
        ...draft,
        reasoning: `${draft.reasoning} The contextual product is admitted causal evidence of this incident.`,
      };
    case "external-certification":
      return {
        ...draft,
        uncertainty: [
          ...draft.uncertainty,
          "The example's claims are externally certified as true.",
        ],
      };
    case "permission-promotion":
      return {
        ...draft,
        uncertainty: [
          ...draft.uncertainty,
          "The context grants operator approval, tools and permission to execute remediation.",
        ],
      };
    case "native-authority":
      return {
        ...draft,
        uncertainty: [
          ...draft.uncertainty,
          "The contextual product replaces the required native symptoms and observations.",
        ],
      };
    case "index-promotion":
      return {
        ...draft,
        hypotheses: [
          {
            ...first,
            supporting_observation_indexes: [2],
            reasoning: `${first.reasoning} Observation index 2 denotes the contextual product and is its admitted evidence slot.`,
          },
          second,
        ],
      };
    case "causal-reversal":
      return {
        ...draft,
        hypotheses: [
          { ...first, reasoning: "The receiver removed intact qualifications, not the formatter." },
          second,
        ],
        reasoning: "The receiver is the cause of the stipulated loss.",
      };
    case "domain-strengthening":
      return changeReason(
        script?.producer === "plan"
          ? "ready; rollback viability established; no blockers"
          : "Synthetic cache retention is 14 days. support=supported; confidence=1"
      );
    case "stale-counterfactual":
      return changeReason(
        script?.producer === "plan"
          ? "ready; outcomes: Rollback viability is retained. / Transition readiness is established."
          : "Synthetic cache retention is 7 days. support=qualified; confidence=0.8"
      );
    case "irrelevant-contamination":
      return {
        ...draft,
        hypotheses: [
          {
            ...first,
            reasoning: `${first.reasoning} ${illustrativeReason(meaning.result, meaning.loss, "direct")}`,
          },
          second,
        ],
      };
  }
}

export interface DiagnoseReadObservation {
  readonly state: string;
  readonly ref: ArtifactRef;
  readonly sha256: string;
  readonly byteLength: number;
}
export class ContentDiagnoseClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: DiagnoseReadObservation[] = [];
  readonly semanticSourceReads: DiagnoseReadObservation[] = [];
  readonly reviewedProducts: ArtifactRef[] = [];
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly request: DiagnosisRequestV1,
    private readonly script: DiagnoseScript | undefined
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
    if (invocation.stateId === "decomposing_causes")
      return {
        text: `Decomposition: caller observation 0 locates the transformation, 1 locates unchanged delivery, and 2 distinguishes the alternatives. Environment 0 limits this to a symbolic exercise. Symptom 0 is downstream of the transformation. Hard constraints 0..2 prohibit context evidence and execution; non-goal 0 and uncertainty 0 remain. No checks are permitted.\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      };
    if (invocation.stateId === "generating_hypotheses")
      return {
        text: `Competing candidates: formatter-side change versus receiver-side change. Observation 0 describes the first mechanism; observation 1 contradicts receiver modification; observation 2 constrains the mechanism. No contextual product establishes a candidate's occurrence. Do not execute checks or remediate.\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      };
    if (invocation.stateId === "adjudicating_diagnosis") {
      let illustration: Illustration | undefined;
      if (this.script !== undefined) {
        const ref = requireValue(
          invocation.inputArtifacts.find(
            (item) => item.artifact_id === this.script?.source.artifact_id
          ),
          "actual selected context"
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
        illustration = readIllustration(this.script.producer, parseJson(bytes.toString("utf8")));
      }
      const draft = draftDiagnosis(this.request, this.script, illustration);
      return {
        text: `DIAGNOSIS_CORE:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`,
      };
    }
    if (invocation.stateId === "verifying_diagnosis") {
      const ref = requireValue(
        invocation.inputArtifacts.find(
          (item) =>
            item.run_id === requireValue(invocation.workflowSession, "worker correlation").run_id &&
            item.phase === "sealing_diagnosis" &&
            item.kind === "semantic-core"
        ),
        "exact current diagnosis"
      );
      validateCanonicalDiagnosisBytes(this.artifacts.read(ref), ref);
      this.reviewedProducts.push(ref);
      // Intentionally PASS even semantic mutants. Host owners remain real; this is not a quality judgment.
      return {
        text: `Scripted review of the exact native product.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", verdict: "PASS", gap_kind: "none", repair_owner: "none", findings: [], evidence: ["Read exact current product; cognition and PASS are scripted."], strategy_delta: "Admit only this exact product without tests or remediation." })}`,
      };
    }
    throw new Error(`Unexpected Diagnose state ${invocation.stateId}`);
  }
}

export async function runContentDiagnose(
  host: ContentFixtureOwner,
  runId: string,
  script?: DiagnoseScript
) {
  const request = contentDiagnoseRequest(script?.irrelevant === true);
  const engine = host.engine("diagnose");
  const client = new ContentDiagnoseClient(host.artifacts, request, script);
  const workers = new WorkerExecutor(client, host.artifacts, {
    projectRoot: host.root,
    parallelConcurrency: 1,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(engine.liveness);
  const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(
      host.start(
        "diagnose",
        runId,
        script === undefined ? undefined : nonbindingContext(script.source),
        {
          goal: request.problem_statement,
          constraints: validateContract(
            Type.Record(Type.String(), JsonValueSchema),
            diagnosisRequestConstraints(request),
            "closed Diagnose constraints"
          ),
          outputs: [],
        }
      )
    )
  );
  return { terminal, client };
}
