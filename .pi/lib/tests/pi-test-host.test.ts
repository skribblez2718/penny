import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireArrayElement, requireDefined, requireFunction } from "./test-narrowers.js";

const state = vi.hoisted((): { failMkdir: boolean; created: string[] } => ({
  failMkdir: false,
  created: [],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync(prefix: string) {
      const directory = actual.mkdtempSync(prefix);
      state.created.push(directory);
      return directory;
    },
    mkdirSync(directory: string) {
      if (state.failMkdir) throw new Error("fixture mkdir failure");
      return actual.mkdirSync(directory);
    },
  };
});

// Consuming tests may mock the entire SDK. Host templates must still use the real SDK.
vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("@earendil-works/pi-ai", () => ({}));

beforeEach(() => {
  vi.resetModules();
  state.failMkdir = false;
  state.created = [];
});
afterEach(() => vi.restoreAllMocks());

describe("installed SDK test host", () => {
  it("bypasses consuming SDK mocks, never fetches, and removes its disposable directory", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const { createTestExtensionApi, createTestToolInfos } = await import("./pi-test-host.js");
    expect(requireArrayElement(createTestToolInfos(["provider"]), 0).name).toBe("provider");
    expect(createTestExtensionApi().getActiveTools()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.created).toHaveLength(1);
    expect(existsSync(requireArrayElement(state.created, 0))).toBe(false);
  });

  it("removes its disposable directory and propagates initialization failure", async () => {
    state.failMkdir = true;
    await expect(import("./pi-test-host.js")).rejects.toThrow("fixture mkdir failure");
    expect(state.created).toHaveLength(1);
    expect(existsSync(requireArrayElement(state.created, 0))).toBe(false);
  });

  it("does not expose original SDK methods through property descriptors", async () => {
    const { createTestExtensionApi } = await import("./pi-test-host.js");
    const api = createTestExtensionApi();
    // This additive capability exists in Pi 1.x, not the compatibility baseline.
    if (Object.hasOwn(api, "getSettings")) {
      const descriptor = requireDefined(Object.getOwnPropertyDescriptor(api, "getSettings"));
      const value: unknown = descriptor.value;
      expect(() => requireFunction(value)()).toThrow(
        "test ExtensionAPI capability is not implemented: getSettings"
      );
    }
  });
});
