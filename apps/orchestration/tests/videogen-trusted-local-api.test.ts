import { createServer } from "node:http";
import { RenderSafetyFixture } from "./videogen-render-safety-fixtures.js";
import { syntheticVideogenInventory } from "./helpers/videogen-fixtures.js";
import { validateVideogenProfileSnapshot } from "../dist/videogen/contracts.js";
import { assembleVideogenEffects } from "../dist/videogen/runtime-adapters.js";
import { LocalApiOperationMeter } from "../dist/host-operations/local-api-meter.js";
import { capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import {
  initializeVideogenOwnerSelection,
  VideogenOwnerSelection,
} from "../dist/videogen/owner-selection.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { runVideogenRuntimeCli } from "../dist/videogen-runtime-cli.js";
import { parseVoiceWireJson } from "../dist/videogen/voice-json.js";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { Type } from "typebox";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../dist/host-operations/capacity-authority.js";
import { HostOperationCapacityRuntimeBinding } from "../dist/host-operations/capacity-runtime.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import { materializeRuntimeVoice } from "../dist/videogen/runtime-voice.js";
import { executionState } from "../dist/videogen/execution-state.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/runtime-registration-digest.js";
import { MEDIA_LIMITS, MEDIA_POLICY } from "./helpers/videogen-media-fixtures.js";
import { sha256 } from "../dist/canonical-json.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceFixture, type VoiceMode } from "./helpers/videogen-voice-fixture.js";
import { required } from "./helpers/videogen-media-fixtures.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import {
  VoiceApiRawResultSchema,
  VOICE_API_RAW_RESULT,
} from "../dist/videogen/voice-api-contracts.js";
import { validateContract, JsonValueSchema } from "../dist/contracts.js";
import {
  bootstrapVideogenRuntime,
  parseVideogenRuntimeManifest,
} from "../dist/videogen/runtime-manifest.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { VOICE_STUDIO_RAW_RESULT } from "../dist/videogen/voice-studio-contracts.js";

describe("explicit trusted_local_api normal Voice API + actual generic owner", () => {
  it("captures API-custodied request/job/output without process instrumentation or all-model preload", async () => {
    await using f = new VoiceFixture(undefined, true);
    await f.start();
    expect(existsSync(f.observation_path)).toBe(false);
    let cumulative = false;
    f.beforeResponse = (route) => {
      if (!cumulative && route.endsWith(".wav")) {
        cumulative = true;
        const j = f.record(),
          cap = required(f.capacity_authority.inspect(j.operation_record_id));
        const measured = f.capacity_authority.account(j.operation_record_id, cap.revision);
        expect(measured.snapshot?.kind).toBe("cumulative");
      }
    };
    const owner = await f.owner();
    await owner.dispatch(f.engine, required(f.directive));
    const j = f.record();
    expect(j.lifecycle).toBe("consumed");
    expect(j.disposition?.outcome).toBe("completed");
    expect(j.expected_result).toEqual(VOICE_API_RAW_RESULT);
    expect(j.expected_result).not.toEqual(VOICE_STUDIO_RAW_RESULT);
    const raw = validateContract(
      VoiceApiRawResultSchema,
      JSON.parse(f.store.read(required(j.operation_result_ref)).toString()),
      "API test result"
    );
    expect(raw.coverage).toMatchObject({
      assurance: "trusted_local_api",
      request_text: f.narration.source_text,
      selected_saved_voice: f.voice,
      resolved_runtime_voice: "unknown",
      fallback_used: "unknown",
      per_chunk_execution: "unknown",
      external_work_exclusion: "unknown",
    });
    expect(raw.coverage.raw_responses.map((x) => x.route)).toContain("/api/tts/generate");
    expect(f.bodies).toEqual([
      { source_text: f.narration.source_text, voice_profile_id: f.voice.id },
      { narration_item_id: f.narration.id, voice_profile_id: f.voice.id },
    ]);
    expect(f.store.read(required(j.output_artifacts[0]))).toEqual(f.wav);
    const capacity = required(f.capacity_authority.inspect(j.operation_record_id));
    const snapshot = required(capacity.snapshot);
    expect(cumulative).toBe(true);
    expect(snapshot.kind).toBe("final");
    expect(snapshot.source_revision).toBe(2);
    expect(snapshot.accounting).toMatchObject({
      assurance: "trusted_local_api",
      external_work_exclusion: "unknown",
      cpu: "wall_clock_allocated_slot_ms_not_cpu_usage",
      engine_steps: "unknown_not_charged",
    });
    expect(required(snapshot.accounting).socket_bytes).toBeGreaterThan(f.wav.length * 2);
    expect(snapshot.readings.reduce((n, r) => n + r.meters.cpu_milliseconds, 0)).toBeGreaterThan(0);
    expect(
      required(snapshot.readings.find((r) => r.resource_id === "shared-gpu")).meters.stored_bytes
    ).toBe(0);
    expect(
      required(snapshot.readings.find((r) => r.resource_id === "shared-gpu")).meters.egress_bytes
    ).toBe(0);
    expect(
      required(snapshot.readings.find((r) => r.resource_id === "shared-store")).meters.stored_bytes
    ).toBeGreaterThan(f.wav.length * 2);
    expect(() =>
      HostOperationCapacityAuthority.installUnreservedVersion(
        f.state_root,
        { ...f.policy, policy_id: "cannot-change-admitted-policy" },
        sha256(canonicalJson(f.policy)),
        ["voice-binding"]
      )
    ).toThrow("no records");
    const before = canonicalJson(snapshot),
      calls = [...f.calls];
    await f.reopen();
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    expect(
      canonicalJson(required(f.capacity_authority.inspect(j.operation_record_id)).snapshot)
    ).toBe(before);
    expect(f.calls).toEqual(calls);
  });
  it.each<VoiceMode>([
    "partial",
    "errored",
    "wrong-job",
    "fallback",
    "ambiguous-create",
    "ambiguous-start",
    "readback-drift",
    "bad-wav",
    "silent",
    "busy",
  ])("refuses %s without output or duplicate mutation", async (mode) => {
    await using f = new VoiceFixture(undefined, true);
    await f.start();
    f.mode = mode;
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    expect(f.record().disposition?.outcome).not.toBe("completed");
    expect(f.record().operation_result_ref).toBeNull();
    expect(f.calls.filter((x) => x === "POST /api/tts/generate").length).toBeLessThanOrEqual(1);
    if (
      ["ambiguous-create", "ambiguous-start", "busy", "readback-drift", "wrong-job"].includes(mode)
    )
      expect(f.record().disposition?.lease_disposition).toBe("quarantined");
  });
  it.each<HostOperationFaultPointV1>([
    "before_submit",
    "after_submit_before_remote_checkpoint",
    "after_remote_checkpoint",
    "after_fetch",
    "after_persist",
    "after_receipt",
    "after_wrapper",
    "before_consume",
    "after_consume",
  ])(
    "reopens at %s, never inventing final measurements or resubmitting accepted work",
    async (point) => {
      await using f = new VoiceFixture(undefined, true);
      await f.start();
      let crashed = false;
      const owner = await f.owner((p) => {
        if (p === point && !crashed) {
          crashed = true;
          throw new HostOperationSimulatedCrashError(p);
        }
      });
      await expect(owner.dispatch(f.engine, required(f.directive))).rejects.toThrow("simulated");
      const submits = f.calls.filter((x) => x === "POST /api/tts/generate").length;
      await f.reopen();
      await (await f.owner()).dispatch(f.engine, required(f.directive));
      if (point !== "before_submit")
        expect(f.calls.filter((x) => x === "POST /api/tts/generate")).toHaveLength(submits);
      if (point === "after_submit_before_remote_checkpoint")
        expect(f.record().disposition?.lease_disposition).toBe("quarantined");
      else expect(f.record().disposition?.outcome).toBe("completed");
    }
  );
  it("quarantines cooperative cancellation without inventing drain/final usage", async () => {
    await using f = new VoiceFixture(undefined, true);
    await f.start();
    f.mode = "cancel-unproven";
    const owner = await f.owner(),
      active = owner.dispatch(f.engine, required(f.directive));
    while (!f.calls.some((x) => x.includes("/tts/jobs/")))
      await new Promise((resolve) => setTimeout(resolve, 2));
    owner.cancelRun(f.run_id);
    await active;
    expect(f.record().disposition?.lease_disposition).toBe("quarantined");
    expect(f.calls.filter((x) => x.includes("/tts/cancel/"))).toEqual([
      "POST /api/tts/cancel/job-fixture",
    ]);
    expect(
      required(f.capacity_authority.inspect(f.record().operation_record_id)).snapshot?.kind
    ).not.toBe("final");
  });
  it("retains the exact old immutable policy and refuses quota, stale-selection or reserved-scope changes", async () => {
    await using f = new VoiceFixture();
    const original = canonicalJson(f.policy),
      next = {
        ...f.policy,
        policy_id: "api-policy-v2",
        external_work_policy: "penny_serialized_api" as const,
      };
    expect(() =>
      HostOperationCapacityAuthority.installUnreservedVersion(
        f.state_root,
        { ...next, max_active: next.max_active + 1 },
        sha256(original),
        ["voice-binding"]
      )
    ).toThrow("quotas");
    expect(() =>
      HostOperationCapacityAuthority.installUnreservedVersion(f.state_root, next, "0".repeat(64), [
        "voice-binding",
      ])
    ).toThrow("compare-and-set");
    HostOperationCapacityAuthority.installUnreservedVersion(f.state_root, next, sha256(original), [
      "voice-binding",
    ]);
    expect(() => HostOperationCapacityAuthority.configure(f.state_root, f.policy)).toThrow(
      "immutable"
    );
    expect(() => HostOperationCapacityAuthority.configure(f.state_root, next)).not.toThrow();
  });
  it("builds and atomically writes a private JSON-only API fragment using GETs, never overwrites it", async () => {
    await using f = new VoiceFixture(undefined, true);
    await f.start();
    const profile = required(f.profile),
      request = path.join(f.root, "bind-request.json"),
      target = path.join(f.root, "api-fragment.json");
    writeFileSync(
      request,
      canonicalJson({
        schema_id: "penny.videogen-voice-api-binding-request.v1",
        schema_version: 1,
        profile_id: profile.profile_id,
        worker_id: profile.process_worker_id,
        gpu_resource_ids: profile.gpu_resource_ids,
        voice_id: profile.voice_id,
        transport: required(f.authority).bindings.transport,
        limits: profile.limits,
        media_policy: MEDIA_POLICY,
        operation_policy: {
          backend_binding_id: f.declaration.backend_binding_id,
          backend_key_sha256: hostCapacityWorkerKey(profile.process_worker_id),
          lease_profile_id: "api-builder-test",
          lease_duration_ms: 10000,
          lease_renew_after_ms: 1000,
          queue_inactivity_ms: 10000,
          operation_inactivity_ms: 10000,
          max_request_bytes: 1048576,
          max_input_bytes: 1048576,
          max_output_bytes: 500000,
          max_progress_events: 256,
        },
      }),
      { mode: 0o600 }
    );
    let status = "";
    await runVideogenRuntimeCli(
      ["bind-api", `--requestfile=${request}`, `--outputfile=${target}`],
      {},
      undefined,
      (s) => {
        status += s;
      }
    );
    expect(JSON.parse(status)).toEqual({ binding: "written", assurance: "trusted_local_api" });
    const bytes = readFileSync(target),
      fragment = validateContract(
        Type.Object({
          assurance: Type.Literal("trusted_local_api"),
          artifacts: Type.Array(JsonValueSchema),
          adapter: JsonValueSchema,
          inspection: JsonValueSchema,
        }),
        parseVoiceWireJson(bytes),
        "API fragment"
      );
    expect(fragment.artifacts).toHaveLength(4);
    const base = parseVideogenRuntimeManifest(
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "fixtures/videogen-minimal-manifest.json"),
          "utf8"
        )
      )
    );
    const imported = bootstrapVideogenRuntime({
      store: f.store,
      project_id: f.project_id,
      manifest: {
        ...base,
        artifacts: [...base.artifacts, ...fragment.artifacts],
        adapters: [fragment.adapter],
        capacity: {
          policy: f.policy,
          local_api: required(f.localMeter).binding,
          demands: [
            {
              operation_kind: "voice_job",
              binding_id: "voice-binding",
              demands: f.demands.requestFor({
                project_id: f.project_id,
                operation_record_id: "hop_" + "0".repeat(64),
                directive: required(f.directive),
                request_bytes: Buffer.from(""),
              }).demands,
            },
          ],
        },
      },
    });
    const selected = required(imported.effects.get("voice_job"));
    expect(
      selected.createAdapter({
        store: f.store,
        checkpointer: f.checkpointer,
        owner: f.ownerSelection(),
        capacity: { runtime: f.capacity, authority: f.capacity_authority },
      }).adapter_id
    ).toBe("videogen.voice-trusted-local-api.v1");

    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(f.calls.every((route) => route.startsWith("GET "))).toBe(true);
    await expect(
      runVideogenRuntimeCli(
        ["bind-api", `--requestfile=${request}`, `--outputfile=${target}`],
        {},
        undefined,
        () => {}
      )
    ).rejects.toThrow();
    expect(readFileSync(target)).toEqual(bytes);
  });
  it("runs the fixed Comfy API factory through a canonical owner with real socket/cache accounting and no replay POST", async () => {
    // Retained render declaration; synthetic media/model inventory. No film approval/quality is supplied.
    const calls: string[] = [],
      video = readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url));
    const server = createServer((request, response) => {
      const route = request.url ?? "";
      calls.push(`${request.method} ${route}`);
      const json = (body: unknown) =>
        response.writeHead(200, { "Content-Type": "application/json" }).end(canonicalJson(body));
      if (route === "/system_stats") json({ ready: true });
      else if (route === "/object_info") json(syntheticVideogenInventory());
      else if (route === "/prompt") {
        request.resume();
        json({ prompt_id: "owned-render", number: 1, node_errors: {} });
      } else if (route === "/history/owned-render")
        json({
          "owned-render": {
            status: { completed: true, status_str: "success" },
            outputs: { "7": { images: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
          },
        });
      else if (route.startsWith("/view?"))
        response.writeHead(200, { "Content-Type": "video/mp4" }).end(video);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test HTTP address");
      using f = new RenderSafetyFixture(address.port, "t2v");
      const profileRef = required(
          f.directive.input_artifacts.artifacts.find((x) => x.slot === "profile_snapshot")
        ).ref,
        profile = validateVideogenProfileSnapshot(
          parseVoiceWireJson(f.artifacts.read(profileRef))
        ).profile;
      const policy = {
        ...capacityPolicy(),
        policy_id: "synthetic-normal-comfy-api",
        external_work_policy: "penny_serialized_api" as const,
        active_inactivity_ms: 60000,
        queue_wait_ms: 10000,
        resources: ["gpu-a", "store-a"].map((resource_id) => ({
          resource_id,
          max_slots: 1,
          protected_finish_slots: 0,
          limits: {
            ...meters(10000000),
            ...(resource_id === "gpu-a"
              ? { cpu_milliseconds: 0, stored_bytes: 0, egress_bytes: 0 }
              : { gpu_milliseconds: 0 }),
          },
          protected_finish: meters(),
        })),
        bindings: [
          {
            binding_id: "comfy-api-render",
            worker_id: "fixture-physical-comfy",
            resource_ids: ["gpu-a", "store-a"],
            operation_kind: f.declaration.operation_kind,
            adapter_id: f.declaration.adapter_id,
            backend_binding_id: f.declaration.backend_binding_id,
            purpose: "work" as const,
          },
        ],
      };
      const meter = new LocalApiOperationMeter(f.artifacts, policy, {
        assurance: "trusted_local_api",
        storage_resource_id: "store-a",
        network_resource_id: "store-a",
        resources: [
          { resource_id: "gpu-a", cpu_slots: 0, gpu_slots: 1 },
          { resource_id: "store-a", cpu_slots: 1, gpu_slots: 0 },
        ],
        max_socket_observations: 64,
        tariffs: { ...meters(), gpu_milliseconds: 1, cpu_milliseconds: 1 },
      });
      HostOperationCapacityAuthority.configure(f.stateRoot, policy);
      const project = new HostCapacityProjectAuthority(
        f.projectId,
        f.checkpointer,
        f.artifacts,
        meter
      );
      using authority = new HostOperationCapacityAuthority({
        stateRoot: f.stateRoot,
        policy,
        projects: [project],
      });
      const capacity = new HostOperationCapacityRuntimeBinding(authority, project, {
        requestFor: (c) => ({
          schema_id: "penny.host-capacity-request.v1",
          schema_version: 1,
          project_id: c.project_id,
          operation_record_id: c.operation_record_id,
          binding_id: "comfy-api-render",
          demands: policy.resources.map((r) => ({
            resource_id: r.resource_id,
            slots: 1,
            meters: {
              ...meters(2000000),
              ...(r.resource_id === "gpu-a"
                ? { cpu_milliseconds: 0, stored_bytes: 0, egress_bytes: 0 }
                : { gpu_milliseconds: 0 }),
            },
          })),
        }),
      });
      const d = f.declaration,
        providers = assembleVideogenEffects(
          [
            {
              kind: "video_render",
              policy: {
                backend_binding_id: d.backend_binding_id,
                backend_key_sha256: f.backendKey,
                lease_profile_id: d.lease_profile.profile_id,
                lease_duration_ms: d.lease_profile.duration_ms,
                lease_renew_after_ms: d.lease_profile.renew_after_ms,
                queue_inactivity_ms: d.lease_profile.queue_inactivity_ms,
                operation_inactivity_ms: d.operation_inactivity_ms,
                max_request_bytes: d.max_request_bytes,
                max_input_bytes: required(d.max_input_bytes),
                max_output_bytes: d.max_output_bytes,
                max_progress_events: d.max_progress_events,
              },
              binding: {
                assurance: "trusted_local_api",
                worker_id: "fixture-physical-comfy",
                profiles: [profile],
                approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
              },
            },
          ],
          MEDIA_LIMITS,
          undefined,
          meter
        );
      const context = required(f.checkpointer.loadRunById(f.directive.identity.run_id));
      initializeVideogenOwnerSelection(context, {
        project_id: f.projectId,
        limits: MEDIA_LIMITS,
        territory: "test-only",
        admitted_destination_id: "none",
      });
      f.checkpointer.saveRun(context, "test_empty_owner_selection", {});
      const adapter = required(providers.get("video_render")).createAdapter({
        store: f.artifacts,
        checkpointer: f.checkpointer,
        owner: new VideogenOwnerSelection({
          project_id: f.projectId,
          run_id: context.identity.run_id,
          store: f.artifacts,
          checkpointer: f.checkpointer,
        }),
        capacity: { runtime: capacity, authority },
      });
      const owner = new HostOperationRuntimeOwner({
        projectId: f.projectId,
        checkpointer: f.checkpointer,
        artifacts: f.artifacts,
        leaseAuthority: f.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
        capacityRuntime: capacity,
        resultCache: await FileHostOperationResultCache.provision(path.join(f.root, "api-cache")),
      });
      await owner.dispatch(f.engine, f.directive);
      expect(f.record().disposition?.outcome).toBe("completed");
      const snapshot = required(
        required(authority.inspect(f.record().operation_record_id)).snapshot
      );
      expect(snapshot.kind).toBe("final");
      expect(required(snapshot.accounting).socket_bytes).toBeGreaterThan(video.byteLength);
      expect(
        required(snapshot.readings.find((r) => r.resource_id === "gpu-a")).meters.stored_bytes
      ).toBe(0);
      expect(
        required(snapshot.readings.find((r) => r.resource_id === "store-a")).meters.stored_bytes
      ).toBeGreaterThan(video.byteLength * 2);
      const before = [...calls];
      await owner.dispatch(f.engine, f.directive);
      expect(calls).toEqual(before);
      expect(calls.filter((x) => x === "POST /prompt")).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  it("constructs the identical API adapter + compiled meter through the default closed JSON manifest", async () => {
    await using f = new VoiceFixture(undefined, true);
    await f.start();
    const base = parseVideogenRuntimeManifest(
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "fixtures/videogen-minimal-manifest.json"),
          "utf8"
        )
      )
    );
    const policy = {
      backend_binding_id: f.declaration.backend_binding_id,
      backend_key_sha256: required(f.directive).policy_binding.backend_key_sha256,
      lease_profile_id: f.declaration.lease_profile.profile_id,
      lease_duration_ms: f.declaration.lease_profile.duration_ms,
      lease_renew_after_ms: f.declaration.lease_profile.renew_after_ms,
      queue_inactivity_ms: f.declaration.lease_profile.queue_inactivity_ms,
      operation_inactivity_ms: f.declaration.operation_inactivity_ms,
      max_request_bytes: f.declaration.max_request_bytes,
      max_input_bytes: f.declaration.max_input_bytes,
      max_output_bytes: f.declaration.max_output_bytes,
      max_progress_events: f.declaration.max_progress_events,
    };
    const providers = bootstrapVideogenRuntime({
      store: f.store,
      project_id: f.project_id,
      manifest: {
        ...base,
        adapters: [
          {
            kind: "voice_job",
            policy,
            binding: {
              assurance: "trusted_local_api",
              profile_ref: f.profile_ref,
              profile: f.apiProfile,
              transport: { origin: f.origin, mode: "isolated_loopback" },
            },
          },
        ],
        capacity: {
          policy: f.policy,
          local_api: required(f.localMeter).binding,
          demands: [
            {
              operation_kind: "voice_job",
              binding_id: "voice-binding",
              demands: f.demands.requestFor({
                project_id: f.project_id,
                operation_record_id: "hop_" + "0".repeat(64),
                directive: required(f.directive),
                request_bytes: Buffer.from(""),
              }).demands,
            },
          ],
        },
      },
    });
    const provider = required(providers.effects.get("voice_job"));
    expect(provider.declaration).toEqual(f.declaration);
    const adapter = provider.createAdapter({
      store: f.store,
      checkpointer: f.checkpointer,
      owner: f.ownerSelection(),
      capacity: { runtime: f.capacity, authority: f.capacity_authority },
    });
    expect(
      adapter.inspectRequest({
        directive: required(f.directive),
        request_bytes: f.store.read(required(f.directive).request_ref),
        declaration: f.declaration,
        input_artifacts: required(f.directive).input_artifacts,
      }).adapter_id
    ).toBe(f.declaration.adapter_id);
    expect(
      validateContract(JsonValueSchema, providers.capacity_options?.policy, "API policy")
    ).toEqual(f.policy);
    const project = new HostCapacityProjectAuthority(
      f.project_id,
      f.checkpointer,
      f.store,
      required(providers.capacity_options).measurements
    );
    using authority = new HostOperationCapacityAuthority({
      stateRoot: f.state_root,
      policy: f.policy,
      projects: [project],
    });
    const capacity = new HostOperationCapacityRuntimeBinding(
      authority,
      project,
      required(providers.capacity_options).demands
    );
    const actual = provider.createAdapter({
      store: f.store,
      checkpointer: f.checkpointer,
      owner: f.ownerSelection(),
      capacity: { runtime: capacity, authority },
    });
    const owner = new HostOperationRuntimeOwner({
      projectId: f.project_id,
      checkpointer: f.checkpointer,
      artifacts: f.store,
      leaseAuthority: f.leases,
      adapters: new Map([[actual.adapter_id, actual]]),
      useValidator: required(f.authority),
      capacityRuntime: capacity,
      resultCache: await FileHostOperationResultCache.provision(path.join(f.root, "default-cache")),
    });
    await owner.dispatch(f.engine, required(f.directive));
    expect(f.record().disposition?.outcome, f.diagnostics()).toBe("completed");
    expect(
      required(authority.inspect(f.record().operation_record_id)).snapshot?.accounting?.assurance
    ).toBe("trusted_local_api");
    const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, {
      ...providers,
      config: { ...providers.config, territory: "test-territory", limits: MEDIA_LIMITS },
      host_owners: { leases: f.leases, state_root: f.state_root },
    });
    const context = required(f.checkpointer.loadRunById(f.run_id));
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
    materializeRuntimeVoice(
      runtime,
      context,
      f.record().operation_record_id,
      runtimeRegistrationSha256(f.registration),
      "voice-asset"
    );
    const source = required(
      executionState(context).slots.find((x) => x.slot === "audio_source-voice-asset")
    );
    expect(JSON.parse(f.store.read(source.ref).toString())).toMatchObject({
      source_kind: "voice_studio",
      codec: "canonical_pcm",
    });
    const before = canonicalJson(executionState(context));
    materializeRuntimeVoice(
      runtime,
      context,
      f.record().operation_record_id,
      runtimeRegistrationSha256(f.registration),
      "voice-asset"
    );
    expect(canonicalJson(executionState(context))).toBe(before);
  });
});
