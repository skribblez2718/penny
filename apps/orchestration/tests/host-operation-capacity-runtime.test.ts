import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import type {
  HostOperationAdapterV1,
  HostOperationCallRecordV1,
} from "../dist/host-operations/contracts.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME, pennyStatePaths } from "../dist/state/paths.js";
import { capacityPolicy } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  capacityDemandSource,
  syntheticCapacityAdapter,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

function crashAt(point: HostOperationFaultPointV1) {
  return (candidate: HostOperationFaultPointV1): void => {
    if (candidate === point) throw new HostOperationSimulatedCrashError(candidate);
  };
}
function catalogMutation(fixture: CapacityRuntimeFixture, sql: string, id: string): void {
  using store = new OwnerSqliteDatabase({
    directory: pennyStatePaths(fixture.config.stateRoot).root,
    databaseName: CATALOG_DATABASE_NAME,
    label: "capacity runtime corruption fixture",
    mode: "existing",
  });
  store.db.prepare(sql).run(id);
}
function leaseRequest(journal: HostOperationCallRecordV1) {
  return {
    operation_record_id: journal.operation_record_id,
    backend_key_sha256: journal.policy_binding.backend_key_sha256,
    project_id: journal.project_id,
    run_id: journal.identity.run_id,
    state_id: journal.state_id,
    attempt: journal.attempt,
    operation_id: journal.operation_id,
    registration_sha256: journal.registration_sha256,
    request_sha256: journal.request_sha256,
    duration_ms: 500,
    queue_inactivity_expires_at_ms: journal.queue_inactivity_expires_at_ms,
  };
}
function adapterFor(run: HostOperationAdapterV1["run"]): HostOperationAdapterV1 {
  const base = syntheticCapacityAdapter(() => undefined, { submissions: 0 });
  return { ...base, run };
}
function useFakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("opt-in generic host capacity runtime", () => {
  it("executes through a real runner and settles exact measured spend once", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("capacity-positive");
    const runner = new OrchestrationRunner(
      f.engine,
      new WorkerExecutor(
        {
          runAgent: async () => {
            throw new Error("no model");
          },
        },
        f.artifacts,
        { projectRoot: f.config.projectRoot, parallelConcurrency: 1, registration: f.registration }
      ),
      undefined,
      f.owner()
    );
    expect((await runner.runUntilBoundary(directive)).action).toBe("await_user");
    const journal = f.record(directive);
    const held = requireValue(f.capacity.inspect(journal.operation_record_id), "settled capacity");
    expect(journal.lifecycle).toBe("consumed");
    expect(held).toMatchObject({
      state: "settled",
      milestone: "verified",
      snapshot: { kind: "final", source_revision: 1 },
    });
    expect(held.snapshot?.readings[0]?.meters.attempts).toBe(3);
    expect(held.lease).toEqual(journal.lease);
    expect(held.lease.lease_epoch).toBe(2);
    expect(f.counter.submissions).toBe(1);
    const before = canonicalJson(held.snapshot);
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(canonicalJson(f.capacity.inspect(journal.operation_record_id)?.snapshot)).toBe(before);
    expect(
      f.checkpointer
        .events(directive.identity.run_id)
        .filter((x) => x.eventType === "host_operation_consumed")
    ).toHaveLength(1);
  });

  it("keeps the no-opt-in legacy journal/result path and creates no reservation", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("legacy");
    expect((await f.owner({}, false).dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.record(directive)).toMatchObject({
      lifecycle: "consumed",
      disposition: { outcome: "completed" },
      progress_event_count: 4,
    });
    expect(f.capacity.inspect(f.record(directive).operation_record_id)).toBeUndefined();
    expect(f.counter.submissions).toBe(1);
  });

  it.each(["after_remote_checkpoint", "after_fetch", "after_persist", "before_consume"] as const)(
    "reopens exact stores after %s without repeating remote work",
    async (point) => {
      using f = new CapacityRuntimeFixture();
      const directive = f.prepare(`restart-${point}`);
      await expect(
        f.owner({ fault: crashAt(point) }).dispatch(f.engine, directive)
      ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      const prior = requireValue(
        f.capacity.inspect(f.record(directive).operation_record_id),
        "prior capacity"
      );
      const correlation = f.record(directive).remote_correlation_sha256;
      f.reopen();
      expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
      expect(f.counter.submissions).toBe(1);
      expect(f.record(directive).remote_correlation_sha256).toBe(correlation);
      const after = requireValue(
        f.capacity.inspect(f.record(directive).operation_record_id),
        "after capacity"
      );
      expect(after.active_started_ms).toBe(prior.active_started_ms);
      expect(after.request).toEqual(prior.request);
      expect(after.state).toBe("settled");
      f.reopen();
      expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
      expect(f.counter.submissions).toBe(1);
    }
  );

  it.each(["persisted", "terminal"] as const)(
    "recovers exact %s boundary before consume",
    async (lifecycle) => {
      using f = new CapacityRuntimeFixture();
      const directive = f.prepare(`journal-${lifecycle}`);
      const transition = f.checkpointer.transitionHostOperationCall.bind(f.checkpointer);
      const spy = vi
        .spyOn(f.checkpointer, "transitionHostOperationCall")
        .mockImplementation((input) => {
          if (input.next.lifecycle === (lifecycle === "persisted" ? "verified" : "settled"))
            throw new HostOperationSimulatedCrashError("after_persist");
          return transition(input);
        });
      await expect(f.owner().dispatch(f.engine, directive)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      expect(f.record(directive).lifecycle).toBe(lifecycle);
      spy.mockRestore();
      f.reopen();
      expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
      expect(f.counter.submissions).toBe(1);
      expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("settled");
    }
  );

  it("adopts an acceptance epoch crash without resetting capacity clocks or demands", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("acceptance-fence");
    vi.spyOn(f.capacity, "adoptFence").mockImplementationOnce(() => {
      throw new HostOperationSimulatedCrashError("after_remote_checkpoint");
    });
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    const before = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "old fence hold"
    );
    expect(before.lease.lease_epoch).toBe(1);
    expect(f.record(directive).lease?.lease_epoch).toBe(2);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.counter.submissions).toBe(1);
    const after = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "adopted hold"
    );
    expect(after.active_started_ms).toBe(before.active_started_ms);
    expect(after.request).toEqual(before.request);
    expect(after.lease.lease_epoch).toBe(2);
  });

  it("reacquires an expired pre-submit fence without new capacity time or allocation", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("pre-submit-adopt");
    await expect(
      f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const before = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "old hold"
    );
    vi.setSystemTime(10_600);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.active_started_ms).toBe(
      before.active_started_ms
    );
    expect(f.counter.submissions).toBe(1);
  });

  it.each([
    "after_remote_checkpoint",
    "after_fetch",
    "after_persist",
    "before_consume",
    "consumed",
  ] as const)("refuses current demand drift at %s before effects or replay", async (point) => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare(`drift-${point}`);
    if (point === "consumed") await f.owner().dispatch(f.engine, directive);
    else
      await expect(
        f.owner({ fault: crashAt(point) }).dispatch(f.engine, directive)
      ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const before = canonicalJson(f.record(directive));
    f.demands = capacityDemandSource("video-a", 21);
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow(/selection conflict/u);
    expect(canonicalJson(f.record(directive))).toBe(before);
    expect(f.counter.submissions).toBe(1);
  });

  it.each(["after_remote_checkpoint", "terminal", "consumed"] as const)(
    "refuses slot-only demand drift at %s without changing durable evidence",
    async (point) => {
      using f = new CapacityRuntimeFixture();
      const directive = f.prepare(`slot-drift-${point}`);
      if (point === "consumed") await f.owner().dispatch(f.engine, directive);
      else if (point === "terminal") {
        const transition = f.checkpointer.transitionHostOperationCall.bind(f.checkpointer);
        const spy = vi
          .spyOn(f.checkpointer, "transitionHostOperationCall")
          .mockImplementation((input) => {
            if (input.next.lifecycle === "settled")
              throw new HostOperationSimulatedCrashError("before_consume");
            return transition(input);
          });
        await expect(f.owner().dispatch(f.engine, directive)).rejects.toBeInstanceOf(
          HostOperationSimulatedCrashError
        );
        expect(f.record(directive).lifecycle).toBe("terminal");
        spy.mockRestore();
      } else
        await expect(
          f.owner({ fault: crashAt(point) }).dispatch(f.engine, directive)
        ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      const journalBefore = canonicalJson(f.record(directive));
      const id = f.record(directive).operation_record_id;
      const capacityBefore = canonicalJson(requireValue(f.capacity.inspect(id), "prior hold"));
      const source = f.demands;
      f.demands = {
        requestFor(input) {
          const request = source.requestFor(input);
          return {
            ...request,
            demands: request.demands.map((demand) => ({ ...demand, slots: demand.slots + 1 })),
          };
        },
      };
      await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow(/selection conflict/u);
      expect(canonicalJson(f.record(directive))).toBe(journalBefore);
      expect(canonicalJson(f.capacity.inspect(id))).toBe(capacityBefore);
      expect(f.counter.submissions).toBe(1);
    }
  );

  it("rejects captured late adapter callbacks after terminalization without renewing or mutating", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture();
    const lateCallbacks: (() => void)[] = [];
    const base = syntheticCapacityAdapter((journal) => f.measure(journal), f.counter);
    const adapter: HostOperationAdapterV1 = {
      ...base,
      run: async (context) => {
        lateCallbacks.push(
          () => context.reportActivity("late_transport"),
          () => context.emitProgress({ progress_class: "adapter_progress" }),
          () => context.beginSubmission(),
          () => context.recordRemoteAccepted("late_acceptance"),
          () => context.recordFetched(requireValue(context.journal.fetched, "prior fetch"))
        );
        return base.run(context);
      },
    };
    const directive = f.prepare("late-callbacks");
    expect(
      (
        await f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive)
      ).action
    ).toBe("await_user");
    const id = f.record(directive).operation_record_id;
    const journalBefore = canonicalJson(f.record(directive));
    const capacityBefore = canonicalJson(requireValue(f.capacity.inspect(id), "settled hold"));
    const eventsBefore = canonicalJson(f.checkpointer.events(directive.identity.run_id));
    expect(lateCallbacks).toHaveLength(5);
    for (const callback of lateCallbacks) expect(callback).toThrow(/outside its active fence/u);
    await vi.advanceTimersByTimeAsync(1000);
    expect(canonicalJson(f.record(directive))).toBe(journalBefore);
    expect(canonicalJson(f.capacity.inspect(id))).toBe(capacityBefore);
    expect(canonicalJson(f.checkpointer.events(directive.identity.run_id))).toBe(eventsBefore);
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the existing use validator before capacity selection even on consumed replay", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("validator-first");
    await f.owner().dispatch(f.engine, directive);
    let selected = 0;
    f.demands = {
      requestFor: () => {
        selected += 1;
        throw new Error("capacity drift");
      },
    };
    await expect(
      f
        .owner({
          useValidator: {
            validateUse() {
              throw new Error("original validator refusal");
            },
          },
        })
        .dispatch(f.engine, directive)
    ).rejects.toThrow("original validator refusal");
    expect(selected).toBe(0);
  });

  it("refuses missing/wrong mapping, and releases an existing exact pre-submit fence", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("mapping");
    await expect(
      f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    f.demands = capacityDemandSource("video-b");
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow(/binding conflict/u);
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.record(directive)).toMatchObject({
      lifecycle: "terminal",
      disposition: { reason_code: "capacity_unavailable" },
    });
    expect(f.counter.submissions).toBe(0);
    f.demands = capacityDemandSource();
    f.measure(f.record(directive), 0);
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("settled");
  });

  it.each(["after_remote_checkpoint", "after_persist", "before_consume", "consumed"] as const)(
    "never reconstructs a missing required reservation at %s",
    async (point) => {
      using f = new CapacityRuntimeFixture();
      const directive = f.prepare(`missing-${point}`);
      if (point === "consumed") await f.owner().dispatch(f.engine, directive);
      else
        await expect(
          f.owner({ fault: crashAt(point) }).dispatch(f.engine, directive)
        ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      const journal = f.record(directive);
      catalogMutation(
        f,
        "DELETE FROM host_capacity_snapshots WHERE operation_record_id = ?",
        journal.operation_record_id
      );
      catalogMutation(
        f,
        "DELETE FROM host_capacity_records WHERE operation_record_id = ?",
        journal.operation_record_id
      );
      await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow(
        /required reservation absent/u
      );
      expect(f.capacity.inspect(journal.operation_record_id)).toBeUndefined();
      expect(f.counter.submissions).toBe(1);
    }
  );

  it("expires parked capacity without running/polling, releases lease and retires fairness entry", async () => {
    using f = new CapacityRuntimeFixture();
    const first = f.prepare("held");
    await expect(
      f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, first)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    f.demands = capacityDemandSource("video-b", 70);
    const second = f.prepare("queued", "worker-b");
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("await_user");
    const journal = f.record(second);
    expect(journal).toMatchObject({
      lifecycle: "consumed",
      disposition: {
        reason_code: "capacity_queue_expired",
        remote_disposition: "proven_not_accepted",
      },
    });
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    const retired = requireValue(f.capacity.inspect(journal.operation_record_id), "retired queue");
    expect(retired).toMatchObject({ state: "expired", active_started_ms: null, snapshot: null });
    expect(() =>
      f.capacity.retireQueued(
        f.record(first).operation_record_id,
        requireValue(f.capacity.inspect(f.record(first).operation_record_id), "hold").revision
      )
    ).toThrow(/retirement/u);
    // A distinct overlapping worker can now proceed; the retired entry cannot block FIFO.
    f.demands = capacityDemandSource("video-b", 20);
    const third = f.prepare("after-queue", "worker-b");
    expect((await f.owner().dispatch(f.engine, third)).action).toBe("await_user");
    expect(f.counter.submissions).toBe(1);
    expect(f.capacity.inspect(f.record(first).operation_record_id)?.state).toBe("held");
  });

  it("safely releases admission-limit failures with no adapter execution or replacement", async () => {
    const policy = { ...capacityPolicy(), max_admissions_per_project: 1 };
    using f = new CapacityRuntimeFixture(policy);
    const first = f.prepare("one-admission");
    await expect(
      f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, first)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    f.demands = capacityDemandSource("video-b");
    const directive = f.prepare("admission-denied", "worker-b");
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.record(directive).disposition?.reason_code).toBe("capacity_unavailable");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)).toBeUndefined();
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(f.counter.submissions).toBe(0);
  });

  it("checks requireHeld at actual adapter entry, not just reservation", async () => {
    using f = new CapacityRuntimeFixture();
    const source = f.demands;
    f.demands = {
      requestFor(input) {
        const held = f.capacity.inspect(input.operation_record_id);
        if (held?.state === "held" && held.cleanup_started_ms === null)
          f.capacity.beginCleanup(input.operation_record_id, held.revision);
        return source.requestFor(input);
      },
    };
    let entries = 0;
    const directive = f.prepare("entry-refused");
    await expect(
      f
        .owner({
          adapters: new Map([
            [
              "fixture-adapter",
              adapterFor(async () => {
                entries += 1;
                throw new Error("must not enter");
              }),
            ],
          ]),
        })
        .dispatch(f.engine, directive)
    ).rejects.toThrow(/final measured artifact/u);
    expect(entries).toBe(0);
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("held");
  });

  it("rechecks requireHeld immediately after the host seam and before submission guard", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("apply-refused");
    await expect(
      f
        .owner({
          fault(point) {
            if (point === "before_submit") {
              const journal = f.record(directive);
              const held = requireValue(
                f.capacity.inspect(journal.operation_record_id),
                "apply hold"
              );
              f.capacity.beginCleanup(journal.operation_record_id, held.revision);
            }
          },
        })
        .dispatch(f.engine, directive)
    ).rejects.toThrow(/final measured artifact/u);
    expect(f.record(directive)).toMatchObject({
      lifecycle: "terminal",
      remote_correlation_id: null,
    });
    expect(f.counter.submissions).toBe(0);
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
  });

  it("refuses a stolen fence without execution, refund or permissive settlement", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("stale-fence");
    await expect(
      f
        .owner({
          fault(point) {
            if (point === "before_submit") {
              const journal = f.record(directive);
              vi.setSystemTime(10_600);
              f.leases.tryAcquire(
                {
                  ...leaseRequest(journal),
                  operation_record_id: `hop_${"a".repeat(64)}`,
                  run_id: "competitor",
                  operation_id: "competitor",
                  queue_inactivity_expires_at_ms: Date.now() + 1000,
                },
                Date.now()
              );
            }
          },
        })
        .dispatch(f.engine, directive)
    ).rejects.toThrow(/disposition conflicts/u);
    expect(f.counter.submissions).toBe(0);
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("held");
  });

  it("capacity silence expires despite legacy polls, activity and backend heartbeats", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 300 });
    let polls = 0;
    const adapter = adapterFor(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("silent-polling");
      const interval = setInterval(() => {
        polls += 1;
        context.reportActivity("transport_tick");
        context.emitProgress({ progress_class: "poll" });
      }, 40);
      context.signal.addEventListener("abort", () => clearInterval(interval), { once: true });
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("silent-capacity");
    const done = f
      .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
      .dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(301);
    expect((await done).action).toBe("await_user");
    expect(polls).toBeGreaterThan(3);
    expect(f.record(directive)).toMatchObject({
      lifecycle: "consumed",
      disposition: { outcome: "timed_out", lease_disposition: "quarantined" },
    });
    const capacity = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "quarantine"
    );
    expect(capacity).toMatchObject({
      state: "quarantined",
      snapshot: null,
      cleanup_started_ms: 10_300,
    });
    const poisoned = f.leases.inspect(directive.policy_binding.backend_key_sha256);
    if (poisoned.state !== "quarantined") throw new Error("expected quarantine");
    f.leases.resetQuarantine({
      backend_key_sha256: directive.policy_binding.backend_key_sha256,
      quarantine_id: poisoned.quarantine_id,
      disposition: "queue_inspected_empty",
      evidence_sha256: sha256("synthetic inspection"),
      now_ms: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.capacity.inspect(capacity.request.operation_record_id)?.state).toBe("quarantined");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces explicit elapsed cap independently of fresh durable fetch activity", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture({
      ...capacityPolicy(),
      active_inactivity_ms: 200,
      max_elapsed_ms: 250,
    });
    const adapter = adapterFor(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("elapsed-cap");
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      f.measure(context.journal);
      context.recordFetched({
        schema_version: 1,
        content_sha256: sha256("fetched"),
        byte_length: 7,
        item_count: 1,
        poll_count: 1,
      });
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("elapsed");
    const done = f
      .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
      .dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(251);
    expect((await done).action).toBe("await_user");
    const record = requireValue(
      f.capacity.inspect(f.record(directive).operation_record_id),
      "elapsed record"
    );
    expect(record.last_milestone_ms).toBe(10_150);
    expect(record.cleanup_started_ms).toBe(10_250);
    expect(record.state).toBe("settled");
    expect(f.record(directive).disposition?.outcome).toBe("timed_out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("begins bounded cleanup before cancellation observer and uses the shorter grace", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), cleanup_grace_ms: 60 });
    let cleanupAt: number | null = null;
    let observerSignal: AbortSignal | undefined;
    const adapter = adapterFor(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("cleanup");
      context.registerRemoteCancellation(async (signal) => {
        cleanupAt = requireValue(
          f.capacity.inspect(context.journal.operation_record_id),
          "cleanup reservation"
        ).cleanup_started_ms;
        observerSignal = signal;
        return await new Promise<never>(() => undefined);
      });
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("cleanup-grace");
    const controller = new AbortController();
    const done = f
      .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
      .dispatch(f.engine, directive, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(61);
    expect((await done).action).toBe("await_user");
    expect(cleanupAt).toBe(10_010);
    expect(observerSignal?.aborted).toBe(true);
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("quarantined");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("quarantines both capacities after ambiguous submission restart without a zero final", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("ambiguous");
    await expect(
      f
        .owner({ fault: crashAt("after_submit_before_remote_checkpoint") })
        .dispatch(f.engine, directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
    expect(f.counter.submissions).toBe(1);
    expect(f.capacity.inspect(f.record(directive).operation_record_id)).toMatchObject({
      state: "quarantined",
      snapshot: null,
    });
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("quarantined");
  });

  it.each(["missing", "over-cap"] as const)(
    "blocks consume on %s final meter and recovers exactly",
    async (kind) => {
      using f = new CapacityRuntimeFixture();
      const adapter = syntheticCapacityAdapter((journal) => {
        if (kind === "over-cap") f.measure(journal, 21);
      }, f.counter);
      const directive = f.prepare(`meter-${kind}`);
      await expect(
        f
          .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
          .dispatch(f.engine, directive)
      ).rejects.toThrow();
      expect(f.record(directive)).toMatchObject({
        lifecycle: "terminal",
        disposition: { outcome: "completed" },
      });
      expect(f.capacity.inspect(f.record(directive).operation_record_id)).toMatchObject({
        state: "held",
        snapshot: null,
      });
      expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
      expect(f.counter.submissions).toBe(1);
      if (kind === "missing") {
        f.measure(f.record(directive));
        f.reopen();
        expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
        expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("settled");
        expect(f.counter.submissions).toBe(1);
      }
    }
  );
  it("preserves queued crash evidence and releases queue-limit refusal without a new hold", async () => {
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), max_queued_per_project: 1 });
    const first = f.prepare("queue-limit-held");
    await expect(
      f.owner({ fault: crashAt("before_submit") }).dispatch(f.engine, first)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    f.demands = capacityDemandSource("video-b", 70);
    const second = f.prepare("queue-retire-crash", "worker-b");
    vi.spyOn(f.capacity, "retireQueued").mockImplementationOnce(() => {
      throw new HostOperationSimulatedCrashError("before_consume");
    });
    await expect(f.owner().dispatch(f.engine, second)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    expect(f.capacity.inspect(f.record(second).operation_record_id)?.state).toBe("queued");
    expect(f.leases.inspect(second.policy_binding.backend_key_sha256).state).toBe("free");
    const third = f.prepare("queue-limit-denied", "worker-b");
    expect((await f.owner().dispatch(f.engine, third)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(third).operation_record_id)).toBeUndefined();
    expect(f.record(third).disposition?.reason_code).toBe("capacity_unavailable");
    expect(f.counter.submissions).toBe(0);
    f.reopen();
    expect((await f.owner().dispatch(f.engine, second)).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(second).operation_record_id)?.state).toBe("expired");
    expect(f.capacity.inspect(f.record(first).operation_record_id)?.state).toBe("held");
  });

  it("fails closed on corrupt final snapshot history even on consumed replay", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("corrupt-ledger");
    await f.owner().dispatch(f.engine, directive);
    const before = canonicalJson(f.record(directive));
    catalogMutation(
      f,
      "UPDATE host_capacity_snapshots SET snapshot_sha256 = '0000000000000000000000000000000000000000000000000000000000000000' WHERE operation_record_id = ?",
      f.record(directive).operation_record_id
    );
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow();
    expect(canonicalJson(f.record(directive))).toBe(before);
    expect(f.counter.submissions).toBe(1);
  });

  it("releases the exact pre-submit lease even if demand changes at apply", async () => {
    using f = new CapacityRuntimeFixture();
    let source = capacityDemandSource();
    f.demands = { requestFor: (input) => source.requestFor(input) };
    const directive = f.prepare("apply-demand-drift");
    await expect(
      f
        .owner({
          fault(point) {
            if (point === "before_submit") source = capacityDemandSource("video-a", 21);
          },
        })
        .dispatch(f.engine, directive)
    ).rejects.toThrow(/selection conflict/u);
    expect(f.counter.submissions).toBe(0);
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("held");
    source = capacityDemandSource();
    f.measure(f.record(directive), 0);
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("await_user");
  });

  it("settles known targeted-stop proof only with final measurements after cleanup begins", async () => {
    useFakeClock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 250 });
    let observedCleanup = false;
    const adapter = adapterFor(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("known-stop");
      context.registerRemoteCancellation(async () => {
        observedCleanup =
          f.capacity.inspect(context.journal.operation_record_id)?.cleanup_started_ms !== null;
        f.measure(context.journal);
        return {
          schema_version: 1,
          remote_disposition: "proven_terminal",
          remote_correlation_id: "known-stop",
          reason_code: "synthetic_stop_observed",
        };
      });
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("known-cleanup-stop");
    const done = f
      .owner({ adapters: new Map([[adapter.adapter_id, adapter]]) })
      .dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(251);
    expect((await done).action).toBe("await_user");
    expect(observedCleanup).toBe(true);
    expect(f.capacity.inspect(f.record(directive).operation_record_id)).toMatchObject({
      state: "settled",
      snapshot: { kind: "final" },
    });
    expect(f.leases.inspect(directive.policy_binding.backend_key_sha256).state).toBe("free");
    expect(vi.getTimerCount()).toBe(0);
  });
});
