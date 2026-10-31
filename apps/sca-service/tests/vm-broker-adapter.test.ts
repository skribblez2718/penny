import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaP01SourceTreeDigest } from "../../orchestration/dist/sca/p01-contracts.js";
import type { ScaBrokerExecuteRequestV1 } from "../src/contracts.js";
import { SCA_ADAPTER_REGISTRY } from "../src/adapters.js";
import {
  buildVerifiedVmGraph,
  createVmBrokerAdapterRegistry,
  vmBrokerProcessRunner,
  type PinnedVmFile,
  type VmBrokerRunner,
} from "../src/vm-broker-adapter.js";

const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(sourceText = "<?php echo 1;\n") {
  const root = mkdtempSync(join(tmpdir(), "sca-vm-adapter-"));
  roots.push(root);
  const workspaceParent = join(root, "private");
  mkdirSync(workspaceParent, { mode: 0o700 });
  writeFileSync(join(workspaceParent, ".vm-global.lock"), "", { mode: 0o600 });
  const store = ArtifactStore.provision(join(root, "artifacts"), {
    projectId: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  stores.push(store);
  const scripts = join(root, "bridge");
  mkdirSync(scripts, { mode: 0o700 });
  for (const name of ["run_job.py", "run_guest.py", "output_protocol.py"]) {
    const target = join(scripts, name);
    copyFileSync(
      fileURLToPath(new URL(`../../../scripts/sca-vm/${name}`, import.meta.url)),
      target
    );
    chmodSync(target, 0o500);
  }
  const bridge = join(scripts, "run_job.py");
  const launcher = join(scripts, "run_guest.py");
  const file = (path: string): PinnedVmFile => ({
    path,
    sha256: sha256(readFileSync(path)),
    size_bytes: readFileSync(path).length,
  });
  const binary = join(root, "tool");
  writeFileSync(binary, "tool", { mode: 0o700 });
  const template = join(root, "template.raw");
  writeFileSync(template, Buffer.alloc(65_536, 1), { mode: 0o400 });
  chmodSync(template, 0o400);
  const optionsBase = {
    artifactStore: store,
    projectId: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workspaceParent,
    globalLock: join(workspaceParent, ".vm-global.lock"),
    runJob: file(bridge),
    runGuest: file(launcher),
    outputProtocol: file(join(scripts, "output_protocol.py")),
    python: file(binary),
    genisoimage: file(binary),
    cp: file(binary),
    qemu: file(binary),
    bwrap: file(binary),
    systemctl: file(binary),
    template: file(template),
  };
  const persist = (
    kind: string,
    operation_id: string,
    content: Record<string, unknown>,
    upstream_refs: ReturnType<typeof store.persist>[] = [],
    parent_ref: ReturnType<typeof store.persist> | null = null
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-1",
        phase:
          kind === "source-snapshot" || kind.startsWith("sca-p01-source-")
            ? "SCA-P01-source"
            : "SCA-P01",
        branch_id: null,
        kind,
        operation_id,
        version: 1,
        producer:
          kind === "source-snapshot" || kind.startsWith("sca-p01-source-")
            ? "host:source-custody"
            : "fixture",
        media_type: "application/json",
        ...(typeof content.schema_id === "string" && typeof content.schema_version === "number"
          ? {
              content_schema: {
                schema_id: content.schema_id,
                schema_version: content.schema_version,
              },
            }
          : {}),
        parent_ref,
        upstream_refs,
      },
      content: canonicalJson(content),
    });
  const source = Buffer.from(sourceText);
  const fileIdentity = {
    path: "src/main.php",
    byte_count: source.length,
    content_sha256: sha256(source),
  };
  const tree = scaP01SourceTreeDigest([fileIdentity]);
  const manifest = persist("sca-p01-source-file-manifest", "manifest", {
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    schema_version: 1,
    snapshot_id: "snapshot-1",
    scope: { include_paths: ["src"], exclude_paths: [] },
    files: [fileIdentity],
    file_count: 1,
    byte_count: source.length,
    tree_sha256: tree,
  });
  const custody = persist(
    "sca-p01-source-custody-corpus",
    "custody",
    {
      schema_id: "penny.sca-p01-source-custody-corpus.v1",
      schema_version: 1,
      custody_id: "custody-1",
      snapshot_id: "snapshot-1",
      file_manifest_ref: manifest,
      files: [{ ...fileIdentity, encoding: "base64", content_base64: source.toString("base64") }],
      file_count: 1,
      byte_count: source.length,
      tree_sha256: tree,
      sealed: true,
    },
    [manifest]
  );
  const snapshot = persist(
    "source-snapshot",
    "snapshot",
    {
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
      snapshot_id: "snapshot-1",
      tree_sha256: tree,
      file_manifest_ref: manifest,
      file_manifest_sha256: manifest.content_digest,
      custody_ref: custody,
      custody_sha256: custody.content_digest,
      scope: { include_paths: ["src"], exclude_paths: [] },
      file_count: 1,
      byte_count: source.length,
      status: "frozen",
    },
    [manifest, custody].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
  );
  const config = persist("sca-vm-broker-config", "config", {
    schema_id: "penny.sca-vm-broker-config.v1",
    schema_version: 1,
    project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    enabled_operations: ["source_query", "graph_query", "application_test"],
    allowed_source_roots: ["src"],
  });
  const submitted = new Date().toISOString();
  const request: ScaBrokerExecuteRequestV1 = {
    schema_id: "penny.sca-broker-execute-request.v1",
    schema_version: 1,
    tenant_id: "tenant-1",
    project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    run_id: "run-1",
    job_id: "job-1",
    attempt: 1,
    idempotency_key: "key-1",
    tool_name: "sca_source_query",
    operation: "source_query",
    submitted_at: submitted,
    deadline_at: new Date(Date.parse(submitted) + 60_000).toISOString(),
    limits: { timeout_ms: 30_000, max_output_bytes: 1_000_000, max_result_items: 10 },
    source_snapshot_ref: snapshot,
    config_ref: config,
    input_refs: [],
    operation_input: {
      kind: "source_query",
      query_id: "query-1",
      selectors: [
        {
          path: "src/main.php",
          line_range: { start_line: 1, end_line_exclusive: 2 },
          symbol: null,
        },
      ],
      parameters: [{ name: "case_sensitive", value: { kind: "boolean", value: true } }],
    },
  };
  const options = {
    ...optionsBase,
    authorization: {
      configProducers: ["fixture"],
      configDigests: [config.content_digest],
      executionPlanProducers: ["fixture"],
      graphBindingProducers: ["host:sca-vm-graph-builder"],
      graphProducers: ["host:sca-vm-graph-builder"],
      policyProducers: ["fixture"],
      policyDigests: [sha256("authorized-policy-placeholder")],
    },
  };
  return {
    options,
    request,
    persist,
    sourceIdentity: fileIdentity,
    sourceTree: tree,
    workspaceParent,
  };
}
function graphBuildRunner(
  graphBytes = Buffer.from(canonicalJson({ fixture: "graph-bytes" })),
  mutateReceipt?: (receipt: Record<string, unknown>) => void,
  inspectJob?: (job: Record<string, unknown>, jobDir: string) => void
): VmBrokerRunner {
  return {
    async run(_executable, args) {
      const jobDir = args[args.indexOf("--job-dir") + 1];
      const outputParent = args[args.indexOf("--output-parent") + 1];
      if (jobDir === undefined || outputParent === undefined) throw new Error("build argv absent");
      const jobBytes = readFileSync(join(jobDir, "job.json"));
      const parsed: unknown = JSON.parse(jobBytes.toString("utf8"));
      if (!isRecord(parsed)) throw new Error("build job malformed");
      inspectJob?.(parsed, jobDir);
      const runDirectory = join(outputParent, "sca-vm-job-test");
      const results = join(runDirectory, "results");
      mkdirSync(results, { recursive: true, mode: 0o700 });
      chmodSync(runDirectory, 0o700);
      chmodSync(results, 0o700);
      const metadata = Buffer.from(
        canonicalJson({
          schema_id: "penny.sca-graph-build-metadata.v1",
          schema_version: 1,
          byte_length: graphBytes.length,
          content_sha256: sha256(graphBytes),
          file_count: 1,
          language: "php",
        })
      );
      const graphPath = join(results, "graph.cpg.bin");
      const metadataPath = join(results, "metadata.json");
      writeFileSync(graphPath, graphBytes, { mode: 0o600 });
      writeFileSync(metadataPath, metadata, { mode: 0o600 });
      const receipt: Record<string, unknown> = {
        schema_id: "penny.sca-vm-host-result.v1",
        schema_version: 1,
        status: "succeeded",
        error_code: null,
        execution_duration_ms: 1,
        job_sha256: sha256(jobBytes),
        run_directory: runDirectory,
        logical_result_items: 1,
        outputs: [
          {
            name: "graph.cpg.bin",
            path: graphPath,
            schema_id: "penny.sca-joern-cpg.v1",
            media_type: "application/vnd.penny.joern-cpg",
            byte_length: graphBytes.length,
            content_sha256: sha256(graphBytes),
          },
          {
            name: "metadata.json",
            path: metadataPath,
            schema_id: "penny.sca-graph-build-metadata.v1",
            media_type: "application/json",
            byte_length: metadata.length,
            content_sha256: sha256(metadata),
          },
        ],
      };
      mutateReceipt?.(receipt);
      return { exitCode: 0, stdout: `${canonicalJson(receipt)}\n`, terminated: true };
    },
  };
}
async function boundGraph(f: ReturnType<typeof fixture>, operation: string) {
  return buildVerifiedVmGraph({
    options: { ...f.options, runner: graphBuildRunner() },
    sourceSnapshotRef: f.request.source_snapshot_ref,
    runId: "run-1",
    operationId: operation,
    language: "php",
    maxNumDef: 4_000,
    maxOutputBytes: 1_000_000,
    signal: new AbortController().signal,
  });
}
function context(signal = new AbortController().signal) {
  const work: number[] = [];
  const output: Array<[number, number]> = [];
  return {
    context: {
      signal,
      reportWorkMilestone: () => {
        work.push(1);
      },
      reportPersistedOutput: (bytes: number, items: number) => {
        output.push([bytes, items]);
      },
    },
    work,
    output,
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fakeRunner(
  inspect: (job: Record<string, unknown>, args: readonly string[]) => void,
  mutate?: (receipt: Record<string, unknown>) => void
): VmBrokerRunner {
  return {
    async run(_executable, args, _signal, alive) {
      const jobDir = args[args.indexOf("--job-dir") + 1];
      const parent = args[args.indexOf("--output-parent") + 1];
      if (jobDir === undefined || parent === undefined) throw new Error("runner arguments absent");
      const raw = readFileSync(join(jobDir, "job.json"));
      const job: unknown = JSON.parse(raw.toString("utf8"));
      if (!isRecord(job)) throw new Error("invalid staged job");
      inspect(job, args);
      alive();
      const run = join(parent, "sca-vm-job-test");
      mkdirSync(run, { mode: 0o700 });
      const results = join(run, "results");
      mkdirSync(results, { mode: 0o700 });
      const body =
        job.operation === "application_test"
          ? {
              complete: true,
              authority: "guest_claim",
              items: [{ path: "src/main.php", passed: true }],
              passed: true,
              schema_id: "penny.sca-application-test-result.v1",
              schema_version: 1,
              test_id: "php.syntax.v1",
            }
          : job.operation === "graph_query"
            ? {
                complete: true,
                authority: "guest_claim",
                items: [
                  {
                    file_name: "src/main.php",
                    full_name: "main",
                    label: "METHOD",
                    line_number: 1,
                    name: "main",
                    node_id: "1",
                  },
                ],
                query_id: "query-1",
                schema_id: "penny.sca-graph-query-result.v1",
                schema_version: 1,
              }
            : {
                complete: true,
                authority: "guest_claim",
                items: [
                  {
                    path: "src/main.php",
                    content_sha256: sha256("<?php echo 1;\n"),
                    start_line: 1,
                    end_line_exclusive: 2,
                    text: "<?php echo 1;\n",
                  },
                ],
                query_id: "query-1",
                schema_id: "penny.sca-source-query-result.v1",
                schema_version: 1,
              };
      const content = Buffer.from(canonicalJson(body));
      const path = join(results, "result.json");
      writeFileSync(path, content, { mode: 0o400 });
      chmodSync(path, 0o400);
      const receipt: Record<string, unknown> = {
        schema_id: "penny.sca-vm-host-result.v1",
        schema_version: 1,
        status: "succeeded",
        error_code: null,
        execution_duration_ms: 1,
        job_sha256: sha256(raw),
        logical_result_items: 1,
        run_directory: run,
        outputs: [
          {
            name: "result.json",
            path,
            schema_id: body.schema_id,
            media_type: "application/json",
            byte_length: content.length,
            content_sha256: sha256(content),
          },
        ],
      };
      mutate?.(receipt);
      return { exitCode: 0, terminated: true, stdout: canonicalJson(receipt) + "\n" };
    },
  };
}
function mutateResultRunner(mutate: (body: Record<string, unknown>) => void): VmBrokerRunner {
  const delegate = fakeRunner(() => undefined);
  return {
    async run(executable, args, signal, progress) {
      const completed = await delegate.run(executable, args, signal, progress);
      const receipt: unknown = JSON.parse(completed.stdout);
      if (!isRecord(receipt) || !Array.isArray(receipt.outputs) || !isRecord(receipt.outputs[0]))
        throw new Error("fixture receipt is invalid");
      const output = receipt.outputs[0];
      if (typeof output.path !== "string") throw new Error("fixture output path is absent");
      const body: unknown = JSON.parse(readFileSync(output.path, "utf8"));
      if (!isRecord(body)) throw new Error("fixture result body is invalid");
      mutate(body);
      const content = Buffer.from(canonicalJson(body));
      chmodSync(output.path, 0o600);
      writeFileSync(output.path, content, { mode: 0o400 });
      chmodSync(output.path, 0o400);
      output.byte_length = content.length;
      output.content_sha256 = sha256(content);
      return { ...completed, stdout: `${canonicalJson(receipt)}\n` };
    },
  };
}

describe("direct VM broker adapter (inactive)", () => {
  it("reports only authenticated bridge progress and terminates its whole process group", async () => {
    const controller = new AbortController();
    let milestones = 0;
    const running = vmBrokerProcessRunner.run(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process');
         const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
         process.stdout.write(String(child.pid)+'\\n');
         process.stderr.write('PENNY_SCA_VM_PROGRESS:validated\\nPENNY_SCA_VM_PROGRESS:media_ready\\nPENNY_SCA_VM_PROGRESS:disk_ready\\nPENNY_SCA_VM_PROGRESS:guest_started\\nPENNY_SCA_VM_PROGRESS:guest_active:1\\nPENNY_SCA_VM_PROGRESS:guest_active:2\\nPENNY_SCA_VM_PROGRESS:guest_active:2\\nnot-progress\\n');
         setInterval(()=>{},1000);`,
      ],
      controller.signal,
      () => {
        milestones += 1;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await running;
    const descendant = Number(result.stdout.trim());
    expect(result.terminated).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(milestones).toBe(6);
    expect(Number.isSafeInteger(descendant)).toBe(true);
    expect(() => process.kill(descendant, 0)).toThrow();
  });
  it("stops buffering every stream after the runner output ceiling", async () => {
    const result = await vmBrokerProcessRunner.run(
      process.execPath,
      [
        "-e",
        "for(let i=0;i<20;i++)process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);",
      ],
      new AbortController().signal,
      () => undefined
    );
    expect(result.exitCode).toBe(1);
    expect(result.terminated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65_536);
  });
  it("does not change the global null registry", () => {
    expect(Object.values(SCA_ADAPTER_REGISTRY)).toEqual([null, null, null]);
  });
  it("pins the host bridge at construction and refuses changed config", () => {
    const f = fixture();
    expect(() =>
      createVmBrokerAdapterRegistry({
        ...f.options,
        runJob: { ...f.options.runJob, sha256: "0".repeat(64) },
      })
    ).toThrow();
    expect(() =>
      createVmBrokerAdapterRegistry({
        ...f.options,
        workspaceParent: join(f.workspaceParent, "missing"),
      })
    ).toThrow();
  });
  it("keeps the deployment lock independent from workspace placement", () => {
    const f = fixture();
    const secondWorkspace = join(f.workspaceParent, "..", "private-second");
    mkdirSync(secondWorkspace, { mode: 0o700 });
    expect(() =>
      createVmBrokerAdapterRegistry({ ...f.options, workspaceParent: secondWorkspace })
    ).not.toThrow();
  });
  it("stages only selected source bytes, converts selectors, persists verified output, and proves cleanup", async () => {
    const f = fixture();
    const progress = context();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: fakeRunner((job, args) => {
        expect(job.operation).toBe("source_query");
        expect(args.slice(-2)).toEqual(["--timeout", "1200"]);
        expect(args[args.indexOf("--lock-file") + 1]).toBe(f.options.globalLock);
        expect(job.payload).toMatchObject({
          query: {
            selectors: [
              { path: "src/main.php", start_line: 1, end_line_exclusive: 2, symbol: null },
            ],
            parameters: [{ name: "case_sensitive", value: { kind: "boolean", value: true } }],
          },
          files: [{ path: "src/main.php" }],
        });
        const dir = args[args.indexOf("--job-dir") + 1];
        if (dir === undefined) throw new Error("job directory missing");
        expect(readFileSync(join(dir, "assets/source/src/main.php")).toString()).toBe(
          "<?php echo 1;\n"
        );
        expect(readdirSync(join(dir, "assets/source/src"))).toEqual(["main.php"]);
      }),
    });
    const result = await registry.source_query?.run(f.request, progress.context);
    expect(result?.terminal_status).toBe("succeeded");
    expect(result?.output_refs).toHaveLength(1);
    const outputRef = result?.output_refs[0];
    if (outputRef === undefined) throw new Error("output ref missing");
    expect(
      JSON.parse(f.options.artifactStore.readById(outputRef.artifact_id).toString("utf8"))
    ).toMatchObject({
      authority: "host_verified_excerpt",
    });
    expect(progress.work).toHaveLength(1);
    expect(progress.output).toEqual([[outputRef.byte_length, 1]]);
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects a semantically forged source excerpt even when its receipt digest is valid", async () => {
    const f = fixture();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: mutateResultRunner((body) => {
        const items = body.items;
        if (!Array.isArray(items) || !isRecord(items[0])) throw new Error("fixture item absent");
        items[0].text = "forged but schema-valid\n";
      }),
    });
    const result = await registry.source_query?.run(f.request, context().context);
    expect(result).toMatchObject({ terminal_status: "failed", output_refs: [] });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects unsupported query parameters before invoking the runner", async () => {
    const f = fixture();
    if (f.request.operation_input.kind !== "source_query") throw new Error("fixture drift");
    const sourceInput = f.request.operation_input;
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      operation_input: {
        ...sourceInput,
        parameters: [{ name: "ignored", value: { kind: "boolean", value: true } }],
      },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run() {
          throw new Error("runner must not execute");
        },
      },
    });
    expect(await registry.source_query?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("enforces trusted source roots before invoking the runner", async () => {
    const f = fixture();
    const deniedConfig = f.persist("sca-vm-broker-config", "config-denied-root", {
      schema_id: "penny.sca-vm-broker-config.v1",
      schema_version: 1,
      project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      enabled_operations: ["source_query"],
      allowed_source_roots: ["vendor"],
    });
    const request: ScaBrokerExecuteRequestV1 = { ...f.request, config_ref: deniedConfig };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      authorization: {
        ...f.options.authorization,
        configDigests: [deniedConfig.content_digest],
      },
      runner: {
        async run() {
          throw new Error("unauthorized source path must not reach the runner");
        },
      },
    });
    expect(await registry.source_query?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects forged hashes and never returns partial refs", async () => {
    const f = fixture();
    const progress = context();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: fakeRunner(
        () => undefined,
        (receipt) => {
          receipt.job_sha256 = "0".repeat(64);
        }
      ),
    });
    const result = await registry.source_query?.run(f.request, progress.context);
    expect(result).toMatchObject({ terminal_status: "failed", output_refs: [], partial: false });
    expect(progress.output).toEqual([]);
    // Untrusted identity cannot authorize deletion of a possibly live VM run.
    expect(readdirSync(f.workspaceParent)).toHaveLength(2);
  });
  it("stages the exact graph artifact and verifies graph output", async () => {
    const f = fixture();
    const graph = await boundGraph(f, "graph");
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_graph_query",
      operation: "graph_query",
      input_refs: [graph],
      operation_input: {
        kind: "graph_query",
        graph_ref: graph,
        query_id: "query-1",
        parameters: [],
        selectors: [{ path: "src/main.php", line_range: null, symbol: null }],
      },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: fakeRunner((job, args) => {
        expect(job.payload).toMatchObject({
          graph: {
            path: "graph.cpg.bin",
            asset_path: "assets/graph.cpg.bin",
            content_sha256: graph.content_digest,
          },
          query: { selectors: [{ start_line: null, end_line_exclusive: null }] },
        });
        const dir = args[args.indexOf("--job-dir") + 1];
        if (dir === undefined) throw new Error("job directory missing");
        expect(sha256(readFileSync(join(dir, "assets/graph.cpg.bin")))).toBe(graph.content_digest);
        expect(readdirSync(join(dir, "assets"))).toEqual(["graph.cpg.bin"]);
      }),
    });
    const graphResult = await registry.graph_query?.run(request, context().context);
    expect(graphResult?.terminal_status).toBe("succeeded");
    const outputRef = graphResult?.output_refs[0];
    if (outputRef === undefined) throw new Error("graph output ref missing");
    expect(
      JSON.parse(f.options.artifactStore.readById(outputRef.artifact_id).toString("utf8"))
    ).toMatchObject({
      authority: "scanner_observation",
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects a graph that is not derived from the exact source snapshot", async () => {
    const f = fixture();
    const graph = f.persist("sca-graph", "graph-unbound", { fixture: "graph-bytes" });
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_graph_query",
      operation: "graph_query",
      input_refs: [graph],
      operation_input: {
        kind: "graph_query",
        graph_ref: graph,
        query_id: "query-1",
        parameters: [],
        selectors: [{ path: "src/main.php", line_range: null, symbol: null }],
      },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run() {
          throw new Error("unbound graph must not reach the runner");
        },
      },
    });
    expect(await registry.graph_query?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects graph bytes that do not match the direct bridge receipt", async () => {
    const f = fixture();
    await expect(
      buildVerifiedVmGraph({
        options: {
          ...f.options,
          runner: graphBuildRunner(undefined, (receipt) => {
            const outputs = receipt.outputs;
            if (!Array.isArray(outputs) || !isRecord(outputs[0]))
              throw new Error("fixture graph output missing");
            outputs[0].content_sha256 = "0".repeat(64);
          }),
        },
        sourceSnapshotRef: f.request.source_snapshot_ref,
        runId: "run-1",
        operationId: "graph-mismatch",
        language: "php",
        maxNumDef: 4_000,
        maxOutputBytes: 1_000_000,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/output (?:changed|digest mismatch)/u);
  });
  it("constructs the graph build only from sealed P01 source bytes", async () => {
    const f = fixture();
    const inspect = (job: Record<string, unknown>, jobDir: string) => {
      if (!isRecord(job.payload)) throw new Error("fixture job payload missing");
      const files: unknown = job.payload.files;
      if (!Array.isArray(files) || !isRecord(files[0])) throw new Error("fixture file missing");
      expect(files[0]).toEqual({
        path: f.sourceIdentity.path,
        asset_path: `source/${f.sourceIdentity.path}`,
        byte_length: f.sourceIdentity.byte_count,
        content_sha256: f.sourceIdentity.content_sha256,
      });
      const staged = readFileSync(join(jobDir, `source/${f.sourceIdentity.path}`));
      expect(sha256(staged)).toBe(f.sourceIdentity.content_sha256);
    };
    const graph = await buildVerifiedVmGraph({
      options: { ...f.options, runner: graphBuildRunner(undefined, undefined, inspect) },
      sourceSnapshotRef: f.request.source_snapshot_ref,
      runId: "run-1",
      operationId: "graph-sealed-source",
      language: "php",
      maxNumDef: 4_000,
      maxOutputBytes: 1_000_000,
      signal: new AbortController().signal,
    });
    expect(graph.producer).toBe("host:sca-vm-graph-builder");
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects graph nodes outside the requested selector range despite a valid receipt", async () => {
    const f = fixture();
    const graph = await boundGraph(f, "graph-range");
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_graph_query",
      operation: "graph_query",
      input_refs: [graph],
      operation_input: {
        kind: "graph_query",
        graph_ref: graph,
        query_id: "query-1",
        parameters: [],
        selectors: [
          {
            path: "src/main.php",
            line_range: { start_line: 2, end_line_exclusive: 3 },
            symbol: null,
          },
        ],
      },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: fakeRunner(() => undefined),
    });
    expect(await registry.graph_query?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("permits only an allowlisted declarative test with explicit source paths", async () => {
    const f = fixture();
    const plan = f.persist("sca-execution-plan", "plan", {
      schema_id: "penny.sca-vm-test-plan.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      test_id: "php.syntax.v1",
      source_paths: ["src/main.php"],
    });
    const policy = f.persist("sca-execution-policy", "policy", {
      schema_id: "penny.sca-vm-test-policy.v1",
      schema_version: 1,
      project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_test_ids: ["php.syntax.v1"],
    });
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_application_test",
      operation: "application_test",
      input_refs: [plan, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
      operation_input: { kind: "application_test", execution_plan_ref: plan, policy_ref: policy },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      authorization: {
        ...f.options.authorization,
        policyDigests: [policy.content_digest],
      },
      runner: fakeRunner((job) => {
        expect(job.payload).toMatchObject({
          test: { test_id: "php.syntax.v1" },
          files: [{ path: "src/main.php" }],
        });
      }),
    });
    const result = await registry.application_test?.run(request, context().context);
    expect(result?.terminal_status).toBe("succeeded");
    expect(result?.result_item_count).toBe(1);
    const outputRef = result?.output_refs[0];
    if (outputRef === undefined) throw new Error("application output ref missing");
    expect(
      JSON.parse(f.options.artifactStore.readById(outputRef.artifact_id).toString("utf8"))
    ).toMatchObject({
      authority: "host_verified_syntax",
    });
    const denied = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run() {
          throw new Error("unauthorized policy must not reach the runner");
        },
      },
    });
    expect(await denied.application_test?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
  });
  it("rejects application results for an unrequested path despite a valid receipt", async () => {
    const f = fixture();
    const plan = f.persist("sca-execution-plan", "plan-path", {
      schema_id: "penny.sca-vm-test-plan.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      test_id: "php.syntax.v1",
      source_paths: ["src/main.php"],
    });
    const policy = f.persist("sca-execution-policy", "policy-path", {
      schema_id: "penny.sca-vm-test-policy.v1",
      schema_version: 1,
      project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_test_ids: ["php.syntax.v1"],
    });
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_application_test",
      operation: "application_test",
      input_refs: [plan, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
      operation_input: { kind: "application_test", execution_plan_ref: plan, policy_ref: policy },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      authorization: {
        ...f.options.authorization,
        policyDigests: [policy.content_digest],
      },
      runner: mutateResultRunner((body) => {
        const items = body.items;
        if (!Array.isArray(items) || !isRecord(items[0])) throw new Error("fixture item absent");
        items[0].path = "src/other.php";
      }),
    });
    expect(await registry.application_test?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("independently rejects a forged passing syntax result for invalid source", async () => {
    const f = fixture("<?php function broken( {\n");
    const plan = f.persist("sca-execution-plan", "plan-invalid-syntax", {
      schema_id: "penny.sca-vm-test-plan.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      test_id: "php.syntax.v1",
      source_paths: ["src/main.php"],
    });
    const policy = f.persist("sca-execution-policy", "policy-invalid-syntax", {
      schema_id: "penny.sca-vm-test-policy.v1",
      schema_version: 1,
      project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_test_ids: ["php.syntax.v1"],
    });
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_application_test",
      operation: "application_test",
      input_refs: [plan, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
      operation_input: { kind: "application_test", execution_plan_ref: plan, policy_ref: policy },
    };
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      authorization: {
        ...f.options.authorization,
        policyDigests: [policy.content_digest],
      },
      runner: fakeRunner(() => undefined),
    });
    expect(await registry.application_test?.run(request, context().context)).toMatchObject({
      terminal_status: "failed",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("rejects a changed output digest after a valid bridge receipt and reports no partial result", async () => {
    const f = fixture();
    const progress = context();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: fakeRunner(
        () => undefined,
        (receipt) => {
          const outputs = receipt.outputs;
          if (!Array.isArray(outputs) || !isRecord(outputs[0]))
            throw new Error("fixture output absent");
          outputs[0].content_sha256 = "0".repeat(64);
        }
      ),
    });
    const result = await registry.source_query?.run(f.request, progress.context);
    expect(result).toMatchObject({ terminal_status: "failed", output_refs: [], partial: false });
    expect(progress.output).toEqual([]);
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("maps an observed cancellation without returning an output", async () => {
    const f = fixture();
    const controller = new AbortController();
    const delegate = fakeRunner(() => undefined);
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run(exe, args, signal, alive) {
          const completed = await delegate.run(exe, args, signal, alive);
          controller.abort();
          return completed;
        },
      },
    });
    const result = await registry.source_query?.run(f.request, context(controller.signal).context);
    expect(result).toMatchObject({ terminal_status: "cancelled", output_refs: [] });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("removes staged work after an authenticated contained cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run(_exe, args) {
          const jobDir = args[args.indexOf("--job-dir") + 1];
          if (jobDir === undefined) throw new Error("job directory missing");
          const job = readFileSync(join(jobDir, "job.json"));
          controller.abort();
          return {
            exitCode: 130,
            terminated: true,
            stdout:
              canonicalJson({
                containment_proved: true,
                job_sha256: sha256(job),
                run_media_removed: true,
                schema_id: "penny.sca-vm-cancellation.v1",
                schema_version: 1,
                status: "cancelled",
                unit: `penny-guest-${"a".repeat(32)}.service`,
                unit_observed: true,
              }) + "\n",
          };
        },
      },
    });
    expect(
      await registry.source_query?.run(f.request, context(controller.signal).context)
    ).toMatchObject({ terminal_status: "cancelled", output_refs: [] });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("preserves unverified work when the runner cannot prove termination", async () => {
    const f = fixture();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run() {
          return { exitCode: 1, stdout: "", terminated: false };
        },
      },
    });
    let unverifiedReports = 0;
    const result = await registry.source_query?.run(f.request, {
      ...context().context,
      reportContainmentUnverified: () => {
        unverifiedReports += 1;
      },
    });
    expect(result).toMatchObject({ terminal_status: "failed", output_refs: [] });
    expect(unverifiedReports).toBe(1);
    expect(readdirSync(f.workspaceParent)).toHaveLength(2);
  });
  it("cancels before staging without invoking the runner", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const registry = createVmBrokerAdapterRegistry({
      ...f.options,
      runner: {
        async run() {
          throw new Error("runner must not run");
        },
      },
    });
    expect(
      await registry.source_query?.run(f.request, context(controller.signal).context)
    ).toMatchObject({
      terminal_status: "cancelled",
      output_refs: [],
    });
    expect(readdirSync(f.workspaceParent)).toEqual([".vm-global.lock"]);
  });
  it("denies wrong project and refuses unlisted test plans before runner execution", async () => {
    const f = fixture();
    const registry = createVmBrokerAdapterRegistry(f.options);
    const capability = await registry.source_query?.capability({
      schema_id: "penny.sca-broker-capability-request.v1",
      schema_version: 1,
      tenant_id: "tenant-1",
      project_id: "other",
      run_id: "run-1",
      request_id: "cap-1",
      tool_name: "sca_source_query",
      operation: "source_query",
      requested_at: f.request.submitted_at,
      deadline_at: f.request.deadline_at,
      timeout_ms: 30_000,
    });
    expect(capability?.status).toBe("unavailable");
    const plan = f.persist("sca-execution-plan", "plan", {
      schema_id: "penny.sca-vm-test-plan.v1",
      schema_version: 1,
      snapshot_id: "snapshot-1",
      test_id: "php.syntax.v1",
      source_paths: ["src/main.php"],
      command: "id",
    });
    const policy = f.persist("sca-execution-policy", "policy", {
      schema_id: "penny.sca-vm-test-policy.v1",
      schema_version: 1,
      project_id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_test_ids: ["php.syntax.v1"],
    });
    const inputs = [plan, policy].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    const request: ScaBrokerExecuteRequestV1 = {
      ...f.request,
      tool_name: "sca_application_test",
      operation: "application_test",
      input_refs: inputs,
      operation_input: { kind: "application_test", execution_plan_ref: plan, policy_ref: policy },
    };
    const result = await registry.application_test?.run(request, context().context);
    expect(result).toMatchObject({ terminal_status: "failed", output_refs: [] });
  });
});
