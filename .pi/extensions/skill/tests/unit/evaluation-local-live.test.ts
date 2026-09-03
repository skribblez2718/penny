import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Model } from "@earendil-works/pi-ai";
import {
  initializePennyState,
  type AgentInvocation,
  type ModelClient,
  type PlaybookRegistrationV1,
} from "@penny/orchestration/source";
import { describe, expect, it, vi } from "vitest";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
} from "../../evaluation-contracts.js";
import {
  PinnedLocalLiveMeasuredModelClient,
  assertLocalLiveModelBinding,
  assertLocalLiveOptIn,
  bindLocalLiveEvaluationState,
  localLiveModelClientFactory,
  preflightLocalLiveModel,
  type LocalLiveModelPreflightDependenciesV1,
} from "../../evaluation-local-live.js";
import {
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  freezePairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
} from "../../evaluation-runner.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);

function plan() {
  return validatePairedEvaluationPlan(
    JSON.parse(
      readFileSync(
        path.join(PROJECT_ROOT, "evals", "fixtures", "synthetic-known-delta.plan.v1.json"),
        "utf8"
      )
    )
  );
}

function localPlan() {
  const base = plan();
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

function catalogModel(
  input: {
    readonly provider?: string;
    readonly model?: string;
    readonly baseUrl?: string;
    readonly inputRate?: number;
  } = {}
): Model<"openai-completions"> {
  return {
    id: input.model ?? "qwen3.8:latest",
    name: "Qwen 3.8 local test model",
    api: "openai-completions",
    provider: input.provider ?? "ollama",
    baseUrl: input.baseUrl ?? "http://127.0.0.1:11434/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: input.inputRate ?? 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function tagsResponse(models: readonly unknown[]): Response {
  const body = JSON.stringify({ models });
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json",
    },
  });
}

function preflightDependencies(
  input: {
    readonly model?: Model<"openai-completions">;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  } = {}
): LocalLiveModelPreflightDependenciesV1 {
  const model = input.model ?? catalogModel();
  return {
    createCatalog: async () => ({
      getModel: (providerId, modelId) =>
        providerId === "ollama" && modelId === "qwen3.8:latest" ? model : undefined,
    }),
    fetch:
      input.fetch ??
      (async () => tagsResponse([{ name: "qwen3.8:latest", model: "qwen3.8:latest" }])),
    timeoutMs: input.timeoutMs ?? 1_000,
  };
}

function stateSandbox(): {
  readonly temporary: string;
  readonly isolatedRoot: string;
  readonly decoyRoot: string;
  readonly env: NodeJS.ProcessEnv;
} {
  const temporary = mkdtempSync(path.join(tmpdir(), "penny-local-live-state-unit-"));
  const isolatedRoot = path.join(temporary, "isolated");
  const decoyRoot = path.join(temporary, "decoy");
  const env: NodeJS.ProcessEnv = { PENNY_STATE_ROOT: isolatedRoot };
  initializePennyState(PROJECT_ROOT, { env });
  initializePennyState(PROJECT_ROOT, { env: { PENNY_STATE_ROOT: decoyRoot } });
  return { temporary, isolatedRoot, decoyRoot, env };
}

function invocation(registration: PlaybookRegistrationV1): AgentInvocation {
  return {
    agent: "demetri",
    stateId: "evaluating",
    task: "{}",
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    inputArtifacts: [],
    registration: {
      playbook_name: registration.name,
      workflow_name: registration.worker.workflow_name,
      guidance: registration.worker.guidance,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
    },
  };
}

describe("local-live evaluation preflight and pinned measured client", () => {
  it("requires dual explicit opt-in", () => {
    expect(() =>
      assertLocalLiveOptIn({ env: { PENNY_EVALUATION_LOCAL_LIVE: "1" }, cliOptIn: false })
    ).toThrow(/both/u);
    expect(() => assertLocalLiveOptIn({ env: {}, cliOptIn: true })).toThrow(/both/u);
    expect(() =>
      assertLocalLiveOptIn({ env: { PENNY_EVALUATION_LOCAL_LIVE: "1" }, cliOptIn: true })
    ).not.toThrow();
  });

  it("binds an absent process selector to the canonical isolated evaluator root", () => {
    const sandbox = stateSandbox();
    try {
      const processEnv: NodeJS.ProcessEnv = {};
      const binding = bindLocalLiveEvaluationState({
        projectRoot: PROJECT_ROOT,
        env: sandbox.env,
        processEnv,
      });
      expect(binding.state_root).toBe(sandbox.isolatedRoot);
      expect(processEnv.PENNY_STATE_ROOT).toBe(sandbox.isolatedRoot);
    } finally {
      rmSync(sandbox.temporary, { recursive: true, force: true });
    }
  });

  it("accepts canonically equivalent process roots", () => {
    const sandbox = stateSandbox();
    try {
      const processEnv: NodeJS.ProcessEnv = {
        PENNY_STATE_ROOT: `${sandbox.isolatedRoot}${path.sep}`,
      };
      expect(() =>
        bindLocalLiveEvaluationState({
          projectRoot: PROJECT_ROOT,
          env: sandbox.env,
          processEnv,
        })
      ).not.toThrow();
    } finally {
      rmSync(sandbox.temporary, { recursive: true, force: true });
    }
  });

  it("rejects a different existing process root without overwriting it", () => {
    const sandbox = stateSandbox();
    try {
      const processEnv: NodeJS.ProcessEnv = { PENNY_STATE_ROOT: sandbox.decoyRoot };
      expect(() =>
        bindLocalLiveEvaluationState({
          projectRoot: PROJECT_ROOT,
          env: sandbox.env,
          processEnv,
        })
      ).toThrow(/LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE/u);
      expect(processEnv.PENNY_STATE_ROOT).toBe(sandbox.decoyRoot);
    } finally {
      rmSync(sandbox.temporary, { recursive: true, force: true });
    }
  });

  it("rejects process-root drift after an initial binding", () => {
    const sandbox = stateSandbox();
    try {
      const processEnv: NodeJS.ProcessEnv = {};
      bindLocalLiveEvaluationState({
        projectRoot: PROJECT_ROOT,
        env: sandbox.env,
        processEnv,
      });
      processEnv.PENNY_STATE_ROOT = sandbox.decoyRoot;
      expect(() =>
        bindLocalLiveEvaluationState({
          projectRoot: PROJECT_ROOT,
          env: sandbox.env,
          processEnv,
        })
      ).toThrow(/LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE/u);
    } finally {
      rmSync(sandbox.temporary, { recursive: true, force: true });
    }
  });

  it("refuses local-live client creation until the artifact_read preflight succeeds", async () => {
    const sandbox = stateSandbox();
    const originalStateRoot = process.env.PENNY_STATE_ROOT;
    try {
      delete process.env.PENNY_STATE_ROOT;
      const local = localPlan();
      const populationValue = validateEvaluationPopulation(
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
      const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
      const frozen = freezePairedEvaluation({
        population: populationValue,
        plan: local,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        implementationBinding: syntheticEvaluationImplementationBinding({
          projectRoot: PROJECT_ROOT,
          population: populationValue,
          plan: local,
          runtimeFunctions,
        }),
        runtimeFunctions,
      });
      const model = catalogModel();
      const factory = localLiveModelClientFactory({
        projectRoot: PROJECT_ROOT,
        env: sandbox.env,
        resolved: {
          model,
          preflight: {
            provider: local.runtime_binding.provider,
            model: local.runtime_binding.model,
            model_id: `${local.runtime_binding.provider}/${local.runtime_binding.model}`,
            base_url: model.baseUrl,
            runtime: local.runtime_binding.runtime,
            thinking_level: local.runtime_binding.thinking_level,
            rates: local.runtime_binding.rates,
            locality: "loopback",
            provider_available: true,
          },
        },
      });
      const entry = frozen.schedule[0];
      if (entry === undefined) throw new Error("frozen local-live schedule is empty");
      expect(() => factory({ entry, plan: local })).toThrow(
        /LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED/u
      );
      await factory.preflight?.({
        frozen,
        population: populationValue,
        plan: local,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
      });
      expect(() => factory({ entry, plan: local })).not.toThrow();
      process.env.PENNY_STATE_ROOT = sandbox.decoyRoot;
      expect(() => factory({ entry, plan: local })).toThrow(
        /LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE/u
      );
    } finally {
      if (originalStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
      else process.env.PENNY_STATE_ROOT = originalStateRoot;
      rmSync(sandbox.temporary, { recursive: true, force: true });
    }
  });

  it("admits only exact zero-rate loopback bindings and the frozen runtime", () => {
    const base = plan();
    const preflight = assertLocalLiveModelBinding({
      plan: base,
      actualRuntime: base.runtime_binding.runtime,
      descriptor: {
        provider: base.runtime_binding.provider,
        model: base.runtime_binding.model,
        base_url: "http://127.0.0.1:11434/v1",
        rates: base.runtime_binding.rates,
      },
    });
    expect(preflight).toMatchObject({ locality: "loopback", provider_available: true });
    expect(() =>
      assertLocalLiveModelBinding({
        plan: base,
        actualRuntime: base.runtime_binding.runtime,
        descriptor: {
          provider: base.runtime_binding.provider,
          model: base.runtime_binding.model,
          base_url: "https://models.example.test/v1",
          rates: base.runtime_binding.rates,
        },
      })
    ).toThrow(/loopback/u);
    expect(() =>
      assertLocalLiveModelBinding({
        plan: {
          ...base,
          runtime_binding: {
            ...base.runtime_binding,
            rates: { ...base.runtime_binding.rates, input_usd_per_million_tokens: 1 },
          },
        },
        actualRuntime: base.runtime_binding.runtime,
        descriptor: {
          provider: base.runtime_binding.provider,
          model: base.runtime_binding.model,
          base_url: "http://localhost:11434/v1",
          rates: base.runtime_binding.rates,
        },
      })
    ).toThrow(/USD 0.00/u);
  });

  it("resolves exact catalog metadata and proves the exact local Ollama tag without credentials", async () => {
    const requested: { url?: string; init?: RequestInit } = {};
    const fetcher: typeof globalThis.fetch = async (url, init) => {
      requested.url = url.toString();
      requested.init = init;
      return tagsResponse([{ name: "qwen3.8:latest", model: "qwen3.8:latest" }]);
    };
    const base = localPlan();
    const resolved = await preflightLocalLiveModel(
      {
        plan: base,
        actualRuntime: base.runtime_binding.runtime,
        expectedProvider: "ollama",
      },
      preflightDependencies({ fetch: fetcher })
    );

    expect(resolved.preflight).toMatchObject({
      provider: "ollama",
      model: "qwen3.8:latest",
      base_url: "http://127.0.0.1:11434/v1",
      locality: "loopback",
      provider_available: true,
    });
    expect(requested.url).toBe("http://127.0.0.1:11434/api/tags");
    expect(requested.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(requested.init?.headers).toBeUndefined();
  });

  it("runs semantic authorization before catalog/model/provider access", async () => {
    const base = localPlan();
    const dependencies = preflightDependencies();
    const events: string[] = [];
    await preflightLocalLiveModel(
      {
        plan: base,
        actualRuntime: base.runtime_binding.runtime,
        expectedProvider: "ollama",
        semanticAuthorizationPreflight: async () => {
          events.push("authorization");
          return {
            manifest: {
              execution_binding: {
                provider: base.runtime_binding.provider,
                model: base.runtime_binding.model,
                runtime: base.runtime_binding.runtime,
                thinking_level: base.runtime_binding.thinking_level,
              },
            },
          };
        },
      },
      {
        ...dependencies,
        createCatalog: async (signal) => {
          events.push("catalog");
          return dependencies.createCatalog(signal);
        },
      }
    );
    expect(events).toEqual(["authorization", "catalog"]);

    let catalogCalls = 0;
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
          semanticAuthorizationPreflight: async () => {
            throw new Error("authorization rejected");
          },
        },
        {
          ...dependencies,
          createCatalog: async (signal) => {
            catalogCalls += 1;
            return dependencies.createCatalog(signal);
          },
        }
      )
    ).rejects.toThrow(/authorization rejected/u);
    expect(catalogCalls).toBe(0);
  });

  it("rejects an absent exact Ollama tag without substituting another installed model", async () => {
    const base = localPlan();
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        preflightDependencies({
          fetch: async () => tagsResponse([{ name: "qwen3.8:other", model: "qwen3.8:other" }]),
        })
      )
    ).rejects.toThrow(/not installed/u);
  });

  it("rejects an exact Ollama tag backed by a remote cloud model", async () => {
    const base = localPlan();
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        preflightDependencies({
          fetch: async () =>
            tagsResponse([
              {
                name: "qwen3.8:latest",
                model: "qwen3.8:latest",
                remote_model: "qwen3.8",
                remote_host: "https://ollama.com:443",
              },
            ]),
        })
      )
    ).rejects.toThrow(/remote Ollama tag/u);
  });

  it.each([
    ["provider", catalogModel({ provider: "remote-provider" }), /identity/u],
    ["model", catalogModel({ model: "qwen3.8:substitute" }), /identity/u],
    ["rate", catalogModel({ inputRate: 1 }), /rates/u],
    ["URL", catalogModel({ baseUrl: "https://models.example.test/v1" }), /loopback/u],
    [
      "credential-bearing URL",
      catalogModel({ baseUrl: "http://user:secret@127.0.0.1:11434/v1" }),
      /credential-free/u,
    ],
  ])("rejects catalog %s drift before querying tags", async (_kind, model, expected) => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const base = localPlan();
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        preflightDependencies({ model, fetch: fetcher })
      )
    ).rejects.toThrow(expected);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on Ollama tag endpoint timeout and request error", async () => {
    const base = localPlan();
    const timeoutFetch: typeof globalThis.fetch = async (_url, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("test signal is absent");
      return new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(signal.reason);
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        preflightDependencies({ fetch: timeoutFetch, timeoutMs: 5 })
      )
    ).rejects.toThrow(/timed out/u);
    await expect(
      preflightLocalLiveModel(
        {
          plan: base,
          actualRuntime: base.runtime_binding.runtime,
          expectedProvider: "ollama",
        },
        preflightDependencies({
          fetch: async () => {
            throw new Error("connection refused");
          },
        })
      )
    ).rejects.toThrow(/request failed/u);
  });

  it("overrides every variant with the frozen model and thinking level and measures zero cost", async () => {
    const runtimeBinding = {
      ...plan().runtime_binding,
      provider: "ollama",
      model: "qwen3.8:latest",
      thinking_level: "low" as const,
    };
    let captured: AgentInvocation | undefined;
    const inner: ModelClient = {
      async runAgent(value) {
        captured = value;
        value.admitResolvedModel?.({ provider: "ollama", model: "qwen3.8:latest" });
        return { text: "complete" };
      },
    };
    const client = new PinnedLocalLiveMeasuredModelClient(runtimeBinding, inner);
    await client.runAgent(invocation(DIRECT_DEMETRI_BASELINE_REGISTRATION));
    expect(captured?.modelOverride).toBe("ollama/qwen3.8:latest");
    expect(captured?.thinkingLevel).toBe("low");
    expect(client.measurement("run")).toMatchObject({
      cost_microusd: 0,
      loopback_provider_calls: 1,
    });
    expect(client.measurement("run").latency_ms).toBeGreaterThanOrEqual(1);
  });
});
