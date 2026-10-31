import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
  SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA,
  validateScaP03AttemptWitnessV1,
  validateScaP03CleanupEvidenceV2,
  validateScaP03IsolationEvidenceV2,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  validateScaP03RuntimePolicyV1,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  checkArtifact,
  P03_BOOTSTRAP_ROLES,
  readP03BootstrapBytes,
  type ScaP03BootstrapArtifactReaderV1,
} from "./p03-bootstrap.js";
import {
  censusScaP03WorkspaceV1,
  validateScaP03ConfinementProjectionV3,
  type ScaP03BootstrapHostProbeV1,
} from "./p03-bootstrap-host.js";
import type { ScaP03DockerCandidateConfigV1 } from "./p03-docker-runtime.js";

const seal = (draft: Record<string, unknown>): Uint8Array =>
  Buffer.from(canonicalJson({ ...draft, evidence_sha256: sha256(canonicalJson(draft)) }));
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Two independent host-verifier decisions. A failed observation is an immutable diagnostic, never a PASS. */
export async function issueScaP03PostRunEvidenceV3(input: {
  store: ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
  config: ScaP03DockerCandidateConfigV1;
  attempt_ref: ArtifactRef;
  policy_ref: ArtifactRef;
  implementation_identity_ref: ArtifactRef;
  runtime_identity_ref: ArtifactRef;
  implementation_source_refs: readonly ArtifactRef[];
}): Promise<{ cleanup_bytes: Uint8Array; isolation_bytes: Uint8Array }> {
  const { store, probe, attempt_ref, policy_ref, config } = input;
  const attempt = validateScaP03AttemptWitnessV1(readP03BootstrapBytes(store, attempt_ref));
  if (
    input.implementation_source_refs.length === 0 ||
    input.implementation_source_refs.length > 128 ||
    input.implementation_source_refs.reduce((total, ref) => total + ref.byte_length, 0) >
      32 * 1024 * 1024 ||
    input.implementation_source_refs.some(
      (ref, i) =>
        i > 0 && ref.artifact_id <= (input.implementation_source_refs[i - 1]?.artifact_id ?? "")
    )
  )
    throw new Error("p03_issuer_implementation_refs_invalid");
  checkArtifact(store, attempt_ref, {
    run_id: attempt.run_id,
    kind: "sca-p03-attempt-witness",
    schema_id: attempt.schema_id,
    schema_version: 1,
    producer: P03_BOOTSTRAP_ROLES.evaluator,
    parent: null,
    upstream: [
      policy_ref,
      input.implementation_identity_ref,
      input.runtime_identity_ref,
      ...input.implementation_source_refs,
    ],
  });
  checkArtifact(store, policy_ref, {
    run_id: attempt.run_id,
    kind: SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy.kind,
    schema_id: SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy.content_schema.schema_id,
    schema_version: SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy.content_schema.schema_version,
    producer: SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy.producer,
    parent: null,
    upstream: [],
  });
  const policyBytes = readP03BootstrapBytes(store, policy_ref);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(policyBytes);
  const raw: unknown = JSON.parse(text);
  if (canonicalJson(raw) !== text) throw new Error("p03_issuer_policy_noncanonical");
  const policy = validateScaP03RuntimePolicyV1(raw);
  if (
    policy.staging_parent_sha256 !== sha256(config.staging_parent) ||
    policy.process_timeout_ms !== config.timeout_ms ||
    policy.max_num_def !== config.max_num_def ||
    attempt.disposition !== "completed" ||
    attempt.executions.length === 0
  )
    throw new Error("p03_issuer_input_invalid");
  const executions = [...attempt.executions].sort((a, b) => a.name.localeCompare(b.name));
  const names = executions.map((entry) => entry.name);
  // Independent daemon query; never trust removed/absence_observed flags alone.
  let daemon: readonly { name: string; id: string }[] | null = null;
  try {
    daemon = await probe.containerCensus(names);
  } catch {
    /* fail-closed diagnostic */
  }
  let workspace = false;
  try {
    if ((await probe.workspaceIdentityDigest(attempt.attempt_id)) === attempt.workspace_sha256) {
      await censusScaP03WorkspaceV1(await probe.workspacePaths(attempt.attempt_id));
      workspace = true;
    }
  } catch {
    /* fail-closed diagnostic */
  }
  let identity = false;
  let measuredIdentity = attempt.identity;
  try {
    measuredIdentity = await probe.measureIdentity();
    identity = same(measuredIdentity, attempt.identity);
  } catch {
    /* fail-closed diagnostic */
  }
  const absent = daemon !== null && daemon.length === 0;
  const cleanupDraft = {
    schema_id: SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
    schema_version: 2,
    attempt_ref,
    record_input_sha256: sha256(
      canonicalJson({
        attempt_ref,
        runtime_policy_ref: policy_ref,
        implementation_identity_ref: input.implementation_identity_ref,
        runtime_identity_ref: input.runtime_identity_ref,
        implementation_source_refs: input.implementation_source_refs,
      })
    ),
    verifier_id: P03_BOOTSTRAP_ROLES.cleanup,
    observed_at: probe.now().toISOString(),
    containers: executions.map((entry) => ({
      name: entry.name,
      id: entry.id,
      absent: absent && entry.id !== null,
    })),
    workspace_absent_or_empty: workspace,
    complete_census: daemon !== null,
    decision:
      absent && workspace && identity && executions.every((entry) => entry.id !== null)
        ? "PASS"
        : "FAIL",
  };
  const cleanup_bytes = seal(cleanupDraft);
  validateScaP03CleanupEvidenceV2(cleanup_bytes);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  let confined = uid !== undefined && gid !== undefined && identity && absent && workspace;
  for (const entry of executions) {
    try {
      if (
        entry.id === null ||
        entry.confinement_projection === null ||
        sha256(entry.confinement_projection) !== entry.confinement_sha256
      )
        throw new Error("p03_issuer_projection_missing");
      validateScaP03ConfinementProjectionV3(
        entry.confinement_projection,
        entry.id,
        entry.name,
        attempt.identity.image_id
      );
      const posture: unknown = JSON.parse(entry.confinement_projection);
      if (
        posture === null ||
        typeof posture !== "object" ||
        Array.isArray(posture) ||
        !("pids" in posture) ||
        posture.pids !== config.pids ||
        !("memory" in posture) ||
        posture.memory !== config.memory_bytes ||
        !("memory_swap" in posture) ||
        posture.memory_swap !== config.memory_bytes ||
        !("nano_cpus" in posture) ||
        posture.nano_cpus !== Math.round(config.cpus * 1_000_000_000) ||
        !("user" in posture) ||
        posture.user !== `${String(uid)}:${String(gid)}` ||
        !("tmpfs" in posture) ||
        posture.tmpfs === null ||
        typeof posture.tmpfs !== "object" ||
        !("/work" in posture.tmpfs) ||
        posture.tmpfs["/work"] !==
          `rw,exec,nosuid,nodev,size=${String(config.max_workspace_bytes)},mode=0700,uid=${String(uid)},gid=${String(gid)}`
      )
        throw new Error("p03_issuer_posture_drift");
    } catch {
      confined = false;
    }
  }
  const isolationDraft = {
    schema_id: SCA_P03_ISOLATION_EVIDENCE_V2_SCHEMA,
    schema_version: 2,
    attempt_ref,
    policy_ref,
    verifier_id: P03_BOOTSTRAP_ROLES.isolation,
    observed_at: probe.now().toISOString(),
    identity: measuredIdentity,
    containers: executions.map((entry) => ({
      name: entry.name,
      id: entry.id,
      confinement_sha256: entry.confinement_sha256,
    })),
    decision: confined ? "PASS" : "FAIL",
  };
  // Completed witnesses necessarily have ids/digests; malformed input cannot be represented as evidence.
  const isolation_bytes = seal(isolationDraft);
  validateScaP03IsolationEvidenceV2(isolation_bytes);
  return { cleanup_bytes, isolation_bytes };
}
