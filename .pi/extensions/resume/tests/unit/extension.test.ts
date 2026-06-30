import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

describe("resume extension", () => {
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

  it("registers resume_export tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "resume_export");
    expect(tool).toBeDefined();
  });

  it("registers resume_list_accomplishments tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "resume_list_accomplishments");
    expect(tool).toBeDefined();
  });

  it("registers resume_update_canonical tool", () => {
    extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "resume_update_canonical");
    expect(tool).toBeDefined();
  });

  it("registers exactly 3 tools", () => {
    extension(mockPi);
    expect(registeredTools).toHaveLength(3);
  });
});
