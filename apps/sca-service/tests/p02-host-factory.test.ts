import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { scaP01SourceTreeDigest } from "../../orchestration/dist/sca/p01-contracts.js";
import {
  createP02HostProcessRunnerFactoryV1,
  deriveP02HostRuleDigestsV1,
  deriveP02HostSourceManifestV1,
  isControlledP02FactoryRunnerV1,
  matchesP02HostFactoryRunnerV1,
} from "../src/p02-host-process-runner.js";
import {
  p02HostProfileDigest,
  p02InventoryPackageFiles,
  P02_HOST_REQUEST_SCHEMA,
  type P02HostRequest,
} from "../src/p02-host-harness.js";
import {
  createP02ControlledInventoryRunnerV1,
  readP02InventoryContainmentEvidenceV1,
} from "../src/p02-host-inventory-runner.js";
import { inspectInstalledTreeSitterIdentitiesV2 } from "../src/adapters/tree-sitter-index.js";
import { materializeScaSourceCustodyV1 } from "../src/source-custody-materializer.js";
import { runScaSemgrepV1 } from "../src/adapters/semgrep.js";

const dispatched = vi.hoisted(() => ({ plans: [] as unknown[] }));
vi.mock("../src/p02-host-harness.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/p02-host-harness.js")>();
  return {
    ...original,
    runP02HostCanary: async (plan: P02HostRequest) => {
      dispatched.plans.push(plan);
      const nonce = "b".repeat(64);
      const planHash = sha256(canonicalJson(plan));
      const stdout = canonicalJson({ results: [], errors: [] });
      return {
        status: "passed",
        unit: null,
        issue: null,
        receipt: {
          plan_sha256: planHash,
          nonce,
          process: {
            schema_id: "penny.sca-process-result.v1",
            schema_version: 1,
            request_sha256: sha256(
              canonicalJson({ plan_sha256: planHash, nonce, kind: plan.kind })
            ),
            status: "succeeded",
            exit_code: 0,
            signal: null,
            stdout,
            stderr: "",
            stdout_sha256: sha256(stdout),
            stderr_sha256: sha256(""),
            stdout_bytes: Buffer.byteLength(stdout),
            stderr_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            failure_code: "none",
          },
        },
      };
    },
  };
});

const created: string[] = [];
afterEach(async () => {
  dispatched.plans.length = 0;
  for (const root of created.splice(0)) {
    const stage = path.join(root, "staging");
    for (const entry of await (await import("node:fs/promises")).readdir(stage)) {
      if (entry.includes("-source-")) await chmod(path.join(stage, entry), 0o700);
    }
    await rm(root, { recursive: true, force: true });
  }
});

function ref(digest: string) {
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: "fixture",
    phase: "fixture",
    branch_id: null,
    kind: "source-manifest",
    operation_id: "fixture",
    version: 1,
    producer: "fixture",
    media_type: "application/json",
    byte_length: 0,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  } as const;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "p02-factory-"));
  created.push(root);
  const staging_parent = path.join(root, "staging");
  const workspace_parent = path.join(root, "workspace");
  await mkdir(staging_parent, { mode: 0o700 });
  await mkdir(workspace_parent, { mode: 0o700 });
  const content = "const value = 1;\n";
  const identity = {
    path: "a.js",
    byte_count: Buffer.byteLength(content),
    content_sha256: sha256(content),
  };
  const manifest = {
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    schema_version: 1,
    snapshot_id: "fixture-snapshot",
    scope: { include_paths: ["a.js"], exclude_paths: [] },
    files: [identity],
    file_count: 1,
    byte_count: identity.byte_count,
    tree_sha256: scaP01SourceTreeDigest([identity]),
  };
  const file_manifest_sha256 = sha256(canonicalJson(manifest));
  const custody = {
    schema_id: "penny.sca-p01-source-custody-corpus.v1",
    schema_version: 1,
    custody_id: "fixture-custody",
    snapshot_id: manifest.snapshot_id,
    file_manifest_ref: ref(file_manifest_sha256),
    files: [
      { ...identity, encoding: "base64", content_base64: Buffer.from(content).toString("base64") },
    ],
    file_count: 1,
    byte_count: identity.byte_count,
    tree_sha256: manifest.tree_sha256,
    sealed: true,
  };
  const material = {
    schema_id: "penny.sca-source-custody-materialization-input.v1",
    schema_version: 1,
    file_manifest_sha256,
    custody_sha256: sha256(canonicalJson(custody)),
    file_manifest: manifest,
    custody,
  };
  const source_manifest = deriveP02HostSourceManifestV1(material);
  const id = "sca-p02-semgrep-js-ts";
  const source = path.join(staging_parent, `${id}-source-${"a".repeat(16)}`);
  const aux = path.join(staging_parent, `${id}-aux-${"a".repeat(16)}`);
  const materialized = await materializeScaSourceCustodyV1(material, { staging_root: source });
  await mkdir(path.join(aux, "config"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(aux, "scratch"), { mode: 0o700 });
  const rules = ["rules: []\n", "rules: [a]\n", "rules: [unlisted]\n"];
  const hashes = rules.map(sha256);
  for (const [index, rule] of rules.entries())
    await writeFile(path.join(aux, "config", `rule-${String(index).padStart(6, "0")}.yaml`), rule, {
      mode: 0o400,
    });
  const hex = "a".repeat(64);
  const tool_runtime = {
    kind: "sealed" as const,
    tree: {
      root: "/sealed/closure",
      files: [{ path: "bin/semgrep", bytes: 1, sha256: hex }],
      total_bytes: 1,
      tree_sha256: sha256(canonicalJson([{ path: "bin/semgrep", bytes: 1, sha256: hex }])),
    },
    mount_root: "/home/runner/.pyenv/versions/semgrep-1.168.0",
    executable: "bin/semgrep",
    executable_sha256: hex,
    tool_version: "1.168.0" as const,
    same_uid_residual_ack: true as const,
  };
  const { source_generation, ...sourceFiles } = source_manifest;
  const base: P02HostRequest = {
    kind: "semgrep_js_ts",
    source: { ...sourceFiles, root: source },
    source_generation,
    tool_runtime,
    rule: { path: path.join(aux, "config", "rule-000000.yaml"), sha256: hashes[0] },
    runtime: { path: "/usr/bin/node", sha256: hex },
    closure: [{ path: "/usr/lib/libc.so", sha256: hex }],
    deployment: { path: path.join(root, "deployment"), sha256: hex },
    controls: {
      bwrap: hex,
      systemd_run: hex,
      systemctl: hex,
      scratch_launcher: hex,
      mount: hex,
      setpriv: hex,
    },
    profile_sha256: hex,
    workspace_parent,
    protected_roots: [path.join(root, "protected"), "/home/runner"],
    limits: {
      scratch_bytes: 1048576,
      memory_bytes: 134217728,
      tasks: 8,
      cpu_percent: 50,
      runtime_ms: 10000,
      output_bytes: 65536,
    },
  };
  base.controls.scratch_launcher = sha256(
    await readFile(new URL("../src/p02-scratch-launcher.mjs", import.meta.url))
  );
  const worker = fileURLToPath(new URL("../src/p02-host-worker.mjs", import.meta.url));
  const launcher = fileURLToPath(new URL("../src/p02-host-harness.ts", import.meta.url));
  base.profile_sha256 = p02HostProfileDigest(
    base,
    sha256(await readFile(worker)),
    sha256(await readFile(launcher))
  );
  const runner = createP02HostProcessRunnerFactoryV1({
    kind: "semgrep_js_ts",
    tool_runtime: base.tool_runtime,
    runtime: base.runtime,
    closure: base.closure,
    deployment: base.deployment,
    controls: base.controls,
    profile_sha256: base.profile_sha256,
    workspace_parent: base.workspace_parent,
    protected_roots: base.protected_roots,
    limits: base.limits,
    source_material: material,
    staging_parent,
    allowed_rule_sha256: hashes.slice(0, 2),
  });
  const request = (index: number) => ({
    schema_id: "penny.sca-process-request.v1" as const,
    schema_version: 1 as const,
    executable: path.join(tool_runtime.mount_root, tool_runtime.executable),
    executable_sha256: hex,
    arguments: [
      "scan",
      "--json",
      "--error",
      "--metrics=off",
      "--disable-version-check",
      "--no-git-ignore",
      "--x-ignore-semgrepignore-files",
      "--no-rewrite-rule-ids",
      "--config",
      path.join(aux, "config", `rule-${String(index).padStart(6, "0")}.yaml`),
      "--",
      ".",
    ],
    cwd: source,
    environment: [
      { name: "HOME", value: path.join(aux, "scratch") },
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
      { name: "SEMGREP_SEND_METRICS", value: "off" },
    ],
    timeout_ms: 9500,
    max_stdout_bytes: 4096,
    max_stderr_bytes: 4096,
  });
  return {
    root,
    runner,
    request,
    hashes,
    source,
    aux,
    materialized,
    staging_parent,
    base,
    material,
  };
}

describe("P02 operation-scoped factory (no host launch)", () => {
  it("issues inventory only for a sealed exact package list and frozen indexer source", async () => {
    const f = await fixture();
    const identity = inspectInstalledTreeSitterIdentitiesV2();
    const packageFiles = p02InventoryPackageFiles().map((file) => ({
      path: file,
      bytes: 1,
      sha256: "a".repeat(64),
    }));
    const tool_runtime = {
      kind: "inventory" as const,
      mount_root: "/opt/p02-inventory/node_modules" as const,
      same_uid_residual_ack: true as const,
      bundle: { path: path.join(f.root, "inventory-bundle"), sha256: "a".repeat(64) },
      indexer_source: {
        path: fileURLToPath(new URL("../src/adapters/tree-sitter-index.ts", import.meta.url)),
        sha256: identity.implementation_sha256,
      },
      packages: {
        root: "/sealed/inventory-packages",
        files: packageFiles,
        total_bytes: packageFiles.length,
        tree_sha256: sha256(canonicalJson(packageFiles)),
      },
    };
    const config = {
      staging_parent: f.staging_parent,
      source_material: f.material,
      tree_sitter_identity: identity,
      tool_runtime,
      runtime: f.base.runtime,
      closure: f.base.closure,
      deployment: f.base.deployment,
      controls: f.base.controls,
      profile_sha256: f.base.profile_sha256,
      workspace_parent: f.base.workspace_parent,
      protected_roots: f.base.protected_roots,
      limits: f.base.limits,
    };
    const inventoryRunner = createP02ControlledInventoryRunnerV1(config);
    expect(inventoryRunner.qualification).toBe("controlled_p02_inventory_only");
    expect(readP02InventoryContainmentEvidenceV1(inventoryRunner)).toEqual([]);
    expect(Object.isFrozen(readP02InventoryContainmentEvidenceV1(inventoryRunner))).toBe(true);
    expect(() => readP02InventoryContainmentEvidenceV1({})).toThrow(
      "p02_inventory_runner_not_issued"
    );
    expect(() =>
      createP02ControlledInventoryRunnerV1({
        ...config,
        tool_runtime: {
          ...tool_runtime,
          indexer_source: { ...tool_runtime.indexer_source, sha256: "b".repeat(64) },
        },
      })
    ).toThrow("p02_inventory_indexer_identity");
    expect(() =>
      createP02ControlledInventoryRunnerV1({
        ...config,
        tool_runtime: {
          ...tool_runtime,
          packages: {
            ...tool_runtime.packages,
            files: [
              ...packageFiles,
              { path: "tree-sitter/unlisted.js", bytes: 1, sha256: "a".repeat(64) },
            ],
          },
        },
      })
    ).toThrow();
    await f.materialized.cleanup();
  });
  it("uses both admitted JS/TS rules in distinct source/rule-bound plans; refuses unlisted, path and source drift before dispatch", async () => {
    const f = await fixture();
    expect(isControlledP02FactoryRunnerV1(f.runner)).toBe(true);
    await f.runner.run(f.request(0));
    await f.runner.run(f.request(1));
    expect(dispatched.plans).toHaveLength(2);
    const plans = dispatched.plans.map((plan) =>
      validateContract(P02_HOST_REQUEST_SCHEMA, plan, "dispatched P02 plan")
    );
    const first = plans[0];
    const second = plans[1];
    if (first === undefined || second === undefined) throw Error("missing dispatched P02 plans");
    expect(plans.map((p) => p.rule.sha256)).toEqual(f.hashes.slice(0, 2));
    expect(first.source.root).toBe(f.source);
    expect(first.profile_sha256).toBe(second.profile_sha256);
    expect(sha256(canonicalJson(first))).not.toBe(sha256(canonicalJson(second)));
    await expect(f.runner.run(f.request(2))).rejects.toThrow("p02_process_rule_unlisted");
    await expect(
      f.runner.run({ ...f.request(0), cwd: path.join(f.root, "other") })
    ).rejects.toThrow("p02_process_plan_mismatch");
    await expect(
      f.runner.run({ ...f.request(0), arguments: ["--config", "/etc/passwd"] })
    ).rejects.toThrow("p02_process_plan_mismatch");
    expect(dispatched.plans).toHaveLength(2);
    await chmod(f.source, 0o755);
    await writeFile(path.join(f.source, "extra.js"), "unexpected");
    await chmod(f.source, 0o555);
    await expect(f.runner.run(f.request(0))).rejects.toThrow();
    expect(dispatched.plans).toHaveLength(2);
    await f.materialized.cleanup();
  });
  it("rejects a changed custody generation marker and symlinked rule before dispatch", async () => {
    const f = await fixture();
    const marker = path.join(f.source, ".penny-sca-generation.json");
    await chmod(marker, 0o644);
    await expect(f.runner.run(f.request(0))).rejects.toThrow("p02_host_tree_marker");
    await chmod(marker, 0o444);
    const rule = f.request(0).arguments[9];
    if (rule === undefined) throw Error("missing rule");
    await rm(rule);
    await (await import("node:fs/promises")).symlink(f.request(1).arguments[9] ?? "", rule);
    await expect(f.runner.run(f.request(0))).rejects.toThrow();
    expect(dispatched.plans).toHaveLength(0);
    await f.materialized.cleanup();
  });
  it("routes multiple selected component adapter invocations through the issued runner", async () => {
    const f = await fixture();
    const component = (index: number) => ({
      schema_id: "penny.sca-semgrep-request.v1",
      schema_version: 1,
      source_snapshot_sha256: "a".repeat(64),
      source_root: f.source,
      scratch_root: path.join(f.aux, "scratch"),
      rule_config: f.request(index).arguments[9],
      rule_config_sha256: f.hashes[index],
      runtime: {
        state: "available",
        executable: f.request(index).executable,
        executable_sha256: f.request(index).executable_sha256,
        fixed_arguments: [],
        tool_version: "1.168.0",
        runtime_identity: "semgrep",
        runtime_sha256: "b".repeat(64),
      },
      timeout_ms: 9500,
      max_output_bytes: 4096,
    });
    const requestBinding = {
      operation_kind: "semgrep_js_ts" as const,
      staging_parent: f.staging_parent,
      executable: {
        executable_path: f.request(0).executable,
        executable_sha256: f.request(0).executable_sha256,
      },
      timeout_ms: 9500,
      max_output_bytes: 4096,
      selected_rule_bindings: f.hashes.slice(0, 2).map((content_sha256) => ({ content_sha256 })),
    };
    expect(matchesP02HostFactoryRunnerV1(f.runner, requestBinding)).toBe(true);
    expect(
      matchesP02HostFactoryRunnerV1(f.runner, {
        ...requestBinding,
        selected_rule_bindings: f.hashes.map((content_sha256) => ({ content_sha256 })),
      })
    ).toBe(false);
    expect(
      matchesP02HostFactoryRunnerV1(f.runner, {
        ...requestBinding,
        staging_parent: path.join(f.root, "other"),
      })
    ).toBe(false);
    expect(matchesP02HostFactoryRunnerV1({ ...f.runner }, requestBinding)).toBe(false);
    const first = await runScaSemgrepV1(component(0), undefined, f.runner);
    const second = await runScaSemgrepV1(component(1), undefined, f.runner);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(first.invocation_sha256).not.toBe(second.invocation_sha256);
    expect(dispatched.plans).toHaveLength(2);
    await expect(runScaSemgrepV1(component(2), undefined, f.runner)).rejects.toThrow(
      "p02_process_rule_unlisted"
    );
    expect(dispatched.plans).toHaveLength(2);
    await f.materialized.cleanup();
  });
  it("derives rule hashes from admitted bundle selection, not rule-directory enumeration", () => {
    const rules = ["javascript", "typescript", "php"].map((language, i) => ({
      rule_id: `rule-${i}`,
      language,
      encoding: "base64",
      content_base64: Buffer.from(String(i)).toString("base64"),
      content_sha256: sha256(String(i)),
    }));
    const bundle = {
      schema_id: "penny.sca-p01-rule-bundle.v1",
      schema_version: 1,
      bundle_id: "bundle",
      release_id: "release",
      immutable: true,
      rules,
    };
    const selected = {
      schema_id: "penny.sca-p01-selected-rule-manifest.v1",
      schema_version: 1,
      selection_id: "selection",
      rule_profile_id: "profile",
      analysis_profile_id: "analysis",
      rule_release_id: "release",
      rule_release_ref: ref(sha256("release")),
      selected_rule_ids: rules.map((r) => r.rule_id),
    };
    expect(deriveP02HostRuleDigestsV1(bundle, selected, "semgrep_js_ts")).toEqual(
      rules.slice(0, 2).map((r) => r.content_sha256)
    );
  });
});
