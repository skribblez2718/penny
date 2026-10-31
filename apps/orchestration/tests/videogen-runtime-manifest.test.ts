import path from "node:path";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OrchestrationService } from "../dist/service.js";
import {
  bootstrapVideogenRuntime,
  buildVideogenRuntimeManifest,
  loadVideogenRuntimeFromEnvironment,
  parseVideogenRuntimeManifest,
  readVideogenPrivateFile,
  resolveVideogenSymbols,
  VIDEOGEN_RUNTIME_MANIFEST_ENV,
} from "../dist/videogen/runtime-manifest.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import {
  ManifestVideogenFixture,
  minimalVideogenManifest,
} from "./helpers/videogen-manifest-fixture.js";
import { capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import { validateCapacityRequest } from "../dist/host-operations/capacity-contracts.js";
import { createComfyVideogenDeclaration } from "../dist/videogen/operation-owner.js";
import { createComfyVideoUploadDeclaration } from "../dist/videogen/upload-operation.js";
function manifest(config: unknown) {
  return {
    schema_id: "penny.videogen-runtime-manifest.v1",
    schema_version: 1,
    artifacts: [
      {
        id: "capability",
        kind: "fixture-capability",
        media_type: "application/json",
        source: { json: { fixture: true } },
      },
    ],
    config,
    recipes: [],
    adapters: [],
  };
}
describe("explicit private videogen environment loader", () => {
  it("emits a complete portable JSON fixture using the typed builder, with no generating-store refs", () => {
    using source = new ManifestVideogenFixture();
    const generated = minimalVideogenManifest(source);
    const checked = parseVideogenRuntimeManifest(
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "fixtures/videogen-minimal-manifest.json"),
          "utf8"
        )
      )
    );
    expect(buildVideogenRuntimeManifest(generated)).toEqual(checked);
    using target = new ManifestVideogenFixture();
    const providers = bootstrapVideogenRuntime({
      manifest: checked,
      store: target.store,
      project_id: target.project_id,
    });
    expect(providers.config.context).toBe("isolated_fixture");
    expect(providers.config.model_capability_ref.producer).toBe("host:videogen-bootstrap");
    expect(target.store.read(providers.config.model_capability_ref).length).toBeGreaterThan(0);
    expect(providers.effects.size).toBe(0);
  });
  it("default service reaches and recovers the exact G1 without constructor provider injection", async () => {
    using f = new ManifestVideogenFixture();
    const x = setup(f),
      filename = path.join(f.root, "private-runtime.json"),
      m = minimalVideogenManifest(f);
    writeFileSync(filename, canonicalJson(m), { mode: 0o600 });
    const env = { PENNY_STATE_ROOT: f.stateRoot, [VIDEOGEN_RUNTIME_MANIFEST_ENV]: filename };
    const request = videogenStageRequest(),
      identity = {
        schema_version: 2 as const,
        run_id: f.run_id,
        session_id: f.run_id,
        playbook: "videogen",
        engine_owner: "typescript" as const,
      };
    let first;
    {
      using service = new OrchestrationService({
        projectRoot: f.root,
        env,
        playbookName: "videogen",
        modelClient: x.client,
      });
      first = await service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: request.brief,
        constraints: request,
        project_root: f.root,
        trust_profile: "hardened-untrusted",
      });
      expect(first.action).toBe("await_user");
    }
    {
      using service = new OrchestrationService({
        projectRoot: f.root,
        env,
        playbookName: "videogen",
        modelClient: x.client,
      });
      expect(await service.execute({ schema_version: 2, action: "recover", identity })).toEqual(
        first
      );
    }
    const a = loadVideogenRuntimeFromEnvironment({ env, store: f.store, project_id: f.project_id }),
      b = loadVideogenRuntimeFromEnvironment({ env, store: f.store, project_id: f.project_id });
    expect(a?.config.model_capability_ref).toEqual(b?.config.model_capability_ref);
  });
  it("requires canonical owner-only regular private files; rejects symlinks and mode drift", () => {
    using f = new ManifestVideogenFixture();
    const file = path.join(f.root, "input.json"),
      link = path.join(f.root, "link.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    expect(readVideogenPrivateFile(file, 16).toString()).toBe("{}");
    expect(() => readVideogenPrivateFile(file, 1)).toThrow();
    symlinkSync(file, link);
    expect(() => readVideogenPrivateFile(link, 16)).toThrow(/UNSAFE/);
    chmodSync(file, 0o644);
    expect(() => readVideogenPrivateFile(file, 16)).toThrow(/UNSAFE/);
  });
  it("rejects executable/module selectors, unsafe keys, missing symbols and excessive nesting", () => {
    expect(() =>
      parseVideogenRuntimeManifest({ ...manifest({}), module: "operator-code" })
    ).toThrow();
    expect(() => parseVideogenRuntimeManifest(JSON.parse('{"__proto__":{}}'))).toThrow(
      /UNSAFE_KEY/
    );
    expect(() => resolveVideogenSymbols({ $artifact: "absent" }, new Map())).toThrow(
      /missing_input/
    );
    let value: unknown = {};
    for (let i = 0; i < 50; i++) value = { next: value };
    expect(() => parseVideogenRuntimeManifest(value)).toThrow(/COMPLEXITY/);
  });
  it("validates resolved configuration and pinned input bytes before bootstrap publication", () => {
    using f = new ManifestVideogenFixture();
    const x = setup(f),
      m = manifest({ ...x.providers.config, activation: "bogus" }),
      digest = sha256(canonicalJson(m));
    expect(() =>
      bootstrapVideogenRuntime({ manifest: m, store: f.store, project_id: f.project_id })
    ).toThrow();
    expect(
      f.store.refFor(
        `videogen-bootstrap-${digest}`,
        "private-config",
        null,
        "fixture-capability",
        "videogen-bootstrap:capability",
        1
      )
    ).toBeNull();
    const file = path.join(f.root, "seed.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const bad = {
      ...manifest(x.providers.config),
      artifacts: [
        {
          id: "seed",
          kind: "seed",
          media_type: "application/json",
          source: { file: { path: file, sha256: "a".repeat(64), max_bytes: 100 } },
        },
      ],
    };
    expect(() =>
      bootstrapVideogenRuntime({ manifest: bad, store: f.store, project_id: f.project_id })
    ).toThrow(/DRIFT/);
  });
  it("rejects duplicate keys, lossy UTF-8 and non-data bindings before publication", () => {
    using f = new ManifestVideogenFixture();
    const filename = path.join(f.root, "malformed-manifest.json");
    const load = () =>
      loadVideogenRuntimeFromEnvironment({
        env: { [VIDEOGEN_RUNTIME_MANIFEST_ENV]: filename },
        store: f.store,
        project_id: f.project_id,
      });
    writeFileSync(filename, '{"schema_version":1,"schema_version":1}', { mode: 0o600 });
    expect(load).toThrow("VIDEOGEN_MANIFEST_INVALID_JSON");
    writeFileSync(filename, Buffer.from([0x22, 0xff, 0x22]));
    expect(load).toThrow("VIDEOGEN_MANIFEST_INVALID_JSON");
    const getter = vi.fn(() => ({}));
    const object = Object.defineProperty({}, "config", { get: getter, enumerable: true });
    expect(() => parseVideogenRuntimeManifest(object)).toThrow("PLAIN_JSON_REQUIRED");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseVideogenRuntimeManifest({ ...manifest({}), adapters: [{ createAdapter: () => true }] })
    ).toThrow();
  });
  it("an absent manifest does not invent a deployment", () => {
    using f = new ManifestVideogenFixture();
    expect(
      loadVideogenRuntimeFromEnvironment({ env: {}, store: f.store, project_id: f.project_id })
    ).toBeUndefined();
  });
  it("constructs only compiled pinned Comfy bindings from JSON, without contacting a backend", async () => {
    const { syntheticVideogenProfile } = await import("./helpers/videogen-fixtures.js");
    const { createVideogenRegistration } = await import("../dist/playbooks/videogen.js");
    const { validateRegistrationContract } = await import("../dist/playbooks/registry.js");
    using f = new ManifestVideogenFixture();
    const x = setup(f),
      profile = syntheticVideogenProfile({ port: 1, mode: "t2v" });
    const policy = {
      backend_binding_id: "fixture-video",
      backend_key_sha256: "a".repeat(64),
      lease_profile_id: "fixture-video-lease",
      lease_duration_ms: 30000,
      lease_renew_after_ms: 5000,
      queue_inactivity_ms: 30000,
      operation_inactivity_ms: 30000,
      max_request_bytes: 1000000,
      max_input_bytes: 1000000,
      max_output_bytes: 1000000,
      max_progress_events: 128,
    };
    const binding = {
      legacy_http: true,
      profiles: [profile],
      approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
    };
    const declarations = [
      createComfyVideogenDeclaration({ ...policy, effect_protocol: "request_intent_v1" }),
      createComfyVideoUploadDeclaration({ ...policy, effect_protocol: "request_intent_v1" }),
    ];
    const capacity = {
      policy: {
        ...capacityPolicy(),
        bindings: declarations.map((d) => ({
          binding_id: d.operation_kind,
          operation_kind: d.operation_kind,
          adapter_id: d.adapter_id,
          backend_binding_id: d.backend_binding_id,
          worker_id: "fixture-video-worker",
          resource_ids: ["gpu-a", "store-a"],
          purpose: "work" as const,
        })),
      },
      measurement_file: path.join(f.root, "actual-measurements.json"),
      demands: declarations.map((d) => ({
        operation_kind: d.operation_kind,
        binding_id: d.operation_kind,
        demands: [
          { resource_id: "store-a", slots: 1, meters: meters(2) },
          { resource_id: "gpu-a", slots: 1, meters: meters(1) },
        ],
      })),
    };
    const m = {
      ...manifest(x.providers.config),
      adapters: [
        { kind: "video_render", policy, binding },
        { kind: "reference_upload", policy, binding },
      ],
    };
    expect(() =>
      bootstrapVideogenRuntime({ manifest: m, store: f.store, project_id: f.project_id })
    ).toThrow(/CAPACITY_REQUIRED/);
    const providers = bootstrapVideogenRuntime({
      manifest: { ...m, capacity },
      store: f.store,
      project_id: f.project_id,
    });
    // Construction snapshots policy and demands; caller mutation cannot rebind an admitted closure.
    const originalDemand = capacity.demands[0];
    if (originalDemand === undefined) throw new Error("fixture capacity demand missing");
    expect(originalDemand.demands.map((row) => row.resource_id)).toEqual(["store-a", "gpu-a"]);
    originalDemand.demands.splice(0);
    const demandSource = providers.capacity_options?.demands;
    if (demandSource === undefined) throw new Error("capacity demand source missing");
    const selected: unknown = Reflect.apply(demandSource.requestFor, demandSource, [
      {
        project_id: f.project_id,
        operation_record_id: `hop_${"a".repeat(64)}`,
        directive: { operation_kind: "video_render" },
      },
    ]);
    expect(validateCapacityRequest(selected).demands).toEqual([
      { resource_id: "gpu-a", slots: 1, meters: meters(1) },
      { resource_id: "store-a", slots: 1, meters: meters(2) },
    ]);
    expect(() =>
      bootstrapVideogenRuntime({
        manifest: { ...m, capacity },
        store: f.store,
        project_id: f.project_id,
      })
    ).toThrow();
    const measurementSource = providers.capacity_options?.measurements;
    if (measurementSource === undefined) throw new Error("actual meter source missing");
    expect(() => {
      Reflect.apply(measurementSource.read, measurementSource, [{}]);
    }).toThrow();
    writeFileSync(capacity.measurement_file, canonicalJson({ estimated: true, readings: [] }), {
      mode: 0o600,
    });
    expect(() => {
      Reflect.apply(measurementSource.read, measurementSource, [{}]);
    }).toThrow();
    expect([...providers.effects.keys()]).toEqual(["video_render", "reference_upload"]);
    expect(providers.effects.get("video_render")?.declaration.effect_protocol).toBe(
      "request_intent_v1"
    );
    validateRegistrationContract(createVideogenRegistration(providers), f.root);
  });
});
