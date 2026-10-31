// TEST ONLY. Literal finite semantic oracle; not a model judge or runtime filter.
// This module is never imported at runtime by the source-field cognition transform.
import { validateStrategyV2, type ArtifactRef, type StrategyV2 } from "../../dist/index.js";
import type { ContentProducer } from "./universal-content-oracle.js";
import type { PlanScenario } from "./universal-content-plan-fixtures.js";

interface Meaning {
  readonly direct: readonly string[];
  readonly paraphrase: readonly string[];
}
const meanings: Readonly<Record<ContentProducer, Meaning>> = {
  assess: {
    direct: [
      "assessment meets concerns the supplied release note",
      "maintenance-time criterion=met; courtesy criterion=met",
      "supplied-note verdicts only; Do not externally verify the schedule.",
    ],
    paraphrase: [
      "the supplied note has overall disposition meets",
      "courtesy=met and maintenance-time clarity=met",
      "no schedule verification follows from note assessment; Do not externally verify the schedule.",
    ],
  },
  decide: {
    direct: [
      "selected selection recommends Option A",
      "Option C is infeasible; quote sensitivity: Select alt_b instead of alt_a.",
      "source uncertainty: Option B's final quote may fall.; communicating the recommendation neither decides anew nor authorizes implementation",
    ],
    paraphrase: [
      "Option A is the source's selection (selected)",
      "exclude infeasible Option C; sensitivity says Select alt_b instead of alt_a.",
      "Option B's final quote may fall. remains a sensitivity; describing the recommendation is not a new decision or implementation permission",
    ],
  },
  define: {
    direct: [
      "ready specification requires The transition specification must define the target outcome.",
      "source prohibition: Do not execute the transition.",
      "source planning_started=false, taskification_started=false, execution_started=false; communication planning does not adopt it as a native specification",
    ],
    paraphrase: [
      "source specification is ready: The transition specification must define the target outcome.",
      "preserve this source boundary: Do not execute the transition.",
      "execution_started=false, taskification_started=false, planning_started=false in the source; describing it supplies no binding Plan input",
    ],
  },
  diagnose: {
    direct: [
      "supported diagnosis: The supplied evidence supports cache staleness.",
      "primary=hyp_cache; origin=ruled_out",
      "tests_executed=false; remediation_started=false; supplied observations are not newly executed tests",
    ],
    paraphrase: [
      "source diagnosis is supported because The supplied evidence supports cache staleness.",
      "origin is ruled_out, unlike primary supported hyp_cache",
      "remediation_started=false and tests_executed=false; no fresh test evidence is established",
    ],
  },
  plan: {
    direct: [
      "ready strategy targets Rollback viability is retained. | Transition readiness is established.",
      "source blockers: none",
      "execution_started=false; target outcomes are not achievements or execution permission",
    ],
    paraphrase: [
      "source strategy is ready, describing Rollback viability is retained. | Transition readiness is established.",
      "reported strategy blockers are none",
      "no achieved work or execution approval follows; source execution_started=false",
    ],
  },
  produce: {
    direct: [
      "markdown artifact uses text/markdown; charset=utf-8",
      'exact greeting content: "# Greeting\\n\\nHello, world.\\n\\n*Supplied by the caller.*"',
      "greeting source label=caller statement; source constraint: Do not claim the statement was independently verified.; content is not execution or publication permission",
    ],
    paraphrase: [
      "source media type text/markdown; charset=utf-8 belongs to a markdown artifact",
      'preserve verbatim greeting: "# Greeting\\n\\nHello, world.\\n\\n*Supplied by the caller.*"',
      "attribute to caller statement; retain Do not claim the statement was independently verified.; describing content confers no action permission",
    ],
  },
  research: {
    direct: [
      "retention claim: Synthetic cache retention is 7 days.",
      "support=qualified; confidence=0.8",
      "scope qualification: The fixture scope remains deliberately bounded.; synthetic source, not independently verified external fact",
    ],
    paraphrase: [
      "synthetic synthesis states Synthetic cache retention is 7 days.",
      "confidence 0.8 accompanies qualified support",
      "retain bounded scope: The fixture scope remains deliberately bounded.; external verification is not established",
    ],
  },
};
const blockedPlan: Meaning = {
  direct: [
    "blocked strategy targets Transition readiness is established.",
    "source blockers: Rollback access is unavailable.",
    "execution_started=false; target outcomes are not achievements or execution permission",
  ],
  paraphrase: [
    "source strategy is blocked, describing Transition readiness is established.",
    "reported strategy blockers are Rollback access is unavailable.",
    "no achieved work or execution approval follows; source execution_started=false",
  ],
};
const fourteenDayResearch: Meaning = {
  direct: [
    "retention claim: Synthetic cache retention is 14 days.",
    "support=qualified; confidence=0.8",
    "scope qualification: The fixture scope remains deliberately bounded.; synthetic source, not independently verified external fact",
  ],
  paraphrase: [
    "synthetic synthesis states Synthetic cache retention is 14 days.",
    "confidence 0.8 accompanies qualified support",
    "retain bounded scope: The fixture scope remains deliberately bounded.; external verification is not established",
  ],
};
const irrelevantPlan: Meaning = {
  direct: [
    "the notice frames the caller greeting Welcome, reader.",
    "transition strategy is irrelevant to welcome-notice readiness",
    "caller attribution, not strategy provenance, governs the greeting",
  ],
  paraphrase: [
    "preserve the caller's Welcome, reader. greeting",
    "exclude unrelated transition strategy from notice readiness",
    "the caller supplies the greeting; the strategy does not",
  ],
};
export interface PlanExpectation {
  readonly producer: ContentProducer;
  readonly scenario: PlanScenario;
  readonly source: ArtifactRef;
}
function meaningFor(expected: PlanExpectation): Meaning {
  if (expected.scenario === "base") return meanings[expected.producer];
  if (expected.producer === "plan" && expected.scenario === "counterfactual") return blockedPlan;
  if (expected.producer === "research" && expected.scenario === "counterfactual")
    return fourteenDayResearch;
  if (expected.producer === "plan" && expected.scenario === "irrelevant") return irrelevantPlan;
  throw new Error("No independent Plan oracle for scenario");
}
function fail(detail: string): never {
  throw new Error(`PLAN_CONTENT_ORACLE: ${detail}`);
}

/** Check the current sealed native strategy's three operative readiness outcomes and linked
 * dependencies, not JSON tucked into a report. Two bounded wordings, not arbitrary paraphrases.
 */
export function assertPlanMeaning(value: unknown, expected: PlanExpectation): StrategyV2 {
  const product = validateStrategyV2(value);
  const meaning = meaningFor(expected);
  const labels = [
    "Result framing is communication-ready: ",
    "Distinction coverage is communication-ready: ",
    "Qualified circulation readiness is bounded by: ",
  ];
  const predicates = [
    "A future bulletin can faithfully frame ",
    "A future bulletin can distinguish ",
    "Any future circulation review must retain ",
  ];
  const selected = labels.map((label, index) => {
    const alternatives = [meaning.direct[index], meaning.paraphrase[index]];
    const outcome = product.outcomes.find((row) =>
      alternatives.some((clause) => row.statement === label + clause)
    );
    if (outcome === undefined)
      fail(
        "distinguishing meaning or qualification ignored, omitted, changed, coerced or promoted"
      );
    const validSignal = alternatives.some((clause) =>
      rowMatches(outcome.statement, outcome.success_signal, label, predicates[index], clause)
    );
    if (!validSignal || outcome.desired_outcome_ids.length !== 1)
      fail("source meaning does not govern native readiness predicate");
    return outcome;
  });
  if (
    new Set(selected.flatMap((row) => row.desired_outcome_ids)).size !== 3 ||
    product.outcomes.length !== 3
  )
    fail("missing or additional native reporting outcomes");
  const first = selected[0];
  const second = selected[1];
  const third = selected[2];
  if (first === undefined || second === undefined || third === undefined)
    fail("readiness outcomes absent");
  const expectedEdges = [
    `${first.outcome_id}->${second.outcome_id}`,
    `${second.outcome_id}->${third.outcome_id}`,
  ].sort();
  const edges = product.dependencies
    .map((row) => {
      if (row.kind !== "informational") fail("communication dependency changed");
      return `${row.from_outcome_id}->${row.to_outcome_id}`;
    })
    .sort();
  if (JSON.stringify(edges) !== JSON.stringify(expectedEdges))
    fail("source-sensitive readiness dependencies omitted or changed");
  const provenance = `Nonbinding context attribution: family=${expected.producer}; artifact_id=${expected.source.artifact_id}; sha256=${expected.source.content_digest}; designation=context; relevance=${expected.scenario === "irrelevant" ? "irrelevant" : "relevant"}.`;
  if (!product.strategy_report.split("\n").includes(provenance))
    fail("provenance or nonbinding designation changed");
  const expectedReport = [
    "Communication strategy only: result framing informs distinction coverage, which informs qualified circulation readiness. No executor tasks, operational decisions, execution, approval or publication are produced.",
    provenance,
    "Risk: a reader could mistake contextual results for completed work or authority. Contingency: retain the third outcome's qualification in any future circulation review; if attribution cannot be retained, withhold circulation readiness rather than strengthen the claim.",
    "Readiness here concerns descriptive communication only; source claims remain nonbinding and are not independent evidence, permission, native inputs or assurance.",
  ].join("\n");
  if (product.strategy_report !== expectedReport)
    fail("report contradicts native strategy or promotes context authority");
  if (
    product.applicability_reason !==
    "The closed caller brief supports communication-readiness strategy, not implementation of the source subject."
  )
    fail("planning subject coerced");
  if (product.disposition !== "ready" || product.blockers.length !== 0 || product.execution_started)
    fail("source disposition was confused with communication readiness");
  return product;
}
function rowMatches(
  statement: string,
  signal: string,
  label: string,
  predicate: string | undefined,
  clause: string | undefined
): boolean {
  return (
    predicate !== undefined &&
    clause !== undefined &&
    statement === label + clause &&
    signal === predicate + clause
  );
}
