import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../orchestration/dist/canonical-json.js";
import { SCA_P03_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p03-playbook.js";
import type { ScaProposedActivationStartV1 } from "../../orchestration/dist/sca/qualification-activation.js";
import type { ScaP03DockerRuntimeConfigV1 } from "../src/p03-docker-runtime.js";

interface CapturedServiceOptions {
  readonly playbookRegistration?: unknown;
  readonly hostOperationAdapters?: unknown;
  readonly hostOperationResultCache?: unknown;
  readonly hostOperationUseValidator?: unknown;
  readonly enableChildWorkflows?: boolean;
}

const mocks = vi.hoisted(() => ({
  bindingValidate: vi.fn(),
  createBindingValidator: vi.fn(),
  deriveAuthority: vi.fn(),
  verifyProof: vi.fn(),
  createRuntime: vi.fn(),
  createAdapters: vi.fn(),
  serviceOptions: ((): CapturedServiceOptions | null => null)(),
}));

vi.mock("../../orchestration/dist/service.js", () => ({
  OrchestrationService: class {
    constructor(options: CapturedServiceOptions) {
      mocks.serviceOptions = options;
    }
  },
}));
vi.mock("../../orchestration/dist/sca/p03-admission.js", () => ({
  createScaP03ProductionUseValidatorV1: mocks.createBindingValidator,
}));
vi.mock("../src/p03-bootstrap.js", () => ({
  scaP03ProductionUseAuthorityFromBindingsV1: mocks.deriveAuthority,
}));
vi.mock("../src/p03-bootstrap-host.js", () => ({
  verifyScaP03ProductionProofV1: mocks.verifyProof,
}));
vi.mock("../src/p03-docker-runtime.js", () => ({
  createScaP03ProductionDockerJoernRuntimeV1: mocks.createRuntime,
}));
vi.mock("../src/p03-operations.js", () => ({
  createScaP03OperationAdaptersV1: mocks.createAdapters,
}));

import {
  createScaP03ActivatedProductionServiceV1,
  createScaP03ProductionHostCompositionV1,
  type ScaP03ProductionRuntimeProofV1,
} from "../src/p03-production-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBindingValidator.mockReturnValue({ validateUse: mocks.bindingValidate });
  mocks.deriveAuthority.mockReturnValue({ authority: "exact" });
  mocks.verifyProof.mockResolvedValue({ proof_sha256: sha256("proof") });
  mocks.createRuntime.mockResolvedValue({ runtime_kind: "host_qualified_joern" });
  mocks.createAdapters.mockReturnValue(new Map([["adapter", { adapter_id: "adapter" }]]));
  mocks.serviceOptions = null;
});

function existingCacheRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "p03-production-composition-"));
  roots.push(root);
  const cache = path.join(root, "cache");
  mkdirSync(cache, { mode: 0o700 });
  return cache;
}

function fixtureInput(
  resultCacheRoot: string
): Parameters<typeof createScaP03ProductionHostCompositionV1>[0] {
  const config: ScaP03DockerRuntimeConfigV1 = {
    docker_executable: "/usr/bin/docker",
    image_ref: `joern@sha256:${sha256("image")}`,
    expected_joern_version: "4.0.627",
    expected_docker_executable_sha256: sha256("docker"),
    expected_docker_client_version: "client",
    expected_docker_server_version: "server",
    runtime_id: "runtime",
    isolation_id: "isolation",
    isolation_profile_sha256: sha256("profile"),
    implementation_identity_sha256: sha256("implementation"),
    deployment_identity_sha256: sha256("deployment"),
    staging_parent: "/private/staging",
    memory_bytes: 1_073_741_824,
    cpus: 1,
    pids: 64,
    max_workspace_bytes: 268_435_456,
    max_num_def: 100_000,
    max_command_output_bytes: 1_048_576,
    timeout_ms: 60_000,
  };
  return {
    config,
    get proof(): ScaP03ProductionRuntimeProofV1 {
      throw new Error("proof read before owner reservation");
    },
    result_cache_root: resultCacheRoot,
    async runner() {
      throw new Error("not executed by composition test");
    },
  };
}

describe("P03 production pre-reservation effect barriers", () => {
  it.each(["normal", "missing-cache", "unsafe-cache"])(
    "fails on invalid %s operands without proof callbacks or effects",
    async (kind) => {
      let cache = existingCacheRoot();
      if (kind === "missing-cache") cache = path.join(cache, "missing");
      if (kind === "unsafe-cache") chmodSync(cache, 0o750);
      await expect(createScaP03ProductionHostCompositionV1(fixtureInput(cache))).rejects.toThrow(
        "proof read before owner reservation"
      );
      expect(mocks.createRuntime).not.toHaveBeenCalled();
      expect(mocks.createBindingValidator).not.toHaveBeenCalled();
      expect(mocks.verifyProof).not.toHaveBeenCalled();
      expect(mocks.createAdapters).not.toHaveBeenCalled();
    }
  );
  it("refuses before registry resolution can cause sampling or a nested same-resource acquisition", async () => {
    const resolve = vi.fn(() => SCA_P03_PHASE_REGISTRATION);
    await expect(
      createScaP03ActivatedProductionServiceV1({
        project_root: "/project",
        activation_host: { sample: vi.fn(), verifyIssuance: vi.fn() },
        get proposed_start(): ScaProposedActivationStartV1 {
          throw new Error("activation read before guard");
        },
        phase_registry: { resolve },
        host: fixtureInput(existingCacheRoot()),
      })
    ).rejects.toThrow("proof read before owner reservation");
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.verifyProof).not.toHaveBeenCalled();
    expect(mocks.serviceOptions).toBeNull();
  });
});
