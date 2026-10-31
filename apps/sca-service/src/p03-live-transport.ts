import { spawn } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { HostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/contracts.js";
import type { ScaP03InitialResourcesV1 } from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { assertScaP03ProtectedPathV1 } from "./p03-production-sampler.js";
import { readStableScaP03FileV1 } from "./p03-bootstrap-local-probe.js";
import type { DockerCommandV1, DockerRunnerV1 } from "./p03-docker-runtime.js";

/** Accepted activity renews inactivity only. Authority expiry remains an independent clock. */
export class ScaP03ProgressInactivityV1 implements Disposable {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: number;
  private lastUnits = 0;
  constructor(
    private readonly interval: number,
    private readonly parent: AbortSignal,
    private readonly onAccepted: (units: number) => void,
    private readonly now = () => performance.now()
  ) {
    this.signal = this.controller.signal;
    this.deadline = now() + interval;
    parent.addEventListener("abort", this.abort, { once: true });
    if (parent.aborted) this.abort();
    else this.arm();
  }
  private readonly abort = () =>
    this.controller.abort(this.parent.reason ?? new Error("p03_cancelled"));
  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.signal.aborted) return;
    this.timer = setTimeout(
      () => {
        if (this.now() >= this.deadline) this.controller.abort(new Error("p03_inactivity_expired"));
        else this.arm();
      },
      Math.max(1, this.deadline - this.now())
    );
  }
  accept(units: number): void {
    this.signal.throwIfAborted();
    if (!Number.isSafeInteger(units) || units <= this.lastUnits || this.now() >= this.deadline)
      throw new Error("p03_progress_stale_or_empty");
    this.onAccepted(units); // Failed owner/fence acceptance must not renew transport liveness.
    this.lastUnits = units;
    this.deadline = this.now() + this.interval;
    this.arm();
  }
  [Symbol.dispose](): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.parent.removeEventListener("abort", this.abort);
  }
}
export interface ScaP03LiveDockerEndpointV1 {
  readonly executable: string;
  readonly executable_sha256: string;
  readonly socket: string;
  readonly image_ref: string;
}
function assertEndpoint(input: ScaP03LiveDockerEndpointV1): void {
  assertScaP03ProtectedPathV1(input.executable);
  assertScaP03ProtectedPathV1(input.socket);
  const executable = lstatSync(input.executable);
  const socket = lstatSync(input.socket);
  const uid = process.geteuid?.();
  if (
    !executable.isFile() ||
    executable.nlink !== 1 ||
    (executable.mode & constants.S_IXUSR) === 0 ||
    (executable.mode & 0o022) !== 0 ||
    ![0, uid].includes(executable.uid) ||
    sha256(readStableScaP03FileV1(input.executable, 256 * 1_048_576)) !== input.executable_sha256 ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    (socket.mode & 0o002) !== 0 ||
    ![0, uid].includes(socket.uid)
  )
    throw new Error("p03_live_endpoint_custody_invalid");
}
/** This is not a generic Docker tool. Only the adapter's closed vectors are accepted. */
export function assertScaP03ClosedDockerArgvV1(argv: readonly string[], image: string): void {
  if (
    argv.length === 0 ||
    argv.length > 128 ||
    argv.some((a) => a.length > 4096 || /[\0\r\n]/.test(a))
  )
    throw new Error("p03_live_argv_invalid");
  const same = (a: readonly string[]) => canonicalJson(a) === canonicalJson(argv);
  if (
    same(["version", "--format", "{{json .}}"]) ||
    same(["image", "inspect", "--format", "{{json .}}", image])
  )
    return;
  const name = (s: string | undefined) =>
    typeof s === "string" && /^penny-p03-[a-f0-9-]{36}$/.test(s);
  const id = (s: string | undefined) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (argv[0] !== "container") throw new Error("p03_live_argv_forbidden");
  if (
    argv[1] === "inspect" &&
    argv.length === 5 &&
    argv[2] === "--format" &&
    argv[3] === "{{json .}}" &&
    id(argv[4])
  )
    return;
  if (argv[1] === "start" && argv.length === 3 && id(argv[2])) return;
  if (argv[1] === "rm" && argv.length === 4 && argv[2] === "--force" && name(argv[3])) return;
  if (
    argv[1] === "ls" &&
    (argv.length === 7 || argv.length === 8) &&
    argv[2] === "--all" &&
    argv.slice(-2)[0] === "--format" &&
    ["{{.ID}}", "{{json .}}"].includes(argv.at(-1) ?? "") &&
    argv.includes("--filter") &&
    /^name=\^\/penny-p03-[a-f0-9-]{36}\$$/.test(argv[argv.indexOf("--filter") + 1] ?? "")
  )
    return;
  if (argv[1] === "create") {
    // Full creation syntax is adapter-owned. No host config/context, volume/device/network escapes.
    const forbidden = [
      "--privileged",
      "--volume",
      "-v",
      "--device",
      "--pid",
      "--ipc",
      "--uts",
      "--publish",
      "-p",
      "--env-file",
      "--entrypoint=",
      "--host",
      "--context",
    ];
    const required = ["--pull=never", "--read-only", "--no-healthcheck", "--init"];
    const singles = new Set(required);
    const pairs = new Set([
      "--name",
      "--network",
      "--cap-drop",
      "--security-opt",
      "--log-driver",
      "--entrypoint",
      "--pids-limit",
      "--memory",
      "--memory-swap",
      "--cpus",
      "--user",
      "--tmpfs",
      "--workdir",
      "--env",
      "--mount",
      "--label",
    ]);
    const seen = new Set<string>();
    for (let i = 2; i < argv.length - 2; i++) {
      const key = argv[i];
      if (key === undefined) throw new Error("p03_live_create_forbidden");
      if (seen.has(key) && !["--tmpfs", "--env", "--mount", "--label"].includes(key))
        throw new Error("p03_live_create_forbidden");
      seen.add(key);
      if (singles.has(key)) continue;
      if (!pairs.has(key) || argv[++i] === undefined) throw new Error("p03_live_create_forbidden");
    }
    const fixedPairs = [
      ["--network", "none"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
      ["--log-driver", "none"],
      ["--entrypoint", "sleep"],
    ];
    if (
      forbidden.some((a) => argv.some((v) => v === a || v.startsWith(`${a}=`))) ||
      required.some((a) => !argv.includes(a)) ||
      fixedPairs.some(([k, v]) => argv[argv.indexOf(k ?? "") + 1] !== v) ||
      !name(argv[argv.indexOf("--name") + 1]) ||
      argv
        .flatMap((v, i) => (v === "--label" ? [argv[i + 1]] : []))
        .some(
          (v) =>
            typeof v !== "string" ||
            !/^(?:penny\.sca\.p03\.operation=[a-f0-9]{64}|penny\.sca\.p03\.attempt=[1-9][0-9]{0,3})$/.test(
              v
            )
        ) ||
      argv.at(-2) !== image ||
      argv.at(-1) !== "infinity"
    )
      throw new Error("p03_live_create_forbidden");
    return;
  }
  if (argv[1] === "exec" && id(argv[2])) {
    const tool = argv[3];
    const tail = argv.slice(4);
    if (
      ["java", "php", "python3"].includes(tool ?? "") &&
      canonicalJson(tail) === canonicalJson(["--version"])
    )
      return;
    if (tool === "which" && canonicalJson(tail) === canonicalJson(["joern"])) return;
    if (
      tool === "find" &&
      tail.length === 7 &&
      ["io.joern.joern-cli-*.jar", "io.joern.php2cpg-*.jar", "io.joern.jssrc2cpg-*.jar"].includes(
        tail[4] ?? ""
      ) &&
      canonicalJson(tail) ===
        canonicalJson(["/opt/joern", "-type", "f", "-name", tail[4], "-printf", "%f\\n"])
    )
      return;
    if (
      tool === "joern" &&
      (canonicalJson(tail) === canonicalJson(["--help"]) ||
        canonicalJson(tail) ===
          canonicalJson([
            "--script",
            "/scripts/inventory.sc",
            "--param",
            "cpgFile=/input/graph.cpg.bin",
            "--param",
            "outFile=/work/inventory.tsv",
          ]))
    )
      return;
    if (
      tool === "python3" &&
      tail.length === 3 &&
      tail[0] === "/scripts/readback.py" &&
      ["graph.cpg.bin", "inventory.tsv"].includes(tail[1] ?? "") &&
      /^[1-9][0-9]{0,8}$/.test(tail[2] ?? "")
    )
      return;
    if (
      tool === "joern-parse" &&
      tail.length === 7 &&
      tail[0] === "--language" &&
      ["PHP", "JSSRC"].includes(tail[1] ?? "") &&
      tail[2] === "--output" &&
      tail[3] === "/work/graph.cpg.bin" &&
      tail[4] === "--max-num-def" &&
      /^[1-9][0-9]{0,6}$/.test(tail[5] ?? "") &&
      tail[6] === "/source"
    )
      return;
  }
  throw new Error("p03_live_argv_forbidden");
}
/** Pinned Joern writes ordinary diagnostics to stderr on successful graph imports.
 * Charge both streams, but return only strict stdout. Diagnostics cannot substitute for
 * stdout, successful exit, validated readback, source custody or semantic graph evidence. */
export function scaP03CompletedDockerStdoutV1(
  exitCode: number | null,
  stdout: Uint8Array,
  stderr: Uint8Array,
  outputLimit: number
): string {
  if (
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 1 ||
    stdout.byteLength + stderr.byteLength > outputLimit
  )
    throw new Error("p03_live_output_limit");
  if (exitCode !== 0) throw new Error("p03_live_command_failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
}

/** Owner-context only: constructed AFTER beginSubmission, no second lease, no child secret. */
export function createScaP03OwnedDockerTransportV1(input: {
  endpoint: ScaP03LiveDockerEndpointV1;
  resources: ScaP03InitialResourcesV1;
  context: HostOperationExecutionContextV1;
  assertAuthority(): void;
}): DockerRunnerV1 {
  const endpoint = structuredClone(input.endpoint);
  const resources = structuredClone(input.resources);
  // No effectful constructor. The admitted candidate journals the guard/correlation FIRST.
  // Every command independently requires that owned milestone; no nested lease is acquired.
  let commands = 0;
  let cleanupCommands = 0;
  let activityUnits = 0;
  const ownedNames = new Set<string>();
  let inFlight = false;
  let initialSocket: { dev: number; ino: number } | undefined;
  const run = async (command: DockerCommandV1): Promise<string> => {
    const cleanup = command.signal !== input.context.signal;
    if (
      cleanup ? ++cleanupCommands > resources.max_commands * 2 : ++commands > resources.max_commands
    )
      throw new Error("p03_live_command_budget");
    if (!["submitting", "submitted"].includes(input.context.journal.lifecycle))
      throw new Error("p03_live_submission_guard_required");
    assertScaP03ClosedDockerArgvV1(command.argv, endpoint.image_ref);
    // Only exact owned removal and absence census may execute after work cancellation/expiry.
    if (cleanup && !["rm", "ls"].includes(command.argv[1] ?? ""))
      throw new Error("p03_live_cleanup_scope");
    if (command.argv[1] === "create") {
      const argv = command.argv;
      const value = (key: string) => argv[argv.indexOf(key) + 1];
      if (
        value("--cpus") !== String(resources.cpus) ||
        value("--memory") !== String(resources.memory_bytes) ||
        value("--memory-swap") !== String(resources.memory_bytes) ||
        value("--pids-limit") !== String(resources.pids) ||
        value("--workdir") !== "/tmp"
      )
        throw new Error("p03_live_create_bounds");
      const tmpfs = argv.flatMap((a, i) => (a === "--tmpfs" ? [argv[i + 1]] : []));
      const tmp = `/tmp:rw,exec,nosuid,nodev,size=${String(resources.tmp_bytes)}`;
      const work = `/work:rw,exec,nosuid,nodev,size=${String(resources.work_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`;
      if (canonicalJson(tmpfs) !== canonicalJson([tmp, work]))
        throw new Error("p03_live_tmpfs_bounds");
      const envs = argv.flatMap((a, i) => (a === "--env" ? [argv[i + 1]] : []));
      if (
        canonicalJson(envs) !==
        canonicalJson(["HOME=/tmp", `JAVA_TOOL_OPTIONS=-Xmx${String(resources.jvm_heap_bytes)}`])
      )
        throw new Error("p03_live_environment_forbidden");
      const workspace = command.docker_config.slice(0, -"/docker-config".length);
      for (const mount of argv.flatMap((a, i) => (a === "--mount" ? [argv[i + 1]] : []))) {
        if (
          typeof mount !== "string" ||
          !["scripts", "source", "output"].some(
            (part) =>
              mount ===
              `type=bind,src=${workspace}/${part},dst=/${part === "output" ? "input" : part},readonly`
          )
        )
          throw new Error("p03_live_mount_forbidden");
      }
      const name = value("--name");
      if (name === undefined || ownedNames.has(name)) throw new Error("p03_live_name_conflict");
      const seed = sha256(input.context.journal.operation_record_id);
      const ordinal = ownedNames.size + 1;
      const n = sha256(`${seed}:${String(ordinal)}`);
      const expectedName = `penny-p03-${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
      const labels = argv.flatMap((v, i) => (v === "--label" ? [argv[i + 1]] : []));
      if (
        name !== expectedName ||
        canonicalJson(labels) !==
          canonicalJson([
            `penny.sca.p03.operation=${seed}`,
            `penny.sca.p03.attempt=${String(ordinal)}`,
          ])
      )
        throw new Error("p03_live_ownership_mapping_invalid");
      ownedNames.add(name); // BEFORE create: even a lost response remains exact owned cleanup scope.
    }
    if (cleanup) {
      const name =
        command.argv[1] === "rm"
          ? command.argv[3]
          : (command.argv[command.argv.indexOf("--filter") + 1] ?? "").slice("name=^/".length, -1);
      if (name === undefined || !ownedNames.has(name))
        throw new Error("p03_live_cleanup_not_owned");
    }
    if (!cleanup) {
      input.context.signal.throwIfAborted();
      input.assertAuthority();
    }
    assertEndpoint(endpoint);
    const currentSocket = lstatSync(endpoint.socket);
    initialSocket ??= { dev: currentSocket.dev, ino: currentSocket.ino };
    if (currentSocket.dev !== initialSocket.dev || currentSocket.ino !== initialSocket.ino)
      throw new Error("p03_live_endpoint_changed");
    if (command.output_bytes > resources.command_output_bytes)
      throw new Error("p03_live_output_policy");
    const captureLimit = Math.min(command.output_bytes, resources.command_output_bytes) - 2; // final newline/framing reserve
    if (captureLimit < 1) throw new Error("p03_live_output_policy");
    if (inFlight) throw new Error("p03_live_concurrency_limit");
    inFlight = true;
    return new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failed: Error | undefined;
      const child = spawn(endpoint.executable, [...command.argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: command.docker_config,
          DOCKER_CONFIG: command.docker_config,
          DOCKER_HOST: `unix://${endpoint.socket}`,
        },
      });
      const stop = (error: Error) => {
        failed ??= error;
        child.kill("SIGKILL");
      };
      const clock = new ScaP03ProgressInactivityV1(
        cleanup ? resources.cleanup_grace_ms : resources.inactivity_ms,
        command.signal,
        () => {
          if (!cleanup) {
            input.assertAuthority();
            input.context.reportActivity("p03_docker_output", ++activityUnits);
          }
        }
      );
      const abort = () => stop(new Error("p03_live_transport_aborted"));
      clock.signal.addEventListener("abort", abort, { once: true });
      if (clock.signal.aborted) abort();
      let progress = 0;
      for (const [stream, errorStream] of [
        [child.stdout, false],
        [child.stderr, true],
      ] as const) {
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > captureLimit) {
            stop(new Error("p03_live_output_limit"));
            return;
          }
          if (errorStream) stderr.push(chunk);
          else stdout.push(chunk);
          // Arbitrary banners/stderr or partial stdout are not completed work.
          // Only successful command completion below renews canonical inactivity.
        });
      }
      // Authority rechecks stop silent running work too. These checks NEVER renew activity.
      const authorityTimer = cleanup
        ? undefined
        : setInterval(() => {
            try {
              input.assertAuthority();
            } catch {
              stop(new Error("p03_live_authority_revoked_or_expired"));
            }
          }, 250);
      child.on("error", () => stop(new Error("p03_live_spawn_failed")));
      child.on("close", (code) => {
        inFlight = false;
        if (authorityTimer !== undefined) clearInterval(authorityTimer);
        clock[Symbol.dispose]();
        clock.signal.removeEventListener("abort", abort);
        if (failed !== undefined) reject(failed);
        else if (code !== 0) reject(new Error("p03_live_command_failed"));
        else {
          try {
            const text = scaP03CompletedDockerStdoutV1(
              code,
              Buffer.concat(stdout),
              Buffer.concat(stderr),
              captureLimit
            );
            clock.accept(++progress);
            if (!cleanup) input.assertAuthority();
            resolve(text);
          } catch {
            reject(new Error("p03_live_result_rejected"));
          }
        }
      });
    });
  };
  return run;
}
