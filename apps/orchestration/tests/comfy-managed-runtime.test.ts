import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  bootstrapVideogenRuntime,
  parseVideogenRuntimeManifest,
} from "../dist/videogen/runtime-manifest.js";
import { NativeCapacityMeter } from "../dist/host-operations/native-capacity.js";
import { ComfyHttpClient } from "../dist/comfy/client.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../dist/host-operations/capacity-authority.js";
import { HostOperationCapacityRuntimeBinding } from "../dist/host-operations/capacity-runtime.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import { nativeFileSha256 } from "../dist/host-operations/native-process.js";
import { managedComputePackageSha256 } from "../dist/host-operations/managed-compute-relay.js";
import { createComfyVideogenDeclaration } from "../dist/videogen/operation-owner.js";
import { buildVideoSubmittedGraph } from "../dist/videogen/graph-builder.js";
import { VideoGenerationOperationRequestV1Schema } from "../dist/videogen/contracts.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import type { NativeCapacityRuntime } from "../dist/host-operations/native-capacity-contracts.js";
import { HostEffectFixture } from "./helpers/host-effect-fixture.js";
import { nativeProcessPin } from "./helpers/native-capacity-fixture.js";
import { capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import {
  syntheticVideogenProfile,
  syntheticVideogenInventory,
} from "./helpers/videogen-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";

it("awaits real socket counters and propagates a failed final meter without an uncaught exception", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test port absent");
    let finished = false;
    const client = new ComfyHttpClient(
      { scheme: "http", host: "127.0.0.1", port: address.port },
      {
        max_request_bytes: 1024,
        max_readiness_bytes: 1024,
        max_inventory_bytes: 1024,
        max_history_bytes: 1024,
        max_image_bytes: 1024,
        connect_timeout_ms: 1000,
        read_timeout_ms: 1000,
      },
      {
        beginSocket: () => (sent, received) => {
          expect(sent).toBeGreaterThan(0);
          expect(received).toBeGreaterThan(0);
          finished = true;
          throw new Error("exact final meter unavailable");
        },
      }
    );
    await expect(client.ready({ signal: new AbortController().signal })).rejects.toThrow(
      "exact final meter unavailable"
    );
    expect(finished).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

// CPU/GPU readings are controlled probes. IPC credentials, service drain, graph
// projection, HTTP wire counters, SQLite journal/fence/grant and settlement are real.
describe("default JSON managed Comfy native lifecycle (no GPU)", () => {
  it("prepares before baseline, uses one exact private graph, meters sockets and settles CLOSED", async () => {
    const root = path.resolve("../..");
    const policyOptions = {
      backend_binding_id: "managed-comfy",
      backend_key_sha256: hostCapacityWorkerKey("worker-a"),
      lease_profile_id: "managed-comfy",
      lease_duration_ms: 60000,
      lease_renew_after_ms: 10000,
      queue_inactivity_ms: 30000,
      operation_inactivity_ms: 60000,
      max_request_bytes: 65536,
      max_input_bytes: 2000000,
      max_output_bytes: 2000000,
      max_progress_events: 64,
    };
    const declaration = createComfyVideogenDeclaration({
      ...policyOptions,
      managed: true,
      effect_protocol: "request_intent_v1",
    });
    using f = new HostEffectFixture(declaration, policyOptions.backend_key_sha256);
    const python = realpathSync(path.join(root, ".venv/bin/python"));
    const service = spawn(
      python,
      [path.join(root, "apps/orchestration/tests/fixtures/managed-compute-service.py"), f.root],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          PYTHONPATH: path.join(root, "scripts/system"),
          PENNY_TEST_GATE_BUILD: sha256("synthetic build"),
        },
      }
    );
    const peerRoot = path.join(f.root, "peer");
    mkdirSync(peerRoot, { mode: 0o700 });
    const peer = spawn(
      python,
      [path.join(root, "apps/orchestration/tests/fixtures/managed-compute-service.py"), peerRoot],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          PYTHONPATH: path.join(root, "scripts/system"),
          PENNY_TEST_GATE_BUILD: sha256("synthetic build"),
          PENNY_TEST_WORKER_ID: "worker-b",
        },
      }
    );
    let meter: NativeCapacityMeter | undefined;
    let authority: HostOperationCapacityAuthority | undefined;
    let prompt = "";
    let posts = 0;
    let gets = 0;
    const server = createServer((request, response) => {
      gets++;
      response.setHeader("content-type", "application/json");
      if (request.url === "/prompt") {
        posts++;
        response.writeHead(500).end();
      } else if (request.url === "/system_stats") response.end("{}");
      else if (request.url === "/object_info")
        response.end(canonicalJson(syntheticVideogenInventory()));
      else if (request.url?.startsWith("/history/")) {
        prompt = request.url.slice("/history/".length);
        response.end(
          canonicalJson({
            [prompt]: {
              status: { completed: true, status_str: "success" },
              outputs: {
                "7": { images: [{ filename: "clip.mp4", subfolder: "", type: "output" }] },
              },
            },
          })
        );
      } else if (request.url?.startsWith("/view?")) {
        response.setHeader("content-type", "video/mp4");
        response.end(readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url)));
      } else response.writeHead(404).end();
    });
    try {
      await Promise.all([once(service.stdout, "data"), once(peer.stdout, "data")]);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP address missing");
      const pin = nativeProcessPin(requireValue(service.pid, "service PID"));
      const gate = path.join(f.root, "gate-build");
      writeFileSync(gate, "synthetic build", { mode: 0o600 });
      // The fixture hello uses this build identity; native build file independently pins bytes.
      const gateSha = nativeFileSha256(gate);
      const worker = {
        worker_id: "worker-a",
        process: pin,
        gate_build: { path: gate, sha256: gateSha },
        state_file: path.join(f.root, "state.json"),
        grant_file: path.join(f.root, "grant.json"),
        max_age_ms: 60000,
      };
      const peerPin = nativeProcessPin(requireValue(peer.pid, "peer PID"));
      const peerWorker = {
        ...worker,
        worker_id: "worker-b",
        process: peerPin,
        state_file: path.join(peerRoot, "state.json"),
        grant_file: path.join(peerRoot, "grant.json"),
      };
      const transfer = path.join(f.root, "counter-{operation_record_id}.json");
      const policy = capacityPolicy();
      policy.bindings = [
        {
          binding_id: "video-a",
          operation_kind: "video_render",
          adapter_id: declaration.adapter_id,
          backend_binding_id: declaration.backend_binding_id,
          worker_id: "worker-a",
          resource_ids: ["gpu-a", "store-a"],
          purpose: "work",
        },
      ];
      policy.bindings.push({
        ...requireValue(policy.bindings[0], "primary binding"),
        binding_id: "upload-b",
        operation_kind: "reference_upload",
        adapter_id: "videogen.comfyui-upload-adapter.v1",
        worker_id: "worker-b",
      });
      policy.resources = policy.resources.filter((r) =>
        ["gpu-a", "store-a"].includes(r.resource_id)
      );
      for (const r of policy.resources) {
        r.max_slots = 1;
        r.limits = meters(10000000);
        r.protected_finish = meters(0);
      }
      policy.queue_wait_ms = 30000;
      policy.active_inactivity_ms = 30000;
      policy.max_snapshots_per_operation = 64;
      const topology = {
        schema_version: 1 as const,
        resources: policy.resources.map((r) => ({
          resource_id: r.resource_id,
          device:
            r.resource_id === "gpu-a"
              ? { kind: "gpu" as const, uuid: "GPU-1234" }
              : { kind: "local" as const, identity: r.resource_id },
        })),
        workers: [
          { worker_id: "worker-a", resource_ids: ["gpu-a", "store-a"] },
          { worker_id: "worker-b", resource_ids: ["gpu-a", "store-a"] },
        ],
      };
      policy.topology_sha256 = sha256(canonicalJson(topology));
      const native: NativeCapacityRuntime = {
        topology,
        workers: [worker, peerWorker],
        meters: [
          {
            binding_id: "video-a",
            process: pin,
            cpu_cgroup: { directory: f.root, proc_path: "/fixture" },
            private_files: [],
            network: { counter_file: transfer },
            resources: [
              {
                resource_id: "gpu-a",
                sources: ["worker_cpu", "journal_events", "transfer_bytes"],
                tariff: { per: "cpu_milliseconds", numerator: 1, denominator: 1 },
              },
              {
                resource_id: "store-a",
                sources: ["private_bytes", "journal_bytes"],
                tariff: { per: "stored_bytes", numerator: 1, denominator: 1 },
              },
            ],
          },
        ],
      };
      const probe = path.join(f.root, "gpu-probe");
      const stamp = path.join(f.root, "first-probe-closed");
      writeFileSync(
        probe,
        `#!/bin/sh
if [ ! -f '${stamp}' ]; then
 grep -q '"kind":"closed"' '${worker.state_file}' && grep -q '"kind":"closed"' '${peerWorker.state_file}' || exit 3
 printf 'all overlapping gates closed before GPU probe' > '${stamp}'
fi
case "$1" in
--query-gpu=uuid) printf 'GPU-1234\\n';;
--query-compute-apps=pid,gpu_uuid) printf '${pin.pid}, GPU-1234\\n${peerPin.pid}, GPU-1234\\n';;
*) exit 1;;
esac
`,
        { mode: 0o700 }
      );
      native.gpu_probe = {
        executable: { path: probe, sha256: nativeFileSha256(probe) },
        timeout_ms: 1000,
        max_output_bytes: 4096,
      };
      native.meters.push({
        ...requireValue(native.meters[0], "primary meter"),
        binding_id: "upload-b",
        process: peerPin,
        cpu_cgroup: { directory: peerRoot, proc_path: "/fixture-peer" },
        network: { counter_file: path.join(peerRoot, "counter-{operation_record_id}.json") },
      });
      const helper = path.join(root, "scripts/system/penny_compute_gate/peer_transport.py");
      const inventoryPath = path.join(f.root, "inventory.json");
      const inventory = canonicalJson(syntheticVideogenInventory());
      writeFileSync(inventoryPath, inventory, { mode: 0o600 });
      const profile = syntheticVideogenProfile({ port: address.port });
      const template = parseVideogenRuntimeManifest(
        JSON.parse(
          readFileSync(
            new URL("./fixtures/videogen-minimal-manifest.json", import.meta.url),
            "utf8"
          )
        )
      );
      const providers = bootstrapVideogenRuntime({
        native_meter_probes: {
          cpu: () => ({
            boot_id: pin.boot_id,
            process_epoch: sha256("controlled epoch"),
            cgroup_identity: "controlled:1",
            cpu_usage_usec: "1000",
            monotonic_ns: process.hrtime.bigint().toString(),
          }),
        },
        store: f.store,
        project_id: f.projectId,
        manifest: {
          ...template,
          adapters: [
            {
              kind: "video_render",
              policy: policyOptions,
              binding: {
                worker_id: "worker-a",
                profiles: [profile],
                approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
                managed: {
                  worker,
                  backend_uid: requireValue(process.getuid?.(), "UID"),
                  socket_path: path.join(f.root, "gate.sock"),
                  python: { path: python, sha256: nativeFileSha256(python) },
                  helper: {
                    path: helper,
                    sha256: nativeFileSha256(helper),
                    package_sha256: managedComputePackageSha256(helper),
                  },
                  transfer_counter_file: transfer,
                },
                inventory: { path: inventoryPath, sha256: sha256(inventory), max_bytes: 65536 },
              },
            },
            {
              kind: "reference_upload",
              policy: { ...policyOptions, backend_key_sha256: hostCapacityWorkerKey("worker-b") },
              binding: {
                worker_id: "worker-b",
                profiles: [profile],
                approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
                managed: {
                  worker: peerWorker,
                  backend_uid: requireValue(process.getuid?.(), "UID"),
                  socket_path: path.join(peerRoot, "gate.sock"),
                  python: { path: python, sha256: nativeFileSha256(python) },
                  helper: {
                    path: helper,
                    sha256: nativeFileSha256(helper),
                    package_sha256: managedComputePackageSha256(helper),
                  },
                  transfer_counter_file: path.join(peerRoot, "counter-{operation_record_id}.json"),
                },
                inventory: { path: inventoryPath, sha256: sha256(inventory), max_bytes: 65536 },
              },
            },
          ],
          capacity: {
            policy,
            native,
            demands: policy.bindings.map((b) => ({
              operation_kind: b.operation_kind,
              binding_id: b.binding_id,
              demands: policy.resources.map((r) => ({
                resource_id: r.resource_id,
                slots: 1,
                meters: meters(1000000),
              })),
            })),
          },
        },
      });
      const options = requireValue(providers.capacity_options, "native capacity options");
      if (!(options.measurements instanceof NativeCapacityMeter))
        throw new Error("default native collector missing");
      meter = options.measurements;
      const project = new HostCapacityProjectAuthority(f.projectId, f.checkpointer, f.store, meter);
      HostOperationCapacityAuthority.configure(path.join(f.root, "state"), policy);
      authority = new HostOperationCapacityAuthority({
        stateRoot: path.join(f.root, "state"),
        policy,
        projects: [project],
      });
      const capacity = new HostOperationCapacityRuntimeBinding(authority, project, options.demands);
      const provider = requireValue(providers.effects.get("video_render"), "compiled provider");
      const snapshot = {
        schema_id: "penny.videogen-profile-snapshot.v1" as const,
        schema_version: 1 as const,
        profile,
        approved_profile_sha256: profile.profile_sha256,
        source_graph_sha256: profile.source_graph_sha256,
      };
      const snapshotRef = f.ref(snapshot, snapshot.schema_id, "videogen-profile-snapshot");
      const graph = buildVideoSubmittedGraph({
        run_id: f.runId,
        shot_id: "shot",
        profile_snapshot: snapshot,
        profile_snapshot_ref: snapshotRef,
        spec: {
          mode: "t2v",
          positive_prompt: "blue square",
          negative_prompt: "flicker",
          seed: 1,
          dimensions: { width: 64, height: 64 },
          frame_count: 3,
          fps: 3,
        },
        input_upload_receipt: null,
        input_upload_receipt_ref: null,
      });
      const graphRef = f.ref(graph, graph.schema_id, "video-submitted-graph");
      const prepared = f.prepare({
        request_schema: VideoGenerationOperationRequestV1Schema,
        request: {
          schema_id: declaration.request.schema_id,
          schema_version: 1,
          run_id: f.runId,
          shot_id: "shot",
          profile_id: profile.profile_id,
          profile_sha256: profile.profile_sha256,
          profile_snapshot_ref: snapshotRef,
          submitted_graph_ref: graphRef,
          submitted_graph_sha256: graphRef.content_digest,
          mode: "t2v",
          dimensions: graph.dimensions,
          frame_count: 3,
          fps: 3,
        },
        input_refs: [snapshotRef, graphRef],
        profile_snapshot_ref: snapshotRef,
      });
      const directive = f.start(prepared, [
        { slot: "profile_snapshot", ref: snapshotRef },
        { slot: "submitted_graph", ref: graphRef },
      ]);
      // No owner-selection methods are used by this exact Comfy factory.
      const { VideogenOwnerSelection, initializeVideogenOwnerSelection } =
        await import("../dist/videogen/owner-selection.js");
      const context = requireValue(f.checkpointer.loadRunById(f.runId), "run context");
      initializeVideogenOwnerSelection(context, {
        project_id: f.projectId,
        limits: providers.config.limits,
        admitted_destination_id: "fixture",
        territory: "fixture",
      });
      f.checkpointer.saveRun(context, "fixture_selection", {});
      const ownerSelection = new VideogenOwnerSelection({
        store: f.store,
        checkpointer: f.checkpointer,
        project_id: f.projectId,
        run_id: f.runId,
      });
      const adapter = provider.createAdapter({
        owner: ownerSelection,
        store: f.store,
        checkpointer: f.checkpointer,
        capacity: { authority, runtime: capacity },
      });
      const cache = await FileHostOperationResultCache.provision(path.join(f.root, "cache"));
      await new HostOperationRuntimeOwner({
        projectId: f.projectId,
        artifacts: f.store,
        checkpointer: f.checkpointer,
        leaseAuthority: f.leases,
        adapters: new Map([[adapter.adapter_id, adapter]]),
        capacityRuntime: capacity,
        resultCache: cache,
      }).dispatch(f.engine, directive);
      const journal = requireValue(f.checkpointer.hostOperationCallsForRun(f.runId)[0], "journal");
      expect(journal.lifecycle).toBe("consumed");
      expect(journal.disposition?.outcome).toBe("completed");
      const final = requireValue(authority.inspect(journal.operation_record_id), "final capacity");
      expect(final.state).toBe("settled");
      expect(requireValue(final.snapshot, "final snapshot").kind).toBe("final");
      expect(final.snapshot?.readings.some((r) => r.meters.egress_bytes > 0)).toBe(true);
      expect(JSON.parse(readFileSync(worker.state_file, "utf8"))).toMatchObject({
        state: { kind: "closed", active_calls: 0 },
      });
      expect(readFileSync(stamp, "utf8")).toContain("all overlapping gates closed");
      expect(JSON.parse(readFileSync(peerWorker.state_file, "utf8"))).toMatchObject({
        state: { kind: "closed", active_calls: 0 },
      });
      expect(() =>
        meter?.registerComfy({
          worker,
          backend_uid: 0,
          socket_path: "late",
          python: { path: python, sha256: nativeFileSha256(python) },
          helper: {
            path: helper,
            sha256: nativeFileSha256(helper),
            package_sha256: managedComputePackageSha256(helper),
          },
          transfer_counter_file: transfer,
        })
      ).toThrow("registration closed");
      expect(prompt).toMatch(/^[a-f0-9-]{36}$/u);
      expect(posts).toBe(0);
      expect(gets).toBeGreaterThan(3);
    } finally {
      meter?.close();
      authority?.close();
      server.closeAllConnections();
      server.close();
      service.stdin.end();
      peer.stdin.end();
      await Promise.all([once(service, "exit"), once(peer, "exit")]);
    }
  }, 30000);
});
