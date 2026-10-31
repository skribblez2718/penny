import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  ManagedComputeRelay,
  managedComputePackageSha256,
} from "../dist/host-operations/managed-compute-relay.js";
import { publishManagedLeaseFile } from "../dist/host-operations/managed-lease-client.js";
import { nativeFileSha256, observeNativeProcess } from "../dist/host-operations/native-process.js";
import { ComfyHttpClient } from "../dist/comfy/client.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import { nativeProcessPin } from "./helpers/native-capacity-fixture.js";
import { requireValue } from "./helpers/narrowing.js";

afterEach(() => vi.unstubAllEnvs());

describe("private compute relay: actual kernel peer and global catalog, synthetic no-GPU executor", () => {
  it.each(["finish", "expiry_drain", "expiry_meter"] as const)(
    "closes actual service, binds graph, and drains only owned work (%s)",
    async (terminal) => {
      using f = new CapacityFixture();
      const root = path.resolve("../..");
      vi.stubEnv("PYTHONPATH", path.join(root, "scripts/system"));
      const python = realpathSync(path.join(root, ".venv/bin/python"));
      const service = spawn(
        python,
        [path.join(root, "apps/orchestration/tests/fixtures/managed-compute-service.py"), f.root],
        { stdio: "pipe" }
      );
      let relay: ManagedComputeRelay | undefined;
      try {
        await once(service.stdout, "data");
        const pin = nativeProcessPin(requireValue(service.pid, "fake service PID"));
        const authority = f.core();
        const helper = path.join(root, "scripts/system/penny_compute_gate/peer_transport.py");
        relay = new ManagedComputeRelay({
          authority,
          worker_id: "worker-a",
          backend: pin,
          backend_uid: requireValue(process.getuid?.(), "UID"),
          gate_build_sha256: "b".repeat(64),
          socket_path: path.join(f.root, "gate.sock"),
          python: { path: python, sha256: nativeFileSha256(python) },
          helper: {
            path: helper,
            sha256: nativeFileSha256(helper),
            package_sha256: managedComputePackageSha256(helper),
          },
          state_file: path.join(f.root, "state.json"),
          counter_file: path.join(f.root, "counter-{operation_record_id}.json"),
        });
        await relay.close();
        expect(JSON.parse(readFileSync(path.join(f.root, "state.json"), "utf8"))).toMatchObject({
          sequence: 1,
          state: { kind: "closed", active_calls: 0 },
        });
        const project = requireValue(f.projects[0], "project");
        const persist = (kind: string, schema: string, content: unknown) =>
          project.artifacts.persist({
            metadata: {
              schema_version: 2,
              run_id: "real-private-relay",
              phase: "capacity-state",
              branch_id: null,
              kind,
              operation_id: kind,
              version: 1,
              producer: "host:test",
              media_type: "application/json",
              content_schema: { schema_id: schema, schema_version: 1 },
              parent_ref: null,
              upstream_refs: [],
            },
            content: canonicalJson(content),
          });
        const snapshot = persist("snapshot", "penny.videogen-profile-snapshot.v1", {
          synthetic: true,
        });
        const graph = { "1": { class_type: "Fake", inputs: { text: "exact artifact payload" } } };
        const artifact = {
          schema_id: "penny.video-submitted-graph.v1",
          schema_version: 1,
          run_id: "real-private-relay",
          shot_id: "shot",
          profile_id: "synthetic",
          profile_sha256: sha256("profile"),
          profile_snapshot_ref: snapshot,
          mode: "t2v",
          dimensions: { width: 64, height: 64 },
          frame_count: 1,
          fps: 1,
          seed: 1,
          input_upload_receipt_ref: null,
          input_descriptor: null,
          output_node_id: "1",
          graph,
        };
        const graphRef = persist("submitted", "penny.video-submitted-graph.v1", artifact);
        const submittedBytes = Buffer.from(canonicalJson(artifact));
        const request = {
          schema_id: "penny.video-generation-operation-request.v1",
          schema_version: 1,
          run_id: artifact.run_id,
          shot_id: artifact.shot_id,
          profile_id: artifact.profile_id,
          profile_sha256: artifact.profile_sha256,
          profile_snapshot_ref: snapshot,
          submitted_graph_ref: graphRef,
          submitted_graph_sha256: graphRef.content_digest,
          mode: artifact.mode,
          dimensions: artifact.dimensions,
          frame_count: 1,
          fps: 1,
        };
        const op = f.operation("real-private-relay", "video-a", 0, 20, request);
        const held = authority.reserve(op.request);
        const lease = requireValue(op.record.lease, "fence");
        f.leases.guardSubmission(op.leaseRequest, lease, f.now);
        f.transition(op, { lifecycle: "submitting" });
        const grant = {
          schema_id: "penny.managed-lease-grant.v1" as const,
          schema_version: 1 as const,
          operation_record_id: op.record.operation_record_id,
          project_id: op.record.project_id,
          operation_request_sha256: op.record.request_sha256,
          capacity_request_sha256: sha256(canonicalJson(held.request)),
          directive_sha256: op.record.directive_sha256,
          lease,
          worker_id: "worker-a",
          process_epoch: observeNativeProcess(pin, nativeFileSha256).process_epoch,
          gate_sequence: 1,
          resource_ids: op.request.demands.map((d) => d.resource_id),
          issued_at_ms: f.now,
          expires_at_ms: f.now + 100000,
        };
        authority.recordNativeEvent(op.record.operation_record_id, "managed_lease_grant_v1", grant);
        const grantFile = path.join(f.root, "grant.json");
        publishManagedLeaseFile(grantFile, grant);
        await expect(
          relay.open({
            grant_file: grantFile,
            operation_request_bytes: op.project.artifacts.readById(
              op.record.directive.request_ref.artifact_id
            ),
            submitted_graph_bytes: Buffer.from(
              canonicalJson({ ...artifact, graph: { "1": { class_type: "Other", inputs: {} } } })
            ),
          })
        ).rejects.toThrow("binding conflict");
        const prompt = await relay.open({
          grant_file: grantFile,
          operation_request_bytes: op.project.artifacts.readById(
            op.record.directive.request_ref.artifact_id
          ),
          submitted_graph_bytes: submittedBytes,
        });
        expect(prompt).toMatch(/^[a-f0-9-]{36}$/u);
        if (terminal === "expiry_meter") {
          const closeMeter = relay.beginSocket();
          f.now += f.policy.active_inactivity_ms + 1;
          expect(() => closeMeter(10, 15)).not.toThrow();
          await expect(relay.sample()).rejects.toThrow();
          expect(() => readFileSync(path.join(f.root, "state.json"))).toThrow();
          return;
        }
        if (terminal === "expiry_drain") {
          f.now += f.policy.active_inactivity_ms + 1;
          const drained = await relay.drainOwned();
          expect(drained).toMatchObject({ mode: "closed", active_calls: 0, sequence: 3 });
          expect(() =>
            readFileSync(path.join(f.root, `counter-${op.record.operation_record_id}.json`))
          ).toThrow();
          return;
        }
        await relay.submit();
        let observation = await relay.sample();
        for (let i = 0; i < 20 && !observation.terminal; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          observation = await relay.sample();
        }
        expect(observation).toMatchObject({
          terminal: true,
          active_calls: 0,
          prompt_id: prompt,
          graph_sha256: sha256(canonicalJson(graph)),
        });
        await relay.finish();
        const state: unknown = JSON.parse(readFileSync(path.join(f.root, "state.json"), "utf8"));
        expect(state).toMatchObject({ sequence: 3, state: { kind: "closed" } });
        const counter: unknown = JSON.parse(
          readFileSync(path.join(f.root, `counter-${op.record.operation_record_id}.json`), "utf8")
        );
        expect(counter).toMatchObject({
          operation_record_id: op.record.operation_record_id,
          lease,
        });
        expect(counter).toHaveProperty("egress_bytes", expect.any(Number));
        await expect(
          relay.open({
            grant_file: grantFile,
            operation_request_bytes: op.project.artifacts.readById(
              op.record.directive.request_ref.artifact_id
            ),
            submitted_graph_bytes: submittedBytes,
          })
        ).rejects.toThrow("replay conflict");
      } finally {
        relay?.disconnect();
        service.stdin.end();
        await once(service, "exit");
      }
    },
    15000
  );

  it("counts actual one-use HTTP socket bytes without widening the strict client's graph authority", async () => {
    let observed: { written: number; read: number } | undefined;
    let resolveWire: (() => void) | undefined;
    const wire = new Promise<void>((resolve) => {
      resolveWire = resolve;
    });
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture address unavailable");
      const client = new ComfyHttpClient(
        { scheme: "http", host: "127.0.0.1", port: address.port },
        {
          max_request_bytes: 4096,
          max_readiness_bytes: 4096,
          max_inventory_bytes: 4096,
          max_history_bytes: 4096,
          max_image_bytes: 4096,
          connect_timeout_ms: 1000,
          read_timeout_ms: 1000,
        },
        {
          beginSocket: () => (written, read) => {
            observed = { written, read };
            resolveWire?.();
          },
        }
      );
      await client.ready({ signal: new AbortController().signal });
      await wire;
      expect(requireValue(observed, "wire counter").written).toBeGreaterThan(20);
      expect(requireValue(observed, "wire counter").read).toBeGreaterThan(2);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
