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
vi.mock("@earendil-works/pi-coding-agent", () => ({
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

  it("fails discovery on missing, empty, or duplicate tools instead of ambient fallback", () => {
    const projectRoot = fs.mkdtempSync(path.join("/tmp", "penny-agent-discovery-"));
    const agentsDir = path.join(projectRoot, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(agentsDir, "invalid.md"),
        "---\nname: invalid\ndescription: Invalid fixture\n---\nPrompt"
      );
      expect(() => discoverAgents(projectRoot, "project")).toThrow(/non-empty tools/);
      fs.writeFileSync(
        path.join(agentsDir, "invalid.md"),
        "---\nname: invalid\ndescription: Invalid fixture\ntools: read, read\n---\nPrompt"
      );
      expect(() => discoverAgents(projectRoot, "project")).toThrow(/duplicate tool 'read'/);
      fs.writeFileSync(
        path.join(agentsDir, "invalid.md"),
        "---\nname: invalid\ndescription: Valid fixture\ntools: read, artifact_read\n---\nPrompt"
      );
      expect(discoverAgents(projectRoot, "project").agents[0]?.tools).toEqual([
        "read",
        "artifact_read",
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("guards local discovery source against MemPalace or memory lookup dependencies", () => {
    const source = fs.readFileSync(new URL("../../agents.ts", import.meta.url), "utf-8");
    const forbiddenLookup =
      /\bmempalace\b|mempalace_|memory_(?:smart_search|search|list|get|query)|(?:from|require\()\s*["'][^"']*(?:memory|mempalace)/i;
    expect(source).not.toMatch(forbiddenLookup);
  });

  it("formats a bounded, single-line model-visible agent catalog", async () => {
    const {
      formatModelVisibleAgentCatalog,
      MODEL_VISIBLE_AGENT_LIMIT,
      MODEL_VISIBLE_AGENT_DESCRIPTION_LIMIT,
      MODEL_VISIBLE_AGENT_CATALOG_LIMIT,
    } = await import("../../agents.js");
    const agents = Array.from({ length: MODEL_VISIBLE_AGENT_LIMIT + 2 }, (_, index) => ({
      name: `agent-${index}`,
      description: `specialty-${index}\n${"x".repeat(MODEL_VISIBLE_AGENT_DESCRIPTION_LIMIT + 100)}`,
      systemPrompt: "test",
      tools: ["read"],
      source: "project" as const,
      filePath: `/tmp/agent-${index}.md`,
    }));

    const catalog = formatModelVisibleAgentCatalog(agents);

    expect(catalog).not.toContain("\n");
    expect(catalog).toContain("agent-0: specialty-0 ");
    expect(catalog).toContain("…");
    expect(catalog.length).toBeLessThanOrEqual(MODEL_VISIBLE_AGENT_CATALOG_LIMIT);

    // The catalog is bounded by whichever limit binds FIRST: the agent count or the
    // total character budget. Which one that is depends on the description limit, so
    // asserting a fixed remainder silently encodes the current constants. (It did:
    // this previously hard-coded "2 additional agents", which held only while
    // MODEL_VISIBLE_AGENT_LIMIT was the binding constraint at a 512-char description
    // limit. Raising that limit made the catalog budget bind instead.)
    //
    // Assert the accounting invariant instead — every agent is either listed or
    // counted in the remainder, exactly once. That is stronger than a magic number
    // and survives a change to either limit.
    const listed = (catalog.match(/agent-\d+:/g) ?? []).length;
    const remainder = catalog.match(
      /(\d+) additional agents? (?:is|are) available by name in the tool schema/
    );

    expect(remainder).not.toBeNull();
    if (remainder === null) {
      throw new Error("catalog must report the number of omitted agents");
    }
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThanOrEqual(MODEL_VISIBLE_AGENT_LIMIT);
    expect(listed + Number(remainder[1])).toBe(agents.length);
    // The first omitted agent must not appear.
    expect(catalog).not.toContain(`agent-${listed}:`);
  });
});
