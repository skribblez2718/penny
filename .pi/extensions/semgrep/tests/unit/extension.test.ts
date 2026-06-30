import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

describe("semgrep extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: Array<{ name: string }>;

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("registers semgrep_scan tool", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "semgrep_scan");
    expect(tool).toBeDefined();
  });

  it("registers semgrep_list_rules tool", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "semgrep_list_rules");
    expect(tool).toBeDefined();
  });

  it("registers exactly 2 tools", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(2);
  });
});
