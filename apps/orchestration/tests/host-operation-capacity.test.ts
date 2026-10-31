import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { HostOperationCapacityAuthority } from "../dist/host-operations/capacity-authority.js";
import {
  CAPACITY_METERS,
  hostCapacityWorkerKey,
  validateCapacityPolicy,
  validateCapacityRequest,
  capacityJson,
  validateCapacityRecord,
} from "../dist/host-operations/capacity-contracts.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME } from "../dist/state/paths.js";
import { VideogenCapacitySchedulerBinding } from "../dist/videogen/capacity-scheduler.js";
import { CapacityFixture, capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

const NEVER = {
  outcome: "cancelled",
  remote_disposition: "proven_not_accepted",
  lease_disposition: "released",
  retryable: false,
  reason_code: "fixture_never_submitted",
} as const;
const TERMINAL = {
  outcome: "completed",
  remote_disposition: "proven_terminal",
  lease_disposition: "released",
  retryable: false,
  reason_code: null,
} as const;
const UNKNOWN = {
  outcome: "remote_unknown",
  remote_disposition: "may_continue",
  lease_disposition: "quarantined",
  retryable: false,
  reason_code: "fixture_remote_unknown",
} as const;

function capacityRows(db: OwnerSqliteDatabase): unknown {
  return {
    policy: db.db.prepare("SELECT * FROM host_capacity_policy").all(),
    records: db.db
      .prepare("SELECT * FROM host_capacity_records ORDER BY operation_record_id")
      .all(),
    snapshots: db.db
      .prepare(
        "SELECT * FROM host_capacity_snapshots ORDER BY operation_record_id, source_revision"
      )
      .all(),
  };
}
function putSnapshot(
  db: OwnerSqliteDatabase,
  id: string,
  revision: number,
  body: unknown,
  text = canonicalJson(body),
  hash = sha256(text)
): void {
  db.db
    .prepare("INSERT OR REPLACE INTO host_capacity_snapshots VALUES (?, ?, ?, ?)")
    .run(id, revision, text, hash);
}
function putRecord(db: OwnerSqliteDatabase, id: string, record: unknown): void {
  const text = canonicalJson(record);
  db.db
    .prepare(
      "UPDATE host_capacity_records SET record_jcs = ?, record_sha256 = ? WHERE operation_record_id = ?"
    )
    .run(text, sha256(text), id);
}

describe("opt-in global host capacity", () => {
  it.each([1, 2])("reserves the final proof slot at total snapshot cap %s", (cap) => {
    const policy = capacityPolicy();
    policy.max_snapshots_per_operation = cap;
    using f = new CapacityFixture(policy);
    const core = f.core();
    const op = f.operation(`final-slot-${cap}`);
    let held = core.reserve(op.request);
    f.submit(op);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      label: "fixture final slot",
      mode: "existing",
    });
    if (cap === 2) {
      f.snapshot(op, 5);
      held = core.account(op.record.operation_record_id, held.revision);
      for (let retry = 0; retry < 3; retry += 1)
        expect(core.account(op.record.operation_record_id, held.revision)).toEqual(held);
    }
    f.snapshot(op, 10, 2);
    const before = capacityRows(db);
    expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow(
      "ledger limit"
    );
    expect(capacityRows(db)).toEqual(before);
    expect(core.inspect(op.record.operation_record_id)).toEqual(held);
    f.disposition(op, TERMINAL);
    f.snapshot(op, 10, 3, "final");
    held = core.account(op.record.operation_record_id, held.revision);
    expect(core.account(op.record.operation_record_id, held.revision)).toEqual(held);
    const settled = core.settle(op.record.operation_record_id, held.revision);
    expect(settled.state).toBe("settled");
    expect(core.account(op.record.operation_record_id, settled.revision)).toEqual(settled);
    expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_snapshots").get()?.n).toBe(cap);
  });
  it.each(["work", "finish"] as const)(
    "rejects an identical journal authority tuple with a second %s binding at the policy boundary",
    (purpose) => {
      using f = new CapacityFixture();
      const binding = requireValue(
        f.policy.bindings.find((x) => x.binding_id === "video-b"),
        "work binding"
      );
      const ambiguous = {
        ...f.policy,
        bindings: [...f.policy.bindings, { ...binding, binding_id: "finish-alias", purpose }],
      };
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture alias policy",
        mode: "existing",
      });
      const before = capacityRows(db);
      expect(() => validateCapacityPolicy(ambiguous)).toThrow("authority");
      expect(() => HostOperationCapacityAuthority.configure(f.stateRoot, ambiguous)).toThrow(
        "authority"
      );
      expect(
        () =>
          new HostOperationCapacityAuthority({
            stateRoot: f.stateRoot,
            policy: ambiguous,
            projects: f.projects.map((x) => x.authority),
          })
      ).toThrow("authority");
      expect(capacityRows(db)).toEqual(before);
    }
  );
  it.each(["operation_kind", "adapter_id", "backend_binding_id", "worker_id"] as const)(
    "allows distinct journal-bound %s authority, not a request-selected purpose alias",
    (coordinate) => {
      const policy = capacityPolicy();
      const binding = requireValue(policy.bindings[0], "binding");
      policy.bindings.push({
        ...binding,
        binding_id: "distinct-finish",
        purpose: "finish",
        [coordinate]: "distinct-authority",
      });
      expect(validateCapacityPolicy(policy)).toEqual(policy);
      using f = new CapacityFixture(policy);
      const core = f.core();
      const op = f.operation(`different-authority-${coordinate}`);
      expect(() => core.reserve({ ...op.request, binding_id: "distinct-finish" })).toThrow(
        "binding conflict"
      );
      expect(core.inspect(op.record.operation_record_id)).toBeUndefined();
      expect(core.reserve(op.request).state).toBe("held");
    }
  );
  it.each(["malformed", "valid-unselected", "parentless"] as const)(
    "refuses %s snapshot rows even without a record-selected snapshot, without partial writes",
    (attack) => {
      using f = new CapacityFixture();
      const core = f.core();
      const op = f.operation(`orphan-${attack}`);
      const held = core.reserve(op.request);
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture orphan snapshots",
        mode: "existing",
      });
      const body = attack === "malformed" ? {} : f.snapshot(op, 1, 99);
      putSnapshot(db, op.record.operation_record_id, 99, body);
      if (attack === "parentless") {
        db.db.exec("PRAGMA foreign_keys=OFF");
        db.db
          .prepare("DELETE FROM host_capacity_records WHERE operation_record_id = ?")
          .run(op.record.operation_record_id);
        db.db.exec("PRAGMA foreign_keys=ON");
      }
      const next = f.operation(`orphan-next-${attack}`, "video-c", 1);
      const before = capacityRows(db);
      expect(() => core.inspect(op.record.operation_record_id)).toThrow();
      expect(() => core.reserve(op.request)).toThrow();
      expect(() => core.reserve(next.request)).toThrow();
      expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow();
      expect(capacityRows(db)).toEqual(before);
    }
  );
  it.each([
    "malformed",
    "extra-field",
    "invalid-json",
    "noncanonical",
    "wrong-hash",
    "oversized",
    "row-operation",
    "row-revision",
    "request-hash",
    "missing-resource",
    "foreign-resource",
    "foreign-backend",
    "future-fence",
    "conflicting-prior-token",
    "conflicting-prior-lease",
    "conflicting-current-fence",
    "fence-regression",
    "meter-regression",
    "over-cap",
    "final-before-latest",
    "unselected-latest",
    "selected-old",
    "missing-selected",
    "overflow",
    "cumulative-filled-final-slot",
  ])(
    "refuses historical snapshot %s on inspect/reserve/account without partial writes",
    (attack) => {
      const policy = capacityPolicy();
      policy.max_snapshots_per_operation = 4;
      using f = new CapacityFixture(policy);
      const core = f.core();
      const op = f.operation(`history-${attack}`);
      let held = core.reserve(op.request);
      const first = structuredClone(f.snapshot(op, 5));
      held = core.account(op.record.operation_record_id, held.revision);
      const second = structuredClone(f.snapshot(op, 10, 2));
      held = core.account(op.record.operation_record_id, held.revision);
      f.submit(op, true);
      held = core.adoptFence(op.record.operation_record_id, held.revision);
      const third = structuredClone(f.snapshot(op, 15, 3));
      held = core.account(op.record.operation_record_id, held.revision);
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture historical corruption",
        mode: "existing",
      });
      let body: unknown = first;
      let text: string | undefined;
      let hash: string | undefined;
      if (attack === "malformed") body = {};
      if (attack === "extra-field") body = { ...first, extra: true };
      if (attack === "invalid-json") text = "{";
      if (attack === "noncanonical") text = JSON.stringify(first, null, 2);
      if (attack === "wrong-hash") hash = sha256("wrong snapshot");
      if (attack === "oversized") text = "é".repeat(65_537);
      if (attack === "row-operation")
        first.operation_record_id = `hop_${sha256("foreign operation")}`;
      if (attack === "row-revision") first.source_revision = 99;
      if (attack === "request-hash") first.request_sha256 = sha256("different capacity request");
      if (attack === "missing-resource") first.readings.pop();
      if (attack === "foreign-resource")
        requireValue(first.readings[0], "reading").resource_id = "foreign-resource";
      if (attack === "foreign-backend") first.lease.backend_key_sha256 = sha256("foreign backend");
      if (attack === "future-fence") first.lease.lease_epoch = held.lease.lease_epoch + 1;
      if (attack === "conflicting-prior-token")
        first.lease.fencing_token_sha256 = sha256("prior conflict");
      if (attack === "conflicting-prior-lease") first.lease.lease_id = "foreign-lease";
      if (attack === "conflicting-current-fence")
        first.lease = { ...held.lease, fencing_token_sha256: sha256("current conflict") };
      if (attack === "fence-regression") first.lease = held.lease;
      if (attack === "meter-regression")
        first.readings.forEach((x) => {
          x.meters.attempts = 11;
        });
      if (attack === "over-cap")
        first.readings.forEach((x) => {
          x.meters.attempts = 21;
        });
      if (attack === "final-before-latest") first.kind = "final";
      putSnapshot(db, op.record.operation_record_id, 1, body, text, hash);
      if (
        attack === "unselected-latest" ||
        attack === "overflow" ||
        attack === "cumulative-filled-final-slot"
      )
        putSnapshot(db, op.record.operation_record_id, 4, { ...third, source_revision: 4 });
      if (attack === "overflow")
        putSnapshot(db, op.record.operation_record_id, 5, { ...third, source_revision: 5 });
      if (attack === "cumulative-filled-final-slot")
        putRecord(db, op.record.operation_record_id, {
          ...held,
          snapshot: { ...third, source_revision: 4 },
        });
      if (attack === "selected-old")
        putRecord(db, op.record.operation_record_id, { ...held, snapshot: second });
      if (attack === "missing-selected")
        db.db
          .prepare(
            "DELETE FROM host_capacity_snapshots WHERE operation_record_id = ? AND source_revision = 3"
          )
          .run(op.record.operation_record_id);
      const next = f.operation(`history-next-${attack}`, "video-c", 1);
      f.snapshot(op, 16, 4);
      const before = capacityRows(db);
      expect(() => core.inspect(op.record.operation_record_id)).toThrow();
      expect(() => core.reserve(op.request)).toThrow();
      expect(() => core.reserve(next.request)).toThrow();
      expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow();
      expect(capacityRows(db)).toEqual(before);
    }
  );
  it.each(["missing-proof", "past-final-fence", "after-final"] as const)(
    "rejects historical final snapshot %s",
    (attack) => {
      using f = new CapacityFixture();
      const core = f.core();
      const op = f.operation(`history-final-${attack}`);
      let held = core.reserve(op.request);
      f.snapshot(op, 5);
      held = core.account(op.record.operation_record_id, held.revision);
      f.submit(op, true);
      held = core.adoptFence(op.record.operation_record_id, held.revision);
      f.disposition(op, TERMINAL);
      const final = structuredClone(f.snapshot(op, 10, 2, "final"));
      held = core.account(op.record.operation_record_id, held.revision);
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture historical final",
        mode: "existing",
      });
      if (attack === "missing-proof")
        db.db
          .prepare("DELETE FROM host_backend_dispositions WHERE operation_record_id = ?")
          .run(op.record.operation_record_id);
      if (attack === "past-final-fence") {
        final.lease = { ...final.lease, lease_epoch: final.lease.lease_epoch - 1 };
        putSnapshot(db, op.record.operation_record_id, 2, final);
        putRecord(db, op.record.operation_record_id, { ...held, snapshot: final });
      }
      if (attack === "after-final") {
        const after = { ...final, kind: "cumulative" as const, source_revision: 3 };
        putSnapshot(db, op.record.operation_record_id, 3, after);
        putRecord(db, op.record.operation_record_id, { ...held, snapshot: after });
      }
      const before = capacityRows(db);
      expect(() => core.inspect(op.record.operation_record_id)).toThrow();
      expect(() => core.reserve(op.request)).toThrow();
      expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow();
      expect(capacityRows(db)).toEqual(before);
    }
  );
  it("preserves multi-snapshot history through same-owner fence adoption, restart and final settlement", () => {
    using f = new CapacityFixture();
    const one = f.core();
    const op = f.operation("history-valid-adoption");
    let held = one.reserve(op.request);
    for (const revision of [1, 2]) {
      f.snapshot(op, revision * 2, revision);
      held = one.account(op.record.operation_record_id, held.revision);
    }
    f.submit(op, true);
    held = one.adoptFence(op.record.operation_record_id, held.revision);
    one.close();
    const two = f.core();
    expect(two.inspect(op.record.operation_record_id)).toEqual(held);
    f.snapshot(op, 6, 3);
    held = two.account(op.record.operation_record_id, held.revision);
    f.disposition(op, TERMINAL);
    f.snapshot(op, 6, 4, "final");
    held = two.account(op.record.operation_record_id, held.revision);
    held = two.settle(op.record.operation_record_id, held.revision);
    expect(two.inspect(op.record.operation_record_id)).toEqual(held);
    expect(two.reserve(op.request)).toEqual(held);
  });
  it.each(["measurement", "disposition"] as const)(
    "refuses missing durable %s proof before a new shared admission",
    (proof) => {
      using f = new CapacityFixture();
      const core = f.core();
      const op = f.operation(`missing-proof-${proof}`);
      let held = core.reserve(op.request);
      f.disposition(op, NEVER);
      f.snapshot(op, 0, 1, "final");
      held = core.account(op.record.operation_record_id, held.revision);
      core.settle(op.record.operation_record_id, held.revision);
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture missing proof",
        mode: "existing",
      });
      if (proof === "measurement")
        db.db
          .prepare("DELETE FROM host_capacity_snapshots WHERE operation_record_id = ?")
          .run(op.record.operation_record_id);
      else
        db.db
          .prepare("DELETE FROM host_backend_dispositions WHERE operation_record_id = ?")
          .run(op.record.operation_record_id);
      expect(() => core.inspect(op.record.operation_record_id)).toThrow("absent or drifted");
      const next = f.operation(`missing-proof-next-${proof}`, "video-b", 1);
      expect(() => core.reserve(next.request)).toThrow("absent or drifted");
      expect(core.inspect(next.record.operation_record_id)).toBeUndefined();
    }
  );
  it("rejects unsafe integer sums without rounding or admitting over capacity", () => {
    const policy = capacityPolicy();
    for (const resource of policy.resources) {
      resource.limits = meters(Number.MAX_SAFE_INTEGER);
      resource.protected_finish = meters(0);
    }
    using f = new CapacityFixture(policy);
    const core = f.core();
    const a = f.operation("maximum-a", "video-a", 0, Number.MAX_SAFE_INTEGER);
    expect(core.reserve(a.request).state).toBe("held");
    const b = f.operation("maximum-b", "video-b", 1, 1);
    expect(core.reserve(b.request).state).toBe("queued");
  });
  it("rejects accessors without running them, and bounds bytes, collections and cross-field persisted state", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("closed-state");
    const held = core.reserve(op.request);
    let ran = false;
    const accessor = {
      get demands() {
        ran = true;
        return op.request.demands;
      },
    };
    expect(() => validateCapacityRequest(accessor)).toThrow("accessors");
    expect(ran).toBe(false);
    expect(() => capacityJson("x".repeat(131_073))).toThrow("byte limit");
    expect(() => capacityJson(Array.from({ length: 4_097 }, () => 0))).toThrow("collection limit");
    expect(() =>
      validateCapacityRecord({ ...held, state: "settled", disposition_receipt_id: "fake-proof" })
    ).toThrow("final measurement");
    expect(() => validateCapacityRecord({ ...held, state: "quarantined" })).toThrow(
      "proof identity"
    );
    expect(() =>
      validateCapacityRecord({ ...held, last_milestone_ms: held.last_checked_ms + 1 })
    ).toThrow("active clocks");
    expect(() =>
      validateCapacityRecord({
        ...held,
        lease: { ...held.lease, lease_epoch: Number.MAX_SAFE_INTEGER + 1 },
      })
    ).toThrow("lease projection");
  });
  it("refuses schema version drift during ordinary accounting without mutation", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("version-drift");
    const held = core.reserve(op.request);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      label: "fixture drift",
      mode: "existing",
    });
    db.db.exec("PRAGMA user_version=3");
    expect(() => core.inspect(op.record.operation_record_id)).toThrow("schema 4");
    expect(() => core.clockStatus(op.record.operation_record_id)).toThrow("schema 4");
    expect(db.db.prepare("SELECT revision FROM host_capacity_records").get()?.revision).toBe(
      held.revision
    );
  });
  it("holds all resources across independent connections and projects, with distinct-resource progress", () => {
    using f = new CapacityFixture();
    const one = f.core();
    const two = f.core();
    const a = f.operation("atomic-a", "video-a", 0, 60);
    const b = f.operation("atomic-b", "video-b", 1, 60);
    const c = f.operation("atomic-c", "video-c", 1, 60);
    expect(one.reserve(a.request).state).toBe("held");
    const blocked = two.reserve(b.request);
    expect(blocked.state).toBe("queued");
    expect(blocked.active_started_ms).toBeNull();
    expect(two.reserve(c.request).state).toBe("held");
    expect(one.inspect(b.record.operation_record_id)).toEqual(blocked);
  });
  it("does not partially hold a free resource when another resource is saturated", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const a = f.operation("partial-a", "video-a");
    a.request.demands.forEach((x) => {
      x.meters = meters(x.resource_id === "store-a" ? 80 : 0);
    });
    core.reserve(a.request);
    const b = f.operation("partial-b", "video-b");
    b.request.demands.forEach((x) => {
      x.meters = meters(x.resource_id === "store-a" ? 1 : 80);
    });
    expect(core.reserve(b.request).state).toBe("queued");
    const voice = f.operation("partial-voice", "voice-a", 1, 0);
    // An earlier overlapping queue head blocks voice, but no slots/units were held by b.
    f.now += 501;
    const expired = core.tryAdmit(b.record.operation_record_id, 1);
    expect(expired.state).toBe("expired");
    expect(core.reserve(voice.request).state).toBe("held");
  });
  it.each(CAPACITY_METERS)(
    "atomically saturates %s without spending reservation units",
    (meter) => {
      using f = new CapacityFixture();
      const core = f.core();
      const a = f.operation(`meter-a-${meter}`, "video-a", 0, 0);
      const b = f.operation(`meter-b-${meter}`, "video-b", 1, 0);
      for (const demand of a.request.demands) demand.meters[meter] = 80;
      for (const demand of b.request.demands) demand.meters[meter] = 1;
      const held = core.reserve(a.request);
      expect(held.snapshot).toBeNull();
      expect(core.reserve(b.request).state).toBe("queued");
      expect(core.inspect(a.record.operation_record_id)?.request.demands).toEqual(
        a.request.demands
      );
    }
  );
  it("protects finish meters and slots without accepting a caller-selected finish purpose", () => {
    const policy = capacityPolicy();
    for (const resource of policy.resources) resource.protected_finish_slots = 1;
    using f = new CapacityFixture(policy);
    const core = f.core();
    const a = f.operation("finish-work", "video-a", 0, 80);
    const b = f.operation("finish-block", "video-b", 1, 1);
    const finish = f.operation("finish-final", "finish-a", 1, 20);
    expect(core.reserve(a.request).state).toBe("held");
    expect(core.reserve(b.request).state).toBe("queued");
    // FIFO overlapping waiter remains ahead. Expire it, without releasing the active work.
    f.now += 501;
    core.tryAdmit(b.record.operation_record_id, 1);
    expect(core.reserve(finish.request).state).toBe("held");
    expect(() => core.reserve({ ...b.request, purpose: "finish" })).toThrow();
  });
  it("keeps one worker identity across image/video profiles and voice on shared GPU capacity", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const video = f.operation("profiles-video", "video-a", 0, 60);
    core.reserve(video.request);
    const image = f.operation("profiles-image", "image-a", 1, 60);
    expect(image.record.lifecycle).toBe("prepared");
    expect(() => core.reserve(image.request)).toThrow("pre-submission");
    expect(image.leaseRequest.backend_key_sha256).toBe(video.leaseRequest.backend_key_sha256);
    const voice = f.operation("profiles-voice", "voice-a", 1, 60);
    expect(core.reserve(voice.request).state).toBe("queued");
    expect(voice.leaseRequest.backend_key_sha256).not.toBe(video.leaseRequest.backend_key_sha256);
  });
  it("binds two opt-in video profiles without reinterpreting retained endpoint/profile keys", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const mapping = ["one", "two"].map((profile_id) => ({
      profile_id,
      profile_sha256: sha256(profile_id),
      operation_kind: "video_render",
      capacity_binding_id: "video-a",
    }));
    const scheduler = new VideogenCapacitySchedulerBinding(core, mapping);
    const op = f.operation("binding-seam");
    const input = {
      profile_id: "one",
      profile_sha256: sha256("one"),
      operation_kind: "video_render",
      project_id: op.project.projectId,
      operation_record_id: op.record.operation_record_id,
      demands: op.request.demands,
    };
    expect(scheduler.reserve(input).effect_permission).toBe("none");
    expect(
      scheduler.requestFor({ ...input, profile_id: "two", profile_sha256: sha256("two") })
    ).toEqual(op.request);
    expect(() => scheduler.requestFor({ ...input, profile_sha256: sha256("changed") })).toThrow(
      "stale"
    );
    expect(() => scheduler.requestFor({ ...input, profile_id: "missing" })).toThrow("absent");
    expect(hostCapacityWorkerKey("worker-a")).not.toBe(
      sha256(canonicalJson({ endpoint: "synthetic", profile_id: "one" }))
    );
    const stored = core.inspect(op.record.operation_record_id);
    expect(stored?.lease.backend_key_sha256).toBe(hostCapacityWorkerKey("worker-a"));
  });
  it("charges cumulative snapshots exactly once, retains spent units, releases only unused amounts", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const a = f.operation("accounting-a", "video-a", 0, 80);
    let held = core.reserve(a.request);
    f.submit(a);
    f.snapshot(a, 30);
    held = core.account(a.record.operation_record_id, held.revision);
    expect(core.account(a.record.operation_record_id, held.revision)).toEqual(held);
    f.snapshot(a, 40, 2);
    held = core.account(a.record.operation_record_id, held.revision);
    f.disposition(a, TERMINAL);
    f.snapshot(a, 40, 3, "final");
    held = core.account(a.record.operation_record_id, held.revision);
    const settled = core.settle(a.record.operation_record_id, held.revision);
    expect(core.settle(a.record.operation_record_id, settled.revision)).toEqual(settled);
    expect(settled.snapshot?.readings[0]?.meters.cost_microcredits).toBe(40);
    const b = f.operation("accounting-b", "video-b", 1, 40);
    expect(core.reserve(b.request).state).toBe("held");
    const c = f.operation("accounting-voice", "voice-a", 1, 1);
    expect(core.reserve(c.request).state).toBe("queued");
  });
  it.each(["revision", "decrease", "overflow", "incomplete", "fence", "identity"])(
    "refuses measurement %s and rolls back its ledger",
    (attack) => {
      using f = new CapacityFixture();
      const core = f.core();
      const op = f.operation(`measurement-${attack}`);
      let held = core.reserve(op.request);
      f.submit(op);
      f.snapshot(op, 10);
      held = core.account(op.record.operation_record_id, held.revision);
      const next = f.snapshot(op, 12, 2);
      if (attack === "revision") next.source_revision = 1;
      if (attack === "decrease")
        next.readings.forEach((x) => {
          x.meters.cost_microcredits = 9;
        });
      if (attack === "overflow")
        next.readings.forEach((x) => {
          x.meters.engine_steps = 21;
        });
      if (attack === "incomplete") next.readings.pop();
      if (attack === "fence")
        next.lease = { ...next.lease, fencing_token_sha256: sha256("wrong-fence") };
      if (attack === "identity") next.request_sha256 = sha256("wrong-request");
      expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow();
      expect(core.inspect(op.record.operation_record_id)).toEqual(held);
      using db = new OwnerSqliteDatabase({
        directory: f.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        label: "fixture catalog",
        mode: "existing",
      });
      expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_snapshots").get()?.n).toBe(1);
    }
  );
  it("refuses settlement without real exact disposition and final measured snapshots", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("proof-controls");
    let held = core.reserve(op.request);
    f.submit(op);
    expect(() => core.settle(op.record.operation_record_id, held.revision)).toThrow("proof absent");
    f.snapshot(op, 5, 1, "final");
    expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow(
      "disposition proof"
    );
    f.snapshot(op, 5);
    held = core.account(op.record.operation_record_id, held.revision);
    f.disposition(op, TERMINAL);
    expect(() => core.settle(op.record.operation_record_id, held.revision)).toThrow(
      "final measured"
    );
    f.snapshot(op, 5, 2, "final");
    held = core.account(op.record.operation_record_id, held.revision);
    expect(core.settle(op.record.operation_record_id, held.revision).state).toBe("settled");
  });
  it("releases never-submitted work only from exact lease non-acceptance proof", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("never-submitted");
    let held = core.reserve(op.request);
    f.now += 2_000;
    expect(core.clockStatus(op.record.operation_record_id).active_inactivity_expired).toBe(true);
    expect(() => core.settle(op.record.operation_record_id, held.revision)).toThrow("proof absent");
    f.disposition(op, NEVER);
    f.snapshot(op, 0, 1, "final");
    held = core.account(op.record.operation_record_id, held.revision);
    expect(core.settle(op.record.operation_record_id, held.revision).state).toBe("settled");
  });
  it("quarantines remote-unknown holds across restart with no timer or operator-reset release", () => {
    using f = new CapacityFixture();
    const one = f.core();
    const op = f.operation("quarantine-a", "video-a", 0, 80);
    let held = one.reserve(op.request);
    f.submit(op);
    f.disposition(op, UNKNOWN);
    held = one.settle(op.record.operation_record_id, held.revision);
    one.close();
    f.now += 200_000;
    const two = f.core();
    expect(two.inspect(op.record.operation_record_id)).toEqual(held);
    const voice = f.operation("quarantine-voice", "voice-a", 1, 1);
    expect(two.reserve(voice.request).state).toBe("queued");
    const separate = f.operation("quarantine-distinct", "video-c", 1, 80);
    expect(two.reserve(separate.request).state).toBe("held");
    const poison = f.leases.inspect(op.leaseRequest.backend_key_sha256);
    if (poison.state !== "quarantined") throw new Error("quarantine expected");
    f.leases.resetQuarantine({
      backend_key_sha256: op.leaseRequest.backend_key_sha256,
      quarantine_id: poison.quarantine_id,
      disposition: "queue_inspected_empty",
      evidence_sha256: sha256("synthetic operator inspection"),
      now_ms: f.now,
    });
    expect(two.settle(op.record.operation_record_id, held.revision).state).toBe("quarantined");
    expect(two.inspect(op.record.operation_record_id)?.snapshot).toBeNull();
  });
  it("refuses stale backend fences and stale capacity revisions; adopts exact owner-reconciled fences without new clocks", () => {
    using f = new CapacityFixture();
    const one = f.core();
    const two = f.core();
    const op = f.operation("fenced-a");
    let held = one.reserve(op.request);
    f.snapshot(op, 5);
    held = one.account(op.record.operation_record_id, held.revision);
    f.submit(op, true);
    expect(() => two.requireHeld(op.record.operation_record_id, held.revision)).toThrow(
      "fence conflict"
    );
    const adopted = one.adoptFence(op.record.operation_record_id, held.revision);
    expect(adopted.lease.lease_epoch).toBe(held.lease.lease_epoch + 1);
    expect(adopted.last_milestone_ms).toBe(held.last_milestone_ms);
    expect(() => two.requireHeld(op.record.operation_record_id, held.revision)).toThrow(
      "stale revision"
    );
    held = two.requireHeld(op.record.operation_record_id, adopted.revision);
    expect(held.state).toBe("held");
    expect(() => f.leases.release(op.leaseRequest, adopted.lease, NEVER, null, f.now)).toThrow();
    const stale = { ...adopted.lease, fencing_token_sha256: sha256("stale") };
    expect(() => f.leases.renew(op.leaseRequest, stale, f.now)).toThrow("stale");
  });
  it("keeps FIFO for overlapping resources, skips expired queue heads, and starts active time only on admission", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const a = f.operation("queue-a", "video-a", 0, 80);
    const active = core.reserve(a.request);
    const b = f.operation("queue-b", "video-b", 1, 40);
    let queued = core.reserve(b.request);
    f.now += 300;
    const voice = f.operation("queue-c", "voice-a", 1, 1);
    const later = core.reserve(voice.request);
    expect(later.state).toBe("queued");
    f.disposition(a, NEVER);
    f.snapshot(a, 0, 1, "final");
    const accounted = core.account(a.record.operation_record_id, active.revision);
    core.settle(a.record.operation_record_id, accounted.revision);
    expect(core.tryAdmit(voice.record.operation_record_id, later.revision).state).toBe("queued");
    queued = core.tryAdmit(b.record.operation_record_id, queued.revision);
    expect(queued.state).toBe("held");
    expect(queued.active_started_ms).toBe(f.now);
    expect(queued.last_milestone_ms).toBe(f.now);
    expect(
      core.tryAdmit(
        voice.record.operation_record_id,
        requireValue(core.inspect(voice.record.operation_record_id), "later queue").revision
      ).state
    ).toBe("held");
  });
  it("bounds queue depth, project/global concurrency, lifetime admission and snapshot ledger", () => {
    const policy = capacityPolicy();
    policy.max_active = 1;
    policy.max_active_per_project = 1;
    policy.max_queued = 1;
    policy.max_queued_per_project = 1;
    policy.max_admissions = 3;
    policy.max_admissions_per_project = 3;
    policy.max_snapshots_per_operation = 2;
    using f = new CapacityFixture(policy);
    const core = f.core();
    const a = f.operation("limits-a");
    let held = core.reserve(a.request);
    const b = f.operation("limits-b", "video-b", 1);
    expect(core.reserve(b.request).state).toBe("queued");
    const c = f.operation("limits-c", "video-c", 1);
    expect(() => core.reserve(c.request)).toThrow("queue limit");
    f.submit(a);
    f.snapshot(a, 1);
    held = core.account(a.record.operation_record_id, held.revision);
    f.snapshot(a, 2, 2);
    expect(() => core.account(a.record.operation_record_id, held.revision)).toThrow("ledger limit");
    expect(core.inspect(a.record.operation_record_id)).toEqual(held);
    f.disposition(a, TERMINAL);
    f.snapshot(a, 2, 3, "final");
    held = core.account(a.record.operation_record_id, held.revision);
    expect(core.settle(a.record.operation_record_id, held.revision).state).toBe("settled");
  });
  it("enforces per-project concurrency separately from global active limit", () => {
    const policy = capacityPolicy();
    policy.max_active = 2;
    policy.max_active_per_project = 1;
    using f = new CapacityFixture(policy);
    const core = f.core();
    expect(core.reserve(f.operation("project-first").request).state).toBe("held");
    expect(core.reserve(f.operation("project-second", "video-c").request).state).toBe("queued");
    expect(core.reserve(f.operation("project-other", "voice-a", 1).request).state).toBe("held");
  });
  it("enforces durable lifetime admissions after released capacity rather than pruning accounting", () => {
    const policy = capacityPolicy();
    policy.max_admissions = 2;
    policy.max_admissions_per_project = 2;
    using f = new CapacityFixture(policy);
    const core = f.core();
    for (const id of ["lifetime-one", "lifetime-two"]) {
      const op = f.operation(id);
      let held = core.reserve(op.request);
      f.disposition(op, NEVER);
      f.snapshot(op, 0, 1, "final");
      held = core.account(op.record.operation_record_id, held.revision);
      core.settle(op.record.operation_record_id, held.revision);
    }
    const third = f.operation("lifetime-three");
    expect(() => core.reserve(third.request)).toThrow("admission limit");
  });
  it("does not renew from polls, measured spend, heartbeat, generic activity expiry or transport trickle", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("clock-untrusted");
    let held = core.reserve(op.request);
    f.submit(op);
    for (let i = 0; i < 3; i += 1) {
      f.now += 300;
      f.leases.renew(op.leaseRequest, requireValue(op.record.lease, "heartbeat lease"), f.now);
      f.transition(op, {
        lifecycle: "submitted",
        progress_event_count: i + 1,
        operation_inactivity_expires_at_ms: f.now + 100_000,
      });
      held = core.observeMilestone(op.record.operation_record_id, held.revision);
      f.snapshot(op, i + 1, i + 1);
      held = core.account(op.record.operation_record_id, held.revision);
      expect(held.last_milestone_ms).toBe(1_000);
    }
    f.now += 100;
    expect(core.clockStatus(op.record.operation_record_id).active_inactivity_expired).toBe(true);
    expect(() => core.requireHeld(op.record.operation_record_id, held.revision)).toThrow(
      "active clock"
    );
    expect(core.inspect(op.record.operation_record_id)?.state).toBe("held");
  });
  it("renews only new durable typed output milestones and keeps explicit elapsed and cleanup clocks distinct", () => {
    const policy = capacityPolicy();
    policy.max_elapsed_ms = 1_500;
    using f = new CapacityFixture(policy);
    const core = f.core();
    const op = f.operation("clock-milestones");
    let held = core.reserve(op.request);
    f.submit(op);
    f.now += 900;
    f.transition(op, {
      lifecycle: "fetched",
      fetched: {
        schema_version: 1,
        content_sha256: sha256("output"),
        byte_length: 6,
        item_count: 1,
        poll_count: 100,
      },
    });
    held = core.observeMilestone(op.record.operation_record_id, held.revision);
    expect(held.last_milestone_ms).toBe(1_900);
    f.now += 500;
    held = core.observeMilestone(op.record.operation_record_id, held.revision);
    expect(held.last_milestone_ms).toBe(1_900);
    expect(core.clockStatus(op.record.operation_record_id).active_inactivity_expired).toBe(false);
    held = core.beginCleanup(op.record.operation_record_id, held.revision);
    expect(core.clockStatus(op.record.operation_record_id).cleanup_expired).toBe(false);
    f.now += 100;
    expect(core.clockStatus(op.record.operation_record_id).explicit_elapsed_expired).toBe(true);
    expect(core.clockStatus(op.record.operation_record_id).cleanup_expired).toBe(false);
    f.now += 100;
    expect(core.clockStatus(op.record.operation_record_id).cleanup_expired).toBe(true);
    expect(() => core.settle(op.record.operation_record_id, held.revision)).toThrow("proof absent");
  });
  it("does not grant fresh inactivity on connection/process restart or backward clocks", () => {
    using f = new CapacityFixture();
    const one = f.core();
    const op = f.operation("clock-restart");
    const held = one.reserve(op.request);
    one.close();
    f.now += 1_000;
    const two = f.core();
    expect(() => two.requireHeld(op.record.operation_record_id, held.revision)).toThrow(
      "active clock"
    );
    f.now = 999;
    expect(() => two.clockStatus(op.record.operation_record_id)).toThrow("clock regression");
    expect(() => two.beginCleanup(op.record.operation_record_id, held.revision)).toThrow(
      "clock regression"
    );
  });
  it.each([
    "extra",
    "missing-meter",
    "negative",
    "fraction",
    "overflow",
    "duplicate",
    "missing-resource",
    "wrong-project",
    "unknown-binding",
  ])("fails closed on malformed %s input", (attack) => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation(`malformed-${attack}`);
    let input: unknown = structuredClone(op.request);
    if (attack === "extra") input = { ...op.request, remote_never_accepted: true };
    if (attack === "missing-meter")
      input = {
        ...op.request,
        demands: [{ resource_id: "gpu-a", slots: 1, meters: { gpu_milliseconds: 1 } }],
      };
    if (attack === "negative" || attack === "fraction" || attack === "overflow")
      input = {
        ...op.request,
        demands: op.request.demands.map((x) => ({
          ...x,
          meters: {
            ...x.meters,
            attempts:
              attack === "negative"
                ? -1
                : attack === "fraction"
                  ? 1.5
                  : Number.MAX_SAFE_INTEGER + 1,
          },
        })),
      };
    if (attack === "duplicate")
      input = {
        ...op.request,
        demands: [
          requireValue(op.request.demands[0], "demand"),
          requireValue(op.request.demands[0], "demand"),
        ],
      };
    if (attack === "missing-resource")
      input = { ...op.request, demands: op.request.demands.slice(0, 1) };
    if (attack === "wrong-project")
      input = { ...op.request, project_id: requireValue(f.projects[1], "other project").projectId };
    if (attack === "unknown-binding") input = { ...op.request, binding_id: "missing" };
    expect(() => core.reserve(input)).toThrow();
    expect(core.inspect(op.record.operation_record_id)).toBeUndefined();
  });
  it("refuses absent authority, policy drift, external-work claims, topology aliases and corrupted catalog bytes", () => {
    using f = new CapacityFixture();
    const op = f.operation("authority-controls");
    const core = f.core();
    const held = core.reserve(op.request);
    expect(
      () =>
        new HostOperationCapacityAuthority({
          stateRoot: f.stateRoot,
          policy: f.policy,
          projects: [],
        })
    ).toThrow("authority missing");
    expect(() =>
      f.core([requireValue(f.projects[1], "other").authority]).reserve(op.request)
    ).toThrow("authority absent");
    expect(() =>
      HostOperationCapacityAuthority.configure(f.stateRoot, { ...f.policy, max_active: 9 })
    ).toThrow("immutable");
    expect(() =>
      validateCapacityPolicy({ ...f.policy, external_work_policy: "accounted_by_caller" })
    ).toThrow();
    expect(() =>
      validateCapacityPolicy({
        ...f.policy,
        bindings: [
          ...f.policy.bindings,
          {
            ...requireValue(f.policy.bindings[0], "binding"),
            binding_id: "lying-profile",
            resource_ids: ["gpu-b", "store-b"],
          },
        ],
      })
    ).toThrow("topology conflicts");
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      label: "fixture corruption",
      mode: "existing",
    });
    db.db
      .prepare("UPDATE host_capacity_records SET record_sha256 = ? WHERE operation_record_id = ?")
      .run(sha256("corrupt"), op.record.operation_record_id);
    expect(() => core.inspect(held.request.operation_record_id)).toThrow("digest diverges");
  });
  it("rolls back snapshot insertion if the record write fails", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const op = f.operation("rollback-accounting");
    const held = core.reserve(op.request);
    f.submit(op);
    f.snapshot(op, 10);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      label: "fixture rollback",
      mode: "existing",
    });
    db.db.exec(
      "CREATE TRIGGER capacity_fixture_fault BEFORE UPDATE ON host_capacity_records BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
    );
    expect(() => core.account(op.record.operation_record_id, held.revision)).toThrow(
      "fixture rollback"
    );
    expect(core.inspect(op.record.operation_record_id)).toEqual(held);
    expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_snapshots").get()?.n).toBe(0);
  });
  it("bounds deep/cyclic input, missing meters, unordered resources and SQL-like identifiers", () => {
    using f = new CapacityFixture();
    const op = f.operation("complexity");
    const cycle: Record<string, unknown> = {};
    cycle["cycle"] = cycle;
    expect(() => validateCapacityRequest(cycle)).toThrow("complexity");
    expect(() =>
      validateCapacityRequest({ ...op.request, demands: [...op.request.demands].reverse() })
    ).toThrow("ordered");
    expect(() =>
      validateCapacityRequest({ ...op.request, binding_id: "'; DROP TABLE projects;--" })
    ).toThrow();
  });
});
