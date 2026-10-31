import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import { HostOperationCapacityAuthority } from "../dist/host-operations/capacity-authority.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME } from "../dist/state/paths.js";
import { CapacityFixture, capacityPolicy } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  capacityDemandSource,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

function crashAt(point: HostOperationFaultPointV1) {
  return (candidate: HostOperationFaultPointV1): void => {
    if (candidate === point) throw new HostOperationSimulatedCrashError(candidate);
  };
}
function clock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
}
function demands(f: CapacityRuntimeFixture): void {
  const a = capacityDemandSource("video-a", 20);
  const b = capacityDemandSource("video-b", 70);
  const c = capacityDemandSource("video-c", 20);
  f.demands = {
    requestFor: (input) => {
      const key = input.directive.policy_binding.backend_key_sha256;
      const policy = capacityPolicy();
      const workerB = requireValue(
        policy.bindings.find((x) => x.binding_id === "video-b"),
        "binding b"
      );
      const workerC = requireValue(
        policy.bindings.find((x) => x.binding_id === "video-c"),
        "binding c"
      );
      // Select exact fixture workers by their existing generic key contract.
      if (key === hostCapacityWorkerKey(workerB.worker_id)) return b.requestFor(input);
      if (key === hostCapacityWorkerKey(workerC.worker_id)) return c.requestFor(input);
      return a.requestFor(input);
    },
  };
}
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
async function blocked(f: CapacityRuntimeFixture) {
  demands(f);
  const first = f.prepare("parking-blocker");
  await expect(
    f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, first)
  ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
  return { first, second: f.prepare("parking-waiter", "worker-b") };
}
function catalog(f: CapacityRuntimeFixture): OwnerSqliteDatabase {
  return new OwnerSqliteDatabase({
    directory: f.config.stateRoot,
    databaseName: CATALOG_DATABASE_NAME,
    mode: "existing",
    label: "parking verification catalog",
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("durable capacity parking and fresh fenced reacquisition", () => {
  it("frees the exact fence without disposition, preserves queue order/deadlines and admits once after capacity is free", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await blocked(f);
    const done = f.owner().dispatch(f.engine, second);
    await vi.advanceTimersByTimeAsync(1);
    const journal = f.record(second);
    const parked = requireValue(f.capacity.runtimeRecord(journal.operation_record_id), "parked V2");
    expect(parked.parked).toBe(true);
    expect(journal).toMatchObject({
      lifecycle: "lease_acquired",
      disposition: null,
      remote_correlation_id: null,
    });
    expect(parked.core).toMatchObject({
      state: "queued",
      active_started_ms: null,
      last_milestone_ms: null,
      snapshot: null,
    });
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.leases.dispositionForOperation(journal.operation_record_id)).toBeUndefined();
    using db = catalog(f);
    expect(
      db.db
        .prepare("SELECT count(*) AS n FROM host_operation_queue WHERE operation_record_id = ?")
        .get(journal.operation_record_id)?.n
    ).toBe(0);
    // A separate connection can write while the owner waits: no SQLite lock spans the wait.
    db.transaction(() => db.db.prepare("UPDATE projects SET updated_at = updated_at").run());
    await vi.advanceTimersByTimeAsync(39);
    expect((await f.owner().dispatch(f.engine, first)).action).toBe("await_user");
    await vi.advanceTimersByTimeAsync(21);
    expect((await done).action).toBe("await_user");
    const after = requireValue(
      f.capacity.runtimeRecord(journal.operation_record_id),
      "admitted V2"
    );
    expect(after.core).toMatchObject({
      state: "settled",
      created_ms: parked.core.created_ms,
      queue_expires_ms: parked.core.queue_expires_ms,
      request: parked.core.request,
    });
    expect(after.core.active_started_ms).toBeGreaterThan(parked.core.created_ms);
    expect(after.parking).toEqual(parked.parking);
    expect(after.parked).toBe(false);
    expect(after.core.lease.lease_id).not.toBe(parked.core.lease.lease_id);
    expect(f.counter.submissions).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "capacity_queued",
    "after_capacity_park",
    "after_capacity_reacquire",
    "before_capacity_admit",
    "after_capacity_admit",
  ] as const)("recovers the practical %s crash window from reopened real stores", async (point) => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await blocked(f);
    const failure = f.owner({ fault: crashAt(point) }).dispatch(f.engine, second);
    const rejection = expect(failure).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    if (
      ["after_capacity_reacquire", "before_capacity_admit", "after_capacity_admit"].includes(point)
    ) {
      await vi.advanceTimersByTimeAsync(30);
      await f.owner().dispatch(f.engine, first);
      await vi.advanceTimersByTimeAsync(21);
    }
    await rejection;
    const old = requireValue(
      f.capacity.inspect(f.record(second).operation_record_id),
      "old queued demand"
    );
    f.reopen();
    const recovered = f.owner().dispatch(f.engine, second);
    if (point === "capacity_queued" || point === "after_capacity_park") {
      await vi.advanceTimersByTimeAsync(20);
      await f.owner().dispatch(f.engine, first);
      await vi.advanceTimersByTimeAsync(21);
    }
    expect((await recovered).action).toBe("await_user");
    expect(f.counter.submissions).toBe(2);
    const after = requireValue(
      f.capacity.inspect(f.record(second).operation_record_id),
      "recovered capacity"
    );
    expect(after.request).toEqual(old.request);
    expect(after.created_ms).toBe(old.created_ms);
    expect(after.queue_expires_ms).toBe(old.queue_expires_ms);
    if (old.active_started_ms !== null) expect(after.active_started_ms).toBe(old.active_started_ms);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("status");
    expect(f.counter.submissions).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "cancel",
    "expiry",
    "cancel-after-fresh-acquire",
    "expiry-after-fresh-acquire",
  ] as const)(
    "settles parked restart %s without adapter entry, fresh capacity clocks or freeing another owner",
    async (boundary) => {
      clock();
      using f = new CapacityRuntimeFixture();
      const { first, second } = await blocked(f);
      const point = boundary.includes("fresh") ? "after_capacity_reacquire" : "after_capacity_park";
      const initial = f.owner({ fault: crashAt(point) }).dispatch(f.engine, second);
      const rejection = expect(initial).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      if (point === "after_capacity_reacquire") {
        await vi.advanceTimersByTimeAsync(20);
        await f.owner().dispatch(f.engine, first);
        await vi.advanceTimersByTimeAsync(21);
      }
      await rejection;
      const before = requireValue(
        f.capacity.inspect(f.record(second).operation_record_id),
        "parked demand"
      );
      f.reopen();
      const controller = new AbortController();
      if (boundary.startsWith("expiry")) vi.setSystemTime(10_600);
      else controller.abort();
      expect((await f.owner().dispatch(f.engine, second, controller.signal)).action).toBe(
        "await_user"
      );
      const after = requireValue(
        f.capacity.inspect(f.record(second).operation_record_id),
        "retired demand"
      );
      expect(after).toMatchObject({
        state: "expired",
        request: before.request,
        created_ms: before.created_ms,
        queue_expires_ms: before.queue_expires_ms,
        active_started_ms: null,
        snapshot: null,
      });
      expect(f.record(second).disposition?.outcome).toBe(
        boundary.startsWith("expiry") ? "timed_out" : "cancelled"
      );
      expect(f.counter.submissions).toBe(point === "after_capacity_reacquire" ? 1 : 0);
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("does not let a parked waiter monopolize its backend FIFO or unrelated workers", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { second } = await blocked(f);
    await expect(
      f.owner({ fault: crashAt("after_capacity_park") }).dispatch(f.engine, second)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const journal = f.record(second);
    const competitor = {
      operation_record_id: `hop_${sha256("independent backend operator")}`,
      backend_key_sha256: second.policy_binding.backend_key_sha256,
      project_id: journal.project_id,
      run_id: "independent",
      state_id: "independent",
      attempt: 1,
      operation_id: "independent",
      registration_sha256: journal.registration_sha256,
      request_sha256: journal.request_sha256,
      duration_ms: 500,
      queue_inactivity_expires_at_ms: 11_000,
    };
    const acquired = f.leases.tryAcquire(competitor, Date.now());
    expect(acquired.kind).toBe("acquired");
    const distinct = f.prepare("independent-worker", "worker-c");
    expect((await f.owner().dispatch(f.engine, distinct)).action).toBe("await_user");
    const controller = new AbortController();
    controller.abort();
    await f.owner().dispatch(f.engine, second, controller.signal);
    expect(f.leases.ownedActive(competitor)?.lease).toEqual(
      acquired.kind === "acquired" ? acquired.active.lease : undefined
    );
    expect(f.counter.submissions).toBe(1);
  });

  it("refuses changed parked demand before reacquisition and retains exact recovery evidence", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { second } = await blocked(f);
    await expect(
      f.owner({ fault: crashAt("after_capacity_park") }).dispatch(f.engine, second)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const prior = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "prior parked"
    );
    f.demands = capacityDemandSource("video-b", 71);
    await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
    expect(f.capacity.runtimeRecord(f.record(second).operation_record_id)).toEqual(prior);
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.counter.submissions).toBe(0);
  });

  it("rolls back parking proof, backend free and event together on failed catalog write", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserveRuntime(f.operation("atomic-block", "video-a", 0, 70).request);
    const queued = f.operation("atomic-park", "video-b", 1, 70);
    const record = core.reserveRuntime(queued.request);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "parking crash transaction",
    });
    db.db.exec(
      "CREATE TRIGGER parking_fault BEFORE UPDATE ON host_capacity_records BEGIN SELECT RAISE(ABORT, 'parking crash'); END"
    );
    expect(() => core.park(queued.record.operation_record_id, record.revision)).toThrow(
      "parking crash"
    );
    expect(core.runtimeRecord(queued.record.operation_record_id)?.parked).toBe(false);
    expect(f.leases.inspect(queued.leaseRequest.backend_key_sha256).state).toBe("active");
    expect(db.db.prepare("SELECT count(*) AS n FROM host_backend_lease_events").get()?.n).toBe(0);
    expect(f.leases.dispositionForOperation(queued.record.operation_record_id)).toBeUndefined();
  });

  it("accepts a lower fresh epoch only with exact durable parking proof, and rejects the old token", () => {
    using f = new CapacityFixture();
    const core = f.core();
    const blocker = f.operation("epoch-blocker", "video-a", 0, 70);
    const held = core.reserveRuntime(blocker.request);
    const queued = f.operation("epoch-parked", "video-b", 1, 70);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "nonmonotonic fence fixture",
    });
    const lease = requireValue(queued.record.lease, "old lease");
    db.db
      .prepare("UPDATE host_backend_leases SET lease_epoch = 9 WHERE backend_key_sha256 = ?")
      .run(lease.backend_key_sha256);
    f.transition(queued, { lease: { ...lease, lease_epoch: 9 } });
    let record = core.reserveRuntime(queued.request);
    record = core.park(queued.record.operation_record_id, record.revision);
    f.disposition(blocker, {
      outcome: "cancelled",
      remote_disposition: "proven_not_accepted",
      lease_disposition: "released",
      retryable: false,
      reason_code: "fixture_stop",
    });
    f.snapshot(blocker, 0, 1, "final");
    const measured = core.account(blocker.record.operation_record_id, held.revision);
    core.settle(blocker.record.operation_record_id, measured.revision);
    f.acquire(queued);
    expect(queued.record.lease?.lease_epoch).toBe(1);
    record = core.reacquire(queued.record.operation_record_id, record.revision);
    expect(record.state).toBe("held");
    expect(() =>
      f.leases.guardSubmission(queued.leaseRequest, { ...lease, lease_epoch: 9 }, f.now)
    ).toThrow(/stale/u);
  });

  it.each(["terminal", "accepted", "missing-proof", "stale-revision"] as const)(
    "refuses %s parking/reacquisition without a replacement grant",
    (attack) => {
      using f = new CapacityFixture();
      const core = f.core();
      core.reserveRuntime(f.operation("negative-block", "video-a", 0, 70).request);
      const queued = f.operation(`negative-${attack}`, "video-b", 1, 70);
      let record = core.reserveRuntime(queued.request);
      if (attack === "terminal") {
        f.disposition(queued, {
          outcome: "cancelled",
          remote_disposition: "proven_not_accepted",
          lease_disposition: "released",
          retryable: false,
          reason_code: "fixture_stop",
        });
        expect(() => core.park(queued.record.operation_record_id, record.revision)).toThrow();
      } else if (attack === "accepted") {
        f.submit(queued);
        expect(() => core.park(queued.record.operation_record_id, record.revision)).toThrow();
      } else {
        record = core.park(queued.record.operation_record_id, record.revision);
        if (attack === "missing-proof") {
          using db = new OwnerSqliteDatabase({
            directory: f.stateRoot,
            databaseName: CATALOG_DATABASE_NAME,
            mode: "existing",
            label: "missing exact parking evidence",
          });
          db.db
            .prepare("DELETE FROM host_backend_lease_events WHERE operation_record_id = ?")
            .run(queued.record.operation_record_id);
          expect(() => core.readyToReacquire(queued.record.operation_record_id)).toThrow(/proof/u);
        } else
          expect(() =>
            core.reacquire(queued.record.operation_record_id, record.revision - 1)
          ).toThrow(/stale revision/u);
      }
    }
  );

  it("reads/replays exact legacy V1 bytes and refuses implicit legacy parking upgrade", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserve(f.operation("legacy-block", "video-a", 0, 70).request);
    const queued = f.operation("legacy-queue", "video-b", 1, 70);
    const record = core.reserve(queued.request);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "exact legacy replay",
    });
    const before = db.db
      .prepare("SELECT record_jcs FROM host_capacity_records WHERE operation_record_id = ?")
      .get(queued.record.operation_record_id);
    expect(() => core.park(queued.record.operation_record_id, record.revision)).toThrow(
      /legacy bytes/u
    );
    expect(core.reserveRuntime(queued.request)).toEqual(record);
    expect(core.inspect(queued.record.operation_record_id)).toEqual(record);
    expect(
      db.db
        .prepare("SELECT record_jcs FROM host_capacity_records WHERE operation_record_id = ?")
        .get(queued.record.operation_record_id)
    ).toEqual(before);
    using fresh = new HostOperationCapacityAuthority({
      stateRoot: f.stateRoot,
      policy: f.policy,
      projects: f.projects.map((x) => x.authority),
      now: () => f.now,
    });
    expect(canonicalJson(fresh.inspect(queued.record.operation_record_id))).toBe(
      canonicalJson(record)
    );
    expect(fresh.runtimeRecord(queued.record.operation_record_id)).toBeUndefined();
    using leases = new HostOperationLeaseAuthority(f.stateRoot);
    expect(leases.dispositionForOperation(queued.record.operation_record_id)).toBeUndefined();
  });
});
