import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

describe("javascript extension", () => {
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

  it("registers js_download_target tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "js_download_target");
    expect(tool).toBeDefined();
  });

  it("registers js_deobfuscate tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "js_deobfuscate");
    expect(tool).toBeDefined();
  });

  it("registers js_inventory tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "js_inventory");
    expect(tool).toBeDefined();
  });

  it("registers exactly 3 tools", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(3);
  });
});
