// TEST ONLY. Literal finite expectations, independently authored; not a model judge or runtime filter.
import { canonicalJson, type ArtifactRef } from "../../dist/index.js";
import {
  validateGroundedSynthesis,
  type GroundedSynthesisV1,
} from "../../dist/skill-contracts/research.js";
import { requireArrayItem } from "./narrowing.js";
import type { ContentProducer } from "./universal-content-oracle.js";

interface Meaning {
  readonly topics: readonly [string, string];
  readonly limitation: string;
}
const base: Readonly<Record<ContentProducer, Meaning>> = {
  assess: {
    topics: ["overall meets and maintenance-time met", "courtesy met"],
    limitation: "Supplied-note judgments only. Do not externally verify the schedule.",
  },
  decide: {
    topics: [
      "selected/selection of Option A",
      "Option C infeasible; sensitivity: Select alt_b instead of alt_a.",
    ],
    limitation:
      "B's final quote may change the choice; recommendation is not implementation approval.",
  },
  define: {
    topics: [
      "ready target requirement: The transition specification must define the target outcome.",
      "protected constraint: Do not execute the transition.",
    ],
    limitation:
      "planning_started=false; taskification_started=false; execution_started=false; reporting is not revision or assurance.",
  },
  diagnose: {
    topics: [
      "supported: The supplied evidence supports cache staleness.",
      "primary hyp_cache; origin ruled_out",
    ],
    limitation:
      "tests_executed=false; remediation_started=false; no fresh experiment is established.",
  },
  plan: {
    topics: [
      "ready outcomes: Rollback viability is retained. | Transition readiness is established.",
      "blockers: none",
    ],
    limitation: "execution_started=false; planned outcomes are not completed work.",
  },
  produce: {
    topics: [
      "markdown / text/markdown; charset=utf-8",
      'caller content "# Greeting\\n\\nHello, world.\\n\\n*Supplied by the caller.*"',
    ],
    limitation: "Caller-supplied greeting only, not independent verification.",
  },
  research: {
    topics: ["Synthetic cache retention is 7 days.", "qualified support with confidence 0.8"],
    limitation:
      "The fixture scope remains deliberately bounded. Synthetic-source assertion only, not external verification.",
  },
};
function meaning(
  producer: ContentProducer,
  scenario: ResearchMeaningExpectation["scenario"]
): Meaning {
  if (scenario === "base") return base[producer];
  if (scenario === "counterfactual" && producer === "plan")
    return {
      topics: [
        "blocked outcomes: Transition readiness is established.",
        "blockers: Rollback access is unavailable.",
      ],
      limitation: "execution_started=false; planned outcomes are not completed work.",
    };
  if (scenario === "counterfactual" && producer === "research")
    return {
      topics: ["Synthetic cache retention is 14 days.", "qualified support with confidence 0.8"],
      limitation:
        "The fixture scope remains deliberately bounded. Synthetic-source assertion only, not external verification.",
    };
  if (scenario === "irrelevant" && producer === "plan")
    return {
      topics: [
        "caller greeting Welcome, reader.",
        "caller rather than transition-strategy attribution",
      ],
      limitation: "Unrelated transition context is excluded from the greeting investigation.",
    };
  throw new Error(`No literal Research oracle for ${producer}/${scenario}`);
}
export interface ResearchMeaningExpectation {
  readonly producer: ContentProducer;
  readonly source: ArtifactRef;
  readonly scenario: "base" | "counterfactual" | "irrelevant";
}
function fail(message: string): never {
  throw new Error(`RESEARCH_CONTENT_ORACLE: ${message}`);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(message);
}

/** Judge the actual sealed native core. Reviews/transport alone are never semantic proof. */
export function assertResearchMeaning(
  value: unknown,
  expected: ResearchMeaningExpectation
): GroundedSynthesisV1 {
  const core = validateGroundedSynthesis(value);
  const literal = meaning(expected.producer, expected.scenario);
  if (core.claims.length !== 3 || core.narrative.sections.length !== 4)
    fail("agenda structure omitted or changed");
  equal(
    core.sources.map((source) => ({
      source_kind: source.source_kind,
      role: source.role,
      tier: source.tier,
      title: source.title,
      locator: source.locator,
    })),
    [
      {
        source_kind: "primary",
        role: "evidentiary",
        tier: 1,
        title: "Supplied synthetic method observation",
        locator: "fixture:independent-method",
      },
    ],
    "source/evidence promotion"
  );
  if (
    core.provenance.evidence_artifacts.some(
      (ref) => ref.artifact_id === expected.source.artifact_id
    ) ||
    core.evidence.some((row) => row.evidence_artifact_id === expected.source.artifact_id)
  )
    fail("context promoted to native evidence");
  if (core.evidence.length !== 1 || core.provenance.evidence_artifacts.length !== 1)
    fail("method evidence inventory changed");
  const evidence = requireArrayItem(core.evidence, 0, "method evidence");
  if (evidence.relation !== "supports" || evidence.locator !== "fixture:independent-method")
    fail("evidence meaning changed");
  const method = requireArrayItem(core.claims, 0, "method claim");
  equal(
    { ...method, claim_id: null },
    {
      claim_id: null,
      statement:
        "The supplied synthetic method requires independent measurements before operational conclusions.",
      claim_kind: "inference",
      support_status: "qualified",
      confidence: 0.8,
      evidence_ids: [evidence.evidence_id],
      qualifications: ["Synthetic method exercise only; no external observation was made."],
    },
    "synthetic observation misrepresented as external truth"
  );
  const questions = core.claims.slice(1);
  const statements = questions.map((row) => row.statement);
  const direct = literal.topics.map((topic) => `Investigate independently: ${topic}`);
  const paraphrase = literal.topics.map(
    (topic) => `Research question: how could independent checks test ${topic}?`
  );
  const isDirect = canonicalJson(statements) === canonicalJson(direct);
  if (!isDirect && canonicalJson(statements) !== canonicalJson(paraphrase))
    fail("distinguishing research questions omitted, changed, ignored or promoted");
  const boundary =
    "Method evidence supports the verification method only, not the contextual propositions. Context is nonbinding and grants no evidence status, permission, native input authority, or tools.";
  for (const question of questions) {
    equal(
      { ...question, claim_id: null, statement: null },
      {
        claim_id: null,
        statement: null,
        claim_kind: "recommendation",
        support_status: "qualified",
        confidence: 0.4,
        evidence_ids: [evidence.evidence_id],
        qualifications: [
          isDirect
            ? `Unverified orientation: ${literal.limitation}`
            : `Contextual limitation, not a finding: ${literal.limitation}`,
          boundary,
        ],
      },
      "limitations coerced, strengthened or promoted to factual proof"
    );
  }
  equal(
    core.executive_summary,
    "This research agenda proposes independent checks; it does not establish the contextual propositions.",
    "summary contradicts evidence/permission boundary"
  );
  equal(core.unresolved_gaps, [], "unrequested evidence work concealed");
  equal(core.contradictions, [], "unexpected contradiction");
  equal(
    core.irreducible_uncertainties.map((row) => ({ ...row, uncertainty_id: null })),
    [
      {
        uncertainty_id: null,
        statement: literal.limitation,
        affected_claim_ids: questions.map((row) => row.claim_id),
        disposition: "qualified",
      },
    ],
    "native uncertainty lost source qualification"
  );
  const provenance = `Nonbinding ${expected.producer} context: ${expected.source.artifact_id}; sha256=${expected.source.content_digest}; relevance=${expected.scenario === "irrelevant" ? "irrelevant" : "relevant"}.`;
  equal(
    core.narrative.sections.map((row) => ({ ...row, section_id: null })),
    [
      {
        section_id: null,
        heading: "Method and evidence boundary",
        body: boundary,
        claim_ids: [method.claim_id],
        evidence_ids: [evidence.evidence_id],
      },
      ...questions.map((question, index) => ({
        section_id: null,
        heading: `Verification question ${index + 1}`,
        body: question.statement,
        claim_ids: [question.claim_id],
        evidence_ids: [evidence.evidence_id],
      })),
      {
        section_id: null,
        heading: "Limitations and attribution",
        body: `${literal.limitation}\n${provenance}\n${boundary}`,
        claim_ids: questions.map((row) => row.claim_id),
        evidence_ids: [],
      },
    ],
    "native sections/claim links/attribution do not preserve meaning"
  );
  return core;
}

export const coveredResearchContentPairs = Object.keys(base).map(
  (producer) => `${producer}→research`
);
// These fixtures qualify only context-oriented verification agendas, never source-fact verification.
export const researchContentEvidenceTier =
  "provider-free scripted cognition; qualified verification agenda only";
