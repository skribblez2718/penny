import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema } from "../contracts.js";
import {
  OpaqueIdSchema,
  SchemaIdSchema,
  Sha256Schema,
  assertText,
  validateSkillSchema,
} from "./common.js";

const DiagnosticIdentity = Type.Literal("penny.seal-diagnostic.v1");

/** Host registration policy; never reconstructed from draft text or old feedback. */
export const SealPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.seal-policy.v1"),
    schema_version: Type.Literal(1),
    skill: OpaqueIdSchema,
    draft_phase: OpaqueIdSchema,
    seal_phase: OpaqueIdSchema,
    draft_schema: SchemaIdSchema,
    draft_schema_version: Type.Integer({ minimum: 1 }),
    draft_kind: OpaqueIdSchema,
    product_kind: OpaqueIdSchema,
    /** Null means no correction ceiling; the numeric maximum protects exact counter arithmetic. */
    correction_limit: Type.Union([
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
      Type.Null(),
    ]),
    diagnostic_schema: DiagnosticIdentity,
    stall_on_unchanged_rejection: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type SealPolicyV1 = Readonly<Static<typeof SealPolicyV1Schema>>;

export const SealIssueV1Schema = Type.Object(
  {
    code: OpaqueIdSchema,
    path: Type.String({ maxLength: 256 }),
    detail: Type.String({ maxLength: 512 }),
    source_ordinals: Type.Array(Type.Integer({ minimum: 0, maximum: 127 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type SealIssueV1 = Readonly<Static<typeof SealIssueV1Schema>>;

export const SealDiagnosticV1Schema = Type.Object(
  {
    schema_id: DiagnosticIdentity,
    schema_version: Type.Literal(1),
    skill: OpaqueIdSchema,
    phase: OpaqueIdSchema,
    draft_schema: SchemaIdSchema,
    policy_sha256: Sha256Schema,
    rejected_draft_ref: ArtifactRefSchema,
    epoch_anchor_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    rejection_ordinal: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    previous_diagnostic_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    failure_class: Type.Union([
      Type.Literal("FRAMING_INVALID"),
      Type.Literal("JSON_INVALID"),
      Type.Literal("SCHEMA_INVALID"),
      Type.Literal("SEMANTIC_INVALID"),
      Type.Literal("PROJECTION_INVALID"),
    ]),
    issues: Type.Array(SealIssueV1Schema, { minItems: 1, maxItems: 1024 }),
    issue_count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    issues_complete: Type.Boolean(),
    corrections_used: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    /** Null means no correction ceiling; the numeric maximum protects exact counter arithmetic. */
    correction_limit: Type.Union([
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    disposition: Type.Union([
      Type.Literal("correction_offered"),
      Type.Literal("exhausted"),
      Type.Literal("stalled"),
    ]),
    stall_reason: Type.Optional(
      Type.Union([Type.Literal("identical_rejected_digest"), Type.Literal("unchanged_diagnostics")])
    ),
  },
  { additionalProperties: false }
);
export type SealDiagnosticV1 = Readonly<Static<typeof SealDiagnosticV1Schema>>;

/** Optional on new terminal projections, separate from semantic repair diagnostics. */
export const SealDiagnosticsProjectionV1Schema = Type.Object(
  {
    latest_diagnostic_ref: ArtifactRefSchema,
    rejected_draft_ref: ArtifactRefSchema,
    epoch_anchor_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    corrections_used: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    /** Null means no correction ceiling; the numeric maximum protects exact counter arithmetic. */
    correction_limit: Type.Union([
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    disposition: Type.Union([
      Type.Literal("correction_offered"),
      Type.Literal("exhausted"),
      Type.Literal("stalled"),
    ]),
  },
  { additionalProperties: false }
);
export type SealDiagnosticsProjectionV1 = Readonly<
  Static<typeof SealDiagnosticsProjectionV1Schema>
>;

export function validateSealPolicy(value: unknown): SealPolicyV1 {
  const policy = validateSkillSchema(SealPolicyV1Schema, value, "SealPolicyV1");
  if (
    !/^[a-z][a-z0-9-]*$/u.test(policy.draft_kind) ||
    !/^[a-z][a-z0-9-]*$/u.test(policy.product_kind)
  ) {
    throw new Error("registered seal artifact kind is invalid");
  }
  return policy;
}

/** The engine freezes explicit host policy at start; legacy snapshots keep their registered policy. */
export function runSealPolicy(
  context: { readonly sealCorrectionLimit?: number | null | undefined },
  policy: SealPolicyV1
): SealPolicyV1 {
  return context.sealCorrectionLimit === undefined
    ? policy
    : validateSealPolicy({
        ...policy,
        correction_limit: context.sealCorrectionLimit,
      });
}

export function sealPolicySha256(policy: SealPolicyV1): string {
  return sha256(canonicalJson(validateSealPolicy(policy)));
}

export function validateSealDiagnostic(value: unknown, policy: SealPolicyV1): SealDiagnosticV1 {
  const bound = validateSealPolicy(policy);
  const diagnostic = validateSkillSchema(SealDiagnosticV1Schema, value, "SealDiagnosticV1");
  currentArtifactRef(diagnostic.rejected_draft_ref);
  if (diagnostic.epoch_anchor_ref !== null) currentArtifactRef(diagnostic.epoch_anchor_ref);
  if (diagnostic.previous_diagnostic_ref !== null) {
    currentArtifactRef(diagnostic.previous_diagnostic_ref);
  }
  if (
    diagnostic.skill !== bound.skill ||
    diagnostic.draft_schema !== bound.draft_schema ||
    diagnostic.policy_sha256 !== sealPolicySha256(bound) ||
    diagnostic.correction_limit !== bound.correction_limit ||
    diagnostic.phase !== bound.seal_phase ||
    diagnostic.rejected_draft_ref.phase !== bound.draft_phase ||
    diagnostic.rejected_draft_ref.kind !== bound.draft_kind ||
    diagnostic.rejected_draft_ref.content_schema?.schema_id !== bound.draft_schema ||
    diagnostic.rejected_draft_ref.content_schema?.schema_version !== bound.draft_schema_version ||
    diagnostic.epoch_anchor_ref?.artifact_id === diagnostic.rejected_draft_ref.artifact_id ||
    (diagnostic.epoch_anchor_ref?.run_id !== undefined &&
      diagnostic.epoch_anchor_ref.run_id !== diagnostic.rejected_draft_ref.run_id) ||
    (diagnostic.previous_diagnostic_ref?.run_id !== undefined &&
      diagnostic.previous_diagnostic_ref.run_id !== diagnostic.rejected_draft_ref.run_id) ||
    (diagnostic.previous_diagnostic_ref?.phase !== undefined &&
      diagnostic.previous_diagnostic_ref.phase !== diagnostic.phase) ||
    (diagnostic.previous_diagnostic_ref?.kind !== undefined &&
      diagnostic.previous_diagnostic_ref.kind !== "seal-diagnostic") ||
    (diagnostic.rejection_ordinal === 1) !== (diagnostic.previous_diagnostic_ref === null) ||
    diagnostic.corrections_used !== diagnostic.rejection_ordinal - 1 ||
    (bound.correction_limit !== null &&
      diagnostic.rejection_ordinal > bound.correction_limit + 1) ||
    (diagnostic.disposition === "stalled"
      ? bound.stall_on_unchanged_rejection !== true ||
        diagnostic.previous_diagnostic_ref === null ||
        diagnostic.stall_reason === undefined ||
        (bound.correction_limit !== null && diagnostic.corrections_used >= bound.correction_limit)
      : diagnostic.stall_reason !== undefined ||
        diagnostic.disposition !==
          (bound.correction_limit === null || diagnostic.corrections_used < bound.correction_limit
            ? "correction_offered"
            : "exhausted")) ||
    diagnostic.issue_count < diagnostic.issues.length ||
    diagnostic.issues_complete !== (diagnostic.issue_count === diagnostic.issues.length)
  ) {
    throw new Error("seal diagnostic binding or correction accounting is invalid");
  }
  const keys = new Set<string>();
  let lastKey: string | undefined;
  for (const issue of diagnostic.issues) {
    assertText(issue.code, "seal issue code", { minBytes: 1, maxBytes: 128 });
    assertText(issue.path, "seal issue path", { maxBytes: 256 });
    assertText(issue.detail, "seal issue detail", { maxBytes: 512, multiline: true });
    if (
      issue.source_ordinals.some((ordinal, index) => {
        const previous = issue.source_ordinals[index - 1];
        return previous !== undefined && ordinal <= previous;
      })
    ) {
      throw new Error("seal issue source ordinals are not strictly ordered");
    }
    const key = canonicalJson([issue.code, issue.path, issue.source_ordinals]);
    if (keys.has(key)) throw new Error("seal diagnostic repeats an issue key");
    if (lastKey !== undefined && key < lastKey) {
      throw new Error("seal diagnostic issue keys are not ordered");
    }
    keys.add(key);
    lastKey = key;
  }
  if (Buffer.byteLength(canonicalJson(diagnostic), "utf8") > 1024 * 1024) {
    throw new Error("seal diagnostic exceeds 1 MiB");
  }
  return diagnostic;
}

/** Build the optional new-terminal field from the exact persisted diagnostic, never prose. */
export function sealDiagnosticsProjection(
  diagnostic: SealDiagnosticV1,
  diagnosticRef: Static<typeof ArtifactRefSchema>,
  policy: SealPolicyV1
): SealDiagnosticsProjectionV1 {
  const checked = validateSealDiagnostic(diagnostic, policy);
  const ref = currentArtifactRef(diagnosticRef);
  if (
    ref.kind !== "seal-diagnostic" ||
    ref.run_id !== checked.rejected_draft_ref.run_id ||
    ref.phase !== checked.phase ||
    ref.content_schema?.schema_id !== checked.schema_id ||
    ref.content_schema?.schema_version !== checked.schema_version ||
    ref.content_digest !== sha256(canonicalJson(checked))
  ) {
    throw new Error("seal terminal diagnostic ref does not bind the diagnostic");
  }
  return validateSealDiagnosticsProjection({
    latest_diagnostic_ref: ref,
    rejected_draft_ref: checked.rejected_draft_ref,
    epoch_anchor_ref: checked.epoch_anchor_ref,
    corrections_used: checked.corrections_used,
    correction_limit: checked.correction_limit,
    disposition: checked.disposition,
  });
}

export function validateSealDiagnosticsProjection(value: unknown): SealDiagnosticsProjectionV1 {
  const projection = validateSkillSchema(
    SealDiagnosticsProjectionV1Schema,
    value,
    "SealDiagnosticsProjectionV1"
  );
  currentArtifactRef(projection.latest_diagnostic_ref);
  currentArtifactRef(projection.rejected_draft_ref);
  if (projection.epoch_anchor_ref !== null) currentArtifactRef(projection.epoch_anchor_ref);
  if (
    projection.latest_diagnostic_ref.kind !== "seal-diagnostic" ||
    projection.latest_diagnostic_ref.run_id !== projection.rejected_draft_ref.run_id ||
    (projection.epoch_anchor_ref?.run_id !== undefined &&
      projection.epoch_anchor_ref.run_id !== projection.rejected_draft_ref.run_id) ||
    (projection.correction_limit !== null &&
      projection.corrections_used > projection.correction_limit) ||
    (projection.disposition === "stalled"
      ? projection.correction_limit !== null &&
        projection.corrections_used >= projection.correction_limit
      : projection.disposition !==
        (projection.correction_limit === null ||
        projection.corrections_used < projection.correction_limit
          ? "correction_offered"
          : "exhausted"))
  ) {
    throw new Error("seal terminal diagnostic projection is inconsistent");
  }
  return projection;
}
