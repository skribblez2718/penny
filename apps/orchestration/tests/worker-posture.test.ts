import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseSsotTools, resolveDomainGuidancePath } from "../src/model-client.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";

const PROJECT_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/u, ""))
    .sort();
}

function independentlyDeclaredTools(agent: string): string[] {
  const doc = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
  const line = doc
    .slice(0, doc.indexOf("\n---", 4))
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) throw new Error(`agent '${agent}' declares no tools:`);
  return line
    .slice("tools:".length)
    .split(",")
    .map((name) => name.trim());
}

describe("exact YAML tool authority", () => {
  it("returns exact set equality for every agent under every trust profile", () => {
    for (const profile of ["trusted-interactive", "hardened-untrusted"] as const) {
      for (const agent of agentNames()) {
        const doc = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
        expect(parseSsotTools(doc, agent), `${agent}/${profile}`).toEqual(
          independentlyDeclaredTools(agent)
        );
      }
    }
  });

  it("does not inject orchestration result tools or strip hardened tools", () => {
    for (const agent of agentNames()) {
      const tools = independentlyDeclaredTools(agent);
      expect(tools).not.toContain("submit_orchestration_result");
      expect(
        parseSsotTools(readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8"), agent)
      ).toEqual(tools);
    }
    const source = readFileSync(new URL("../src/model-client.ts", import.meta.url), "utf8");
    expect(source).not.toContain("HARDENED_STRIP");
    expect(source).not.toContain("WORKER_EXTENSION_NAMES");
    expect(source).not.toContain('name: "submit_orchestration_result"');
  });

  it("keeps KB replacement matrices anonymous instead of claiming catalog roles", () => {
    const modelClient = readFileSync(new URL("../src/model-client.ts", import.meta.url), "utf8");
    const kbClient = readFileSync(new URL("../src/kb/kb-model-client.ts", import.meta.url), "utf8");
    const sessionTools = readFileSync(
      new URL("../src/kb/session-tools.ts", import.meta.url),
      "utf8"
    );
    expect(modelClient).toContain("cannot run with an isolated replacement tool matrix");
    expect(kbClient).toContain("kb-private-${invocation.stateId}");
    expect(sessionTools).toContain("This is not a catalog-agent invocation");
    expect(sessionTools).not.toContain('"ROLE DEFINITION:"');
  });

  it("fails missing, empty, and duplicate YAML tool declarations", () => {
    expect(() => parseSsotTools("---\nname: x\n---\n", "x")).toThrow(/no top-level 'tools:'/);
    expect(() => parseSsotTools("---\nname: x\ntools:\n---\n", "x")).toThrow(/empty/);
    expect(() => parseSsotTools("---\nname: x\ntools: read, read\n---\n", "x")).toThrow(
      /duplicate tool 'read'/
    );
  });
});

describe("guidance resolution", () => {
  it("resolves phase-specific guidance from the skill contract", () => {
    expect(
      resolveDomainGuidancePath({
        projectRoot: "/proj",
        agent: "echo",
        stateId: "researching",
        guidance: RESEARCH_SKILL_CONTRACT.guidance,
      })
    ).toBe("/proj/.pi/skills/research/assets/prompts/echo-researching.md");
  });
});
