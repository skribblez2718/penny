import { describe, it, expect, beforeEach, vi } from "vitest";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// A hoisted control flag lets each test deterministically force the
// not-installed branch (spawnSync ENOENT) regardless of whether the real trivy
// binary is on this host (Batch F.2). The not-installed path stays a genuine
// hermetic unit test that passes with OR without the tool present.
const control = vi.hoisted(() => ({ forceMissing: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: any, args: any, opts: any) => {
      if (control.forceMissing) {
        return {
          error: new Error("ENOENT: forced not-installed"),
          status: null,
          stdout: "",
          stderr: "",
        } as any;
      }
      return (actual.spawnSync as any)(cmd, args, opts);
    },
  };
});

import extension, { buildTrivyArgs, classifyTrivyExit } from "../../index.js";

describe("trivy extension", () => {
  let registeredTools: Array<{ name: string; execute: (...a: any[]) => any }>;
  let mockPi: ExtensionAPI;

  beforeEach(() => {
    control.forceMissing = false;
    registeredTools = [];
    mockPi = {
      registerTool: (tool: any) => registeredTools.push(tool),
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("registers exactly one trivy_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("trivy_scan");
  });

  it("returns a graceful not-installed message with the pinned version (forced)", async () => {
    control.forceMissing = true; // deterministic — hermetic regardless of host
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "trivy_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(text).toContain("v0.72.0");
    expect(text.toLowerCase()).toContain("not installed");
  });

  it("is presence-aware: on this host (trivy present) it runs instead of returning the not-installed stub", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "trivy_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.tool).toBe("trivy");
    expect(typeof parsed.success).toBe("boolean");
    if (parsed.installed === false) {
      expect(res.content[0].text).toContain("v0.72.0");
      expect(res.content[0].text.toLowerCase()).toContain("not installed");
    } else {
      expect(res.content[0].text.toLowerCase()).not.toContain("not installed");
    }
  });
});

// Batch F.2 REAL-VERIFIED fix: trivy-secret.yaml must NOT carry the invalid
// `enable-builtin-rules` key (it FATAL'd trivy 0.72.0), and must remain a
// well-formed allow-rules-only config that real trivy accepts (rc=0).
describe("trivy-secret.yaml config", () => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const secretYamlPath = join(__dir, "..", "..", "trivy-secret.yaml");
  const raw = readFileSync(secretYamlPath, "utf-8");
  // Only consider non-comment lines for structural checks.
  const lines = raw.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));

  it("does NOT contain the invalid enable-builtin-rules key", () => {
    for (const l of lines) {
      expect(l).not.toMatch(/^\s*enable-builtin-rules\s*:/);
    }
  });

  it("keeps the allow-rules block and is well-formed YAML (no tabs)", () => {
    expect(lines.some((l) => /^allow-rules\s*:/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s*-\s*id\s*:/.test(l))).toBe(true);
    // Real YAML forbids hard tabs for indentation.
    expect(raw).not.toMatch(/\t/);
  });
});

// Phase 6b: Carren's Phase 4a deferred nit — the secret ruleset must be passed
// as an explicit absolute --secret-config CLI arg (not left to trivy.yaml's
// internal relative reference resolving against an unpredictable runtime cwd).
describe("trivy buildTrivyArgs", () => {
  it("passes both --config and --secret-config as absolute paths", () => {
    const args = buildTrivyArgs("/tmp/target");
    const cfgIdx = args.indexOf("--config");
    const secIdx = args.indexOf("--secret-config");
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    expect(secIdx).toBeGreaterThanOrEqual(0);
    const cfgPath = args[cfgIdx + 1];
    const secPath = args[secIdx + 1];
    expect(isAbsolute(cfgPath)).toBe(true);
    expect(isAbsolute(secPath)).toBe(true);
    expect(cfgPath.endsWith("trivy.yaml")).toBe(true);
    expect(secPath.endsWith("trivy-secret.yaml")).toBe(true);
  });

  it("uses array-form args with the target last (no shell string)", () => {
    const args = buildTrivyArgs("/tmp/target");
    expect(args[0]).toBe("fs");
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args[args.length - 1]).toBe("/tmp/target");
  });
});

// Phase 6b: exit-code classification (REAL-VERIFIED, trivy 0.72.0). Under our
// pinned trivy.yaml `exit-code: 0`, a successful scan (findings or clean) exits
// 0 (success path); any non-zero exit reaching the catch is a real error.
describe("trivy classifyTrivyExit", () => {
  it("treats exit 0 as findings/clean (success path)", () => {
    expect(classifyTrivyExit(0)).toBe("findings");
  });
  it("treats any non-zero exit as a real error, not findings", () => {
    expect(classifyTrivyExit(1)).toBe("error");
    expect(classifyTrivyExit(2)).toBe("error");
    expect(classifyTrivyExit(null)).toBe("error");
    expect(classifyTrivyExit(undefined)).toBe("error");
  });
});
