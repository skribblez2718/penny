import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  ArtifactRefSchema,
  LivenessPolicyV1Schema,
  type ArtifactRef,
  type InputArtifacts,
  type JsonValue,
} from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SchemaIdSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  TextSchema,
  assertDerivedId,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const QUESTION_BYTES = 32_768;
const CONTEXT_SOURCE_BYTES = 32_768;
const CONTEXT_TOTAL_BYTES = 131_072;
const MAX_SCOPE_ITEMS = 32;
const MAX_CONTEXT_BINDINGS = 9;
const MAX_INPUT_PRODUCTS = 8;
const MAX_CLAIMS = 512;
const MAX_SOURCES = 512;
const MAX_EVIDENCE = 2_048;
const MAX_FINDINGS = 128;
export const MAX_RESEARCH_SEMANTIC_DRAFT_BYTES = 1_048_576;
const HOST_LIVENESS_FIELDS = new Set([
  "max_steps",
  "total_phase_repair_invocations",
  "model_turns_per_worker",
  "model_turns_per_run",
  "tool_calls_per_worker",
  "tool_calls_per_run",
  "external_calls_per_worker",
  "external_calls_per_run",
  "worker_wall_clock_ms",
  "run_wall_clock_ms",
  "malformed_results_per_state_branch",
  "identical_malformed_digest_limit",
  "protocol_errors_per_worker",
  "identical_protocol_digest_limit",
]);
const LEGACY_CONSTRAINT_FIELDS = new Set([
  "mode",
  "scope",
  "verification_model_override",
  "validate_model",
  "budget_overrides",
  "max_sub_queries",
  "max_fan_width",
  "total_research_rounds",
  "max_research_rounds",
  "max_evaluator_attempts_per_loop",
  "max_iterations",
  "critique_passes",
  "context_bindings",
  "report_format",
]);

const ScopeSchema = Type.Object(
  {
    include: Type.Array(TextSchema({ maxBytes: QUESTION_BYTES }), {
      maxItems: MAX_SCOPE_ITEMS,
      uniqueItems: true,
    }),
    exclude: Type.Array(TextSchema({ maxBytes: QUESTION_BYTES }), {
      maxItems: MAX_SCOPE_ITEMS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

const BudgetOverridesSchema = Type.Object(
  {
    max_sub_queries: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    max_fan_width: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    total_research_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    max_evaluator_attempts_per_loop: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    critique_passes: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  },
  { additionalProperties: false }
);

const ContextSlotSchema = Type.Union([
  Type.Literal("domain_guidance"),
  Type.Literal("standard_guidance"),
  Type.Literal("output_shape_guidance"),
]);
export type ResearchContextSlotV1 = Static<typeof ContextSlotSchema>;

const VersionedDocumentBindingSchema = Type.Object(
  {
    slot: ContextSlotSchema,
    binding_kind: Type.Literal("versioned_document"),
    selected_by: Type.Union([Type.Literal("caller"), Type.Literal("host")]),
    source_id: OpaqueIdSchema,
    document_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
    expected_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ApprovedKbResultBindingSchema = Type.Object(
  {
    slot: ContextSlotSchema,
    binding_kind: Type.Literal("approved_kb_result"),
    selected_by: Type.Union([Type.Literal("caller"), Type.Literal("host")]),
    source_id: OpaqueIdSchema,
    kb_profile_id: OpaqueIdSchema,
    result_id: OpaqueIdSchema,
    expected_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const CallerInputBindingSchema = Type.Object(
  {
    slot: Type.Literal("output_shape_guidance"),
    binding_kind: Type.Literal("caller_input"),
    selected_by: Type.Literal("caller"),
    source_id: OpaqueIdSchema,
    content: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
  },
  { additionalProperties: false }
);

export const ResearchContextBindingRequestV1Schema = Type.Union([
  VersionedDocumentBindingSchema,
  ApprovedKbResultBindingSchema,
  CallerInputBindingSchema,
]);
export type ResearchContextBindingRequestV1 = Static<typeof ResearchContextBindingRequestV1Schema>;

const ResearchInputProductV1Schema = Type.Object(
  {
    port_name: Type.Literal("prior_grounded_synthesis"),
    artifact_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ResearchRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-request.v1"),
    schema_version: Type.Literal(1),
    question: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    scope: ScopeSchema,
    mode: Type.Union([
      Type.Literal("quick"),
      Type.Literal("standard"),
      Type.Literal("deep"),
      Type.Null(),
    ]),
    verification_model_override: Type.Union([OpaqueIdSchema, Type.Null()]),
    budget_overrides: BudgetOverridesSchema,
    context_bindings: Type.Array(ResearchContextBindingRequestV1Schema, {
      maxItems: MAX_CONTEXT_BINDINGS,
    }),
    input_products: Type.Array(ResearchInputProductV1Schema, {
      maxItems: MAX_INPUT_PRODUCTS,
    }),
  },
  { additionalProperties: false }
);
export type ResearchRequestV1 = Static<typeof ResearchRequestV1Schema>;

function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillSchemaValidationError(label, ["value must be an object"]);
  }
  return value;
}

function optionalInteger(
  value: JsonValue | undefined,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SkillSchemaValidationError(label, [
      `value must be an integer from ${minimum} through ${maximum}`,
    ]);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SkillSchemaValidationError(label, ["value must be a string"]);
  }
  return value;
}

function stringList(value: JsonValue | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SkillSchemaValidationError(label, ["value must be a string array"]);
  }
  const output = value.map((item) => String(item).normalize("NFC"));
  for (const [index, item] of output.entries()) {
    assertText(item, `${label}[${index}]`, {
      maxBytes: QUESTION_BYTES,
      multiline: true,
    });
  }
  assertUnique(output, label);
  return output;
}

function assertContextBinding(binding: ResearchContextBindingRequestV1, index: number): void {
  assertOpaqueId(binding.source_id, `research request context_bindings[${index}].source_id`);
  if (binding.binding_kind === "versioned_document") {
    assertOpaqueId(binding.document_id, `research request context_bindings[${index}].document_id`);
    assertOpaqueId(binding.revision_id, `research request context_bindings[${index}].revision_id`);
  } else if (binding.binding_kind === "approved_kb_result") {
    assertOpaqueId(
      binding.kb_profile_id,
      `research request context_bindings[${index}].kb_profile_id`
    );
    assertOpaqueId(binding.result_id, `research request context_bindings[${index}].result_id`);
  } else {
    assertText(binding.content, `research request context_bindings[${index}].content`, {
      minBytes: 1,
      maxBytes: QUESTION_BYTES,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
}

export function validateResearchRequest(value: unknown): ResearchRequestV1 {
  const request = validateSkillSchema(ResearchRequestV1Schema, value, "ResearchRequestV1");
  assertText(request.question, "ResearchRequestV1.question", {
    minBytes: 1,
    maxBytes: QUESTION_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  for (const [listName, values] of [
    ["include", request.scope.include],
    ["exclude", request.scope.exclude],
  ] as const) {
    for (const [index, item] of values.entries()) {
      assertText(item, `ResearchRequestV1.scope.${listName}[${index}]`, {
        maxBytes: QUESTION_BYTES,
        multiline: true,
      });
    }
    assertUnique(values, `ResearchRequestV1.scope.${listName}`);
  }
  const include = new Set(request.scope.include);
  const overlap = request.scope.exclude.find((item) => include.has(item));
  if (overlap !== undefined) {
    throw new SkillSchemaValidationError("ResearchRequestV1.scope", [
      `include and exclude overlap at '${overlap}'`,
    ]);
  }
  const counts: Record<ResearchContextSlotV1, number> = {
    domain_guidance: 0,
    standard_guidance: 0,
    output_shape_guidance: 0,
  };
  const sources: string[] = [];
  for (const [index, binding] of request.context_bindings.entries()) {
    assertContextBinding(binding, index);
    counts[binding.slot] += 1;
    sources.push(binding.source_id);
  }
  if (
    counts.domain_guidance > 4 ||
    counts.standard_guidance > 4 ||
    counts.output_shape_guidance > 1
  ) {
    throw new SkillSchemaValidationError("ResearchRequestV1.context_bindings", [
      "slot limits are domain<=4, standard<=4, output-shape<=1",
    ]);
  }
  assertUnique(sources, "ResearchRequestV1.context_bindings source IDs");
  const productIds = request.input_products.map((product) => product.artifact_ref.artifact_id);
  assertUnique(productIds, "ResearchRequestV1.input_products artifact refs");
  if (request.verification_model_override !== null) {
    assertOpaqueId(request.verification_model_override, "ResearchRequestV1 verification model");
  }
  return request;
}

function parseScope(value: JsonValue | undefined): ResearchRequestV1["scope"] {
  if (value === undefined) return { include: [], exclude: [] };
  const input = record(value, "research scope");
  const unknown = Object.keys(input).filter((key) => key !== "include" && key !== "exclude");
  if (unknown.length > 0) {
    throw new SkillSchemaValidationError("research scope", [
      `unknown field(s): ${unknown.sort().join(", ")}`,
    ]);
  }
  return {
    include: stringList(input.include, "research scope.include"),
    exclude: stringList(input.exclude, "research scope.exclude"),
  };
}

function aliasInteger(
  constraints: Readonly<Record<string, JsonValue>>,
  canonicalName: string,
  legacyName: string,
  minimum: number,
  maximum: number
): number | undefined {
  const canonical = optionalInteger(
    constraints[canonicalName],
    `constraints.${canonicalName}`,
    minimum,
    maximum
  );
  const legacy = optionalInteger(
    constraints[legacyName],
    `constraints.${legacyName}`,
    minimum,
    maximum
  );
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new SkillSchemaValidationError("research budget aliases", [
      `${canonicalName} and ${legacyName} disagree`,
    ]);
  }
  return canonical ?? legacy;
}

function parseBudgetOverrides(
  constraints: Readonly<Record<string, JsonValue>>
): ResearchRequestV1["budget_overrides"] {
  const nestedValue = constraints.budget_overrides;
  const nested =
    nestedValue === undefined ? {} : record(nestedValue, "constraints.budget_overrides");
  const unknown = Object.keys(nested).filter(
    (key) =>
      ![
        "max_sub_queries",
        "max_fan_width",
        "total_research_rounds",
        "max_evaluator_attempts_per_loop",
        "critique_passes",
      ].includes(key)
  );
  if (unknown.length > 0) {
    throw new SkillSchemaValidationError("constraints.budget_overrides", [
      `unknown field(s): ${unknown.sort().join(", ")}`,
    ]);
  }
  const direct = (name: string, minimum: number, maximum: number): number | undefined => {
    const outer = optionalInteger(constraints[name], `constraints.${name}`, minimum, maximum);
    const inner = optionalInteger(
      nested[name],
      `constraints.budget_overrides.${name}`,
      minimum,
      maximum
    );
    if (outer !== undefined && inner !== undefined && outer !== inner) {
      throw new SkillSchemaValidationError("research budget overrides", [
        `${name} is supplied with conflicting values`,
      ]);
    }
    return inner ?? outer;
  };
  const maxSubQueries = direct("max_sub_queries", 1, 64);
  const maxFanWidth = direct("max_fan_width", 1, 64);
  const roundsNested = optionalInteger(
    nested.total_research_rounds,
    "constraints.budget_overrides.total_research_rounds",
    1,
    16
  );
  const roundsAlias = aliasInteger(
    constraints,
    "total_research_rounds",
    "max_research_rounds",
    1,
    16
  );
  if (roundsNested !== undefined && roundsAlias !== undefined && roundsNested !== roundsAlias) {
    throw new SkillSchemaValidationError("research budget overrides", [
      "total_research_rounds is supplied with conflicting values",
    ]);
  }
  const attemptsNested = optionalInteger(
    nested.max_evaluator_attempts_per_loop,
    "constraints.budget_overrides.max_evaluator_attempts_per_loop",
    1,
    16
  );
  const attemptsAlias = aliasInteger(
    constraints,
    "max_evaluator_attempts_per_loop",
    "max_iterations",
    1,
    16
  );
  if (
    attemptsNested !== undefined &&
    attemptsAlias !== undefined &&
    attemptsNested !== attemptsAlias
  ) {
    throw new SkillSchemaValidationError("research budget overrides", [
      "max_evaluator_attempts_per_loop is supplied with conflicting values",
    ]);
  }
  const critique = direct("critique_passes", 0, 2);
  const rounds = roundsNested ?? roundsAlias;
  const attempts = attemptsNested ?? attemptsAlias;
  return {
    ...(maxSubQueries === undefined ? {} : { max_sub_queries: maxSubQueries }),
    ...(maxFanWidth === undefined ? {} : { max_fan_width: maxFanWidth }),
    ...(rounds === undefined ? {} : { total_research_rounds: rounds }),
    ...(attempts === undefined ? {} : { max_evaluator_attempts_per_loop: attempts }),
    ...(critique === undefined ? {} : { critique_passes: critique }),
  };
}

function parseContextBindings(
  constraints: Readonly<Record<string, JsonValue>>
): ResearchContextBindingRequestV1[] {
  const raw = constraints.context_bindings;
  const parsed =
    raw === undefined
      ? []
      : validateSkillSchema(
          Type.Array(ResearchContextBindingRequestV1Schema, { maxItems: MAX_CONTEXT_BINDINGS }),
          raw,
          "constraints.context_bindings"
        );
  const reportFormat = optionalString(constraints.report_format, "constraints.report_format");
  if (reportFormat === undefined) return parsed;
  const content = reportFormat.normalize("NFC");
  assertText(content, "constraints.report_format", {
    minBytes: 1,
    maxBytes: QUESTION_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  return [
    ...parsed,
    {
      slot: "output_shape_guidance",
      binding_kind: "caller_input",
      selected_by: "caller",
      source_id: `caller-output-shape-${sha256(content).slice(0, 32)}`,
      content,
    },
  ];
}

function canonicalVerificationModelOverride(
  canonical: string | undefined,
  legacy: string | undefined
): string | null {
  const selected = canonical ?? legacy;
  if (selected === undefined) return null;
  if (canonical !== undefined || !selected.includes("/")) return selected;
  const encoded = `legacy-model-${Buffer.from(selected, "utf8").toString("base64url")}`;
  if (encoded.length > 128) {
    throw new SkillSchemaValidationError("constraints.validate_model", [
      "legacy provider/model override is too long for canonical identity",
    ]);
  }
  return encoded;
}

function isTypedGroundedSynthesisRef(binding: InputArtifacts["artifacts"][number]): boolean {
  return (
    binding.slot === "prior_grounded_synthesis" ||
    binding.ref.content_schema?.schema_id === "penny.grounded-synthesis.v1"
  );
}

export function canonicalizeResearchRequest(input: {
  readonly question: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
  readonly inputArtifacts?: InputArtifacts;
}): ResearchRequestV1 {
  if (Object.hasOwn(input.constraints, "rigor_escalation")) {
    throw new SkillSchemaValidationError("research constraints", [
      "rigor_escalation is not a supported request field",
    ]);
  }
  const forbiddenHost = Object.keys(input.constraints).filter((key) =>
    HOST_LIVENESS_FIELDS.has(key)
  );
  if (forbiddenHost.length > 0) {
    throw new SkillSchemaValidationError("research constraints", [
      `host liveness fields are not caller-supplied: ${forbiddenHost.sort().join(", ")}`,
    ]);
  }
  const unknown = Object.keys(input.constraints).filter(
    (key) => !LEGACY_CONSTRAINT_FIELDS.has(key) && !HOST_LIVENESS_FIELDS.has(key)
  );
  if (unknown.length > 0) {
    throw new SkillSchemaValidationError("research constraints", [
      `unknown field(s): ${unknown.sort().join(", ")}`,
    ]);
  }
  const modeValue = input.constraints.mode;
  const mode =
    modeValue === undefined || modeValue === null
      ? null
      : validateSkillSchema(
          Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")]),
          modeValue,
          "constraints.mode"
        );
  const verificationCanonical = optionalString(
    input.constraints.verification_model_override,
    "constraints.verification_model_override"
  );
  const verificationLegacy = optionalString(
    input.constraints.validate_model,
    "constraints.validate_model"
  );
  if (
    verificationCanonical !== undefined &&
    verificationLegacy !== undefined &&
    verificationCanonical !== verificationLegacy
  ) {
    throw new SkillSchemaValidationError("research verification model aliases", [
      "verification_model_override and validate_model disagree",
    ]);
  }
  const bindings = input.inputArtifacts?.artifacts ?? [];
  const slots = bindings.map((binding) => binding.slot);
  const refIds = bindings.map((binding) => binding.ref.artifact_id);
  assertUnique(slots, "research input artifact slots");
  assertUnique(refIds, "research input artifact refs");
  const products = bindings.filter(isTypedGroundedSynthesisRef).map((binding) => ({
    port_name: "prior_grounded_synthesis" as const,
    artifact_ref: binding.ref,
  }));
  if (products.length > MAX_INPUT_PRODUCTS) {
    throw new SkillSchemaValidationError("research input products", ["at most 8 are allowed"]);
  }
  const question = input.question.normalize("NFC");
  const request = validateResearchRequest({
    schema_id: "penny.research-request.v1",
    schema_version: 1,
    question,
    scope: parseScope(input.constraints.scope),
    mode,
    verification_model_override: canonicalVerificationModelOverride(
      verificationCanonical,
      verificationLegacy
    ),
    budget_overrides: parseBudgetOverrides(input.constraints),
    context_bindings: parseContextBindings(input.constraints),
    input_products: products,
  });
  return request;
}

export function researchRequestSha256(request: ResearchRequestV1): string {
  return sha256(canonicalJson(validateResearchRequest(request)));
}

/** Value-preserving compatibility projection consumed by the unchanged P1 playbook. */
export function researchRuntimeConstraints(
  requestValue: ResearchRequestV1,
  compatibility: { readonly legacyVerificationModelOverride?: string } = {}
): Record<string, JsonValue> {
  const request = validateResearchRequest(requestValue);
  const verificationModel =
    compatibility.legacyVerificationModelOverride ?? request.verification_model_override;
  return {
    ...(request.mode === null ? {} : { mode: request.mode }),
    ...(verificationModel === null ? {} : { validate_model: verificationModel }),
    ...(request.budget_overrides.max_sub_queries === undefined
      ? {}
      : { max_sub_queries: request.budget_overrides.max_sub_queries }),
    ...(request.budget_overrides.max_fan_width === undefined
      ? {}
      : { max_fan_width: request.budget_overrides.max_fan_width }),
    ...(request.budget_overrides.total_research_rounds === undefined
      ? {}
      : { max_research_rounds: request.budget_overrides.total_research_rounds }),
    ...(request.budget_overrides.max_evaluator_attempts_per_loop === undefined
      ? {}
      : { max_iterations: request.budget_overrides.max_evaluator_attempts_per_loop }),
    ...(request.budget_overrides.critique_passes === undefined
      ? {}
      : { critique_passes: request.budget_overrides.critique_passes }),
    ...((): Record<string, JsonValue> => {
      const caller = request.context_bindings.find(
        (binding) => binding.binding_kind === "caller_input"
      );
      return caller?.binding_kind === "caller_input" ? { report_format: caller.content } : {};
    })(),
  };
}

const ResearchStateSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("critiquing_plan"),
  Type.Literal("researching"),
  Type.Literal("synthesizing"),
  Type.Literal("critiquing_report"),
  Type.Literal("validating"),
]);
export type ResearchContextConsumerStateV1 = Static<typeof ResearchStateSchema>;

const DocumentRevisionSchema = Type.Object(
  {
    kind: Type.Literal("document"),
    document_id: OpaqueIdSchema,
    revision_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
const ApprovedKbRevisionSchema = Type.Object(
  {
    kind: Type.Literal("approved_kb"),
    kb_profile_id: OpaqueIdSchema,
    result_id: OpaqueIdSchema,
    approval_id: OpaqueIdSchema,
    approval_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const CallerRevisionSchema = Type.Object(
  {
    kind: Type.Literal("caller"),
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const FreshnessSchema = Type.Union([
  Type.Object({ status: Type.Literal("not_time_sensitive") }, { additionalProperties: false }),
  Type.Object(
    {
      status: Type.Literal("current"),
      observed_at: Rfc3339UtcSchema,
      valid_through: Rfc3339UtcSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("stale"),
      observed_at: Rfc3339UtcSchema,
      stale_at: Rfc3339UtcSchema,
    },
    { additionalProperties: false }
  ),
]);
const ConflictSchema = Type.Union([
  Type.Object({ status: Type.Literal("none") }, { additionalProperties: false }),
  Type.Object(
    {
      status: Type.Literal("resolved"),
      source_ids: Type.Array(OpaqueIdSchema, { minItems: 2, maxItems: 9, uniqueItems: true }),
      winner_source_id: OpaqueIdSchema,
      rationale_sha256: Sha256Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("unresolved"),
      source_ids: Type.Array(OpaqueIdSchema, { minItems: 2, maxItems: 9, uniqueItems: true }),
    },
    { additionalProperties: false }
  ),
]);

export const ContextSourceRefV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.context-source-ref.v1"),
    schema_version: Type.Literal(1),
    source_kind: Type.Union([
      Type.Literal("versioned_document"),
      Type.Literal("approved_kb_result"),
      Type.Literal("caller_input"),
    ]),
    source_id: OpaqueIdSchema,
    slot: ContextSlotSchema,
    role: Type.Union([
      Type.Literal("normative"),
      Type.Literal("advisory"),
      Type.Literal("evidentiary"),
      Type.Literal("caller_constraint"),
    ]),
    scope_id: OpaqueIdSchema,
    content: Type.Object(
      {
        sha256: Sha256Schema,
        utf8_bytes: Type.Integer({ minimum: 1, maximum: CONTEXT_SOURCE_BYTES }),
        media_type: Type.Union([
          Type.Literal("text/plain"),
          Type.Literal("text/markdown"),
          Type.Literal("application/json"),
        ]),
      },
      { additionalProperties: false }
    ),
    revision: Type.Union([DocumentRevisionSchema, ApprovedKbRevisionSchema, CallerRevisionSchema]),
    freshness: FreshnessSchema,
    upstream_locators: Type.Array(
      Type.Object(
        {
          source_id: OpaqueIdSchema,
          locator: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: false }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    provider: Type.Object(
      {
        provider_id: OpaqueIdSchema,
        configuration_sha256: Sha256Schema,
        eligibility_record_id: OpaqueIdSchema,
        eligibility_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    verification_disposition: Type.Union([
      Type.Literal("accepted_for_scope"),
      Type.Literal("advisory_only"),
      Type.Literal("requires_independent_verification"),
      Type.Literal("caller_constraint"),
    ]),
    conflict: ConflictSchema,
    consumer_states: Type.Array(ResearchStateSchema, {
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type ContextSourceRefV1 = Static<typeof ContextSourceRefV1Schema>;

export const CONTEXT_CONSUMER_STATES: Readonly<
  Record<ResearchContextSlotV1, readonly ResearchContextConsumerStateV1[]>
> = {
  domain_guidance: [
    "planning",
    "critiquing_plan",
    "researching",
    "synthesizing",
    "critiquing_report",
    "validating",
  ],
  standard_guidance: [
    "planning",
    "critiquing_plan",
    "researching",
    "synthesizing",
    "critiquing_report",
    "validating",
  ],
  output_shape_guidance: ["synthesizing", "critiquing_report", "validating"],
};

export function validateContextSourceRef(
  value: unknown,
  boundSourceIds: readonly string[] = []
): ContextSourceRefV1 {
  const source = validateSkillSchema(ContextSourceRefV1Schema, value, "ContextSourceRefV1");
  assertOpaqueId(source.source_id, "ContextSourceRefV1.source_id");
  assertOpaqueId(source.scope_id, "ContextSourceRefV1.scope_id");
  assertOpaqueId(source.provider.provider_id, "ContextSourceRefV1.provider.provider_id");
  assertOpaqueId(
    source.provider.eligibility_record_id,
    "ContextSourceRefV1.provider.eligibility_record_id"
  );
  for (const [index, upstream] of source.upstream_locators.entries()) {
    assertOpaqueId(upstream.source_id, `ContextSourceRefV1.upstream_locators[${index}].source_id`);
    assertText(upstream.locator, `ContextSourceRefV1.upstream_locators[${index}].locator`, {
      minBytes: 1,
      maxBytes: 2_048,
      multiline: false,
      trimmedNonEmpty: true,
    });
  }
  if (source.freshness.status === "current") {
    assertRfc3339Utc(source.freshness.observed_at, "ContextSourceRefV1 freshness observed_at");
    assertRfc3339Utc(source.freshness.valid_through, "ContextSourceRefV1 freshness valid_through");
    if (Date.parse(source.freshness.valid_through) < Date.parse(source.freshness.observed_at)) {
      throw new SkillSchemaValidationError("ContextSourceRefV1 freshness", [
        "valid_through precedes observed_at",
      ]);
    }
  }
  if (source.freshness.status === "stale") {
    throw new SkillSchemaValidationError("ContextSourceRefV1 freshness", [
      "stale context is not admitted to a worker",
    ]);
  }
  if (source.conflict.status === "unresolved") {
    throw new SkillSchemaValidationError("ContextSourceRefV1 conflict", [
      "unresolved conflicts are not admitted to a worker",
    ]);
  }
  if (source.conflict.status === "resolved") {
    assertUnique(source.conflict.source_ids, "ContextSourceRefV1 conflict sources");
    const allowed = new Set(
      boundSourceIds.length === 0 ? source.conflict.source_ids : boundSourceIds
    );
    if (
      !source.conflict.source_ids.every((sourceId) => allowed.has(sourceId)) ||
      !source.conflict.source_ids.includes(source.conflict.winner_source_id) ||
      !allowed.has(source.conflict.winner_source_id)
    ) {
      throw new SkillSchemaValidationError("ContextSourceRefV1 conflict", [
        "resolved conflicts may name only bound sources and one bound winner",
      ]);
    }
  }
  if (source.source_kind === "approved_kb_result") {
    if (
      source.role !== "advisory" ||
      source.revision.kind !== "approved_kb" ||
      source.upstream_locators.length === 0 ||
      !["advisory_only", "requires_independent_verification"].includes(
        source.verification_disposition
      )
    ) {
      throw new SkillSchemaValidationError("ContextSourceRefV1 approved KB source", [
        "approved KB context must remain advisory, approved, located, and independently bounded",
      ]);
    }
  } else if (source.source_kind === "versioned_document") {
    if (
      source.revision.kind !== "document" ||
      source.role === "caller_constraint" ||
      source.verification_disposition === "caller_constraint"
    ) {
      throw new SkillSchemaValidationError("ContextSourceRefV1 document source", [
        "document revision, role, and disposition disagree",
      ]);
    }
  } else if (
    source.revision.kind !== "caller" ||
    source.role !== "caller_constraint" ||
    source.slot !== "output_shape_guidance" ||
    source.verification_disposition !== "caller_constraint"
  ) {
    throw new SkillSchemaValidationError("ContextSourceRefV1 caller source", [
      "caller input must be an output-shape caller constraint",
    ]);
  }
  const expectedConsumers = CONTEXT_CONSUMER_STATES[source.slot];
  if (canonicalJson(source.consumer_states) !== canonicalJson(expectedConsumers)) {
    throw new SkillSchemaValidationError("ContextSourceRefV1 consumer_states", [
      "consumer states do not equal the frozen slot projection",
    ]);
  }
  return source;
}

export function assertResolvedContextContent(
  source: ContextSourceRefV1,
  content: string | Uint8Array
): Buffer {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (
    bytes.length > CONTEXT_SOURCE_BYTES ||
    bytes.length !== source.content.utf8_bytes ||
    sha256(bytes) !== source.content.sha256
  ) {
    throw new SkillSchemaValidationError("resolved research context", [
      "content digest or UTF-8 byte length does not match its safe envelope",
    ]);
  }
  return bytes;
}

export function assertContextOverlayBudget(sources: readonly ContextSourceRefV1[]): void {
  const total = sources.reduce((sum, source) => sum + source.content.utf8_bytes, 0);
  if (total > CONTEXT_TOTAL_BYTES) {
    throw new SkillSchemaValidationError("research context overlay", [
      "resolved overlay exceeds 128 KiB",
    ]);
  }
}

const StableId = (prefix: string) => Type.String({ pattern: `^${prefix}-[0-9]{4}$` });
const ConfidenceValueSchema = Type.Number({ minimum: 0, maximum: 1 });

const ClaimV1Schema = Type.Object(
  {
    claim_id: StableId("claim"),
    statement: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    claim_kind: Type.Union([
      Type.Literal("fact"),
      Type.Literal("inference"),
      Type.Literal("recommendation"),
    ]),
    support_status: Type.Union([
      Type.Literal("supported"),
      Type.Literal("qualified"),
      Type.Literal("unsupported"),
    ]),
    confidence: ConfidenceValueSchema,
    evidence_ids: Type.Array(StableId("evidence"), { maxItems: 128, uniqueItems: true }),
    qualifications: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
const SourceV1Schema = Type.Object(
  {
    source_id: StableId("source"),
    source_kind: Type.Union([
      Type.Literal("primary"),
      Type.Literal("secondary"),
      Type.Literal("context"),
    ]),
    role: Type.Union([
      Type.Literal("normative"),
      Type.Literal("evidentiary"),
      Type.Literal("advisory"),
    ]),
    tier: Type.Integer({ minimum: 1, maximum: 3 }),
    title: TextSchema({ minBytes: 1, maxBytes: 2_048, multiline: false }),
    locator: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: false }),
    published_at: Type.Optional(Rfc3339UtcSchema),
    observed_at: Type.Optional(Rfc3339UtcSchema),
  },
  { additionalProperties: false }
);
const EvidenceV1Schema = Type.Object(
  {
    evidence_id: StableId("evidence"),
    source_id: StableId("source"),
    locator: TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: false }),
    excerpt_sha256: Sha256Schema,
    evidence_artifact_id: ArtifactIdSchema,
    relation: Type.Union([
      Type.Literal("supports"),
      Type.Literal("contradicts"),
      Type.Literal("contextualizes"),
    ]),
  },
  { additionalProperties: false }
);
const ContradictionV1Schema = Type.Object(
  {
    contradiction_id: StableId("contradiction"),
    claim_ids: Type.Array(StableId("claim"), { minItems: 1, maxItems: 32, uniqueItems: true }),
    evidence_ids: Type.Array(StableId("evidence"), {
      minItems: 2,
      maxItems: 32,
      uniqueItems: true,
    }),
    status: Type.Union([
      Type.Literal("resolved"),
      Type.Literal("qualified"),
      Type.Literal("unresolved"),
    ]),
  },
  { additionalProperties: false }
);
const GapV1Schema = Type.Object(
  {
    gap_id: StableId("gap"),
    statement: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    affected_claim_ids: Type.Array(StableId("claim"), { maxItems: 128, uniqueItems: true }),
    gap_kind: Type.Union([
      Type.Literal("researchable"),
      Type.Literal("caller_decision"),
      Type.Literal("irreducible"),
    ]),
    blocking: Type.Boolean(),
  },
  { additionalProperties: false }
);
const UncertaintyV1Schema = Type.Object(
  {
    uncertainty_id: StableId("uncertainty"),
    statement: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    affected_claim_ids: Type.Array(StableId("claim"), { maxItems: 128, uniqueItems: true }),
    disposition: Type.Union([Type.Literal("qualified"), Type.Literal("blocking")]),
  },
  { additionalProperties: false }
);
const NarrativeSectionV1Schema = Type.Object(
  {
    section_id: StableId("section"),
    heading: TextSchema({ minBytes: 1, maxBytes: 512, multiline: false }),
    body: TextSchema({ minBytes: 1, maxBytes: 65_536, multiline: true }),
    claim_ids: Type.Array(StableId("claim"), { maxItems: MAX_CLAIMS, uniqueItems: true }),
    evidence_ids: Type.Array(StableId("evidence"), {
      maxItems: MAX_EVIDENCE,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

const ResearchSemanticDraftSourceV1Schema = Type.Object(
  {
    source_kind: SourceV1Schema.properties.source_kind,
    role: SourceV1Schema.properties.role,
    tier: SourceV1Schema.properties.tier,
    title: SourceV1Schema.properties.title,
    locator: SourceV1Schema.properties.locator,
    published_at: SourceV1Schema.properties.published_at,
    observed_at: SourceV1Schema.properties.observed_at,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftEvidenceV1Schema = Type.Object(
  {
    source_index: Type.Integer({ minimum: 0, maximum: MAX_SOURCES - 1 }),
    evidence_artifact_slot: Type.Integer({ minimum: 0, maximum: 63 }),
    locator: EvidenceV1Schema.properties.locator,
    excerpt: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    relation: EvidenceV1Schema.properties.relation,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftClaimV1Schema = Type.Object(
  {
    statement: ClaimV1Schema.properties.statement,
    claim_kind: ClaimV1Schema.properties.claim_kind,
    support_status: ClaimV1Schema.properties.support_status,
    confidence: ClaimV1Schema.properties.confidence,
    evidence_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_EVIDENCE - 1 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    qualifications: ClaimV1Schema.properties.qualifications,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftContradictionV1Schema = Type.Object(
  {
    claim_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_CLAIMS - 1 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    evidence_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_EVIDENCE - 1 }), {
      minItems: 2,
      maxItems: 32,
      uniqueItems: true,
    }),
    status: ContradictionV1Schema.properties.status,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftGapV1Schema = Type.Object(
  {
    statement: GapV1Schema.properties.statement,
    affected_claim_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_CLAIMS - 1 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    gap_kind: GapV1Schema.properties.gap_kind,
    blocking: GapV1Schema.properties.blocking,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftUncertaintyV1Schema = Type.Object(
  {
    statement: UncertaintyV1Schema.properties.statement,
    affected_claim_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_CLAIMS - 1 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    disposition: UncertaintyV1Schema.properties.disposition,
  },
  { additionalProperties: false }
);
const ResearchSemanticDraftSectionV1Schema = Type.Object(
  {
    heading: NarrativeSectionV1Schema.properties.heading,
    body: NarrativeSectionV1Schema.properties.body,
    claim_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_CLAIMS - 1 }), {
      maxItems: MAX_CLAIMS,
      uniqueItems: true,
    }),
    evidence_indexes: Type.Array(Type.Integer({ minimum: 0, maximum: MAX_EVIDENCE - 1 }), {
      maxItems: MAX_EVIDENCE,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const ResearchSemanticDraftV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-semantic-draft.v1"),
    schema_version: Type.Literal(1),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    executive_summary: TextSchema({
      minBytes: 1,
      maxBytes: QUESTION_BYTES,
      multiline: true,
    }),
    sources: Type.Array(ResearchSemanticDraftSourceV1Schema, {
      minItems: 1,
      maxItems: MAX_SOURCES,
    }),
    evidence: Type.Array(ResearchSemanticDraftEvidenceV1Schema, {
      minItems: 1,
      maxItems: MAX_EVIDENCE,
    }),
    claims: Type.Array(ResearchSemanticDraftClaimV1Schema, {
      minItems: 1,
      maxItems: MAX_CLAIMS,
    }),
    contradictions: Type.Array(ResearchSemanticDraftContradictionV1Schema, { maxItems: 256 }),
    unresolved_gaps: Type.Array(ResearchSemanticDraftGapV1Schema, { maxItems: 256 }),
    irreducible_uncertainties: Type.Array(ResearchSemanticDraftUncertaintyV1Schema, {
      maxItems: 256,
    }),
    sections: Type.Array(ResearchSemanticDraftSectionV1Schema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
export type ResearchSemanticDraftV1 = Static<typeof ResearchSemanticDraftV1Schema>;

function assertDraftIndexes(
  values: readonly number[],
  upperExclusive: number,
  label: string
): void {
  const dangling = values.find((value) => value >= upperExclusive);
  if (dangling !== undefined) {
    throw new SkillSchemaValidationError(label, [
      `index ${dangling} does not resolve within 0..${Math.max(upperExclusive - 1, 0)}`,
    ]);
  }
}

export function validateResearchSemanticDraft(
  value: unknown,
  encodedByteLength?: number
): ResearchSemanticDraftV1 {
  const draft = validateSkillSchema(
    ResearchSemanticDraftV1Schema,
    value,
    "ResearchSemanticDraftV1"
  );
  const canonicalByteLength = Buffer.byteLength(canonicalJson(draft), "utf8");
  const measuredByteLength = encodedByteLength ?? canonicalByteLength;
  if (
    !Number.isSafeInteger(measuredByteLength) ||
    measuredByteLength < 1 ||
    measuredByteLength > MAX_RESEARCH_SEMANTIC_DRAFT_BYTES ||
    canonicalByteLength > MAX_RESEARCH_SEMANTIC_DRAFT_BYTES
  ) {
    throw new SkillSchemaValidationError("ResearchSemanticDraftV1 bytes", [
      `draft exceeds the ${MAX_RESEARCH_SEMANTIC_DRAFT_BYTES} byte limit`,
    ]);
  }
  assertText(draft.title, "ResearchSemanticDraftV1.title", {
    minBytes: 1,
    maxBytes: 512,
    multiline: false,
    trimmedNonEmpty: true,
  });
  assertText(draft.executive_summary, "ResearchSemanticDraftV1.executive_summary", {
    minBytes: 1,
    maxBytes: QUESTION_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  for (const [index, source] of draft.sources.entries()) {
    assertText(source.title, `ResearchSemanticDraftV1.sources[${index}].title`, {
      minBytes: 1,
      maxBytes: 2_048,
      multiline: false,
      trimmedNonEmpty: true,
    });
    assertText(source.locator, `ResearchSemanticDraftV1.sources[${index}].locator`, {
      minBytes: 1,
      maxBytes: 4_096,
      multiline: false,
      trimmedNonEmpty: true,
    });
    if (source.published_at !== undefined) {
      assertRfc3339Utc(
        source.published_at,
        `ResearchSemanticDraftV1.sources[${index}].published_at`
      );
    }
    if (source.observed_at !== undefined) {
      assertRfc3339Utc(source.observed_at, `ResearchSemanticDraftV1.sources[${index}].observed_at`);
    }
  }
  for (const [index, evidence] of draft.evidence.entries()) {
    assertDraftIndexes(
      [evidence.source_index],
      draft.sources.length,
      `ResearchSemanticDraftV1.evidence[${index}].source_index`
    );
    assertText(evidence.locator, `ResearchSemanticDraftV1.evidence[${index}].locator`, {
      minBytes: 1,
      maxBytes: 4_096,
      multiline: false,
      trimmedNonEmpty: true,
    });
    assertText(evidence.excerpt, `ResearchSemanticDraftV1.evidence[${index}].excerpt`, {
      minBytes: 1,
      maxBytes: QUESTION_BYTES,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
  for (const [index, claim] of draft.claims.entries()) {
    assertDraftIndexes(
      claim.evidence_indexes,
      draft.evidence.length,
      `ResearchSemanticDraftV1.claims[${index}].evidence_indexes`
    );
    assertText(claim.statement, `ResearchSemanticDraftV1.claims[${index}].statement`, {
      minBytes: 1,
      maxBytes: QUESTION_BYTES,
      multiline: true,
      trimmedNonEmpty: true,
    });
    for (const [qualificationIndex, qualification] of claim.qualifications.entries()) {
      assertText(
        qualification,
        `ResearchSemanticDraftV1.claims[${index}].qualifications[${qualificationIndex}]`,
        { minBytes: 1, maxBytes: 4_096, multiline: true, trimmedNonEmpty: true }
      );
    }
    if (
      claim.support_status === "supported" &&
      !claim.evidence_indexes.some(
        (evidenceIndex) => draft.evidence[evidenceIndex]?.relation === "supports"
      )
    ) {
      throw new SkillSchemaValidationError(`ResearchSemanticDraftV1.claims[${index}]`, [
        "supported claims require supporting evidence",
      ]);
    }
    if (claim.support_status === "qualified" && claim.qualifications.length === 0) {
      throw new SkillSchemaValidationError(`ResearchSemanticDraftV1.claims[${index}]`, [
        "qualified claims require an explicit qualification",
      ]);
    }
  }
  for (const [index, contradiction] of draft.contradictions.entries()) {
    assertDraftIndexes(
      contradiction.claim_indexes,
      draft.claims.length,
      `ResearchSemanticDraftV1.contradictions[${index}].claim_indexes`
    );
    assertDraftIndexes(
      contradiction.evidence_indexes,
      draft.evidence.length,
      `ResearchSemanticDraftV1.contradictions[${index}].evidence_indexes`
    );
  }
  for (const [index, gap] of draft.unresolved_gaps.entries()) {
    assertDraftIndexes(
      gap.affected_claim_indexes,
      draft.claims.length,
      `ResearchSemanticDraftV1.unresolved_gaps[${index}].affected_claim_indexes`
    );
    assertText(gap.statement, `ResearchSemanticDraftV1.unresolved_gaps[${index}].statement`, {
      minBytes: 1,
      maxBytes: QUESTION_BYTES,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
  for (const [index, uncertainty] of draft.irreducible_uncertainties.entries()) {
    assertDraftIndexes(
      uncertainty.affected_claim_indexes,
      draft.claims.length,
      `ResearchSemanticDraftV1.irreducible_uncertainties[${index}].affected_claim_indexes`
    );
    assertText(
      uncertainty.statement,
      `ResearchSemanticDraftV1.irreducible_uncertainties[${index}].statement`,
      { minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true, trimmedNonEmpty: true }
    );
  }
  for (const [index, section] of draft.sections.entries()) {
    assertDraftIndexes(
      section.claim_indexes,
      draft.claims.length,
      `ResearchSemanticDraftV1.sections[${index}].claim_indexes`
    );
    assertDraftIndexes(
      section.evidence_indexes,
      draft.evidence.length,
      `ResearchSemanticDraftV1.sections[${index}].evidence_indexes`
    );
    assertText(section.heading, `ResearchSemanticDraftV1.sections[${index}].heading`, {
      minBytes: 1,
      maxBytes: 512,
      multiline: false,
      trimmedNonEmpty: true,
    });
    assertText(section.body, `ResearchSemanticDraftV1.sections[${index}].body`, {
      minBytes: 1,
      maxBytes: 65_536,
      multiline: true,
      trimmedNonEmpty: true,
    });
  }
  return draft;
}

export function researchSemanticDraftPromptContract(): string {
  return canonicalJson({
    schema: ResearchSemanticDraftV1Schema,
    draft_bytes: {
      encoding: "UTF-8 JSON",
      maximum: MAX_RESEARCH_SEMANTIC_DRAFT_BYTES,
      canonical_serialization_required: false,
      response_framing: "draft JSON value, one LF, then the closed SUMMARY line",
    },
    local_indexes: {
      base: 0,
      ids: "owner-assigned deterministically by array order",
      evidence_artifact_slot: "owner-selected Echo artifact slot",
    },
    owner_fields_forbidden: [
      "request",
      "provenance",
      "stable global IDs",
      "artifact IDs",
      "digests or excerpt hashes",
    ],
    host_semantic_validator: "validateResearchSemanticDraft",
  });
}

export const GroundedSynthesisV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.grounded-synthesis.v1"),
    schema_version: Type.Literal(1),
    request: Type.Object(
      {
        request_sha256: Sha256Schema,
        normalized_question: TextSchema({
          minBytes: 1,
          maxBytes: QUESTION_BYTES,
          multiline: true,
        }),
        scope: ScopeSchema,
      },
      { additionalProperties: false }
    ),
    title: TextSchema({ minBytes: 1, maxBytes: 512, multiline: false }),
    executive_summary: TextSchema({ minBytes: 1, maxBytes: QUESTION_BYTES, multiline: true }),
    claims: Type.Array(ClaimV1Schema, { minItems: 1, maxItems: MAX_CLAIMS }),
    sources: Type.Array(SourceV1Schema, { minItems: 1, maxItems: MAX_SOURCES }),
    evidence: Type.Array(EvidenceV1Schema, { minItems: 1, maxItems: MAX_EVIDENCE }),
    contradictions: Type.Array(ContradictionV1Schema, { maxItems: 256 }),
    unresolved_gaps: Type.Array(GapV1Schema, { maxItems: 256 }),
    irreducible_uncertainties: Type.Array(UncertaintyV1Schema, { maxItems: 256 }),
    narrative: Type.Object(
      {
        sections: Type.Array(NarrativeSectionV1Schema, { minItems: 1, maxItems: 64 }),
      },
      { additionalProperties: false }
    ),
    provenance: Type.Object(
      {
        context_trace_sha256: Sha256Schema,
        evidence_artifacts: Type.Array(ArtifactRefSchema, {
          minItems: 1,
          maxItems: 64,
        }),
        synthesis_source_artifact: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type GroundedSynthesisV1 = Static<typeof GroundedSynthesisV1Schema>;

function assertNoProductGraphKey(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProductGraphKey(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:receipt|render|terminal_envelope|completion_admission|w7)/iu.test(key)) {
      throw new SkillSchemaValidationError("GroundedSynthesisV1", [
        `product/completion graph field '${path}.${key}' is forbidden`,
      ]);
    }
    assertNoProductGraphKey(child, `${path}.${key}`);
  }
}

function assertReferences(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  label: string
): void {
  const dangling = values.find((value) => !allowed.has(value));
  if (dangling !== undefined) {
    throw new SkillSchemaValidationError(label, [`reference '${dangling}' does not resolve`]);
  }
}

export function validateGroundedSynthesis(value: unknown): GroundedSynthesisV1 {
  const core = validateSkillSchema(GroundedSynthesisV1Schema, value, "GroundedSynthesisV1");
  assertNoProductGraphKey(core);
  assertText(core.request.normalized_question, "GroundedSynthesisV1 normalized question", {
    minBytes: 1,
    maxBytes: QUESTION_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  const claimIds = core.claims.map((claim) => claim.claim_id);
  const sourceIds = core.sources.map((source) => source.source_id);
  const evidenceIds = core.evidence.map((evidence) => evidence.evidence_id);
  const sectionIds = core.narrative.sections.map((section) => section.section_id);
  assertUnique(claimIds, "GroundedSynthesisV1 claim IDs");
  assertUnique(sourceIds, "GroundedSynthesisV1 source IDs");
  assertUnique(evidenceIds, "GroundedSynthesisV1 evidence IDs");
  assertUnique(sectionIds, "GroundedSynthesisV1 section IDs");
  const claims = new Set(claimIds);
  const sources = new Set(sourceIds);
  const evidence = new Set(evidenceIds);
  const relationByEvidence = new Map(
    core.evidence.map((item) => [item.evidence_id, item.relation])
  );
  for (const claim of core.claims) {
    assertReferences(claim.evidence_ids, evidence, `claim ${claim.claim_id} evidence`);
    if (
      claim.support_status === "supported" &&
      !claim.evidence_ids.some((id) => relationByEvidence.get(id) === "supports")
    ) {
      throw new SkillSchemaValidationError(`claim ${claim.claim_id}`, [
        "supported claims require supporting evidence",
      ]);
    }
    if (claim.support_status === "qualified" && claim.qualifications.length === 0) {
      throw new SkillSchemaValidationError(`claim ${claim.claim_id}`, [
        "qualified claims require an explicit qualification",
      ]);
    }
  }
  for (const item of core.evidence) {
    assertReferences([item.source_id], sources, `evidence ${item.evidence_id} source`);
  }
  for (const contradiction of core.contradictions) {
    assertReferences(
      contradiction.claim_ids,
      claims,
      `contradiction ${contradiction.contradiction_id}`
    );
    assertReferences(
      contradiction.evidence_ids,
      evidence,
      `contradiction ${contradiction.contradiction_id}`
    );
    if (new Set(contradiction.evidence_ids).size < 2) {
      throw new SkillSchemaValidationError(`contradiction ${contradiction.contradiction_id}`, [
        "contradiction endpoints must be distinct",
      ]);
    }
  }
  for (const gap of core.unresolved_gaps) {
    assertReferences(gap.affected_claim_ids, claims, `gap ${gap.gap_id}`);
  }
  for (const uncertainty of core.irreducible_uncertainties) {
    assertReferences(
      uncertainty.affected_claim_ids,
      claims,
      `uncertainty ${uncertainty.uncertainty_id}`
    );
  }
  for (const section of core.narrative.sections) {
    assertReferences(section.claim_ids, claims, `section ${section.section_id} claims`);
    assertReferences(section.evidence_ids, evidence, `section ${section.section_id} evidence`);
  }
  const provenanceIds = new Set(
    core.provenance.evidence_artifacts.map((artifact) => artifact.artifact_id)
  );
  const absent = core.evidence.find((item) => !provenanceIds.has(item.evidence_artifact_id));
  if (absent !== undefined) {
    throw new SkillSchemaValidationError("GroundedSynthesisV1 provenance", [
      `evidence artifact '${absent.evidence_artifact_id}' is absent`,
    ]);
  }
  return core;
}

function stableResearchId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(4, "0")}`;
}

export function projectResearchSemanticDraft(input: {
  readonly draft: unknown;
  readonly request: ResearchRequestV1;
  readonly contextTraceSha256: string;
  readonly evidenceArtifacts: readonly ArtifactRef[];
  readonly synthesisSourceArtifact: ArtifactRef;
  readonly readEvidenceArtifact: (artifact: ArtifactRef) => Uint8Array;
}): GroundedSynthesisV1 {
  const draft = validateResearchSemanticDraft(input.draft);
  const request = validateResearchRequest(input.request);
  if (!/^[a-f0-9]{64}$/u.test(input.contextTraceSha256)) {
    throw new SkillSchemaValidationError("ResearchSemanticDraftV1 context trace", [
      "context trace must be a SHA-256 digest",
    ]);
  }
  if (input.evidenceArtifacts.length < 1 || input.evidenceArtifacts.length > 64) {
    throw new SkillSchemaValidationError("ResearchSemanticDraftV1 evidence artifacts", [
      "owner-selected Echo evidence must contain 1..64 artifacts",
    ]);
  }
  assertUnique(
    input.evidenceArtifacts.map((artifact) => artifact.artifact_id),
    "ResearchSemanticDraftV1 evidence artifact IDs"
  );
  for (const artifact of input.evidenceArtifacts) {
    if (
      artifact.kind !== "agent-output" ||
      artifact.phase !== "researching" ||
      artifact.producer !== "agent:echo"
    ) {
      throw new SkillSchemaValidationError("ResearchSemanticDraftV1 evidence artifacts", [
        "evidence slots may bind only owner-selected Echo researching artifacts",
      ]);
    }
  }
  if (
    input.synthesisSourceArtifact.kind !== "agent-output" ||
    input.synthesisSourceArtifact.phase !== "synthesizing" ||
    input.synthesisSourceArtifact.producer !== "agent:synthia"
  ) {
    throw new SkillSchemaValidationError("ResearchSemanticDraftV1 Synthia lineage", [
      "synthesis source must be the exact Synthia synthesizing artifact",
    ]);
  }
  const evidenceBytes = new Map<string, Buffer>();
  const evidence = draft.evidence.map((item, index) => {
    const artifact = input.evidenceArtifacts[item.evidence_artifact_slot];
    if (artifact === undefined) {
      throw new SkillSchemaValidationError(
        `ResearchSemanticDraftV1.evidence[${index}].evidence_artifact_slot`,
        ["slot does not resolve to an owner-selected Echo artifact"]
      );
    }
    let bytes = evidenceBytes.get(artifact.artifact_id);
    if (bytes === undefined) {
      bytes = Buffer.from(input.readEvidenceArtifact(artifact));
      evidenceBytes.set(artifact.artifact_id, bytes);
    }
    const excerptBytes = Buffer.from(item.excerpt, "utf8");
    if (!bytes.includes(excerptBytes)) {
      throw new SkillSchemaValidationError(`ResearchSemanticDraftV1.evidence[${index}].excerpt`, [
        `excerpt is absent from owner-selected evidence slot ${item.evidence_artifact_slot}`,
      ]);
    }
    return {
      evidence_id: stableResearchId("evidence", index),
      source_id: stableResearchId("source", item.source_index),
      locator: item.locator,
      excerpt_sha256: sha256(excerptBytes),
      evidence_artifact_id: artifact.artifact_id,
      relation: item.relation,
    };
  });
  return validateGroundedSynthesis({
    schema_id: "penny.grounded-synthesis.v1",
    schema_version: 1,
    request: {
      request_sha256: researchRequestSha256(request),
      normalized_question: request.question,
      scope: request.scope,
    },
    title: draft.title,
    executive_summary: draft.executive_summary,
    claims: draft.claims.map((claim, index) => ({
      claim_id: stableResearchId("claim", index),
      statement: claim.statement,
      claim_kind: claim.claim_kind,
      support_status: claim.support_status,
      confidence: claim.confidence,
      evidence_ids: claim.evidence_indexes.map((evidenceIndex) =>
        stableResearchId("evidence", evidenceIndex)
      ),
      qualifications: claim.qualifications,
    })),
    sources: draft.sources.map((source, index) => ({
      source_id: stableResearchId("source", index),
      source_kind: source.source_kind,
      role: source.role,
      tier: source.tier,
      title: source.title,
      locator: source.locator,
      ...(source.published_at === undefined ? {} : { published_at: source.published_at }),
      ...(source.observed_at === undefined ? {} : { observed_at: source.observed_at }),
    })),
    evidence,
    contradictions: draft.contradictions.map((contradiction, index) => ({
      contradiction_id: stableResearchId("contradiction", index),
      claim_ids: contradiction.claim_indexes.map((claimIndex) =>
        stableResearchId("claim", claimIndex)
      ),
      evidence_ids: contradiction.evidence_indexes.map((evidenceIndex) =>
        stableResearchId("evidence", evidenceIndex)
      ),
      status: contradiction.status,
    })),
    unresolved_gaps: draft.unresolved_gaps.map((gap, index) => ({
      gap_id: stableResearchId("gap", index),
      statement: gap.statement,
      affected_claim_ids: gap.affected_claim_indexes.map((claimIndex) =>
        stableResearchId("claim", claimIndex)
      ),
      gap_kind: gap.gap_kind,
      blocking: gap.blocking,
    })),
    irreducible_uncertainties: draft.irreducible_uncertainties.map((uncertainty, index) => ({
      uncertainty_id: stableResearchId("uncertainty", index),
      statement: uncertainty.statement,
      affected_claim_ids: uncertainty.affected_claim_indexes.map((claimIndex) =>
        stableResearchId("claim", claimIndex)
      ),
      disposition: uncertainty.disposition,
    })),
    narrative: {
      sections: draft.sections.map((section, index) => ({
        section_id: stableResearchId("section", index),
        heading: section.heading,
        body: section.body,
        claim_ids: section.claim_indexes.map((claimIndex) => stableResearchId("claim", claimIndex)),
        evidence_ids: section.evidence_indexes.map((evidenceIndex) =>
          stableResearchId("evidence", evidenceIndex)
        ),
      })),
    },
    provenance: {
      context_trace_sha256: input.contextTraceSha256,
      evidence_artifacts: [...input.evidenceArtifacts],
      synthesis_source_artifact: input.synthesisSourceArtifact,
    },
  });
}

export function validateCanonicalGroundedSynthesisBytes(
  bytes: Uint8Array,
  expected?: ArtifactRef
): GroundedSynthesisV1 {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0 || buffer[0] === 0xef || buffer.at(-1) === 0x0a) {
    throw new SkillSchemaValidationError("GroundedSynthesisV1 canonical bytes", [
      "BOM, empty input, and trailing newline are forbidden",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SkillSchemaValidationError("GroundedSynthesisV1 canonical bytes", [
      "content is not JSON",
    ]);
  }
  const core = validateGroundedSynthesis(parsed);
  const canonical = Buffer.from(canonicalJson(core), "utf8");
  if (!canonical.equals(buffer)) {
    throw new SkillSchemaValidationError("GroundedSynthesisV1 canonical bytes", [
      "bytes do not equal canonical JSON",
    ]);
  }
  if (expected !== undefined) {
    if (
      expected.kind !== "semantic-core" ||
      expected.media_type !== "application/json" ||
      expected.content_schema?.schema_id !== "penny.grounded-synthesis.v1" ||
      expected.content_schema.schema_version !== 1 ||
      expected.content_digest !== sha256(buffer) ||
      expected.byte_length !== buffer.length
    ) {
      throw new SkillSchemaValidationError("GroundedSynthesisV1 artifact binding", [
        "kind, media type, content schema, digest, or byte length mismatch",
      ]);
    }
  }
  return core;
}

export const SemanticCoreRefV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    schema_id: Type.Literal("penny.grounded-synthesis.v1"),
    product_schema_version: Type.Literal(1),
    artifact_ref: ArtifactRefSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type SemanticCoreRefV1 = Static<typeof SemanticCoreRefV1Schema>;

export function validateSemanticCoreRef(value: unknown): SemanticCoreRefV1 {
  const ref = validateSkillSchema(SemanticCoreRefV1Schema, value, "SemanticCoreRefV1");
  if (
    ref.artifact_ref.kind !== "semantic-core" ||
    ref.artifact_ref.media_type !== "application/json" ||
    ref.artifact_ref.content_schema?.schema_id !== ref.schema_id ||
    ref.artifact_ref.content_schema.schema_version !== ref.product_schema_version ||
    ref.artifact_ref.content_digest !== ref.sha256
  ) {
    throw new SkillSchemaValidationError("SemanticCoreRefV1", [
      "artifact kind, media type, content schema, or digest does not bind the core",
    ]);
  }
  return ref;
}

export const ProductReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.product-receipt.v1"),
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ pattern: "^prc_[a-f0-9]{64}$" }),
    receipt_kind: Type.Union([
      Type.Literal("grounding_verification"),
      Type.Literal("quality_critique"),
      Type.Literal("deterministic_product_validation"),
    ]),
    producer: Type.Union([
      Type.Literal("agent:vera"),
      Type.Literal("agent:carren"),
      Type.Literal("host:product-validator"),
    ]),
    attested_core: SemanticCoreRefV1Schema,
    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
    findings: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
      maxItems: MAX_FINDINGS,
    }),
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: MAX_FINDINGS }),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ProductReceiptV1 = Static<typeof ProductReceiptV1Schema>;

export function productReceiptId(body: Omit<ProductReceiptV1, "receipt_id">): `prc_${string}` {
  return `prc_${sha256(canonicalJson(body))}`;
}

export function validateProductReceipt(value: unknown): ProductReceiptV1 {
  const receipt = validateSkillSchema(ProductReceiptV1Schema, value, "ProductReceiptV1");
  validateSemanticCoreRef(receipt.attested_core);
  assertRfc3339Utc(receipt.created_at, "ProductReceiptV1.created_at");
  const expectedProducer = {
    grounding_verification: "agent:vera",
    quality_critique: "agent:carren",
    deterministic_product_validation: "host:product-validator",
  } as const;
  if (receipt.producer !== expectedProducer[receipt.receipt_kind]) {
    throw new SkillSchemaValidationError("ProductReceiptV1", [
      "producer and receipt kind disagree",
    ]);
  }
  if (receipt.verdict === "PASS" && receipt.evidence_refs.length === 0) {
    throw new SkillSchemaValidationError("ProductReceiptV1", [
      "PASS requires non-empty evidence refs",
    ]);
  }
  const { receipt_id: receiptId, ...body } = receipt;
  assertDerivedId(receiptId, "prc_", sha256(canonicalJson(body)), "ProductReceiptV1");
  return receipt;
}

export const DeterministicRenderRefV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.deterministic-render-ref.v1"),
    schema_version: Type.Literal(1),
    render_name: Type.Union([
      Type.Literal("report"),
      Type.Literal("sources"),
      Type.Literal("readme"),
    ]),
    renderer_id: Type.Literal("penny.research.compat-markdown.v1"),
    target_relative_path: Type.Union([
      Type.Literal("report.md"),
      Type.Literal("sources.md"),
      Type.Literal("README.md"),
    ]),
    semantic_core: SemanticCoreRefV1Schema,
    artifact_ref: ArtifactRefSchema,
    content_sha256: Sha256Schema,
    byte_length: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type DeterministicRenderRefV1 = Static<typeof DeterministicRenderRefV1Schema>;

export function validateDeterministicRenderRef(value: unknown): DeterministicRenderRefV1 {
  const render = validateSkillSchema(
    DeterministicRenderRefV1Schema,
    value,
    "DeterministicRenderRefV1"
  );
  validateSemanticCoreRef(render.semantic_core);
  const expectedPath = {
    report: "report.md",
    sources: "sources.md",
    readme: "README.md",
  } as const;
  if (
    render.target_relative_path !== expectedPath[render.render_name] ||
    render.artifact_ref.kind !== "deterministic-render" ||
    !["text/markdown", "text/markdown; charset=utf-8"].includes(render.artifact_ref.media_type) ||
    render.artifact_ref.content_digest !== render.content_sha256 ||
    render.artifact_ref.byte_length !== render.byte_length
  ) {
    throw new SkillSchemaValidationError("DeterministicRenderRefV1", [
      "name/path, kind, media type, digest, or byte length disagree",
    ]);
  }
  return render;
}

const ReceiptEnvelopeBindingV1Schema = Type.Object(
  {
    receipt_kind: ProductReceiptV1Schema.properties.receipt_kind,
    receipt_id: ProductReceiptV1Schema.properties.receipt_id,
    artifact_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ResearchProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Type.String({ pattern: "^penv_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    semantic_core: SemanticCoreRefV1Schema,
    receipts: Type.Array(ReceiptEnvelopeBindingV1Schema, { minItems: 2, maxItems: 3 }),
    renders: Type.Array(DeterministicRenderRefV1Schema, { minItems: 3, maxItems: 3 }),
  },
  { additionalProperties: false }
);
export type ResearchProductEnvelopeV1 = Static<typeof ResearchProductEnvelopeV1Schema>;

export function researchProductEnvelopeId(
  body: Omit<ResearchProductEnvelopeV1, "envelope_id">
): `penv_${string}` {
  return `penv_${sha256(canonicalJson(body))}`;
}

function sameCore(left: SemanticCoreRefV1, right: SemanticCoreRefV1): boolean {
  return (
    left.artifact_ref.artifact_id === right.artifact_ref.artifact_id && left.sha256 === right.sha256
  );
}

export function validateResearchProductEnvelope(value: unknown): ResearchProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    ResearchProductEnvelopeV1Schema,
    value,
    "ResearchProductEnvelopeV1"
  );
  validateSemanticCoreRef(envelope.semantic_core);
  assertOpaqueId(envelope.run_id, "ResearchProductEnvelopeV1.run_id");
  const receiptKinds = envelope.receipts.map((receipt) => receipt.receipt_kind);
  if (
    receiptKinds.filter((kind) => kind === "grounding_verification").length !== 1 ||
    receiptKinds.filter((kind) => kind === "deterministic_product_validation").length !== 1 ||
    receiptKinds.filter((kind) => kind === "quality_critique").length > 1
  ) {
    throw new SkillSchemaValidationError("ResearchProductEnvelopeV1 receipts", [
      "requires one grounding, one deterministic-validation, and at most one quality receipt",
    ]);
  }
  assertUnique(
    envelope.receipts.map((receipt) => receipt.receipt_id),
    "ResearchProductEnvelopeV1 receipt IDs"
  );
  const renderNames = envelope.renders.map((render) => render.render_name);
  if (canonicalJson([...renderNames].sort()) !== canonicalJson(["readme", "report", "sources"])) {
    throw new SkillSchemaValidationError("ResearchProductEnvelopeV1 renders", [
      "requires exactly report, sources, and readme",
    ]);
  }
  for (const render of envelope.renders) {
    validateDeterministicRenderRef(render);
    if (!sameCore(render.semantic_core, envelope.semantic_core)) {
      throw new SkillSchemaValidationError("ResearchProductEnvelopeV1", [
        "render core binding mismatch",
      ]);
    }
  }
  const { envelope_id: envelopeId, ...body } = envelope;
  assertDerivedId(envelopeId, "penv_", sha256(canonicalJson(body)), "ResearchProductEnvelopeV1");
  return envelope;
}

export function validateResearchProductGraph(input: {
  readonly core: unknown;
  readonly envelope: unknown;
  readonly receipts: readonly unknown[];
  readonly renders: readonly unknown[];
}): ResearchProductEnvelopeV1 {
  const core = validateGroundedSynthesis(input.core);
  const envelope = validateResearchProductEnvelope(input.envelope);
  if (
    core.claims.some((claim) => claim.support_status === "unsupported") ||
    envelope.semantic_core.sha256 !== sha256(canonicalJson(core))
  ) {
    throw new SkillSchemaValidationError("research product graph core", [
      "positive completion requires the exact core digest and no unsupported claim",
    ]);
  }
  const receipts = input.receipts.map(validateProductReceipt);
  const renders = input.renders.map(validateDeterministicRenderRef);
  if (receipts.length !== envelope.receipts.length || renders.length !== envelope.renders.length) {
    throw new SkillSchemaValidationError("research product graph", [
      "resolved receipt/render cardinality differs from the envelope",
    ]);
  }
  for (const binding of envelope.receipts) {
    const receipt = receipts.find((candidate) => candidate.receipt_id === binding.receipt_id);
    if (
      receipt === undefined ||
      receipt.receipt_kind !== binding.receipt_kind ||
      receipt.attested_core.sha256 !== envelope.semantic_core.sha256 ||
      binding.artifact_ref.kind !== "product-receipt" ||
      binding.artifact_ref.content_schema?.schema_id !== "penny.product-receipt.v1" ||
      binding.artifact_ref.content_schema.schema_version !== 1
    ) {
      throw new SkillSchemaValidationError("research product graph receipt", [
        `receipt '${binding.receipt_id}' is stale or substituted`,
      ]);
    }
  }
  for (const binding of envelope.renders) {
    const resolved = renders.find((candidate) => candidate.render_name === binding.render_name);
    if (resolved === undefined || canonicalJson(resolved) !== canonicalJson(binding)) {
      throw new SkillSchemaValidationError("research product graph render", [
        `render '${binding.render_name}' is missing or substituted`,
      ]);
    }
  }
  return envelope;
}

export const SkillPortV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    name: OpaqueIdSchema,
    direction: Type.Union([Type.Literal("input"), Type.Literal("output")]),
    transport: Type.Union([Type.Literal("inline_request"), Type.Literal("artifact")]),
    schema_id: SchemaIdSchema,
    schema_version_required: Type.Integer({ minimum: 1 }),
    artifact_kind: Type.Union([OpaqueIdSchema, Type.Null()]),
    source: Type.Union([
      Type.Literal("caller"),
      Type.Literal("prior_skill"),
      Type.Literal("either"),
      Type.Literal("skill"),
    ]),
    min_items: Type.Integer({ minimum: 0 }),
    max_items: Type.Integer({ minimum: 1 }),
    semantic_product: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type SkillPortV1 = Static<typeof SkillPortV1Schema>;

export function validateSkillPort(value: unknown): SkillPortV1 {
  const port = validateSkillSchema(SkillPortV1Schema, value, "SkillPortV1");
  assertOpaqueId(port.name, "SkillPortV1.name");
  if (port.min_items > port.max_items) {
    throw new SkillSchemaValidationError("SkillPortV1", ["min_items exceeds max_items"]);
  }
  if (port.transport === "inline_request" && port.artifact_kind !== null) {
    throw new SkillSchemaValidationError("SkillPortV1", [
      "inline request ports cannot declare an artifact kind",
    ]);
  }
  if (port.transport === "artifact" && port.artifact_kind === null) {
    throw new SkillSchemaValidationError("SkillPortV1", [
      "artifact ports require an artifact kind",
    ]);
  }
  return port;
}

export const RESEARCH_PORTS = {
  request: {
    schema_version: 1,
    name: "request",
    direction: "input",
    transport: "inline_request",
    schema_id: "penny.research-request.v1",
    schema_version_required: 1,
    artifact_kind: null,
    source: "caller",
    min_items: 1,
    max_items: 1,
    semantic_product: false,
  },
  prior_grounded_synthesis: {
    schema_version: 1,
    name: "prior_grounded_synthesis",
    direction: "input",
    transport: "artifact",
    schema_id: "penny.grounded-synthesis.v1",
    schema_version_required: 1,
    artifact_kind: "semantic-core",
    source: "either",
    min_items: 0,
    max_items: 8,
    semantic_product: true,
  },
  legacy_context: {
    schema_version: 1,
    name: "legacy_context",
    direction: "input",
    transport: "artifact",
    schema_id: "penny.research-legacy-agent-output.v1",
    schema_version_required: 1,
    artifact_kind: "agent-output",
    source: "either",
    min_items: 0,
    max_items: 64,
    semantic_product: false,
  },
  legacy_report_artifact: {
    schema_version: 1,
    name: "legacy_report_artifact",
    direction: "output",
    transport: "artifact",
    schema_id: "penny.research-legacy-agent-output.v1",
    schema_version_required: 1,
    artifact_kind: "agent-output",
    source: "skill",
    min_items: 1,
    max_items: 1,
    semantic_product: false,
  },
  grounded_synthesis: {
    schema_version: 1,
    name: "grounded_synthesis",
    direction: "output",
    transport: "artifact",
    schema_id: "penny.grounded-synthesis.v1",
    schema_version_required: 1,
    artifact_kind: "semantic-core",
    source: "skill",
    min_items: 1,
    max_items: 1,
    semantic_product: true,
  },
} as const satisfies Readonly<Record<string, SkillPortV1>>;

const ResearchBudgetPresetV1Schema = Type.Object(
  {
    plan_critique: Type.Boolean(),
    quality_critique: Type.Boolean(),
    total_research_rounds: Type.Integer({ minimum: 1, maximum: 16 }),
    default_max_evaluator_attempts: Type.Integer({ minimum: 1, maximum: 16 }),
    liveness: LivenessPolicyV1Schema,
  },
  { additionalProperties: false }
);

export const ResearchBudgetPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-budget-policy.v1"),
    schema_version: Type.Literal(1),
    presets: Type.Object(
      {
        quick: ResearchBudgetPresetV1Schema,
        standard: ResearchBudgetPresetV1Schema,
        deep: ResearchBudgetPresetV1Schema,
      },
      { additionalProperties: false }
    ),
    aliases: Type.Object(
      {
        max_research_rounds: Type.Literal("total_research_rounds"),
        research_round_minus_one: Type.Literal("additional_research_rounds_spent"),
        max_iterations: Type.Literal("max_evaluator_attempts_per_loop"),
        max_iterations_minus_one: Type.Literal("max_semantic_repairs_per_loop"),
        critique_passes: Type.Literal("evaluator_activation_policy"),
        validate_model: Type.Literal("verification_model_policy"),
        max_steps: Type.Literal("host_final_safety_ceiling"),
      },
      { additionalProperties: false }
    ),
    caller_override_fields: Type.Array(
      Type.Union([
        Type.Literal("max_sub_queries"),
        Type.Literal("max_fan_width"),
        Type.Literal("total_research_rounds"),
        Type.Literal("max_evaluator_attempts_per_loop"),
        Type.Literal("critique_passes"),
      ]),
      { minItems: 5, maxItems: 5, uniqueItems: true }
    ),
    host_ceiling_fields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 10,
      maxItems: 16,
      uniqueItems: true,
    }),
    phase_attempt_projection: Type.Object(
      {
        source_event: Type.Literal("liveness_invocation_admitted"),
        key: Type.Literal("state_id+branch_id"),
        ceiling_source: Type.Literal("total_phase_repair_invocations"),
        relation: Type.Literal("equal_to_total_ceiling"),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ResearchBudgetPolicyV1 = Static<typeof ResearchBudgetPolicyV1Schema>;

export const ResearchBudgetAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-budget-admission.v1"),
    schema_version: Type.Literal(1),
    mode: Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")]),
    max_sub_queries: Type.Integer({ minimum: 1, maximum: 64 }),
    max_fan_width: Type.Integer({ minimum: 1, maximum: 64 }),
    effective_decomposition_width: Type.Integer({ minimum: 1, maximum: 64 }),
    total_research_rounds: Type.Integer({ minimum: 1, maximum: 16 }),
    max_evaluator_attempts_per_loop: Type.Integer({ minimum: 1, maximum: 16 }),
    max_semantic_repairs_per_loop: Type.Integer({ minimum: 0, maximum: 15 }),
    critique_passes: Type.Integer({ minimum: 0, maximum: 2 }),
    liveness: LivenessPolicyV1Schema,
    phase_attempt_ceiling_per_state_branch: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export type ResearchBudgetAdmissionV1 = Static<typeof ResearchBudgetAdmissionV1Schema>;

export const ResearchBudgetSnapshotV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.research-budget-snapshot.v1"),
    schema_version: Type.Literal(1),
    admission: ResearchBudgetAdmissionV1Schema,
    liveness_snapshot_sha256: Sha256Schema,
    phase_attempts_by_state_branch: Type.Record(
      Type.String({ minLength: 1, maxLength: 260 }),
      Type.Integer({ minimum: 0 })
    ),
  },
  { additionalProperties: false }
);
export type ResearchBudgetSnapshotV1 = Static<typeof ResearchBudgetSnapshotV1Schema>;

export function makeResearchBudgetPolicy(input: {
  readonly quick: Static<typeof LivenessPolicyV1Schema>;
  readonly standard: Static<typeof LivenessPolicyV1Schema>;
  readonly deep: Static<typeof LivenessPolicyV1Schema>;
}): ResearchBudgetPolicyV1 {
  return validateSkillSchema(
    ResearchBudgetPolicyV1Schema,
    {
      schema_id: "penny.research-budget-policy.v1",
      schema_version: 1,
      presets: {
        quick: {
          plan_critique: false,
          quality_critique: false,
          total_research_rounds: 2,
          default_max_evaluator_attempts: 3,
          liveness: input.quick,
        },
        standard: {
          plan_critique: false,
          quality_critique: false,
          total_research_rounds: 2,
          default_max_evaluator_attempts: 3,
          liveness: input.standard,
        },
        deep: {
          plan_critique: true,
          quality_critique: true,
          total_research_rounds: 3,
          default_max_evaluator_attempts: 3,
          liveness: input.deep,
        },
      },
      aliases: {
        max_research_rounds: "total_research_rounds",
        research_round_minus_one: "additional_research_rounds_spent",
        max_iterations: "max_evaluator_attempts_per_loop",
        max_iterations_minus_one: "max_semantic_repairs_per_loop",
        critique_passes: "evaluator_activation_policy",
        validate_model: "verification_model_policy",
        max_steps: "host_final_safety_ceiling",
      },
      caller_override_fields: [
        "max_sub_queries",
        "max_fan_width",
        "total_research_rounds",
        "max_evaluator_attempts_per_loop",
        "critique_passes",
      ],
      host_ceiling_fields: [
        "total_phase_repair_invocations",
        "model_turns_per_worker",
        "model_turns_per_run",
        "tool_calls_per_worker",
        "tool_calls_per_run",
        "external_calls_per_worker",
        "external_calls_per_run",
        "worker_wall_clock_ms",
        "run_wall_clock_ms",
        "routing_repair",
      ],
      phase_attempt_projection: {
        source_event: "liveness_invocation_admitted",
        key: "state_id+branch_id",
        ceiling_source: "total_phase_repair_invocations",
        relation: "equal_to_total_ceiling",
      },
    },
    "ResearchBudgetPolicyV1"
  );
}

export function resolveResearchBudgetAdmission(
  request: ResearchRequestV1,
  policy: ResearchBudgetPolicyV1,
  declaredMode: "quick" | "standard" | "deep" = "standard"
): ResearchBudgetAdmissionV1 {
  validateResearchRequest(request);
  const mode = request.mode ?? declaredMode;
  const preset = policy.presets[mode];
  const maxSubQueries = request.budget_overrides.max_sub_queries ?? 4;
  const maxFanWidth = request.budget_overrides.max_fan_width ?? 8;
  const evaluatorAttempts =
    request.budget_overrides.max_evaluator_attempts_per_loop ??
    preset.default_max_evaluator_attempts;
  return validateSkillSchema(
    ResearchBudgetAdmissionV1Schema,
    {
      schema_id: "penny.research-budget-admission.v1",
      schema_version: 1,
      mode,
      max_sub_queries: maxSubQueries,
      max_fan_width: maxFanWidth,
      effective_decomposition_width: Math.min(maxSubQueries, maxFanWidth),
      total_research_rounds:
        request.budget_overrides.total_research_rounds ?? preset.total_research_rounds,
      max_evaluator_attempts_per_loop: evaluatorAttempts,
      max_semantic_repairs_per_loop: evaluatorAttempts - 1,
      critique_passes: request.budget_overrides.critique_passes ?? (preset.plan_critique ? 2 : 0),
      liveness: preset.liveness,
      phase_attempt_ceiling_per_state_branch: preset.liveness.total_phase_repair_invocations,
    },
    "ResearchBudgetAdmissionV1"
  );
}
