import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { ArtifactStore, type ArtifactHostStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { SqliteScaActivationOwner } from "../../orchestration/dist/sca/activation-owner.js";
import { SqliteScaPhaseActivationRegistry } from "../../orchestration/dist/sca/phase-activation.js";
import { createScaP02ActivationHostV1 } from "../../orchestration/dist/sca/p02-activation-host.js";
import { requireScaP03AcceptedP02Qualification } from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import { requireScaActivationAdmissionV1 } from "../../orchestration/dist/sca/qualification-activation.js";
import {
  ScaP03InitialResourcesV1Schema,
  deriveScaP03InitialCustodyV1,
  type ScaP03InitialProposalV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  SCA_P03_IMPLEMENTATION_SOURCE_PATHS,
  scaP03SourceManifestSha256,
} from "../../orchestration/dist/sca/p03-qualification.js";
import { Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import {
  ScaP03CliFreezeManifestSchema,
  ScaP03CliProductionVerifyManifestSchema,
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionSealedHandoffSchema,
  parseScaP03CliCanonical,
} from "./p03-bootstrap-cli-contracts.js";
import {
  assertScaP03ProtectedPathV1,
  measureScaP03ProtectedDependencyRootV1,
} from "./p03-production-sampler.js";
import { readStableScaP03FileV1 } from "./p03-bootstrap-local-probe.js";
import {
  loadScaP03PredecessorInputsV1,
  createScaP03ApprovedInputReaderV1,
} from "./p03-predecessor-inputs.js";
import type { ScaP03PreLiveInputsV1, ScaP03SealedBootstrapInputsV1 } from "./p03-initial-live.js";

type ScaP03PredecessorBindingV1 = Pick<
  ScaP03PreLiveInputsV1,
  | "tenant_id"
  | "project_id"
  | "accepted_p01"
  | "accepted_p02"
  | "p02_proposed_start"
  | "p02_authority_ref"
  | "p02_issuance_ref"
  | "root_tool_id"
>;

/** Lossless content identity; timestamps must not pass through floating-point milliseconds. */
export function scaP03InitialFileMetadataV1(
  stat: Pick<BigIntStats, "dev" | "ino" | "size" | "uid" | "mode" | "nlink" | "mtimeNs" | "ctimeNs">
): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.uid,
    stat.mode,
    stat.nlink,
    stat.mtimeNs,
    stat.ctimeNs,
  ]
    .map(String)
    .join(":");
}

/** Program-content hashes only, under the existing POSIX DAC trusted-writer contract.
 * Every use opens a no-follow descriptor and remeasures ALL protected ancestors and root
 * mappings, including named directory entries. Any metadata change requires an exact-byte
 * reread. Dependencies, capsule bytes, source/P02 eligibility and all authority remain fresh.
 * This is not protection against root/same-UID writers, ACLs or mount replacement. */
export class ScaP03InitialProgramMeasurementsV1 {
  private readonly roots: readonly string[];
  private readonly content = new Map<string, { identity: string; sha256: string }>();
  constructor(roots: readonly string[]) {
    if (roots.length < 1 || roots.length > 16) throw new Error("p03_initial_deployment_root_limit");
    this.roots = [...roots];
  }
  private ancestry(file: string): string {
    const directories = new Set<string>();
    for (const root of this.roots) {
      if (root === path.parse(root).root) throw new Error("p03_initial_deployment_root_too_broad");
      assertScaP03ProtectedPathV1(root, true);
      directories.add(root);
    }
    assertScaP03ProtectedPathV1(file);
    for (const start of [...directories, path.dirname(file)]) {
      for (let dir = start; ; dir = path.dirname(dir)) {
        directories.add(dir);
        if (dir === path.dirname(dir)) break;
      }
    }
    return canonicalJson(
      [...directories].sort().map((dir) => {
        const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd, { bigint: true });
          const named = lstatSync(dir, { bigint: true });
          if (
            !opened.isDirectory() ||
            scaP03InitialFileMetadataV1(opened) !== scaP03InitialFileMetadataV1(named)
          )
            throw new Error("p03_initial_ancestor_changed");
          return { path: dir, metadata: scaP03InitialFileMetadataV1(opened) };
        } finally {
          closeSync(fd);
        }
      })
    );
  }
  assertProgram(file: string, expected: string): "rehashed" | "unchanged" {
    if (!this.roots.some((root) => file.startsWith(`${root}${path.sep}`)))
      throw new Error("p03_initial_mapping_outside_deployment");
    const ancestry = this.ancestry(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      const named = lstatSync(file, { bigint: true });
      const metadata = scaP03InitialFileMetadataV1(opened);
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.size < 1n ||
        opened.size > BigInt(256 * 1_048_576) ||
        (opened.mode & 0o022n) !== 0n ||
        ![0n, BigInt(process.geteuid?.() ?? -1)].includes(opened.uid) ||
        metadata !== scaP03InitialFileMetadataV1(named)
      )
        throw new Error("p03_initial_program_drift");
      const identity = canonicalJson({ file, roots: this.roots, ancestry, metadata });
      const previous = this.content.get(file);
      const unchanged = previous?.identity === identity && previous.sha256 === expected;
      const readCurrent = () => {
        this.content.delete(file);
        if (sha256(readStableScaP03FileV1(file, 256 * 1_048_576)) !== expected)
          throw new Error("p03_initial_program_drift");
      };
      if (!unchanged) readCurrent();
      if (
        metadata !== scaP03InitialFileMetadataV1(fstatSync(fd, { bigint: true })) ||
        metadata !== scaP03InitialFileMetadataV1(lstatSync(file, { bigint: true }))
      )
        throw new Error("p03_initial_program_changed_during_measurement");
      if (ancestry !== this.ancestry(file)) {
        // Other users may change entries in a trusted root-owned sticky ancestor. Do not
        // publish a cache identity across that change. A hit must fall back to full hashing;
        // all current protection and named descriptor checks still apply.
        if (unchanged) readCurrent();
        this.ancestry(file); // Revalidate protection after the fallback's exact-byte read too.
        if (
          metadata !== scaP03InitialFileMetadataV1(fstatSync(fd, { bigint: true })) ||
          metadata !== scaP03InitialFileMetadataV1(lstatSync(file, { bigint: true }))
        )
          throw new Error("p03_initial_program_changed_during_measurement");
        this.content.delete(file);
        return "rehashed";
      }
      if (!unchanged) {
        if (this.content.size >= 258) throw new Error("p03_initial_program_mapping_limit");
        this.content.set(file, { identity, sha256: expected });
      }
      return unchanged ? "unchanged" : "rehashed";
    } finally {
      closeSync(fd);
    }
  }
}

const AbsolutePath = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^/[^\\u0000\\r\\n]*$",
});
const Program = Type.Object(
  { path: AbsolutePath, sha256: Sha256Schema },
  { additionalProperties: false }
);
/** Private, CLOSED pre-live operands. No final identity, handoff, selection, seal or issuance. */
export const ScaP03PreLiveCapsuleV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-pre-live-capsule.v1"),
    schema_version: Type.Literal(1),
    create_store: Type.Literal(false),
    project_root: AbsolutePath,
    state_root: AbsolutePath,
    store_root: AbsolutePath,
    evidence_destination: AbsolutePath,
    // Approved configuration commits to the complete owning source census, independently
    // of the caller-listed deployed module mappings. Legacy unbound capsules are refused.
    source_manifest_sha256: Sha256Schema,
    config: ScaP03CliFreezeManifestSchema.properties.config,
    docker_socket: AbsolutePath,
    node: Program,
    entrypoint: Program,
    module_files: Type.Array(Program, { minItems: 1, maxItems: 256 }),
    deployment_roots: Type.Array(AbsolutePath, { minItems: 1, maxItems: 16, uniqueItems: true }),
    dependency_root: Type.Union([AbsolutePath, Type.Null()]),
    dependency_sha256: Type.Union([Sha256Schema, Type.Null()]),
    toolchain_version_commands: ScaP03CliFreezeManifestSchema.properties.toolchain_version_commands,
  },
  { additionalProperties: false }
);
export const ScaP03SealedBootstrapCapsuleV1Schema = Type.Object(
  {
    ...ScaP03PreLiveCapsuleV1Schema.properties,
    schema_id: Type.Literal("penny.sca-p03-sealed-bootstrap-capsule.v1"),
    verification: Type.Object(
      { manifest_path: AbsolutePath, manifest_sha256: Sha256Schema },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export const ScaP03NativeCapsuleV1Schema = Type.Union([
  ScaP03PreLiveCapsuleV1Schema,
  ScaP03SealedBootstrapCapsuleV1Schema,
]);
export type ScaP03PreLiveCapsuleV1 = Static<typeof ScaP03PreLiveCapsuleV1Schema>;
export type ScaP03NativeCapsuleV1 = Static<typeof ScaP03NativeCapsuleV1Schema>;

export type ScaP03InitialNativeHostInputV1 = {
  readonly capsule_path: string;
  readonly capsule_sha256: string;
  readonly approved_state_root: string;
  readonly approved_backend_resource_sha256: string;
  readonly store: ArtifactStore;
  readonly p02_owner: SqliteScaActivationOwner;
  readonly p02_registry: SqliteScaPhaseActivationRegistry;
  readonly p02_host: Omit<
    Parameters<typeof createScaP02ActivationHostV1>[0],
    "store" | "owner" | "now" | "artifact_reads"
  >;
};

/** The approved authority locations are host configuration, NOT fields chosen by a proposal.
 * Opening another catalog cannot escape the independently bound state root. No provisioning. */
export class ScaP03InitialNativeHostV1 {
  private readonly ownedCapsule: ScaP03NativeCapsuleV1;
  get capsule(): ScaP03NativeCapsuleV1 {
    return structuredClone(this.ownedCapsule);
  }
  private readonly input: ScaP03InitialNativeHostInputV1;
  private readonly configurationDigest: string;
  private readonly protection: string;
  private readonly programs: ScaP03InitialProgramMeasurementsV1;
  private readonly sourceManifest: string;
  constructor(input: ScaP03InitialNativeHostInputV1) {
    this.input = { ...input, p02_host: structuredClone(input.p02_host) };
    if (
      !(input.store instanceof ArtifactStore) ||
      !(input.p02_owner instanceof SqliteScaActivationOwner) ||
      !(input.p02_registry instanceof SqliteScaPhaseActivationRegistry)
    )
      throw new Error("p03_initial_native_owners_required");
    const bytes = readStableScaP03FileV1(input.capsule_path, 1_048_576, true);
    if (sha256(bytes) !== input.capsule_sha256) throw new Error("p03_initial_capsule_drift");
    this.ownedCapsule = parseScaP03CliCanonical(ScaP03NativeCapsuleV1Schema, bytes);
    this.configurationDigest = sha256(bytes);
    if (
      this.capsule.state_root !== input.approved_state_root ||
      this.capsule.store_root !== input.store.root ||
      this.capsule.project_root !== input.p02_host.project_root
    )
      throw new Error("p03_initial_state_binding_invalid");
    input.store.assertBoundProject(input.p02_host.project_id);
    const tools = this.capsule.toolchain_version_commands;
    if (
      canonicalJson([tools.jvm, tools.php_runtime, tools.helper]) !==
      canonicalJson([
        ["java", "--version"],
        ["php", "--version"],
        ["python3", "--version"],
      ])
    )
      throw new Error("p03_initial_version_commands_forbidden");
    this.programs = new ScaP03InitialProgramMeasurementsV1(this.ownedCapsule.deployment_roots);
    this.protection = this.measureDeployment();
    this.sourceManifest = this.measureSource();
    if (this.sourceManifest !== this.ownedCapsule.source_manifest_sha256)
      throw new Error("p03_initial_source_manifest_drift");
  }
  private measureSource(): string {
    const root = this.input.p02_host.project_root;
    return scaP03SourceManifestSha256(
      SCA_P03_IMPLEMENTATION_SOURCE_PATHS.map((relative) => {
        const file = path.join(root, relative);
        assertScaP03ProtectedPathV1(file);
        const bytes = readStableScaP03FileV1(file, 64 * 1_048_576);
        return { path: relative, sha256: sha256(bytes), byte_length: bytes.byteLength };
      })
    );
  }
  sourceManifestSha256(): string {
    return this.sourceManifest;
  }
  private measureDeployment(): string {
    const c = this.capsule;
    // Pin the REAL parent runtime/module, not an unused program that merely hashes correctly.
    if (
      c.node.path !== realpathSync(process.execPath) ||
      !c.module_files.some((file) => file.path === fileURLToPath(import.meta.url))
    )
      throw new Error("p03_initial_running_module_mapping_required");
    const covered = (file: string) =>
      c.deployment_roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
    const programs = [
      c.node,
      c.entrypoint,
      ...c.module_files,
      { path: c.config.docker_executable, sha256: c.config.expected_docker_executable_sha256 },
    ];
    if (
      new Set(c.module_files.map((f) => f.path)).size !== c.module_files.length ||
      !c.module_files.some((f) => f.path === c.entrypoint.path && f.sha256 === c.entrypoint.sha256)
    )
      throw new Error("p03_initial_module_closure_invalid");
    const roots = c.deployment_roots.map((root) => {
      if (root === path.parse(root).root) throw new Error("p03_initial_deployment_root_too_broad");
      return assertScaP03ProtectedPathV1(root, true);
    });
    let moduleBytes = 0;
    for (const file of c.module_files) {
      if (!covered(file.path)) throw new Error("p03_initial_mapping_outside_deployment");
      moduleBytes += lstatSync(file.path).size;
    }
    if (moduleBytes > 32 * 1_048_576) throw new Error("p03_initial_module_byte_limit");
    const files = programs.map((f) => {
      if (!covered(f.path)) throw new Error("p03_initial_mapping_outside_deployment");
      const ancestors = assertScaP03ProtectedPathV1(f.path);
      const stat = lstatSync(f.path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o022) !== 0 ||
        ![0, process.geteuid?.()].includes(stat.uid)
      )
        throw new Error("p03_initial_program_drift");
      this.programs.assertProgram(f.path, f.sha256);
      return { ...f, ancestors };
    });
    if (
      (lstatSync(c.node.path).mode & 0o100) === 0 ||
      (lstatSync(c.config.docker_executable).mode & 0o100) === 0
    )
      throw new Error("p03_initial_executable_invalid");
    for (const dir of [c.store_root, c.evidence_destination, c.config.staging_parent]) {
      if (!covered(dir)) throw new Error("p03_initial_mapping_outside_deployment");
      assertScaP03ProtectedPathV1(dir, true);
      const stat = lstatSync(dir);
      if (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("p03_initial_private_directory_required");
    }
    if ((c.dependency_root === null) !== (c.dependency_sha256 === null))
      throw new Error("p03_initial_dependency_mapping_invalid");
    for (const program of [c.entrypoint, ...c.module_files]) {
      for (let dir = path.dirname(program.path); ; dir = path.dirname(dir)) {
        const modules = path.join(dir, "node_modules");
        try {
          lstatSync(modules);
          if (modules !== c.dependency_root) throw new Error("p03_initial_ambient_dependency_root");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (dir === path.dirname(dir)) break;
      }
    }
    if (
      c.dependency_root !== null &&
      (!covered(c.dependency_root) ||
        measureScaP03ProtectedDependencyRootV1(c.dependency_root) !== c.dependency_sha256)
    )
      throw new Error("p03_initial_dependency_drift");
    assertScaP03ProtectedPathV1(c.docker_socket);
    const socket = lstatSync(c.docker_socket);
    if (
      !socket.isSocket() ||
      (socket.mode & 0o002) !== 0 ||
      ![0, process.geteuid?.()].includes(socket.uid)
    )
      throw new Error("p03_initial_socket_invalid");
    return canonicalJson({
      roots,
      files,
      socket: { dev: socket.dev, ino: socket.ino },
      dependency: c.dependency_sha256,
    });
  }
  backendResourceSha256(): string {
    return this.input.approved_backend_resource_sha256;
  }
  deploymentSha256(): string {
    return sha256(this.protection);
  }
  assertCapsule(proposal: ScaP03InitialProposalV1): void {
    const c = this.capsule;
    const r = proposal.resources;
    const bytes = readStableScaP03FileV1(this.input.capsule_path, 1_048_576, true);
    // Recheck before admission/submission and around every normal command. A newly
    // constructed host also checks the approved capsule, so restart cannot adopt drift.
    if (this.measureSource() !== this.sourceManifest)
      throw new Error("p03_initial_source_manifest_drift");
    if (
      (proposal.effect === "bootstrap_verification") !==
        (c.schema_id === "penny.sca-p03-sealed-bootstrap-capsule.v1") ||
      sha256(bytes) !== this.configurationDigest ||
      this.protection !== this.measureDeployment() ||
      proposal.configuration_sha256 !== this.configurationDigest ||
      proposal.deployment_sha256 !== this.deploymentSha256() ||
      proposal.evidence_destination_sha256 !== sha256(c.evidence_destination) ||
      proposal.backend_resource_sha256 !== this.input.approved_backend_resource_sha256 ||
      proposal.project_id !== this.input.p02_host.project_id ||
      c.config.memory_bytes !== r.memory_bytes ||
      c.config.cpus !== r.cpus ||
      c.config.pids !== r.pids ||
      c.config.max_workspace_bytes !== r.work_bytes ||
      c.config.max_command_output_bytes !== r.command_output_bytes ||
      c.config.timeout_ms !== r.inactivity_ms ||
      c.config.max_num_def !== r.max_num_def
    )
      throw new Error("p03_initial_capsule_binding_invalid");
  }
  /** Exact private manifest, original sealed refs, accepted snapshot/P01 and CURRENT P02.
   * These checks are read-only and run again around every completed work boundary. */
  assertSealedInputs(m: ScaP03SealedBootstrapInputsV1, proposal: ScaP03InitialProposalV1): void {
    this.assertCapsule(proposal);
    this.assertPredecessorClosure(m, proposal);
    this.assertSealedCurrent(m, proposal.resources, proposal);
    if (
      proposal.effect !== "bootstrap_verification" ||
      m.run_id !== proposal.sealed_bootstrap_inputs_ref.run_id ||
      m.project_id !== proposal.project_id ||
      m.deployment_sha256 !== proposal.deployment_sha256 ||
      m.configuration_sha256 !== proposal.configuration_sha256 ||
      m.evidence_destination_sha256 !== proposal.evidence_destination_sha256
    )
      throw new Error("p03_sealed_purpose_binding_invalid");
  }
  assertSealedCurrent(
    m: ScaP03SealedBootstrapInputsV1,
    resources: ScaP03InitialProposalV1["resources"],
    proposal?: ScaP03InitialProposalV1
  ): void {
    validateContract(ScaP03InitialResourcesV1Schema, resources, "P03 sealed resource policy");
    if (
      resources.cleanup_grace_ms !== 5000 ||
      resources.tmp_bytes + resources.work_bytes > 67_108_864 ||
      resources.jvm_heap_bytes > resources.memory_bytes
    )
      throw new Error("p03_sealed_resource_policy_invalid");
    const bytes = readStableScaP03FileV1(this.input.capsule_path, 1_048_576, true);
    if (
      sha256(bytes) !== this.configurationDigest ||
      this.protection !== this.measureDeployment() ||
      this.measureSource() !== this.sourceManifest ||
      m.source_manifest_sha256 !== this.sourceManifest
    )
      throw new Error("p03_sealed_current_deployment_drift");
    const c = this.capsule;
    if (
      c.schema_id !== "penny.sca-p03-sealed-bootstrap-capsule.v1" ||
      m.manifest_sha256 !== c.verification.manifest_sha256 ||
      m.project_id !== this.input.p02_host.project_id ||
      m.deployment_sha256 !== this.deploymentSha256() ||
      m.configuration_sha256 !== this.configurationDigest ||
      m.evidence_destination_sha256 !== sha256(c.evidence_destination) ||
      m.resource_policy_sha256 !== sha256(canonicalJson(resources)) ||
      resources.memory_bytes !== c.config.memory_bytes ||
      resources.cpus !== c.config.cpus ||
      resources.pids !== c.config.pids ||
      resources.work_bytes !== c.config.max_workspace_bytes ||
      resources.command_output_bytes !== c.config.max_command_output_bytes ||
      resources.inactivity_ms !== c.config.timeout_ms
    )
      throw new Error("p03_sealed_purpose_binding_invalid");
    const manifestBytes = readStableScaP03FileV1(c.verification.manifest_path, 1_048_576, true);
    if (sha256(manifestBytes) !== m.manifest_sha256) throw new Error("p03_sealed_manifest_drift");
    const manifest = parseScaP03CliCanonical(
      ScaP03CliProductionVerifyManifestSchema,
      manifestBytes
    );
    if (
      manifest.store_root !== c.store_root ||
      manifest.project_id !== m.project_id ||
      manifest.working_dir !== c.evidence_destination ||
      canonicalJson(manifest.config) !== canonicalJson(c.config)
    )
      throw new Error("p03_sealed_private_mapping_invalid");
    const protectedFiles = [
      c.verification.manifest_path,
      manifest.working_dir,
      manifest.freeze_handoff_path,
      manifest.sealed_handoff_path,
      manifest.external_review_path,
      manifest.reviewer_public_key_path,
      ...manifest.implementation.map((v) => v.path),
      ...manifest.runtime_packages.map((v) => v.path),
    ];
    for (const file of protectedFiles) {
      if (!c.deployment_roots.some((root) => file.startsWith(root + path.sep)))
        throw new Error("p03_sealed_mapping_outside_deployment");
      assertScaP03ProtectedPathV1(file, file === manifest.working_dir);
    }
    const freezeBytes = readStableScaP03FileV1(manifest.freeze_handoff_path, 1_048_576, true);
    const sealedBytes = readStableScaP03FileV1(manifest.sealed_handoff_path, 1_048_576, true);
    if (
      sha256(freezeBytes) !== manifest.freeze_handoff_sha256 ||
      sha256(sealedBytes) !== manifest.sealed_handoff_sha256 ||
      sha256(sealedBytes) !== m.sealed_handoff_sha256
    )
      throw new Error("p03_sealed_handoff_drift");
    const freeze = parseScaP03CliCanonical(ScaP03CliProductionFreezeHandoffSchema, freezeBytes);
    const sealed = parseScaP03CliCanonical(ScaP03CliProductionSealedHandoffSchema, sealedBytes);
    if (
      canonicalJson(freeze.production_bindings.roots) !==
        canonicalJson({
          accepted_p01: m.accepted_p01,
          root_tool_id: m.root_tool_id,
          toolchain_ref: m.toolchain_ref,
          root_executable_ref: m.root_executable_ref,
          root_measurement_ref: m.root_measurement_ref,
        }) ||
      canonicalJson(sealed.production_record_ref) !== canonicalJson(m.production_record_ref) ||
      canonicalJson(sealed.record_ref) !== canonicalJson(m.record_ref) ||
      canonicalJson(sealed.binding_ref) !== canonicalJson(m.binding_ref) ||
      canonicalJson(sealed.review_ref) !== canonicalJson(m.review_ref) ||
      canonicalJson(sealed.host_attestation_ref) !== canonicalJson(m.attestation_ref)
    )
      throw new Error("p03_sealed_original_refs_mismatch");
    if (proposal === undefined) this.currentP02(m, this.input.store);
    else this.assertCurrentP02(m, proposal);
  }
  assertPredecessorClosure(m: ScaP03PredecessorBindingV1, proposal: ScaP03InitialProposalV1): void {
    const limits = deriveScaP03InitialCustodyV1(proposal.input_refs);
    const replay = loadScaP03PredecessorInputsV1(
      {
        schema_id: "penny.sca-p03-predecessor-inputs.v1",
        schema_version: 1,
        store_root: this.input.store.root,
        tenant_id: m.tenant_id,
        project_id: m.project_id,
        request_ref: m.accepted_p02.p02_request_ref,
        transition_ref: m.accepted_p02.transition_ref,
        definition_ref: m.accepted_p02.qualification_definition_ref,
        gate_ref: m.accepted_p02.qualification_gate_ref,
        qualification_ref: m.p02_proposed_start.qualification_ref,
        historical_authority_ref: m.p02_authority_ref,
        historical_issuance_ref: m.p02_issuance_ref,
        issuance_producer: this.input.p02_host.issuance_contract.producer,
        authority_producer: this.input.p02_host.authority_contract.producer,
        root_tool_id: m.root_tool_id,
        limits,
      },
      proposal.input_refs
    );
    if (replay.status !== "ready") throw new Error("p03_initial_exact_predecessor_replay_denied");
    const known = new Map(proposal.input_refs.map((ref) => [ref.artifact_id, canonicalJson(ref)]));
    if (
      replay.value.closure.refs.some((ref) => known.get(ref.artifact_id) !== canonicalJson(ref)) ||
      canonicalJson(replay.value.accepted_p01) !== canonicalJson(m.accepted_p01) ||
      canonicalJson(replay.value.bootstrap_operands.accepted_p02) !==
        canonicalJson(m.accepted_p02) ||
      replay.value.recorded_root_closure.image_ref !== this.capsule.config.image_ref ||
      replay.value.recorded_root_closure.joern_version !==
        this.capsule.config.expected_joern_version
    )
      throw new Error("p03_initial_predecessor_closure_cross_splice");
  }
  assertOperation(
    context: import("../../orchestration/dist/host-operations/contracts.js").HostOperationExecutionContextV1
  ): void {
    context.signal.throwIfAborted();
    if (
      context.journal.project_id !== this.input.p02_host.project_id ||
      context.directive.policy_binding.backend_key_sha256 !==
        this.input.approved_backend_resource_sha256 ||
      ![
        "sca.p03.qualify-joern.v1",
        "sca.p03.build-source-graph.v1",
        "sca.p03.run-baseline-query-batch.v1",
      ].includes(context.directive.operation_kind)
    )
      throw new Error("p03_production_owned_scope_invalid");
  }
  /** Fresh native admission, issuer clock and canonical owner ledger. Never historical time replay. */
  assertCurrentP02(m: ScaP03PredecessorBindingV1, proposal: ScaP03InitialProposalV1): void {
    const reader = createScaP03ApprovedInputReaderV1(this.input.store, proposal.input_refs);
    for (const ref of [
      m.p02_authority_ref,
      m.p02_issuance_ref,
      m.p02_proposed_start.authority_ref,
      m.p02_proposed_start.qualification_ref,
      m.p02_proposed_start.gate_ref,
    ])
      reader.assertApprovedRef(ref);
    this.currentP02(m, reader);
    reader.finish();
  }
  private currentP02(m: ScaP03PredecessorBindingV1, reader: ArtifactHostStore): void {
    const h = this.input.p02_host;
    if (
      m.tenant_id !== h.tenant_id ||
      m.project_id !== h.project_id ||
      canonicalJson(m.accepted_p02.qualification_definition_ref) !==
        canonicalJson(h.definition_ref) ||
      canonicalJson(m.accepted_p02.qualification_gate_ref) !== canonicalJson(h.gate_ref)
    )
      throw new Error("p03_initial_p02_host_binding_invalid");
    requireScaP03AcceptedP02Qualification({
      store: reader,
      definition_ref: h.definition_ref,
      gate_ref: h.gate_ref,
      tenant_id: h.tenant_id,
      project_id: h.project_id,
      accepted_p02_refs: [
        m.accepted_p02.transition_ref,
        m.accepted_p02.p02_request_ref,
        m.accepted_p02.gate_ref,
        m.accepted_p02.m1_ref,
        m.accepted_p02.coverage_matrix_ref,
        m.accepted_p02.evidence_manifest_ref,
        m.accepted_p02.successor_ledger_ref,
        ...m.accepted_p02.evidence_refs,
      ],
    });
    const host = createScaP02ActivationHostV1({
      ...h,
      store: this.input.store,
      owner: this.input.p02_owner,
      artifact_reads: reader,
    });
    const admission = requireScaActivationAdmissionV1({ host, proposed: m.p02_proposed_start });
    const authority = validateContract(
      Type.Object({ issuance_record_ref: Type.Unknown() }, { additionalProperties: true }),
      JSON.parse(reader.readById(m.p02_authority_ref.artifact_id).toString()),
      "P02 authority issuance projection"
    );
    if (
      admission.phase_id !== "SCA-P02" ||
      canonicalJson(authority.issuance_record_ref) !== canonicalJson(m.p02_issuance_ref)
    )
      throw new Error("p03_initial_p02_issuance_invalid");
    this.input.p02_registry.resolve({ host, proposed: m.p02_proposed_start });
  }
}
