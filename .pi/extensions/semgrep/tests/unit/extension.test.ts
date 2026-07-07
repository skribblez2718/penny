import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../../index.js";

interface CapturedTool {
  name: string;
  execute?: (...args: any[]) => any;
}

describe("semgrep extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTools: CapturedTool[];

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: (tool: CapturedTool) => {
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

  it("registers exactly 2 tools (new rulesets/preset are data, not tools)", async () => {
    await extension(mockPi);
    expect(registeredTools).toHaveLength(2);
  });

  describe("semgrep_list_rules output", () => {
    async function listRulesText(): Promise<string> {
      await extension(mockPi);
      const tool = registeredTools.find((t) => t.name === "semgrep_list_rules");
      expect(tool?.execute).toBeInstanceOf(Function);
      const result = await tool!.execute!("test-call", {}, undefined, undefined);
      return result.content.map((c: { text: string }) => c.text).join("\n");
    }

    it("lists the 9 new vendored library rulesets", async () => {
      const text = await listRulesText();
      for (const key of [
        "vendor-jose",
        "vendor-jsonwebtoken",
        "vendor-jwt-simple",
        "vendor-passport-jwt",
        "vendor-sequelize",
        "vendor-serialize-javascript",
        "vendor-shelljs",
        "vendor-node-crypto",
        "vendor-vm2",
      ]) {
        expect(text).toContain(key);
      }
    });

    it("lists the custom Tier-2 ruleset", async () => {
      const text = await listRulesText();
      expect(text).toContain("custom");
    });

    it("advertises both the jsa and sca presets", async () => {
      const text = await listRulesText();
      expect(text).toContain("jsa Preset");
      expect(text).toContain("sca Preset");
    });

    it("advertises the self-improving-SAST learned rulesets", async () => {
      const text = await listRulesText();
      expect(text).toContain("learned-jsa");
      expect(text).toContain("learned-sca");
    });
  });
});
