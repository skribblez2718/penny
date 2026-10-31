// TEST ONLY: closed, independently authored literal expectations, not an NLP judge or runtime filter.
// Do not import transformations, reader outputs, or fixture expected values into this oracle.
import {
  canonicalJson,
  validateDecision,
  type ArtifactRef,
  type DecisionV2,
} from "../../dist/index.js";
import { requireArrayItem } from "./narrowing.js";
import type { ContentProducer } from "./universal-content-oracle.js";

interface ExpectedMeaning {
  readonly selected: string;
  // Literal comparative report, choice rationale, and decision sensitivity; two accepted paraphrases.
  readonly variants: readonly (readonly [string, string, string])[];
}
const meanings: Readonly<
  Record<ContentProducer | "plan-blocked" | "research-fourteen" | "irrelevant", ExpectedMeaning>
> = {
  assess: {
    selected: "report_compact",
    variants: [
      [
        "Compact beats contrast here: maintenance time is met and courtesy is met; caveat-led would imply a blocker absent from the meets assessment.",
        "Choose report_compact to communicate meets without obscuring the separate required time and advisory courtesy verdicts; supplied-note assessment is not schedule verification.",
        "If time or courtesy ceased to be met/met, reconsider report_caveat; the current meets result concerns supplied material, not verified scheduling.",
      ],
      [
        "Against contrast and caveat-led, compact fits the meets result: time criterion met, courtesy criterion met, with no reported blocker.",
        "report_compact preserves both criterion verdicts (met, met) and the meets outcome without treating the supplied note as an externally checked schedule.",
        "A departure from time met or courtesy met could favor report_caveat over report_compact; meets does not independently verify the schedule.",
      ],
    ],
  },
  decide: {
    selected: "report_contrast",
    variants: [
      [
        "Contrast beats compact: Option A is the source selection, not a ranking, and Option C is infeasible; caveat-led alone would obscure the A/B quote trade-off.",
        "Choose report_contrast: the source's selected outcome is conditional on B's final quote (Select alt_b instead of alt_a.); reporting this is not adopting or executing its option choice.",
        "A changed B quote could change the reported choice from Option A: Select alt_b instead of alt_a. Keep Option C's current infeasibility distinct; reassess report_compact only if the comparison ceases to matter.",
      ],
      [
        "Prefer contrast to compact or caveat-led because the source selects Option A, excludes infeasible Option C, and retains a quote-dependent comparison rather than a ranking.",
        "report_contrast makes Option A versus excluded Option C intelligible while retaining B's quote sensitivity (Select alt_b instead of alt_a.); the source choice is not this task's native alternative or action.",
        "Retain the possibility 'Select alt_b instead of alt_a.' alongside the current Option A selection and Option C exclusion; without that quote-sensitive contrast, report_compact might suffice.",
      ],
    ],
  },
  define: {
    selected: "report_compact",
    variants: [
      [
        "Compact beats contrast for this ready specification: The transition specification must define the target outcome. Caveat-led need not imply a blocker, but must not lose 'Do not execute the transition.' or planning_started=false.",
        "Choose report_compact with the target-outcome requirement and protected no-execution constraint intact; execution_started=false means readiness is not execution permission.",
        "If the ready specification no longer covered the target outcome, prefer report_caveat; currently planning_started=false and execution_started=false, and 'Do not execute the transition.' still binds the source.",
      ],
      [
        "A ready specification defining 'The transition specification must define the target outcome.' favors compact over an invented contrast; caveat-led must not misstate 'Do not execute the transition.' or planning_started=false.",
        "report_compact can state readiness and the target outcome without dilution: 'Do not execute the transition.' remains protected and execution_started=false, not permission to implement.",
        "Reconsider report_caveat if target-outcome coverage or ready status changes; planning_started=false, execution_started=false, and 'Do not execute the transition.' are present limits, not action authority.",
      ],
    ],
  },
  diagnose: {
    selected: "report_contrast",
    variants: [
      [
        "Contrast beats compact: The supplied evidence supports cache staleness. Primary hyp_cache is supported, while origin is ruled_out; caveat-led alone would hide that distinction.",
        "Choose report_contrast to separate cache support from origin exclusion; tests_executed=false and remediation_started=false, so this is supplied-observation reasoning, not an executed experiment or fix.",
        "If origin ceased to be ruled_out or hyp_cache lost support, reconsider report_caveat; current tests_executed=false and remediation_started=false cannot certify an experiment or repair.",
      ],
      [
        "Prefer contrast over compact or a caveat-only lead: hyp_cache is primary in a supported diagnosis, origin is ruled_out, and 'The supplied evidence supports cache staleness.' explains the distinction.",
        "report_contrast preserves cache versus origin without overstating proof: tests_executed=false, remediation_started=false; the causal support comes from supplied observations.",
        "Reassess report_caveat if the hyp_cache/ruled_out distinction changes; no experiment or repair is established by tests_executed=false, remediation_started=false.",
      ],
    ],
  },
  plan: {
    selected: "report_compact",
    variants: [
      [
        "Compact beats caveat-led: disposition=ready; planned outcomes: Rollback viability is retained. Transition readiness is established. Blockers: none. Contrast adds no competing strategy.",
        "Choose report_compact because readiness and rollback are planned outcomes with no reported blocker; execution_started=false, not evidence of completed transition or permission.",
        "If rollback access became unavailable, switch to report_caveat; current disposition=ready, blockers=none, execution_started=false.",
      ],
      [
        "Prefer compact over caveat-led for disposition=ready, outcomes 'Rollback viability is retained. Transition readiness is established.', blockers 'none'; contrast would invent a strategy contest.",
        "report_compact gives planned readiness and rollback proportionate prominence; execution_started=false does not establish implementation or approval.",
        "Losing rollback access would favor report_caveat; preserve the current ready status and 'none' blocker record without converting execution_started=false into action authority.",
      ],
    ],
  },
  produce: {
    selected: "report_compact",
    variants: [
      [
        "Compact beats contrast for 'Hello, world.' in markdown (text/markdown; charset=utf-8); caveat-led would overstate a dispute, but caller attribution=true must remain.",
        "Choose report_compact: 'Hello, world.' is supplied by the caller, not independently verified; retain the markdown format and attribution rather than inventing corroboration.",
        "If 'Hello, world.' lost its caller attribution or markdown format, reconsider report_caveat; current media type text/markdown; charset=utf-8 and supplied status do not prove external truth.",
      ],
      [
        "Prefer compact over contrast or caveat-led for the markdown greeting 'Hello, world.', media type text/markdown; charset=utf-8, with caller attribution=true.",
        "report_compact preserves the greeting and its supplied status in markdown; 'Hello, world.' is caller material, not externally certified content.",
        "A change to the caller-attributed 'Hello, world.' or markdown/text/markdown; charset=utf-8 presentation could favor report_caveat; supplied wording remains unverified.",
      ],
    ],
  },
  research: {
    selected: "report_caveat",
    variants: [
      [
        "Caveat-led beats compact: 'Synthetic cache retention is 7 days.' is qualified at source confidence 0.8. 'The fixture scope remains deliberately bounded.' Contrast must not invent competing retention evidence.",
        "Choose report_caveat so 'The fixture scope remains deliberately bounded.' stays attached to 'Synthetic cache retention is 7 days.'; qualified support at 0.8 is not independent verification.",
        "If newly admitted material removed 'The fixture scope remains deliberately bounded.', reconsider report_compact; currently 'Synthetic cache retention is 7 days.' remains qualified at 0.8, not an externally verified retention guarantee.",
      ],
      [
        "Prefer caveat-led to compact or an invented contrast: the source's 'Synthetic cache retention is 7 days.' has qualified support, confidence 0.8, and qualification 'The fixture scope remains deliberately bounded.'.",
        "report_caveat leads with bounded scope rather than overstating 'Synthetic cache retention is 7 days.': qualified, confidence 0.8, 'The fixture scope remains deliberately bounded.', and no external verification.",
        "Reassess report_compact only if the scope qualification changes: 'Synthetic cache retention is 7 days.', qualified support and 0.8 confidence retain 'The fixture scope remains deliberately bounded.' rather than certifying retention.",
      ],
    ],
  },
  "plan-blocked": {
    selected: "report_caveat",
    variants: [
      [
        "Caveat-led beats compact: disposition=blocked; planned outcomes: Transition readiness is established. Blockers: Rollback access is unavailable. Contrast adds no competing strategy.",
        "Choose report_caveat because the rollback-access blocker must lead, not be reported as readiness; execution_started=false, not evidence of completed transition or permission.",
        "If rollback access became available, reassess report_compact; current disposition=blocked, blockers=Rollback access is unavailable., execution_started=false.",
      ],
      [
        "Prefer caveat-led over compact for disposition=blocked, outcomes 'Transition readiness is established.', blockers 'Rollback access is unavailable.'; contrast would invent a strategy contest.",
        "report_caveat gives the unavailable rollback access priority over a misleading ready lead; execution_started=false does not establish implementation or approval.",
        "Resolving rollback access could favor report_compact; preserve the current blocked status and 'Rollback access is unavailable.' blocker record without converting execution_started=false into action authority.",
      ],
    ],
  },
  "research-fourteen": {
    selected: "report_caveat",
    variants: [
      [
        "Caveat-led beats compact: 'Synthetic cache retention is 14 days.' is qualified at source confidence 0.8. 'The fixture scope remains deliberately bounded.' Contrast must not invent competing retention evidence.",
        "Choose report_caveat so 'The fixture scope remains deliberately bounded.' stays attached to 'Synthetic cache retention is 14 days.'; qualified support at 0.8 is not independent verification.",
        "If newly admitted material removed 'The fixture scope remains deliberately bounded.', reconsider report_compact; currently 'Synthetic cache retention is 14 days.' remains qualified at 0.8, not an externally verified retention guarantee.",
      ],
      [
        "Prefer caveat-led to compact or an invented contrast: the source's 'Synthetic cache retention is 14 days.' has qualified support, confidence 0.8, and qualification 'The fixture scope remains deliberately bounded.'.",
        "report_caveat leads with bounded scope rather than overstating 'Synthetic cache retention is 14 days.': qualified, confidence 0.8, 'The fixture scope remains deliberately bounded.', and no external verification.",
        "Reassess report_compact only if the scope qualification changes: 'Synthetic cache retention is 14 days.', qualified support and 0.8 confidence retain 'The fixture scope remains deliberately bounded.' rather than certifying retention.",
      ],
    ],
  },
  irrelevant: {
    selected: "report_compact",
    variants: [
      [
        "Compact beats contrast and caveat-led for the caller's short 'Hello, visitor.' greeting; a transition strategy supplies no relevant greeting distinction.",
        "Choose report_compact from caller_greeting and preference_lead only; the strategy's outcomes and readiness must not influence greeting presentation.",
        "A changed caller greeting or presentation preference could favor report_contrast; a changed strategy alone cannot change report_compact.",
      ],
      [
        "For the caller's 'Hello, visitor.' greeting, prefer compact to contrast or caveat-led; transition context is unrelated to this presentation decision.",
        "report_compact follows caller_greeting plus preference_lead, not strategy readiness or outcomes; reading context does not make it relevant.",
        "Reconsider report_contrast if caller greeting requirements change, not when unrelated strategy context changes; report_compact is caller-derived.",
      ],
    ],
  },
};

export interface DecideExpectation {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly scenario?: "base" | "counterfactual" | "irrelevant";
}

// An independently written complete native request expectation. No distinguishing producer answers.
function expectedRequest(irrelevant: boolean) {
  return {
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
  };
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`DECIDE_CONTENT: ${label}`);
}

/** Native validity is checked first; semantic comparisons are independent of scripted PASS reviews. */
export function assertContextDecision(value: unknown, expected: DecideExpectation): DecisionV2 {
  const product = validateDecision(value);
  const irrelevant = expected.scenario === "irrelevant";
  const meaning = irrelevant
    ? meanings.irrelevant
    : expected.scenario === "counterfactual" && expected.producer === "plan"
      ? meanings["plan-blocked"]
      : expected.scenario === "counterfactual" && expected.producer === "research"
        ? meanings["research-fourteen"]
        : meanings[expected.producer];
  equal(
    product.request,
    expectedRequest(irrelevant),
    "native request or protected caller fields changed"
  );
  equal(product.execution_started, false, "execution flag");
  equal(
    product.source_lineage.input_artifact_ids,
    [],
    "context promoted into native semantic inputs"
  );
  equal(product.outcome, "selected", "reporting outcome");
  equal(product.confidence, "PROBABLE", "confidence strengthened");
  equal(product.has_blocking_unresolved, false, "invented blocking issue");
  equal(product.blocking_questions ?? [], [], "invented blocking questions");
  equal(
    product.applicability_reason,
    "The caller supplied reporting alternatives; this assessment selects a report format, not a source action.",
    "native applicability"
  );
  equal(
    product.feasibility,
    [
      { alternative_id: "report_compact", status: "feasible" },
      { alternative_id: "report_contrast", status: "feasible" },
      { alternative_id: "report_caveat", status: "feasible" },
    ],
    "complete feasibility coverage"
  );
  equal(
    product.recommendation,
    { kind: "selection", alternative_ids: [meaning.selected] },
    "selection must follow the comparative source-sensitive rationale"
  );
  equal(
    product.comparison_dimension_ids,
    ["objective_fidelity", "preference_lead"],
    "native comparison dimensions"
  );
  equal(
    product.basis_ids_used,
    [
      "constraint_nonbinding",
      "constraint_no_action",
      "objective_fidelity",
      "preference_lead",
      "uncertainty_scope",
      ...(irrelevant ? ["caller_greeting"] : []),
    ],
    "source promoted to native alternatives/evidence/basis"
  );
  const lines = product.rationale_report.split("\n");
  equal(lines.length, 4, "comparative report shape");
  equal(
    lines[0],
    `Context: ${expected.source.artifact_id} (${expected.source.content_digest}); designation=context, nonbinding.`,
    "exact provenance or nonbinding designation"
  );
  equal(
    lines[3],
    "Limits: Context is nonbinding; it supplies no native alternatives, native evidence, approval, execution permission, or independent verification.",
    "evidence/approval/permission/native-authority promotion"
  );
  if (product.sensitivity.length !== 1)
    throw new Error("DECIDE_CONTENT: missing substantive sensitivity");
  const sensitivity = requireArrayItem(product.sensitivity, 0, "sensitivity");
  equal(
    sensitivity.basis_ids,
    ["uncertainty_scope", "preference_lead"],
    "sensitivity native basis namespace"
  );
  const found = meaning.variants.some(
    ([comparison, rationale, change]) =>
      lines[1] === `Comparison: ${comparison}` &&
      lines[2] === `Rationale: ${rationale}` &&
      sensitivity.resulting_decision_change === change
  );
  if (!found)
    throw new Error(
      "DECIDE_CONTENT: comparative meaning, qualifications, or sensitivity ignored/omitted/changed/coerced"
    );
  return product;
}
