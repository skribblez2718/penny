import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../dist/host-operations/capacity-authority.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import {
  minimalVideogenManifest,
  ManifestVideogenFixture,
} from "./helpers/videogen-manifest-fixture.js";
import {
  bootstrapVideogenRuntime,
  buildVideogenRuntimeManifest,
  parseVideogenRuntimeManifest,
  VIDEOGEN_RUNTIME_MANIFEST_ENV,
} from "../dist/videogen/runtime-manifest.js";
import { OrchestrationService } from "../dist/service.js";
import { chmodSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  observeNativeProcess,
  requireNativeDescendant,
  nativeFileSha256,
  parseLinuxProcessStat,
  measureNativePrivateFiles,
} from "../dist/host-operations/native-process.js";
import {
  NativeCapacityMeter,
  NativeManagedWorkerRegistry,
  observeNativeCpu,
} from "../dist/host-operations/native-capacity.js";
import { publishManagedLeaseFile } from "../dist/host-operations/managed-lease-client.js";
import {
  NativeMeterFinalSchema,
  NativeMeterStartSchema,
  ManagedWorkerStateSchema,
} from "../dist/host-operations/native-capacity-contracts.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { readNativeObservationFile } from "../dist/host-operations/native-host-observation.js";
import { HostOperationCapacityRuntimeBinding } from "../dist/host-operations/capacity-runtime.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { syntheticCapacityAdapter } from "./helpers/capacity-runtime-fixtures.js";
import { nativeCapacityFixture, nativeProcessPin } from "./helpers/native-capacity-fixture.js";
import { requireValue } from "./helpers/narrowing.js";

function bind(n: ReturnType<typeof nativeCapacityFixture>): void {
  new HostOperationCapacityRuntimeBinding(n.f.capacity, n.f.project, n.f.demands);
}
function baseline(n: ReturnType<typeof nativeCapacityFixture>, id: string) {
  return validateSkillSchema(
    NativeMeterStartSchema,
    n.f.capacity.nativeEvent(id, "native_meter_start_v1"),
    "baseline"
  );
}

describe("native capacity: actual Linux identity, controlled CPU/GPU counters (not GPU qualification)", () => {
  it("default JSON composition builds the real native collector and refuses an uninstalled policy without installing one", () => {
    const n = nativeCapacityFixture(true);
    using f = n.f;
    using target = new ManifestVideogenFixture();
    const template = minimalVideogenManifest(target);
    const capacity = {
      policy: f.policy,
      native: n.config,
      demands: f.policy.bindings.map((b) => ({
        operation_kind: b.operation_kind,
        binding_id: b.binding_id,
        demands: b.resource_ids.map((resource_id) => ({
          resource_id,
          slots: 1,
          meters: {
            gpu_milliseconds: 10000,
            cpu_milliseconds: 10000,
            stored_bytes: 10000,
            egress_bytes: 10000,
            cost_microcredits: 10000,
            attempts: 1,
            engine_steps: 1,
          },
        })),
      })),
    };
    const manifest = buildVideogenRuntimeManifest({ ...template, capacity });
    const providers = bootstrapVideogenRuntime({
      manifest,
      store: target.store,
      project_id: target.project_id,
    });
    expect(providers.capacity_options?.measurements).toBeInstanceOf(NativeCapacityMeter);
    expect(() =>
      parseVideogenRuntimeManifest({
        ...manifest,
        capacity: { ...capacity, measurement_file: "/not-a-source" },
      })
    ).toThrow();
    const file = path.join(target.root, "native-runtime.json");
    writeFileSync(file, canonicalJson(manifest), { mode: 0o600 });
    const create = () =>
      new OrchestrationService({
        projectRoot: target.root,
        env: { PENNY_STATE_ROOT: target.stateRoot, [VIDEOGEN_RUNTIME_MANIFEST_ENV]: file },
        playbookName: "videogen",
      });
    expect(create).toThrow("durable policy absent");
    expect(create).toThrow("durable policy absent");
    const drift = structuredClone(capacity);
    requireValue(drift.native.topology.resources[0], "physical resource").device = {
      kind: "gpu",
      uuid: "GPU-5678",
    };
    expect(() =>
      bootstrapVideogenRuntime({
        manifest: { ...manifest, capacity: drift },
        store: target.store,
        project_id: target.project_id,
      })
    ).toThrow("topology drift");
  });
  it("checks a foreign project's managed grant through the SAME live catalog fence, without opening its project database", () => {
    using f = new CapacityFixture();
    const local = f.core([requireValue(f.projects[0], "local").authority]);
    const foreign = f.core([requireValue(f.projects[1], "foreign").authority]);
    const op = f.operation("foreign-managed", "voice-a", 1),
      held = foreign.reserve(op.request);
    const grant = {
      schema_id: "penny.managed-lease-grant.v1" as const,
      schema_version: 1 as const,
      operation_record_id: op.record.operation_record_id,
      project_id: op.record.project_id,
      operation_request_sha256: op.record.request_sha256,
      capacity_request_sha256: sha256(canonicalJson(op.request)),
      directive_sha256: op.record.directive_sha256,
      lease: requireValue(op.record.lease, "foreign fence"),
      worker_id: "voice-process",
      process_epoch: sha256("controlled process"),
      gate_sequence: 1,
      resource_ids: op.request.demands.map((d) => d.resource_id),
      issued_at_ms: f.now,
      expires_at_ms: f.now + 100000,
    };
    expect(() =>
      foreign.recordNativeEvent(op.record.operation_record_id, "managed_lease_grant_v1", grant)
    ).toThrow("phase conflict");
    f.leases.guardSubmission(op.leaseRequest, grant.lease, f.now);
    f.transition(op, { lifecycle: "submitting" });
    foreign.recordNativeEvent(op.record.operation_record_id, "managed_lease_grant_v1", grant);
    expect(local.requireNativeGrant(grant)).toEqual(held.lease);
    expect(() =>
      local.requireNativeGrant({ ...grant, operation_request_sha256: sha256("wrong") })
    ).toThrow("conflict");
    f.now += 100001;
    expect(() => local.requireNativeGrant(grant)).toThrow("fence/hold absent");
  });
  it("parses Linux comm with parentheses, verifies live epoch and refuses stale/reused pins", () => {
    const pin = nativeProcessPin();
    const fields = Array.from({ length: 30 }, () => "0");
    fields[0] = "S";
    fields[1] = "1";
    fields[11] = "21";
    fields[12] = "34";
    fields[19] = "123";
    expect(parseLinuxProcessStat(`42 (name ) with spaces)) ${fields.join(" ")}`)).toMatchObject({
      pid: 42,
      start_ticks: "123",
      cpu_ticks: 55n,
    });
    expect(observeNativeProcess(pin, nativeFileSha256).pid).toBe(process.pid);
    expect(() => observeNativeProcess({ ...pin, start_ticks: "1" }, nativeFileSha256)).toThrow(
      "drifted"
    );
    expect(() => parseLinuxProcessStat("bad proc input")).toThrow();
  });
  it("measures only exact nonrecursive private bytes; directories, links and readable exports refuse", () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const file = path.join(f.root, "measured.bin");
    expect(measureNativePrivateFiles([file])[0]?.bytes).toBe(0);
    writeFileSync(file, Buffer.alloc(71), { mode: 0o600 });
    expect(measureNativePrivateFiles([file])[0]?.bytes).toBe(71);
    chmodSync(file, 0o644);
    expect(() => measureNativePrivateFiles([file])).toThrow("unsafe");
    chmodSync(file, 0o600);
    const link = path.join(f.root, "linked.bin");
    symlinkSync(file, link);
    expect(() => measureNativePrivateFiles([link])).toThrow();
    expect(() => measureNativePrivateFiles([f.root])).toThrow("unsafe");
    expect(() => measureNativePrivateFiles([file, file])).toThrow("duplicate");
  });
  it("does not mistake ordinary fixture files for real Linux cgroup accounting", () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const b = requireValue(n.config.meters[0], "meter");
    expect(() =>
      observeNativeCpu({ ...b, cpu_cgroup: { ...b.cpu_cgroup, directory: f.root } })
    ).toThrow("cgroup");
  });
  it("uses the real owner lifecycle, bounded measured deltas, exact tariff and same-journal stop/final receipts", async () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const directive = f.prepare("native-meter-owner"),
      base = syntheticCapacityAdapter(() => undefined, f.counter);
    const adapter = {
      ...base,
      run: async (context: Parameters<typeof base.run>[0]) => {
        expect(baseline(n, context.journal.operation_record_id).counter.cpu_usage_usec).toBe(
          "1000"
        );
        n.counters.usec = 4001n;
        n.counters.ns += 123000000n;
        writeFileSync(
          path.join(f.root, `private-${context.journal.operation_record_id}.bin`),
          Buffer.alloc(73),
          { mode: 0o600 }
        );
        const held = requireValue(f.capacity.inspect(context.journal.operation_record_id), "hold");
        f.capacity.account(context.journal.operation_record_id, held.revision);
        return base.run(context);
      },
    };
    expect(
      (
        await f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive)
      ).action
    ).toBe("await_user");
    const journal = f.record(directive),
      capacity = requireValue(f.capacity.inspect(journal.operation_record_id), "settled");
    const snapshot = requireValue(capacity.snapshot, "measured snapshot");
    expect(capacity.state).toBe("settled");
    expect(snapshot.kind).toBe("final");
    expect(snapshot.source_revision).toBe(2);
    expect(snapshot.readings[0]?.meters).toMatchObject({
      cpu_milliseconds: 4,
      gpu_milliseconds: 0,
      cost_microcredits: 6,
      attempts: 1,
      engine_steps: 1,
      egress_bytes: 0,
    });
    const bytes = 73 + requireValue(journal.operation_result_ref, "raw result").byte_length;
    expect(snapshot.readings[1]?.meters.stored_bytes).toBe(bytes);
    expect(snapshot.readings[1]?.meters.cost_microcredits).toBe(Math.ceil((bytes * 3) / 2));
    expect(
      f.capacity.nativeEvent(journal.operation_record_id, "native_meter_stop_v1")
    ).toBeDefined();
    expect(
      validateSkillSchema(
        NativeMeterFinalSchema,
        f.capacity.nativeEvent(journal.operation_record_id, "native_meter_final_v1"),
        "final"
      ).snapshot
    ).toEqual(snapshot);
    const before = canonicalJson(capacity.snapshot);
    n.counters.usec = 999999999n;
    f.reopen();
    const reopenedSource = new NativeCapacityMeter(n.config, f.policy, undefined, {
      cpu: () => {
        throw new Error("final replay must not sample again");
      },
    });
    f.capacity.close();
    f.project = new HostCapacityProjectAuthority(
      f.config.projectId,
      f.checkpointer,
      f.artifacts,
      reopenedSource
    );
    f.capacity = new HostOperationCapacityAuthority({
      stateRoot: f.config.stateRoot,
      policy: f.policy,
      projects: [f.project],
    });
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(canonicalJson(f.capacity.inspect(journal.operation_record_id)?.snapshot)).toBe(before);
    expect(f.counter.submissions).toBe(1);
  });
  it("bills configured CPU allocation windows from observed monotonic time and exact held slots, retaining actual CPU usage", async () => {
    const n = nativeCapacityFixture(false, undefined, (config) => {
      for (const binding of config.meters) {
        const cpu = requireValue(
          binding.resources.find((r) => r.sources.includes("worker_cpu")),
          "CPU source"
        );
        cpu.tariff = { per: "cpu_allocation_milliseconds", numerator: 1, denominator: 1 };
      }
    });
    using f = n.f;
    const directive = f.prepare("native-allocated-cpu"),
      base = syntheticCapacityAdapter(() => undefined, f.counter);
    const adapter = {
      ...base,
      run: async (context: Parameters<typeof base.run>[0]) => {
        n.counters.usec = 4001n;
        n.counters.ns += 123000000n;
        return base.run(context);
      },
    };
    expect(
      (
        await f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive)
      ).action
    ).toBe("await_user");
    const record = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "settled allocation"
    );
    expect(record.state).toBe("settled");
    expect(record.snapshot?.readings[0]?.meters).toMatchObject({
      cpu_milliseconds: 4,
      cost_microcredits: 123,
    });
    expect(f.counter.submissions).toBe(1);
  });
  it("retains a hold on native counter reset without fabricating a final zero", async () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const directive = f.prepare("native-reset"),
      base = syntheticCapacityAdapter(() => undefined, f.counter);
    const adapter = {
      ...base,
      run: async (context: Parameters<typeof base.run>[0]) => {
        n.counters.usec = 999n;
        return base.run(context);
      },
    };
    await expect(
      f.owner({ adapters: new Map([[adapter.adapter_id, adapter]]) }).dispatch(f.engine, directive)
    ).rejects.toThrow("regression");
    const journal = f.record(directive);
    expect(journal.lifecycle).toBe("terminal");
    expect(f.capacity.inspect(journal.operation_record_id)?.state).toBe("held");
    expect(
      f.capacity.nativeEvent(journal.operation_record_id, "native_meter_final_v1")
    ).toBeUndefined();
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
  });
  it.each([false, true])(
    "charges an actual exported byte counter or refuses the wrong exact fence (drift=%s)",
    async (drift) => {
      const n = nativeCapacityFixture();
      using f = n.f;
      const meter = requireValue(
        n.config.meters.find((m) => m.binding_id === "video-a"),
        "meter"
      );
      const file = path.join(f.root, "transfer-{operation_record_id}.json");
      meter.network = { counter_file: file };
      const resource = requireValue(meter.resources[0], "meter resource");
      resource.sources.push("transfer_bytes");
      resource.tariff = { per: "egress_bytes", numerator: 5, denominator: 2 };
      const source = new NativeCapacityMeter(n.config, f.policy, undefined, {
        cpu: () => ({
          boot_id: n.pin.boot_id,
          process_epoch: n.epoch,
          cgroup_identity: "controlled:1",
          cpu_usage_usec: n.counters.usec.toString(),
          monotonic_ns: n.counters.ns.toString(),
        }),
      });
      f.capacity.close();
      f.project = new HostCapacityProjectAuthority(
        f.config.projectId,
        f.checkpointer,
        f.artifacts,
        source
      );
      f.capacity = new HostOperationCapacityAuthority({
        stateRoot: f.config.stateRoot,
        policy: f.policy,
        projects: [f.project],
      });
      const directive = f.prepare(`transfer-counter-${drift}`),
        base = syntheticCapacityAdapter(() => undefined, f.counter);
      const adapter = {
        ...base,
        run: async (context: Parameters<typeof base.run>[0]) => {
          context.beginSubmission();
          context.recordRemoteAccepted("controlled-transfer");
          const held = requireValue(
            f.capacity.inspect(context.journal.operation_record_id),
            "hold"
          );
          writeFileSync(
            file.replace("{operation_record_id}", context.journal.operation_record_id),
            canonicalJson({
              schema_id: "penny.native-transfer-counter.v1",
              schema_version: 1,
              operation_record_id: context.journal.operation_record_id,
              operation_request_sha256: context.journal.request_sha256,
              capacity_request_sha256: sha256(canonicalJson(held.request)),
              lease: {
                ...held.lease,
                ...(drift ? { fencing_token_sha256: sha256("different fence") } : {}),
              },
              egress_bytes: 123,
            }),
            { mode: 0o600 }
          );
          return base.run(context);
        },
      };
      const run = f
        .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
        .dispatch(f.engine, directive);
      if (drift) {
        await expect(run).rejects.toThrow("exact operation/fence conflict");
        expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("held");
      } else {
        await expect(run).resolves.toMatchObject({ action: "await_user" });
        const cap = requireValue(
          f.capacity.inspect(f.record(directive).operation_record_id),
          "capacity"
        );
        expect(requireValue(cap.snapshot, "actual final").readings[0]?.meters).toMatchObject({
          egress_bytes: 123,
          cost_microcredits: 308,
        });
      }
    }
  );
  it("retains the original baseline across a guarded crash and refuses changed sources", async () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const directive = f.prepare("native-baseline-crash");
    await expect(
      f
        .owner({
          fault: (point) => {
            if (point === "after_remote_checkpoint")
              throw new HostOperationSimulatedCrashError(point);
          },
        })
        .dispatch(f.engine, directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const journal = f.record(directive);
    expect(journal.lifecycle).toBe("submitted");
    const start = baseline(n, journal.operation_record_id);
    expect(start.operation_request_sha256).toBe(journal.request_sha256);
    // Source identity drift is not repaired by recovery, estimates, reservation totals or fake zero.
    const changed = structuredClone(n.config);
    requireValue(changed.meters[0], "meter").private_files = [];
    const other = new NativeCapacityMeter(changed, f.policy, undefined, {
      cpu: () => start.counter,
    });
    other.bind(f.capacity);
    expect(() =>
      other.read({
        journal,
        capacity: requireValue(f.capacity.inspect(journal.operation_record_id), "hold"),
      })
    ).toThrow("identity drift");
  });
  it("blocks over-cap native actuals without reducing reserve, quota or accounting", async () => {
    const n = nativeCapacityFixture();
    using f = n.f;
    const directive = f.prepare("native-over-cap"),
      base = syntheticCapacityAdapter(() => undefined, f.counter);
    const adapter = {
      ...base,
      run: async (context: Parameters<typeof base.run>[0]) => {
        n.counters.usec = 11000001n;
        return base.run(context);
      },
    };
    await expect(
      f.owner({ adapters: new Map([[adapter.adapter_id, adapter]]) }).dispatch(f.engine, directive)
    ).rejects.toThrow(/cap exceeded/u);
    const capacity = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "retained hold"
    );
    expect(capacity.state).toBe("held");
    expect(capacity.snapshot).toBeNull();
    expect(f.policy.resources[0]?.protected_finish.cpu_milliseconds).toBe(100);
  });
  it("refuses synthetic inactive state without a registered actual closure source before baseline", async () => {
    const n = nativeCapacityFixture(true);
    using f = n.f;
    const directive = f.prepare("managed-window");
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow("baseline");
    const journal = f.record(directive);
    expect(
      f.capacity.nativeEvent(journal.operation_record_id, "native_meter_start_v1")
    ).toBeUndefined();
    expect(
      f.capacity.nativeEvent(journal.operation_record_id, "managed_lease_grant_v1")
    ).toBeUndefined();
  });
  it("accepts another properly gated resident Linux process, but unknown PIDs, wrong devices and stale gate states block", async () => {
    const fixture = path.join(
      realpathSync(path.dirname(new URL(import.meta.url).pathname)),
      "fixtures",
      "native-idle-process.mjs"
    );
    const child = fork(fixture, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await once(child, "message");
      const peer = nativeProcessPin(requireValue(child.pid, "child PID"));
      const n = nativeCapacityFixture(true, peer);
      using f = n.f;
      bind(n);
      requireNativeDescendant(peer, n.pin);
      expect(() => requireNativeDescendant(n.pin, peer)).toThrow("ownership drift");
      const registry = new NativeManagedWorkerRegistry(n.config, f.policy, f.capacity);
      const gpu = {
        uuids: ["GPU-1234"],
        applications: [
          { pid: process.pid, uuid: "GPU-1234" },
          { pid: peer.pid, uuid: "GPU-1234" },
        ],
      };
      expect(() => registry.requireInventory(gpu, ["GPU-1234"])).not.toThrow();
      expect(() =>
        registry.requireInventory(
          { ...gpu, applications: [...gpu.applications, { pid: 2147483647, uuid: "GPU-1234" }] },
          ["GPU-1234"]
        )
      ).toThrow("unmanaged GPU");
      expect(() => registry.requireInventory({ ...gpu, uuids: [] }, ["GPU-1234"])).toThrow(
        "GPU absent"
      );
      const pin = requireValue(n.config.workers[1], "peer worker");
      const state = validateSkillSchema(
        ManagedWorkerStateSchema,
        readNativeObservationFile(pin.state_file, 16384),
        "state"
      );
      publishManagedLeaseFile(pin.state_file, { ...state, observed_at_ms: Date.now() - 60001 });
      expect(() => registry.requireInventory(gpu, ["GPU-1234"])).toThrow("stale");
      publishManagedLeaseFile(pin.state_file, {
        ...state,
        state: { kind: "executing", active_calls: 1, grant_sha256: sha256("fabricated grant") },
      });
      expect(() => registry.requireInventory({ ...gpu, applications: [] }, ["GPU-1234"])).toThrow(
        "catalog hold"
      );
    } finally {
      child.send("exit");
      await once(child, "exit");
    }
  });
});
