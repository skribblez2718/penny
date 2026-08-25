import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PlatformMemoryClientV1,
  PlatformMemoryError,
  allowedPlatformMemoryOperations,
  assertDistinctIsolatedMemoryConfigsV1,
  resolveMemoryCredentialReference,
  validatePlatformMemoryConfigV1,
} from "../../src/index.js";
import { ALPHA_TOKEN, isolatedConfig } from "../fixtures.js";

function invokeUnchecked(
  client: PlatformMemoryClientV1,
  operation: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const result: unknown = Reflect.apply(client.invoke, client, [operation, input]);
  if (!(result instanceof Promise)) throw new Error("platform memory invocation was not async");
  return result;
}

describe("contract v1 configuration", () => {
  it("accepts only the three explicit modes and keeps none inert", async () => {
    const none = validatePlatformMemoryConfigV1({
      contractVersion: 1,
      mode: "none",
      principalId: "principal-none",
    });
    expect(none).toEqual({
      contractVersion: 1,
      mode: "none",
      principalId: "principal-none",
    });
    expect(allowedPlatformMemoryOperations(none)).toEqual([]);

    const fetchSpy = async () => new Response("unexpected");
    const client = new PlatformMemoryClientV1(none, { fetch: fetchSpy as typeof fetch });
    await expect(client.invoke("search", { query: "x" })).rejects.toMatchObject({
      code: "MEMORY_DISABLED",
    });

    expect(() => validatePlatformMemoryConfigV1({ contractVersion: 1, mode: "hub" })).toThrow(
      PlatformMemoryError
    );
    expect(() =>
      validatePlatformMemoryConfigV1({
        contractVersion: 1,
        mode: "none",
        principalId: "principal-none",
        endpoint: "https://memory.invalid/mcp",
      })
    ).toThrow(/unsupported fields/);
  });

  it("requires caller-owned target, credential, trust, and preserve custody", () => {
    const validated = validatePlatformMemoryConfigV1(isolatedConfig("alpha"));
    expect(validated).toMatchObject({
      contractVersion: 1,
      mode: "isolated",
      principalId: "principal-alpha",
      target: {
        endpoint: "https://memory-alpha.invalid/mcp",
        palaceId: "palace-alpha",
        dataRootId: "data-root-alpha",
      },
      trust: { kind: "isolated", isolationBoundaryId: "boundary-alpha" },
      custody: { uninstallDisposition: "preserve" },
    });

    expect(() =>
      validatePlatformMemoryConfigV1({
        ...isolatedConfig("alpha"),
        custody: { ...isolatedConfig("alpha").custody, uninstallDisposition: "delete" },
      })
    ).toThrow(/preserve/);
    expect(() =>
      validatePlatformMemoryConfigV1({
        ...isolatedConfig("alpha"),
        credential: { kind: "literal", token: ALPHA_TOKEN },
      })
    ).toThrow(/credential.kind/);
  });

  it("requires an explicit whole-palace acknowledgement for shared mode", () => {
    const base = isolatedConfig("alpha");
    const shared = {
      ...base,
      mode: "shared-trust-domain",
      trust: {
        kind: "shared-trust-domain",
        trustDomainId: "trusted-fleet",
        wholePalaceAccessAcknowledged: true,
      },
    } as const;
    expect(validatePlatformMemoryConfigV1(shared).mode).toBe("shared-trust-domain");
    expect(() =>
      validatePlatformMemoryConfigV1({
        ...shared,
        trust: {
          kind: "shared-trust-domain",
          trustDomainId: "trusted-fleet",
          wholePalaceAccessAcknowledged: false,
        },
      })
    ).toThrow(/whole-palace/);
  });

  it("rejects isolation claims that collide on any custody boundary", () => {
    assertDistinctIsolatedMemoryConfigsV1(isolatedConfig("alpha"), isolatedConfig("beta"));
    expect(() =>
      assertDistinctIsolatedMemoryConfigsV1(
        isolatedConfig("alpha"),
        isolatedConfig("beta", {
          target: { ...isolatedConfig("beta").target, dataRootId: "data-root-alpha" },
        })
      )
    ).toThrow(/distinct/);
  });

  it("resolves only referenced bounded environment or owner-only file credentials", () => {
    expect(
      resolveMemoryCredentialReference(
        { kind: "environment", name: "MEMORY_TOKEN" },
        { env: { MEMORY_TOKEN: ALPHA_TOKEN } }
      )
    ).toBe(ALPHA_TOKEN);

    const directory = mkdtempSync(join(tmpdir(), "platform-memory-credential-"));
    const path = join(directory, "token");
    writeFileSync(path, ALPHA_TOKEN, { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(resolveMemoryCredentialReference({ kind: "file", path })).toBe(ALPHA_TOKEN);
    chmodSync(path, 0o644);
    expect(() => resolveMemoryCredentialReference({ kind: "file", path })).toThrow(/owner-only/);
  });
});

describe("narrow operation policy", () => {
  it("allows only configured capability operations and rejects routing overrides", async () => {
    const config = isolatedConfig("alpha", {
      capabilities: ["recall-read"],
      primaryDiaryId: undefined,
    });
    const client = new PlatformMemoryClientV1(config, {
      credentialResolver: () => ALPHA_TOKEN,
      fetch: (() => Promise.resolve(new Response("unexpected"))) as typeof fetch,
    });

    await expect(
      client.invoke("add_drawer", { wing: "w", room: "r", content: "x" })
    ).rejects.toMatchObject({
      code: "MEMORY_OPERATION_FORBIDDEN",
    });
    await expect(
      client.invoke("search", {
        query: "x",
        endpoint: "https://memory-beta.invalid/mcp",
      })
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_REQUEST" });
    await expect(client.invoke("list_drawers", { limit: 101 })).rejects.toMatchObject({
      code: "MEMORY_INVALID_REQUEST",
    });
  });

  it.each(["delete", "bulk-delete", "admin", "logstream-read", "event-broadcast"])(
    "rejects out-of-contract operation %s before transport",
    async (operation) => {
      let fetched = false;
      const client = new PlatformMemoryClientV1(isolatedConfig("alpha"), {
        credentialResolver: () => ALPHA_TOKEN,
        fetch: (() => {
          fetched = true;
          return Promise.resolve(new Response("unexpected"));
        }) as typeof fetch,
      });
      await expect(invokeUnchecked(client, operation, {})).rejects.toMatchObject({
        code: "MEMORY_OPERATION_FORBIDDEN",
      });
      expect(fetched).toBe(false);
    }
  );
});
