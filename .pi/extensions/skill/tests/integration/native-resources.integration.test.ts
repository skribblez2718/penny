import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../../../..");
const sandboxes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installed Pi default extension resource lifecycle", () => {
  it("loads visible and hidden packages by default once across repeated binding and reload, but advertises only visible packages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-native-resources-"));
    sandboxes.push(root);
    const skillsDir = path.join(root, ".pi", "skills");
    cpSync(path.join(repository, ".pi", "skills"), skillsDir, { recursive: true });
    const extensionDir = path.join(root, ".pi", "extensions");
    mkdirSync(extensionDir, { recursive: true });
    // Default directory discovery, not --extension/--skill or a replacement factory.
    symlinkSync(
      path.join(repository, ".pi", "extensions", "skill"),
      path.join(extensionDir, "skill"),
      "dir"
    );
    for (const name of ["artifacts", "lib", "subagent"]) {
      symlinkSync(
        path.join(repository, ".pi", "extensions", name),
        path.join(extensionDir, name),
        "dir"
      );
    }
    symlinkSync(path.join(repository, ".pi", "lib"), path.join(root, ".pi", "lib"), "dir");
    symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
    vi.stubEnv("PROJECT_ROOT", root);
    vi.stubEnv("PENNY_SKILLS_DIR", skillsDir);
    vi.stubEnv("PI_OBSERVABILITY_ENABLED", "false");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const prompts: string[] = [];
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            if ("prompt" in event) prompts.push(event.prompt);
          });
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const skillTool = loader.getExtensions().extensions.flatMap((extension) => {
      const tool = extension.tools.get("skill");
      return tool === undefined ? [] : [tool.definition];
    });
    expect(skillTool).toHaveLength(1);
    expect(skillTool[0]?.description).toContain(
      "explicitly user-invoked model-hidden /skill:<name> contract"
    );
    expect(skillTool[0]?.description).toContain(
      "does not grant registration, private activation, approval or execution authority"
    );
    const initialSkills = loader.getSkills().skills;
    const visibleBefore = initialSkills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => skill.name)
      .sort();
    const hiddenBefore = initialSkills
      .filter((skill) => skill.disableModelInvocation)
      .map((skill) => skill.filePath)
      .sort();
    expect(visibleBefore).toContain("research");
    expect(visibleBefore).not.toContain("videogen");
    expect(hiddenBefore).toContain(path.join(skillsDir, "videogen", "SKILL.md"));
    expect(hiddenBefore).toContain(path.join(skillsDir, "imagegen", "SKILL.md"));
    const faux = fauxProvider({
      tokensPerSecond: 0,
      models: [{ id: "native-resources", contextWindow: 131072, maxTokens: 8192 }],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      tools: ["skill", "read"],
    });
    try {
      for (const action of ["startup", "duplicate", "reload"] as const) {
        if (action === "reload") await session.reload();
        else await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
        const loaded = loader.getSkills().skills;
        expect(
          loaded
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => skill.name)
            .sort()
        ).toEqual(visibleBefore);
        expect(
          loaded
            .filter((skill) => skill.disableModelInvocation)
            .map((skill) => skill.filePath)
            .sort()
        ).toEqual(hiddenBefore);
        expect(new Set(loaded.map((skill) => skill.name)).size).toBe(loaded.length);
        expect(loaded.find((skill) => skill.name === "videogen")).toMatchObject({
          disableModelInvocation: true,
        });
        const advertising = formatSkillsForPrompt(loaded);
        for (const skill of loaded) {
          if (skill.disableModelInvocation) {
            expect(advertising).not.toContain(`<name>${skill.name}</name>`);
            expect(session.systemPrompt).not.toContain(`<name>${skill.name}</name>`);
          } else {
            expect(advertising).toContain(`<name>${skill.name}</name>`);
            expect(session.systemPrompt).toContain(`<name>${skill.name}</name>`);
          }
        }
        expect(
          loader.getSkills().diagnostics.filter((diagnostic) => diagnostic.type === "collision")
        ).toEqual([]);
      }
      faux.setResponses([fauxAssistantMessage("Visible command fixture only.")]);
      await session.prompt("/skill:research supplied visible description");
      expect(prompts.at(-1)).toContain('<skill name="research"');
      expect(prompts.at(-1)).toMatch(/<\/skill>\n\nsupplied visible description$/u);
      faux.setResponses([fauxAssistantMessage("Hidden command fixture only; no dispatch.")]);
      await session.prompt("/skill:videogen supplied hidden description");
      expect(prompts.at(-1)).toContain('<skill name="videogen"');
      expect(prompts.at(-1)).toMatch(/<\/skill>\n\nsupplied hidden description$/u);
      expect(errors).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });
});
