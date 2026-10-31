import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import {
  capacityParkingJournalBinding,
  type HostCapacityParkingProofV1,
} from "../dist/host-operations/capacity-runtime-contracts.js";
import { capacityJson } from "../dist/host-operations/capacity-contracts.js";
import { sha256 } from "../dist/canonical-json.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME } from "../dist/state/paths.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  capacityDemandSource,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";
import type { HostOperationCallRecordV1 } from "../dist/host-operations/contracts.js";
import type { HostCapacityRuntimeRecordV2 } from "../dist/host-operations/capacity-runtime-contracts.js";

function expectOriginalQueue(
  after: HostCapacityRuntimeRecordV2,
  before: HostCapacityRuntimeRecordV2
): void {
  expect(after).toMatchObject({
    parked: true,
    parking: before.parking,
    productive_count: 0,
    productive: null,
    core: {
      state: "queued",
      request: before.core.request,
      lease: before.core.lease,
      created_ms: before.core.created_ms,
      queue_expires_ms: before.core.queue_expires_ms,
      active_started_ms: null,
      last_milestone_ms: null,
      milestone: "none",
      cleanup_started_ms: null,
      snapshot: null,
      disposition_receipt_id: null,
    },
  });
}
function expectNoBackendQueue(f: CapacityRuntimeFixture, journal: HostOperationCallRecordV1): void {
  using db = new OwnerSqliteDatabase({
    directory: f.config.stateRoot,
    databaseName: CATALOG_DATABASE_NAME,
    mode: "existing",
    label: "compensation queue verification",
  });
  expect(
    db.db
      .prepare("SELECT count(*) AS n FROM host_operation_queue WHERE operation_record_id = ?")
      .get(journal.operation_record_id)?.n
  ).toBe(0);
  expect(
    db.db
      .prepare("SELECT count(*) AS n FROM host_capacity_snapshots WHERE operation_record_id = ?")
      .get(journal.operation_record_id)?.n
  ).toBe(0);
}

function crashAt(point: HostOperationFaultPointV1) {
  return (candidate: HostOperationFaultPointV1): void => {
    if (candidate === point) throw new HostOperationSimulatedCrashError(candidate);
  };
}
function clock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
}
async function queue(f: CapacityRuntimeFixture) {
  const a = capacityDemandSource("video-a", 20);
  const b = capacityDemandSource("video-b", 70);
  let drift = false;
  f.demands = {
    requestFor(input) {
      const demand = (input.directive.identity.run_id === "blocker" ? a : b).requestFor(input);
      return drift && input.directive.identity.run_id !== "blocker"
        ? capacityDemandSource("video-b", 71).requestFor(input)
        : demand;
    },
  };
  const first = f.prepare("blocker");
  await expect(
    f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, first)
  ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
  const second = f.prepare("waiter", "worker-b");
  return {
    first,
    second,
    drift: () => {
      drift = true;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("capacity queue authority at asynchronous boundaries", () => {
  it("cannot skip use validation when an independent release changes a readiness hint", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    await expect(
      f.owner({ fault: crashAt("after_capacity_park") }).dispatch(f.engine, second)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    await f.owner().dispatch(f.engine, first);
    const before = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "original parked proof"
    );
    // A stale negative hint is legitimate and grants nothing. The next real read sees free resources.
    vi.spyOn(f.capacity, "readyToReacquire").mockReturnValueOnce(false);
    let checks = 0;
    const done = f
      .owner({
        useValidator: {
          validateUse() {
            checks += 1;
            if (checks > 1) throw new Error("reacquisition revoked");
          },
        },
      })
      .dispatch(f.engine, second);
    const rejection = expect(done).rejects.toThrow(/reacquisition revoked/u);
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(checks).toBe(2);
    expect(f.capacity.runtimeRecord(f.record(second).operation_record_id)).toEqual(before);
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["revocation", "demand-drift"] as const)(
    "refuses live %s after parking, before a fresh fence or hold",
    async (attack) => {
      clock();
      using f = new CapacityRuntimeFixture();
      const { first, second, drift } = await queue(f);
      let revoked = false;
      let checks = 0;
      const done = f
        .owner({
          useValidator: {
            validateUse() {
              checks += 1;
              if (revoked) throw new Error("revoked current use");
            },
          },
        })
        .dispatch(f.engine, second);
      const rejection = expect(done).rejects.toThrow(
        attack === "revocation" ? /revoked current use/u : /selection conflict/u
      );
      await vi.advanceTimersByTimeAsync(1);
      const before = requireValue(
        f.capacity.runtimeRecord(f.record(second).operation_record_id),
        "parked demand"
      );
      expect(before.parked).toBe(true);
      await f.owner().dispatch(f.engine, first);
      if (attack === "revocation") revoked = true;
      else drift();
      await vi.advanceTimersByTimeAsync(21);
      await rejection;
      const after = requireValue(
        f.capacity.runtimeRecord(f.record(second).operation_record_id),
        "refused parked demand"
      );
      expect(after).toEqual(before);
      expect(f.record(second).lifecycle).toBe("lease_acquired");
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expect(checks).toBe(attack === "revocation" ? 2 : 1);
      expect(f.counter.submissions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("revalidates current use at actual adapter entry after fresh atomic admission", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    let checks = 0;
    const done = f
      .owner({
        useValidator: {
          validateUse() {
            checks += 1;
            if (checks === 3) throw new Error("entry revoked");
          },
        },
      })
      .dispatch(f.engine, second);
    // No final measurement is invented for a held-but-refused operation.
    const rejection = expect(done).rejects.toThrow(/final measured artifact/u);
    await vi.advanceTimersByTimeAsync(1);
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(checks).toBe(3);
    expect(f.counter.submissions).toBe(1);
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    const held = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "unsettled exact hold"
    );
    expect(held.core).toMatchObject({ state: "held", snapshot: null });
    expect(f.record(second)).toMatchObject({ lifecycle: "terminal", remote_correlation_id: null });
    f.measure(f.record(second), 0); // Explicit trusted fixture measurement, only after exact no-effect proof.
    f.reopen();
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("await_user");
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an uncooperative parked use validator by the original queue deadline and ignores late work", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    let checks = 0;
    let late: (() => void) | undefined;
    const done = f
      .owner({
        useValidator: {
          validateUse(input) {
            checks += 1;
            if (checks === 1) return;
            late = input.reportWorkMilestone;
            return new Promise<never>(() => undefined);
          },
        },
      })
      .dispatch(f.engine, second);
    const rejection = expect(done).rejects.toThrow(/inactivity expired/u);
    await vi.advanceTimersByTimeAsync(1);
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    const before = canonicalJson(f.capacity.runtimeRecord(f.record(second).operation_record_id));
    requireValue(late, "late validator activity")();
    await vi.advanceTimersByTimeAsync(10);
    expect(canonicalJson(f.capacity.runtimeRecord(f.record(second).operation_record_id))).toBe(
      before
    );
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    // Exact restart converges to timeout without acquiring or starting an active capacity clock.
    f.reopen();
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(second).operation_record_id)).toMatchObject({
      state: "expired",
      active_started_ms: null,
    });
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a stale fresh reacquisition fence atomically hold resources", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    const done = f
      .owner({
        fault(point) {
          if (point !== "before_capacity_admit") return;
          const journal = f.record(second);
          const lease = requireValue(journal.lease, "fresh reacquired lease");
          using db = new OwnerSqliteDatabase({
            directory: f.config.stateRoot,
            databaseName: CATALOG_DATABASE_NAME,
            mode: "existing",
            label: "fresh stale fence fixture",
          });
          db.db
            .prepare(
              "UPDATE host_backend_leases SET fencing_token_sha256 = ? WHERE backend_key_sha256 = ?"
            )
            .run(sha256("independent fresh fence"), lease.backend_key_sha256);
        },
      })
      .dispatch(f.engine, second);
    const rejection = expect(done).rejects.toThrow(/fence stale/u);
    await vi.advanceTimersByTimeAsync(1);
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(f.capacity.inspect(f.record(second).operation_record_id)).toMatchObject({
      state: "queued",
      active_started_ms: null,
      snapshot: null,
    });
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fresh reacquisition compensation", () => {
  it.each(["new", "recovered"] as const)(
    "compensates demand drift inside %s tryAcquire and converges while demand remains changed",
    async (path) => {
      clock();
      using f = new CapacityRuntimeFixture();
      const { first, second, drift } = await queue(f);
      if (path === "recovered") {
        const crashed = f
          .owner({ fault: crashAt("after_capacity_reacquire") })
          .dispatch(f.engine, second);
        const rejected = expect(crashed).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
        await vi.advanceTimersByTimeAsync(1);
        await f.owner().dispatch(f.engine, first);
        await vi.advanceTimersByTimeAsync(21);
        await rejected;
        f.reopen();
      }
      const acquire = f.leases.tryAcquire.bind(f.leases);
      let original: HostCapacityRuntimeRecordV2 | undefined;
      vi.spyOn(f.leases, "tryAcquire").mockImplementation((request, now) => {
        const result = acquire(request, now);
        if (
          request.run_id === second.identity.run_id &&
          (result.kind === "acquired" || result.kind === "adopted")
        ) {
          const stored = f.capacity.runtimeRecord(request.operation_record_id);
          if (stored?.parked) {
            original = stored;
            drift();
          }
        }
        return result;
      });
      const running = f.owner().dispatch(f.engine, second);
      const rejected = expect(running).rejects.toThrow(/selection conflict/u);
      if (path === "new") {
        await vi.advanceTimersByTimeAsync(1);
        await f.owner().dispatch(f.engine, first);
        await vi.advanceTimersByTimeAsync(21);
      }
      await rejected;
      const journal = f.record(second);
      const before = requireValue(original, "pre-drift original parked request");
      expectOriginalQueue(
        requireValue(f.capacity.runtimeRecord(journal.operation_record_id), "compensated queue"),
        before
      );
      expect(journal).toMatchObject({
        lifecycle: "lease_acquired",
        lease: before.core.lease,
        disposition: null,
        remote_correlation_id: null,
      });
      expect(f.leases.dispositionForOperation(journal.operation_record_id)).toBeUndefined();
      expectNoBackendQueue(f, journal);
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expect(f.counter.submissions).toBe(1);
      f.reopen();
      await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
      expect(f.record(second).lifecycle).toBe("terminal");
      expect(f.leases.dispositionForOperation(journal.operation_record_id)).toMatchObject({
        lease: before.core.lease,
        disposition: { lease_disposition: "released", remote_disposition: "proven_not_accepted" },
      });
      expectOriginalQueue(
        requireValue(f.capacity.runtimeRecord(journal.operation_record_id), "replayed queue"),
        before
      );
      await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expect(f.counter.submissions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(["after_capacity_reacquire", "before_capacity_admit"] as const)(
    "compensates a recovered %s crash before changed-demand validation can terminalize",
    async (point) => {
      clock();
      using f = new CapacityRuntimeFixture();
      const { first, second, drift } = await queue(f);
      const running = f.owner({ fault: crashAt(point) }).dispatch(f.engine, second);
      const rejected = expect(running).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      await vi.advanceTimersByTimeAsync(1);
      const original = requireValue(
        f.capacity.runtimeRecord(f.record(second).operation_record_id),
        "original parked queue"
      );
      await f.owner().dispatch(f.engine, first);
      await vi.advanceTimersByTimeAsync(21);
      await rejected;
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("active");
      drift();
      f.reopen();
      await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
      expectOriginalQueue(
        requireValue(
          f.capacity.runtimeRecord(f.record(second).operation_record_id),
          "recovered queue"
        ),
        original
      );
      expect(f.record(second)).toMatchObject({ lifecycle: "terminal", lease: original.core.lease });
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expectNoBackendQueue(f, f.record(second));
      await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
      expect(f.counter.submissions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    "inside-acquire",
    "after_capacity_reacquire",
    "before_capacity_admit",
    "lost-fit",
  ] as const)(
    "compensates a non-crash %s error without inventing a terminal release or refund",
    async (point) => {
      clock();
      using f = new CapacityRuntimeFixture();
      const { first, second } = await queue(f);
      const acquire = f.leases.tryAcquire.bind(f.leases);
      if (point === "inside-acquire")
        vi.spyOn(f.leases, "tryAcquire").mockImplementation((request, now) => {
          const result = acquire(request, now);
          if (
            request.run_id === second.identity.run_id &&
            f.capacity.runtimeRecord(request.operation_record_id)?.parked &&
            (result.kind === "acquired" || result.kind === "adopted")
          )
            throw new Error("post-acquire failure");
          return result;
        });
      const running = f
        .owner({
          fault(candidate) {
            if (candidate === point) throw new Error("post-acquire failure");
            if (point === "lost-fit" && candidate === "before_capacity_admit") {
              vi.spyOn(f.capacity, "reacquire").mockImplementationOnce((id, revision) => {
                // Commit unadmitted fresh-fence adoption, then fail before it can re-park.
                reacquire(id, revision, false);
                throw new Error("post-acquire failure");
              });
            }
          },
        })
        .dispatch(f.engine, second);
      const reacquire = f.capacity.reacquire.bind(f.capacity);
      const rejected = expect(running).rejects.toThrow(/post-acquire failure/u);
      await vi.advanceTimersByTimeAsync(1);
      const original = requireValue(
        f.capacity.runtimeRecord(f.record(second).operation_record_id),
        "original queued proof"
      );
      await f.owner().dispatch(f.engine, first);
      await vi.advanceTimersByTimeAsync(21);
      await rejected;
      expectOriginalQueue(
        requireValue(
          f.capacity.runtimeRecord(f.record(second).operation_record_id),
          "compensated queue"
        ),
        original
      );
      expect(f.record(second)).toMatchObject({
        lifecycle: "lease_acquired",
        disposition: null,
        lease: original.core.lease,
      });
      expect(
        f.leases.dispositionForOperation(f.record(second).operation_record_id)
      ).toBeUndefined();
      expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
      expectNoBackendQueue(f, f.record(second));
      expect(f.counter.submissions).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("repairs catalog-commit/project-CAS crashes without freeing the next backend owner", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second, drift } = await queue(f);
    const transition = f.checkpointer.transitionHostOperationCall.bind(f.checkpointer);
    const acquire = f.leases.tryAcquire.bind(f.leases);
    vi.spyOn(f.leases, "tryAcquire").mockImplementation((request, now) => {
      const result = acquire(request, now);
      if (
        request.run_id === second.identity.run_id &&
        (result.kind === "acquired" || result.kind === "adopted") &&
        f.capacity.runtimeRecord(request.operation_record_id)?.parked
      )
        drift();
      return result;
    });
    const running = f.owner().dispatch(f.engine, second);
    const rejected = expect(running).rejects.toThrow(/project compensation CAS crash/u);
    await vi.advanceTimersByTimeAsync(1);
    const original = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "original parked queue"
    );
    vi.spyOn(f.checkpointer, "transitionHostOperationCall").mockImplementation((input) => {
      if (
        input.next.operation_record_id === original.core.request.operation_record_id &&
        input.next.lifecycle === "lease_acquired" &&
        canonicalJson(input.next.lease) === canonicalJson(original.core.lease)
      )
        throw new Error("project compensation CAS crash");
      return transition(input);
    });
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    const before = requireValue(original, "crash proof");
    const journal = f.record(second);
    expect(journal.lease).not.toEqual(before.core.lease);
    expectOriginalQueue(
      requireValue(
        f.capacity.runtimeRecord(journal.operation_record_id),
        "catalog compensated queue"
      ),
      before
    );
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    f.reopen();
    const other = {
      operation_record_id: `hop_${sha256("other owner after compensation")}`,
      backend_key_sha256: second.policy_binding.backend_key_sha256,
      project_id: journal.project_id,
      run_id: "other",
      state_id: "other",
      attempt: 1,
      operation_id: "other",
      registration_sha256: journal.registration_sha256,
      request_sha256: journal.request_sha256,
      duration_ms: 500,
      queue_inactivity_expires_at_ms: 11_000,
    };
    const acquired = f.leases.tryAcquire(other, Date.now());
    if (acquired.kind !== "acquired") throw new Error("other owner must acquire freed backend");
    await expect(f.owner().dispatch(f.engine, second)).rejects.toThrow(/selection conflict/u);
    expect(f.record(second)).toMatchObject({ lifecycle: "terminal", lease: before.core.lease });
    expect(f.leases.ownedActive(other)).toEqual(acquired.active);
    expectOriginalQueue(
      requireValue(
        f.capacity.runtimeRecord(journal.operation_record_id),
        "reconciled original queue"
      ),
      before
    );
    expectNoBackendQueue(f, f.record(second));
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans a recovered fresh fence even when the initial use validator rejects", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    const running = f
      .owner({ fault: crashAt("after_capacity_reacquire") })
      .dispatch(f.engine, second);
    const rejected = expect(running).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    await vi.advanceTimersByTimeAsync(1);
    const original = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "original queue"
    );
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    f.reopen();
    await expect(
      f
        .owner({
          useValidator: {
            validateUse() {
              throw new Error("current use revoked");
            },
          },
        })
        .dispatch(f.engine, second)
    ).rejects.toThrow(/current use revoked/u);
    expectOriginalQueue(
      requireValue(f.capacity.runtimeRecord(f.record(second).operation_record_id), "revoked queue"),
      original
    );
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.record(second).lifecycle).toBe("lease_acquired");
    expect(f.leases.dispositionForOperation(f.record(second).operation_record_id)).toBeUndefined();
    expect(f.counter.submissions).toBe(1);
  });

  it("never erases an admitted hold on an error after atomic admission", async () => {
    clock();
    using f = new CapacityRuntimeFixture();
    const { first, second } = await queue(f);
    const running = f
      .owner({
        fault(point) {
          if (point === "after_capacity_admit") throw new Error("admitted error");
        },
      })
      .dispatch(f.engine, second);
    const rejected = expect(running).rejects.toThrow(/admitted error/u);
    await vi.advanceTimersByTimeAsync(1);
    await f.owner().dispatch(f.engine, first);
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    const held = requireValue(
      f.capacity.runtimeRecord(f.record(second).operation_record_id),
      "admitted hold"
    );
    expect(held).toMatchObject({ parked: false, core: { state: "held", snapshot: null } });
    expect(held.core.active_started_ms).not.toBeNull();
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("active");
    expect(f.counter.submissions).toBe(1);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(second).operation_record_id)).toMatchObject({
      state: "settled",
      active_started_ms: held.core.active_started_ms,
    });
    expect(f.counter.submissions).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("proof-bound compensation refusal and atomicity", () => {
  it.each([
    "guarded",
    "submitted",
    "expired-fence",
    "stale-token",
    "other-owner",
    "missing-proof",
    "stale-revision",
    "changed-journal",
    "queue-deadline",
    "request-custody",
    "progress-drift",
    "terminal",
    "admitted",
  ] as const)("never compensates %s or erases any admitted allocation", (attack) => {
    using f = new CapacityFixture();
    const core = f.core();
    const blocker = f.operation("compensation-blocker", "video-a", 0, 70);
    const held = core.reserveRuntime(blocker.request);
    const op = f.operation(`compensation-${attack}`, "video-b", 1, 70);
    let queued = core.reserveRuntime(op.request);
    queued = core.park(op.record.operation_record_id, queued.revision);
    f.acquire(op);
    const fresh = requireValue(op.record.lease, "fresh exact fence");
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "compensation adversarial catalog",
    });
    if (attack === "guarded") f.leases.guardSubmission(op.leaseRequest, fresh, f.now);
    if (attack === "submitted") f.submit(op);
    if (attack === "expired-fence") f.now += op.leaseRequest.duration_ms;
    if (attack === "stale-token")
      db.db
        .prepare(
          "UPDATE host_backend_leases SET fencing_token_sha256 = ? WHERE backend_key_sha256 = ?"
        )
        .run(sha256("new independent token"), fresh.backend_key_sha256);
    if (attack === "other-owner")
      db.db
        .prepare(
          "UPDATE host_backend_leases SET operation_record_id = ?, run_id = ? WHERE backend_key_sha256 = ?"
        )
        .run(`hop_${sha256("independent owner")}`, "independent-owner", fresh.backend_key_sha256);
    if (attack === "missing-proof")
      db.db
        .prepare("DELETE FROM host_backend_lease_events WHERE operation_record_id = ?")
        .run(op.record.operation_record_id);
    if (attack === "request-custody")
      vi.spyOn(op.project.artifacts, "readById").mockReturnValue(
        Buffer.from("drifted immutable request")
      );
    if (attack === "progress-drift") f.transition(op, { progress_event_count: 1 });
    if (attack === "terminal")
      f.transition(op, {
        lifecycle: "terminal",
        disposition: {
          outcome: "failed",
          remote_disposition: "proven_not_accepted",
          lease_disposition: "released",
          retryable: false,
          reason_code: "test_terminal",
        },
      });
    if (attack === "admitted") {
      f.disposition(blocker, {
        outcome: "cancelled",
        remote_disposition: "proven_not_accepted",
        lease_disposition: "released",
        retryable: false,
        reason_code: "free_resources",
      });
      f.snapshot(blocker, 0, 1, "final");
      const measured = core.account(blocker.record.operation_record_id, held.revision);
      core.settle(blocker.record.operation_record_id, measured.revision);
      queued = core.reacquire(op.record.operation_record_id, queued.revision);
      expect(queued.state).toBe("held");
    }
    const capacityBefore = db.db
      .prepare("SELECT * FROM host_capacity_records WHERE operation_record_id = ?")
      .get(op.record.operation_record_id);
    const backendBefore = f.leases.inspect(fresh.backend_key_sha256);
    const blockerBefore = core.inspect(blocker.record.operation_record_id);
    const journal =
      attack === "changed-journal"
        ? {
            ...op.record,
            operation_inactivity_expires_at_ms: op.record.operation_inactivity_expires_at_ms + 1,
          }
        : attack === "queue-deadline"
          ? {
              ...op.record,
              queue_inactivity_expires_at_ms: op.record.queue_inactivity_expires_at_ms + 1,
            }
          : op.record;
    expect(() =>
      core.compensateReacquisition(
        journal,
        attack === "stale-revision" ? queued.revision - 1 : queued.revision,
        fresh
      )
    ).toThrow();
    expect(
      db.db
        .prepare("SELECT * FROM host_capacity_records WHERE operation_record_id = ?")
        .get(op.record.operation_record_id)
    ).toEqual(capacityBefore);
    expect(f.leases.inspect(fresh.backend_key_sha256)).toEqual(backendBefore);
    expect(core.inspect(blocker.record.operation_record_id)).toEqual(blockerBefore);
    expect(f.leases.dispositionForOperation(op.record.operation_record_id)).toBeUndefined();
    expect(
      db.db
        .prepare(
          "SELECT count(*) AS n FROM host_backend_lease_events WHERE operation_record_id = ? AND event_type = 'capacity_reacquisition_compensated_v1'"
        )
        .get(op.record.operation_record_id)?.n
    ).toBe(0);
  });

  it("rolls back fresh-fence free, compensation event and capacity repair on a failed catalog update", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserveRuntime(f.operation("rollback-blocker", "video-a", 0, 70).request);
    const op = f.operation("rollback-compensation", "video-b", 1, 70);
    const queued = core.park(
      op.record.operation_record_id,
      core.reserveRuntime(op.request).revision
    );
    f.now += 1;
    f.acquire(op);
    const fresh = requireValue(op.record.lease, "rollback fresh fence");
    const backend = f.leases.inspect(fresh.backend_key_sha256);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "compensation transaction failure",
    });
    db.db.exec(
      "CREATE TRIGGER compensation_fault BEFORE UPDATE ON host_capacity_records BEGIN SELECT RAISE(ABORT, 'compensation crash'); END"
    );
    expect(() => core.compensateReacquisition(op.record, queued.revision, fresh)).toThrow(
      /compensation crash/u
    );
    expect(core.inspect(op.record.operation_record_id)).toEqual(queued);
    expect(f.leases.inspect(fresh.backend_key_sha256)).toEqual(backend);
    expect(f.leases.dispositionForOperation(op.record.operation_record_id)).toBeUndefined();
    expect(
      db.db
        .prepare(
          "SELECT count(*) AS n FROM host_backend_lease_events WHERE operation_record_id = ? AND event_type = 'capacity_reacquisition_compensated_v1'"
        )
        .get(op.record.operation_record_id)?.n
    ).toBe(0);
  });
});

describe("closed nonterminal parking proof", () => {
  it("cannot compensate a fresh fence outside the owning catalog transaction", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserveRuntime(f.operation("compensating-proof-blocker", "video-a", 0, 70).request);
    const op = f.operation("compensating-proof-waiter", "video-b", 1, 70);
    const parked = core.park(
      op.record.operation_record_id,
      core.reserveRuntime(op.request).revision
    );
    f.acquire(op);
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "compensation transaction boundary",
    });
    expect(() =>
      HostOperationLeaseAuthority.compensateCapacityReacquisitionInTransaction(
        db,
        op.record,
        requireValue(op.record.lease, "fresh compensation fence"),
        f.now
      )
    ).toThrow(/owning catalog transaction/u);
    expect(core.inspect(op.record.operation_record_id)).toEqual(parked);
    expect(f.leases.inspect(op.leaseRequest.backend_key_sha256).state).toBe("active");
    expect(f.leases.dispositionForOperation(op.record.operation_record_id)).toBeUndefined();
  });

  it("cannot free a backend outside the owning catalog transaction", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserveRuntime(f.operation("proof-blocker", "video-a", 0, 70).request);
    const op = f.operation("proof-waiter", "video-b", 1, 70);
    const queued = core.reserveRuntime(op.request);
    const proof: HostCapacityParkingProofV1 = {
      schema_id: "penny.host-capacity-parking-proof.v1",
      schema_version: 1,
      operation_record_id: op.record.operation_record_id,
      project_id: op.record.project_id,
      directive_sha256: op.record.directive_sha256,
      operation_request_sha256: op.record.request_sha256,
      capacity_request_sha256: sha256(capacityJson(queued.request)),
      journal_binding_sha256: capacityParkingJournalBinding(op.record),
      lease: requireValue(op.record.lease, "proof fence"),
      capacity_revision: queued.revision,
      parked_at_ms: f.now,
      queue_expires_ms: queued.queue_expires_ms,
      backend_queue_expires_ms: op.record.queue_inactivity_expires_at_ms,
    };
    using db = new OwnerSqliteDatabase({
      directory: f.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "parking transaction boundary",
    });
    expect(() =>
      HostOperationLeaseAuthority.parkPreSubmissionInTransaction(db, op.record, proof)
    ).toThrow(/proof refused/u);
    expect(f.leases.inspect(proof.lease.backend_key_sha256).state).toBe("active");
    expect(core.runtimeRecord(op.record.operation_record_id)?.parked).toBe(false);
    expect(f.leases.dispositionForOperation(op.record.operation_record_id)).toBeUndefined();
  });

  it("cannot use a terminal release as a nonterminal parking proof", () => {
    using f = new CapacityFixture();
    const core = f.core();
    core.reserveRuntime(f.operation("release-blocker", "video-a", 0, 70).request);
    const op = f.operation("released-not-parked", "video-b", 1, 70);
    const queued = core.reserveRuntime(op.request);
    f.disposition(op, {
      outcome: "cancelled",
      remote_disposition: "proven_not_accepted",
      lease_disposition: "released",
      retryable: false,
      reason_code: "explicit_no_effect",
    });
    expect(() => core.readyToReacquire(op.record.operation_record_id)).toThrow(/parked proof/u);
    expect(() => core.reacquire(op.record.operation_record_id, queued.revision)).toThrow();
    expect(core.inspect(op.record.operation_record_id)).toEqual(queued);
  });
  it.each(["run", "backend", "queue-deadline"] as const)(
    "refuses parked settlement with changed %s identity",
    (attack) => {
      using f = new CapacityFixture();
      const core = f.core();
      core.reserveRuntime(f.operation("settlement-blocker", "video-a", 0, 70).request);
      const op = f.operation("settlement-parked", "video-b", 1, 70);
      let queued = core.reserveRuntime(op.request);
      queued = core.park(op.record.operation_record_id, queued.revision);
      const request = {
        ...op.leaseRequest,
        ...(attack === "run" ? { run_id: "foreign-run" } : {}),
        ...(attack === "backend" ? { backend_key_sha256: sha256("foreign backend") } : {}),
        ...(attack === "queue-deadline"
          ? { queue_inactivity_expires_at_ms: op.leaseRequest.queue_inactivity_expires_at_ms + 1 }
          : {}),
      };
      expect(() =>
        f.leases.settleParked(
          request,
          queued.lease,
          {
            outcome: "cancelled",
            remote_disposition: "proven_not_accepted",
            lease_disposition: "released",
            retryable: false,
            reason_code: "fixture_cancel",
          },
          f.now
        )
      ).toThrow(/exact proof conflict/u);
      expect(f.leases.dispositionForOperation(op.record.operation_record_id)).toBeUndefined();
      expect(core.inspect(op.record.operation_record_id)).toEqual(queued);
      expect(f.leases.inspect(queued.backend_key_sha256).state).toBe("free");
    }
  );
});
