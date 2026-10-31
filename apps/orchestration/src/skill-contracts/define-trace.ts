import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactHostStore } from "../artifact-store.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  TextSchema,
  assertUnique,
  validateSkillSchema,
} from "./common.js";
import {
  definitionRequestSourceItems,
  validateDefinitionRequest,
  validateDefinitionSourceManifest,
  validateDefinitionFrameV2,
  validateCanonicalSpecificationBytes,
  validateSpecification,
  parseSpecificationDraftV2,
  parseSpecificationDraftV3,
  stableDefinitionId,
  type SpecificationDraftV2,
  type SpecificationV1,
} from "./define.js";
import { validateEvidenceAdmissionV2 } from "./evidence-admission.js";
import { validateDefinitionSupport } from "./define-support.js";

const LocatorSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("json_pointer"), pointer: TextSchema({ maxBytes: 1024 }) },
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
const QuestionTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("request_uncertainty"),
      source_item_index: Type.Integer({ minimum: 0, maximum: 127 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("discovered_question"), question_id: OpaqueIdSchema },
    { additionalProperties: false }
  ),
]);
const SupportSchema = Type.Array(
  Type.Object(
    {
      ref: ArtifactRefSchema,
      locator: LocatorSchema,
      support_slot: Type.Integer({ minimum: 0, maximum: 68 }),
    },
    { additionalProperties: false }
  ),
  { maxItems: 16 }
);
export const DefinitionTraceV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.definition-trace.v1"),
    schema_version: Type.Literal(1),
    registration_binding: Type.Object(
      {
        name: Type.Literal("define"),
        contract_sha256: Sha256Schema,
        registration_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    request_ref: ArtifactRefSchema,
    manifest_ref: ArtifactRefSchema,
    frame_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    product_ref: ArtifactRefSchema,
    prior_product_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    support_refs: Type.Array(ArtifactRefSchema, { maxItems: 69 }),
    coverage: Type.Array(
      Type.Object(
        {
          source_item_id: OpaqueIdSchema,
          ordinal: Type.Integer({ minimum: 0, maximum: 127 }),
          disposition: Type.Union([
            Type.Literal("incorporated"),
            Type.Literal("excluded"),
            Type.Literal("unresolved"),
          ]),
          product_item_ids: Type.Array(OpaqueIdSchema, { maxItems: 760 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 128 }
    ),
    question_resolutions: Type.Array(
      Type.Object(
        {
          question_id: OpaqueIdSchema,
          target: QuestionTargetSchema,
          status: Type.Union([
            Type.Literal("resolved"),
            Type.Literal("pending"),
            Type.Literal("declined"),
          ]),
          claim: TextSchema({ minBytes: 1, maxBytes: 4096, multiline: true }),
          rationale: TextSchema({ minBytes: 1, maxBytes: 2048, multiline: true }),
          support: SupportSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    standard_support: Type.Array(
      Type.Object(
        {
          standard_item_id: OpaqueIdSchema,
          standard: TextSchema({ minBytes: 1, maxBytes: 512, multiline: true }),
          category: OpaqueIdSchema,
          status: Type.Union([
            Type.Literal("not_assessed"),
            Type.Literal("identified"),
            Type.Literal("applicable"),
            Type.Literal("not_applicable"),
            Type.Literal("satisfied_with_evidence"),
          ]),
          claim: Type.Union([
            TextSchema({ minBytes: 1, maxBytes: 4096, multiline: true }),
            Type.Null(),
          ]),
          support: SupportSchema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 64 }
    ),
    protected_mappings: Type.Array(
      Type.Object(
        {
          source_item_id: OpaqueIdSchema,
          field_path: TextSchema({ minBytes: 1, maxBytes: 256 }),
          item_id: OpaqueIdSchema,
          original_value_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { maxItems: 160 }
    ),
    readiness: Type.Object(
      {
        disposition: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
        blocking_question_ids: Type.Array(OpaqueIdSchema, { maxItems: 64 }),
        unresolved_source_ids: Type.Array(OpaqueIdSchema, { maxItems: 128 }),
      },
      { additionalProperties: false }
    ),
    projection_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type DefinitionTraceV1 = Readonly<Static<typeof DefinitionTraceV1Schema>>;
export const MAX_DEFINITION_TRACE_BYTES = 4 * 1024 * 1024;

export function validateDefinitionTraceV1(value: unknown): DefinitionTraceV1 {
  const trace = validateSkillSchema(DefinitionTraceV1Schema, value, "DefinitionTraceV1");
  const { projection_sha256: ignored, ...body } = trace;
  void ignored;
  if (
    trace.projection_sha256 !== sha256(canonicalJson(body)) ||
    Buffer.byteLength(canonicalJson(trace)) > MAX_DEFINITION_TRACE_BYTES ||
    trace.product_ref.kind !== "specification" ||
    (trace.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v2" &&
      trace.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3") ||
    trace.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    trace.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v2"
  ) {
    throw new Error("DefinitionTraceV1 identity, roles, or 4 MiB size bound invalid");
  }
  assertUnique(
    trace.support_refs.map((ref) => ref.artifact_id),
    "DefinitionTraceV1 support refs"
  );
  assertUnique(
    trace.coverage.map((row) => String(row.ordinal)),
    "DefinitionTraceV1 coverage ordinals"
  );
  return trace;
}

function exact<T>(reader: ArtifactHostStore, ref: ArtifactRef, validate: (value: unknown) => T): T {
  const stored = reader.refById(ref.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref))
    throw new Error("DefinitionTraceV1 ref drifted");
  const bytes = reader.readById(ref.artifact_id).toString("utf8");
  const value = validate(JSON.parse(bytes));
  if (canonicalJson(value) !== bytes) throw new Error("DefinitionTraceV1 operand is noncanonical");
  return value;
}

/** Deterministic projection; use with a prospective product ref before persisting the product. */
export function projectDefinitionTrace(input: {
  readonly reader: ArtifactHostStore;
  readonly registration_binding: DefinitionTraceV1["registration_binding"];
  readonly request_ref: ArtifactRef;
  readonly manifest_ref: ArtifactRef;
  readonly frame_ref: ArtifactRef;
  readonly orientation_ref: ArtifactRef;
  readonly admission_ref: ArtifactRef;
  readonly draft_ref: ArtifactRef;
  readonly draft_bytes: Uint8Array;
  readonly product_ref: ArtifactRef;
  readonly product: SpecificationV1;
  readonly prior_product_ref: ArtifactRef | null;
}): DefinitionTraceV1 {
  const { reader, product } = input;
  const prior =
    input.prior_product_ref === null
      ? undefined
      : exact(reader, input.prior_product_ref, (value) =>
          validateSpecification(value, { skipRevisionClosure: true })
        );
  validateSpecification(product, prior === undefined ? {} : { priorSpecification: prior });
  if (
    input.product_ref.content_digest !== sha256(canonicalJson(product)) ||
    input.product_ref.byte_length !== Buffer.byteLength(canonicalJson(product)) ||
    input.product_ref.run_id !== input.request_ref.run_id ||
    input.prior_product_ref?.artifact_id !==
      (product.source_lineage.prior_specification_artifact_id ?? undefined)
  ) {
    throw new Error("DefinitionTraceV1 prospective product ref or revision parent differs");
  }
  const request = exact(reader, input.request_ref, validateDefinitionRequest);
  const manifest = exact(reader, input.manifest_ref, (value) =>
    validateDefinitionSourceManifest(value, request, input.request_ref)
  );
  if (
    manifest.request_sha256 !== sha256(canonicalJson(request)) ||
    canonicalJson(manifest.request_ref) !== canonicalJson(input.request_ref)
  )
    throw new Error("DefinitionTraceV1 manifest differs from request");
  const frame = exact(reader, input.frame_ref, (value) =>
    validateDefinitionFrameV2(value, request, input.request_ref, input.orientation_ref)
  );
  const admission = exact(reader, input.admission_ref, validateEvidenceAdmissionV2);
  if (
    canonicalJson(admission.frame_ref) !== canonicalJson(input.frame_ref) ||
    canonicalJson(admission.source_artifact_ref) !== canonicalJson(input.orientation_ref)
  )
    throw new Error("DefinitionTraceV1 admission differs from frame");
  const selectedDraft = reader.refById(input.draft_ref.artifact_id);
  if (
    selectedDraft === undefined ||
    canonicalJson(selectedDraft) !== canonicalJson(input.draft_ref) ||
    !reader.readById(input.draft_ref.artifact_id).equals(Buffer.from(input.draft_bytes))
  ) {
    throw new Error("DefinitionTraceV1 draft bytes differ from exact artifact");
  }
  const draft =
    input.draft_ref.content_schema?.schema_id === "penny.specification-draft.v3"
      ? parseSpecificationDraftV3(input.draft_bytes, {
          request,
          frame,
          admission,
          ...(prior === undefined ? {} : { priorSpecification: prior }),
        }).compatibilityDraft
      : parseSpecificationDraftV2(input.draft_bytes, {
          request,
          frame,
          admission,
          ...(prior === undefined ? {} : { priorSpecification: prior }),
        }).draft;
  validateDefinitionSupport({ reader, request, frame, admission, draft, product });
  const sources = definitionRequestSourceItems(request);
  if (
    canonicalJson(sources) !== canonicalJson(manifest.sources) ||
    canonicalJson(product.source_items) !== canonicalJson(sources)
  )
    throw new Error("DefinitionTraceV1 source inventory drifted");
  const support = (selectors: SpecificationDraftV2["support_claims"][number]["support"]) =>
    selectors.map((selector) => {
      const slot = admission.support_slots[selector.support_slot];
      if (slot === undefined) throw new Error("DefinitionTraceV1 support slot is absent");
      return { ...selector, ref: slot.ref };
    });
  const question_resolutions = frame.questions.flatMap((question) => {
    const target =
      question.source_item_index === null
        ? { kind: "discovered_question" as const, question_id: question.question_id }
        : { kind: "request_uncertainty" as const, source_item_index: question.source_item_index };
    const claim = draft.support_claims.find(
      (c) => canonicalJson(c.target) === canonicalJson(target)
    );
    if (claim === undefined || !("status" in claim))
      throw new Error("DefinitionTraceV1 question claim is missing");
    return [
      {
        question_id: question.question_id,
        target,
        status: claim.status,
        claim: claim.claim,
        rationale: claim.rationale,
        support: support(claim.support),
      },
    ];
  });
  const standardDraftIndexByItemId = new Map(
    draft.specification.standards_status.map((item, index) => {
      const claim = draft.support_claims.find(
        (candidate) =>
          candidate.target.kind === "standard" && candidate.target.standard_index === index
      );
      const evidenceArtifactIds = [
        ...new Set(
          (claim?.support ?? []).map((selector) => {
            const slot = admission.support_slots[selector.support_slot];
            if (slot === undefined) {
              throw new Error("DefinitionTraceV1 standard support slot is absent");
            }
            return slot.ref.artifact_id;
          })
        ),
      ]
        .slice(0, 4)
        .sort((left, right) => left.localeCompare(right));
      return [
        stableDefinitionId("spec-standard", {
          category: item.category,
          standard: item.standard,
          status: item.status,
          rationale: item.rationale,
          evidence_artifact_ids: evidenceArtifactIds,
        }),
        index,
      ] as const;
    })
  );
  const standard_support = product.standards_status.map((standard) => {
    const index = standardDraftIndexByItemId.get(standard.item_id);
    if (index === undefined)
      throw new Error("DefinitionTraceV1 sealed standard differs from draft");
    const item = draft.specification.standards_status[index];
    if (
      item === undefined ||
      item.category !== standard.category ||
      item.standard !== standard.standard ||
      item.status !== standard.status ||
      item.rationale !== standard.rationale
    ) {
      throw new Error("DefinitionTraceV1 sealed standard semantics differ from draft");
    }
    const claim = draft.support_claims.find(
      (candidate) =>
        candidate.target.kind === "standard" && candidate.target.standard_index === index
    );
    return {
      standard_item_id: standard.item_id,
      standard: standard.standard,
      category: standard.category,
      status: standard.status,
      claim: claim?.claim ?? null,
      support: claim === undefined ? [] : support(claim.support),
    };
  });
  const protected_mappings: {
    source_item_id: string;
    field_path: string;
    item_id: string;
    original_value_sha256: string;
  }[] = [];
  const kindOffsets = new Map<string, number>();
  for (const source of sources) {
    const offset = kindOffsets.get(source.kind) ?? 0;
    kindOffsets.set(source.kind, offset + 1);
    const value =
      source.kind === "hard_constraint"
        ? request.hard_constraints[offset]
        : source.kind === "non_goal"
          ? request.non_goals[offset]
          : source.kind === "out_of_scope"
            ? request.out_of_scope[offset]
            : source.kind === "prior_decision"
              ? request.prior_decisions[offset]?.binding_effect
              : undefined;
    if (value === undefined) continue;
    const items =
      source.kind === "hard_constraint"
        ? product.constraints
        : source.kind === "prior_decision"
          ? product.requirements
          : product.non_goals;
    const matching = items.find(
      (item) => item.statement === value && item.source_item_ids.includes(source.source_item_id)
    );
    if (
      matching === undefined ||
      (source.kind === "out_of_scope" && !product.scope.excluded.includes(value))
    ) {
      throw new Error("DefinitionTraceV1 protected caller text is missing or reworded");
    }
    protected_mappings.push({
      source_item_id: source.source_item_id,
      field_path: `${source.kind}[${source.ordinal}]`,
      item_id: matching.item_id,
      original_value_sha256: sha256(value),
    });
  }
  const body = {
    schema_id: "penny.definition-trace.v1" as const,
    schema_version: 1 as const,
    registration_binding: input.registration_binding,
    request_ref: input.request_ref,
    manifest_ref: input.manifest_ref,
    frame_ref: input.frame_ref,
    admission_ref: input.admission_ref,
    draft_ref: input.draft_ref,
    product_ref: input.product_ref,
    prior_product_ref: input.prior_product_ref,
    support_refs: admission.support_slots.map((slot) => slot.ref),
    coverage: sources.map((source, ordinal) => {
      const row = product.source_coverage.find(
        (entry) => entry.source_item_id === source.source_item_id
      );
      if (row === undefined) throw new Error("DefinitionTraceV1 coverage source differs");
      return {
        source_item_id: source.source_item_id,
        ordinal,
        disposition: row.disposition,
        product_item_ids: row.product_item_ids,
      };
    }),
    question_resolutions,
    standard_support,
    protected_mappings,
    readiness: {
      disposition: product.disposition,
      blocking_question_ids: frame.questions
        .filter(
          (q) =>
            q.material &&
            question_resolutions.find((row) => row.question_id === q.question_id)?.status !==
              "resolved"
        )
        .map((q) => q.question_id),
      unresolved_source_ids: product.source_coverage
        .filter((row) => row.disposition === "unresolved")
        .map((row) => row.source_item_id),
    },
  };
  return validateDefinitionTraceV1({ ...body, projection_sha256: sha256(canonicalJson(body)) });
}

/** Replay only with the exact selected product; never trust a model-provided trace digest. */
export function assertDefinitionTraceProjection(
  input: Parameters<typeof projectDefinitionTrace>[0] & {
    readonly trace_ref: ArtifactRef;
  }
): void {
  const prior =
    input.prior_product_ref === null
      ? undefined
      : exact(input.reader, input.prior_product_ref, (value) =>
          validateSpecification(value, { skipRevisionClosure: true })
        );
  const product = validateCanonicalSpecificationBytes(
    input.reader.readById(input.product_ref.artifact_id),
    input.product_ref,
    ...(prior === undefined ? [] : [{ priorSpecification: prior }])
  );
  if (canonicalJson(product) !== canonicalJson(input.product))
    throw new Error("DefinitionTraceV1 product differs");
  const stored = exact(input.reader, input.trace_ref, validateDefinitionTraceV1);
  const projected = projectDefinitionTrace(input);
  if (canonicalJson(stored) !== canonicalJson(projected))
    throw new Error("DefinitionTraceV1 projection differs from exact inputs");
}
