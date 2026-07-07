import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

describe("pdf2markdown extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: Array<{ name: string }>;
  let registeredCommands: Array<{ name: string }>;

  beforeEach(() => {
    registeredTools = [];
    registeredCommands = [];
    mockPi = {
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
      registerCommand: (name: string, _opts: unknown) => {
        registeredCommands.push({ name });
      },
      on: () => {},
    } as unknown as ExtensionAPI;
  });

  it("registers pdf_to_markdown tool", async () => {
    await extension(mockPi);
    const tool = registeredTools.find((t) => t.name === "pdf_to_markdown");
    expect(tool).toBeDefined();
  });

  it("registers pdf2markdown command", async () => {
    await extension(mockPi);
    const cmd = registeredCommands.find((c) => c.name === "pdf2markdown");
    expect(cmd).toBeDefined();
  });

  it("registers exactly 1 tool", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(1);
  });
});
