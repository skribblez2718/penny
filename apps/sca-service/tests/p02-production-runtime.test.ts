import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import { hostOperationDeclarationSha256 } from "../../orchestration/dist/host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../../orchestration/dist/host-operations/owner.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/registry.js";
import {
  SCA_P02_CANDIDATE_REGISTRATION,
  SCA_P02_OPERATION_DECLARATIONS,
  SCA_P02_PHASE_REGISTRATION,
} from "../../orchestration/dist/sca/p02-playbook.js";
import {
  scaProposedStartSha256,
  type ScaProposedActivationStartV1,
} from "../../orchestration/dist/sca/qualification-activation.js";
import type { ScaOsvV2Transport } from "../src/adapters/osv-v2.js";
import type { P02ControlledInventoryRunnerV1 } from "../src/p02-host-inventory-runner.js";
import type { P02ControlledProcessRunnerV1 } from "../src/p02-host-process-runner.js";
import type {
  createScaP02OperationAdaptersV1,
  ScaP02OperationAdapterOptionsV1,
} from "../src/p02-operations.js";

interface CapturedServiceOptions {
  readonly playbookRegistration?: unknown;
  readonly hostOperationAdapters?: unknown;
  readonly hostOperationResultCache?: unknown;
  readonly hostOperationUseValidator?: HostOperationUseValidatorV1;
  readonly scaP02ComponentValidationAuthority?: unknown;
  readonly enableChildWorkflows?: boolean;
}

const mocks = vi.hoisted(() => ({
  createAdapters: vi.fn<typeof createScaP02OperationAdaptersV1>(),
  serviceOptions: ((): CapturedServiceOptions | null => null)(),
}));

vi.mock("../src/p02-operations.js", () => ({
  createScaP02OperationAdaptersV1: mocks.createAdapters,
}));
vi.mock("../../orchestration/dist/service.js", () => ({
  OrchestrationService: class {
    constructor(options: CapturedServiceOptions) {
      mocks.serviceOptions = options;
    }
  },
}));

import {
  createScaP02ActivatedProductionServiceV1,
  createScaP02CandidateHostCompositionV1,
  createScaP02CandidateServiceV1,
  type ScaP02ProductionAdapterBindingsV1,
} from "../src/p02-production-runtime.js";

const roots: string[] = [];

function artifactRef(label: string): ArtifactRef {
  return previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id: "run",
      phase: "p02",
      branch_id: null,
      kind: "evidence",
      operation_id: label,
      version: 1,
      producer: "test",
      media_type: "application/json",
      parent_ref: null,
      upstream_refs: [],
    },
    content: label,
  });
}

function inventoryRunner(): P02ControlledInventoryRunnerV1 {
  return {
    qualification: "controlled_p02_inventory_only",
    profile_sha256: "1".repeat(64),
    deployment_sha256: "2".repeat(64),
    async run() {
      throw new Error("not executed by composition test");
    },
  };
}

function processRunner(
  kind: P02ControlledProcessRunnerV1["kind"],
  seed: string
): P02ControlledProcessRunnerV1 {
  return {
    qualification: "controlled_p02_scanners_only",
    kind,
    profile_sha256: seed.repeat(64),
    deployment_sha256: seed.toUpperCase().repeat(64),
    async run() {
      throw new Error("not executed by composition test");
    },
  };
}

function transport(): ScaOsvV2Transport {
  return {
    ip_confinement: "external_worker_enforced",
    async send() {
      throw new Error("not executed by composition test");
    },
  };
}

function proposedStart(): ScaProposedActivationStartV1 {
  const projection = {
    tenant_id: "fixture-tenant",
    project_id: "fixture-project",
    phase_id: "SCA-P02",
    production_playbook_name: "sca-p02",
    qualification_run_id: "fixture-qualification",
    activation_run_id: "fixture-activation",
    qualification_ref: artifactRef("qualification"),
    gate_ref: artifactRef("gate"),
  };
  return {
    ...projection,
    proposed_start_sha256: scaProposedStartSha256(projection),
    authority_ref: artifactRef("authority"),
  };
}

function useInput(): Parameters<HostOperationUseValidatorV1["validateUse"]>[0] {
  const declaration = SCA_P02_OPERATION_DECLARATIONS.inventory;
  const request = artifactRef("inventory-request");
  return {
    directive: {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: {
        schema_version: 2,
        run_id: "fixture-run",
        session_id: "fixture-session",
        playbook: "sca-p02",
        engine_owner: "typescript",
      },
      state_id: "fixture-inventory",
      attempt: 1,
      operation_id: "fixture-operation",
      operation_kind: declaration.operation_kind,
      registration_sha256: runtimeRegistrationSha256(SCA_P02_PHASE_REGISTRATION),
      request_ref: request,
      request_sha256: request.content_digest,
      input_artifacts: { schema_version: 2, artifacts: [] },
      expected_result: declaration.result,
      policy_binding: {
        schema_version: 1,
        declaration_sha256: hostOperationDeclarationSha256(declaration),
        adapter_id: declaration.adapter_id,
        backend_binding_id: declaration.backend_binding_id,
        backend_key_sha256: sha256("fixture-backend"),
        lease_profile_id: declaration.lease_profile.profile_id,
        lease_profile_sha256: declaration.lease_profile.profile_sha256,
        operation_inactivity_ms: declaration.operation_inactivity_ms,
      },
    },
    declaration,
    request_bytes: Uint8Array.of(1),
    signal: new AbortController().signal,
    reportWorkMilestone: vi.fn(),
  };
}

function existingCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "p02-production-cache-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function bindings(): ScaP02ProductionAdapterBindingsV1 {
  const composerTransport = transport();
  const npmTransport = transport();
  return {
    component_validation_authority: { validateComponents: vi.fn() },
    isolation: {
      runtime_kind: "host_qualified",
      qualification_scope: "live_qualified",
      isolation_id: "isolation",
      runtime_id: "runtime",
      implementation_identity_sha256: "a".repeat(64),
      deployment_identity_sha256: "b".repeat(64),
      profile_id: "profile",
      profile_sha256: "c".repeat(64),
      operation_profiles: {
        inventory: "1".repeat(64),
        semgrep_php: "2".repeat(64),
        semgrep_js_ts: "3".repeat(64),
        gitleaks: "4".repeat(64),
        osv_composer: "5".repeat(64),
        osv_npm: "6".repeat(64),
      },
      host_attestation_id: "attestation",
      host_attestation_sha256: "d".repeat(64),
      host_attestation_ref: artifactRef("attestation"),
      run: async ({ execute }) => execute(),
    },
    controlled_inventory_runner: inventoryRunner(),
    controlled_process_runners: {
      semgrep_php: processRunner("semgrep_php", "7"),
      semgrep_js_ts: processRunner("semgrep_js_ts", "8"),
      gitleaks: processRunner("gitleaks", "9"),
    },
    osv_transports: {
      osv_composer: { transport_id: "composer-transport", transport: composerTransport },
      osv_npm: { transport_id: "npm-transport", transport: npmTransport },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdapters.mockReturnValue(
    new Map([
      [
        "inventory",
        {
          adapter_id: "inventory",
          inspectRequest() {
            throw new Error("not executed by composition test");
          },
          async run() {
            throw new Error("not executed by composition test");
          },
        },
      ],
    ])
  );
  mocks.serviceOptions = null;
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("P02 candidate production composition", () => {
  it("binds distinct OSV capabilities and injects the durable cache into the service", async () => {
    const inputBindings = bindings();
    const composition = await createScaP02CandidateServiceV1({
      project_root: "/project",
      host: { result_cache_root: existingCacheRoot(), bindings: inputBindings },
    });

    const adapterOptions: ScaP02OperationAdapterOptionsV1 | undefined =
      mocks.createAdapters.mock.calls[0]?.[0];
    const composer = adapterOptions?.osv_transports?.osv_composer;
    const npm = adapterOptions?.osv_transports?.osv_npm;
    if (composer === undefined || npm === undefined) {
      throw new Error("production composition omitted an OSV transport");
    }
    expect(composer.transport_id).toBe("composer-transport");
    expect(npm.transport_id).toBe("npm-transport");
    expect(composer.transport).not.toBe(npm.transport);

    expect(mocks.serviceOptions?.playbookRegistration).toBe(SCA_P02_CANDIDATE_REGISTRATION);
    expect(mocks.serviceOptions?.hostOperationAdapters).toBe(composition.adapters);
    expect(mocks.serviceOptions?.hostOperationResultCache).toBe(composition.result_cache);
    expect(mocks.serviceOptions?.scaP02ComponentValidationAuthority).toBe(
      composition.component_validation_authority
    );
    expect(mocks.serviceOptions?.enableChildWorkflows).toBe(false);
  });

  it("constructs the campaign service only from fresh activation and replays it before use", async () => {
    const resolve = vi.fn(() => SCA_P02_PHASE_REGISTRATION);
    const composition = await createScaP02ActivatedProductionServiceV1({
      project_root: "/project",
      activation_host: { sample: vi.fn(), verifyIssuance: vi.fn() },
      proposed_start: proposedStart(),
      phase_registry: { resolve },
      host: { result_cache_root: existingCacheRoot(), bindings: bindings() },
    });

    expect(composition.runtime_registration_sha256).toBe(
      runtimeRegistrationSha256(SCA_P02_PHASE_REGISTRATION)
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(mocks.serviceOptions?.playbookRegistration).toBe(SCA_P02_PHASE_REGISTRATION);
    expect(mocks.serviceOptions?.hostOperationUseValidator).toBe(composition.use_validator);

    await composition.use_validator.validateUse(useInput());
    expect(resolve).toHaveBeenCalledTimes(3);

    resolve.mockImplementation(() => {
      throw new Error("P02 activation revoked");
    });
    expect(() => composition.use_validator.validateUse(useInput())).toThrow(/revoked/u);
  });

  it("refuses absent activation before cache or adapter construction", async () => {
    await expect(
      createScaP02ActivatedProductionServiceV1({
        project_root: "/project",
        activation_host: { sample: vi.fn(), verifyIssuance: vi.fn() },
        proposed_start: proposedStart(),
        phase_registry: {
          resolve() {
            throw new Error("P02 is not durably active");
          },
        },
        host: { result_cache_root: existingCacheRoot(), bindings: bindings() },
      })
    ).rejects.toThrow(/not durably active/u);
    expect(mocks.createAdapters).not.toHaveBeenCalled();
    expect(mocks.serviceOptions).toBeNull();
  });

  it("rejects reuse of one OSV transport capability before opening the cache", async () => {
    const inputBindings = bindings();
    const shared = inputBindings.osv_transports.osv_composer;
    const invalid: ScaP02ProductionAdapterBindingsV1 = {
      ...inputBindings,
      osv_transports: { osv_composer: shared, osv_npm: shared },
    };

    await expect(
      createScaP02CandidateHostCompositionV1({
        result_cache_root: "/not/opened",
        bindings: invalid,
      })
    ).rejects.toThrow(/bindings_invalid/u);
    expect(mocks.createAdapters).not.toHaveBeenCalled();
  });

  it("refuses a missing durable cache before adapter construction", async () => {
    await expect(
      createScaP02CandidateHostCompositionV1({
        result_cache_root: join(tmpdir(), `missing-p02-cache-${Date.now()}`),
        bindings: bindings(),
      })
    ).rejects.toThrow(/ENOENT|absent/u);
    expect(mocks.createAdapters).not.toHaveBeenCalled();
  });
});
