/**
 * KB model policy tests (deterministic).
 *
 * Production policy: each agent runs on the model declared in its SSOT
 * frontmatter (.pi/agents/<agent>.md `model:`). An explicit override exists
 * for tests only. These tests pin the SSOT parsing and the refusal behavior;
 * catalog resolution (alias → provider/model) was verified live in this
 * environment (`sol` → openai-codex/gpt-5.6-sol, `terra` →
 * openai-codex/gpt-5.6-terra).
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KbModelClient, ssotModel } from "../src/kb/kb-model-client.js";
import { resolveDomainGuidancePath } from "../src/model-client.js";
import { KNOWLEDGE_BASE_SKILL_CONTRACT } from "../src/playbooks/knowledge-base.js";
import { type IngestSource } from "../src/kb/ingest.js";

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const agentFile = (name: string): string =>
  readFileSync(path.join(projectRoot, ".pi", "agents", `${name}.md`), "utf8");

/** Seed a tmp project with one agent SSOT and (optionally) its phase guidance. */
function seedAgent(root: string, name: string, frontmatter: string, withGuidance = true): void {
  mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "SYSTEM.md"), "# Test Cognitive Frame\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), frontmatter, { mode: 0o600 });
  if (withGuidance) {
    const prompts = path.join(root, ".pi", "skills", "knowledge-base", "assets", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(path.join(prompts, `${name}-phase_test.md`), "# guidance\n\nDo the phase.\n", {
      mode: 0o600,
    });
  }
}

const dirs: string[] = [];
function tmpProject(label = "penny-kb-model"): string {
  const d = mkdtempSync(path.join(tmpdir(), label + "-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SSOT model parsing", () => {
  it("reads each KB agent's declared production model", () => {
    expect(ssotModel(agentFile("echo"))).toBe("sol");
    expect(ssotModel(agentFile("synthia"))).toBe("terra");
    expect(ssotModel(agentFile("carren"))).toBe("sol");
    expect(ssotModel(agentFile("vera"))).toBe("terra");
  });

  it("returns undefined when the SSOT declares no model", () => {
    expect(ssotModel("---\nname: fake\ntools: read\n---\n\nBody only.")).toBeUndefined();
    expect(ssotModel("no frontmatter at all")).toBeUndefined();
  });
});

describe("KbModelClient model policy", () => {
  it("refuses to run a phase whose agent declares no model (no guessing)", async () => {
    const root = tmpProject();
    seedAgent(root, "modelless", "---\nname: modelless\ntools: read\n---\n\nA body.\n");
    const client = new KbModelClient({ projectRoot: root });
    const sources: IngestSource[] = [];
    await expect(
      client.run({
        agent: "modelless",
        stateId: "phase_test",
        phaseBrief: "brief",
        sourceAllowlist: [],
        priorPhaseAllowlist: [],
        readSource: () => {
          throw new Error("no sources");
        },
        readPhaseOutput: () => {
          throw new Error("no priors");
        },
      })
    ).rejects.toThrow(/no 'model:'/);
    void sources;
  });

  it("accepts an explicit test-only override even when the SSOT has none", async () => {
    const root = tmpProject();
    seedAgent(root, "modelless", "---\nname: modelless\ntools: read\n---\n\nA body.\n");
    const prompts = path.join(root, ".pi", "skills", "knowledge-base", "assets", "prompts");
    writeFileSync(path.join(prompts, "modelless-ingest.md"), "# guidance\n", { mode: 0o600 });
    const client = new KbModelClient({
      projectRoot: root,
      modelOverride: "definitely/not-a-real-model",
    });
    // The complete private-session boundary is present, so failure reaches the
    // explicit model override rather than falling through to any default model.
    await expect(
      client.run({
        agent: "modelless",
        stateId: "ingest",
        runId: "run_model_override",
        profileId: "kbp_model_override",
        expectedArtifactKind: "claims",
        phaseBrief: "brief",
        sourceAllowlist: [],
        priorPhaseAllowlist: [],
        allowedPriorArtifacts: [],
        readSource: () => {
          throw new Error("no sources");
        },
        readRunArtifact: () => {
          throw new Error("no priors");
        },
        stageArtifact: () => {
          throw new Error("model resolution must happen first");
        },
        submitPhaseResult: () => {
          throw new Error("model resolution must happen first");
        },
      })
    ).rejects.toThrow(/definitely\/not-a-real-model/);
  });
});

describe("KB guidance policy (W6 seam)", () => {
  it("refuses a phase whose declared guidance file is absent", async () => {
    const root = tmpProject();
    // Agent SSOT present and complete; only the contract-declared prompt is missing.
    seedAgent(
      root,
      "guideless",
      "---\nname: guideless\nmodel: sol\ntools: read\n---\n\nBody.\n",
      false
    );
    const client = new KbModelClient({ projectRoot: root });
    await expect(
      client.run({
        agent: "guideless",
        stateId: "phase_test",
        phaseBrief: "brief",
        sourceAllowlist: [],
        priorPhaseAllowlist: [],
        readSource: () => {
          throw new Error("no sources");
        },
        readPhaseOutput: () => {
          throw new Error("no priors");
        },
      })
    ).rejects.toThrow(/refusing to run a KB phase without its declared prompt/);
  });

  it("resolves each shipped ingest phase to its contract-declared prompt file", () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    for (const [agent, phase] of [
      ["echo", "ingest"],
      ["synthia", "compose"],
      ["carren", "lint"],
      ["vera", "verify"],
    ] as const) {
      const resolved = resolveDomainGuidancePath({
        projectRoot: root,
        agent,
        stateId: phase,
        ...(KNOWLEDGE_BASE_SKILL_CONTRACT.guidance
          ? { guidance: KNOWLEDGE_BASE_SKILL_CONTRACT.guidance }
          : {}),
      });
      expect(resolved.endsWith(`/${agent}-${phase}.md`)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    }
  });
});
