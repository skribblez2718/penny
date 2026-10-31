// TEST ONLY. Literal independent expectations for one native-family column, not a model judge.
// Neither this table nor this judge is imported at runtime by the scripted cognition client.
import { validateSpecification, type ArtifactRef, type SpecificationV1 } from "../../dist/index.js";
import type { ContentProducer } from "./universal-content-oracle.js";
import type { DefineScenario } from "./universal-content-define-fixtures.js";

interface Meaning {
  readonly direct: readonly string[];
  readonly paraphrase: readonly string[];
}
const meanings: Readonly<Record<ContentProducer, Meaning>> = {
  assess: {
    direct: [
      "assessment disposition is meets",
      "maintenance-time criterion is met and courtesy criterion is met",
      "verdicts concern supplied material only; Do not externally verify the schedule.",
    ],
    paraphrase: [
      "the supplied note receives meets overall",
      "courtesy is met while maintenance-time clarity is met",
      "supplied-note judgments do not verify the schedule; Do not externally verify the schedule.",
    ],
  },
  decide: {
    direct: [
      "selected outcome uses selection: Option A",
      "Option C is infeasible; sensitivity is Select alt_b instead of alt_a.",
      "selection is conditional on B's final quote, not permission to implement it",
    ],
    paraphrase: [
      "Option A is the selection recommendation (selected)",
      "exclude infeasible Option C; the stated sensitivity says Select alt_b instead of alt_a.",
      "B's final quote may change the choice; recommending does not authorize implementation",
    ],
  },
  define: {
    direct: [
      "source specification disposition is ready; requirement: The transition specification must define the target outcome.",
      "protected source constraint is Do not execute the transition.",
      "source planning_started=false, taskification_started=false, execution_started=false; reporting is not revision or approval",
    ],
    paraphrase: [
      "the ready source requires: The transition specification must define the target outcome.",
      "retain the source prohibition: Do not execute the transition.",
      "source execution_started=false, taskification_started=false, planning_started=false; describe it without revising or approving it",
    ],
  },
  diagnose: {
    direct: [
      "supported diagnosis: The supplied evidence supports cache staleness.",
      "primary hypothesis is hyp_cache; origin hypothesis is ruled_out",
      "tests_executed=false and remediation_started=false; supplied observations are not new test evidence",
    ],
    paraphrase: [
      "the diagnosis is supported because The supplied evidence supports cache staleness.",
      "origin is ruled_out, while hyp_cache is the primary supported hypothesis",
      "remediation_started=false; tests_executed=false; no fresh experiment is established",
    ],
  },
  plan: {
    direct: [
      "strategy disposition is ready; outcomes: Rollback viability is retained. | Transition readiness is established.",
      "strategy blockers: none",
      "execution_started=false; planned outcomes are not completed work or execution permission",
    ],
    paraphrase: [
      "the ready strategy describes: Rollback viability is retained. | Transition readiness is established.",
      "reported blockers are none",
      "no completed work or execution approval follows; execution_started=false",
    ],
  },
  produce: {
    direct: [
      "artifact kind is markdown; media type is text/markdown; charset=utf-8",
      'the exact supplied content is "# Greeting\\n\\nHello, world.\\n\\n*Supplied by the caller.*"',
      "the greeting is caller-supplied, not independently verified",
    ],
    paraphrase: [
      "text/markdown; charset=utf-8 is the media type of the markdown artifact",
      'preserve this content verbatim: "# Greeting\\n\\nHello, world.\\n\\n*Supplied by the caller.*"',
      "attribute the greeting to the caller rather than claiming external verification",
    ],
  },
  research: {
    direct: [
      "research claim: Synthetic cache retention is 7 days.",
      "support is qualified with confidence 0.8",
      "retain qualification: The fixture scope remains deliberately bounded.; synthetic source only, not external verification",
    ],
    paraphrase: [
      "the synthetic synthesis states: Synthetic cache retention is 7 days.",
      "confidence 0.8 accompanies qualified support",
      "keep the scope limit: The fixture scope remains deliberately bounded.; no independently verified external fact is established",
    ],
  },
};
const blockedPlan: Meaning = {
  direct: [
    "strategy disposition is blocked; outcomes: Transition readiness is established.",
    "strategy blockers: Rollback access is unavailable.",
    "execution_started=false; planned outcomes are not completed work or execution permission",
  ],
  paraphrase: [
    "the blocked strategy describes: Transition readiness is established.",
    "reported blockers are Rollback access is unavailable.",
    "no completed work or execution approval follows; execution_started=false",
  ],
};
const fourteenDayResearch: Meaning = {
  direct: [
    "research claim: Synthetic cache retention is 14 days.",
    "support is qualified with confidence 0.8",
    "retain qualification: The fixture scope remains deliberately bounded.; synthetic source only, not external verification",
  ],
  paraphrase: [
    "the synthetic synthesis states: Synthetic cache retention is 14 days.",
    "confidence 0.8 accompanies qualified support",
    "keep the scope limit: The fixture scope remains deliberately bounded.; no independently verified external fact is established",
  ],
};
const irrelevantPlan: Meaning = {
  direct: [
    "the notice contains the caller greeting Welcome, reader.",
    "transition strategy is irrelevant to the welcome notice",
    "greeting provenance is the caller, not the strategy",
  ],
  paraphrase: [
    "preserve the caller's Welcome, reader. greeting",
    "exclude the unrelated transition strategy from notice content",
    "attribute the greeting to the caller rather than the strategy",
  ],
};
export interface DefineExpectation {
  readonly producer: ContentProducer;
  readonly scenario: DefineScenario;
  readonly source: ArtifactRef;
}
function expectedMeaning(expected: DefineExpectation): Meaning {
  if (expected.scenario === "base") return meanings[expected.producer];
  if (expected.scenario === "irrelevant" && expected.producer === "plan") return irrelevantPlan;
  if (expected.scenario === "counterfactual" && expected.producer === "plan") return blockedPlan;
  if (expected.scenario === "counterfactual" && expected.producer === "research")
    return fourteenDayResearch;
  throw new Error("No independent Define oracle for this scenario");
}
function fail(detail: string): never {
  throw new Error(`DEFINE_CONTENT_ORACLE: ${detail}`);
}

/** Judge actual normative requirements and observable acceptance, not a prose appendix or PASS claim.
 * Finite two-wording corpus only. Runtime validity/coverage/authority checks remain the native owners'.
 */
export function assertDefineMeaning(value: unknown, expected: DefineExpectation): SpecificationV1 {
  const product = validateSpecification(value);
  const meaning = expectedMeaning(expected);
  const categories = ["outcome", "reporting_detail", "reporting_limit"];
  for (const [index, category] of categories.entries()) {
    const requirement = product.requirements.find((row) => row.category === category);
    if (requirement === undefined) fail("material reporting requirement omitted");
    const alternatives = [
      `The bulletin must report: ${meaning.direct[index]}`,
      `The reader-facing report shall state: ${meaning.paraphrase[index]}`,
    ];
    if (!alternatives.includes(requirement.statement) || requirement.priority !== "must")
      fail(
        "distinguishing meaning or qualification ignored, omitted, changed, coerced or promoted"
      );
    const objective = product.objectives.find((row) =>
      requirement.objective_ids.includes(row.item_id)
    );
    if (objective === undefined) fail("reporting requirement is not objective-linked");
    const criteria = product.acceptance_criteria.filter((row) =>
      row.requirement_ids.includes(requirement.item_id)
    );
    const observations = [
      `Read the candidate bulletin and compare with the exact context: ${meaning.direct[index]}`,
      `Read the candidate bulletin and compare with the exact context: ${meaning.paraphrase[index]}`,
    ];
    if (criteria.length !== 1 || !criteria.some((row) => observations.includes(row.observation)))
      fail("meaning lacks an observable linked acceptance condition");
  }
  const provenance = `Nonbinding context attribution: family=${expected.producer}; artifact_id=${expected.source.artifact_id}; sha256=${expected.source.content_digest}; designation=context; relevance=${expected.scenario === "irrelevant" ? "irrelevant" : "relevant"}.`;
  const quality = product.requirements.find((row) => row.category === "quality");
  if (
    quality?.statement !== provenance ||
    !product.acceptance_criteria.some(
      (row) => row.requirement_ids.includes(quality.item_id) && row.observation === provenance
    )
  )
    fail("exact provenance, relevance or nonbinding context designation changed");
  if (
    product.summary !==
    "This specification defines a descriptive bulletin, not source execution or external verification."
  )
    fail("summary promotes context to evidence, permission or native authority");
  const boundary = product.requirements.find((row) => row.category === "constraint");
  if (
    boundary?.statement !==
    "The bulletin remains descriptive; it neither carries out source work nor grants evidence, permission or native assurance."
  )
    fail("reporting boundary was strengthened into authority");
  if (product.requirements.length !== 5 || product.acceptance_criteria.length !== 5)
    fail("unexpected extra or missing reporting conditions");
  return product;
}
