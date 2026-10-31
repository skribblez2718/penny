import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { canonicalJson } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { OrchestrationService } from "../dist/service.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import {
  loadVideogenRuntimeFromEnvironment,
  parseVideogenRuntimeManifest,
  VIDEOGEN_RUNTIME_MANIFEST_ENV,
} from "../dist/videogen/runtime-manifest.js";
import { VOICE_API_ADAPTER_ID } from "../dist/videogen/voice-api-contracts.js";
import { VOICE_STUDIO_ADAPTER_ID } from "../dist/videogen/voice-studio-contracts.js";
import { VoiceFixture } from "./helpers/videogen-voice-fixture.js";
import { required } from "./helpers/videogen-media-fixtures.js";
import { meters } from "./helpers/capacity-fixtures.js";

// Read only the counters under test; production retains its own closed window schema.
const Counters = Type.Object({
  observations: Type.Integer(),
  pending_sockets: Type.Integer(),
  socket_bytes: Type.Integer(),
  guarded: Type.Boolean(),
  ended_ms: Type.Union([Type.Integer(), Type.Null()]),
});
function windows(f: VoiceFixture) {
  const id = f.record().operation_record_id;
  return Array.from(
    { length: f.store.lastVersion(id, "local-api-meter", null, "local-api-window", "window") },
    (_, index) =>
      validateContract(
        Counters,
        JSON.parse(
          f.store
            .read(
              required(
                f.store.refFor(id, "local-api-meter", null, "local-api-window", "window", index + 1)
              )
            )
            .toString()
        ),
        "service fixture meter counters"
      )
  );
}

async function startService(f: VoiceFixture, cacheRoot?: string) {
  const filename = path.join(f.root, "service-voice.json");
  const env = { PENNY_STATE_ROOT: f.state_root, [VIDEOGEN_RUNTIME_MANIFEST_ENV]: filename };
  const fences: string[] = [];
  let service: OrchestrationService | undefined;
  try {
    await f.start(() => {
      const base = parseVideogenRuntimeManifest(
        JSON.parse(
          readFileSync(
            new URL("./fixtures/videogen-minimal-manifest.json", import.meta.url),
            "utf8"
          )
        )
      );
      const d = f.declaration;
      const manifest = parseVideogenRuntimeManifest({
        ...base,
        ...(cacheRoot === undefined ? {} : { result_cache_root: cacheRoot }),
        adapters: [
          {
            kind: "voice_job",
            policy: {
              backend_binding_id: d.backend_binding_id,
              backend_key_sha256: hostCapacityWorkerKey("voice-process"),
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
            binding: {
              ...(f.api
                ? { assurance: "trusted_local_api" }
                : { legacy_http: true, process_snapshot_path: f.observation_path }),
              profile_ref: required(f.profile_ref),
              profile: required(f.api ? f.apiProfile : f.profile),
              transport: { origin: f.origin, mode: "isolated_loopback" },
            },
          },
        ],
        capacity: {
          policy: f.policy,
          ...(f.api
            ? { local_api: required(f.localMeter).binding }
            : { measurement_file: path.join(f.root, "unused-measurements.json") }),
          demands: [
            {
              operation_kind: "voice_job",
              binding_id: "voice-binding",
              demands: f.policy.resources.map((r) => ({
                resource_id: r.resource_id,
                slots: 1,
                meters: f.api
                  ? {
                      ...meters(2000000),
                      ...(r.resource_id === "shared-gpu"
                        ? { cpu_milliseconds: 0, stored_bytes: 0, egress_bytes: 0 }
                        : { gpu_milliseconds: 0 }),
                    }
                  : meters(2000000),
              })),
            },
          ],
        },
      });
      writeFileSync(filename, canonicalJson(manifest), { mode: 0o600 });
      service = new OrchestrationService({
        projectRoot: f.root,
        env,
        playbookName: "videogen",
        modelClient: {
          async runAgent() {
            throw new Error("service cache fixture forbids model dispatch");
          },
        },
        // Legacy refusal needs only synthetic final-zero measurements, not native instrumentation.
        ...(f.api
          ? {}
          : {
              hostOperationCapacity: {
                policy: f.policy,
                demands: f.demands,
                measurements: f.capacity_project.measurements,
              },
            }),
        hostOperationFault: (point, kind) => {
          if (point === "before_submit" || point === "before_consume") {
            fences.push(`${point}:${kind}`);
            throw new HostOperationSimulatedCrashError(point);
          }
        },
      });
      return service.engine.registration;
    });
    const actual = required(service);
    const providers = required(
      loadVideogenRuntimeFromEnvironment({ env, store: actual.artifacts, project_id: f.project_id })
    );
    const runtime = new VideogenRuntime(
      actual.artifacts,
      actual.checkpointer,
      f.project_id,
      providers
    );
    const context = required(actual.checkpointer.loadRunById(f.run_id));
    context.playbookData.videogen_execution = {
      schema_version: 1,
      config_digest: runtime.binding_digest,
      slots: [],
      shot_ids: [],
      shot_index: 0,
      asset_index: 0,
      effect_index: 0,
      effects: [],
    };
    for (const { ref } of required(f.directive).input_artifacts.artifacts)
      if (!context.selectedArtifacts.some((x) => x.artifact_id === ref.artifact_id))
        context.selectedArtifacts.push(ref);
    actual.checkpointer.saveRun(context, "service_cache_fixture_ready", {});
    return { service: actual, fences };
  } catch (error) {
    service?.close();
    throw error;
  }
}
function recover(service: OrchestrationService, f: VoiceFixture) {
  return service.execute({
    schema_version: 2,
    action: "recover",
    identity: required(f.directive).identity,
  });
}

afterEach(() => vi.restoreAllMocks());
describe("videogen service selected Voice result-cache policy (GET-only localhost)", () => {
  it("uses the manifest cache miss, measures five real inspection sockets and stops exactly before_submit without POST", async () => {
    await using f = new VoiceFixture(undefined, true, { serviceState: true });
    f.getOnly = true;
    const cacheRoot = path.join(f.root, "service-cache");
    await FileHostOperationResultCache.provision(cacheRoot);
    const reads = vi.spyOn(FileHostOperationResultCache.prototype, "read");
    const writes = vi.spyOn(FileHostOperationResultCache.prototype, "write");
    const closedSockets: { read: number; written: number }[] = [];
    f.server.on("connection", (socket) =>
      socket.once("close", () => {
        closedSockets.push({ read: socket.bytesRead, written: socket.bytesWritten });
      })
    );
    const started = await startService(f, cacheRoot);
    using service = started.service;
    const { fences } = started;
    expect(service.engine.registration.host_operations?.declarations).toEqual([f.declaration]);
    expect(f.declaration.adapter_id).toBe(VOICE_API_ADAPTER_ID);
    await expect(recover(service, f)).rejects.toThrow(
      "simulated host-operation crash at 'before_submit'"
    );
    expect(fences).toEqual(["before_submit:voice_job"]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledWith(required(f.directive).request_sha256);
    expect(await required(reads.mock.results[0]).value).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(f.calls).toEqual([
      "GET /openapi.json",
      "GET /api/system/health",
      "GET /api/voices",
      `GET /api/voices/${f.voice.id}`,
      `GET /api/voices/${f.voice.id}/sample`,
    ]);
    expect(f.bodies).toEqual([]);
    await vi.waitFor(() => expect(closedSockets).toHaveLength(5));
    expect(closedSockets.every((s) => s.read > 0 && s.written > 0)).toBe(true);
    const history = windows(f),
      last = required(history.at(-1));
    expect(history).toHaveLength(16); // baseline + open/count/close for each socket
    expect(history.filter((w) => w.pending_sockets === 1)).toHaveLength(10);
    expect(last).toMatchObject({
      observations: 5,
      pending_sockets: 0,
      guarded: false,
      ended_ms: null,
    });
    expect(last.socket_bytes).toBe(closedSockets.reduce((n, s) => n + s.read + s.written, 0));
    expect(f.record()).toMatchObject({
      lifecycle: "lease_acquired",
      disposition: null,
      remote_correlation_id: null,
      fetched: null,
      output_artifacts: [],
    });
    expect(required(f.capacity_authority.inspect(f.record().operation_record_id)).state).toBe(
      "held"
    );
  });

  it("fails closed without a configured cache before inspection or submission, with the original zero-socket signature", async () => {
    await using f = new VoiceFixture(undefined, true, { serviceState: true });
    f.getOnly = true;
    const started = await startService(f);
    using service = started.service;
    const { fences } = started;
    await expect(recover(service, f)).rejects.toThrow(
      "simulated host-operation crash at 'before_consume'"
    );
    expect(fences).toEqual(["before_consume:voice_job"]);
    expect(f.calls).toEqual([]);
    expect(f.bodies).toEqual([]);
    expect(
      windows(f).map((w) => ({
        observations: w.observations,
        socket_bytes: w.socket_bytes,
        pending_sockets: w.pending_sockets,
        guarded: w.guarded,
        ended: w.ended_ms !== null,
      }))
    ).toEqual([
      { observations: 0, socket_bytes: 0, pending_sockets: 0, guarded: false, ended: false },
      { observations: 0, socket_bytes: 0, pending_sockets: 0, guarded: false, ended: true },
    ]);
    expect(f.record()).toMatchObject({
      lifecycle: "settled",
      remote_correlation_id: null,
      fetched: null,
      output_artifacts: [],
      disposition: {
        outcome: "failed",
        reason_code: "voice_studio_refused",
        retryable: false,
        remote_disposition: "proven_not_accepted",
        lease_disposition: "released",
      },
    });
    expect(required(f.capacity_authority.inspect(f.record().operation_record_id)).state).toBe(
      "settled"
    );
  });

  it("preserves legacy Voice Studio bypass even when a durable cache is supplied", async () => {
    await using f = new VoiceFixture(undefined, false, { serviceState: true });
    f.getOnly = true;
    const cacheRoot = path.join(f.root, "legacy-cache");
    await FileHostOperationResultCache.provision(cacheRoot);
    const reads = vi.spyOn(FileHostOperationResultCache.prototype, "read");
    const writes = vi.spyOn(FileHostOperationResultCache.prototype, "write");
    const started = await startService(f, cacheRoot);
    using service = started.service;
    const { fences } = started;
    expect(f.declaration.adapter_id).toBe(VOICE_STUDIO_ADAPTER_ID);
    await expect(recover(service, f)).rejects.toThrow(
      "simulated host-operation crash at 'before_consume'"
    );
    expect(fences).toEqual(["before_consume:voice_job"]);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.bodies).toEqual([]);
    expect(f.record().disposition).toMatchObject({
      outcome: "failed",
      remote_disposition: "proven_not_accepted",
      reason_code: "voice_studio_refused",
    });
  });
});
