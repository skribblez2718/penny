import { spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { assertScaP03ProtectedPathV1 } from "./p03-production-sampler.js";

const AbsolutePath = Type.String({ minLength: 2, maxLength: 4096 });
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const CopyFile = Type.Object(
  {
    source_path: AbsolutePath,
    target_relative: Type.String({ minLength: 1, maxLength: 1024 }),
    sha256: Digest,
    mode: Type.Union([Type.Literal(0o400), Type.Literal(0o500)]),
  },
  { additionalProperties: false }
);
export const ScaP03DeploymentFilesInputV1Schema = Type.Object(
  {
    deployment_root: AbsolutePath,
    files: Type.Array(CopyFile, { minItems: 1, maxItems: 16384 }),
    max_file_bytes: Type.Integer({ minimum: 1, maximum: 256 * 1_048_576 }),
    max_total_bytes: Type.Integer({ minimum: 1, maximum: 512 * 1_048_576 }),
  },
  { additionalProperties: false }
);
export type ScaP03DeploymentFilesInputV1 = Static<typeof ScaP03DeploymentFilesInputV1Schema>;
export interface ScaP03DeploymentFileV1 {
  readonly source_path: string;
  readonly target_relative: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly source_metadata: string;
  readonly mode: number;
}
export interface ScaP03DeploymentFilesReceiptV1 {
  readonly schema_id: "penny.sca-p03-deployment-files.v1";
  readonly schema_version: 1;
  readonly assurance: "measured_files_only_not_runtime_authority";
  readonly deployment_root: string;
  readonly protected_ancestry: string;
  readonly files: readonly ScaP03DeploymentFileV1[];
  readonly files_sha256: string;
}

function absolute(candidate: string): void {
  if (
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate ||
    ["\0", "\r", "\n"].some((character) => candidate.includes(character)) ||
    candidate === path.parse(candidate).root
  )
    throw new Error("p03_deployment_path_invalid");
}
function relative(candidate: string): void {
  if (
    path.isAbsolute(candidate) ||
    candidate.includes("\\") ||
    ["\0", "\r", "\n"].some((character) => candidate.includes(character)) ||
    candidate.split("/").some((part) => part === "" || part === "." || part === "..") ||
    candidate
      .split("/")
      .some((part) =>
        /^(?:\.env(?:\..*)?|auth\.json|settings\.json|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/u.test(
          part
        )
      )
  )
    throw new Error("p03_deployment_relative_path_invalid");
}
function metadata(stat: import("node:fs").BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ]
    .map(String)
    .join(":");
}
/** Installed package hardlinks may be read, never reproduced. Interior symlinks are refused.
 * Writable original sources are permitted ONLY with an independently supplied exact-byte pin.
 * Root/same-UID writers, ACL and mount attacks remain outside the POSIX DAC contract. */
function stable(file: string, limit: number): { bytes: Buffer; identity: string } {
  absolute(file);
  const parent = path.dirname(file);
  if (realpathSync(parent) !== parent) throw new Error("p03_deployment_source_parent_link");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(limit) ||
      ![0n, BigInt(process.geteuid?.() ?? -1)].includes(before.uid) ||
      metadata(before) !== metadata(lstatSync(file, { bigint: true }))
    )
      throw new Error("p03_deployment_source_custody");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const readback = Buffer.alloc(bytes.length);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const count = readSync(fd, readback, 0, readback.length, 0);
    const identity = metadata(before);
    if (
      BigInt(length) !== before.size ||
      count !== length ||
      identity !== metadata(fstatSync(fd, { bigint: true })) ||
      identity !== metadata(lstatSync(file, { bigint: true })) ||
      realpathSync(parent) !== parent ||
      !bytes.equals(readback)
    )
      throw new Error("p03_deployment_source_changed");
    return { bytes: bytes.subarray(0, length), identity };
  } finally {
    closeSync(fd);
  }
}
function publish(file: string, bytes: Uint8Array, mode: number): void {
  const temp = path.join(path.dirname(file), `.prepare-${randomUUID()}`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // The entire containing subtree is newly created and private; no existing target is adopted.
    renameSync(temp, file);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

/** Explicit file copier, not a resolver, installer, capsule writer or qualification issuer.
 * Preflight validates EVERY pin and budget before creating the fresh root. Mid-copy failure
 * leaves only complete private files for inspection; a receipt is published last, never forged.
 * No settings, environment, canonical store, credentials or source permissions are changed. */
export function stageScaP03DeploymentFilesV1(value: unknown): ScaP03DeploymentFilesReceiptV1 {
  const input = validateContract(ScaP03DeploymentFilesInputV1Schema, value, "P03 deployment files");
  absolute(input.deployment_root);
  assertScaP03ProtectedPathV1(path.dirname(input.deployment_root), true);
  const targets = new Set<string>(["deployment-files.json"]);
  let total = 0;
  for (const file of input.files) {
    relative(file.target_relative);
    relative(path.basename(file.source_path));
    if (targets.has(file.target_relative)) throw new Error("p03_deployment_duplicate_target");
    targets.add(file.target_relative);
    const source = stable(file.source_path, input.max_file_bytes);
    if (sha256(source.bytes) !== file.sha256) throw new Error("p03_deployment_source_digest");
    total += source.bytes.byteLength;
    if (total > input.max_total_bytes) throw new Error("p03_deployment_byte_limit");
  }
  for (const target of targets) {
    for (let parent = path.dirname(target); parent !== "."; parent = path.dirname(parent))
      if (targets.has(parent)) throw new Error("p03_deployment_target_collision");
  }
  mkdirSync(input.deployment_root, { mode: 0o700 }); // EEXIST refuses adoption.
  const files: ScaP03DeploymentFileV1[] = [];
  for (const file of [...input.files].sort((a, b) =>
    a.target_relative.localeCompare(b.target_relative)
  )) {
    const source = stable(file.source_path, input.max_file_bytes);
    if (sha256(source.bytes) !== file.sha256) throw new Error("p03_deployment_source_digest");
    const target = path.join(input.deployment_root, file.target_relative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    publish(target, source.bytes, file.mode);
    const copied = stable(target, input.max_file_bytes);
    const stat = lstatSync(target);
    if (
      sha256(copied.bytes) !== file.sha256 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== file.mode
    )
      throw new Error("p03_deployment_copy_drift");
    assertScaP03ProtectedPathV1(target);
    files.push({
      ...file,
      byte_length: source.bytes.byteLength,
      source_metadata: source.identity,
    });
  }
  const receipt: ScaP03DeploymentFilesReceiptV1 = {
    schema_id: "penny.sca-p03-deployment-files.v1",
    schema_version: 1,
    assurance: "measured_files_only_not_runtime_authority",
    deployment_root: input.deployment_root,
    protected_ancestry: assertScaP03ProtectedPathV1(input.deployment_root, true),
    files,
    files_sha256: sha256(canonicalJson(files)),
  };
  publish(
    path.join(input.deployment_root, "deployment-files.json"),
    Buffer.from(canonicalJson(receipt)),
    0o400
  );
  return receipt;
}

export const ScaP03DeploymentBuildInputV1Schema = Type.Object(
  {
    source_project_root: AbsolutePath,
    build_root: AbsolutePath,
    bun_executable: AbsolutePath,
    bun_sha256: Digest,
    node_executable: AbsolutePath,
    node_sha256: Digest,
    entrypoint: AbsolutePath,
    entrypoint_sha256: Digest,
    external_packages: Type.Array(Type.String({ pattern: "^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$" }), {
      maxItems: 64,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type ScaP03DeploymentBuildInputV1 = Static<typeof ScaP03DeploymentBuildInputV1Schema>;
export interface ScaP03DeploymentBuildResultV1 {
  readonly status: "syntax_checked_bundle_only" | "blocked";
  readonly argv: readonly string[];
  readonly exit_status: number | null;
  readonly diagnostic: string;
  readonly bundle_sha256: string | null;
  readonly external_packages: readonly string[];
}
/** Strict REAL build, with no package acquisition or permissive unresolved-import fallback.
 * Only syntax is executed, never the produced module. External packages still require separate
 * measured closure and real loading checks. Success here is deliberately NOT deployability.
 * No total productive-work timeout; output and bundle-size limits are independent finite caps. */
export function buildScaP03DeploymentBundleV1(value: unknown): ScaP03DeploymentBuildResultV1 {
  const input = validateContract(ScaP03DeploymentBuildInputV1Schema, value, "P03 deployment build");
  for (const file of [
    input.source_project_root,
    input.build_root,
    input.entrypoint,
    input.bun_executable,
    input.node_executable,
  ])
    absolute(file);
  if (
    realpathSync(input.source_project_root) !== input.source_project_root ||
    !input.entrypoint.startsWith(input.source_project_root + path.sep) ||
    input.build_root === input.source_project_root ||
    input.build_root.startsWith(input.source_project_root + path.sep)
  )
    throw new Error("p03_deployment_build_boundary");
  for (const [file, digest] of [
    [input.bun_executable, input.bun_sha256],
    [input.node_executable, input.node_sha256],
  ]) {
    if (file === undefined || sha256(stable(file, 256 * 1_048_576).bytes) !== digest)
      throw new Error("p03_deployment_builder_digest");
  }
  relative(path.basename(input.entrypoint));
  if (sha256(stable(input.entrypoint, 64 * 1_048_576).bytes) !== input.entrypoint_sha256)
    throw new Error("p03_deployment_entrypoint_digest");
  assertScaP03ProtectedPathV1(path.dirname(input.build_root), true);
  mkdirSync(input.build_root, { mode: 0o700 });
  const candidate = path.join(input.build_root, "candidate.mjs");
  const argv = [
    "build",
    "--no-env-file",
    "--no-install",
    input.entrypoint,
    `--outfile=${candidate}`,
    "--target=node",
    "--format=esm",
    "--env=disable",
    "--reject-unresolved",
    `--metafile=${path.join(input.build_root, "metafile.json")}`,
    ...input.external_packages.map((name) => `--external=${name}`),
  ];
  const options = {
    cwd: input.source_project_root,
    env: { HOME: input.build_root, TMPDIR: input.build_root },
    maxBuffer: 1_048_576,
    encoding: "utf8" as const,
    shell: false,
  };
  const result = spawnSync(input.bun_executable, argv, options);
  let diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  let status: ScaP03DeploymentBuildResultV1["status"] = "blocked";
  let digest: string | null = null;
  if (result.status === 0 && result.error === undefined) {
    const bundle = stable(candidate, 32 * 1_048_576);
    const syntax = spawnSync(input.node_executable, ["--check", candidate], options);
    diagnostic += `${syntax.stdout ?? ""}${syntax.stderr ?? ""}${syntax.error?.message ?? ""}`;
    if (syntax.status === 0 && syntax.error === undefined) {
      publish(path.join(input.build_root, "runtime.mjs"), bundle.bytes, 0o400);
      status = "syntax_checked_bundle_only";
      digest = sha256(bundle.bytes);
    }
  }
  if (sha256(stable(input.entrypoint, 64 * 1_048_576).bytes) !== input.entrypoint_sha256)
    throw new Error("p03_deployment_entrypoint_changed");
  const report: ScaP03DeploymentBuildResultV1 = {
    status,
    argv,
    exit_status: result.status,
    diagnostic,
    bundle_sha256: digest,
    external_packages: input.external_packages,
  };
  publish(
    path.join(input.build_root, "build-result.json"),
    Buffer.from(canonicalJson(report)),
    0o400
  );
  return report;
}
