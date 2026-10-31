import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enforceNativeAutoCompaction } from "../../../../lib/compaction-policy.mjs";
import { SCA_SERVICE_SOCKET_ENV, SCA_SERVICE_TOKEN_ENV } from "../../src/config.js";
import { SCA_MODEL_TOOL_ROSTER } from "../../src/contracts.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SCA_EXTENSION = fileURLToPath(new URL("../../index.ts", import.meta.url));
const SUBAGENT_EXTENSION = path.join(PROJECT_ROOT, ".pi/extensions/subagent/index.ts");
const SKILL_EXTENSION = path.join(PROJECT_ROOT, ".pi/extensions/skill/index.ts");
const roots = new Set<string>();
const pendingWork = new Set<Promise<void>>();

afterEach(async () => {
  // A Vitest timeout does not cancel an SDK import/session promise. Settle it
  // before removing its temporary tree or restoring its environment.
  await Promise.allSettled([...pendingWork]);
  vi.unstubAllEnvs();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("SCA provider-first direct-agent compatibility", () => {
  // Finite harness budget for cold SDK/extension imports; not a production deadline.
  it("loads a model-free direct session with ordinary tools while the service is unavailable and SCA remains discoverable", async () => {
    const work = (async () => {
      vi.stubEnv(SCA_SERVICE_SOCKET_ENV, undefined);
      vi.stubEnv(SCA_SERVICE_TOKEN_ENV, undefined);
      // Bind the test's public packages explicitly; no operator .env or global catalog is needed.
      vi.stubEnv("PROJECT_ROOT", PROJECT_ROOT);
      vi.stubEnv("PENNY_SKILLS_DIR", path.join(PROJECT_ROOT, ".pi/skills"));
      const root = await mkdtemp(path.join(tmpdir(), "penny-sca-loader-"));
      roots.add(root);
      const agentDir = path.join(root, "agent");
      await mkdir(agentDir, { recursive: true });

      const settingsManager = enforceNativeAutoCompaction(
        SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: false },
        })
      );
      const loader = new DefaultResourceLoader({
        cwd: PROJECT_ROOT,
        agentDir,
        settingsManager,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [SCA_EXTENSION, SUBAGENT_EXTENSION, SKILL_EXTENSION],
      });
      await loader.reload();

      const extensions = loader.getExtensions();
      expect(extensions.errors).toEqual([]);
      const registeredNames = extensions.extensions.flatMap((extension) => [
        ...extension.tools.keys(),
      ]);
      expect(registeredNames).toEqual(
        expect.arrayContaining(["subagent", "skill", ...SCA_MODEL_TOOL_ROSTER])
      );

      const skills = loader.getSkills();
      expect(skills.skills.some((skill) => skill.name === "sca")).toBe(true);
      expect(skills.skills.some((skill) => skill.name === "assess")).toBe(true);

      const { session } = await createAgentSession({
        cwd: PROJECT_ROOT,
        agentDir,
        resourceLoader: loader,
        settingsManager,
        tools: ["read", "subagent", "skill", ...SCA_MODEL_TOOL_ROSTER],
      });
      try {
        expect(session.autoCompactionEnabled).toBe(true);
        expect(session.settingsManager).toBe(settingsManager);
        expect(session.model).toMatchObject({ id: "unknown", provider: "unknown" });
        expect(session.getActiveToolNames()).toEqual(
          expect.arrayContaining(["read", "subagent", "skill", ...SCA_MODEL_TOOL_ROSTER])
        );
      } finally {
        await session.dispose();
      }
    })();
    pendingWork.add(work);
    try {
      await work;
    } finally {
      pendingWork.delete(work);
    }
  }, 30_000);
});
