#!/usr/bin/env node
import {
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/contracts.js";
import { createScaP03BoundVerificationReaderV1 } from "./p03-verification-reader.js";
import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../orchestration/dist/contracts.js";
import {
  ScaP03CurrentBootstrapSampleV1Schema,
  type ScaP03CurrentBootstrapSampleV1,
} from "../../orchestration/dist/sca/p03-activation-host.js";
import { validateScaP03P01RuntimeIdentityRootV1 } from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import {
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  validateScaP03QualificationProfileV2,
  validateScaP03RuntimePolicyV1,
  validateScaP03HostIsolationAttestationV1,
  validateScaP03ImplementationIdentityV1,
  parseSourceOracleValidationReceiptBytes,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  validateScaP03AttestationBindingV3,
  validateScaP03BootstrapQualificationRecordV3,
  validateScaP03BootstrapReviewV3,
  validateScaP03CurrentSelectionV1,
  validateScaP03ExternalReviewReceiptV2,
  SCA_P03_PRODUCTION_EVALUATOR,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
  SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  freezeScaP03BootstrapV3,
  freezeScaP03ProductionV1,
  type ScaP03FrozenBuilderResultV3,
  type ScaP03FrozenProductionResultV1,
} from "./p03-bootstrap-freeze.js";
import {
  P03_BOOTSTRAP_ROLES,
  type ScaP03BootstrapVerificationReaderV1,
  readP03BootstrapBytes,
  readP03BootstrapInputs,
  readP03ProductionInputs,
} from "./p03-bootstrap.js";
import {
  createScaP03BootstrapHostAuthorityV1,
  createScaP03ProductionQualificationRecordV1,
  measureScaP03BuildClosureV3,
  scaP03ProductionRecordUpstreamRefsV1,
  verifyScaP03BootstrapProofV3,
  verifyScaP03ProductionProofV1,
  type ScaP03BootstrapHostProbeV1,
} from "./p03-bootstrap-host.js";
import { issueScaP03PostRunEvidenceV3 } from "./p03-bootstrap-issuers.js";
import {
  readStableScaP03FileV1,
  createScaP03LocalHostProbeDeterministicTestOnlyV1,
  type ScaP03ProbeCommandV1,
  createScaP03LocalHostProbeV1,
  createScaP03OwnedLocalHostProbeV1,
} from "./p03-bootstrap-local-probe.js";
import { measureScaP03BootstrapEnvironmentV1 } from "./p03-bootstrap-measure.js";
import {
  measureScaP03BootstrapCandidateV3,
  measureScaP03ProductionCandidateV1,
  finalizeScaP03BootstrapRecordV3,
  finalizeScaP03ProductionBootstrapRecordV1,
} from "./p03-bootstrap-v3.js";
import { ScaP03WorkspaceRegistryV1 } from "./p03-bootstrap-workspaces.js";
import type { ScaP03HostWitnessSinkV1 } from "./p03-bootstrap-witness.js";
import { persistScaP03HostEvidenceV3 } from "./p03-bootstrap-writer.js";
import {
  dockerCommandV1,
  createScaP03DockerJoernCandidateV1,
  verifyScaP03DockerConfigV1,
  type DockerRunnerV1,
  type ScaP03DockerCandidateV1,
} from "./p03-docker-runtime.js";
import {
  ScaP03ProductionSampleInputV1Schema,
  type ScaP03ProductionSampleInputV1,
  assertScaP03ProtectedPathV1,
  scaP03ProductionManifestProtectedPathsV1,
} from "./p03-production-sampler.js";
import { validateSourceOracleBytes } from "./p03-source-oracle.js";
import {
  ScaP03CliExternalReviewSchema,
  ScaP03CliFreezeHandoffSchema,
  ScaP03CliFreezeManifestSchema,
  ScaP03CliSealManifestSchema,
  ScaP03CliSealedHandoffSchema,
  ScaP03CliVerifyManifestSchema,
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionFreezeManifestSchema,
  ScaP03CliProductionSealManifestSchema,
  ScaP03CliProductionSealedHandoffSchema,
  ScaP03CliProductionVerifyManifestSchema,
  parseScaP03CliCanonical,
  scaP03CliMappingSha256,
  validateScaP03CliPaths,
  type ScaP03CliFreezeHandoff,
  type ScaP03CliSealManifest,
  type ScaP03CliVerifyManifest,
  type ScaP03CliProductionFreezeHandoff,
  type ScaP03CliProductionSealManifest,
  type ScaP03CliProductionVerifyManifest,
} from "./p03-bootstrap-cli-contracts.js";

import { isCanonicalHostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/owner.js";
const offlineSamplingToken = Symbol("p03-offline-sampling-only");
const nativeSamplingToken = Symbol("p03-native-sealed-sampling");
import {
  ScaP03InitialAuthorizationV1,
  type ScaP03InitialProposalV1,
  type ScaP03InitialGateBindingV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { ScaP03InitialNativeHostV1 } from "./p03-initial-host.js";
import type { ScaP03SealedBootstrapInputsV1 } from "./p03-initial-live.js";
import { createScaP03OwnedDockerTransportV1 } from "./p03-live-transport.js";

async function sample(
  inputValue: ScaP03ProductionSampleInputV1,
  command: ScaP03ProbeCommandV1,
  guarded?: { readonly context: HostOperationExecutionContextV1; readonly store: ArtifactStore }
): Promise<ScaP03CurrentBootstrapSampleV1> {
  const input = validateContract(
    ScaP03ProductionSampleInputV1Schema,
    inputValue,
    "P03 production sample input"
  );
  validateScaP03CliPaths([input.manifest_path]);
  let output: string | undefined;
  await runScaP03BootstrapCliV1(
    [
      "sample-production",
      "--manifest",
      input.manifest_path,
      "--manifest-sha256",
      input.manifest_sha256,
    ],
    {
      offline_sampling_token: offlineSamplingToken,
      ...(guarded === undefined ? {} : { guarded_verification: guarded }),
      createProbe: (probeInput) =>
        createScaP03LocalHostProbeDeterministicTestOnlyV1(probeInput, command),
      emit: (value) => {
        if (output !== undefined) throw new Error("p03_sampler_multiple_outputs");
        output = value;
      },
    }
  );
  if (output === undefined) throw new Error("p03_sampler_verification_unavailable");
  return parseScaP03CliCanonical(ScaP03CurrentBootstrapSampleV1Schema, Buffer.from(output));
}
/** ONLY the existing signed native initial operation can dispatch sealed verification.
 * Neither a manifest, current PASS nor a structural user/model boolean is authority. */
export async function sampleScaP03ProductionBootstrapV1(
  input: ScaP03ProductionSampleInputV1,
  admitted: {
    context: HostOperationExecutionContextV1;
    store: ArtifactStore;
    authorization: ScaP03InitialAuthorizationV1;
    proposal: ScaP03InitialProposalV1;
    gate: ScaP03InitialGateBindingV1;
    native_host: ScaP03InitialNativeHostV1;
    sealed_inputs: ScaP03SealedBootstrapInputsV1;
    deterministic_test_transport?: DockerRunnerV1;
  }
): Promise<ScaP03CurrentBootstrapSampleV1> {
  if (
    !isCanonicalHostOperationExecutionContextV1(admitted.context) ||
    !(admitted.authorization instanceof ScaP03InitialAuthorizationV1) ||
    !(admitted.native_host instanceof ScaP03InitialNativeHostV1) ||
    admitted.proposal.effect !== "bootstrap_verification"
  )
    throw new Error("p03_sealed_native_authority_required");
  const assertAuthority = () => {
    admitted.authorization.assertEffect(admitted.context, admitted.proposal, admitted.gate);
    admitted.native_host.assertSealedInputs(admitted.sealed_inputs, admitted.proposal);
  };
  assertAuthority();
  const c = admitted.native_host.capsule;
  if (
    c.schema_id !== "penny.sca-p03-sealed-bootstrap-capsule.v1" ||
    canonicalJson(c.verification) !== canonicalJson(input) ||
    admitted.context.journal.lifecycle !== "lease_acquired"
  )
    throw new Error("p03_sealed_owned_invocation_invalid");
  // Guard is durable before temporary configuration/probe/workspace effects. ONE fence.
  admitted.context.beginSubmission();
  const seed = sha256(admitted.context.journal.operation_record_id);
  admitted.context.recordRemoteAccepted(
    canonicalJson({
      schema_version: 1,
      seed,
      count: admitted.proposal.resources.max_commands,
      label: seed,
    })
  );
  const owned = {
    context: admitted.context,
    resources: admitted.proposal.resources,
    assertAuthority,
  };
  const transport =
    admitted.deterministic_test_transport ??
    createScaP03OwnedDockerTransportV1({
      endpoint: {
        executable: c.config.docker_executable,
        executable_sha256: c.config.expected_docker_executable_sha256,
        socket: c.docker_socket,
        image_ref: c.config.image_ref,
      },
      ...owned,
    });
  let output: string | undefined;
  let settled: () => void = () => {};
  const cleanupSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  admitted.context.registerRemoteCancellation(async (signal) => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void cleanupSettled.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
    return {
      remote_disposition: "may_continue",
      reason_code: "p03_sealed_cleanup_requires_inspection",
    };
  });
  try {
    await runScaP03BootstrapCliV1(
      [
        "sample-production",
        "--manifest",
        input.manifest_path,
        "--manifest-sha256",
        input.manifest_sha256,
      ],
      {
        native_sampling_token: nativeSamplingToken,
        guarded_verification: { context: admitted.context, store: admitted.store },
        createProbe: (local) => createScaP03OwnedLocalHostProbeV1(local, owned, transport),
        emit(value) {
          if (output !== undefined) throw new Error("p03_sampler_multiple_outputs");
          output = value;
        },
      }
    );
  } finally {
    settled();
  }
  assertAuthority();
  if (output === undefined) throw new Error("p03_sampler_verification_unavailable");
  return parseScaP03CliCanonical(ScaP03CurrentBootstrapSampleV1Schema, Buffer.from(output));
}
/** Offline tests only: replaces Docker observations, never authority, custody, proof or sample validation. */
export function sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(
  input: ScaP03ProductionSampleInputV1,
  command: ScaP03ProbeCommandV1,
  guarded?: { readonly context: HostOperationExecutionContextV1; readonly store: ArtifactStore }
): Promise<ScaP03CurrentBootstrapSampleV1> {
  return sample(input, command, guarded);
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const digest = (draft: Record<string, unknown>, key: string): Record<string, unknown> => ({
  ...draft,
  [key]: sha256(canonicalJson(draft)),
});
function decode(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_cli_noncanonical");
  return value;
}
function directory(dir: string): void {
  validateScaP03CliPaths([dir]);
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(dir) !== dir ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("p03_cli_directory_custody_invalid");
}
function atomicPrivate(file: string, bytes: Uint8Array, replace = false): void {
  validateScaP03CliPaths([file]);
  directory(path.dirname(file));
  let before: { ino: number; dev: number } | undefined;
  try {
    const named = lstatSync(file);
    before = { ino: named.ino, dev: named.dev };
    if (
      !named.isFile() ||
      named.nlink !== 1 ||
      named.uid !== process.getuid?.() ||
      (named.mode & 0o777) !== 0o600
    )
      throw new Error("p03_cli_existing_file_invalid");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (before !== undefined) {
    const current = readStableScaP03FileV1(file, 1024 * 1024, true);
    if (!replace) {
      if (!Buffer.from(current).equals(bytes)) throw new Error("p03_cli_adopt_conflict");
      return;
    }
  }
  const temporary = path.join(path.dirname(file), `.p03-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    const current = (() => {
      try {
        return lstatSync(file);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    })();
    if (before?.ino !== current?.ino || before?.dev !== current?.dev)
      throw new Error("p03_cli_file_raced");
    if (replace) renameSync(temporary, file);
    else {
      linkSync(temporary, file);
      unlinkSync(temporary);
    }
    const dir = openSync(
      path.dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
    throw error;
  }
}
function persistExact(
  store: ArtifactStore,
  run_id: string,
  kind: string,
  operation_id: string,
  producer: string,
  schema_id: string,
  schema_version: number,
  content: Uint8Array,
  upstream_refs: readonly ArtifactRef[]
): ArtifactRef {
  const metadata: Extract<OutputArtifactMetadata, { schema_version: 2 }> = {
    schema_version: 2,
    run_id,
    phase: "SCA-P03",
    branch_id: null,
    kind,
    operation_id,
    version: 1,
    producer,
    media_type: "application/json",
    content_schema: { schema_id, schema_version },
    parent_ref: null,
    upstream_refs: [...upstream_refs],
  };
  const expected = previewArtifactRef({ metadata, content });
  const version = store.lastVersion(run_id, "SCA-P03", null, kind, operation_id);
  if (version > 1) throw new Error("p03_cli_artifact_slot_conflict");
  const ref =
    version === 0 ? store.persist({ metadata, content }) : store.refById(expected.artifact_id);
  if (
    ref === undefined ||
    !same(ref, expected) ||
    !same(store.metadata(ref), metadata) ||
    !Buffer.from(store.read(ref)).equals(content)
  )
    throw new Error("p03_cli_artifact_adopt_conflict");
  return ref;
}
function persistEvidence(
  store: ArtifactStore,
  run_id: string,
  kind: Parameters<typeof persistScaP03HostEvidenceV3>[0]["kind"],
  bytes: Uint8Array,
  upstream_refs: readonly ArtifactRef[]
): ArtifactRef {
  const operation_id = `bootstrap-${kind}`;
  if (store.lastVersion(run_id, "SCA-P03", null, kind, operation_id) === 0)
    return persistScaP03HostEvidenceV3({ store, run_id, kind, operation_id, bytes, upstream_refs });
  const raw = decode(bytes);
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schema_id" in raw) ||
    !("schema_version" in raw) ||
    typeof raw.schema_id !== "string" ||
    typeof raw.schema_version !== "number"
  )
    throw new Error("p03_cli_evidence_invalid");
  const producer =
    kind === "sca-p03-cleanup-evidence"
      ? P03_BOOTSTRAP_ROLES.cleanup
      : kind === "sca-p03-isolation-evidence"
        ? P03_BOOTSTRAP_ROLES.isolation
        : P03_BOOTSTRAP_ROLES.evaluator;
  return persistExact(
    store,
    run_id,
    kind,
    operation_id,
    producer,
    raw.schema_id,
    raw.schema_version,
    bytes,
    upstream_refs
  );
}
function loadKey(file: string, fingerprint: string): KeyObject {
  const bytes = readStableScaP03FileV1(file, 16 * 1024, true);
  const key = createPublicKey(Buffer.from(bytes));
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519" ||
    sha256(key.export({ format: "der", type: "spki" })) !== fingerprint
  )
    throw new Error("p03_cli_reviewer_key_untrusted");
  return key;
}
function assertExactImplementationRoles(
  store: ScaP03BootstrapVerificationReaderV1,
  b: {
    implementation_identity_ref: ArtifactRef;
    implementation_identity_sha256: string;
    implementation_source_refs: readonly ArtifactRef[];
  }
): void {
  const identity = validateScaP03ImplementationIdentityV1(
    decode(readP03BootstrapBytes(store, b.implementation_identity_ref))
  );
  if (identity.implementation_sha256 !== b.implementation_identity_sha256)
    throw new Error("p03_cli_implementation_identity_drift");
  const roles = ["source", "build", "normalizer", "query_runner"] as const;
  for (const role of roles) {
    const members = b.implementation_source_refs.filter((ref) =>
      ref.operation_id.startsWith(`freeze-implementation-${role}-`)
    );
    if (
      members.length < 1 ||
      members.length > 64 ||
      members.some((ref, index) => {
        const prefix = `freeze-implementation-${role}-`;
        const suffix = ref.operation_id.slice(prefix.length);
        return (
          ref.kind !== "sca-p03-implementation-source" ||
          !/^(0|[1-9][0-9]?)$/.test(suffix) ||
          Number(suffix) >= members.length ||
          members.some((other, i) => i < index && other.operation_id === ref.operation_id)
        );
      }) ||
      new Set(members.map((ref) => ref.operation_id)).size !== members.length
    )
      throw new Error("p03_cli_implementation_roles_invalid");
    const ordered = members
      .map((ref) => ({ ref, current_sha256: sha256(readP03BootstrapBytes(store, ref)) }))
      .sort((a, c) => a.ref.artifact_id.localeCompare(c.ref.artifact_id));
    if (sha256(canonicalJson(ordered)) !== identity[`${role}_sha256`])
      throw new Error("p03_cli_implementation_identity_drift");
  }
  if (
    b.implementation_source_refs.length !==
    roles.reduce(
      (sum, role) =>
        sum +
        b.implementation_source_refs.filter((ref) =>
          ref.operation_id.startsWith(`freeze-implementation-${role}-`)
        ).length,
      0
    )
  )
    throw new Error("p03_cli_implementation_roles_invalid");
}
type AnySealManifest =
  | ScaP03CliSealManifest
  | ScaP03CliVerifyManifest
  | ScaP03CliProductionSealManifest
  | ScaP03CliProductionVerifyManifest;

function mapping(manifest: AnySealManifest): {
  files: Record<string, string>;
  sha256: string;
} {
  validateScaP03CliPaths([
    ...manifest.implementation.map((x) => x.path),
    ...manifest.runtime_packages.map((x) => x.path),
  ]);
  const refs = [
    ...manifest.implementation.map((x) => x.ref),
    ...manifest.runtime_packages.map((x) => x.ref),
  ];
  if (
    new Set(refs.map((r) => r.artifact_id)).size !== refs.length ||
    refs.some((ref) => ref.run_id !== manifest.run_id)
  )
    throw new Error("p03_cli_build_mapping_invalid");
  return {
    files: Object.fromEntries<string>([
      ...manifest.implementation.map((x): [string, string] => [x.ref.artifact_id, x.path]),
      ...manifest.runtime_packages.map((x): [string, string] => [x.ref.artifact_id, x.path]),
    ]),
    sha256: scaP03CliMappingSha256(manifest.implementation),
  };
}
type ReadyBootstrapHandoff = ScaP03CliFreezeHandoff & {
  record_ref: ArtifactRef;
  cleanup_ref: ArtifactRef;
  isolation_ref: ArtifactRef;
};
type ReadyProductionHandoff = ScaP03CliProductionFreezeHandoff & {
  record_ref: ArtifactRef;
  cleanup_ref: ArtifactRef;
  isolation_ref: ArtifactRef;
};
type ReadyHandoff = ReadyBootstrapHandoff | ReadyProductionHandoff;
const productionManifest = (
  manifest: AnySealManifest
): manifest is ScaP03CliProductionSealManifest | ScaP03CliProductionVerifyManifest =>
  manifest.schema_id === "penny.sca-p03-cli-production-seal-manifest.v1" ||
  manifest.schema_id === "penny.sca-p03-cli-production-verify-manifest.v1";
const productionHandoff = (handoff: ReadyHandoff): handoff is ReadyProductionHandoff =>
  handoff.schema_id === "penny.sca-p03-cli-production-freeze-handoff.v1";
const productionFrozen = (
  frozen: ScaP03FrozenBuilderResultV3 | ScaP03FrozenProductionResultV1
): frozen is ScaP03FrozenProductionResultV1 => "production_bindings" in frozen;
function freezeHandoff(manifest: AnySealManifest): ReadyHandoff {
  const bytes = readStableScaP03FileV1(manifest.freeze_handoff_path, 1024 * 1024, true);
  if (sha256(bytes) !== manifest.freeze_handoff_sha256) throw new Error("p03_cli_handoff_drift");
  const handoff = productionManifest(manifest)
    ? parseScaP03CliCanonical(ScaP03CliProductionFreezeHandoffSchema, bytes)
    : parseScaP03CliCanonical(ScaP03CliFreezeHandoffSchema, bytes);
  if (
    handoff.store_root !== manifest.store_root ||
    handoff.project_id !== manifest.project_id ||
    handoff.run_id !== manifest.run_id ||
    handoff.status !== "ready_for_review" ||
    handoff.record_ref === null ||
    handoff.cleanup_ref === null ||
    handoff.isolation_ref === null ||
    handoff.mapping_sha256 !== mapping(manifest).sha256 ||
    !same(
      handoff.bindings.implementation_source_refs,
      manifest.implementation
        .map((x) => x.ref)
        .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
    ) ||
    !same(
      handoff.bindings.runtime_package_refs,
      manifest.runtime_packages
        .map((x) => x.ref)
        .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
    )
  )
    throw new Error("p03_cli_handoff_mismatch");
  return {
    ...handoff,
    record_ref: handoff.record_ref,
    cleanup_ref: handoff.cleanup_ref,
    isolation_ref: handoff.isolation_ref,
  };
}
function makeProbe(
  manifest: AnySealManifest,
  store: ScaP03BootstrapVerificationReaderV1,
  registry: ScaP03WorkspaceRegistryV1,
  injected?: (
    input: Parameters<typeof createScaP03LocalHostProbeV1>[0]
  ) => ScaP03BootstrapHostProbeV1
): ScaP03BootstrapHostProbeV1 {
  const local = {
    config: manifest.config,
    store,
    build_files: mapping(manifest).files,
    runtime_package_refs: manifest.runtime_packages.map((x) => x.ref),
    current_selection_path: path.join(manifest.working_dir, "selection.json"),
    registry,
  };
  return injected === undefined ? createScaP03LocalHostProbeV1(local) : injected(local);
}
export interface ScaP03BootstrapCliDepsV1 {
  /** Internal offline-only sampling token, never supplied by the executable main guard. */
  readonly offline_sampling_token?: symbol;
  readonly native_sampling_token?: symbol;
  /** Real owner context + canonical store for offline guarded-operation qualification. */
  readonly guarded_verification?: {
    readonly context: HostOperationExecutionContextV1;
    readonly store: ArtifactStore;
  };
  readonly dockerRunner?: DockerRunnerV1;
  readonly createProbe?: (
    input: Parameters<typeof createScaP03LocalHostProbeV1>[0]
  ) => ScaP03BootstrapHostProbeV1;
  /** Offline contract-test seam; the executable's main guard supplies no dependencies. */
  readonly deterministicTestCandidate?: (
    sink: ScaP03HostWitnessSinkV1
  ) => Promise<ScaP03DockerCandidateV1>;
  readonly emit?: (value: string) => void;
}
export async function runScaP03BootstrapCliV1(
  argv: readonly string[],
  deps: ScaP03BootstrapCliDepsV1 = {}
): Promise<void> {
  if (
    (argv[0] === "sample-production"
      ? argv.length !== 5 ||
        argv[3] !== "--manifest-sha256" ||
        !/^[a-f0-9]{64}$/.test(argv[4] ?? "")
      : argv.length !== 3) ||
    argv[1] !== "--manifest" ||
    ![
      "freeze-record",
      "freeze-production-record",
      "seal",
      "seal-production",
      "verify",
      "verify-production",
      "sample-production",
    ].includes(argv[0] ?? "")
  )
    throw new Error(
      "usage: p03-bootstrap {freeze-record|freeze-production-record|seal|seal-production|verify|verify-production|sample-production} --manifest ABS_PATH [--manifest-sha256 SHA256]"
    );
  if (
    argv[0] === "sample-production" &&
    deps.offline_sampling_token !== offlineSamplingToken &&
    deps.native_sampling_token !== nativeSamplingToken
  )
    throw new Error("p03_guarded_bootstrap_verification_unavailable");
  // Native initial work has its own canonical owner adapter. A standalone executable/manifest,
  // interactive same-UID shell or signing custody is not an authenticated initial operator grant.
  // These function-valued dependencies are existing offline contract-test seams, never CLI flags.
  if (
    deps.offline_sampling_token !== offlineSamplingToken &&
    deps.native_sampling_token !== nativeSamplingToken &&
    deps.dockerRunner === undefined &&
    deps.createProbe === undefined &&
    deps.deterministicTestCandidate === undefined
  )
    throw new Error("p03_trusted_initial_operator_required");
  const file = argv[2];
  if (file === undefined) throw new Error("p03_cli_manifest_missing");
  const bytes = readStableScaP03FileV1(file, 1024 * 1024, true);
  if (argv[0] === "sample-production" && sha256(bytes) !== argv[4])
    throw new Error("p03_cli_manifest_drift");
  const emit = deps.emit ?? ((value: string) => process.stdout.write(`${value}\n`));
  if (argv[0] === "freeze-record" || argv[0] === "freeze-production-record") {
    const production = argv[0] === "freeze-production-record";
    const m = production
      ? parseScaP03CliCanonical(ScaP03CliProductionFreezeManifestSchema, bytes)
      : parseScaP03CliCanonical(ScaP03CliFreezeManifestSchema, bytes);
    directory(m.working_dir);
    directory(m.config.staging_parent);
    validateScaP03CliPaths([
      m.store_root,
      m.working_dir,
      m.oracle_path,
      m.source_oracle_review_path,
      m.profile_path,
      m.policy_path,
      ...m.fixtures.map((x) => x.path),
      ...m.implementation.map((x) => x.path),
    ]);
    const oracle_bytes = readStableScaP03FileV1(m.oracle_path, 1024 * 1024, true);
    const oracle = validateSourceOracleBytes(oracle_bytes);
    const review_bytes = readStableScaP03FileV1(m.source_oracle_review_path, 1024 * 1024, true);
    const profile = validateScaP03QualificationProfileV2(
      decode(readStableScaP03FileV1(m.profile_path, 1024 * 1024, true))
    );
    const policy = validateScaP03RuntimePolicyV1(
      decode(readStableScaP03FileV1(m.policy_path, 1024 * 1024, true))
    );
    if (policy.staging_parent_sha256 !== sha256(m.config.staging_parent))
      throw new Error("p03_cli_staging_parent_mismatch");
    const fixtures = m.fixtures.map((entry) => ({
      language: entry.language,
      bytes: readStableScaP03FileV1(entry.path, 16 * 1024 * 1024, true),
    }));
    const implementation = m.implementation.map((entry) => {
      const bytes = readStableScaP03FileV1(entry.path, 16 * 1024 * 1024, true);
      return {
        ...entry,
        bytes,
        current_bytes: readStableScaP03FileV1(entry.path, 16 * 1024 * 1024, true),
      };
    });
    if ("accepted_p01" in m) {
      const preflightStore = ArtifactStore.openExisting(m.store_root, {
        projectId: m.project_id,
      });
      try {
        validateScaP03P01RuntimeIdentityRootV1({
          store: preflightStore,
          accepted_p01: m.accepted_p01,
          runtime: {
            root_tool_id: m.root_tool_id,
            toolchain_ref: m.toolchain_ref,
            root_executable_ref: m.root_executable_ref,
            root_measurement_ref: m.root_measurement_ref,
            joern_version: m.config.expected_joern_version,
          },
        });
      } finally {
        preflightStore.close();
      }
    }
    const measured = await measureScaP03BootstrapEnvironmentV1(m, deps.dockerRunner);
    const store = m.create_store
      ? ArtifactStore.provision(m.store_root, { projectId: m.project_id })
      : ArtifactStore.openExisting(m.store_root, { projectId: m.project_id });
    try {
      const oracle_ref = previewArtifactRef({
        metadata: {
          schema_version: 2,
          run_id: m.run_id,
          phase: "SCA-P03",
          branch_id: null,
          kind: "sca-p03-source-oracle",
          operation_id: "freeze-oracle",
          version: 1,
          producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
          media_type: "application/json",
          content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA, schema_version: 2 },
          parent_ref: null,
          upstream_refs: [],
        },
        content: canonicalJson(oracle),
      });
      const review_ref = persistExact(
        store,
        m.run_id,
        "sca-p03-source-oracle-review",
        "independent-review",
        SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
        SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
        1,
        review_bytes,
        [oracle_ref]
      );
      const priorValidation = store.refFor(
        m.run_id,
        "SCA-P03",
        null,
        "sca-p03-source-oracle-validation",
        "freeze-oracle-validation",
        1
      );
      const validated_at =
        priorValidation === null
          ? new Date().toISOString()
          : parseSourceOracleValidationReceiptBytes(readP03BootstrapBytes(store, priorValidation))
              .validated_at;
      const frozen =
        "accepted_p01" in m
          ? freezeScaP03ProductionV1(store, {
              ...m,
              profile,
              policy,
              measured,
              oracle_bytes,
              review_ref,
              review_bytes,
              validated_at,
              fixtures,
              implementation,
            })
          : freezeScaP03BootstrapV3(store, {
              ...m,
              profile,
              policy,
              measured,
              oracle_bytes,
              review_ref,
              review_bytes,
              validated_at,
              fixtures,
              implementation,
            });
      const packageFiles = frozen.package_descriptors.map((entry, index) => {
        const file = path.join(m.working_dir, `package-${String(index)}.json`);
        atomicPrivate(file, entry.bytes);
        return { ref: entry.ref, path: file };
      });
      const mapped = frozen.implementation_mappings.map((x) => ({
        role: x.role,
        path: x.path,
        ref: x.ref,
      }));
      const build_files = Object.fromEntries<string>([
        ...mapped.map((x): [string, string] => [x.ref.artifact_id, x.path]),
        ...packageFiles.map((x): [string, string] => [x.ref.artifact_id, x.path]),
      ]);
      const registryPath = path.join(m.working_dir, "registry.json");
      const previousFile = path.join(
        m.working_dir,
        production ? "production-freeze-handoff.json" : "freeze-handoff.json"
      );
      let previous: ScaP03CliFreezeHandoff | ScaP03CliProductionFreezeHandoff | null = null;
      try {
        previous = parseScaP03CliCanonical(
          production ? ScaP03CliProductionFreezeHandoffSchema : ScaP03CliFreezeHandoffSchema,
          readStableScaP03FileV1(previousFile, 1024 * 1024, true)
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (previous !== null) {
        if (productionFrozen(frozen)) {
          if (
            !("production_bindings" in previous) ||
            !same(previous.production_bindings, frozen.production_bindings)
          )
            throw new Error("p03_cli_handoff_adopt_conflict");
        } else if ("production_bindings" in previous) {
          throw new Error("p03_cli_handoff_adopt_conflict");
        }
        if (
          previous.store_root !== m.store_root ||
          previous.project_id !== m.project_id ||
          previous.run_id !== m.run_id ||
          !same(previous.bindings, frozen.bindings) ||
          previous.mapping_sha256 !== scaP03CliMappingSha256(mapped) ||
          (previous.status === "ready_for_review") !== (previous.record_ref !== null)
        )
          throw new Error("p03_cli_handoff_adopt_conflict");
        const resumed = ScaP03WorkspaceRegistryV1.resume(registryPath);
        const local = {
          config: m.config,
          store,
          build_files,
          runtime_package_refs: frozen.bindings.runtime_package_refs,
          current_selection_path: path.join(m.working_dir, "selection.json"),
          registry: resumed,
        };
        const replayProbe =
          deps.createProbe === undefined
            ? createScaP03LocalHostProbeV1(local)
            : deps.createProbe(local);
        if (productionFrozen(frozen)) readP03ProductionInputs(store, frozen.production_bindings);
        else readP03BootstrapInputs(store, frozen.bindings, m.run_id);
        readP03BootstrapBytes(store, previous.attempt_ref);
        if (previous.cleanup_ref !== null) readP03BootstrapBytes(store, previous.cleanup_ref);
        if (previous.isolation_ref !== null) readP03BootstrapBytes(store, previous.isolation_ref);
        if (previous.record_ref !== null) {
          const prior = validateScaP03BootstrapQualificationRecordV3(
            decode(readP03BootstrapBytes(store, previous.record_ref))
          );
          if (
            !same(prior.implementation_source_refs, frozen.bindings.implementation_source_refs) ||
            !same(prior.attempt_witness_ref, previous.attempt_ref) ||
            !same(prior.cleanup_evidence_ref, previous.cleanup_ref) ||
            !same(prior.host_isolation_evidence_ref, previous.isolation_ref)
          )
            throw new Error("p03_cli_record_adopt_conflict");
          readP03BootstrapInputs(store, prior, m.run_id);
        }
        if (
          (await replayProbe.measureIdentity()).deployment_sha256 !==
            frozen.bindings.deployment_identity_sha256 ||
          (
            await measureScaP03BuildClosureV3(
              store,
              replayProbe,
              frozen.bindings.implementation_source_refs
            )
          ).length !== 64 ||
          (
            await measureScaP03BuildClosureV3(
              store,
              replayProbe,
              frozen.bindings.runtime_package_refs
            )
          ).length !== 64
        )
          throw new Error("p03_cli_replay_drift");
        emit(
          canonicalJson({
            status: previous.status,
            handoff_sha256: sha256(canonicalJson(previous)),
            attempt_ref: previous.attempt_ref,
            cleanup_ref: previous.cleanup_ref,
            isolation_ref: previous.isolation_ref,
            record_ref: previous.record_ref,
          })
        );
        return;
      }
      const registry = ScaP03WorkspaceRegistryV1.create(registryPath);
      const probeInput = {
        config: m.config,
        store,
        build_files,
        runtime_package_refs: frozen.bindings.runtime_package_refs,
        current_selection_path: path.join(m.working_dir, "selection.json"),
        registry,
      };
      const probe =
        deps.createProbe === undefined
          ? createScaP03LocalHostProbeV1(probeInput)
          : deps.createProbe(probeInput);
      const runner = deps.dockerRunner ?? dockerCommandV1(m.config.docker_executable);
      const measurementInput = {
        run_id: m.run_id,
        store,
        probe,
        implementation_refs: frozen.bindings.implementation_source_refs,
        workspace_registry: registry,
        candidate: (sink: ScaP03HostWitnessSinkV1) =>
          deps.deterministicTestCandidate === undefined
            ? createScaP03DockerJoernCandidateV1(m.config, runner, sink)
            : deps.deterministicTestCandidate(sink),
        signal: new AbortController().signal,
      };
      const measuredAttempt = productionFrozen(frozen)
        ? await measureScaP03ProductionCandidateV1({
            ...measurementInput,
            production_bindings: frozen.production_bindings,
          })
        : await measureScaP03BootstrapCandidateV3({
            ...measurementInput,
            bindings: frozen.bindings,
          });
      const attempt_ref = persistEvidence(
        store,
        m.run_id,
        "sca-p03-attempt-witness",
        measuredAttempt.witness_bytes,
        [
          frozen.bindings.runtime_policy_ref,
          frozen.bindings.implementation_identity_ref,
          frozen.bindings.runtime_identity_ref,
          ...frozen.bindings.implementation_source_refs,
        ]
      );
      let cleanup_ref: ArtifactRef | null = null;
      let isolation_ref: ArtifactRef | null = null;
      let record_ref: ArtifactRef | null = null;
      if (measuredAttempt.disposition === "completed") {
        try {
          const evidence = await issueScaP03PostRunEvidenceV3({
            store,
            probe,
            config: m.config,
            attempt_ref,
            policy_ref: frozen.bindings.runtime_policy_ref,
            implementation_identity_ref: frozen.bindings.implementation_identity_ref,
            runtime_identity_ref: frozen.bindings.runtime_identity_ref,
            implementation_source_refs: frozen.bindings.implementation_source_refs,
          });
          cleanup_ref = persistEvidence(
            store,
            m.run_id,
            "sca-p03-cleanup-evidence",
            evidence.cleanup_bytes,
            [attempt_ref, frozen.bindings.runtime_policy_ref]
          );
          isolation_ref = persistEvidence(
            store,
            m.run_id,
            "sca-p03-isolation-evidence",
            evidence.isolation_bytes,
            [attempt_ref, frozen.bindings.runtime_policy_ref]
          );
        } catch {
          /* attempt remains blocked; no positive record */
        }
        if (cleanup_ref !== null && isolation_ref !== null) {
          let finalRecord: Awaited<ReturnType<typeof finalizeScaP03BootstrapRecordV3>> | null =
            null;
          try {
            const finalizationInput = {
              run_id: m.run_id,
              measured: measuredAttempt,
              attempt_ref,
              cleanup_ref,
              isolation_ref,
              implementation_refs: frozen.bindings.implementation_source_refs,
              store,
              probe,
            };
            finalRecord = productionFrozen(frozen)
              ? await finalizeScaP03ProductionBootstrapRecordV1({
                  ...finalizationInput,
                  production_bindings: frozen.production_bindings,
                })
              : await finalizeScaP03BootstrapRecordV3({
                  ...finalizationInput,
                  bindings: frozen.bindings,
                });
          } catch {
            /* independent evidence can fail, never a PASS */
          }
          if (finalRecord !== null)
            record_ref = persistEvidence(
              store,
              m.run_id,
              "sca-p03-bootstrap-record",
              Buffer.from(canonicalJson(finalRecord)),
              [
                frozen.bindings.fixture_corpus_ref,
                frozen.bindings.source_oracle_ref,
                frozen.bindings.source_oracle_validation_ref,
                frozen.bindings.source_oracle_review_ref,
                frozen.bindings.baseline_query_set_ref,
                frozen.bindings.qualification_profile_ref,
                frozen.bindings.runtime_policy_ref,
                frozen.bindings.implementation_identity_ref,
                frozen.bindings.runtime_identity_ref,
                ...frozen.bindings.fixture_content_refs,
                ...frozen.bindings.query_script_refs,
                ...frozen.bindings.query_plan_refs,
                ...frozen.bindings.runtime_package_refs,
                ...frozen.bindings.implementation_source_refs,
                attempt_ref,
                cleanup_ref,
                isolation_ref,
              ]
            );
        }
      }
      const handoffDraft = {
        schema_version: 1 as const,
        store_root: m.store_root,
        project_id: m.project_id,
        run_id: m.run_id,
        status: record_ref === null ? ("blocked" as const) : ("ready_for_review" as const),
        bindings: frozen.bindings,
        mapping_sha256: scaP03CliMappingSha256(mapped),
        attempt_ref,
        cleanup_ref,
        isolation_ref,
        record_ref,
      };
      const handoff = productionFrozen(frozen)
        ? parseScaP03CliCanonical(
            ScaP03CliProductionFreezeHandoffSchema,
            Buffer.from(
              canonicalJson({
                ...handoffDraft,
                schema_id: "penny.sca-p03-cli-production-freeze-handoff.v1",
                production_bindings: frozen.production_bindings,
              })
            )
          )
        : parseScaP03CliCanonical(
            ScaP03CliFreezeHandoffSchema,
            Buffer.from(
              canonicalJson({
                ...handoffDraft,
                schema_id: "penny.sca-p03-cli-freeze-handoff.v1",
              })
            )
          );
      const handoffBytes = Buffer.from(canonicalJson(handoff));
      if (record_ref === null) {
        const diagnostic = digest(
          {
            schema_id: "penny.sca-p03-cli-blocked-diagnostic.v1",
            schema_version: 1,
            reason_code:
              measuredAttempt.disposition === "completed"
                ? "post_run_incomplete"
                : measuredAttempt.disposition === "cancelled"
                  ? "candidate_cancelled"
                  : "candidate_failed",
            attempt_ref,
            cleanup_ref,
            isolation_ref,
          },
          "diagnostic_sha256"
        );
        atomicPrivate(
          path.join(m.working_dir, "blocked-diagnostic.json"),
          Buffer.from(canonicalJson(diagnostic))
        );
      }
      atomicPrivate(previousFile, handoffBytes);
      emit(
        canonicalJson({
          status: handoff.status,
          handoff_sha256: sha256(handoffBytes),
          attempt_ref,
          cleanup_ref,
          isolation_ref,
          record_ref,
        })
      );
    } finally {
      store.close();
    }
    return;
  }
  if (argv[0] === "seal" || argv[0] === "seal-production") {
    const production = argv[0] === "seal-production";
    const m = production
      ? parseScaP03CliCanonical(ScaP03CliProductionSealManifestSchema, bytes)
      : parseScaP03CliCanonical(ScaP03CliSealManifestSchema, bytes);
    verifyScaP03DockerConfigV1(m.config);
    directory(m.working_dir);
    const handoff = freezeHandoff(m);
    const key = loadKey(m.reviewer_public_key_path, m.reviewer_public_key_sha256);
    const externalBytes = readStableScaP03FileV1(m.external_review_path, 1024 * 1024, true);
    const external = parseScaP03CliCanonical(ScaP03CliExternalReviewSchema, externalBytes);
    const { signature, ...signed } = external;
    if (
      !same(signed, {
        external_review_id: external.external_review_id,
        record_ref: handoff.record_ref,
        attempt_ref: handoff.attempt_ref,
        cleanup_ref: handoff.cleanup_ref,
        isolation_ref: handoff.isolation_ref,
        reviewer_id: m.reviewer_id,
        reviewer_authority_id: m.reviewer_authority_id,
        decision: "PASS",
        reviewed_at: external.reviewed_at,
      }) ||
      new Set([
        m.reviewer_id,
        m.reviewer_authority_id,
        m.evaluator_id,
        m.attester_id,
        P03_BOOTSTRAP_ROLES.cleanup,
        P03_BOOTSTRAP_ROLES.isolation,
      ]).size !== 6 ||
      !verifySignature(
        null,
        Buffer.from(canonicalJson(signed)),
        key,
        Buffer.from(signature, "base64")
      )
    )
      throw new Error("p03_cli_review_untrusted");
    const store = ArtifactStore.openExisting(m.store_root, { projectId: m.project_id });
    try {
      const record = validateScaP03BootstrapQualificationRecordV3(
        decode(readP03BootstrapBytes(store, handoff.record_ref))
      );
      if (productionHandoff(handoff)) readP03ProductionInputs(store, handoff.production_bindings);
      assertExactImplementationRoles(store, handoff.bindings);
      if (
        readP03BootstrapInputs(store, handoff.bindings, m.run_id).policy.staging_parent_sha256 !==
        sha256(m.config.staging_parent)
      )
        throw new Error("p03_cli_staging_parent_mismatch");
      if (
        Date.parse(external.reviewed_at) <= Date.parse(record.evaluated_at) ||
        Date.parse(external.reviewed_at) > Date.now() + 60_000
      )
        throw new Error("p03_cli_review_time_invalid");
      const ext_ref = persistExact(
        store,
        m.run_id,
        "sca-p03-external-review",
        "bootstrap-external-review",
        P03_BOOTSTRAP_ROLES.reviewer,
        "penny.sca-p03-external-review.v1",
        1,
        externalBytes,
        [handoff.record_ref, handoff.attempt_ref, handoff.cleanup_ref, handoff.isolation_ref]
      );
      const receipt = digest(
        {
          schema_id: "penny.sca-p03-bootstrap-reviewer-receipt.v2",
          schema_version: 2,
          external_review_id: external.external_review_id,
          external_review_ref: ext_ref,
          record_ref: handoff.record_ref,
          attempt_ref: handoff.attempt_ref,
          cleanup_ref: handoff.cleanup_ref,
          isolation_ref: handoff.isolation_ref,
          reviewer_id: m.reviewer_id,
          reviewer_authority_id: m.reviewer_authority_id,
          evaluator_id: m.evaluator_id,
          attester_id: m.attester_id,
          reviewed_at: external.reviewed_at,
          decision: "PASS",
        },
        "receipt_sha256"
      );
      validateScaP03ExternalReviewReceiptV2(Buffer.from(canonicalJson(receipt)));
      const receipt_ref = persistExact(
        store,
        m.run_id,
        "sca-p03-reviewer-receipt",
        "bootstrap-receipt",
        P03_BOOTSTRAP_ROLES.reviewer,
        "penny.sca-p03-bootstrap-reviewer-receipt.v2",
        2,
        Buffer.from(canonicalJson(receipt)),
        [
          handoff.record_ref,
          handoff.attempt_ref,
          handoff.cleanup_ref,
          handoff.isolation_ref,
          ext_ref,
        ]
      );
      const b = handoff.bindings;
      const reviewed = digest(
        {
          schema_id: "penny.sca-p03-bootstrap-review.v3",
          schema_version: 3,
          evidence_class: "live",
          record_ref: handoff.record_ref,
          source_oracle_ref: b.source_oracle_ref,
          source_oracle_validation_ref: b.source_oracle_validation_ref,
          attempt_witness_ref: handoff.attempt_ref,
          implementation_source_refs: b.implementation_source_refs,
          reviewer_id: m.reviewer_id,
          reviewer_authority_id: m.reviewer_authority_id,
          reviewer_receipt_ref: receipt_ref,
          decision: "PASS",
          reviewed_at: external.reviewed_at,
        },
        "review_sha256"
      );
      validateScaP03BootstrapReviewV3(reviewed);
      const review_ref = persistExact(
        store,
        m.run_id,
        "sca-p03-bootstrap-review",
        "bootstrap-review",
        P03_BOOTSTRAP_ROLES.reviewer,
        "penny.sca-p03-bootstrap-review.v3",
        3,
        Buffer.from(canonicalJson(reviewed)),
        [
          receipt_ref,
          b.source_oracle_ref,
          b.source_oracle_validation_ref,
          handoff.attempt_ref,
          ...b.implementation_source_refs,
        ]
      );
      const previousAttestation = store.refFor(
        m.run_id,
        "SCA-P03",
        null,
        SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.kind,
        "bootstrap-attestation",
        1
      );
      const attested_at =
        previousAttestation === null
          ? new Date(Math.max(Date.now(), Date.parse(external.reviewed_at) + 1)).toISOString()
          : validateScaP03HostIsolationAttestationV1(
              decode(readP03BootstrapBytes(store, previousAttestation))
            ).attested_at;
      const attestation = {
        schema_id: "penny.sca-p03-host-isolation-attestation.v1",
        schema_version: 1,
        attestation_id: m.attestation_id,
        source_oracle_ref: b.source_oracle_ref,
        source_oracle_validation_ref: b.source_oracle_validation_ref,
        parser_identity_sha256: b.parser_identity_sha256,
        runtime_kind: "host_qualified_joern",
        runtime_id: b.runtime_id,
        isolation_id: b.isolation_id,
        implementation_identity_sha256: b.implementation_identity_sha256,
        deployment_identity_sha256: b.deployment_identity_sha256,
        profile_id: b.profile_id,
        profile_sha256: b.profile_sha256,
        runtime_tree_sha256: b.runtime_tree_sha256,
        qualification_scope: "live_qualified",
        qualified: true,
        attested_at,
      };
      validateScaP03HostIsolationAttestationV1(attestation);
      const attestation_ref = persistExact(
        store,
        m.run_id,
        SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.kind,
        "bootstrap-attestation",
        SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.producer,
        SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.content_schema.schema_id,
        SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.content_schema.schema_version,
        Buffer.from(canonicalJson(attestation)),
        [
          handoff.record_ref,
          review_ref,
          b.source_oracle_ref,
          b.source_oracle_validation_ref,
          handoff.attempt_ref,
          ...b.implementation_source_refs,
        ]
      );
      const binding = digest(
        {
          schema_id: "penny.sca-p03-attestation-binding.v3",
          schema_version: 3,
          host_attestation_ref: attestation_ref,
          qualification_record_ref: handoff.record_ref,
          review_ref,
          source_oracle_ref: b.source_oracle_ref,
          source_oracle_validation_ref: b.source_oracle_validation_ref,
          parser_identity_sha256: b.parser_identity_sha256,
          attempt_witness_ref: handoff.attempt_ref,
          implementation_source_refs: b.implementation_source_refs,
        },
        "binding_sha256"
      );
      validateScaP03AttestationBindingV3(binding);
      const binding_ref = persistExact(
        store,
        m.run_id,
        "sca-p03-attestation-binding",
        "bootstrap-binding",
        P03_BOOTSTRAP_ROLES.attester,
        "penny.sca-p03-attestation-binding.v3",
        3,
        Buffer.from(canonicalJson(binding)),
        [
          handoff.record_ref,
          review_ref,
          attestation_ref,
          b.source_oracle_ref,
          b.source_oracle_validation_ref,
          handoff.attempt_ref,
          ...b.implementation_source_refs,
        ]
      );
      const selection = path.join(m.working_dir, "selection.json");
      let previousSelection: ReturnType<typeof validateScaP03CurrentSelectionV1> | null = null;
      try {
        previousSelection = validateScaP03CurrentSelectionV1(
          readStableScaP03FileV1(selection, 1024 * 1024, true)
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (
        previousSelection !== null &&
        (previousSelection.status !== "selected" ||
          !same(previousSelection.record_ref, handoff.record_ref) ||
          !same(previousSelection.binding_ref, binding_ref) ||
          previousSelection.deployment_sha256 !== b.deployment_identity_sha256)
      )
        throw new Error("p03_cli_selection_conflict");
      const selected = digest(
        {
          schema_id: "penny.sca-p03-bootstrap-selection.v1",
          schema_version: 1,
          record_ref: handoff.record_ref,
          binding_ref,
          deployment_sha256: b.deployment_identity_sha256,
          selected_at:
            previousSelection?.selected_at ??
            new Date(Math.max(Date.now(), Date.parse(attested_at))).toISOString(),
          status: "selected",
        },
        "selection_sha256"
      );
      const selectedBytes = Buffer.from(canonicalJson(selected));
      validateScaP03CurrentSelectionV1(selectedBytes);
      atomicPrivate(selection, selectedBytes);
      const registry = ScaP03WorkspaceRegistryV1.resume(path.join(m.working_dir, "registry.json"));
      const probe = makeProbe(m, store, registry, deps.createProbe);
      const authority = createScaP03BootstrapHostAuthorityV1({
        store,
        probe,
        record_ref: handoff.record_ref,
        binding_ref,
        attempt_ref: handoff.attempt_ref,
        cleanup_ref: handoff.cleanup_ref,
        isolation_ref: handoff.isolation_ref,
        receipt_ref,
        reviewer_public_key: key,
        reviewer_id: m.reviewer_id,
        reviewer_authority_id: m.reviewer_authority_id,
        evaluator_id: m.evaluator_id,
        attester_id: m.attester_id,
        implementation_refs: b.implementation_source_refs,
        runtime_package_refs: b.runtime_package_refs,
      });
      try {
        const bootstrapProofInput = {
          authority,
          config: m.config,
          binding_ref,
          host_attestation_ref: attestation_ref,
          qualification_record_ref: handoff.record_ref,
          review_ref,
        };
        let proof = await verifyScaP03BootstrapProofV3(bootstrapProofInput);
        let productionRecordRef: ArtifactRef | null = null;
        let productionBindingSha256: string | null = null;
        if (productionHandoff(handoff)) {
          productionBindingSha256 = handoff.production_bindings.binding_sha256;
          const productionRecord = await createScaP03ProductionQualificationRecordV1({
            ...bootstrapProofInput,
            store,
            production_bindings: handoff.production_bindings,
          });
          productionRecordRef = persistExact(
            store,
            m.run_id,
            SCA_P03_PRODUCTION_QUALIFICATION_RECORD_KIND,
            SCA_P03_PRODUCTION_QUALIFICATION_RECORD_OPERATION_ID,
            SCA_P03_PRODUCTION_EVALUATOR,
            SCA_P03_PRODUCTION_QUALIFICATION_RECORD_V1_SCHEMA,
            1,
            Buffer.from(canonicalJson(productionRecord)),
            scaP03ProductionRecordUpstreamRefsV1({
              production_bindings: handoff.production_bindings,
              bootstrap_record_ref: handoff.record_ref,
              bootstrap_review_ref: review_ref,
              bootstrap_binding_ref: binding_ref,
              host_attestation_ref: attestation_ref,
            })
          );
          proof = await verifyScaP03ProductionProofV1({
            ...bootstrapProofInput,
            store,
            production_bindings: handoff.production_bindings,
            production_record_ref: productionRecordRef,
          });
        }
        if ((productionRecordRef === null) !== (productionBindingSha256 === null))
          throw new Error("p03_cli_production_record_binding_invalid");
        const sealedDraft = {
          schema_version: 1 as const,
          store_root: m.store_root,
          project_id: m.project_id,
          run_id: m.run_id,
          record_ref: handoff.record_ref,
          attempt_ref: handoff.attempt_ref,
          cleanup_ref: handoff.cleanup_ref,
          isolation_ref: handoff.isolation_ref,
          external_review_ref: ext_ref,
          receipt_ref,
          review_ref,
          host_attestation_ref: attestation_ref,
          binding_ref,
          mapping_sha256: handoff.mapping_sha256,
          proof_sha256: proof.proof_sha256,
          status: "verified" as const,
        };
        const sealed =
          productionRecordRef === null
            ? parseScaP03CliCanonical(
                ScaP03CliSealedHandoffSchema,
                Buffer.from(
                  canonicalJson({
                    ...sealedDraft,
                    schema_id: "penny.sca-p03-cli-sealed-handoff.v1",
                  })
                )
              )
            : parseScaP03CliCanonical(
                ScaP03CliProductionSealedHandoffSchema,
                Buffer.from(
                  canonicalJson({
                    ...sealedDraft,
                    schema_id: "penny.sca-p03-cli-production-sealed-handoff.v1",
                    production_record_ref: productionRecordRef,
                    production_binding_sha256: productionBindingSha256,
                  })
                )
              );
        const sealedBytes = Buffer.from(canonicalJson(sealed));
        atomicPrivate(
          path.join(
            m.working_dir,
            productionRecordRef === null ? "sealed-handoff.json" : "production-sealed-handoff.json"
          ),
          sealedBytes
        );
        emit(
          canonicalJson({
            status: "verified",
            sealed_handoff_sha256: sha256(sealedBytes),
            binding_ref,
            review_ref,
            host_attestation_ref: attestation_ref,
            ...(productionRecordRef === null ? {} : { production_record_ref: productionRecordRef }),
            proof,
          })
        );
      } catch (error) {
        const { selection_sha256: _old, ...draft } = selected;
        void _old;
        atomicPrivate(
          selection,
          Buffer.from(
            canonicalJson({
              ...draft,
              status: "revoked",
              selection_sha256: sha256(canonicalJson({ ...draft, status: "revoked" })),
            })
          ),
          true
        );
        throw error;
      }
    } finally {
      store.close();
    }
    return;
  }
  const sampling = argv[0] === "sample-production";
  const production = argv[0] === "verify-production" || sampling;
  const m = production
    ? parseScaP03CliCanonical(ScaP03CliProductionVerifyManifestSchema, bytes)
    : parseScaP03CliCanonical(ScaP03CliVerifyManifestSchema, bytes);
  verifyScaP03DockerConfigV1(m.config);
  const protectedPaths =
    sampling && m.schema_id === "penny.sca-p03-cli-production-verify-manifest.v1"
      ? canonicalJson([
          assertScaP03ProtectedPathV1(file),
          scaP03ProductionManifestProtectedPathsV1(m),
        ])
      : undefined;
  directory(m.working_dir);
  const handoff = freezeHandoff(m);
  const sealedBytes = readStableScaP03FileV1(m.sealed_handoff_path, 1024 * 1024, true);
  if (sha256(sealedBytes) !== m.sealed_handoff_sha256)
    throw new Error("p03_cli_sealed_handoff_drift");
  const sealed = production
    ? parseScaP03CliCanonical(ScaP03CliProductionSealedHandoffSchema, sealedBytes)
    : parseScaP03CliCanonical(ScaP03CliSealedHandoffSchema, sealedBytes);
  if (
    sealed.status !== "verified" ||
    sealed.store_root !== m.store_root ||
    sealed.project_id !== m.project_id ||
    sealed.run_id !== m.run_id ||
    sealed.mapping_sha256 !== handoff.mapping_sha256 ||
    !same(sealed.record_ref, handoff.record_ref) ||
    !same(sealed.attempt_ref, handoff.attempt_ref) ||
    !same(sealed.cleanup_ref, handoff.cleanup_ref) ||
    !same(sealed.isolation_ref, handoff.isolation_ref) ||
    (production &&
      (!("production_record_ref" in sealed) ||
        !productionHandoff(handoff) ||
        sealed.production_binding_sha256 !== handoff.production_bindings.binding_sha256))
  )
    throw new Error("p03_cli_sealed_handoff_mismatch");
  const key = loadKey(m.reviewer_public_key_path, m.reviewer_public_key_sha256);
  const externalBytes = readStableScaP03FileV1(m.external_review_path, 1024 * 1024, true);
  if (
    sha256(externalBytes) !== sealed.external_review_ref.content_digest ||
    !same(
      parseScaP03CliCanonical(ScaP03CliExternalReviewSchema, externalBytes).record_ref,
      sealed.record_ref
    )
  )
    throw new Error("p03_cli_external_review_drift");
  const guarded = deps.guarded_verification;
  if (
    guarded !== undefined &&
    (!sampling ||
      guarded.context.journal.project_id !== m.project_id ||
      guarded.store.root !== m.store_root)
  )
    throw new Error("p03_verification_store_binding_invalid");
  const openedStore =
    guarded === undefined
      ? new ArtifactStore(m.store_root, { projectId: m.project_id }, "verify")
      : undefined;
  const store =
    guarded === undefined
      ? openedStore
      : createScaP03BoundVerificationReaderV1(guarded.context, guarded.store);
  if (store === undefined) throw new Error("p03_verification_store_unavailable");
  try {
    if (productionHandoff(handoff)) readP03ProductionInputs(store, handoff.production_bindings);
    assertExactImplementationRoles(store, handoff.bindings);
    if (
      readP03BootstrapInputs(store, handoff.bindings, m.run_id).policy.staging_parent_sha256 !==
      sha256(m.config.staging_parent)
    )
      throw new Error("p03_cli_staging_parent_mismatch");
    const registry = ScaP03WorkspaceRegistryV1.resume(path.join(m.working_dir, "registry.json"));
    const probe = makeProbe(m, store, registry, deps.createProbe);
    const authority = createScaP03BootstrapHostAuthorityV1({
      store,
      probe,
      record_ref: sealed.record_ref,
      binding_ref: sealed.binding_ref,
      attempt_ref: sealed.attempt_ref,
      cleanup_ref: sealed.cleanup_ref,
      isolation_ref: sealed.isolation_ref,
      receipt_ref: sealed.receipt_ref,
      reviewer_public_key: key,
      reviewer_id: m.reviewer_id,
      reviewer_authority_id: m.reviewer_authority_id,
      evaluator_id: m.evaluator_id,
      attester_id: m.attester_id,
      implementation_refs: handoff.bindings.implementation_source_refs,
      runtime_package_refs: handoff.bindings.runtime_package_refs,
    });
    // Snapshot only for projection; the authority independently reads/validates selection.
    const selectionBytes = sampling ? await probe.currentSelection() : undefined;
    const bootstrapProofInput = {
      authority,
      config: m.config,
      binding_ref: sealed.binding_ref,
      host_attestation_ref: sealed.host_attestation_ref,
      qualification_record_ref: sealed.record_ref,
      review_ref: sealed.review_ref,
      ...(guarded === undefined
        ? {}
        : {
            verification_context: {
              signal: guarded.context.signal,
              reportWorkMilestone: () =>
                guarded.context.reportActivity("p03_verification_milestone", 1),
            },
          }),
    };
    const proof =
      productionHandoff(handoff) && "production_record_ref" in sealed
        ? await verifyScaP03ProductionProofV1({
            ...bootstrapProofInput,
            store,
            production_bindings: handoff.production_bindings,
            production_record_ref: sealed.production_record_ref,
          })
        : await verifyScaP03BootstrapProofV3(bootstrapProofInput);
    if (proof.proof_sha256 !== sealed.proof_sha256) throw new Error("p03_cli_proof_drift");
    if (sampling) {
      if (
        m.schema_id !== "penny.sca-p03-cli-production-verify-manifest.v1" ||
        protectedPaths !==
          canonicalJson([
            assertScaP03ProtectedPathV1(file),
            scaP03ProductionManifestProtectedPathsV1(m),
          ])
      )
        throw new Error("p03_cli_sampling_protection_changed");
      if (
        selectionBytes === undefined ||
        !productionHandoff(handoff) ||
        !("production_record_ref" in sealed) ||
        !Buffer.from(selectionBytes).equals(await probe.currentSelection()) ||
        !Buffer.from(bytes).equals(readStableScaP03FileV1(file, 1024 * 1024, true)) ||
        !Buffer.from(sealedBytes).equals(
          readStableScaP03FileV1(m.sealed_handoff_path, 1024 * 1024, true)
        ) ||
        sha256(readStableScaP03FileV1(m.freeze_handoff_path, 1024 * 1024, true)) !==
          m.freeze_handoff_sha256 ||
        sha256(readStableScaP03FileV1(m.external_review_path, 1024 * 1024, true)) !==
          sealed.external_review_ref.content_digest
      )
        throw new Error("p03_cli_sampling_input_drift");
      loadKey(m.reviewer_public_key_path, m.reviewer_public_key_sha256);
      emit(
        canonicalJson(
          validateContract(
            ScaP03CurrentBootstrapSampleV1Schema,
            {
              // Collector and activation use SHA-256 of these exact PRODUCTION SEALED handoff bytes.
              handoff_sha256: sha256(sealedBytes),
              proof_sha256: proof.proof_sha256,
              selection_sha256: sha256(selectionBytes),
              deployment_identity_sha256: m.config.deployment_identity_sha256,
              production_binding_sha256: sealed.production_binding_sha256,
              production_record_ref: sealed.production_record_ref,
              record_ref: sealed.record_ref,
              binding_ref: sealed.binding_ref,
              review_ref: sealed.review_ref,
              attestation_ref: sealed.host_attestation_ref,
              attempt_ref: sealed.attempt_ref,
              cleanup_ref: sealed.cleanup_ref,
              isolation_ref: sealed.isolation_ref,
              receipt_ref: sealed.receipt_ref,
              external_review_ref: sealed.external_review_ref,
            },
            "P03 freshly verified production bootstrap sample"
          )
        )
      );
      return;
    }
    emit(
      canonicalJson({
        status: "verified",
        binding_ref: sealed.binding_ref,
        review_ref: sealed.review_ref,
        host_attestation_ref: sealed.host_attestation_ref,
        ...(productionHandoff(handoff) && "production_record_ref" in sealed
          ? { production_record_ref: sealed.production_record_ref }
          : {}),
        proof,
      })
    );
  } finally {
    openedStore?.close();
  }
}
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runScaP03BootstrapCliV1(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`p03-bootstrap: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
