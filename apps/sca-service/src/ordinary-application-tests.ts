/** Ordinary, opt-in application execution. No enrollment, store, engine or model tool.
 * The registered host-operation owner supplies exact readInput custody, journals the submission
 * guard, caches the complete result, and quarantines ambiguous/unproved outcomes. Raw receipts
 * are private evidence: never forward them (or test output) directly to a cognitive worker.
 */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { currentArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  type CurrentArtifactRef,
} from "../../orchestration/dist/contracts.js";
import { parseSealedScaSourceCorpusV1 } from "../../orchestration/dist/sca/active-compliance.js";
import { ScaVmBrokerProductionConfigV1Schema } from "./production-vm-config.js";
import { createVmBrokerProcessRunner, type VmBrokerRunner } from "./vm-broker-adapter.js";

import {
  OrdinaryApplicationContainerConfigSchema,
  ORDINARY_APPLICATION_CONTAINER_PROFILE,
  runOrdinaryApplicationContainer,
  type OrdinaryApplicationDockerRunner,
} from "./ordinary-application-container.js";
export {
  OrdinaryApplicationContainerConfigSchema,
  ORDINARY_APPLICATION_CONTAINER_PROFILE,
} from "./ordinary-application-container.js";
export type {
  OrdinaryApplicationContainerConfig,
  OrdinaryApplicationDockerRunner,
} from "./ordinary-application-container.js";

const CONTROL_BYTES = 1_048_576;
const CORPUS_BYTES = 64 * CONTROL_BYTES;
const SOURCE_BYTES = 16 * CONTROL_BYTES;
const FILE_BYTES = 2 * CONTROL_BYTES;
const RAW_BYTES = 12 * CONTROL_BYTES;
const Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const Relative = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[A-Za-z0-9._@+/-]+$" });
const Interpreter = Type.Union([
  Type.Literal("php"),
  Type.Literal("node"),
  Type.Literal("node_typescript"),
]);
const Resources = Type.Object(
  {
    vm_timeout_seconds: Type.Integer({ minimum: 1, maximum: 1200 }),
    test_timeout_ms: Type.Integer({ minimum: 100, maximum: 60_000 }),
    cpu_seconds: Type.Integer({ minimum: 1, maximum: 60 }),
    memory_bytes: Type.Integer({ minimum: 16_777_216, maximum: 1_610_612_736 }),
    processes: Type.Integer({ minimum: 1, maximum: 32 }),
    file_bytes: Type.Integer({ minimum: 1024, maximum: 8_388_608 }),
    output_bytes: Type.Integer({ minimum: 1, maximum: 65_536 }),
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestPlanSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-plan.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_sha256: Hex,
    source_corpus_ref: ArtifactRefSchema,
    interpreter: Interpreter,
    source_files: Type.Array(
      Type.Object({ path: Relative, content_sha256: Hex }, { additionalProperties: false }),
      { minItems: 1, maxItems: 128 }
    ),
    harness_ref: ArtifactRefSchema,
    test_inputs: Type.Array(
      Type.Object({ path: Relative, ref: ArtifactRefSchema }, { additionalProperties: false }),
      { maxItems: 8 }
    ),
    stdin_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    expected_exit_code: Type.Integer({ minimum: 0, maximum: 255 }),
    resources: Resources,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestPolicySchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-policy.v1"),
    schema_version: Type.Literal(1),
    project_id: Id,
    run_id: Id,
    isolation: Type.Literal("vm"),
    network: Type.Literal("none"),
    credentials: Type.Literal("none"),
    profile: Type.Literal("qemu-kvm-nicless-v1"),
    allowed_plan_sha256: Type.Array(Hex, { minItems: 1, maxItems: 64, uniqueItems: true }),
    maxima: Resources,
  },
  { additionalProperties: false }
);
/** V2 removes VM-specific resource terminology for the explicitly temporary CONTAINER profile.
 * Legacy V1 QEMU/KVM plans/policies remain unchanged. There is no silent fallback.
 */
const ContainerResources = Type.Object(
  {
    ...Resources.properties,
    operation_timeout_seconds: Resources.properties.vm_timeout_seconds,
  },
  { additionalProperties: false }
);
// Omit the legacy VM-only member rather than admitting both spellings.
const { vm_timeout_seconds: _legacyVmTimeout, ...containerResourceProperties } =
  ContainerResources.properties;
export const OrdinaryApplicationContainerResourcesSchema = Type.Object(
  containerResourceProperties,
  { additionalProperties: false }
);
export const OrdinaryApplicationContainerPlanSchema = Type.Object(
  {
    ...OrdinaryApplicationTestPlanSchema.properties,
    schema_id: Type.Literal("penny.sca-ordinary-application-plan.v2"),
    schema_version: Type.Literal(2),
    resources: OrdinaryApplicationContainerResourcesSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationContainerPolicySchema = Type.Object(
  {
    ...OrdinaryApplicationTestPolicySchema.properties,
    schema_id: Type.Literal("penny.sca-ordinary-application-policy.v2"),
    schema_version: Type.Literal(2),
    isolation: Type.Literal("container"),
    profile: Type.Literal(ORDINARY_APPLICATION_CONTAINER_PROFILE),
    maxima: OrdinaryApplicationContainerResourcesSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationExecutionPlanSchema = Type.Union([
  OrdinaryApplicationTestPlanSchema,
  OrdinaryApplicationContainerPlanSchema,
]);
export const OrdinaryApplicationExecutionPolicySchema = Type.Union([
  OrdinaryApplicationTestPolicySchema,
  OrdinaryApplicationContainerPolicySchema,
]);
export type OrdinaryApplicationContainerPlan = Static<
  typeof OrdinaryApplicationContainerPlanSchema
>;
export type OrdinaryApplicationContainerPolicy = Static<
  typeof OrdinaryApplicationContainerPolicySchema
>;
export type OrdinaryApplicationExecutionPlan = Static<
  typeof OrdinaryApplicationExecutionPlanSchema
>;
export type OrdinaryApplicationExecutionPolicy = Static<
  typeof OrdinaryApplicationExecutionPolicySchema
>;
export const OrdinaryApplicationTestRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-request.v1"),
    schema_version: Type.Literal(1),
    project_id: Id,
    run_id: Id,
    action_id: Id,
    source_snapshot_sha256: Hex,
    execution_plan_ref: ArtifactRefSchema,
    policy_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestAuthoritySchema = Type.Object(
  {
    project_id: Id,
    admitted_policy_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);
const Pins = ScaVmBrokerProductionConfigV1Schema.properties;
/** Host construction only. No member of this configuration is accepted in a model request. */
export const OrdinaryApplicationVmConfigSchema = Type.Object(
  {
    workspace_parent: Pins.workspace_parent,
    global_lock: Pins.global_lock,
    run_job: Pins.run_job,
    run_guest: Pins.run_guest,
    output_protocol: Pins.output_protocol,
    python: Pins.python,
    genisoimage: Pins.genisoimage,
    cp: Pins.cp,
    qemu: Pins.qemu,
    bwrap: Pins.bwrap,
    systemctl: Pins.systemctl,
    template: Pins.template,
    bridge: Pins.run_job,
    guest: Pins.run_guest,
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationRuntimeConfigSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("qemu-kvm"), vm: OrdinaryApplicationVmConfigSchema },
    { additionalProperties: false }
  ),
  OrdinaryApplicationContainerConfigSchema,
]);
export type OrdinaryApplicationRuntimeConfig = Static<
  typeof OrdinaryApplicationRuntimeConfigSchema
>;
export type OrdinaryApplicationTestPlan = Static<typeof OrdinaryApplicationTestPlanSchema>;
export type OrdinaryApplicationTestPolicy = Static<typeof OrdinaryApplicationTestPolicySchema>;
export type OrdinaryApplicationTestRequest = Static<typeof OrdinaryApplicationTestRequestSchema>;
export type OrdinaryApplicationVmConfig = Static<typeof OrdinaryApplicationVmConfigSchema>;
const Execution = Type.Union([
  Type.Literal("RUN"),
  Type.Literal("NOT RUN"),
  Type.Literal("UNKNOWN"),
]);
const GuestResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    payload_sha256: Hex,
    status: Type.Union([
      Type.Literal("exited"),
      Type.Literal("unsupported"),
      Type.Literal("timeout"),
      Type.Literal("output_limit"),
      Type.Literal("failed"),
    ]),
    execution: Type.Union([Type.Literal("RUN"), Type.Literal("NOT RUN")]),
    exit_code: Type.Union([Type.Integer({ minimum: -255, maximum: 255 }), Type.Null()]),
    stdout_base64: Type.String({ maxLength: 87_384 }),
    stderr_base64: Type.String({ maxLength: 87_384 }),
  },
  { additionalProperties: false }
);
const BridgePointerSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    receipt_sha256: Hex,
    receipt_bytes: Type.Integer({ minimum: 1, maximum: 15 * CONTROL_BYTES }),
  },
  { additionalProperties: false }
);
const BridgeResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    payload_sha256: Hex,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    launcher_started: Type.Boolean(),
    unit_observed: Type.Boolean(),
    containment_proved: Type.Boolean(),
    media_removed: Type.Boolean(),
    launcher_base64: Type.String({ maxLength: 16_384 }),
    command_base64: Type.String({ maxLength: CONTROL_BYTES }),
    serial_base64: Type.String({ maxLength: RAW_BYTES }),
  },
  { additionalProperties: false }
);
export const OrdinaryApplicationTestResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ordinary-application-result.v1"),
    schema_version: Type.Literal(1),
    request_sha256: Hex,
    source_snapshot_sha256: Hex,
    isolation: Type.Optional(
      Type.Union([Type.Literal("VM"), Type.Literal("CONTAINER"), Type.Null()])
    ),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("denied"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
    ]),
    reason: Type.Union([
      Type.Literal("observed"),
      Type.Literal("invalid_operands"),
      Type.Literal("policy_denied"),
      Type.Literal("not_configured"),
      Type.Literal("cancelled"),
      Type.Literal("vm_failed"),
      Type.Literal("container_failed"),
      Type.Literal("guest_unsupported"),
      Type.Literal("timeout"),
      Type.Literal("output_limit"),
      Type.Literal("evidence_invalid"),
      Type.Literal("recovery_requires_exact_cache"),
      Type.Literal("containment_unproved"),
    ]),
    execution: Execution,
    acceptance: Type.Union([
      Type.Literal("not_submitted"),
      Type.Literal("terminal"),
      Type.Literal("ambiguous"),
    ]),
    cleanup: Type.Union([
      Type.Literal("not_needed"),
      Type.Literal("proved"),
      Type.Literal("unproved"),
    ]),
    quarantine_required: Type.Boolean(),
    passed: Type.Union([Type.Boolean(), Type.Null()]),
    exit_code: Type.Union([Type.Integer({ minimum: -255, maximum: 255 }), Type.Null()]),
    stdout_base64: Type.String({ maxLength: 87_384 }),
    stderr_base64: Type.String({ maxLength: 87_384 }),
    raw_receipt_base64: Type.String({ maxLength: 20 * CONTROL_BYTES }),
    retained_workspace: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    evidence_scope: Type.Union([
      Type.Literal("untrusted_guest_observation_not_vulnerability_or_isolation_attestation"),
      Type.Literal("untrusted_container_observation_not_vulnerability_or_isolation_attestation"),
    ]),
  },
  { additionalProperties: false }
);
export type OrdinaryApplicationTestResult = Static<typeof OrdinaryApplicationTestResultSchema>;
export interface OrdinaryApplicationTestOwner {
  readonly projectId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** Must return only an exact operand already admitted by this host operation. No discovery. */
  readArtifact(ref: CurrentArtifactRef): {
    readonly ref: CurrentArtifactRef;
    readonly bytes: Uint8Array;
  };
  /** Synchronous durable submission guard; throw if the current backend fence is not owned. */
  beforeSubmit(correlation: string): void;
  /** Called only after the named VM service or daemon-owned CONTAINER is observed. Not RUN proof. */
  accepted(correlation: string): void;
  activity(): void;
}
export interface OrdinaryApplicationTestRuntime {
  run(value: unknown, owner: OrdinaryApplicationTestOwner): Promise<OrdinaryApplicationTestResult>;
}
export interface OrdinaryApplicationTestOptions {
  readonly authority: Static<typeof OrdinaryApplicationTestAuthoritySchema>;
  readonly vm?: OrdinaryApplicationVmConfig;
  /** Host-only tagged configuration. Mutually exclusive with legacy vm. No fallback. */
  readonly runtime?: OrdinaryApplicationRuntimeConfig;
  readonly dockerRunner?: OrdinaryApplicationDockerRunner;
  /** Trusted test seam only; synthetic receipts are not live isolation evidence. */
  readonly runner?: VmBrokerRunner;
}
class AdmissionError extends Error {
  constructor(readonly reason: "invalid_operands" | "policy_denied") {
    super(reason);
  }
}
function denied(reason: "invalid_operands" | "policy_denied"): never {
  throw new AdmissionError(reason);
}
function relative(value: string): boolean {
  return (
    /^[A-Za-z0-9._@+/-]+$/u.test(value) &&
    Buffer.byteLength(value) <= 1024 &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && part.length <= 255)
  );
}
function json<S extends TSchema>(bytes: Buffer, schema: S, maximum = CONTROL_BYTES): Static<S> {
  if (bytes.length > maximum) denied("invalid_operands");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) denied("invalid_operands");
  return validateContract(schema, value, "ordinary application-test document");
}
function base64(value: string, maximum: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value)
    throw new Error("invalid bounded base64");
  return bytes;
}
function exact(
  owner: OrdinaryApplicationTestOwner,
  ref: CurrentArtifactRef,
  maximum: number
): Buffer {
  const canonical = currentArtifactRef(ref);
  if (
    canonicalJson(canonical) !== canonicalJson(ref) ||
    ref.run_id !== owner.runId ||
    ref.byte_length > maximum
  )
    denied("invalid_operands");
  const input = owner.readArtifact(ref);
  if (canonicalJson(input.ref) !== canonicalJson(ref)) denied("invalid_operands");
  const bytes = Buffer.from(input.bytes);
  if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    denied("invalid_operands");
  return bytes;
}
function documentRef(ref: CurrentArtifactRef, kind: string, schema: string, version = 1): void {
  if (
    ref.kind !== kind ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== schema ||
    ref.content_schema.schema_version !== version
  )
    denied("invalid_operands");
}
function result(
  request: OrdinaryApplicationTestRequest,
  patch: Partial<OrdinaryApplicationTestResult>
): OrdinaryApplicationTestResult {
  return validateOrdinaryApplicationTestResult({
    schema_id: "penny.sca-ordinary-application-result.v1",
    schema_version: 1,
    request_sha256: sha256(canonicalJson(request)),
    source_snapshot_sha256: request.source_snapshot_sha256,
    status: "denied",
    reason: "invalid_operands",
    execution: "NOT RUN",
    acceptance: "not_submitted",
    cleanup: "not_needed",
    quarantine_required: false,
    passed: null,
    exit_code: null,
    stdout_base64: "",
    stderr_base64: "",
    raw_receipt_base64: "",
    retained_workspace: null,
    evidence_scope: "untrusted_guest_observation_not_vulnerability_or_isolation_attestation",
    ...patch,
  });
}
export function validateOrdinaryApplicationTestResult(
  value: unknown
): OrdinaryApplicationTestResult {
  const parsed = validateContract(
    OrdinaryApplicationTestResultSchema,
    value,
    "ordinary application-test result"
  );
  base64(parsed.stdout_base64, 65_536);
  base64(parsed.stderr_base64, 65_536);
  base64(parsed.raw_receipt_base64, 15 * CONTROL_BYTES);
  if (
    (parsed.status === "completed" &&
      (parsed.execution !== "RUN" ||
        parsed.acceptance !== "terminal" ||
        parsed.cleanup !== "proved" ||
        parsed.passed === null ||
        parsed.exit_code === null ||
        parsed.raw_receipt_base64 === "")) ||
    (parsed.status === "denied" &&
      (parsed.execution !== "NOT RUN" ||
        parsed.acceptance !== "not_submitted" ||
        parsed.cleanup !== "not_needed" ||
        !["invalid_operands", "policy_denied"].includes(parsed.reason))) ||
    (parsed.status === "unsupported" &&
      (parsed.execution !== "NOT RUN" ||
        !["not_configured", "guest_unsupported"].includes(parsed.reason))) ||
    (parsed.isolation === "CONTAINER" &&
      parsed.evidence_scope !==
        "untrusted_container_observation_not_vulnerability_or_isolation_attestation") ||
    (parsed.isolation === "VM" &&
      parsed.evidence_scope !==
        "untrusted_guest_observation_not_vulnerability_or_isolation_attestation") ||
    (parsed.execution === "UNKNOWN" && parsed.status !== "incomplete") ||
    (parsed.acceptance === "not_submitted" && parsed.execution !== "NOT RUN") ||
    (parsed.cleanup === "not_needed" && parsed.acceptance !== "not_submitted") ||
    (parsed.cleanup === "unproved" || parsed.acceptance === "ambiguous") !==
      parsed.quarantine_required ||
    (parsed.quarantine_required && parsed.status !== "incomplete") ||
    (parsed.status !== "completed" && parsed.passed !== null) ||
    (parsed.retained_workspace !== null &&
      (parsed.cleanup !== "unproved" ||
        !path.isAbsolute(parsed.retained_workspace) ||
        path.normalize(parsed.retained_workspace) !== parsed.retained_workspace ||
        parsed.retained_workspace.includes("\0"))) ||
    (parsed.execution === "NOT RUN" &&
      (parsed.exit_code !== null || parsed.stdout_base64 !== "" || parsed.stderr_base64 !== ""))
  )
    throw new Error("contradictory application-test truth");
  return parsed;
}
function admit(
  request: OrdinaryApplicationTestRequest,
  authority: Static<typeof OrdinaryApplicationTestAuthoritySchema>,
  owner: OrdinaryApplicationTestOwner,
  isolation?: "vm" | "container"
) {
  if (
    request.project_id !== authority.project_id ||
    request.project_id !== owner.projectId ||
    request.run_id !== owner.runId ||
    !authority.admitted_policy_refs.some(
      (ref) => canonicalJson(ref) === canonicalJson(request.policy_ref)
    )
  )
    denied("policy_denied");
  const container =
    request.policy_ref.content_schema?.schema_id === "penny.sca-ordinary-application-policy.v2";
  const version = container ? 2 : 1;
  if ((isolation === "container") !== container && isolation !== undefined) denied("policy_denied");
  documentRef(
    request.policy_ref,
    "sca-execution-policy",
    `penny.sca-ordinary-application-policy.v${version}`,
    version
  );
  documentRef(
    request.execution_plan_ref,
    "sca-execution-plan",
    `penny.sca-ordinary-application-plan.v${version}`,
    version
  );
  const policy = json(
    exact(owner, request.policy_ref, CONTROL_BYTES),
    OrdinaryApplicationExecutionPolicySchema
  );
  const plan = json(
    exact(owner, request.execution_plan_ref, CONTROL_BYTES),
    OrdinaryApplicationExecutionPlanSchema
  );
  if (
    policy.schema_version !== version ||
    plan.schema_version !== version ||
    policy.project_id !== owner.projectId ||
    policy.run_id !== owner.runId ||
    !policy.allowed_plan_sha256.includes(request.execution_plan_ref.content_digest) ||
    plan.source_snapshot_sha256 !== request.source_snapshot_sha256
  )
    denied("policy_denied");
  for (const key of Object.keys(plan.resources)) {
    const limit: unknown = Reflect.get(plan.resources, key);
    const maximum: unknown = Reflect.get(policy.maxima, key);
    if (typeof limit !== "number" || typeof maximum !== "number" || limit > maximum)
      denied("policy_denied");
  }
  const operationSeconds =
    "operation_timeout_seconds" in plan.resources
      ? plan.resources.operation_timeout_seconds
      : plan.resources.vm_timeout_seconds;
  if (plan.resources.test_timeout_ms >= operationSeconds * 1000) denied("invalid_operands");
  const corpusBytes = exact(owner, plan.source_corpus_ref, CORPUS_BYTES);
  const corpus = parseSealedScaSourceCorpusV1(corpusBytes);
  if (corpus.source_snapshot_sha256 !== request.source_snapshot_sha256) denied("invalid_operands");
  const paths = new Set<string>();
  let total = 0;
  const files = plan.source_files.map((entry) => {
    const file = corpus.files.get(entry.path);
    if (
      !relative(entry.path) ||
      paths.has(entry.path) ||
      corpus.excluded_paths.has(entry.path) ||
      file === undefined ||
      file.content_sha256 !== entry.content_sha256 ||
      file.bytes.length > FILE_BYTES ||
      (total += file.bytes.length) > SOURCE_BYTES
    )
      denied("invalid_operands");
    paths.add(entry.path);
    return {
      path: `source/${entry.path}`,
      content_sha256: file.content_sha256,
      content_base64: file.bytes.toString("base64"),
    };
  });
  const harness = exact(owner, plan.harness_ref, FILE_BYTES);
  if (harness.length === 0) denied("invalid_operands");
  total += harness.length;
  const extension =
    plan.interpreter === "php" ? "php" : plan.interpreter === "node_typescript" ? "ts" : "mjs";
  files.push({
    path: `tests/harness.${extension}`,
    content_sha256: sha256(harness),
    content_base64: harness.toString("base64"),
  });
  const inputPaths = new Set<string>();
  for (const input of plan.test_inputs) {
    if (!relative(input.path) || inputPaths.has(input.path)) denied("invalid_operands");
    inputPaths.add(input.path);
    const bytes = exact(owner, input.ref, FILE_BYTES);
    total += bytes.length;
    files.push({
      path: `tests/data/${input.path}`,
      content_sha256: sha256(bytes),
      content_base64: bytes.toString("base64"),
    });
  }
  // Reject file/directory alias collisions before touching the filesystem or VM.
  const names = files.map((file) => file.path).sort();
  if (names.some((name, i) => names.slice(i + 1).some((other) => other.startsWith(`${name}/`))))
    denied("invalid_operands");
  const stdin =
    plan.stdin_ref === null ? Buffer.alloc(0) : exact(owner, plan.stdin_ref, FILE_BYTES);
  if (total + stdin.length > SOURCE_BYTES) denied("invalid_operands");
  const payload = {
    schema_version: 1,
    request_sha256: sha256(canonicalJson(request)),
    source_snapshot_sha256: request.source_snapshot_sha256,
    source_corpus_sha256: plan.source_corpus_ref.content_digest,
    plan_sha256: request.execution_plan_ref.content_digest,
    policy_sha256: request.policy_ref.content_digest,
    interpreter: plan.interpreter,
    resources: plan.resources,
    files,
    stdin_base64: stdin.toString("base64"),
  };
  return { plan, payload: Buffer.from(canonicalJson(payload)) };
}
async function pin(
  file: OrdinaryApplicationVmConfig["bridge"],
  maximum: number,
  immutable = false,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if (
    !path.isAbsolute(file.path) ||
    path.normalize(file.path) !== file.path ||
    /[\0\r\n$]/u.test(file.path) ||
    (await realpath(file.path)) !== file.path ||
    file.size_bytes > maximum
  )
    throw new Error("unsafe VM pin");
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== file.size_bytes ||
      ![0, process.getuid?.()].includes(before.uid) ||
      (before.mode & (immutable ? 0o222 : 0o022)) !== 0
    )
      throw new Error("unsafe VM file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1_048_576);
    let offset = 0;
    while (offset < before.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error("VM pin truncated");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      hash.digest("hex") !== file.sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (await lstat(file.path)).ino !== before.ino
    )
      throw new Error("VM pin drift");
  } finally {
    await handle.close();
  }
}
async function vmPreflight(vm: OrdinaryApplicationVmConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !path.isAbsolute(vm.workspace_parent) ||
    (await realpath(vm.workspace_parent)) !== vm.workspace_parent
  )
    throw new Error("VM host unsupported");
  const parent = await lstat(vm.workspace_parent);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700 ||
    path.dirname(vm.global_lock) !== vm.workspace_parent
  )
    throw new Error("unsafe VM workspace");
  const lock = await lstat(vm.global_lock);
  if (
    (await realpath(vm.global_lock)) !== vm.global_lock ||
    !lock.isFile() ||
    lock.nlink !== 1 ||
    lock.uid !== process.getuid?.() ||
    lock.size !== 0 ||
    (lock.mode & 0o777) !== 0o600
  )
    throw new Error("VM lock unavailable or quarantined");
  for (const file of [
    vm.bridge,
    vm.guest,
    vm.run_job,
    vm.run_guest,
    vm.output_protocol,
    vm.python,
    vm.genisoimage,
    vm.cp,
    vm.qemu,
    vm.bwrap,
    vm.systemctl,
  ])
    await pin(file, 256 * CONTROL_BYTES, false, signal);
  await pin(vm.template, 32 * 1024 * CONTROL_BYTES, true, signal);
  if (vm.output_protocol.path !== path.join(path.dirname(vm.run_job.path), "output_protocol.py"))
    throw new Error("bridge import custody mismatch");
  const kvm = await open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!(await kvm.stat()).isCharacterDevice()) throw new Error("KVM unavailable");
  } finally {
    await kvm.close();
  }
}
async function absent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
/** Fresh execution only. Recovery must use recoverOrdinaryApplicationTest, never call run again. */
export function createOrdinaryApplicationTestRuntime(
  input: OrdinaryApplicationTestOptions
): OrdinaryApplicationTestRuntime {
  const authority = validateContract(
    OrdinaryApplicationTestAuthoritySchema,
    structuredClone(input.authority),
    "application-test host authority"
  );
  if (input.vm !== undefined && input.runtime !== undefined)
    throw new Error("Select exactly one application-test backend");
  const configured =
    input.runtime === undefined
      ? undefined
      : validateContract(
          OrdinaryApplicationRuntimeConfigSchema,
          structuredClone(input.runtime),
          "application-test host runtime"
        );
  const container = configured?.kind === "docker" ? configured : undefined;
  const vmInput = configured?.kind === "qemu-kvm" ? configured.vm : input.vm;
  const vm =
    vmInput === undefined
      ? undefined
      : validateContract(
          OrdinaryApplicationVmConfigSchema,
          structuredClone(vmInput),
          "application-test host VM config"
        );
  const runner = input.runner ?? createVmBrokerProcessRunner(60_000);
  const dockerRunner = input.dockerRunner;
  return Object.freeze({
    async run(
      value: unknown,
      owner: OrdinaryApplicationTestOwner
    ): Promise<OrdinaryApplicationTestResult> {
      // Malformed request cannot be given an invented identity/result. Parent handles this as invalid input.
      const request = validateContract(
        OrdinaryApplicationTestRequestSchema,
        structuredClone(value),
        "application-test request"
      );
      let admitted: ReturnType<typeof admit>;
      try {
        admitted = admit(
          request,
          authority,
          owner,
          container === undefined ? (vm === undefined ? undefined : "vm") : "container"
        );
      } catch (error) {
        return result(request, {
          status: "denied",
          reason: error instanceof AdmissionError ? error.reason : "invalid_operands",
        });
      }
      if (owner.signal.aborted) return result(request, { status: "failed", reason: "cancelled" });
      if (container !== undefined) {
        return result(request, {
          isolation: "CONTAINER",
          evidence_scope:
            "untrusted_container_observation_not_vulnerability_or_isolation_attestation",
          ...(await runOrdinaryApplicationContainer(
            container,
            admitted,
            request,
            owner,
            dockerRunner
          )),
        });
      }
      if (vm === undefined)
        return result(request, { status: "unsupported", reason: "not_configured" });
      try {
        await vmPreflight(vm, owner.signal);
      } catch {
        return result(
          request,
          owner.signal.aborted
            ? { status: "failed", reason: "cancelled" }
            : { status: "unsupported", reason: "not_configured" }
        );
      }
      let work: string | undefined;
      let guarded = false;
      let cleanup = false;
      let raw = "";
      let outcome = result(request, { status: "failed", reason: "vm_failed" });
      try {
        work = await mkdtemp(path.join(vm.workspace_parent, "ordinary-app-"));
        await writeFile(path.join(work, "config.json"), canonicalJson(vm), {
          flag: "wx",
          mode: 0o400,
        });
        await writeFile(path.join(work, "payload.json"), admitted.payload, {
          flag: "wx",
          mode: 0o400,
        });
        owner.signal.throwIfAborted();
        const correlation = `penny-guest-${sha256(canonicalJson(request)).slice(0, 32)}.service`;
        owner.beforeSubmit(correlation);
        guarded = true;
        let milestones = 0;
        let acceptanceRecorded = false;
        const transport = await runner.run(
          vm.python.path,
          [
            "-I",
            "-B",
            vm.bridge.path,
            "--config",
            path.join(work, "config.json"),
            "--payload",
            path.join(work, "payload.json"),
            "--unit",
            correlation,
          ],
          owner.signal,
          () => {
            milestones += 1;
            if (milestones === 4) {
              owner.accepted(correlation);
              acceptanceRecorded = true;
            }
            owner.activity();
          }
        );
        // Preserve every bounded byte, even malformed transport output. Never print it.
        if (Buffer.byteLength(transport.stdout) <= 15 * CONTROL_BYTES)
          raw = Buffer.from(transport.stdout).toString("base64");
        if (!transport.terminated || !transport.stdout.endsWith("\n"))
          throw new Error("bridge process termination/result uncertain");
        const pointer = json(Buffer.from(transport.stdout.slice(0, -1)), BridgePointerSchema);
        const receiptFile = await open(
          path.join(work, "receipt.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        let receiptBytes: Buffer;
        try {
          const before = await receiptFile.stat();
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.uid !== process.getuid?.() ||
            (before.mode & 0o077) !== 0 ||
            before.size !== pointer.receipt_bytes
          )
            throw new Error("unsafe bridge receipt");
          const buffer = Buffer.alloc(pointer.receipt_bytes + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await receiptFile.read(
              buffer,
              length,
              buffer.length - length,
              length
            );
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          receiptBytes = buffer.subarray(0, length);
          const after = await receiptFile.stat();
          if (
            receiptBytes.length !== pointer.receipt_bytes ||
            sha256(receiptBytes) !== pointer.receipt_sha256 ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error("bridge receipt drift");
        } finally {
          await receiptFile.close();
        }
        raw = receiptBytes.toString("base64");
        const bridge = json(receiptBytes, BridgeResultSchema, 15 * CONTROL_BYTES);
        if (
          bridge.payload_sha256 !== sha256(admitted.payload) ||
          (!bridge.launcher_started && bridge.unit_observed)
        )
          throw new Error("bridge binding mismatch");
        cleanup = bridge.containment_proved && bridge.media_removed;
        if (!cleanup) throw new Error("VM containment unproved");
        if (bridge.unit_observed && !acceptanceRecorded) owner.accepted(correlation);
        const execution = bridge.launcher_started ? "UNKNOWN" : "NOT RUN";
        outcome = result(request, {
          status: execution === "UNKNOWN" ? "incomplete" : "failed",
          reason: owner.signal.aborted || bridge.status === "cancelled" ? "cancelled" : "vm_failed",
          execution,
          acceptance: "terminal",
          cleanup: "proved",
          raw_receipt_base64: raw,
        });
        if (
          bridge.status === "completed" &&
          transport.exitCode === 0 &&
          bridge.launcher_started &&
          bridge.unit_observed
        ) {
          const serial = base64(bridge.serial_base64, 8 * CONTROL_BYTES)
            .toString("utf8")
            .replace(/\r\n/gu, "\n");
          const markers = serial
            .split("\n")
            .filter((line) => line.startsWith("PENNY_APP_TEST_RESULT="));
          if (markers.length !== 1 || markers[0] === undefined)
            throw new Error("guest receipt missing/duplicated");
          const guest = json(
            Buffer.from(markers[0].slice("PENNY_APP_TEST_RESULT=".length)),
            GuestResultSchema
          );
          const stdout = base64(guest.stdout_base64, admitted.plan.resources.output_bytes);
          const stderr = base64(guest.stderr_base64, admitted.plan.resources.output_bytes);
          if (
            stdout.length + stderr.length > admitted.plan.resources.output_bytes ||
            guest.payload_sha256 !== sha256(admitted.payload) ||
            (guest.status === "exited" &&
              (guest.execution !== "RUN" || guest.exit_code === null)) ||
            (guest.status === "unsupported" && guest.execution !== "NOT RUN")
          )
            throw new Error("guest observation inconsistent");
          outcome = result(request, {
            status:
              guest.status === "exited"
                ? "completed"
                : guest.status === "unsupported"
                  ? "unsupported"
                  : "failed",
            reason:
              guest.status === "exited"
                ? "observed"
                : guest.status === "unsupported"
                  ? "guest_unsupported"
                  : guest.status === "timeout"
                    ? "timeout"
                    : guest.status === "output_limit"
                      ? "output_limit"
                      : "vm_failed",
            execution: guest.execution,
            acceptance: "terminal",
            cleanup: "proved",
            passed:
              guest.status === "exited"
                ? guest.exit_code === admitted.plan.expected_exit_code
                : null,
            exit_code: guest.exit_code,
            stdout_base64: guest.stdout_base64,
            stderr_base64: guest.stderr_base64,
            raw_receipt_base64: raw,
          });
          if (owner.signal.aborted)
            outcome = result(request, {
              ...outcome,
              status: "failed",
              reason: "cancelled",
              passed: null,
            });
        }
      } catch {
        outcome = result(
          request,
          guarded
            ? {
                status: "incomplete",
                reason: cleanup ? "evidence_invalid" : "containment_unproved",
                execution: "UNKNOWN",
                acceptance: cleanup ? "terminal" : "ambiguous",
                cleanup: cleanup ? "proved" : "unproved",
                quarantine_required: !cleanup,
                raw_receipt_base64: raw,
              }
            : { status: "failed", reason: owner.signal.aborted ? "cancelled" : "vm_failed" }
        );
      }
      if (work !== undefined && (!guarded || cleanup)) {
        try {
          if ((await realpath(work)) !== work) throw new Error("workspace changed");
          await rm(work, { recursive: true, force: false });
          if (!(await absent(work))) throw new Error("workspace remains");
        } catch {
          outcome = result(request, {
            ...outcome,
            status: "incomplete",
            reason: "containment_unproved",
            cleanup: "unproved",
            acceptance: guarded ? outcome.acceptance : "not_submitted",
            quarantine_required: true,
            passed: null,
          });
        }
      }
      if (work !== undefined && outcome.cleanup === "unproved")
        outcome = result(request, { ...outcome, retained_workspace: work });
      return result(request, { ...outcome, isolation: "VM" });
    },
  });
}
/** Only the existing owner's exact cached artifact is replayable. No scan, rerun or synthetic terminal. */
export function recoverOrdinaryApplicationTest(
  value: unknown,
  cachedBytes: Uint8Array | null
): OrdinaryApplicationTestResult {
  const request = validateContract(
    OrdinaryApplicationTestRequestSchema,
    value,
    "application-test recovery request"
  );
  if (cachedBytes === null)
    return result(request, {
      status: "incomplete",
      reason: "recovery_requires_exact_cache",
      execution: "UNKNOWN",
      acceptance: "ambiguous",
      cleanup: "unproved",
      quarantine_required: true,
    });
  const cached = validateOrdinaryApplicationTestResult(
    json(Buffer.from(cachedBytes), OrdinaryApplicationTestResultSchema, 24 * CONTROL_BYTES)
  );
  if (
    cached.request_sha256 !== sha256(canonicalJson(request)) ||
    cached.source_snapshot_sha256 !== request.source_snapshot_sha256
  )
    throw new Error("application-test recovery binding drift");
  return cached;
}
