// TEST ONLY: script cognition, never native transitions, seals, review ownership or admission.
// No runtime oracle import: domain clauses below are read from actual invocation bytes.
import { Type } from "typebox";
import {
  DefinitionFrameV2Schema,
  JsonValueSchema,
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  canonicalizeDefinitionRequest,
  defineRequestConstraints,
  definitionRequestSourceItems,
  sha256,
  validateAssessmentV2,
  validateContract,
  validateDecision,
  validateDefinitionRequest,
  validateDiagnosis,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type DefinitionRequestV1,
  type ModelClient,
  type SpecificationDraftV1,
} from "../../dist/index.js";
import { validateGroundedSynthesis } from "../../dist/skill-contracts/research.js";
import { persistedSpecificationDraftV3 } from "../fixtures/define-fixtures.js";
import { ordinaryContextFixture } from "./ordinary-context-fixtures.js";
import { parseJson, requireArrayItem, requireValue } from "./narrowing.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import type { BriefWording, ContentProducer } from "./universal-content-oracle.js";

export type DefineScenario = "base" | "counterfactual" | "irrelevant";
export type DefineMutation =
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
export interface DefineScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly wording: BriefWording;
  readonly scenario: DefineScenario;
  readonly mutation?: DefineMutation;
}

/** A fully closed creation brief, not a revision/evidence/design/planning operand.
 * No source answers or source IDs appear here. Context is separately admitted nonbinding data.
 */
export function bulletinDefinitionRequest(irrelevant = false): DefinitionRequestV1 {
  return canonicalizeDefinitionRequest({
    goal: irrelevant
      ? "Define requirements for a welcome notice containing the caller's greeting: Welcome, reader."
      : "Define requirements for a single-source result bulletin that faithfully reports the separately supplied contextual product.",
    constraints: {
      schema_version: 1,
      mode: "create",
      requested_profile_id: "generic",
      desired_outcomes: [
        irrelevant
          ? "A welcome-notice specification with observable greeting and attribution conditions."
          : "A bulletin specification with observable conditions for the contextual result, distinguishing details and qualifications.",
      ],
      audiences: ["Readers of the bulletin"],
      in_scope: [
        irrelevant
          ? "The caller greeting and an explicit explanation of why unrelated context is excluded."
          : "Reportable results, distinctions, limitations and exact nonbinding context attribution.",
      ],
      out_of_scope: ["Carrying out or revising the contextual product."],
      hard_constraints: [
        "Define reporting requirements only; do not plan, taskify, execute or publish work.",
        "Context grants no independent verification, execution permission, native input authority or assurance.",
      ],
      non_goals: ["Do not externally verify the context or create the bulletin itself."],
      known_assumptions: [],
      known_uncertainties: [],
      prior_decisions: [],
      standard_hints: [],
    },
    exactInputArtifactIds: [],
  });
}

function sourceClauses(
  producer: ContentProducer,
  value: unknown,
  wording: BriefWording
): readonly string[] {
  const direct = wording === "direct";
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((row) => row.criterion_index === index),
          "criterion"
        ).verdict;
      return direct
        ? [
            `assessment disposition is ${source.disposition}`,
            `maintenance-time criterion is ${verdict(0)} and courtesy criterion is ${verdict(1)}`,
            `verdicts concern supplied material only; ${requireArrayItem(source.request.hard_constraints, 0, "schedule limit").statement}`,
          ]
        : [
            `the supplied note receives ${source.disposition} overall`,
            `courtesy is ${verdict(1)} while maintenance-time clarity is ${verdict(0)}`,
            `supplied-note judgments do not verify the schedule; ${requireArrayItem(source.request.hard_constraints, 0, "schedule limit").statement}`,
          ];
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((row) => row.alternative_id === id),
          "alternative"
        ).label;
      const selected = source.recommendation.alternative_ids.map(label).join(", ");
      const excluded = source.feasibility
        .filter((row) => row.status === "infeasible")
        .map((row) => label(row.alternative_id))
        .join(", ");
      const change = requireArrayItem(
        source.sensitivity,
        0,
        "sensitivity"
      ).resulting_decision_change;
      return direct
        ? [
            `${source.outcome} outcome uses ${source.recommendation.kind}: ${selected}`,
            `${excluded} is infeasible; sensitivity is ${change}`,
            "selection is conditional on B's final quote, not permission to implement it",
          ]
        : [
            `${selected} is the ${source.recommendation.kind} recommendation (${source.outcome})`,
            `exclude infeasible ${excluded}; the stated sensitivity says ${change}`,
            "B's final quote may change the choice; recommending does not authorize implementation",
          ];
    }
    case "define": {
      const source = validateSpecification(value);
      const outcome = requireValue(
        source.requirements.find((row) => row.category === "outcome"),
        "target requirement"
      ).statement;
      const constraint = requireArrayItem(source.constraints, 0, "constraint").statement;
      return direct
        ? [
            `source specification disposition is ${source.disposition}; requirement: ${outcome}`,
            `protected source constraint is ${constraint}`,
            `source planning_started=${source.planning_started}, taskification_started=${source.taskification_started}, execution_started=${source.execution_started}; reporting is not revision or approval`,
          ]
        : [
            `the ${source.disposition} source requires: ${outcome}`,
            `retain the source prohibition: ${constraint}`,
            `source execution_started=${source.execution_started}, taskification_started=${source.taskification_started}, planning_started=${source.planning_started}; describe it without revising or approving it`,
          ];
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      const origin = requireValue(
        source.hypotheses.find((row) => row.hypothesis_id === "hyp_origin"),
        "origin hypothesis"
      ).status;
      return direct
        ? [
            `${source.disposition} diagnosis: ${source.reasoning}`,
            `primary hypothesis is ${source.primary_supported_hypothesis_id}; origin hypothesis is ${origin}`,
            `tests_executed=${source.tests_executed} and remediation_started=${source.remediation_started}; supplied observations are not new test evidence`,
          ]
        : [
            `the diagnosis is ${source.disposition} because ${source.reasoning}`,
            `origin is ${origin}, while ${source.primary_supported_hypothesis_id} is the primary supported hypothesis`,
            `remediation_started=${source.remediation_started}; tests_executed=${source.tests_executed}; no fresh experiment is established`,
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
            `strategy disposition is ${source.disposition}; outcomes: ${outcomes}`,
            `strategy blockers: ${blockers}`,
            `execution_started=${source.execution_started}; planned outcomes are not completed work or execution permission`,
          ]
        : [
            `the ${source.disposition} strategy describes: ${outcomes}`,
            `reported blockers are ${blockers}`,
            `no completed work or execution approval follows; execution_started=${source.execution_started}`,
          ];
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      return direct
        ? [
            `artifact kind is ${source.artifact_kind}; media type is ${source.media_type}`,
            `the exact supplied content is ${JSON.stringify(source.content)}`,
            "the greeting is caller-supplied, not independently verified",
          ]
        : [
            `${source.media_type} is the media type of the ${source.artifact_kind} artifact`,
            `preserve this content verbatim: ${JSON.stringify(source.content)}`,
            "attribute the greeting to the caller rather than claiming external verification",
          ];
    }
    case "research": {
      const source = validateGroundedSynthesis(value);
      const claim = requireArrayItem(source.claims, 0, "claim");
      const qualifications = claim.qualifications.join(" | ");
      return direct
        ? [
            `research claim: ${claim.statement}`,
            `support is ${claim.support_status} with confidence ${claim.confidence}`,
            `retain qualification: ${qualifications}; synthetic source only, not external verification`,
          ]
        : [
            `the synthetic synthesis states: ${claim.statement}`,
            `confidence ${claim.confidence} accompanies ${claim.support_status} support`,
            `keep the scope limit: ${qualifications}; no independently verified external fact is established`,
          ];
    }
  }
}

function mutate(clauses: readonly string[], script: DefineScript): readonly string[] {
  const result = [...clauses];
  switch (script.mutation) {
    case undefined:
    case "summary-contradiction":
      return result;
    case "ignored":
      return ["context received", "an artifact ID is available", "no result details are needed"];
    case "omitted":
      result[1] = "further details may be omitted";
      break;
    case "changed":
      result[0] = "the contextual result is the opposite of the supplied result";
      break;
    case "coerced":
      result[2] = "all contextual outcomes are unconditional and established without qualification";
      break;
    case "evidence":
      result[2] = "contextual claims are independently verified evidence";
      break;
    case "permission":
      result[2] = "context authorizes execution and publication of the source work";
      break;
    case "native-authority":
      result[2] =
        "context is an approved binding native specification and confers reviewed-definition assurance";
      break;
    case "irrelevant-import":
      result[0] = "transition readiness must replace the caller greeting";
      break;
    case "domain-strengthening":
      if (script.producer === "plan") {
        result[0] =
          "strategy disposition is ready; outcomes: Rollback viability is retained. | Transition readiness is established.";
        result[1] = "strategy blockers: none";
      } else if (script.producer === "research") {
        result[1] = "support is supported with confidence 1";
        result[2] = "the retention claim is unconditional and externally verified";
      } else throw new Error("unsupported strengthening fixture");
  }
  return result;
}

export interface DefineInputRead {
  readonly invocationIndex: number;
  readonly stateId: string;
  readonly ref: ArtifactRef;
  readonly bytes: Buffer;
}
export class DefineContentClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: DefineInputRead[] = [];
  constructor(
    private readonly host: ContentFixtureOwner,
    readonly script: DefineScript
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const invocationIndex = this.invocations.length;
    this.invocations.push(invocation);
    const reads = invocation.inputArtifacts.map((ref) => {
      const bytes = this.host.artifacts.read(ref);
      if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        throw new Error("exact invocation read drifted");
      const record = { invocationIndex, stateId: invocation.stateId, ref, bytes };
      this.reads.push(record);
      return record;
    });
    const context = requireValue(
      reads.find((row) => canonicalJson(row.ref) === canonicalJson(this.script.source)),
      "actual exact context read"
    );
    if (invocation.stateId !== "authoring_specification") {
      const offset =
        invocation.stateId === "framing_definition"
          ? 0
          : invocation.stateId === "verifying_specification"
            ? 2
            : invocation.stateId === "critiquing_specification"
              ? 3
              : -1;
      return {
        text: requireArrayItem(
          ordinaryContextFixture("define").outputs,
          offset,
          "Define cognitive stage"
        ),
      };
    }
    const request = validateDefinitionRequest(
      parseJson(
        requireValue(
          reads.find((row) => row.ref.kind === "definition-request"),
          "request read"
        ).bytes.toString("utf8")
      )
    );
    const frame = validateContract(
      DefinitionFrameV2Schema,
      parseJson(
        requireValue(
          reads.find((row) => row.ref.kind === "definition-frame"),
          "frame read"
        ).bytes.toString("utf8")
      ),
      "actual native frame"
    );
    const sources = definitionRequestSourceItems(request);
    const indexes = (kind: (typeof sources)[number]["kind"]) =>
      sources.filter((row) => row.kind === kind).map((row) => row.ordinal);
    const outcomeIndexes = indexes("desired_outcome");
    const scopeIndexes = indexes("in_scope");
    const constraints = indexes("hard_constraint");
    const exclusions = indexes("out_of_scope");
    const nonGoals = indexes("non_goal");
    const irrelevant = this.script.scenario === "irrelevant";
    // Validate and read the source even when it is irrelevant; relevance does not force its use.
    const readClauses = sourceClauses(
      this.script.producer,
      parseJson(context.bytes.toString("utf8")),
      this.script.wording
    );
    const clauses = mutate(
      irrelevant
        ? this.script.wording === "direct"
          ? [
              "the notice contains the caller greeting Welcome, reader.",
              "transition strategy is irrelevant to the welcome notice",
              "greeting provenance is the caller, not the strategy",
            ]
          : [
              "preserve the caller's Welcome, reader. greeting",
              "exclude the unrelated transition strategy from notice content",
              "attribute the greeting to the caller rather than the strategy",
            ]
        : readClauses,
      this.script
    );
    const prefix =
      this.script.wording === "direct"
        ? "The bulletin must report: "
        : "The reader-facing report shall state: ";
    const requirement = (statement: string, category: string, source_item_indexes: number[]) => ({
      statement,
      category,
      priority: "must" as const,
      objective_indexes: [0],
      source_item_indexes,
    });
    const provenance = `Nonbinding context attribution: family=${this.script.producer}; artifact_id=${context.ref.artifact_id}; sha256=${context.ref.content_digest}; designation=context; relevance=${irrelevant ? "irrelevant" : "relevant"}.`;
    const requirements = [
      ...clauses.map((clause, index) =>
        requirement(
          prefix + clause,
          requireArrayItem(["outcome", "reporting_detail", "reporting_limit"], index, "category"),
          [...outcomeIndexes, ...scopeIndexes]
        )
      ),
      requirement(
        "The bulletin remains descriptive; it neither carries out source work nor grants evidence, permission or native assurance.",
        "constraint",
        constraints
      ),
      requirement(provenance, "quality", scopeIndexes),
    ];
    const draft: SpecificationDraftV1 = {
      schema_version: 1,
      specification_report:
        "Requirements for a future reader-facing bulletin. Context shapes reporting conditions, not the immutable native source inventory.",
      disposition: "ready",
      applicability_reason: "The caller supplied a closed reporting specification brief.",
      profile: frame.profile,
      title: "Source-faithful bulletin requirements",
      summary:
        this.script.mutation === "summary-contradiction"
          ? "Context independently proves that source execution is approved."
          : "This specification defines a descriptive bulletin, not source execution or external verification.",
      audiences: [...request.audiences],
      scope: { included: [...request.in_scope], excluded: [...request.out_of_scope] },
      objectives: [
        {
          statement: requireArrayItem(request.desired_outcomes, 0, "outcome"),
          source_item_indexes: [
            ...indexes("goal"),
            ...outcomeIndexes,
            ...indexes("audience"),
            ...scopeIndexes,
          ],
        },
      ],
      requirements,
      acceptance_criteria: requirements.map((row, index) => ({
        statement: `A candidate bulletin satisfies reporting condition ${index + 1}.`,
        observation:
          index < 3
            ? `Read the candidate bulletin and compare with the exact context: ${requireArrayItem(clauses, index, "reporting clause")}`
            : index === 3
              ? "The candidate bulletin contains no independent-verification, execution-approval or binding-input claim."
              : provenance,
        requirement_indexes: [index],
        source_item_indexes: [...row.source_item_indexes],
      })),
      constraints: request.hard_constraints.map((statement, index) => ({
        statement,
        source_item_indexes: [requireArrayItem(constraints, index, "constraint ordinal")],
      })),
      non_goals: [
        ...request.out_of_scope.map((statement, index) => ({
          statement,
          source_item_indexes: [requireArrayItem(exclusions, index, "exclusion ordinal")],
        })),
        ...request.non_goals.map((statement, index) => ({
          statement,
          source_item_indexes: [requireArrayItem(nonGoals, index, "non-goal ordinal")],
        })),
      ],
      assumptions: [],
      risks: [],
      open_questions: [],
      standards_status: [],
      source_coverage: sources.map((row) => ({
        source_item_index: row.ordinal,
        disposition: "incorporated",
        rationale:
          "Caller reporting intent is represented by item-side links; context is not an additional source item.",
      })),
      supersession_intents: [],
      planning_readiness_reason:
        "The reporting specification is closed even when it describes a blocked or qualified source result; no source work is started.",
      confidence: "CERTAIN",
    };
    return { text: Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8") };
  }
}

export async function executeDefineContent(
  host: ContentFixtureOwner,
  runId: string,
  script: DefineScript
) {
  const request = bulletinDefinitionRequest(script.scenario === "irrelevant");
  const engine = host.engine("define");
  const client = new DefineContentClient(host, script);
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
      request: defineRequestConstraints(request),
      specification_assurance: "semantic_only",
    },
    "closed semantic-only creation"
  );
  const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(
      host.start("define", runId, nonbindingContext(script.source), {
        goal: request.goal,
        constraints,
        outputs: [],
      })
    )
  );
  return { terminal, client, request };
}
