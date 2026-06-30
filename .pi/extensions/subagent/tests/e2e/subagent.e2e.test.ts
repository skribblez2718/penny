/**
 * Subagent Extension E2E Tests
 *
 * Tests extension discovery and structure without LLM API calls.
 * Full E2E with LLM is run separately.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

describe("Subagent E2E — Extension Discovery", () => {
  it("should have pi available on PATH", () => {
    const result = execSync("pi --version 2>&1", { encoding: "utf-8" }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should have the subagent extension directory structure", () => {
    const extDir = path.join(process.cwd(), ".pi/extensions/subagent");
    expect(fs.existsSync(path.join(extDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(extDir, "tsconfig.json"))).toBe(true);
  });

  it("should have agent definitions in .pi/agents/", () => {
    const agentsDir = path.join(process.cwd(), ".pi/agents");
    const agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.map((f) => path.basename(f, ".md"))).toContain("echo");
  });
});
