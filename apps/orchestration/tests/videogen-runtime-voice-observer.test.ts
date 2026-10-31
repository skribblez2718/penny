import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import {
  voiceHostFileSha256,
  observeVoiceHostProcess,
  type VoiceHostServiceObservation,
} from "../dist/videogen/voice-host-process.js";
import {
  createVoiceStudioHostProcessObserver,
  VoiceStudioHostObservationSourceSchema,
  VoiceStudioHostProcessBindingSchema,
  type VoiceStudioHostProcessBinding,
} from "../dist/videogen/runtime-voice-observer.js";
import {
  loadVideogenRuntimeFromEnvironment,
  parseVideogenRuntimeManifest,
  VIDEOGEN_RUNTIME_MANIFEST_ENV,
} from "../dist/videogen/runtime-manifest.js";
import { VoiceStudioAdapter } from "../dist/videogen/voice-studio-adapter.js";
import { VoiceFixture } from "./helpers/videogen-voice-fixture.js";
import { required } from "./helpers/videogen-media-fixtures.js";
import { meters } from "./helpers/capacity-fixtures.js";

async function fixture(f: VoiceFixture) {
  await f.start();
  const pin = (file: string) => ({
    path: realpathSync(file),
    sha256: voiceHostFileSha256(realpathSync(file)),
  });
  const file = (name: string) => {
    const target = path.join(f.root, name);
    writeFileSync(target, `Synthetic ${name}`, { mode: 0o600 });
    return pin(target);
  };
  const source_files = [file("source.txt")],
    runtime_files = [file("runtime.txt")],
    model_files = [file("model.txt")];
  const gpu = path.join(f.root, "synthetic-gpu"),
    probe_calls = path.join(f.root, "synthetic-gpu.calls");
  writeFileSync(
    gpu,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${probe_calls}'\ncase "$1" in\n--query-gpu=uuid) printf 'GPU-1234\\n';;\n--query-compute-apps=pid,gpu_uuid) printf '${process.pid}, GPU-1234\\n';;\n*) exit 1;;\nesac\n`,
    { mode: 0o700 }
  );
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const binding: VoiceStudioHostProcessBinding = {
    process: {
      pid: process.pid,
      boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      start_ticks: required(
        stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/u)[19]
      ),
      executable: pin(realpathSync(`/proc/${process.pid}/exe`)),
      cwd: realpathSync(process.cwd()),
    },
    source_files,
    runtime_files,
    model_files,
    gpu: { executable: pin(gpu), timeout_ms: 2000, max_output_bytes: 1024 },
    gpu_uuids: ["GPU-1234"],
    max_snapshot_age_ms: 60000,
  };
  const build = f.json(
    { schema_version: 1, source_files, runtime_files },
    "penny.test-voice-build.v1"
  );
  const profile = {
    ...required(f.profile),
    service_build_ref: build,
    model_sha256: sha256(canonicalJson(model_files)),
  };
  const profile_ref = f.json(profile, profile.schema_id);
  const service: VoiceHostServiceObservation = {
    schema_version: 1,
    process_epoch: observeVoiceHostProcess(binding.process).process_epoch,
    service_build_sha256: build.content_digest,
    model_sha256: profile.model_sha256,
    engine: profile.engine,
    observed_at_ms: Date.now(),
    models_loaded: false,
    model_identity_verified: false,
    gpu_uuids: binding.gpu_uuids,
    admission: {
      mode: "uncontrolled",
      backend_binding_id: profile.backend_binding_id,
      active_job_ids: [],
      active_unmanaged_calls: null,
    },
    jobs: [],
  };
  return {
    binding,
    profile_ref,
    profile,
    service,
    probe_calls,
    isolation: "isolated_loopback" as const,
  };
}
function observerManifest(f: VoiceFixture, binding: unknown) {
  const base = parseVideogenRuntimeManifest(
    JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "fixtures/videogen-minimal-manifest.json"),
        "utf8"
      )
    )
  );
  const d = f.declaration;
  return {
    ...base,
    adapters: [
      {
        kind: "voice_job",
        policy: {
          backend_binding_id: d.backend_binding_id,
          backend_key_sha256: sha256("synthetic voice worker"),
          lease_profile_id: d.lease_profile.profile_id,
          lease_duration_ms: d.lease_profile.duration_ms,
          lease_renew_after_ms: d.lease_profile.renew_after_ms,
          queue_inactivity_ms: d.lease_profile.queue_inactivity_ms,
          operation_inactivity_ms: d.operation_inactivity_ms,
          max_request_bytes: d.max_request_bytes,
          max_input_bytes: d.max_input_bytes,
          max_output_bytes: d.max_output_bytes,
          max_progress_events: d.max_progress_events,
        },
        binding,
      },
    ],
    capacity: {
      policy: f.policy,
      measurement_file: path.join(f.root, "actual-capacity-readings.json"),
      demands: [
        {
          operation_kind: "voice_job",
          binding_id: "voice-binding",
          demands: ["shared-gpu", "shared-store"].map((resource_id) => ({
            resource_id,
            slots: 1,
            meters: meters(2000000),
          })),
        },
      ],
    },
  };
}
function loadDefault(f: VoiceFixture, manifest: unknown) {
  const filename = path.join(f.root, "private-voice-manifest.json");
  writeFileSync(filename, canonicalJson(manifest), { mode: 0o600 });
  return required(
    loadVideogenRuntimeFromEnvironment({
      env: { [VIDEOGEN_RUNTIME_MANIFEST_ENV]: filename },
      store: f.store,
      project_id: f.project_id,
    })
  );
}
function nativeBinding(f: VoiceFixture, n: Awaited<ReturnType<typeof fixture>>) {
  return {
    profile_ref: n.profile_ref,
    profile: n.profile,
    transport: { mode: n.isolation, origin: f.origin },
    process_observer: n.binding,
    legacy_http: true,
  };
}
function createDefaultAdapter(
  f: VoiceFixture,
  providers: ReturnType<typeof loadDefault>
): VoiceStudioAdapter {
  const provider = required(providers.effects.get("voice_job"));
  const adapter = provider.createAdapter({
    owner: required(f.authority).bindings.owner,
    store: f.store,
    checkpointer: f.checkpointer,
    capacity: { runtime: f.capacity, authority: f.capacity_authority },
  });
  if (!(adapter instanceof VoiceStudioAdapter)) throw new Error("concrete voice adapter missing");
  return adapter;
}
describe("fixed JSON native voice observer loader (synthetic GPU, actual local process/files)", () => {
  it("accepts exactly one closed source and rejects callbacks, readiness flags, shell args and oversized probes", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f);
    expect(
      validateContract(
        VoiceStudioHostObservationSourceSchema,
        { process_observer: n.binding },
        "source"
      )
    ).toEqual({ process_observer: n.binding });
    for (const value of [
      {},
      { process_observer: n.binding, process_snapshot_path: "/unused" },
      { process_observer: { ...n.binding, ready: true } },
      { process_observer: { ...n.binding, service_observations: { read: () => n.service } } },
      { process_observer: { ...n.binding, gpu: { ...n.binding.gpu, args: ["--execute"] } } },
      { process_observer: { ...n.binding, gpu: { ...n.binding.gpu, timeout_ms: 30001 } } },
    ])
      expect(() =>
        validateContract(VoiceStudioHostObservationSourceSchema, value, "source")
      ).toThrow();
    expect(() =>
      validateContract(
        VoiceStudioHostProcessBindingSchema,
        { ...n.binding, model_files: [] },
        "binding"
      )
    ).toThrow();
  });
  it("constructs the actual native observer and never promotes missing instrumentation, unloaded models or unknown admission", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f);
    const absent = createVoiceStudioHostProcessObserver(n);
    expect(absent.inspect().reasons).toContain("service_runtime_instrumentation_required");
    expect(() => absent.snapshot()).toThrow("not ready");
    const filename = path.join(f.root, "private-observations.json");
    writeFileSync(filename, canonicalJson(n.service), { mode: 0o600 });
    const observer = createVoiceStudioHostProcessObserver({
      ...n,
      binding: { ...n.binding, service_observations: { path: filename, max_bytes: 65536 } },
    });
    expect(observer.inspect().reasons).toEqual([
      "loaded_model_identity_unverified",
      "models_unloaded_authorized_load_required",
      "exclusive_service_admission_not_established",
    ]);
    expect(() => observer.snapshot()).toThrow("not ready");
    writeFileSync(filename, canonicalJson({ ready: true }));
    expect(() => observer.inspect()).toThrow();
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
  it("snapshots JSON pins and refuses changed source/model bytes or malformed private service exports", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f);
    const observer = createVoiceStudioHostProcessObserver(n);
    n.binding.gpu_uuids.splice(0);
    expect(observer.inspect().reasons).toEqual(["service_runtime_instrumentation_required"]);
    writeFileSync(required(n.binding.model_files[0]).path, "changed bytes");
    expect(() => observer.inspect()).toThrow("changed");
    expect(() =>
      createVoiceStudioHostProcessObserver({
        ...n,
        binding: { ...n.binding, gpu_uuids: ["GPU-1234"] },
      })
    ).toThrow("pin drift");
  });
});
describe("DEFAULT private manifest voice observer integration (no real GPU/model work)", () => {
  it.each(["native", "snapshot"] as const)(
    "constructs the compiled %s source with concrete current owners and mandatory capacity",
    async (source) => {
      await using f = new VoiceFixture();
      const n = await fixture(f);
      const binding =
        source === "native"
          ? nativeBinding(f, n)
          : {
              profile_ref: required(f.profile_ref),
              profile: required(f.profile),
              transport: { mode: "isolated_loopback", origin: f.origin },
              process_snapshot_path: f.observation_path,
              legacy_http: true,
            };
      const manifest = observerManifest(f, binding);
      const { capacity: _capacity, ...withoutCapacity } = manifest;
      expect(() => loadDefault(f, withoutCapacity)).toThrow("VIDEOGEN_CAPACITY_REQUIRED");
      expect(() =>
        loadDefault(
          f,
          observerManifest(f, {
            ...binding,
            profile_ref: { ...binding.profile_ref, content_digest: sha256("other profile") },
          })
        )
      ).toThrow("voice observer profile binding drift");
      const providers = loadDefault(f, manifest);
      expect([...providers.effects.keys()]).toEqual(["voice_job"]);
      expect(providers.capacity_options).toBeDefined();
      const adapter = createDefaultAdapter(f, providers);
      expect(adapter.authority.bindings.capacity).toBe(f.capacity);
      expect(adapter.authority.bindings.capacity_authority).toBe(f.capacity_authority);
      expect(adapter.authority.bindings.owner).toBe(required(f.authority).bindings.owner);
      expect(existsSync(n.probe_calls)).toBe(false);
      expect(f.calls).toEqual([]);
      expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
      expect(() =>
        required(providers.effects.get("voice_job")).createAdapter({
          owner: required(f.authority).bindings.owner,
          store: f.store,
          checkpointer: f.checkpointer,
        })
      ).toThrow("VIDEOGEN_VOICE_CAPABILITY_MISSING");
      if (source === "snapshot") {
        const ref = await adapter.authority.bindings.observations.collect(
          "readiness",
          new AbortController().signal
        );
        expect(adapter.authority.bindings.observations.selected("readiness")).toEqual(ref);
        expect(f.calls).toEqual([
          `GET /api/voices/${f.voice.id}`,
          `GET /api/voices/${f.voice.id}/sample`,
        ]);
      }
    }
  );
  it("rejects both/neither sources, extra module selectors and fabricated PASS flags before publication", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f),
      native = nativeBinding(f, n),
      { process_observer: _observer, ...base } = native;
    for (const binding of [
      base,
      { ...native, process_snapshot_path: f.observation_path },
      { ...native, module: "untrusted-observer.mjs" },
      { ...native, process_observer: { ...n.binding, module: "untrusted-observer.mjs" } },
      { ...native, process_observer: { ...n.binding, ready: true } },
      {
        ...native,
        process_observer: {
          ...n.binding,
          service_observations: { path: "/unused", max_bytes: 1024, pass: true },
        },
      },
    ]) {
      const manifest = observerManifest(f, binding);
      expect(() => loadDefault(f, manifest)).toThrow();
      const first = required(manifest.artifacts[0]);
      expect(
        f.store.refFor(
          `videogen-bootstrap-${sha256(canonicalJson(manifest))}`,
          "private-config",
          null,
          first.kind,
          `videogen-bootstrap:${first.id}`,
          1
        )
      ).toBeNull();
    }
    expect(existsSync(n.probe_calls)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
  it.each([
    "profile",
    "process",
    "source",
    "runtime",
    "model",
    "build-manifest",
    "model-manifest",
  ] as const)(
    "refuses %s pin/ref mismatch eagerly in DEFAULT bootstrap, not at first effect",
    async (mismatch) => {
      await using f = new VoiceFixture();
      const n = await fixture(f),
        binding = nativeBinding(f, n);
      switch (mismatch) {
        case "profile":
          binding.profile_ref = { ...n.profile_ref, content_digest: sha256("other profile") };
          break;
        case "process":
          binding.process_observer.process.start_ticks = "0";
          break;
        case "source":
          writeFileSync(required(n.binding.source_files[0]).path, "changed source bytes");
          break;
        case "runtime":
          writeFileSync(required(n.binding.runtime_files[0]).path, "changed runtime bytes");
          break;
        case "model":
          writeFileSync(required(n.binding.model_files[0]).path, "changed model bytes");
          break;
        case "build-manifest":
          binding.profile = {
            ...n.profile,
            service_build_ref: {
              ...n.profile.service_build_ref,
              content_digest: sha256("other build"),
            },
          };
          binding.profile_ref = f.json(binding.profile, binding.profile.schema_id);
          break;
        case "model-manifest":
          binding.profile = { ...n.profile, model_sha256: sha256("other model manifest") };
          binding.profile_ref = f.json(binding.profile, binding.profile.schema_id);
          break;
      }
      const manifest = observerManifest(f, binding);
      expect(() => loadDefault(f, manifest)).toThrow(/drift/u);
      const first = required(manifest.artifacts[0]);
      expect(
        f.store.refFor(
          `videogen-bootstrap-${sha256(canonicalJson(manifest))}`,
          "private-config",
          null,
          first.kind,
          `videogen-bootstrap:${first.id}`,
          1
        )
      ).toBeNull();
      expect(existsSync(n.probe_calls)).toBe(false);
      expect(f.calls).toEqual([]);
      expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    }
  );
  it("passes the real class to the current-owner collector and keeps absent instrumentation NOT READY", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f),
      providers = loadDefault(f, observerManifest(f, nativeBinding(f, n))),
      adapter = createDefaultAdapter(f, providers),
      before = required(f.checkpointer.loadRunById(f.run_id)).selectedArtifacts;
    await expect(
      adapter.authority.bindings.observations.collect("readiness", new AbortController().signal)
    ).rejects.toThrow("service_runtime_instrumentation_required");
    expect(readFileSync(n.probe_calls, "utf8").trim().split("\n")).toEqual([
      "--query-gpu=uuid",
      "--query-compute-apps=pid,gpu_uuid",
    ]);
    expect(required(f.checkpointer.loadRunById(f.run_id)).selectedArtifacts).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
  it("retains the bootstrap observer's verified file stamps instead of rebinding pins at first effect", async () => {
    await using f = new VoiceFixture();
    const n = await fixture(f),
      providers = loadDefault(f, observerManifest(f, nativeBinding(f, n)));
    writeFileSync(required(n.binding.source_files[0]).path, "changed after bootstrap");
    const adapter = createDefaultAdapter(f, providers);
    await expect(
      adapter.authority.bindings.observations.collect("readiness", new AbortController().signal)
    ).rejects.toThrow("voice pinned file changed");
    expect(existsSync(n.probe_calls)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
});
