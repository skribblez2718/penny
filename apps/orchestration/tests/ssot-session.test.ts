import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerResourceLoader, parseSsotTools } from "../dist/model-client.js";
import { unavailableMemoryReplacement } from "./helpers/unavailable-memory-replacement.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/u, ""))
    .sort();
}

afterEach(() => vi.unstubAllEnvs());

describe("real SDK worker tool surfaces", () => {
  it("uses this checkout's skills independent of the test cwd and inherited roots", () => {
    expect(process.env.PENNY_SKILLS_DIR).toBe(path.join(PROJECT_ROOT, ".pi", "skills"));
  });

  it("still refuses registration when a test explicitly selects missing skill packages", async () => {
    const emptySkillsDir = mkdtempSync(path.join(os.tmpdir(), "pi-compat-missing-skills-"));
    vi.stubEnv("PENNY_SKILLS_DIR", emptySkillsDir);
    const errorDigest = createHash("sha256")
      .update(
        "Failed to load extension: registry/package mismatch for 'assess': skill package or SKILL.md is unavailable"
      )
      .digest("hex");
    try {
      await expect(createWorkerResourceLoader(PROJECT_ROOT)).rejects.toThrow(errorDigest);
    } finally {
      rmSync(emptySkillsDir, { recursive: true, force: true });
    }
  });

  it("refuses duplicate memory providers when exact source replacement is omitted or unrelated", async () => {
    // An unconfigured primary may correctly register no memory tools. Worker-read
    // registers an unavailable read surface even without a valid isolated config,
    // so this conflict oracle does not depend on an operator's optional service.
    vi.stubEnv("PENNY_RUNTIME_ROLE", "worker-read");
    vi.stubEnv("PENNY_MEMORY_TRUST_MODE", "none");
    const replacement = unavailableMemoryReplacement(PROJECT_ROOT, ["memory_smart_search"]);
    await expect(createWorkerResourceLoader(PROJECT_ROOT, [replacement.extension])).rejects.toThrow(
      /EXTENSION_CONFLICT/u
    );
    await expect(
      createWorkerResourceLoader(
        PROJECT_ROOT,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ ...replacement, source: path.join(PROJECT_ROOT, ".pi/extensions/artifacts/index.ts") }]
      )
    ).rejects.toThrow(/EXTENSION_CONFLICT/u);
  });

  it("activates exactly YAML tools for every catalog agent with optional services unconfigured", async () => {
    const declaredByAgent = new Map(
      agentNames().map((agent) => {
        const doc = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
        return [agent, parseSsotTools(doc, agent)] as const;
      })
    );
    const memoryNames = [
      ...new Set([...declaredByAgent.values()].flat().filter((name) => name.startsWith("memory_"))),
    ];
    const resourceLoader = await createWorkerResourceLoader(
      PROJECT_ROOT,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)]
    );

    for (const [agent, declared] of declaredByAgent) {
      const { session } = await createAgentSession({
        cwd: PROJECT_ROOT,
        sessionManager: SessionManager.inMemory(PROJECT_ROOT),
        resourceLoader,
        tools: [...declared],
      });
      try {
        expect([...session.getActiveToolNames()].sort(), agent).toEqual([...declared].sort());
      } finally {
        session.dispose();
      }
    }
  }, 60000);
});
