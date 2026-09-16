import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// agent-runner.ts imports this package at module load; stub so it loads.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

const SYSTEM_MD_FIXTURE = [
  "<system_context>",
  "",
  "# Who You Are",
  "",
  "You are **Penny**, a personal AI assistant. Penny must get better.",
  "Project root is ${PROJECT_ROOT}.",
  "",
  "# Deliver",
  "",
  "Lead with the answer.",
  "",
  "# Memory and Improvement",
  "",
  "- Memory is not a workflow channel. Read supplied exact IDs with `artifact_read`.",
  "",
  "# On-Demand Protocols",
  "",
  "- **After substantive work** — link output with `memory_kg_add`.",
  "- Run the compaction resume protocol.",
  "</system_context>",
].join("\n");

let projectRoot: string;

import { buildAgentBaseSystemPrompt } from "../../agent-runner.js";

function requireAgentBaseSystemPrompt(agentName: string): string {
  const prompt = buildAgentBaseSystemPrompt(agentName, projectRoot);
  if (prompt === null) {
    throw new Error(`expected a base system prompt for ${agentName}`);
  }
  return prompt;
}

describe("buildAgentBaseSystemPrompt", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "penny-base-prompt-"));
    mkdirSync(path.join(projectRoot, ".pi"));
    writeFileSync(path.join(projectRoot, ".pi", "SYSTEM.md"), SYSTEM_MD_FIXTURE);
    vi.stubEnv("PI_DIRECTORY", "/ignored/ambient/.pi");
    vi.stubEnv("PROJECT_ROOT", "/ignored/ambient");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("replaces only the persona declaration with the capitalized agent name", () => {
    const prompt = requireAgentBaseSystemPrompt("echo");
    expect(prompt).toContain("You are **Echo**");
    expect(prompt).toContain("Penny must get better");
  });

  it("capitalizes multi-letter agent names correctly", () => {
    const prompt = requireAgentBaseSystemPrompt("annie");
    expect(prompt).toContain("**Annie**");
    expect(prompt).toContain("Penny must get better");
  });

  it("strips the '# On-Demand Protocols' section but keeps </system_context>", () => {
    const prompt = requireAgentBaseSystemPrompt("vera");
    expect(prompt).not.toContain("On-Demand Protocols");
    expect(prompt).not.toContain("memory_kg_add");
    expect(prompt).not.toContain("compaction resume protocol");
    // Earlier sections are preserved.
    expect(prompt).toContain("# Deliver");
    expect(prompt).toContain("Lead with the answer.");
    // The artifact/memory boundary sits ABOVE the stripped section on purpose:
    // workers must keep it, or they fall back to memory for predecessor output.
    expect(prompt).toContain("artifact_read");
    expect(prompt).toContain("Memory is not a workflow channel");
    // Closing tag preserved so the block stays balanced.
    expect(prompt.trimEnd().endsWith("</system_context>")).toBe(true);
  });

  it("substitutes ${VAR} placeholders from process.env", () => {
    const prompt = requireAgentBaseSystemPrompt("piper");
    expect(prompt).toContain(`Project root is ${projectRoot}.`);
    expect(prompt).not.toContain("${PROJECT_ROOT}");
  });

  it("fails closed when the canonical frame is absent instead of using an ambient default", () => {
    rmSync(path.join(projectRoot, ".pi", "SYSTEM.md"));
    expect(() => buildAgentBaseSystemPrompt("echo", projectRoot)).toThrow();
  });
});
