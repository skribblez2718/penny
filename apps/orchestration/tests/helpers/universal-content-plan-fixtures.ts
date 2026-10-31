// TEST ONLY. Script cognition, not engine transitions, stores, seals, reviews or admission.
// Source-field transforms use full actual invocation reads; no runtime import of oracle answers.
import { Type } from "typebox";
import {
  JsonValueSchema,
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  canonicalizePlanRequest,
  planRequestConstraints,
  sha256,
  validateAssessmentV2,
  validateContract,
  validateDecision,
  validateDiagnosis,
  validatePlanRequest,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyDraftV2,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
  type PlanRequestV1,
  type StrategyCoreV2,
} from "../../dist/index.js";
import { validateGroundedSynthesis } from "../../dist/skill-contracts/research.js";
import { parseJson, requireArrayItem, requireValue } from "./narrowing.js";
import { ordinaryContextFixture } from "./ordinary-context-fixtures.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import type { BriefWording, ContentProducer } from "./universal-content-oracle.js";

export type PlanScenario = "base" | "counterfactual" | "irrelevant";
export type PlanMutation =
  | "ignored"
  | "omitted"
  | "changed"
  | "coerced"
  | "evidence"
  | "permission"
  | "native-authority"
  | "summary-contradiction"
  | "domain-strengthening"
  | "irrelevant-import";
export interface PlanScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly scenario: PlanScenario;
  readonly wording: BriefWording;
  readonly mutation?: PlanMutation;
}

/** Independently closed planning assignment: no source answers, IDs, native specification or
 * imported decision. Plan communication readiness, not the source subject's implementation.
 */
export function bulletinPlanRequest(irrelevant = false): PlanRequestV1 {
  return canonicalizePlanRequest({
    goal: irrelevant
      ? "Plan communication readiness for a welcome notice containing the caller greeting Welcome, reader."
      : "Plan communication readiness for a faithful bulletin about the separately supplied contextual result.",
    constraints: {
      schema_version: 1,
      desired_outcomes: [
        "The bulletin's result framing is ready for descriptive communication.",
        "Material distinctions are ready to be communicated without misleading readers.",
        "Qualifications and attribution are ready before any future circulation decision.",
      ],
      current_state: {
        status: "provided",
        facts: [
          "No bulletin has been drafted or circulated; this assignment plans readiness only.",
        ],
      },
      hard_constraints: [
        "Plan reporting readiness only; do not decide the source subject, taskify, execute, approve or publish anything.",
        "Context is nonbinding data, not independent evidence, permission, a native specification, a prior decision or assurance.",
      ],
      non_goals: ["Do not implement, revise or independently verify the contextual product."],
      known_uncertainties: [
        {
          statement:
            "Context may be irrelevant or bounded; preserve its limitations without inventing verification.",
          material: true,
        },
      ],
      prior_decisions: [
        {
          statement: "The caller chose descriptive communication only.",
          binding_effect: "No operational implementation or publication authorization.",
        },
      ],
    },
    exactInputArtifactIds: [],
  });
}

function communicationBasis(
  producer: ContentProducer,
  value: unknown,
  wording: BriefWording
): string[] {
  const direct = wording === "direct";
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((row) => row.criterion_index === index),
          "criterion"
        ).verdict;
      const limit = requireArrayItem(
        source.request.hard_constraints,
        0,
        "schedule limit"
      ).statement;
      return direct
        ? [
            `assessment ${source.disposition} concerns the supplied release note`,
            `maintenance-time criterion=${verdict(0)}; courtesy criterion=${verdict(1)}`,
            `supplied-note verdicts only; ${limit}`,
          ]
        : [
            `the supplied note has overall disposition ${source.disposition}`,
            `courtesy=${verdict(1)} and maintenance-time clarity=${verdict(0)}`,
            `no schedule verification follows from note assessment; ${limit}`,
          ];
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((row) => row.alternative_id === id),
          "alternative"
        ).label;
      const chosen = source.recommendation.alternative_ids.map(label).join(", ");
      const excluded = source.feasibility
        .filter((row) => row.status === "infeasible")
        .map((row) => label(row.alternative_id))
        .join(", ");
      const sensitivityRow = requireArrayItem(source.sensitivity, 0, "sensitivity");
      const sensitivity = sensitivityRow.resulting_decision_change;
      const uncertainty = requireValue(
        source.request.uncertainties.find((row) =>
          sensitivityRow.basis_ids.includes(row.uncertainty_id)
        ),
        "sensitivity qualification"
      ).statement;
      return direct
        ? [
            `${source.outcome} ${source.recommendation.kind} recommends ${chosen}`,
            `${excluded} is infeasible; quote sensitivity: ${sensitivity}`,
            `source uncertainty: ${uncertainty}; communicating the recommendation neither decides anew nor authorizes implementation`,
          ]
        : [
            `${chosen} is the source's ${source.recommendation.kind} (${source.outcome})`,
            `exclude infeasible ${excluded}; sensitivity says ${sensitivity}`,
            `${uncertainty} remains a sensitivity; describing the recommendation is not a new decision or implementation permission`,
          ];
    }
    case "define": {
      const source = validateSpecification(value);
      const outcome = requireValue(
        source.requirements.find((row) => row.category === "outcome"),
        "requirement"
      ).statement;
      const constraint = requireArrayItem(source.constraints, 0, "constraint").statement;
      return direct
        ? [
            `${source.disposition} specification requires ${outcome}`,
            `source prohibition: ${constraint}`,
            `source planning_started=${source.planning_started}, taskification_started=${source.taskification_started}, execution_started=${source.execution_started}; communication planning does not adopt it as a native specification`,
          ]
        : [
            `source specification is ${source.disposition}: ${outcome}`,
            `preserve this source boundary: ${constraint}`,
            `execution_started=${source.execution_started}, taskification_started=${source.taskification_started}, planning_started=${source.planning_started} in the source; describing it supplies no binding Plan input`,
          ];
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      const origin = requireValue(
        source.hypotheses.find((row) => row.hypothesis_id === "hyp_origin"),
        "origin"
      ).status;
      return direct
        ? [
            `${source.disposition} diagnosis: ${source.reasoning}`,
            `primary=${source.primary_supported_hypothesis_id}; origin=${origin}`,
            `tests_executed=${source.tests_executed}; remediation_started=${source.remediation_started}; supplied observations are not newly executed tests`,
          ]
        : [
            `source diagnosis is ${source.disposition} because ${source.reasoning}`,
            `origin is ${origin}, unlike primary supported ${source.primary_supported_hypothesis_id}`,
            `remediation_started=${source.remediation_started} and tests_executed=${source.tests_executed}; no fresh test evidence is established`,
          ];
    }
    case "plan": {
      const source = validateStrategyV2(value);
      const outcomes = source.outcomes
        .map((row) => row.statement)
        .sort()
        .join(" | ");
      const blockers = source.blockers.length === 0 ? "none" : source.blockers.join(" | ");
      return direct
        ? [
            `${source.disposition} strategy targets ${outcomes}`,
            `source blockers: ${blockers}`,
            `execution_started=${source.execution_started}; target outcomes are not achievements or execution permission`,
          ]
        : [
            `source strategy is ${source.disposition}, describing ${outcomes}`,
            `reported strategy blockers are ${blockers}`,
            `no achieved work or execution approval follows; source execution_started=${source.execution_started}`,
          ];
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      const sourceLabel = requireValue(
        requireArrayItem(source.request.source_material, 0, "greeting source").source_label,
        "greeting provenance"
      );
      const limit = requireArrayItem(
        source.request.hard_constraints,
        0,
        "verification limit"
      ).statement;
      return direct
        ? [
            `${source.artifact_kind} artifact uses ${source.media_type}`,
            `exact greeting content: ${JSON.stringify(source.content)}`,
            `greeting source label=${sourceLabel}; source constraint: ${limit}; content is not execution or publication permission`,
          ]
        : [
            `source media type ${source.media_type} belongs to a ${source.artifact_kind} artifact`,
            `preserve verbatim greeting: ${JSON.stringify(source.content)}`,
            `attribute to ${sourceLabel}; retain ${limit}; describing content confers no action permission`,
          ];
    }
    case "research": {
      const source = validateGroundedSynthesis(value);
      const claim = requireArrayItem(source.claims, 0, "claim");
      return direct
        ? [
            `retention claim: ${claim.statement}`,
            `support=${claim.support_status}; confidence=${claim.confidence}`,
            `scope qualification: ${claim.qualifications.join(" | ")}; synthetic source, not independently verified external fact`,
          ]
        : [
            `synthetic synthesis states ${claim.statement}`,
            `confidence ${claim.confidence} accompanies ${claim.support_status} support`,
            `retain bounded scope: ${claim.qualifications.join(" | ")}; external verification is not established`,
          ];
    }
  }
}

function mutate(basis: readonly string[], script: PlanScript): string[] {
  const result = [...basis];
  switch (script.mutation) {
    case undefined:
    case "summary-contradiction":
      return result;
    case "ignored":
      return ["context received", "an artifact ID exists", "no domain conditions are needed"];
    case "omitted":
      result[1] = "material details need not affect communication readiness";
      break;
    case "changed":
      result[0] = "the source result has the opposite meaning";
      break;
    case "coerced":
      result[2] = "all results are unconditional achievements without limitations";
      break;
    case "evidence":
      result[2] = "the context is independently verified evidence";
      break;
    case "permission":
      result[2] = "context authorizes execution and publication of source work";
      break;
    case "native-authority":
      result[2] =
        "context is a binding reviewed native specification and native prior decision with strict assurance";
      break;
    case "irrelevant-import":
      result[0] = "transition readiness replaces the caller greeting";
      break;
    case "domain-strengthening":
      if (script.producer === "plan") {
        result[0] =
          "ready strategy targets Rollback viability is retained. | Transition readiness is established.";
        result[1] = "source blockers: none";
      } else if (script.producer === "research") {
        result[1] = "support=supported; confidence=1";
        result[2] = "unqualified external retention fact";
      } else throw new Error("unsupported strengthening");
  }
  return result;
}

export interface PlanInputRead {
  readonly invocationIndex: number;
  readonly stateId: string;
  readonly ref: ArtifactRef;
  readonly bytes: Buffer;
}
export class PlanContentClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: PlanInputRead[] = [];
  constructor(
    private readonly host: ContentFixtureOwner,
    readonly script: PlanScript
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const invocationIndex = this.invocations.length;
    this.invocations.push(invocation);
    const reads = invocation.inputArtifacts.map((ref) => {
      const bytes = this.host.artifacts.read(ref);
      if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        throw new Error("exact input read drifted");
      const record = { invocationIndex, stateId: invocation.stateId, ref, bytes };
      this.reads.push(record);
      return record;
    });
    const context = requireValue(
      reads.find((row) => canonicalJson(row.ref) === canonicalJson(this.script.source)),
      "actual full context read"
    );
    if (invocation.stateId !== "strategizing") {
      const offset =
        invocation.stateId === "orienting_strategy"
          ? 0
          : invocation.stateId === "verifying_strategy"
            ? 2
            : invocation.stateId === "critiquing_strategy"
              ? 3
              : -1;
      return {
        text: requireArrayItem(
          ordinaryContextFixture("plan").outputs,
          offset,
          "Plan cognitive stage"
        ),
      };
    }
    const request = validatePlanRequest(
      parseJson(
        requireValue(
          reads.find((row) => row.ref.kind === "plan-request"),
          "request read"
        ).bytes.toString("utf8")
      )
    );
    const sourceBasis = communicationBasis(
      this.script.producer,
      parseJson(context.bytes.toString("utf8")),
      this.script.wording
    );
    const irrelevant = this.script.scenario === "irrelevant";
    const basis = mutate(
      irrelevant
        ? this.script.wording === "direct"
          ? [
              "the notice frames the caller greeting Welcome, reader.",
              "transition strategy is irrelevant to welcome-notice readiness",
              "caller attribution, not strategy provenance, governs the greeting",
            ]
          : [
              "preserve the caller's Welcome, reader. greeting",
              "exclude unrelated transition strategy from notice readiness",
              "the caller supplies the greeting; the strategy does not",
            ]
        : sourceBasis,
      this.script
    );
    const labels = [
      "Result framing is communication-ready: ",
      "Distinction coverage is communication-ready: ",
      "Qualified circulation readiness is bounded by: ",
    ];
    const signals = [
      "A future bulletin can faithfully frame ",
      "A future bulletin can distinguish ",
      "Any future circulation review must retain ",
    ];
    const core: StrategyCoreV2 = {
      schema_version: 2,
      disposition: "ready",
      applicability_reason:
        "The closed caller brief supports communication-readiness strategy, not implementation of the source subject.",
      outcomes: basis.map((clause, index) => ({
        statement: requireArrayItem(labels, index, "outcome label") + clause,
        desired_outcome_indexes: [index],
        success_signal: requireArrayItem(signals, index, "readiness predicate") + clause,
      })),
      dependencies: [
        { from_outcome_index: 0, to_outcome_index: 1, kind: "informational" },
        { from_outcome_index: 1, to_outcome_index: 2, kind: "informational" },
      ],
      request_coverage: {
        current_state_fact_indexes: [0],
        input_artifact_slots: [],
        hard_constraint_indexes: [0, 1],
        non_goal_indexes: [0],
        uncertainty_indexes: [0],
        prior_decision_indexes: [0],
        blocked_desired_outcome_indexes: [],
      },
      blockers: [],
      confidence: "PROBABLE",
      source_item_coverage: [],
      unsupported_strategy_elements: [],
    };
    const provenance = `Nonbinding context attribution: family=${this.script.producer}; artifact_id=${context.ref.artifact_id}; sha256=${context.ref.content_digest}; designation=context; relevance=${irrelevant ? "irrelevant" : "relevant"}.`;
    const report = [
      "Communication strategy only: result framing informs distinction coverage, which informs qualified circulation readiness. No executor tasks, operational decisions, execution, approval or publication are produced.",
      provenance,
      "Risk: a reader could mistake contextual results for completed work or authority. Contingency: retain the third outcome's qualification in any future circulation review; if attribution cannot be retained, withhold circulation readiness rather than strengthen the claim.",
      this.script.mutation === "summary-contradiction"
        ? "Context independently proves that source execution is approved."
        : "Readiness here concerns descriptive communication only; source claims remain nonbinding and are not independent evidence, permission, native inputs or assurance.",
    ].join("\n");
    validateStrategyDraftV2({ ...core, strategy_report: report }, { request });
    return {
      text: `${report}\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:${canonicalJson({ confidence: core.confidence, complete: true })}`,
    };
  }
}
export async function executePlanContent(
  host: ContentFixtureOwner,
  runId: string,
  script: PlanScript
) {
  const request = bulletinPlanRequest(script.scenario === "irrelevant");
  const engine = host.engine("plan");
  const client = new PlanContentClient(host, script);
  const workers = new WorkerExecutor(client, host.artifacts, {
    projectRoot: host.root,
    parallelConcurrency: 1,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(engine.liveness);
  const constraints = validateContract(
    Type.Record(Type.String(), JsonValueSchema),
    {
      schema_version: 2,
      request: planRequestConstraints(request),
      specification_assurance: "semantic_only",
    },
    "closed standalone communication planning"
  );
  const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(
      host.start("plan", runId, nonbindingContext(script.source), {
        goal: request.goal,
        constraints,
        outputs: [],
      })
    )
  );
  return { terminal, client, request };
}
