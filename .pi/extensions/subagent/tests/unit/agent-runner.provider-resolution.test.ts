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

import { resolveProviderForModel } from "../../agent-runner.js";

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
