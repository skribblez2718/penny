import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// A hoisted control flag lets each test deterministically force the
// not-installed branch (spawnSync ENOENT) regardless of whether the real
// gitleaks binary is on this host. This keeps the not-installed path a genuine
// hermetic unit test (Batch F.2) — it passes with OR without the tool present.
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

import extension, { buildGitleaksArgs } from "../../index.js";

describe("gitleaks extension", () => {
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

  it("registers exactly one gitleaks_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("gitleaks_scan");
  });

  it("returns a graceful not-installed message with the pinned version (forced)", async () => {
    control.forceMissing = true; // deterministic — hermetic regardless of host
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "gitleaks_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(text).toContain("v8.30.1");
    expect(text.toLowerCase()).toContain("not installed");
  });

  it("is presence-aware: on this host (gitleaks present) it runs instead of returning the not-installed stub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-pa-"));
    writeFileSync(join(dir, "app.js"), 'console.log("hi");\n');
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "gitleaks_scan")!;
    const res = await tool.execute("test-id", { target: dir });
    const text = res.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.tool).toBe("gitleaks");
    expect(typeof parsed.success).toBe("boolean");
    if (parsed.installed === false) {
      // Hypothetical tool-less host: graceful not-installed with pinned version.
      expect(text).toContain("v8.30.1");
      expect(text.toLowerCase()).toContain("not installed");
    } else {
      // Tool present: it actually ran (success shape) — never the stub.
      expect(text.toLowerCase()).not.toContain("not installed");
      expect(parsed.success).toBe(true);
      expect(typeof parsed.total_findings).toBe("number");
    }
  });
});

// Batch F.2 REAL-VERIFIED fix: the args MUST include --no-git, else gitleaks
// scans (absent) git history on a plain directory and finds 0 bytes.
describe("gitleaks buildGitleaksArgs", () => {
  it("includes the required --no-git flag", () => {
    const args = buildGitleaksArgs("/tmp/target", "/tmp/report.json");
    expect(args).toContain("--no-git");
  });

  it("uses array-form args (no shell string) with detect + json report", () => {
    const args = buildGitleaksArgs("/tmp/target", "/tmp/report.json");
    expect(args[0]).toBe("detect");
    expect(args).toContain("--source");
    expect(args).toContain("--report-format");
    expect(args).toContain("json");
    const rpIdx = args.indexOf("--report-path");
    expect(rpIdx).toBeGreaterThanOrEqual(0);
    expect(args[rpIdx + 1]).toBe("/tmp/report.json");
  });
});
