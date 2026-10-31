import { ManagedComputeRelay } from "./managed-compute-relay.js";
import { ComfyManagedBindingSchema, type ComfyManagedBinding } from "../comfy/managed-binding.js";
import { VoiceManagedRelay } from "../videogen/voice-managed-relay.js";
import {
  VoicePrivateBindingSchema,
  type VoicePrivateBinding,
} from "../videogen/voice-private-client.js";
import { publishManagedLeaseFile } from "./managed-lease-client.js";
import { lstatSync, readdirSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema, assertUnique } from "../skill-contracts/common.js";
import {
  HostOperationCapacityAuthority,
  type HostCapacityMeasurementSourceV1,
} from "./capacity-authority.js";
import {
  capacityJson,
  validateCapacitySnapshot,
  zeroCapacityMeters,
  type HostCapacityPolicyV1,
  type HostCapacityRecordV1,
} from "./capacity-contracts.js";
import {
  NativeCapacityRuntimeSchema,
  NativeMeterStartSchema,
  NativeMeterStopSchema,
  NativeMeterFinalSchema,
  NativeTransferCounterSchema,
  ManagedWorkerStateSchema,
  ManagedLeaseGrantSchema,
  validateNativeTopology,
  type NativeCapacityRuntime,
  type NativeMeterBinding,
  type NativeMeterStart,
  type ManagedWorkerPin,
  type ManagedLeaseGrant,
} from "./native-capacity-contracts.js";
import {
  nativeFileSha256,
  observeNativeProcess,
  requireNativeDescendant,
  parseLinuxProcessStat,
  readNativeText,
  measureNativePrivateFiles,
} from "./native-process.js";
import type { HostOperationCallRecordV1 } from "./contracts.js";
import {
  readNativeObservationFile,
  observeNativeHostGpus,
  type NativeGpuProbe,
} from "./native-host-observation.js";

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function checked(n: bigint): number {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("native meter integer overflow/regression");
  return Number(n);
}
function ceil(n: bigint, d: bigint): number {
  if (n < 0n || d < 1n) throw new Error("native meter counter regression");
  return checked((n + d - 1n) / d);
}
/** No caller-selected allowlist: each resident PID must have a pinned epoch, a live all-entrypoint
 * gate and, when executing, a real catalog grant/hold for these exact physical resources. */
export class NativeManagedWorkerRegistry {
  readonly #config: NativeCapacityRuntime;
  readonly #authority: HostOperationCapacityAuthority;
  constructor(
    config: NativeCapacityRuntime,
    policy: HostCapacityPolicyV1,
    authority: HostOperationCapacityAuthority
  ) {
    if (
      new.target !== NativeManagedWorkerRegistry ||
      !(authority instanceof HostOperationCapacityAuthority)
    )
      throw new Error("native registry concrete authority required");
    this.#config = structuredClone(
      validateSkillSchema(NativeCapacityRuntimeSchema, config, "native capacity runtime")
    );
    validateNativeTopology(config.topology, policy);
    assertUnique(
      config.workers.map((w) => w.worker_id),
      "managed workers"
    );
    assertUnique(
      config.workers.map((w) => w.process.pid.toString()),
      "managed process identities"
    );
    for (const worker of config.topology.workers) {
      const gpu = worker.resource_ids.some((id) =>
        config.topology.resources.some((r) => r.resource_id === id && r.device.kind === "gpu")
      );
      if (gpu && !config.workers.some((w) => w.worker_id === worker.worker_id))
        throw new Error("managed GPU entrypoint gate missing");
    }

    this.#authority = authority;
    Object.freeze(this);
  }
  private state(pin: ManagedWorkerPin) {
    const process = observeNativeProcess(pin.process, nativeFileSha256);
    if (nativeFileSha256(pin.gate_build.path) !== pin.gate_build.sha256)
      throw new Error("managed entrypoint gate build drift");
    const state = validateSkillSchema(
      ManagedWorkerStateSchema,
      readNativeObservationFile(pin.state_file, 16384),
      "managed worker state"
    );
    if (
      state.worker_id !== pin.worker_id ||
      state.process_epoch !== process.process_epoch ||
      state.gate_build_sha256 !== pin.gate_build.sha256 ||
      state.observed_at_ms > Date.now() ||
      state.observed_at_ms + pin.max_age_ms <= Date.now()
    )
      throw new Error("managed worker stale process/gate state");
    return state;
  }
  private current(pin: ManagedWorkerPin): void {
    const state = this.state(pin);
    if (state.state.kind === "executing") {
      const holds = this.#authority
        .nativeReservations()
        .filter((r) => this.#authority.binding(r.request.binding_id).worker_id === pin.worker_id);
      if (holds.length !== 1)
        throw new Error("managed executing worker has no unique current catalog hold");
      const hold = holds[0];
      if (hold === undefined) throw new Error("managed hold absent");
      const grant = validateSkillSchema(
        ManagedLeaseGrantSchema,
        this.#authority.nativeEvent(hold.request.operation_record_id, "managed_lease_grant_v1"),
        "managed current grant"
      );
      if (
        sha256(capacityJson(grant)) !== state.state.grant_sha256 ||
        grant.process_epoch !== state.process_epoch ||
        state.sequence !== grant.gate_sequence + 1
      )
        throw new Error("managed execution grant/state drift");
      this.#authority.requireNativeGrant(grant);
    }
  }
  requireWorker(workerId: string, epoch: string, uuids: readonly string[]): void {
    const pin = this.#config.workers.find((w) => w.worker_id === workerId);
    const worker = this.#config.topology.workers.find((w) => w.worker_id === workerId);
    const devices = this.#config.topology.resources
      .filter((r) => worker?.resource_ids.includes(r.resource_id))
      .flatMap((r) => (r.device.kind === "gpu" ? [r.device.uuid] : []));
    if (
      !pin ||
      this.state(pin).process_epoch !== epoch ||
      !same([...devices].sort(), [...uuids].sort())
    )
      throw new Error("managed observer worker/process/device drift");
  }
  requireInventory(
    gpu: {
      readonly uuids: readonly string[];
      readonly applications: readonly { readonly pid: number; readonly uuid: string }[];
    },
    selected: readonly string[]
  ): void {
    const resources = this.#config.topology.resources;
    for (const uuid of selected)
      if (!gpu.uuids.includes(uuid)) throw new Error("managed physical GPU absent");
    for (const app of gpu.applications.filter((a) => selected.includes(a.uuid))) {
      const matches = this.#config.workers.filter((w) => w.process.pid === app.pid);
      const pin = matches[0];
      if (matches.length !== 1 || pin === undefined)
        throw new Error(
          "unmanaged GPU process present; close/drain or enroll its actual admission gate"
        );
      const worker = this.#config.topology.workers.find((w) => w.worker_id === pin.worker_id);
      if (
        !worker?.resource_ids.some((id) =>
          resources.some(
            (r) => r.resource_id === id && r.device.kind === "gpu" && r.device.uuid === app.uuid
          )
        )
      )
        throw new Error("managed GPU process physical mapping drift");
      this.current(pin);
    }
    // Also inspect registered gates with no resident context: silence alone grants nothing.
    for (const pin of this.#config.workers) {
      const worker = this.#config.topology.workers.find((w) => w.worker_id === pin.worker_id);
      if (
        worker?.resource_ids.some((id) =>
          resources.some(
            (r) =>
              r.resource_id === id && r.device.kind === "gpu" && selected.includes(r.device.uuid)
          )
        )
      )
        this.current(pin);
    }
  }
  issue(
    journal: HostOperationCallRecordV1,
    capacity: HostCapacityRecordV1
  ): ManagedLeaseGrant | undefined {
    const worker_id = this.#authority.binding(capacity.request.binding_id).worker_id;
    const pin = this.#config.workers.find((w) => w.worker_id === worker_id);
    if (!pin) return undefined; // local-only workers are fenced by their native owner/cgroup.
    const state = this.state(pin);
    const prior = this.#authority.nativeEvent(
      journal.operation_record_id,
      "managed_lease_grant_v1"
    );
    if (prior !== undefined) {
      const grant = validateSkillSchema(ManagedLeaseGrantSchema, prior, "managed retained grant");
      this.#authority.requireNativeGrant(grant);
      if (grant.process_epoch !== state.process_epoch)
        throw new Error("managed grant process restarted");
      publishManagedLeaseFile(pin.grant_file, grant);
      return grant;
    }
    if (
      state.state.kind !== "closed" ||
      journal.lease === null ||
      journal.lease_expires_at_ms === null
    )
      throw new Error("managed entrypoint gate must be closed and drained before grant");
    const grant = validateSkillSchema(
      ManagedLeaseGrantSchema,
      {
        schema_id: "penny.managed-lease-grant.v1",
        schema_version: 1,
        operation_record_id: journal.operation_record_id,
        project_id: journal.project_id,
        operation_request_sha256: journal.request_sha256,
        capacity_request_sha256: sha256(capacityJson(capacity.request)),
        directive_sha256: journal.directive_sha256,
        lease: journal.lease,
        worker_id,
        process_epoch: state.process_epoch,
        gate_sequence: state.sequence,
        resource_ids: capacity.request.demands.map((d) => d.resource_id),
        issued_at_ms: Date.now(),
        expires_at_ms: journal.lease_expires_at_ms,
      },
      "managed lease grant"
    );
    this.#authority.recordNativeEvent(journal.operation_record_id, "managed_lease_grant_v1", grant);
    publishManagedLeaseFile(pin.grant_file, grant);
    return grant;
  }
  requireClosed(workerId: string): void {
    const pin = this.#config.workers.find((w) => w.worker_id === workerId);
    if (pin && this.state(pin).state.kind !== "closed")
      throw new Error("managed worker not drained; final measurement blocked");
  }
}
Object.freeze(NativeManagedWorkerRegistry.prototype);
Object.freeze(NativeManagedWorkerRegistry);

/** Real Linux CPU counters in a dedicated leaf cgroup, with bounded membership checks.
 * No cgroup creation, PID move, mount, service, install or quota change is performed. */
export function observeNativeCpu(binding: NativeMeterBinding): NativeMeterStart["counter"] {
  const pin = binding.process,
    process = observeNativeProcess(pin, nativeFileSha256),
    directory = binding.cpu_cgroup.directory;
  if (!path.isAbsolute(directory) || realpathSync(directory) !== directory)
    throw new Error("native CPU cgroup must be canonical");
  const root = lstatSync(directory, { bigint: true });
  if (statfsSync(directory).type !== 0x63677270 || !root.isDirectory())
    throw new Error("native CPU cgroup directory required");
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > 256 || entries.some((e) => e.isDirectory()))
    throw new Error("native CPU requires bounded leaf cgroup");
  const procGroup = readNativeText(`/proc/${pin.pid}/cgroup`, 4096).trim();
  if (procGroup !== `0::${binding.cpu_cgroup.proc_path}`)
    throw new Error("native CPU cgroup membership drift");
  const members = readNativeText(path.join(directory, "cgroup.procs"), 16384)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (members.length < 1 || members.length > 1024 || !members.includes(String(pin.pid)))
    throw new Error("native CPU cgroup membership invalid");
  for (const member of members) {
    if (!/^[1-9][0-9]*$/u.test(member)) throw new Error("native CPU cgroup PID malformed");
    let pid = Number(member);
    const visited = new Set<number>();
    while (pid !== pin.pid) {
      if (visited.has(pid) || visited.size >= 64 || pid <= 1)
        throw new Error("native CPU cgroup contains unrelated work");
      visited.add(pid);
      pid = parseLinuxProcessStat(readNativeText(`/proc/${pid}/stat`, 4096)).parent_pid;
    }
  }
  const rows = readNativeText(path.join(directory, "cpu.stat"), 4096).trim().split(/\n/u);
  const usages = rows.filter((row) => row.startsWith("usage_usec "));
  const value = usages[0]?.slice("usage_usec ".length);
  if (usages.length !== 1 || value === undefined || !/^[0-9]{1,32}$/u.test(value))
    throw new Error("native CPU actual counter unavailable");
  const after = lstatSync(directory, { bigint: true });
  if (after.dev !== root.dev || after.ino !== root.ino)
    throw new Error("native CPU cgroup replaced");
  observeNativeProcess(pin, nativeFileSha256);
  return {
    boot_id: pin.boot_id,
    monotonic_ns: processHrtime(),
    cpu_usage_usec: value,
    cgroup_identity: `${root.dev}:${root.ino}`,
    process_epoch: process.process_epoch,
  };
}
function processHrtime(): string {
  return process.hrtime.bigint().toString();
}
/** Lifecycle collector. 'gpu_milliseconds' means allocated GPU-slot wall milliseconds,
 * NEVER kernel execution time inferred from utilization. CPU is measured worker/cgroup CPU,
 * including descendants/overhead. Exact private file bytes and same-journal artifacts are counted.
 * Missing sources, counter reset, process restart or source drift refuse with the hold retained. */
export class NativeCapacityMeter implements HostCapacityMeasurementSourceV1 {
  readonly #config: NativeCapacityRuntime;
  readonly #policy: HostCapacityPolicyV1;
  #bound: HostOperationCapacityAuthority | undefined;
  readonly #gpu: NativeGpuProbe | undefined;
  readonly #cpu: typeof observeNativeCpu;
  #registry: NativeManagedWorkerRegistry | undefined;
  readonly #preparedClosures = new Map<string, string>();
  readonly #services = new Map<
    string,
    | { kind: "comfy"; binding: ComfyManagedBinding; relay?: ManagedComputeRelay }
    | { kind: "voice"; binding: VoicePrivateBinding; backend: string; relay?: VoiceManagedRelay }
  >();
  registerComfy(value: ComfyManagedBinding): void {
    if (this.#bound) throw new Error("managed registration closed after authority binding");
    const binding = structuredClone(
      validateSkillSchema(ComfyManagedBindingSchema, value, "Comfy managed binding")
    );
    this.requireManagedBinding(
      binding.worker,
      binding.transfer_counter_file,
      binding.worker.worker_id
    );
    const prior = this.#services.get(binding.worker.worker_id);
    if (prior && (prior.kind !== "comfy" || !same(prior.binding, binding)))
      throw new Error("managed source registration conflict");
    if (!prior) this.#services.set(binding.worker.worker_id, { kind: "comfy", binding });
  }
  registerVoice(value: VoicePrivateBinding, backend: string): void {
    if (this.#bound) throw new Error("managed registration closed after authority binding");
    const binding = structuredClone(
      validateSkillSchema(VoicePrivateBindingSchema, value, "Voice managed binding")
    );
    this.requireManagedBinding(
      binding.worker,
      binding.transfer_counter_file,
      binding.worker.worker_id
    );
    if (this.#services.has(binding.worker.worker_id))
      throw new Error("managed source registration conflict");
    this.#services.set(binding.worker.worker_id, { kind: "voice", binding, backend });
  }
  comfyRelay(workerId: string): ManagedComputeRelay {
    const s = this.#services.get(workerId);
    if (!s || s.kind !== "comfy") throw new Error("managed Comfy source missing");
    const b = s.binding;
    return (s.relay ??= new ManagedComputeRelay({
      authority: this.authority(),
      worker_id: workerId,
      backend: b.worker.process,
      backend_uid: b.backend_uid,
      gate_build_sha256: b.worker.gate_build.sha256,
      socket_path: b.socket_path,
      python: b.python,
      helper: b.helper,
      state_file: b.worker.state_file,
      counter_file: b.transfer_counter_file,
      refresh_ms: Math.max(1, Math.min(1000, Math.floor(b.worker.max_age_ms / 3))),
    }));
  }
  voiceRelay(workerId: string): VoiceManagedRelay {
    const s = this.#services.get(workerId);
    if (!s || s.kind !== "voice") throw new Error("managed Voice source missing");
    return (s.relay ??= new VoiceManagedRelay(s.binding, this.authority(), s.backend));
  }
  /** ALL overlapping registered services must actually close before the first GPU probe.
   * Missing bridges refuse; an inactive PID or a health response is never a permit. */
  async prepareExternalSources(
    input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]
  ): Promise<void> {
    if (
      this.authority().nativeEvent(input.journal.operation_record_id, "native_meter_start_v1") !==
      undefined
    )
      return;
    const selected = input.capacity.request.demands.map((d) => d.resource_id);
    for (const pin of this.#config.workers) {
      const w = this.#config.topology.workers.find((w) => w.worker_id === pin.worker_id);
      if (!w?.resource_ids.some((r) => selected.includes(r))) continue;
      const service = this.#services.get(pin.worker_id);
      if (!service) throw new Error("overlapping managed service closure source missing");
      if (service.kind === "comfy") await this.comfyRelay(pin.worker_id).close();
      else {
        const relay = this.voiceRelay(pin.worker_id);
        await relay.acquire();
        await relay.closedState();
      }
      this.registry().requireClosed(pin.worker_id);
    }
    this.#preparedClosures.set(
      input.journal.operation_record_id,
      sha256(capacityJson({ request: input.capacity.request, lease: input.capacity.lease }))
    );
  }
  close(): void {
    for (const s of this.#services.values()) {
      if (s.kind === "comfy") s.relay?.disconnect();
      else s.relay?.close();
    }
  }
  constructor(
    config: NativeCapacityRuntime,
    policy: HostCapacityPolicyV1,
    gpu?: NativeGpuProbe,
    probes?: { readonly cpu: typeof observeNativeCpu }
  ) {
    this.#config = structuredClone(
      validateSkillSchema(NativeCapacityRuntimeSchema, config, "native capacity runtime")
    );
    this.#policy = structuredClone(policy);
    this.#gpu = gpu;
    this.#cpu = probes?.cpu ?? observeNativeCpu;
    validateNativeTopology(config.topology, policy);
    assertUnique(
      config.meters.map((m) => m.binding_id),
      "native meter bindings"
    );
    for (const b of policy.bindings)
      if (!config.meters.some((m) => m.binding_id === b.binding_id))
        throw new Error("native actual meter mapping missing");
    const groups = new Map<string, string>();
    for (const meter of config.meters) {
      const binding = policy.bindings.find((b) => b.binding_id === meter.binding_id);
      if (
        !binding ||
        !same(meter.resources.map((r) => r.resource_id).sort(), [...binding.resource_ids].sort())
      )
        throw new Error("native meter resource mapping drift");
      const pin = config.workers.find((w) => w.worker_id === binding.worker_id);
      if (pin && !same(pin.process, meter.process))
        requireNativeDescendant(pin.process, meter.process);
      for (const source of [
        "worker_cpu",
        "private_bytes",
        "journal_bytes",
        "journal_events",
      ] as const)
        if (meter.resources.filter((r) => r.sources.includes(source)).length !== 1)
          throw new Error("native complete nonduplicated source mapping required");
      const priorWorker = groups.get(meter.cpu_cgroup.directory);
      if (priorWorker !== undefined && priorWorker !== binding.worker_id)
        throw new Error("native CPU cgroup shared by distinct workers");
      groups.set(meter.cpu_cgroup.directory, binding.worker_id);
      for (const r of meter.resources) {
        const physical = config.topology.resources.find((x) => x.resource_id === r.resource_id);
        if (r.tariff.per === "cpu_allocation_milliseconds" && !r.sources.includes("worker_cpu"))
          throw new Error("native CPU allocation tariff requires the actual worker CPU source");
        if (r.sources.includes("gpu_allocation_window") && physical?.device.kind !== "gpu")
          throw new Error("native GPU meter physical mapping absent");
        if (r.sources.includes("transfer_bytes") && meter.network === "none")
          throw new Error("native transfer source mapping invalid");
      }
      if (
        meter.network !== "none" &&
        !meter.resources.some((r) => r.sources.includes("transfer_bytes"))
      )
        throw new Error("native network source has no mapped resource");
      for (const token of meter.private_files)
        if (
          token.split("{operation_record_id}").length !== 2 ||
          token.replaceAll("{operation_record_id}", "").includes("{")
        )
          throw new Error("native private outputs require exact operation-record token");
      if (
        meter.network !== "none" &&
        meter.network.counter_file.split("{operation_record_id}").length !== 2
      )
        throw new Error("native transfer export requires exact operation-record token");
    }
  }
  bind(authority: HostOperationCapacityAuthority): void {
    if (
      !(authority instanceof HostOperationCapacityAuthority) ||
      (this.#bound !== undefined && this.#bound !== authority)
    )
      throw new Error("native meter authority binding drift");
    this.#bound = authority;
  }
  private authority(): HostOperationCapacityAuthority {
    if (!this.#bound) throw new Error("native meter concrete authority not bound");
    return this.#bound;
  }
  managedWorkers(): NativeManagedWorkerRegistry {
    return this.registry();
  }
  requireManagedBinding(pin: ManagedWorkerPin, transfer: string, workerId: string): void {
    const installed = this.#config.workers.find((w) => w.worker_id === workerId);
    const meters = this.#config.meters.filter((m) =>
      this.#policy.bindings.some((b) => b.binding_id === m.binding_id && b.worker_id === workerId)
    );
    if (
      !installed ||
      !same(installed, pin) ||
      !meters.length ||
      meters.some((m) => m.network === "none" || m.network.counter_file !== transfer)
    )
      throw new Error("managed relay/native meter binding drift");
  }
  private binding(capacity: HostCapacityRecordV1) {
    const b = this.#config.meters.find((m) => m.binding_id === capacity.request.binding_id);
    if (!b) throw new Error("native meter binding absent");
    return b;
  }
  private registry(): NativeManagedWorkerRegistry {
    this.#registry ??= new NativeManagedWorkerRegistry(
      this.#config,
      this.#policy,
      this.authority()
    );
    return this.#registry;
  }
  private inventory(capacity: HostCapacityRecordV1): void {
    const uuids = this.#config.topology.resources.flatMap((r) =>
      capacity.request.demands.some((d) => d.resource_id === r.resource_id) &&
      r.device.kind === "gpu"
        ? [r.device.uuid]
        : []
    );
    if (!uuids.length) return;
    if (!this.#gpu) throw new Error("native physical GPU probe missing");
    this.registry().requireInventory(observeNativeHostGpus(this.#gpu), uuids);
  }
  begin(input: Parameters<NonNullable<HostCapacityMeasurementSourceV1["begin"]>>[0]): void {
    const { journal, capacity } = input,
      b = this.binding(capacity),
      a = this.authority();
    const worker = this.#policy.bindings.find((x) => x.binding_id === capacity.request.binding_id);
    const managed = this.#config.workers.find((x) => x.worker_id === worker?.worker_id);
    if (managed && !same(managed.process, b.process))
      requireNativeDescendant(managed.process, b.process);
    if (input.declaration.max_pre_acceptance_retries !== 0)
      throw new Error("native meter requires exact single submission attempt policy");
    if (
      b.network === "none" &&
      input.declaration.capability_classes.includes("registered_loopback_http")
    )
      throw new Error("native network operation lacks actual transfer source");
    if (
      journal.lifecycle !== "lease_acquired" &&
      a.nativeEvent(journal.operation_record_id, "native_meter_start_v1") === undefined
    )
      throw new Error("native missing baseline after submission; cannot reconstruct");
    const prior = a.nativeEvent(journal.operation_record_id, "native_meter_start_v1");
    if (prior === undefined) {
      const selected = capacity.request.demands.map((d) => d.resource_id);
      const overlaps = this.#config.workers.some((pin) =>
        this.#config.topology.workers.some(
          (w) => w.worker_id === pin.worker_id && w.resource_ids.some((r) => selected.includes(r))
        )
      );
      if (
        overlaps &&
        this.#preparedClosures.get(journal.operation_record_id) !==
          sha256(capacityJson({ request: capacity.request, lease: capacity.lease }))
      )
        throw new Error("native actual overlapping service closure missing before baseline");
      for (const pin of this.#config.workers) {
        const worker = this.#config.topology.workers.find((w) => w.worker_id === pin.worker_id);
        if (worker?.resource_ids.some((r) => selected.includes(r)))
          this.registry().requireClosed(pin.worker_id);
      }
    }
    this.inventory(capacity);
    if (prior === undefined) {
      this.registry().requireClosed(a.binding(capacity.request.binding_id).worker_id);
      if (journal.lease === null) throw new Error("native baseline fence absent");
      const start = validateSkillSchema(
        NativeMeterStartSchema,
        {
          schema_version: 1,
          binding_sha256: sha256(capacityJson(b)),
          operation_request_sha256: journal.request_sha256,
          capacity_request_sha256: sha256(capacityJson(capacity.request)),
          lease: journal.lease,
          counter: this.#cpu(b),
          files: measureNativePrivateFiles(
            b.private_files.map((f) =>
              f.replaceAll("{operation_record_id}", journal.operation_record_id)
            )
          ),
        },
        "native meter baseline"
      );
      if (start.files.some((file) => file.bytes !== 0 || file.identity !== null))
        throw new Error("native operation private outputs preexist before baseline");
      a.recordNativeEvent(journal.operation_record_id, "native_meter_start_v1", start);
    } else this.start(input);
  }
  guarded(input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]): void {
    this.start(input);
    this.inventory(input.capacity);
    this.registry().issue(input.journal, input.capacity);
  }
  private start(input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]): NativeMeterStart {
    const { journal, capacity } = input,
      b = this.binding(capacity);
    const start = validateSkillSchema(
      NativeMeterStartSchema,
      this.authority().nativeEvent(journal.operation_record_id, "native_meter_start_v1"),
      "native exact baseline"
    );
    if (
      start.binding_sha256 !== sha256(capacityJson(b)) ||
      start.operation_request_sha256 !== journal.request_sha256 ||
      start.capacity_request_sha256 !== sha256(capacityJson(capacity.request)) ||
      start.lease.backend_key_sha256 !== capacity.backend_key_sha256 ||
      start.lease.lease_epoch > capacity.lease.lease_epoch
    )
      throw new Error("native meter baseline identity drift");
    return start;
  }
  end(input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]): void {
    const { journal, capacity } = input,
      b = this.binding(capacity),
      a = this.authority();
    const start = this.start(input);
    if (a.nativeEvent(journal.operation_record_id, "native_meter_stop_v1") !== undefined) return;
    if (journal.disposition?.lease_disposition !== "released") return;
    this.inventory(capacity);
    this.registry().requireClosed(a.binding(capacity.request.binding_id).worker_id);
    a.recordNativeEvent(journal.operation_record_id, "native_meter_stop_v1", {
      schema_version: 1,
      binding_sha256: sha256(capacityJson(b)),
      start_sha256: sha256(capacityJson(start)),
      operation_request_sha256: journal.request_sha256,
      counter: this.#cpu(b),
      files: measureNativePrivateFiles(
        b.private_files.map((f) =>
          f.replaceAll("{operation_record_id}", journal.operation_record_id)
        )
      ),
      transfer_bytes: this.transfer(input),
    });
  }
  private transfer(input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]): number {
    const { journal, capacity } = input,
      b = this.binding(capacity);
    if (b.network === "none") return 0; // begin() verified a local-only registered declaration.
    const v = validateSkillSchema(
      NativeTransferCounterSchema,
      readNativeObservationFile(
        b.network.counter_file.replaceAll("{operation_record_id}", journal.operation_record_id),
        16384
      ),
      "native actual transfer counter"
    );
    if (
      v.operation_record_id !== journal.operation_record_id ||
      v.operation_request_sha256 !== journal.request_sha256 ||
      v.capacity_request_sha256 !== sha256(capacityJson(capacity.request)) ||
      !same(v.lease, capacity.lease)
    )
      throw new Error("native transfer exact operation/fence conflict");
    return v.egress_bytes;
  }
  read(input: Parameters<HostCapacityMeasurementSourceV1["read"]>[0]): unknown {
    const { journal, capacity } = input,
      b = this.binding(capacity),
      a = this.authority();
    const final = a.nativeEvent(journal.operation_record_id, "native_meter_final_v1");
    const start = this.start(input);
    if (final !== undefined) {
      const retained = validateSkillSchema(NativeMeterFinalSchema, final, "native final receipt");
      if (
        retained.start_sha256 !== sha256(capacityJson(start)) ||
        retained.binding_sha256 !== sha256(capacityJson(b)) ||
        retained.operation_request_sha256 !== journal.request_sha256 ||
        !same(retained.snapshot.lease, capacity.lease)
      )
        throw new Error("native final receipt binding drift");
      return retained.snapshot;
    }
    const isFinal = ["terminal", "settled", "consumed"].includes(journal.lifecycle);
    if (isFinal && journal.disposition?.lease_disposition !== "released")
      throw new Error("native unknown remote work cannot finalize");
    const stop = isFinal
      ? validateSkillSchema(
          NativeMeterStopSchema,
          a.nativeEvent(journal.operation_record_id, "native_meter_stop_v1"),
          "native durable stop required"
        )
      : undefined;
    if (
      stop &&
      (stop.binding_sha256 !== sha256(capacityJson(b)) ||
        stop.start_sha256 !== sha256(capacityJson(start)) ||
        stop.operation_request_sha256 !== journal.request_sha256)
    )
      throw new Error("native stop binding drift");
    if (!stop) this.inventory(capacity);
    const counter = stop?.counter ?? this.#cpu(b);
    if (
      counter.boot_id !== start.counter.boot_id ||
      counter.cgroup_identity !== start.counter.cgroup_identity ||
      counter.process_epoch !== start.counter.process_epoch
    )
      throw new Error("native measurement process/cgroup counter reset");
    const cpu = ceil(BigInt(counter.cpu_usage_usec) - BigInt(start.counter.cpu_usage_usec), 1000n);
    const elapsed = ceil(
      BigInt(counter.monotonic_ns) - BigInt(start.counter.monotonic_ns),
      1000000n
    );
    const files =
      stop?.files ??
      measureNativePrivateFiles(
        b.private_files.map((f) =>
          f.replaceAll("{operation_record_id}", journal.operation_record_id)
        )
      );
    const privateBytes = checked(files.reduce((sum, f) => sum + BigInt(f.bytes), 0n));
    const refs = [
      ...(journal.operation_result_ref ? [journal.operation_result_ref] : []),
      ...journal.output_artifacts,
    ];
    const journalBytes = checked(
      [...new Map(refs.map((r) => [r.artifact_id, r])).values()].reduce(
        (sum, r) => sum + BigInt(r.byte_length),
        0n
      )
    );
    const transfer = stop?.transfer_bytes ?? this.transfer(input);
    const snapshot = validateCapacitySnapshot({
      schema_id: "penny.host-capacity-snapshot.v1",
      schema_version: 1,
      operation_record_id: journal.operation_record_id,
      request_sha256: sha256(capacityJson(capacity.request)),
      lease: capacity.lease,
      source_revision: (capacity.snapshot?.source_revision ?? 0) + 1,
      kind: isFinal ? "final" : "cumulative",
      evidence_sha256: sha256(
        capacityJson({
          start,
          counter,
          files,
          refs: refs.map((r) => ({
            artifact_id: r.artifact_id,
            byte_length: r.byte_length,
            content_digest: r.content_digest,
          })),
          transfer,
          gpu_semantics: "allocated_slot_wall_milliseconds",
          cpu_semantics: "dedicated_leaf_cgroup_usage_usec",
          cpu_allocation_cost_semantics: "allocated_slot_wall_milliseconds",
        })
      ),
      readings: b.resources
        .map((r) => {
          const meters = zeroCapacityMeters();
          if (r.sources.includes("worker_cpu")) meters.cpu_milliseconds = cpu;
          if (r.sources.includes("gpu_allocation_window"))
            meters.gpu_milliseconds = checked(
              BigInt(elapsed) *
                BigInt(
                  capacity.request.demands.find((d) => d.resource_id === r.resource_id)?.slots ?? 0
                )
            );
          if (r.sources.includes("private_bytes")) meters.stored_bytes = privateBytes;
          if (r.sources.includes("journal_bytes"))
            meters.stored_bytes = checked(BigInt(meters.stored_bytes) + BigInt(journalBytes));
          if (r.sources.includes("transfer_bytes")) meters.egress_bytes = transfer;
          if (r.sources.includes("journal_events")) {
            meters.attempts = 1;
            meters.engine_steps = 1;
          }
          const billedUnits =
            r.tariff.per === "cpu_allocation_milliseconds"
              ? checked(
                  BigInt(elapsed) *
                    BigInt(
                      capacity.request.demands.find((d) => d.resource_id === r.resource_id)
                        ?.slots ?? 0
                    )
                )
              : meters[r.tariff.per];
          meters.cost_microcredits = ceil(
            BigInt(billedUnits) * BigInt(r.tariff.numerator),
            BigInt(r.tariff.denominator)
          );
          return { resource_id: r.resource_id, meters };
        })
        .sort((l, r) =>
          l.resource_id < r.resource_id ? -1 : l.resource_id > r.resource_id ? 1 : 0
        ),
    });
    if (isFinal)
      a.recordNativeEvent(journal.operation_record_id, "native_meter_final_v1", {
        schema_version: 1,
        binding_sha256: sha256(capacityJson(b)),
        start_sha256: sha256(capacityJson(start)),
        operation_request_sha256: journal.request_sha256,
        counter,
        snapshot,
      });
    return snapshot;
  }
}
