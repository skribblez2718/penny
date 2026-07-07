import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// codeql is OPT-IN only. Without confirm_opt_in it returns a STATIC notice and
// never attempts binary detection. With confirm_opt_in=true it detects the
// binary (version --format=terse) and, if present, would run the two-step scan.
//
// Batch F.2 test policy:
//  - spawnSync (version-check) is delegated to the REAL binary by default, so on
//    THIS host the codeql 2.25.6 version-check is genuinely exercised. A hoisted
//    control flag can force the not-installed branch (ENOENT) deterministically
//    so the not-installed path is a hermetic unit test on ANY host.
//  - execFileSync (the heavy two-step database create + analyze) is ALWAYS
//    blocked here: we NEVER build a real codeql database in the unit suite
//    (scan-path verification is deferred / opt-in-off). This guarantees the
//    suite is fast and safe regardless of host.
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
    // GUARD: never run a real codeql database build/analyze in unit tests.
    execFileSync: () => {
      const e = new Error("codeql database build is intentionally blocked in unit tests");
      (e as any).status = 1;
      throw e;
    },
  };
});

import extension from "../../index.js";

describe("codeql extension", () => {
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

  it("registers exactly one codeql_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("codeql_scan");
  });

  it("returns the static opt-in notice when confirm_opt_in is missing", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "codeql_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(text).toContain("OPT-IN");
    expect(text.toLowerCase()).toContain("confirm_opt_in");
    // Must NOT have attempted detection / reported install status.
    expect(text.toLowerCase()).not.toContain("not installed");
  });

  it("returns the static opt-in notice when confirm_opt_in is false", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "codeql_scan")!;
    const res = await tool.execute("test-id", { target: "/x", confirm_opt_in: false });
    expect(res.content[0].text).toContain("OPT-IN");
  });

  it("after opt-in with the binary absent (forced), follows the graceful not-installed path", async () => {
    control.forceMissing = true; // deterministic — hermetic regardless of host
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "codeql_scan")!;
    const res = await tool.execute("test-id", {
      target: "/tmp/does-not-exist",
      confirm_opt_in: true,
    });
    const text = res.content[0].text;
    expect(text).toContain("v2.25.6");
    expect(text.toLowerCase()).toContain("not installed");
  });

  it("is presence-aware: after opt-in on this host, the version-check passes the gate and the scan path is safely stubbed (no DB build)", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "codeql_scan")!;
    const res = await tool.execute("test-id", {
      target: "/tmp/does-not-exist",
      confirm_opt_in: true,
    });
    const text = res.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.tool).toBe("codeql");
    if (parsed.installed === false) {
      // Hypothetical tool-less host: graceful not-installed with pinned version.
      expect(text).toContain("v2.25.6");
      expect(text.toLowerCase()).toContain("not installed");
    } else {
      // Tool present on this host: version-check succeeded (gate passed), then
      // the DB build was blocked by the test guard -> structured exec error,
      // NEVER the not-installed stub and NEVER a real database build.
      expect(text.toLowerCase()).not.toContain("not installed");
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("codeql execution failed");
    }
  });
});
