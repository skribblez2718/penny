import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import { HostOperationCapacityAuthority } from "../dist/host-operations/capacity-authority.js";
import { OrchestrationService } from "../dist/service.js";
import { initializePennyState } from "../dist/state/index.js";
import { OwnerSqliteDatabase } from "../dist/state/owner-sqlite.js";
import { CATALOG_DATABASE_NAME } from "../dist/state/paths.js";
import { capacityPolicy } from "./helpers/capacity-fixtures.js";
import {
  CapacityRuntimeFixture,
  capacityRuntimeRegistration,
  capacityDemandSource,
  captureCapacityMeasurement,
  fixtureMeasurements,
  syntheticCapacityAdapter,
} from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

const noModel = {
  runAgent: async (): Promise<never> => {
    throw new Error("no provider in capacity service fixture");
  },
};
function catalogSnapshot(stateRoot: string): string {
  using store = new OwnerSqliteDatabase({
    directory: stateRoot,
    databaseName: CATALOG_DATABASE_NAME,
    label: "capacity service catalog fixture",
    mode: "existing",
    readOnly: true,
  });
  return canonicalJson({
    schema: store.db.prepare("PRAGMA user_version").get(),
    ddl: store.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
      .all(),
    policy: store.db.prepare("SELECT * FROM host_capacity_policy").all(),
    capacity: store.db.prepare("SELECT * FROM host_capacity_records").all(),
    measurements: store.db.prepare("SELECT * FROM host_capacity_snapshots").all(),
  });
}

describe("service capacity composition is explicit and read-only", () => {
  it("owns concrete project custody and settles through the normal service runner", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("service-capacity");
    const adapter = syntheticCapacityAdapter((journal) => {
      captureCapacityMeasurement(
        service.artifacts,
        journal,
        f.demands.requestFor({
          project_id: journal.project_id,
          operation_record_id: journal.operation_record_id,
          directive: journal.directive,
          request_bytes: service.artifacts.readById(journal.request_ref.artifact_id),
        })
      );
    }, f.counter);
    const prior = catalogSnapshot(f.config.stateRoot);
    using service: OrchestrationService = new OrchestrationService({
      projectRoot: f.config.projectRoot,
      env: f.env,
      modelClient: noModel,
      playbookRegistration: f.registration,
      hostOperationAdapters: new Map([[adapter.adapter_id, adapter]]),
      hostOperationCapacity: {
        policy: f.policy,
        demands: f.demands,
        measurements: fixtureMeasurements(() => service.artifacts),
      },
    });
    expect(catalogSnapshot(f.config.stateRoot)).toBe(prior);
    expect((await service.runner.runUntilBoundary(directive)).action).toBe("await_user");
    const journal = f.record(directive);
    expect(journal.lifecycle).toBe("consumed");
    expect(f.capacity.inspect(journal.operation_record_id)).toMatchObject({
      state: "settled",
      snapshot: { kind: "final" },
    });
    expect(f.counter.submissions).toBe(1);
    expect(
      (await requireValue(service.hostOperations, "service owner").dispatch(f.engine, directive))
        .action
    ).toBe("status");
    expect(f.counter.submissions).toBe(1);
  });

  it("has no per-operation missing-mapping fallback when configured", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("service-missing-mapping");
    using service: OrchestrationService = new OrchestrationService({
      projectRoot: f.config.projectRoot,
      env: f.env,
      modelClient: noModel,
      playbookRegistration: f.registration,
      hostOperationAdapters: new Map([
        [
          "fixture-adapter",
          syntheticCapacityAdapter(() => {
            throw new Error("must not measure");
          }, f.counter),
        ],
      ]),
      hostOperationCapacity: {
        policy: f.policy,
        demands: {
          requestFor() {
            throw new Error("current capacity mapping absent");
          },
        },
        measurements: {
          read() {
            throw new Error("no meter");
          },
        },
      },
    });
    await expect(service.runner.runUntilBoundary(directive)).rejects.toThrow(
      "current capacity mapping absent"
    );
    expect(f.record(directive)).toMatchObject({ lifecycle: "prepared", lease: null });
    expect(f.counter.submissions).toBe(0);
  });

  it("rejects absent/drifted installed policy without installing policy, DDL or schema bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "capacity-service-readonly-"));
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    initializePennyState(projectRoot, { env });
    const configuration = vi.spyOn(HostOperationCapacityAuthority, "configure");
    try {
      const absent = catalogSnapshot(env.PENNY_STATE_ROOT);
      expect(
        () =>
          new OrchestrationService({
            projectRoot,
            env,
            modelClient: noModel,
            playbookRegistration: capacityRuntimeRegistration(),
            hostOperationCapacity: {
              policy: capacityPolicy(),
              demands: capacityDemandSource(),
              measurements: {
                read() {
                  throw new Error("unused");
                },
              },
            },
          })
      ).toThrow(/policy absent or drifted/u);
      expect(catalogSnapshot(env.PENNY_STATE_ROOT)).toBe(absent);
      expect(configuration).not.toHaveBeenCalled();
      // Policy installation is a separate explicit test-host setup, never composition.
      HostOperationCapacityAuthority.configure(env.PENNY_STATE_ROOT, capacityPolicy());
      configuration.mockClear();
      const installed = catalogSnapshot(env.PENNY_STATE_ROOT);
      expect(
        () =>
          new OrchestrationService({
            projectRoot,
            env,
            modelClient: noModel,
            playbookRegistration: capacityRuntimeRegistration(),
            hostOperationCapacity: {
              policy: { ...capacityPolicy(), active_inactivity_ms: 2000 },
              demands: capacityDemandSource(),
              measurements: {
                read() {
                  throw new Error("unused");
                },
              },
            },
          })
      ).toThrow(/policy absent or drifted/u);
      expect(catalogSnapshot(env.PENNY_STATE_ROOT)).toBe(installed);
      expect(configuration).not.toHaveBeenCalled();
      using service: OrchestrationService = new OrchestrationService({
        projectRoot,
        env,
        modelClient: noModel,
        playbookRegistration: capacityRuntimeRegistration(),
      });
      expect(service.hostOperations).toBeUndefined();
      expect(catalogSnapshot(env.PENNY_STATE_ROOT)).toBe(installed);
    } finally {
      configuration.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no opt-in keeps legacy service dispatch even when no final metering exists", async () => {
    using f = new CapacityRuntimeFixture();
    const directive = f.prepare("service-legacy");
    const before = catalogSnapshot(f.config.stateRoot);
    using service: OrchestrationService = new OrchestrationService({
      projectRoot: f.config.projectRoot,
      env: f.env,
      modelClient: noModel,
      playbookRegistration: f.registration,
      hostOperationAdapters: new Map([
        ["fixture-adapter", syntheticCapacityAdapter(() => undefined, f.counter)],
      ]),
    });
    expect((await service.runner.runUntilBoundary(directive)).action).toBe("await_user");
    expect(f.record(directive).lifecycle).toBe("consumed");
    expect(catalogSnapshot(f.config.stateRoot)).toBe(before);
    expect(f.counter.submissions).toBe(1);
  });
});
