import { verify as verifySignature, type KeyObject } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ScaP03DockerCandidateConfigV1,
  ScaP03DockerOwnedExecutionV1,
  DockerRunnerV1,
} from "./p03-docker-runtime.js";
import { bindScaP03LocalProbeToOwnedOperationV1 } from "./p03-bootstrap-local-probe.js";
import type { ScaP03ExactArtifactReaderV1 } from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  validateScaP03AttemptWitnessV1,
  validateScaP03CleanupEvidenceV2,
  validateScaP03IsolationEvidenceV2,
  validateScaP03ExternalReviewReceiptV2,
  validateScaP03CurrentSelectionV1,
  validateScaP03BootstrapQualificationRecordV3,
  validateScaP03AttestationBindingV3,
  validateScaP03BootstrapReviewV3,
  validateScaP03ProductionQualificationRecordV1,
  SCA_P03_PRODUCTION_EVALUATOR,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
  type ScaP03AttemptWitnessV1,
  type ScaP03ProductionQualificationRecordV1,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03BaselineQuerySetV2,
  scaP03QueryReleaseSha256V2,
  validateScaP03HostIsolationAttestationV1,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  checkArtifact,
  exactP03BootstrapObservations,
  readP03BootstrapInputs,
  P03_BOOTSTRAP_ROLES,
  readP03BootstrapBytes,
  readP03ProductionInputs,
  type ScaP03BootstrapArtifactReaderV1,
  type ScaP03FrozenProductionBindingsV1,
} from "./p03-bootstrap.js";

/** Host-controlled probe: raw daemon enumeration/inspect and independently measured identity,
 * never a candidate's assertion that isolation or cleanup passed. */
export interface ScaP03HostVerificationContextV1 {
  readonly signal: AbortSignal;
  readonly reportWorkMilestone: () => void;
  readonly owned_execution?: {
    readonly owned: ScaP03DockerOwnedExecutionV1;
    readonly transport: DockerRunnerV1;
  };
}

export interface ScaP03BootstrapHostProbeV1 {
  containerCensus(
    names: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly { name: string; id: string }[]>;
  inspectContainer(name: string, id: string, signal?: AbortSignal): Promise<Uint8Array>;
  measureIdentity(signal?: AbortSignal): Promise<ScaP03AttemptWitnessV1["identity"]>;
  /** Read current deployed/build bytes for this exact immutable ref through a host-controlled mapping. */
  readBuildFile(ref: ArtifactRef, signal?: AbortSignal): Promise<Uint8Array>;
  /** Host-only mapping from owner-created attempt to workspace paths, never from artifact JSON. */
  workspacePaths(attemptId: string, signal?: AbortSignal): Promise<readonly string[]>;
  /** Digest of owner-recorded path/dev/inode tuples, captured before removal. */
  workspaceIdentityDigest(attemptId: string, signal?: AbortSignal): Promise<string>;
  /** Host-owned latest selection bytes, not a supplied historical selection artifact. */
  currentSelection(signal?: AbortSignal): Promise<Uint8Array>;
  now(): Date;
}

function verificationContext(
  value?: ScaP03HostVerificationContextV1
): ScaP03HostVerificationContextV1 {
  return (
    value ?? {
      signal: new AbortController().signal,
      reportWorkMilestone() {},
    }
  );
}

/** No-follow census; an unknown, raced, or symlinked workspace is not absence proof. */
export async function censusScaP03WorkspaceV1(
  paths: readonly string[],
  contextValue?: ScaP03HostVerificationContextV1
): Promise<void> {
  const context = verificationContext(contextValue);
  if (paths.length === 0 || paths.length > 256 || new Set(paths).size !== paths.length)
    throw new Error("p03_workspace_census_incomplete");
  for (const target of paths) {
    context.signal.throwIfAborted();
    if (!target.startsWith("/") || target.includes("/../") || target.includes("/./"))
      throw new Error("p03_workspace_path_invalid");
    const parent = path.dirname(target);
    const parentBefore = await lstat(parent);
    if (
      !parentBefore.isDirectory() ||
      parentBefore.isSymbolicLink() ||
      (await realpath(parent)) !== parent
    )
      throw new Error("p03_workspace_parent_invalid");
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("p03_workspace_type_invalid");
      const dir = await opendir(target);
      try {
        for await (const entry of dir) {
          if (entry.isSymbolicLink() || entry.name !== ".")
            throw new Error("p03_workspace_not_empty");
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
      const after = await lstat(target);
      if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isDirectory())
        throw new Error("p03_workspace_raced");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parentAfter = await lstat(parent);
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      (await realpath(parent)) !== parent
    )
      throw new Error("p03_workspace_raced");
    context.reportWorkMilestone();
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const CONFINED_IMAGE_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "JOERN_HOME",
  "LC_ALL",
  "LANG",
  "LANGUAGE",
  "JAVA_HOME",
  "JAVA_17_HOME",
  "JOERN_DATAFLOW_TRACKED_WIDTH",
  "CLASSPATH",
]);
function confinedImageEnvironment(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return false;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  if (entries.length !== value.length) return false;
  const pairs = entries.map((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0
      ? ([entry.slice(0, separator), entry.slice(separator + 1)] as const)
      : (["", ""] as const);
  });
  return (
    pairs.every(
      ([key, entryValue]) =>
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(key) &&
        CONFINED_IMAGE_ENV_KEYS.has(key) &&
        entryValue.length <= 2048 &&
        !entryValue.includes("\0") &&
        !/[\r\n]/u.test(entryValue)
    ) &&
    new Set(pairs.map(([key]) => key)).size === pairs.length &&
    pairs.some(([key, entryValue]) => key === "HOME" && entryValue === "/tmp")
  );
}
export function validateScaP03ConfinementProjectionV3(
  projection: string,
  id: string,
  name: string,
  image: string
): void {
  let value: unknown;
  try {
    value = JSON.parse(projection);
  } catch {
    throw new Error("p03_host_confinement_invalid");
  }
  if (canonicalJson(value) !== projection || !plainRecord(value))
    throw new Error("p03_host_confinement_invalid");
  const p = value;
  const keys = [
    "image",
    "id",
    "name",
    "network",
    "pid_mode",
    "ipc_mode",
    "uts_mode",
    "readonly_root",
    "privileged",
    "init",
    "cap_drop",
    "security_opt",
    "pids",
    "memory",
    "memory_swap",
    "nano_cpus",
    "log",
    "tmpfs",
    "user",
    "workdir",
    "env",
    "entrypoint",
    "command",
    "mounts",
    "running",
  ];
  const tmpfs = p.tmpfs;
  const mounts = p.mounts;
  if (
    !equal(Object.keys(p).sort(), keys.sort()) ||
    p.image !== image ||
    p.id !== id ||
    p.name !== `/${name}` ||
    p.network !== "none" ||
    typeof p.pid_mode !== "string" ||
    p.pid_mode === "host" ||
    typeof p.ipc_mode !== "string" ||
    p.ipc_mode === "host" ||
    typeof p.uts_mode !== "string" ||
    p.uts_mode === "host" ||
    p.readonly_root !== true ||
    p.privileged !== false ||
    p.init !== true ||
    p.running !== true ||
    !equal(p.cap_drop, ["ALL"]) ||
    !equal(p.security_opt, ["no-new-privileges"]) ||
    !Number.isSafeInteger(p.pids) ||
    Number(p.pids) < 16 ||
    !Number.isSafeInteger(p.memory) ||
    Number(p.memory) < 256 * 1024 * 1024 ||
    p.memory !== p.memory_swap ||
    !Number.isSafeInteger(p.nano_cpus) ||
    Number(p.nano_cpus) <= 0 ||
    p.log !== "none" ||
    p.workdir !== "/tmp" ||
    !equal(p.entrypoint, ["sleep"]) ||
    !equal(p.command, ["infinity"]) ||
    !confinedImageEnvironment(p.env) ||
    !plainRecord(tmpfs) ||
    !equal(Object.keys(tmpfs).sort(), ["/tmp", "/work"]) ||
    tmpfs["/tmp"] !== "rw,exec,nosuid,nodev,size=67108864" ||
    !Array.isArray(mounts) ||
    mounts.length < 1 ||
    mounts.length > 3 ||
    !mounts.some((m: unknown) => plainRecord(m) && m.destination === "/scripts") ||
    new Set(mounts.map((m: unknown) => (plainRecord(m) ? m.destination : null))).size !==
      mounts.length ||
    mounts.some(
      (m: unknown) =>
        !plainRecord(m) ||
        !equal(
          Object.keys(m).sort(),
          ["destination", "type", "readonly", "source_sha256"].sort()
        ) ||
        Reflect.get(m, "type") !== "bind" ||
        Reflect.get(m, "readonly") !== true ||
        !["/scripts", "/source", "/input"].includes(String(Reflect.get(m, "destination"))) ||
        !/^[a-f0-9]{64}$/.test(String(Reflect.get(m, "source_sha256")))
    )
  )
    throw new Error("p03_host_confinement_invalid");
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function age(time: string, now: number): void {
  const value = Date.parse(time);
  if (!Number.isFinite(value) || value > now + 60_000 || now - value > 24 * 60 * 60 * 1000)
    throw new Error("p03_host_evidence_stale");
}
export async function measureScaP03BuildClosureV3(
  store: ScaP03BootstrapArtifactReaderV1,
  probe: ScaP03BootstrapHostProbeV1,
  refs: readonly ArtifactRef[],
  contextValue?: ScaP03HostVerificationContextV1
): Promise<string> {
  const context = verificationContext(contextValue);
  if (
    refs.length === 0 ||
    refs.length > 128 ||
    refs.reduce((sum, ref) => sum + ref.byte_length, 0) > 32 * 1024 * 1024 ||
    new Set(refs.map((r) => r.artifact_id)).size !== refs.length ||
    refs.some((ref, i) => i > 0 && ref.artifact_id <= (refs[i - 1]?.artifact_id ?? ""))
  )
    throw new Error("p03_host_closure_invalid");
  const measured = [];
  for (const ref of refs) {
    context.signal.throwIfAborted();
    const immutable = readP03BootstrapBytes(store, ref);
    const current = await probe.readBuildFile(ref, context.signal);
    if (
      current.byteLength !== immutable.byteLength ||
      current.byteLength > 16 * 1024 * 1024 ||
      sha256(current) !== sha256(immutable)
    )
      throw new Error("p03_host_build_drift");
    measured.push({ ref, current_sha256: sha256(current) });
    context.reportWorkMilestone();
  }
  return sha256(canonicalJson(measured));
}

const hostAuthorityToken = Symbol("p03-closed-host-authority");
export class ScaP03ClosedHostAuthorityV3 {
  readonly #verify: (
    context: ScaP03HostVerificationContextV1
  ) => Promise<ScaP03VerifiedHostLineageV3>;
  constructor(
    token: symbol,
    verify: (context: ScaP03HostVerificationContextV1) => Promise<ScaP03VerifiedHostLineageV3>
  ) {
    if (token !== hostAuthorityToken) throw new Error("p03_host_authority_invalid");
    this.#verify = verify;
  }
  verifyLiveV3(
    contextValue?: ScaP03HostVerificationContextV1
  ): Promise<ScaP03VerifiedHostLineageV3> {
    return this.#verify(verificationContext(contextValue));
  }
}
export interface ScaP03VerifiedHostLineageV3 {
  readonly attestation_id: string;
  readonly attestation_sha256: string;
  readonly parser_identity_sha256: string;
  readonly source_oracle_ref: ArtifactRef;
  readonly source_oracle_validation_ref: ArtifactRef;
  readonly proof_sha256: string;
  readonly fidelity_binding: {
    readonly implementation_identity_ref: ArtifactRef;
    readonly qualification_profile_ref: ArtifactRef;
    readonly baseline_query_set_ref: ArtifactRef;
    readonly query_release_sha256: string;
    readonly campaign_query_release_sha256: string;
    readonly fidelity_requirements: ReturnType<
      typeof readP03BootstrapInputs
    >["profile"]["fidelity_requirements"];
  };
  readonly confinement_projections: readonly string[];
  readonly record_ref: ArtifactRef;
  readonly binding_ref: ArtifactRef;
  readonly review_ref: ArtifactRef;
  readonly attestation_ref: ArtifactRef;
  readonly runtime_id: string;
  readonly isolation_id: string;
  readonly runtime_tree_sha256: string;
  readonly implementation_identity_sha256: string;
  readonly deployment_identity_sha256: string;
  readonly profile_sha256: string;
  readonly joern_version: string;
  readonly max_num_def: number;
  readonly staging_parent_sha256: string;
  readonly timeout_ms: number;
}
export async function verifyScaP03BootstrapProofV3(input: {
  authority: ScaP03ClosedHostAuthorityV3;
  config: ScaP03DockerCandidateConfigV1;
  binding_ref: ArtifactRef;
  host_attestation_ref: ArtifactRef;
  qualification_record_ref: ArtifactRef;
  review_ref: ArtifactRef;
  verification_context?: ScaP03HostVerificationContextV1;
}): Promise<
  Pick<
    ScaP03VerifiedHostLineageV3,
    | "attestation_id"
    | "attestation_sha256"
    | "proof_sha256"
    | "fidelity_binding"
    | "parser_identity_sha256"
    | "source_oracle_ref"
    | "source_oracle_validation_ref"
  >
> {
  if (!(input.authority instanceof ScaP03ClosedHostAuthorityV3))
    throw new Error("p03_host_authority_invalid");
  const context = verificationContext(input.verification_context);
  context.signal.throwIfAborted();
  const value = await input.authority.verifyLiveV3(context);
  context.signal.throwIfAborted();
  context.reportWorkMilestone();
  const c = input.config;
  const proofDeploymentIdentity = sha256(
    canonicalJson({
      docker_executable_sha256: c.expected_docker_executable_sha256,
      docker_client_version: c.expected_docker_client_version,
      docker_server_version: c.expected_docker_server_version,
      image_id: `sha256:${value.runtime_tree_sha256}`,
      joern_version: c.expected_joern_version,
    })
  );
  const user = `${String(process.getuid?.())}:${String(process.getgid?.())}`;
  for (const projection of value.confinement_projections) {
    const posture: unknown = JSON.parse(projection);
    if (
      !plainRecord(posture) ||
      !plainRecord(posture.tmpfs) ||
      posture.pids !== c.pids ||
      posture.memory !== c.memory_bytes ||
      posture.memory_swap !== c.memory_bytes ||
      posture.nano_cpus !== Math.round(c.cpus * 1_000_000_000) ||
      posture.user !== user ||
      posture.tmpfs["/work"] !==
        `rw,exec,nosuid,nodev,size=${String(c.max_workspace_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`
    )
      throw new Error("p03_host_confinement_config_drift");
  }
  if (
    !equal(value.record_ref, input.qualification_record_ref) ||
    !equal(value.binding_ref, input.binding_ref) ||
    !equal(value.review_ref, input.review_ref) ||
    !equal(value.attestation_ref, input.host_attestation_ref) ||
    value.runtime_id !== c.runtime_id ||
    value.isolation_id !== c.isolation_id ||
    !/^[a-f0-9]{64}$/.test(value.runtime_tree_sha256) ||
    value.implementation_identity_sha256 !== c.implementation_identity_sha256 ||
    value.deployment_identity_sha256 !== c.deployment_identity_sha256 ||
    proofDeploymentIdentity !== c.deployment_identity_sha256 ||
    value.profile_sha256 !== c.isolation_profile_sha256 ||
    value.joern_version !== c.expected_joern_version ||
    value.max_num_def !== c.max_num_def ||
    value.staging_parent_sha256 !== sha256(c.staging_parent) ||
    value.timeout_ms !== c.timeout_ms
  )
    throw new Error("p03_host_config_or_proof_mismatch");
  return {
    attestation_id: value.attestation_id,
    attestation_sha256: value.attestation_sha256,
    proof_sha256: value.proof_sha256,
    fidelity_binding: value.fidelity_binding,
    parser_identity_sha256: value.parser_identity_sha256,
    source_oracle_ref: value.source_oracle_ref,
    source_oracle_validation_ref: value.source_oracle_validation_ref,
  };
}

function acceptedP01Refs(
  accepted: ScaP03FrozenProductionBindingsV1["roots"]["accepted_p01"]
): readonly ArtifactRef[] {
  return [
    accepted.request_ref,
    accepted.obligation_ledger_ref,
    accepted.campaign_manifest_core_ref,
    accepted.admission_evidence_ref,
    accepted.p01_gate_ref,
    accepted.campaign_manifest_ref,
    ...accepted.frozen_refs,
  ].filter(
    (ref, index, refs) =>
      refs.findIndex((candidate) => candidate.artifact_id === ref.artifact_id) === index
  );
}

/** Canonical custody closure for the durable production proof record. */
export function scaP03ProductionRecordUpstreamRefsV1(input: {
  readonly production_bindings: ScaP03FrozenProductionBindingsV1;
  readonly bootstrap_record_ref: ArtifactRef;
  readonly bootstrap_review_ref: ArtifactRef;
  readonly bootstrap_binding_ref: ArtifactRef;
  readonly host_attestation_ref: ArtifactRef;
}): readonly ArtifactRef[] {
  return [
    ...acceptedP01Refs(input.production_bindings.roots.accepted_p01),
    input.bootstrap_record_ref,
    input.bootstrap_review_ref,
    input.bootstrap_binding_ref,
    input.host_attestation_ref,
  ].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function buildScaP03ProductionQualificationRecordV1(input: {
  readonly production_bindings: ScaP03FrozenProductionBindingsV1;
  readonly bootstrap_record_ref: ArtifactRef;
  readonly bootstrap_review_ref: ArtifactRef;
  readonly bootstrap_binding_ref: ArtifactRef;
  readonly host_attestation_ref: ArtifactRef;
}): ScaP03ProductionQualificationRecordV1 {
  const draft = {
    schema_id: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
    schema_version: 1 as const,
    run_id: input.production_bindings.run_id,
    production_bindings_sha256: input.production_bindings.binding_sha256,
    accepted_p01: input.production_bindings.roots.accepted_p01,
    bootstrap_record_ref: input.bootstrap_record_ref,
    bootstrap_review_ref: input.bootstrap_review_ref,
    bootstrap_binding_ref: input.bootstrap_binding_ref,
    host_attestation_ref: input.host_attestation_ref,
  };
  return validateScaP03ProductionQualificationRecordV1({
    ...draft,
    record_sha256: sha256(canonicalJson(draft)),
  });
}

/** Build the durable production envelope only after live V3 proof and root verification. */
export async function createScaP03ProductionQualificationRecordV1(
  input: Parameters<typeof verifyScaP03BootstrapProofV3>[0] & {
    readonly store: ScaP03ExactArtifactReaderV1 & ScaP03BootstrapArtifactReaderV1;
    readonly production_bindings: ScaP03FrozenProductionBindingsV1;
  }
): Promise<ScaP03ProductionQualificationRecordV1> {
  readP03ProductionInputs(input.store, input.production_bindings);
  await verifyScaP03BootstrapProofV3(input);
  readP03ProductionInputs(input.store, input.production_bindings);
  return buildScaP03ProductionQualificationRecordV1({
    production_bindings: input.production_bindings,
    bootstrap_record_ref: input.qualification_record_ref,
    bootstrap_review_ref: input.review_ref,
    bootstrap_binding_ref: input.binding_ref,
    host_attestation_ref: input.host_attestation_ref,
  });
}

/** Production proof use revalidates accepted P01 roots at both edges of live V3 verification. */
export async function verifyScaP03ProductionProofV1(
  input: Parameters<typeof verifyScaP03BootstrapProofV3>[0] & {
    readonly store: ScaP03ExactArtifactReaderV1 & ScaP03BootstrapArtifactReaderV1;
    readonly production_bindings: ScaP03FrozenProductionBindingsV1;
    readonly production_record_ref: ArtifactRef;
  }
): Promise<
  Awaited<ReturnType<typeof verifyScaP03BootstrapProofV3>> & {
    readonly production_record_ref: ArtifactRef;
  }
> {
  readP03ProductionInputs(input.store, input.production_bindings);
  const productionRecordBytes = readP03BootstrapBytes(input.store, input.production_record_ref);
  const productionRecordText = new TextDecoder("utf-8", { fatal: true }).decode(
    productionRecordBytes
  );
  let productionRecordValue: unknown;
  try {
    productionRecordValue = JSON.parse(productionRecordText);
  } catch {
    throw new Error("p03_production_record_noncanonical");
  }
  if (canonicalJson(productionRecordValue) !== productionRecordText) {
    throw new Error("p03_production_record_noncanonical");
  }
  const record = validateScaP03ProductionQualificationRecordV1(productionRecordValue);
  if (
    record.run_id !== input.production_bindings.run_id ||
    record.production_bindings_sha256 !== input.production_bindings.binding_sha256 ||
    !equal(record.accepted_p01, input.production_bindings.roots.accepted_p01) ||
    !equal(record.bootstrap_record_ref, input.qualification_record_ref) ||
    !equal(record.bootstrap_review_ref, input.review_ref) ||
    !equal(record.bootstrap_binding_ref, input.binding_ref) ||
    !equal(record.host_attestation_ref, input.host_attestation_ref)
  ) {
    throw new Error("p03_production_record_binding_invalid");
  }
  checkArtifact(input.store, input.production_record_ref, {
    run_id: record.run_id,
    kind: SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
    schema_id: record.schema_id,
    schema_version: record.schema_version,
    producer: SCA_P03_PRODUCTION_EVALUATOR,
    parent: null,
    upstream: scaP03ProductionRecordUpstreamRefsV1({
      production_bindings: input.production_bindings,
      bootstrap_record_ref: input.qualification_record_ref,
      bootstrap_review_ref: input.review_ref,
      bootstrap_binding_ref: input.binding_ref,
      host_attestation_ref: input.host_attestation_ref,
    }),
  });
  const verified = await verifyScaP03BootstrapProofV3(input);
  readP03ProductionInputs(input.store, input.production_bindings);
  return { ...verified, production_record_ref: input.production_record_ref };
}

/** Strict live factory. Callback-based V2 seams are deliberately never an upgrade path. */
export function createScaP03BootstrapHostAuthorityV1(input: {
  store: ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
  record_ref: ArtifactRef;
  binding_ref: ArtifactRef;
  attempt_ref: ArtifactRef;
  cleanup_ref: ArtifactRef;
  isolation_ref: ArtifactRef;
  receipt_ref: ArtifactRef;
  reviewer_public_key: KeyObject;
  reviewer_id: string;
  reviewer_authority_id: string;
  evaluator_id: string;
  attester_id: string;
  /** Exact caller-supplied source/build closure, not a project-layout guess. */
  implementation_refs: readonly ArtifactRef[];
  runtime_package_refs: readonly ArtifactRef[];
}): ScaP03ClosedHostAuthorityV3 {
  if (
    input.reviewer_public_key.type !== "public" ||
    input.reviewer_public_key.asymmetricKeyType !== "ed25519"
  )
    throw new Error("p03_host_review_key_invalid");
  const { store } = input;
  async function verifyLiveV3(
    context: ScaP03HostVerificationContextV1
  ): Promise<ScaP03VerifiedHostLineageV3> {
    const probe =
      context.owned_execution === undefined
        ? input.probe
        : bindScaP03LocalProbeToOwnedOperationV1(
            input.probe,
            context.owned_execution.owned,
            context.owned_execution.transport
          );
    context.signal.throwIfAborted();
    const decode = (ref: ArtifactRef): unknown => {
      const bytes = readP03BootstrapBytes(store, ref);
      if (bytes.byteLength > 1024 * 1024) throw new Error("p03_host_evidence_size_invalid");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      if (canonicalJson(value) !== text) throw new Error("p03_host_noncanonical");
      return value;
    };
    const record = validateScaP03BootstrapQualificationRecordV3(decode(input.record_ref));
    const binding = validateScaP03AttestationBindingV3(decode(input.binding_ref));
    const review = validateScaP03BootstrapReviewV3(decode(binding.review_ref));
    const attestation = validateScaP03HostIsolationAttestationV1(
      decode(binding.host_attestation_ref)
    );
    const witness = validateScaP03AttemptWitnessV1(readP03BootstrapBytes(store, input.attempt_ref));
    const cleanup = validateScaP03CleanupEvidenceV2(
      readP03BootstrapBytes(store, input.cleanup_ref)
    );
    const isolation = validateScaP03IsolationEvidenceV2(
      readP03BootstrapBytes(store, input.isolation_ref)
    );
    const receipt = validateScaP03ExternalReviewReceiptV2(
      readP03BootstrapBytes(store, input.receipt_ref)
    );
    const selectionBytes = await probe.currentSelection(context.signal);
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    const selection = validateScaP03CurrentSelectionV1(selectionBytes);
    const run_id = input.record_ref.run_id;
    const custody = (
      ref: ArtifactRef,
      kind: string,
      schema_id: string,
      producer: string,
      upstream: readonly ArtifactRef[]
    ) =>
      checkArtifact(store, ref, {
        run_id,
        kind,
        schema_id,
        schema_version: Number(schema_id.slice(-1)),
        producer,
        parent: null,
        upstream,
      });
    custody(
      input.attempt_ref,
      "sca-p03-attempt-witness",
      witness.schema_id,
      P03_BOOTSTRAP_ROLES.evaluator,
      [
        record.runtime_policy_ref,
        record.implementation_identity_ref,
        record.runtime_identity_ref,
        ...record.implementation_source_refs,
      ]
    );
    custody(
      input.cleanup_ref,
      "sca-p03-cleanup-evidence",
      cleanup.schema_id,
      P03_BOOTSTRAP_ROLES.cleanup,
      [input.attempt_ref, record.runtime_policy_ref]
    );
    custody(
      input.isolation_ref,
      "sca-p03-isolation-evidence",
      isolation.schema_id,
      P03_BOOTSTRAP_ROLES.isolation,
      [input.attempt_ref, record.runtime_policy_ref]
    );
    custody(
      input.record_ref,
      "sca-p03-bootstrap-record",
      record.schema_id,
      P03_BOOTSTRAP_ROLES.evaluator,
      [
        record.fixture_corpus_ref,
        record.source_oracle_ref,
        record.source_oracle_validation_ref,
        record.source_oracle_review_ref,
        record.baseline_query_set_ref,
        record.qualification_profile_ref,
        record.runtime_policy_ref,
        record.implementation_identity_ref,
        record.runtime_identity_ref,
        ...record.fixture_content_refs,
        ...record.query_script_refs,
        ...record.query_plan_refs,
        ...record.runtime_package_refs,
        ...record.implementation_source_refs,
        input.attempt_ref,
        input.cleanup_ref,
        input.isolation_ref,
      ]
    );
    custody(
      input.receipt_ref,
      "sca-p03-reviewer-receipt",
      receipt.schema_id,
      P03_BOOTSTRAP_ROLES.reviewer,
      [
        input.record_ref,
        input.attempt_ref,
        input.cleanup_ref,
        input.isolation_ref,
        receipt.external_review_ref,
      ]
    );
    custody(
      binding.review_ref,
      "sca-p03-bootstrap-review",
      review.schema_id,
      P03_BOOTSTRAP_ROLES.reviewer,
      [
        input.receipt_ref,
        record.source_oracle_ref,
        record.source_oracle_validation_ref,
        input.attempt_ref,
        ...record.implementation_source_refs,
      ]
    );
    custody(
      binding.host_attestation_ref,
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.kind,
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.content_schema.schema_id,
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.producer,
      [
        input.record_ref,
        binding.review_ref,
        record.source_oracle_ref,
        record.source_oracle_validation_ref,
        input.attempt_ref,
        ...record.implementation_source_refs,
      ]
    );
    custody(
      input.binding_ref,
      "sca-p03-attestation-binding",
      binding.schema_id,
      P03_BOOTSTRAP_ROLES.attester,
      [
        input.record_ref,
        binding.review_ref,
        binding.host_attestation_ref,
        record.source_oracle_ref,
        record.source_oracle_validation_ref,
        input.attempt_ref,
        ...record.implementation_source_refs,
      ]
    );
    const { corpus, release, policy, profile, parser_identity_sha256 } = readP03BootstrapInputs(
      store,
      record,
      run_id
    );
    const now = probe.now().getTime();
    for (const time of [
      witness.ended_at,
      cleanup.observed_at,
      isolation.observed_at,
      receipt.reviewed_at,
      selection.selected_at,
      record.evaluated_at,
    ])
      age(time, now);
    if (
      witness.disposition !== "completed" ||
      record.evidence_class !== "live" ||
      !record.exact_expected_observations ||
      !exactP03BootstrapObservations(
        corpus,
        release,
        record.fixture_content_refs.map((ref) => {
          const bytes = readP03BootstrapBytes(store, ref);
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          );
          return validateScaP03QualificationFixtureContentV1(value);
        }),
        record,
        record.source_oracle_validation_ref
      ) ||
      attestation.parser_identity_sha256 !== parser_identity_sha256 ||
      binding.parser_identity_sha256 !== parser_identity_sha256 ||
      !equal(binding.implementation_source_refs, record.implementation_source_refs) ||
      !equal(review.implementation_source_refs, record.implementation_source_refs) ||
      !equal(binding.source_oracle_ref, record.source_oracle_ref) ||
      !equal(binding.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
      !record.cleanup_verified ||
      !record.host_isolation_verified ||
      cleanup.decision !== "PASS" ||
      isolation.decision !== "PASS" ||
      receipt.decision !== "PASS" ||
      review.decision !== "PASS" ||
      review.evidence_class !== "live" ||
      !equal(review.record_ref, input.record_ref) ||
      !equal(review.reviewer_receipt_ref, input.receipt_ref) ||
      !equal(review.attempt_witness_ref, input.attempt_ref) ||
      !equal(review.source_oracle_ref, record.source_oracle_ref) ||
      !equal(review.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
      review.reviewer_id !== input.reviewer_id ||
      review.reviewer_authority_id !== input.reviewer_authority_id ||
      attestation.profile_id !== record.profile_id ||
      attestation.runtime_id !== record.runtime_id ||
      attestation.isolation_id !== record.isolation_id ||
      attestation.runtime_tree_sha256 !== record.runtime_tree_sha256 ||
      attestation.implementation_identity_sha256 !== record.implementation_identity_sha256 ||
      attestation.deployment_identity_sha256 !== record.deployment_identity_sha256 ||
      attestation.profile_sha256 !== record.profile_sha256 ||
      !equal(attestation.source_oracle_ref, record.source_oracle_ref) ||
      !equal(attestation.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
      selection.status !== "selected" ||
      !equal(record.attempt_witness_ref, input.attempt_ref) ||
      !equal(record.cleanup_evidence_ref, input.cleanup_ref) ||
      !equal(record.host_isolation_evidence_ref, input.isolation_ref) ||
      !equal(binding.attempt_witness_ref, input.attempt_ref) ||
      !equal(binding.qualification_record_ref, input.record_ref) ||
      !equal(cleanup.attempt_ref, input.attempt_ref) ||
      !equal(isolation.attempt_ref, input.attempt_ref) ||
      !equal(isolation.policy_ref, record.runtime_policy_ref) ||
      new Set([
        cleanup.verifier_id,
        isolation.verifier_id,
        input.evaluator_id,
        input.attester_id,
        input.reviewer_id,
        input.reviewer_authority_id,
      ]).size !== 6 ||
      receipt.external_review_ref.run_id !== run_id ||
      !equal(receipt.record_ref, input.record_ref) ||
      !equal(receipt.attempt_ref, input.attempt_ref) ||
      !equal(receipt.cleanup_ref, input.cleanup_ref) ||
      !equal(receipt.isolation_ref, input.isolation_ref) ||
      !equal(selection.record_ref, input.record_ref) ||
      !equal(selection.binding_ref, input.binding_ref) ||
      selection.deployment_sha256 !== record.deployment_identity_sha256 ||
      receipt.reviewer_id !== input.reviewer_id ||
      receipt.reviewer_authority_id !== input.reviewer_authority_id ||
      receipt.evaluator_id !== input.evaluator_id ||
      receipt.attester_id !== input.attester_id ||
      new Set([input.reviewer_id, input.evaluator_id, input.attester_id]).size !== 3 ||
      witness.run_id !== input.record_ref.run_id ||
      witness.candidate_sha256 !==
        sha256(
          canonicalJson({
            run_id,
            runtime_id: record.runtime_id,
            isolation_id: record.isolation_id,
            implementation_sha256: record.implementation_identity_sha256,
            deployment_sha256: record.deployment_identity_sha256,
            profile_sha256: record.profile_sha256,
            implementation_source_refs: record.implementation_source_refs,
          })
        ) ||
      cleanup.record_input_sha256 !==
        sha256(
          canonicalJson({
            attempt_ref: input.attempt_ref,
            runtime_policy_ref: record.runtime_policy_ref,
            implementation_identity_ref: record.implementation_identity_ref,
            runtime_identity_ref: record.runtime_identity_ref,
            implementation_source_refs: record.implementation_source_refs,
          })
        ) ||
      record.runtime_id !== witness.identity.runtime_id ||
      record.isolation_id !== witness.identity.isolation_id ||
      record.runtime_tree_sha256 !== witness.identity.image_id.slice(7) ||
      record.implementation_identity_sha256 !== witness.identity.implementation_sha256 ||
      record.deployment_identity_sha256 !== witness.identity.deployment_sha256 ||
      record.runtime_package_closure_sha256 !== witness.identity.runtime_package_sha256 ||
      !equal(isolation.identity, witness.identity) ||
      Date.parse(cleanup.observed_at) < Date.parse(witness.ended_at) ||
      Date.parse(isolation.observed_at) < Date.parse(witness.ended_at) ||
      Date.parse(witness.started_at) > Date.parse(witness.ended_at) ||
      Date.parse(record.evaluated_at) < Date.parse(witness.ended_at) ||
      Date.parse(receipt.reviewed_at) <= Date.parse(record.evaluated_at) ||
      Date.parse(review.reviewed_at) !== Date.parse(receipt.reviewed_at) ||
      Date.parse(attestation.attested_at) <= Date.parse(review.reviewed_at) ||
      Date.parse(selection.selected_at) < Date.parse(attestation.attested_at)
    )
      throw new Error("p03_host_lineage_invalid");
    if (
      !equal(input.implementation_refs, record.implementation_source_refs) ||
      (await measureScaP03BuildClosureV3(
        store,
        probe,
        record.implementation_source_refs,
        context
      )) !== record.implementation_closure_sha256 ||
      (await measureScaP03BuildClosureV3(store, probe, input.runtime_package_refs, context)) !==
        record.runtime_package_closure_sha256 ||
      !equal(input.runtime_package_refs, record.runtime_package_refs)
    )
      throw new Error("p03_host_build_drift");
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    if (!equal(await probe.measureIdentity(context.signal), witness.identity))
      throw new Error("p03_host_deployment_drift");
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    if (
      !equal(
        cleanup.containers.map((c) => c.name),
        [...witness.executions.map((c) => c.name)].sort()
      ) ||
      !equal(
        isolation.containers.map((c) => c.name),
        [...witness.executions.map((c) => c.name)].sort()
      )
    )
      throw new Error("p03_host_census_incomplete");
    const daemon = await probe.containerCensus(
      witness.executions.map((c) => c.name),
      context.signal
    );
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    if (daemon.length !== 0) throw new Error("p03_host_container_present");
    for (const execution of witness.executions) {
      if (execution.id !== null && execution.confinement_projection !== null)
        validateScaP03ConfinementProjectionV3(
          execution.confinement_projection,
          execution.id,
          execution.name,
          witness.identity.image_id
        );
      const cleanupEntry = cleanup.containers.find((c) => c.name === execution.name);
      const isolationEntry = isolation.containers.find((c) => c.name === execution.name);
      if (
        execution.id === null ||
        cleanupEntry?.id !== execution.id ||
        isolationEntry?.id !== execution.id ||
        isolationEntry.confinement_sha256 !== execution.confinement_sha256 ||
        execution.confinement_projection === null ||
        sha256(execution.confinement_projection) !== execution.confinement_sha256 ||
        !cleanupEntry.absent
      )
        throw new Error("p03_host_container_lineage_invalid");
    }
    if (
      (await probe.workspaceIdentityDigest(witness.attempt_id, context.signal)) !==
      witness.workspace_sha256
    )
      throw new Error("p03_host_workspace_identity_drift");
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    await censusScaP03WorkspaceV1(
      await probe.workspacePaths(witness.attempt_id, context.signal),
      context
    );
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    // The external immutable object must itself be signed by the trusted reviewer key.
    const external = decode(receipt.external_review_ref);
    if (
      external === null ||
      typeof external !== "object" ||
      Array.isArray(external) ||
      !("signature" in external) ||
      typeof external.signature !== "string"
    )
      throw new Error("p03_host_review_invalid");
    const signed: Record<string, unknown> = Object.fromEntries(
      Object.entries(external).filter(([k]) => k !== "signature")
    );
    custody(
      receipt.external_review_ref,
      "sca-p03-external-review",
      "penny.sca-p03-external-review.v1",
      P03_BOOTSTRAP_ROLES.reviewer,
      [input.record_ref, input.attempt_ref, input.cleanup_ref, input.isolation_ref]
    );
    if (
      !equal(signed, {
        external_review_id: receipt.external_review_id,
        record_ref: input.record_ref,
        attempt_ref: input.attempt_ref,
        cleanup_ref: input.cleanup_ref,
        isolation_ref: input.isolation_ref,
        reviewer_id: input.reviewer_id,
        reviewer_authority_id: input.reviewer_authority_id,
        decision: receipt.decision,
        reviewed_at: receipt.reviewed_at,
      }) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(external.signature) ||
      !verifySignature(
        null,
        Buffer.from(canonicalJson(signed)),
        input.reviewer_public_key,
        Buffer.from(external.signature, "base64")
      )
    )
      throw new Error("p03_host_review_untrusted");
    context.signal.throwIfAborted();
    context.reportWorkMilestone();
    return {
      fidelity_binding: {
        implementation_identity_ref: record.implementation_identity_ref,
        qualification_profile_ref: record.qualification_profile_ref,
        baseline_query_set_ref: record.baseline_query_set_ref,
        query_release_sha256: release.release_sha256,
        campaign_query_release_sha256: scaP03QueryReleaseSha256V2({
          ...release,
          query_set_sha256: validateScaP03BaselineQuerySetV2(decode(record.baseline_query_set_ref))
            .query_set_sha256,
        }),
        fidelity_requirements: profile.fidelity_requirements,
      },
      confinement_projections: witness.executions.map(
        (entry) => entry.confinement_projection ?? ""
      ),
      record_ref: input.record_ref,
      binding_ref: input.binding_ref,
      review_ref: binding.review_ref,
      attestation_ref: binding.host_attestation_ref,
      runtime_id: record.runtime_id,
      isolation_id: record.isolation_id,
      runtime_tree_sha256: record.runtime_tree_sha256,
      implementation_identity_sha256: record.implementation_identity_sha256,
      deployment_identity_sha256: record.deployment_identity_sha256,
      profile_sha256: record.profile_sha256,
      joern_version: record.joern_version,
      max_num_def: record.max_num_def,
      staging_parent_sha256: policy.staging_parent_sha256,
      timeout_ms: policy.process_timeout_ms,
      attestation_id: attestation.attestation_id,
      attestation_sha256: binding.host_attestation_ref.content_digest,
      parser_identity_sha256,
      source_oracle_ref: record.source_oracle_ref,
      source_oracle_validation_ref: record.source_oracle_validation_ref,
      proof_sha256: sha256(
        canonicalJson({
          record_ref: input.record_ref,
          binding_ref: input.binding_ref,
          review_ref: binding.review_ref,
          attestation_ref: binding.host_attestation_ref,
          attempt_ref: input.attempt_ref,
          cleanup_ref: input.cleanup_ref,
          isolation_ref: input.isolation_ref,
          receipt_ref: input.receipt_ref,
          external_review_ref: receipt.external_review_ref,
          source_oracle_ref: record.source_oracle_ref,
          source_oracle_validation_ref: record.source_oracle_validation_ref,
          parser_identity_sha256,
          implementation_source_refs: record.implementation_source_refs,
          implementation_closure_sha256: record.implementation_closure_sha256,
          runtime_package_closure_sha256: record.runtime_package_closure_sha256,
          selection_sha256: sha256(selectionBytes),
        })
      ),
    };
  }
  return new ScaP03ClosedHostAuthorityV3(hostAuthorityToken, verifyLiveV3);
}
