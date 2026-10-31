import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  TextSchema,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

export const SpecificationProfileIdSchema = Type.Union([
  Type.Literal("generic"),
  Type.Literal("software"),
  Type.Literal("business_process"),
  Type.Literal("research"),
]);
export type SpecificationProfileId = Static<typeof SpecificationProfileIdSchema>;

const SpecificationProfileBodyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    profile_id: SpecificationProfileIdSchema,
    profile_version: Type.Literal(1),
    title: TextSchema({ minBytes: 1, maxBytes: 128 }),
    description: TextSchema({ minBytes: 1, maxBytes: 1_024, multiline: true }),
    required_requirement_categories: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    required_standard_categories: Type.Array(OpaqueIdSchema, {
      maxItems: 16,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
type SpecificationProfileBodySchemaValue = Static<typeof SpecificationProfileBodyV1Schema>;
export type SpecificationProfileBodyV1 = Readonly<
  Omit<
    SpecificationProfileBodySchemaValue,
    "required_requirement_categories" | "required_standard_categories"
  > & {
    readonly required_requirement_categories: readonly string[];
    readonly required_standard_categories: readonly string[];
  }
>;

export const SpecificationProfileV1Schema = Type.Object(
  {
    ...SpecificationProfileBodyV1Schema.properties,
    profile_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
type SpecificationProfileSchemaValue = Static<typeof SpecificationProfileV1Schema>;
export type SpecificationProfileV1 = Readonly<
  Omit<
    SpecificationProfileSchemaValue,
    "required_requirement_categories" | "required_standard_categories"
  > & {
    readonly required_requirement_categories: readonly string[];
    readonly required_standard_categories: readonly string[];
  }
>;

export function specificationProfileSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(SpecificationProfileBodyV1Schema, value, "SpecificationProfileBodyV1")
    )
  );
}

export function validateSpecificationProfile(value: unknown): SpecificationProfileV1 {
  const profile = validateSkillSchema(
    SpecificationProfileV1Schema,
    value,
    "SpecificationProfileV1"
  );
  assertText(profile.title, "SpecificationProfileV1.title", {
    minBytes: 1,
    maxBytes: 128,
    trimmedNonEmpty: true,
  });
  assertText(profile.description, "SpecificationProfileV1.description", {
    minBytes: 1,
    maxBytes: 1_024,
    multiline: true,
    trimmedNonEmpty: true,
  });
  assertUnique(
    profile.required_requirement_categories,
    "SpecificationProfileV1 required requirement categories"
  );
  assertUnique(
    profile.required_standard_categories,
    "SpecificationProfileV1 required standard categories"
  );
  const { profile_sha256: ignoredDigest, ...body } = profile;
  void ignoredDigest;
  if (profile.profile_sha256 !== specificationProfileSha256(body)) {
    throw new Error("SpecificationProfileV1 profile_sha256 is invalid");
  }
  return profile;
}

function profile(value: Omit<SpecificationProfileV1, "profile_sha256">): SpecificationProfileV1 {
  const sealed = validateSpecificationProfile({
    ...value,
    profile_sha256: specificationProfileSha256(value),
  });
  return Object.freeze({
    ...sealed,
    required_requirement_categories: Object.freeze([...sealed.required_requirement_categories]),
    required_standard_categories: Object.freeze([...sealed.required_standard_categories]),
  });
}

const PROFILES = Object.freeze([
  profile({
    schema_version: 1,
    profile_id: "generic",
    profile_version: 1,
    title: "Generic creation specification",
    description:
      "Cross-domain fallback that requires outcome, constraint, and quality requirements without inventing a specialized method.",
    required_requirement_categories: ["outcome", "constraint", "quality"],
    required_standard_categories: [],
  }),
  profile({
    schema_version: 1,
    profile_id: "software",
    profile_version: 1,
    title: "Software specification",
    description:
      "Software-oriented semantic overlay covering behavior, interfaces, security and privacy, accessibility, compatibility, observability, and failure behavior.",
    required_requirement_categories: [
      "behavior",
      "interface",
      "security_privacy",
      "accessibility",
      "compatibility",
      "observability",
      "failure_behavior",
    ],
    required_standard_categories: ["security", "accessibility"],
  }),
  profile({
    schema_version: 1,
    profile_id: "business_process",
    profile_version: 1,
    title: "Business-process specification",
    description:
      "Process-oriented semantic overlay covering triggers, roles, inputs, steps, decisions, controls, handoffs, service levels, exceptions, and records.",
    required_requirement_categories: [
      "trigger",
      "roles",
      "inputs",
      "steps",
      "decision_rules",
      "controls",
      "handoffs",
      "service_levels",
      "exceptions",
      "records",
    ],
    required_standard_categories: ["governance", "records"],
  }),
  profile({
    schema_version: 1,
    profile_id: "research",
    profile_version: 1,
    title: "Research specification",
    description:
      "Research-oriented semantic overlay covering questions, scope, evidence sources, inclusion and exclusion, method, analysis, validity, ethics and data handling, and reproducibility.",
    required_requirement_categories: [
      "research_questions",
      "scope",
      "evidence_sources",
      "inclusion_exclusion",
      "method",
      "analysis",
      "validity_threats",
      "ethics_data_handling",
      "reproducibility",
    ],
    required_standard_categories: ["ethics", "data_handling"],
  }),
] as const satisfies readonly SpecificationProfileV1[]);

const PROFILE_BY_ID: ReadonlyMap<SpecificationProfileId, SpecificationProfileV1> = new Map(
  PROFILES.map((entry) => [entry.profile_id, entry])
);

export const SPECIFICATION_PROFILE_IDS: readonly SpecificationProfileId[] = Object.freeze(
  PROFILES.map((entry) => entry.profile_id)
);

/** Return a detached, validated profile. Callers cannot mutate the registry. */
export function specificationProfile(profileId: SpecificationProfileId): SpecificationProfileV1 {
  const entry = PROFILE_BY_ID.get(profileId);
  if (entry === undefined) throw new Error(`unknown specification profile '${profileId}'`);
  return structuredClone(entry);
}

/** Return detached profiles in canonical registry order. */
export function specificationProfiles(): readonly SpecificationProfileV1[] {
  return PROFILES.map((entry) => structuredClone(entry));
}
