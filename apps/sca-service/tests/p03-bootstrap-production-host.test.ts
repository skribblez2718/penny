import { SCA_P03_PRODUCTION_INPUT_CONTRACTS } from "../../orchestration/dist/sca/p03-contracts.js";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import { P03_BOOTSTRAP_ROLES } from "../src/p03-bootstrap.js";
import { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";
import { ScaP03WorkspaceRegistryV1 } from "../src/p03-bootstrap-workspaces.js";
import {
  createScaP03LocalHostProbeDeterministicTestOnlyV1,
  readStableScaP03FileV1,
} from "../src/p03-bootstrap-local-probe.js";
import { issueScaP03PostRunEvidenceV3 } from "../src/p03-bootstrap-issuers.js";
import { persistScaP03HostEvidenceV3 } from "../src/p03-bootstrap-writer.js";
import {
  validateScaP03CleanupEvidenceV2,
  validateScaP03IsolationEvidenceV2,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import type { ScaP03DockerCandidateConfigV1 } from "../src/p03-docker-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "p03-host-check-"));
  roots.push(root);
  const privateDir = path.join(root, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  const store = ArtifactStore.provision(path.join(root, "artifacts"));
  let ordinal = 0;
  function persist(
    value: unknown,
    kind: string,
    producer: string = Object.values(SCA_P03_PRODUCTION_INPUT_CONTRACTS).find(
      (entry) => entry.kind === kind
    )?.producer ?? P03_BOOTSTRAP_ROLES.frozen,
    upstream_refs: ArtifactRef[] = [],
    schema = "penny.sca-p03-runtime-package.v1"
  ): ArtifactRef {
    return store.persist({
      metadata: {
        schema_version: 2,
        run_id: "p03-test",
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id: `host-${++ordinal}`,
        version: 1,
        producer,
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: Number(schema.slice(-1)) },
        parent_ref: null,
        upstream_refs,
      },
      content: canonicalJson(value),
    });
  }
  const docker = path.join(privateDir, "docker");
  writeFileSync(docker, "fake docker", { mode: 0o700 });
  const pkgFile = path.join(privateDir, "package");
  writeFileSync(pkgFile, canonicalJson({ package: "docker-image-pin", digest: sha256("image") }));
  const pkg = persist(
    { package: "docker-image-pin", digest: sha256("image") },
    "sca-p03-runtime-package"
  );
  const packages = sha256(
    canonicalJson([{ ref: pkg, current_sha256: sha256(readStableScaP03FileV1(pkgFile, 1024)) }])
  );
  const image_id = `sha256:${sha256("image-configuration")}`;
  const image_ref = `repo/image@sha256:${sha256("image-manifest")}`;
  const docker_executable_sha256 = sha256(readStableScaP03FileV1(docker, 1024));
  const deployment_sha256 = sha256(
    canonicalJson({
      docker_executable_sha256,
      docker_client_version: "1.2.3",
      docker_server_version: "1.2.3",
      image_id,
      joern_version: "4.0.627",
    })
  );
  const config: ScaP03DockerCandidateConfigV1 = {
    docker_executable: docker,
    image_ref,
    expected_joern_version: "4.0.627",
    expected_docker_executable_sha256: docker_executable_sha256,
    expected_docker_client_version: "1.2.3",
    expected_docker_server_version: "1.2.3",
    runtime_id: "runtime",
    isolation_id: "isolation",
    isolation_profile_sha256: sha256("profile"),
    implementation_identity_sha256: sha256("implementation"),
    deployment_identity_sha256: deployment_sha256,
    staging_parent: privateDir,
    memory_bytes: 512 * 1024 * 1024,
    cpus: 1,
    pids: 32,
    max_workspace_bytes: 64 * 1024 * 1024,
    max_num_def: 100,
    max_command_output_bytes: 1024 * 1024,
    timeout_ms: 30_000,
  };
  const registry = ScaP03WorkspaceRegistryV1.create(path.join(privateDir, "registry.json"));
  const selection = path.join(privateDir, "current.json");
  writeFileSync(selection, "{}", { mode: 0o600 });
  const commands: string[][] = [];
  let residue = false;
  let imageDrift = false;
  let cancelAfterCreate: AbortController | undefined;
  const name = `penny-p03-${randomUUID()}`;
  let probeName = name;
  const id = sha256("container");
  const command = async (argv: readonly string[], _dockerConfig: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    commands.push([...argv]);
    if (argv[0] === "version")
      return JSON.stringify({ Client: { Version: "1.2.3" }, Server: { Version: "1.2.3" } });
    if (argv[0] === "image")
      return JSON.stringify({
        Id: imageDrift ? `sha256:${sha256("drift")}` : image_id,
        RepoDigests: [config.image_ref],
      });
    if (argv[1] === "create") {
      probeName = argv[argv.indexOf("--name") + 1] ?? "";
      cancelAfterCreate?.abort(new Error("cancelled after probe create"));
      cancelAfterCreate = undefined;
      return id;
    }
    if (argv[1] === "inspect")
      return JSON.stringify({
        Id: id,
        Name: `/${probeName}`,
        Image: imageDrift ? `sha256:${sha256("drift")}` : image_id,
        HostConfig: {
          NetworkMode: "none",
          PidMode: "",
          IpcMode: "",
          UTSMode: "",
          ReadonlyRootfs: true,
          Privileged: false,
          Init: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 32,
          Memory: config.memory_bytes,
          MemorySwap: config.memory_bytes,
          NanoCpus: 1_000_000_000,
          LogConfig: { Type: "none" },
          Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=67108864" },
        },
        Mounts: [],
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          WorkingDir: "/tmp",
          Env: ["HOME=/tmp"],
          Entrypoint: ["sleep"],
          Cmd: ["infinity"],
        },
      });
    if (argv[1] === "exec") {
      if (argv[3] === "find") return "io.joern.joern-cli-4.0.627.jar\n";
      if (argv[3] === "which") return "/opt/joern/joern-cli/joern\n";
      if (argv[3] === "joern") return "Usage: joern [options] [<cpg.bin>]\n";
      throw new Error("unexpected probe command");
    }
    if (argv[1] === "ls")
      return residue
        ? `${JSON.stringify({ Names: argv.join(" ").includes(name) ? name : probeName, ID: id })}\n`
        : "";
    return "";
  };
  const probe = createScaP03LocalHostProbeDeterministicTestOnlyV1(
    {
      config,
      store,
      build_files: { [pkg.artifact_id]: pkgFile },
      runtime_package_refs: [pkg],
      current_selection_path: selection,
      registry,
    },
    command
  );
  const identity = {
    runtime_id: config.runtime_id,
    isolation_id: config.isolation_id,
    implementation_sha256: config.implementation_identity_sha256,
    runtime_package_sha256: packages,
    deployment_sha256,
    docker_executable_sha256,
    docker_client_version: "1.2.3",
    docker_server_version: "1.2.3",
    image_id,
    joern_version: "4.0.627",
  };
  return {
    root,
    privateDir,
    store,
    persist,
    registry,
    config,
    pkg,
    pkgFile,
    docker,
    probe,
    identity,
    commands,
    setResidue: (value: boolean) => {
      residue = value;
    },
    setImageDrift: (value: boolean) => {
      imageDrift = value;
    },
    cancelAfterNextCreate: (controller: AbortController) => {
      cancelAfterCreate = controller;
    },
    name,
    id,
    selection,
  };
}
it("measures a pinned local Docker executable and image through bounded no-shell commands; rejects drift and residue", async () => {
  const fx = fixture();
  expect(await fx.probe.measureIdentity()).toEqual(fx.identity);
  expect(
    fx.commands.some(
      (argv) =>
        argv.includes("--network") &&
        argv.includes("none") &&
        argv.includes("--read-only") &&
        argv.includes("--cap-drop")
    )
  ).toBe(true);
  expect(fx.commands.some((argv) => argv.includes("--version"))).toBe(false);
  expect(
    fx.commands.some(
      (argv) =>
        argv[1] === "exec" &&
        argv[3] === "find" &&
        argv.some((argument) => argument.includes("joern-cli"))
    )
  ).toBe(true);
  fx.setResidue(true);
  await expect(fx.probe.measureIdentity()).rejects.toThrow("p03_host_probe_residue");
  fx.setResidue(false);
  fx.setImageDrift(true);
  await expect(fx.probe.measureIdentity()).rejects.toThrow("p03_host_deployment_drift");
  fx.setImageDrift(false);
  writeFileSync(fx.pkgFile, "different");
  await expect(fx.probe.measureIdentity()).rejects.toThrow("p03_host_package_drift");
  writeFileSync(
    fx.pkgFile,
    canonicalJson({ package: "docker-image-pin", digest: sha256("image") })
  );
  writeFileSync(fx.docker, "different");
  await expect(fx.probe.measureIdentity()).rejects.toThrow("p03_host_docker_drift");
  fx.store.close();
});
it("threads cancellation through the Docker probe and performs independent cleanup", async () => {
  const fx = fixture();
  const controller = new AbortController();
  fx.cancelAfterNextCreate(controller);

  await expect(fx.probe.measureIdentity(controller.signal)).rejects.toThrow(
    "cancelled after probe create"
  );
  expect(
    fx.commands.some(
      (argv) => argv[0] === "container" && argv[1] === "rm" && argv.includes("--force")
    )
  ).toBe(true);
  expect(
    fx.commands.some(
      (argv) => argv[0] === "container" && argv[1] === "ls" && argv.includes("--all")
    )
  ).toBe(true);
  fx.store.close();
});

it("keeps raw workspace paths in a private registry across an exact resume and refuses unsafe files", async () => {
  const fx = fixture();
  const work = path.join(fx.privateDir, "workspace");
  mkdirSync(work, { mode: 0o700 });
  const stat = lstatSync(work);
  const sink = new ScaP03HostWitnessSinkV1(
    { run_id: "p03-test", candidate_sha256: sha256("candidate"), identity: fx.identity },
    fx.registry
  );
  sink.startWorkspace(canonicalJson({ path: work, dev: stat.dev, ino: stat.ino }));
  rmSync(work, { recursive: true });
  sink.finishWorkspace(true);
  expect(ScaP03WorkspaceRegistryV1.resume(fx.registry.file ?? "").digest(sink.attempt_id)).toBe(
    sink.workspaceDigest()
  );
  expect(fx.registry.paths(sink.attempt_id)).toEqual([work]);
  const secret = path.join(fx.privateDir, "linked");
  symlinkSync(fx.pkgFile, secret);
  expect(() => readStableScaP03FileV1(secret, 1024)).toThrow();
  rmSync(fx.selection);
  symlinkSync(fx.pkgFile, fx.selection);
  await expect(fx.probe.currentSelection()).rejects.toThrow();
  chmodSync(fx.registry.file ?? "", 0o644);
  expect(() => ScaP03WorkspaceRegistryV1.resume(fx.registry.file ?? "")).toThrow(
    "p03_registry_custody_invalid"
  );
  fx.store.close();
});
it("issues independent PASS only after host census and emits FAIL diagnostics for residue", async () => {
  const fx = fixture();
  const work = path.join(fx.privateDir, "workspace");
  mkdirSync(work, { mode: 0o700 });
  const stat = lstatSync(work);
  const sink = new ScaP03HostWitnessSinkV1(
    { run_id: "p03-test", candidate_sha256: sha256("candidate"), identity: fx.identity },
    fx.registry
  );
  sink.startWorkspace(canonicalJson({ path: work, dev: stat.dev, ino: stat.ino }));
  const name = fx.name;
  const projection = canonicalJson({
    image: fx.identity.image_id,
    id: fx.id,
    name: `/${name}`,
    network: "none",
    pid_mode: "",
    ipc_mode: "",
    uts_mode: "",
    readonly_root: true,
    privileged: false,
    init: true,
    running: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges"],
    pids: 32,
    memory: fx.config.memory_bytes,
    memory_swap: fx.config.memory_bytes,
    nano_cpus: 1_000_000_000,
    log: "none",
    tmpfs: {
      "/tmp": "rw,exec,nosuid,nodev,size=67108864",
      "/work": `rw,exec,nosuid,nodev,size=${fx.config.max_workspace_bytes},mode=0700,uid=${process.getuid?.()},gid=${process.getgid?.()}`,
    },
    user: `${process.getuid?.()}:${process.getgid?.()}`,
    workdir: "/tmp",
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin:/opt/joern/joern-cli/bin",
      "JOERN_HOME=/opt/joern/joern-cli",
      "JAVA_HOME=/etc/alternatives/jre_17",
      "JOERN_DATAFLOW_TRACKED_WIDTH=128",
    ],
    entrypoint: ["sleep"],
    command: ["infinity"],
    mounts: [
      { destination: "/scripts", type: "bind", readonly: true, source_sha256: sha256("script") },
    ],
  });
  sink.create(name, ["container", "create"]);
  sink.id(name, fx.id);
  sink.inspect(name, "{}", projection);
  sink.startContainer(name);
  sink.command(name, ["container", "exec"], false);
  sink.response(name, "ok");
  sink.removal(name, true);
  rmSync(work, { recursive: true });
  sink.finishWorkspace(true);
  const policy = fx.persist(
    {
      schema_id: "penny.sca-p03-runtime-policy.v1",
      schema_version: 1,
      policy_id: "policy",
      staging_parent_sha256: sha256(fx.config.staging_parent),
      source_posture: "read_only",
      network_access: "denied",
      package_acquisition: "forbidden",
      target_execution: "forbidden",
      shell_execution: "forbidden",
      joern_server: "forbidden",
      process_timeout_ms: fx.config.timeout_ms,
      max_graph_bytes: 1000,
      max_query_output_bytes: 1000,
      max_query_items: 1,
      max_page_items: 1,
      max_pages_per_query: 1,
      max_ast_depth: 1,
      max_ast_nodes: 1,
      max_num_def: fx.config.max_num_def,
    },
    "sca-p03-runtime-policy",
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy.producer,
    [],
    "penny.sca-p03-runtime-policy.v1"
  );
  const implementation = fx.persist(
    { fixture: "implementation" },
    "sca-p03-implementation-identity"
  );
  const runtime = fx.persist({ fixture: "runtime" }, "sca-p03-joern-runtime-identity");
  const attempt = fx.persist(
    JSON.parse(Buffer.from(sink.finalize("completed")).toString("utf8")),
    "sca-p03-attempt-witness",
    P03_BOOTSTRAP_ROLES.evaluator,
    [policy, implementation, runtime, fx.pkg],
    "penny.sca-p03-attempt-witness.v1"
  );
  const input = {
    store: fx.store,
    probe: fx.probe,
    config: fx.config,
    attempt_ref: attempt,
    policy_ref: policy,
    implementation_identity_ref: implementation,
    runtime_identity_ref: runtime,
    implementation_source_refs: [fx.pkg],
  };
  for (const staging_parent of [
    path.join(fx.config.staging_parent, "other"),
    `${fx.config.staging_parent}/.`,
  ]) {
    await expect(
      issueScaP03PostRunEvidenceV3({
        ...input,
        config: { ...fx.config, staging_parent },
        probe: {
          ...fx.probe,
          containerCensus: async () => {
            throw new Error("census must not run");
          },
        },
      })
    ).rejects.toThrow("p03_issuer_input_invalid");
  }
  const good = await issueScaP03PostRunEvidenceV3(input);
  expect(validateScaP03CleanupEvidenceV2(good.cleanup_bytes).decision).toBe("PASS");
  expect(validateScaP03IsolationEvidenceV2(good.isolation_bytes).decision).toBe("PASS");
  fx.setResidue(true);
  const bad = await issueScaP03PostRunEvidenceV3(input);
  expect(validateScaP03CleanupEvidenceV2(bad.cleanup_bytes).decision).toBe("FAIL");
  expect(validateScaP03IsolationEvidenceV2(bad.isolation_bytes).decision).toBe("FAIL");
  fx.setResidue(false);
  mkdirSync(work);
  writeFileSync(path.join(work, "residue"), "leftover");
  const workspaceFailure = await issueScaP03PostRunEvidenceV3(input);
  expect(validateScaP03CleanupEvidenceV2(workspaceFailure.cleanup_bytes).decision).toBe("FAIL");
  expect(validateScaP03IsolationEvidenceV2(workspaceFailure.isolation_bytes).decision).toBe("FAIL");
  const diagnostic = persistScaP03HostEvidenceV3({
    store: fx.store,
    run_id: "p03-test",
    operation_id: "diagnostic-cleanup",
    kind: "sca-p03-cleanup-evidence",
    bytes: bad.cleanup_bytes,
    upstream_refs: [attempt, policy],
  });
  expect(validateScaP03CleanupEvidenceV2(fx.store.read(diagnostic)).decision).toBe("FAIL");
  expect(() =>
    persistScaP03HostEvidenceV3({
      store: fx.store,
      run_id: "p03-test",
      operation_id: "diagnostic-cleanup",
      kind: "sca-p03-cleanup-evidence",
      bytes: bad.cleanup_bytes,
      upstream_refs: [attempt, policy],
    })
  ).toThrow("p03_writer_existing_slot");
  fx.store.close();
});
