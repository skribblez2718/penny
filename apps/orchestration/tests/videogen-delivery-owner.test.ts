import { createLocalDeliveryAdapter } from "../dist/videogen/delivery.js";
import { currentAdapterHost } from "../dist/videogen/native-owner-authority.js";
import {
  readVideogenOwnerSelection,
  selectVideogenRights,
} from "../dist/videogen/owner-selection.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { DeliveryOwnerFixture } from "./helpers/videogen-delivery-owner.js";
describe("real owner journal/current-G5 local delivery protocol (NO production qualification)", () => {
  it("prepares only after exact durable gates, publishes frozen dual products, emits owner receipt and replays without recopy", async () => {
    using f = new DeliveryOwnerFixture();
    const prepared = f.prepare();
    expect(readdirSync(f.destination)).toEqual([]);
    const d = f.directive(prepared.intent_ref),
      owner = f.owner();
    await owner.dispatch(f.engine, d);
    const record = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    expect(record?.lifecycle).toBe("consumed");
    expect(record?.host_receipt_ref).not.toBeNull();
    expect(record?.result_wrapper?.ref).toBeDefined();
    if (record?.result_wrapper?.ref !== undefined && record.result_wrapper.ref !== null) {
      const wrapped: unknown = JSON.parse(f.store.read(record.result_wrapper.ref).toString());
      expect(wrapped).toMatchObject({
        receipt_ref: record.host_receipt_ref,
        raw_result_ref: record.operation_result_ref,
      });
      if (record.host_receipt_ref !== null)
        expect(f.store.metadata(record.host_receipt_ref).upstream_refs).not.toContainEqual(
          record.result_wrapper.ref
        );
    }

    expect(
      readFileSync(
        path.join(
          f.destination,
          prepared.intent.exclusive_final_id,
          "products/package/manifest.json"
        )
      )
    ).toEqual(f.store.read(f.manifest_ref));
    expect(
      readFileSync(
        path.join(f.destination, prepared.intent.exclusive_final_id, "products/master.mp4")
      )
    ).toEqual(f.store.read(f.p.master));
    await owner.dispatch(f.engine, d);
    expect(readdirSync(f.destination)).toEqual([prepared.intent.exclusive_final_id]);
  });
  it("recovers a crash after raw publication without recopying or minting another receipt", async () => {
    using f = new DeliveryOwnerFixture();
    const prepared = f.prepare(),
      d = f.directive(prepared.intent_ref);
    const owner = f.owner((point) => {
      if (point === "after_persist") throw new HostOperationSimulatedCrashError(point);
    });
    await expect(owner.dispatch(f.engine, d)).rejects.toBeInstanceOf(
      HostOperationSimulatedCrashError
    );
    const before = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    expect(before?.operation_result_ref).not.toBeNull();
    await f.owner().dispatch(f.engine, d);
    const after = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    expect(after?.lifecycle).toBe("consumed");
    expect(after?.operation_result_ref).toEqual(before?.operation_result_ref);
    expect(readdirSync(f.destination)).toEqual([prepared.intent.exclusive_final_id]);
  });
  it.each(["G1", "G4", "G5", "rights", "ledger", "budget", "measurement", "master"] as const)(
    "refuses concrete checkpoint %s revocation despite the old structural host, with no publication",
    async (changed) => {
      using f = new DeliveryOwnerFixture();
      const prepared = f.prepare(),
        d = f.directive(prepared.intent_ref),
        owner = f.owner();
      const c = f.checkpointer.loadRunById(f.run_id);
      if (!c) throw new Error("parent absent");
      const old = readVideogenOwnerSelection(f.binding.owner);
      if (changed === "rights")
        selectVideogenRights(
          c,
          old.rights.current_rights.map((r) => ({ ...r, status: "revoked" as const }))
        );
      else {
        const ref = changed.startsWith("G")
          ? old.gate.current_approvals.find((a) => a.gate_id === changed)?.decision_ref
          : changed === "ledger"
            ? f.e.edit.source_dependency_ledger_ref
            : changed === "budget"
              ? f.budget_ref
              : changed === "measurement"
                ? f.e.host.measured_source_refs[0]
                : f.p.master;
        if (!ref) throw new Error("selection absent");
        c.selectedArtifacts = c.selectedArtifacts.filter((r) => r.artifact_id !== ref.artifact_id);
      }
      f.checkpointer.saveRun(c, "fixture_actual_revocation", {});
      await expect(owner.dispatch(f.engine, d)).rejects.toThrow();
      expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
      expect(readdirSync(f.destination)).toEqual([]);
    }
  );
  it("refuses copied/proxied/wrong-project owners and ignores cloned structural authority fields", () => {
    using f = new DeliveryOwnerFixture();
    using other = new DeliveryOwnerFixture();
    for (const owner of [
      { ...f.binding.owner },
      new Proxy(f.binding.owner, {}),
      other.binding.owner,
    ]) {
      expect(() =>
        Reflect.apply(createLocalDeliveryAdapter, undefined, [{ ...f.binding, owner }])
      ).toThrow();
    }
    const projected = currentAdapterHost(f.binding.owner, {
      ...f.binding.host,
      current_rights: [],
      current_dependencies: [],
      measured_source_refs: [],
      audio_sources: [],
      now_utc: "2099-01-01T00:00:00Z",
    });
    expect(projected.host.current_rights).toHaveLength(f.current_rights.length);
    expect(projected.host.measured_source_refs).toEqual(f.e.host.measured_source_refs);
    expect(projected.host.current_dependencies).toEqual(f.e.host.current_dependencies);
    const c = f.checkpointer.loadRunById(f.run_id);
    if (!c) throw new Error("parent absent");
    c.selectedArtifacts = c.selectedArtifacts.filter(
      (r) => r.artifact_id !== f.e.host.measured_source_refs[0]?.artifact_id
    );
    f.checkpointer.saveRun(c, "fixture_source_changed", {});
    expect(() => projected.assertUnchanged()).toThrow("source checkpoint changed");
  });
  it("holds accepted historical artifacts and publication after revocation rather than replaying or consuming", async () => {
    using f = new DeliveryOwnerFixture();
    const prepared = f.prepare(),
      d = f.directive(prepared.intent_ref);
    await expect(
      f
        .owner((point) => {
          if (point === "after_persist") throw new HostOperationSimulatedCrashError(point);
        })
        .dispatch(f.engine, d)
    ).rejects.toThrow();
    const before = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    if (!before?.operation_result_ref) throw new Error("historical result absent");
    const c = f.checkpointer.loadRunById(f.run_id);
    if (!c) throw new Error("parent absent");
    selectVideogenRights(
      c,
      f.current_rights.map((r) => ({ ...r, status: "revoked" as const }))
    );
    f.checkpointer.saveRun(c, "fixture_revoke_after_effect", {});
    await expect(f.owner().dispatch(f.engine, d)).rejects.toThrow();
    const after = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    expect(after).toEqual(before);
    expect(f.store.read(before.operation_result_ref).byteLength).toBeGreaterThan(0);
    expect(readdirSync(f.destination)).toEqual([prepared.intent.exclusive_final_id]);
  });
  it("fences current rights changed by the submission boundary before final publication", async () => {
    using f = new DeliveryOwnerFixture();
    const prepared = f.prepare(),
      d = f.directive(prepared.intent_ref);
    const owner = f.owner((point) => {
      if (point === "before_submit") {
        const c = f.checkpointer.loadRunById(f.run_id);
        if (!c) throw new Error("parent absent");
        selectVideogenRights(
          c,
          f.current_rights.map((r) => ({ ...r, status: "revoked" }))
        );
        f.checkpointer.saveRun(c, "fixture_before_publication_revocation", {});
      }
    });
    await owner.dispatch(f.engine, d);
    expect(readdirSync(f.destination)).not.toContain(prepared.intent.exclusive_final_id);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]?.disposition?.outcome).not.toBe(
      "completed"
    );
  });
  it("refuses stale G5 operands before staging and refuses changed package bytes on owner readback", async () => {
    using f = new DeliveryOwnerFixture();
    expect(() => f.prepare(f.opaque("changed unapproved master"))).toThrow();
    expect(readdirSync(f.destination)).toEqual([]);
    const prepared = f.prepare(),
      d = f.directive(prepared.intent_ref);
    f.files.prepare(
      "local-output",
      prepared.intent.staging_id,
      [
        ...f.p.manifest.files.map((a) => ({
          relative_path: `package/${a.relative_path}`,
          sha256: a.sha256,
          bytes: f.store.read(a.producer_ref),
        })),
        {
          relative_path: "package/manifest.json",
          sha256: f.manifest_ref.content_digest,
          bytes: f.store.read(f.manifest_ref),
        },
        {
          relative_path: "master.mp4",
          sha256: f.p.master.content_digest,
          bytes: f.store.read(f.p.master),
        },
      ],
      new AbortController().signal
    );
    const master = path.join(f.destination, prepared.intent.staging_id, "master.mp4");
    const { chmodSync, writeFileSync } = await import("node:fs");
    chmodSync(master, 0o600);
    writeFileSync(master, "tampered");
    await f.owner().dispatch(f.engine, d);
    const record = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    expect(record?.disposition?.outcome).not.toBe("completed");
    expect(readdirSync(f.destination)).not.toContain(prepared.intent.exclusive_final_id);
  });
});
