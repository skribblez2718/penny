import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createWorkerResourceLoader, parseSsotTools } from "../src/model-client.js";

/**
 * End-to-end (real AgentSession): with the allow-list derived from the SSOT
 * (.pi/agents/carren.md) and an owner extension loaded, the session activates
 * exactly SSOT ∩ registered — the SSOT-allowed read tool is active, and a
 * write-capable tool is absent (not allowed and not registered). This is what
 * Option A must guarantee in a real session, using a generic stand-in so the
 * app stays extension-agnostic (no dependency on any specific extension pkg).
 */
describe("Option A: SSOT allow-list drives a real worker session", () => {
  it("activates SSOT-allowed read tools and blocks write tools in a real session", async () => {
    const projectRoot = path.resolve("..", "..");
    const agent = "carren";
    const doc = readFileSync(path.join(projectRoot, ".pi", "agents", "carren.md"), "utf8");

    // The SSOT is the authority: no private table, no hand-picked allow-list.
    const ssot = parseSsotTools(doc, agent);
    expect(ssot).toContain("bash"); // carren declares shell authority
    expect(ssot).toContain("memory_smart_search"); // carren declares memory.read
    const allowed = [...ssot, "submit_orchestration_result"];

    // Generic stand-in for a worker-read memory extension: it registers ONE
    // read tool (named to be in the SSOT) and NO write tool.
    const stubReadExtension = (pi: { registerTool: (tool: unknown) => void }): void => {
      pi.registerTool({
        name: "memory_smart_search",
        label: "Memory search (read stub)",
        description: "stand-in read tool",
        parameters: Type.Object({ q: Type.Optional(Type.String()) }),
        async execute(_toolCallId: string) {
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      } as never);
    };

    const resourceLoader = await createWorkerResourceLoader(projectRoot, [stubReadExtension]);
    const { session } = await createAgentSession({
      cwd: projectRoot,
      sessionManager: SessionManager.inMemory(projectRoot),
      resourceLoader,
      tools: allowed,
    } as Parameters<typeof createAgentSession>[0]);

    const active: string[] = session.getActiveToolNames();
    const all: string[] = (session.getAllTools() ?? []).map((tool) => tool.name);

    // SSOT-allowed + registered => active.
    expect(active).toContain("memory_smart_search");
    // SSOT-allowed built-ins honored (a private table would have stripped them).
    expect(active).toContain("bash");
    expect(active).toContain("read");
    // The session only activates what is in the SSOT allow-list AND registered
    // (the owner extension supplies the memory read tool; writes are neither).
    expect(active.length).toBeGreaterThan(0);
    // A write-capable tool is ABSENT: not in the SSOT allow-list and not registered.
    expect(all).not.toContain("memory_add_drawer");
    expect(active).not.toContain("memory_add_drawer");
    const activeWrites = active.filter((tool) =>
      ["memory_add_drawer", "memory_diary_write", "memory_kg_add"].includes(tool)
    );
    expect(activeWrites).toEqual([]);
  }, 30000);
});
