import { AsyncLocalStorage } from "node:async_hooks";
import { Type, type Static } from "typebox";
import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef, validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import type { HostCapacityMeasurementSourceV1 } from "./capacity-authority.js";
import {
  HostCapacityMetersV1Schema,
  validateCapacitySnapshot,
  zeroCapacityMeters,
  type HostCapacityPolicyV1,
  type HostCapacitySnapshotV1,
} from "./capacity-contracts.js";
import {
  HostOperationLeaseIdentityV1Schema,
  type HostOperationAdapterV1,
  type HostOperationExecutionContextV1,
} from "./contracts.js";
const closed = { additionalProperties: false } as const;
const amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const LocalApiMeterBindingSchema = Type.Object(
  {
    assurance: Type.Literal("trusted_local_api"),
    storage_resource_id: OpaqueIdSchema,
    network_resource_id: OpaqueIdSchema,
    resources: Type.Array(
      Type.Object(
        {
          resource_id: OpaqueIdSchema,
          cpu_slots: amount,
          gpu_slots: amount,
        },
        closed
      ),
      { minItems: 1, maxItems: 64 }
    ),
    tariffs: HostCapacityMetersV1Schema,
    max_socket_observations: Type.Integer({ minimum: 1, maximum: 10000 }),
  },
  closed
);
export type LocalApiMeterBinding = Static<typeof LocalApiMeterBindingSchema>;
const WindowSchema = Type.Object(
  {
    operation_record_id: Type.String({ pattern: "^hop_[a-f0-9]{64}$" }),
    request_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    capacity_request_sha256: Sha256Schema,
    binding_sha256: Sha256Schema,
    started_ms: amount,
    ended_ms: Type.Union([amount, Type.Null()]),
    socket_bytes: amount,
    observations: amount,
    guarded: Type.Boolean(),
    pending_sockets: amount,
    cache_payload_bytes: amount,
    cache_sha256: Type.Union([Sha256Schema, Type.Null()]),
    owned_artifacts: Type.Array(ArtifactRefSchema.properties.artifact_id, { maxItems: 512 }),
    owned_file_bytes: amount,
    owned_files_sha256: Type.Union([Sha256Schema, Type.Null()]),
  },
  closed
);
type Window = Static<typeof WindowSchema>;
type Input = Parameters<HostCapacityMeasurementSourceV1["read"]>[0];
function safe(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("local API meter overflow");
  return n;
}
/** Compiled operation collector; no external measurement file, recursive scan, service inspector
 * or CPU attribution guess. Windows and closed-socket counters live in the existing artifact store.
 * In-flight crash traffic is unknowable and must not be recovered as a final reading. */
export class LocalApiOperationMeter implements HostCapacityMeasurementSourceV1 {
  readonly binding: LocalApiMeterBinding;
  private readonly scope = new AsyncLocalStorage<string>();
  private readonly active = new Map<string, Window>();
  constructor(
    readonly store: ArtifactStore,
    readonly policy: HostCapacityPolicyV1,
    value: unknown
  ) {
    this.binding = validateContract(LocalApiMeterBindingSchema, value, "local API meter binding");
    if (
      policy.external_work_policy !== "penny_serialized_api" ||
      !this.binding.resources.some((r) => r.resource_id === this.binding.storage_resource_id) ||
      !this.binding.resources.some((r) => r.resource_id === this.binding.network_resource_id) ||
      new Set(this.binding.resources.map((r) => r.resource_id)).size !==
        this.binding.resources.length ||
      policy.resources.some(
        (r) => !this.binding.resources.some((x) => x.resource_id === r.resource_id)
      )
    )
      throw new Error(
        "local API accounting requires explicit API capacity policy/resource mappings"
      );
    for (const r of this.binding.resources)
      if (
        !policy.resources.some((x) => x.resource_id === r.resource_id) ||
        (r.cpu_slots + r.gpu_slots < 1 &&
          r.resource_id !== this.binding.storage_resource_id &&
          r.resource_id !== this.binding.network_resource_id)
      )
        throw new Error("local API allocation mapping absent");
  }
  private coordinate(id: string) {
    return { run: id, phase: "local-api-meter", kind: "local-api-window", operation: "window" };
  }
  private load(id: string): Window | undefined {
    const c = this.coordinate(id),
      ref = this.store.refFor(
        c.run,
        c.phase,
        null,
        c.kind,
        c.operation,
        this.store.lastVersion(c.run, c.phase, null, c.kind, c.operation)
      );
    if (!ref) return undefined;
    return validateContract(
      WindowSchema,
      JSON.parse(this.store.read(ref).toString()),
      "API meter window"
    );
  }
  private save(w: Window): void {
    validateContract(WindowSchema, w, "API meter window");
    const c = this.coordinate(w.operation_record_id),
      prior = this.store.refFor(
        c.run,
        c.phase,
        null,
        c.kind,
        c.operation,
        this.store.lastVersion(c.run, c.phase, null, c.kind, c.operation)
      );
    this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: c.run,
        phase: c.phase,
        branch_id: null,
        kind: c.kind,
        operation_id: c.operation,
        version: (prior?.version ?? 0) + 1,
        producer: "host:local-api-operation-meter",
        media_type: "application/json",
        parent_ref: prior ?? null,
        upstream_refs: [],
      },
      content: canonicalJson(w),
    });
    this.active.set(w.operation_record_id, w);
  }
  private currentWindow({ journal, capacity }: Input): Window | undefined {
    const w =
      this.active.get(journal.operation_record_id) ?? this.load(journal.operation_record_id);
    if (!w) return undefined;
    if (
      (w.pending_sockets !== 0 && !this.active.has(journal.operation_record_id)) ||
      w.binding_sha256 !== sha256(canonicalJson(this.binding)) ||
      w.request_sha256 !== journal.request_sha256 ||
      w.capacity_request_sha256 !== sha256(canonicalJson(capacity.request)) ||
      canonicalJson(journal.lease) !== canonicalJson(capacity.lease)
    )
      throw new Error("API meter identity or unfinished socket drift");
    if (canonicalJson(w.lease) !== canonicalJson(capacity.lease)) {
      // The concrete capacity owner has already verified and adopted this exact same-operation
      // fence. Preserve original counters and allocation clocks; never create a new baseline.
      if (
        capacity.lease.lease_epoch <= w.lease.lease_epoch ||
        capacity.lease.backend_key_sha256 !== w.lease.backend_key_sha256
      )
        throw new Error("API meter stale fence");
      const next = { ...w, lease: capacity.lease };
      this.save(next);
      return next;
    }
    this.active.set(journal.operation_record_id, w);
    return w;
  }
  begin(input: Input): void {
    const { journal, capacity } = input;
    if (this.currentWindow(input)) return;
    if (
      journal.lifecycle !== "lease_acquired" ||
      capacity.active_started_ms === null ||
      !journal.lease
    )
      throw new Error("API meter baseline missing");
    this.save({
      operation_record_id: journal.operation_record_id,
      request_sha256: journal.request_sha256,
      lease: journal.lease,
      capacity_request_sha256: sha256(canonicalJson(capacity.request)),
      binding_sha256: sha256(canonicalJson(this.binding)),
      started_ms: Date.now(),
      ended_ms: null,
      socket_bytes: 0,
      observations: 0,
      guarded: false,
      pending_sockets: 0,
      cache_payload_bytes: 0,
      cache_sha256: null,
      owned_artifacts: [],
      owned_file_bytes: 0,
      owned_files_sha256: null,
    });
  }
  guarded({ journal }: Input): void {
    const w = this.active.get(journal.operation_record_id);
    if (!w || w.ended_ms !== null) throw new Error("API meter baseline missing");
    this.save({ ...w, guarded: true });
  }
  cached({
    journal,
    byte_length,
    content_sha256,
  }: Parameters<NonNullable<HostCapacityMeasurementSourceV1["cached"]>>[0]): void {
    const w =
      this.active.get(journal.operation_record_id) ?? this.load(journal.operation_record_id);
    if (
      !w ||
      w.ended_ms !== null ||
      (w.cache_sha256 !== null &&
        (w.cache_sha256 !== content_sha256 || w.cache_payload_bytes !== byte_length))
    )
      throw new Error("API original cached bytes conflict");
    this.save({ ...w, cache_payload_bytes: safe(byte_length), cache_sha256: content_sha256 });
  }
  recordOwnedFiles(
    files: readonly {
      readonly relative_path: string;
      readonly sha256: string;
      readonly bytes: number;
    }[]
  ): void {
    const id = this.scope.getStore(),
      w = id === undefined ? undefined : this.active.get(id);
    if (!w || w.ended_ms !== null || files.length > 65536)
      throw new Error("owned file observation outside API window/limit");
    const digest = sha256(canonicalJson(files));
    if (w.owned_files_sha256 !== null && w.owned_files_sha256 !== digest)
      throw new Error("owned operation files changed");
    this.save({
      ...w,
      owned_files_sha256: digest,
      owned_file_bytes: files.reduce((n, f) => safe(n + safe(f.bytes)), 0),
    });
  }
  recordArtifact(ref: ArtifactRef): void {
    const id = this.scope.getStore(),
      w = id === undefined ? undefined : this.active.get(id);
    if (!w || w.ended_ms !== null) throw new Error("artifact outside API operation window");
    this.store.read(ref);
    if (!w.owned_artifacts.includes(ref.artifact_id))
      this.save({ ...w, owned_artifacts: [...w.owned_artifacts, ref.artifact_id] });
  }
  beginSocket(): (written: number, read: number) => void {
    const id = this.scope.getStore(),
      w = id === undefined ? undefined : this.active.get(id);
    if (!w || w.ended_ms !== null) throw new Error("API socket outside operation");
    this.save({ ...w, pending_sockets: w.pending_sockets + 1 });
    let closed = false;
    return (written, read) => {
      if (closed) throw new Error("API socket counted twice");
      closed = true;
      this.countSocketBytes(safe(written + read));
      const current = this.active.get(w.operation_record_id);
      if (!current) throw new Error("API socket window absent");
      this.save({ ...current, pending_sockets: current.pending_sockets - 1 });
    };
  }
  readonly countSocketBytes = (bytes: number): void => {
    const id = this.scope.getStore(),
      w = id === undefined ? undefined : this.active.get(id);
    if (!w || w.ended_ms !== null) throw new Error("socket traffic outside owned API operation");
    if (w.observations >= this.binding.max_socket_observations)
      throw new Error("API socket observation limit");
    this.save({
      ...w,
      socket_bytes: safe(w.socket_bytes + safe(bytes)),
      observations: w.observations + 1,
    });
  };
  wrap(adapter: HostOperationAdapterV1): HostOperationAdapterV1 {
    const scoped = <T>(ctx: HostOperationExecutionContextV1, fn: () => T): T =>
      this.scope.run(ctx.journal.operation_record_id, fn);
    return {
      adapter_id: adapter.adapter_id,
      inspectRequest: (i) => adapter.inspectRequest(i),
      ...(adapter.prepare
        ? {
            prepare: async (ctx: HostOperationExecutionContextV1) => {
              await scoped(ctx, () => adapter.prepare?.(ctx));
            },
          }
        : {}),
      run: (ctx) => scoped(ctx, () => adapter.run(ctx)),
      ...(adapter.close ? { close: () => adapter.close?.() } : {}),
    };
  }
  end(input: Input): void {
    const w = this.currentWindow(input);
    if (!w || w.pending_sockets !== 0)
      throw new Error("API meter final baseline/socket closure absent");
    if (w.ended_ms === null) this.save({ ...w, ended_ms: Date.now() });
  }
  read({ journal, capacity }: Input): HostCapacitySnapshotV1 {
    // Exact durable final is authoritative on warm/reopen/consumed paths. Never resample.
    if (capacity.snapshot?.kind === "final") return capacity.snapshot;
    const w = this.currentWindow({ journal, capacity });
    if (!w) throw new Error("API meter original window absent");
    const final = journal.disposition?.lease_disposition === "released";
    if (final && w.ended_ms === null) throw new Error("API meter unclosed window");
    const end = w.ended_ms ?? Date.now(),
      elapsed = safe(end - w.started_ms);
    // Only directly owned bytes: exact cached result and exact persisted raw/output payloads.
    const artifacts = [
      ...new Set([
        ...w.owned_artifacts,
        ...(journal.operation_result_ref ? [journal.operation_result_ref.artifact_id] : []),
        ...journal.output_artifacts.map((ref) => ref.artifact_id),
      ]),
    ];
    const stored = safe(
      w.owned_file_bytes +
        w.cache_payload_bytes +
        artifacts.reduce((n, id) => safe(n + this.store.readById(id).byteLength), 0)
    );
    if (
      (stored > 0 &&
        !capacity.request.demands.some(
          (d) => d.resource_id === this.binding.storage_resource_id
        )) ||
      (w.socket_bytes > 0 &&
        !capacity.request.demands.some((d) => d.resource_id === this.binding.network_resource_id))
    )
      throw new Error("API measured storage/network resource was not held");
    const readings = capacity.request.demands
      .map((d) => {
        const r = this.binding.resources.find((x) => x.resource_id === d.resource_id);
        if (!r) throw new Error("API meter resource absent");
        const m = {
          ...zeroCapacityMeters(),
          gpu_milliseconds: safe(elapsed * d.slots * r.gpu_slots),
          cpu_milliseconds: safe(elapsed * d.slots * r.cpu_slots),
          stored_bytes: d.resource_id === this.binding.storage_resource_id ? stored : 0,
          egress_bytes: d.resource_id === this.binding.network_resource_id ? w.socket_bytes : 0,
          attempts: w.guarded ? 1 : 0,
        };
        for (const name of Object.keys(m)) {
          if (!(name in this.binding.tariffs)) throw new Error("API tariff absent");
        }
        m.cost_microcredits = safe(
          m.gpu_milliseconds * this.binding.tariffs.gpu_milliseconds +
            m.cpu_milliseconds * this.binding.tariffs.cpu_milliseconds +
            m.stored_bytes * this.binding.tariffs.stored_bytes +
            m.egress_bytes * this.binding.tariffs.egress_bytes +
            m.attempts * this.binding.tariffs.attempts
        );
        return { resource_id: d.resource_id, meters: m };
      })
      .sort((a, b) => a.resource_id.localeCompare(b.resource_id));
    const accounting = {
      assurance: "trusted_local_api",
      cpu: "wall_clock_allocated_slot_ms_not_cpu_usage",
      gpu: "wall_clock_allocated_slot_ms_not_kernel_usage",
      network: "bidirectional_socket_bytes_including_tls_not_internet_egress",
      storage: "owned_payload_bytes_excludes_meter_control_metadata_and_transient_scratch",
      external_work_exclusion: "unknown",
      engine_steps: "unknown_not_charged",
      cost: "configured_internal_tariff_units_not_currency",
      started_ms: w.started_ms,
      ended_ms: end,
      socket_bytes: w.socket_bytes,
      tariffs: this.binding.tariffs,
    };
    return validateCapacitySnapshot({
      schema_id: "penny.host-capacity-snapshot.v1",
      schema_version: 1,
      operation_record_id: journal.operation_record_id,
      request_sha256: sha256(canonicalJson(capacity.request)),
      lease: capacity.lease,
      source_revision: (capacity.snapshot?.source_revision ?? 0) + 1,
      evidence_sha256: sha256(canonicalJson({ w, accounting, readings })),
      kind: final ? "final" : "cumulative",
      readings,
      accounting,
    });
  }
}
