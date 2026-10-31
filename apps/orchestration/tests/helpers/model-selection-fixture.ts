/** Isolated SDK configuration: no private models, credentials, sessions, or provider calls. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE_HEAVY_MODEL_ID = "zz-fixture-heavy";
export const FIXTURE_MID_MODEL_ID = "zz-fixture-mid";
export const FIXTURE_OVERRIDE_MODEL_ID = "zz-fixture-override";

export function writeModelSelectionFixture(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const model = (id: string, name: string) => ({
    id,
    name,
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const provider = (models: ReturnType<typeof model>[]) => ({
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKey: "provider-free-fixture-not-a-secret",
    models,
  });
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "openai-codex": provider([
          model(FIXTURE_HEAVY_MODEL_ID, "sol"),
          model(FIXTURE_MID_MODEL_ID, "terra"),
        ]),
        "fixture-other": provider([
          model(FIXTURE_OVERRIDE_MODEL_ID, "approved"),
          model("zz-collision", "sol"),
        ]),
      },
    })
  );
  writeFileSync(path.join(agentDir, "auth.json"), "{}");
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture-other",
      defaultModel: FIXTURE_OVERRIDE_MODEL_ID,
      cacheWarming: "off",
    })
  );
}
