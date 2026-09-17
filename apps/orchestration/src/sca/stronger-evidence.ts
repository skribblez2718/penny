import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import { ScaM3ManifestV1Schema, validateScaM3ManifestV1 } from "./finding-validation.js";
import { ScaFindingSetV1Schema, validateScaFindingSetV1 } from "./findings.js";

const MAX_ITEMS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_FINDING_EVIDENCE_SCHEMA = "penny.sca-finding-evidence.v1";
export const SCA_M4_PROOF_INPUT_SCHEMA = "penny.sca-m4-proof-input.v1";
export const SCA_M4_MANIFEST_SCHEMA = "penny.sca-m4-manifest.v1";

const ExecutionStatusSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("output_limit"),
  Type.Literal("unavailable"),
]);

export const ScaFindingEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_FINDING_EVIDENCE_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    m3_manifest_sha256: Sha256Schema,
    execution_id: OpaqueIdSchema,
    execution_receipt_sha256: Sha256Schema,
    authorization_id: Type.String({ pattern: "^scaauth_[a-f0-9]{64}$" }),
    authorization_sha256: Sha256Schema,
    human_principal_id: OpaqueIdSchema,
    sandbox_profile_sha256: Sha256Schema,
    action_plan_sha256: Sha256Schema,
    action_type: Type.Union([
      Type.Literal("build"),
      Type.Literal("test"),
      Type.Literal("harness"),
      Type.Literal("proof_of_concept"),
    ]),
    execution_status: ExecutionStatusSchema,
    started_at: Rfc3339UtcSchema,
    completed_at: Rfc3339UtcSchema,
    exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
    stdout_sha256: Sha256Schema,
    stderr_sha256: Sha256Schema,
    finding_ids: Type.Array(Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    gap_ids: Type.Array(Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    effect: Type.Union([
      Type.Literal("supports_finding"),
      Type.Literal("refutes_finding"),
      Type.Literal("resolves_gap"),
      Type.Literal("inconclusive"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    failure_code: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    evidence_id: Type.String({ pattern: "^scaevid_[a-f0-9]{64}$" }),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaM4ProofInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M4_PROOF_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    finding_set: ScaFindingSetV1Schema,
    m3_manifest: ScaM3ManifestV1Schema,
    evidence: Type.Array(ScaFindingEvidenceV1Schema, { maxItems: MAX_ITEMS }),
  },
  { additionalProperties: false }
);

const ScaM4BlockerV1Schema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("m3_not_passed"),
      Type.Literal("m3_binding_mismatch"),
      Type.Literal("duplicate_evidence"),
      Type.Literal("evidence_binding_mismatch"),
      Type.Literal("unknown_evidence_target"),
      Type.Literal("missing_required_evidence"),
      Type.Literal("incomplete_authorized_execution"),
      Type.Literal("evidence_did_not_resolve_gap"),
      Type.Literal("evidence_refutes_finding"),
    ]),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    detail: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const ScaEvidenceGraphNodeV1Schema = Type.Object(
  {
    node_id: Type.String({ minLength: 1, maxLength: 512 }),
    node_kind: Type.Union([Type.Literal("evidence"), Type.Literal("finding"), Type.Literal("gap")]),
    label: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);

const ScaEvidenceGraphEdgeV1Schema = Type.Object(
  {
    from_node_id: Type.String({ minLength: 1, maxLength: 512 }),
    to_node_id: Type.String({ minLength: 1, maxLength: 512 }),
    relation: Type.Union([
      Type.Literal("supports"),
      Type.Literal("refutes"),
      Type.Literal("resolves"),
      Type.Literal("fails_to_resolve"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaM4ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M4_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    m3_manifest_sha256: Sha256Schema,
    milestone: Type.Literal("M4_STRONGER_EVIDENCE"),
    release_eligible: Type.Literal(false),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    evidence: Type.Array(ScaFindingEvidenceV1Schema, { maxItems: MAX_ITEMS }),
    resolved_gap_ids: Type.Array(Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    authorized_execution_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    incomplete_attempt_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    graph_nodes: Type.Array(ScaEvidenceGraphNodeV1Schema, { maxItems: MAX_ITEMS }),
    graph_edges: Type.Array(ScaEvidenceGraphEdgeV1Schema, { maxItems: MAX_ITEMS }),
    blockers: Type.Array(ScaM4BlockerV1Schema, { maxItems: MAX_ITEMS }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaFindingEvidenceV1 = Static<typeof ScaFindingEvidenceV1Schema>;
export type ScaM4ProofInputV1 = Static<typeof ScaM4ProofInputV1Schema>;
export type ScaM4ManifestV1 = Static<typeof ScaM4ManifestV1Schema>;
type UnsignedEvidence = Omit<ScaFindingEvidenceV1, "evidence_id" | "evidence_sha256">;
type EvidenceWithId = Omit<ScaFindingEvidenceV1, "evidence_sha256">;
type UnsignedM4 = Omit<ScaM4ManifestV1, "manifest_sha256">;
type Blocker = ScaM4ManifestV1["blockers"][number];

export class ScaEvidenceError extends Error {
  constructor(
    readonly code:
      | "invalid_evidence"
      | "evidence_digest_mismatch"
      | "invalid_m4_input"
      | "m4_manifest_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaEvidenceError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function evidenceId(value: UnsignedEvidence): string {
  return `scaevid_${sha256(
    canonicalJson({
      execution_receipt_sha256: value.execution_receipt_sha256,
      finding_ids: [...value.finding_ids].sort(compareUtf8),
      gap_ids: [...value.gap_ids].sort(compareUtf8),
      effect: value.effect,
    })
  )}`;
}

function evidenceDigest(value: EvidenceWithId): string {
  return sha256(canonicalJson(value));
}

function m4Digest(value: UnsignedM4): string {
  return sha256(canonicalJson(value));
}

export function sealScaFindingEvidenceV1(value: UnsignedEvidence): ScaFindingEvidenceV1 {
  let input: UnsignedEvidence;
  try {
    input = validateContract(
      Type.Omit(ScaFindingEvidenceV1Schema, ["evidence_id", "evidence_sha256"]),
      value,
      "SCA finding evidence input"
    );
  } catch (error) {
    throw new ScaEvidenceError(
      "invalid_evidence",
      error instanceof Error ? error.message : "SCA finding evidence is invalid"
    );
  }
  if (
    input.finding_ids.length + input.gap_ids.length === 0 ||
    new Set(input.finding_ids).size !== input.finding_ids.length ||
    new Set(input.gap_ids).size !== input.gap_ids.length ||
    Date.parse(input.completed_at) < Date.parse(input.started_at) ||
    (input.execution_status === "succeeded") !== (input.failure_code === null) ||
    (input.execution_status !== "succeeded" && input.effect !== "inconclusive") ||
    (input.effect === "resolves_gap" && input.gap_ids.length === 0) ||
    ((input.effect === "supports_finding" || input.effect === "refutes_finding") &&
      input.finding_ids.length === 0)
  ) {
    throw new ScaEvidenceError(
      "invalid_evidence",
      "SCA finding evidence target, execution status, effect, or time range is inconsistent"
    );
  }
  const normalized: UnsignedEvidence = {
    ...input,
    finding_ids: [...input.finding_ids].sort(compareUtf8),
    gap_ids: [...input.gap_ids].sort(compareUtf8),
  };
  const withId: EvidenceWithId = { ...normalized, evidence_id: evidenceId(normalized) };
  return validateContract(
    ScaFindingEvidenceV1Schema,
    { ...withId, evidence_sha256: evidenceDigest(withId) },
    "SCA finding evidence"
  );
}

export function validateScaFindingEvidenceV1(value: unknown): ScaFindingEvidenceV1 {
  const evidence = validateContract(ScaFindingEvidenceV1Schema, value, "SCA finding evidence");
  const { evidence_sha256: observedDigest, ...withoutDigest } = evidence;
  const { evidence_id: observedId, ...unsigned } = withoutDigest;
  if (evidenceId(unsigned) !== observedId || evidenceDigest(withoutDigest) !== observedDigest) {
    throw new ScaEvidenceError("evidence_digest_mismatch", "SCA finding evidence digest mismatch");
  }
  return evidence;
}

function addBlocker(
  blockers: Blocker[],
  code: Blocker["code"],
  subjectId: string,
  detail: string
): void {
  blockers.push({ code, subject_id: subjectId, detail });
}

export function buildScaM4ManifestV1(value: unknown): ScaM4ManifestV1 {
  let input: ScaM4ProofInputV1;
  try {
    input = validateContract(ScaM4ProofInputV1Schema, value, "SCA M4 proof input");
  } catch (error) {
    throw new ScaEvidenceError(
      "invalid_m4_input",
      error instanceof Error ? error.message : "SCA M4 proof input is invalid"
    );
  }
  const findingSet = validateScaFindingSetV1(input.finding_set);
  const m3 = validateScaM3ManifestV1(input.m3_manifest);
  const evidence = input.evidence.map((entry) => validateScaFindingEvidenceV1(entry));
  const blockers: Blocker[] = [];
  if (m3.status !== "passed") {
    addBlocker(blockers, "m3_not_passed", m3.manifest_sha256, "M3 proof did not pass");
  }
  if (
    m3.tenant_id !== findingSet.tenant_id ||
    m3.project_id !== findingSet.project_id ||
    m3.run_id !== findingSet.run_id ||
    m3.source_snapshot_sha256 !== findingSet.source_snapshot_sha256 ||
    m3.finding_set_sha256 !== findingSet.finding_set_sha256
  ) {
    addBlocker(
      blockers,
      "m3_binding_mismatch",
      m3.manifest_sha256,
      "M3 and finding-set bindings differ"
    );
  }
  const findingIds = new Set(findingSet.findings.map((finding) => finding.finding_id));
  const expectedGapIds = new Set(m3.gap_dispositions.map((gap) => gap.gap_id));
  const seenEvidence = new Set<string>();
  for (const entry of evidence) {
    if (seenEvidence.has(entry.evidence_id)) {
      addBlocker(
        blockers,
        "duplicate_evidence",
        entry.evidence_id,
        "Evidence appears more than once"
      );
      continue;
    }
    seenEvidence.add(entry.evidence_id);
    if (
      entry.tenant_id !== findingSet.tenant_id ||
      entry.project_id !== findingSet.project_id ||
      entry.run_id !== findingSet.run_id ||
      entry.source_snapshot_sha256 !== findingSet.source_snapshot_sha256 ||
      entry.finding_set_sha256 !== findingSet.finding_set_sha256 ||
      entry.m3_manifest_sha256 !== m3.manifest_sha256
    ) {
      addBlocker(
        blockers,
        "evidence_binding_mismatch",
        entry.evidence_id,
        "Evidence binding differs from the M4 subject"
      );
    }
    for (const targetId of entry.finding_ids) {
      if (!findingIds.has(targetId)) {
        addBlocker(
          blockers,
          "unknown_evidence_target",
          targetId,
          "Evidence names an unknown finding"
        );
      }
    }
    for (const targetId of entry.gap_ids) {
      if (!expectedGapIds.has(targetId)) {
        addBlocker(blockers, "unknown_evidence_target", targetId, "Evidence names an unknown gap");
      }
    }
    if (entry.execution_status !== "succeeded") {
      addBlocker(
        blockers,
        "incomplete_authorized_execution",
        entry.execution_id,
        `Authorized execution ended with status ${entry.execution_status}`
      );
    }
    if (entry.effect === "refutes_finding") {
      for (const findingId of entry.finding_ids) {
        addBlocker(
          blockers,
          "evidence_refutes_finding",
          findingId,
          "Stronger evidence refutes a retained finding; re-derivation is required"
        );
      }
    }
  }

  const resolvedGapIds: string[] = [];
  for (const gap of m3.gap_dispositions.filter(
    (entry) => entry.disposition === "requires_stronger_evidence"
  )) {
    const attempts = evidence.filter((entry) => entry.gap_ids.includes(gap.gap_id));
    if (attempts.length === 0) {
      addBlocker(
        blockers,
        "missing_required_evidence",
        gap.gap_id,
        "Required stronger evidence was not attempted"
      );
      continue;
    }
    if (
      attempts.some(
        (entry) => entry.execution_status === "succeeded" && entry.effect === "resolves_gap"
      )
    ) {
      resolvedGapIds.push(gap.gap_id);
    } else {
      addBlocker(
        blockers,
        "evidence_did_not_resolve_gap",
        gap.gap_id,
        "Authorized evidence did not resolve the required gap"
      );
    }
  }

  const nodes = new Map<string, ScaM4ManifestV1["graph_nodes"][number]>();
  const edges: ScaM4ManifestV1["graph_edges"] = [];
  for (const entry of evidence) {
    nodes.set(entry.evidence_id, {
      node_id: entry.evidence_id,
      node_kind: "evidence",
      label: `${entry.action_type}:${entry.execution_status}`,
    });
    for (const findingId of entry.finding_ids) {
      nodes.set(findingId, { node_id: findingId, node_kind: "finding", label: findingId });
      edges.push({
        from_node_id: entry.evidence_id,
        to_node_id: findingId,
        relation:
          entry.effect === "supports_finding"
            ? "supports"
            : entry.effect === "refutes_finding"
              ? "refutes"
              : "fails_to_resolve",
      });
    }
    for (const gapId of entry.gap_ids) {
      nodes.set(gapId, { node_id: gapId, node_kind: "gap", label: gapId });
      edges.push({
        from_node_id: entry.evidence_id,
        to_node_id: gapId,
        relation:
          entry.execution_status === "succeeded" && entry.effect === "resolves_gap"
            ? "resolves"
            : "fails_to_resolve",
      });
    }
  }
  const orderedEvidence = [...evidence].sort((left, right) =>
    compareUtf8(left.evidence_id, right.evidence_id)
  );
  const unsigned: UnsignedM4 = {
    schema_id: SCA_M4_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: findingSet.tenant_id,
    project_id: findingSet.project_id,
    run_id: findingSet.run_id,
    source_snapshot_sha256: findingSet.source_snapshot_sha256,
    finding_set_sha256: findingSet.finding_set_sha256,
    m3_manifest_sha256: m3.manifest_sha256,
    milestone: "M4_STRONGER_EVIDENCE",
    release_eligible: false,
    status: blockers.length === 0 ? "passed" : "blocked",
    evidence: orderedEvidence,
    resolved_gap_ids: resolvedGapIds.sort(compareUtf8),
    authorized_execution_count: evidence.length,
    incomplete_attempt_count: evidence.filter((entry) => entry.execution_status !== "succeeded")
      .length,
    graph_nodes: [...nodes.values()].sort((left, right) =>
      compareUtf8(left.node_id, right.node_id)
    ),
    graph_edges: edges.sort((left, right) =>
      compareUtf8(
        `${left.from_node_id}\u0000${left.relation}\u0000${left.to_node_id}`,
        `${right.from_node_id}\u0000${right.relation}\u0000${right.to_node_id}`
      )
    ),
    blockers,
  };
  return validateContract(
    ScaM4ManifestV1Schema,
    { ...unsigned, manifest_sha256: m4Digest(unsigned) },
    "SCA M4 manifest"
  );
}

export function validateScaM4ManifestV1(value: unknown): ScaM4ManifestV1 {
  const manifest = validateContract(ScaM4ManifestV1Schema, value, "SCA M4 manifest");
  const { manifest_sha256: observedDigest, ...unsigned } = manifest;
  if (m4Digest(unsigned) !== observedDigest) {
    throw new ScaEvidenceError("m4_manifest_digest_mismatch", "SCA M4 manifest digest mismatch");
  }
  return manifest;
}
