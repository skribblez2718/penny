/**
 * The REAL `.pi/SYSTEM.md` must keep its artifact/memory boundary after the
 * agent transform strips "# On-Demand Protocols".
 *
 * The fixture-based test proves the transform's behavior; this one proves the
 * shipped file is actually arranged to survive it. Without this, the guidance
 * can silently drift back below the strip boundary and every worker loses it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const systemMd = readFileSync(join(projectRoot, ".pi", "SYSTEM.md"), "utf8");

/** Mirrors buildAgentBaseSystemPrompt's strip exactly. */
function agentView(source: string): string {
  return source.replace(/\n#\s*On-Demand Protocols[\s\S]*?(?=\n<\/system_context>|$)/, "");
}

describe("SYSTEM.md artifact guidance reaches workers", () => {
  it("keeps an artifact_read instruction after the On-Demand Protocols strip", () => {
    const worker = agentView(systemMd);
    expect(worker).not.toContain("On-Demand Protocols");
    expect(worker).toContain("artifact_read");
  });

  it("states the memory-is-not-a-workflow-channel boundary to workers", () => {
    const worker = agentView(systemMd).toLowerCase();
    expect(worker).toContain("not a workflow channel");
  });

  it("still closes the system_context tag", () => {
    expect(agentView(systemMd).trimEnd().endsWith("</system_context>")).toBe(true);
  });

  it("keeps worker input discipline but strips orchestrator-only forwarding guidance", () => {
    expect(agentView(systemMd)).toContain("input_artifacts");
    expect(agentView(systemMd)).toContain("missing_input:");
    expect(agentView(systemMd)).not.toContain("Delegation results");
  });
});
