import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  VoicePreparationObserver,
  VoicePreparationBindingsSchema,
} from "../dist/videogen/voice-preparation.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { nativeCapacityFixture } from "./helpers/native-capacity-fixture.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import type { InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { hostOperationPolicyBinding } from "../dist/host-operations/contracts.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { runtimeRegistrationSha256, skillContractSha256 } from "../dist/playbooks/registry.js";
import {
  voicePreparationRegistration,
  voicePreparationDemands,
} from "../dist/videogen/voice-preparation-job.js";
import {
  VoicePreparationAdapter,
  VOICE_PREPARATION_ADAPTER,
  VOICE_PREPARATION_REQUEST,
  voicePreparationDeclaration,
  type VoicePreparationRequest,
} from "../dist/videogen/voice-preparation.js";
import { capacityPolicy } from "./helpers/capacity-fixtures.js";
import { CapacityRuntimeFixture } from "./helpers/capacity-runtime-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

/** Real engine, catalog, fenced holds, journals and synthetic final/reopen. Engine residency and counters
 * are controlled here; actual IPC preload is separately tested against the private fake app. */
function setup(failure: "none" | "partial" | "drain" = "none") {
  const policy = capacityPolicy();
  const binding = requireValue(
    policy.bindings.find((x) => x.binding_id === "video-a"),
    "binding"
  );
  binding.operation_kind = "voice_model_preparation";
  binding.adapter_id = VOICE_PREPARATION_ADAPTER;
  const f = new CapacityRuntimeFixture(policy);
  const epoch = sha256("controlled same process epoch");
  const request: VoicePreparationRequest = {
    schema_id: "penny.voice-preparation-request.v1",
    schema_version: 1,
    run_id: "cold-preparation",
    operation_id: "cold-preparation-op",
    brief: "Explicit isolated preparation request; not narration approval.",
    bindings_sha256: sha256("controlled bindings"),
    max_runtime_ms: 1000,
    cpu_cores: 1,
    max_output_bytes: 65536,
    max_transfer_bytes: 65536,
  };
  const registration = voicePreparationRegistration("fixture-service", request, f.capacity);
  const engine = () =>
    new OrchestrationEngine(f.checkpointer, {
      projectRoot: f.config.projectRoot,
      maxSteps: 32,
      receiptAuthority: ReceiptAuthority.loadExisting(f.config.receiptKeyPath),
      artifactStore: f.artifacts,
      artifactReader: f.artifacts,
      artifactRevisions: f.artifacts,
      playbookRegistration: registration,
    });
  const ref = f.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: request.run_id,
      phase: "prepare_models",
      branch_id: null,
      kind: VOICE_PREPARATION_REQUEST.artifact_kind,
      operation_id: request.operation_id,
      version: 1,
      producer: "host:voice-preparation",
      media_type: "application/json",
      content_schema: { schema_id: request.schema_id, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(request),
  });
  const identity = {
    schema_version: 2 as const,
    run_id: request.run_id,
    session_id: "cold-prep-session",
    playbook: "voice-preparation",
    engine_owner: "typescript" as const,
  };
  const directive: InvokeHostOperationDirectiveV1 = {
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity,
    state_id: "prepare_models",
    attempt: 1,
    operation_id: request.operation_id,
    operation_kind: "voice_model_preparation",
    registration_sha256: runtimeRegistrationSha256(registration),
    request_ref: ref,
    request_sha256: ref.content_digest,
    input_artifacts: { schema_version: 2, artifacts: [] },
    expected_result: voicePreparationDeclaration("fixture-service", request).result,
    policy_binding: hostOperationPolicyBinding(
      voicePreparationDeclaration("fixture-service", request),
      hostCapacityWorkerKey("worker-a")
    ),
  };
  const context = RunContext.create({
    identity,
    goal: request.brief,
    constraints: {},
    projectRoot: f.config.projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: 32,
    initialArtifacts: [ref],
    registrationContractBinding: {
      schema_version: 1,
      registration_name: registration.name,
      contract_sha256: skillContractSha256(registration.contract),
      registration_sha256: runtimeRegistrationSha256(registration),
    },
  });
  context.transition("prepare_models");
  context.pendingDirective = directive;
  const e = engine();
  f.checkpointer.createRun(context, "explicit_preparation_fixture", {});
  e.liveness.bindPolicy(context);
  const events: string[] = [];
  let loaded = false,
    calls = 0;
  const observer = {
    backend: "fixture-service",
    inspect: (requireLoaded: boolean) => {
      events.push(requireLoaded ? "warm" : "cold");
      if (requireLoaded && !loaded) throw new Error("actual residency absent");
      return {
        schema_version: 1 as const,
        process_epoch: epoch,
        service_build_sha256: sha256("controlled source"),
        model_sha256: sha256("controlled weights"),
        engine: "Qwen3TTSEngine",
        observed_at_ms: Date.now(),
        models_loaded: loaded,
        model_identity_verified: loaded,
        gpu_uuids: loaded ? ["GPU-1234"] : [],
        admission: {
          mode: "host_exclusive" as const,
          backend_binding_id: "fixture-service",
          active_job_ids: [],
          active_unmanaged_calls: 0,
        },
        jobs: [],
      };
    },
  };
  const relay = {
    prepare: async () => {
      events.push("held");
      expect(f.capacity.inspect(f.record(directive).operation_record_id)?.state).toBe("held");
    },
    requirePreparationWindow: () => undefined,
    enter: (c: Parameters<VoicePreparationAdapter["run"]>[0]) => {
      expect(c.journal.lifecycle).toBe("submitting");
      events.push("guard");
    },
    preload: async () => {
      events.push("preload");
      calls++;

      if (failure === "partial") throw new Error("partial loader failed");
      loaded = true;
    },
    drain: async () => {
      events.push("drain");
      if (failure === "drain") throw new Error("device drain unknown");
      f.measure(f.record(directive), 3);
    },
    close: () => undefined,
  };
  const adapter = new VoicePreparationAdapter(
    request,
    directive.policy_binding.backend_key_sha256,
    relay,
    observer,
    f.capacity
  );
  return { f, request, registration, directive, adapter, engine, events, calls: () => calls };
}
describe("bounded Voice cold preparation (controlled engines, not GPU qualification)", () => {
  it("the concrete observer admits an unloaded pinned/drained service but warm readiness still requires exact verified engine/model/device", () => {
    const n = nativeCapacityFixture(true);
    using f = n.f;
    n.source.bind(f.capacity);
    const file = path.join(f.root, "observation.json");
    const source = path.join(f.root, "source.py"),
      model = path.join(f.root, "model.safetensors");
    writeFileSync(source, "controlled source", { mode: 0o600 });
    writeFileSync(model, "controlled weights", { mode: 0o600 });
    const source_files = [{ path: source, sha256: sha256("controlled source") }],
      runtime_files = [n.pin.executable],
      model_files = [{ path: model, sha256: sha256("controlled weights") }];
    const observer = new VoicePreparationObserver(
      {
        process: n.pin,
        source_files,
        runtime_files,
        model_files,
        gpu: requireValue(n.config.gpu_probe, "GPU probe"),
        gpu_uuids: ["GPU-1234"],
        max_snapshot_age_ms: 10000,
        service_observations: { path: file, max_bytes: 65536 },
      },
      "fixture-service",
      n.source.managedWorkers()
    );
    const cold = {
      schema_version: 1,
      process_epoch: n.epoch,
      service_build_sha256: sha256(
        canonicalJson({ schema_version: 1, source_files, runtime_files })
      ),
      model_sha256: sha256(canonicalJson(model_files)),
      engine: "unconstructed",
      observed_at_ms: Date.now(),
      models_loaded: false,
      model_identity_verified: false,
      gpu_uuids: [],
      admission: {
        mode: "host_exclusive",
        backend_binding_id: "fixture-service",
        active_job_ids: [],
        active_unmanaged_calls: 0,
      },
      jobs: [],
    };
    const publish = (s: unknown) => writeFileSync(file, canonicalJson(s), { mode: 0o600 });
    publish(cold);
    expect(observer.inspect(false).models_loaded).toBe(false);
    expect(() => observer.inspect(true)).toThrow("residency unproven");
    const warm = {
      ...cold,
      engine: "Qwen3TTSEngine",
      models_loaded: true,
      model_identity_verified: true,
      gpu_uuids: ["GPU-1234"],
    };
    publish(warm);
    expect(observer.inspect(true).process_epoch).toBe(n.epoch);
    for (const bad of [
      { ...warm, process_epoch: sha256("different epoch") },
      { ...warm, admission: { ...warm.admission, active_job_ids: ["foreign-active-job"] } },
      { ...warm, admission: { ...warm.admission, active_unmanaged_calls: 1 } },
    ]) {
      publish(bad);
      expect(() => observer.inspect(false)).toThrow("identity/admission/drain");
    }
    for (const bad of [
      { ...warm, gpu_uuids: ["GPU-5678"] },
      { ...warm, model_identity_verified: false },
      { ...warm, models_loaded: false },
    ]) {
      publish(bad);
      expect(() => observer.inspect(true)).toThrow("residency unproven");
    }
    publish(warm);
    writeFileSync(source, "source changed", { mode: 0o600 });
    expect(() => observer.inspect(false)).toThrow("pin drift");
  });
  it("derives finite multi-resource ceilings and allocated-slot tariffs from the exact request, never from invented meter readings", () => {
    const n = nativeCapacityFixture(true);
    using f = n.f;
    const binding = requireValue(
      f.policy.bindings.find((b) => b.binding_id === "video-a"),
      "binding"
    );
    binding.operation_kind = "voice_model_preparation";
    binding.adapter_id = VOICE_PREPARATION_ADAPTER;
    binding.backend_binding_id = "fixture-service";
    binding.resource_ids.push("cpu-test");
    const meter = requireValue(n.config.meters[0], "native meter");
    const gpu = requireValue(
      meter.resources.find((r) => r.sources.includes("gpu_allocation_window")),
      "GPU source"
    );
    gpu.sources = ["gpu_allocation_window", "journal_events"];
    gpu.tariff = { per: "gpu_milliseconds", numerator: 1, denominator: 1 };
    const storage = requireValue(
      meter.resources.find((r) => r.sources.includes("private_bytes")),
      "storage"
    );
    storage.tariff = { per: "cpu_milliseconds", numerator: 1, denominator: 1 };
    meter.resources.push({
      resource_id: "cpu-test",
      sources: ["worker_cpu"],
      tariff: { per: "cpu_allocation_milliseconds", numerator: 1, denominator: 1 },
    });
    const worker = requireValue(n.config.workers[0], "worker"),
      pin = n.pin.executable;
    const b = validateSkillSchema(
      VoicePreparationBindingsSchema,
      {
        schema_id: "penny.voice-preparation-bindings.v1",
        schema_version: 1,
        activation: "pinned_active_process",
        project_root: f.config.projectRoot,
        state_root: f.config.stateRoot,
        backend_binding_id: "fixture-service",
        capacity_binding_id: "video-a",
        policy: f.policy,
        native: n.config,
        comfy_services: [],
        control: {
          socket_path: path.join(f.root, "voice.sock"),
          checker_socket_path: path.join(f.root, "checker.sock"),
          python: pin,
          helper_sha256: sha256("controlled helper"),
          worker,
          transfer_counter_file: path.join(f.root, "transfer-{operation_record_id}.json"),
          refresh_ms: 1000,
        },
        observer: {
          process: n.pin,
          source_files: [pin],
          runtime_files: [pin],
          model_files: [pin],
          gpu: n.config.gpu_probe,
          gpu_uuids: ["GPU-1234"],
          max_snapshot_age_ms: 10000,
          service_observations: { path: path.join(f.root, "obs.json"), max_bytes: 65536 },
        },
      },
      "controlled preparation bindings"
    );
    const r: VoicePreparationRequest = {
      schema_id: "penny.voice-preparation-request.v1",
      schema_version: 1,
      run_id: "ceiling-test",
      operation_id: "ceiling-test-op",
      brief: "explicit controlled preparation",
      bindings_sha256: sha256(canonicalJson(b)),
      max_runtime_ms: 1000,
      cpu_cores: 2,
      max_output_bytes: 65536,
      max_transfer_bytes: 32768,
    };
    const demands = voicePreparationDemands(b, r);
    expect(demands.find((d) => d.resource_id === "cpu-test")).toMatchObject({
      slots: 2,
      meters: { cpu_milliseconds: 2000, cost_microcredits: 2000 },
    });
    expect(demands.find((d) => d.resource_id === "gpu-a")).toMatchObject({
      slots: 1,
      meters: { gpu_milliseconds: 1000, cost_microcredits: 1000 },
    });
    expect(demands.find((d) => d.resource_id === "store-a")?.meters.stored_bytes).toBe(65536);
    const bad = structuredClone(b),
      cpu = requireValue(
        bad.native.meters[0]?.resources.find((x) => x.sources.includes("worker_cpu")),
        "CPU"
      );
    cpu.tariff.per = "cpu_milliseconds";
    expect(() => voicePreparationDemands(bad, r)).toThrow("allocated CPU/GPU tariff");
  });
  it("cold false -> actual held fence -> guard -> preload -> loaded true -> drain -> same-epoch final and consumed journal", async () => {
    const x = setup();
    using f = x.f;
    const next = await f
      .owner({ adapters: new Map([[x.adapter.adapter_id, x.adapter]]) })
      .dispatch(x.engine(), x.directive);
    expect(next.action).toBe("complete");
    expect(x.events).toEqual(["held", "cold", "cold", "guard", "preload", "warm", "drain", "warm"]);
    const record = f.record(x.directive),
      cap = requireValue(f.capacity.inspect(record.operation_record_id), "capacity");
    expect(record.lifecycle).toBe("consumed");
    expect(cap.state).toBe("settled");
    expect(cap.snapshot?.kind).toBe("final");
    expect(cap.snapshot?.readings[0]?.meters.gpu_milliseconds).toBe(3);
    expect(x.calls()).toBe(1);
    f.reopen();
    expect(
      (
        await f
          .owner({ adapters: new Map([[x.adapter.adapter_id, x.adapter]]) })
          .dispatch(x.engine(), x.directive)
      ).action
    ).toBe("complete");
    expect(f.capacity.inspect(record.operation_record_id)?.snapshot).toEqual(cap.snapshot);
    expect(x.calls()).toBe(1);
  });
  it.each(["partial", "drain"] as const)(
    "%s failure quarantines the SAME operation/fence and never fabricates final metering or retries preload",
    async (failure) => {
      const x = setup(failure);
      using f = x.f;
      await f
        .owner({ adapters: new Map([[x.adapter.adapter_id, x.adapter]]) })
        .dispatch(x.engine(), x.directive);
      const record = f.record(x.directive),
        cap = requireValue(f.capacity.inspect(record.operation_record_id), "capacity");
      expect(record.disposition?.lease_disposition).toBe("quarantined");
      expect(cap.state).toBe("quarantined");
      expect(cap.snapshot?.kind).not.toBe("final");
      expect(x.calls()).toBe(1);
      f.reopen();
      expect(f.capacity.inspect(record.operation_record_id)?.lease).toEqual(cap.lease);
      await f
        .owner({ adapters: new Map([[x.adapter.adapter_id, x.adapter]]) })
        .dispatch(x.engine(), x.directive);
      expect(x.calls()).toBe(1);
    }
  );
  it("guarded crash reopens without repeating preload or inventing drain", async () => {
    const x = setup();
    using f = x.f;
    await expect(
      f
        .owner({
          adapters: new Map([[x.adapter.adapter_id, x.adapter]]),
          fault: (point) => {
            if (point === "after_submit_before_remote_checkpoint")
              throw new HostOperationSimulatedCrashError(point);
          },
        })
        .dispatch(x.engine(), x.directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    expect(x.calls()).toBe(1);
    f.reopen();
    await f
      .owner({ adapters: new Map([[x.adapter.adapter_id, x.adapter]]) })
      .dispatch(x.engine(), x.directive);
    expect(x.calls()).toBe(1);
    expect(f.record(x.directive).disposition?.lease_disposition).toBe("quarantined");
  });
});
