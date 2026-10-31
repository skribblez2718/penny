import path from "node:path";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { type ArtifactRef, type InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/registry.js";
import { bootstrapVideogenRuntime } from "../dist/videogen/runtime-manifest.js";
import {
  assembleVideogenEffects,
  type VideogenAdapterManifestV1,
} from "../dist/videogen/runtime-adapters.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import { saveExecution, executionState, slot, setSlot } from "../dist/videogen/execution-state.js";
import {
  validateVideogenPrivateConfig,
  type VideogenEffectRecipeV1,
} from "../dist/videogen/runtime-config.js";
import { BudgetReservationV1Schema } from "../dist/videogen/foundation-contracts.js";
import { DeliveryIntentV1Schema } from "../dist/videogen/delivery.js";
import { NativeBuildRequestV1Schema } from "../dist/videogen/native-contracts.js";
import { KdenliveFixtureRegistry } from "../dist/videogen/kdenlive-registry.js";
import {
  readVideogenOwnerSelection,
  selectVideogenRights,
} from "../dist/videogen/owner-selection.js";
import { checkRights, RightsBindingV1Schema } from "../dist/videogen/rights-ledger.js";
import { GatePacketV1Schema } from "../dist/videogen/gates.js";
import { assertNativeG4Lineage } from "../dist/videogen/native-owner-authority.js";
import { DeliveryOwnerFixture } from "./helpers/videogen-delivery-owner.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { setup, fixtureProviders } from "./helpers/videogen-executor-fixture.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { RunnerFixture, NATIVE_TEST_POLICY } from "./helpers/videogen-native-runner.js";
import { saved, XML_LIMITS } from "./helpers/videogen-native-fixtures.js";
import { capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import {
  hostCapacityWorkerKey,
  validateCapacitySnapshot,
} from "../dist/host-operations/capacity-contracts.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../dist/host-operations/capacity-authority.js";
import { HostOperationCapacityRuntimeBinding } from "../dist/host-operations/capacity-runtime.js";

// These are synthetic model/media/legal prerequisites. The adapter and owner are real, and
// every filesystem effect stays in disposable fixtures. No editor or production qualification.
const policy = {
  backend_binding_id: "local-fixture",
  backend_key_sha256: hostCapacityWorkerKey("compiled-fixture-worker"),
  lease_profile_id: "compiled-fixture",
  lease_duration_ms: 60000,
  lease_renew_after_ms: 10000,
  queue_inactivity_ms: 30000,
  operation_inactivity_ms: 60000,
  max_request_bytes: 1000000,
  max_input_bytes: 1000000,
  max_output_bytes: 10000000,
  max_progress_events: 128,
};
const editPolicy = {
  max_frames: 10000,
  max_samples: 1000000,
  max_duration: { numerator: 60, denominator: 1 },
  sync_tolerance: { numerator: 1, denominator: 100 },
  max_width: 1920,
  max_height: 1080,
  max_abs_gain_db: 24,
};
function deliveryManifest(root: string): VideogenAdapterManifestV1 {
  return {
    kind: "local_delivery",
    policy,
    binding: {
      edit_policy: editPolicy,
      package_policy: { max_files: 1000, max_file_bytes: 10000000, max_payload_bytes: 10000000 },
      destinations: [
        {
          destination_id: "local-output",
          root,
          max_files: 1000,
          max_bytes: 10000000,
          reserve_bytes: 1,
        },
      ],
    },
  };
}
function providerFor(value: VideogenAdapterManifestV1) {
  const provider = assembleVideogenEffects([value], FOUNDATION_LIMITS).get(value.kind);
  if (provider === undefined) throw new Error("compiled provider missing");
  return provider;
}
function recipe(
  kind: VideogenEffectRecipeV1["kind"],
  requestSchema: string,
  requestField: string,
  requestSlot: string,
  output: ArtifactRef
): VideogenEffectRecipeV1 {
  return {
    kind,
    stage: kind === "local_delivery" ? "delivery" : "finished",
    subject_id: kind === "local_delivery" ? "production" : "shot",
    fields: { schema_id: requestSchema, schema_version: 1 },
    operands: [{ field: requestField, slot: requestSlot }],
    input_slots: [],
    input_bindings: [
      {
        slot: kind === "local_delivery" ? "delivery-intent" : "native-build",
        source_slot: requestSlot,
      },
    ],
    budget_policy: {
      lifetime_ms: 3600000,
      meters: [
        { meter: "attempts", reserved: 1 },
        { meter: "stored_bytes", reserved: 8000000 },
      ],
    },
    output_contract_ref: output,
    backend_key_sha256: policy.backend_key_sha256,
  };
}
function prepareRuntime(
  f: DeliveryOwnerFixture,
  adapter: VideogenAdapterManifestV1,
  value: VideogenEffectRecipeV1
) {
  const base = fixtureProviders(f).config;
  const config = validateVideogenPrivateConfig({
    ...base,
    rights: f.current_rights,
    envelope: {
      ...base.envelope,
      max_storage_bytes: 50000000,
      max_output_bytes: 10000000,
      max_attempts: 100,
    },
  });
  const capacity = capacityPolicy();
  const resource = capacity.resources[0],
    binding = capacity.bindings[0];
  if (resource === undefined || binding === undefined) throw new Error("capacity fixture missing");
  const provider = providerFor(adapter);
  const capacityBinding = {
    ...binding,
    binding_id: "compiled-binding",
    operation_kind: adapter.kind,
    adapter_id: provider.declaration.adapter_id,
    backend_binding_id: provider.declaration.backend_binding_id,
    worker_id: "compiled-fixture-worker",
    resource_ids: [resource.resource_id],
  };
  // Roundtrip plain JSON through the actual fixed factory loader, not injected fixture providers.
  const providers = bootstrapVideogenRuntime({
    manifest: JSON.parse(
      canonicalJson({
        schema_id: "penny.videogen-runtime-manifest.v1",
        schema_version: 1,
        artifacts: [],
        config,
        recipes: [{ ...value, output_contract_ref: f.opaque("synthetic expected output policy") }],
        adapters: [adapter],
        capacity: {
          policy: {
            ...capacity,
            queue_wait_ms: 60000,
            active_inactivity_ms: 60000,
            cleanup_grace_ms: 60000,
            bindings: [capacityBinding],
          },
          measurement_file: path.join(f.root, "actual-measurements.json"),
          demands: [
            {
              operation_kind: adapter.kind,
              binding_id: capacityBinding.binding_id,
              demands: [{ resource_id: resource.resource_id, slots: 1, meters: meters(1) }],
            },
          ],
        },
      })
    ),
    store: f.store,
    project_id: f.project_id,
  });
  const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, providers);
  const c = f.checkpointer.loadRunById(f.run_id);
  if (c === undefined || c === null) throw new Error("parent missing");
  const request = f.json(
    { ...videogenStageRequest(), destination_id: "local-output" },
    "penny.videogen-request.v1"
  );
  const current = readVideogenOwnerSelection(f.binding.owner);
  saveExecution(c, {
    schema_version: 1,
    config_digest: runtime.binding_digest,
    slots: [
      { slot: "request", ref: request },
      { slot: "L", ref: f.e.ledger_ref },
      { slot: "manifest", ref: f.manifest_ref },
      ...current.gate.current_approvals.map((a) => ({ slot: a.gate_id, ref: a.decision_ref })),
    ],
    shot_ids: ["shot"],
    shot_index: 0,
    asset_index: 0,
    effect_index: 0,
    effects: [],
  });
  c.selectedArtifacts.push(request);
  return { runtime, providers, c };
}
function hostDirective(
  value: ReturnType<VideogenRuntime["effect"]>
): InvokeHostOperationDirectiveV1 {
  if (value?.action !== "invoke_host_operation") throw new Error("host directive missing");
  return value;
}

describe("default JSON factories → runtime directive → concrete owner/adapter", () => {
  for (const withCapacity of [false, true])
    it(`derives G5 manifest predecessor and current budget, then publishes/readbacks with the real local adapter${withCapacity ? " and concrete capacity owner" : ""}`, async () => {
      const destination = mkdtempSync(path.join(tmpdir(), "penny-concrete-delivery-"));
      try {
        const manifest = deliveryManifest(destination),
          provider = providerFor(manifest);
        using f = new DeliveryOwnerFixture(provider.declaration);
        const prepared = f.prepare();
        const r = recipe(
          "local_delivery",
          "penny.videogen-delivery-operation-request.v1",
          "delivery_intent_ref",
          "delivery_intent",
          f.opaque("expected policy")
        );
        const x = prepareRuntime(f, manifest, r),
          s = executionState(x.c);
        setSlot(x.c, s, "delivery_intent", prepared.intent_ref);
        x.c.transition("delivery-fixture");
        const d = hostDirective(
          x.runtime.effect(
            x.c,
            "local_delivery",
            "delivery",
            "production",
            runtimeRegistrationSha256(f.registration)
          )
        );
        expect(d.effect_identity?.predecessor_ref).toEqual(f.manifest_ref);
        const intent = x.runtime.read(
          slot(executionState(x.c), "delivery_intent"),
          DeliveryIntentV1Schema
        );
        const budget = x.runtime.read(intent.budget_ref, BudgetReservationV1Schema);
        expect(budget.scope_gate_ref).toEqual(f.g5);
        expect(budget.subject_id).toBe("local-output");
        expect(intent.budget_ref).not.toEqual(f.budget_ref);
        f.checkpointer.saveRun(x.c, "runtime_concrete_prepared", {});
        const adapter = x.providers.effects
          .get("local_delivery")
          ?.createAdapter({ owner: f.binding.owner, store: f.store, checkpointer: f.checkpointer });
        if (adapter === undefined) throw new Error("default adapter missing");
        adapter.inspectRequest({
          directive: d,
          declaration: provider.declaration,
          request_bytes: f.store.read(d.request_ref),
          input_artifacts: d.input_artifacts,
        });
        const capacityOptions = x.providers.capacity_options;
        if (capacityOptions === undefined) throw new Error("JSON capacity options missing");
        const project = new HostCapacityProjectAuthority(
          f.project_id,
          f.checkpointer,
          f.store,
          capacityOptions.measurements
        );
        const stateRoot = path.join(f.root, "state");
        if (withCapacity)
          HostOperationCapacityAuthority.configure(stateRoot, capacityOptions.policy);
        using capacity = withCapacity
          ? new HostOperationCapacityAuthority({
              stateRoot,
              policy: capacityOptions.policy,
              projects: [project],
            })
          : undefined;
        const capacityRuntime =
          capacity === undefined
            ? undefined
            : new HostOperationCapacityRuntimeBinding(capacity, project, capacityOptions.demands);
        const owner = new HostOperationRuntimeOwner({
          projectId: f.project_id,
          checkpointer: f.checkpointer,
          artifacts: f.store,
          leaseAuthority: f.leases,
          adapters: new Map([[adapter.adapter_id, adapter]]),
          ...(capacityRuntime === undefined ? {} : { capacityRuntime }),
          fault(point) {
            if (!withCapacity || point !== "after_persist") return;
            const journal = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
            if (journal?.lease === null || journal === undefined)
              throw new Error("actual journal fence missing");
            const demand = capacityOptions.demands.requestFor({
              project_id: f.project_id,
              operation_record_id: journal.operation_record_id,
              directive: d,
              request_bytes: f.store.read(d.request_ref),
            });
            // Explicit synthetic meter fixture; real JSON loader and owners consume its exact
            // final fence-bound snapshot. This is not a real host/hardware measurement claim.
            const snapshot = validateCapacitySnapshot({
              schema_id: "penny.host-capacity-snapshot.v1",
              schema_version: 1,
              operation_record_id: journal.operation_record_id,
              request_sha256: sha256(canonicalJson(demand)),
              lease: journal.lease,
              source_revision: 1,
              evidence_sha256: sha256("synthetic capacity fixture reading"),
              kind: "final",
              readings: demand.demands.map((value) => ({
                resource_id: value.resource_id,
                meters: meters(1),
              })),
            });
            writeFileSync(path.join(f.root, "actual-measurements.json"), canonicalJson(snapshot), {
              mode: 0o600,
            });
          },
        });
        await owner.dispatch(f.engine, d);
        const record = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
        expect(record?.lifecycle).toBe("consumed");
        expect(record?.result_wrapper?.ref).toBeDefined();
        if (withCapacity && record !== undefined)
          expect(capacity?.inspect(record.operation_record_id)).toMatchObject({
            state: "settled",
            snapshot: { kind: "final" },
          });
        expect(
          readFileSync(path.join(destination, intent.exclusive_final_id, "products/master.mp4"))
        ).toEqual(f.store.read(f.p.master));
        await owner.dispatch(f.engine, d);
        expect(readdirSync(destination)).toEqual([intent.exclusive_final_id]);
      } finally {
        rmSync(destination, { recursive: true, force: true });
      }
    });
  it("rejects an explicit ledger predecessor and stale bootstrap reservation for concrete delivery", () => {
    using f = new DeliveryOwnerFixture();
    const manifest = deliveryManifest(f.destination),
      prepared = f.prepare();
    for (const change of ["predecessor", "budget"] as const) {
      const r = recipe(
        "local_delivery",
        "penny.videogen-delivery-operation-request.v1",
        "delivery_intent_ref",
        "delivery_intent",
        f.opaque("expected policy")
      );
      if (change === "predecessor") r.predecessor_slot = "L";
      else {
        delete r.budget_policy;
        r.budget_ref = f.budget_ref;
      }
      const x = prepareRuntime(f, manifest, r);
      setSlot(x.c, executionState(x.c), "delivery_intent", prepared.intent_ref);
      expect(() =>
        x.runtime.effect(
          x.c,
          "local_delivery",
          "delivery",
          "production",
          runtimeRegistrationSha256(f.registration)
        )
      ).toThrow(
        change === "predecessor" ? /PREDECESSOR_CONFLICT/ : /CURRENT_BUDGET_POLICY_REQUIRED/
      );
    }
    expect(readdirSync(f.destination)).toEqual([]);
  });
  it("refuses duplicate meters, envelope overflow, and expired cached current-gate reservations before publication", () => {
    using f = new DeliveryOwnerFixture();
    const manifest = deliveryManifest(f.destination),
      prepared = f.prepare();
    for (const failure of ["duplicate", "overflow", "expired"] as const) {
      const r = recipe(
        "local_delivery",
        "penny.videogen-delivery-operation-request.v1",
        "delivery_intent_ref",
        "delivery_intent",
        f.opaque("expected policy")
      );
      if (r.budget_policy === undefined) throw new Error("fixture policy missing");
      if (failure === "duplicate") r.budget_policy.meters.push({ meter: "attempts", reserved: 1 });
      if (failure === "overflow")
        r.budget_policy.meters = [{ meter: "stored_bytes", reserved: 50000001 }];
      const x = prepareRuntime(f, manifest, r);
      setSlot(x.c, executionState(x.c), "delivery_intent", prepared.intent_ref);
      const dispatch = () =>
        x.runtime.effect(
          x.c,
          "local_delivery",
          "delivery",
          "production",
          runtimeRegistrationSha256(f.registration)
        );
      if (failure === "expired") {
        hostDirective(dispatch());
        const s = executionState(x.c),
          row = s.slots.find((entry) => entry.slot.startsWith("budget-"));
        if (row === undefined) throw new Error("cached reservation missing");
        const current = x.runtime.read(row.ref, BudgetReservationV1Schema);
        const expired = x.runtime.seal(
          x.c,
          "budget-reservation",
          {
            ...current,
            created_at_utc: "2000-01-01T00:00:00.000Z",
            expires_at_utc: "2000-01-01T00:00:01.000Z",
          },
          [f.g5],
          BudgetReservationV1Schema
        );
        setSlot(x.c, s, row.slot, expired);
      }
      expect(dispatch).toThrow(
        failure === "duplicate"
          ? /duplicate recipe budget meter/
          : failure === "overflow"
            ? /BUDGET_ENVELOPE_EXCEEDED/
            : /BUDGET_EXPIRED_OR_CHANGED/
      );
    }
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    expect(readdirSync(f.destination)).toEqual([]);
  });
  it("accepts only the current G4 rough→final host derivation through the compiled native adapter", () => {
    using process = new RunnerFixture();
    const pin = (p: string) => ({ path: realpathSync(p), sha256: sha256(readFileSync(p)) });
    const registry = new KdenliveFixtureRegistry({
      editor_build_digest: process.driver_digest,
      mlt_build_digest: process.driver_digest,
      limits: XML_LIMITS,
      fixtures: ["single.kdenlive", "ordered.kdenlive", "caption.kdenlive"].map((name) => ({
        bytes: saved(name),
        sha256: sha256(saved(name)),
      })),
    });
    const files = ["single.kdenlive", "ordered.kdenlive", "caption.kdenlive"].map((name) => ({
      path: path.join(process.root, name),
      sha256: sha256(saved(name)),
      max_bytes: XML_LIMITS.max_bytes,
    }));
    for (const file of files)
      writeFileSync(file.path, saved(path.basename(file.path)), { mode: 0o600 });
    const manifest: VideogenAdapterManifestV1 = {
      kind: "kdenlive_build_verify",
      policy,
      binding: {
        runtime: {
          bubblewrap: pin("/usr/bin/bwrap"),
          prlimit: pin("/usr/bin/prlimit"),
          unshare: pin("/usr/bin/unshare"),
          mount: pin("/usr/bin/mount"),
          shell: pin("/bin/sh"),
          driver: {
            source: path.join(process.root, "driver"),
            target: "/runtime/driver",
            sha256: process.driver_digest,
          },
          runtime_files: [],
          scratch_root: process.root,
          max_runtime_bytes: 10000000,
        },
        process_policy: NATIVE_TEST_POLICY,
        edit_policy: editPolicy,
        output_root_selector: "native-output",
        registry: {
          editor_build_digest: process.driver_digest,
          mlt_build_digest: process.driver_digest,
          limits: XML_LIMITS,
          fixtures: files,
        },
      },
    };
    const provider = providerFor(manifest);
    using f = new DeliveryOwnerFixture(provider.declaration, [
      { meter: "attempts", limit: 100 },
      { meter: "stored_bytes", limit: 50000000 },
    ]);
    const r = recipe(
      "kdenlive_build_verify",
      "penny.videogen-native-operation-request.v1",
      "native_build_request_ref",
      "native_request",
      f.opaque("expected policy")
    );
    r.input_bindings?.push({ slot: "asset-0", source_slot: "picture" });
    const x = prepareRuntime(f, manifest, r),
      s = executionState(x.c);
    const template = f.json(
      {
        schema_id: "penny.videogen-native-build-request.v1",
        schema_version: 1,
        edit_ref: f.e.edit_ref,
        assets: [{ source_ref: f.e.video, role: "video", relative_path: "assets/video.mp4" }],
        fixture_digest: sha256(saved("single.kdenlive")),
        editor_build_digest: process.driver_digest,
        mlt_build_digest: process.driver_digest,
        feature_subset_digest: registry.digest,
        output_root_selector: "native-output",
        limits: {
          max_xml_bytes: XML_LIMITS.max_bytes,
          max_assets: 8, // Current edit requires video, voice, captions, style and font operands.
          max_duration_frames: 10000,
          max_normalize_ms: 5000,
        },
      },
      NativeBuildRequestV1Schema.properties.schema_id.const
    );
    const result = f.json(
      {
        schema_id: "penny.videogen-shot-result.v1",
        schema_version: 1,
        shot_id: "shot",
        stage: "final",
        clip_ref: f.e.video,
        route_ref: f.opaque("synthetic route"),
        video_evidence_ref: f.opaque("synthetic media qualification"),
        ledger_ref: f.e.ledger_ref,
        shot_media_ref: f.opaque("synthetic shot media"),
        objective_binding_ref: f.opaque("synthetic objective review"),
        quality_binding_ref: f.opaque("synthetic quality review"),
        disposition: "accepted",
      },
      "penny.videogen-shot-result.v1"
    );
    for (const [name, ref] of [
      ["rough_edit", f.e.edit_ref],
      ["final-shot", result],
      ["native_request_template", template],
      ["picture", f.e.video],
    ] as const)
      setSlot(x.c, s, name, ref);
    // This preparation starts a new final edit, not the previously prepared delivery package.
    s.slots = s.slots.filter((row) => row.slot !== "manifest");
    saveExecution(x.c, s);
    x.runtime.inheritRights(x.c, result, [f.e.video], result, "video");
    x.c.transition("finish_prepare");
    x.runtime.host(x.c, runtimeRegistrationSha256(f.registration));
    const d = hostDirective(
      x.runtime.effect(
        x.c,
        "kdenlive_build_verify",
        "finished",
        "shot",
        runtimeRegistrationSha256(f.registration)
      )
    );
    f.checkpointer.saveRun(x.c, "native_runtime_prepared", {});
    const adapter = x.providers.effects
      .get("kdenlive_build_verify")
      ?.createAdapter({ owner: f.binding.owner, store: f.store, checkpointer: f.checkpointer });
    if (adapter === undefined) throw new Error("compiled native missing");
    expect(
      adapter.inspectRequest({
        directive: d,
        declaration: provider.declaration,
        request_bytes: f.store.read(d.request_ref),
        input_artifacts: d.input_artifacts,
      })
    ).toMatchObject({ operation_kind: "kdenlive_build_verify" });
    const editRef = slot(executionState(x.c), "final_edit");
    expect(d.effect_identity?.predecessor_ref).toEqual(editRef);
    const g4 = readVideogenOwnerSelection(f.binding.owner).gate.current_approvals.find(
      (g) => g.gate_id === "G4"
    );
    if (g4 === undefined) throw new Error("G4 missing");
    const packet = x.runtime.read(g4.packet_ref, GatePacketV1Schema);
    expect(packet.presented.some((p) => p.ref.artifact_id === editRef.artifact_id)).toBe(false);
    assertNativeG4Lineage(f.binding.owner, editRef, packet, g4.decision_ref);
    const revoked = f.checkpointer.loadRun(x.c.identity);
    revoked.selectedArtifacts = revoked.selectedArtifacts.filter(
      (ref) => ref.artifact_id !== result.artifact_id
    );
    f.checkpointer.saveRun(revoked, "native_final_revoked", {});
    expect(() =>
      adapter.inspectRequest({
        directive: d,
        declaration: provider.declaration,
        request_bytes: f.store.read(d.request_ref),
        input_artifacts: d.input_artifacts,
      })
    ).toThrow(/lineage|current checkpoint operand selection/);
  });
  it("fresh story rights inherit existing grants and ancestor revocation still refuses use", async () => {
    using f = new FoundationFixture();
    const consent = f.opaque("synthetic consent"),
      source = f.opaque("cleared story input", "text/plain"),
      rights = f.rights(source, "text", [consent]);
    const base = setup(f).providers;
    const asset = base.config.assets[0];
    if (asset === undefined) throw new Error("asset missing");
    const configured = {
      ...base,
      config: validateVideogenPrivateConfig({
        ...base.config,
        rights: f.current_rights,
        assets: [
          {
            ...asset,
            source: "imagegen_fresh",
            input_refs: [],
            consent_ref: consent,
            rights_ref: rights,
          },
        ],
      }),
    };
    const x = setup(f, configured),
      request = videogenStageRequest();
    const identity = {
      schema_version: 2 as const,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript" as const,
    };
    const boundary = await x.runner.runUntilBoundary(
      x.engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal: request.brief,
        constraints: request,
        project_root: path.resolve(import.meta.dirname, "../../.."),
        trust_profile: "hardened-untrusted",
      })
    );
    expect(boundary.action).toBe("await_user");
    const c = f.checkpointer.loadRun(identity),
      s = executionState(c);
    const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, configured);
    const inherited = runtime.read(slot(s, "story_rights"), RightsBindingV1Schema);
    expect(inherited.derived_from_rights_refs).toEqual([rights]);
    expect(inherited.allowed_uses).toEqual(["source", "preview", "motion", "edit", "deliver"]);
    const owner = new (await import("../dist/videogen/owner-selection.js")).VideogenOwnerSelection({
      store: f.store,
      checkpointer: f.checkpointer,
      project_id: f.project_id,
      run_id: f.run_id,
    });
    const h = readVideogenOwnerSelection(owner).rights;
    checkRights(h, slot(s, "canon"), slot(s, "story_rights"), "preview");
    selectVideogenRights(
      c,
      h.current_rights.map((r) =>
        r.subject_ref.artifact_id === source.artifact_id ? { ...r, status: "revoked" } : r
      )
    );
    f.checkpointer.saveRun(c, "ancestor_rights_revoked", {});
    expect(() =>
      checkRights(
        readVideogenOwnerSelection(owner).rights,
        slot(s, "canon"),
        slot(s, "story_rights"),
        "preview"
      )
    ).toThrow(/revoked/);
  });
});
