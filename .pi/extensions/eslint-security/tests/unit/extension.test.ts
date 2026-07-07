import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

// NOTE: unlike the other 7 tools, `eslint` is a root devDependency of this repo
// and is resolvable via node_modules/.bin under bun's test runner. So the pure
// "not-installed" path may not be exercised here. This test asserts GRACEFUL,
// non-crashing behavior either way: if eslint is absent it returns the pinned
// version + install hint; if eslint is present but the security plugins/target
// are absent it returns a non-throwing structured error. Both are acceptable.

describe("eslint-security extension", () => {
  let registeredTools: Array<{ name: string; execute: (...a: any[]) => any }>;
  let mockPi: ExtensionAPI;

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: (tool: any) => registeredTools.push(tool),
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("registers exactly one eslint_security_scan tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("eslint_security_scan");
  });

  it("handles a scan request gracefully (non-throwing structured response)", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "eslint_security_scan")!;
    const res = await tool.execute("test-id", { target: "/tmp/does-not-exist" });
    const text = res.content[0].text;
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.tool).toBe("eslint-security");
    // Must be a boolean success flag either way (no crash, structured output).
    expect(typeof parsed.success).toBe("boolean");
    if (parsed.installed === false) {
      // eslint binary genuinely absent -> not-installed path with pinned version.
      expect(text).toContain("v4.0.1");
      expect(text.toLowerCase()).toContain("not installed");
    }
  });
});
