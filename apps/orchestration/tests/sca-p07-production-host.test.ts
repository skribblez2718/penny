import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  scaBrokerExecuteRequestSha256,
  validateScaBrokerExecuteRequestV1,
  type ScaBrokerExecuteRequestV1,
} from "../dist/sca/broker-contracts.js";
import { createScaP07CandidateRegistrationV1 } from "../dist/sca/p07-playbook.js";
import {
  createScaP07ProductionHostCompositionV1,
  createScaP07UnixBrokerClientV1,
} from "../dist/sca/p07-production-host.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function endpoint(mode: "ok" | "malformed" = "ok") {
  const root = mkdtempSync(path.join(os.tmpdir(), "p07-production-host-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const socketPath = path.join(root, "broker.sock");
  let observed: unknown = null;
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const frame = Buffer.concat(chunks).toString("utf8");
      observed = JSON.parse(frame.slice(0, -1));
      if (mode === "malformed") {
        socket.end("{}\n{}\n");
        return;
      }
      if (
        typeof observed !== "object" ||
        observed === null ||
        Array.isArray(observed) ||
        !("request" in observed)
      )
        throw new Error("test broker request absent");
      const request = validateScaBrokerExecuteRequestV1(observed.request);
      socket.end(
        `${JSON.stringify({
          protocol: "penny.sca-service-ipc.v1",
          ok: true,
          action: "execute",
          result: {
            schema_id: "penny.sca-broker-execute-accepted-result.v1",
            schema_version: 1,
            tenant_id: request.tenant_id,
            project_id: request.project_id,
            run_id: request.run_id,
            job_id: request.job_id,
            attempt: request.attempt,
            idempotency_key: request.idempotency_key,
            tool_name: request.tool_name,
            operation: request.operation,
            request_sha256: scaBrokerExecuteRequestSha256(request),
            status: "accepted",
            accepted_at: request.submitted_at,
          },
        })}\n`
      );
    });
  });
  servers.push(server);
  return {
    root,
    socketPath,
    observed: () => observed,
    ready: new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    }),
  };
}

function artifact(kind: string, operation: string, digest: string) {
  const identity = {
    branch_id: null,
    kind,
    operation_id: operation,
    phase: "SCA-P01-source",
    run_id: "run",
    version: 1,
  };
  return {
    schema_version: 2 as const,
    artifact_id: `art_${sha256(canonicalJson(identity))}`,
    run_id: "run",
    phase: "SCA-P01-source",
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    producer: "host:source-custody",
    media_type: "application/json",
    content_schema: {
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
    },
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function request(): ScaBrokerExecuteRequestV1 {
  const now = new Date();
  const ref = artifact("source-snapshot", "source", "c".repeat(64));
  return {
    schema_id: "penny.sca-broker-execute-request.v1",
    schema_version: 1,
    tenant_id: "tenant",
    project_id: "project",
    run_id: "run",
    job_id: "job",
    attempt: 1,
    idempotency_key: "idempotency",
    tool_name: "sca_source_query",
    operation: "source_query",
    submitted_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + 10_000).toISOString(),
    limits: { timeout_ms: 1000, max_output_bytes: 1000, max_result_items: 10 },
    source_snapshot_ref: ref,
    config_ref: artifact("config", "config", "d".repeat(64)),
    input_refs: [],
    operation_input: {
      kind: "source_query",
      query_id: "query",
      selectors: [{ path: "src/a.ts", line_range: null, symbol: null }],
      parameters: [],
    },
  };
}

const token = "t".repeat(32);

describe("P07 production Unix broker client", () => {
  it("keys its runtime adapter map by the registered adapter ID and supplies use-time validation", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "p07-production-composition-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const store = ArtifactStore.provision(path.join(root, "artifacts"), {
      projectId: `prj_${"a".repeat(32)}`,
    });
    try {
      const composition = createScaP07ProductionHostCompositionV1({
        store,
        resolve_current_authority_ref: () => {
          throw new Error("not used during construction");
        },
        socket: {
          socket_path: path.join(root, "broker.sock"),
          authentication_token: token,
          response_inactivity_ms: 1000,
          max_response_bytes: 100_000,
        },
        backend_binding_id: "broker",
        lease_profile_id: "lease",
        lease_duration_ms: 30_000,
        lease_renew_after_ms: 10_000,
        queue_inactivity_ms: 5_000,
        operation_inactivity_ms: 30_000,
        max_input_bytes: 500_000,
        max_output_bytes: 100_000,
      });
      expect(composition.adapters.get(composition.declaration.adapter_id)).toBe(
        composition.adapter
      );
      expect(composition.adapters.get(composition.operation_kind)).toBeUndefined();
      expect(composition.use_validator.validateUse).toEqual(expect.any(Function));

      // A candidate registration built from the composition declares the composition's exact
      // declaration and backend key.
      const registration = createScaP07CandidateRegistrationV1({
        declaration: composition.declaration,
        backend_key_sha256: composition.backend_key_sha256,
        resolve_current_authority_ref: () => {
          throw new Error("not used during construction");
        },
      });
      expect(registration.host_operations?.declarations).toEqual([composition.declaration]);
    } finally {
      store.close();
    }
  });
  it("sends one authenticated bounded frame to an owner-only Unix endpoint", async () => {
    const host = endpoint();
    await host.ready;
    const client = createScaP07UnixBrokerClientV1({
      socket_path: host.socketPath,
      authentication_token: token,
      response_inactivity_ms: 1000,
      max_response_bytes: 100_000,
    });
    const value = request();
    const result = await client.execute(value, new AbortController().signal);
    expect(result.status).toBe("accepted");
    expect(host.observed()).toEqual({
      protocol: "penny.sca-service-ipc.v1",
      action: "execute",
      token,
      request: value,
    });
  });

  it("rejects malformed multi-frame responses and non-private endpoint parents", async () => {
    const malformed = endpoint("malformed");
    await malformed.ready;
    const client = createScaP07UnixBrokerClientV1({
      socket_path: malformed.socketPath,
      authentication_token: token,
      response_inactivity_ms: 1000,
      max_response_bytes: 100_000,
    });
    await expect(client.execute(request(), new AbortController().signal)).rejects.toThrow(
      /malformed|multiple/u
    );

    const exposed = endpoint();
    await exposed.ready;
    chmodSync(exposed.root, 0o755);
    const exposedClient = createScaP07UnixBrokerClientV1({
      socket_path: exposed.socketPath,
      authentication_token: token,
      response_inactivity_ms: 1000,
      max_response_bytes: 100_000,
    });
    await expect(exposedClient.execute(request(), new AbortController().signal)).rejects.toThrow(
      /owner-only/u
    );
  });
});
