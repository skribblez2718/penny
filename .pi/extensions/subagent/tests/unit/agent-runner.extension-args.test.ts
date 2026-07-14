/**
 * Agent Extension-Args Tests
 *
 * Verifies resolveAgentExtensionArgs(): agents force-load Penny's full extension
 * set via `--no-extensions -e <path> ...` (independent of the agent cwd/trust),
 * so tool-providing extensions (memory, search, ...) are always available. This
 * fixes external-target agents (sca/jsa) that previously loaded zero project
 * extensions because pi's cwd-based, trust-gated discovery found none.
 *
 * fs is mocked so the extensions directory layout is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

let extDirExists = true;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const KNOWN_DIR_EXTS = ["compaction", "memory", "observability"];
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      const s = String(p);
      if (s.endsWith("/extensions")) return extDirExists;
      // subdir extensions have an index.ts; the single-file one does not
      return KNOWN_DIR_EXTS.some((name) => s.endsWith(`/extensions/${name}/index.ts`));
    }),
    statSync: vi.fn((p: unknown) => {
      const s = String(p);
      return {
        isDirectory: () => s.endsWith("/extensions"),
        isFile: () => !s.endsWith("/extensions"),
      } as unknown as import("node:fs").Stats;
    }),
    readdirSync: vi.fn((p: unknown) => {
      if (String(p).endsWith("/extensions")) {
        // intentionally unsorted to prove the function sorts deterministically
        return ["observability", "memory", "single.ts", "compaction"] as unknown as string[];
      }
      return [] as unknown as string[];
    }),
  };
});

import { resolveAgentExtensionArgs } from "../../agent-runner.js";

describe("resolveAgentExtensionArgs", () => {
  beforeEach(() => {
    extDirExists = true;
    process.env.PI_DIRECTORY = "/fake/project/.pi";
    delete process.env.PROJECT_ROOT;
  });

  it("force-loads every extension deterministically with --no-extensions", () => {
    const args = resolveAgentExtensionArgs("/any/cwd");
    expect(args[0]).toBe("--no-extensions");
    // -e paths, sorted: compaction, memory, observability, single.ts
    const ePaths = args.filter((_, i) => args[i - 1] === "-e");
    expect(ePaths).toEqual([
      "/fake/project/.pi/extensions/compaction/index.ts",
      "/fake/project/.pi/extensions/memory/index.ts",
      "/fake/project/.pi/extensions/observability/index.ts",
      "/fake/project/.pi/extensions/single.ts",
    ]);
  });

  it("includes the memory extension so memory_* tools exist regardless of cwd", () => {
    const args = resolveAgentExtensionArgs("/somewhere/else");
    expect(args.join(" ")).toContain("/extensions/memory/index.ts");
  });

  it("falls back to compaction-only (discovery left on) when extensions dir is missing", () => {
    extDirExists = false;
    delete process.env.PI_DIRECTORY;
    const args = resolveAgentExtensionArgs("/proj");
    expect(args).not.toContain("--no-extensions");
    expect(args).toEqual(["-e", "/proj/.pi/extensions/compaction/index.ts"]);
  });
});
