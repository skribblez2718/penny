import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

describe("jsluice extension", () => {
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

  it("registers jsluice_urls tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "jsluice_urls");
    expect(tool).toBeDefined();
  });

  it("registers jsluice_secrets tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "jsluice_secrets");
    expect(tool).toBeDefined();
  });

  it("registers exactly 2 tools", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(2);
  });
});
