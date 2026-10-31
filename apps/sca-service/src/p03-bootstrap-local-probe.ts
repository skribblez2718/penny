import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  readP03BootstrapBytes,
  type ScaP03BootstrapVerificationReaderV1,
} from "./p03-bootstrap.js";
import type { ScaP03BootstrapHostProbeV1 } from "./p03-bootstrap-host.js";
import type { ScaP03WorkspaceRegistryV1 } from "./p03-bootstrap-workspaces.js";
import {
  verifyScaP03DockerConfigV1,
  scaP03OwnedAttemptOrdinalV1,
  chargeScaP03OwnedCommandV1,
  type ScaP03DockerCandidateConfigV1,
  type ScaP03DockerOwnedExecutionV1,
  type DockerRunnerV1,
} from "./p03-docker-runtime.js";
import {
  assertScaP03JoernLauncherProbeV1,
  parseScaP03JoernPackageListingV1,
} from "./p03-toolchain-version.js";

export type ScaP03ProbeCommandV1 = (
  argv: readonly string[],
  dockerConfig: string,
  signal?: AbortSignal
) => Promise<string>;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Exact, no-follow host read with stable named inode, size and readback. */
export function readStableScaP03FileV1(
  file: string,
  limit: number,
  privateFile = false
): Uint8Array {
  if (
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    limit < 1 ||
    !Number.isSafeInteger(limit)
  )
    throw new Error("p03_host_file_path_invalid");
  const parent = path.dirname(file);
  const parentBefore = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !parentBefore.isDirectory() ||
    parentBefore.isSymbolicLink()
  )
    throw new Error("p03_host_file_parent_invalid");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    const named = lstatSync(file);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > limit ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      (privateFile && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600))
    )
      throw new Error("p03_host_file_custody_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    const still = lstatSync(file);
    const parentAfter = lstatSync(parent);
    const readback = Buffer.alloc(before.size + 1);
    const count = readSync(fd, readback, 0, readback.length, 0);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      still.ino !== before.ino ||
      still.dev !== before.dev ||
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      parentAfter.isSymbolicLink() ||
      realpathSync(parent) !== parent ||
      count !== before.size ||
      sha256(readback.subarray(0, count)) !== sha256(bytes.subarray(0, length))
    )
      throw new Error("p03_host_file_raced");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
export interface ScaP03LocalHostProbeConfigV1 {
  config: ScaP03DockerCandidateConfigV1;
  store: ScaP03BootstrapVerificationReaderV1;
  build_files: Readonly<Record<string, string>>;
  runtime_package_refs: readonly ArtifactRef[];
  current_selection_path: string;
  registry: ScaP03WorkspaceRegistryV1;
}
export function createScaP03LocalHostProbeV1(
  input: ScaP03LocalHostProbeConfigV1
): ScaP03BootstrapHostProbeV1 {
  return makeProbe(input);
}
/** Offline contract tests only; callers cannot supply a process runner to the production factory. */
export function createScaP03LocalHostProbeDeterministicTestOnlyV1(
  input: ScaP03LocalHostProbeConfigV1,
  command: ScaP03ProbeCommandV1
): ScaP03BootstrapHostProbeV1 {
  return makeProbe(input, command);
}
/** Native bounded verification transport, sharing the caller's existing guarded fence. */
export function createScaP03OwnedLocalHostProbeV1(
  input: ScaP03LocalHostProbeConfigV1,
  owned: ScaP03DockerOwnedExecutionV1,
  runner: DockerRunnerV1
): ScaP03BootstrapHostProbeV1 {
  if (owned.context.journal.lifecycle !== "submitted") throw new Error("p03_probe_guard_required");
  return makeProbe(
    input,
    async (argv, dockerConfig, signal) => {
      chargeScaP03OwnedCommandV1(owned);
      const cleanup = signal !== owned.context.signal;
      if (!cleanup) owned.assertAuthority();
      const result = await runner({
        argv,
        docker_config: dockerConfig,
        signal: signal ?? owned.context.signal,
        timeout_ms: owned.resources.inactivity_ms,
        output_bytes: owned.resources.command_output_bytes,
      });
      if (Buffer.byteLength(result) > owned.resources.command_output_bytes)
        throw new Error("p03_probe_output_limit");
      if (!cleanup) {
        owned.assertAuthority();
        owned.context.reportActivity("p03_probe_command_completed", Buffer.byteLength(result) + 1);
      }
      return result;
    },
    owned
  );
}
const nativeProbes = new WeakMap<ScaP03BootstrapHostProbeV1, ScaP03LocalHostProbeConfigV1>();
/** Only a concrete local probe can be rebound to the same canonical operation. No arbitrary
 * probe callback, structural flag or test authority is promoted by this binding. */
export function bindScaP03LocalProbeToOwnedOperationV1(
  probe: ScaP03BootstrapHostProbeV1,
  owned: ScaP03DockerOwnedExecutionV1,
  runner: DockerRunnerV1
): ScaP03BootstrapHostProbeV1 {
  const input = nativeProbes.get(probe);
  if (input === undefined) throw new Error("p03_native_owned_probe_required");
  return createScaP03OwnedLocalHostProbeV1(input, owned, runner);
}
function makeProbe(
  input: ScaP03LocalHostProbeConfigV1,
  injected?: ScaP03ProbeCommandV1,
  owned?: ScaP03DockerOwnedExecutionV1
): ScaP03BootstrapHostProbeV1 {
  const { config, store, registry } = input;
  let probeOrdinal = 0;
  verifyScaP03DockerConfigV1(config);
  const staging = lstatSync(config.staging_parent);
  if (
    !staging.isDirectory() ||
    staging.isSymbolicLink() ||
    realpathSync(config.staging_parent) !== config.staging_parent ||
    staging.uid !== process.getuid?.() ||
    (staging.mode & 0o077) !== 0
  )
    throw new Error("p03_host_staging_parent_invalid");
  if (
    Object.keys(input.build_files).length === 0 ||
    Object.keys(input.build_files).length > 256 ||
    !Object.entries(input.build_files).every(
      ([id, file]) => /^art_[a-f0-9]{64}$/.test(id) && path.isAbsolute(file)
    )
  )
    throw new Error("p03_host_build_mapping_invalid");
  if (
    input.runtime_package_refs.length === 0 ||
    input.runtime_package_refs.length > 128 ||
    new Set(input.runtime_package_refs.map((ref) => ref.artifact_id)).size !==
      input.runtime_package_refs.length
  )
    throw new Error("p03_host_package_refs_invalid");
  if (!path.isAbsolute(input.current_selection_path))
    throw new Error("p03_host_selection_path_invalid");
  const command: ScaP03ProbeCommandV1 =
    injected ??
    ((argv, dockerConfig, signal) =>
      new Promise((resolve, reject) => {
        execFile(
          config.docker_executable,
          [...argv],
          {
            shell: false,
            timeout: config.timeout_ms,
            maxBuffer: Math.min(config.max_command_output_bytes, 1024 * 1024),
            env: { PATH: "/usr/bin:/bin", DOCKER_CONFIG: dockerConfig },
            ...(signal === undefined ? {} : { signal }),
          },
          (error, stdout) =>
            error === null ? resolve(stdout) : reject(new Error("p03_host_docker_command_failed"))
        );
      }));
  async function withConfig<T>(
    signal: AbortSignal | undefined,
    fn: (
      run: (argv: readonly string[]) => Promise<string>,
      cleanupRun: (argv: readonly string[]) => Promise<string>
    ) => Promise<T>
  ): Promise<T> {
    signal ??= owned?.context.signal;
    signal?.throwIfAborted();
    owned?.assertAuthority();
    const dir = await mkdtemp(path.join(config.staging_parent, "p03-probe-"));
    await chmod(dir, 0o700);
    const cleanup = new AbortController();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupRun = (argv: readonly string[]) => {
      cleanupTimer ??= setTimeout(
        () => cleanup.abort(new Error("p03_probe_cleanup_grace_expired")),
        owned?.resources.cleanup_grace_ms ?? config.timeout_ms
      );
      return command(argv, dir, cleanup.signal);
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await fn((argv) => command(argv, dir, signal), cleanupRun) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    }
    try {
      await rm(dir, { recursive: true, force: false });
      try {
        lstatSync(dir);
        throw new Error("p03_probe_workspace_residue");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    } catch (cleanupError) {
      throw new Error("p03_cleanup_unproven", {
        cause: { problem: outcome.ok ? undefined : outcome.error, cleanupError },
      });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  async function census(
    names: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly { name: string; id: string }[]> {
    signal?.throwIfAborted();
    if (
      names.length > 256 ||
      new Set(names).size !== names.length ||
      names.some((name) => !/^penny-p03-[a-f0-9-]{36}$/.test(name))
    )
      throw new Error("p03_host_census_names_invalid");
    return withConfig(signal, async (run) => {
      const rows: { name: string; id: string }[] = [];
      for (const name of names) {
        const listing = await run([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{json .}}",
        ]);
        if (listing.length > 1024 * 1024) throw new Error("p03_host_census_limit");
        for (const line of listing.trim().split("\n")) {
          if (line === "") continue;
          const raw: unknown = JSON.parse(line);
          if (
            !object(raw) ||
            raw.Names !== name ||
            typeof raw.ID !== "string" ||
            !/^[a-f0-9]{64}$/.test(raw.ID)
          )
            throw new Error("p03_host_census_invalid");
          rows.push({ name, id: raw.ID });
        }
      }
      if (new Set(rows.map((row) => row.name)).size !== rows.length)
        throw new Error("p03_host_census_ambiguous");
      return rows;
    });
  }
  const probe: ScaP03BootstrapHostProbeV1 = {
    now: () => new Date(),
    workspacePaths: async (id, signal) => {
      signal?.throwIfAborted();
      return registry.paths(id);
    },
    workspaceIdentityDigest: async (id, signal) => {
      signal?.throwIfAborted();
      return registry.digest(id);
    },
    readBuildFile: async (ref: ArtifactRef, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const file = input.build_files[ref.artifact_id];
      if (
        file === undefined ||
        store.refById(ref.artifact_id)?.content_digest !== ref.content_digest
      )
        throw new Error("p03_host_build_mapping_missing");
      const bytes = readStableScaP03FileV1(file, 16 * 1024 * 1024);
      if (sha256(bytes) !== sha256(readP03BootstrapBytes(store, ref)))
        throw new Error("p03_host_build_drift");
      return bytes;
    },
    currentSelection: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return readStableScaP03FileV1(input.current_selection_path, 1024 * 1024, true);
    },
    containerCensus: census,
    inspectContainer: async (name, id, signal) => {
      signal?.throwIfAborted();
      if (!/^penny-p03-[a-f0-9-]{36}$/.test(name) || !/^[a-f0-9]{64}$/.test(id))
        throw new Error("p03_host_inspect_invalid");
      const raw = await withConfig(signal, (run) =>
        run(["container", "inspect", "--format", "{{json .}}", id])
      );
      const value: unknown = JSON.parse(raw);
      if (!object(value) || value.Id !== id || value.Name !== `/${name}`)
        throw new Error("p03_host_inspect_drift");
      return Buffer.from(raw);
    },
    measureIdentity: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const executableStat = lstatSync(config.docker_executable);
      if (
        !executableStat.isFile() ||
        executableStat.nlink !== 1 ||
        (executableStat.mode & 0o022) !== 0 ||
        (executableStat.mode & constants.S_IXUSR) === 0
      )
        throw new Error("p03_host_docker_custody_invalid");
      const executable = readStableScaP03FileV1(config.docker_executable, 256 * 1024 * 1024);
      const docker_executable_sha256 = sha256(executable);
      if (docker_executable_sha256 !== config.expected_docker_executable_sha256)
        throw new Error("p03_host_docker_drift");
      let measuredImageId: string | undefined;
      await withConfig(signal, async (run, cleanupRun) => {
        const version: unknown = JSON.parse(await run(["version", "--format", "{{json .}}"]));
        const image: unknown = JSON.parse(
          await run(["image", "inspect", "--format", "{{json .}}", config.image_ref])
        );
        if (
          !object(version) ||
          !object(version.Client) ||
          !object(version.Server) ||
          version.Client.Version !== config.expected_docker_client_version ||
          version.Server.Version !== config.expected_docker_server_version ||
          !object(image) ||
          typeof image.Id !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
          !Array.isArray(image.RepoDigests) ||
          !image.RepoDigests.includes(config.image_ref)
        )
          throw new Error("p03_host_daemon_drift");
        measuredImageId = image.Id;
        if (owned !== undefined) probeOrdinal = scaP03OwnedAttemptOrdinalV1(owned);
        const seed = owned === undefined ? null : sha256(owned.context.journal.operation_record_id);
        const n = seed === null ? null : sha256(`${seed}:${String(probeOrdinal)}`);
        const name =
          n === null
            ? `penny-p03-${randomUUID()}`
            : `penny-p03-${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid === undefined || gid === undefined) throw new Error("p03_host_non_posix");
        let createAttempted = false;
        let probeFailed = false;
        let probeFailure: unknown;
        try {
          createAttempted = true;
          const id = (
            await run([
              "container",
              "create",
              "--pull=never",
              ...(owned === undefined ? [] : ["--no-healthcheck"]),
              "--name",
              name,
              ...(seed === null
                ? []
                : [
                    "--label",
                    `penny.sca.p03.operation=${seed}`,
                    "--label",
                    `penny.sca.p03.attempt=${String(probeOrdinal)}`,
                  ]),
              "--network",
              "none",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--pids-limit",
              String(config.pids),
              "--memory",
              String(config.memory_bytes),
              "--memory-swap",
              String(config.memory_bytes),
              "--cpus",
              String(config.cpus),
              "--user",
              `${uid}:${gid}`,
              "--init",
              "--log-driver",
              "none",
              "--tmpfs",
              owned === undefined
                ? "/tmp:rw,exec,nosuid,nodev,size=67108864"
                : `/tmp:rw,exec,nosuid,nodev,size=${String(owned.resources.tmp_bytes)}`,
              ...(owned === undefined
                ? []
                : [
                    "--tmpfs",
                    `/work:rw,exec,nosuid,nodev,size=${String(owned.resources.work_bytes)},mode=0700,uid=${uid},gid=${gid}`,
                  ]),
              "--workdir",
              "/tmp",
              "--env",
              "HOME=/tmp",
              ...(owned === undefined
                ? []
                : ["--env", `JAVA_TOOL_OPTIONS=-Xmx${String(owned.resources.jvm_heap_bytes)}`]),
              "--entrypoint",
              "sleep",
              config.image_ref,
              "infinity",
            ])
          ).trim();
          if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("p03_host_probe_id_invalid");
          const inspect: unknown = JSON.parse(
            await run(["container", "inspect", "--format", "{{json .}}", id])
          );
          if (
            !object(inspect) ||
            inspect.Id !== id ||
            inspect.Image !== image.Id ||
            inspect.Name !== `/${name}` ||
            !object(inspect.HostConfig) ||
            !object(inspect.Config) ||
            !object(inspect.HostConfig.Tmpfs) ||
            !object(inspect.HostConfig.LogConfig) ||
            !Array.isArray(inspect.Mounts) ||
            inspect.Mounts.length !== 0 ||
            inspect.HostConfig.NetworkMode !== "none" ||
            inspect.HostConfig.PidMode === "host" ||
            inspect.HostConfig.IpcMode === "host" ||
            inspect.HostConfig.UTSMode === "host" ||
            inspect.HostConfig.ReadonlyRootfs !== true ||
            inspect.HostConfig.Privileged !== false ||
            inspect.HostConfig.Init !== true ||
            canonicalJson(inspect.HostConfig.CapDrop) !== canonicalJson(["ALL"]) ||
            canonicalJson(inspect.HostConfig.SecurityOpt) !==
              canonicalJson(["no-new-privileges"]) ||
            inspect.HostConfig.PidsLimit !== config.pids ||
            inspect.HostConfig.Memory !== config.memory_bytes ||
            inspect.HostConfig.MemorySwap !== config.memory_bytes ||
            inspect.HostConfig.NanoCpus !== Math.round(config.cpus * 1_000_000_000) ||
            inspect.HostConfig.LogConfig.Type !== "none" ||
            canonicalJson(inspect.HostConfig.Tmpfs) !==
              canonicalJson(
                owned === undefined
                  ? { "/tmp": "rw,exec,nosuid,nodev,size=67108864" }
                  : {
                      "/tmp": `rw,exec,nosuid,nodev,size=${String(owned.resources.tmp_bytes)}`,
                      "/work": `rw,exec,nosuid,nodev,size=${String(owned.resources.work_bytes)},mode=0700,uid=${uid},gid=${gid}`,
                    }
              ) ||
            (owned !== undefined &&
              (!object(inspect.Config.Labels) ||
                inspect.Config.Labels["penny.sca.p03.operation"] !== seed ||
                inspect.Config.Labels["penny.sca.p03.attempt"] !== String(probeOrdinal))) ||
            inspect.Config.User !== `${uid}:${gid}` ||
            inspect.Config.WorkingDir !== "/tmp" ||
            !Array.isArray(inspect.Config.Env) ||
            !inspect.Config.Env.includes("HOME=/tmp") ||
            canonicalJson(inspect.Config.Entrypoint) !== canonicalJson(["sleep"]) ||
            canonicalJson(inspect.Config.Cmd) !== canonicalJson(["infinity"])
          )
            throw new Error("p03_host_probe_confinement_invalid");
          await run(["container", "start", id]);
          const joernVersion = parseScaP03JoernPackageListingV1(
            await run([
              "container",
              "exec",
              id,
              "find",
              "/opt/joern",
              "-type",
              "f",
              "-name",
              "io.joern.joern-cli-*.jar",
              "-printf",
              "%f\\n",
            ]),
            "joern-cli"
          );
          assertScaP03JoernLauncherProbeV1(
            await run(["container", "exec", id, "which", "joern"]),
            await run(["container", "exec", id, "joern", "--help"])
          );
          if (joernVersion !== config.expected_joern_version)
            throw new Error("p03_host_joern_drift");
        } catch (error) {
          probeFailed = true;
          probeFailure = error;
        }
        if (createAttempted) {
          try {
            await cleanupRun(["container", "rm", "--force", name]);
          } catch {
            /* absence checked independently */
          }
        }
        const remaining = await cleanupRun([
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.ID}}",
        ]);
        if (remaining.trim() !== "") throw new Error("p03_host_probe_residue");
        if (probeFailed) throw probeFailure;
      });
      const executableAfter = lstatSync(config.docker_executable);
      if (
        executableAfter.dev !== executableStat.dev ||
        executableAfter.ino !== executableStat.ino ||
        executableAfter.size !== executableStat.size ||
        sha256(readStableScaP03FileV1(config.docker_executable, 256 * 1024 * 1024)) !==
          docker_executable_sha256
      )
        throw new Error("p03_host_docker_drift");
      signal?.throwIfAborted();
      const packages = [];
      for (const ref of [...input.runtime_package_refs].sort((a, b) =>
        a.artifact_id.localeCompare(b.artifact_id)
      )) {
        signal?.throwIfAborted();
        const file = input.build_files[ref.artifact_id];
        if (file === undefined) throw new Error("p03_host_package_mapping_missing");
        const current = readStableScaP03FileV1(file, 16 * 1024 * 1024);
        if (sha256(current) !== sha256(readP03BootstrapBytes(store, ref)))
          throw new Error("p03_host_package_drift");
        packages.push({ ref, current_sha256: sha256(current) });
      }
      const runtime_package_sha256 = sha256(canonicalJson(packages));
      if (measuredImageId === undefined) throw new Error("p03_host_image_measurement_missing");
      const image_id = measuredImageId;
      const deployment_sha256 = sha256(
        canonicalJson({
          docker_executable_sha256,
          docker_client_version: config.expected_docker_client_version,
          docker_server_version: config.expected_docker_server_version,
          image_id,
          joern_version: config.expected_joern_version,
        })
      );
      if (deployment_sha256 !== config.deployment_identity_sha256)
        throw new Error("p03_host_deployment_drift");
      return {
        runtime_id: config.runtime_id,
        isolation_id: config.isolation_id,
        implementation_sha256: config.implementation_identity_sha256,
        runtime_package_sha256,
        deployment_sha256,
        docker_executable_sha256,
        docker_client_version: config.expected_docker_client_version,
        docker_server_version: config.expected_docker_server_version,
        image_id,
        joern_version: config.expected_joern_version,
      };
    },
  };
  nativeProbes.set(probe, input);
  return probe;
}
