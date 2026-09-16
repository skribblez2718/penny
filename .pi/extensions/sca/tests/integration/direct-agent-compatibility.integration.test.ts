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

import { SCA_SERVICE_SOCKET_ENV, SCA_SERVICE_TOKEN_ENV } from "../../src/config.js";
import { SCA_MODEL_TOOL_ROSTER } from "../../src/contracts.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SCA_EXTENSION = fileURLToPath(new URL("../../index.ts", import.meta.url));
const SUBAGENT_EXTENSION = path.join(PROJECT_ROOT, ".pi/extensions/subagent/index.ts");
const SKILL_EXTENSION = path.join(PROJECT_ROOT, ".pi/extensions/skill/index.ts");
const roots = new Set<string>();

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("SCA provider-first direct-agent compatibility", () => {
  it("loads a model-free direct session with ordinary tools while the service and SCA skill are absent", async () => {
    vi.stubEnv(SCA_SERVICE_SOCKET_ENV, undefined);
    vi.stubEnv(SCA_SERVICE_TOKEN_ENV, undefined);
    const root = await mkdtemp(path.join(tmpdir(), "penny-sca-loader-"));
    roots.add(root);
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir, { recursive: true });

    const loader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir,
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
    expect(skills.skills.some((skill) => skill.name === "sca")).toBe(false);
    expect(skills.skills.some((skill) => skill.name === "assess")).toBe(true);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await createAgentSession({
      cwd: PROJECT_ROOT,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      tools: ["read", "subagent", "skill", ...SCA_MODEL_TOOL_ROSTER],
    });
    try {
      expect(session.model).toMatchObject({ id: "unknown", provider: "unknown" });
      expect(session.getActiveToolNames()).toEqual(
        expect.arrayContaining(["read", "subagent", "skill", ...SCA_MODEL_TOOL_ROSTER])
      );
    } finally {
      await session.dispose();
    }
  });
});
