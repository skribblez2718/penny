import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { MediaEvidenceCustody } from "../dist/videogen/media-evidence.js";
import {
  MediaFixture,
  pcmAsset,
  protocolPcmAdapter,
  required,
} from "./helpers/videogen-media-fixtures.js";

describe("raw→existing owner receipt→domain wrapper real store/engine custody protocol", () => {
  it("refuses orphan receipt-shaped artifacts, prepared journal, another project and structural fake owners", async () => {
    using f = new MediaFixture();
    f.json({ schema_version: 1, outcome: "completed" }, "penny.host-operation-receipt.v1");
    expect(() => f.evidence().materialize("orphan-operation")).toThrow(/missing journal/);
    const request = f.request(pcmAsset());
    const d = f.prepare(request);
    const owner = f.owner(protocolPcmAdapter(f, request, { count: 0 }), (point) => {
      if (point === "before_submit") throw new HostOperationSimulatedCrashError(point);
    });
    await expect(owner.dispatch(f.engine, d)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    expect(() => f.evidence().materialize(record.operation_record_id)).toThrow(/settled/);
    using foreign = new MediaFixture();
    expect(() => f.evidence(foreign.store).materialize(record.operation_record_id)).toThrow();
    const bad: unknown = {
      project_id: f.project_id,
      store: {},
      checkpointer: f.checkpointer,
      leases: f.leases,
    };
    // Runtime negative boundary, not a partial-host assertion.
    expect(() => {
      Reflect.construct(MediaEvidenceCustody, [bad]);
    }).toThrow(/concrete/);
  });
  it("settles raw PCM before receipt-citing measurement, reopens exact stores and idempotently wraps without decode", async () => {
    using f = new MediaFixture();
    const request = f.request(pcmAsset());
    const d = f.prepare(request);
    const calls = { count: 0 };
    const adapter = protocolPcmAdapter(f, request, calls);
    await f.owner(adapter).dispatch(f.engine, d);
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    expect(record.lifecycle).toBe("consumed");
    const result = f.evidence().materialize(record.operation_record_id);
    expect(result.production_admission).toBe("blocked");
    expect(result.video_evidence_ref).toBeNull();
    const measurement = required(result.audio_measurement_ref);
    const meta = f.store.metadata(measurement);
    expect(meta.upstream_refs.map((x) => x.artifact_id)).toContain(result.receipt_ref.artifact_id);
    expect(record.output_artifacts.map((x) => x.artifact_id)).not.toContain(
      measurement.artifact_id
    );
    expect(
      f.store.metadata(result.receipt_ref).upstream_refs.map((x) => x.artifact_id)
    ).not.toContain(measurement.artifact_id);
    const bytes: unknown = JSON.parse(f.store.read(measurement).toString("utf8"));
    expect(bytes).toMatchObject({
      decoded_sample_count: 8000,
      decode_receipt_ref: result.receipt_ref,
      measured_sync_offsets: [],
    });
    using reopenedStore = ArtifactStore.openExisting(path.join(f.root, "artifacts"), {
      projectId: f.project_id,
    });
    using reopenedControl = Checkpointer.openExisting(path.join(f.root, "control.db"), undefined, {
      projectId: f.project_id,
    });
    const persist = vi.spyOn(reopenedStore, "persist");
    expect(
      f.evidence(reopenedStore, reopenedControl).materialize(record.operation_record_id)
    ).toEqual(result);
    expect(persist).not.toHaveBeenCalled();
    await f.owner(adapter).dispatch(f.engine, d);
    expect(calls.count).toBe(1);
  });
  it.each(["after_persist", "before_consume"] as const)(
    "recovers %s using exact existing raw records/receipt, without another adapter execution",
    async (point) => {
      using f = new MediaFixture();
      const request = f.request(pcmAsset());
      const d = f.prepare(request);
      const calls = { count: 0 };
      const adapter = protocolPcmAdapter(f, request, calls);
      await expect(
        f
          .owner(adapter, (observed) => {
            if (observed === point) throw new HostOperationSimulatedCrashError(point);
          })
          .dispatch(f.engine, d)
      ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      const initial = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
      if (point === "after_persist")
        expect(() => f.evidence().materialize(initial.operation_record_id)).toThrow(/settled/);
      await f.owner(adapter).dispatch(f.engine, d);
      const result = f.evidence().materialize(initial.operation_record_id);
      expect(result.audio_measurement_ref).not.toBeNull();
      expect(calls.count).toBe(1);
    }
  );
  it("refuses stale current bindings and byte/manifest corruption instead of inventing missing custody", async () => {
    using f = new MediaFixture();
    const request = f.request(pcmAsset());
    const d = f.prepare(request);
    await f.owner(protocolPcmAdapter(f, request, { count: 0 })).dispatch(f.engine, d);
    const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
    const spy = vi.spyOn(f.store, "readById");
    spy.mockImplementation(() => Buffer.from("corrupt"));
    expect(() => f.evidence().materialize(record.operation_record_id)).toThrow();
    spy.mockRestore();
    const lookup = vi.spyOn(f.checkpointer, "hostOperationCall");
    lookup.mockReturnValue({ ...record, registration_sha256: "f".repeat(64) });
    expect(() => f.evidence().materialize(record.operation_record_id)).toThrow();
    lookup.mockRestore();
  });
});
