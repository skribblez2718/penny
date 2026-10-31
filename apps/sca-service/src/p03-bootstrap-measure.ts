import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { readStableScaP03FileV1 } from "./p03-bootstrap-local-probe.js";
import {
  dockerCommandV1,
  verifyScaP03DockerConfigV1,
  type DockerRunnerV1,
  type ScaP03DockerCandidateConfigV1,
} from "./p03-docker-runtime.js";
import { sha256 } from "../../orchestration/dist/canonical-json.js";
import type {
  ScaP03CliFreezeManifest,
  ScaP03CliProductionFreezeManifest,
} from "./p03-bootstrap-cli-contracts.js";
import {
  assertScaP03JoernLauncherProbeV1,
  parseScaP03JoernPackageListingV1,
} from "./p03-toolchain-version.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ScaP03BootstrapEnvironmentMeasurementV1 {
  readonly docker_executable_bytes: Uint8Array;
  readonly docker_client_version: string;
  readonly docker_server_version: string;
  readonly image_ref: string;
  readonly image_id: string;
  readonly joern_version: string;
  readonly php_frontend_version: string;
  readonly javascript_frontend_version: string;
  readonly jvm_version: string;
  readonly php_runtime_version: string;
  readonly helper_version: string;
}

/** Bootstrap-only independent Docker and toolchain measurement. The image is never pulled. */
export async function measureScaP03BootstrapEnvironmentV1(
  manifest: ScaP03CliFreezeManifest | ScaP03CliProductionFreezeManifest,
  runner: DockerRunnerV1 = dockerCommandV1(manifest.config.docker_executable)
): Promise<ScaP03BootstrapEnvironmentMeasurementV1> {
  const c: ScaP03DockerCandidateConfigV1 = manifest.config;
  verifyScaP03DockerConfigV1(c);
  const executableStat = lstatSync(c.docker_executable);
  if (
    !executableStat.isFile() ||
    executableStat.isSymbolicLink() ||
    executableStat.nlink !== 1 ||
    (executableStat.mode & 0o022) !== 0 ||
    (executableStat.mode & constants.S_IXUSR) === 0
  )
    throw new Error("p03_cli_docker_executable_custody_invalid");
  const docker_executable_bytes = readStableScaP03FileV1(c.docker_executable, 256 * 1024 * 1024);
  if (sha256(docker_executable_bytes) !== c.expected_docker_executable_sha256)
    throw new Error("p03_cli_docker_executable_drift");
  const dockerConfig = await mkdtemp(path.join(c.staging_parent, "p03-bootstrap-probe-"));
  await chmod(dockerConfig, 0o700);
  const signal = new AbortController().signal;
  const run = (argv: readonly string[]) =>
    runner({
      argv,
      signal,
      timeout_ms: c.timeout_ms,
      output_bytes: c.max_command_output_bytes,
      docker_config: dockerConfig,
    });
  try {
    const version: unknown = JSON.parse(await run(["version", "--format", "{{json .}}"]));
    const image: unknown = JSON.parse(
      await run(["image", "inspect", "--format", "{{json .}}", c.image_ref])
    );
    if (
      !object(version) ||
      !object(version.Client) ||
      !object(version.Server) ||
      typeof version.Client.Version !== "string" ||
      typeof version.Server.Version !== "string" ||
      !object(image) ||
      typeof image.Id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.includes(c.image_ref)
    )
      throw new Error("p03_cli_docker_image_invalid");
    const docker_client_version = version.Client.Version;
    const docker_server_version = version.Server.Version;
    if (
      docker_client_version !== c.expected_docker_client_version ||
      docker_server_version !== c.expected_docker_server_version
    )
      throw new Error("p03_cli_docker_version_drift");
    const name = `penny-p03-${randomUUID()}`;
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("p03_cli_non_posix");
    let created = false;
    let measurement: ScaP03BootstrapEnvironmentMeasurementV1 | undefined;
    let probeFailed = false;
    let probeFailure: unknown;
    try {
      created = true;
      const id = (
        await run([
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
          `${uid}:${gid}`,
          "--init",
          "--log-driver",
          "none",
          "--tmpfs",
          "/tmp:rw,exec,nosuid,nodev,size=67108864",
          "--workdir",
          "/tmp",
          "--env",
          "HOME=/tmp",
          "--entrypoint",
          "sleep",
          c.image_ref,
          "infinity",
        ])
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("p03_cli_probe_container_invalid");
      const inspected: unknown = JSON.parse(
        await run(["container", "inspect", "--format", "{{json .}}", id])
      );
      if (
        !object(inspected) ||
        inspected.Id !== id ||
        inspected.Image !== image.Id ||
        inspected.Name !== `/${name}` ||
        !object(inspected.HostConfig) ||
        inspected.HostConfig.NetworkMode !== "none" ||
        inspected.HostConfig.ReadonlyRootfs !== true ||
        inspected.HostConfig.Privileged !== false ||
        inspected.HostConfig.Init !== true ||
        !object(inspected.Config) ||
        inspected.Config.User !== `${uid}:${gid}` ||
        !Array.isArray(inspected.Mounts) ||
        inspected.Mounts.length !== 0
      )
        throw new Error("p03_cli_probe_confinement_invalid");
      await run(["container", "start", id]);
      const raw = async (argv: readonly string[]) => {
        if (argv.some((arg) => /[\r\n\0]/.test(arg)))
          throw new Error("p03_cli_probe_command_invalid");
        return run(["container", "exec", id, ...argv]);
      };
      const output = async (argv: readonly string[]) => {
        const firstLine = (await raw(argv)).trim().split("\n")[0]?.trim();
        if (!firstLine || firstLine.length > 256) throw new Error("p03_cli_probe_version_invalid");
        // Persist a version token, never a tool banner or a host/container path.
        const version = firstLine.match(/\b[0-9]+(?:\.[0-9]+){0,5}(?:[-+][A-Za-z0-9.]+)?\b/)?.[0];
        if (!version || version.length > 64) throw new Error("p03_cli_probe_version_invalid");
        return version;
      };
      const packageListing = (component: "joern-cli" | "php2cpg" | "jssrc2cpg") =>
        raw([
          "find",
          "/opt/joern",
          "-type",
          "f",
          "-name",
          `io.joern.${component}-*.jar`,
          "-printf",
          "%f\\n",
        ]);
      // Joern's launcher accepts unknown flags and enters the REPL, so `joern --version`
      // is not a trustworthy probe. Require one exact CLI package in the already
      // digest-pinned image and separately prove the expected launcher loads its help entrypoint.
      const joern_version = parseScaP03JoernPackageListingV1(
        await packageListing("joern-cli"),
        "joern-cli"
      );
      assertScaP03JoernLauncherProbeV1(
        await raw(["which", "joern"]),
        await raw(["joern", "--help"])
      );
      if (joern_version !== c.expected_joern_version) throw new Error("p03_cli_joern_drift");
      const tools = manifest.toolchain_version_commands;
      const php_frontend_version = parseScaP03JoernPackageListingV1(
        await raw(tools.php_frontend),
        "php2cpg"
      );
      const javascript_frontend_version = parseScaP03JoernPackageListingV1(
        await raw(tools.javascript_frontend),
        "jssrc2cpg"
      );
      if (php_frontend_version !== joern_version || javascript_frontend_version !== joern_version)
        throw new Error("p03_cli_frontend_version_drift");
      measurement = {
        docker_executable_bytes,
        docker_client_version,
        docker_server_version,
        image_ref: c.image_ref,
        image_id: image.Id,
        joern_version,
        php_frontend_version,
        javascript_frontend_version,
        jvm_version: await output(tools.jvm),
        php_runtime_version: await output(tools.php_runtime),
        helper_version: await output(tools.helper),
      };
    } catch (error) {
      probeFailed = true;
      probeFailure = error;
    }
    if (created) {
      try {
        await run(["container", "rm", "--force", name]);
      } catch {
        /* independently checked */
      }
    }
    const remaining = await run([
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ]);
    if (remaining.trim() !== "") throw new Error("p03_cli_probe_residue");
    if (probeFailed) throw probeFailure;
    if (measurement === undefined) throw new Error("p03_cli_probe_measurement_missing");
    return measurement;
  } finally {
    await rm(dockerConfig, { recursive: true, force: false });
  }
}
