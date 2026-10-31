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

import { transformCatalogFrame } from "@penny/orchestration";
import { describe, expect, it } from "vitest";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const systemMd = readFileSync(join(projectRoot, ".pi", "SYSTEM.md"), "utf8");

/** Use the same production transform as buildAgentBaseSystemPrompt. */
function agentView(source: string): string {
  return transformCatalogFrame(source, "echo", {});
}

describe("SYSTEM.md artifact guidance reaches workers", () => {
  it("keeps an artifact_read instruction after the On-Demand Protocols strip", () => {
    const worker = agentView(systemMd);
    expect(worker).not.toContain("On-Demand Protocols");
    expect(worker).toContain("artifact_read");
  });

  it("keeps curated memory separate from workflow state and exact work products", () => {
    const worker = agentView(systemMd);
    expect(worker).toContain("curated knowledge, not workflow state");
    expect(worker).toContain(
      "Move exact work products by immutable artifact ID or caller-specified path."
    );
  });

  it("still closes the system_context tag", () => {
    expect(agentView(systemMd).trimEnd().endsWith("</system_context>")).toBe(true);
  });

  it("keeps worker input discipline but strips orchestrator-only forwarding guidance", () => {
    expect(agentView(systemMd)).toContain("input_artifacts");
    expect(agentView(systemMd)).toContain("missing_input:");
    expect(agentView(systemMd)).not.toContain("run the artifact access protocol");
  });
});
