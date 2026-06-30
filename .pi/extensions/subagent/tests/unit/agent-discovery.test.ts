/**
 * Agent Discovery Unit Tests
 *
 * Tests discoverAgents() logic including:
 * - Normal discovery from cwd upward walk
 * - PI_DIRECTORY fallback when upward walk fails
 * - PI_DIRECTORY ignored when upward walk succeeds
 * - PI_DIRECTORY ignored when it doesn't point to a valid directory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the pi-coding-agent parseFrontmatter to return valid agent data
vi.mock("@mariozechner/pi-coding-agent", () => ({
  parseFrontmatter: (content: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { frontmatter: {}, body: content };
    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    return { frontmatter: fm, body: content.replace(/^---\n[\s\S]*?\n---\n?/, "") };
  },
}));

// We need to import after mocking, so use dynamic import
const fs = await import("node:fs");
const path = await import("node:path");

// Track original env
const originalPiDirectory = process.env.PI_DIRECTORY;

describe("discoverAgents", () => {
  let discoverAgents: typeof import("../../agents.js").discoverAgents;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import with fresh module cache
    const mod = await import("../../agents.js");
    discoverAgents = mod.discoverAgents;
  });

  afterEach(() => {
    // Restore PI_DIRECTORY
    if (originalPiDirectory !== undefined) {
      process.env.PI_DIRECTORY = originalPiDirectory;
    } else {
      delete process.env.PI_DIRECTORY;
    }
  });

  it("finds agents via upward walk from cwd", () => {
    // This test uses the REAL filesystem — the project's .pi/agents directory
    const result = discoverAgents(process.cwd(), "project");
    expect(result.agents.length).toBeGreaterThan(0);
    expect(result.projectAgentsDir).toContain(".pi/agents");
    const names = result.agents.map((a) => a.name);
    expect(names).toContain("echo");
    expect(names).toContain("piper");
    expect(names).toContain("carren");
    expect(names).toContain("tabitha");
  });

  it("falls back to PI_DIRECTORY when upward walk fails", () => {
    // Set PI_DIRECTORY to the actual project .pi dir BEFORE calling discoverAgents.
    // The extension appends /agents automatically.
    // process.cwd() here is .pi/extensions/subagent, so walk up to project root.
    const projectRoot = path.resolve(process.cwd(), "../../..");
    process.env.PI_DIRECTORY = path.join(projectRoot, ".pi");

    // Use a cwd with no .pi/agents anywhere above it
    const result = discoverAgents("/tmp", "project");
    expect(result.agents.length).toBeGreaterThan(0);
    expect(result.projectAgentsDir).toBe(path.join(projectRoot, ".pi/agents"));
    const names = result.agents.map((a) => a.name);
    expect(names).toContain("echo");
  });

  it("prefers upward walk over PI_DIRECTORY when both succeed", () => {
    // PI_DIRECTORY set to something, but cwd also has .pi/agents via upward walk
    process.env.PI_DIRECTORY = "/some/other/path/.pi";

    const result = discoverAgents(process.cwd(), "project");
    // Upward walk from .pi/extensions/subagent finds ../../.pi/agents (project root)
    const projectRoot = path.resolve(process.cwd(), "../../..");
    expect(result.projectAgentsDir).toBe(path.join(projectRoot, ".pi/agents"));
  });

  it("returns empty agents when neither upward walk nor PI_DIRECTORY works", () => {
    // No PI_DIRECTORY and no .pi/agents above /tmp
    delete process.env.PI_DIRECTORY;

    const result = discoverAgents("/tmp", "project");
    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBeNull();
  });

  it("ignores PI_DIRECTORY when it points to a non-existent directory", () => {
    process.env.PI_DIRECTORY = "/nonexistent/path/.pi";

    const result = discoverAgents("/tmp", "project");
    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBeNull();
  });
});
