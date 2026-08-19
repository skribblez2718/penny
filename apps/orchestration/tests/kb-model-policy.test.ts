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

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KbModelClient, ssotModel } from "../src/kb/kb-model-client.js";
import { type AgentRunner, type IngestSource } from "../src/kb/ingest.js";

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const agentFile = (name: string): string =>
  readFileSync(path.join(projectRoot, ".pi", "agents", `${name}.md`), "utf8");

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
    mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "agents", "modelless.md"),
      "---\nname: modelless\ntools: read\n---\n\nA body.\n",
      { mode: 0o600 }
    );
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
    mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "agents", "modelless.md"),
      "---\nname: modelless\ntools: read\n---\n\nA body.\n",
      { mode: 0o600 }
    );
    const client = new KbModelClient({
      projectRoot: root,
      modelOverride: "definitely/not-a-real-model",
    });
    // The override is honored (parsing passes) and fails at resolution time,
    // which proves the override path is taken rather than the SSOT refusal.
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
    ).rejects.toThrow(/definitely\/not-a-real-model/);
  });
});
