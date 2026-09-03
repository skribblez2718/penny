import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ArtifactStore,
  canonicalJson,
  initializePennyState,
  resolvePennyRuntimeState,
  sha256,
} from "@penny/orchestration/source";
import { describe, expect, it } from "vitest";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
} from "../../evaluation-contracts.js";
import {
  preflightLocalLiveArtifactRead,
  preflightLocalLiveModel,
  type LocalLiveModelPreflightDependenciesV1,
} from "../../evaluation-local-live.js";
import {
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  freezePairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
} from "../../evaluation-runner.js";
import {
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "../../../artifacts/artifact-runtime.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);

function localPlan(): unknown {
  return JSON.parse(
    readFileSync(
      path.join(PROJECT_ROOT, "evals", "fixtures", "synthetic-known-delta.plan.v1.json"),
      "utf8"
    )
  );
}

function frozenLocalPlan() {
  const value = localPlan();
  const base = validatePairedEvaluationPlan(value);
  return validatePairedEvaluationPlan({
    ...base,
    runtime_binding: {
      ...base.runtime_binding,
      provider: "ollama",
      model: "qwen3.8:latest",
      thinking_level: "low",
    },
  });
}

async function listenLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("loopback integration server has no TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

describe("local-live isolated artifact_read integration", () => {
  it("reads the exact sentinel from the isolated root and rejects a decoy root before trials", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-local-live-artifact-read-"));
    try {
      const isolatedRoot = path.join(temporary, "isolated");
      const decoyRoot = path.join(temporary, "decoy");
      const env: NodeJS.ProcessEnv = { PENNY_STATE_ROOT: isolatedRoot };
      initializePennyState(PROJECT_ROOT, { env });
      initializePennyState(PROJECT_ROOT, {
        env: { PENNY_STATE_ROOT: decoyRoot },
      });
      const population = validateEvaluationPopulation(
        JSON.parse(
          readFileSync(
            path.join(
              PROJECT_ROOT,
              "evals",
              "fixtures",
              "synthetic-known-delta.population.v1.json"
            ),
            "utf8"
          )
        )
      );
      const plan = validatePairedEvaluationPlan(localPlan());
      const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
      const frozen = freezePairedEvaluation({
        population,
        plan,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        implementationBinding: syntheticEvaluationImplementationBinding({
          projectRoot: PROJECT_ROOT,
          population,
          plan,
          runtimeFunctions,
        }),
        runtimeFunctions,
      });
      const processEnv: NodeJS.ProcessEnv = {};
      await preflightLocalLiveArtifactRead({
        projectRoot: PROJECT_ROOT,
        env,
        processEnv,
        frozen,
      });
      expect(processEnv.PENNY_STATE_ROOT).toBe(isolatedRoot);

      const identitySha256 = sha256(
        canonicalJson({ plan_id: frozen.plan_id, schedule_sha256: frozen.schedule_sha256 })
      );
      const sentinelBytes = canonicalJson({
        schema_version: 1,
        plan_id: frozen.plan_id,
        schedule_sha256: frozen.schedule_sha256,
      });
      const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
      using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
        projectId: state.projectId,
      });
      const sentinelRef = artifacts.refFor(
        `evaluation-preflight-${identitySha256.slice(0, 32)}`,
        "evaluation",
        null,
        "evaluation-preflight",
        `artifact-read-preflight:${identitySha256}`,
        1
      );
      if (sentinelRef === null) throw new Error("isolated preflight sentinel is absent");
      expect(artifacts.read(sentinelRef).toString("utf8")).toBe(sentinelBytes);

      const execution = await executeArtifactRead(
        loadArtifactRuntimeConfig(PROJECT_ROOT, processEnv),
        { artifact: sentinelRef.artifact_id }
      );
      expect(execution.code).toBe("OK");
      const text = execution.result.content[0]?.text;
      if (text === undefined) throw new Error("artifact_read integration payload is absent");
      const payload: unknown = JSON.parse(text);
      expect(payload).toMatchObject({
        ok: true,
        artifact_ref: sentinelRef,
        content: sentinelBytes,
        content_digest: sentinelRef.content_digest,
        truncated: false,
        next_range: null,
      });

      processEnv.PENNY_STATE_ROOT = decoyRoot;
      await expect(
        preflightLocalLiveArtifactRead({
          projectRoot: PROJECT_ROOT,
          env,
          processEnv,
          frozen,
        })
      ).rejects.toMatchObject({ code: "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE" });
      expect(processEnv.PENNY_STATE_ROOT).toBe(decoyRoot);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("local-live Pi catalog and Ollama tags integration", () => {
  it("loads the normal Pi catalog shape and independently proves an installed local tag", async () => {
    const requests: Array<{
      readonly method: string | undefined;
      readonly url: string | undefined;
      readonly authorization: string | undefined;
      readonly cookie: string | undefined;
    }> = [];
    const server = await listenLoopback((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      const body = JSON.stringify({
        models: [{ name: "qwen3.8:latest", model: "qwen3.8:latest" }],
      });
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
      response.end(body);
    });
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-local-live-catalog-"));
    try {
      const modelsPath = path.join(temporary, "models.json");
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            ollama: {
              baseUrl: `${server.origin}/v1`,
              api: "openai-completions",
              models: [
                {
                  id: "qwen3.8:latest",
                  reasoning: true,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        "utf8"
      );
      const dependencies: LocalLiveModelPreflightDependenciesV1 = {
        createCatalog: (signal) =>
          ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath,
            modelsStorePath: path.join(temporary, "models-store.json"),
            allowModelNetwork: false,
            refreshOnCreate: false,
            signal,
          }),
        fetch: globalThis.fetch,
        timeoutMs: 2_000,
      };
      const plan = frozenLocalPlan();
      const resolved = await preflightLocalLiveModel(
        {
          plan,
          actualRuntime: plan.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        dependencies
      );

      expect(resolved.model).toMatchObject({
        provider: "ollama",
        id: "qwen3.8:latest",
        baseUrl: `${server.origin}/v1`,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      expect(requests).toEqual([
        {
          method: "GET",
          url: "/api/tags",
          authorization: undefined,
          cookie: undefined,
        },
      ]);
    } finally {
      await server.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
