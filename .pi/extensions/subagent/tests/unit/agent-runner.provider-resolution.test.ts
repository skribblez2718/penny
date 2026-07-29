/**
 * Provider-Resolution Tests
 *
 * Verifies that an agent's model is dispatched with the provider that DECLARES
 * that model in models.json — the fix for a mixed Claude+Ollama fleet where the
 * global defaultProvider (anthropic) would otherwise misroute Ollama-model
 * agents (e.g. glm-5.2:cloud) to Anthropic and 404.
 *
 * fs.readFileSync is mocked per-path so the model catalog + settings are
 * deterministic and CI-independent. Module-level caches are fresh because
 * vitest isolates the module graph per test file.
 */

import { describe, it, expect, vi } from "vitest";

// agent-runner.ts imports this package at module load; resolve it with a stub
// so the module graph loads under vitest (mirrors the sibling model-override test).
vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((p: unknown) => {
      const s = String(p);
      if (s.endsWith("models.json")) {
        return JSON.stringify({
          providers: {
            ollama: {
              models: [{ id: "glm-5.2:cloud" }, { id: "minimax-m3:cloud" }],
            },
            anthropic: {
              models: [{ id: "claude-sonnet-x" }],
            },
          },
        });
      }
      if (s.endsWith("settings.json")) {
        return JSON.stringify({ defaultProvider: "anthropic" });
      }
      return "unrelated file contents";
    }),
  };
});

import { resolveProviderForModel, parseModelOverride } from "../../agent-runner.js";

describe("resolveProviderForModel", () => {
  it("maps an Ollama-provider model to the ollama provider", () => {
    expect(resolveProviderForModel("glm-5.2:cloud")).toBe("ollama");
    expect(resolveProviderForModel("minimax-m3:cloud")).toBe("ollama");
  });

  it("maps a model declared under anthropic to the anthropic provider", () => {
    expect(resolveProviderForModel("claude-sonnet-x")).toBe("anthropic");
  });

  it("returns undefined for a model not declared in any catalog (caller falls back to default)", () => {
    expect(resolveProviderForModel("some-unknown-model")).toBeUndefined();
  });

  it("returns undefined for an empty/undefined model id", () => {
    expect(resolveProviderForModel(undefined)).toBeUndefined();
    expect(resolveProviderForModel("")).toBeUndefined();
  });
});

describe("parseModelOverride", () => {
  it("splits a provider/model composite so the explicit provider is carried", () => {
    expect(parseModelOverride("ollama/glm")).toEqual({ provider: "ollama", model: "glm" });
    expect(parseModelOverride("ollama/glm-5.2:cloud")).toEqual({
      provider: "ollama",
      model: "glm-5.2:cloud",
    });
  });

  it("splits on the FIRST slash so a vendor-style model id survives as the model", () => {
    expect(parseModelOverride("openrouter/anthropic/claude-sonnet-4")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("treats a bare override (no slash) as a model-only override", () => {
    expect(parseModelOverride("sonnet")).toEqual({ model: "sonnet" });
    expect(parseModelOverride("glm-5.2:cloud")).toEqual({ model: "glm-5.2:cloud" });
  });

  it("returns empty for undefined/empty (agent's own model is used)", () => {
    expect(parseModelOverride(undefined)).toEqual({});
    expect(parseModelOverride("")).toEqual({});
  });

  it("falls back to model-only when a half is empty (leading/trailing slash)", () => {
    expect(parseModelOverride("/glm")).toEqual({ model: "/glm" });
    expect(parseModelOverride("ollama/")).toEqual({ model: "ollama/" });
  });
});
