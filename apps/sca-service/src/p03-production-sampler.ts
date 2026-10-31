import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  SqliteScaActivationOwner,
  type ScaActivationIssuanceInstallationV1,
} from "../../orchestration/dist/sca/activation-owner.js";
import { SqliteScaPhaseActivationRegistry } from "../../orchestration/dist/sca/phase-activation.js";
import {
  validateScaActivationAuthorityV1,
  validateScaActivationIssuanceV1,
} from "../../orchestration/dist/sca/qualification-activation-contracts.js";
import { SCA_P03_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p03-playbook.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/runtime-registration-digest.js";
import { Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import { type ScaP03CurrentBootstrapSampleV1 } from "../../orchestration/dist/sca/p03-activation-host.js";
import {
  ScaP03CliProductionVerifyManifestSchema,
  parseScaP03CliCanonical,
  validateScaP03CliPaths,
} from "./p03-bootstrap-cli-contracts.js";
import { ScaP03NativeVerificationInvocationV1 } from "./p03-bootstrap-verification.js";
import { readStableScaP03FileV1 } from "./p03-bootstrap-local-probe.js";

const AbsolutePath = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^/[^\\u0000\\r\\n]*$",
});
export const ScaP03ProductionSampleInputV1Schema = Type.Object(
  {
    manifest_path: AbsolutePath,
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03ProductionSampleInputV1 = Readonly<
  Static<typeof ScaP03ProductionSampleInputV1Schema>
>;
export const ScaP03ProductionSamplerInputV1Schema = Type.Object(
  {
    ...ScaP03ProductionSampleInputV1Schema.properties,
    node_executable: AbsolutePath,
    node_executable_sha256: Sha256Schema,
    cli_entrypoint: AbsolutePath,
    cli_entrypoint_sha256: Sha256Schema,
    deployment_roots: Type.Array(AbsolutePath, { minItems: 1, maxItems: 16, uniqueItems: true }),
    external_dependency_root: Type.Union([AbsolutePath, Type.Null()]),
    external_dependency_sha256: Type.Union([Sha256Schema, Type.Null()]),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
  },
  { additionalProperties: false }
);
export type ScaP03ProductionSamplerInputV1 = Readonly<
  Static<typeof ScaP03ProductionSamplerInputV1Schema>
>;

export interface ScaP03SamplerAuthorityV1 {
  /** Already installed canonical authority. This adapter never installs, consumes or rearms it. */
  readonly owner: SqliteScaActivationOwner;
  readonly installation: ScaActivationIssuanceInstallationV1;
  /** Supply only for this authority's already-active phase row; never an unrelated row. */
  readonly phase_registry?: SqliteScaPhaseActivationRegistry;
}

// Limits apply to the reviewed host program, not an untrusted-code sandbox.
const EXECUTABLE_LIMIT = 256 * 1_048_576;
const ENTRYPOINT_LIMIT = 32 * 1_048_576;
/** POSIX DAC trust boundary: root and this effective UID are trusted writers. No ACL/mount,
 * root compromise, same-UID attacker, or sandbox claim. A root-owned sticky writable ancestor
 * is safe only when its immediate named child has a trusted owner and is not writable by others. */
export function assertScaP03ProtectedPathV1(candidate: string, directory = false): string {
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    realpathSync(candidate) !== candidate
  )
    throw new Error("p03_sampler_path_not_canonical");
  const dirs = directory ? candidate : path.dirname(candidate);
  const components = [path.parse(dirs).root];
  for (const part of dirs.slice(1).split(path.sep).filter(Boolean))
    components.push(path.join(components.at(-1) ?? "/", part));
  const identities = components.map((dir, index) => {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const named = lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.dev !== named.dev ||
        stat.ino !== named.ino ||
        named.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== uid)
      )
        throw new Error("p03_sampler_ancestor_custody_invalid");
      if ((stat.mode & 0o022) !== 0) {
        const child = components[index + 1] ?? (directory ? undefined : candidate);
        const next = child === undefined ? undefined : lstatSync(child);
        if (
          stat.uid !== 0 ||
          (stat.mode & 0o1000) === 0 ||
          next === undefined ||
          next.isSymbolicLink() ||
          (next.uid !== 0 && next.uid !== uid) ||
          (next.mode & 0o022) !== 0
        )
          throw new Error("p03_sampler_writable_ancestor");
      }
      return { path: dir, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
    } finally {
      closeSync(fd);
    }
  });
  return canonicalJson(identities);
}

/** Complete bounded no-link dependency tree, including loader JavaScript and native binaries.
 * The caller reviews and pins this digest; no package is installed or granted trust by hashing. */
export function measureScaP03ProtectedDependencyRootV1(root: string): string {
  assertScaP03ProtectedPathV1(root, true);
  const entries: { path: string; sha256: string | null; mode: number; uid: number }[] = [];
  let bytes = 0;
  const visit = (dir: string, depth: number) => {
    if (depth > 32) throw new Error("p03_sampler_dependency_limit");
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (
        entries.length >= 16384 ||
        stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
        (stat.mode & 0o022) !== 0
      )
        throw new Error("p03_sampler_dependency_custody_invalid");
      if (stat.isDirectory()) {
        assertScaP03ProtectedPathV1(file, true);
        entries.push({
          path: path.relative(root, file),
          sha256: null,
          mode: stat.mode & 0o7777,
          uid: stat.uid,
        });
        visit(file, depth + 1);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 512 * 1_048_576) throw new Error("p03_sampler_dependency_limit");
        entries.push({
          path: path.relative(root, file),
          sha256: dependencyFileDigest(file, stat.size),
          mode: stat.mode & 0o7777,
          uid: stat.uid,
        });
      } else throw new Error("p03_sampler_dependency_custody_invalid");
    }
  };
  visit(root, 0);
  return sha256(canonicalJson(entries));
}

function dependencyFileDigest(file: string, size: number): string {
  if (size !== 0) return sha256(readStableScaP03FileV1(file, 64 * 1_048_576));
  // Empty package placeholders are legitimate. Still bind a no-follow, single-link empty inode.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const named = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== 0 ||
      named.size !== 0 ||
      stat.dev !== named.dev ||
      stat.ino !== named.ino
    )
      throw new Error("p03_sampler_dependency_custody_invalid");
    return sha256("");
  } finally {
    closeSync(fd);
  }
}

export function scaP03ProductionManifestProtectedPathsV1(
  manifest: Static<typeof ScaP03CliProductionVerifyManifestSchema>
): string {
  const dirs = [manifest.store_root, manifest.working_dir, manifest.config.staging_parent];
  const files = [
    manifest.config.docker_executable,
    manifest.freeze_handoff_path,
    manifest.sealed_handoff_path,
    manifest.external_review_path,
    manifest.reviewer_public_key_path,
    path.join(manifest.working_dir, "selection.json"),
    path.join(manifest.working_dir, "registry.json"),
    ...manifest.implementation.map((m) => m.path),
    ...manifest.runtime_packages.map((m) => m.path),
  ];
  return canonicalJson({
    dirs: dirs.map((dir) => assertScaP03ProtectedPathV1(dir, true)),
    files: files.map((file) => {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        (stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
        (stat.mode & 0o022) !== 0
      )
        throw new Error("p03_sampler_input_custody_invalid");
      return assertScaP03ProtectedPathV1(file);
    }),
  });
}

function deployment(input: ScaP03ProductionSamplerInputV1) {
  const covered = (file: string) =>
    input.deployment_roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
  const roots = input.deployment_roots.map((root) => {
    if (root === path.parse(root).root) throw new Error("p03_sampler_deployment_root_too_broad");
    return assertScaP03ProtectedPathV1(root, true);
  });
  for (const file of [input.node_executable, input.cli_entrypoint, input.manifest_path]) {
    if (!covered(file)) throw new Error("p03_sampler_path_outside_deployment");
    assertScaP03ProtectedPathV1(file);
  }
  const cwd = path.dirname(input.cli_entrypoint);
  const dependency = input.external_dependency_root;
  if (
    (dependency === null) !== (input.external_dependency_sha256 === null) ||
    (dependency !== null && (dependency !== path.join(cwd, "node_modules") || !covered(dependency)))
  )
    throw new Error("p03_sampler_dependency_root_invalid");
  // Disable global CJS search and reject every undeclared ancestor node_modules candidate.
  for (let ancestor = cwd; ; ancestor = path.dirname(ancestor)) {
    const modules = path.join(ancestor, "node_modules");
    if (existsNoFollow(modules)) {
      if (modules !== dependency) throw new Error("p03_sampler_ambient_dependency_root");
    }
    if (ancestor === path.dirname(ancestor)) break;
  }
  if (
    dependency !== null &&
    measureScaP03ProtectedDependencyRootV1(dependency) !== input.external_dependency_sha256
  )
    throw new Error("p03_sampler_dependency_drift");
  return canonicalJson({
    roots,
    cwd: assertScaP03ProtectedPathV1(cwd, true),
    node: assertScaP03ProtectedPathV1(input.node_executable),
    cli: assertScaP03ProtectedPathV1(input.cli_entrypoint),
    manifest: assertScaP03ProtectedPathV1(input.manifest_path),
  });
}
function existsNoFollow(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
function decodeOwnedJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value));
}

function identity(file: string, expected: string, limit: number, executable: boolean) {
  const bytes = readStableScaP03FileV1(file, limit);
  const stat = lstatSync(file);
  if (
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    (stat.mode & 0o022) !== 0 ||
    (executable && (stat.mode & constants.S_IXUSR) === 0) ||
    sha256(bytes) !== expected
  )
    throw new Error("p03_sampler_program_identity_invalid");
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

/** Read-only production sampler for one already-consumed native verification invocation.
 * Preserve installed-authority and reviewed executable/dependency/protected-path checks. Never
 * dispatch a direct subprocess or treat later activation revocation as crash containment.
 */
export function createScaP03ProductionBootstrapSamplerV1(
  inputValue: ScaP03ProductionSamplerInputV1,
  authorityInput: ScaP03SamplerAuthorityV1
): () => ScaP03CurrentBootstrapSampleV1;
export function createScaP03ProductionBootstrapSamplerV1(
  inputValue: ScaP03ProductionSamplerInputV1,
  authorityInput: ScaP03SamplerAuthorityV1,
  invocation: ScaP03NativeVerificationInvocationV1
): () => Promise<ScaP03CurrentBootstrapSampleV1>;
export function createScaP03ProductionBootstrapSamplerV1(
  inputValue: ScaP03ProductionSamplerInputV1,
  authorityInput: ScaP03SamplerAuthorityV1,
  invocation?: ScaP03NativeVerificationInvocationV1
): () => ScaP03CurrentBootstrapSampleV1 | Promise<ScaP03CurrentBootstrapSampleV1> {
  // Own the configuration; mutation of the caller's object cannot change the admitted program/inputs.
  const input = parseScaP03CliCanonical(
    ScaP03ProductionSamplerInputV1Schema,
    Buffer.from(canonicalJson(inputValue))
  );
  if (
    !(authorityInput.owner instanceof SqliteScaActivationOwner) ||
    (authorityInput.phase_registry !== undefined &&
      !(authorityInput.phase_registry instanceof SqliteScaPhaseActivationRegistry))
  )
    throw new Error("p03_sampler_canonical_owner_required");
  const authority = validateScaActivationAuthorityV1(
    decodeOwnedJson(authorityInput.installation.authority)
  );
  const record = validateScaActivationIssuanceV1(
    decodeOwnedJson(authorityInput.installation.record)
  );
  const scope = authority.scope;
  if (
    scope.phase_id !== "SCA-P03" ||
    scope.production_playbook_name !== "sca-p03" ||
    scope.runtime_registration_sha256 !== runtimeRegistrationSha256(SCA_P03_PHASE_REGISTRATION) ||
    record.scope_sha256 !== sha256(canonicalJson(scope)) ||
    record.authority_id !== scope.authority_id ||
    canonicalJson(authority.issuance_record_ref) !==
      canonicalJson(authorityInput.installation.ref) ||
    authority.issuance_record_ref.content_digest !== sha256(canonicalJson(record))
  )
    throw new Error("p03_sampler_authority_binding_invalid");
  const owner = authorityInput.owner;
  const requireAuthority = () => {
    if (
      !owner.verifyIssuance({
        record,
        ref: authority.issuance_record_ref,
        scope,
        policy_id: scope.issuer_policy_id,
      })
    )
      throw new Error("p03_sampler_authority_denied_inspection_required");
  };
  validateScaP03CliPaths([input.node_executable, input.cli_entrypoint, input.manifest_path]);
  return () => {
    requireAuthority();
    const protection = deployment(input);
    const node = identity(
      input.node_executable,
      input.node_executable_sha256,
      EXECUTABLE_LIMIT,
      true
    );
    const entrypoint = identity(
      input.cli_entrypoint,
      input.cli_entrypoint_sha256,
      ENTRYPOINT_LIMIT,
      false
    );
    const manifest = readStableScaP03FileV1(input.manifest_path, 1_048_576, true);
    if (sha256(manifest) !== input.manifest_sha256) throw new Error("p03_sampler_manifest_drift");
    const parsedManifest = parseScaP03CliCanonical(
      ScaP03CliProductionVerifyManifestSchema,
      manifest
    );
    const manifestProtection = scaP03ProductionManifestProtectedPathsV1(parsedManifest);
    for (const file of [
      parsedManifest.store_root,
      parsedManifest.working_dir,
      parsedManifest.config.staging_parent,
      parsedManifest.config.docker_executable,
      parsedManifest.freeze_handoff_path,
      parsedManifest.sealed_handoff_path,
      parsedManifest.external_review_path,
      parsedManifest.reviewer_public_key_path,
      ...parsedManifest.implementation.map((m) => m.path),
      ...parsedManifest.runtime_packages.map((m) => m.path),
    ])
      if (
        !input.deployment_roots.some(
          (root) => file === root || file.startsWith(`${root}${path.sep}`)
        )
      )
        throw new Error("p03_sampler_path_outside_deployment");
    if (protection !== deployment(input)) throw new Error("p03_sampler_protection_changed");
    requireAuthority();
    // Read/authenticate-only is not a dispatch grant. There is deliberately no direct child
    // fallback: neither post-error revocation nor a process-local latch contains parent death.
    // Only the concrete native invocation can supply consumed verification evidence.
    if (invocation !== undefined) {
      if (!(invocation instanceof ScaP03NativeVerificationInvocationV1))
        throw new Error("p03_sampler_native_invocation_required");
      return invocation.collect().then((result) => {
        requireAuthority();
        if (
          result.manifest_sha256 !== input.manifest_sha256 ||
          protection !== deployment(input) ||
          canonicalJson(node) !==
            canonicalJson(
              identity(input.node_executable, input.node_executable_sha256, EXECUTABLE_LIMIT, true)
            ) ||
          canonicalJson(entrypoint) !==
            canonicalJson(
              identity(input.cli_entrypoint, input.cli_entrypoint_sha256, ENTRYPOINT_LIMIT, false)
            ) ||
          manifestProtection !== scaP03ProductionManifestProtectedPathsV1(parsedManifest) ||
          sha256(readStableScaP03FileV1(input.manifest_path, 1_048_576, true)) !==
            input.manifest_sha256 ||
          result.sample.handoff_sha256 !== parsedManifest.sealed_handoff_sha256
        )
          throw new Error("p03_sampler_current_invocation_drift");
        return result.sample;
      });
    }
    void manifestProtection;
    throw new Error("p03_guarded_bootstrap_verification_unavailable");
  };
}
