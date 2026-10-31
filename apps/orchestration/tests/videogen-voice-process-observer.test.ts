import { chmodSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  observeVoiceHostProcess,
  voiceHostFileSha256,
  type VoiceHostServiceObservation,
} from "../dist/videogen/voice-host-process.js";
import {
  VoiceStudioNotReadyError,
  VoiceStudioProcessObserver,
  VoiceStudioServiceObservationFile,
} from "../dist/videogen/voice-studio-process-observer.js";
import { VoiceStudioObservationCollector } from "../dist/videogen/voice-studio-observations.js";
import {
  type VoiceStudioPrivateHostBindingInputsV1,
  createVoiceStudioPrivateHostBinding,
} from "../dist/videogen/voice-studio-adapter.js";
import {
  VoiceStudioChunkPlanV1Schema,
  type VoiceStudioProfileV1,
} from "../dist/videogen/voice-studio-contracts.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { VoiceFixture } from "./helpers/videogen-voice-fixture.js";
import { required } from "./helpers/videogen-media-fixtures.js";

function nativeFixture(f: VoiceFixture, external = false) {
  const pin = (file: string) => ({
    path: realpathSync(file),
    sha256: voiceHostFileSha256(realpathSync(file)),
  });
  const paths = ["source.py", "runtime.txt", "model.weights"].map((name) => {
    const file = path.join(f.root, name);
    writeFileSync(file, `synthetic ${name}`);
    return pin(file);
  });
  const source_files = [required(paths[0])],
    runtime_files = [required(paths[1])],
    model_files = [required(paths[2])];
  const exe = path.join(f.root, external ? "gpu-external" : "gpu-probe");
  // Deterministic local test-only command, not the deployment GPU oracle.
  writeFileSync(
    exe,
    `#!/bin/sh\ncase "$1" in\n--query-gpu=uuid) printf 'GPU-1234\\n';;\n--query-compute-apps=pid,gpu_uuid) printf '${process.pid}, GPU-1234\\n${external ? "999999, GPU-1234\\n" : ""}';;\n*) exit 1;;\nesac\n`,
    { mode: 0o700 }
  );
  const process_pin = {
    pid: process.pid,
    boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start_ticks:
      required(readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1])
        .trim()
        .split(/\s+/u)[19] ?? "",
    executable: pin(realpathSync(`/proc/${process.pid}/exe`)),
    cwd: realpathSync(process.cwd()),
  };
  const build = f.json(
    { schema_version: 1, source_files, runtime_files },
    "penny.test-voice-build.v1"
  );
  const profile: VoiceStudioProfileV1 = {
    ...required(f.profile),
    service_build_ref: build,
    model_sha256: sha256(canonicalJson(model_files)),
  };
  const profile_ref = f.json(profile, profile.schema_id),
    facts = observeVoiceHostProcess(process_pin);
  const service: VoiceHostServiceObservation = {
    schema_version: 1,
    process_epoch: facts.process_epoch,
    service_build_sha256: build.content_digest,
    model_sha256: profile.model_sha256,
    engine: profile.engine,
    observed_at_ms: Date.now(),
    models_loaded: true,
    model_identity_verified: true,
    gpu_uuids: ["GPU-1234"],
    admission: {
      mode: "host_exclusive",
      backend_binding_id: profile.backend_binding_id,
      active_job_ids: [],
      active_unmanaged_calls: 0,
    },
    jobs: [],
  };
  const bindings = {
    profile_ref,
    profile,
    process: process_pin,
    source_files,
    runtime_files,
    model_files,
    gpu: { executable: pin(exe), timeout_ms: 2000, max_output_bytes: 1024 },
    gpu_uuids: ["GPU-1234"],
    isolation: "isolated_loopback" as const,
    max_snapshot_age_ms: 60000,
  };
  const protocol = { read: (): unknown => structuredClone(service) };
  return {
    bindings,
    service,
    protocol,
    observer: new VoiceStudioProcessObserver({ ...bindings, service_observations: protocol }),
  };
}
describe("host-owned Voice Studio process observation (synthetic GPU/protocol, real Linux PID/files)", () => {
  it("derives epoch/pins and refuses absent instrumentation; unloaded models are renewable not-ready", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const n = nativeFixture(f);
    const absent = new VoiceStudioProcessObserver(n.bindings);
    expect(absent.inspect().reasons).toEqual(["service_runtime_instrumentation_required"]);
    expect(() => absent.snapshot()).toThrow(VoiceStudioNotReadyError);
    n.service.models_loaded = false;
    expect(n.observer.inspect().reasons).toContain("models_unloaded_authorized_load_required");
    expect(() => n.observer.snapshot()).toThrow("models_unloaded");
    n.service.models_loaded = true;
    const ready = n.observer.snapshot().raw.readiness;
    expect(ready.process_epoch).toBe(n.service.process_epoch);
    expect(ready.profile_sha256).toBe(n.bindings.profile_ref.content_digest);
    expect(ready.expires_at_ms - ready.observed_at_ms).toBe(60000);
    expect(n.observer.snapshot().raw.coverage).toEqual([]);
  });
  it("requires source/runtime/model pins, exact process identity and unchanged verified files", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const n = nativeFixture(f);
    expect(
      () =>
        new VoiceStudioProcessObserver({
          ...n.bindings,
          model_files: [{ ...required(n.bindings.model_files[0]), sha256: sha256("wrong") }],
        })
    ).toThrow("pin drift");
    expect(() => observeVoiceHostProcess({ ...n.bindings.process, start_ticks: "1" })).toThrow(
      "drifted"
    );
    expect(() =>
      n.observer.requireBinding(required(f.profile_ref), required(f.profile), "isolated_loopback")
    ).toThrow("binding drift");
    writeFileSync(required(n.bindings.source_files[0]).path, "changed source");
    expect(() => n.observer.snapshot()).toThrow("changed");
  });
  it("rejects stale, wrong-worker, wrong-model, wrong-device, unmanaged and other-job observations", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const n = nativeFixture(f),
      original = structuredClone(n.service);
    const changes: Partial<VoiceHostServiceObservation>[] = [
      { observed_at_ms: Date.now() - 60001 },
      { observed_at_ms: Date.now() + 60000 },
      { process_epoch: sha256("other") },
      { model_sha256: sha256("other") },
      { service_build_sha256: sha256("other") },
      { gpu_uuids: ["GPU-abcd"] },
      { admission: { ...original.admission, mode: "uncontrolled" } },
      { admission: { ...original.admission, active_unmanaged_calls: 1 } },
      { admission: { ...original.admission, active_job_ids: ["other"] } },
    ];
    for (const change of changes) {
      Object.assign(n.service, structuredClone(original), change);
      expect(() => n.observer.snapshot()).toThrow(VoiceStudioNotReadyError);
    }
    Object.assign(n.service, original);
    expect(n.observer.snapshot().raw.readiness.external_work).toBe("excluded");
    const other = nativeFixture(f, true);
    expect(other.observer.inspect().reasons).toContain("external_gpu_process_present");
    expect(() => other.observer.snapshot()).toThrow("external_gpu");
  });
  it("maps actual completed job ordinals only with exact source text, resolved voice, fallback and error facts", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const n = nativeFixture(f);
    const old = required(f.request),
      request = {
        ...old,
        profile_ref: n.bindings.profile_ref,
        service_build_ref: n.bindings.profile.service_build_ref,
      };
    const plan = required(f.authority).read(
      request.chunk_plan_ref,
      VoiceStudioChunkPlanV1Schema,
      "penny.videogen-voice-studio-chunk-plan.v1"
    );
    const correlation = {
      schema_id: "penny.videogen-voice-studio-correlation.v1" as const,
      schema_version: 1 as const,
      request_sha256: sha256(canonicalJson(request)),
      profile_sha256: n.bindings.profile_ref.content_digest,
      process_epoch: n.service.process_epoch,
      job_id: "actual-job",
      narration_item_id: f.narration.id,
    };
    const input = { correlation, request, narration: f.narration, plan };
    expect(() => n.observer.snapshot(input)).toThrow("correlation");
    const chunk = {
      ordinal: 0,
      segment_id: "actual-chunk",
      text_sha256: sha256(required(plan.chunks[0]).text),
      voice_id: request.voice_id,
      resolved_voice_sha256: n.bindings.profile.voice_sha256,
      fallback_used: false,
      status: "completed",
      error_present: false,
    };
    const job = {
      job_id: correlation.job_id,
      narration_item_id: f.narration.id,
      status: "completed",
      narration_sha256: sha256(canonicalJson(f.narration)),
      chunks: [chunk],
    };
    n.service.jobs = [job];
    expect(n.observer.snapshot(input).raw.coverage[0]?.chunks).toEqual([
      {
        chunk_id: required(plan.chunks[0]).chunk_id,
        segment_id: chunk.segment_id,
        text_sha256: chunk.text_sha256,
        voice_id: request.voice_id,
        resolved_voice_sha256: n.bindings.profile.voice_sha256,
        fallback_used: false,
        status: "completed",
        error: null,
      },
    ]);
    const original = structuredClone(chunk);
    for (const change of [
      { fallback_used: true },
      { resolved_voice_sha256: sha256("other voice") },
      { voice_id: null },
      { text_sha256: sha256("other words") },
      { ordinal: 1 },
      { status: "running" },
      { error_present: true },
    ]) {
      Object.assign(chunk, original, change);
      expect(() => n.observer.snapshot(input)).toThrow("unproven");
    }
    Object.assign(chunk, original);
    n.service.jobs.push(structuredClone(job));
    expect(() => n.observer.snapshot(input)).toThrow("correlation");
  });
  it("collects native observations through the concrete collector, without requiring a fictional snapshot exporter", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const n = nativeFixture(f);
    const collector = new VoiceStudioObservationCollector({
      owner: required(f.authority).bindings.owner,
      profile_ref: n.bindings.profile_ref,
      profile: n.bindings.profile,
      transport: { mode: "isolated_loopback", origin: f.origin },
      process_observer: n.observer,
    });
    const ref = await collector.collect("readiness", new AbortController().signal);
    expect(collector.selected("readiness")).toEqual(ref);
    expect(f.calls).toEqual([
      `GET /api/voices/${f.voice.id}`,
      `GET /api/voices/${f.voice.id}/sample`,
    ]);
    n.service.models_loaded = false;
    expect(() => collector.selected("readiness")).toThrow("models_unloaded");
    await expect(collector.collect("readiness", new AbortController().signal)).rejects.toThrow(
      "models_unloaded"
    );
    n.service.models_loaded = true;
    n.service.process_epoch = sha256("restart");
    await expect(collector.collect("readiness", new AbortController().signal)).rejects.toThrow(
      "identity_drift"
    );
  });
  it("loads bounded canonical owner-private service facts; refuses world-readable and symlink exports", async () => {
    await using f = new VoiceFixture();
    const file = path.join(f.root, "service-facts.json");
    writeFileSync(file, canonicalJson({ schema_version: 1 }), { mode: 0o600 });
    const source = new VoiceStudioServiceObservationFile(file, 1024);
    expect(source.read()).toEqual({ schema_version: 1 });
    chmodSync(file, 0o644);
    expect(() => source.read()).toThrow("unsafe");
    chmodSync(file, 0o600);
    const link = path.join(f.root, "link.json");
    symlinkSync(file, link);
    expect(() => new VoiceStudioServiceObservationFile(link, 1024).read()).toThrow();
    writeFileSync(file, '{"schema_version":1,"schema_version":1}');
    expect(() => source.read()).toThrow("duplicate");
    writeFileSync(file, canonicalJson({ value: "x".repeat(2000) }));
    expect(() => source.read()).toThrow("unsafe");
  });
  it("constructs real host ports from literal typed private inputs, without starting an operation", async () => {
    await using f = new VoiceFixture();
    await f.start();
    const { observations: _old, ...authority } = required(f.authority).bindings;
    const input: VoiceStudioPrivateHostBindingInputsV1 = {
      authority,
      observation_source: { process_snapshot_path: f.observation_path },
      declaration: f.declaration,
      cache: await FileHostOperationResultCache.provision(path.join(f.root, "factory-cache")),
    };
    const bound = createVoiceStudioPrivateHostBinding(input);
    expect(bound.capacityRuntime).toBe(f.capacity);
    expect(bound.adapters.size).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    expect(() => {
      Reflect.apply(createVoiceStudioPrivateHostBinding, undefined, [
        { ...input, observation_source: {} },
      ]);
    }).toThrow("exactly one");
  });
});
