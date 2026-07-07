import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// A hoisted control flag lets each test deterministically force the
// not-installed branch (spawnSync ENOENT) regardless of whether the real
// trufflehog binary is on this host (Batch F.2). The not-installed path stays
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

import extension from "../../index.js";

describe("trufflehog extension", () => {
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

  it("registers exactly one trufflehog_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("trufflehog_scan");
  });

  it("returns a graceful not-installed message with the pinned version (forced)", async () => {
    control.forceMissing = true; // deterministic — hermetic regardless of host
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "trufflehog_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(text).toContain("v3.95.7");
    expect(text.toLowerCase()).toContain("not installed");
  });

  it("is presence-aware: on this host (trufflehog present) it runs instead of returning the not-installed stub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trufflehog-pa-"));
    writeFileSync(join(dir, "app.js"), 'console.log("hi");\n');
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "trufflehog_scan")!;
    const res = await tool.execute("test-id", { target: dir });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.tool).toBe("trufflehog");
    expect(typeof parsed.success).toBe("boolean");
    if (parsed.installed === false) {
      expect(res.content[0].text).toContain("v3.95.7");
      expect(res.content[0].text.toLowerCase()).toContain("not installed");
    } else {
      expect(res.content[0].text.toLowerCase()).not.toContain("not installed");
    }
  });
});
