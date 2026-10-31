import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import {
  ArtifactStore,
  previewArtifactRef,
  type PersistArtifactInput,
} from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract, type CurrentArtifactRef } from "../../orchestration/dist/contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../../orchestration/dist/skill-contracts/common.js";
import {
  SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
  SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
  SCA_P01_TRUSTED_PRODUCERS,
  validateScaP01ToolMeasurementReceiptV1,
  type ScaP01ToolMeasurementReceiptV1,
  type ScaToolchainIdentityV1,
} from "../../orchestration/dist/sca/p01-policy-contracts.js";
import { parseScaP03JoernPackageListingV1 } from "./p03-toolchain-version.js";
import {
  runBoundedScaProcess,
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
} from "./process.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const DIGEST_ID = /^sha256:[a-f0-9]{64}$/u;
const ImageIdSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const AbsolutePathSchema = Type.String({ minLength: 1, maxLength: 4096 });
const VersionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[0-9]+(?:\\.[0-9]+){1,5}$",
});

/** Private caller configuration. No host or image paths are built into the issuer. */
export const ScaP01JoernRootInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p01-joern-root-input.v1"),
    schema_version: Type.Literal(1),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    run_id: OpaqueIdSchema,
    operation_id: OpaqueIdSchema,
    tool_id: OpaqueIdSchema,
    receipt_id: OpaqueIdSchema,
    docker_executable: AbsolutePathSchema,
    docker_executable_sha256: Sha256Schema,
    docker_socket: AbsolutePathSchema,
    staging_parent: AbsolutePathSchema,
    image_ref: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: "^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$",
    }),
    expected_image_id: ImageIdSchema,
    expected_image_closure_sha256: Sha256Schema,
    expected_docker_client_version: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    }),
    expected_docker_server_version: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    }),
    expected_joern_version: VersionSchema,
    package_root: AbsolutePathSchema,
    launcher_path: AbsolutePathSchema,
    uid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    gid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    memory_bytes: Type.Integer({ minimum: 64 * 1024 * 1024, maximum: 16 * 1024 * 1024 * 1024 }),
    cpus: Type.Integer({ minimum: 1, maximum: 16 }),
    pids: Type.Integer({ minimum: 16, maximum: 1024 }),
    tmpfs_bytes: Type.Integer({ minimum: 1024 * 1024, maximum: 256 * 1024 * 1024 }),
    inactivity_ms: Type.Integer({ minimum: 1, maximum: 300000 }),
    max_command_output_bytes: Type.Integer({ minimum: 4096, maximum: MAX_DOCKER_OUTPUT_BYTES }),
  },
  { additionalProperties: false }
);
export type ScaP01JoernRootInputV1 = Readonly<Static<typeof ScaP01JoernRootInputV1Schema>>;

const ImageClosureSchema = Type.Object(
  {
    image_id: ImageIdSchema,
    config_blob_sha256: Sha256Schema,
    config_projection_sha256: Sha256Schema,
    rootfs_diff_ids: Type.Array(ImageIdSchema, { minItems: 1, maxItems: 256 }),
    os: Type.Literal("linux"),
    architecture: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_]+$" }),
    variant: Type.Union([
      Type.String({ maxLength: 64, pattern: "^[a-zA-Z0-9._-]*$" }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);
export type ScaP01JoernImageClosureV1 = Readonly<Static<typeof ImageClosureSchema>>;

/** Bounded measurement evidence, not a restorable image/archive or an activation proof. */
export const ScaP01JoernRuntimeClosureV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p01-joern-runtime-closure.v1"),
    schema_version: Type.Literal(1),
    representation: Type.Literal("docker-local-runtime-closure"),
    image_ref: Type.String({ maxLength: 512 }),
    image: ImageClosureSchema,
    image_closure_sha256: Sha256Schema,
    docker_executable_sha256: Sha256Schema,
    docker_client_version: Type.String({ maxLength: 64 }),
    docker_server_version: Type.String({ maxLength: 64 }),
    package_root_sha256: Sha256Schema,
    joern_version: VersionSchema,
    packages: Type.Array(
      Type.Object(
        {
          component: Type.Union([
            Type.Literal("joern-cli"),
            Type.Literal("php2cpg"),
            Type.Literal("jssrc2cpg"),
          ]),
          filename: Type.String({ minLength: 1, maxLength: 256 }),
          path_sha256: Sha256Schema,
          content_sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 5, maxItems: 5 }
    ),
    launcher: Type.Object(
      {
        path_sha256: Sha256Schema,
        content_sha256: Sha256Schema,
        help_sha256: Sha256Schema,
        help_bytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 }),
      },
      { additionalProperties: false }
    ),
    init: Type.Object(
      {
        path_sha256: Sha256Schema,
        content_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    confinement: Type.Object(
      {
        network: Type.Literal("none"),
        readonly_rootfs: Type.Literal(true),
        privileged: Type.Literal(false),
        cap_drop: Type.Literal("ALL"),
        no_new_privileges: Type.Literal(true),
        uid: Type.Integer({ minimum: 1 }),
        gid: Type.Integer({ minimum: 1 }),
        memory_bytes: Type.Integer({ minimum: 1 }),
        cpus: Type.Integer({ minimum: 1 }),
        pids: Type.Integer({ minimum: 1 }),
        tmpfs_bytes: Type.Integer({ minimum: 1 }),
        inactivity_ms: Type.Integer({ minimum: 1 }),
        max_command_output_bytes: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false }
    ),
    cleanup: Type.Literal("verified-absent"),
  },
  { additionalProperties: false }
);
export type ScaP01JoernRuntimeClosureV1 = Readonly<
  Static<typeof ScaP01JoernRuntimeClosureV1Schema>
>;
export interface ScaP01IssuedJoernRootV1 {
  readonly closure: ScaP01JoernRuntimeClosureV1;
  readonly executable_ref: CurrentArtifactRef;
  readonly measurement_receipt_ref: CurrentArtifactRef;
  readonly measurement_receipt: ScaP01ToolMeasurementReceiptV1;
  readonly tool: ScaToolchainIdentityV1["tools"][number];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function fail(code: string): never {
  throw new Error(`p01_joern_${code}`);
}
function canonicalPath(p: string): void {
  if (
    !path.posix.isAbsolute(p) ||
    path.posix.normalize(p) !== p ||
    /[\r\n\t\\\0]/u.test(p) ||
    p === "/"
  )
    fail("path_invalid");
}

/** Docker JSON is bounded before parsing, including depth, token count and duplicate object keys. */
function dockerJson(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_DOCKER_OUTPUT_BYTES || text.includes("\0"))
    fail("docker_output_invalid");
  const scopes: Array<Set<string> | null> = [];
  // JSON.parse below rejects invalid escapes and literal control characters.
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]]/gu;
  let count = 0;
  for (const token of text.matchAll(tokens)) {
    if (++count > 16384) fail("docker_output_invalid");
    const s = token[0];
    if (s === "{" || s === "[") scopes.push(s === "{" ? new Set() : null);
    else if (s === "}" || s === "]") scopes.pop();
    else {
      let next = token.index + s.length;
      while (/\s/u.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] !== ":") continue;
      const key: unknown = JSON.parse(s);
      const scope = scopes.at(-1);
      if (typeof key !== "string" || scope === undefined || scope === null || scope.has(key))
        fail("docker_output_invalid");
      scope.add(key);
    }
    if (scopes.length > 16) fail("docker_output_invalid");
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return fail("docker_output_invalid");
  }
}

/** Bound direct utility inputs too, before canonical serialization allocates or recurses. */
function boundedJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length !== 0) {
    const item = pending.pop();
    if (item === undefined) fail("docker_output_invalid");
    if (++nodes > 16384 || item.depth > 16) fail("docker_output_invalid");
    const v = item.value;
    if (typeof v === "string") bytes += Buffer.byteLength(v);
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("docker_output_invalid");
    } else if (v !== null && typeof v !== "boolean") {
      if (typeof v !== "object" || seen.has(v)) fail("docker_output_invalid");
      seen.add(v);
      const entries: Array<[string, unknown]> = Object.entries(v);
      if (entries.length > 16384 || pending.length + entries.length > 16384)
        fail("docker_output_invalid");
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key);
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    if (bytes > MAX_DOCKER_OUTPUT_BYTES) fail("docker_output_invalid");
  }
}

/** Pin the daemon-observed immutable config/rootfs projection; layer order is significant. */
export function scaP01JoernImageClosureV1(
  value: unknown,
  imageRef: string
): ScaP01JoernImageClosureV1 {
  boundedJson(value);
  if (
    !object(value) ||
    typeof value.Id !== "string" ||
    !DIGEST_ID.test(value.Id) ||
    !Array.isArray(value.RepoDigests) ||
    !value.RepoDigests.every((v: unknown) => typeof v === "string") ||
    !value.RepoDigests.includes(imageRef) ||
    new Set(value.RepoDigests).size !== value.RepoDigests.length ||
    !object(value.Config) ||
    !object(value.RootFS) ||
    value.RootFS.Type !== "layers" ||
    !Array.isArray(value.RootFS.Layers) ||
    !value.RootFS.Layers.every((v: unknown) => typeof v === "string" && DIGEST_ID.test(v)) ||
    !Array.isArray(value.Config.Env) ||
    !value.Config.Env.every((v: unknown) => typeof v === "string") ||
    !(
      value.Config.Volumes === undefined ||
      value.Config.Volumes === null ||
      (object(value.Config.Volumes) && Object.keys(value.Config.Volumes).length === 0)
    )
  )
    fail("image_invalid");
  return validateContract(
    ImageClosureSchema,
    {
      image_id: value.Id,
      config_blob_sha256: value.Id.slice(7),
      config_projection_sha256: sha256(canonicalJson(value.Config)),
      rootfs_diff_ids: value.RootFS.Layers,
      os: value.Os,
      architecture: value.Architecture,
      variant: value.Variant ?? null,
    },
    "P01 Joern image closure"
  );
}

/** Stable, bounded, no-follow executable measurement without importing P03 host authority. */
function executableDigest(file: string): string {
  const parent = path.dirname(file);
  const parentBefore = lstatSync(parent);
  if (!parentBefore.isDirectory() || realpathSync(parent) !== parent) fail("executable_invalid");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 256 * 1024 * 1024
    )
      fail("executable_invalid");
    const hash = () => {
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (count === 0) break;
        position += count;
        if (position > before.size) fail("executable_drift");
        digest.update(buffer.subarray(0, count));
      }
      if (position !== before.size) fail("executable_drift");
      return digest.digest("hex");
    };
    const digest = hash();
    if (hash() !== digest) fail("executable_drift");
    const after = fstatSync(fd),
      named = lstatSync(file),
      parentAfter = lstatSync(parent);
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.nlink !== 1 ||
      named.isSymbolicLink() ||
      named.ino !== before.ino ||
      named.dev !== before.dev ||
      named.size !== before.size ||
      parentAfter.ino !== parentBefore.ino ||
      parentAfter.dev !== parentBefore.dev ||
      realpathSync(parent) !== parent
    )
      fail("executable_drift");
    return digest;
  } finally {
    closeSync(fd);
  }
}

function hostPreflight(c: ScaP01JoernRootInputV1): string {
  if (process.platform !== "linux") fail("host_invalid");
  for (const p of [
    c.docker_executable,
    c.docker_socket,
    c.staging_parent,
    c.package_root,
    c.launcher_path,
  ])
    canonicalPath(p);
  const repository = c.image_ref.split("@")[0];
  if (
    !repository ||
    c.image_ref.includes("//") ||
    repository.slice(repository.lastIndexOf("/") + 1).includes(":") ||
    !c.launcher_path.startsWith(`${c.package_root}/`)
  )
    fail("input_invalid");
  const staging = lstatSync(c.staging_parent);
  if (
    !staging.isDirectory() ||
    realpathSync(c.staging_parent) !== c.staging_parent ||
    staging.uid !== process.getuid?.() ||
    (staging.mode & 0o777) !== 0o700
  )
    fail("staging_invalid");
  const executable = lstatSync(c.docker_executable);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.nlink !== 1 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0 ||
    (executable.uid !== 0 && executable.uid !== process.getuid?.())
  )
    fail("executable_invalid");
  if (executableDigest(c.docker_executable) !== c.docker_executable_sha256)
    fail("executable_drift");
  const socket = lstatSync(c.docker_socket);
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    realpathSync(c.docker_socket) !== c.docker_socket ||
    (socket.mode & 0o002) !== 0 ||
    (socket.uid !== 0 && socket.uid !== process.getuid?.())
  )
    fail("socket_invalid");
  return canonicalJson(
    [staging, executable, socket].map((s) => ({
      dev: s.dev,
      ino: s.ino,
      mode: s.mode,
      uid: s.uid,
      gid: s.gid,
    }))
  );
}

function confined(
  value: unknown,
  c: ScaP01JoernRootInputV1,
  id: string,
  name: string,
  running: boolean
): void {
  if (
    !object(value) ||
    !object(value.HostConfig) ||
    !object(value.Config) ||
    !object(value.State) ||
    !object(value.NetworkSettings)
  )
    fail("confinement_invalid");
  const h = value.HostConfig,
    config = value.Config,
    state = value.State,
    net = value.NetworkSettings;
  const empty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
  if (
    value.Id !== id ||
    value.Image !== c.expected_image_id ||
    value.Name !== `/${name}` ||
    h.NetworkMode !== "none" ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    h.Init !== true ||
    !same(h.CapDrop, ["ALL"]) ||
    !empty(h.CapAdd) ||
    !same(h.SecurityOpt, ["no-new-privileges"]) ||
    h.PidMode !== "" ||
    h.IpcMode !== "private" ||
    h.UTSMode !== "" ||
    h.UsernsMode !== "" ||
    !empty(h.Binds) ||
    !empty(h.Devices) ||
    !empty(h.DeviceRequests) ||
    !empty(h.VolumesFrom) ||
    !object(h.PortBindings) ||
    Object.keys(h.PortBindings).length !== 0 ||
    h.PublishAllPorts !== false ||
    h.PidsLimit !== c.pids ||
    h.Memory !== c.memory_bytes ||
    h.MemorySwap !== c.memory_bytes ||
    h.NanoCpus !== c.cpus * 1e9 ||
    !object(h.LogConfig) ||
    h.LogConfig.Type !== "none" ||
    !same(h.Tmpfs, { "/tmp": `rw,exec,nosuid,nodev,size=${c.tmpfs_bytes}` }) ||
    !Array.isArray(value.Mounts) ||
    value.Mounts.length !== 0 ||
    config.User !== `${c.uid}:${c.gid}` ||
    config.WorkingDir !== "/tmp" ||
    !Array.isArray(config.Env) ||
    !config.Env.includes("HOME=/tmp") ||
    !same(config.Entrypoint, ["sleep"]) ||
    !same(config.Cmd, ["infinity"]) ||
    !same(config.Healthcheck, { Test: ["NONE"] }) ||
    state.Running !== running ||
    state.Status !== (running ? "running" : "created") ||
    !object(net.Networks) ||
    Object.entries(net.Networks).some(
      ([key, v]) => key !== "none" || !object(v) || v.IPAddress !== "" || v.GlobalIPv6Address !== ""
    ) ||
    (typeof net.IPAddress === "string" && net.IPAddress !== "")
  )
    fail("confinement_invalid");
}

async function measure(
  c: ScaP01JoernRootInputV1,
  signal: AbortSignal
): Promise<ScaP01JoernRuntimeClosureV1> {
  signal.throwIfAborted();
  const hostIdentity = hostPreflight(c);
  const work = await mkdtemp(path.join(c.staging_parent, "p01-joern-"));
  const cleanupSignal = new AbortController().signal;
  const name = `penny-p01-joern-${randomUUID()}`;
  let createAttempted = false;
  let calls = 0;
  const run = async (argv: string[], cleanup = false): Promise<string> => {
    const active = cleanup ? cleanupSignal : signal;
    active.throwIfAborted();
    if (++calls > 48) fail("command_limit");
    const request: ScaProcessRequestV1 = {
      schema_id: "penny.sca-process-request.v1",
      schema_version: 1,
      executable: c.docker_executable,
      executable_sha256: c.docker_executable_sha256,
      arguments: argv,
      cwd: work,
      environment: [
        { name: "DOCKER_CONFIG", value: work },
        { name: "DOCKER_HOST", value: `unix://${c.docker_socket}` },
        { name: "HOME", value: work },
      ],
      timeout_ms: c.inactivity_ms,
      max_stdout_bytes: c.max_command_output_bytes,
      max_stderr_bytes: c.max_command_output_bytes,
    };
    const result = validateContract(
      ScaProcessResultV1Schema,
      await runBoundedScaProcess(request, active),
      "P01 Docker result"
    );
    active.throwIfAborted();
    if (
      result.status !== "succeeded" ||
      result.exit_code !== 0 ||
      result.signal !== null ||
      result.failure_code !== "none" ||
      result.stdout_truncated ||
      result.stderr_truncated ||
      result.request_sha256 !== sha256(canonicalJson(request)) ||
      result.stdout_bytes !== Buffer.byteLength(result.stdout) ||
      result.stderr_bytes !== Buffer.byteLength(result.stderr) ||
      result.stdout_bytes > c.max_command_output_bytes ||
      result.stderr_bytes > c.max_command_output_bytes ||
      result.stdout_sha256 !== sha256(result.stdout) ||
      result.stderr_sha256 !== sha256(result.stderr) ||
      result.stdout.includes("\0") ||
      result.stderr !== ""
    )
      fail("command_failed");
    return result.stdout;
  };
  const inspectImage = async () => {
    const image = scaP01JoernImageClosureV1(
      dockerJson(await run(["image", "inspect", "--format", "{{json .}}", c.image_ref])),
      c.image_ref
    );
    if (
      image.image_id !== c.expected_image_id ||
      sha256(canonicalJson(image)) !== c.expected_image_closure_sha256
    )
      fail("image_drift");
    const byId = scaP01JoernImageClosureV1(
      dockerJson(await run(["image", "inspect", "--format", "{{json .}}", c.expected_image_id])),
      c.image_ref
    );
    if (!same(image, byId)) fail("image_drift");
    return image;
  };
  let closure: ScaP01JoernRuntimeClosureV1 | undefined;
  let failure: unknown;
  let failed = false;
  let cleanupFailure: unknown;
  try {
    const version = dockerJson(await run(["version", "--format", "{{json .}}"]));
    if (
      !object(version) ||
      !object(version.Client) ||
      !object(version.Server) ||
      version.Client.Version !== c.expected_docker_client_version ||
      version.Server.Version !== c.expected_docker_server_version
    )
      fail("docker_version_drift");
    const image = await inspectImage();
    createAttempted = true;
    const created = await run([
      "container",
      "create",
      "--pull=never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(c.pids),
      "--memory",
      String(c.memory_bytes),
      "--memory-swap",
      String(c.memory_bytes),
      "--cpus",
      String(c.cpus),
      "--user",
      `${c.uid}:${c.gid}`,
      "--ipc",
      "private",
      "--init",
      "--no-healthcheck",
      "--log-driver",
      "none",
      "--tmpfs",
      `/tmp:rw,exec,nosuid,nodev,size=${c.tmpfs_bytes}`,
      "--workdir",
      "/tmp",
      "--env",
      "HOME=/tmp",
      "--entrypoint",
      "sleep",
      c.expected_image_id,
      "infinity",
    ]);
    if (!/^[a-f0-9]{64}\n$/u.test(created)) fail("container_id_invalid");
    const id = created.slice(0, -1);
    const inspectContainer = async (running: boolean) =>
      confined(
        dockerJson(await run(["container", "inspect", "--format", "{{json .}}", id])),
        c,
        id,
        name,
        running
      );
    await inspectContainer(false);
    const start = await run(["container", "start", id]);
    if (start !== `${id}\n`) fail("container_start_invalid");
    await inspectContainer(true);
    const exec = (args: string[]) => run(["container", "exec", id, ...args]);
    const hashFile = async (file: string) => {
      if ((await exec(["stat", "-c", "%F", "--", file])) !== "regular file\n")
        fail("package_type_invalid");
      if ((await exec(["readlink", "-e", "--", file])).trim() !== file)
        fail("package_path_invalid");
      const output = await exec(["sha256sum", "--", file]);
      if (
        output !== `${output.slice(0, 64)}  ${file}\n` ||
        !/^[a-f0-9]{64}$/u.test(output.slice(0, 64))
      )
        fail("package_hash_invalid");
      return output.slice(0, 64);
    };
    const packages: ScaP01JoernRuntimeClosureV1["packages"] = [];
    for (const component of ["joern-cli", "jssrc2cpg", "php2cpg"] as const) {
      const listing = await exec([
        "find",
        c.package_root,
        "-name",
        `io.joern.${component}-*.jar`,
        "-printf",
        "%y\t%p\\n",
      ]);
      if (Buffer.byteLength(listing) > 8192 || !listing.endsWith("\n"))
        fail("package_listing_invalid");
      const files = listing
        .slice(0, -1)
        .split("\n")
        .map((line) => {
          if (!line.startsWith("f\t")) fail("package_listing_invalid");
          const file = line.slice(2);
          canonicalPath(file);
          if (!file.startsWith(`${c.package_root}/`)) fail("package_path_invalid");
          return file;
        })
        .sort();
      if (files.some((f) => path.posix.basename(f) !== path.posix.basename(f).trim()))
        fail("package_listing_invalid");
      const measured = parseScaP03JoernPackageListingV1(
        files.map((f) => path.posix.basename(f)).join("\n"),
        component
      );
      if (measured !== c.expected_joern_version) fail("package_version_drift");
      for (const file of files)
        packages.push({
          component,
          filename: path.posix.basename(file),
          path_sha256: sha256(file),
          content_sha256: await hashFile(file),
        });
    }
    const launcherHash = await hashFile(c.launcher_path);
    const initPath = "/usr/sbin/docker-init";
    const initHash = await hashFile(initPath);
    const help = await exec([c.launcher_path, "--help"]);
    if (
      !help.startsWith("Usage: joern [options] [<cpg.bin>]\n") ||
      help.includes("Unknown option") ||
      help.includes("\0") ||
      Buffer.byteLength(help) > 64 * 1024
    )
      fail("launcher_probe_invalid");
    // Docker's requested `--init` helper is the sole expected daemon-injected layer change.
    // Measure its bytes above and reject every other overlay mutation.
    const diff = (await run(["container", "diff", id]))
      .trim()
      .split("\n")
      .filter((entry) => entry.length > 0)
      .sort();
    if (!same(diff, ["A /usr/sbin/docker-init", "C /usr", "C /usr/sbin"])) fail("rootfs_mutation");
    await inspectContainer(true);
    if (!same(image, await inspectImage())) fail("image_drift");
    const versionAfter = dockerJson(await run(["version", "--format", "{{json .}}"]));
    if (
      !object(versionAfter) ||
      !object(versionAfter.Client) ||
      !object(versionAfter.Server) ||
      versionAfter.Client.Version !== c.expected_docker_client_version ||
      versionAfter.Server.Version !== c.expected_docker_server_version
    )
      fail("docker_version_drift");
    if (hostPreflight(c) !== hostIdentity) fail("host_drift");
    closure = validateContract(
      ScaP01JoernRuntimeClosureV1Schema,
      {
        schema_id: "penny.sca-p01-joern-runtime-closure.v1",
        schema_version: 1,
        representation: "docker-local-runtime-closure",
        image_ref: c.image_ref,
        image,
        image_closure_sha256: c.expected_image_closure_sha256,
        docker_executable_sha256: c.docker_executable_sha256,
        docker_client_version: c.expected_docker_client_version,
        docker_server_version: c.expected_docker_server_version,
        package_root_sha256: sha256(c.package_root),
        joern_version: c.expected_joern_version,
        packages,
        launcher: {
          path_sha256: sha256(c.launcher_path),
          content_sha256: launcherHash,
          help_sha256: sha256(help),
          help_bytes: Buffer.byteLength(help),
        },
        init: {
          path_sha256: sha256(initPath),
          content_sha256: initHash,
        },
        confinement: {
          network: "none",
          readonly_rootfs: true,
          privileged: false,
          cap_drop: "ALL",
          no_new_privileges: true,
          uid: c.uid,
          gid: c.gid,
          memory_bytes: c.memory_bytes,
          cpus: c.cpus,
          pids: c.pids,
          tmpfs_bytes: c.tmpfs_bytes,
          inactivity_ms: c.inactivity_ms,
          max_command_output_bytes: c.max_command_output_bytes,
        },
        cleanup: "verified-absent",
      },
      "P01 Joern runtime closure"
    );
  } catch (error) {
    failure = error;
    failed = true;
  }
  // Cancellation never disables owner cleanup; a lost create response is covered by the exact random name.
  if (createAttempted) {
    try {
      if ((await run(["container", "rm", "--force", name], true)) !== `${name}\n`)
        fail("container_removal_invalid");
    } catch (error) {
      if (!failed) cleanupFailure = error;
    }
    try {
      if (
        (await run(
          ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
          true
        )) !== ""
      )
        fail("container_residue");
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    await rm(work, { recursive: true, force: false });
    try {
      lstatSync(work);
      fail("workspace_residue");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== undefined)
    throw new Error("p01_joern_cleanup_unproven", { cause: { failure, cleanupFailure } });
  if (failed) throw failure;
  signal.throwIfAborted();
  if (closure === undefined) fail("measurement_missing");
  return closure;
}

/** Explicit host custody operation only. No routes, store provisioning, selection or activation. */
export async function issueScaP01JoernRootV1(input: {
  readonly store: ArtifactStore;
  readonly config: unknown;
  readonly signal: AbortSignal;
}): Promise<ScaP01IssuedJoernRootV1> {
  const { store, signal } = input;
  const c = validateContract(ScaP01JoernRootInputV1Schema, input.config, "P01 Joern root input");
  // Snapshot validated inputs before any await; caller mutation cannot change a pin mid-measurement.
  const config = validateContract(
    ScaP01JoernRootInputV1Schema,
    JSON.parse(canonicalJson(c)),
    "P01 Joern root snapshot"
  );
  signal.throwIfAborted();
  store.assertBoundProject(config.project_id);
  const metadata = (
    kind: string,
    producer: string,
    schema: string,
    media: string,
    upstream: CurrentArtifactRef[] = []
  ) => ({
    schema_version: 2 as const,
    run_id: config.run_id,
    phase: "sca-p01",
    branch_id: null,
    kind,
    operation_id: config.operation_id,
    version: 1,
    producer,
    media_type: media,
    content_schema: { schema_id: schema, schema_version: 1 },
    parent_ref: null,
    upstream_refs: upstream,
  });
  const packageMetadata = metadata(
    "sca-p01-tool-executable-package",
    SCA_P01_TRUSTED_PRODUCERS.tool_executable,
    SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
    "application/octet-stream"
  );
  const receiptMetadata = metadata(
    "sca-p01-tool-measurement-receipt",
    SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
    SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
    "application/json"
  );
  // Fresh slots only. Existing or partially issued operations are never adopted/relabelled.
  for (const m of [packageMetadata, receiptMetadata])
    if (store.lastVersion(m.run_id, m.phase, null, m.kind, m.operation_id) !== 0)
      fail("artifact_conflict");
  const closure = await measure(config, signal);
  const content = canonicalJson(closure);
  if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) fail("manifest_limit");
  const packageInput: PersistArtifactInput = { metadata: packageMetadata, content };
  const executable_ref = previewArtifactRef(packageInput);
  const measurement_receipt = validateScaP01ToolMeasurementReceiptV1({
    schema_id: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
    schema_version: 1,
    receipt_id: config.receipt_id,
    tool_id: config.tool_id,
    role: "parser",
    version: closure.joern_version,
    executable_ref,
    executable_sha256: sha256(content),
    measurement_method: "host-sha256",
    measured_at: new Date().toISOString(),
    status: "verified",
  });
  const receiptInput: PersistArtifactInput = {
    metadata: { ...receiptMetadata, upstream_refs: [executable_ref] },
    content: canonicalJson(measurement_receipt),
  };
  const measurement_receipt_ref = previewArtifactRef(receiptInput);
  signal.throwIfAborted();
  // Recheck both slots before any persistence after the async probe.
  for (const artifact of [packageInput, receiptInput]) {
    if (store.refById(previewArtifactRef(artifact).artifact_id) !== undefined)
      fail("artifact_conflict");
  }
  for (const artifact of [packageInput, receiptInput]) {
    signal.throwIfAborted();
    const planned = previewArtifactRef(artifact);
    const persisted = store.persist(artifact);
    if (
      !same(planned, persisted) ||
      !same(store.metadata(persisted), artifact.metadata) ||
      !store.readById(persisted.artifact_id).equals(Buffer.from(artifact.content))
    )
      fail("artifact_verification_failed");
  }
  signal.throwIfAborted();
  return {
    closure,
    executable_ref,
    measurement_receipt_ref,
    measurement_receipt,
    tool: {
      tool_id: config.tool_id,
      role: "parser",
      version: closure.joern_version,
      executable_ref,
      executable_sha256: executable_ref.content_digest,
      measurement_receipt_ref,
      languages: ["javascript", "php", "typescript"],
      target_execution: "forbidden",
      network_access: "denied",
      acquisition: "preinstalled-only",
    },
  };
}
