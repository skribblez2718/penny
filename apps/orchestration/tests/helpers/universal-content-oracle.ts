// TEST ONLY. This finite reader-brief oracle is not a production semantic filter or model judge.
// Expectations are authored independently of the scripted client and never generated from its output.
import { Type, type Static } from "typebox";
import {
  JsonValueSchema,
  canonicalJson,
  validateContract,
  validateProducedArtifactV2,
  type ArtifactRef,
  type JsonValue,
} from "../../dist/index.js";

export const contentProducers = [
  "assess",
  "decide",
  "define",
  "diagnose",
  "plan",
  "produce",
  "research",
] as const;
export type ContentProducer = (typeof contentProducers)[number];
export type ContentScenario = "base" | "counterfactual" | "irrelevant";
export type BriefWording = "direct" | "paraphrase";

// These limits bound this synthetic fixture document, not worker liveness or production policy.
export const ReaderBriefSchema = Type.Object(
  {
    source: Type.Object(
      {
        artifact_id: Type.String({ maxLength: 68 }),
        content_digest: Type.String({ maxLength: 64 }),
        family: Type.String({ maxLength: 32 }),
        designation: Type.String({ maxLength: 32 }),
      },
      { additionalProperties: false }
    ),
    relevance: Type.Union([Type.Literal("relevant"), Type.Literal("irrelevant")]),
    summary: Type.String({ minLength: 1, maxLength: 1024 }),
    facts: Type.Record(Type.String({ maxLength: 64 }), JsonValueSchema, { maxProperties: 12 }),
    authority: Type.Object(
      {
        externally_verified: Type.Boolean(),
        permission: Type.String({ maxLength: 64 }),
        replaces_native_input: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ReaderBrief = Static<typeof ReaderBriefSchema>;

interface ExpectedMeaning {
  readonly facts: Record<string, JsonValue>;
  readonly summaries: readonly string[];
}

// Literal expected domain values, deliberately NOT imported from producer/client fixture builders.
const baseMeanings: Readonly<Record<ContentProducer, ExpectedMeaning>> = {
  assess: {
    facts: { disposition: "meets", time: "met", courtesy: "met" },
    summaries: [
      "The supplied note meets both criteria.",
      "Both criteria are met by the supplied note.",
    ],
  },
  decide: {
    facts: {
      outcome: "selected",
      recommendation: "selection",
      chosen: ["Option A"],
      excluded: ["Option C"],
      sensitivity: "Select alt_b instead of alt_a.",
    },
    summaries: [
      "Option A is selected; a lower B quote could change the choice.",
      "The decision favors A, conditionally sensitive to B's final quote.",
    ],
  },
  define: {
    facts: {
      disposition: "ready",
      requirement: "The transition specification must define the target outcome.",
      constraint: "Do not execute the transition.",
      planning_started: false,
      execution_started: false,
    },
    summaries: [
      "The specification defines transition readiness, not execution permission.",
      "A planning-ready specification is not authority to execute the transition.",
    ],
  },
  diagnose: {
    facts: {
      disposition: "supported",
      reasoning: "The supplied evidence supports cache staleness.",
      primary: "hyp_cache",
      origin: "ruled_out",
      tests_executed: false,
      remediation_started: false,
    },
    summaries: [
      "Supplied observations support cache staleness, not an origin fault.",
      "The diagnosis favors a stale cache and rules out the origin hypothesis.",
    ],
  },
  plan: {
    facts: {
      disposition: "ready",
      outcomes: ["Rollback viability is retained.", "Transition readiness is established."],
      blockers: [],
      execution_started: false,
    },
    summaries: [
      "The strategy covers transition readiness and rollback; it has not executed anything.",
      "Readiness and rollback are planned outcomes, not completed execution.",
    ],
  },
  produce: {
    facts: {
      content: "# Greeting\n\nHello, world.\n\n*Supplied by the caller.*",
      artifact_kind: "markdown",
      media_type: "text/markdown; charset=utf-8",
    },
    summaries: [
      "The artifact contains a caller-supplied greeting.",
      "The greeting is attributed to the caller rather than independently verified.",
    ],
  },
  research: {
    facts: {
      claim: "Synthetic cache retention is 7 days.",
      support: "qualified",
      confidence: 0.8,
      qualifications: ["The fixture scope remains deliberately bounded."],
    },
    summaries: [
      "The synthetic source reports seven-day retention, with a scope qualification.",
      "Seven days is a qualified synthetic-source claim, not external verification.",
    ],
  },
};

function expectedMeaning(producer: ContentProducer, scenario: ContentScenario): ExpectedMeaning {
  if (scenario === "base") return baseMeanings[producer];
  if (scenario === "irrelevant" && producer === "plan")
    return {
      facts: { greeting: "Hello, world." },
      summaries: [
        "Transition strategy is irrelevant to the supplied greeting.",
        "The greeting comes from the caller, not from transition context.",
      ],
    };
  if (scenario === "counterfactual" && producer === "plan")
    return {
      facts: {
        disposition: "blocked",
        outcomes: ["Transition readiness is established."],
        blockers: ["Rollback access is unavailable."],
        execution_started: false,
      },
      summaries: [
        "Rollback access blocks the strategy; no execution has begun.",
        "The blocked strategy cannot establish rollback viability or authorize execution.",
      ],
    };
  if (scenario === "counterfactual" && producer === "research")
    return {
      facts: {
        claim: "Synthetic cache retention is 14 days.",
        support: "qualified",
        confidence: 0.8,
        qualifications: ["The fixture scope remains deliberately bounded."],
      },
      summaries: [
        "The synthetic source reports fourteen-day retention, with a scope qualification.",
        "Fourteen days is a qualified synthetic-source claim, not external verification.",
      ],
    };
  throw new Error(`No independent oracle for ${producer}/${scenario}`);
}

export interface ReaderBriefExpectation {
  readonly producer: ContentProducer;
  readonly scenario: ContentScenario;
  readonly source: ArtifactRef;
}

/** Checks the native product, then its task-specific distinguishing content; never trusts reviews as meaning proof. */
export function assertReaderBrief(
  productValue: unknown,
  expected: ReaderBriefExpectation
): ReaderBrief {
  const product = validateProducedArtifactV2(productValue);
  if (product.artifact_kind !== "json" || product.media_type !== "application/json")
    throw new Error("CONTENT_ORACLE: native reader brief must be JSON");
  if (Buffer.byteLength(product.content, "utf8") > 16_384)
    throw new Error("CONTENT_ORACLE: fixture brief exceeds its representation bound");
  const parsed: unknown = JSON.parse(product.content);
  const brief = validateContract(ReaderBriefSchema, parsed, "content-oracle reader brief");
  const meaning = expectedMeaning(expected.producer, expected.scenario);
  const provenance = {
    artifact_id: expected.source.artifact_id,
    content_digest: expected.source.content_digest,
    family: expected.producer,
    designation: "context",
  };
  if (canonicalJson(brief.source) !== canonicalJson(provenance))
    throw new Error("CONTENT_ORACLE: provenance or context designation changed");
  if (brief.relevance !== (expected.scenario === "irrelevant" ? "irrelevant" : "relevant"))
    throw new Error("CONTENT_ORACLE: task relevance misrepresented");
  if (canonicalJson(brief.facts) !== canonicalJson(meaning.facts))
    throw new Error("CONTENT_ORACLE: distinguishing meaning omitted, changed, or coerced");
  // A deliberately closed paraphrase corpus, not a claim to recognize arbitrary equivalent prose.
  if (!meaning.summaries.includes(brief.summary))
    throw new Error("CONTENT_ORACLE: summary does not preserve the fixture meaning");
  if (
    brief.authority.externally_verified ||
    brief.authority.permission !== "none" ||
    brief.authority.replaces_native_input
  )
    throw new Error(
      "CONTENT_ORACLE: contextual data promoted to evidence, permission, or native authority"
    );
  return brief;
}

// This helper owns only the Produce column. The six native consumer suites
// independently own the other columns; these arrays are not global coverage claims.
export const produceContentPairs = contentProducers.map((producer) => ({
  producer,
  consumer: "produce" as const,
}));
export const otherConsumerContentPairs = contentProducers.flatMap((producer) =>
  contentProducers
    .filter((consumer) => consumer !== "produce")
    .map((consumer) => ({ producer, consumer }))
);
