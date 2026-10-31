import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostOperationResultCacheV1 } from "../dist/host-operations/result-cache.js";
import type { ModelClient } from "../dist/model-client.js";
import { initializePennyState } from "../dist/state/index.js";

const captured = vi.hoisted(() => [] as unknown[]);
vi.mock("../dist/host-operations/owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dist/host-operations/owner.js")>();
  return {
    ...actual,
    HostOperationRuntimeOwner: class extends actual.HostOperationRuntimeOwner {
      constructor(...args: ConstructorParameters<typeof actual.HostOperationRuntimeOwner>) {
        captured.push(args[0]);
        super(...args);
      }
    },
  };
});

import { OrchestrationService } from "../dist/service.js";

const roots: string[] = [];
afterEach(() => {
  captured.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OrchestrationService host-operation result cache composition", () => {
  it("forwards the exact durable cache into the runtime owner", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "service-host-cache-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };
    initializePennyState(projectRoot, { env });
    const cache: HostOperationResultCacheV1 = {
      async read() {
        return null;
      },
      async write(requestSha256, bytes) {
        return {
          schema_version: 1,
          request_sha256: requestSha256,
          content_sha256: "a".repeat(64),
          byte_length: bytes.byteLength,
          bytes,
        };
      },
    };
    const modelClient: ModelClient = {
      async runAgent() {
        throw new Error("cache composition fixture must not invoke a model");
      },
    };
    const service = new OrchestrationService({
      projectRoot,
      env,
      modelClient,
      hostOperationAdapters: new Map(),
      hostOperationResultCache: cache,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ resultCache: cache });
    service.close();
  });
});
