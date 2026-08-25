import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { registerTool } from "../../../.pi/lib/pi-tool-registration.js";
import { createWorkerResourceLoader, parseSsotTools } from "../src/model-client.js";

const PROJECT_ROOT = path.resolve("..", "..");
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/u, ""))
    .sort();
}

describe("real SDK worker tool surfaces", () => {
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
    const unavailableMemory = (pi: ExtensionAPI): void => {
      for (const name of memoryNames) {
        registerTool(pi, {
          name,
          label: name,
          description: "Typed unavailable optional-service test provider",
          parameters: Type.Object({}, { additionalProperties: true }),
          async execute() {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ok: false,
                    error: { code: "MEMPALACE_UNAVAILABLE", retryable: true },
                  }),
                },
              ],
              details: {},
            };
          },
        });
      }
    };
    const resourceLoader = await createWorkerResourceLoader(PROJECT_ROOT, [unavailableMemory]);

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
