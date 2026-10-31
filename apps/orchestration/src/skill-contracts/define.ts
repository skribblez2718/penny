import { Type, type Static } from "typebox";
import type { EvidenceAdmissionV2 } from "./evidence-admission.js";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  TextSchema,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";
import {
  SpecificationProfileIdSchema,
  specificationProfile,
  specificationProfiles,
  validateSpecificationProfile,
  type SpecificationProfileId,
  type SpecificationProfileV1,
} from "./define-profiles.js";

const MAX_DEFINE_INPUTS = 4;
const MAX_DEFINITION_SOURCE_ITEMS = 128;
const MAX_SPECIFICATION_PROSE_BYTES = 65_536;
const MAX_SPECIFICATION_CORE_LINE_BYTES = 98_304;
const MAX_SPECIFICATION_SUMMARY_LINE_BYTES = 256;
export const MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES = 196_608;

const DefinitionModeV1Schema = Type.Union([Type.Literal("create"), Type.Literal("revise")]);
const AssumptionInputV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    material: Type.Boolean(),
  },
  { additionalProperties: false }
);
const UncertaintyInputV1Schema = Type.Object(
  {
    question: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    owner: Type.Union([Type.Literal("caller"), Type.Literal("evidence")]),
    material: Type.Boolean(),
  },
  { additionalProperties: false }
);
const PriorDecisionInputV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    binding_effect: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  },
  { additionalProperties: false }
);
const StandardHintInputV1Schema = Type.Object(
  {
    category: OpaqueIdSchema,
    standard: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
    relevance: TextSchema({ minBytes: 1, maxBytes: 1_024, multiline: true }),
  },
  { additionalProperties: false }
);

const DefinitionRequestConstraintProperties = {
  schema_version: Type.Literal(1),
  mode: DefinitionModeV1Schema,
  requested_profile_id: Type.Union([SpecificationProfileIdSchema, Type.Null()]),
  desired_outcomes: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    minItems: 1,
    maxItems: 24,
  }),
  audiences: Type.Array(TextSchema({ minBytes: 1, maxBytes: 1_024, multiline: true }), {
    maxItems: 16,
  }),
  in_scope: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    maxItems: 32,
  }),
  out_of_scope: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    maxItems: 32,
  }),
  hard_constraints: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    maxItems: 64,
  }),
  non_goals: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
    maxItems: 32,
  }),
  known_assumptions: Type.Array(AssumptionInputV1Schema, { maxItems: 32 }),
  known_uncertainties: Type.Array(UncertaintyInputV1Schema, { maxItems: 32 }),
  prior_decisions: Type.Array(PriorDecisionInputV1Schema, { maxItems: 32 }),
  standard_hints: Type.Array(StandardHintInputV1Schema, { maxItems: 32 }),
};

export const DefinitionRequestConstraintsV1Schema = Type.Object(
  DefinitionRequestConstraintProperties,
  { additionalProperties: false }
);
export type DefinitionRequestConstraintsV1 = Readonly<
  Static<typeof DefinitionRequestConstraintsV1Schema>
>;

/** Invocation policy is separate from the SpecificationV1 semantic contract. */
export const DefineInvocationV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    request: DefinitionRequestConstraintsV1Schema,
    specification_assurance: Type.Union([
      Type.Literal("reviewed_definition"),
      Type.Literal("semantic_only"),
    ]),
  },
  { additionalProperties: false }
);
export type DefineInvocationV2 = Readonly<Static<typeof DefineInvocationV2Schema>>;
export function validateDefineInvocation(value: unknown): {
  readonly request: DefinitionRequestConstraintsV1;
  readonly specification_assurance: DefineInvocationV2["specification_assurance"];
} {
  if (typeof value !== "object" || value === null || !("schema_version" in value)) {
    throw new Error("Define invocation requires a supported schema_version");
  }
  if (value.schema_version === 1) {
    return {
      request: validateSkillSchema(
        DefinitionRequestConstraintsV1Schema,
        value,
        "DefineInvocationV1"
      ),
      specification_assurance: "semantic_only",
    };
  }
  const invocation = validateSkillSchema(DefineInvocationV2Schema, value, "DefineInvocationV2");
  return {
    request: invocation.request,
    specification_assurance: invocation.specification_assurance,
  };
}

export const DefinitionRequestV1Schema = Type.Object(
  {
    request_id: OpaqueIdSchema,
    goal: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    ...DefinitionRequestConstraintProperties,
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_DEFINE_INPUTS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type DefinitionRequestV1 = Readonly<Static<typeof DefinitionRequestV1Schema>>;

/** New trace-capable starts cannot promise exact protected content that V1 cannot encode. */
export class DefinitionProtectedContentUnrepresentableError extends Error {
  readonly code = "DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE" as const;
  constructor(
    readonly request_sha256: string,
    readonly findings: readonly {
      readonly field_path: string;
      readonly source_ordinals: readonly number[];
      readonly measured: number;
      readonly limit: number;
      readonly unit: "bytes" | "items";
    }[]
  ) {
    super("DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE");
    this.name = "DefinitionProtectedContentUnrepresentableError";
  }
}

export function assertDefinitionProtectedContentRepresentable(value: unknown): void {
  const request = validateDefinitionRequest(value);
  const sources = definitionRequestSourceItems(request);
  const ordinals = (kind: DefinitionSourceItemV1["kind"]) =>
    sources.filter((item) => item.kind === kind).map((item) => item.ordinal);
  const excludedOrdinals = ordinals("out_of_scope");
  const findings: DefinitionProtectedContentUnrepresentableError["findings"][number][] = [];
  request.out_of_scope.forEach((text, index) => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > 2_048) {
      const ordinal = excludedOrdinals[index];
      if (ordinal === undefined) throw new Error("protected exclusion source ordinal is absent");
      findings.push({
        field_path: `out_of_scope[${index}]`,
        source_ordinals: [ordinal],
        measured: bytes,
        limit: 2_048,
        unit: "bytes",
      });
    }
  });
  const protectedTexts = new Set([...request.non_goals, ...request.out_of_scope]);
  if (protectedTexts.size > 32) {
    findings.push({
      field_path: "non_goals+out_of_scope",
      source_ordinals: [...ordinals("non_goal"), ...excludedOrdinals],
      measured: protectedTexts.size,
      limit: 32,
      unit: "items",
    });
  }
  if (findings.length > 0) {
    throw new DefinitionProtectedContentUnrepresentableError(
      definitionRequestSha256(request),
      findings.slice(0, 32)
    );
  }
}

export const DefinitionFrameRouteV1Schema = Type.Union([
  Type.Literal("author"),
  Type.Literal("clarify"),
  Type.Literal("evidence"),
]);
const ProfileBindingV1Schema = Type.Object(
  {
    profile_id: SpecificationProfileIdSchema,
    profile_version: Type.Literal(1),
    profile_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const DefinitionFrameBodyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    request_id: OpaqueIdSchema,
    profile: ProfileBindingV1Schema,
    profile_selection_basis: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    route: DefinitionFrameRouteV1Schema,
    route_reason: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    clarification_questions: Type.Array(
      TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
      { maxItems: 16, uniqueItems: true }
    ),
    evidence_questions: Type.Array(TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }), {
      maxItems: 16,
      uniqueItems: true,
    }),
    planning_started: Type.Literal(false),
    taskification_started: Type.Literal(false),
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export const DefinitionFrameV1Schema = Type.Object(
  {
    ...DefinitionFrameBodyV1Schema.properties,
    frame_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type DefinitionFrameV1 = Readonly<Static<typeof DefinitionFrameV1Schema>>;

export const DefinitionQuestionV1Schema = Type.Object(
  {
    question_id: OpaqueIdSchema,
    question: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    owner: Type.Union([Type.Literal("caller"), Type.Literal("evidence")]),
    material: Type.Boolean(),
    source_item_index: Type.Union([Type.Integer({ minimum: 0, maximum: 127 }), Type.Null()]),
    origin_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type DefinitionQuestionV1 = Readonly<Static<typeof DefinitionQuestionV1Schema>>;
export const DefinitionFrameV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    frame_id: OpaqueIdSchema,
    request_id: OpaqueIdSchema,
    profile: ProfileBindingV1Schema,
    profile_selection_basis: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    route: DefinitionFrameRouteV1Schema,
    route_reason: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    questions: Type.Array(DefinitionQuestionV1Schema, { maxItems: 64 }),
    planning_started: Type.Literal(false),
    taskification_started: Type.Literal(false),
    execution_started: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type DefinitionFrameV2 = Readonly<Static<typeof DefinitionFrameV2Schema>>;

export function definitionQuestionId(input: {
  readonly requestId: string;
  readonly owner: "caller" | "evidence";
  readonly sourceItemIndex: number | null;
  readonly question: string;
  readonly material: boolean;
}): string {
  return stableDefinitionId("definition-question", {
    request_id: input.requestId,
    owner: input.owner,
    source_item_index: input.sourceItemIndex,
    question: input.question,
    material: input.material,
  });
}

/** Source ordinals and materiality come from the request, never from Piper's suggestion. */
export function canonicalizeDefinitionFrameV2(input: {
  readonly request: unknown;
  readonly requestRef: ArtifactRef;
  readonly orientationRef: ArtifactRef;
  readonly selectedProfileId: SpecificationProfileId;
  readonly profileSelectionBasis: string;
  readonly route: Static<typeof DefinitionFrameRouteV1Schema>;
  readonly routeReason: string;
  readonly discoveredQuestions: readonly {
    readonly question: string;
    readonly owner: "caller" | "evidence";
    readonly material: boolean;
  }[];
  /** Previously selected material discoveries that the new framing did not re-propose. */
  readonly carriedQuestions?: readonly DefinitionQuestionV1[];
}): DefinitionFrameV2 {
  const request = validateDefinitionRequest(input.request);
  const requestBytes = Buffer.from(canonicalJson(request), "utf8");
  if (
    input.requestRef.kind !== "definition-request" ||
    input.requestRef.content_schema?.schema_id !== "penny.definition-request.v1" ||
    input.requestRef.content_schema.schema_version !== 1 ||
    input.requestRef.content_digest !== sha256(requestBytes) ||
    input.requestRef.byte_length !== requestBytes.length ||
    input.orientationRef.phase !== "framing_definition" ||
    input.orientationRef.kind !== "agent-output" ||
    input.orientationRef.producer !== "agent:piper" ||
    input.requestRef.run_id !== input.orientationRef.run_id
  ) {
    throw new Error("DefinitionFrameV2 source refs do not bind request and framing output");
  }
  if (
    request.requested_profile_id !== null &&
    request.requested_profile_id !== input.selectedProfileId
  ) {
    throw new Error("DefinitionFrameV2 profile disagrees with the request");
  }
  if (input.discoveredQuestions.length + (input.carriedQuestions?.length ?? 0) > 32)
    throw new Error("DefinitionFrameV2 discovered question limit exceeded");
  const uncertaintySources = definitionRequestSourceItems(request).filter(
    (source) => source.kind === "uncertainty"
  );
  const questions: DefinitionQuestionV1[] = [
    ...request.known_uncertainties.map((entry, index) => {
      const source = uncertaintySources[index];
      if (source === undefined) throw new Error("DefinitionFrameV2 uncertainty source missing");
      const identity = {
        requestId: request.request_id,
        owner: entry.owner,
        sourceItemIndex: source.ordinal,
        question: entry.question,
        material: entry.material,
      };
      return {
        question_id: definitionQuestionId(identity),
        question: entry.question,
        owner: entry.owner,
        material: entry.material,
        source_item_index: source.ordinal,
        origin_ref: input.requestRef,
      };
    }),
    ...input.discoveredQuestions.map((entry) => ({
      question_id: definitionQuestionId({
        requestId: request.request_id,
        owner: entry.owner,
        sourceItemIndex: null,
        question: entry.question,
        material: entry.material,
      }),
      ...entry,
      source_item_index: null,
      origin_ref: input.orientationRef,
    })),
    ...(input.carriedQuestions ?? []),
  ];
  const body = {
    schema_version: 2 as const,
    request_id: request.request_id,
    profile: profileBinding(input.selectedProfileId),
    profile_selection_basis: input.profileSelectionBasis,
    route: input.route,
    route_reason: input.routeReason,
    questions,
    planning_started: false as const,
    taskification_started: false as const,
    execution_started: false as const,
  };
  return validateDefinitionFrameV2(
    { ...body, frame_id: stableDefinitionId("definition-frame", body) },
    request,
    input.requestRef,
    input.orientationRef
  );
}

export function validateDefinitionFrameV2(
  value: unknown,
  requestValue: unknown,
  requestRef: ArtifactRef,
  orientationRef: ArtifactRef
): DefinitionFrameV2 {
  const frame = validateSkillSchema(DefinitionFrameV2Schema, value, "DefinitionFrameV2");
  const request = validateDefinitionRequest(requestValue);
  assertProfileBinding(frame.profile);
  if (
    request.requested_profile_id !== null &&
    frame.profile.profile_id !== request.requested_profile_id
  ) {
    throw new Error("DefinitionFrameV2 profile disagrees with the request");
  }
  if (
    frame.request_id !== request.request_id ||
    frame.frame_id !==
      stableDefinitionId(
        "definition-frame",
        (() => {
          const { frame_id: ignored, ...body } = frame;
          void ignored;
          return body;
        })()
      )
  )
    throw new Error("DefinitionFrameV2 ID or request binding is stale");
  const sourceOrdinals = definitionRequestSourceItems(request)
    .filter((source) => source.kind === "uncertainty")
    .map((source) => source.ordinal);
  if (
    frame.questions.length < sourceOrdinals.length ||
    frame.questions.length > sourceOrdinals.length + 32
  ) {
    throw new Error("DefinitionFrameV2 question inventory is incomplete");
  }
  frame.questions.forEach((question, index) => {
    const entry = request.known_uncertainties[index];
    const expected = entry === undefined ? null : sourceOrdinals[index];
    if (
      question.source_item_index !== expected ||
      (entry !== undefined &&
        (question.question !== entry.question ||
          question.owner !== entry.owner ||
          question.material !== entry.material)) ||
      (entry === undefined
        ? question.origin_ref.run_id !== orientationRef.run_id ||
          question.origin_ref.phase !== "framing_definition" ||
          question.origin_ref.kind !== "agent-output" ||
          question.origin_ref.producer !== "agent:piper"
        : canonicalJson(question.origin_ref) !== canonicalJson(requestRef)) ||
      question.question_id !==
        definitionQuestionId({
          requestId: frame.request_id,
          owner: question.owner,
          sourceItemIndex: expected,
          question: question.question,
          material: question.material,
        })
    ) {
      throw new Error("DefinitionFrameV2 question identity, ownership, or origin diverged");
    }
  });
  assertUnique(
    frame.questions.map((question) => question.question_id),
    "DefinitionFrameV2 question IDs"
  );
  if (
    frame.route === "clarify" &&
    !frame.questions.some((question) => question.owner === "caller")
  ) {
    throw new Error("DefinitionFrameV2 clarification requires a caller question");
  }
  if (
    frame.route === "evidence" &&
    !frame.questions.some((question) => question.owner === "evidence")
  ) {
    throw new Error("DefinitionFrameV2 evidence route requires an evidence question");
  }
  return frame;
}

export const DefinitionClarificationChallengeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.definition-clarification-challenge.v1"),
    schema_version: Type.Literal(1),
    challenge_id: OpaqueIdSchema,
    request_ref: ArtifactRefSchema,
    manifest_ref: ArtifactRefSchema,
    frame_ref: ArtifactRefSchema,
    gate_id: OpaqueIdSchema,
    gate_visit: Type.Integer({ minimum: 0 }),
    question_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false }
);
export type DefinitionClarificationChallengeV1 = Readonly<
  Static<typeof DefinitionClarificationChallengeV1Schema>
>;
export const DefinitionClarificationResponseV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.definition-clarification-response.v1"),
    schema_version: Type.Literal(1),
    challenge_ref: ArtifactRefSchema,
    request_ref: ArtifactRefSchema,
    owner_response_id: OpaqueIdSchema,
    answers: Type.Array(
      Type.Object(
        {
          question_id: OpaqueIdSchema,
          disposition: Type.Union([
            Type.Literal("answered"),
            Type.Literal("declined"),
            Type.Literal("not_answered"),
          ]),
          answer_text: Type.Union([
            TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 16 }
    ),
  },
  { additionalProperties: false }
);
export type DefinitionClarificationResponseV1 = Readonly<
  Static<typeof DefinitionClarificationResponseV1Schema>
>;

/** The host fixes the gate visit and ordered caller-question inventory before persistence. */
export function definitionClarificationChallenge(input: {
  readonly requestRef: ArtifactRef;
  readonly manifestRef: ArtifactRef;
  readonly frameRef: ArtifactRef;
  readonly frame: DefinitionFrameV2;
  readonly gateId: string;
  readonly gateVisit: number;
  readonly questionIds: readonly string[];
}): DefinitionClarificationChallengeV1 {
  const body = {
    schema_id: "penny.definition-clarification-challenge.v1" as const,
    schema_version: 1 as const,
    request_ref: input.requestRef,
    manifest_ref: input.manifestRef,
    frame_ref: input.frameRef,
    gate_id: input.gateId,
    gate_visit: input.gateVisit,
    question_ids: [...input.questionIds],
  };
  return validateDefinitionClarificationChallenge(
    { ...body, challenge_id: stableDefinitionId("definition-challenge", body) },
    input.frame
  );
}

export function validateDefinitionClarificationChallenge(
  value: unknown,
  frame: DefinitionFrameV2
): DefinitionClarificationChallengeV1 {
  const challenge = validateSkillSchema(
    DefinitionClarificationChallengeV1Schema,
    value,
    "DefinitionClarificationChallengeV1"
  );
  if (
    challenge.request_ref.kind !== "definition-request" ||
    challenge.manifest_ref.kind !== "definition-source-manifest" ||
    challenge.frame_ref.kind !== "definition-frame" ||
    challenge.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    challenge.frame_ref.content_digest !== sha256(canonicalJson(frame)) ||
    challenge.frame_ref.byte_length !== Buffer.byteLength(canonicalJson(frame), "utf8") ||
    challenge.request_ref.run_id !== challenge.manifest_ref.run_id ||
    challenge.request_ref.run_id !== challenge.frame_ref.run_id
  ) {
    throw new Error(
      "Definition clarification challenge has stale request, manifest, or frame refs"
    );
  }
  assertUnique(challenge.question_ids, "Definition clarification question IDs");
  const caller = new Set(
    frame.questions.filter((q) => q.owner === "caller").map((q) => q.question_id)
  );
  if (challenge.question_ids.some((id) => !caller.has(id)))
    throw new Error("Definition clarification challenge contains a non-caller or stale question");
  const { challenge_id: ignored, ...body } = challenge;
  void ignored;
  if (
    challenge.challenge_id !== stableDefinitionId("definition-challenge", body) ||
    Buffer.byteLength(canonicalJson(challenge), "utf8") > 65_536
  ) {
    throw new Error("Definition clarification challenge identity or size is invalid");
  }
  return challenge;
}

export function validateDefinitionClarificationResponse(input: {
  readonly value: unknown;
  readonly challenge: DefinitionClarificationChallengeV1;
  readonly challengeRef: ArtifactRef;
}): DefinitionClarificationResponseV1 {
  const response = validateSkillSchema(
    DefinitionClarificationResponseV1Schema,
    input.value,
    "DefinitionClarificationResponseV1"
  );
  if (
    canonicalJson(response.challenge_ref) !== canonicalJson(input.challengeRef) ||
    input.challengeRef.kind !== "definition-clarification-challenge" ||
    canonicalJson(response.request_ref) !== canonicalJson(input.challenge.request_ref) ||
    canonicalJson(response.answers.map((row) => row.question_id)) !==
      canonicalJson(input.challenge.question_ids)
  ) {
    throw new Error(
      "Definition clarification response question, request or challenge binding is stale"
    );
  }
  for (const row of response.answers) {
    if ((row.disposition === "answered") !== (row.answer_text !== null)) {
      throw new Error("Definition clarification response disposition disagrees with answer text");
    }
  }
  if (Buffer.byteLength(canonicalJson(response), "utf8") > 131_072) {
    throw new Error("Definition clarification response exceeds its size bound");
  }
  return response;
}

/** A single free-text answer maps only to one question; group text proves none. */
export function mapDefinitionGateResponse(input: {
  readonly challenge: DefinitionClarificationChallengeV1;
  readonly challengeRef: ArtifactRef;
  readonly ownerResponseId: string;
  readonly mappedAnswers?: Readonly<Record<string, string | null>>;
  readonly freeText?: string;
}): DefinitionClarificationResponseV1 {
  if (input.mappedAnswers !== undefined && input.freeText !== undefined) {
    throw new Error("Definition gate response cannot mix free text with mapped answers");
  }
  const known = new Set(input.challenge.question_ids);
  if (
    input.mappedAnswers !== undefined &&
    Object.keys(input.mappedAnswers).some((id) => !known.has(id))
  ) {
    throw new Error("Definition gate response contains an unchallenged field ID");
  }
  const answers = input.challenge.question_ids.map((id) => {
    const mapped = input.mappedAnswers?.[id];
    const answer =
      mapped === undefined && input.challenge.question_ids.length === 1 ? input.freeText : mapped;
    return {
      question_id: id,
      disposition:
        answer === undefined
          ? ("not_answered" as const)
          : answer === null
            ? ("declined" as const)
            : ("answered" as const),
      answer_text: answer ?? null,
    };
  });
  return validateDefinitionClarificationResponse({
    value: {
      schema_id: "penny.definition-clarification-response.v1",
      schema_version: 1,
      challenge_ref: input.challengeRef,
      request_ref: input.challenge.request_ref,
      owner_response_id: input.ownerResponseId,
      answers,
    },
    challenge: input.challenge,
    challengeRef: input.challengeRef,
  });
}

const SourceItemKindV1Schema = Type.Union([
  Type.Literal("goal"),
  Type.Literal("desired_outcome"),
  Type.Literal("audience"),
  Type.Literal("in_scope"),
  Type.Literal("out_of_scope"),
  Type.Literal("hard_constraint"),
  Type.Literal("non_goal"),
  Type.Literal("assumption"),
  Type.Literal("uncertainty"),
  Type.Literal("prior_decision"),
  Type.Literal("standard_hint"),
  Type.Literal("input_artifact"),
]);
const DefinitionSourceItemV1Schema = Type.Object(
  {
    source_item_id: OpaqueIdSchema,
    kind: SourceItemKindV1Schema,
    ordinal: Type.Integer({ minimum: 0, maximum: 127 }),
    canonical_value_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type DefinitionSourceItemV1 = Readonly<Static<typeof DefinitionSourceItemV1Schema>>;

export const DefinitionSourceManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.definition-source-manifest.v1"),
    schema_version: Type.Literal(1),
    request_ref: ArtifactRefSchema,
    request_sha256: Sha256Schema,
    source_count: Type.Integer({ minimum: 1, maximum: MAX_DEFINITION_SOURCE_ITEMS }),
    sources: Type.Array(DefinitionSourceItemV1Schema, {
      minItems: 1,
      maxItems: MAX_DEFINITION_SOURCE_ITEMS,
    }),
  },
  { additionalProperties: false }
);
export type DefinitionSourceManifestV1 = Readonly<Static<typeof DefinitionSourceManifestV1Schema>>;

const DraftSourceIndexesSchema = Type.Array(Type.Integer({ minimum: 0, maximum: 127 }), {
  minItems: 1,
  maxItems: 64,
  uniqueItems: true,
});
const DraftStatementItemV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftObjectiveV1Schema = DraftStatementItemV1Schema;
const DraftRequirementV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    category: OpaqueIdSchema,
    priority: Type.Union([Type.Literal("must"), Type.Literal("should"), Type.Literal("may")]),
    objective_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: 63 }), {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftAcceptanceCriterionV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    observation: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    requirement_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: 127 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftRiskV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    impact: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    mitigation: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftQuestionV1Schema = Type.Object(
  {
    question: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    owner: Type.Union([Type.Literal("caller"), Type.Literal("evidence")]),
    blocking: Type.Boolean(),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const StandardStatusV1Schema = Type.Union([
  Type.Literal("not_assessed"),
  Type.Literal("identified"),
  Type.Literal("applicable"),
  Type.Literal("not_applicable"),
  Type.Literal("satisfied_with_evidence"),
]);
const DraftStandardV1Schema = Type.Object(
  {
    category: OpaqueIdSchema,
    standard: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
    status: StandardStatusV1Schema,
    rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    evidence_artifact_slots: Type.Array(Type.Integer({ minimum: 0, maximum: 3 }), {
      maxItems: MAX_DEFINE_INPUTS,
      uniqueItems: true,
    }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const ProductItemKindV1Schema = Type.Union([
  Type.Literal("objective"),
  Type.Literal("requirement"),
  Type.Literal("acceptance_criterion"),
  Type.Literal("constraint"),
  Type.Literal("non_goal"),
  Type.Literal("assumption"),
  Type.Literal("risk"),
  Type.Literal("open_question"),
  Type.Literal("standard"),
]);
const DraftProductItemRefV1Schema = Type.Object(
  {
    kind: ProductItemKindV1Schema,
    index: Type.Integer({ minimum: 0, maximum: 255 }),
  },
  { additionalProperties: false }
);
const DraftSourceCoverageV1Schema = Type.Object(
  {
    source_item_index: Type.Integer({ minimum: 0, maximum: 127 }),
    disposition: Type.Union([
      Type.Literal("incorporated"),
      Type.Literal("excluded"),
      Type.Literal("unresolved"),
    ]),
    // Compatibility-only input from earlier drafts. Item-side source_item_indexes are the
    // authoritative semantic relation; the host derives the reciprocal product references.
    product_item_refs: Type.Optional(
      Type.Array(DraftProductItemRefV1Schema, {
        maxItems: 64,
        uniqueItems: true,
      })
    ),
    rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
  },
  { additionalProperties: false }
);
const DraftSupersessionIntentV1Schema = Type.Object(
  {
    prior_item_id: OpaqueIdSchema,
    replacement: Type.Union([DraftProductItemRefV1Schema, Type.Null()]),
    reason: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
  },
  { additionalProperties: false }
);

const SpecificationDispositionV1Schema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("blocked"),
]);
const SpecificationCoreProperties = {
  schema_version: Type.Literal(1),
  disposition: SpecificationDispositionV1Schema,
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  profile: ProfileBindingV1Schema,
  title: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
  summary: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  audiences: Type.Array(TextSchema({ minBytes: 1, maxBytes: 1_024, multiline: true }), {
    maxItems: 16,
    uniqueItems: true,
  }),
  scope: Type.Object(
    {
      included: Type.Array(TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }), {
        maxItems: 32,
        uniqueItems: true,
      }),
      excluded: Type.Array(TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }), {
        maxItems: 32,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false }
  ),
  objectives: Type.Array(DraftObjectiveV1Schema, { minItems: 1, maxItems: 24 }),
  requirements: Type.Array(DraftRequirementV1Schema, { minItems: 1, maxItems: 128 }),
  acceptance_criteria: Type.Array(DraftAcceptanceCriterionV1Schema, {
    minItems: 1,
    maxItems: 256,
  }),
  constraints: Type.Array(DraftStatementItemV1Schema, { maxItems: 64 }),
  non_goals: Type.Array(DraftStatementItemV1Schema, { maxItems: 32 }),
  assumptions: Type.Array(DraftStatementItemV1Schema, { maxItems: 64 }),
  risks: Type.Array(DraftRiskV1Schema, { maxItems: 64 }),
  open_questions: Type.Array(DraftQuestionV1Schema, { maxItems: 64 }),
  standards_status: Type.Array(DraftStandardV1Schema, { maxItems: 64 }),
  source_coverage: Type.Array(DraftSourceCoverageV1Schema, { minItems: 1, maxItems: 128 }),
  supersession_intents: Type.Array(DraftSupersessionIntentV1Schema, { maxItems: 512 }),
  planning_readiness_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  confidence: ConfidenceSchema,
};

export const SpecificationCoreV1Schema = Type.Object(SpecificationCoreProperties, {
  additionalProperties: false,
});
export type SpecificationCoreV1 = Readonly<Static<typeof SpecificationCoreV1Schema>>;

export const SpecificationDraftV1Schema = Type.Object(
  {
    specification_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_SPECIFICATION_PROSE_BYTES,
      multiline: true,
    }),
    ...SpecificationCoreProperties,
  },
  { additionalProperties: false }
);
export type SpecificationDraftV1 = Readonly<Static<typeof SpecificationDraftV1Schema>>;

// V2 transport keeps the V1 semantic core but removes the ignored reverse relation.
const DraftSourceCoverageV2Schema = Type.Object(
  {
    source_item_index: DraftSourceCoverageV1Schema.properties.source_item_index,
    disposition: DraftSourceCoverageV1Schema.properties.disposition,
    rationale: DraftSourceCoverageV1Schema.properties.rationale,
  },
  { additionalProperties: false }
);
export const SpecificationCoreForDraftV2Schema = Type.Object(
  {
    ...SpecificationCoreProperties,
    source_coverage: Type.Array(DraftSourceCoverageV2Schema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);
const DefinitionSupportLocatorV1Schema = Type.Union([
  Type.Object(
    { kind: Type.Literal("json_pointer"), pointer: TextSchema({ minBytes: 0, maxBytes: 1_024 }) },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("utf8_byte_range"),
      start: Type.Integer({ minimum: 0 }),
      end_exclusive: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false }
  ),
]);
export const DefinitionSupportSelectorV1Schema = Type.Object(
  {
    support_slot: Type.Integer({ minimum: 0, maximum: 68 }),
    locator: DefinitionSupportLocatorV1Schema,
  },
  { additionalProperties: false }
);
const SupportSelectorsV1Schema = Type.Array(DefinitionSupportSelectorV1Schema, { maxItems: 16 });
export const DefinitionSupportClaimV1Schema = Type.Union([
  Type.Object(
    {
      target: Type.Object(
        {
          kind: Type.Literal("request_uncertainty"),
          source_item_index: Type.Integer({ minimum: 0, maximum: 127 }),
        },
        { additionalProperties: false }
      ),
      status: Type.Union([
        Type.Literal("resolved"),
        Type.Literal("pending"),
        Type.Literal("declined"),
      ]),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      target: Type.Object(
        { kind: Type.Literal("discovered_question"), question_id: OpaqueIdSchema },
        { additionalProperties: false }
      ),
      status: Type.Union([
        Type.Literal("resolved"),
        Type.Literal("pending"),
        Type.Literal("declined"),
      ]),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      target: Type.Object(
        {
          kind: Type.Literal("standard"),
          standard_index: Type.Integer({ minimum: 0, maximum: 63 }),
        },
        { additionalProperties: false }
      ),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
]);
export const SpecificationDraftV2Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    specification_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_SPECIFICATION_PROSE_BYTES,
      multiline: true,
    }),
    specification: SpecificationCoreForDraftV2Schema,
    support_claims: Type.Array(DefinitionSupportClaimV1Schema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type SpecificationDraftV2 = Readonly<Static<typeof SpecificationDraftV2Schema>>;

// V3 gives authored rows stable, draft-local identities. These keys are discarded at
// sealing; canonical SpecificationV1 item IDs remain host-derived from semantic content.
const DraftKeySchema = OpaqueIdSchema;
const DraftStatementItemV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    statement: DraftStatementItemV1Schema.properties.statement,
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftObjectiveV3Schema = DraftStatementItemV3Schema;
const DraftRequirementV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    statement: DraftRequirementV1Schema.properties.statement,
    category: DraftRequirementV1Schema.properties.category,
    priority: DraftRequirementV1Schema.properties.priority,
    objective_keys: Type.Array(DraftKeySchema, {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftAcceptanceCriterionV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    statement: DraftAcceptanceCriterionV1Schema.properties.statement,
    observation: DraftAcceptanceCriterionV1Schema.properties.observation,
    requirement_keys: Type.Array(DraftKeySchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftRiskV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    statement: DraftRiskV1Schema.properties.statement,
    impact: DraftRiskV1Schema.properties.impact,
    mitigation: DraftRiskV1Schema.properties.mitigation,
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftQuestionV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    question: DraftQuestionV1Schema.properties.question,
    owner: DraftQuestionV1Schema.properties.owner,
    blocking: DraftQuestionV1Schema.properties.blocking,
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftStandardV3Schema = Type.Object(
  {
    draft_key: DraftKeySchema,
    category: DraftStandardV1Schema.properties.category,
    standard: DraftStandardV1Schema.properties.standard,
    status: DraftStandardV1Schema.properties.status,
    rationale: DraftStandardV1Schema.properties.rationale,
    evidence_artifact_slots: DraftStandardV1Schema.properties.evidence_artifact_slots,
    source_item_indexes: DraftSourceIndexesSchema,
  },
  { additionalProperties: false }
);
const DraftProductItemRefV3Schema = Type.Object(
  { kind: ProductItemKindV1Schema, draft_key: DraftKeySchema },
  { additionalProperties: false }
);
const DraftSupersessionIntentV3Schema = Type.Object(
  {
    prior_item_id: OpaqueIdSchema,
    replacement: Type.Union([DraftProductItemRefV3Schema, Type.Null()]),
    reason: DraftSupersessionIntentV1Schema.properties.reason,
  },
  { additionalProperties: false }
);
export const SpecificationCoreForDraftV3Schema = Type.Object(
  {
    ...SpecificationCoreProperties,
    objectives: Type.Array(DraftObjectiveV3Schema, { minItems: 1, maxItems: 24 }),
    requirements: Type.Array(DraftRequirementV3Schema, { minItems: 1, maxItems: 128 }),
    acceptance_criteria: Type.Array(DraftAcceptanceCriterionV3Schema, {
      minItems: 1,
      maxItems: 256,
    }),
    constraints: Type.Array(DraftStatementItemV3Schema, { maxItems: 64 }),
    non_goals: Type.Array(DraftStatementItemV3Schema, { maxItems: 32 }),
    assumptions: Type.Array(DraftStatementItemV3Schema, { maxItems: 64 }),
    risks: Type.Array(DraftRiskV3Schema, { maxItems: 64 }),
    open_questions: Type.Array(DraftQuestionV3Schema, { maxItems: 64 }),
    standards_status: Type.Array(DraftStandardV3Schema, { maxItems: 64 }),
    source_coverage: Type.Array(DraftSourceCoverageV2Schema, { minItems: 1, maxItems: 128 }),
    supersession_intents: Type.Array(DraftSupersessionIntentV3Schema, { maxItems: 512 }),
  },
  { additionalProperties: false }
);
export const DefinitionSupportClaimV2Schema = Type.Union([
  Type.Object(
    {
      target: Type.Object(
        {
          kind: Type.Literal("request_uncertainty"),
          source_item_index: Type.Integer({ minimum: 0, maximum: 127 }),
        },
        { additionalProperties: false }
      ),
      status: Type.Union([
        Type.Literal("resolved"),
        Type.Literal("pending"),
        Type.Literal("declined"),
      ]),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      target: Type.Object(
        { kind: Type.Literal("discovered_question"), question_id: OpaqueIdSchema },
        { additionalProperties: false }
      ),
      status: Type.Union([
        Type.Literal("resolved"),
        Type.Literal("pending"),
        Type.Literal("declined"),
      ]),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      target: Type.Object(
        { kind: Type.Literal("standard"), standard_key: DraftKeySchema },
        { additionalProperties: false }
      ),
      claim: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
      support: SupportSelectorsV1Schema,
    },
    { additionalProperties: false }
  ),
]);
export const SpecificationDraftV3Schema = Type.Object(
  {
    schema_version: Type.Literal(3),
    specification_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_SPECIFICATION_PROSE_BYTES,
      multiline: true,
    }),
    specification: SpecificationCoreForDraftV3Schema,
    support_claims: Type.Array(DefinitionSupportClaimV2Schema, { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type SpecificationDraftV3 = Readonly<Static<typeof SpecificationDraftV3Schema>>;

const SpecificationDraftRepairOperationV1Schema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("add_acceptance_criterion"),
      criterion: DraftAcceptanceCriterionV3Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("replace_acceptance_criterion"),
      criterion_key: DraftKeySchema,
      criterion: DraftAcceptanceCriterionV3Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { operation: Type.Literal("remove_acceptance_criterion"), criterion_key: DraftKeySchema },
    { additionalProperties: false }
  ),
]);
export const SpecificationDraftRepairV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.specification-draft-repair.v1"),
    schema_version: Type.Literal(1),
    base_draft_ref: ArtifactRefSchema,
    base_draft_sha256: Sha256Schema,
    diagnostic_ref: ArtifactRefSchema,
    operations: Type.Array(SpecificationDraftRepairOperationV1Schema, {
      minItems: 1,
      maxItems: 64,
    }),
  },
  { additionalProperties: false }
);
export type SpecificationDraftRepairV1 = Readonly<Static<typeof SpecificationDraftRepairV1Schema>>;

/** The trace retains all selectors; the V1 product carries up to its four exact evidence IDs. */
function v2StandardEvidenceIds(
  draft: SpecificationDraftV2,
  admission?: EvidenceAdmissionV2
): readonly (readonly string[])[] | undefined {
  if (admission === undefined) return undefined;
  return draft.specification.standards_status.map((_, index) => {
    const claim = draft.support_claims.find(
      (row) => row.target.kind === "standard" && row.target.standard_index === index
    );
    const refs =
      claim?.support.map(
        (selector) => admission.support_slots[selector.support_slot]?.ref.artifact_id
      ) ?? [];
    if (refs.some((ref) => ref === undefined))
      throw draftFailure("SEMANTIC_INVALID", "standard support slot is absent");
    return sortedStrings(
      [...new Set(refs.filter((ref): ref is string => ref !== undefined))].slice(0, 4)
    );
  });
}

/** Checks an exact captured artifact; never resolves external paths or URLs. */
export function checkDefinitionSupportLocator(value: unknown, bytes: Uint8Array): void {
  const locator = validateSkillSchema(
    DefinitionSupportLocatorV1Schema,
    value,
    "DefinitionSupportLocatorV1"
  );
  if (locator.kind === "utf8_byte_range") {
    const { start, end_exclusive } = locator;
    if (end_exclusive <= start || end_exclusive - start > 16_384 || end_exclusive > bytes.length) {
      throw new Error("support byte range is outside the exact artifact or excerpt bound");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(bytes.subarray(start, end_exclusive));
    return;
  }
  const pointer = locator.pointer;
  if (pointer !== "" && (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))) {
    throw new Error("support JSON pointer is malformed");
  }
  let node: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= node.length) {
        throw new Error("support JSON pointer does not exist");
      }
      node = node[Number(key)];
    } else if (node !== null && typeof node === "object" && Object.hasOwn(node, key)) {
      const member: unknown = Reflect.get(node, key);
      node = member;
    } else {
      throw new Error("support JSON pointer does not exist");
    }
  }
  if (Buffer.byteLength(canonicalJson(node), "utf8") > 16_384) {
    throw new Error("support JSON pointer excerpt exceeds its bound");
  }
}

export function parseSpecificationDraftV2Shape(value: unknown): SpecificationDraftV2 {
  const draft = validateSkillSchema(SpecificationDraftV2Schema, value, "SpecificationDraftV2");
  let questions = 0;
  let standards = 0;
  const targets = new Set<string>();
  for (const entry of draft.support_claims) {
    const key = canonicalJson(entry.target);
    if (targets.has(key)) throw new Error("SpecificationDraftV2 duplicate support claim target");
    targets.add(key);
    if (entry.target.kind === "standard") standards += 1;
    else questions += 1;
    const selectors = new Set<string>();
    for (const selector of entry.support) {
      const selectorKey = canonicalJson(selector);
      if (selectors.has(selectorKey))
        throw new Error("SpecificationDraftV2 duplicate support selector");
      selectors.add(selectorKey);
      if (
        selector.locator.kind === "utf8_byte_range" &&
        (selector.locator.end_exclusive <= selector.locator.start ||
          selector.locator.end_exclusive - selector.locator.start > 16_384)
      ) {
        throw new Error("SpecificationDraftV2 support byte range exceeds the excerpt bound");
      }
      if (
        selector.locator.kind === "json_pointer" &&
        selector.locator.pointer !== "" &&
        (!selector.locator.pointer.startsWith("/") || /~(?![01])/u.test(selector.locator.pointer))
      ) {
        throw new Error("SpecificationDraftV2 support JSON pointer is malformed");
      }
    }
  }
  if (questions > 64 || standards > 64)
    throw new Error("SpecificationDraftV2 support target count exceeds its bound");
  return draft;
}

function draftKeyPath(kind: string, key: string, field?: string): string {
  return `/specification/${kind}/by-key/${key}${field === undefined ? "" : `/${field}`}`;
}

function boundedIssueContext(value: string): string {
  const normalized = value.replaceAll("\n", " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function v3CollectionKeys(
  draft: SpecificationDraftV3
): Readonly<Record<string, readonly string[]>> {
  return {
    objectives: draft.specification.objectives.map((entry) => entry.draft_key),
    requirements: draft.specification.requirements.map((entry) => entry.draft_key),
    acceptance_criteria: draft.specification.acceptance_criteria.map((entry) => entry.draft_key),
    constraints: draft.specification.constraints.map((entry) => entry.draft_key),
    non_goals: draft.specification.non_goals.map((entry) => entry.draft_key),
    assumptions: draft.specification.assumptions.map((entry) => entry.draft_key),
    risks: draft.specification.risks.map((entry) => entry.draft_key),
    open_questions: draft.specification.open_questions.map((entry) => entry.draft_key),
    standards_status: draft.specification.standards_status.map((entry) => entry.draft_key),
  };
}

function v3DraftSealIssues(
  draft: SpecificationDraftV3,
  request: DefinitionRequestV1
): readonly SpecificationDraftSealIssueV1[] {
  const issues: SpecificationDraftSealIssueV1[] = [];
  const add = (
    code: string,
    path: string,
    detail: string,
    sourceOrdinals: readonly number[] = []
  ) =>
    issues.push({ code, path, detail, source_ordinals: [...sourceOrdinals].sort((a, b) => a - b) });
  const keys = v3CollectionKeys(draft);
  for (const [collection, values] of Object.entries(keys)) {
    const seen = new Set<string>();
    values.forEach((key) => {
      if (seen.has(key)) {
        add(
          "DUPLICATE_DRAFT_KEY",
          draftKeyPath(collection, key),
          `Draft key '${key}' occurs more than once in ${collection}.`
        );
      }
      seen.add(key);
    });
  }
  const objectiveKeys = new Set(keys.objectives ?? []);
  for (const requirement of draft.specification.requirements) {
    for (const key of requirement.objective_keys) {
      if (!objectiveKeys.has(key)) {
        add(
          "UNKNOWN_OBJECTIVE_KEY",
          draftKeyPath("requirements", requirement.draft_key, "objective_keys"),
          `Requirement '${requirement.draft_key}' references unknown objective key '${key}'.`
        );
      }
    }
  }
  const requirementKeys = new Set(keys.requirements ?? []);
  const covered = new Set<string>();
  for (const criterion of draft.specification.acceptance_criteria) {
    for (const key of criterion.requirement_keys) {
      if (!requirementKeys.has(key)) {
        add(
          "UNKNOWN_REQUIREMENT_KEY",
          draftKeyPath("acceptance_criteria", criterion.draft_key, "requirement_keys"),
          `Acceptance criterion '${criterion.draft_key}' references unknown requirement key '${key}'.`
        );
      } else {
        covered.add(key);
      }
    }
  }
  for (const requirement of draft.specification.requirements) {
    if (!covered.has(requirement.draft_key)) {
      add(
        "UNCOVERED_REQUIREMENT",
        draftKeyPath("requirements", requirement.draft_key, "acceptance_coverage"),
        `Requirement '${requirement.draft_key}' has no acceptance criterion: ${boundedIssueContext(requirement.statement)}`,
        requirement.source_item_indexes
      );
    }
  }
  const collectionForKind = (kind: Static<typeof ProductItemKindV1Schema>): readonly string[] => {
    switch (kind) {
      case "objective":
        return keys.objectives ?? [];
      case "requirement":
        return keys.requirements ?? [];
      case "acceptance_criterion":
        return keys.acceptance_criteria ?? [];
      case "constraint":
        return keys.constraints ?? [];
      case "non_goal":
        return keys.non_goals ?? [];
      case "assumption":
        return keys.assumptions ?? [];
      case "risk":
        return keys.risks ?? [];
      case "open_question":
        return keys.open_questions ?? [];
      case "standard":
        return keys.standards_status ?? [];
    }
  };
  for (const intent of draft.specification.supersession_intents) {
    if (
      intent.replacement !== null &&
      !collectionForKind(intent.replacement.kind).includes(intent.replacement.draft_key)
    ) {
      add(
        "UNKNOWN_REPLACEMENT_KEY",
        `/specification/supersession_intents/${intent.prior_item_id}/replacement`,
        `Supersession for '${intent.prior_item_id}' references unknown ${intent.replacement.kind} key '${intent.replacement.draft_key}'.`
      );
    }
  }
  const standardKeys = new Set(keys.standards_status ?? []);
  for (const claim of draft.support_claims) {
    if (claim.target.kind === "standard" && !standardKeys.has(claim.target.standard_key)) {
      add(
        "UNKNOWN_STANDARD_KEY",
        `/support_claims/standard/${claim.target.standard_key}`,
        `Support claim references unknown standard key '${claim.target.standard_key}'.`
      );
    }
  }
  const sources = definitionRequestSourceItems(request);
  const sourceCount = sources.length;
  const itemLinks = new Map<number, number>();
  const itemCollections = [
    draft.specification.objectives,
    draft.specification.requirements,
    draft.specification.acceptance_criteria,
    draft.specification.constraints,
    draft.specification.non_goals,
    draft.specification.assumptions,
    draft.specification.risks,
    draft.specification.open_questions,
    draft.specification.standards_status,
  ];
  for (const collection of itemCollections) {
    for (const item of collection) {
      for (const ordinal of item.source_item_indexes) {
        if (ordinal >= sourceCount) {
          add(
            "OUT_OF_RANGE_SOURCE_ORDINAL",
            `/specification/source_links/${ordinal}`,
            `Product item references source ordinal ${ordinal}, but source_count is ${sourceCount}.`,
            [ordinal]
          );
        } else {
          itemLinks.set(ordinal, (itemLinks.get(ordinal) ?? 0) + 1);
        }
      }
    }
  }
  const coverageRows = new Map<
    number,
    SpecificationDraftV3["specification"]["source_coverage"][number]
  >();
  draft.specification.source_coverage.forEach((row, index) => {
    if (row.source_item_index >= sourceCount) {
      add(
        "OUT_OF_RANGE_SOURCE_ORDINAL",
        `/specification/source_coverage/${index}/source_item_index`,
        `Source coverage ordinal ${row.source_item_index} is outside source_count ${sourceCount}.`,
        [row.source_item_index]
      );
      return;
    }
    if (coverageRows.has(row.source_item_index)) {
      add(
        "DUPLICATE_SOURCE_ORDINAL",
        `/specification/source_coverage/${index}/source_item_index`,
        `Source coverage repeats ordinal ${row.source_item_index}.`,
        [row.source_item_index]
      );
      return;
    }
    coverageRows.set(row.source_item_index, row);
  });
  for (const source of sources) {
    const row = coverageRows.get(source.ordinal);
    if (row === undefined) {
      add(
        "MISSING_SOURCE_ORDINAL",
        `/specification/source_coverage/by-ordinal/${source.ordinal}`,
        `Source coverage omits ordinal ${source.ordinal} (${source.kind}).`,
        [source.ordinal]
      );
      continue;
    }
    const linkCount = itemLinks.get(source.ordinal) ?? 0;
    if (row.disposition === "incorporated" && linkCount === 0) {
      add(
        "UNLINKED_INCORPORATED_SOURCE",
        `/specification/source_coverage/by-ordinal/${source.ordinal}/disposition`,
        `Incorporated source ordinal ${source.ordinal} (${source.kind}) has no item-side linkage.`,
        [source.ordinal]
      );
    }
    if (row.disposition !== "incorporated" && linkCount > 0) {
      add(
        "LINKED_NONINCORPORATED_SOURCE",
        `/specification/source_coverage/by-ordinal/${source.ordinal}/disposition`,
        `${row.disposition} source ordinal ${source.ordinal} (${source.kind}) is linked from ${linkCount} product item(s).`,
        [source.ordinal]
      );
    }
  }
  const unique = new Map<string, SpecificationDraftSealIssueV1>();
  for (const issue of issues) {
    unique.set(canonicalJson([issue.code, issue.path, issue.source_ordinals]), issue);
  }
  return [...unique.values()].sort((left, right) =>
    canonicalJson([left.code, left.path, left.source_ordinals]).localeCompare(
      canonicalJson([right.code, right.path, right.source_ordinals])
    )
  );
}

function v3CompatibilityDraft(draft: SpecificationDraftV3): SpecificationDraftV2 {
  const objectiveIndex = new Map(
    draft.specification.objectives.map((entry, index) => [entry.draft_key, index] as const)
  );
  const requirementIndex = new Map(
    draft.specification.requirements.map((entry, index) => [entry.draft_key, index] as const)
  );
  const standardIndex = new Map(
    draft.specification.standards_status.map((entry, index) => [entry.draft_key, index] as const)
  );
  const replacementIndex = new Map<string, number>();
  for (const [kind, entries] of Object.entries(v3CollectionKeys(draft))) {
    const wireKind =
      kind === "objectives"
        ? "objective"
        : kind === "requirements"
          ? "requirement"
          : kind === "acceptance_criteria"
            ? "acceptance_criterion"
            : kind === "constraints"
              ? "constraint"
              : kind === "non_goals"
                ? "non_goal"
                : kind === "assumptions"
                  ? "assumption"
                  : kind === "risks"
                    ? "risk"
                    : kind === "open_questions"
                      ? "open_question"
                      : "standard";
    entries.forEach((key, index) => replacementIndex.set(`${wireKind}:${key}`, index));
  }
  const indexFor = (map: ReadonlyMap<string, number>, key: string, label: string): number => {
    const value = map.get(key);
    if (value === undefined) throw new Error(`${label} '${key}' is absent`);
    return value;
  };
  const stripStatement = (entry: Static<typeof DraftStatementItemV3Schema>) => ({
    statement: entry.statement,
    source_item_indexes: entry.source_item_indexes,
  });
  const specification: SpecificationDraftV2["specification"] = {
    ...draft.specification,
    objectives: draft.specification.objectives.map(stripStatement),
    requirements: draft.specification.requirements.map((entry) => ({
      statement: entry.statement,
      category: entry.category,
      priority: entry.priority,
      objective_indexes: entry.objective_keys.map((key) =>
        indexFor(objectiveIndex, key, "objective key")
      ),
      source_item_indexes: entry.source_item_indexes,
    })),
    acceptance_criteria: draft.specification.acceptance_criteria.map((entry) => ({
      statement: entry.statement,
      observation: entry.observation,
      requirement_indexes: entry.requirement_keys.map((key) =>
        indexFor(requirementIndex, key, "requirement key")
      ),
      source_item_indexes: entry.source_item_indexes,
    })),
    constraints: draft.specification.constraints.map(stripStatement),
    non_goals: draft.specification.non_goals.map(stripStatement),
    assumptions: draft.specification.assumptions.map(stripStatement),
    risks: draft.specification.risks.map((entry) => ({
      statement: entry.statement,
      impact: entry.impact,
      mitigation: entry.mitigation,
      source_item_indexes: entry.source_item_indexes,
    })),
    open_questions: draft.specification.open_questions.map((entry) => ({
      question: entry.question,
      owner: entry.owner,
      blocking: entry.blocking,
      source_item_indexes: entry.source_item_indexes,
    })),
    standards_status: draft.specification.standards_status.map((entry) => ({
      category: entry.category,
      standard: entry.standard,
      status: entry.status,
      rationale: entry.rationale,
      evidence_artifact_slots: entry.evidence_artifact_slots,
      source_item_indexes: entry.source_item_indexes,
    })),
    supersession_intents: draft.specification.supersession_intents.map((entry) => ({
      prior_item_id: entry.prior_item_id,
      replacement:
        entry.replacement === null
          ? null
          : {
              kind: entry.replacement.kind,
              index: indexFor(
                replacementIndex,
                `${entry.replacement.kind}:${entry.replacement.draft_key}`,
                "replacement key"
              ),
            },
      reason: entry.reason,
    })),
  };
  const support_claims: SpecificationDraftV2["support_claims"] = draft.support_claims.map(
    (claim) => {
      if (claim.target.kind === "standard") {
        return {
          target: {
            kind: "standard" as const,
            standard_index: indexFor(standardIndex, claim.target.standard_key, "standard key"),
          },
          claim: claim.claim,
          support: claim.support,
        };
      }
      if (!("status" in claim) || !("rationale" in claim)) {
        throw new Error("question support claim lacks status or rationale");
      }
      if (claim.target.kind === "request_uncertainty") {
        return {
          target: {
            kind: "request_uncertainty" as const,
            source_item_index: claim.target.source_item_index,
          },
          status: claim.status,
          claim: claim.claim,
          rationale: claim.rationale,
          support: claim.support,
        };
      }
      if (claim.target.kind !== "discovered_question") {
        throw new Error("question support claim target is invalid");
      }
      return {
        target: {
          kind: "discovered_question" as const,
          question_id: claim.target.question_id,
        },
        status: claim.status,
        claim: claim.claim,
        rationale: claim.rationale,
        support: claim.support,
      };
    }
  );
  return parseSpecificationDraftV2Shape({
    schema_version: 2,
    specification_report: draft.specification_report,
    specification,
    support_claims,
  });
}

export function parseSpecificationDraftV3Shape(value: unknown): SpecificationDraftV3 {
  return validateSkillSchema(SpecificationDraftV3Schema, value, "SpecificationDraftV3");
}

export type SpecificationDraftFailureClassV1 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "PROJECTION_INVALID";

export const SpecificationCoverageIssueV1Schema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("MISSING_SOURCE_ORDINAL"),
      Type.Literal("DUPLICATE_SOURCE_ORDINAL"),
      Type.Literal("OUT_OF_RANGE_SOURCE_ORDINAL"),
    ]),
    path: TextSchema({ minBytes: 1, maxBytes: 256 }),
    ordinal: Type.Integer({ minimum: 0, maximum: 127 }),
    kind: Type.Union([SourceItemKindV1Schema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type SpecificationCoverageIssueV1 = Readonly<
  Static<typeof SpecificationCoverageIssueV1Schema>
>;

export interface SpecificationDraftSealIssueV1 {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly source_ordinals: readonly number[];
}

export class SpecificationDraftValidationError extends Error {
  constructor(
    readonly failureClass: SpecificationDraftFailureClassV1,
    readonly issues: readonly string[],
    readonly coverageIssues: readonly SpecificationCoverageIssueV1[] = [],
    readonly sealIssues: readonly SpecificationDraftSealIssueV1[] = []
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "SpecificationDraftValidationError";
  }
}

export const SpecificationSealFeedbackV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.specification-seal-feedback.v1"),
    schema_version: Type.Literal(1),
    // Diagnostic revision is telemetry, not a product-epoch or correction allowance.
    attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    rejected_draft_artifact_id: ArtifactIdSchema,
    failure_class: Type.Union([
      Type.Literal("FRAMING_INVALID"),
      Type.Literal("JSON_INVALID"),
      Type.Literal("SCHEMA_INVALID"),
      Type.Literal("SEMANTIC_INVALID"),
      Type.Literal("PROJECTION_INVALID"),
    ]),
    issues: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512 }), {
      minItems: 1,
      maxItems: 1_024,
    }),
    // Optional for exact replay of previously sealed V1 feedback artifacts.
    coverage_issues: Type.Optional(
      Type.Array(SpecificationCoverageIssueV1Schema, { maxItems: 256 })
    ),
  },
  { additionalProperties: false }
);
export type SpecificationSealFeedbackV1 = Readonly<
  Static<typeof SpecificationSealFeedbackV1Schema>
>;

const ItemSourceIdsSchema = Type.Array(OpaqueIdSchema, {
  minItems: 1,
  maxItems: 64,
  uniqueItems: true,
});
const SpecificationStatementItemV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
const SpecificationRequirementV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    category: OpaqueIdSchema,
    priority: Type.Union([Type.Literal("must"), Type.Literal("should"), Type.Literal("may")]),
    objective_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 24, uniqueItems: true }),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
const SpecificationAcceptanceCriterionV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    observation: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    requirement_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
const SpecificationRiskV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    statement: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    impact: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    mitigation: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
const SpecificationQuestionV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    question: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    owner: Type.Union([Type.Literal("caller"), Type.Literal("evidence")]),
    blocking: Type.Boolean(),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
const SpecificationStandardV1Schema = Type.Object(
  {
    item_id: OpaqueIdSchema,
    category: OpaqueIdSchema,
    standard: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
    status: StandardStatusV1Schema,
    rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
    evidence_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_DEFINE_INPUTS,
      uniqueItems: true,
    }),
    source_item_ids: ItemSourceIdsSchema,
  },
  { additionalProperties: false }
);
// A single admitted source may legitimately support every semantic item. These collection
// maxima are the closed SpecificationCoreV1 capacities: 24 + 128 + 256 + 64 + 32 +
// 64 + 64 + 64 + 64 = 760. The reciprocal host-derived index must represent that relation.
export const MAX_SPECIFICATION_SEMANTIC_ITEMS = 760;

const SpecificationSourceCoverageV1Schema = Type.Object(
  {
    source_item_id: OpaqueIdSchema,
    disposition: Type.Union([
      Type.Literal("incorporated"),
      Type.Literal("excluded"),
      Type.Literal("unresolved"),
    ]),
    product_item_ids: Type.Array(OpaqueIdSchema, {
      maxItems: MAX_SPECIFICATION_SEMANTIC_ITEMS,
      uniqueItems: true,
    }),
    rationale: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
  },
  { additionalProperties: false }
);
const SpecificationSupersessionV1Schema = Type.Object(
  {
    prior_item_id: OpaqueIdSchema,
    replacement_item_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    reason: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: true }),
  },
  { additionalProperties: false }
);
const PlanningHandoffV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    planning_ready: Type.Boolean(),
    planning_readiness_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
    objective_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 24, uniqueItems: true }),
    requirement_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 128, uniqueItems: true }),
    acceptance_criterion_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 256,
      uniqueItems: true,
    }),
    constraint_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    non_goal_ids: Type.Array(OpaqueIdSchema, { maxItems: 32, uniqueItems: true }),
    assumption_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    risk_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    blocking_question_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    standard_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
  },
  { additionalProperties: false }
);
const SpecificationLineagePreimageV1Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    draft_artifact_id: ArtifactIdSchema,
    draft_sha256: Sha256Schema,
    input_artifact_ids: Type.Array(ArtifactIdSchema, {
      maxItems: MAX_DEFINE_INPUTS,
      uniqueItems: true,
    }),
    prior_specification_artifact_id: Type.Union([ArtifactIdSchema, Type.Null()]),
    prior_specification_id: Type.Union([OpaqueIdSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export const SpecificationLineageV1Schema = Type.Object(
  {
    ...SpecificationLineagePreimageV1Schema.properties,
    lineage_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const SpecificationSemanticProperties = {
  disposition: SpecificationDispositionV1Schema,
  applicability_reason: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  profile: ProfileBindingV1Schema,
  title: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
  summary: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }),
  audiences: Type.Array(TextSchema({ minBytes: 1, maxBytes: 1_024, multiline: true }), {
    maxItems: 16,
    uniqueItems: true,
  }),
  scope: SpecificationCoreV1Schema.properties.scope,
  source_items: Type.Array(DefinitionSourceItemV1Schema, { minItems: 1, maxItems: 128 }),
  objectives: Type.Array(SpecificationStatementItemV1Schema, { minItems: 1, maxItems: 24 }),
  requirements: Type.Array(SpecificationRequirementV1Schema, { minItems: 1, maxItems: 128 }),
  acceptance_criteria: Type.Array(SpecificationAcceptanceCriterionV1Schema, {
    minItems: 1,
    maxItems: 256,
  }),
  constraints: Type.Array(SpecificationStatementItemV1Schema, { maxItems: 64 }),
  non_goals: Type.Array(SpecificationStatementItemV1Schema, { maxItems: 32 }),
  assumptions: Type.Array(SpecificationStatementItemV1Schema, { maxItems: 64 }),
  risks: Type.Array(SpecificationRiskV1Schema, { maxItems: 64 }),
  open_questions: Type.Array(SpecificationQuestionV1Schema, { maxItems: 64 }),
  standards_status: Type.Array(SpecificationStandardV1Schema, { maxItems: 64 }),
  source_coverage: Type.Array(SpecificationSourceCoverageV1Schema, {
    minItems: 1,
    maxItems: 128,
  }),
  supersession: Type.Array(SpecificationSupersessionV1Schema, { maxItems: 512 }),
  supersedes_specification_ids: Type.Array(OpaqueIdSchema, {
    maxItems: 1,
    uniqueItems: true,
  }),
  planning_handoff: PlanningHandoffV1Schema,
  confidence: ConfidenceSchema,
  planning_started: Type.Literal(false),
  taskification_started: Type.Literal(false),
  execution_started: Type.Literal(false),
};

export const SpecificationV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    specification_id: OpaqueIdSchema,
    specification_report: TextSchema({
      minBytes: 1,
      maxBytes: MAX_SPECIFICATION_PROSE_BYTES,
      multiline: true,
    }),
    ...SpecificationSemanticProperties,
    request: DefinitionRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: SpecificationLineageV1Schema,
  },
  { additionalProperties: false }
);
export type SpecificationV1 = Readonly<Static<typeof SpecificationV1Schema>>;

const SpecificationRoutingSummaryV1Schema = Type.Object(
  {
    confidence: ConfidenceSchema,
    complete: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type SpecificationRoutingSummaryV1 = Readonly<
  Static<typeof SpecificationRoutingSummaryV1Schema>
>;

export const SpecificationProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.specification-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Sha256Schema,
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    specification_assurance_ref: Type.Optional(ArtifactRefSchema),
    frame_ref: ArtifactRefSchema,
    orientation_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_DEFINE_INPUTS }),
    draft_ref: ArtifactRefSchema,
    specification_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 4,
      maxItems: 32,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_specification"),
        Type.Literal("exact_lineage"),
        Type.Literal("profile_semantics"),
        Type.Literal("complete_source_coverage"),
        Type.Literal("revision_supersession"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("latest_validity_receipt"),
        Type.Literal("latest_quality_receipt"),
        Type.Literal("no_planning_taskification_or_execution"),
      ]),
      { minItems: 9, maxItems: 9, uniqueItems: true }
    ),
    planning_started: Type.Literal(false),
    taskification_started: Type.Literal(false),
    execution_started: Type.Literal(false),
    execution_authorized: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type SpecificationProductIntegrityV1 = Readonly<
  Static<typeof SpecificationProductIntegrityV1Schema>
>;

export const SpecificationProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.specification-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Sha256Schema,
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    request_ref: ArtifactRefSchema,
    specification_assurance_ref: Type.Optional(ArtifactRefSchema),
    frame_ref: ArtifactRefSchema,
    orientation_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 1 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_DEFINE_INPUTS }),
    draft_ref: ArtifactRefSchema,
    specification_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type SpecificationProductEnvelopeV1 = Readonly<
  Static<typeof SpecificationProductEnvelopeV1Schema>
>;

/** Trace-bound successors; V1 schemas/readers remain unchanged for historical runs. */
export const SpecificationProductIntegrityV2Schema = Type.Object(
  {
    ...SpecificationProductIntegrityV1Schema.properties,
    schema_id: Type.Literal("penny.specification-product-integrity.v2"),
    schema_version: Type.Literal(2),
    trace_ref: ArtifactRefSchema,
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_specification"),
        Type.Literal("exact_lineage"),
        Type.Literal("profile_semantics"),
        Type.Literal("complete_source_coverage"),
        Type.Literal("revision_supersession"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("latest_validity_receipt"),
        Type.Literal("latest_quality_receipt"),
        Type.Literal("no_planning_taskification_or_execution"),
        Type.Literal("exact_definition_trace_and_support"),
      ]),
      { minItems: 10, maxItems: 10, uniqueItems: true }
    ),
  },
  { additionalProperties: false }
);
export type SpecificationProductIntegrityV2 = Readonly<
  Static<typeof SpecificationProductIntegrityV2Schema>
>;
export const SpecificationProductEnvelopeV2Schema = Type.Object(
  {
    ...SpecificationProductEnvelopeV1Schema.properties,
    schema_id: Type.Literal("penny.specification-product-envelope.v2"),
    schema_version: Type.Literal(2),
    trace_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type SpecificationProductEnvelopeV2 = Readonly<
  Static<typeof SpecificationProductEnvelopeV2Schema>
>;

export function specificationProductIntegrityV2Id(
  value: Omit<SpecificationProductIntegrityV2, "integrity_id">
): string {
  return sha256(canonicalJson(value));
}
export function validateSpecificationProductIntegrityV2(
  value: unknown
): SpecificationProductIntegrityV2 {
  const integrity = validateSkillSchema(
    SpecificationProductIntegrityV2Schema,
    value,
    "SpecificationProductIntegrityV2"
  );
  const expectedChecks = [
    "canonical_specification",
    "exact_lineage",
    "profile_semantics",
    "complete_source_coverage",
    "revision_supersession",
    "signed_worker_evidence",
    "latest_validity_receipt",
    "latest_quality_receipt",
    "no_planning_taskification_or_execution",
    "exact_definition_trace_and_support",
  ];
  const { integrity_id: ignored, ...body } = integrity;
  void ignored;
  if (
    canonicalJson(integrity.checks) !== canonicalJson(expectedChecks) ||
    integrity.integrity_id !== specificationProductIntegrityV2Id(body) ||
    integrity.trace_ref.kind !== "definition-trace" ||
    integrity.trace_ref.content_schema?.schema_id !== "penny.definition-trace.v1" ||
    integrity.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    integrity.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v2" ||
    (integrity.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v2" &&
      integrity.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3") ||
    integrity.validity_receipt_ref.content_schema?.schema_id !== "penny.review-receipt.v2" ||
    integrity.quality_receipt_ref.content_schema?.schema_id !== "penny.review-receipt.v2" ||
    integrity.specification_ref.content_schema?.schema_id !== "penny.specification.v1"
  ) {
    throw new Error("SpecificationProductIntegrityV2 trace, checks or identity is invalid");
  }
  assertUnique(
    [
      integrity.request_ref,
      ...(integrity.specification_assurance_ref === undefined
        ? []
        : [integrity.specification_assurance_ref]),
      integrity.frame_ref,
      integrity.orientation_ref,
      integrity.admission_ref,
      integrity.trace_ref,
      ...integrity.evidence_refs,
      ...integrity.imported_input_refs,
      integrity.draft_ref,
      integrity.specification_ref,
      integrity.vera_report_ref,
      integrity.carren_report_ref,
      integrity.validity_receipt_ref,
      integrity.quality_receipt_ref,
    ].map((ref) => ref.artifact_id),
    "SpecificationProductIntegrityV2 refs"
  );
  return integrity;
}
export function specificationProductEnvelopeV2Id(
  value: Omit<SpecificationProductEnvelopeV2, "envelope_id">
): string {
  return sha256(canonicalJson(value));
}
export function validateSpecificationProductEnvelopeV2(
  value: unknown
): SpecificationProductEnvelopeV2 {
  const envelope = validateSkillSchema(
    SpecificationProductEnvelopeV2Schema,
    value,
    "SpecificationProductEnvelopeV2"
  );
  const { envelope_id: ignored, ...body } = envelope;
  void ignored;
  if (
    envelope.envelope_id !== specificationProductEnvelopeV2Id(body) ||
    envelope.trace_ref.kind !== "definition-trace" ||
    envelope.trace_ref.content_schema?.schema_id !== "penny.definition-trace.v1" ||
    envelope.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    envelope.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v2" ||
    (envelope.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v2" &&
      envelope.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3") ||
    envelope.validity_receipt_ref.content_schema?.schema_id !== "penny.review-receipt.v2" ||
    envelope.quality_receipt_ref.content_schema?.schema_id !== "penny.review-receipt.v2" ||
    envelope.specification_ref.content_schema?.schema_id !== "penny.specification.v1" ||
    envelope.integrity_ref.content_schema?.schema_id !== "penny.specification-product-integrity.v2"
  ) {
    throw new Error("SpecificationProductEnvelopeV2 trace or identity is invalid");
  }
  assertUnique(
    [
      envelope.request_ref,
      ...(envelope.specification_assurance_ref === undefined
        ? []
        : [envelope.specification_assurance_ref]),
      envelope.frame_ref,
      envelope.orientation_ref,
      envelope.admission_ref,
      envelope.trace_ref,
      ...envelope.evidence_refs,
      ...envelope.imported_input_refs,
      envelope.draft_ref,
      envelope.specification_ref,
      envelope.vera_report_ref,
      envelope.carren_report_ref,
      envelope.validity_receipt_ref,
      envelope.quality_receipt_ref,
      envelope.integrity_ref,
    ].map((ref) => ref.artifact_id),
    "SpecificationProductEnvelopeV2 refs"
  );
  return envelope;
}

function sanitizedIssues(issues: readonly string[]): readonly string[] {
  return [
    ...new Set(
      issues.map((issue) =>
        issue.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\0", " ").trim().slice(0, 512)
      )
    ),
  ]
    .filter((issue) => issue.length > 0)
    .slice(0, 1_024);
}

function collectIssue(issues: string[], action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof SkillSchemaValidationError) issues.push(...error.issues);
    else if (error instanceof Error) issues.push(error.message);
    else issues.push("validation failed");
  }
}

function validateText(value: string, label: string, maxBytes: number, minBytes = 1): void {
  assertText(value, label, {
    minBytes,
    maxBytes,
    multiline: true,
    ...(minBytes > 0 ? { trimmedNonEmpty: true } : {}),
  });
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSorted(values: readonly string[], label: string): void {
  if (canonicalJson(values) !== canonicalJson(sortedStrings(values))) {
    throw new Error(`${label} must be in canonical order`);
  }
}

function assertCanonicalUnique(values: readonly unknown[], label: string): void {
  assertUnique(
    values.map((value) => canonicalJson(value)),
    label
  );
}

export function stableDefinitionId(namespace: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(namespace)) {
    throw new Error("stable Define ID namespace is malformed");
  }
  return `${namespace}-${sha256(canonicalJson(value))}`;
}

function definitionRequestSeed(input: {
  readonly goal: string;
  readonly constraints: DefinitionRequestConstraintsV1;
  readonly inputArtifactIds: readonly string[];
}): Omit<DefinitionRequestV1, "request_id"> {
  return {
    schema_version: 1,
    goal: input.goal,
    mode: input.constraints.mode,
    requested_profile_id: input.constraints.requested_profile_id,
    desired_outcomes: input.constraints.desired_outcomes,
    audiences: input.constraints.audiences,
    in_scope: input.constraints.in_scope,
    out_of_scope: input.constraints.out_of_scope,
    hard_constraints: input.constraints.hard_constraints,
    non_goals: input.constraints.non_goals,
    known_assumptions: input.constraints.known_assumptions,
    known_uncertainties: input.constraints.known_uncertainties,
    prior_decisions: input.constraints.prior_decisions,
    standard_hints: input.constraints.standard_hints,
    input_artifact_ids: sortedStrings(input.inputArtifactIds),
  };
}

function definitionRequestSourceCount(request: DefinitionRequestV1): number {
  return (
    1 +
    request.desired_outcomes.length +
    request.audiences.length +
    request.in_scope.length +
    request.out_of_scope.length +
    request.hard_constraints.length +
    request.non_goals.length +
    request.known_assumptions.length +
    request.known_uncertainties.length +
    request.prior_decisions.length +
    request.standard_hints.length +
    request.input_artifact_ids.length
  );
}

function validateDefinitionRequestContent(request: DefinitionRequestV1): void {
  const issues: string[] = [];
  const textValues: readonly (readonly [string, string, number])[] = [
    [request.goal, "goal", 16_384],
    ...request.desired_outcomes.map((value) => [value, "desired outcome", 4_096] as const),
    ...request.audiences.map((value) => [value, "audience", 1_024] as const),
    ...request.in_scope.map((value) => [value, "in-scope item", 4_096] as const),
    ...request.out_of_scope.map((value) => [value, "out-of-scope item", 4_096] as const),
    ...request.hard_constraints.map((value) => [value, "hard constraint", 4_096] as const),
    ...request.non_goals.map((value) => [value, "non-goal", 4_096] as const),
  ];
  for (const [value, label, maximum] of textValues) {
    collectIssue(issues, () => validateText(value, `DefinitionRequestV1 ${label}`, maximum));
  }
  for (const value of request.known_assumptions) {
    collectIssue(issues, () =>
      validateText(value.statement, "DefinitionRequestV1 assumption", 4_096)
    );
  }
  for (const value of request.known_uncertainties) {
    collectIssue(issues, () =>
      validateText(value.question, "DefinitionRequestV1 uncertainty", 4_096)
    );
  }
  for (const value of request.prior_decisions) {
    collectIssue(issues, () =>
      validateText(value.statement, "DefinitionRequestV1 prior decision", 4_096)
    );
    collectIssue(issues, () =>
      validateText(value.binding_effect, "DefinitionRequestV1 binding effect", 4_096)
    );
  }
  for (const value of request.standard_hints) {
    collectIssue(issues, () => validateText(value.standard, "DefinitionRequestV1 standard", 512));
    collectIssue(issues, () =>
      validateText(value.relevance, "DefinitionRequestV1 standard relevance", 1_024)
    );
  }
  for (const [values, label] of [
    [request.desired_outcomes, "desired outcomes"],
    [request.audiences, "audiences"],
    [request.in_scope, "in-scope items"],
    [request.out_of_scope, "out-of-scope items"],
    [request.hard_constraints, "hard constraints"],
    [request.non_goals, "non-goals"],
    [request.known_assumptions, "assumptions"],
    [request.known_uncertainties, "uncertainties"],
    [request.prior_decisions, "prior decisions"],
    [request.standard_hints, "standard hints"],
  ] as const) {
    collectIssue(issues, () => assertCanonicalUnique(values, `DefinitionRequestV1 ${label}`));
  }
  collectIssue(issues, () =>
    assertUnique(request.input_artifact_ids, "DefinitionRequestV1 input artifact IDs")
  );
  if (definitionRequestSourceCount(request) > MAX_DEFINITION_SOURCE_ITEMS) {
    issues.push(
      `DefinitionRequestV1 may derive at most ${MAX_DEFINITION_SOURCE_ITEMS} source items`
    );
  }
  if (
    canonicalJson(request.input_artifact_ids) !==
    canonicalJson(sortedStrings(request.input_artifact_ids))
  ) {
    issues.push("DefinitionRequestV1 input artifact IDs must be lexicographically sorted");
  }
  const { request_id: ignoredId, ...seed } = request;
  void ignoredId;
  if (request.request_id !== stableDefinitionId("definition-request", seed)) {
    issues.push("DefinitionRequestV1 request_id does not match its canonical seed");
  }
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SkillSchemaValidationError("DefinitionRequestV1", safe);
}

export function validateDefinitionRequest(value: unknown): DefinitionRequestV1 {
  const request = validateSkillSchema(DefinitionRequestV1Schema, value, "DefinitionRequestV1");
  validateDefinitionRequestContent(request);
  return request;
}

export function canonicalizeDefinitionRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
  readonly exactInputArtifactIds: readonly string[];
}): DefinitionRequestV1 {
  validateText(input.goal, "DefinitionRequestV1 admitted goal", 16_384);
  const constraints = validateSkillSchema(
    DefinitionRequestConstraintsV1Schema,
    input.constraints,
    "DefinitionRequestConstraintsV1"
  );
  if (input.exactInputArtifactIds.length > MAX_DEFINE_INPUTS) {
    throw new SkillSchemaValidationError("DefinitionRequestV1", [
      `at most ${MAX_DEFINE_INPUTS} exact inputs are permitted`,
    ]);
  }
  const seed = definitionRequestSeed({
    goal: input.goal,
    constraints,
    inputArtifactIds: input.exactInputArtifactIds,
  });
  return validateDefinitionRequest({
    ...seed,
    request_id: stableDefinitionId("definition-request", seed),
  });
}

export function definitionRequestConstraints(value: unknown): DefinitionRequestConstraintsV1 {
  const request = validateDefinitionRequest(value);
  return {
    schema_version: 1,
    mode: request.mode,
    requested_profile_id: request.requested_profile_id,
    desired_outcomes: request.desired_outcomes,
    audiences: request.audiences,
    in_scope: request.in_scope,
    out_of_scope: request.out_of_scope,
    hard_constraints: request.hard_constraints,
    non_goals: request.non_goals,
    known_assumptions: request.known_assumptions,
    known_uncertainties: request.known_uncertainties,
    prior_decisions: request.prior_decisions,
    standard_hints: request.standard_hints,
  };
}

export function definitionRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateDefinitionRequest(value)));
}

export function definitionSourceManifest(
  requestValue: unknown,
  requestRef: ArtifactRef
): DefinitionSourceManifestV1 {
  const request = validateDefinitionRequest(requestValue);
  const requestBytes = canonicalJson(request);
  const requestSha = sha256(requestBytes);
  if (
    requestRef.kind !== "definition-request" ||
    requestRef.phase !== "intake" ||
    requestRef.content_schema?.schema_id !== "penny.definition-request.v1" ||
    requestRef.content_schema.schema_version !== 1 ||
    requestRef.content_digest !== requestSha ||
    requestRef.byte_length !== Buffer.byteLength(requestBytes, "utf8") ||
    requestRef.store_ref !== `artifact://sha256/${requestSha}`
  ) {
    throw new Error("DefinitionSourceManifestV1 requires the exact admitted request ref");
  }
  const sources = definitionRequestSourceItems(request);
  return validateSkillSchema(
    DefinitionSourceManifestV1Schema,
    {
      schema_id: "penny.definition-source-manifest.v1",
      schema_version: 1,
      request_ref: requestRef,
      request_sha256: definitionRequestSha256(request),
      source_count: sources.length,
      sources,
    },
    "DefinitionSourceManifestV1"
  );
}

export function validateDefinitionSourceManifest(
  value: unknown,
  requestValue: unknown,
  requestRef: ArtifactRef
): DefinitionSourceManifestV1 {
  const manifest = validateSkillSchema(
    DefinitionSourceManifestV1Schema,
    value,
    "DefinitionSourceManifestV1"
  );
  if (
    canonicalJson(manifest) !== canonicalJson(definitionSourceManifest(requestValue, requestRef))
  ) {
    throw new Error(
      "DefinitionSourceManifestV1 request binding or ordered source inventory diverged"
    );
  }
  return manifest;
}

export function definitionRequestSourceItems(value: unknown): readonly DefinitionSourceItemV1[] {
  const request = validateDefinitionRequest(value);
  const seeds: { kind: Static<typeof SourceItemKindV1Schema>; value: unknown }[] = [
    { kind: "goal", value: request.goal },
    ...request.desired_outcomes.map((entry) => ({
      kind: "desired_outcome" as const,
      value: entry,
    })),
    ...request.audiences.map((entry) => ({ kind: "audience" as const, value: entry })),
    ...request.in_scope.map((entry) => ({ kind: "in_scope" as const, value: entry })),
    ...request.out_of_scope.map((entry) => ({ kind: "out_of_scope" as const, value: entry })),
    ...request.hard_constraints.map((entry) => ({
      kind: "hard_constraint" as const,
      value: entry,
    })),
    ...request.non_goals.map((entry) => ({ kind: "non_goal" as const, value: entry })),
    ...request.known_assumptions.map((entry) => ({ kind: "assumption" as const, value: entry })),
    ...request.known_uncertainties.map((entry) => ({ kind: "uncertainty" as const, value: entry })),
    ...request.prior_decisions.map((entry) => ({ kind: "prior_decision" as const, value: entry })),
    ...request.standard_hints.map((entry) => ({ kind: "standard_hint" as const, value: entry })),
    ...request.input_artifact_ids.map((entry) => ({
      kind: "input_artifact" as const,
      value: entry,
    })),
  ];
  return seeds.map((seed, ordinal) => {
    const canonicalValueSha256 = sha256(canonicalJson(seed.value));
    return validateSkillSchema(
      DefinitionSourceItemV1Schema,
      {
        source_item_id: stableDefinitionId("definition-source", {
          kind: seed.kind,
          canonical_value_sha256: canonicalValueSha256,
        }),
        kind: seed.kind,
        ordinal,
        canonical_value_sha256: canonicalValueSha256,
      },
      "DefinitionSourceItemV1"
    );
  });
}

function profileBinding(profileId: SpecificationProfileId): Static<typeof ProfileBindingV1Schema> {
  const profile = specificationProfile(profileId);
  return {
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_sha256: profile.profile_sha256,
  };
}

function assertProfileBinding(
  binding: Static<typeof ProfileBindingV1Schema>
): SpecificationProfileV1 {
  const profile = specificationProfile(binding.profile_id);
  if (
    binding.profile_version !== profile.profile_version ||
    binding.profile_sha256 !== profile.profile_sha256
  ) {
    throw new Error("specification profile binding is stale");
  }
  return validateSpecificationProfile(profile);
}

export function canonicalizeDefinitionFrame(input: {
  readonly request: unknown;
  readonly selectedProfileId: SpecificationProfileId;
  readonly profileSelectionBasis: string;
  readonly route: Static<typeof DefinitionFrameRouteV1Schema>;
  readonly routeReason: string;
  readonly clarificationQuestions?: readonly string[];
  readonly evidenceQuestions?: readonly string[];
}): DefinitionFrameV1 {
  const request = validateDefinitionRequest(input.request);
  if (
    request.requested_profile_id !== null &&
    input.selectedProfileId !== request.requested_profile_id
  ) {
    throw new Error("DefinitionFrameV1 selected profile disagrees with the requested profile");
  }
  const body = validateSkillSchema(
    DefinitionFrameBodyV1Schema,
    {
      schema_version: 1,
      request_id: request.request_id,
      profile: profileBinding(input.selectedProfileId),
      profile_selection_basis: input.profileSelectionBasis,
      route: input.route,
      route_reason: input.routeReason,
      clarification_questions: [...(input.clarificationQuestions ?? [])],
      evidence_questions: [...(input.evidenceQuestions ?? [])],
      planning_started: false,
      taskification_started: false,
      execution_started: false,
    },
    "DefinitionFrameV1 body"
  );
  return validateDefinitionFrame({
    ...body,
    frame_id: stableDefinitionId("definition-frame", body),
  });
}

export function validateDefinitionFrame(value: unknown): DefinitionFrameV1 {
  const frame = validateSkillSchema(DefinitionFrameV1Schema, value, "DefinitionFrameV1");
  assertProfileBinding(frame.profile);
  validateText(frame.profile_selection_basis, "DefinitionFrameV1 profile selection basis", 2_048);
  validateText(frame.route_reason, "DefinitionFrameV1 route reason", 2_048);
  for (const question of [...frame.clarification_questions, ...frame.evidence_questions]) {
    validateText(question, "DefinitionFrameV1 question", 2_048);
  }
  assertUnique(frame.clarification_questions, "DefinitionFrameV1 clarification questions");
  assertUnique(frame.evidence_questions, "DefinitionFrameV1 evidence questions");
  if (frame.route === "clarify" && frame.clarification_questions.length === 0) {
    throw new Error("clarification route requires at least one clarification question");
  }
  if (frame.route === "evidence" && frame.evidence_questions.length === 0) {
    throw new Error("evidence route requires at least one evidence question");
  }
  if (
    frame.route === "author" &&
    (frame.clarification_questions.length > 0 || frame.evidence_questions.length > 0)
  ) {
    throw new Error("author route cannot carry unresolved routing questions");
  }
  if (frame.route !== "clarify" && frame.clarification_questions.length > 0) {
    throw new Error("clarification questions require the clarify route");
  }
  if (frame.route !== "evidence" && frame.evidence_questions.length > 0) {
    throw new Error("evidence questions require the evidence route");
  }
  const { frame_id: ignoredId, ...body } = frame;
  void ignoredId;
  if (frame.frame_id !== stableDefinitionId("definition-frame", body)) {
    throw new Error("DefinitionFrameV1 frame_id is invalid");
  }
  return frame;
}

function specificationCoreFromDraft(draft: SpecificationDraftV1): SpecificationCoreV1 {
  const { specification_report: ignoredReport, ...core } = draft;
  void ignoredReport;
  return core;
}

function indexRange(
  issues: string[],
  indexes: readonly number[],
  length: number,
  label: string
): void {
  if (indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= length)) {
    issues.push(`${label} contains an out-of-range index`);
  }
  if (new Set(indexes).size !== indexes.length) issues.push(`${label} contains duplicate indexes`);
}

interface DraftSourceLinkedItemV1 {
  readonly source_item_indexes: readonly number[];
}

type DraftProductItemKindV1 = Static<typeof ProductItemKindV1Schema>;
type DraftProductItemRefV1 = Readonly<Static<typeof DraftProductItemRefV1Schema>>;

const DRAFT_PRODUCT_ITEM_KINDS = [
  "objective",
  "requirement",
  "acceptance_criterion",
  "constraint",
  "non_goal",
  "assumption",
  "risk",
  "open_question",
  "standard",
] as const satisfies readonly DraftProductItemKindV1[];

function draftCollections(
  core: SpecificationCoreV1
): Readonly<Record<DraftProductItemKindV1, readonly DraftSourceLinkedItemV1[]>> {
  return {
    objective: core.objectives,
    requirement: core.requirements,
    acceptance_criterion: core.acceptance_criteria,
    constraint: core.constraints,
    non_goal: core.non_goals,
    assumption: core.assumptions,
    risk: core.risks,
    open_question: core.open_questions,
    standard: core.standards_status,
  };
}

function validateDraftCoreShape(value: unknown): SpecificationCoreV1 {
  const core = validateSkillSchema(SpecificationCoreV1Schema, value, "SpecificationCoreV1");
  const issues: string[] = [];
  for (const [valueText, label, maxBytes] of [
    [core.applicability_reason, "applicability reason", 4_096],
    [core.title, "title", 512],
    [core.summary, "summary", 4_096],
    [core.planning_readiness_reason, "planning readiness reason", 4_096],
  ] as const) {
    collectIssue(issues, () => validateText(valueText, `SpecificationCoreV1 ${label}`, maxBytes));
  }
  collectIssue(issues, () => assertProfileBinding(core.profile));
  const collections = draftCollections(core);
  for (const [kind, items] of Object.entries(collections)) {
    collectIssue(issues, () => assertCanonicalUnique(items, `SpecificationCoreV1 ${kind} items`));
  }
  collectIssue(issues, () =>
    assertUnique(
      core.supersession_intents.map((entry) => entry.prior_item_id),
      "SpecificationCoreV1 supersession prior IDs"
    )
  );
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SkillSchemaValidationError("SpecificationCoreV1", safe);
  return core;
}

function allDraftItems(core: SpecificationCoreV1): readonly {
  kind: DraftProductItemKindV1;
  index: number;
  source_item_indexes: readonly number[];
}[] {
  const collections = draftCollections(core);
  return DRAFT_PRODUCT_ITEM_KINDS.flatMap((kind) =>
    collections[kind].map((item, index) => ({
      kind,
      index,
      source_item_indexes: item.source_item_indexes,
    }))
  );
}

/**
 * Project the reciprocal source index from the semantic item-side links. Keeping one
 * authoritative relation prevents model-authored forward/reverse tables from drifting while
 * preserving fail-closed coverage and disposition checks.
 */
function derivedDraftProductRefs(
  core: SpecificationCoreV1
): ReadonlyMap<number, readonly DraftProductItemRefV1[]> {
  const result = new Map<number, DraftProductItemRefV1[]>();
  for (const item of allDraftItems(core)) {
    const ref: DraftProductItemRefV1 = { kind: item.kind, index: item.index };
    for (const sourceIndex of item.source_item_indexes) {
      const refs = result.get(sourceIndex) ?? [];
      refs.push(ref);
      result.set(sourceIndex, refs);
    }
  }
  return result;
}

function draftCoverageIssues(
  core: SpecificationCoreV1,
  sources: readonly DefinitionSourceItemV1[]
): SpecificationCoverageIssueV1[] {
  const seen = new Set<number>();
  const issues: SpecificationCoverageIssueV1[] = [];
  core.source_coverage.forEach((entry, index) => {
    const ordinal = entry.source_item_index;
    const source = sources[ordinal];
    if (source === undefined) {
      issues.push({
        code: "OUT_OF_RANGE_SOURCE_ORDINAL",
        path: `source_coverage[${index}].source_item_index`,
        ordinal,
        kind: null,
      });
    } else if (seen.has(ordinal)) {
      issues.push({
        code: "DUPLICATE_SOURCE_ORDINAL",
        path: `source_coverage[${index}].source_item_index`,
        ordinal,
        kind: source.kind,
      });
    }
    seen.add(ordinal);
  });
  for (const source of sources) {
    if (!seen.has(source.ordinal))
      issues.push({
        code: "MISSING_SOURCE_ORDINAL",
        path: `source_coverage[${source.ordinal}]`,
        ordinal: source.ordinal,
        kind: source.kind,
      });
  }
  return issues;
}

function priorSpecificationItemIds(specification: SpecificationV1): readonly string[] {
  return [
    ...specification.objectives,
    ...specification.requirements,
    ...specification.acceptance_criteria,
    ...specification.constraints,
    ...specification.non_goals,
    ...specification.assumptions,
    ...specification.risks,
    ...specification.open_questions,
    ...specification.standards_status,
  ].map((entry) => entry.item_id);
}

export function validateProtectedDefinitionDraft(input: {
  readonly request: unknown;
  readonly draft: unknown;
}): void {
  const request = validateDefinitionRequest(input.request);
  assertDefinitionProtectedContentRepresentable(request);
  const draft = validateSkillSchema(
    SpecificationDraftV1Schema,
    input.draft,
    "protected Define draft"
  );
  const sources = definitionRequestSourceItems(request);
  const issues: string[] = [];
  const requireItem = (
    kind: DefinitionSourceItemV1["kind"],
    value: string,
    items: readonly { statement: string; source_item_indexes: number[] }[],
    index: number,
    label: string
  ) => {
    const ordinal = sources.filter((source) => source.kind === kind)[index]?.ordinal;
    if (
      ordinal === undefined ||
      !items.some((item) => item.statement === value && item.source_item_indexes.includes(ordinal))
    ) {
      issues.push(`${label}[${index}] must be preserved verbatim with its source ordinal`);
    } else if (
      draft.source_coverage.find((row) => row.source_item_index === ordinal)?.disposition !==
      "incorporated"
    ) {
      issues.push(`${label}[${index}] must have incorporated source coverage`);
    }
  };
  request.hard_constraints.forEach((value, index) =>
    requireItem("hard_constraint", value, draft.constraints, index, "hard_constraints")
  );
  request.non_goals.forEach((value, index) =>
    requireItem("non_goal", value, draft.non_goals, index, "non_goals")
  );
  request.out_of_scope.forEach((value, index) => {
    if (!draft.scope.excluded.includes(value)) {
      issues.push(`out_of_scope[${index}] must remain verbatim in scope.excluded`);
    }
    requireItem("out_of_scope", value, draft.non_goals, index, "out_of_scope");
  });
  request.prior_decisions.forEach((value, index) =>
    requireItem(
      "prior_decision",
      value.binding_effect,
      draft.requirements,
      index,
      "prior_decisions"
    )
  );
  if (issues.length > 0)
    throw new SpecificationDraftValidationError("SEMANTIC_INVALID", sanitizedIssues(issues));
}

function specificationDraftSemanticIssues(input: {
  readonly core: SpecificationCoreV1;
  readonly request: DefinitionRequestV1;
  readonly frame: DefinitionFrameV1;
  readonly priorSpecification?: SpecificationV1;
  readonly standardEvidenceIds?: readonly (readonly string[])[];
}): readonly string[] {
  const { core, request, frame, priorSpecification } = input;
  const issues: string[] = [];
  const sources = definitionRequestSourceItems(request);
  if (frame.request_id !== request.request_id) {
    issues.push("draft frame request binding is stale");
  }
  if (canonicalJson(core.profile) !== canonicalJson(frame.profile)) {
    issues.push("draft profile must equal the admitted DefinitionFrameV1 profile");
  }
  for (const item of allDraftItems(core)) {
    for (const ordinal of item.source_item_indexes) {
      if (ordinal >= sources.length) {
        issues.push(
          `${item.kind}[${item.index}] out-of-range source ordinal ${ordinal} (source_count ${sources.length})`
        );
      }
    }
  }
  for (const requirement of core.requirements) {
    indexRange(
      issues,
      requirement.objective_indexes,
      core.objectives.length,
      "requirement objectives"
    );
  }
  for (const criterion of core.acceptance_criteria) {
    indexRange(
      issues,
      criterion.requirement_indexes,
      core.requirements.length,
      "acceptance criterion requirements"
    );
  }
  core.standards_status.forEach((standard, index) => {
    const ids = input.standardEvidenceIds?.[index];
    if (ids === undefined) {
      indexRange(
        issues,
        standard.evidence_artifact_slots,
        request.input_artifact_ids.length,
        "standard evidence artifact slots"
      );
    } else if (standard.evidence_artifact_slots.length !== 0) {
      issues.push("V2 standards use only target-specific support claims, not V1 evidence slots");
    }
    const count = ids?.length ?? standard.evidence_artifact_slots.length;
    if (standard.status === "satisfied_with_evidence" && count === 0)
      issues.push("satisfied_with_evidence standard requires exact admitted evidence");
    if (standard.status !== "satisfied_with_evidence" && count > 0)
      issues.push("only satisfied_with_evidence may claim exact evidence artifacts");
  });
  const profile = assertProfileBinding(core.profile);
  const categories = new Set(core.requirements.map((entry) => entry.category));
  for (const required of profile.required_requirement_categories) {
    if (!categories.has(required))
      issues.push(`profile-required requirement category '${required}' is absent`);
  }
  const standardCategories = new Set(core.standards_status.map((entry) => entry.category));
  for (const required of profile.required_standard_categories) {
    if (!standardCategories.has(required))
      issues.push(`profile-required standard category '${required}' is absent`);
  }
  const requirementCoverage = new Set(
    core.acceptance_criteria.flatMap((entry) => entry.requirement_indexes)
  );
  for (let index = 0; index < core.requirements.length; index += 1) {
    if (!requirementCoverage.has(index))
      issues.push(`requirement index ${index} has no acceptance criterion`);
  }
  const coverageIndexes = core.source_coverage.map((entry) => entry.source_item_index);
  for (const issue of draftCoverageIssues(core, sources)) {
    if (issue.code === "OUT_OF_RANGE_SOURCE_ORDINAL") {
      issues.push(
        `source coverage out-of-range ordinal ${issue.ordinal} (source_count ${sources.length})`
      );
    } else if (issue.code === "DUPLICATE_SOURCE_ORDINAL") {
      issues.push(`source coverage duplicate ordinal ${issue.ordinal} (${issue.kind})`);
    } else {
      issues.push(`source coverage missing ordinal ${issue.ordinal} (${issue.kind})`);
    }
  }
  if (
    new Set(coverageIndexes).size !== sources.length ||
    coverageIndexes.length !== sources.length
  ) {
    issues.push("source coverage must contain every source item exactly once");
  }
  const derivedRefsBySource = derivedDraftProductRefs(core);
  for (const coverage of core.source_coverage) {
    const derivedRefs = derivedRefsBySource.get(coverage.source_item_index) ?? [];
    if (coverage.disposition === "incorporated" && derivedRefs.length === 0) {
      issues.push(
        `incorporated source coverage[${coverage.source_item_index}] requires at least one item-side source linkage`
      );
    }
    if (coverage.disposition !== "incorporated" && derivedRefs.length > 0) {
      issues.push(
        `${coverage.disposition} source coverage[${coverage.source_item_index}] cannot be linked from product items`
      );
    }
  }
  const blockingQuestions = core.open_questions.filter((entry) => entry.blocking);
  const unresolvedSources = core.source_coverage.filter(
    (entry) => entry.disposition === "unresolved"
  );
  if (core.disposition === "ready") {
    if (blockingQuestions.length > 0)
      issues.push("ready specification cannot contain blocking questions");
    if (unresolvedSources.length > 0)
      issues.push("ready specification cannot contain unresolved source coverage");
  } else if (blockingQuestions.length === 0 && unresolvedSources.length === 0) {
    issues.push("blocked specification requires a blocking question or unresolved source item");
  }
  const collections = draftCollections(core);
  if (request.mode === "create") {
    if (priorSpecification !== undefined)
      issues.push("create request cannot admit a prior specification");
    if (core.supersession_intents.length > 0)
      issues.push("create request cannot contain supersession intents");
  } else {
    if (priorSpecification === undefined)
      issues.push("revise request requires one prior SpecificationV1");
    if (priorSpecification !== undefined) {
      const priorIds = new Set(priorSpecificationItemIds(priorSpecification));
      for (const intent of core.supersession_intents) {
        if (!priorIds.has(intent.prior_item_id)) {
          issues.push(`supersession references unknown prior item '${intent.prior_item_id}'`);
        }
        if (intent.replacement !== null) {
          const collection = collections[intent.replacement.kind];
          if (collection === undefined || intent.replacement.index >= collection.length) {
            issues.push("supersession replacement references an unknown draft item");
          }
        }
      }
    }
  }
  return sanitizedIssues(issues);
}

export function validateSpecificationCore(
  value: unknown,
  input: {
    readonly request: unknown;
    readonly frame: unknown;
    readonly priorSpecification?: unknown;
  }
): SpecificationCoreV1 {
  const request = validateDefinitionRequest(input.request);
  const frame = validateDefinitionFrame(input.frame);
  const priorSpecification =
    input.priorSpecification === undefined
      ? undefined
      : validateSpecification(input.priorSpecification, { skipRevisionClosure: true });
  let core: SpecificationCoreV1;
  try {
    core = validateDraftCoreShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "closed schema validation failed"];
    throw new SpecificationDraftValidationError("SCHEMA_INVALID", sanitizedIssues(issues));
  }
  if (frame.request_id !== request.request_id) {
    throw new Error("DefinitionFrameV1 request binding is stale");
  }
  const issues = specificationDraftSemanticIssues({
    core,
    request,
    frame,
    ...(priorSpecification === undefined ? {} : { priorSpecification }),
  });
  if (issues.length > 0)
    throw new SpecificationDraftValidationError(
      "SEMANTIC_INVALID",
      issues,
      draftCoverageIssues(core, definitionRequestSourceItems(request))
    );
  projectValidatedSpecificationDraft(
    { specification_report: "preflight", ...core },
    { request, ...(priorSpecification === undefined ? {} : { priorSpecification }) }
  );
  return core;
}

export function validateSpecificationDraft(
  value: unknown,
  input: {
    readonly request: unknown;
    readonly frame: unknown;
    readonly priorSpecification?: unknown;
    readonly standardEvidenceIds?: readonly (readonly string[])[];
  }
): SpecificationDraftV1 {
  // Host operands are not prose errors. Reject them before the draft-error wrapper.
  const request = validateDefinitionRequest(input.request);
  const frame = validateDefinitionFrame(input.frame);
  if (frame.request_id !== request.request_id) {
    throw new Error("DefinitionFrameV1 request binding is stale");
  }
  const priorSpecification =
    input.priorSpecification === undefined
      ? undefined
      : validateSpecification(input.priorSpecification, { skipRevisionClosure: true });
  let draft: SpecificationDraftV1;
  try {
    draft = validateSkillSchema(SpecificationDraftV1Schema, value, "SpecificationDraftV1");
    validateText(
      draft.specification_report,
      "SpecificationDraftV1 specification report",
      MAX_SPECIFICATION_PROSE_BYTES
    );
    validateDraftCoreShape(specificationCoreFromDraft(draft));
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "closed schema validation failed"];
    throw new SpecificationDraftValidationError("SCHEMA_INVALID", sanitizedIssues(issues));
  }
  const issues = [
    ...specificationDraftSemanticIssues({
      core: specificationCoreFromDraft(draft),
      request,
      frame,
      ...(input.standardEvidenceIds === undefined
        ? {}
        : { standardEvidenceIds: input.standardEvidenceIds }),
      ...(priorSpecification === undefined ? {} : { priorSpecification }),
    }),
  ];
  if (issues.length > 0)
    throw new SpecificationDraftValidationError(
      "SEMANTIC_INVALID",
      sanitizedIssues(issues),
      draftCoverageIssues(draft, definitionRequestSourceItems(request))
    );
  const projected = projectValidatedSpecificationDraft(draft, {
    request,
    ...(input.standardEvidenceIds === undefined
      ? {}
      : { standardEvidenceIds: input.standardEvidenceIds }),
    ...(priorSpecification === undefined ? {} : { priorSpecification }),
  }).semantic;
  if (priorSpecification !== undefined) {
    const currentIds = new Set(
      [
        ...projected.objectives,
        ...projected.requirements,
        ...projected.acceptance_criteria,
        ...projected.constraints,
        ...projected.non_goals,
        ...projected.assumptions,
        ...projected.risks,
        ...projected.open_questions,
        ...projected.standards_status,
      ].map((entry) => entry.item_id)
    );
    const priorIds = priorSpecificationItemIds(priorSpecification);
    const supersededIds = projected.supersession.map((entry) => entry.prior_item_id);
    if (new Set(supersededIds).size !== supersededIds.length) {
      issues.push("supersession prior item IDs must be unique");
    }
    const superseded = new Set(supersededIds);
    for (const priorId of priorIds) {
      if (!currentIds.has(priorId) && !superseded.has(priorId)) {
        issues.push(`revision silently drops prior item '${priorId}'`);
      }
    }
    for (const entry of projected.supersession) {
      if (currentIds.has(entry.prior_item_id)) {
        issues.push("supersession cannot replace a prior item retained by the revision");
      }
    }
  }
  const safe = sanitizedIssues(issues);
  if (safe.length > 0) throw new SpecificationDraftValidationError("SEMANTIC_INVALID", safe);
  return draft;
}

function countLineStartMarker(value: string, marker: string): number {
  return value.split("\n").filter((line) => line.startsWith(marker)).length;
}

function draftFailure(
  failureClass: SpecificationDraftFailureClassV1,
  issues: string | readonly string[]
): SpecificationDraftValidationError {
  return new SpecificationDraftValidationError(
    failureClass,
    sanitizedIssues(typeof issues === "string" ? [issues] : issues)
  );
}

export function parsePersistedSpecificationRoutingSummary(
  value: string
): SpecificationRoutingSummaryV1 | undefined {
  if (
    Buffer.byteLength(value, "utf8") > MAX_SPECIFICATION_SUMMARY_LINE_BYTES ||
    !value.startsWith("SUMMARY:")
  )
    return undefined;
  try {
    return validateSkillSchema(
      SpecificationRoutingSummaryV1Schema,
      JSON.parse(value.slice("SUMMARY:".length)),
      "SpecificationDraftV1 routing summary"
    );
  } catch {
    return undefined;
  }
}

export function parseSpecificationDraft(
  bytes: Uint8Array,
  input: {
    readonly request: unknown;
    readonly frame: unknown;
    readonly priorSpecification?: unknown;
  }
): { readonly draft: SpecificationDraftV1; readonly summary: SpecificationRoutingSummaryV1 } {
  const body = Buffer.from(bytes);
  if (body.byteLength === 0 || body.byteLength > MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES) {
    throw draftFailure(
      "FRAMING_INVALID",
      `SpecificationDraftV1 output must be 1..${MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES} bytes`
    );
  }
  const issues: string[] = [];
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) issues.push("output forbids BOM");
  if (body.includes(0)) issues.push("output forbids NUL");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV1 output is not strict UTF-8");
  }
  if (text.includes("\ufeff")) issues.push("output forbids BOM");
  if (text.includes("\r")) issues.push("output forbids CR");
  if (text.includes("```")) issues.push("output forbids code fences");
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (framed.endsWith("\n")) issues.push("output permits at most one trailing LF");
  if (countLineStartMarker(framed, "SPECIFICATION_CORE:") !== 1) {
    issues.push("output requires exactly one line-start SPECIFICATION_CORE marker");
  }
  if (countLineStartMarker(framed, "SUMMARY:") !== 1) {
    issues.push("output requires exactly one line-start SUMMARY marker");
  }
  const lines = framed.split("\n");
  const nonemptyIndexes = lines.flatMap((line, index) => (line.length === 0 ? [] : [index]));
  const coreIndex = nonemptyIndexes.at(-2);
  const summaryIndex = nonemptyIndexes.at(-1);
  const coreLine = coreIndex === undefined ? "" : (lines[coreIndex] ?? "");
  const summaryLine = summaryIndex === undefined ? "" : (lines[summaryIndex] ?? "");
  if (!coreLine.startsWith("SPECIFICATION_CORE:") || !summaryLine.startsWith("SUMMARY:")) {
    issues.push("SPECIFICATION_CORE and SUMMARY must be the final two nonempty lines");
  }
  if (Buffer.byteLength(coreLine, "utf8") > MAX_SPECIFICATION_CORE_LINE_BYTES) {
    issues.push(
      `SPECIFICATION_CORE line must be at most ${MAX_SPECIFICATION_CORE_LINE_BYTES} bytes`
    );
  }
  if (Buffer.byteLength(summaryLine, "utf8") > MAX_SPECIFICATION_SUMMARY_LINE_BYTES) {
    issues.push(`SUMMARY line must be at most ${MAX_SPECIFICATION_SUMMARY_LINE_BYTES} bytes`);
  }
  const summary = parsePersistedSpecificationRoutingSummary(summaryLine);
  if (summary === undefined) issues.push("SpecificationDraftV1 SUMMARY is invalid");
  const report = coreIndex === undefined ? "" : lines.slice(0, coreIndex).join("\n");
  if (
    Buffer.byteLength(report, "utf8") < 1 ||
    Buffer.byteLength(report, "utf8") > MAX_SPECIFICATION_PROSE_BYTES ||
    report.trim().length === 0
  ) {
    issues.push("specification prose must be nonempty and within its byte budget");
  }
  if (issues.length > 0 || summary === undefined) throw draftFailure("FRAMING_INVALID", issues);
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreLine.slice("SPECIFICATION_CORE:".length));
  } catch {
    throw draftFailure("JSON_INVALID", "SpecificationDraftV1 core footer is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw draftFailure("SCHEMA_INVALID", "SpecificationDraftV1 core footer must be an object");
  }
  const draft = validateSpecificationDraft(
    Object.assign({ specification_report: report }, parsed),
    input
  );
  if (draft.confidence !== summary.confidence) {
    throw draftFailure("SEMANTIC_INVALID", "draft and SUMMARY confidence must match");
  }
  return { draft, summary };
}

function mappedValue<T>(index: number, values: readonly T[], label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${label} index ${index} is out of range`);
  return value;
}

function mappedValues<T>(indexes: readonly number[], values: readonly T[], label: string): T[] {
  return indexes.map((index) => mappedValue(index, values, label));
}

function itemId(kind: string, seed: unknown): string {
  return stableDefinitionId(`spec-${kind}`, seed);
}

interface ProjectedSpecificationV1 {
  readonly semantic: Omit<
    SpecificationV1,
    | "schema_version"
    | "specification_id"
    | "specification_report"
    | "request"
    | "request_sha256"
    | "source_lineage"
  >;
  readonly itemIdByRef: ReadonlyMap<string, string>;
}

// The stable ID seed deliberately omits provenance links. Whole-object uniqueness
// cannot detect two authored rows that will collapse to one sealed identity.
function assertProjectedItemIdsUnique(
  semantic: Pick<
    ProjectedSpecificationV1["semantic"],
    | "objectives"
    | "requirements"
    | "acceptance_criteria"
    | "constraints"
    | "non_goals"
    | "assumptions"
    | "risks"
    | "open_questions"
    | "standards_status"
  >
): void {
  const collections = {
    objective: semantic.objectives,
    requirement: semantic.requirements,
    acceptance_criterion: semantic.acceptance_criteria,
    constraint: semantic.constraints,
    non_goal: semantic.non_goals,
    assumption: semantic.assumptions,
    risk: semantic.risks,
    open_question: semantic.open_questions,
    standard: semantic.standards_status,
  };
  for (const [kind, items] of Object.entries(collections)) {
    const seen = new Map<string, number>();
    items.forEach((item, index) => {
      const first = seen.get(item.item_id);
      if (first !== undefined) {
        throw new SpecificationDraftValidationError("PROJECTION_INVALID", [
          `${kind} projected stable ID collision at indexes ${first} and ${index}`,
        ]);
      }
      seen.set(item.item_id, index);
    });
  }
}

function projectValidatedSpecificationDraft(
  draft: SpecificationDraftV1,
  input: {
    readonly request: DefinitionRequestV1;
    readonly priorSpecification?: SpecificationV1;
    readonly standardEvidenceIds?: readonly (readonly string[])[];
  }
): ProjectedSpecificationV1 {
  const request = input.request;
  const prior = input.priorSpecification;
  const sources = definitionRequestSourceItems(request);
  const sourceIds = sources.map((entry) => entry.source_item_id);
  const mapSources = (indexes: readonly number[]) =>
    sortedStrings(mappedValues(indexes, sourceIds, "source item"));

  const objectives = draft.objectives.map((entry) => {
    const seed = { statement: entry.statement };
    return {
      item_id: itemId("objective", seed),
      statement: entry.statement,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const objectiveIds = objectives.map((entry) => entry.item_id);
  const requirements = draft.requirements.map((entry) => {
    const objective_ids = sortedStrings(
      mappedValues(entry.objective_indexes, objectiveIds, "objective")
    );
    const seed = {
      statement: entry.statement,
      category: entry.category,
      priority: entry.priority,
      objective_ids,
    };
    return {
      item_id: itemId("requirement", seed),
      ...seed,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const requirementIds = requirements.map((entry) => entry.item_id);
  const acceptanceCriteria = draft.acceptance_criteria.map((entry) => {
    const requirement_ids = sortedStrings(
      mappedValues(entry.requirement_indexes, requirementIds, "requirement")
    );
    const seed = {
      statement: entry.statement,
      observation: entry.observation,
      requirement_ids,
    };
    return {
      item_id: itemId("acceptance", seed),
      ...seed,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const statementItems = (
    kind: string,
    entries: readonly Static<typeof DraftStatementItemV1Schema>[]
  ) =>
    entries.map((entry) => ({
      item_id: itemId(kind, { statement: entry.statement }),
      statement: entry.statement,
      source_item_ids: mapSources(entry.source_item_indexes),
    }));
  const constraints = statementItems("constraint", draft.constraints);
  const nonGoals = statementItems("non-goal", draft.non_goals);
  const assumptions = statementItems("assumption", draft.assumptions);
  const risks = draft.risks.map((entry) => {
    const seed = { statement: entry.statement, impact: entry.impact, mitigation: entry.mitigation };
    return {
      item_id: itemId("risk", seed),
      ...seed,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const openQuestions = draft.open_questions.map((entry) => {
    const seed = { question: entry.question, owner: entry.owner, blocking: entry.blocking };
    return {
      item_id: itemId("question", seed),
      ...seed,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const standardsStatus = draft.standards_status.map((entry, index) => {
    const evidence_artifact_ids =
      input.standardEvidenceIds?.[index] === undefined
        ? sortedStrings(
            mappedValues(
              entry.evidence_artifact_slots,
              request.input_artifact_ids,
              "evidence artifact"
            )
          )
        : sortedStrings(input.standardEvidenceIds[index] ?? []);
    const seed = {
      category: entry.category,
      standard: entry.standard,
      status: entry.status,
      rationale: entry.rationale,
      evidence_artifact_ids,
    };
    return {
      item_id: itemId("standard", seed),
      ...seed,
      source_item_ids: mapSources(entry.source_item_indexes),
    };
  });
  const itemCollections: Readonly<Record<string, readonly { item_id: string }[]>> = {
    objective: objectives,
    requirement: requirements,
    acceptance_criterion: acceptanceCriteria,
    constraint: constraints,
    non_goal: nonGoals,
    assumption: assumptions,
    risk: risks,
    open_question: openQuestions,
    standard: standardsStatus,
  };
  assertProjectedItemIdsUnique({
    objectives,
    requirements,
    acceptance_criteria: acceptanceCriteria,
    constraints,
    non_goals: nonGoals,
    assumptions,
    risks,
    open_questions: openQuestions,
    standards_status: standardsStatus,
  });
  const itemIdByRef = new Map<string, string>();
  for (const [kind, entries] of Object.entries(itemCollections)) {
    entries.forEach((entry, index) => itemIdByRef.set(`${kind}:${index}`, entry.item_id));
  }
  const derivedRefsBySource = derivedDraftProductRefs(draft);
  const sourceCoverage = draft.source_coverage
    .map((entry) => ({
      source_item_id: mappedValue(entry.source_item_index, sourceIds, "source coverage"),
      disposition: entry.disposition,
      product_item_ids: sortedStrings(
        (derivedRefsBySource.get(entry.source_item_index) ?? []).map((ref) => {
          const id = itemIdByRef.get(`${ref.kind}:${ref.index}`);
          if (id === undefined) throw new Error("derived source coverage reference is unresolved");
          return id;
        })
      ),
      rationale: entry.rationale,
    }))
    .sort((left, right) => left.source_item_id.localeCompare(right.source_item_id));
  const supersession = draft.supersession_intents
    .map((entry) => {
      const replacementId =
        entry.replacement === null
          ? null
          : itemIdByRef.get(`${entry.replacement.kind}:${entry.replacement.index}`);
      if (replacementId === undefined) {
        throw new SpecificationDraftValidationError("PROJECTION_INVALID", [
          "supersession replacement projection failed",
        ]);
      }
      return {
        prior_item_id: entry.prior_item_id,
        replacement_item_id: replacementId,
        reason: entry.reason,
      };
    })
    .sort((left, right) => left.prior_item_id.localeCompare(right.prior_item_id));
  const sortItems = <T extends { item_id: string }>(entries: readonly T[]): T[] =>
    [...entries].sort((left, right) => left.item_id.localeCompare(right.item_id));
  const sortedObjectives = sortItems(objectives);
  const sortedRequirements = sortItems(requirements);
  const sortedAcceptance = sortItems(acceptanceCriteria);
  const sortedConstraints = sortItems(constraints);
  const sortedNonGoals = sortItems(nonGoals);
  const sortedAssumptions = sortItems(assumptions);
  const sortedRisks = sortItems(risks);
  const sortedQuestions = sortItems(openQuestions);
  const sortedStandards = sortItems(standardsStatus);
  const blockingQuestionIds = sortedStrings(
    sortedQuestions.filter((entry) => entry.blocking).map((entry) => entry.item_id)
  );
  const semantic = {
    disposition: draft.disposition,
    applicability_reason: draft.applicability_reason,
    profile: draft.profile,
    title: draft.title,
    summary: draft.summary,
    audiences: sortedStrings(draft.audiences),
    scope: {
      included: sortedStrings(draft.scope.included),
      excluded: sortedStrings(draft.scope.excluded),
    },
    source_items: [...sources],
    objectives: sortedObjectives,
    requirements: sortedRequirements,
    acceptance_criteria: sortedAcceptance,
    constraints: sortedConstraints,
    non_goals: sortedNonGoals,
    assumptions: sortedAssumptions,
    risks: sortedRisks,
    open_questions: sortedQuestions,
    standards_status: sortedStandards,
    source_coverage: sourceCoverage,
    supersession,
    supersedes_specification_ids: prior === undefined ? [] : [prior.specification_id],
    planning_handoff: {
      schema_version: 1 as const,
      planning_ready: draft.disposition === "ready",
      planning_readiness_reason: draft.planning_readiness_reason,
      objective_ids: sortedObjectives.map((entry) => entry.item_id),
      requirement_ids: sortedRequirements.map((entry) => entry.item_id),
      acceptance_criterion_ids: sortedAcceptance.map((entry) => entry.item_id),
      constraint_ids: sortedConstraints.map((entry) => entry.item_id),
      non_goal_ids: sortedNonGoals.map((entry) => entry.item_id),
      assumption_ids: sortedAssumptions.map((entry) => entry.item_id),
      risk_ids: sortedRisks.map((entry) => entry.item_id),
      blocking_question_ids: blockingQuestionIds,
      standard_ids: sortedStandards.map((entry) => entry.item_id),
    },
    confidence: draft.confidence,
    planning_started: false as const,
    taskification_started: false as const,
    execution_started: false as const,
  };
  return { semantic, itemIdByRef };
}

function projectSpecificationDraft(
  value: unknown,
  input: {
    readonly request: unknown;
    readonly frame: unknown;
    readonly priorSpecification?: unknown;
    readonly standardEvidenceIds?: readonly (readonly string[])[];
  }
): ProjectedSpecificationV1 {
  const request = validateDefinitionRequest(input.request);
  const frame = validateDefinitionFrame(input.frame);
  const prior =
    input.priorSpecification === undefined
      ? undefined
      : validateSpecification(input.priorSpecification, { skipRevisionClosure: true });
  const draft = validateSpecificationDraft(value, {
    request,
    frame,
    ...(input.standardEvidenceIds === undefined
      ? {}
      : { standardEvidenceIds: input.standardEvidenceIds }),
    ...(prior === undefined ? {} : { priorSpecification: prior }),
  });
  return projectValidatedSpecificationDraft(draft, {
    request,
    ...(input.standardEvidenceIds === undefined
      ? {}
      : { standardEvidenceIds: input.standardEvidenceIds }),
    ...(prior === undefined ? {} : { priorSpecification: prior }),
  });
}

export function specificationLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        SpecificationLineagePreimageV1Schema,
        value,
        "SpecificationV1 lineage preimage"
      )
    )
  );
}

function validateSpecificationSemantics(
  specification: SpecificationV1,
  options: { readonly priorSpecification?: SpecificationV1; readonly skipRevisionClosure?: boolean }
): void {
  assertProfileBinding(specification.profile);
  validateText(
    specification.specification_report,
    "SpecificationV1 specification report",
    MAX_SPECIFICATION_PROSE_BYTES
  );
  if (specification.request_sha256 !== definitionRequestSha256(specification.request)) {
    throw new Error("SpecificationV1 request digest drifted");
  }
  const expectedSources = definitionRequestSourceItems(specification.request);
  if (canonicalJson(specification.source_items) !== canonicalJson(expectedSources)) {
    throw new Error("SpecificationV1 source items drifted from its request");
  }
  const profile = specificationProfile(specification.profile.profile_id);
  const requirementCategories = new Set(specification.requirements.map((entry) => entry.category));
  for (const required of profile.required_requirement_categories) {
    if (!requirementCategories.has(required))
      throw new Error(`required profile category '${required}' is absent`);
  }
  const standardCategories = new Set(specification.standards_status.map((entry) => entry.category));
  for (const required of profile.required_standard_categories) {
    if (!standardCategories.has(required))
      throw new Error(`required standard category '${required}' is absent`);
  }
  const allItems = [
    ...specification.objectives,
    ...specification.requirements,
    ...specification.acceptance_criteria,
    ...specification.constraints,
    ...specification.non_goals,
    ...specification.assumptions,
    ...specification.risks,
    ...specification.open_questions,
    ...specification.standards_status,
  ];
  assertUnique(
    allItems.map((entry) => entry.item_id),
    "SpecificationV1 item IDs"
  );
  const itemIds = new Set(allItems.map((entry) => entry.item_id));
  const sourceIds = new Set(expectedSources.map((entry) => entry.source_item_id));
  for (const entry of allItems) {
    assertSorted(entry.source_item_ids, `SpecificationV1 item '${entry.item_id}' source IDs`);
    if (entry.source_item_ids.some((id) => !sourceIds.has(id))) {
      throw new Error(`SpecificationV1 item '${entry.item_id}' has an unknown source ID`);
    }
  }
  for (const collection of [
    specification.objectives,
    specification.requirements,
    specification.acceptance_criteria,
    specification.constraints,
    specification.non_goals,
    specification.assumptions,
    specification.risks,
    specification.open_questions,
    specification.standards_status,
  ]) {
    assertSorted(
      collection.map((entry) => entry.item_id),
      "SpecificationV1 item collection"
    );
  }
  const objectiveIds = new Set(specification.objectives.map((entry) => entry.item_id));
  const requirementIds = new Set(specification.requirements.map((entry) => entry.item_id));
  for (const requirement of specification.requirements) {
    assertSorted(requirement.objective_ids, "SpecificationV1 requirement objective IDs");
    if (requirement.objective_ids.some((id) => !objectiveIds.has(id))) {
      throw new Error("SpecificationV1 requirement references an unknown objective");
    }
    const expected = itemId("requirement", {
      statement: requirement.statement,
      category: requirement.category,
      priority: requirement.priority,
      objective_ids: requirement.objective_ids,
    });
    if (requirement.item_id !== expected)
      throw new Error("SpecificationV1 requirement stable ID drifted");
  }
  const criteriaCoverage = new Set<string>();
  for (const criterion of specification.acceptance_criteria) {
    assertSorted(criterion.requirement_ids, "SpecificationV1 criterion requirement IDs");
    if (criterion.requirement_ids.some((id) => !requirementIds.has(id))) {
      throw new Error("SpecificationV1 criterion references an unknown requirement");
    }
    criterion.requirement_ids.forEach((id) => criteriaCoverage.add(id));
    const expected = itemId("acceptance", {
      statement: criterion.statement,
      observation: criterion.observation,
      requirement_ids: criterion.requirement_ids,
    });
    if (criterion.item_id !== expected)
      throw new Error("SpecificationV1 criterion stable ID drifted");
  }
  if ([...requirementIds].some((id) => !criteriaCoverage.has(id))) {
    throw new Error("SpecificationV1 has a requirement without acceptance coverage");
  }
  for (const objective of specification.objectives) {
    if (objective.item_id !== itemId("objective", { statement: objective.statement })) {
      throw new Error("SpecificationV1 objective stable ID drifted");
    }
  }
  for (const [kind, collection] of [
    ["constraint", specification.constraints],
    ["non-goal", specification.non_goals],
    ["assumption", specification.assumptions],
  ] as const) {
    for (const entry of collection) {
      if (entry.item_id !== itemId(kind, { statement: entry.statement })) {
        throw new Error(`SpecificationV1 ${kind} stable ID drifted`);
      }
    }
  }
  for (const risk of specification.risks) {
    if (
      risk.item_id !==
      itemId("risk", {
        statement: risk.statement,
        impact: risk.impact,
        mitigation: risk.mitigation,
      })
    )
      throw new Error("SpecificationV1 risk stable ID drifted");
  }
  for (const question of specification.open_questions) {
    if (
      question.item_id !==
      itemId("question", {
        question: question.question,
        owner: question.owner,
        blocking: question.blocking,
      })
    )
      throw new Error("SpecificationV1 question stable ID drifted");
  }
  for (const standard of specification.standards_status) {
    assertSorted(standard.evidence_artifact_ids, "SpecificationV1 standard evidence IDs");
    if (
      standard.status === "satisfied_with_evidence" &&
      standard.evidence_artifact_ids.length === 0
    )
      throw new Error("satisfied_with_evidence requires exact evidence");
    if (standard.status !== "satisfied_with_evidence" && standard.evidence_artifact_ids.length > 0)
      throw new Error("only satisfied_with_evidence may carry exact evidence");
    if (
      standard.item_id !==
      itemId("standard", {
        category: standard.category,
        standard: standard.standard,
        status: standard.status,
        rationale: standard.rationale,
        evidence_artifact_ids: standard.evidence_artifact_ids,
      })
    )
      throw new Error("SpecificationV1 standard stable ID drifted");
  }
  assertSorted(
    specification.source_coverage.map((entry) => entry.source_item_id),
    "SpecificationV1 source coverage"
  );
  if (
    canonicalJson(specification.source_coverage.map((entry) => entry.source_item_id)) !==
    canonicalJson(sortedStrings([...sourceIds]))
  )
    throw new Error("SpecificationV1 source coverage is not exact");
  const derivedProductIdsBySource = new Map<string, string[]>();
  for (const item of allItems) {
    for (const sourceId of item.source_item_ids) {
      const productIds = derivedProductIdsBySource.get(sourceId) ?? [];
      productIds.push(item.item_id);
      derivedProductIdsBySource.set(sourceId, productIds);
    }
  }
  for (const coverage of specification.source_coverage) {
    assertSorted(coverage.product_item_ids, "SpecificationV1 source product IDs");
    if (coverage.product_item_ids.some((id) => !itemIds.has(id))) {
      throw new Error("SpecificationV1 source coverage references an unknown item");
    }
    const derivedProductIds = sortedStrings(
      derivedProductIdsBySource.get(coverage.source_item_id) ?? []
    );
    if (canonicalJson(coverage.product_item_ids) !== canonicalJson(derivedProductIds)) {
      throw new Error(
        `SpecificationV1 source coverage for '${coverage.source_item_id}' is not reciprocal with semantic item source IDs`
      );
    }
    if (coverage.disposition === "incorporated" && coverage.product_item_ids.length === 0) {
      throw new Error("incorporated source coverage requires product items");
    }
    if (coverage.disposition !== "incorporated" && coverage.product_item_ids.length > 0) {
      throw new Error("excluded or unresolved source coverage cannot reference product items");
    }
  }
  const blockingIds = sortedStrings(
    specification.open_questions.filter((entry) => entry.blocking).map((entry) => entry.item_id)
  );
  const handoff = specification.planning_handoff;
  if (
    handoff.planning_ready !== (specification.disposition === "ready") ||
    canonicalJson(handoff.objective_ids) !==
      canonicalJson(specification.objectives.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.requirement_ids) !==
      canonicalJson(specification.requirements.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.acceptance_criterion_ids) !==
      canonicalJson(specification.acceptance_criteria.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.constraint_ids) !==
      canonicalJson(specification.constraints.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.non_goal_ids) !==
      canonicalJson(specification.non_goals.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.assumption_ids) !==
      canonicalJson(specification.assumptions.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.risk_ids) !==
      canonicalJson(specification.risks.map((entry) => entry.item_id)) ||
    canonicalJson(handoff.blocking_question_ids) !== canonicalJson(blockingIds) ||
    canonicalJson(handoff.standard_ids) !==
      canonicalJson(specification.standards_status.map((entry) => entry.item_id))
  )
    throw new Error("SpecificationV1 planning handoff drifted from the semantic product");
  if (specification.disposition === "ready" && blockingIds.length > 0) {
    throw new Error("ready SpecificationV1 cannot contain blocking questions");
  }
  if (
    specification.disposition === "ready" &&
    specification.source_coverage.some((entry) => entry.disposition === "unresolved")
  )
    throw new Error("ready SpecificationV1 cannot contain unresolved source coverage");

  const lineagePreimage = {
    request_artifact_id: specification.source_lineage.request_artifact_id,
    draft_artifact_id: specification.source_lineage.draft_artifact_id,
    draft_sha256: specification.source_lineage.draft_sha256,
    input_artifact_ids: specification.source_lineage.input_artifact_ids,
    prior_specification_artifact_id: specification.source_lineage.prior_specification_artifact_id,
    prior_specification_id: specification.source_lineage.prior_specification_id,
  };
  assertSorted(lineagePreimage.input_artifact_ids, "SpecificationV1 lineage input IDs");
  if (
    canonicalJson(lineagePreimage.input_artifact_ids) !==
    canonicalJson(specification.request.input_artifact_ids)
  ) {
    throw new Error("SpecificationV1 lineage inputs drifted from request");
  }
  if (specification.source_lineage.lineage_sha256 !== specificationLineageSha256(lineagePreimage)) {
    throw new Error("SpecificationV1 lineage digest drifted");
  }
  if (specification.request.mode === "create") {
    if (
      specification.supersession.length > 0 ||
      specification.supersedes_specification_ids.length > 0 ||
      lineagePreimage.prior_specification_artifact_id !== null ||
      lineagePreimage.prior_specification_id !== null
    )
      throw new Error("create SpecificationV1 cannot contain prior lineage or supersession");
  } else {
    if (
      specification.supersedes_specification_ids.length !== 1 ||
      lineagePreimage.prior_specification_artifact_id === null ||
      lineagePreimage.prior_specification_id === null ||
      specification.supersedes_specification_ids[0] !== lineagePreimage.prior_specification_id
    )
      throw new Error("revise SpecificationV1 requires one exact prior lineage binding");
    if (!options.skipRevisionClosure) {
      const prior = options.priorSpecification;
      if (
        prior === undefined ||
        prior.specification_id !== lineagePreimage.prior_specification_id
      ) {
        throw new Error(
          "revise SpecificationV1 requires its exact prior SpecificationV1 for validation"
        );
      }
      const priorIds = priorSpecificationItemIds(prior);
      const currentIds = new Set(allItems.map((entry) => entry.item_id));
      const supersededIds = new Set(specification.supersession.map((entry) => entry.prior_item_id));
      assertUnique(
        specification.supersession.map((entry) => entry.prior_item_id),
        "SpecificationV1 supersession prior IDs"
      );
      for (const priorId of priorIds) {
        if (!currentIds.has(priorId) && !supersededIds.has(priorId)) {
          throw new Error(`revision silently drops prior item '${priorId}'`);
        }
      }
      for (const entry of specification.supersession) {
        if (!priorIds.includes(entry.prior_item_id) || currentIds.has(entry.prior_item_id)) {
          throw new Error("SpecificationV1 supersession does not identify a replaced prior item");
        }
        if (entry.replacement_item_id !== null && !currentIds.has(entry.replacement_item_id)) {
          throw new Error("SpecificationV1 supersession replacement is unknown");
        }
      }
    }
  }
  const {
    specification_id: ignoredId,
    source_lineage: ignoredLineage,
    ...withoutIdAndLineage
  } = specification;
  void ignoredId;
  void ignoredLineage;
  const expectedId = stableDefinitionId("specification", {
    product: withoutIdAndLineage,
    lineage_sha256: specification.source_lineage.lineage_sha256,
  });
  if (specification.specification_id !== expectedId) {
    throw new Error("SpecificationV1 specification_id is invalid");
  }
}

export function validateSpecification(
  value: unknown,
  options: { readonly priorSpecification?: unknown; readonly skipRevisionClosure?: boolean } = {}
): SpecificationV1 {
  const specification = validateSkillSchema(SpecificationV1Schema, value, "SpecificationV1");
  const priorSpecification =
    options.priorSpecification === undefined
      ? undefined
      : validateSpecification(options.priorSpecification, { skipRevisionClosure: true });
  validateSpecificationSemantics(specification, {
    ...(priorSpecification === undefined ? {} : { priorSpecification }),
    ...(options.skipRevisionClosure === true ? { skipRevisionClosure: true } : {}),
  });
  return specification;
}

export function sealSpecification(input: {
  readonly request: unknown;
  readonly frame: unknown;
  readonly draft: unknown;
  readonly draftBytes: Uint8Array;
  readonly requestSha256: string;
  readonly sourceRequestArtifactId: string;
  readonly sourceDraftArtifactId: string;
  readonly exactInputArtifactIds: readonly string[];
  readonly priorSpecification?: unknown;
  readonly priorSpecificationArtifactId?: string;
  /** Trace-capable sealing supplies these already validated projections. */
  readonly v2Frame?: DefinitionFrameV2;
  readonly v2Admission?: EvidenceAdmissionV2;
  /** Historical trace-capable drafts default to V2; active keyed drafts declare V3. */
  readonly draftTransportVersion?: 2 | 3;
}): SpecificationV1 {
  const request = validateDefinitionRequest(input.request);
  const frame = validateDefinitionFrame(input.frame);
  if (frame.request_id !== request.request_id)
    throw new Error("DefinitionFrameV1 request binding is stale");
  const requestSha = definitionRequestSha256(request);
  if (input.requestSha256 !== requestSha)
    throw new Error("SpecificationV1 request binding is stale");
  const exactInputArtifactIds = sortedStrings(input.exactInputArtifactIds);
  if (canonicalJson(exactInputArtifactIds) !== canonicalJson(request.input_artifact_ids)) {
    throw new Error("SpecificationV1 exact inputs drifted from request");
  }
  const prior =
    input.priorSpecification === undefined
      ? undefined
      : validateSpecification(input.priorSpecification, { skipRevisionClosure: true });
  if (
    (request.mode === "revise") !==
    (prior !== undefined && input.priorSpecificationArtifactId !== undefined)
  )
    throw new Error("SpecificationV1 create/revise prior binding is invalid");
  const parsedTrace =
    input.v2Frame === undefined
      ? undefined
      : input.draftTransportVersion === 3
        ? parseSpecificationDraftV3(input.draftBytes, {
            request,
            frame: input.v2Frame,
            priorSpecification: prior,
            ...(input.v2Admission === undefined ? {} : { admission: input.v2Admission }),
          })
        : parseSpecificationDraftV2(input.draftBytes, {
            request,
            frame: input.v2Frame,
            priorSpecification: prior,
            ...(input.v2Admission === undefined ? {} : { admission: input.v2Admission }),
          });
  const parsed =
    parsedTrace === undefined
      ? parseSpecificationDraft(input.draftBytes, { request, frame, priorSpecification: prior })
          .draft
      : parsedTrace.legacyCore;
  const supportDraft =
    parsedTrace === undefined
      ? undefined
      : "compatibilityDraft" in parsedTrace
        ? parsedTrace.compatibilityDraft
        : parsedTrace.draft;
  const standardEvidenceIds =
    supportDraft === undefined ? undefined : v2StandardEvidenceIds(supportDraft, input.v2Admission);
  const draft = validateSpecificationDraft(input.draft, {
    request,
    frame,
    priorSpecification: prior,
    ...(standardEvidenceIds === undefined ? {} : { standardEvidenceIds }),
  });
  if (canonicalJson(parsed) !== canonicalJson(draft)) {
    throw new Error("SpecificationV1 source draft bytes and parsed draft disagree");
  }
  const projected = projectSpecificationDraft(draft, {
    request,
    frame,
    priorSpecification: prior,
    ...(standardEvidenceIds === undefined ? {} : { standardEvidenceIds }),
  });
  const lineagePreimage = validateSkillSchema(
    SpecificationLineagePreimageV1Schema,
    {
      request_artifact_id: input.sourceRequestArtifactId,
      draft_artifact_id: input.sourceDraftArtifactId,
      draft_sha256: sha256(Buffer.from(input.draftBytes)),
      input_artifact_ids: exactInputArtifactIds,
      prior_specification_artifact_id: input.priorSpecificationArtifactId ?? null,
      prior_specification_id: prior?.specification_id ?? null,
    },
    "SpecificationV1 lineage"
  );
  const withoutId = {
    schema_version: 1 as const,
    specification_report: draft.specification_report,
    ...projected.semantic,
    request,
    request_sha256: requestSha,
    source_lineage: {
      ...lineagePreimage,
      lineage_sha256: specificationLineageSha256(lineagePreimage),
    },
  };
  const specification = {
    ...withoutId,
    specification_id: stableDefinitionId("specification", {
      product: (() => {
        const { source_lineage: ignoredLineage, ...product } = withoutId;
        void ignoredLineage;
        return product;
      })(),
      lineage_sha256: withoutId.source_lineage.lineage_sha256,
    }),
  };
  return validateSpecification(specification, {
    ...(prior === undefined ? {} : { priorSpecification: prior }),
  });
}

export function assertSpecificationLineage(input: {
  readonly specification: unknown;
  readonly request: unknown;
  readonly frame: unknown;
  readonly draft: unknown;
  readonly draftBytes: Uint8Array;
  readonly requestArtifactId: string;
  readonly draftArtifactId: string;
  readonly exactInputArtifactIds: readonly string[];
  readonly priorSpecification?: unknown;
  readonly priorSpecificationArtifactId?: string;
  readonly v2Frame?: DefinitionFrameV2;
  readonly v2Admission?: EvidenceAdmissionV2;
  readonly draftTransportVersion?: 2 | 3;
}): SpecificationV1 {
  const request = validateDefinitionRequest(input.request);
  const expected = sealSpecification({
    ...(input.v2Frame === undefined ? {} : { v2Frame: input.v2Frame }),
    ...(input.v2Admission === undefined ? {} : { v2Admission: input.v2Admission }),
    ...(input.draftTransportVersion === undefined
      ? {}
      : { draftTransportVersion: input.draftTransportVersion }),
    request,
    frame: input.frame,
    draft: input.draft,
    draftBytes: input.draftBytes,
    requestSha256: definitionRequestSha256(request),
    sourceRequestArtifactId: input.requestArtifactId,
    sourceDraftArtifactId: input.draftArtifactId,
    exactInputArtifactIds: input.exactInputArtifactIds,
    ...(input.priorSpecification === undefined
      ? {}
      : {
          priorSpecification: input.priorSpecification,
          priorSpecificationArtifactId: input.priorSpecificationArtifactId,
        }),
  });
  const specification = validateSpecification(input.specification, {
    ...(input.priorSpecification === undefined
      ? { skipRevisionClosure: true as const }
      : { priorSpecification: input.priorSpecification }),
  });
  if (canonicalJson(specification) !== canonicalJson(expected)) {
    throw new Error("SpecificationV1 request, frame, draft, or host-sealed lineage diverged");
  }
  return specification;
}

export function validateCanonicalSpecificationBytes(
  bytes: Uint8Array,
  ref?: ArtifactRef,
  options: { readonly priorSpecification?: unknown } = {}
): SpecificationV1 {
  const body = Buffer.from(bytes);
  if (
    ref !== undefined &&
    (ref.kind !== "specification" ||
      ref.content_schema?.schema_id !== "penny.specification.v1" ||
      ref.content_schema.schema_version !== 1 ||
      ref.byte_length !== body.byteLength ||
      ref.content_digest !== sha256(body) ||
      ref.store_ref !== `artifact://sha256/${ref.content_digest}`)
  )
    throw new Error("SpecificationV1 artifact ref is stale or has the wrong semantic identity");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("SpecificationV1 artifact is not JSON");
  }
  const specification = validateSpecification(parsed, {
    ...(options.priorSpecification === undefined
      ? { skipRevisionClosure: true }
      : { priorSpecification: options.priorSpecification }),
  });
  if (canonicalJson(specification) !== body.toString("utf8")) {
    throw new Error("SpecificationV1 artifact bytes are not canonical JSON");
  }
  return specification;
}

export function validateSpecificationSealFeedback(value: unknown): SpecificationSealFeedbackV1 {
  const feedback = validateSkillSchema(
    SpecificationSealFeedbackV1Schema,
    value,
    "SpecificationSealFeedbackV1"
  );
  for (const issue of feedback.issues)
    validateText(issue, "SpecificationSealFeedbackV1 issue", 512);
  return feedback;
}

export function specificationProductIntegrityId(
  value: Omit<SpecificationProductIntegrityV1, "integrity_id">
): string {
  return sha256(canonicalJson(value));
}

export function validateSpecificationProductIntegrity(
  value: unknown
): SpecificationProductIntegrityV1 {
  const integrity = validateSkillSchema(
    SpecificationProductIntegrityV1Schema,
    value,
    "SpecificationProductIntegrityV1"
  );
  const expectedChecks = [
    "canonical_specification",
    "exact_lineage",
    "profile_semantics",
    "complete_source_coverage",
    "revision_supersession",
    "signed_worker_evidence",
    "latest_validity_receipt",
    "latest_quality_receipt",
    "no_planning_taskification_or_execution",
  ];
  if (canonicalJson(integrity.checks) !== canonicalJson(expectedChecks)) {
    throw new Error("SpecificationProductIntegrityV1 checks are incomplete or reordered");
  }
  const refs = [
    integrity.request_ref,
    ...(integrity.specification_assurance_ref === undefined
      ? []
      : [integrity.specification_assurance_ref]),
    integrity.frame_ref,
    integrity.orientation_ref,
    integrity.admission_ref,
    ...integrity.evidence_refs,
    ...integrity.imported_input_refs,
    integrity.draft_ref,
    integrity.specification_ref,
    integrity.vera_report_ref,
    integrity.carren_report_ref,
    integrity.validity_receipt_ref,
    integrity.quality_receipt_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "SpecificationProductIntegrityV1 refs"
  );
  const { integrity_id: ignoredId, ...body } = integrity;
  void ignoredId;
  if (integrity.integrity_id !== specificationProductIntegrityId(body)) {
    throw new Error("SpecificationProductIntegrityV1 integrity_id is invalid");
  }
  return integrity;
}

export function specificationProductEnvelopeId(
  value: Omit<SpecificationProductEnvelopeV1, "envelope_id">
): string {
  return sha256(canonicalJson(value));
}

export function validateSpecificationProductEnvelope(
  value: unknown
): SpecificationProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    SpecificationProductEnvelopeV1Schema,
    value,
    "SpecificationProductEnvelopeV1"
  );
  const refs = [
    envelope.request_ref,
    ...(envelope.specification_assurance_ref === undefined
      ? []
      : [envelope.specification_assurance_ref]),
    envelope.frame_ref,
    envelope.orientation_ref,
    envelope.admission_ref,
    ...envelope.evidence_refs,
    ...envelope.imported_input_refs,
    envelope.draft_ref,
    envelope.specification_ref,
    envelope.vera_report_ref,
    envelope.carren_report_ref,
    envelope.validity_receipt_ref,
    envelope.quality_receipt_ref,
    envelope.integrity_ref,
  ];
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "SpecificationProductEnvelopeV1 refs"
  );
  const { envelope_id: ignoredId, ...body } = envelope;
  void ignoredId;
  if (envelope.envelope_id !== specificationProductEnvelopeId(body)) {
    throw new Error("SpecificationProductEnvelopeV1 envelope_id is invalid");
  }
  return envelope;
}

// Compatibility aliases keep orchestration naming concise without changing the wire contracts.
export const DefineRequestConstraintsV1Schema = DefinitionRequestConstraintsV1Schema;
export type DefineRequestConstraintsV1 = DefinitionRequestConstraintsV1;
export type DefineRequestV1 = DefinitionRequestV1;
export const canonicalizeDefineRequest = canonicalizeDefinitionRequest;
export const defineRequestConstraints = definitionRequestConstraints;
export const defineRequestSha256 = definitionRequestSha256;
export const validateDefineRequest = validateDefinitionRequest;

/** Project the actual product lineage schema and its separate host-owned frame carrier. */
export function specificationLineagePromptContract(): string {
  return canonicalJson({
    source_lineage_schema: SpecificationLineageV1Schema,
    ownership: {
      draft:
        "Rhea authors semantic content only; sealing assigns source_lineage and all new IDs and digests.",
      frame_before_review:
        "The exact definition-frame input is recorded in the sealed specification artifact metadata upstream_refs, not in SpecificationV1.source_lineage. Artifact-read content does not expose that host metadata.",
      frame_after_review:
        "The host product-integrity and product-envelope artifacts retain frame_ref after both reviews. They do not exist yet during Vera verification and are not preconditions for a review verdict.",
      completion:
        "The host checks exact stored refs, replays sealing against the request, frame and draft, and validates the reviewed product graph before positive completion. A model verdict cannot replace these checks.",
    },
    review_checks: [
      "Check source_lineage against the supplied schema and exact request, draft and imported inputs; compare the supplied frame request_id and profile with the request and specification.",
      "Do not require a frame artifact ID, frame_id or frame digest inside source_lineage; those fields are outside its closed schema. Their absence there is not a product gap.",
      "A missing exact frame input or an actual request/profile/content mismatch remains a failure; the carrier distinction does not waive lineage or semantic verification.",
      "Do not route a request to add host-only lineage fields to Rhea or promise such fields in specification prose. Report the concrete missing or inconsistent supported evidence instead.",
    ],
  });
}

export function specificationDraftPromptContract(): string {
  return canonicalJson({
    schema: SpecificationCoreV1Schema,
    profiles: specificationProfiles(),
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES,
      specification_prose_bytes: { minimum: 1, maximum: MAX_SPECIFICATION_PROSE_BYTES },
      specification_core_line_maximum_bytes: MAX_SPECIFICATION_CORE_LINE_BYTES,
      summary_line_maximum_bytes: MAX_SPECIFICATION_SUMMARY_LINE_BYTES,
      framing:
        "bounded specification prose, SPECIFICATION_CORE:<single-line JSON>, then final SUMMARY; footer and summary are the final two nonempty lines",
      forbidden: ["BOM", "NUL", "CR", "code fences", "duplicate markers", "trailing content"],
    },
    ids: "model emits indexes and prior exact IDs only; host assigns all new stable IDs",
    profile_categories:
      "use the exact selected profile's required_requirement_categories and required_standard_categories; requirement.category is scalar, so every required category must appear on at least one requirement and a repair must add a missing category without removing another required category",
    revision:
      "create always emits supersession_intents: [], including same-run review repair; revise requires one imported prior SpecificationV1 and emits a complete replacement with explicit supersession intents for changed or removed prior items; same-run reviewed product IDs are never prior-item supersession targets",
    source_traceability: {
      manifest:
        "read the exact host-derived DefinitionSourceManifestV1 and its request; manifest ordinals/kinds/IDs/digests define the source namespace, while the request contains full values; never reconstruct numbering or pad missing rows",
      authoritative_relation:
        "each semantic product item's source_item_indexes is the sole model-authored source-to-product relation",
      coverage_rows:
        "emit exactly one source_coverage row per request source with its disposition and rationale; an incorporated source must be linked by at least one item-side source_item_indexes entry",
      reciprocal_projection:
        "the host derives canonical source_coverage.product_item_ids from item-side source_item_indexes; omit compatibility-only draft product_item_refs because supplied values are ignored",
      fail_closed:
        "missing or duplicate source ordinals, out-of-range item-side indexes, incorporated sources without item-side links, excluded or unresolved sources with item-side links, and projected stable-ID collisions remain draft failures before product persistence",
    },
    standards:
      "status is closed; satisfied_with_evidence requires exact supplied artifact slots and no other status may claim them",
    execution:
      "planning, taskification, and execution are forbidden; the host product sets all three flags false",
    summary: { schema: SpecificationRoutingSummaryV1Schema, confidence_must_equal_core: true },
  });
}

export function specificationDraftV2PromptContract(): string {
  return canonicalJson({
    schema: SpecificationDraftV2Schema,
    profiles: specificationProfiles(),
    transport: "strict UTF-8; SPECIFICATION_CORE:<single-line V2 wrapper JSON> then final SUMMARY",
    support:
      "Use only ordered support_slots from EvidenceAdmissionV2. Each claim names its exact question or standard target, status when a question, and selectors with slot and exact JSON pointer or UTF-8 byte range. Do not claim a pending/declined question resolved, or a satisfied standard without support. Material unresolved questions require blocked disposition and a blocking open question. Preserve protected caller text verbatim.",
    revision:
      "Create emits no prior-item supersession; revise is a full replacement using only the imported prior SpecificationV1.",
    summary: { schema: SpecificationRoutingSummaryV1Schema, confidence_must_equal_core: true },
  });
}

export function specificationDraftV3PromptContract(): string {
  return canonicalJson({
    schema: SpecificationDraftV3Schema,
    profiles: specificationProfiles(),
    transport: "strict UTF-8; SPECIFICATION_CORE:<single-line V3 wrapper JSON> then final SUMMARY",
    draft_keys:
      "Assign a stable draft_key to every semantic item. Keep each collection's keys unique and unchanged across corrections. Use objective_keys, requirement_keys, standard_key, and {kind,draft_key} replacement refs; never derive or renumber array indexes. Draft keys are temporary authoring identities and never claim canonical SpecificationV1 item IDs.",
    source_ordinals:
      "source_item_indexes and source_coverage.source_item_index remain the exact immutable DefinitionSourceManifestV1 ordinals.",
    support:
      "Use only ordered support_slots from EvidenceAdmissionV2. Each claim names its exact question or standard_key target and exact selectors. Material unresolved questions require blocked disposition and a blocking open question.",
    revision:
      "Create emits no prior-item supersession; revise is a complete replacement using only the imported prior SpecificationV1.",
    summary: { schema: SpecificationRoutingSummaryV1Schema, confidence_must_equal_core: true },
  });
}

export function specificationDraftRepairPromptContract(): string {
  return canonicalJson({
    schema: SpecificationDraftRepairV1Schema,
    transport:
      "exactly SPECIFICATION_REPAIR:<single-line JSON> then final SUMMARY; no prose or code fences",
    binding:
      "Copy base_draft_ref, base_draft_sha256, and diagnostic_ref exactly from the supplied artifacts. The host rejects stale, substituted, or mismatched operands.",
    operations:
      "Use closed acceptance-criterion add operations, or replacements that preserve the criterion and append only diagnosed uncovered requirement keys. Do not remove criteria or add unrelated requirement links on this narrow route. Fix every typed uncovered-requirement issue while preserving unrelated rows. The host applies the operations to the exact base, materializes a complete immutable V3 draft, and revalidates the whole candidate.",
    summary: { schema: SpecificationRoutingSummaryV1Schema },
  });
}

/** Historical trace-capable V2 reader; active new starts use keyed V3. */
export function parseSpecificationDraftV2(
  bytes: Uint8Array,
  input: {
    readonly request: unknown;
    readonly frame: DefinitionFrameV2;
    readonly priorSpecification?: unknown;
    readonly admission?: EvidenceAdmissionV2;
  }
): {
  readonly draft: SpecificationDraftV2;
  readonly summary: SpecificationRoutingSummaryV1;
  readonly legacyCore: SpecificationDraftV1;
} {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES) {
    throw draftFailure(
      "FRAMING_INVALID",
      "SpecificationDraftV2 output exceeds the draft byte bound"
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV2 output is not UTF-8");
  }
  if (
    text.includes("\r") ||
    text.includes("\ufeff") ||
    text.includes("\0") ||
    text.includes("```") ||
    text.split("\n").filter((line) => line.startsWith("SPECIFICATION_CORE:")).length !== 1 ||
    text.split("\n").filter((line) => line.startsWith("SUMMARY:")).length !== 1
  ) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV2 footer framing is invalid");
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = framed.split("\n");
  const filled = lines.flatMap((line, index) => (line.length > 0 ? [index] : []));
  const coreIndex = filled.at(-2);
  const summaryIndex = filled.at(-1);
  const coreLine = coreIndex === undefined ? undefined : lines[coreIndex];
  const summaryLine = summaryIndex === undefined ? undefined : lines[summaryIndex];
  if (
    coreIndex === undefined ||
    summaryIndex === undefined ||
    coreLine === undefined ||
    summaryLine === undefined ||
    !coreLine.startsWith("SPECIFICATION_CORE:") ||
    !summaryLine.startsWith("SUMMARY:") ||
    summaryIndex !== lines.length - 1 ||
    Buffer.byteLength(coreLine, "utf8") > MAX_SPECIFICATION_CORE_LINE_BYTES ||
    Buffer.byteLength(summaryLine, "utf8") > MAX_SPECIFICATION_SUMMARY_LINE_BYTES
  ) {
    throw draftFailure(
      "FRAMING_INVALID",
      "SpecificationDraftV2 requires core and summary as final lines"
    );
  }
  const summary = parsePersistedSpecificationRoutingSummary(summaryLine);
  if (summary === undefined)
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV2 SUMMARY is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreLine.slice("SPECIFICATION_CORE:".length));
  } catch {
    throw draftFailure("JSON_INVALID", "SpecificationDraftV2 core footer is not JSON");
  }
  let draft: SpecificationDraftV2;
  try {
    draft = parseSpecificationDraftV2Shape({
      ...(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
      specification_report: lines.slice(0, coreIndex).join("\n"),
    });
  } catch (error) {
    throw draftFailure(
      "SCHEMA_INVALID",
      error instanceof Error ? error.message : "invalid V2 draft"
    );
  }
  if (draft.specification.confidence !== summary.confidence) {
    throw draftFailure(
      "SEMANTIC_INVALID",
      "SpecificationDraftV2 confidence disagrees with SUMMARY"
    );
  }
  const frameV1 = canonicalizeDefinitionFrame({
    request: input.request,
    selectedProfileId: input.frame.profile.profile_id,
    profileSelectionBasis: input.frame.profile_selection_basis,
    route: input.frame.route,
    routeReason: input.frame.route_reason,
    clarificationQuestions:
      input.frame.route === "clarify"
        ? input.frame.questions
            .filter((q) => q.owner === "caller")
            .slice(0, 16)
            .map((q) => q.question)
        : [],
    evidenceQuestions:
      input.frame.route === "evidence"
        ? input.frame.questions
            .filter((q) => q.owner === "evidence")
            .slice(0, 16)
            .map((q) => q.question)
        : [],
  });
  const legacyCore = validateSpecificationDraft(
    {
      specification_report: draft.specification_report,
      ...draft.specification,
    },
    {
      request: input.request,
      frame: frameV1,
      ...(input.admission === undefined
        ? {}
        : { standardEvidenceIds: v2StandardEvidenceIds(draft, input.admission) ?? [] }),
      ...(input.priorSpecification === undefined
        ? {}
        : { priorSpecification: input.priorSpecification }),
    }
  );
  validateProtectedDefinitionDraft({ request: input.request, draft: legacyCore });
  return { draft, summary, legacyCore };
}

function parseV3CandidateFraming(bytes: Uint8Array): {
  readonly draft: SpecificationDraftV3;
  readonly summary: SpecificationRoutingSummaryV1;
} {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > MAX_PERSISTED_SPECIFICATION_DRAFT_BYTES) {
    throw draftFailure(
      "FRAMING_INVALID",
      "SpecificationDraftV3 output exceeds the draft byte bound"
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV3 output is not UTF-8");
  }
  if (
    text.includes("\r") ||
    text.includes("\ufeff") ||
    text.includes("\0") ||
    text.includes("```") ||
    text.split("\n").filter((line) => line.startsWith("SPECIFICATION_CORE:")).length !== 1 ||
    text.split("\n").filter((line) => line.startsWith("SUMMARY:")).length !== 1
  ) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV3 footer framing is invalid");
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (framed.endsWith("\n")) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV3 permits one trailing LF");
  }
  const lines = framed.split("\n");
  const filled = lines.flatMap((line, index) => (line.length > 0 ? [index] : []));
  const coreIndex = filled.at(-2);
  const summaryIndex = filled.at(-1);
  const coreLine = coreIndex === undefined ? undefined : lines[coreIndex];
  const summaryLine = summaryIndex === undefined ? undefined : lines[summaryIndex];
  if (
    coreIndex === undefined ||
    summaryIndex === undefined ||
    coreLine === undefined ||
    summaryLine === undefined ||
    !coreLine.startsWith("SPECIFICATION_CORE:") ||
    !summaryLine.startsWith("SUMMARY:") ||
    summaryIndex !== lines.length - 1 ||
    Buffer.byteLength(coreLine, "utf8") > MAX_SPECIFICATION_CORE_LINE_BYTES ||
    Buffer.byteLength(summaryLine, "utf8") > MAX_SPECIFICATION_SUMMARY_LINE_BYTES
  ) {
    throw draftFailure(
      "FRAMING_INVALID",
      "SpecificationDraftV3 requires core and summary as final lines"
    );
  }
  const summary = parsePersistedSpecificationRoutingSummary(summaryLine);
  if (summary === undefined) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftV3 SUMMARY is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreLine.slice("SPECIFICATION_CORE:".length));
  } catch {
    throw draftFailure("JSON_INVALID", "SpecificationDraftV3 core footer is not JSON");
  }
  let draft: SpecificationDraftV3;
  try {
    draft = parseSpecificationDraftV3Shape({
      ...(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
      specification_report: lines.slice(0, coreIndex).join("\n"),
    });
  } catch (error) {
    throw draftFailure(
      "SCHEMA_INVALID",
      error instanceof Error ? error.message : "invalid V3 draft"
    );
  }
  if (draft.specification.confidence !== summary.confidence) {
    throw draftFailure(
      "SEMANTIC_INVALID",
      "SpecificationDraftV3 confidence disagrees with SUMMARY"
    );
  }
  return { draft, summary };
}

/** Shape/framing-only read used by the exact-base repair applier. */
export function parseSpecificationDraftV3Candidate(bytes: Uint8Array): {
  readonly draft: SpecificationDraftV3;
  readonly summary: SpecificationRoutingSummaryV1;
} {
  return parseV3CandidateFraming(bytes);
}

export function parseSpecificationDraftV3(
  bytes: Uint8Array,
  input: {
    readonly request: unknown;
    readonly frame: DefinitionFrameV2;
    readonly priorSpecification?: unknown;
    readonly admission?: EvidenceAdmissionV2;
  }
): {
  readonly draft: SpecificationDraftV3;
  readonly summary: SpecificationRoutingSummaryV1;
  readonly legacyCore: SpecificationDraftV1;
  readonly compatibilityDraft: SpecificationDraftV2;
} {
  const request = validateDefinitionRequest(input.request);
  const { draft, summary } = parseV3CandidateFraming(bytes);
  const sealIssues = v3DraftSealIssues(draft, request);
  if (sealIssues.length > 0) {
    throw new SpecificationDraftValidationError(
      "SEMANTIC_INVALID",
      sealIssues.map((issue) => issue.detail),
      [],
      sealIssues
    );
  }
  let compatibilityDraft: SpecificationDraftV2;
  try {
    compatibilityDraft = v3CompatibilityDraft(draft);
  } catch (error) {
    throw draftFailure(
      "PROJECTION_INVALID",
      error instanceof Error ? error.message : "V3 compatibility projection failed"
    );
  }
  const frameV1 = canonicalizeDefinitionFrame({
    request,
    selectedProfileId: input.frame.profile.profile_id,
    profileSelectionBasis: input.frame.profile_selection_basis,
    route: input.frame.route,
    routeReason: input.frame.route_reason,
    clarificationQuestions:
      input.frame.route === "clarify"
        ? input.frame.questions
            .filter((question) => question.owner === "caller")
            .slice(0, 16)
            .map((question) => question.question)
        : [],
    evidenceQuestions:
      input.frame.route === "evidence"
        ? input.frame.questions
            .filter((question) => question.owner === "evidence")
            .slice(0, 16)
            .map((question) => question.question)
        : [],
  });
  const legacyCore = validateSpecificationDraft(
    {
      specification_report: compatibilityDraft.specification_report,
      ...compatibilityDraft.specification,
    },
    {
      request,
      frame: frameV1,
      ...(input.admission === undefined
        ? {}
        : {
            standardEvidenceIds: v2StandardEvidenceIds(compatibilityDraft, input.admission) ?? [],
          }),
      ...(input.priorSpecification === undefined
        ? {}
        : { priorSpecification: input.priorSpecification }),
    }
  );
  validateProtectedDefinitionDraft({ request, draft: legacyCore });
  return { draft, summary, legacyCore, compatibilityDraft };
}

export function persistedSpecificationDraftV3(draft: SpecificationDraftV3): Uint8Array {
  const checked = parseSpecificationDraftV3Shape(draft);
  const { specification_report: report, ...core } = checked;
  return Buffer.from(
    `${report}\nSPECIFICATION_CORE:${canonicalJson(core)}\nSUMMARY:${canonicalJson({ confidence: checked.specification.confidence, complete: true })}`,
    "utf8"
  );
}

export function parseSpecificationDraftRepair(bytes: Uint8Array): {
  readonly repair: SpecificationDraftRepairV1;
  readonly summary: SpecificationRoutingSummaryV1;
} {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > 131_072) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftRepairV1 exceeds 128 KiB");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftRepairV1 is not UTF-8");
  }
  if (
    text.includes("\r") ||
    text.includes("\ufeff") ||
    text.includes("\0") ||
    text.includes("```")
  ) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftRepairV1 framing is invalid");
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = framed.split("\n");
  if (
    lines.length !== 2 ||
    lines[0]?.startsWith("SPECIFICATION_REPAIR:") !== true ||
    lines[1]?.startsWith("SUMMARY:") !== true
  ) {
    throw draftFailure(
      "FRAMING_INVALID",
      "SpecificationDraftRepairV1 requires one repair line and one final SUMMARY line"
    );
  }
  const summary = parsePersistedSpecificationRoutingSummary(lines[1]);
  if (summary === undefined) {
    throw draftFailure("FRAMING_INVALID", "SpecificationDraftRepairV1 SUMMARY is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0].slice("SPECIFICATION_REPAIR:".length));
  } catch {
    throw draftFailure("JSON_INVALID", "SpecificationDraftRepairV1 body is not JSON");
  }
  let repair: SpecificationDraftRepairV1;
  try {
    repair = validateSkillSchema(
      SpecificationDraftRepairV1Schema,
      value,
      "SpecificationDraftRepairV1"
    );
  } catch (error) {
    throw draftFailure(
      "SCHEMA_INVALID",
      error instanceof Error ? error.message : "invalid SpecificationDraftRepairV1"
    );
  }
  if (
    repair.base_draft_ref.kind !== "specification-draft" ||
    repair.base_draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3" ||
    repair.base_draft_ref.content_schema.schema_version !== 3 ||
    repair.base_draft_ref.content_digest !== repair.base_draft_sha256 ||
    repair.diagnostic_ref.kind !== "seal-diagnostic" ||
    repair.diagnostic_ref.run_id !== repair.base_draft_ref.run_id
  ) {
    throw draftFailure("SEMANTIC_INVALID", "SpecificationDraftRepairV1 operand binding is invalid");
  }
  return { repair, summary };
}

export function applySpecificationDraftRepair(input: {
  readonly base: SpecificationDraftV3;
  readonly repair: SpecificationDraftRepairV1;
}): SpecificationDraftV3 {
  const base = parseSpecificationDraftV3Shape(input.base);
  const repair = validateSkillSchema(
    SpecificationDraftRepairV1Schema,
    input.repair,
    "SpecificationDraftRepairV1"
  );
  let criteria = [...base.specification.acceptance_criteria];
  for (const operation of repair.operations) {
    if (operation.operation === "add_acceptance_criterion") {
      if (criteria.some((entry) => entry.draft_key === operation.criterion.draft_key)) {
        throw draftFailure(
          "SEMANTIC_INVALID",
          `repair adds duplicate acceptance criterion key '${operation.criterion.draft_key}'`
        );
      }
      criteria.push(operation.criterion);
      continue;
    }
    const index = criteria.findIndex((entry) => entry.draft_key === operation.criterion_key);
    if (index < 0) {
      throw draftFailure(
        "SEMANTIC_INVALID",
        `repair references unknown acceptance criterion key '${operation.criterion_key}'`
      );
    }
    if (operation.operation === "remove_acceptance_criterion") {
      criteria = criteria.filter((_, entryIndex) => entryIndex !== index);
      continue;
    }
    if (operation.criterion.draft_key !== operation.criterion_key) {
      throw draftFailure(
        "SEMANTIC_INVALID",
        "replacement acceptance criterion cannot rename its draft key"
      );
    }
    criteria = criteria.map((entry, entryIndex) =>
      entryIndex === index ? operation.criterion : entry
    );
  }
  return parseSpecificationDraftV3Shape({
    ...base,
    specification: { ...base.specification, acceptance_criteria: criteria },
  });
}
