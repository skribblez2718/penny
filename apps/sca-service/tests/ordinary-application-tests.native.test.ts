import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import {
  createOrdinaryApplicationTestRuntime,
  recoverOrdinaryApplicationTest,
  OrdinaryApplicationVmConfigSchema,
  type OrdinaryApplicationTestPlan,
  type OrdinaryApplicationTestPolicy,
  type OrdinaryApplicationTestRequest,
  type OrdinaryApplicationTestOwner,
} from "../src/ordinary-application-tests.js";

// No synthetic runner, no downloads, no host target execution. Explicit host-owned configuration
// must name an existing reviewed cloud-init/Python guest and already installed pinned tooling.
const configPath = process.env.PENNY_ORDINARY_APPLICATION_VM_CONFIG;
it.runIf(configPath !== undefined)(
  "native real KVM: admitted PHP/JS/TS fixtures, denial, confinement, bounds, cancel and exact recovery",
  async () => {
    if (configPath === undefined) throw new Error("missing explicit live config");
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const supplied = validateContract(
      OrdinaryApplicationVmConfigSchema,
      parsed,
      "native host VM config"
    );
    const root = mkdtempSync(path.join(tmpdir(), "ordinary-app-native-"));
    const workspace = path.join(root, "vm");
    mkdirSync(workspace, { mode: 0o700 });
    const lock = path.join(workspace, "lock");
    writeFileSync(lock, "", { mode: 0o600 });
    const vm = { ...supplied, workspace_parent: workspace, global_lock: lock };
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const store = ArtifactStore.provision(path.join(root, "artifacts"), { projectId });
    let sequence = 0;
    let quarantine = false;
    const records: unknown[] = [];
    function persist(kind: string, content: string | Buffer, schema?: string) {
      return store.persist({
        metadata: {
          schema_version: 2,
          run_id: "native-run",
          phase: "native-test",
          branch_id: null,
          kind,
          operation_id: `native-${sequence++}`,
          version: 1,
          producer: "host:disposable-native-fixture",
          media_type: schema === undefined ? "application/octet-stream" : "application/json",
          ...(schema === undefined
            ? {}
            : { content_schema: { schema_id: schema, schema_version: 1 } }),
          parent_ref: null,
          upstream_refs: [],
        },
        content,
      });
    }
    const sentinel = path.join(root, "host-only-canary");
    writeFileSync(sentinel, "harmless-generated-host-canary", { mode: 0o600 });
    const variable = "PENNY_DISPOSABLE_APPLICATION_CANARY";
    const previous = process.env[variable];
    process.env[variable] = "harmless-generated-environment-canary";
    async function run(
      interpreter: OrdinaryApplicationTestPlan["interpreter"],
      name: string,
      vulnerable: boolean,
      workload: "observe" | "confinement" | "output" | "timeout" | "cancel" | "denied" = "observe"
    ) {
      const extension =
        interpreter === "php" ? "php" : interpreter === "node_typescript" ? "ts" : "mjs";
      const sourceRoot = path.join(root, `source-${sequence}`);
      mkdirSync(sourceRoot);
      const source =
        interpreter === "php"
          ? `<?php function render($s) { return ${vulnerable ? "$s" : "htmlspecialchars($s, ENT_QUOTES, 'UTF-8')"}; }\n`
          : `export function render(s${interpreter === "node_typescript" ? ": string" : ""}) { return ${vulnerable ? "s" : "s.replaceAll('<', '&lt;')"}; }\n`;
      writeFileSync(path.join(sourceRoot, `target.${extension}`), source);
      const capture = buildHostStaticInventory({
        schema_version: 1,
        purpose: "Harmless isolated native fixture",
        source_root: sourceRoot,
        scope: { include: [], exclude: [] },
        execution_mode: "static_only",
        model: "deepseek-flash",
      });
      const corpus = persist("source-corpus", capture.sourceCorpus);
      let harness =
        interpreter === "php"
          ? `<?php require '../source/target.php'; $v=render('<script>'); echo $v === '<script>' ? 'vulnerable' : 'safe';`
          : `import {render} from '../source/target.${extension}'; process.stdout.write(render('<script>') === '<script>' ? 'vulnerable' : 'safe');`;
      if (workload === "confinement")
        harness =
          interpreter === "php"
            ? `<?php if (file_exists(${JSON.stringify(sentinel)}) || getenv('${variable}') !== false) exit(2); $s=@fsockopen('192.0.2.1',9,$n,$e,1); if ($s !== false) exit(3); $s=@stream_socket_client('unix:///var/run/docker.sock',$n,$e,1); if ($s !== false) exit(4); echo 'confined';`
            : `import fs from 'node:fs'; import net from 'node:net'; if(fs.existsSync(${JSON.stringify(sentinel)}) || process.env.${variable}) process.exit(2); async function denied(options){return await new Promise(resolve=>{const s=net.connect(options);s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',()=>resolve(true));s.setTimeout(1000,()=>{s.destroy();resolve(true)})})} if(!await denied({host:'192.0.2.1',port:9}) || !await denied({path:'/var/run/docker.sock'})) process.exit(3); process.stdout.write('confined');`;
      if (workload === "output")
        harness =
          interpreter === "php"
            ? "<?php while(true) echo str_repeat('x',4096);"
            : "while(true) process.stdout.write('x'.repeat(4096));";
      if (workload === "timeout" || workload === "cancel")
        harness =
          interpreter === "php" ? "<?php while(true) usleep(10000);" : "setInterval(()=>{},1000);";
      const harnessRef = persist("test-harness", harness);
      const resources = {
        vm_timeout_seconds: 180,
        test_timeout_ms: workload === "timeout" ? 200 : 5000,
        cpu_seconds: 10,
        memory_bytes: 1_610_612_736,
        processes: 32,
        file_bytes: 1_048_576,
        output_bytes: 4096,
      };
      const plan: OrdinaryApplicationTestPlan = {
        schema_id: "penny.sca-ordinary-application-plan.v1",
        schema_version: 1,
        source_snapshot_sha256: capture.sourceSnapshotSha256,
        source_corpus_ref: corpus,
        interpreter,
        source_files: [
          {
            path: `target.${extension}`,
            content_sha256: workload === "denied" ? "0".repeat(64) : sha256(source),
          },
        ],
        harness_ref: harnessRef,
        test_inputs: [],
        stdin_ref: null,
        expected_exit_code: 0,
        resources,
      };
      const planRef = persist("sca-execution-plan", canonicalJson(plan), plan.schema_id);
      const policy: OrdinaryApplicationTestPolicy = {
        schema_id: "penny.sca-ordinary-application-policy.v1",
        schema_version: 1,
        project_id: projectId,
        run_id: "native-run",
        isolation: "vm",
        network: "none",
        credentials: "none",
        profile: "qemu-kvm-nicless-v1",
        allowed_plan_sha256: [planRef.content_digest],
        maxima: resources,
      };
      const policyRef = persist("sca-execution-policy", canonicalJson(policy), policy.schema_id);
      const request: OrdinaryApplicationTestRequest = {
        schema_id: "penny.sca-ordinary-application-request.v1",
        schema_version: 1,
        project_id: projectId,
        run_id: "native-run",
        action_id: name,
        source_snapshot_sha256: capture.sourceSnapshotSha256,
        execution_plan_ref: planRef,
        policy_ref: policyRef,
      };
      const controller = new AbortController();
      const owner: OrdinaryApplicationTestOwner = {
        projectId,
        runId: "native-run",
        signal: controller.signal,
        readArtifact(ref) {
          const retained = store.refById(ref.artifact_id);
          if (retained === undefined) throw new Error("missing admitted native artifact");
          return { ref: retained, bytes: store.readById(ref.artifact_id) };
        },
        beforeSubmit(correlation) {
          records.push({
            kind: "submission_guard",
            correlation,
            request_sha256: sha256(canonicalJson(request)),
          });
        },
        accepted(correlation) {
          records.push({ kind: "acceptance", correlation });
          if (workload === "cancel") controller.abort();
        },
        activity() {},
      };
      const result = await createOrdinaryApplicationTestRuntime({
        authority: { project_id: projectId, admitted_policy_refs: [policyRef] },
        vm,
      }).run(request, owner);
      quarantine ||= result.quarantine_required;
      const receipt = {
        name,
        interpreter,
        source_sha256: sha256(source),
        harness_sha256: sha256(harness),
        request,
        plan,
        policy,
        result,
      };
      records.push(receipt);
      writeFileSync(path.join(root, `${name}.json`), canonicalJson(receipt), { mode: 0o600 });
      if (workload === "denied")
        expect(result).toMatchObject({ status: "denied", execution: "NOT RUN" });
      else if (result.status === "unsupported") {
        // Missing guest interpreter is a genuine unsupported result, not a VM PASS.
        expect(result.execution).toBe("NOT RUN");
        expect(result.reason).toBe("guest_unsupported");
      } else if (workload === "observe" || workload === "confinement") {
        expect(result).toMatchObject({
          status: "completed",
          execution: "RUN",
          passed: true,
          cleanup: "proved",
        });
        expect(Buffer.from(result.stdout_base64, "base64").toString()).toBe(
          workload === "confinement" ? "confined" : vulnerable ? "vulnerable" : "safe"
        );
      } else if (workload === "cancel")
        expect(result).toMatchObject({
          reason: "cancelled",
          cleanup: "proved",
          quarantine_required: false,
        });
      else
        expect(result).toMatchObject({
          status: "failed",
          execution: "RUN",
          reason: workload === "output" ? "output_limit" : "timeout",
          cleanup: "proved",
        });
      expect(recoverOrdinaryApplicationTest(request, Buffer.from(canonicalJson(result)))).toEqual(
        result
      );
      return result;
    }
    try {
      await run("php", "denied", false, "denied");
      for (const interpreter of ["php", "node", "node_typescript"] as const) {
        const safe = await run(interpreter, `${interpreter}-safe`, false);
        if (safe.status === "unsupported") continue;
        await run(interpreter, `${interpreter}-vulnerable`, true);
        await run(interpreter, `${interpreter}-confinement`, false, "confinement");
      }
      await run("node", "bounded-output", false, "output");
      await run("node", "bounded-timeout", false, "timeout");
      await run("node", "cancel", false, "cancel");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
      store.close();
      writeFileSync(
        path.join(root, "native-records.json"),
        canonicalJson({ records, quarantine, vm }),
        { mode: 0o600 }
      );
      // Canonical operands and receipts are deliberate private evidence, not leaked VM media.
      // Never delete unproved VM media. The caller gets the exact path, not a name-only pointer.
      console.info(`Native application-test evidence retained at: ${root}`);
    }
  },
  2_400_000
);
