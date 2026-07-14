/**
 * Base System Prompt Tests
 *
 * Verifies buildAgentBaseSystemPrompt(): agents receive the project SYSTEM.md
 * as their base prompt (resolved from env, independent of the agent cwd) with
 * two invoke-time transforms — "Penny" -> the agent's display name, and removal
 * of the Penny-only "# On-Demand Protocols" section — plus ${VAR} substitution.
 *
 * This is the fix for the Anthropic OAuth 400 "extra usage" rejection: pi's
 * DEFAULT prompt (used whenever an agent's cwd was not a trusted project) is
 * classified as a third-party app and refused plan billing in tool loops;
 * SYSTEM.md is not.
 *
 * fs is mocked per-path so the SYSTEM.md fixture is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// agent-runner.ts imports this package at module load; stub so it loads.
vi.mock("@mariozechner/pi-coding-agent", () => ({
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
  "# On-Demand Protocols",
  "",
  "- **After substantive work** — link output with `memory_kg_add`.",
  "- Run the compaction resume protocol.",
  "</system_context>",
].join("\n");

let existsShouldSucceed = true;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => existsShouldSucceed && String(p).endsWith("SYSTEM.md")),
    readFileSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith("SYSTEM.md")) return SYSTEM_MD_FIXTURE;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }),
  };
});

import { buildAgentBaseSystemPrompt } from "../../agent-runner.js";

describe("buildAgentBaseSystemPrompt", () => {
  beforeEach(() => {
    existsShouldSucceed = true;
    process.env.PI_DIRECTORY = "/fake/project/.pi";
    process.env.PROJECT_ROOT = "/fake/project";
  });

  it("replaces the persona name 'Penny' with the capitalized agent name", () => {
    const prompt = buildAgentBaseSystemPrompt("echo", "/any/cwd");
    expect(prompt).not.toBeNull();
    expect(/\bPenny\b/.test(prompt!)).toBe(false);
    expect(prompt).toContain("You are **Echo**");
    expect(prompt).toContain("Echo must get better");
  });

  it("capitalizes multi-letter agent names correctly", () => {
    const prompt = buildAgentBaseSystemPrompt("annie", "/any/cwd");
    expect(prompt).toContain("**Annie**");
    expect(prompt).not.toContain("Penny");
  });

  it("strips the '# On-Demand Protocols' section but keeps </system_context>", () => {
    const prompt = buildAgentBaseSystemPrompt("vera", "/any/cwd")!;
    expect(prompt).not.toContain("On-Demand Protocols");
    expect(prompt).not.toContain("memory_kg_add");
    expect(prompt).not.toContain("compaction resume protocol");
    // Earlier sections are preserved.
    expect(prompt).toContain("# Deliver");
    expect(prompt).toContain("Lead with the answer.");
    // Closing tag preserved so the block stays balanced.
    expect(prompt.trimEnd().endsWith("</system_context>")).toBe(true);
  });

  it("substitutes ${VAR} placeholders from process.env", () => {
    const prompt = buildAgentBaseSystemPrompt("piper", "/any/cwd")!;
    expect(prompt).toContain("Project root is /fake/project.");
    expect(prompt).not.toContain("${PROJECT_ROOT}");
  });

  it("returns null when SYSTEM.md cannot be found (falls back to pi default)", () => {
    existsShouldSucceed = false;
    delete process.env.PI_DIRECTORY;
    delete process.env.PROJECT_ROOT;
    const prompt = buildAgentBaseSystemPrompt("echo", "/no/such/cwd");
    expect(prompt).toBeNull();
  });
});
