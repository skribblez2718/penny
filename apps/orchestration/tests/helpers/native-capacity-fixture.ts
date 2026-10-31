import { OrchestrationEngine } from "../../dist/engine.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { hostOperationLeaseProfileSha256 } from "../../dist/host-operations/contracts.js";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import {
  nativeFileSha256,
  observeNativeProcess,
  parseLinuxProcessStat,
  type NativeProcessPin,
} from "../../dist/host-operations/native-process.js";
import { NativeCapacityMeter } from "../../dist/host-operations/native-capacity.js";
import {
  type NativeCapacityRuntime,
  type NativeCapacityTopology,
} from "../../dist/host-operations/native-capacity-contracts.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../../dist/host-operations/capacity-authority.js";
import { capacityPolicy, meters } from "./capacity-fixtures.js";
import { CapacityRuntimeFixture } from "./capacity-runtime-fixtures.js";

export function nativeProcessPin(pid = process.pid): NativeProcessPin {
  const executable = realpathSync(`/proc/${pid}/exe`);
  return {
    pid,
    boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start_ticks: parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")).start_ticks,
    executable: { path: executable, sha256: nativeFileSha256(executable) },
    cwd: realpathSync(`/proc/${pid}/cwd`),
  };
}
/** Real engine/catalog/project stores and real Linux identity; CPU/GPU counter values below
 * are CONTROLLED SYNTHETIC probes. No live resource/production qualification is asserted. */
export function nativeCapacityFixture(
  gpu = false,
  peer?: NativeProcessPin,
  configure?: (config: NativeCapacityRuntime) => void
) {
  const policy = capacityPolicy();
  policy.active_inactivity_ms = 10000;
  policy.queue_wait_ms = 5000;
  if (gpu) {
    policy.bindings = policy.bindings.filter(
      (b) => b.binding_id === "video-a" || (peer !== undefined && b.binding_id === "voice-a")
    );
    policy.resources = policy.resources.filter(
      (r) => r.resource_id === "gpu-a" || r.resource_id === "store-a"
    );
  }
  for (const r of policy.resources) {
    r.limits = meters(1000000);
    r.protected_finish = meters(100);
  }
  const topology: NativeCapacityTopology = {
    schema_version: 1,
    resources: policy.resources.map((r) => ({
      resource_id: r.resource_id,
      device:
        gpu && r.resource_id === "gpu-a"
          ? { kind: "gpu", uuid: "GPU-1234" }
          : { kind: "local", identity: r.resource_id },
    })),
    workers: [
      ...new Map(
        policy.bindings.map((b) => [
          b.worker_id,
          { worker_id: b.worker_id, resource_ids: b.resource_ids },
        ])
      ).values(),
    ],
  };
  policy.topology_sha256 = sha256(canonicalJson(topology));
  const f = new CapacityRuntimeFixture(policy),
    pin = nativeProcessPin();
  for (const d of f.registration.host_operations?.declarations ?? []) {
    const { profile_sha256: _previousDigest, ...body } = d.lease_profile;
    const profile = {
      ...body,
      duration_ms: 10000,
      renew_after_ms: 1000,
      queue_inactivity_ms: 5000,
    };
    d.lease_profile = { ...profile, profile_sha256: hostOperationLeaseProfileSha256(profile) };
  }
  f.engine = new OrchestrationEngine(f.checkpointer, {
    projectRoot: f.config.projectRoot,
    maxSteps: 20,
    receiptAuthority: ReceiptAuthority.loadExisting(f.config.receiptKeyPath),
    artifactRevisions: f.artifacts,
    artifactStore: f.artifacts,
    artifactReader: f.artifacts,
    playbookRegistration: f.registration,
  });
  const epoch = observeNativeProcess(pin, nativeFileSha256).process_epoch;
  const config: NativeCapacityRuntime = {
    topology,
    workers: [],
    meters: policy.bindings.map((b) => ({
      binding_id: b.binding_id,
      process: b.worker_id === "voice-process" && peer ? peer : pin,
      cpu_cgroup: {
        directory: path.join(f.root, `synthetic-cgroup-${b.worker_id}`),
        proc_path: "/synthetic",
      },
      private_files: [path.join(f.root, "private-{operation_record_id}.bin")],
      network: "none",
      resources: b.resource_ids.map((id, index) => ({
        resource_id: id,
        sources:
          index === 0
            ? ["worker_cpu", "journal_events", ...(gpu ? ["gpu_allocation_window" as const] : [])]
            : ["private_bytes", "journal_bytes"],
        tariff: {
          per: index === 0 ? "cpu_milliseconds" : "stored_bytes",
          numerator: 3,
          denominator: 2,
        },
      })),
    })),
  };
  if (gpu) {
    const gate = path.join(f.root, "synthetic-gate"),
      state = path.join(f.root, "gate-state.json"),
      probe = path.join(f.root, "synthetic-gpu-probe");
    writeFileSync(gate, "synthetic all-entrypoint gate, not deployment instrumentation", {
      mode: 0o600,
    });
    config.workers.push({
      worker_id: "worker-a",
      process: pin,
      gate_build: { path: gate, sha256: sha256(readFileSync(gate)) },
      state_file: state,
      grant_file: path.join(f.root, "grant.json"),
      max_age_ms: 60000,
    });
    if (peer) {
      const peerEpoch = observeNativeProcess(peer, nativeFileSha256).process_epoch;
      const peerState = path.join(f.root, "peer-gate-state.json");
      config.workers.push({
        worker_id: "voice-process",
        process: peer,
        gate_build: { path: gate, sha256: sha256(readFileSync(gate)) },
        state_file: peerState,
        grant_file: path.join(f.root, "peer-grant.json"),
        max_age_ms: 60000,
      });
      writeFileSync(
        peerState,
        canonicalJson({
          schema_id: "penny.managed-worker-state.v1",
          schema_version: 1,
          worker_id: "voice-process",
          process_epoch: peerEpoch,
          gate_build_sha256: sha256(readFileSync(gate)),
          sequence: 1,
          observed_at_ms: Date.now(),
          state: { kind: "closed", active_calls: 0, grant_sha256: null },
        }),
        { mode: 0o600 }
      );
    }
    writeFileSync(
      state,
      canonicalJson({
        schema_id: "penny.managed-worker-state.v1",
        schema_version: 1,
        worker_id: "worker-a",
        process_epoch: epoch,
        gate_build_sha256: sha256(readFileSync(gate)),
        sequence: 1,
        observed_at_ms: Date.now(),
        state: { kind: "closed", active_calls: 0, grant_sha256: null },
      }),
      { mode: 0o600 }
    );
    writeFileSync(
      probe,
      `#!/bin/sh\ncase "$1" in\n--query-gpu=uuid) printf 'GPU-1234\\n';;\n--query-compute-apps=pid,gpu_uuid) printf '${process.pid}, GPU-1234\\n${peer ? `${peer.pid}, GPU-1234\\n` : ""}';;\n*) exit 1;;\nesac\n`,
      { mode: 0o700 }
    );
    config.gpu_probe = {
      executable: { path: probe, sha256: sha256(readFileSync(probe)) },
      timeout_ms: 1000,
      max_output_bytes: 4096,
    };
  }
  const counters = { usec: 1000n, ns: 1000000000n, epoch, cgroup: "synthetic:1" };
  configure?.(config);
  const source = new NativeCapacityMeter(config, policy, config.gpu_probe, {
    cpu: () => ({
      boot_id: pin.boot_id,
      process_epoch: counters.epoch,
      cgroup_identity: counters.cgroup,
      cpu_usage_usec: counters.usec.toString(),
      monotonic_ns: counters.ns.toString(),
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
    policy,
    projects: [f.project],
  });
  // The owner constructs/binds source to this concrete authority before actual adapter entry.
  f.demands = {
    requestFor: (context) => ({
      schema_id: "penny.host-capacity-request.v1",
      schema_version: 1,
      project_id: context.project_id,
      operation_record_id: context.operation_record_id,
      binding_id: "video-a",
      demands: ["gpu-a", "store-a"].map((resource_id) => ({
        resource_id,
        slots: 1,
        meters: meters(10000),
      })),
    }),
  };
  return { f, config, counters, source, pin, epoch };
}
