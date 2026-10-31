import { TextDecoder } from "node:util";
import path from "node:path";

import { Type, type Static } from "typebox";

import {
  ScaP01JoernRuntimeClosureV1Schema,
  ScaP01JoernRootInputV1Schema,
  type ScaP01JoernRuntimeClosureV1,
} from "./p01-joern-root.js";
import { parseScaP03JoernPackageListingV1 } from "./p03-toolchain-version.js";
import {
  ArtifactStore,
  currentArtifactRef,
  currentOutputArtifactMetadata,
  previewArtifactRef,
  type ArtifactHostStore,
  type PersistArtifactInput,
} from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../orchestration/dist/contracts.js";
import { OpaqueIdSchema } from "../../orchestration/dist/skill-contracts/common.js";
import { validateScaCampaignManifestCoreV1 } from "../../orchestration/dist/sca/p01-contracts.js";
import {
  validateScaToolchainIdentityV1,
  type ScaToolchainIdentityV1,
} from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  admitScaP02Candidate,
  createScaP03TransitionAdmissionV1,
  scaP02InputArtifacts,
} from "../../orchestration/dist/sca/p02-admission.js";
import { SCA_P02_CANDIDATE_PLAYBOOK_NAME } from "../../orchestration/dist/sca/p02-playbook.js";
import {
  validateScaP02RequestV1,
  validateScaP02P03TransitionV1,
  validateScaP02EvidenceManifestV1,
  validateScaP02GateV1,
  type ScaP02RequestV1,
  type ScaP02P03TransitionV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import {
  measureScaP02CurrentHostBinding,
  type ScaP02CurrentHostBindingV1,
} from "../../orchestration/dist/sca/p02-activation-host.js";
import {
  validateScaP03P01RuntimeRootV1,
  type ScaP03P01RuntimeRootSelectionV1,
} from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import type { ScaP03RequestV2 } from "../../orchestration/dist/sca/p03-contracts.js";
import {
  requireScaP03AcceptedP02Qualification,
  createScaP02QualificationDefinitionFromSnapshot,
  type ScaP02V3DefinitionSnapshot,
} from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import {
  validateScaPhaseGateRecordV3,
  type ScaPhaseGateRecordV3,
} from "../../orchestration/dist/sca/qualification-gate-contracts.js";
import {
  validateScaActivationAuthorityV1,
  validateScaActivationIssuanceV1,
  SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
  SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
  type ScaActivationAuthorityV1,
  type ScaActivationIssuanceV1,
} from "../../orchestration/dist/sca/qualification-activation-contracts.js";
import {
  scaProposedStartSha256,
  scaQualificationPolicyDataSha256,
  type ScaProposedActivationStartV1,
} from "../../orchestration/dist/sca/qualification-activation.js";

import {
  deriveScaP03InitialCustodyV1,
  SCA_P03_INPUT_MAX_ARTIFACT_BYTES,
  SCA_P03_INPUT_MAX_JSON_BYTES,
  SCA_P03_INPUT_MAX_TOTAL_BYTES,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";

/** Hard ceilings for an inspection, not an execution/resource grant. Callers may tighten them. */
export const ScaP03PredecessorLimitsV1Schema = Type.Object(
  {
    max_refs: Type.Integer({ minimum: 1, maximum: 1024 }),
    max_artifact_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_INPUT_MAX_ARTIFACT_BYTES }),
    max_json_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_INPUT_MAX_JSON_BYTES }),
    max_total_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_INPUT_MAX_TOTAL_BYTES }),
  },
  { additionalProperties: false }
);
export type ScaP03PredecessorLimitsV1 = Readonly<Static<typeof ScaP03PredecessorLimitsV1Schema>>;

const contextFields = {
  store_root: Type.String({ minLength: 1, maxLength: 4096 }),
  tenant_id: OpaqueIdSchema,
  project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
  limits: ScaP03PredecessorLimitsV1Schema,
};
const historicalFields = {
  definition_ref: ArtifactRefSchema,
  gate_ref: ArtifactRefSchema,
  qualification_ref: ArtifactRefSchema,
  historical_issuance_ref: ArtifactRefSchema,
  historical_authority_ref: ArtifactRefSchema,
  // Producer expectations come from the caller's issuer installation contract, never defaults.
  issuance_producer: OpaqueIdSchema,
  authority_producer: OpaqueIdSchema,
};
export const ScaP03PredecessorInputsV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-predecessor-inputs.v1"),
    schema_version: Type.Literal(1),
    ...contextFields,
    ...historicalFields,
    request_ref: ArtifactRefSchema,
    transition_ref: ArtifactRefSchema,
    root_tool_id: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false }
);
export type ScaP03PredecessorInputsV1 = Readonly<Static<typeof ScaP03PredecessorInputsV1Schema>>;

/** A separately usable formal-qualification/history inspection; NOT a complete predecessor replay. */
export const ScaP03HistoricalP02InputsV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-historical-p02-inputs.v1"),
    schema_version: Type.Literal(1),
    ...contextFields,
    ...historicalFields,
    accepted_p02_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaP03HistoricalP02InputsV1 = Readonly<
  Static<typeof ScaP03HistoricalP02InputsV1Schema>
>;

export type ScaP03PredecessorDiagnosticCodeV1 =
  | "missing_input"
  | "invalid_input"
  | "store_denied"
  | "ref_mismatch"
  | "metadata_denied"
  | "budget_exceeded"
  | "noncanonical_json"
  | "historical_binding_denied"
  | "p01_replay_denied"
  | "root_selection_denied"
  | "root_closure_denied"
  | "transition_replay_denied"
  | "qualification_replay_denied"
  | "current_binding_denied";
export interface ScaP03PredecessorDiagnosticV1 {
  readonly code: ScaP03PredecessorDiagnosticCodeV1;
  /** Bounded public operand label, never an underlying filesystem/SQLite/validator message. */
  readonly operand: string;
}
export type ScaP03PredecessorResultV1<Value> =
  | { readonly status: "ready"; readonly value: Value }
  | {
      readonly status: "missing_input" | "refused";
      readonly diagnostics: readonly ScaP03PredecessorDiagnosticV1[];
    };

class Refusal extends Error {
  constructor(
    readonly code: ScaP03PredecessorDiagnosticCodeV1,
    readonly operand: string
  ) {
    super(`${code}: ${operand}`);
  }
}
function deny(code: ScaP03PredecessorDiagnosticCodeV1, operand: string): never {
  throw new Refusal(code, operand);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function sorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
function protect<Value>(
  code: ScaP03PredecessorDiagnosticCodeV1,
  operand: string,
  work: () => Value
): Value {
  try {
    return work();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    deny(code, operand);
  }
}
function result<Value>(work: () => Value): ScaP03PredecessorResultV1<Value> {
  try {
    return { status: "ready", value: work() };
  } catch (error) {
    const failure =
      error instanceof Refusal ? error : new Refusal("invalid_input", "predecessor_inputs");
    return {
      status: failure.code === "missing_input" ? "missing_input" : "refused",
      diagnostics: [{ code: failure.code, operand: failure.operand }],
    };
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireFields(value: unknown, names: readonly string[]): void {
  if (!record(value)) deny("invalid_input", "predecessor_inputs");
  for (const name of names)
    if (value[name] === undefined || value[name] === null) deny("missing_input", name);
}
const COMMON_REQUIRED = [...Object.keys(contextFields), ...Object.keys(historicalFields)];

/** Check nesting before JSON.parse/canonicalJson's recursive traversal. Duplicate keys fail canonical equality. */
function parseJson(bytes: Buffer, label: string, limit: number): unknown {
  if (bytes.byteLength > limit) deny("budget_exceeded", label);
  return protect("noncanonical_json", label, () => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const c of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") {
        if (++depth > 64) deny("budget_exceeded", label);
      } else if (c === "}" || c === "]") depth--;
    }
    const parsed: unknown = JSON.parse(text);
    if (canonicalJson(parsed) !== text) deny("noncanonical_json", label);
    return parsed;
  });
}

interface ExactEntry {
  readonly ref: ArtifactRef;
  readonly bytes: Buffer;
  readonly metadata: OutputArtifactMetadata;
}
/** Capability attenuation for existing validators. No selection, writes, scans, or invented read(ref) on ArtifactHostStore. */
class ExactReader implements ArtifactHostStore {
  private readonly entries = new Map<string, ExactEntry>();
  private total = 0;
  private readonly approved: ReadonlyMap<string, string> | undefined;
  private readonly approvedCoordinates: ReadonlyMap<string, string> | undefined;
  private readonly approvedPrefixes: ReadonlySet<string> | undefined;
  constructor(
    private readonly native: ArtifactStore,
    readonly limits: ScaP03PredecessorLimitsV1,
    approvedRefs?: readonly ArtifactRef[]
  ) {
    if (approvedRefs !== undefined) {
      const derived = deriveScaP03InitialCustodyV1(approvedRefs);
      if (!same(derived, limits)) deny("budget_exceeded", "approved_limits");
      this.approved = new Map(approvedRefs.map((ref) => [ref.artifact_id, canonicalJson(ref)]));
      this.approvedCoordinates = new Map(
        approvedRefs.map((ref) => [
          canonicalJson([
            ref.run_id,
            ref.phase,
            ref.branch_id,
            ref.kind,
            ref.operation_id,
            ref.version,
          ]),
          canonicalJson(ref),
        ])
      );
      this.approvedPrefixes = new Set(
        approvedRefs.map((ref) =>
          canonicalJson([ref.run_id, ref.phase, ref.branch_id, ref.kind, ref.operation_id])
        )
      );
    }
  }
  private member(ref: ArtifactRef): void {
    if (this.approved !== undefined && this.approved.get(ref.artifact_id) !== canonicalJson(ref))
      deny("ref_mismatch", "unapproved_ref");
  }
  private memberId(id: string): void {
    if (this.approved !== undefined && !this.approved.has(id))
      deny("ref_mismatch", "unapproved_id");
  }
  persist(input: PersistArtifactInput): never {
    void input;
    return deny("store_denied", "persist");
  }
  select(ref: ArtifactRef): never {
    void ref;
    return deny("store_denied", "select");
  }
  refById(id: string): ArtifactRef | undefined {
    this.memberId(id);
    const stored = protect("ref_mismatch", "exact_ref", () => this.native.refById(id));
    if (stored === undefined) return undefined;
    this.assertApprovedRef(stored);
    return structuredClone(stored);
  }
  readById(id: string): Buffer {
    const ref = this.refById(id);
    if (ref === undefined) deny("missing_input", "closure_ref");
    return Buffer.from(this.exact(ref).bytes);
  }
  metadata(ref: ArtifactRef): OutputArtifactMetadata {
    return this.exact(ref).metadata;
  }
  lastVersion(run: string, phase: string, branch: string | null, kind: string, op: string): number {
    if (
      this.approvedPrefixes !== undefined &&
      !this.approvedPrefixes.has(canonicalJson([run, phase, branch, kind, op]))
    )
      deny("ref_mismatch", "unapproved_coordinate");
    // An approved prefix permits the native current-version check, not an allowlist-derived latest.
    return this.native.lastVersion(run, phase, branch, kind, op);
  }
  refFor(
    run: string,
    phase: string,
    branch: string | null,
    kind: string,
    op: string,
    version: number
  ): ArtifactRef | null {
    const coordinate = canonicalJson([run, phase, branch, kind, op, version]);
    const approved = this.approvedCoordinates?.get(coordinate);
    if (this.approvedCoordinates !== undefined && approved === undefined)
      deny("ref_mismatch", "unapproved_coordinate");
    const ref = this.native.refFor(run, phase, branch, kind, op, version);
    if (ref !== null) {
      this.assertApprovedRef(ref);
      if (approved !== undefined && approved !== canonicalJson(ref))
        deny("ref_mismatch", "exact_ref");
    }
    return ref === null ? null : structuredClone(ref);
  }
  assertApprovedRef(value: ArtifactRef): void {
    const ref = currentArtifactRef(value);
    this.member(ref);
  }
  exact(value: ArtifactRef, label = "closure_ref"): ExactEntry {
    const ref = protect("ref_mismatch", "exact_ref", () => currentArtifactRef(value));
    this.member(ref);
    const cached = this.entries.get(ref.artifact_id);
    if (cached !== undefined) {
      if (!same(cached.ref, ref)) deny("ref_mismatch", "changed_ref");
      return cached;
    }
    if (
      !Number.isSafeInteger(ref.byte_length) ||
      !Number.isSafeInteger(this.total + ref.byte_length) ||
      this.entries.size >= this.limits.max_refs ||
      ref.byte_length > this.limits.max_artifact_bytes ||
      this.total + ref.byte_length > this.limits.max_total_bytes ||
      (ref.media_type === "application/json" && ref.byte_length > this.limits.max_json_bytes)
    )
      deny("budget_exceeded", "closure");
    const stored = protect("ref_mismatch", "exact_ref", () => this.native.refById(ref.artifact_id));
    if (stored === undefined) deny("missing_input", label);
    if (!same(stored, ref)) deny("ref_mismatch", "exact_ref");
    const rawMetadata = protect("metadata_denied", "artifact_metadata", () =>
      this.native.metadata(ref)
    );
    const metadata = protect("metadata_denied", "artifact_metadata", () =>
      currentOutputArtifactMetadata(rawMetadata)
    );
    if (metadata.upstream_refs.length > this.limits.max_refs)
      deny("budget_exceeded", "provenance_refs");
    // Native metadata preserves producer ordering; sorting is not a store invariant.
    // The native validator owns closed shape, duplicates and revision rules. Expected
    // producer lineage is checked separately here and by the source guards.
    if (!same(rawMetadata, metadata)) deny("metadata_denied", "artifact_provenance");
    const bytes = protect("ref_mismatch", "artifact_bytes", () => this.native.read(ref));
    if (
      bytes.byteLength !== ref.byte_length ||
      sha256(bytes) !== ref.content_digest ||
      !same(
        protect("metadata_denied", "artifact_metadata", () =>
          previewArtifactRef({ metadata, content: bytes })
        ),
        ref
      )
    )
      deny("ref_mismatch", "artifact_bytes_or_metadata");
    if (metadata.parent_ref !== null) {
      this.member(metadata.parent_ref);
      if (
        !same(
          this.refFor(
            ref.run_id,
            ref.phase,
            ref.branch_id,
            ref.kind,
            ref.operation_id,
            ref.version - 1
          ),
          metadata.parent_ref
        )
      )
        deny("metadata_denied", "parent_ref");
    }
    // Opaque provenance members retain their exact native bytes (some historical
    // auxiliary JSON includes a trailing newline). Parse/canonicalize only typed
    // operands through json() and their owning validators, never every linked blob.
    const entry = { ref, bytes, metadata };
    this.entries.set(ref.artifact_id, entry);
    this.total += bytes.byteLength;
    return entry;
  }
  json(ref: ArtifactRef, label: string): unknown {
    if (ref.byte_length > this.limits.max_json_bytes) deny("budget_exceeded", label);
    return parseJson(this.exact(ref, label).bytes, label, this.limits.max_json_bytes);
  }
  finish(): void {
    // Iterative bounded walk of exact persisted links only. No global inventory or name lookup.
    const queue = [...this.entries.values()];
    const visited = new Set<string>();
    const enqueued = new Set(queue.map((entry) => entry.ref.artifact_id));
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry === undefined || visited.has(entry.ref.artifact_id)) continue;
      visited.add(entry.ref.artifact_id);
      for (const ref of [
        ...(entry.metadata.parent_ref === null ? [] : [entry.metadata.parent_ref]),
        ...entry.metadata.upstream_refs,
      ]) {
        const child = this.exact(ref);
        if (!enqueued.has(ref.artifact_id)) {
          enqueued.add(ref.artifact_id);
          queue.push(child);
        }
      }
    }
    // Re-read the exact snapshot after replay. A cache never hides removal or drift during validation.
    for (const entry of this.entries.values()) {
      this.member(entry.ref);
      const stored = protect("ref_mismatch", "closure_ref", () =>
        this.native.refById(entry.ref.artifact_id)
      );
      if (!same(stored, entry.ref)) deny("ref_mismatch", "changed_ref");
      const metadata = protect("metadata_denied", "artifact_metadata", () =>
        this.native.metadata(entry.ref)
      );
      if (!same(metadata, entry.metadata)) deny("metadata_denied", "changed_provenance");
      const bytes = protect("ref_mismatch", "artifact_bytes", () => this.native.read(entry.ref));
      if (!bytes.equals(entry.bytes)) deny("ref_mismatch", "changed_bytes");
    }
  }
  provenance(
    ref: ArtifactRef,
    expected: readonly ArtifactRef[],
    order: "producer_sorted" | "native_membership" = "producer_sorted"
  ): void {
    const metadata = this.metadata(ref);
    // Candidate persistence explicitly sorts. External historical issuers have no
    // universal ordering contract: compare exact members without rewriting metadata.
    const observed =
      order === "producer_sorted" ? metadata.upstream_refs : sorted(metadata.upstream_refs);
    if (
      metadata.parent_ref !== null ||
      metadata.domain_revision_parent_ref != null ||
      !same(observed, sorted(expected))
    )
      deny("metadata_denied", "historical_provenance");
  }
  census(): {
    readonly ref_count: number;
    readonly total_bytes: number;
    readonly refs: readonly ArtifactRef[];
  } {
    return {
      ref_count: this.entries.size,
      total_bytes: this.total,
      refs: sorted([...this.entries.values()].map((e) => e.ref)),
    };
  }
}
/** Initial-path projection retains native coordinate checks and repeated exact readback. */
export function createScaP03ApprovedInputReaderV1(
  store: ArtifactStore,
  refs: readonly ArtifactRef[]
) {
  return new ExactReader(store, deriveScaP03InitialCustodyV1(refs), refs);
}
function contract(
  ref: ArtifactRef,
  kind: string,
  schema: string,
  version: number,
  producer: string,
  phase?: string
): void {
  if (
    ref.kind !== kind ||
    ref.content_schema?.schema_id !== schema ||
    ref.content_schema.schema_version !== version ||
    ref.producer !== producer ||
    ref.media_type !== "application/json" ||
    ref.branch_id !== null ||
    (phase !== undefined && ref.phase !== phase)
  )
    deny("ref_mismatch", "artifact_contract");
}
function open<Value>(
  input: Static<typeof ScaP03HistoricalP02InputsV1Schema> | ScaP03PredecessorInputsV1,
  work: (reader: ExactReader, store: ArtifactStore) => Value,
  approvedRefs?: readonly ArtifactRef[]
): Value {
  if (!path.isAbsolute(input.store_root) || path.normalize(input.store_root) !== input.store_root)
    deny("store_denied", "store_root");
  // verify mode is SQLite read-only and neither provisions nor repairs an absent partition.
  using store = protect(
    "store_denied",
    "store_root",
    () => new ArtifactStore(input.store_root, { projectId: input.project_id }, "verify")
  );
  protect("store_denied", "project_id", () => store.assertBoundProject(input.project_id));
  return work(new ExactReader(store, input.limits, approvedRefs), store);
}

export interface ScaP03HistoricalP02ReplayV1 {
  readonly definition: ScaP02V3DefinitionSnapshot;
  readonly gate: ScaPhaseGateRecordV3;
  readonly authority: ScaActivationAuthorityV1;
  readonly issuance: ScaActivationIssuanceV1;
  readonly proposed_start: {
    readonly provenance: "derived_not_persisted_artifact";
    readonly value: ScaProposedActivationStartV1;
    readonly canonical_sha256: string;
  };
  readonly qualification_replay: "passed";
  readonly historical_linkage: "verified_not_authenticated_current_admission";
  readonly current_host_binding_replay: "not_run";
  readonly usable_authority: "unknown";
  readonly authority_reason: "canonical_owner_current_time_not_verified";
  readonly activation_allowed: false;
}
function historical(
  reader: ExactReader,
  input: ScaP03HistoricalP02InputsV1
): ScaP03HistoricalP02ReplayV1 {
  for (const name of [
    "definition_ref",
    "gate_ref",
    "qualification_ref",
    "historical_authority_ref",
    "historical_issuance_ref",
  ] as const)
    // These five operands have owning canonical-JSON contracts, unlike opaque
    // transitively linked native evidence. Bound decoding before source replay.
    reader.json(input[name], name);
  for (const ref of input.accepted_p02_refs) reader.exact(ref, "accepted_p02_refs");
  const definition = protect("qualification_replay_denied", "definition_ref", () =>
    requireScaP03AcceptedP02Qualification({
      store: reader,
      definition_ref: input.definition_ref,
      gate_ref: input.gate_ref,
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      accepted_p02_refs: input.accepted_p02_refs,
    })
  );
  if (!same(definition.qualification_ref, input.qualification_ref))
    deny("historical_binding_denied", "qualification_ref");
  const gate = protect("qualification_replay_denied", "gate_ref", () =>
    validateScaPhaseGateRecordV3(reader.json(input.gate_ref, "gate_ref"))
  );
  for (const [ref, kind, schema, producer] of [
    [
      input.historical_authority_ref,
      "sca-activation-authority",
      SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
      input.authority_producer,
    ],
    [
      input.historical_issuance_ref,
      "sca-activation-issuance",
      SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
      input.issuance_producer,
    ],
  ] as const) {
    contract(ref, kind, schema, 1, producer, "sca-activation-admission");
    if (ref.version !== 1) deny("historical_binding_denied", "activation_version");
  }
  const authority = protect("historical_binding_denied", "historical_authority_ref", () =>
    validateScaActivationAuthorityV1(
      reader.json(input.historical_authority_ref, "historical_authority_ref")
    )
  );
  const issuance = protect("historical_binding_denied", "historical_issuance_ref", () =>
    validateScaActivationIssuanceV1(
      reader.json(input.historical_issuance_ref, "historical_issuance_ref")
    )
  );
  const s = authority.scope;
  const projection = {
    tenant_id: s.tenant_id,
    project_id: s.project_id,
    phase_id: s.phase_id,
    production_playbook_name: s.production_playbook_name,
    qualification_run_id: s.qualification_run_id,
    activation_run_id: s.activation_run_id,
    qualification_ref: s.qualification_ref,
    gate_ref: s.gate_ref,
  };
  const projectedDigest = protect("historical_binding_denied", "proposed_start", () =>
    scaProposedStartSha256(projection)
  );
  if (
    s.tenant_id !== input.tenant_id ||
    s.project_id !== input.project_id ||
    s.phase_id !== "SCA-P02" ||
    s.production_playbook_name !== "sca-p02" ||
    s.qualification_run_id !== definition.run_id ||
    s.activation_run_id !== input.historical_authority_ref.run_id ||
    s.activation_run_id !== input.historical_issuance_ref.run_id ||
    !same(s.gate_ref, input.gate_ref) ||
    !same(s.qualification_ref, input.qualification_ref) ||
    !same(s.implementation_identity_ref, definition.implementation_identity.ref) ||
    !same(authority.issuance_record_ref, input.historical_issuance_ref) ||
    s.qualification_policy_data_sha256 !==
      scaQualificationPolicyDataSha256(
        createScaP02QualificationDefinitionFromSnapshot(definition)
      ) ||
    s.host_implementation_binding_sha256 !== definition.current_host_binding_sha256 ||
    s.proposed_start_sha256 !== projectedDigest ||
    issuance.scope_sha256 !== sha256(canonicalJson(s)) ||
    issuance.authority_id !== s.authority_id ||
    issuance.operator_principal_id !== s.operator_principal_id ||
    issuance.issuer_policy_id !== s.issuer_policy_id ||
    issuance.issued_at !== s.issued_at ||
    Date.parse(gate.evaluated_at) > Date.parse(s.issued_at) ||
    s.operator_principal_id === definition.reviewer_identity_id ||
    s.operator_principal_id === definition.reviewer_lineage_id ||
    s.issuer_policy_id === definition.reviewer_authority_id ||
    s.authority_id === definition.reviewer_authority_id
  )
    deny("historical_binding_denied", "historical_scope");
  const upstream = [s.gate_ref, s.qualification_ref, s.implementation_identity_ref];
  reader.provenance(input.historical_issuance_ref, upstream, "native_membership");
  reader.provenance(
    input.historical_authority_ref,
    [...upstream, input.historical_issuance_ref],
    "native_membership"
  );
  reader.finish();
  const proposal: ScaProposedActivationStartV1 = {
    ...projection,
    proposed_start_sha256: projectedDigest,
    authority_ref: input.historical_authority_ref,
  };
  return {
    definition,
    gate,
    authority,
    issuance,
    proposed_start: {
      provenance: "derived_not_persisted_artifact",
      value: proposal,
      canonical_sha256: sha256(canonicalJson(proposal)),
    },
    qualification_replay: "passed",
    historical_linkage: "verified_not_authenticated_current_admission",
    current_host_binding_replay: "not_run",
    usable_authority: "unknown",
    authority_reason: "canonical_owner_current_time_not_verified",
    activation_allowed: false,
  };
}

/** Replays immutable formal P02 qualification and issuance linkage only; expiry/status are NOT admission. */
export function replayScaP03HistoricalP02AuthorityV1(
  value: unknown
): ScaP03PredecessorResultV1<ScaP03HistoricalP02ReplayV1> {
  return result(() => {
    requireFields(value, [...COMMON_REQUIRED, "accepted_p02_refs"]);
    const input = protect("invalid_input", "historical_p02_inputs", () =>
      validateContract(ScaP03HistoricalP02InputsV1Schema, value, "historical P02 inputs")
    );
    return open(input, (reader) => historical(reader, input));
  });
}

/** Select by exact ID or the UNIQUE complete parser; neither name nor a keyword grants root identity. */
export function selectScaP03PredecessorRootToolV1(
  toolchainValue: unknown,
  rootToolId?: string
): ScaToolchainIdentityV1["tools"][number] {
  return protect("root_selection_denied", "root_tool_id", () => {
    const toolchain = validateScaToolchainIdentityV1(toolchainValue);
    if (new Set(toolchain.tools.map((tool) => tool.tool_id)).size !== toolchain.tools.length)
      deny("root_selection_denied", "duplicate_tool_id");
    const complete = toolchain.tools.filter(
      (tool) =>
        tool.role === "parser" &&
        (["php", "javascript", "typescript"] as const).every((language) =>
          tool.languages.includes(language)
        )
    );
    if (rootToolId === undefined && complete.length > 1) deny("missing_input", "root_tool_id");
    const matches =
      rootToolId === undefined ? complete : complete.filter((tool) => tool.tool_id === rootToolId);
    const selected = matches[0];
    if (matches.length !== 1 || selected === undefined)
      deny("root_selection_denied", "root_tool_id");
    return selected;
  });
}

/** Use the owning package schema and parser. This validates RECORDED measurements, never the live daemon. */
export function validateScaP03RecordedRootClosureV1(
  value: unknown,
  measuredVersion: string
): ScaP01JoernRuntimeClosureV1 {
  return protect("root_closure_denied", "root_executable_ref", () => {
    const closure = validateContract(
      ScaP01JoernRuntimeClosureV1Schema,
      value,
      "P01 recorded root closure"
    );
    validateContract(
      ScaP01JoernRootInputV1Schema.properties.image_ref,
      closure.image_ref,
      "root image ref"
    );
    validateContract(
      ScaP01JoernRootInputV1Schema.properties.expected_docker_client_version,
      closure.docker_client_version,
      "root Docker client"
    );
    validateContract(
      ScaP01JoernRootInputV1Schema.properties.expected_docker_server_version,
      closure.docker_server_version,
      "root Docker server"
    );
    if (
      closure.image_ref.split("@")[0]?.split("/").at(-1)?.includes(":") === true ||
      closure.joern_version !== measuredVersion ||
      closure.image_closure_sha256 !== sha256(canonicalJson(closure.image)) ||
      closure.image.config_blob_sha256 !== closure.image.image_id.slice("sha256:".length) ||
      new Set(closure.packages.map((p) => p.path_sha256)).size !== closure.packages.length ||
      new Set(closure.packages.map((p) => p.filename)).size !== closure.packages.length
    )
      deny("root_closure_denied", "recorded_image_or_version");
    for (const component of ["joern-cli", "php2cpg", "jssrc2cpg"] as const) {
      const version = parseScaP03JoernPackageListingV1(
        closure.packages
          .filter((p) => p.component === component)
          .map((p) => p.filename)
          .join("\n"),
        component
      );
      if (version !== closure.joern_version) deny("root_closure_denied", "recorded_packages");
    }
    for (const key of [
      "uid",
      "gid",
      "memory_bytes",
      "cpus",
      "pids",
      "tmpfs_bytes",
      "inactivity_ms",
      "max_command_output_bytes",
    ] as const)
      validateContract(
        ScaP01JoernRootInputV1Schema.properties[key],
        closure.confinement[key],
        "recorded confinement"
      );
    return closure;
  });
}

export interface ScaP03PredecessorReplayV1 {
  readonly request: ScaP02RequestV1;
  readonly transition: ScaP02P03TransitionV1;
  readonly accepted_p01: ScaP02RequestV1["accepted_p01"];
  readonly root: ScaP03P01RuntimeRootSelectionV1;
  readonly original_root_bytes: Buffer;
  readonly recorded_root_closure: ScaP01JoernRuntimeClosureV1;
  readonly historical_p02: ScaP03HistoricalP02ReplayV1;
  readonly historical_transition_replay_as_of: string;
  readonly closure: {
    readonly ref_count: number;
    readonly total_bytes: number;
    readonly refs: readonly ArtifactRef[];
  };
  readonly bootstrap_operands: {
    readonly provenance: "derived_caller_operands_not_a_new_artifact";
    readonly accepted_p01: ScaP02RequestV1["accepted_p01"];
    readonly accepted_p02: ScaP03RequestV2["accepted_p02"];
    readonly source_snapshot_ref: ArtifactRef;
    readonly source_snapshot_sha256: string;
    readonly root_tool_id: string;
    readonly toolchain_ref: ArtifactRef;
    readonly root_executable_ref: ArtifactRef;
    readonly root_measurement_ref: ArtifactRef;
    readonly create_store: false;
    readonly missing_input: readonly string[];
  };
  readonly readiness: "historical_closure_replayed_only";
  readonly p02_renewal: "not_performed";
  readonly p03_activation: "not_authorized";
  readonly p04: "separately_gated_not_authorized";
}
function full(reader: ExactReader, input: ScaP03PredecessorInputsV1): ScaP03PredecessorReplayV1 {
  // Required direct refs first: never start with a substitute derived from names or selection state.
  for (const name of [
    "request_ref",
    "definition_ref",
    "gate_ref",
    "qualification_ref",
    "historical_issuance_ref",
    "historical_authority_ref",
    "transition_ref",
  ] as const)
    reader.exact(input[name], name);
  contract(
    input.request_ref,
    "sca-p02-candidate-request",
    "penny.sca-p02-request.v1",
    1,
    "host:sca-p02-candidate",
    SCA_P02_CANDIDATE_PLAYBOOK_NAME
  );
  contract(
    input.transition_ref,
    "sca-p02-p03-transition",
    "penny.sca-p02-p03-transition.v1",
    1,
    "host:sca-p02-candidate",
    SCA_P02_CANDIDATE_PLAYBOOK_NAME
  );
  const request = protect("p01_replay_denied", "request_ref", () =>
    validateScaP02RequestV1(reader.json(input.request_ref, "request_ref"))
  );
  if (
    request.tenant_id !== input.tenant_id ||
    request.project_id !== input.project_id ||
    request.run_id !== input.request_ref.run_id
  )
    deny("historical_binding_denied", "request_project_or_run");
  const accepted = request.accepted_p01;
  const core = protect("p01_replay_denied", "campaign_manifest_core_ref", () =>
    validateScaCampaignManifestCoreV1(
      reader.json(accepted.campaign_manifest_core_ref, "campaign_manifest_core_ref")
    )
  );
  const toolchainRef = core.frozen_refs.toolchain_ref;
  const tool = selectScaP03PredecessorRootToolV1(
    reader.json(toolchainRef, "toolchain_ref"),
    input.root_tool_id
  );
  if (tool.executable_ref.byte_length > 64 * 1024) deny("budget_exceeded", "root_executable_ref");
  const root = protect("p01_replay_denied", "accepted_p01", () =>
    validateScaP03P01RuntimeRootV1({
      store: reader,
      accepted_p01: accepted,
      root_tool_id: tool.tool_id,
      toolchain_ref: toolchainRef,
      root_executable_ref: tool.executable_ref,
      root_measurement_ref: tool.measurement_receipt_ref,
    })
  );
  const rootEntry = reader.exact(root.root_executable_ref);
  const recorded = validateScaP03RecordedRootClosureV1(
    parseJson(
      rootEntry.bytes,
      "root_executable_ref",
      Math.min(input.limits.max_json_bytes, 64 * 1024)
    ),
    root.root_measurement.version
  );
  if (
    root.root_measurement.measurement_method !== "host-sha256" ||
    root.root_executable_ref.version !== 1 ||
    root.root_measurement_ref.version !== 1 ||
    root.root_executable_ref.phase !== "sca-p01" ||
    root.root_measurement_ref.phase !== "sca-p01"
  )
    deny("root_closure_denied", "root_custody");
  reader.provenance(root.root_executable_ref, []);
  reader.provenance(root.root_measurement_ref, [root.root_executable_ref]);
  protect("p01_replay_denied", "accepted_p01", () =>
    admitScaP02Candidate({ store: reader, request, input_artifacts: scaP02InputArtifacts(request) })
  );
  reader.provenance(
    input.request_ref,
    scaP02InputArtifacts(request).artifacts.map((binding) => binding.ref)
  );
  const transitionValue = protect("transition_replay_denied", "transition_ref", () =>
    validateScaP02P03TransitionV1(reader.json(input.transition_ref, "transition_ref"))
  );
  if (
    !same(transitionValue.p02_request_ref, input.request_ref) ||
    transitionValue.run_id !== request.run_id ||
    input.transition_ref.run_id !== request.run_id ||
    !same(transitionValue.p01_request_ref, accepted.request_ref) ||
    !same(transitionValue.p01_campaign_manifest_core_ref, accepted.campaign_manifest_core_ref) ||
    !same(transitionValue.p01_campaign_manifest_ref, accepted.campaign_manifest_ref) ||
    Date.parse(transitionValue.consumed_as_of) < Date.parse(request.requested_at)
  )
    deny("transition_replay_denied", "transition_cohort");
  // This is explicitly historical source replay at its RECORDED consumption time, not current admission.
  const transition = protect("transition_replay_denied", "transition_ref", () =>
    createScaP03TransitionAdmissionV1({
      store: reader,
      trusted_clock: () => new Date(transitionValue.consumed_as_of),
    }).consume({ transition_ref: input.transition_ref })
  );
  reader.provenance(input.transition_ref, [
    input.request_ref,
    transition.runtime_policy_ref,
    transition.isolation_evidence_ref,
    ...(transition.isolation_host_attestation_ref === null
      ? []
      : [transition.isolation_host_attestation_ref]),
    transition.p02_gate_ref,
    transition.coverage_matrix_ref,
    transition.successor_ledger_ref,
    transition.evidence_manifest_ref,
    transition.m1_ref,
    accepted.request_ref,
    accepted.campaign_manifest_core_ref,
    accepted.campaign_manifest_ref,
  ]);
  const operationalGate = protect("transition_replay_denied", "operational_gate_ref", () =>
    validateScaP02GateV1(reader.json(transition.p02_gate_ref, "operational_gate_ref"))
  );
  if (
    operationalGate.status !== "passed" ||
    operationalGate.isolation_scope !== "live_qualified" ||
    operationalGate.isolation_host_attestation_ref === null
  )
    deny("transition_replay_denied", "live_operational_boundary");
  const manifest = protect("transition_replay_denied", "evidence_manifest_ref", () =>
    validateScaP02EvidenceManifestV1(
      reader.json(transition.evidence_manifest_ref, "evidence_manifest_ref")
    )
  );
  const operationalRefs = [
    input.request_ref,
    input.transition_ref,
    transition.p02_gate_ref,
    transition.m1_ref,
    transition.coverage_matrix_ref,
    transition.evidence_manifest_ref,
    transition.successor_ledger_ref,
    request.runtime_policy_ref,
    request.isolation_evidence_ref,
    ...(request.isolation_host_attestation_ref === null
      ? []
      : [request.isolation_host_attestation_ref]),
    ...manifest.operations.flatMap((op) => [
      op.operation_request_ref,
      op.operation_result_ref,
      op.normalized_evidence_ref,
      op.operation_receipt_ref,
    ]),
  ];
  for (const ref of operationalRefs) reader.exact(ref);
  const history = historical(reader, {
    ...input,
    schema_id: "penny.sca-p03-historical-p02-inputs.v1",
    accepted_p02_refs: operationalRefs,
  });
  if (Date.parse(history.gate.evaluated_at) < Date.parse(transition.consumed_as_of))
    deny("historical_binding_denied", "transition_qualification_time");
  reader.finish();
  return {
    request,
    transition,
    accepted_p01: accepted,
    root,
    original_root_bytes: Buffer.from(rootEntry.bytes),
    recorded_root_closure: recorded,
    historical_p02: history,
    historical_transition_replay_as_of: transition.consumed_as_of,
    closure: reader.census(),
    bootstrap_operands: {
      provenance: "derived_caller_operands_not_a_new_artifact",
      accepted_p01: accepted,
      accepted_p02: {
        transition_ref: input.transition_ref,
        p02_request_ref: input.request_ref,
        gate_ref: transition.p02_gate_ref,
        m1_ref: transition.m1_ref,
        coverage_matrix_ref: transition.coverage_matrix_ref,
        evidence_manifest_ref: transition.evidence_manifest_ref,
        successor_ledger_ref: transition.successor_ledger_ref,
        evidence_refs: [
          request.runtime_policy_ref,
          request.isolation_evidence_ref,
          ...(request.isolation_host_attestation_ref === null
            ? []
            : [request.isolation_host_attestation_ref]),
          ...manifest.operations.flatMap((op) => [
            op.operation_request_ref,
            op.operation_result_ref,
            op.normalized_evidence_ref,
            op.operation_receipt_ref,
          ]),
        ],
        qualification_definition_ref: input.definition_ref,
        qualification_gate_ref: input.gate_ref,
      },
      source_snapshot_ref: root.core.frozen_refs.source_snapshot_ref,
      source_snapshot_sha256: root.core.frozen_refs.source_snapshot_ref.content_digest,
      root_tool_id: root.root_tool_id,
      toolchain_ref: root.toolchain_ref,
      root_executable_ref: root.root_executable_ref,
      root_measurement_ref: root.root_measurement_ref,
      create_store: false,
      missing_input: [
        "private_deployment_capsule",
        "protected_executable_and_dependency_mappings",
        "working_and_staging_paths",
        "reviewed_fixture_oracle_profile_and_query_operands",
        "original_bootstrap_handoffs_and_current_selection",
        "authenticated_initial_p03_approval",
        "reviewed_live_resource_policy",
        "eligible_p02_renewal_and_activation",
      ],
    },
    readiness: "historical_closure_replayed_only",
    p02_renewal: "not_performed",
    p03_activation: "not_authorized",
    p04: "separately_gated_not_authorized",
  };
}

/** No writes, grants, issuer callbacks, host samples, Docker, or current-time admission. */
export function loadScaP03PredecessorInputsV1(
  value: unknown,
  approvedRefs?: readonly ArtifactRef[]
): ScaP03PredecessorResultV1<ScaP03PredecessorReplayV1> {
  return result(() => {
    requireFields(value, [...COMMON_REQUIRED, "request_ref", "transition_ref"]);
    const input = protect("invalid_input", "predecessor_inputs", () =>
      validateContract(ScaP03PredecessorInputsV1Schema, value, "P03 predecessor inputs")
    );
    if (approvedRefs !== undefined) {
      const limits = deriveScaP03InitialCustodyV1(approvedRefs);
      if (!same(limits, input.limits)) deny("budget_exceeded", "approved_limits");
      const known = new Map(approvedRefs.map((ref) => [ref.artifact_id, canonicalJson(ref)]));
      for (const name of [
        "request_ref",
        "transition_ref",
        "definition_ref",
        "gate_ref",
        "qualification_ref",
        "historical_authority_ref",
        "historical_issuance_ref",
      ] as const) {
        currentArtifactRef(input[name]);
        if (known.get(input[name].artifact_id) !== canonicalJson(input[name]))
          deny("ref_mismatch", "unapproved_direct_ref");
      }
    }
    return open(input, (reader) => full(reader, input), approvedRefs);
  });
}

export const ScaP03PredecessorCurrentBindingInputsV1Schema = Type.Object(
  {
    predecessor_inputs: ScaP03PredecessorInputsV1Schema,
    project_root: Type.String({ minLength: 1, maxLength: 4096 }),
    operational_summary_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export interface ScaP03PredecessorCurrentBindingReplayV1 {
  readonly historical: ScaP03PredecessorReplayV1;
  readonly measured: ScaP02CurrentHostBindingV1;
  readonly current_host_binding_replay: "matches" | "drifted";
  readonly usable_authority: "unknown";
  readonly activation_allowed: false;
}
/** Explicit fresh read-only source measurement using the actual P02 owner; never an arbitrary authority callback. */
export function measureScaP03PredecessorCurrentHostBindingV1(
  value: unknown
): ScaP03PredecessorResultV1<ScaP03PredecessorCurrentBindingReplayV1> {
  return result(() => {
    requireFields(value, ["predecessor_inputs", "project_root", "operational_summary_ref"]);
    const input = protect("invalid_input", "current_binding_inputs", () =>
      validateContract(
        ScaP03PredecessorCurrentBindingInputsV1Schema,
        value,
        "current P02 binding inputs"
      )
    );
    return open(input.predecessor_inputs, (reader, store) => {
      const replay = full(reader, input.predecessor_inputs);
      if (
        !replay.historical_p02.definition.qualified_inputs.some((binding) =>
          same(binding.ref, input.operational_summary_ref)
        )
      )
        deny("current_binding_denied", "operational_summary_ref");
      reader.exact(input.operational_summary_ref);
      const measured = protect("current_binding_denied", "current_host_binding", () =>
        measureScaP02CurrentHostBinding({
          project_root: input.project_root,
          store,
          operational_summary_ref: input.operational_summary_ref,
        })
      );
      const snapshot = replay.historical_p02.definition;
      return {
        historical: replay,
        measured,
        current_host_binding_replay:
          measured.source_manifest_sha256 === snapshot.current_source_manifest_sha256 &&
          measured.host_binding_sha256 === snapshot.current_host_binding_sha256
            ? "matches"
            : "drifted",
        usable_authority: "unknown",
        activation_allowed: false,
      };
    });
  });
}
