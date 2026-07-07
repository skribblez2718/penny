import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// A hoisted control flag lets each test deterministically force the
// not-installed branch (spawnSync ENOENT) regardless of whether the real
// osv-scanner binary is on this host (Batch F.2). The not-installed path stays
// a genuine hermetic unit test that passes with OR without the tool present.
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

import extension, { classifyOsvExit } from "../../index.js";

describe("osv-scanner extension", () => {
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

  it("registers exactly one osv_scanner_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("osv_scanner_scan");
  });

  it("returns a graceful not-installed message with the pinned version (forced)", async () => {
    control.forceMissing = true; // deterministic — hermetic regardless of host
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "osv_scanner_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(text).toContain("v2.4.0");
    expect(text.toLowerCase()).toContain("not installed");
  });

  it("is presence-aware: on this host (osv-scanner present) it runs instead of returning the not-installed stub", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "osv_scanner_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.tool).toBe("osv-scanner");
    expect(typeof parsed.success).toBe("boolean");
    if (parsed.installed === false) {
      expect(res.content[0].text).toContain("v2.4.0");
      expect(res.content[0].text.toLowerCase()).toContain("not installed");
    } else {
      expect(res.content[0].text.toLowerCase()).not.toContain("not installed");
    }
  });
});

// Phase 6b: tool-specific exit-code classification, replacing the looser
// generic `if (err.stdout)` truthy check inherited from the semgrep reference.
// OSV-Scanner documented convention (REAL-VERIFIED, osv-scanner v2.4.0): 0 = no
// vulnerabilities; 1 = vulnerabilities found (normal); other non-zero (e.g.
// 127/128) = operational error.
describe("osv-scanner classifyOsvExit", () => {
  it("treats exit 1 as findings (vulnerabilities found — normal)", () => {
    expect(classifyOsvExit(1)).toBe("findings");
  });
  it("treats exit 0 and other non-1 codes as not-findings/error", () => {
    expect(classifyOsvExit(0)).toBe("error");
    expect(classifyOsvExit(127)).toBe("error");
    expect(classifyOsvExit(128)).toBe("error");
    expect(classifyOsvExit(null)).toBe("error");
    expect(classifyOsvExit(undefined)).toBe("error");
  });
});
