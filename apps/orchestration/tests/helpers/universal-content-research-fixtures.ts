// TEST ONLY. Script cognition, not native Research projection, sealing, review ownership or admission.
// The oracle's literal expectations are never imported by this source-field client.
import {
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  sha256,
  validateAssessmentV2,
  validateDecision,
  validateDiagnosis,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
} from "../../dist/index.js";
import {
  canonicalizeResearchRequest,
  validateGroundedSynthesis,
  validateResearchSemanticDraft,
  type ResearchSemanticDraftV1,
} from "../../dist/skill-contracts/research.js";
import { parseJson, requireArrayItem, requireValue } from "./narrowing.js";
import { researchSemanticDraftFixture } from "./research-semantic-draft.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import type { BriefWording, ContentProducer } from "./universal-content-oracle.js";

export type ResearchScenario = "base" | "counterfactual" | "irrelevant";
export type ResearchMutation =
  | "ignored"
  | "omitted"
  | "changed"
  | "coerced"
  | "evidence"
  | "permission"
  | "native-authority"
  | "summary-contradiction"
  | "domain-strengthening"
  | "irrelevant-import"
  | "unsupported-fact";
export interface ResearchScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly wording: BriefWording;
  readonly scenario: ResearchScenario;
  readonly mutation?: ResearchMutation;
}

// Fixed independently of every producer/source/variant. This is a supplied synthetic method
// observation, NOT an observation of the contextual propositions or a claim of external truth.
export const syntheticMethodObservation =
  "SYNTHETIC METHOD OBSERVATION: Independent measurements are needed to test an unverified workflow proposition. A verification question is not a factual finding, operational approval, or an executed experiment.";

/** Closed native question/scope, sufficient even without context, with no distinguishing answers. */
export function verificationResearchRequest(irrelevant = false) {
  return canonicalizeResearchRequest({
    question: irrelevant
      ? "What verification method should accompany the caller's synthetic greeting Welcome, reader.? Exclude unrelated workflow context."
      : "What independent verification questions and limitations should accompany a nonbinding workflow handoff? Produce a verification agenda, not a factual verdict on the handoff.",
    constraints: {
      mode: "deep",
      scope: {
        include: [
          "The supplied synthetic method observation and its methodological consequence.",
          irrelevant
            ? "Verification of caller greeting attribution only."
            : "Context may orient verification questions and limitations, but is not an evidentiary source.",
        ],
        exclude: [
          "Establishing contextual propositions as true or independently verified.",
          "Execution, publication, approval, tool grants, or substitution for native required inputs.",
        ],
      },
    },
  });
}

interface SourceOrientation {
  readonly questions: readonly string[];
  readonly limit: string;
}
function sourceOrientation(producer: ContentProducer, value: unknown): SourceOrientation {
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((row) => row.criterion_index === index),
          "criterion"
        ).verdict;
      return {
        questions: [
          `overall ${source.disposition} and maintenance-time ${verdict(0)}`,
          `courtesy ${verdict(1)}`,
        ],
        limit: `Supplied-note judgments only. ${requireArrayItem(source.request.hard_constraints, 0, "schedule constraint").statement}`,
      };
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((row) => row.alternative_id === id),
          "alternative"
        ).label;
      return {
        questions: [
          `${source.outcome}/${source.recommendation.kind} of ${source.recommendation.alternative_ids.map(label).join(", ")}`,
          `${source.feasibility
            .filter((row) => row.status === "infeasible")
            .map((row) => label(row.alternative_id))
            .join(
              ", "
            )} infeasible; sensitivity: ${requireArrayItem(source.sensitivity, 0, "sensitivity").resulting_decision_change}`,
        ],
        limit:
          "B's final quote may change the choice; recommendation is not implementation approval.",
      };
    }
    case "define": {
      const source = validateSpecification(value);
      return {
        questions: [
          `${source.disposition} target requirement: ${
            requireValue(
              source.requirements.find((row) => row.category === "outcome"),
              "outcome requirement"
            ).statement
          }`,
          `protected constraint: ${requireArrayItem(source.constraints, 0, "constraint").statement}`,
        ],
        limit: `planning_started=${source.planning_started}; taskification_started=${source.taskification_started}; execution_started=${source.execution_started}; reporting is not revision or assurance.`,
      };
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      return {
        questions: [
          `${source.disposition}: ${source.reasoning}`,
          `primary ${source.primary_supported_hypothesis_id}; origin ${
            requireValue(
              source.hypotheses.find((row) => row.hypothesis_id === "hyp_origin"),
              "origin hypothesis"
            ).status
          }`,
        ],
        limit: `tests_executed=${source.tests_executed}; remediation_started=${source.remediation_started}; no fresh experiment is established.`,
      };
    }
    case "plan": {
      const source = validateStrategyV2(value);
      return {
        questions: [
          `${source.disposition} outcomes: ${source.outcomes
            .map((row) => row.statement)
            .sort()
            .join(" | ")}`,
          `blockers: ${source.blockers.length === 0 ? "none" : source.blockers.join(" | ")}`,
        ],
        limit: `execution_started=${source.execution_started}; planned outcomes are not completed work.`,
      };
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      return {
        questions: [
          `${source.artifact_kind} / ${source.media_type}`,
          `caller content ${JSON.stringify(source.content)}`,
        ],
        limit: "Caller-supplied greeting only, not independent verification.",
      };
    }
    case "research": {
      const claim = requireArrayItem(validateGroundedSynthesis(value).claims, 0, "source claim");
      return {
        questions: [
          claim.statement,
          `${claim.support_status} support with confidence ${claim.confidence}`,
        ],
        limit: `${claim.qualifications.join(" | ")} Synthetic-source assertion only, not external verification.`,
      };
    }
  }
}

function mutateOrientation(value: SourceOrientation, script: ResearchScript): SourceOrientation {
  const questions = [...value.questions];
  switch (script.mutation) {
    case "ignored":
      return { questions: ["context received", "an ID was delivered"], limit: value.limit };
    case "omitted":
      questions[1] = "details omitted";
      break;
    case "changed":
      questions[0] = "the opposite contextual result";
      break;
    case "coerced":
      return { questions, limit: "All contextual outcomes are unconditional and established." };
    case "irrelevant-import":
      questions[0] = "transition readiness replaces the caller greeting";
      break;
    case "domain-strengthening":
      if (script.producer === "plan")
        return {
          questions: [
            "ready outcomes: Rollback viability is retained. | Transition readiness is established.",
            "blockers: none",
          ],
          limit: value.limit,
        };
      if (script.producer === "research")
        return {
          questions: [
            requireArrayItem(questions, 0, "claim"),
            "supported support with confidence 1",
          ],
          limit: "The retention assertion has no qualification.",
        };
      throw new Error("unsupported strengthening fixture");
  }
  return { ...value, questions };
}

function methodDraft(
  invocation: AgentInvocation,
  host: ContentFixtureOwner
): ResearchSemanticDraftV1 {
  const seed = researchSemanticDraftFixture(invocation, host.artifacts, { citedSlots: [0] });
  return validateResearchSemanticDraft({
    ...seed,
    title: "Synthetic verification method",
    executive_summary:
      "Only a synthetic verification method is established; no workflow proposition is verified.",
    sources: [
      {
        source_kind: "primary",
        role: "evidentiary",
        tier: 1,
        title: "Supplied synthetic method observation",
        locator: "fixture:independent-method",
        observed_at: "2026-10-26T00:00:00Z",
      },
    ],
    evidence: seed.evidence.map((row) => ({ ...row, locator: "fixture:independent-method" })),
    claims: [
      {
        statement:
          "The supplied synthetic method requires independent measurements before operational conclusions.",
        claim_kind: "inference",
        support_status: "qualified",
        confidence: 0.8,
        evidence_indexes: [0],
        qualifications: ["Synthetic method exercise only; no external observation was made."],
      },
    ],
    sections: [
      {
        heading: "Verification method",
        body: "Independent measurements are required; no contextual proposition is established.",
        claim_indexes: [0],
        evidence_indexes: [0],
      },
    ],
  });
}

function contextualDraft(
  invocation: AgentInvocation,
  host: ContentFixtureOwner,
  script: ResearchScript,
  bytes: Buffer
): ResearchSemanticDraftV1 {
  const read = sourceOrientation(script.producer, parseJson(bytes.toString("utf8")));
  const orientation = mutateOrientation(
    script.scenario === "irrelevant"
      ? {
          questions: [
            "caller greeting Welcome, reader.",
            "caller rather than transition-strategy attribution",
          ],
          limit: "Unrelated transition context is excluded from the greeting investigation.",
        }
      : read,
    script
  );
  // Reuse only the real owner slot/excerpt reader, not its default claim/source semantics.
  const seed = methodDraft(invocation, host);
  const direct = script.wording === "direct";
  const boundary =
    "Method evidence supports the verification method only, not the contextual propositions. Context is nonbinding and grants no evidence status, permission, native input authority, or tools.";
  const qualify = (limit: string) => [
    direct ? `Unverified orientation: ${limit}` : `Contextual limitation, not a finding: ${limit}`,
    boundary,
  ];
  const claims: ResearchSemanticDraftV1["claims"] = [
    requireArrayItem(seed.claims, 0, "method claim"),
    ...orientation.questions.map((question) => ({
      statement: direct
        ? `Investigate independently: ${question}`
        : `Research question: how could independent checks test ${question}?`,
      claim_kind: "recommendation" as const,
      support_status: "qualified" as const,
      confidence: 0.4,
      // The evidence supports ONLY the recommendation to investigate; it does not establish the topic.
      evidence_indexes: [0],
      qualifications: qualify(orientation.limit),
    })),
  ];
  if (script.mutation === "evidence")
    claims[1] = {
      ...requireArrayItem(claims, 1, "contextual recommendation"),
      statement:
        "The contextual propositions are independently verified by the synthetic method observation.",
      claim_kind: "fact",
      support_status: "supported",
      confidence: 1,
      qualifications: [],
    };
  if (script.mutation === "permission")
    claims[2] = {
      ...requireArrayItem(claims, 2, "contextual recommendation"),
      statement: "Context authorizes execution and publication; bash is allowed.",
    };
  if (script.mutation === "native-authority")
    claims[2] = {
      ...requireArrayItem(claims, 2, "contextual recommendation"),
      statement:
        "Context replaces required native inputs and imports an approved prior semantic core.",
    };
  if (script.mutation === "unsupported-fact")
    claims[1] = {
      ...requireArrayItem(claims, 1, "contextual claim"),
      statement: "The contextual proposition is true.",
      claim_kind: "fact",
      support_status: "unsupported",
      confidence: 0,
      evidence_indexes: [],
      qualifications: ["No independent evidence was supplied."],
    };
  const provenance = `Nonbinding ${script.producer} context: ${script.source.artifact_id}; sha256=${script.source.content_digest}; relevance=${script.scenario === "irrelevant" ? "irrelevant" : "relevant"}.`;
  return validateResearchSemanticDraft({
    ...seed,
    title: "Qualified verification agenda",
    executive_summary:
      script.mutation === "summary-contradiction"
        ? "Context independently proves that operational execution is approved."
        : "This research agenda proposes independent checks; it does not establish the contextual propositions.",
    claims,
    unresolved_gaps: [],
    irreducible_uncertainties: [
      { statement: orientation.limit, affected_claim_indexes: [1, 2], disposition: "qualified" },
    ],
    sections: [
      {
        heading: "Method and evidence boundary",
        body: boundary,
        claim_indexes: [0],
        evidence_indexes: [0],
      },
      ...claims.slice(1).map((claim, index) => ({
        heading: `Verification question ${index + 1}`,
        body: claim.statement,
        claim_indexes: [index + 1],
        evidence_indexes: [0],
      })),
      {
        heading: "Limitations and attribution",
        body: `${orientation.limit}\n${provenance}\n${boundary}`,
        claim_indexes: [1, 2],
        evidence_indexes: [],
      },
    ],
  });
}

export interface ResearchInputRead {
  readonly invocationIndex: number;
  readonly stateId: string;
  readonly ref: ArtifactRef;
  readonly bytes: Buffer;
}
export class ResearchContentClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: ResearchInputRead[] = [];
  constructor(
    private readonly host: ContentFixtureOwner,
    readonly script: ResearchScript | undefined
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const invocationIndex = this.invocations.length;
    this.invocations.push(invocation);
    const reads = invocation.inputArtifacts.map((ref) => {
      const bytes = this.host.artifacts.read(ref);
      if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        throw new Error("exact Research input drift");
      const record = { invocationIndex, stateId: invocation.stateId, ref, bytes };
      this.reads.push(record);
      return record;
    });
    const script = this.script;
    const context =
      script === undefined
        ? undefined
        : requireValue(
            reads.find((row) => canonicalJson(row.ref) === canonicalJson(script.source)),
            "exact contextual read"
          );
    const result = (text: string, details: Record<string, unknown>) => ({
      text: `${text}\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", ...details })}`,
    });
    switch (invocation.stateId) {
      case "planning":
        return result(
          "Inspect the fixed synthetic method observation; keep contextual propositions as questions, not findings.",
          { plan_steps: ["Inspect synthetic method observation."], plan_complete: true }
        );
      case "researching":
        return result(syntheticMethodObservation, { explore_complete: true });
      case "synthesizing":
        return result(
          canonicalJson(
            script === undefined
              ? methodDraft(invocation, this.host)
              : contextualDraft(
                  invocation,
                  this.host,
                  script,
                  requireValue(context, "selected context").bytes
                )
          ),
          { synthesis_complete: true }
        );
      case "validating":
        return result(
          "Scripted review of exact current core; independent fixture oracle remains separate.",
          {
            verdict: "PASS",
            unsupported_claims: [],
            evidence: ["Exact synthetic method and qualified agenda; scripted review."],
          }
        );
      case "critiquing_plan":
      case "critiquing_report":
        return result("Scripted quality review.", {
          verdict: "APPROVE",
          issues: [],
          evidence: ["Exact supplied bytes; scripted review."],
        });
      default:
        throw new Error(`Unexpected Research cognitive state ${invocation.stateId}`);
    }
  }
}

export async function executeResearchContent(
  host: ContentFixtureOwner,
  runId: string,
  script?: ResearchScript
) {
  const request = verificationResearchRequest(script?.scenario === "irrelevant");
  const engine = host.engine("research");
  const client = new ResearchContentClient(host, script);
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
        "research",
        runId,
        script === undefined ? undefined : nonbindingContext(script.source),
        {
          goal: request.question,
          constraints: { mode: request.mode, scope: request.scope },
          outputs: [],
        }
      )
    )
  );
  return { terminal, client, request };
}
