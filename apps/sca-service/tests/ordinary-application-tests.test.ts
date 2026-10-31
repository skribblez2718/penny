import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import type { CurrentArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  createOrdinaryApplicationTestRuntime,
  recoverOrdinaryApplicationTest,
  validateOrdinaryApplicationTestResult,
  type OrdinaryApplicationTestPlan,
  type OrdinaryApplicationTestPolicy,
  type OrdinaryApplicationTestRequest,
  type OrdinaryApplicationTestOwner,
  type OrdinaryApplicationVmConfig,
} from "../src/ordinary-application-tests.js";
import type { VmBrokerRunner } from "../src/vm-broker-adapter.js";

// These tests exercise protocol/control semantics, NOT a guest boot or isolation qualification.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: (...args: Parameters<typeof original.open>) =>
      original.open(args[0] === "/dev/kvm" ? "/dev/null" : args[0], args[1], args[2]),
  };
});
const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  mutatePlan?: (plan: OrdinaryApplicationTestPlan) => void,
  harnessText = "process.stdout.write('controlled observation');\n"
) {
  const root = mkdtempSync(path.join(tmpdir(), "ordinary-app-contract-"));
  roots.push(root);
  const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const store = ArtifactStore.provision(path.join(root, "artifacts"), { projectId });
  stores.push(store);
  const target = path.join(root, "target");
  mkdirSync(target);
  writeFileSync(path.join(target, "safe.ts"), "export const safe = (s: string) => s;\n");
  const captured = buildHostStaticInventory({
    schema_version: 1,
    source_root: target,
    purpose: "Disposable protocol fixture",
    scope: { include: [], exclude: [] },
    execution_mode: "static_only",
    model: "deepseek-flash",
  });
  let sequence = 0;
  function persist(kind: string, content: string | Buffer, schema?: string) {
    return store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-1",
        phase: "test",
        branch_id: null,
        kind,
        operation_id: `operand-${sequence++}`,
        version: 1,
        producer: "host:fixture",
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
  const corpus = persist("source-corpus", captured.sourceCorpus);
  const harness = persist("test-harness", harnessText);
  const resources = {
    vm_timeout_seconds: 120,
    test_timeout_ms: 1000,
    cpu_seconds: 2,
    memory_bytes: 536_870_912,
    processes: 16,
    file_bytes: 4096,
    output_bytes: 1024,
  };
  const plan: OrdinaryApplicationTestPlan = {
    schema_id: "penny.sca-ordinary-application-plan.v1",
    schema_version: 1,
    source_snapshot_sha256: captured.sourceSnapshotSha256,
    source_corpus_ref: corpus,
    interpreter: "node_typescript",
    source_files: [
      { path: "safe.ts", content_sha256: sha256(readFileSync(path.join(target, "safe.ts"))) },
    ],
    harness_ref: harness,
    test_inputs: [],
    stdin_ref: null,
    expected_exit_code: 0,
    resources,
  };
  mutatePlan?.(plan);
  const planRef = persist("sca-execution-plan", canonicalJson(plan), plan.schema_id);
  const policy: OrdinaryApplicationTestPolicy = {
    schema_id: "penny.sca-ordinary-application-policy.v1",
    schema_version: 1,
    project_id: projectId,
    run_id: "run-1",
    isolation: "vm",
    network: "none",
    credentials: "none",
    profile: "qemu-kvm-nicless-v1",
    allowed_plan_sha256: [planRef.content_digest],
    maxima: { ...resources },
  };
  const policyRef = persist("sca-execution-policy", canonicalJson(policy), policy.schema_id);
  const request: OrdinaryApplicationTestRequest = {
    schema_id: "penny.sca-ordinary-application-request.v1",
    schema_version: 1,
    project_id: projectId,
    run_id: "run-1",
    action_id: "test-action",
    source_snapshot_sha256: captured.sourceSnapshotSha256,
    execution_plan_ref: planRef,
    policy_ref: policyRef,
  };
  const vmRoot = path.join(root, "vm");
  mkdirSync(vmRoot, { mode: 0o700 });
  const lock = path.join(vmRoot, "lock");
  writeFileSync(lock, "", { mode: 0o600 });
  function pin(name: string, mode = 0o500) {
    const file = path.join(vmRoot, name);
    writeFileSync(file, `fake pinned ${name}`, { mode });
    chmodSync(file, mode);
    return {
      path: file,
      sha256: sha256(readFileSync(file)),
      size_bytes: readFileSync(file).length,
    };
  }
  const vm: OrdinaryApplicationVmConfig = {
    workspace_parent: vmRoot,
    global_lock: lock,
    run_job: pin("run_job.py"),
    run_guest: pin("run_guest.py"),
    output_protocol: pin("output_protocol.py"),
    python: pin("python"),
    genisoimage: pin("iso"),
    cp: pin("cp"),
    qemu: pin("qemu"),
    bwrap: pin("bwrap"),
    systemctl: pin("systemctl"),
    template: pin("template.raw", 0o400),
    bridge: pin("bridge.py"),
    guest: pin("guest.py"),
  };
  const controller = new AbortController();
  const beforeSubmit = vi.fn();
  const accepted = vi.fn();
  const activity = vi.fn();
  const owner: OrdinaryApplicationTestOwner = {
    projectId,
    runId: "run-1",
    signal: controller.signal,
    readArtifact(ref) {
      const retained = store.refById(ref.artifact_id);
      if (retained === undefined) throw new Error("missing admitted artifact");
      return { ref: retained, bytes: store.readById(ref.artifact_id) };
    },
    beforeSubmit,
    accepted,
    activity,
  };
  const authority = { project_id: projectId, admitted_policy_refs: [policyRef] };
  return {
    root,
    vmRoot,
    vm,
    store,
    request,
    owner,
    authority,
    beforeSubmit,
    accepted,
    activity,
    controller,
    plan,
    policy,
    persist,
    harness,
  };
}
type Oracle = {
  status?: "exited" | "timeout" | "output_limit" | "unsupported";
  exit?: number;
  contain?: boolean;
  removed?: boolean;
  forged?: boolean;
  noMarker?: boolean;
  noLaunch?: boolean;
  cancel?: () => void;
  overOutput?: boolean;
  terminated?: boolean;
  wrongPointer?: boolean;
};
function oracle(options: Oracle = {}) {
  let work: string | undefined;
  const calls: { exe: string; args: readonly string[] }[] = [];
  const runner: VmBrokerRunner = {
    async run(exe, args, _signal, milestone) {
      calls.push({ exe, args });
      const payloadIndex = args.indexOf("--payload");
      const payloadPath = args[payloadIndex + 1];
      if (payloadPath === undefined) throw new Error("payload operand missing");
      work = path.dirname(payloadPath);
      const bytes = await readFile(payloadPath);
      const digest = sha256(bytes);
      for (let i = 0; i < (options.noLaunch ? 3 : 4); i++) milestone();
      options.cancel?.();
      const guest = {
        schema_version: 1,
        payload_sha256: options.forged ? "0".repeat(64) : digest,
        status: options.status ?? "exited",
        execution: options.status === "unsupported" ? "NOT RUN" : "RUN",
        exit_code: options.status === "unsupported" ? null : (options.exit ?? 0),
        stdout_base64:
          options.status === "unsupported"
            ? ""
            : Buffer.from(
                options.overOutput ? "x".repeat(2048) : "controlled observation"
              ).toString("base64"),
        stderr_base64: "",
      };
      const receipt = {
        schema_version: 1,
        payload_sha256: digest,
        status: options.noLaunch ? "failed" : "completed",
        launcher_started: !options.noLaunch,
        unit_observed: !options.noLaunch,
        containment_proved: options.contain ?? true,
        media_removed: options.removed ?? true,
        launcher_base64: "",
        command_base64: "",
        serial_base64: Buffer.from(
          options.noMarker
            ? "boot log only\n"
            : `boot log\nPENNY_APP_TEST_RESULT=${canonicalJson(guest)}\n`
        ).toString("base64"),
      };
      const raw = canonicalJson(receipt);
      await writeFile(path.join(work, "receipt.json"), raw, { flag: "wx", mode: 0o600 });
      return {
        exitCode: options.noLaunch ? 1 : 0,
        terminated: options.terminated ?? true,
        stdout:
          canonicalJson({
            schema_version: 1,
            receipt_sha256: options.wrongPointer ? "0".repeat(64) : sha256(raw),
            receipt_bytes: Buffer.byteLength(raw),
          }) + "\n",
      };
    },
  };
  return { runner, calls, workspace: () => work };
}

describe("ordinary application-test exact admission and VM protocol (synthetic transport)", () => {
  it("exposes a closed API; host configuration cannot be selected in the request", async () => {
    const f = fixture();
    const fake = oracle();
    const runtime = createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    });
    await expect(
      runtime.run({ ...f.request, command: "node", mounts: ["/"], network: "host" }, f.owner)
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
  it("returns unsupported NOT RUN with no VM selected, after admission", async () => {
    const f = fixture();
    const result = await createOrdinaryApplicationTestRuntime({ authority: f.authority }).run(
      f.request,
      f.owner
    );
    expect(result).toMatchObject({
      status: "unsupported",
      execution: "NOT RUN",
      acceptance: "not_submitted",
      cleanup: "not_needed",
    });
    expect(f.beforeSubmit).not.toHaveBeenCalled();
  });
  it.each(["source_hash", "traversal", "duplicate", "file_alias", "resource"])(
    "denies %s before any target execution",
    async (mode) => {
      const f = fixture((plan) => {
        if (mode === "source_hash")
          plan.source_files[0] = { path: "safe.ts", content_sha256: "0".repeat(64) };
        if (mode === "traversal")
          plan.source_files[0] = { path: "../safe.ts", content_sha256: "0".repeat(64) };
        if (mode === "duplicate") plan.source_files.push(...plan.source_files);
        if (mode === "file_alias")
          plan.test_inputs = [
            { path: "a", ref: plan.harness_ref },
            { path: "a/b", ref: plan.harness_ref },
          ];
        if (mode === "resource") plan.resources.vm_timeout_seconds = 1;
      });
      const fake = oracle();
      const result = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(result.status).toBe("denied");
      expect(result.execution).toBe("NOT RUN");
      expect(fake.calls).toEqual([]);
      expect(f.beforeSubmit).not.toHaveBeenCalled();
    }
  );
  it("requires separately host-admitted policy refs; equal-shaped caller policy is not authority", async () => {
    const f = fixture();
    const fake = oracle();
    const other = f.persist("sca-execution-policy", canonicalJson(f.policy), f.policy.schema_id);
    const result = await createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    }).run({ ...f.request, policy_ref: other }, f.owner);
    expect(result).toMatchObject({
      status: "denied",
      reason: "policy_denied",
      execution: "NOT RUN",
    });
    expect(fake.calls).toEqual([]);
  });
  it("rejects a substituted harness/plan even when source snapshot is unchanged", async () => {
    const f = fixture();
    const fake = oracle();
    const harness = f.persist("test-harness", "different exact harness");
    const changed = f.persist(
      "sca-execution-plan",
      canonicalJson({ ...f.plan, harness_ref: harness }),
      f.plan.schema_id
    );
    const result = await createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    }).run({ ...f.request, execution_plan_ref: changed }, f.owner);
    expect(result.reason).toBe("policy_denied");
    expect(fake.calls).toEqual([]);
  });
  it("checks exact owner bytes and cross-run/project identity", async () => {
    const f = fixture();
    const fake = oracle();
    const runtime = createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    });
    const corrupt = {
      ...f.owner,
      readArtifact(ref: CurrentArtifactRef) {
        return { ref, bytes: Buffer.from("substituted") };
      },
    };
    expect((await runtime.run(f.request, corrupt)).status).toBe("denied");
    expect((await runtime.run({ ...f.request, project_id: "other" }, f.owner)).reason).toBe(
      "policy_denied"
    );
    expect((await runtime.run({ ...f.request, run_id: "other" }, f.owner)).reason).toBe(
      "policy_denied"
    );
    expect(fake.calls).toEqual([]);
  });
  it.each([0, 1])(
    "retains a full observation, not a vulnerability verdict (exit %i)",
    async (code) => {
      const f = fixture();
      const fake = oracle({ exit: code });
      const result = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(result).toMatchObject({
        status: "completed",
        execution: "RUN",
        passed: code === 0,
        exit_code: code,
        cleanup: "proved",
        acceptance: "terminal",
        quarantine_required: false,
      });
      expect(Buffer.from(result.stdout_base64, "base64").toString()).toBe("controlled observation");
      expect(result.raw_receipt_base64.length).toBeGreaterThan(0);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.args.slice(0, 2)).toEqual(["-I", "-B"]);
      expect(f.beforeSubmit).toHaveBeenCalledOnce();
      expect(f.accepted).toHaveBeenCalledOnce();
      const work = fake.workspace();
      if (work === undefined) throw new Error("workspace not observed");
      expect(existsSync(work)).toBe(false);
      expect(recoverOrdinaryApplicationTest(f.request, Buffer.from(canonicalJson(result)))).toEqual(
        result
      );
    }
  );
  it.each(["timeout", "output_limit", "unsupported"] as const)(
    "does not convert %s into completed",
    async (status) => {
      const f = fixture();
      const fake = oracle({ status });
      const result = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(result.status).toBe(status === "unsupported" ? "unsupported" : "failed");
      expect(result.passed).toBeNull();
      expect(result.cleanup).toBe("proved");
      expect(result.execution).toBe(status === "unsupported" ? "NOT RUN" : "RUN");
    }
  );
  it.each([{ forged: true }, { noMarker: true }])(
    "never fabricates RUN/NOT RUN from invalid guest evidence %j",
    async (mode) => {
      const f = fixture();
      const fake = oracle(mode);
      const result = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(result).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        reason: "evidence_invalid",
        cleanup: "proved",
      });
    }
  );
  it.each([{ contain: false }, { removed: false }])(
    "quarantines and retains staging when cleanup proof is absent %j",
    async (mode) => {
      const f = fixture();
      const fake = oracle(mode);
      const result = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(result).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        cleanup: "unproved",
        quarantine_required: true,
      });
      const work = fake.workspace();
      if (work === undefined) throw new Error("missing retained workspace");
      expect(existsSync(work)).toBe(true);
    }
  );
  it("does not spawn after an already requested cancel or a rejected submission fence", async () => {
    const f = fixture();
    const fake = oracle();
    const runtime = createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    });
    f.controller.abort();
    expect((await runtime.run(f.request, f.owner)).execution).toBe("NOT RUN");
    expect(fake.calls).toEqual([]);
    const next = fixture();
    next.beforeSubmit.mockImplementation(() => {
      throw new Error("stale fence");
    });
    expect(
      (
        await createOrdinaryApplicationTestRuntime({
          authority: next.authority,
          vm: next.vm,
          runner: fake.runner,
        }).run(next.request, next.owner)
      ).execution
    ).toBe("NOT RUN");
    expect(fake.calls).toEqual([]);
  });
  it("keeps actual RUN truth when cancellation races a complete guest observation", async () => {
    const f = fixture();
    const fake = oracle({ cancel: () => f.controller.abort() });
    const result = await createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    }).run(f.request, f.owner);
    expect(result).toMatchObject({
      status: "failed",
      reason: "cancelled",
      execution: "RUN",
      passed: null,
      cleanup: "proved",
    });
  });
  it("guards the ambiguous acceptance window and refuses automatic recovery replay", async () => {
    const f = fixture();
    const runner: VmBrokerRunner = {
      async run() {
        throw new Error("transport lost after submission");
      },
    };
    const result = await createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner,
    }).run(f.request, f.owner);
    expect(result).toMatchObject({
      status: "incomplete",
      execution: "UNKNOWN",
      acceptance: "ambiguous",
      quarantine_required: true,
    });
    expect(recoverOrdinaryApplicationTest(f.request, null)).toMatchObject({
      reason: "recovery_requires_exact_cache",
      execution: "UNKNOWN",
      quarantine_required: true,
    });
    expect(() =>
      recoverOrdinaryApplicationTest(
        { ...f.request, action_id: "different" },
        Buffer.from(canonicalJson(result))
      )
    ).toThrow("binding drift");
  });
  it("fails closed on pinned image drift and an already quarantined global lock", async () => {
    const f = fixture();
    const fake = oracle();
    const runtime = createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    });
    chmodSync(f.vm.template.path, 0o600);
    writeFileSync(f.vm.template.path, "changed");
    chmodSync(f.vm.template.path, 0o400);
    expect((await runtime.run(f.request, f.owner)).status).toBe("unsupported");
    writeFileSync(f.vm.global_lock, "containment-unproved\n");
    expect((await runtime.run(f.request, f.owner)).execution).toBe("NOT RUN");
    expect(fake.calls).toEqual([]);
  });
  it("denies an empty harness and honors cancellation during pinned-host preflight", async () => {
    const empty = fixture(undefined, "");
    const fake = oracle();
    const denied = await createOrdinaryApplicationTestRuntime({
      authority: empty.authority,
      vm: empty.vm,
      runner: fake.runner,
    }).run(empty.request, empty.owner);
    expect(denied).toMatchObject({ status: "denied", execution: "NOT RUN" });
    const f = fixture();
    const timer = setTimeout(() => f.controller.abort(), 0);
    try {
      const cancelled = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(cancelled).toMatchObject({
        status: "failed",
        reason: "cancelled",
        execution: "NOT RUN",
      });
      expect(f.beforeSubmit).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
  it("preserves proven NOT RUN when the bridge failed before the VM launch", async () => {
    const f = fixture();
    const fake = oracle({ noLaunch: true });
    const outcome = await createOrdinaryApplicationTestRuntime({
      authority: f.authority,
      vm: f.vm,
      runner: fake.runner,
    }).run(f.request, f.owner);
    expect(outcome).toMatchObject({
      status: "failed",
      execution: "NOT RUN",
      cleanup: "proved",
      acceptance: "terminal",
      quarantine_required: false,
    });
    expect(f.accepted).not.toHaveBeenCalled();
  });
  it.each([{ overOutput: true }, { wrongPointer: true }, { terminated: false }])(
    "rejects oversized output, changed receipts and nonterminal transport %j",
    async (mode) => {
      const f = fixture();
      const fake = oracle(mode);
      const outcome = await createOrdinaryApplicationTestRuntime({
        authority: f.authority,
        vm: f.vm,
        runner: fake.runner,
      }).run(f.request, f.owner);
      expect(outcome.status).toBe("incomplete");
      expect(outcome.execution).toBe("UNKNOWN");
      if (mode.overOutput) expect(outcome.cleanup).toBe("proved");
      else {
        expect(outcome.quarantine_required).toBe(true);
        expect(outcome.retained_workspace).toBe(fake.workspace());
      }
    }
  );
  it("rejects policy network/profile widening and never executes a substituted host command", async () => {
    const f = fixture();
    const fake = oracle();
    const badPolicy = f.persist(
      "sca-execution-policy",
      canonicalJson({ ...f.policy, network: "host", profile: "docker", command: "echo anything" }),
      f.policy.schema_id
    );
    const outcome = await createOrdinaryApplicationTestRuntime({
      authority: { ...f.authority, admitted_policy_refs: [badPolicy] },
      vm: f.vm,
      runner: fake.runner,
    }).run({ ...f.request, policy_ref: badPolicy }, f.owner);
    expect(outcome).toMatchObject({ status: "denied", execution: "NOT RUN" });
    expect(fake.calls).toEqual([]);
  });
  it("rejects fabricated completed truth without RUN, receipt, cleanup or with quarantine", async () => {
    const f = fixture();
    const result = await createOrdinaryApplicationTestRuntime({ authority: f.authority }).run(
      f.request,
      f.owner
    );
    expect(() =>
      validateOrdinaryApplicationTestResult({ ...result, status: "completed", passed: true })
    ).toThrow();
    expect(() =>
      validateOrdinaryApplicationTestResult({ ...result, execution: "UNKNOWN" })
    ).toThrow();
    expect(() =>
      validateOrdinaryApplicationTestResult({ ...result, cleanup: "unproved" })
    ).toThrow();
  });
});
