import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initializePennyState,
  resolvePennyRuntimeState,
  sha256,
} from "@penny/orchestration/source";

import {
  REMOTE_CALIBRATION_RUNTIME_ID,
  executeRemoteCalibrationPackageV1,
  loadCalibrationPackageV1,
  preflightRemoteCalibrationPackageV1,
  runRemoteC6CalibrationSequenceV1,
  type LoadedCalibrationPackageV1,
  type RemoteCalibrationDependenciesV1,
} from "../../evaluation-remote-calibration.js";
import { parseRemoteCalibrationCliArgs } from "../../evaluation-remote-calibration-cli.js";
import {
  Q4_ORACLE_REVIEW_CLAUSE_IDS,
  SEMANTIC_REVIEW_IMPLEMENTATION_SHA256,
  SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256,
  SEMANTIC_REVIEW_SYSTEM_PROMPT_V1,
  buildEvaluationLiveCalibrationAuthorizationManifestV1,
  evaluationLiveCalibrationAuthorizationManifestSha256,
  semanticReviewOutputSchemaSha256,
  semanticReviewPacketSchemaSha256,
  type EvaluationLiveCalibrationApprovalReceiptV1,
  type EvaluationLiveCalibrationAuthorizationManifestV1,
  type EvaluationOperatorApprovalVerifierV1,
} from "../../evaluation-semantic-review.js";
import { DECIDE_SEMANTIC_CLAUSE_IDS } from "../../decide-evaluation.js";
import { PLAN_SEMANTIC_CLAUSE_IDS } from "../../plan-evaluation.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

function configuredModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai-codex",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function fleetFor(skill: "decide" | "plan") {
  const agents =
    skill === "decide"
      ? ["annie", "carren", "demetri", "echo", "vera"]
      : ["carren", "echo", "piper", "vera"];
  return agents.map((agent) => ({
    agent,
    ssot_model: agent === "vera" ? "terra" : "sol",
    provider: "openai-codex",
    model: agent === "vera" ? "model-terra" : "model-sol",
    runtime: REMOTE_CALIBRATION_RUNTIME_ID,
    thinking_level: "xhigh" as const,
    allowed_origin: "https://api.openai.com",
    rates: {
      input_usd_per_million_tokens: 1,
      output_usd_per_million_tokens: 2,
      cache_read_usd_per_million_tokens: 0.1,
      cache_write_usd_per_million_tokens: 0.2,
    },
  }));
}

function authorization(input: {
  readonly loaded: LoadedCalibrationPackageV1;
  readonly root: string;
}): {
  readonly manifest: EvaluationLiveCalibrationAuthorizationManifestV1;
  readonly approval: EvaluationLiveCalibrationApprovalReceiptV1;
} {
  const env = { PENNY_STATE_ROOT: path.join(input.root, "state") };
  initializePennyState(PROJECT_ROOT, { env });
  const state = resolvePennyRuntimeState(PROJECT_ROOT, { env });
  const fleet = fleetFor(input.loaded.package.skill);
  const clauses =
    input.loaded.package.skill === "decide" ? DECIDE_SEMANTIC_CLAUSE_IDS : PLAN_SEMANTIC_CLAUSE_IDS;
  const manifest = buildEvaluationLiveCalibrationAuthorizationManifestV1({
    authorization_id: `authorization:${input.loaded.package.package_id}`,
    calibration: {
      package_id: input.loaded.package.package_id,
      package_sha256: input.loaded.package.package_sha256,
      schedule_sha256: input.loaded.scheduleSha256,
      arms: input.loaded.schedule.arms
        .map((arm) => ({ arm_id: arm.arm_id, binding_sha256: arm.binding_sha256 }))
        .sort((left, right) => left.arm_id.localeCompare(right.arm_id)),
    },
    execution_binding: {
      provider: fleet[0]?.provider ?? "openai-codex",
      model: fleet[0]?.model ?? "model-sol",
      runtime: REMOTE_CALIBRATION_RUNTIME_ID,
      thinking_level: "xhigh",
    },
    execution_fleet: fleet,
    judge_binding: {
      provider: "openai-codex",
      model: "judge-model",
      runtime: REMOTE_CALIBRATION_RUNTIME_ID,
      thinking_level: "xhigh",
    },
    judge_rates: {
      input_usd_per_million_tokens: 1,
      output_usd_per_million_tokens: 2,
      cache_read_usd_per_million_tokens: 0.1,
      cache_write_usd_per_million_tokens: 0.2,
    },
    judge_contract: {
      judge_definition_sha256: SEMANTIC_REVIEW_JUDGE_DEFINITION_SHA256,
      judge_prompt_sha256: sha256(SEMANTIC_REVIEW_SYSTEM_PROMPT_V1),
      trial_packet_schema_sha256: semanticReviewPacketSchemaSha256(
        "trial",
        input.loaded.package.skill,
        clauses
      ),
      oracle_packet_schema_sha256: semanticReviewPacketSchemaSha256(
        "oracle",
        input.loaded.package.skill,
        Q4_ORACLE_REVIEW_CLAUSE_IDS
      ),
      trial_output_schema_sha256: semanticReviewOutputSchemaSha256("trial", clauses),
      oracle_output_schema_sha256: semanticReviewOutputSchemaSha256(
        "oracle",
        Q4_ORACLE_REVIEW_CLAUSE_IDS
      ),
      implementation_sha256: SEMANTIC_REVIEW_IMPLEMENTATION_SHA256,
    },
    roots: {
      state_root: path.resolve(state.state.root),
      evidence_root: path.resolve(state.paths.artifacts.root),
    },
    limits: {
      repetitions: 1,
      max_concurrency: 1,
      max_calls: 100,
      max_retries: 2,
      max_execution_calls_per_trial: 2,
      max_execution_turns_per_trial: 2,
      max_input_tokens: 100_000,
      max_output_tokens: 20_000,
      max_total_tokens: 1_000_000,
      max_storage_bytes: 50_000_000,
      max_spend_microusd: 3_000_000,
      max_wall_clock_ms: 60_000,
    },
    egress: {
      allowed_origins: ["https://api.openai.com"],
      credential_scope: "provider-runtime-owned",
    },
    validity: {
      not_before: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-01T02:00:00.000Z",
    },
    nonce: `nonce_${input.loaded.package.package_id.replaceAll("-", "_")}_12345678`,
  });
  const approval: EvaluationLiveCalibrationApprovalReceiptV1 = {
    schema_version: 1,
    approval_id: `approval:${input.loaded.package.package_id}`,
    scope: "evaluation_live_calibration",
    manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(manifest),
    owner_id: "owner:test",
    issued_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-01T02:00:00.000Z",
    nonce: manifest.nonce,
    verification_material: "caller-owned-test-proof",
  };
  return { manifest, approval };
}

function verifier(): EvaluationOperatorApprovalVerifierV1 {
  return {
    verify: ({ approval }) => ({
      owner_id: approval.owner_id,
      verification_id: "verified:test-owner",
    }),
    admit: ({ exact_journal_present }) => (exact_journal_present ? "resume" : "fresh"),
  };
}

function dependencies(catalogCalls: { value: number }): RemoteCalibrationDependenciesV1 {
  const models = new Map([
    ["openai-codex/model-sol", configuredModel("model-sol")],
    ["openai-codex/model-terra", configuredModel("model-terra")],
    ["openai-codex/judge-model", configuredModel("judge-model")],
  ]);
  return {
    createCatalog: async () => ({
      getModel: (provider, model) => {
        catalogCalls.value += 1;
        return models.get(`${provider}/${model}`);
      },
    }),
    now: () => new Date("2026-09-01T01:00:00.000Z"),
    monotonicNow: () => 1,
  };
}

describe("remote C6 calibration path", () => {
  it("loads the exact frozen packages without provider or state work", () => {
    const decide = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
    });
    const plan = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
    });
    expect(decide.package.package_sha256).toBe(
      "058a4419a7b69588d11d5cd2210f667e13c49e0f3fd33801e71f206ca722e4cc"
    );
    expect(plan.package.package_sha256).toBe(
      "3b11518f700a8138602f951dc8cfde7ee546c1edb4f9d514491f087698be9e17"
    );
    expect(decide.package.split).toBe("calibration");
    expect(plan.package.scoring).toBe("non_scoring");
  });

  it("preflights ordinary candidate YAML defaults and evaluation-only strict subsets", async () => {
    const decideLoaded = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
    });
    const planLoaded = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
    });
    const decideAuthorization = authorization({
      loaded: decideLoaded,
      root: temporaryRoot("remote-decide"),
    });
    const planAuthorization = authorization({
      loaded: planLoaded,
      root: temporaryRoot("remote-plan"),
    });
    const calls = { value: 0 };
    const outcome = await runRemoteC6CalibrationSequenceV1({
      projectRoot: PROJECT_ROOT,
      decide: {
        packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
        ...decideAuthorization,
        confirmedPackageSha256: decideLoaded.package.package_sha256,
        confirmedMaxSpendMicrousd: decideAuthorization.manifest.limits.max_spend_microusd,
      },
      plan: {
        packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
        ...planAuthorization,
        confirmedPackageSha256: planLoaded.package.package_sha256,
        confirmedMaxSpendMicrousd: planAuthorization.manifest.limits.max_spend_microusd,
      },
      ownerVerifier: verifier(),
      preflightOnly: true,
      dependencies: dependencies(calls),
    });
    expect(outcome.status).toBe("PREFLIGHT_PASSED");
    if (outcome.status !== "PREFLIGHT_PASSED") throw new Error("unexpected live outcome");
    expect(outcome.decide.loaded.package.skill).toBe("decide");
    expect(outcome.plan.loaded.package.skill).toBe("plan");
    expect(calls.value).toBeGreaterThan(0);
  });

  it("fails closed on stale fleet SSOT and on absent live gates before provider work", async () => {
    const loaded = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
    });
    const auth = authorization({ loaded, root: temporaryRoot("remote-negative") });
    const staleManifest = {
      ...auth.manifest,
      execution_fleet: auth.manifest.execution_fleet?.map((entry, index) =>
        index === 0 ? { ...entry, ssot_model: "terra" } : entry
      ),
    };
    const staleApproval = {
      ...auth.approval,
      manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(staleManifest),
    };
    const calls = { value: 0 };
    await expect(
      preflightRemoteCalibrationPackageV1({
        projectRoot: PROJECT_ROOT,
        packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
        manifest: staleManifest,
        approval: staleApproval,
        ownerVerifier: verifier(),
        confirmedPackageSha256: loaded.package.package_sha256,
        confirmedMaxSpendMicrousd: auth.manifest.limits.max_spend_microusd,
        dependencies: dependencies(calls),
      })
    ).rejects.toThrow(/fleet entry/u);

    const preflight = await preflightRemoteCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/decide-c6-v1/package.v1.json",
      ...auth,
      ownerVerifier: verifier(),
      confirmedPackageSha256: loaded.package.package_sha256,
      confirmedMaxSpendMicrousd: auth.manifest.limits.max_spend_microusd,
      dependencies: dependencies(calls),
    });
    await expect(
      executeRemoteCalibrationPackageV1({
        projectRoot: PROJECT_ROOT,
        preflight,
        ownerVerifier: verifier(),
        env: { PENNY_STATE_ROOT: auth.manifest.roots.state_root },
      })
    ).rejects.toThrow("PENNY_EVALUATION_REMOTE_LIVE=1");
  });

  it("rejects authorization rate-card drift and an undersized worst-case call budget", async () => {
    const loaded = loadCalibrationPackageV1({
      projectRoot: PROJECT_ROOT,
      packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
    });
    const auth = authorization({ loaded, root: temporaryRoot("remote-rate-budget") });
    const rateDriftManifest = {
      ...auth.manifest,
      execution_fleet: auth.manifest.execution_fleet?.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              rates: { ...entry.rates, output_usd_per_million_tokens: 3 },
            }
          : entry
      ),
    };
    const rateDriftApproval = {
      ...auth.approval,
      manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(rateDriftManifest),
    };
    await expect(
      preflightRemoteCalibrationPackageV1({
        projectRoot: PROJECT_ROOT,
        packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
        manifest: rateDriftManifest,
        approval: rateDriftApproval,
        ownerVerifier: verifier(),
        confirmedPackageSha256: loaded.package.package_sha256,
        confirmedMaxSpendMicrousd: rateDriftManifest.limits.max_spend_microusd,
        dependencies: dependencies({ value: 0 }),
      })
    ).rejects.toThrow(/unavailable or stale/u);

    const budgetManifest = {
      ...auth.manifest,
      limits: { ...auth.manifest.limits, max_calls: 1 },
    };
    const budgetApproval = {
      ...auth.approval,
      manifest_sha256: evaluationLiveCalibrationAuthorizationManifestSha256(budgetManifest),
    };
    await expect(
      preflightRemoteCalibrationPackageV1({
        projectRoot: PROJECT_ROOT,
        packagePath: "evals/calibration/plan-c6-v1/package.v1.json",
        manifest: budgetManifest,
        approval: budgetApproval,
        ownerVerifier: verifier(),
        confirmedPackageSha256: loaded.package.package_sha256,
        confirmedMaxSpendMicrousd: budgetManifest.limits.max_spend_microusd,
        dependencies: dependencies({ value: 0 }),
      })
    ).rejects.toThrow(/call ceiling/u);
  });

  it("requires exactly one explicit CLI mode and exact spend confirmation", () => {
    const root = PROJECT_ROOT;
    const base = [
      "--project-root",
      root,
      "--decide-package",
      "evals/calibration/decide-c6-v1/package.v1.json",
      "--decide-manifest",
      "decide-manifest.json",
      "--decide-approval",
      "decide-approval.json",
      "--decide-confirm-package-sha256",
      "a".repeat(64),
      "--decide-confirm-max-spend-microusd",
      "100",
      "--plan-package",
      "evals/calibration/plan-c6-v1/package.v1.json",
      "--plan-manifest",
      "plan-manifest.json",
      "--plan-approval",
      "plan-approval.json",
      "--plan-confirm-package-sha256",
      "b".repeat(64),
      "--plan-confirm-max-spend-microusd",
      "200",
      "--owner-verifier-module",
      "verifier.mjs",
    ];
    expect(parseRemoteCalibrationCliArgs([...base, "--preflight-only"]).preflightOnly).toBe(true);
    expect(() => parseRemoteCalibrationCliArgs(base)).toThrow("Usage");
    expect(() =>
      parseRemoteCalibrationCliArgs([...base, "--preflight-only", "--execute-live"])
    ).toThrow("Usage");
  });
});
