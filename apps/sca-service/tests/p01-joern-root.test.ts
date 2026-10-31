import { createServer, type Server } from "node:net";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { SCA_P01_TRUSTED_PRODUCERS } from "../../orchestration/dist/sca/p01-policy-contracts.js";
import * as processModule from "../src/process.js";
import {
  issueScaP01JoernRootV1,
  scaP01JoernImageClosureV1,
  ScaP01JoernRuntimeClosureV1Schema,
  type ScaP01JoernRootInputV1,
} from "../src/p01-joern-root.js";

const workspaceFault = vi.hoisted(() => ({ denied: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (workspaceFault.denied) return Promise.reject(new Error("workspace removal denied"));
      return actual.rm(...args);
    },
  };
});

const project = `prj_${"a".repeat(32)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const imageRef = `registry.example:5000/tools/joern@sha256:${"c".repeat(64)}`;
const containerId = "d".repeat(64);
const version = "4.1.2";
const image = () => ({
  Id: imageId,
  RepoDigests: [imageRef],
  Os: "linux",
  Architecture: "amd64",
  Config: {
    Env: ["PATH=/usr/bin:/bin", "PRIVATE_VALUE=not-persisted"],
    Entrypoint: null,
    Cmd: null,
    Volumes: null,
  },
  RootFS: { Type: "layers", Layers: [`sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`] },
});

type Fault =
  | "none"
  | "id"
  | "tag"
  | "layer"
  | "config"
  | "image_after"
  | "network"
  | "capability"
  | "mount"
  | "running"
  | "duplicate"
  | "malformed"
  | "deep"
  | "package_duplicate"
  | "package_mismatch"
  | "symlink"
  | "frontend_launcher"
  | "bad_hash"
  | "package_type"
  | "launcher_path"
  | "help"
  | "nonzero"
  | "output"
  | "timeout"
  | "oversized_help"
  | "oversized_command"
  | "cancel"
  | "lost_create"
  | "residue"
  | "cleanup_error"
  | "diff"
  | "stderr";
let root: string;
let store: ArtifactStore;
let server: Server;
let config: ScaP01JoernRootInputV1;
let controller: AbortController;
let requests: processModule.ScaProcessRequestV1[];
let fault: Fault;
let name: string;
let running: boolean;
let removed: boolean;
let imageReads: number;
const packagePaths = (component: string) => {
  const runtime = `${config.package_root}/lib/io.joern.${component}-${version}.jar`;
  return component === "joern-cli"
    ? [runtime]
    : [runtime, `${config.package_root}/lib/io.joern.${component}-${version}-launcher.jar`];
};
function container() {
  return {
    Id: containerId,
    Image: imageId,
    Name: `/${name}`,
    HostConfig: {
      NetworkMode: fault === "network" ? "host" : "none",
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      CapDrop: ["ALL"],
      CapAdd: fault === "capability" ? ["NET_ADMIN"] : null,
      SecurityOpt: ["no-new-privileges"],
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      Binds: null,
      Devices: [],
      DeviceRequests: null,
      VolumesFrom: null,
      PortBindings: {},
      PublishAllPorts: false,
      PidsLimit: config.pids,
      Memory: config.memory_bytes,
      MemorySwap: config.memory_bytes,
      NanoCpus: config.cpus * 1e9,
      LogConfig: { Type: "none" },
      Tmpfs: { "/tmp": `rw,exec,nosuid,nodev,size=${config.tmpfs_bytes}` },
    },
    Config: {
      User: `${config.uid}:${config.gid}`,
      WorkingDir: "/tmp",
      Env: ["HOME=/tmp"],
      Entrypoint: ["sleep"],
      Cmd: ["infinity"],
      Healthcheck: { Test: ["NONE"] },
    },
    Mounts:
      fault === "mount" ? [{ Type: "bind", Source: "/host", Destination: "/data", RW: true }] : [],
    State: {
      Running: fault === "running" ? false : running,
      Status: running ? "running" : "created",
    },
    NetworkSettings: { Networks: {}, IPAddress: "" },
  };
}
function reply(
  request: processModule.ScaProcessRequestV1,
  stdout: string,
  status: processModule.ScaProcessResultV1["status"] = "succeeded"
): processModule.ScaProcessResultV1 {
  return {
    schema_id: "penny.sca-process-result.v1",
    schema_version: 1,
    request_sha256: sha256(canonicalJson(request)),
    status,
    exit_code: status === "succeeded" ? 0 : 1,
    signal: null,
    stdout,
    stderr: "",
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(""),
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: 0,
    stdout_truncated: status === "output_limit",
    stderr_truncated: false,
    failure_code: status === "succeeded" ? "none" : status === "timed_out" ? "timeout" : status,
  };
}
async function docker(
  request: processModule.ScaProcessRequestV1,
  signal?: AbortSignal
): Promise<processModule.ScaProcessResultV1> {
  requests.push(request);
  const a = request.arguments;
  let out = "";
  if (a[0] === "version")
    out = JSON.stringify({ Client: { Version: "28.1.1" }, Server: { Version: "28.1.1" } });
  else if (a[0] === "image") {
    const v = image();
    imageReads++;
    if (fault === "id" || (fault === "image_after" && imageReads > 2))
      v.Id = `sha256:${"0".repeat(64)}`;
    if (fault === "tag") v.RepoDigests = [];
    if (fault === "layer") v.RootFS.Layers.reverse();
    if (fault === "config") v.Config.Env.push("DIFFERENT=1");
    out = JSON.stringify(v);
    if (fault === "duplicate") out = out.replace('"Id":', `"Id":"${imageId}","Id":`);
    if (fault === "malformed") out = "not JSON";
    if (fault === "deep") out = "[".repeat(30) + "0" + "]".repeat(30);
  } else if (a[1] === "create") {
    const value = a[a.indexOf("--name") + 1];
    if (!value) throw new Error("missing name");
    name = value;
    out = `${containerId}\n`;
    if (fault === "lost_create") throw new Error("create reply lost");
  } else if (a[1] === "inspect") out = JSON.stringify(container());
  else if (a[1] === "start") {
    running = true;
    out = `${containerId}\n`;
  } else if (a[1] === "rm") {
    expect(signal?.aborted).toBe(false);
    removed = true;
    out = `${name}\n`;
    if (fault === "cleanup_error") throw new Error("cleanup failed");
  } else if (a[1] === "ls") out = fault === "residue" ? `${containerId}\n` : "";
  else if (a[1] === "diff")
    out = fault === "diff" ? "C /immutable\n" : "C /usr\nC /usr/sbin\nA /usr/sbin/docker-init\n";
  else if (a[1] === "exec") {
    const command = a[3];
    if (command === "find") {
      const pattern = a[6];
      const component = ["joern-cli", "php2cpg", "jssrc2cpg"].find(
        (v) => pattern === `io.joern.${v}-*.jar`
      );
      if (!component) throw new Error(`unexpected find ${a.join(" ")}`);
      let files = packagePaths(component);
      if (fault === "package_duplicate" && component === "joern-cli")
        files.push(`${config.package_root}/duplicate/${path.basename(files[0] ?? "")}`);
      if (fault === "package_mismatch" && component === "php2cpg")
        files = files.map((v) => v.replace(version, "9.9.9"));
      if (fault === "frontend_launcher" && component === "jssrc2cpg") files = files.slice(0, 1);
      out = files.map((f) => `${fault === "symlink" ? "l" : "f"}\t${f}\n`).join("");
    } else if (command === "stat") out = fault === "package_type" ? "fifo\n" : "regular file\n";
    else if (command === "readlink") out = `${fault === "launcher_path" ? "/wrong" : a.at(-1)}\n`;
    else if (command === "sha256sum")
      out =
        fault === "bad_hash"
          ? "pretend digest\n"
          : `${sha256(`actual-bytes:${a.at(-1)}`)}  ${a.at(-1)}\n`;
    else if (command === config.launcher_path) {
      if (fault === "cancel") {
        controller.abort();
        return reply(request, "", "cancelled");
      }
      if (fault === "nonzero")
        return reply(request, "Usage: joern [options] [<cpg.bin>]\n", "nonzero_exit");
      if (fault === "output") return reply(request, "", "output_limit");
      if (fault === "timeout") return reply(request, "", "timed_out");
      if (fault === "oversized_command")
        return reply(request, "x".repeat(config.max_command_output_bytes + 1));
      if (fault === "oversized_help")
        return reply(request, "Usage: joern [options] [<cpg.bin>]\n" + "x".repeat(64 * 1024));
      out =
        fault === "help" ? "Joern 4.1.2 REPL\n" : "Usage: joern [options] [<cpg.bin>]\n  --help\n";
    } else throw new Error(`unexpected exec ${a.join(" ")}`);
  } else throw new Error(`unexpected command ${a.join(" ")}`);
  const result = reply(request, out);
  return fault === "stderr"
    ? { ...result, stderr: "warning", stderr_bytes: 7, stderr_sha256: sha256("warning") }
    : result;
}
function occupiedReceipt() {
  store.persist({
    metadata: {
      schema_version: 2,
      run_id: config.run_id,
      phase: "sca-p01",
      branch_id: null,
      kind: "sca-p01-tool-measurement-receipt",
      operation_id: config.operation_id,
      version: 1,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.sca-p01-tool-measurement-receipt.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    content: "existing",
  });
}

const issue = () => issueScaP01JoernRootV1({ store, config, signal: controller.signal });
function noArtifacts() {
  for (const kind of ["sca-p01-tool-executable-package", "sca-p01-tool-measurement-receipt"])
    expect(store.lastVersion(config.run_id, "sca-p01", null, kind, config.operation_id)).toBe(0);
  expect(readdirSync(config.staging_parent)).toEqual([]);
}

beforeEach(async () => {
  workspaceFault.denied = false;
  root = mkdtempSync(path.join(os.tmpdir(), "p01-root-test-"));
  chmodSync(root, 0o700);
  const staging = path.join(root, "scratch");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(staging, { mode: 0o700 });
  const executable = path.join(root, "docker");
  writeFileSync(executable, "fixture-docker-not-executed", { mode: 0o500 });
  const socket = path.join(root, "docker.sock");
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  chmodSync(socket, 0o600);
  store = ArtifactStore.provision(path.join(root, "store"), { projectId: project });
  config = {
    schema_id: "penny.sca-p01-joern-root-input.v1",
    schema_version: 1,
    project_id: project,
    run_id: "fresh-campaign",
    operation_id: "joern-root",
    tool_id: "joern",
    receipt_id: "joern-measured",
    docker_executable: executable,
    docker_executable_sha256: sha256("fixture-docker-not-executed"),
    docker_socket: socket,
    staging_parent: staging,
    image_ref: imageRef,
    expected_image_id: imageId,
    expected_image_closure_sha256: sha256(
      canonicalJson(scaP01JoernImageClosureV1(image(), imageRef))
    ),
    expected_docker_client_version: "28.1.1",
    expected_docker_server_version: "28.1.1",
    expected_joern_version: version,
    package_root: "/custom/joern",
    launcher_path: "/custom/joern/bin/joern",
    uid: 1001,
    gid: 1001,
    memory_bytes: 1024 ** 3,
    cpus: 2,
    pids: 64,
    tmpfs_bytes: 64 * 1024 ** 2,
    inactivity_ms: 5000,
    max_command_output_bytes: 1024 ** 2,
  };
  controller = new AbortController();
  requests = [];
  fault = "none";
  name = "";
  running = false;
  removed = false;
  imageReads = 0;
  vi.spyOn(processModule, "runBoundedScaProcess").mockImplementation((value, signal) =>
    docker(
      validateContract(processModule.ScaProcessRequestV1Schema, value, "test Docker request"),
      signal
    )
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("P01 measured Joern root custody", () => {
  it("persists genuine observed closure commitments under existing contracts after cleanup", async () => {
    const result = await issue();
    const bytes = store.readById(result.executable_ref.artifact_id);
    expect(bytes.toString()).toBe(canonicalJson(result.closure));
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    expect(result.closure.image.config_blob_sha256).toBe(imageId.slice(7));
    expect(result.closure.image.rootfs_diff_ids).toEqual(image().RootFS.Layers);
    expect(result.closure.image.config_projection_sha256).toBe(
      sha256(canonicalJson(image().Config))
    );
    expect(result.closure.packages).toHaveLength(5);
    for (const component of ["joern-cli", "jssrc2cpg", "php2cpg"])
      for (const file of packagePaths(component)) {
        expect(result.closure.packages).toContainEqual({
          component,
          filename: path.basename(file),
          path_sha256: sha256(file),
          content_sha256: sha256(`actual-bytes:${file}`),
        });
      }
    expect(result.executable_ref.producer).toBe(SCA_P01_TRUSTED_PRODUCERS.tool_executable);
    expect(result.executable_ref.media_type).toBe("application/octet-stream");
    expect(result.measurement_receipt_ref.producer).toBe(
      SCA_P01_TRUSTED_PRODUCERS.tool_measurement
    );
    expect(result.measurement_receipt.executable_sha256).toBe(sha256(bytes));
    expect(result.tool.executable_sha256).toBe(sha256(bytes));
    expect(result.tool.languages).toEqual(["javascript", "php", "typescript"]);
    expect(result.tool.version).toBe(version);
    expect(store.metadata(result.measurement_receipt_ref).upstream_refs).toEqual([
      result.executable_ref,
    ]);
    expect(store.readById(result.measurement_receipt_ref.artifact_id).toString()).toBe(
      canonicalJson(result.measurement_receipt)
    );
    expect(removed).toBe(true);
    expect(readdirSync(config.staging_parent)).toEqual([]);
    expect(bytes.toString()).not.toContain(root);
    expect(bytes.toString()).not.toContain("PRIVATE_VALUE");
    expect(bytes.toString()).not.toContain(config.package_root);
    const create = requests.find((r) => r.arguments[1] === "create");
    if (!create) throw new Error("no create observed");
    expect(create.arguments).toContain("--pull=never");
    expect(create.arguments).toContain(imageId);
    expect(create.arguments).not.toContain(imageRef);
    expect(
      requests.every((r) =>
        r.environment.some(
          (e) => e.name === "DOCKER_HOST" && e.value === `unix://${config.docker_socket}`
        )
      )
    ).toBe(true);
    expect(requests.every((r) => r.environment.length === 3)).toBe(true);
    expect(
      requests.some((r) =>
        ["pull", "save", "export", "load", "build", "run"].includes(r.arguments[0] ?? "")
      )
    ).toBe(false);
    validateContract(
      ScaP01JoernRuntimeClosureV1Schema,
      JSON.parse(bytes.toString()),
      "persisted closure"
    );
  });
  it("image closure is sensitive to config and ordered layer identities, not mutable labels or inspection ordering", () => {
    const original = scaP01JoernImageClosureV1(image(), imageRef);
    const changed = image();
    changed.RootFS.Layers.reverse();
    expect(sha256(canonicalJson(scaP01JoernImageClosureV1(changed, imageRef)))).not.toBe(
      sha256(canonicalJson(original))
    );
    const env = image();
    env.Config.Env.push("FOO=bar");
    expect(scaP01JoernImageClosureV1(env, imageRef).config_projection_sha256).not.toBe(
      original.config_projection_sha256
    );
    expect(
      scaP01JoernImageClosureV1({ RepoTags: ["mutable:latest"], ...image() }, imageRef)
    ).toEqual(original);
    const withoutVolumes = image();
    delete (withoutVolumes.Config as Partial<typeof withoutVolumes.Config>).Volumes;
    expect(() => scaP01JoernImageClosureV1(withoutVolumes, imageRef)).not.toThrow();
    expect(() =>
      scaP01JoernImageClosureV1(
        { ...image(), RootFS: { Type: "layers", Layers: ["not-a-digest"] } },
        imageRef
      )
    ).toThrow();
    expect(() =>
      scaP01JoernImageClosureV1(
        { ...image(), Config: { Env: [], Volumes: { "/data": {} } } },
        imageRef
      )
    ).toThrow();
  });
  it.each<Fault>([
    "id",
    "tag",
    "layer",
    "config",
    "image_after",
    "network",
    "capability",
    "mount",
    "running",
    "duplicate",
    "malformed",
    "deep",
    "package_duplicate",
    "package_mismatch",
    "symlink",
    "frontend_launcher",
    "bad_hash",
    "package_type",
    "launcher_path",
    "help",
    "nonzero",
    "output",
    "timeout",
    "oversized_help",
    "oversized_command",
    "cancel",
    "lost_create",
    "residue",
    "cleanup_error",
    "diff",
    "stderr",
  ])("fails closed without artifacts on %s", async (f) => {
    fault = f;
    await expect(issue()).rejects.toThrow();
    noArtifacts();
    if (name !== "") expect(removed).toBe(true);
    if (f === "residue" || f === "cleanup_error")
      expect(requests.some((r) => r.arguments[1] === "ls")).toBe(true);
  });
  it("cancellation before start creates no workspace or subprocess", async () => {
    controller.abort();
    await expect(issue()).rejects.toThrow();
    noArtifacts();
    expect(requests).toEqual([]);
  });
  it("refuses unknown fields, mutable tags, remote Docker, wrong store, wrong executable pins", async () => {
    const badConfigs = [
      { ...config, injected: true },
      { ...config, image_ref: "joern:latest" },
      { ...config, image_ref: imageRef.replace("joern@", "joern:tag@") },
      { ...config, docker_socket: "tcp://127.0.0.1:2375" },
      { ...config, project_id: `prj_${"1".repeat(32)}` },
      { ...config, docker_executable_sha256: "0".repeat(64) },
    ];
    for (const bad of badConfigs)
      await expect(
        issueScaP01JoernRootV1({ store, config: bad, signal: controller.signal })
      ).rejects.toThrow();
    noArtifacts();
    expect(requests).toEqual([]);
  });
  it("conflicting receipt slots block before measurement and before package persistence", async () => {
    occupiedReceipt();
    await expect(issue()).rejects.toThrow("artifact_conflict");
    expect(requests).toEqual([]);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-executable-package",
        config.operation_id
      )
    ).toBe(0);
  });
  it("does not reissue or silently adopt an already issued root", async () => {
    await issue();
    const calls = requests.length;
    await expect(issue()).rejects.toThrow("artifact_conflict");
    expect(requests).toHaveLength(calls);
  });
  it("rechecks conflicts arriving during the probe before publishing either planned artifact", async () => {
    vi.spyOn(processModule, "runBoundedScaProcess").mockImplementation(async (value, signal) => {
      const request = validateContract(
        processModule.ScaProcessRequestV1Schema,
        value,
        "test Docker request"
      );
      const result = await docker(request, signal);
      if (request.arguments[3] === config.launcher_path) occupiedReceipt();
      return result;
    });
    await expect(issue()).rejects.toThrow("artifact_conflict");
    expect(removed).toBe(true);
    expect(readdirSync(config.staging_parent)).toEqual([]);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-executable-package",
        config.operation_id
      )
    ).toBe(0);
  });
  it("a store failure returns no success and leaves only a complete measured package, never an invented receipt", async () => {
    const persist = store.persist.bind(store);
    vi.spyOn(store, "persist").mockImplementation((input) => {
      expect(removed).toBe(true);
      expect(readdirSync(config.staging_parent)).toEqual([]);
      if (input.metadata.kind === "sca-p01-tool-measurement-receipt")
        throw new Error("store fault");
      return persist(input);
    });
    await expect(issue()).rejects.toThrow("store fault");
    const ref = store.refFor(
      config.run_id,
      "sca-p01",
      null,
      "sca-p01-tool-executable-package",
      config.operation_id,
      1
    );
    if (ref === null) throw new Error("missing complete package");
    const bytes = store.readById(ref.artifact_id);
    const value: unknown = JSON.parse(bytes.toString());
    validateContract(ScaP01JoernRuntimeClosureV1Schema, value, "partial issuance package");
    expect(sha256(bytes)).toBe(ref.content_digest);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-measurement-receipt",
        config.operation_id
      )
    ).toBe(0);
    await expect(issue()).rejects.toThrow("artifact_conflict");
  });
  it("cancellation during package publication prevents receipt publication and any success result", async () => {
    const persist = store.persist.bind(store);
    vi.spyOn(store, "persist").mockImplementation((input) => {
      const ref = persist(input);
      controller.abort();
      return ref;
    });
    await expect(issue()).rejects.toThrow();
    expect(removed).toBe(true);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-executable-package",
        config.operation_id
      )
    ).toBe(1);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-measurement-receipt",
        config.operation_id
      )
    ).toBe(0);
  });
  it("workspace cleanup failure is not a successful measurement or persistence", async () => {
    workspaceFault.denied = true;
    await expect(issue()).rejects.toThrow("cleanup_unproven");
    expect(removed).toBe(true);
    expect(readdirSync(config.staging_parent)).toHaveLength(1);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-executable-package",
        config.operation_id
      )
    ).toBe(0);
    expect(
      store.lastVersion(
        config.run_id,
        "sca-p01",
        null,
        "sca-p01-tool-measurement-receipt",
        config.operation_id
      )
    ).toBe(0);
  });
  it("snapshots caller pins against mutation while asynchronous measurement is in progress", async () => {
    const mutable = { ...config };
    vi.spyOn(processModule, "runBoundedScaProcess").mockImplementation(async (value, signal) => {
      const request = validateContract(
        processModule.ScaProcessRequestV1Schema,
        value,
        "test Docker request"
      );
      mutable.tool_id = "substituted";
      mutable.expected_image_id = `sha256:${"0".repeat(64)}`;
      return docker(request, signal);
    });
    const result = await issueScaP01JoernRootV1({
      store,
      config: mutable,
      signal: controller.signal,
    });
    expect(result.tool.tool_id).toBe(config.tool_id);
    expect(result.closure.image.image_id).toBe(imageId);
  });
  it("exports the issuer from the service without registering or executing it", async () => {
    const service = await import("../src/index.js");
    expect(service.issueScaP01JoernRootV1).toBe(issueScaP01JoernRootV1);
    expect(requests).toEqual([]);
  });
  it("host custody checks refuse an unsafe scratch parent", async () => {
    chmodSync(config.staging_parent, 0o755);
    await expect(issue()).rejects.toThrow("staging_invalid");
    expect(requests).toEqual([]);
    expect(lstatSync(config.staging_parent).isDirectory()).toBe(true);
  });
});
