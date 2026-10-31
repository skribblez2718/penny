import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type {
  HostOperationAdapterV1,
  HostOperationExecutionContextV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import {
  capacityJson,
  validateCapacityRecord,
} from "../dist/host-operations/capacity-contracts.js";
import {
  validateCapacityStoredRecord,
  validateCapacityProductiveObservation,
  type HostCapacityProductiveObservationV1,
} from "../dist/host-operations/capacity-runtime-contracts.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME } from "../dist/state/paths.js";
import { capacityPolicy } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  CAPACITY_ARTIFACT,
  CAPACITY_COMPLETED,
  captureProductiveObservation,
  syntheticCapacityAdapter,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

function clock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
}
function adapter(run: HostOperationAdapterV1["run"]): HostOperationAdapterV1 {
  return { ...syntheticCapacityAdapter(() => undefined, { submissions: 0 }), run };
}
function observe(context: HostOperationExecutionContextV1): void {
  requireValue(context.observeProductiveProgress, "productive callback")();
}
function recordProgress(
  f: CapacityRuntimeFixture,
  context: HostOperationExecutionContextV1,
  revision: number,
  units: number,
  patch: Partial<HostCapacityProductiveObservationV1> = {},
  measured = 1
): void {
  captureProductiveObservation(
    f.artifacts,
    context.journal,
    f.demand(context.journal),
    revision,
    units,
    patch
  );
  f.measure(context.journal, measured, revision, "cumulative");
}
function finish(
  f: CapacityRuntimeFixture,
  context: HostOperationExecutionContextV1,
  finalRevision: number
) {
  const content = canonicalJson({ synthetic: true });
  context.recordFetched({
    schema_version: 1,
    content_sha256: sha256(content),
    byte_length: Buffer.byteLength(content),
    item_count: 1,
    poll_count: 100,
  });
  f.measure(context.journal, 3, finalRevision);
  const output = context.persist({
    disposition: CAPACITY_COMPLETED,
    operation_result: { contract: CAPACITY_ARTIFACT, media_type: "application/json", content },
  });
  return { disposition: CAPACITY_COMPLETED, ...output };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("trusted durable productive capacity observations", () => {
  it("has a zero-payload callback only when an explicit trusted host source is constructed", async () => {
    expectTypeOf<
      NonNullable<HostOperationExecutionContextV1["observeProductiveProgress"]>
    >().parameters.toEqualTypeOf<[]>();
    using f = new CapacityRuntimeFixture();
    const base = syntheticCapacityAdapter((journal) => f.measure(journal), f.counter);
    const a: HostOperationAdapterV1 = {
      ...base,
      run: async (context) => {
        expect(context.observeProductiveProgress).toBeUndefined();
        return base.run(context);
      },
    };
    const directive = f.prepare("no-productive-authority");
    await f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    expect(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id)?.productive
    ).toBeNull();
  });

  it("keeps productive pre-fetch work alive beyond initial inactivity with immutable project evidence, not polls or spend", async () => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 4,
      max_units: 1000,
    });
    const a = adapter(async (context) => {
      context.beginSubmission();
      f.counter.submissions += 1;
      context.recordRemoteAccepted("durable-target");
      for (let revision = 1; revision <= 4; revision += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        context.reportActivity("polling_only");
        context.emitProgress({ progress_class: "poll", completed_units: revision });
        recordProgress(f, context, revision, revision * 10);
        observe(context);
        expect(
          f.capacity.runtimeRecord(context.journal.operation_record_id)?.productive_count
        ).toBe(revision);
        expect(f.capacity.inspect(context.journal.operation_record_id)?.milestone).toBe("none");
      }
      return finish(f, context, 5);
    });
    const directive = f.prepare("productive-long-job");
    const done = f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(401);
    expect((await done).action).toBe("await_user");
    const stored = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "productive V2"
    );
    expect(stored).toMatchObject({
      productive_count: 4,
      productive: { observation: { productive_revision: 4, completed_units: 40 } },
      core: {
        state: "settled",
        active_started_ms: 10_000,
        last_milestone_ms: 10_400,
        snapshot: { kind: "final" },
      },
    });
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not renew from an exact duplicate or replay old progress after accepted-fence restart", async () => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 10,
      max_units: 1000,
    });
    const a = adapter(async (context) => {
      context.beginSubmission();
      f.counter.submissions += 1;
      context.recordRemoteAccepted("duplicate-target");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      recordProgress(f, context, 1, 10);
      observe(context);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      observe(context);
      expect(f.capacity.inspect(context.journal.operation_record_id)?.last_milestone_ms).toBe(
        10_050
      );
      throw new HostOperationSimulatedCrashError("after_remote_checkpoint");
    });
    const directive = f.prepare("productive-restart");
    const initial = f
      .owner({ adapters: new Map([[a.adapter_id, a]]) })
      .dispatch(f.engine, directive);
    const rejection = expect(initial).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    f.reopen();
    const old = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "durable observation"
    );
    const recovered = adapter(async (context) => {
      expect(context.journal.remote_correlation_id).toBe("duplicate-target");
      observe(context); // exact duplicate on the same still-current accepted fence
      expect(f.capacity.inspect(context.journal.operation_record_id)?.last_milestone_ms).toBe(
        old.core.last_milestone_ms
      );
      return await new Promise<never>(() => undefined);
    });
    const done = f
      .owner({ adapters: new Map([[recovered.adapter_id, recovered]]) })
      .dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(100);
    expect((await done).action).toBe("await_user");
    expect(f.record(directive).disposition?.outcome).toBe("timed_out");
    expect(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id)?.productive_count
    ).toBe(1);
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "operation",
    "project",
    "request",
    "demand",
    "remote",
    "fence",
    "source",
    "future",
    "old-time",
    "over-units",
    "unproductive",
    "revision",
    "total-drift",
    "cost",
  ] as const)(
    "refuses %s observations without renewing capacity or partially charging a ledger",
    async (attack) => {
      clock();
      using f = new CapacityRuntimeFixture(
        { ...capacityPolicy(), active_inactivity_ms: 150 },
        true,
        { max_observations: 10, max_units: 1000 }
      );
      const a = adapter(async (context) => {
        context.beginSubmission();
        context.recordRemoteAccepted("negative-target");
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        recordProgress(f, context, 1, 10);
        observe(context);
        const before = requireValue(
          f.capacity.runtimeRecord(context.journal.operation_record_id),
          "accepted observation"
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        const patch: Partial<HostCapacityProductiveObservationV1> = {};
        if (attack === "operation")
          patch.operation_record_id = `hop_${sha256("different operation")}`;
        if (attack === "project") patch.project_id = `prj_${"a".repeat(32)}`;
        if (attack === "request") patch.operation_request_sha256 = sha256("different request");
        if (attack === "demand") patch.capacity_request_sha256 = sha256("different demand");
        if (attack === "remote") patch.remote_correlation_sha256 = sha256("different target");
        if (attack === "fence")
          patch.lease = {
            ...requireValue(context.journal.lease, "current lease"),
            fencing_token_sha256: sha256("stale token"),
          };
        if (attack === "source") patch.source_id = "different-source";
        if (attack === "future") patch.observed_at_ms = 11_000;
        if (attack === "old-time") patch.observed_at_ms = 10_020;
        if (attack === "over-units") {
          patch.total_units = 1001;
          patch.completed_units = 1001;
        }
        if (attack === "unproductive") patch.completed_units = 10;
        if (attack === "revision") patch.productive_revision = 1;
        if (attack === "total-drift") patch.total_units = 999;
        recordProgress(f, context, 2, 20, patch, attack === "cost" ? 21 : 2);
        expect(() => observe(context)).toThrow();
        const after = requireValue(
          f.capacity.runtimeRecord(context.journal.operation_record_id),
          "unchanged selected proof"
        );
        expect(after).toEqual(before);
        return await new Promise<never>(() => undefined);
      });
      const directive = f.prepare(`productive-${attack}`);
      const done = f
        .owner({ adapters: new Map([[a.adapter_id, a]]) })
        .dispatch(f.engine, directive);
      await vi.advanceTimersByTimeAsync(191);
      expect((await done).action).toBe("await_user");
      expect(f.record(directive).disposition?.outcome).toBe("timed_out");
      expect(
        f.capacity.runtimeRecord(f.record(directive).operation_record_id)?.productive_count
      ).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("enforces observation count and explicit elapsed caps independently of new productive evidence", async () => {
    clock();
    using f = new CapacityRuntimeFixture(
      { ...capacityPolicy(), active_inactivity_ms: 150, max_elapsed_ms: 170 },
      true,
      { max_observations: 1, max_units: 1000 }
    );
    const a = adapter(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("elapsed-target");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      recordProgress(f, context, 1, 10);
      observe(context);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      recordProgress(f, context, 2, 20);
      expect(() => observe(context)).toThrow(/over limit/u);
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("productive-explicit-elapsed");
    const done = f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(171);
    expect((await done).action).toBe("await_user");
    expect(f.capacity.inspect(f.record(directive).operation_record_id)?.cleanup_started_ms).toBe(
      10_170
    );
    expect(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id)?.productive_count
    ).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot renew from a late callback after abort, even with newly durable valid evidence", async () => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 10,
      max_units: 1000,
    });
    let late: (() => void) | undefined;
    const a = adapter(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("late-target");
      late = () => {
        recordProgress(f, context, 1, 10);
        observe(context);
      };
      return await new Promise<never>(() => undefined);
    });
    const directive = f.prepare("productive-late");
    const done = f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(151);
    await done;
    const before = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "aborted capacity"
    );
    expect(requireValue(late, "late callback")).toThrow(/outside its active fence/u);
    expect(f.capacity.runtimeRecord(f.record(directive).operation_record_id)).toEqual(before);
    expect(before.productive_count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back measured snapshot insertion when the productive selection write fails", async () => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 10,
      max_units: 1000,
    });
    const a = adapter(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("transaction-target");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      recordProgress(f, context, 1, 10);
      using db = new OwnerSqliteDatabase({
        directory: f.config.stateRoot,
        databaseName: CATALOG_DATABASE_NAME,
        mode: "existing",
        label: "productive transaction crash",
      });
      db.db.exec(
        "CREATE TRIGGER productive_fault BEFORE UPDATE ON host_capacity_records BEGIN SELECT RAISE(ABORT, 'productive crash'); END"
      );
      expect(() => observe(context)).toThrow("productive crash");
      expect(db.db.prepare("SELECT count(*) AS n FROM host_capacity_snapshots").get()?.n).toBe(0);
      expect(f.capacity.runtimeRecord(context.journal.operation_record_id)?.productive_count).toBe(
        0
      );
      db.db.exec("DROP TRIGGER productive_fault");
      observe(context);
      return finish(f, context, 2);
    });
    const directive = f.prepare("productive-transaction");
    const done = f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(51);
    expect((await done).action).toBe("await_user");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsupported versions, unknown fields and a corrupt retained productive proof on consumed replay", async () => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 10,
      max_units: 1000,
    });
    const a = adapter(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("retained-target");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      recordProgress(f, context, 1, 10);
      observe(context);
      return finish(f, context, 2);
    });
    const directive = f.prepare("productive-retained");
    const done = f.owner({ adapters: new Map([[a.adapter_id, a]]) }).dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(51);
    await done;
    const stored = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "retained proof"
    );
    expect(() => validateCapacityRecord(stored)).toThrow(); // V1 is still closed.
    expect(() => validateCapacityStoredRecord({ ...stored, schema_version: 3 })).toThrow();
    expect(() => validateCapacityStoredRecord({ ...stored, arbitrary: true })).toThrow();
    using db = new OwnerSqliteDatabase({
      directory: f.config.stateRoot,
      databaseName: CATALOG_DATABASE_NAME,
      mode: "existing",
      label: "retained productive corruption",
    });
    const corrupt = {
      ...stored,
      productive: {
        ...requireValue(stored.productive, "selected observation"),
        observation: {
          ...requireValue(stored.productive, "selected observation").observation,
          completed_units: 11,
        },
      },
    };
    const text = capacityJson(corrupt);
    db.db
      .prepare(
        "UPDATE host_capacity_records SET record_jcs = ?, record_sha256 = ? WHERE operation_record_id = ?"
      )
      .run(text, sha256(text), f.record(directive).operation_record_id);
    await expect(f.owner().dispatch(f.engine, directive)).rejects.toThrow(/productive proof/u);
    expect(f.record(directive).lifecycle).toBe("consumed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "empty",
    "poll",
    "heartbeat",
    "spend",
    "wrong-producer",
    "wrong-run",
    "noncanonical",
    "unknown-field",
    "zero",
  ] as const)("cannot renew from %s durable source material", async (attack) => {
    clock();
    using f = new CapacityRuntimeFixture({ ...capacityPolicy(), active_inactivity_ms: 150 }, true, {
      max_observations: 10,
      max_units: 1000,
    });
    const a = adapter(async (context) => {
      context.beginSubmission();
      context.recordRemoteAccepted("invalid-source-target");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const seed = captureProductiveObservation(
        f.artifacts,
        context.journal,
        f.demand(context.journal),
        1,
        10
      );
      const original: unknown = JSON.parse(f.artifacts.readById(seed.artifact_id).toString("utf8"));
      const observation = validateCapacityProductiveObservation(original);
      const raw = {
        ...observation,
        productive_revision: attack === "wrong-run" ? 1 : 2,
        ...(attack === "unknown-field" ? { extra: "forbidden" } : {}),
        ...(attack === "zero" ? { completed_units: 0 } : {}),
        ...(["poll", "heartbeat", "spend"].includes(attack) ? { kind: attack } : {}),
      };
      const content = `${attack === "noncanonical" ? " " : ""}${canonicalJson(raw)}`;
      const ref = f.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: attack === "wrong-run" ? "foreign-run" : context.journal.identity.run_id,
          phase: "host-capacity-progress",
          branch_id: null,
          kind: "host-capacity-progress",
          operation_id: `capacity-productive:${context.journal.operation_record_id}:synthetic-progress`,
          version: attack === "wrong-run" ? 1 : 2,
          producer: attack === "wrong-producer" ? "host:unbound-source" : "host:synthetic-progress",
          media_type: "application/json",
          content_schema: { schema_id: observation.schema_id, schema_version: 1 },
          parent_ref: attack === "wrong-run" ? null : seed,
          upstream_refs: attack === "wrong-run" ? [] : [context.journal.request_ref],
        },
        content,
      });
      // The trusted collector's read result is varied; the callback still accepts no payload.
      const source = requireValue(f.project.productive, "trusted negative source fixture");
      const selected = vi.spyOn(source, "read").mockReturnValue(attack === "empty" ? null : ref);
      f.measure(context.journal, 1, 1, "cumulative");
      const before = requireValue(
        f.capacity.runtimeRecord(context.journal.operation_record_id),
        "unrenewed hold"
      );
      const expiry = context.journal.operation_inactivity_expires_at_ms;
      expect(() => observe(context)).toThrow();
      expect(f.capacity.runtimeRecord(context.journal.operation_record_id)).toEqual(before);
      expect(context.journal.operation_inactivity_expires_at_ms).toBe(expiry);
      selected.mockRestore();
      return await new Promise<never>(() => undefined);
    });
    const fixtureErrors: unknown[] = [];
    const checked = {
      ...a,
      run: async (...args: Parameters<typeof a.run>) => {
        try {
          return await a.run(...args);
        } catch (error) {
          fixtureErrors.push(error);
          throw error;
        }
      },
    };
    const directive = f.prepare(`invalid-progress-${attack}`);
    const done = f
      .owner({ adapters: new Map([[checked.adapter_id, checked]]) })
      .dispatch(f.engine, directive);
    await vi.advanceTimersByTimeAsync(151);
    expect((await done).action).toBe("await_user");
    expect(fixtureErrors).toEqual([]);
    expect(f.record(directive).disposition?.outcome).toBe("timed_out");
    expect(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id)?.productive_count
    ).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("adopts an expired accepted fence without resetting clocks, refuses old progress, and accepts only new exact-fence work", async () => {
    clock();
    using f = new CapacityRuntimeFixture(
      { ...capacityPolicy(), active_inactivity_ms: 1000 },
      true,
      { max_observations: 10, max_units: 1000 }
    );
    const initialAdapter = adapter(async (context) => {
      context.beginSubmission();
      f.counter.submissions += 1;
      context.recordRemoteAccepted("fresh-fence-progress");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      recordProgress(f, context, 1, 10);
      observe(context);
      throw new HostOperationSimulatedCrashError("after_remote_checkpoint");
    });
    const directive = f.prepare("productive-fresh-fence");
    const initial = f
      .owner({ adapters: new Map([[initialAdapter.adapter_id, initialAdapter]]) })
      .dispatch(f.engine, directive);
    const rejection = expect(initial).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    const old = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "old productive fence"
    );
    vi.setSystemTime(10_600);
    f.reopen();
    let recovered = false;
    const recoveryAdapter = adapter(async (context) => {
      expect(context.journal.remote_correlation_id).toBe("fresh-fence-progress");
      expect(context.journal.lease?.lease_id).not.toBe(old.core.lease.lease_id);
      expect(() => observe(context)).toThrow(/target\/fence conflict/u);
      expect(f.capacity.inspect(context.journal.operation_record_id)?.last_milestone_ms).toBe(
        10_050
      );
      recordProgress(f, context, 2, 20, {}, 2);
      observe(context);
      recovered = true;
      return finish(f, context, 3);
    });
    expect(
      (
        await f
          .owner({ adapters: new Map([[recoveryAdapter.adapter_id, recoveryAdapter]]) })
          .dispatch(f.engine, directive)
      ).action
    ).toBe("await_user");
    expect(recovered).toBe(true);
    const after = requireValue(
      f.capacity.runtimeRecord(f.record(directive).operation_record_id),
      "new productive fence"
    );
    expect(after).toMatchObject({
      productive_count: 2,
      core: {
        state: "settled",
        active_started_ms: old.core.active_started_ms,
        last_milestone_ms: 10_600,
        request: old.core.request,
        snapshot: { kind: "final", source_revision: 3 },
      },
    });
    f.reopen();
    expect((await f.owner().dispatch(f.engine, directive)).action).toBe("status");
    expect(f.counter.submissions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
