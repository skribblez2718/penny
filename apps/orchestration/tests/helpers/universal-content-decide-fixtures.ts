// TEST ONLY: cognition and reviews are scripted; native owners and completion admission are real.
// No runtime semantic filter. This client never imports oracle values or judging functions.
import { Type } from "typebox";
import {
  JsonValueSchema,
  OrchestrationRunner,
  WorkerExecutor,
  canonicalJson,
  sha256,
  validateAssessmentV2,
  validateContract,
  validateDecision,
  validateDecisionDraft,
  validateDecisionRequest,
  validateDiagnosis,
  validateProducedArtifactV2,
  validateSpecification,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type DecisionDraftV2,
  type DecisionRequestV1,
  type ModelClient,
} from "../../dist/index.js";
import { validateGroundedSynthesis } from "../../dist/skill-contracts/research.js";
import { ContentFixtureOwner, nonbindingContext } from "./universal-content-fixtures.js";
import { requireArrayItem, requireValue, parseJson } from "./narrowing.js";
import type { ContentProducer } from "./universal-content-oracle.js";

export type DecideWording = "direct" | "paraphrase";
export type DecideScenario = "relevant" | "irrelevant";
export type DecideMutation =
  | "ignored"
  | "omitted"
  | "changed"
  | "coerced"
  | "permission"
  | "evidence"
  | "native-authority"
  | "external-verification"
  | "sensitivity"
  | "selection";
export interface DecideScript {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly wording: DecideWording;
  readonly scenario?: DecideScenario;
  readonly mutation?: DecideMutation;
}

/** Independently complete caller request: alternatives describe reporting, never producer answers. */
export function contextDecisionRequest(irrelevant = false): DecisionRequestV1 {
  return validateDecisionRequest({
    schema_version: 1,
    decision_question: irrelevant
      ? "Which supplied reporting approach best presents the caller's greeting?"
      : "Which supplied reporting approach best communicates the contextual product faithfully?",
    alternatives: [
      {
        alternative_id: "report_compact",
        label: "Compact status-led note",
        description: "Lead with the attributable result while retaining important qualifications.",
      },
      {
        alternative_id: "report_contrast",
        label: "Contrast-led note",
        description: "Lead with distinctions between competing positions and retain their limits.",
      },
      {
        alternative_id: "report_caveat",
        label: "Caveat-led note",
        description: "Lead with a material blocker or scope qualification before the result.",
      },
    ],
    hard_constraints: [
      {
        constraint_id: "constraint_nonbinding",
        statement:
          "Context remains nonbinding: do not turn it into native alternatives, evidence, approval, permission, or independent verification.",
      },
      {
        constraint_id: "constraint_no_action",
        statement:
          "Decide a reporting approach only; do not execute, publish, or implement any selection.",
      },
    ],
    objectives: [
      {
        objective_id: "objective_fidelity",
        statement:
          "Compare all supplied approaches using relevant distinctions and qualifications, not merely source identity.",
      },
    ],
    preferences: [
      {
        preference_id: "preference_lead",
        statement: irrelevant
          ? "Prefer compact presentation for the caller's short greeting; unrelated strategy context must not affect this choice."
          : "Prefer contrast for competing positions, caveat-led for blockers or scope-qualified findings, otherwise compact; all approaches must remain faithful.",
      },
    ],
    uncertainties: [
      {
        uncertainty_id: "uncertainty_scope",
        statement:
          "A changed relevant result or qualification could change the best reporting approach; unrelated context must not.",
      },
    ],
    evidence: irrelevant
      ? [
          {
            evidence_id: "caller_greeting",
            statement: "The caller requests a short greeting: Hello, visitor.",
          },
        ]
      : [],
  });
}

interface Meaning {
  readonly selected: string;
  readonly comparison: string;
  readonly rationale: string;
  readonly sensitivity: string;
}

// Native readers intentionally implement transformations, not the independently authored literal oracle.
function readMeaning(producer: ContentProducer, value: unknown, wording: DecideWording): Meaning {
  const direct = wording === "direct";
  switch (producer) {
    case "assess": {
      const source = validateAssessmentV2(value);
      const verdict = (index: number) =>
        requireValue(
          source.criterion_outcomes.find((row) => row.criterion_index === index),
          "criterion"
        ).verdict;
      const time = verdict(0);
      const courtesy = verdict(1);
      return {
        selected: "report_compact",
        comparison: direct
          ? `Compact beats contrast here: maintenance time is ${time} and courtesy is ${courtesy}; caveat-led would imply a blocker absent from the ${source.disposition} assessment.`
          : `Against contrast and caveat-led, compact fits the ${source.disposition} result: time criterion ${time}, courtesy criterion ${courtesy}, with no reported blocker.`,
        rationale: direct
          ? `Choose report_compact to communicate ${source.disposition} without obscuring the separate required time and advisory courtesy verdicts; supplied-note assessment is not schedule verification.`
          : `report_compact preserves both criterion verdicts (${time}, ${courtesy}) and the ${source.disposition} outcome without treating the supplied note as an externally checked schedule.`,
        sensitivity: direct
          ? `If time or courtesy ceased to be ${time}/${courtesy}, reconsider report_caveat; the current ${source.disposition} result concerns supplied material, not verified scheduling.`
          : `A departure from time ${time} or courtesy ${courtesy} could favor report_caveat over report_compact; ${source.disposition} does not independently verify the schedule.`,
      };
    }
    case "decide": {
      const source = validateDecision(value);
      const label = (id: string) =>
        requireValue(
          source.request.alternatives.find((row) => row.alternative_id === id),
          "source alternative"
        ).label;
      const chosen = source.recommendation.alternative_ids.map(label).join(", ");
      const excluded = source.feasibility
        .filter((row) => row.status === "infeasible")
        .map((row) => label(row.alternative_id))
        .join(", ");
      const change = requireArrayItem(
        source.sensitivity,
        0,
        "source sensitivity"
      ).resulting_decision_change;
      return {
        selected: "report_contrast",
        comparison: direct
          ? `Contrast beats compact: ${chosen} is the source selection, not a ranking, and ${excluded} is infeasible; caveat-led alone would obscure the A/B quote trade-off.`
          : `Prefer contrast to compact or caveat-led because the source selects ${chosen}, excludes infeasible ${excluded}, and retains a quote-dependent comparison rather than a ranking.`,
        rationale: direct
          ? `Choose report_contrast: the source's ${source.outcome} outcome is conditional on B's final quote (${change}); reporting this is not adopting or executing its option choice.`
          : `report_contrast makes ${chosen} versus excluded ${excluded} intelligible while retaining B's quote sensitivity (${change}); the source choice is not this task's native alternative or action.`,
        sensitivity: direct
          ? `A changed B quote could change the reported choice from ${chosen}: ${change} Keep ${excluded}'s current infeasibility distinct; reassess report_compact only if the comparison ceases to matter.`
          : `Retain the possibility '${change}' alongside the current ${chosen} selection and ${excluded} exclusion; without that quote-sensitive contrast, report_compact might suffice.`,
      };
    }
    case "define": {
      const source = validateSpecification(value);
      const requirement = requireValue(
        source.requirements.find((row) => row.category === "outcome"),
        "outcome requirement"
      ).statement;
      const constraint = requireArrayItem(source.constraints, 0, "source constraint").statement;
      return {
        selected: "report_compact",
        comparison: direct
          ? `Compact beats contrast for this ${source.disposition} specification: ${requirement} Caveat-led need not imply a blocker, but must not lose '${constraint}' or planning_started=${source.planning_started}.`
          : `A ${source.disposition} specification defining '${requirement}' favors compact over an invented contrast; caveat-led must not misstate '${constraint}' or planning_started=${source.planning_started}.`,
        rationale: direct
          ? `Choose report_compact with the target-outcome requirement and protected no-execution constraint intact; execution_started=${source.execution_started} means readiness is not execution permission.`
          : `report_compact can state readiness and the target outcome without dilution: '${constraint}' remains protected and execution_started=${source.execution_started}, not permission to implement.`,
        sensitivity: direct
          ? `If the ${source.disposition} specification no longer covered the target outcome, prefer report_caveat; currently planning_started=${source.planning_started} and execution_started=${source.execution_started}, and '${constraint}' still binds the source.`
          : `Reconsider report_caveat if target-outcome coverage or ${source.disposition} status changes; planning_started=${source.planning_started}, execution_started=${source.execution_started}, and '${constraint}' are present limits, not action authority.`,
      };
    }
    case "diagnose": {
      const source = validateDiagnosis(value);
      const origin = requireValue(
        source.hypotheses.find((row) => row.hypothesis_id === "hyp_origin"),
        "origin hypothesis"
      ).status;
      return {
        selected: "report_contrast",
        comparison: direct
          ? `Contrast beats compact: ${source.reasoning} Primary ${source.primary_supported_hypothesis_id} is ${source.disposition}, while origin is ${origin}; caveat-led alone would hide that distinction.`
          : `Prefer contrast over compact or a caveat-only lead: ${source.primary_supported_hypothesis_id} is primary in a ${source.disposition} diagnosis, origin is ${origin}, and '${source.reasoning}' explains the distinction.`,
        rationale: direct
          ? `Choose report_contrast to separate cache support from origin exclusion; tests_executed=${source.tests_executed} and remediation_started=${source.remediation_started}, so this is supplied-observation reasoning, not an executed experiment or fix.`
          : `report_contrast preserves cache versus origin without overstating proof: tests_executed=${source.tests_executed}, remediation_started=${source.remediation_started}; the causal support comes from supplied observations.`,
        sensitivity: direct
          ? `If origin ceased to be ${origin} or ${source.primary_supported_hypothesis_id} lost support, reconsider report_caveat; current tests_executed=${source.tests_executed} and remediation_started=${source.remediation_started} cannot certify an experiment or repair.`
          : `Reassess report_caveat if the ${source.primary_supported_hypothesis_id}/${origin} distinction changes; no experiment or repair is established by tests_executed=${source.tests_executed}, remediation_started=${source.remediation_started}.`,
      };
    }
    case "plan": {
      const source = validateStrategyV2(value);
      const outcomes = source.outcomes
        .map((row) => row.statement)
        .sort()
        .join(" ");
      const blockers = source.blockers.length === 0 ? "none" : source.blockers.join(" ");
      const blocked = source.disposition === "blocked";
      const selected = blocked ? "report_caveat" : "report_compact";
      return {
        selected,
        comparison: direct
          ? `${blocked ? "Caveat-led beats compact" : "Compact beats caveat-led"}: disposition=${source.disposition}; planned outcomes: ${outcomes} Blockers: ${blockers.replace(/\.$/u, "")}. Contrast adds no competing strategy.`
          : `${blocked ? "Prefer caveat-led over compact" : "Prefer compact over caveat-led"} for disposition=${source.disposition}, outcomes '${outcomes}', blockers '${blockers}'; contrast would invent a strategy contest.`,
        rationale: direct
          ? `Choose ${selected} because ${blocked ? "the rollback-access blocker must lead, not be reported as readiness" : "readiness and rollback are planned outcomes with no reported blocker"}; execution_started=${source.execution_started}, not evidence of completed transition or permission.`
          : `${selected} gives ${blocked ? "the unavailable rollback access priority over a misleading ready lead" : "planned readiness and rollback proportionate prominence"}; execution_started=${source.execution_started} does not establish implementation or approval.`,
        sensitivity: direct
          ? `${blocked ? "If rollback access became available, reassess report_compact" : "If rollback access became unavailable, switch to report_caveat"}; current disposition=${source.disposition}, blockers=${blockers}, execution_started=${source.execution_started}.`
          : `${blocked ? "Resolving rollback access could favor report_compact" : "Losing rollback access would favor report_caveat"}; preserve the current ${source.disposition} status and '${blockers}' blocker record without converting execution_started=${source.execution_started} into action authority.`,
      };
    }
    case "produce": {
      const source = validateProducedArtifactV2(value);
      const greeting = requireValue(source.content.match(/Hello, world\./u)?.[0], "greeting bytes");
      const supplied = source.content.includes("*Supplied by the caller.*");
      return {
        selected: "report_compact",
        comparison: direct
          ? `Compact beats contrast for '${greeting}' in ${source.artifact_kind} (${source.media_type}); caveat-led would overstate a dispute, but caller attribution=${supplied} must remain.`
          : `Prefer compact over contrast or caveat-led for the ${source.artifact_kind} greeting '${greeting}', media type ${source.media_type}, with caller attribution=${supplied}.`,
        rationale: direct
          ? `Choose report_compact: '${greeting}' is supplied by the caller, not independently verified; retain the ${source.artifact_kind} format and attribution rather than inventing corroboration.`
          : `report_compact preserves the greeting and its supplied status in ${source.artifact_kind}; '${greeting}' is caller material, not externally certified content.`,
        sensitivity: direct
          ? `If '${greeting}' lost its caller attribution or ${source.artifact_kind} format, reconsider report_caveat; current media type ${source.media_type} and supplied status do not prove external truth.`
          : `A change to the caller-attributed '${greeting}' or ${source.artifact_kind}/${source.media_type} presentation could favor report_caveat; supplied wording remains unverified.`,
      };
    }
    case "research": {
      const source = validateGroundedSynthesis(value);
      const claim = requireArrayItem(source.claims, 0, "claim");
      const qualification = claim.qualifications.join(" ");
      return {
        selected: "report_caveat",
        comparison: direct
          ? `Caveat-led beats compact: '${claim.statement}' is ${claim.support_status} at source confidence ${claim.confidence}. '${qualification}' Contrast must not invent competing retention evidence.`
          : `Prefer caveat-led to compact or an invented contrast: the source's '${claim.statement}' has ${claim.support_status} support, confidence ${claim.confidence}, and qualification '${qualification}'.`,
        rationale: direct
          ? `Choose report_caveat so '${qualification}' stays attached to '${claim.statement}'; ${claim.support_status} support at ${claim.confidence} is not independent verification.`
          : `report_caveat leads with bounded scope rather than overstating '${claim.statement}': ${claim.support_status}, confidence ${claim.confidence}, '${qualification}', and no external verification.`,
        sensitivity: direct
          ? `If newly admitted material removed '${qualification}', reconsider report_compact; currently '${claim.statement}' remains ${claim.support_status} at ${claim.confidence}, not an externally verified retention guarantee.`
          : `Reassess report_compact only if the scope qualification changes: '${claim.statement}', ${claim.support_status} support and ${claim.confidence} confidence retain '${qualification}' rather than certifying retention.`,
      };
    }
  }
}

function irrelevantMeaning(wording: DecideWording): Meaning {
  return wording === "direct"
    ? {
        selected: "report_compact",
        comparison:
          "Compact beats contrast and caveat-led for the caller's short 'Hello, visitor.' greeting; a transition strategy supplies no relevant greeting distinction.",
        rationale:
          "Choose report_compact from caller_greeting and preference_lead only; the strategy's outcomes and readiness must not influence greeting presentation.",
        sensitivity:
          "A changed caller greeting or presentation preference could favor report_contrast; a changed strategy alone cannot change report_compact.",
      }
    : {
        selected: "report_compact",
        comparison:
          "For the caller's 'Hello, visitor.' greeting, prefer compact to contrast or caveat-led; transition context is unrelated to this presentation decision.",
        rationale:
          "report_compact follows caller_greeting plus preference_lead, not strategy readiness or outcomes; reading context does not make it relevant.",
        sensitivity:
          "Reconsider report_contrast if caller greeting requirements change, not when unrelated strategy context changes; report_compact is caller-derived.",
      };
}

function mutateMeaning(meaning: Meaning, script: DecideScript): Meaning {
  switch (script.mutation) {
    case "ignored":
      return {
        ...meaning,
        comparison: "All approaches can report context.",
        rationale: "Choose the default approach; context received.",
        sensitivity: "Changed input could change the approach.",
      };
    case "omitted": {
      // Retain one true fact, but omit the other distinguishing facts and qualifications everywhere.
      const oneFact: Record<ContentProducer, string> = {
        assess: "The overall assessment is meets.",
        decide: "The source selects Option A.",
        define: "The specification is ready.",
        diagnose: "The diagnosis supports cache staleness.",
        plan: "The strategy covers transition readiness.",
        produce: "The greeting is Hello, world.",
        research: "Synthetic cache retention is 7 days.",
      };
      return {
        ...meaning,
        comparison: `Compact, contrast and caveat-led differ in emphasis. ${oneFact[script.producer]}`,
        rationale: `Choose the reporting approach on this fact alone: ${oneFact[script.producer]}`,
        sensitivity: "Changed input could change the approach.",
      };
    }
    case "changed": {
      // Native-valid semantic lie, made before the real seal/reviews, not a post-seal forged object.
      const changes: Record<ContentProducer, readonly [string, string]> = {
        assess: ["courtesy", "hostility"],
        decide: ["Option A", "Option B"],
        define: ["target outcome", "implementation deadline"],
        diagnose: ["hyp_cache", "hyp_origin"],
        plan: ["Rollback", "Deployment"],
        produce: ["Hello, world.", "Goodbye, world."],
        research: ["days", "months"],
      };
      const [before, after] = changes[script.producer];
      return {
        ...meaning,
        comparison: meaning.comparison.replaceAll(before, after),
        rationale: meaning.rationale.replaceAll(before, after),
        sensitivity: meaning.sensitivity.replaceAll(before, after),
      };
    }
    case "coerced":
      return {
        ...meaning,
        comparison:
          "Compact is enough because the source is unconditionally supported and ready; all qualifications and blockers are resolved.",
        rationale:
          "The contextual result is an unqualified guarantee, so report_compact needs no limitations.",
        sensitivity: "No source limitation could change this unconditional result.",
      };
    case "sensitivity":
      return {
        ...meaning,
        sensitivity: "A different caller preference might change the presentation.",
      };
    case "selection":
      return {
        ...meaning,
        selected: meaning.selected === "report_compact" ? "report_contrast" : "report_compact",
      };
    default:
      return meaning;
  }
}

function limits(mutation: DecideMutation | undefined): string {
  switch (mutation) {
    case "permission":
      return "Limits: Context approves and authorizes execution of the source selection without further permission.";
    case "evidence":
      return "Limits: Context is native decision evidence and host evidence admission.";
    case "native-authority":
      return "Limits: Context supplies this task's native alternatives and overrides caller requirements.";
    case "external-verification":
      return "Limits: The source has been independently externally verified by this task.";
    default:
      return "Limits: Context is nonbinding; it supplies no native alternatives, native evidence, approval, execution permission, or independent verification.";
  }
}

function decisionDraft(
  request: DecisionRequestV1,
  script: DecideScript,
  sourceValue: unknown
): DecisionDraftV2 {
  const meaning = mutateMeaning(
    script.scenario === "irrelevant"
      ? irrelevantMeaning(script.wording)
      : readMeaning(script.producer, sourceValue, script.wording),
    script
  );
  return validateDecisionDraft(
    {
      schema_version: 2,
      outcome: "selected",
      applicability_reason:
        "The caller supplied reporting alternatives; this assessment selects a report format, not a source action.",
      feasibility: request.alternatives.map((row) => ({
        alternative_id: row.alternative_id,
        status: "feasible",
      })),
      recommendation: { kind: "selection", alternative_ids: [meaning.selected] },
      comparison_dimension_ids: ["objective_fidelity", "preference_lead"],
      basis_ids_used: [
        "constraint_nonbinding",
        "constraint_no_action",
        "objective_fidelity",
        "preference_lead",
        "uncertainty_scope",
        ...(script.scenario === "irrelevant" ? ["caller_greeting"] : []),
      ],
      sensitivity: [
        {
          basis_ids: ["uncertainty_scope", "preference_lead"],
          resulting_decision_change: meaning.sensitivity,
        },
      ],
      has_blocking_unresolved: false,
      confidence: "PROBABLE",
      rationale_report: [
        `Context: ${script.source.artifact_id} (${script.source.content_digest}); designation=context, nonbinding.`,
        `Comparison: ${meaning.comparison}`,
        `Rationale: ${meaning.rationale}`,
        limits(script.mutation),
      ].join("\n"),
    },
    { request, exactInputArtifactIds: [] }
  );
}

export interface DecideRead {
  readonly state: string;
  readonly ref: ArtifactRef;
  readonly bytes: number;
  readonly digest: string;
}
class DecideFixtureClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly reads: DecideRead[] = [];
  constructor(
    private readonly host: ContentFixtureOwner,
    private readonly request: DecisionRequestV1,
    private readonly script: DecideScript
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const inputs = invocation.inputArtifacts.map((ref) => {
      const bytes = this.host.artifacts.read(ref);
      this.reads.push({
        state: invocation.stateId,
        ref,
        bytes: bytes.byteLength,
        digest: sha256(bytes),
      });
      return { ref, bytes };
    });
    const source = requireValue(
      inputs.find(
        ({ ref }) =>
          ref.artifact_id === this.script.source.artifact_id &&
          canonicalJson(ref) === canonicalJson(this.script.source)
      ),
      "exact context in actual invocation"
    );
    if (invocation.stateId === "deciding") {
      const requestInput = requireValue(
        inputs.find(({ ref }) => ref.kind === "decision-request"),
        "native request in invocation"
      );
      const actualRequest = validateDecisionRequest(parseJson(requestInput.bytes.toString("utf8")));
      if (canonicalJson(actualRequest) !== canonicalJson(this.request))
        throw new Error("native request changed");
      const draft = decisionDraft(
        actualRequest,
        this.script,
        parseJson(source.bytes.toString("utf8"))
      );
      const { rationale_report: report, ...core } = draft;
      return {
        text: `${report}\nDECISION_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      };
    }
    if (invocation.stateId === "analyzing_decision") {
      return {
        text: `Analysis maps the supplied reporting approaches, constraints, preferences and contextual relevance without selecting or acquiring evidence.\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", analysis_complete: true, gap_kind: "none", repair_owner: "none", findings: [], strategy_delta: "Author the reporting assessment only." })}`,
      };
    }
    if (invocation.stateId !== "verifying_decision" && invocation.stateId !== "critiquing_decision")
      throw new Error(`Unexpected DECIDE cognition ${invocation.stateId}`);
    // Deliberately PASS/APPROVE even semantic mutants: native receipts are not content-oracle proof.
    return {
      text: `Scripted review of the exact delivered current product.\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", verdict: invocation.stateId === "verifying_decision" ? "PASS" : "APPROVE", gap_kind: "none", repair_owner: "none", findings: [], evidence: ["Exact current refs were read; this scripted verdict does not certify meaning."], strategy_delta: "Proceed with this exact product." })}`,
    };
  }
}

export async function executeContextDecision(
  host: ContentFixtureOwner,
  runId: string,
  script: DecideScript
) {
  const request = contextDecisionRequest(script.scenario === "irrelevant");
  const { decision_question: goal, ...constraints } = request;
  const fixture = {
    goal,
    constraints: validateContract(
      Type.Record(Type.String(), JsonValueSchema),
      constraints,
      "native Decide constraints"
    ),
    outputs: [],
  };
  const engine = host.engine("decide");
  const client = new DecideFixtureClient(host, request, script);
  const workers = new WorkerExecutor(client, host.artifacts, {
    projectRoot: host.root,
    parallelConcurrency: 1,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(engine.liveness);
  const terminal = await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(host.start("decide", runId, nonbindingContext(script.source), fixture))
  );
  return { terminal, client, request };
}
