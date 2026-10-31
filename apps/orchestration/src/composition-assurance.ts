/** Project-local, exact-coordinate prospective admission. This module does not start a run. */
import path from "node:path";
import { Type, type Static } from "typebox";
import { OwnerSqliteDatabase } from "./state/owner-sqlite.js";
import {
  ArtifactStore,
  currentArtifactRef,
  previewArtifactRef,
  type ArtifactReader,
} from "./artifact-store.js";
import type { RunContext } from "./context.js";
import { Checkpointer, canonicalJson, sha256 } from "./checkpointer.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type JsonValue,
  type CompletionAdmissionEnvelope,
  type StateVisitRef,
  validateContract,
} from "./contracts.js";
import { validateCanonicalSpecificationBytes } from "./skill-contracts/define.js";
import {
  DEFINE_PLAYBOOK_REGISTRATION,
  evaluateDefineLatestReviewedSpecificationDod,
} from "./playbooks/define.js";

const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Id = Type.String({ minLength: 1 });
const ProducerSchema = Type.Object(
  {
    run_id: Id,
    registration_name: Type.Literal("define"),
    contract_sha256: Hash,
    registration_sha256: Hash,
    terminal_sha256: Hash,
    completion_admission_sha256: Hash,
  },
  { additionalProperties: false }
);
const RoleSchema = Type.Union([
  Type.Literal("input_specification"),
  Type.Literal("producer_request"),
  Type.Literal("framing_output"),
  Type.Literal("frame"),
  Type.Literal("source_manifest"),
  Type.Literal("evidence_admission"),
  Type.Literal("native_evidence"),
  Type.Literal("imported_semantic_input"),
  Type.Literal("clarification_challenge"),
  Type.Literal("clarification_response"),
  Type.Literal("draft"),
  Type.Literal("trace"),
  Type.Literal("validity_report"),
  Type.Literal("quality_report"),
  Type.Literal("validity_receipt"),
  Type.Literal("quality_receipt"),
  Type.Literal("integrity"),
  Type.Literal("product_envelope"),
  Type.Literal("producer_input_assurance"),
  Type.Literal("immediate_prior_product"),
]);
type Role = Static<typeof RoleSchema>;
const CheckedSchema = Type.Object(
  { ref: ArtifactRefSchema, roles: Type.Array(RoleSchema, { minItems: 1 }) },
  { additionalProperties: false }
);
const OwnerEvidenceSchema = Type.Object(
  {
    run_id: Id,
    record_class: Type.Union([
      Type.Literal("terminal"),
      Type.Literal("completion_admission"),
      Type.Literal("state_visit"),
      Type.Literal("execution_receipt"),
    ]),
    coordinate: Type.String({ minLength: 1 }),
    sha256: Hash,
  },
  { additionalProperties: false }
);
const Common = {
  schema_id: Type.Literal("penny.composition-assurance.v1"),
  schema_version: Type.Literal(1),
  consumer: Type.Object(
    { run_id: Id, registration_name: Id, contract_sha256: Hash, registration_sha256: Hash },
    { additionalProperties: false }
  ),
  invocation_sha256: Hash,
  request_ref: ArtifactRefSchema,
  checked_artifacts: Type.Array(CheckedSchema, { maxItems: 256 }),
  checked_artifact_count: Type.Integer({ minimum: 0, maximum: 256 }),
  checked_artifact_bytes: Type.Integer({ minimum: 0, maximum: 64 * 1024 * 1024 }),
  binding_sha256: Hash,
};
const NoSpecificationSchema = Type.Object(
  {
    ...Common,
    mode: Type.Literal("not_applicable"),
    specification_ref: Type.Null(),
    producer: Type.Null(),
    immediate_parent: Type.Null(),
    checked_artifacts: Type.Tuple([]),
    checked_artifact_count: Type.Literal(0),
    checked_artifact_bytes: Type.Literal(0),
    scope: Type.Tuple([Type.Literal("no_specification_input")]),
  },
  { additionalProperties: false }
);
const SemanticSchema = Type.Object(
  {
    ...Common,
    mode: Type.Literal("semantic_only"),
    specification_ref: ArtifactRefSchema,
    producer: Type.Null(),
    immediate_parent: Type.Null(),
    scope: Type.Tuple([Type.Literal("canonical_semantics")]),
  },
  { additionalProperties: false }
);
const ReviewedSchema = Type.Object(
  {
    ...Common,
    mode: Type.Literal("reviewed_definition"),
    specification_ref: ArtifactRefSchema,
    producer: ProducerSchema,
    immediate_parent: Type.Union([
      Type.Object(
        { status: Type.Literal("not_revision"), ref: Type.Null() },
        { additionalProperties: false }
      ),
      Type.Object(
        { status: Type.Literal("verified"), ref: ArtifactRefSchema },
        { additionalProperties: false }
      ),
    ]),
    owner_evidence: Type.Array(OwnerEvidenceSchema, { minItems: 1, maxItems: 128 }),
    scope: Type.Tuple([
      Type.Literal("canonical_semantics"),
      Type.Literal("completed_define_trace_contract"),
      Type.Literal("stored_support_readable"),
      Type.Literal("immediate_revision_closure"),
    ]),
  },
  { additionalProperties: false }
);
export const CompositionAssuranceV1Schema = Type.Union([
  NoSpecificationSchema,
  SemanticSchema,
  ReviewedSchema,
]);
export type CompositionAssuranceV1 = Static<typeof CompositionAssuranceV1Schema>;
export function validateCompositionAssurance(value: unknown): CompositionAssuranceV1 {
  const record = validateContract(CompositionAssuranceV1Schema, value, "composition assurance");
  if (Buffer.byteLength(canonicalJson(record)) > ASSURANCE_LIMITS.assuranceBytes)
    throw new Error("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED: assurance record");
  const { binding_sha256: digest, ...body } = record;
  if (
    digest !== sha256(canonicalJson(body)) ||
    record.checked_artifact_count !== record.checked_artifacts.length ||
    record.checked_artifact_bytes !==
      record.checked_artifacts.reduce((sum, item) => sum + item.ref.byte_length, 0) ||
    record.checked_artifacts.some(
      (item, index) =>
        record.checked_artifacts.findIndex(
          (other) => other.ref.artifact_id === item.ref.artifact_id
        ) !== index || canonicalJson([...item.roles].sort()) !== canonicalJson(item.roles)
    )
  ) {
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: assurance digest or checked refs");
  }
  const requiredReviewedRoles: readonly Role[] = [
    "input_specification",
    "producer_request",
    "frame",
    "source_manifest",
    "evidence_admission",
    "draft",
    "trace",
    "validity_report",
    "quality_report",
    "validity_receipt",
    "quality_receipt",
    "integrity",
    "product_envelope",
  ];
  if (
    record.mode === "reviewed_definition" &&
    (record.producer.run_id !== record.specification_ref.run_id ||
      !["terminal", "completion_admission", "state_visit", "execution_receipt"].every((kind) =>
        record.owner_evidence.some(
          (evidence) => evidence.record_class === kind && evidence.run_id === record.producer.run_id
        )
      ) ||
      !requiredReviewedRoles.every((required) =>
        record.checked_artifacts.some((item) => item.roles.includes(required))
      ))
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: missing reviewed graph roles");
  if (
    record.mode === "semantic_only" &&
    (record.checked_artifacts.length !== 1 ||
      canonicalJson(record.checked_artifacts[0]?.ref) !== canonicalJson(record.specification_ref) ||
      canonicalJson(record.checked_artifacts[0]?.roles) !== canonicalJson(["input_specification"]))
  ) {
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: semantic-only scope");
  }
  return record;
}

export const ASSURANCE_LIMITS = Object.freeze({
  artifacts: 256,
  artifactBytes: 64 * 1024 * 1024,
  records: 128,
  recordBytes: 16 * 1024 * 1024,
  assuranceBytes: 1024 * 1024,
});
const RefusalCodeSchema = Type.Union([
  Type.Literal("SPECIFICATION_ASSURANCE_UNAVAILABLE"),
  Type.Literal("SPECIFICATION_ASSURANCE_UNSUPPORTED"),
  Type.Literal("SPECIFICATION_ASSURANCE_NOT_COMPLETE"),
  Type.Literal("SPECIFICATION_ASSURANCE_BINDING_INVALID"),
  Type.Literal("SPECIFICATION_ASSURANCE_CUSTODY_INVALID"),
  Type.Literal("SPECIFICATION_REVISION_CLOSURE_INVALID"),
  Type.Literal("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED"),
  Type.Literal("SPECIFICATION_ASSURANCE_CANCELLED"),
]);
export type AssuranceRefusalCode = Static<typeof RefusalCodeSchema>;
export const CompositionAssuranceRefusalSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    status: Type.Literal("refused"),
    code: RefusalCodeSchema,
    input_artifact_id: Type.Union([Id, Type.Null()]),
    requested_mode: Type.Union([
      Type.Literal("reviewed_definition"),
      Type.Literal("semantic_only"),
      Type.Literal("not_applicable"),
    ]),
    consumer_registration_sha256: Hash,
    findings: Type.Array(
      Type.Object(
        { code: RefusalCodeSchema, path: Id, detail: Type.String({ maxLength: 512 }) },
        { additionalProperties: false }
      ),
      { maxItems: 32 }
    ),
  },
  { additionalProperties: false }
);
export type CompositionAssuranceRefusal = Static<typeof CompositionAssuranceRefusalSchema>;
export type AssuranceMode = CompositionAssuranceV1["mode"];
export interface CompositionAdmissionInput {
  readonly artifacts: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly project_id: string;
  readonly project_root: string;
  readonly consumer: CompositionAssuranceV1["consumer"];
  /** Host-selected exact active Define registration accepted as a reviewed producer. */
  readonly supported_define_registration_sha256: string | null;
  readonly invocation: JsonValue;
  /** Canonical semantic request bytes, independently validated by the caller's native request port. */
  readonly request_bytes: string;
  readonly request_schema: { readonly schema_id: string; readonly schema_version: number };
  readonly specification_ref: ArtifactRef | null;
  readonly mode: AssuranceMode;
  readonly signal?: AbortSignal;
}
export type CompositionAdmissionResult =
  | { readonly status: "prepared"; readonly assurance: CompositionAssuranceV1 }
  | CompositionAssuranceRefusal;

/** Admission refusals are typed, and cannot become a downgraded invocation. */
export class CompositionAssuranceCapabilityUnavailableError extends Error {
  readonly code = "SPECIFICATION_ASSURANCE_UNAVAILABLE" as const;
  constructor() {
    super("SPECIFICATION_ASSURANCE_UNAVAILABLE: project-bound verifier is required");
    this.name = "CompositionAssuranceCapabilityUnavailableError";
  }
}

export class CompositionAssuranceAdmissionError extends Error {
  constructor(readonly refusal: CompositionAssuranceRefusal) {
    super(refusal.code);
    this.name = "CompositionAssuranceAdmissionError";
  }
}

export function selectedCompositionAssurance(
  context: RunContext,
  reader: ArtifactReader
): { readonly ref: ArtifactRef; readonly value: CompositionAssuranceV1 } {
  const candidates = context.selectedArtifacts.filter(
    (ref) => ref.kind === "composition-assurance"
  );
  if (candidates.length !== 1)
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: selection");
  const ref = candidates[0];
  if (
    ref === undefined ||
    ref.run_id !== context.identity.run_id ||
    ref.phase !== "admission" ||
    ref.version !== 1 ||
    ref.operation_id !== `composition-assurance:${context.identity.run_id}` ||
    ref.content_schema?.schema_id !== "penny.composition-assurance.v1" ||
    ref.content_schema.schema_version !== 1 ||
    canonicalJson(reader.refById(ref.artifact_id)) !== canonicalJson(ref)
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: ref");
  const bytes = reader.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
  }
  const value = validateCompositionAssurance(parsed);
  if (
    canonicalJson(value) !== bytes.toString("utf8") ||
    value.consumer.run_id !== context.identity.run_id ||
    value.consumer.registration_name !== context.identity.playbook ||
    value.consumer.contract_sha256 !== context.registrationContractBinding?.contract_sha256 ||
    value.consumer.registration_sha256 !==
      context.registrationContractBinding.registration_sha256 ||
    value.request_ref.run_id !== context.identity.run_id ||
    value.request_ref.phase !== "admission" ||
    value.request_ref.kind !== "composition-request" ||
    value.request_ref.version !== 1 ||
    value.request_ref.operation_id !== `composition-request:${context.identity.run_id}` ||
    value.request_ref.producer !== "host:composition-assurance" ||
    value.request_ref.content_schema?.schema_id !==
      (context.identity.playbook === "define"
        ? "penny.definition-request.v1"
        : "penny.plan-request.v1") ||
    value.request_ref.content_schema.schema_version !== 1 ||
    canonicalJson(reader.refById(value.request_ref.artifact_id)) !==
      canonicalJson(value.request_ref) ||
    reader.readById(value.request_ref.artifact_id).byteLength !== value.request_ref.byte_length ||
    sha256(reader.readById(value.request_ref.artifact_id)) !== value.request_ref.content_digest ||
    (value.specification_ref !== null &&
      !context.selectedArtifacts.some(
        (selected) => canonicalJson(selected) === canonicalJson(value.specification_ref)
      )) ||
    (value.specification_ref === null && value.mode !== "not_applicable")
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: policy or request");
  return { ref, value };
}

export function assertExistingStartAssurance(input: CompositionAdmissionInput): ArtifactRef {
  input.checkpointer.assertBoundProject(input.project_id);
  input.artifacts.assertBoundProject(input.project_id);
  const context = input.checkpointer.loadRunById(input.consumer.run_id);
  if (context === undefined)
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: missing run");
  const { ref, value } = selectedCompositionAssurance(context, input.artifacts);
  if (
    canonicalJson(value.consumer) !== canonicalJson(input.consumer) ||
    value.invocation_sha256 !== sha256(canonicalJson(input.invocation)) ||
    input.artifacts.readById(value.request_ref.artifact_id).toString("utf8") !==
      input.request_bytes ||
    value.mode !== input.mode ||
    canonicalJson(value.specification_ref) !== canonicalJson(input.specification_ref)
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: retry operands");
  for (const checked of value.checked_artifacts) {
    if (
      canonicalJson(input.artifacts.refById(checked.ref.artifact_id)) !== canonicalJson(checked.ref)
    )
      throw new Error("SPECIFICATION_ASSURANCE_CUSTODY_INVALID: retry checked ref");
    input.artifacts.read(checked.ref);
  }
  return ref;
}

export function assertSelectedSpecificationAssurance(input: {
  readonly context: RunContext;
  readonly reader: ArtifactReader;
  readonly checkpointer: Checkpointer;
  readonly native_request_ref: ArtifactRef;
  readonly imported_input_refs: readonly ArtifactRef[];
}): ArtifactRef {
  const { ref, value } = selectedCompositionAssurance(input.context, input.reader);
  const native = input.reader.readById(input.native_request_ref.artifact_id);
  if (
    canonicalJson(input.reader.refById(input.native_request_ref.artifact_id)) !==
      canonicalJson(input.native_request_ref) ||
    native.byteLength !== input.native_request_ref.byte_length ||
    sha256(native) !== input.native_request_ref.content_digest ||
    canonicalJson(JSON.parse(native.toString("utf8"))) !== native.toString("utf8") ||
    input.reader.readById(value.request_ref.artifact_id).toString("utf8") !==
      native.toString("utf8")
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: native request");
  const specificationRefs = input.imported_input_refs.filter(
    (item) => item.content_schema?.schema_id === "penny.specification.v1"
  );
  if (
    specificationRefs.length > 1 ||
    (specificationRefs.length === 0
      ? value.mode !== "not_applicable" || value.specification_ref !== null
      : value.mode === "not_applicable" ||
        canonicalJson(value.specification_ref) !== canonicalJson(specificationRefs[0]))
  )
    throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: specification or mode");
  for (const checked of value.checked_artifacts) {
    if (
      canonicalJson(input.reader.refById(checked.ref.artifact_id)) !== canonicalJson(checked.ref) ||
      sha256(input.reader.readById(checked.ref.artifact_id)) !== checked.ref.content_digest
    )
      throw new Error("SPECIFICATION_ASSURANCE_CUSTODY_INVALID: checked artifact");
  }
  if (value.mode === "reviewed_definition") {
    assertOwnerReadBudget(input.checkpointer, value.producer.run_id);
    const producerContext = input.checkpointer.loadRunById(value.producer.run_id);
    const producerBinding = producerContext?.registrationContractBinding;
    const terminal = producerContext?.terminalDirective;
    const admission = input.checkpointer.completionAdmission(value.producer.run_id);
    if (
      producerContext === undefined ||
      producerBinding?.registration_name !== value.producer.registration_name ||
      producerBinding.contract_sha256 !== value.producer.contract_sha256 ||
      producerBinding.registration_sha256 !== value.producer.registration_sha256 ||
      terminal?.action !== "complete" ||
      terminal.status !== "complete" ||
      !terminal.met ||
      sha256(canonicalJson(terminal)) !== value.producer.terminal_sha256 ||
      terminal.result.output_artifact_ref === undefined ||
      canonicalJson(terminal.result.output_artifact_ref) !==
        canonicalJson(value.specification_ref) ||
      admission === undefined ||
      sha256(canonicalJson(admission)) !== value.producer.completion_admission_sha256
    ) {
      throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: producer owner proof");
    }
    const visits = input.checkpointer.stateVisits(value.producer.run_id);
    assertOwnerProofBudget(visits.length, admission.evidence_refs.length);
    const admissionEvents = input.checkpointer
      .events(value.producer.run_id)
      .filter(
        (event) => canonicalJson(event.payload.completion_admission_v1) === canonicalJson(admission)
      );
    if (
      admissionEvents.length !== 1 ||
      canonicalJson(admission.state_visit_refs) !== canonicalJson(visits) ||
      canonicalJson(value.owner_evidence) !==
        canonicalJson(
          exactOwnerProof({
            checkpointer: input.checkpointer,
            runId: value.producer.run_id,
            terminalSha256: value.producer.terminal_sha256,
            admission,
            admissionSequence: String(admissionEvents[0]?.sequence),
            visits,
          })
        )
    ) {
      throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: continuing owner proof");
    }
  }
  return ref;
}

export function requirePreparedAssurance(input: CompositionAdmissionInput): CompositionAssuranceV1 {
  const result = prepareCompositionAssurance(input);
  if (result.status === "refused") throw new CompositionAssuranceAdmissionError(result);
  return result.assurance;
}

export function requireMaterializedAssurance(
  input: CompositionAdmissionInput,
  prepared: CompositionAssuranceV1
): ArtifactRef {
  const result = materializeCompositionAssurance(input, prepared);
  if (result.status === "refused") throw new CompositionAssuranceAdmissionError(result);
  return result.assurance_ref;
}

class Refused extends Error {
  constructor(readonly code: AssuranceRefusalCode) {
    super(code);
  }
}
function fail(code: AssuranceRefusalCode): never {
  throw new Refused(code);
}
function cancel(input: CompositionAdmissionInput): void {
  if (input.signal?.aborted) fail("SPECIFICATION_ASSURANCE_CANCELLED");
}
/**
 * Bound the complete exact-run read before the owner decodes any JSON. Physical event rows
 * are not proof records: ordinary streaming progress can create thousands of them without
 * adding a single visit, review or receipt. Retain the raw byte ceiling (including telemetry)
 * and charge the compact terminal/admission/visit/receipt proof separately below.
 *
 * The checkpointer owns decoding and evidence verification. This create-never, owner-pinned
 * read transaction only measures storage; it neither rewrites old runs nor admits evidence.
 */
function assertOwnerReadBudget(checkpointer: Checkpointer, runId: string): void {
  using database = new OwnerSqliteDatabase({
    directory: path.dirname(checkpointer.dbPath),
    databaseName: path.basename(checkpointer.dbPath),
    label: "composition assurance owner",
    mode: "existing",
    readOnly: true,
    verifyIntegrity: false,
  });
  const size = database.db
    .prepare(
      `SELECT
      (SELECT COALESCE(SUM(length(CAST(context_json AS BLOB))), 0) FROM runs WHERE run_id = ?) +
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM events WHERE run_id = ?) +
      (SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) FROM receipts WHERE run_id = ?) AS bytes`
    )
    .get(runId, runId, runId);
  if (size === undefined || typeof size.bytes !== "number" || !Number.isSafeInteger(size.bytes))
    fail("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
  if (size.bytes > ASSURANCE_LIMITS.recordBytes) fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
}
function assertOwnerProofBudget(visits: number, receipts: number): void {
  // Exactly the terminal, completion admission, complete visit inventory and required receipts.
  if (2 + visits + receipts > ASSURANCE_LIMITS.records)
    fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
}
function exactOwnerProof(input: {
  readonly checkpointer: Checkpointer;
  readonly runId: string;
  readonly terminalSha256: string;
  readonly admission: CompletionAdmissionEnvelope;
  readonly admissionSequence: string;
  readonly visits: readonly StateVisitRef[];
}): Static<typeof OwnerEvidenceSchema>[] {
  assertOwnerProofBudget(input.visits.length, input.admission.evidence_refs.length);
  const receipts = input.admission.evidence_refs.map((receipt) => {
    if (
      receipt.kind !== "execution_receipt" ||
      receipt.sha256 === undefined ||
      !input.checkpointer.completionEvidenceRefExists(receipt, input.runId)
    )
      fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
    return {
      run_id: input.runId,
      record_class: "execution_receipt" as const,
      coordinate: receipt.reference_id,
      sha256: receipt.sha256,
    };
  });
  return [
    {
      run_id: input.runId,
      record_class: "terminal",
      coordinate: input.runId,
      sha256: input.terminalSha256,
    },
    {
      run_id: input.runId,
      record_class: "completion_admission",
      coordinate: input.admissionSequence,
      sha256: sha256(canonicalJson(input.admission)),
    },
    ...input.visits.map((visit) => ({
      run_id: input.runId,
      record_class: "state_visit" as const,
      coordinate: `${visit.event_sequence}:${visit.offset}`,
      sha256: sha256(canonicalJson(visit)),
    })),
    ...receipts,
  ];
}
function role(ref: ArtifactRef): Role | undefined {
  if (ref.kind === "agent-output") {
    if (ref.phase === "framing_definition") return "framing_output";
    if (ref.phase === "gathering_definition_evidence") return "native_evidence";
    if (ref.phase === "verifying_specification") return "validity_report";
    if (ref.phase === "critiquing_specification") return "quality_report";
  }
  if (ref.kind === "specification") return "input_specification";
  if (ref.kind === "definition-request") return "producer_request";
  if (ref.kind === "definition-source-manifest") return "source_manifest";
  if (ref.kind === "definition-frame") return "frame";
  if (ref.kind === "definition-trace") return "trace";
  if (ref.kind === "evidence-admission") return "evidence_admission";
  if (ref.kind === "specification-draft") return "draft";
  if (ref.kind === "review-receipt")
    return ref.branch_id === "quality" ? "quality_receipt" : "validity_receipt";
  if (ref.kind === "specification-product-integrity") return "integrity";
  if (ref.kind === "specification-product-envelope") return "product_envelope";
  if (ref.kind === "definition-clarification-challenge") return "clarification_challenge";
  if (ref.kind === "definition-clarification-response") return "clarification_response";
  // Match the producer's closed native import surface, not arbitrary cross-run artifacts.
  if (
    DEFINE_PLAYBOOK_REGISTRATION.contract.io.input_ports.some(
      (port) =>
        port.transport === "artifact" &&
        port.semantic_product &&
        port.artifact_kind === ref.kind &&
        port.schema_id === ref.content_schema?.schema_id &&
        port.schema_version_required === ref.content_schema?.schema_version
    )
  )
    return "imported_semantic_input";
  if (ref.kind === "composition-assurance") return "producer_input_assurance";
  return undefined;
}

type AssuranceBody =
  | Omit<Static<typeof NoSpecificationSchema>, "binding_sha256">
  | Omit<Static<typeof SemanticSchema>, "binding_sha256">
  | Omit<Static<typeof ReviewedSchema>, "binding_sha256">;
function verify(input: CompositionAdmissionInput): AssuranceBody {
  cancel(input);
  input.checkpointer.assertBoundProject(input.project_id);
  input.artifacts.assertBoundProject(input.project_id);
  if (input.checkpointer.runExists(input.consumer.run_id))
    fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  if (
    (input.mode === "not_applicable" && input.specification_ref !== null) ||
    (input.mode !== "not_applicable" && input.specification_ref === null)
  )
    fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  const request_ref = previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id: input.consumer.run_id,
      phase: "admission",
      branch_id: null,
      kind: "composition-request",
      operation_id: `composition-request:${input.consumer.run_id}`,
      version: 1,
      producer: "host:composition-assurance",
      media_type: "application/json",
      content_schema: input.request_schema,
      parent_ref: null,
      upstream_refs: [],
    },
    content: input.request_bytes,
  });
  if (Buffer.byteLength(input.request_bytes) > ASSURANCE_LIMITS.assuranceBytes)
    fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
  if (
    Buffer.byteLength(canonicalJson(input.invocation)) > ASSURANCE_LIMITS.assuranceBytes ||
    canonicalJson(JSON.parse(input.request_bytes)) !== input.request_bytes
  )
    fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
  const common = {
    schema_id: "penny.composition-assurance.v1" as const,
    schema_version: 1 as const,
    consumer: input.consumer,
    invocation_sha256: sha256(canonicalJson(input.invocation)),
    request_ref,
  };
  if (input.specification_ref === null)
    return {
      ...common,
      mode: "not_applicable",
      specification_ref: null,
      checked_artifacts: [],
      checked_artifact_count: 0,
      checked_artifact_bytes: 0,
      producer: null,
      immediate_parent: null,
      scope: ["no_specification_input"],
    };
  const refs = new Map<string, { ref: ArtifactRef; roles: Set<Role> }>();
  let bytes = 0;
  const check = (ref: ArtifactRef, assigned: Role): void => {
    cancel(input);
    const canonical = currentArtifactRef(ref);
    const stored = input.artifacts.refById(canonical.artifact_id);
    if (stored === undefined) fail("SPECIFICATION_ASSURANCE_UNAVAILABLE");
    if (canonicalJson(stored) !== canonicalJson(canonical))
      fail("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
    if (!refs.has(ref.artifact_id)) {
      if (
        refs.size >= ASSURANCE_LIMITS.artifacts ||
        bytes + ref.byte_length > ASSURANCE_LIMITS.artifactBytes
      )
        fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
      bytes += ref.byte_length;
      refs.set(ref.artifact_id, { ref, roles: new Set() });
    }
    refs.get(ref.artifact_id)?.roles.add(assigned);
    const metadata = input.artifacts.metadata(ref);
    if (
      metadata.run_id !== ref.run_id ||
      metadata.kind !== ref.kind ||
      metadata.phase !== ref.phase ||
      metadata.operation_id !== ref.operation_id ||
      metadata.version !== ref.version ||
      metadata.producer !== ref.producer ||
      metadata.media_type !== ref.media_type ||
      canonicalJson(metadata.content_schema ?? null) !== canonicalJson(ref.content_schema ?? null)
    )
      fail("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
  };
  check(input.specification_ref, "input_specification");
  const product = validateCanonicalSpecificationBytes(
    input.artifacts.read(input.specification_ref),
    input.specification_ref
  );
  if (input.mode === "semantic_only")
    return {
      ...common,
      mode: "semantic_only",
      specification_ref: input.specification_ref,
      checked_artifacts: [{ ref: input.specification_ref, roles: ["input_specification"] }],
      checked_artifact_count: 1,
      checked_artifact_bytes: bytes,
      producer: null,
      immediate_parent: null,
      scope: ["canonical_semantics"],
    };
  const productMetadata = input.artifacts.metadata(input.specification_ref);
  const runId = productMetadata.run_id;
  if (runId !== input.specification_ref.run_id) fail("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
  // Precharge all raw bytes, not an unrelated count of streaming telemetry rows.
  assertOwnerReadBudget(input.checkpointer, runId);
  const context = input.checkpointer.loadRunById(runId);
  if (context === undefined) fail("SPECIFICATION_ASSURANCE_UNAVAILABLE");
  const binding = context.registrationContractBinding;
  const registration = DEFINE_PLAYBOOK_REGISTRATION;
  if (
    binding?.registration_name !== "define" ||
    binding.contract_sha256 !== sha256(canonicalJson(registration.contract)) ||
    input.supported_define_registration_sha256 === null ||
    binding.registration_sha256 !== input.supported_define_registration_sha256 ||
    context.identity.playbook !== "define"
  )
    fail("SPECIFICATION_ASSURANCE_UNSUPPORTED");
  const terminal = context.terminalDirective;
  if (
    terminal?.action !== "complete" ||
    terminal.status !== "complete" ||
    !terminal.met ||
    terminal.result.output_artifact_ref === undefined ||
    canonicalJson(terminal.result.output_artifact_ref) !== canonicalJson(input.specification_ref)
  )
    fail("SPECIFICATION_ASSURANCE_NOT_COMPLETE");
  if (
    !context.selectedArtifacts.some(
      (ref) =>
        ref.artifact_id === input.specification_ref?.artifact_id &&
        canonicalJson(ref) === canonicalJson(input.specification_ref)
    )
  )
    fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  const admission = input.checkpointer.completionAdmission(runId);
  if (admission === undefined) fail("SPECIFICATION_ASSURANCE_NOT_COMPLETE");
  const { terminal_envelope_id: id, ...admissionBody } = admission;
  const visits = input.checkpointer.stateVisits(runId);
  assertOwnerProofBudget(visits.length, admission.evidence_refs.length);
  if (
    id !== `tenv_${sha256(canonicalJson(admissionBody))}` ||
    admission.run_id !== runId ||
    admission.terminal_digest !== sha256(canonicalJson(terminal)) ||
    admission.gate_digest !== sha256(canonicalJson(registration.contract.completion_gate)) ||
    admission.latest_product.product_id !== input.specification_ref.artifact_id ||
    admission.latest_product.sha256 !== input.specification_ref.content_digest ||
    canonicalJson(admission.state_visit_refs) !== canonicalJson(visits) ||
    admission.origin_state !== "admitting_specification" ||
    admission.evidence_refs.some(
      (ref) => !input.checkpointer.completionEvidenceRefExists(ref, runId)
    )
  )
    fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  const trace = terminal.artifacts.find(
    (ref) =>
      ref.kind === "definition-trace" &&
      ref.content_schema?.schema_id === "penny.definition-trace.v1"
  );
  if (trace === undefined) fail("SPECIFICATION_ASSURANCE_UNSUPPORTED");
  for (const ref of terminal.artifacts) {
    if (ref.run_id !== runId && !product.request.input_artifact_ids.includes(ref.artifact_id))
      fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
    // Unknown required roles are not silently dropped when a producing contract changes.
    const assigned = role(ref);
    if (assigned === undefined) fail("SPECIFICATION_ASSURANCE_UNSUPPORTED");
    try {
      check(
        ref,
        ref.artifact_id === input.specification_ref.artifact_id
          ? "input_specification"
          : ref.artifact_id === product.source_lineage.prior_specification_artifact_id
            ? "immediate_prior_product"
            : ref.run_id !== runId
              ? "imported_semantic_input"
              : assigned
      );
    } catch (error) {
      if (
        ref.artifact_id === product.source_lineage.prior_specification_artifact_id &&
        !(error instanceof Refused && error.code === "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED")
      )
        fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
      throw error;
    }
  }
  // Trace metadata names immediate support challenges even when the positive terminal
  // selects only their responses. Include those exact refs, never a discoverable scan.
  for (const ref of input.artifacts.metadata(trace).upstream_refs) {
    if (refs.has(ref.artifact_id)) continue;
    const assigned = role(ref);
    if (assigned === undefined) fail("SPECIFICATION_ASSURANCE_UNSUPPORTED");
    check(ref, assigned);
  }
  const parentId = product.source_lineage.prior_specification_artifact_id;
  let immediate_parent: Static<typeof ReviewedSchema>["immediate_parent"] = {
    status: "not_revision",
    ref: null,
  };
  if (product.request.mode === "revise") {
    if (parentId === null) fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
    const parent = input.artifacts.refById(parentId);
    if (
      parent === undefined ||
      canonicalJson(productMetadata.domain_revision_parent_ref ?? null) !== canonicalJson(parent)
    )
      fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
    check(parent, "immediate_prior_product");
    try {
      const prior = validateCanonicalSpecificationBytes(input.artifacts.read(parent), parent);
      validateCanonicalSpecificationBytes(
        input.artifacts.read(input.specification_ref),
        input.specification_ref,
        { priorSpecification: prior }
      );
    } catch {
      fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
    }
    immediate_parent = { status: "verified", ref: parent };
  } else if (parentId !== null || productMetadata.domain_revision_parent_ref != null)
    fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
  // The complete bounded role inventory has been charged before graph bodies are read.
  for (const { ref } of refs.values()) {
    cancel(input);
    try {
      input.artifacts.read(ref);
    } catch (error) {
      if (ref.artifact_id === product.source_lineage.prior_specification_artifact_id)
        fail("SPECIFICATION_REVISION_CLOSURE_INVALID");
      throw error;
    }
  }
  const predicate = evaluateDefineLatestReviewedSpecificationDod({
    checkpointer: input.checkpointer,
    context,
    terminal,
    originState: admission.origin_state,
    latestProduct: admission.latest_product,
    artifactReader: input.artifacts,
    projectRoot: input.project_root,
  });
  if (
    !predicate.passed ||
    canonicalJson(predicate.evidence_refs) !== canonicalJson(admission.evidence_refs)
  )
    fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  const checked_artifacts = [...refs.values()].map(({ ref, roles }) => ({
    ref,
    roles: [...roles].sort(),
  }));
  const admissionEvent = input.checkpointer
    .events(runId)
    .filter(
      (event) => canonicalJson(event.payload.completion_admission_v1) === canonicalJson(admission)
    );
  if (admissionEvent.length !== 1) fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  const owner_evidence = exactOwnerProof({
    checkpointer: input.checkpointer,
    runId,
    terminalSha256: sha256(canonicalJson(terminal)),
    admission,
    admissionSequence: String(admissionEvent[0]?.sequence),
    visits,
  });
  return {
    ...common,
    mode: "reviewed_definition",
    specification_ref: input.specification_ref,
    checked_artifacts,
    checked_artifact_count: checked_artifacts.length,
    checked_artifact_bytes: bytes,
    producer: {
      run_id: runId,
      registration_name: "define",
      contract_sha256: binding.contract_sha256,
      registration_sha256: binding.registration_sha256,
      terminal_sha256: sha256(canonicalJson(terminal)),
      completion_admission_sha256: sha256(canonicalJson(admission)),
    },
    immediate_parent,
    owner_evidence,
    scope: [
      "canonical_semantics",
      "completed_define_trace_contract",
      "stored_support_readable",
      "immediate_revision_closure",
    ],
  };
}
function refuse(input: CompositionAdmissionInput, error: unknown): CompositionAssuranceRefusal {
  const code: AssuranceRefusalCode =
    error instanceof Refused
      ? error.code
      : error instanceof Error && error.message.includes("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED")
        ? "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED"
        : "SPECIFICATION_ASSURANCE_CUSTODY_INVALID";
  return {
    schema_version: 1,
    status: "refused",
    code,
    input_artifact_id: input.specification_ref?.artifact_id ?? null,
    requested_mode: input.mode,
    consumer_registration_sha256: input.consumer.registration_sha256,
    findings: [{ code, path: "specification_ref", detail: code }],
  };
}
/** Pure preflight: no request/assurance artifact or consumer run is created. */
export function prepareCompositionAssurance(
  input: CompositionAdmissionInput
): CompositionAdmissionResult {
  try {
    const body = verify(input);
    const assurance = validateCompositionAssurance({
      ...body,
      binding_sha256: sha256(canonicalJson(body)),
    });
    if (Buffer.byteLength(canonicalJson(assurance)) > ASSURANCE_LIMITS.assuranceBytes)
      fail("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
    return { status: "prepared", assurance };
  } catch (error) {
    return refuse(input, error);
  }
}
/** Fixed slots; unchanged operands adopt. Recheck the producer before *any* write. */
export function materializeCompositionAssurance(
  input: CompositionAdmissionInput,
  prepared: CompositionAssuranceV1
):
  | {
      readonly status: "materialized";
      readonly request_ref: ArtifactRef;
      readonly assurance_ref: ArtifactRef;
    }
  | CompositionAssuranceRefusal {
  const current = prepareCompositionAssurance(input);
  if (current.status === "refused") return current;
  if (canonicalJson(current.assurance) !== canonicalJson(prepared))
    return refuse(input, new Refused("SPECIFICATION_ASSURANCE_BINDING_INVALID"));
  const requestMetadata = {
    schema_version: 2 as const,
    run_id: input.consumer.run_id,
    phase: "admission",
    branch_id: null,
    kind: "composition-request",
    operation_id: `composition-request:${input.consumer.run_id}`,
    version: 1,
    producer: "host:composition-assurance",
    media_type: "application/json",
    content_schema: input.request_schema,
    parent_ref: null,
    upstream_refs: [],
  };
  const assuranceMetadata = {
    ...requestMetadata,
    kind: "composition-assurance",
    operation_id: `composition-assurance:${input.consumer.run_id}`,
    content_schema: { schema_id: "penny.composition-assurance.v1", schema_version: 1 },
    upstream_refs: [
      prepared.request_ref,
      ...(prepared.specification_ref === null ? [] : [prepared.specification_ref]),
    ],
  };
  try {
    // Check both immutable logical slots before writing either one; an orphan is never run truth.
    const request = previewArtifactRef({ metadata: requestMetadata, content: input.request_bytes });
    const assuranceBytes = canonicalJson(prepared);
    const assurance = previewArtifactRef({ metadata: assuranceMetadata, content: assuranceBytes });
    for (const [metadata, expected] of [
      [requestMetadata, request],
      [assuranceMetadata, assurance],
    ] as const) {
      const existing = input.artifacts.refFor(
        metadata.run_id,
        metadata.phase,
        metadata.branch_id,
        metadata.kind,
        metadata.operation_id,
        metadata.version
      );
      if (existing !== null && canonicalJson(existing) !== canonicalJson(expected))
        fail("SPECIFICATION_ASSURANCE_BINDING_INVALID");
    }
    cancel(input);
    const request_ref = input.artifacts.persist({
      metadata: requestMetadata,
      content: input.request_bytes,
    });
    const assurance_ref = input.artifacts.persist({
      metadata: assuranceMetadata,
      content: assuranceBytes,
    });
    if (
      canonicalJson(input.artifacts.refById(request_ref.artifact_id)) !==
        canonicalJson(prepared.request_ref) ||
      canonicalJson(input.artifacts.refById(assurance_ref.artifact_id)) !==
        canonicalJson(assurance) ||
      input.artifacts.read(assurance_ref).toString("utf8") !== assuranceBytes ||
      input.artifacts.read(request_ref).toString("utf8") !== input.request_bytes
    )
      fail("SPECIFICATION_ASSURANCE_CUSTODY_INVALID");
    return { status: "materialized", request_ref, assurance_ref };
  } catch (error) {
    return refuse(input, error);
  }
}
