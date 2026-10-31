import {
  capacityPolicyVersions,
  CapacityPolicyVersionsSchema,
} from "./capacity-policy-versions.js";
import { validateContract } from "../contracts.js";
import {
  NativeCapacityEventSchemas,
  type NativeCapacityEventKind,
} from "./native-capacity-contracts.js";
import { ArtifactStore } from "../artifact-store.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { HostOperationLeaseAuthority } from "./lease-authority.js";
import {
  capacityCore,
  capacityParkingJournalBinding,
  validateCapacityStoredRecord,
  validateCapacityProductiveObservation,
  type HostCapacityStoredRecord,
  type HostCapacityRuntimeRecordV2,
} from "./capacity-runtime-contracts.js";
import type { HostCapacityParkingProofV1 } from "./capacity-runtime-contracts.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ProjectCatalog } from "../state/catalog.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME, pennyStatePaths } from "../state/paths.js";
import {
  validateHostOperationDispositionReceipt,
  type HostOperationDeclarationV1,
  type HostOperationCallRecordV1,
  type HostOperationDispositionReceiptV1,
  type HostOperationLeaseIdentityV1,
} from "./contracts.js";
import { HostOperationArtifactCustody } from "./storage.js";
import {
  CAPACITY_METERS,
  capacityJson,
  hostCapacityWorkerKey,
  validateCapacityPolicy,
  validateCapacityRecord,
  validateCapacityRequest,
  validateCapacitySnapshot,
  zeroCapacityMeters,
  type HostCapacityBindingV1,
  type HostCapacityPolicyV1,
  type HostCapacityRecordV1,
  type HostCapacityRequestV1,
  type HostCapacitySnapshotV1,
} from "./capacity-contracts.js";

/** Trusted construction-time metering port, never a request field or remote-stop proof.
 * Implementations must read durable measured cumulative units, not estimates or polling counters.
 * Missing production metering deliberately prevents settlement; fixture sources are not qualifiers. */
export interface HostCapacityMeasurementSourceV1 {
  bind?(authority: HostOperationCapacityAuthority): void;
  /** Owner-verified actual exact cache bytes, never a configured measurement claim. */
  cached?(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly byte_length: number;
    readonly content_sha256: string;
  }): void;
  close?(): void;
  prepareExternalSources?(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
  }): Promise<void>;
  /** Called only by the canonical owner after an actual hold and again at submission guard.
   * Native baselines must be durable before effects; recovery cannot reconstruct one. */
  begin?(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
    readonly declaration: HostOperationDeclarationV1;
  }): void;
  guarded?(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
  }): void;
  /** Close the actual observation window BEFORE the backend can be released/reused. */
  end?(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
  }): void;
  read(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
  }): unknown;
}

/** Trusted synchronous host collector. It selects an exact durable immutable artifact, never
 * adapter-supplied payload. Limits/identity are pinned at reservation, independently of meters. */
export interface HostCapacityProductiveSourceV1 {
  readonly source_id: string;
  readonly producer: string;
  readonly max_observations: number;
  readonly max_units: number;
  read(input: {
    readonly journal: HostOperationCallRecordV1;
    readonly capacity: HostCapacityRecordV1;
  }): unknown;
}

/** Exact project-journal custody. Structural readers and supplied journal JSON are not accepted. */
export class HostCapacityProjectAuthority {
  private readonly custody: HostOperationArtifactCustody;
  constructor(
    readonly projectId: string,
    private readonly checkpointer: Checkpointer,
    private readonly artifacts: ArtifactStore,
    readonly measurements: HostCapacityMeasurementSourceV1,
    readonly productive?: HostCapacityProductiveSourceV1
  ) {
    if (!(checkpointer instanceof Checkpointer) || !(artifacts instanceof ArtifactStore))
      throw new Error("capacity requires concrete project owners");
    artifacts.assertBoundProject(projectId);
    this.custody = HostOperationArtifactCustody.fromArtifactStore(artifacts);
    if (
      productive !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(productive.source_id) ||
        !/^host:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(productive.producer) ||
        !Number.isSafeInteger(productive.max_observations) ||
        productive.max_observations < 1 ||
        productive.max_observations > 65_536 ||
        !Number.isSafeInteger(productive.max_units) ||
        productive.max_units < 1)
    )
      throw new Error("capacity productive source binding invalid");
  }
  read(operationRecordId: string): HostOperationCallRecordV1 {
    const record = this.checkpointer.hostOperationCall(operationRecordId);
    if (record === undefined || record.project_id !== this.projectId)
      throw new Error("capacity exact project journal absent");
    return this.custody.verifyForProject(this.projectId, record);
  }
  productiveBinding(): string | null {
    const source = this.productive;
    return source === undefined
      ? null
      : sha256(
          capacityJson({
            source_id: source.source_id,
            producer: source.producer,
            max_observations: source.max_observations,
            max_units: source.max_units,
          })
        );
  }
  verifyProductive(ref: ArtifactRef): HostCapacityRuntimeRecordV2["productive"] {
    const source = this.productive;
    if (source === undefined) throw new Error("capacity productive source absent");
    const stored = this.artifacts.refById(ref.artifact_id);
    if (
      !same(stored, ref) ||
      ref.producer !== source.producer ||
      ref.kind !== "host-capacity-progress" ||
      ref.phase !== "host-capacity-progress" ||
      ref.branch_id !== null ||
      ref.media_type !== "application/json" ||
      ref.content_schema?.schema_id !== "penny.host-capacity-productive-observation.v1" ||
      ref.content_schema.schema_version !== 1 ||
      ref.byte_length > 16_384
    )
      throw new Error("capacity productive artifact custody conflict");
    const bytes = this.artifacts.readById(ref.artifact_id);
    if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest)
      throw new Error("capacity productive artifact bytes conflict");
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const observation = validateCapacityProductiveObservation(raw);
    if (
      capacityJson(observation) !== bytes.toString("utf8") ||
      observation.project_id !== this.projectId ||
      observation.source_id !== source.source_id ||
      ref.version !== observation.productive_revision ||
      ref.operation_id !==
        `capacity-productive:${observation.operation_record_id}:${source.source_id}`
    )
      throw new Error("capacity productive artifact binding conflict");
    return { ref, observation };
  }
  requestBytes(operationRecordId: string): Buffer {
    const journal = this.read(operationRecordId);
    return this.artifacts.readById(journal.request_ref.artifact_id);
  }
}
export interface HostCapacityClockStatusV1 {
  readonly queue_expired: boolean;
  readonly active_inactivity_expired: boolean;
  readonly explicit_elapsed_expired: boolean;
  readonly cleanup_expired: boolean;
  readonly effect_permission: "none";
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function rowText(value: unknown, key: string): string {
  if (value === null || typeof value !== "object" || !(key in value))
    throw new Error("capacity catalog row absent");
  const item: unknown = Reflect.get(value, key);
  if (typeof item !== "string") throw new Error("capacity catalog row malformed");
  return item;
}
function rowInteger(value: unknown, key: string): number {
  if (value === null || typeof value !== "object" || !(key in value))
    throw new Error("capacity catalog row absent");
  const item: unknown = Reflect.get(value, key);
  if (typeof item !== "number" || !Number.isSafeInteger(item))
    throw new Error("capacity catalog integer malformed");
  return item;
}
function checkedAdd(left: number, right: number): number {
  const result = BigInt(left) + BigInt(right);
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("capacity arithmetic overflow");
  return Number(result);
}
function checkedClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)
    throw new Error("capacity clock invalid");
  return value;
}
function decodeJson(row: unknown, textKey: string, hashKey: string): unknown {
  const text = rowText(row, textKey);
  if (Buffer.byteLength(text, "utf8") > 131_072 || sha256(text) !== rowText(row, hashKey))
    throw new Error("capacity catalog digest diverges");
  const value: unknown = JSON.parse(text);
  if (capacityJson(value) !== text) throw new Error("capacity catalog JSON not canonical");
  return value;
}
const MILESTONES = ["none", "fetched", "persisted", "verified"] as const;

/** Opt-in, global atomic holds/accounting. This object cannot dispatch or grant execution. */
export class HostOperationCapacityAuthority implements Disposable {
  private readonly store: OwnerSqliteDatabase;
  private readonly policy: HostCapacityPolicyV1;
  private readonly policySha256: string;
  private readonly projects: ReadonlyMap<string, HostCapacityProjectAuthority>;
  private readonly now: () => number;

  /** Explicit host policy installation; immutable once installed, and never runtime DDL. */
  static configure(stateRoot: string, value: unknown): void {
    const policy = validateCapacityPolicy(value);
    using _catalog = new ProjectCatalog(stateRoot, { create: false });
    using store = new OwnerSqliteDatabase({
      directory: pennyStatePaths(stateRoot).root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "host capacity configuration",
      mode: "existing",
    });
    store.transaction(() => {
      if (store.db.prepare("PRAGMA user_version").get()?.user_version !== 4)
        throw new Error("capacity requires exact catalog schema 4");
      const text = capacityJson(policy);
      const existing = store.db
        .prepare("SELECT policy_jcs, policy_sha256 FROM host_capacity_policy WHERE singleton = 1")
        .get();
      if (existing !== undefined) {
        if (
          capacityJson(
            capacityPolicyVersions(decodeJson(existing, "policy_jcs", "policy_sha256")).active
          ) !== text
        )
          throw new Error("capacity policy immutable conflict");
        return;
      }
      store.db.prepare("INSERT INTO host_capacity_policy VALUES (1, ?, ?)").run(text, sha256(text));
    });
  }
  /** Explicit, empty-catalog-only version selection. Preserves original immutable policies,
   * capacities/reserves and all unselected bindings. No DDL, second owner, reset or hold bypass. */
  static installUnreservedVersion(
    stateRoot: string,
    value: unknown,
    expectedSha256: string,
    bindingIds: readonly string[]
  ): void {
    const policy = validateCapacityPolicy(value);
    using _catalog = new ProjectCatalog(stateRoot, { create: false });
    using store = new OwnerSqliteDatabase({
      directory: pennyStatePaths(stateRoot).root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "explicit capacity policy version",
      mode: "existing",
    });
    store.transaction(() => {
      if (store.db.prepare("PRAGMA user_version").get()?.user_version !== 4)
        throw new Error("capacity exact catalog version required");
      const row = store.db
        .prepare("SELECT policy_jcs, policy_sha256 FROM host_capacity_policy WHERE singleton = 1")
        .get();
      if (!row) throw new Error("existing immutable capacity policy required");
      const versions = capacityPolicyVersions(decodeJson(row, "policy_jcs", "policy_sha256")),
        old = versions.active;
      if (
        sha256(capacityJson(old)) !== expectedSha256 ||
        versions.policies.some((p) => p.policy_id === policy.policy_id)
      )
        throw new Error("capacity policy version compare-and-set conflict");
      if (
        store.db.prepare("SELECT 1 FROM host_capacity_records LIMIT 1").get() ||
        store.db.prepare("SELECT 1 FROM host_capacity_snapshots LIMIT 1").get() ||
        store.db.prepare("SELECT 1 FROM host_operation_queue LIMIT 1").get() ||
        store.db.prepare("SELECT 1 FROM host_backend_leases WHERE state != 'free' LIMIT 1").get()
      )
        throw new Error(
          "capacity version requires no records, queues, active leases or quarantine"
        );
      const {
        policy_id: _oi,
        topology_sha256: _ot,
        external_work_policy: _oe,
        bindings: ob,
        ...oldLimits
      } = old;
      const {
        policy_id: _ni,
        topology_sha256: _nt,
        external_work_policy: _ne,
        bindings: nb,
        ...newLimits
      } = policy;
      if (
        !same(oldLimits, newLimits) ||
        bindingIds.length === 0 ||
        new Set(bindingIds).size !== bindingIds.length ||
        ob.length !== nb.length ||
        bindingIds.some((id) => !ob.some((b) => b.binding_id === id)) ||
        ob.some((b) => {
          const n = nb.find((x) => x.binding_id === b.binding_id);
          return (
            !n ||
            (!bindingIds.includes(b.binding_id)
              ? !same(b, n)
              : b.operation_kind !== n.operation_kind ||
                b.purpose !== n.purpose ||
                !same(b.resource_ids, n.resource_ids))
          );
        })
      )
        throw new Error(
          "capacity version must preserve quotas/reserves and unselected binding scopes"
        );
      const envelope = validateContract(
        CapacityPolicyVersionsSchema,
        {
          schema_id: "penny.host-capacity-policy-versions.v2",
          schema_version: 2,
          active_sha256: sha256(capacityJson(policy)),
          policies: [...versions.policies, policy],
        },
        "capacity policy version"
      );
      const text = capacityJson(envelope);
      store.db
        .prepare(
          "UPDATE host_capacity_policy SET policy_jcs = ?, policy_sha256 = ? WHERE singleton = 1 AND policy_sha256 = ?"
        )
        .run(text, sha256(text), rowText(row, "policy_sha256"));
    });
  }
  constructor(input: {
    readonly stateRoot: string;
    readonly policy: unknown;
    readonly projects: readonly HostCapacityProjectAuthority[];
    readonly now?: () => number;
  }) {
    this.policy = validateCapacityPolicy(input.policy);
    this.policySha256 = sha256(capacityJson(this.policy));
    this.now = input.now ?? Date.now;
    const projects = new Map<string, HostCapacityProjectAuthority>();
    for (const project of input.projects) {
      if (!(project instanceof HostCapacityProjectAuthority) || projects.has(project.projectId))
        throw new Error("capacity project authority duplicate or missing");
      projects.set(project.projectId, project);
    }
    if (projects.size === 0) throw new Error("capacity project authority missing");
    this.projects = projects;
    using _catalog = new ProjectCatalog(input.stateRoot, { create: false });
    this.store = new OwnerSqliteDatabase({
      directory: pennyStatePaths(input.stateRoot).root,
      databaseName: CATALOG_DATABASE_NAME,
      label: "host capacity authority",
      mode: "existing",
    });
    try {
      this.assertPolicy();
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  binding(bindingId: string): HostCapacityBindingV1 {
    const found = this.policy.bindings.find((x) => x.binding_id === bindingId);
    if (found === undefined) throw new Error("capacity binding absent");
    return structuredClone(found);
  }
  /** Current immutable selection, including terminal/replay paths; never grants execution. */
  validateSelection(value: unknown): HostCapacityRequestV1 {
    const request = validateCapacityRequest(value);
    const journal = this.project(request.project_id).read(request.operation_record_id);
    this.assertPolicy();
    this.assertBinding(request, journal);
    const prior = this.read(request.operation_record_id);
    if (
      prior !== undefined &&
      (!same(prior.request, request) ||
        prior.directive_sha256 !== journal.directive_sha256 ||
        prior.operation_request_sha256 !== journal.request_sha256 ||
        prior.backend_key_sha256 !== journal.policy_binding.backend_key_sha256)
    )
      throw new Error("capacity current immutable selection conflict");
    return structuredClone(request);
  }
  /** Read-only deadlines from the installed policy and exact reservation. */
  deadlines(operationRecordId: string): {
    readonly active_inactivity_at_ms: number | null;
    readonly elapsed_at_ms: number | null;
    readonly cleanup_at_ms: number | null;
    readonly cleanup_grace_ms: number;
  } {
    this.clockStatus(operationRecordId);
    const record = this.required(operationRecordId);
    return {
      active_inactivity_at_ms:
        record.last_milestone_ms === null
          ? null
          : checkedAdd(record.last_milestone_ms, this.policy.active_inactivity_ms),
      elapsed_at_ms:
        record.active_started_ms === null || this.policy.max_elapsed_ms === undefined
          ? null
          : checkedAdd(record.active_started_ms, this.policy.max_elapsed_ms),
      cleanup_at_ms:
        record.cleanup_started_ms === null
          ? null
          : checkedAdd(record.cleanup_started_ms, this.policy.cleanup_grace_ms),
      cleanup_grace_ms: this.policy.cleanup_grace_ms,
    };
  }
  /** Retire only never-admitted work against its exact durable non-submission disposition.
   * Uses the existing expired representation; cannot release a hold or alter measured spend. */
  retireQueued(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record, journal) => {
      const receipt = this.disposition(record);
      if (
        (record.state !== "queued" && record.state !== "expired") ||
        record.active_started_ms !== null ||
        record.snapshot !== null ||
        !["terminal", "settled", "consumed"].includes(journal.lifecycle) ||
        journal.remote_correlation_id !== null ||
        journal.fetched !== null ||
        journal.persistence_plan !== null ||
        receipt === undefined ||
        receipt.disposition.lease_disposition !== "released" ||
        !["none", "proven_not_accepted"].includes(receipt.disposition.remote_disposition) ||
        !same(receipt.disposition, journal.disposition) ||
        receipt.remote_correlation_sha256 !== null
      )
        throw new Error("capacity queued retirement requires exact never-submitted release");
      return { ...record, state: "expired" };
    });
  }
  reserve(value: unknown): HostCapacityRecordV1 {
    return this.reserveRecord(value, false);
  }
  /** New opt-in runtime records only. Existing V1 bytes are never upgraded or reinterpreted. */
  reserveRuntime(value: unknown): HostCapacityRecordV1 {
    return this.reserveRecord(value, true);
  }
  private reserveRecord(value: unknown, runtime: boolean): HostCapacityRecordV1 {
    const request = validateCapacityRequest(value);
    const journal = this.project(request.project_id).read(request.operation_record_id);
    const binding = this.assertBinding(request, journal);
    return this.store.transaction(() => {
      this.assertPolicy();
      const now = checkedClock(this.now());
      const existing = this.read(request.operation_record_id);
      if (existing !== undefined) {
        if (
          !same(existing.request, request) ||
          existing.directive_sha256 !== journal.directive_sha256 ||
          !same(existing.lease, journal.lease)
        )
          throw new Error("capacity reservation replay conflict");
        if (existing.state === "held" || existing.state === "queued") {
          if (this.disposition(existing) === undefined)
            this.assertActive(journal, existing.lease, now, false);
        }
        return existing;
      }
      if (journal.lifecycle !== "lease_acquired" || journal.lease === null)
        throw new Error("capacity reserve requires fenced pre-submission journal");
      this.assertActive(journal, journal.lease, now, true);
      const all = this.records();
      const perProject = all.filter((x) => x.request.project_id === request.project_id);
      if (
        all.length >= this.policy.max_admissions ||
        perProject.length >= this.policy.max_admissions_per_project
      )
        throw new Error("capacity admission limit");
      const queued = all.filter((x) => x.state === "queued" && x.queue_expires_ms > now);
      const canHold = !this.earlierOverlapping(queued, request) && this.fits(all, request, binding);
      if (
        !canHold &&
        (queued.length >= this.policy.max_queued ||
          queued.filter((x) => x.request.project_id === request.project_id).length >=
            this.policy.max_queued_per_project)
      )
        throw new Error("capacity queue limit");
      const record = validateCapacityRecord({
        schema_id: "penny.host-capacity-record.v1",
        schema_version: 1,
        request,
        policy_sha256: this.policySha256,
        directive_sha256: journal.directive_sha256,
        operation_request_sha256: journal.request_sha256,
        backend_key_sha256: journal.policy_binding.backend_key_sha256,
        lease: journal.lease,
        revision: 1,
        state: canHold ? "held" : "queued",
        created_ms: now,
        last_checked_ms: now,
        queue_expires_ms: checkedClock(checkedAdd(now, this.policy.queue_wait_ms)),
        active_started_ms: canHold ? now : null,
        last_milestone_ms: canHold ? now : null,
        milestone: "none",
        cleanup_started_ms: null,
        snapshot: null,
        disposition_receipt_id: null,
        effect_permission: "none",
      });
      const stored: HostCapacityStoredRecord = runtime
        ? {
            schema_id: "penny.host-capacity-runtime-record.v2",
            schema_version: 2,
            core: record,
            parked: false,
            parking: null,
            productive_binding_sha256: this.project(request.project_id).productiveBinding(),
            productive_count: 0,
            productive: null,
          }
        : record;
      validateCapacityStoredRecord(stored);
      this.store.db
        .prepare("INSERT INTO host_capacity_records VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          request.operation_record_id,
          request.project_id,
          record.revision,
          record.state,
          capacityJson(stored),
          sha256(capacityJson(stored))
        );
      return record;
    });
  }
  private assertNoDisposition(id: string): void {
    if (
      this.store.db
        .prepare("SELECT 1 FROM host_backend_dispositions WHERE operation_record_id = ? LIMIT 1")
        .get(id) !== undefined
    )
      throw new Error("capacity parking cannot adopt terminal disposition");
  }
  /** Queue demand/order/deadlines survive; the backend fence and proof commit together. */
  park(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(
      operationRecordId,
      expectedRevision,
      (record) => record,
      false,
      (stored, journal, now) => {
        const core = stored.core;
        const binding = capacityParkingJournalBinding(journal);
        this.assertNoDisposition(operationRecordId);
        if (
          core.state !== "queued" ||
          core.active_started_ms !== null ||
          core.snapshot !== null ||
          core.cleanup_started_ms !== null
        )
          throw new Error("capacity parking requires never-admitted queued demand");
        if (stored.parked) {
          if (stored.parking?.journal_binding_sha256 !== binding)
            throw new Error("capacity parked journal conflict");
          return stored;
        }
        this.assertActive(journal, core.lease, now, true);
        const proof = {
          schema_id: "penny.host-capacity-parking-proof.v1" as const,
          schema_version: 1 as const,
          operation_record_id: operationRecordId,
          project_id: journal.project_id,
          directive_sha256: journal.directive_sha256,
          operation_request_sha256: journal.request_sha256,
          capacity_request_sha256: sha256(capacityJson(core.request)),
          journal_binding_sha256: binding,
          lease: core.lease,
          capacity_revision: core.revision,
          parked_at_ms: now,
          queue_expires_ms: core.queue_expires_ms,
          backend_queue_expires_ms: journal.queue_inactivity_expires_at_ms,
        };
        HostOperationLeaseAuthority.parkPreSubmissionInTransaction(this.store, journal, proof);
        return { ...stored, parked: true, parking: proof };
      }
    );
  }
  /** Readiness is only a hint. It never reserves, changes clocks, or joins backend FIFO. */
  readyToReacquire(operationRecordId: string): boolean {
    const stored = this.runtimeRecord(operationRecordId);
    if (stored === undefined || !stored.parked || stored.parking === null)
      throw new Error("capacity exact parked proof required");
    const core = stored.core;
    const journal = this.project(core.request.project_id).read(operationRecordId);
    if (capacityParkingJournalBinding(journal) !== stored.parking.journal_binding_sha256)
      throw new Error("capacity parked journal conflict");
    this.assertNoDisposition(operationRecordId);
    const now = checkedClock(this.now());
    if (now < core.last_checked_ms) throw new Error("capacity clock regression");
    if (now >= Math.min(core.queue_expires_ms, stored.parking.backend_queue_expires_ms))
      return false;
    return this.queuedFits(core, now);
  }
  private queuedFits(core: HostCapacityRecordV1, now: number): boolean {
    const all = this.records();
    const earlier = all.filter(
      (x) =>
        x.state === "queued" &&
        x.queue_expires_ms > now &&
        (x.created_ms < core.created_ms ||
          (x.created_ms === core.created_ms &&
            x.request.operation_record_id < core.request.operation_record_id))
    );
    return (
      !this.earlierOverlapping(earlier, core.request) &&
      this.fits(all, core.request, this.binding(core.request.binding_id))
    );
  }
  /** Fresh lease identity, not epoch order, proves reacquisition after free/reset. Atomic
   * all-resource admission rechecks fit. On a race, the new queued fence must park again. */
  reacquire(
    operationRecordId: string,
    expectedRevision: number,
    admit = true
  ): HostCapacityRecordV1 {
    return this.update(
      operationRecordId,
      expectedRevision,
      (record) => record,
      true,
      (stored, journal, now) => {
        const core = stored.core;
        const proof = stored.parking;
        if (
          !stored.parked ||
          proof === null ||
          core.state !== "queued" ||
          core.active_started_ms !== null ||
          core.snapshot !== null ||
          core.cleanup_started_ms !== null ||
          journal.lease === null ||
          capacityParkingJournalBinding(journal) !== proof.journal_binding_sha256 ||
          same(journal.lease, proof.lease)
        )
          throw new Error("capacity reacquisition exact non-submission parking proof conflict");
        this.assertNoDisposition(operationRecordId);
        this.assertActive(journal, journal.lease, now, true, admit);
        const expired = now >= Math.min(core.queue_expires_ms, proof.backend_queue_expires_ms);
        const held = admit && !expired && this.queuedFits(core, now);
        return {
          ...stored,
          parked: false,
          core: {
            ...core,
            lease: journal.lease,
            state: expired ? "expired" : held ? "held" : "queued",
            active_started_ms: held ? now : null,
            last_milestone_ms: held ? now : null,
          },
        };
      }
    );
  }
  /** A current demand refusal cannot authorize admission, but also cannot strand a fresh
   * fence. Cleanup uses only the canonical original request and concrete current custody. */
  compensateReacquisition(
    expectedJournal: HostOperationCallRecordV1,
    expectedRevision: number,
    fresh: HostOperationLeaseIdentityV1
  ): HostCapacityRecordV1 {
    return this.update(
      expectedJournal.operation_record_id,
      expectedRevision,
      (record) => record,
      true,
      (stored, journal, now) => {
        if (!same(journal, expectedJournal))
          throw new Error("capacity compensation journal is not current");
        HostOperationLeaseAuthority.compensateCapacityReacquisitionInTransaction(
          this.store,
          journal,
          fresh,
          now
        );
        const proof = stored.parking;
        if (proof === null) throw new Error("capacity compensation original proof absent");
        return { ...stored, parked: true, core: { ...stored.core, lease: proof.lease } };
      }
    );
  }
  /** The catalog commit precedes the project CAS. Only an exact compensation event may
   * restore the journal's proof fence; an arbitrary mismatched fence is never adopted. */
  compensatedParking(
    expectedJournal: HostOperationCallRecordV1
  ): HostCapacityParkingProofV1 | undefined {
    return this.store.transaction(() => {
      this.assertPolicy();
      const stored = this.runtimeRecord(expectedJournal.operation_record_id);
      if (stored === undefined || !stored.parked || same(stored.core.lease, expectedJournal.lease))
        return undefined;
      const journal = this.project(stored.core.request.project_id).read(
        expectedJournal.operation_record_id
      );
      this.assertBinding(stored.core.request, journal);
      if (!same(journal, expectedJournal))
        throw new Error("capacity compensation journal is not current");
      return HostOperationLeaseAuthority.compensatedParkingInTransaction(this.store, journal);
    });
  }
  /** No adapter payload/authority: read one exact artifact from the trusted host source. */
  observeProductive(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    const initial = this.required(operationRecordId);
    const project = this.project(initial.request.project_id);
    const journal = project.read(operationRecordId);
    const source = project.productive;
    if (source === undefined) throw new Error("capacity productive source absent");
    const raw = source.read({
      journal: structuredClone(journal),
      capacity: structuredClone(initial),
    });
    // Reuse the exact platform ref parser; null/unknown/structural claims are not progress.
    const ref = validateSkillSchema(ArtifactRefSchema, raw, "capacity productive exact ref");
    const selected = project.verifyProductive(ref);
    if (selected === null) throw new Error("capacity productive observation absent");
    const snapshot = validateCapacitySnapshot(
      project.measurements.read({
        journal: structuredClone(journal),
        capacity: structuredClone(initial),
      })
    );
    return this.update(
      operationRecordId,
      expectedRevision,
      (record) => record,
      false,
      (stored, fresh, now) => {
        const core = stored.core;
        this.requireLiveHold(core, fresh, now);
        const observation = selected.observation;
        if (
          fresh.lifecycle !== "submitted" ||
          fresh.remote_correlation_sha256 === null ||
          observation.remote_correlation_sha256 !== fresh.remote_correlation_sha256 ||
          !same(observation.lease, core.lease) ||
          ref.run_id !== fresh.identity.run_id ||
          observation.operation_record_id !== operationRecordId ||
          observation.project_id !== fresh.project_id ||
          observation.directive_sha256 !== fresh.directive_sha256 ||
          observation.operation_request_sha256 !== fresh.request_sha256 ||
          observation.capacity_request_sha256 !== sha256(capacityJson(core.request)) ||
          stored.productive_binding_sha256 !== project.productiveBinding()
        )
          throw new Error("capacity productive exact target/fence conflict");
        if (same(stored.productive, selected)) return stored;
        const prior = stored.productive?.observation;
        if (
          stored.productive_count >= source.max_observations ||
          observation.total_units > source.max_units ||
          observation.completed_units > source.max_units ||
          observation.productive_revision <= (prior?.productive_revision ?? 0) ||
          observation.completed_units <= (prior?.completed_units ?? 0) ||
          (prior !== undefined && observation.total_units !== prior.total_units) ||
          observation.observed_at_ms <= (core.last_milestone_ms ?? -1) ||
          observation.observed_at_ms > now ||
          observation.observed_at_ms < (core.active_started_ms ?? now)
        )
          throw new Error("capacity productive observation stale, unproductive or over limit");
        if (snapshot.kind !== "cumulative")
          throw new Error("capacity productive measurement must be cumulative");
        const measured = this.applySnapshot(core, fresh, now, snapshot);
        return {
          ...stored,
          productive: selected,
          productive_count: stored.productive_count + 1,
          core: { ...measured, last_milestone_ms: observation.observed_at_ms },
        };
      }
    );
  }

  /** Exact same-operation fencing adoption (e.g. lease authority acceptance reconciliation).
   * It changes no allocation, spend or clock allowance, and cannot adopt after a disposition. */
  adoptFence(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(
      operationRecordId,
      expectedRevision,
      (record, journal, now) => {
        if (record.state !== "held" && record.state !== "queued")
          throw new Error("capacity fence adoption requires live reservation");
        if (journal.lease === null || this.disposition(record) !== undefined)
          throw new Error("capacity fence adoption lacks uninterrupted ownership");
        this.assertActive(journal, journal.lease, now, false);
        if (same(record.lease, journal.lease)) return record;
        if (
          journal.lease.lease_epoch <= record.lease.lease_epoch ||
          journal.lease.backend_key_sha256 !== record.lease.backend_key_sha256
        )
          throw new Error("capacity fence adoption stale");
        return { ...record, lease: journal.lease };
      },
      true
    );
  }
  tryAdmit(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record, journal, now) => {
      if (record.state !== "queued") throw new Error("capacity admission requires queued record");
      if (now >= record.queue_expires_ms) return { ...record, state: "expired" };
      this.assertActive(journal, record.lease, now, true);
      const queued = this.records().filter(
        (x) =>
          x.state === "queued" &&
          x.queue_expires_ms > now &&
          x.request.operation_record_id !== operationRecordId
      );
      const earlier = queued.filter(
        (x) =>
          x.created_ms < record.created_ms ||
          (x.created_ms === record.created_ms && x.request.operation_record_id < operationRecordId)
      );
      if (
        this.earlierOverlapping(earlier, record.request) ||
        !this.fits(this.records(), record.request, this.binding(record.request.binding_id))
      )
        return record;
      return { ...record, state: "held", active_started_ms: now, last_milestone_ms: now };
    });
  }
  /** No generic activity callback: only first observation of immutable durable output milestones. */
  observeMilestone(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record, journal, now) => {
      this.requireLiveHold(record, journal, now);
      const milestone =
        journal.lifecycle === "verified"
          ? "verified"
          : journal.lifecycle === "persisted"
            ? "persisted"
            : journal.lifecycle === "fetched"
              ? "fetched"
              : "none";
      if (MILESTONES.indexOf(milestone) <= MILESTONES.indexOf(record.milestone)) return record;
      if (
        journal.fetched === null ||
        (milestone !== "fetched" && journal.operation_result_ref === null)
      )
        throw new Error("capacity journal milestone incomplete");
      return { ...record, milestone, last_milestone_ms: now };
    });
  }
  requireHeld(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record, journal, now) => {
      this.requireLiveHold(record, journal, now);
      return record;
    });
  }
  /** Only measured source snapshots charge. Snapshot IDs/bytes cannot be submitted by callers. */
  account(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    const record = this.required(operationRecordId);
    const project = this.project(record.request.project_id);
    const journal = project.read(operationRecordId);
    const snapshot = validateCapacitySnapshot(
      project.measurements.read({ journal, capacity: structuredClone(record) })
    );
    return this.update(operationRecordId, expectedRevision, (current, freshJournal, now) =>
      this.applySnapshot(current, freshJournal, now, snapshot)
    );
  }
  private applySnapshot(
    current: HostCapacityRecordV1,
    freshJournal: HostOperationCallRecordV1,
    now: number,
    snapshot: HostCapacitySnapshotV1
  ): HostCapacityRecordV1 {
    const operationRecordId = current.request.operation_record_id;
    if (!["held", "quarantined", "settled"].includes(current.state))
      throw new Error("capacity accounting requires admitted hold");
    const receipt = this.disposition(current);
    if (receipt === undefined) this.assertActive(freshJournal, current.lease, now, false);
    if (
      snapshot.operation_record_id !== operationRecordId ||
      snapshot.request_sha256 !== sha256(capacityJson(current.request)) ||
      !same(snapshot.lease, current.lease)
    )
      throw new Error("capacity measurement identity conflict");
    if (snapshot.kind === "final" && receipt?.disposition.lease_disposition !== "released")
      throw new Error("capacity final measurement lacks disposition proof");
    this.assertReadings(current, snapshot);
    const existing = this.store.db
      .prepare(
        "SELECT snapshot_jcs, snapshot_sha256 FROM host_capacity_snapshots WHERE operation_record_id = ? AND source_revision = ?"
      )
      .get(operationRecordId, snapshot.source_revision);
    if (existing !== undefined) {
      if (!same(decodeJson(existing, "snapshot_jcs", "snapshot_sha256"), snapshot))
        throw new Error("capacity snapshot replay conflict");
      if (!same(current.snapshot, snapshot)) throw new Error("capacity old measurement replay");
      return current;
    }
    if (
      current.state === "settled" ||
      current.snapshot?.kind === "final" ||
      snapshot.source_revision <= (current.snapshot?.source_revision ?? 0)
    )
      throw new Error("capacity measurement revision stale or finalized");
    const count = this.snapshotRows(operationRecordId).length;
    // Cumulative measurements cannot spend the slot needed to prove final release.
    const limit = this.policy.max_snapshots_per_operation - (snapshot.kind === "final" ? 0 : 1);
    if (count >= limit) throw new Error("capacity measurement ledger limit");
    this.store.db
      .prepare("INSERT INTO host_capacity_snapshots VALUES (?, ?, ?, ?)")
      .run(
        operationRecordId,
        snapshot.source_revision,
        capacityJson(snapshot),
        sha256(capacityJson(snapshot))
      );
    return { ...current, snapshot };
  }
  /** Derive exact proof from the catalog; no caller booleans, timer release or reset shortcut. */
  settle(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record) => {
      if (!["held", "quarantined", "settled"].includes(record.state))
        throw new Error("capacity settlement requires admitted hold");
      const receipt = this.disposition(record);
      if (receipt === undefined) throw new Error("capacity release proof absent");
      if (receipt.disposition.lease_disposition === "quarantined") {
        if (record.state === "settled") throw new Error("capacity settled disposition conflicts");
        return { ...record, state: "quarantined", disposition_receipt_id: receipt.receipt_id };
      }
      if (
        !["none", "proven_not_accepted", "proven_terminal"].includes(
          receipt.disposition.remote_disposition
        ) ||
        record.snapshot?.kind !== "final"
      )
        throw new Error(
          "capacity release requires terminal/non-acceptance proof and final measured snapshot"
        );
      return { ...record, state: "settled", disposition_receipt_id: receipt.receipt_id };
    });
  }
  beginCleanup(operationRecordId: string, expectedRevision: number): HostCapacityRecordV1 {
    return this.update(operationRecordId, expectedRevision, (record, _journal, now) => ({
      ...record,
      cleanup_started_ms: record.cleanup_started_ms ?? now,
    }));
  }
  clockStatus(operationRecordId: string): HostCapacityClockStatusV1 {
    this.assertPolicy();
    const record = this.required(operationRecordId);
    const now = checkedClock(this.now());
    if (now < record.last_checked_ms) throw new Error("capacity clock regression");
    return this.status(record, now);
  }
  inspect(operationRecordId: string): HostCapacityRecordV1 | undefined {
    this.store.assertCustody();
    this.assertPolicy();
    return this.read(operationRecordId);
  }
  /** Native collector receipts share the catalog and exact operation journal. No DDL,
   * parallel database, expiry refund, or caller-selected backend is introduced. */
  nativeEvent(id: string, kind: NativeCapacityEventKind): unknown | undefined {
    this.assertPolicy();
    this.required(id);
    const rows = this.store.db
      .prepare(
        "SELECT event_jcs, event_sha256 FROM host_backend_lease_events WHERE operation_record_id = ? AND event_type = ? ORDER BY event_id LIMIT 2"
      )
      .all(id, kind);
    if (rows.length > 1) throw new Error("native collector duplicate receipt");
    const row = rows[0];
    return row === undefined
      ? undefined
      : validateSkillSchema(
          NativeCapacityEventSchemas[kind],
          decodeJson(row, "event_jcs", "event_sha256"),
          "native catalog receipt"
        );
  }
  recordNativeEvent(id: string, kind: NativeCapacityEventKind, value: unknown): void {
    capacityJson(value);
    const checked = validateSkillSchema(
      NativeCapacityEventSchemas[kind],
      value,
      "native collector receipt"
    );
    const text = capacityJson(checked);
    this.store.transaction(() => {
      this.assertPolicy();
      const record = this.required(id);
      const journal = this.project(record.request.project_id).read(id);
      this.assertBinding(record.request, journal);
      if (!same(record.lease, journal.lease))
        throw new Error("native collector current journal fence conflict");
      if (
        checked.operation_request_sha256 !== journal.request_sha256 ||
        ("capacity_request_sha256" in checked &&
          checked.capacity_request_sha256 !== sha256(capacityJson(record.request))) ||
        ("lease" in checked && !same(checked.lease, record.lease)) ||
        ("snapshot" in checked &&
          (checked.snapshot.operation_record_id !== id ||
            checked.snapshot.request_sha256 !== sha256(capacityJson(record.request)) ||
            !same(checked.snapshot.lease, record.lease)))
      )
        throw new Error("native receipt exact operation/request/resource/fence conflict");
      const existing = this.nativeEvent(id, kind);
      if (existing !== undefined) {
        if (!same(existing, checked)) throw new Error("native collector receipt conflict");
        return;
      }
      if (kind === "native_meter_stop_v1") {
        if (
          journal.lifecycle !== "terminal" ||
          journal.disposition?.lease_disposition !== "released"
        )
          throw new Error("native stop requires proven terminal released disposition");
        this.assertActive(journal, record.lease, checkedClock(this.now()), false, false);
      } else if (kind === "native_meter_final_v1") {
        if (
          journal.lifecycle !== "terminal" ||
          this.disposition(record)?.disposition.lease_disposition !== "released"
        )
          throw new Error("native final receipt requires terminal released journal");
      } else {
        this.requireLiveHold(record, journal, checkedClock(this.now()));
        if (
          (kind === "managed_lease_grant_v1" && journal.lifecycle !== "submitting") ||
          (kind !== "managed_lease_grant_v1" && journal.lifecycle !== "lease_acquired")
        )
          throw new Error("native baseline/grant journal phase conflict");
      }
      this.store.db
        .prepare(
          "INSERT INTO host_backend_lease_events (backend_key_sha256, operation_record_id, event_type, event_jcs, event_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          record.backend_key_sha256,
          id,
          kind,
          text,
          sha256(text),
          new Date(this.now()).toISOString()
        );
    });
  }
  /** Validate a managed client against a CURRENT admitted operation, not a PID allowlist.
   * Same-operation acceptance adopts a new fence but never grants another request/window. */
  requireNativeGrant(value: unknown): HostOperationLeaseIdentityV1 {
    const grant = validateSkillSchema(
      NativeCapacityEventSchemas.managed_lease_grant_v1,
      value,
      "managed lease grant"
    );
    return this.store.transaction(() => {
      this.assertPolicy();
      const record = this.required(grant.operation_record_id);
      const project = this.projects.get(record.request.project_id);
      const journal = project?.read(grant.operation_record_id);
      const now = checkedClock(this.now());
      if (journal) this.requireLiveHold(record, journal, now);
      else {
        // A foreign project originally minted the grant through concrete journal custody.
        // Recheck its catalog fence/hold without discovering/opening its private database.
        const row = this.store.db
          .prepare("SELECT * FROM host_backend_leases WHERE backend_key_sha256 = ?")
          .get(record.backend_key_sha256);
        if (
          record.state !== "held" ||
          record.cleanup_started_ms !== null ||
          this.status(record, now).active_inactivity_expired ||
          this.status(record, now).explicit_elapsed_expired ||
          row === undefined ||
          rowText(row, "state") !== "active" ||
          rowText(row, "operation_record_id") !== grant.operation_record_id ||
          rowText(row, "project_id") !== record.request.project_id ||
          rowText(row, "request_sha256") !== record.operation_request_sha256 ||
          rowText(row, "lease_id") !== record.lease.lease_id ||
          rowInteger(row, "lease_epoch") !== record.lease.lease_epoch ||
          rowText(row, "fencing_token_sha256") !== record.lease.fencing_token_sha256 ||
          rowInteger(row, "expires_at_ms") <= now
        )
          throw new Error("managed foreign grant live catalog fence/hold absent");
      }
      const live = this.store.db
        .prepare("SELECT active_phase FROM host_backend_leases WHERE backend_key_sha256 = ?")
        .get(record.backend_key_sha256);
      if (live === undefined || rowText(live, "active_phase") === "pre_submission")
        throw new Error("managed grant requires durable submission guard");
      const binding = this.binding(record.request.binding_id);
      if (
        !same(this.nativeEvent(grant.operation_record_id, "managed_lease_grant_v1"), grant) ||
        grant.project_id !== record.request.project_id ||
        grant.operation_request_sha256 !== record.operation_request_sha256 ||
        grant.directive_sha256 !== record.directive_sha256 ||
        grant.capacity_request_sha256 !== sha256(capacityJson(record.request)) ||
        grant.worker_id !== binding.worker_id ||
        !same([...grant.resource_ids].sort(), [...binding.resource_ids].sort()) ||
        grant.lease.backend_key_sha256 !== record.backend_key_sha256 ||
        grant.lease.lease_epoch > record.lease.lease_epoch
      )
        throw new Error("managed grant current operation/resource conflict");
      return structuredClone(record.lease);
    });
  }
  /** Read-only catalog census, including quarantined holds; never silently discard unknown work. */
  nativeReservations(): readonly HostCapacityRecordV1[] {
    this.assertPolicy();
    return this.records().filter((r) => r.state === "held" || r.state === "quarantined");
  }
  close(): void {
    this.store.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }

  private update(
    id: string,
    expectedRevision: number,
    apply: (
      record: HostCapacityRecordV1,
      journal: HostOperationCallRecordV1,
      now: number
    ) => HostCapacityRecordV1,
    allowFenceChange = false,
    runtimeApply?: (
      stored: HostCapacityRuntimeRecordV2,
      journal: HostOperationCallRecordV1,
      now: number
    ) => HostCapacityRuntimeRecordV2
  ): HostCapacityRecordV1 {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error("capacity revision invalid");
    const initial = this.required(id);
    return this.store.transaction(() => {
      this.assertPolicy();
      const journal = this.project(initial.request.project_id).read(id);
      const current = this.required(id);
      if (current.revision !== expectedRevision) throw new Error("capacity stale revision");
      this.assertBinding(current.request, journal);
      if (
        journal.directive_sha256 !== current.directive_sha256 ||
        journal.request_sha256 !== current.operation_request_sha256 ||
        (!allowFenceChange && !same(journal.lease, current.lease))
      )
        throw new Error("capacity journal/fence conflict");
      const now = checkedClock(this.now());
      if (now < current.last_checked_ms) throw new Error("capacity clock regression");
      const stored = this.readStored(id);
      if (stored === undefined) throw new Error("capacity record absent");
      if (runtimeApply !== undefined && stored.schema_version !== 2)
        throw new Error("capacity runtime V2 representation required; legacy bytes not upgraded");
      const runtimeNext =
        runtimeApply === undefined || stored.schema_version !== 2
          ? undefined
          : runtimeApply(stored, journal, now);
      const next = validateCapacityRecord({
        ...(runtimeNext?.core ?? apply(current, journal, now)),
        last_checked_ms: now,
      });
      const nextStored =
        stored.schema_version === 2 ? { ...(runtimeNext ?? stored), core: next } : next;
      if (same(nextStored, stored)) return current;
      const updated = validateCapacityRecord({
        ...next,
        revision: checkedAdd(current.revision, 1),
      });
      const updatedStored = validateCapacityStoredRecord(
        stored.schema_version === 2 ? { ...nextStored, core: updated } : updated
      );
      const result = this.store.db
        .prepare(
          "UPDATE host_capacity_records SET revision = ?, state = ?, record_jcs = ?, record_sha256 = ? WHERE operation_record_id = ? AND revision = ?"
        )
        .run(
          updated.revision,
          updated.state,
          capacityJson(updatedStored),
          sha256(capacityJson(updatedStored)),
          id,
          expectedRevision
        );
      if (Number(result.changes) !== 1) throw new Error("capacity CAS lost");
      return updated;
    });
  }
  private assertBinding(
    request: HostCapacityRequestV1,
    journal: HostOperationCallRecordV1
  ): HostCapacityBindingV1 {
    // Policy validation makes this full journal coordinate unique, irrespective of purpose.
    const binding = this.policy.bindings.find(
      (candidate) =>
        journal.operation_kind === candidate.operation_kind &&
        journal.policy_binding.adapter_id === candidate.adapter_id &&
        journal.policy_binding.backend_binding_id === candidate.backend_binding_id &&
        journal.policy_binding.backend_key_sha256 === hostCapacityWorkerKey(candidate.worker_id)
    );
    if (binding === undefined || request.binding_id !== binding.binding_id)
      throw new Error(
        "capacity opt-in worker binding conflict; retained keys are not reinterpreted"
      );
    if (
      !same(
        request.demands.map((x) => x.resource_id),
        [...binding.resource_ids].sort()
      )
    )
      throw new Error("capacity all-resource demand required");
    return binding;
  }
  private assertActive(
    journal: HostOperationCallRecordV1,
    lease: HostCapacityRecordV1["lease"],
    now: number,
    preSubmission: boolean,
    live = true
  ): void {
    const row = this.store.db
      .prepare("SELECT * FROM host_backend_leases WHERE backend_key_sha256 = ?")
      .get(lease.backend_key_sha256);
    if (
      row === undefined ||
      rowText(row, "state") !== "active" ||
      rowText(row, "lease_id") !== lease.lease_id ||
      rowInteger(row, "lease_epoch") !== lease.lease_epoch ||
      rowText(row, "fencing_token_sha256") !== lease.fencing_token_sha256 ||
      rowText(row, "operation_record_id") !== journal.operation_record_id ||
      rowText(row, "project_id") !== journal.project_id ||
      rowText(row, "run_id") !== journal.identity.run_id ||
      rowText(row, "state_id") !== journal.state_id ||
      rowInteger(row, "attempt") !== journal.attempt ||
      rowText(row, "operation_id") !== journal.operation_id ||
      rowText(row, "registration_sha256") !== journal.registration_sha256 ||
      rowText(row, "request_sha256") !== journal.request_sha256 ||
      (live && rowInteger(row, "expires_at_ms") <= now) ||
      (preSubmission && rowText(row, "active_phase") !== "pre_submission")
    )
      throw new Error("capacity backend fence stale or missing pre-submission authority");
  }
  private disposition(record: HostCapacityRecordV1): HostOperationDispositionReceiptV1 | undefined {
    const row = this.store.db
      .prepare(
        "SELECT receipt_jcs, receipt_sha256 FROM host_backend_dispositions WHERE operation_record_id = ? AND backend_key_sha256 = ? AND lease_id = ? AND lease_epoch = ? ORDER BY created_at DESC, receipt_id DESC LIMIT 1"
      )
      .get(
        record.request.operation_record_id,
        record.backend_key_sha256,
        record.lease.lease_id,
        record.lease.lease_epoch
      );
    if (row === undefined) return undefined;
    const receipt = validateHostOperationDispositionReceipt(
      decodeJson(row, "receipt_jcs", "receipt_sha256")
    );
    if (
      receipt.operation_record_id !== record.request.operation_record_id ||
      receipt.backend_key_sha256 !== record.backend_key_sha256 ||
      !same(receipt.lease, record.lease)
    )
      throw new Error("capacity disposition exact fence conflict");
    return receipt;
  }
  private assertReadings(
    record: HostCapacityRecordV1,
    snapshot: HostCapacitySnapshotV1,
    previousSnapshot = record.snapshot
  ): void {
    if (
      (this.policy.external_work_policy === "penny_serialized_api") !==
      (snapshot.accounting?.assurance === "trusted_local_api")
    )
      throw new Error("capacity accounting assurance/policy mismatch");
    if (
      !same(
        snapshot.readings.map((x) => x.resource_id),
        record.request.demands.map((x) => x.resource_id)
      )
    )
      throw new Error("capacity incomplete/all-resource readings");
    for (const [index, demand] of record.request.demands.entries()) {
      const reading = snapshot.readings[index];
      const previous = previousSnapshot?.readings[index];
      if (reading === undefined) throw new Error("capacity reading missing");
      for (const meter of CAPACITY_METERS)
        if (
          reading.meters[meter] < (previous?.meters[meter] ?? 0) ||
          reading.meters[meter] > demand.meters[meter]
        )
          throw new Error("capacity meter rollback or cap exceeded");
    }
  }
  private fits(
    all: readonly HostCapacityRecordV1[],
    request: HostCapacityRequestV1,
    binding: HostCapacityBindingV1
  ): boolean {
    const active = all.filter((x) => x.state === "held" || x.state === "quarantined");
    if (
      active.length >= this.policy.max_active ||
      active.filter((x) => x.request.project_id === request.project_id).length >=
        this.policy.max_active_per_project
    )
      return false;
    for (const demand of request.demands) {
      const resource = this.policy.resources.find((x) => x.resource_id === demand.resource_id);
      if (resource === undefined) throw new Error("capacity resource missing");
      let slots = BigInt(demand.slots);
      let workSlots = binding.purpose === "work" ? BigInt(demand.slots) : 0n;
      const total = zeroCapacityMeters();
      const work = zeroCapacityMeters();
      for (const record of all) {
        if (record.state === "queued" || record.state === "expired") continue;
        const held = record.state === "held" || record.state === "quarantined";
        const prior = record.request.demands.find((x) => x.resource_id === demand.resource_id);
        if (prior === undefined) continue;
        if (held) {
          slots += BigInt(prior.slots);
          if (this.binding(record.request.binding_id).purpose === "work")
            workSlots += BigInt(prior.slots);
        }
        const amounts = held
          ? prior.meters
          : record.snapshot?.readings.find((x) => x.resource_id === demand.resource_id)?.meters;
        if (amounts === undefined)
          throw new Error("capacity settled record lacks measured consumption");
        for (const meter of CAPACITY_METERS) {
          total[meter] = checkedAdd(total[meter], amounts[meter]);
          if (this.binding(record.request.binding_id).purpose === "work")
            work[meter] = checkedAdd(work[meter], amounts[meter]);
        }
      }
      if (
        slots > BigInt(resource.max_slots) ||
        workSlots > BigInt(resource.max_slots - resource.protected_finish_slots)
      )
        return false;
      for (const meter of CAPACITY_METERS) {
        if (BigInt(total[meter]) + BigInt(demand.meters[meter]) > BigInt(resource.limits[meter]))
          return false;
        if (
          binding.purpose === "work" &&
          BigInt(work[meter]) + BigInt(demand.meters[meter]) >
            BigInt(resource.limits[meter] - resource.protected_finish[meter])
        )
          return false;
      }
    }
    return true;
  }
  private earlierOverlapping(
    queued: readonly HostCapacityRecordV1[],
    request: HostCapacityRequestV1
  ): boolean {
    return queued.some((x) =>
      x.request.demands.some((a) => request.demands.some((b) => a.resource_id === b.resource_id))
    );
  }
  private requireLiveHold(
    record: HostCapacityRecordV1,
    journal: HostOperationCallRecordV1,
    now: number
  ): void {
    if (record.state !== "held" || record.cleanup_started_ms !== null)
      throw new Error("capacity is not an active hold");
    const status = this.status(record, now);
    if (status.active_inactivity_expired || status.explicit_elapsed_expired)
      throw new Error("capacity active clock expired");
    if (["terminal", "settled", "consumed"].includes(journal.lifecycle))
      throw new Error("capacity journal already terminal");
    this.assertActive(journal, record.lease, now, false);
  }
  private status(record: HostCapacityRecordV1, now: number): HostCapacityClockStatusV1 {
    return {
      queue_expired: record.state === "queued" && now >= record.queue_expires_ms,
      active_inactivity_expired:
        record.last_milestone_ms !== null &&
        now - record.last_milestone_ms >= this.policy.active_inactivity_ms,
      explicit_elapsed_expired:
        record.active_started_ms !== null &&
        this.policy.max_elapsed_ms !== undefined &&
        now - record.active_started_ms >= this.policy.max_elapsed_ms,
      cleanup_expired:
        record.cleanup_started_ms !== null &&
        now - record.cleanup_started_ms >= this.policy.cleanup_grace_ms,
      effect_permission: "none",
    };
  }
  private assertPolicy(): void {
    this.store.assertCustody();
    if (this.store.db.prepare("PRAGMA user_version").get()?.user_version !== 4)
      throw new Error("capacity requires exact catalog schema 4");
    const row = this.store.db
      .prepare("SELECT policy_jcs, policy_sha256 FROM host_capacity_policy WHERE singleton = 1")
      .get();
    if (
      row === undefined ||
      sha256(
        capacityJson(capacityPolicyVersions(decodeJson(row, "policy_jcs", "policy_sha256")).active)
      ) !== this.policySha256
    )
      throw new Error("capacity durable policy absent or drifted");
    if (
      this.store.db
        .prepare(
          "SELECT s.operation_record_id FROM host_capacity_snapshots AS s LEFT JOIN host_capacity_records AS r ON r.operation_record_id = s.operation_record_id WHERE r.operation_record_id IS NULL LIMIT 1"
        )
        .get() !== undefined
    )
      throw new Error("capacity orphan measurement row");
  }
  private project(id: string): HostCapacityProjectAuthority {
    const project = this.projects.get(id);
    if (project === undefined) throw new Error("capacity project authority absent");
    return project;
  }
  runtimeRecord(id: string): HostCapacityRuntimeRecordV2 | undefined {
    this.assertPolicy();
    const stored = this.readStored(id);
    return stored?.schema_version === 2 ? stored : undefined;
  }
  private read(id: string): HostCapacityRecordV1 | undefined {
    const stored = this.readStored(id);
    return stored === undefined ? undefined : capacityCore(stored);
  }
  private readStored(id: string): HostCapacityStoredRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM host_capacity_records WHERE operation_record_id = ?")
      .get(id);
    const snapshotRows = this.snapshotRows(id);
    if (row === undefined) {
      if (snapshotRows.length !== 0) throw new Error("capacity orphan measurement row");
      return undefined;
    }
    const stored = validateCapacityStoredRecord(decodeJson(row, "record_jcs", "record_sha256"));
    const record = capacityCore(stored);
    if (stored.schema_version === 2) {
      if (stored.parking !== null) {
        const text = capacityJson(stored.parking);
        if (
          this.store.db
            .prepare(
              `SELECT 1 FROM host_backend_lease_events WHERE operation_record_id = ?
          AND backend_key_sha256 = ? AND event_type = 'capacity_parked_v1' AND event_jcs = ? AND event_sha256 = ?`
            )
            .get(id, record.backend_key_sha256, text, sha256(text)) === undefined
        )
          throw new Error("capacity durable parking proof absent or drifted");
      }
      const project = this.projects.get(record.request.project_id);
      if (project !== undefined) {
        if (stored.productive_binding_sha256 !== project.productiveBinding())
          throw new Error("capacity productive source binding drift");
        if (
          stored.productive !== null &&
          !same(project.verifyProductive(stored.productive.ref), stored.productive)
        )
          throw new Error("capacity durable productive proof absent or drifted");
      }
    }
    if (
      record.request.operation_record_id !== rowText(row, "operation_record_id") ||
      record.request.project_id !== rowText(row, "project_id") ||
      record.revision !== rowInteger(row, "revision") ||
      record.state !== rowText(row, "state") ||
      record.policy_sha256 !== this.policySha256
    )
      throw new Error("capacity row projection diverges");
    this.assertSnapshotHistory(record, snapshotRows);
    if (record.state === "settled" || record.state === "quarantined") {
      const receipt = this.disposition(record);
      const expected = record.state === "settled" ? "released" : "quarantined";
      if (
        receipt === undefined ||
        receipt.receipt_id !== record.disposition_receipt_id ||
        receipt.disposition.lease_disposition !== expected
      )
        throw new Error("capacity disposed proof absent or drifted");
    }
    return stored;
  }
  /** Read one overflow witness, never truncate history into an apparently valid ledger. */
  private snapshotRows(id: string): unknown[] {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM host_capacity_snapshots WHERE operation_record_id = ? ORDER BY source_revision LIMIT ?"
      )
      .all(id, this.policy.max_snapshots_per_operation + 1);
    if (rows.length > this.policy.max_snapshots_per_operation)
      throw new Error("capacity measurement ledger overflow");
    return rows;
  }
  private assertSnapshotHistory(record: HostCapacityRecordV1, rows: readonly unknown[]): void {
    let previous: HostCapacitySnapshotV1 | null = null;
    const requestSha256 = sha256(capacityJson(record.request));
    for (const row of rows) {
      const snapshot = validateCapacitySnapshot(decodeJson(row, "snapshot_jcs", "snapshot_sha256"));
      if (
        rowText(row, "operation_record_id") !== record.request.operation_record_id ||
        snapshot.operation_record_id !== record.request.operation_record_id ||
        rowInteger(row, "source_revision") !== snapshot.source_revision ||
        snapshot.request_sha256 !== requestSha256 ||
        snapshot.lease.backend_key_sha256 !== record.backend_key_sha256 ||
        snapshot.lease.lease_epoch > record.lease.lease_epoch ||
        (snapshot.lease.lease_epoch === record.lease.lease_epoch &&
          !same(snapshot.lease, record.lease))
      )
        throw new Error("capacity historical measurement identity/fence conflict");
      // Prior epochs survive same-owner adoption. Within one epoch the entire fence is exact;
      // source order cannot roll epochs or measured spend back, or append after final proof.
      if (
        previous !== null &&
        (snapshot.source_revision <= previous.source_revision ||
          previous.kind === "final" ||
          snapshot.lease.lease_epoch < previous.lease.lease_epoch ||
          (snapshot.lease.lease_epoch === previous.lease.lease_epoch &&
            !same(snapshot.lease, previous.lease)))
      )
        throw new Error("capacity historical measurement order/fence conflict");
      this.assertReadings(record, snapshot, previous);
      if (snapshot.kind === "final") {
        if (
          !same(snapshot.lease, record.lease) ||
          this.disposition(record)?.disposition.lease_disposition !== "released"
        )
          throw new Error("capacity historical final disposition proof absent or drifted");
      }
      previous = snapshot;
    }
    if (!same(previous, record.snapshot))
      throw new Error(
        "capacity durable measurement absent or drifted; latest snapshot not selected"
      );
    if (rows.length === this.policy.max_snapshots_per_operation && previous?.kind !== "final")
      throw new Error("capacity measurement ledger lacks reserved final slot");
  }
  private required(id: string): HostCapacityRecordV1 {
    this.store.assertCustody();
    const record = this.read(id);
    if (record === undefined) throw new Error("capacity reservation absent");
    return record;
  }
  private records(): HostCapacityRecordV1[] {
    const rows = this.store.db
      .prepare("SELECT operation_record_id FROM host_capacity_records LIMIT ?")
      .all(this.policy.max_admissions + 1);
    if (rows.length > this.policy.max_admissions)
      throw new Error("capacity catalog admission overflow");
    return rows.map((row) => this.required(rowText(row, "operation_record_id")));
  }
}
