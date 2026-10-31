import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadImagegenRuntimeFromEnvironment } from "../dist/imagegen/runtime-config.js";
import {
  ImagegenActivationDeniedError,
  SqliteImagegenActivationController,
  imagegenActivationRequestSha256,
} from "../dist/imagegen/activation.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import { initializePennyState } from "../dist/state/setup.js";
import { OrchestrationService } from "../dist/service.js";
import { COMFY_IMAGEGEN_ADAPTER_ID } from "../dist/imagegen/operation-owner.js";
import { COMFY_IMAGEGEN_READINESS_ADAPTER_ID } from "../dist/imagegen/readiness-operation.js";
import { IMAGEGEN_EXPORT_ADAPTER_ID } from "../dist/imagegen/export-operation.js";
import { SYNTHETIC_NODE_POLICIES, syntheticProfile } from "./helpers/imagegen-fixtures.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-runtime-config-"));
  roots.push(root);
  return root;
}

function manifest(
  root: string,
  activation: Record<string, unknown> = { mode: "disabled" }
): Record<string, unknown> {
  const profile = syntheticProfile({ port: 8188 });
  const exportRoot = path.join(root, "exports");
  mkdirSync(exportRoot, { mode: 0o700 });
  return {
    schema_version: 1,
    default_profile_id: profile.profile_id,
    approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
    profiles: [profile],
    node_class_policies: SYNTHETIC_NODE_POLICIES,
    activation,
    storage: { ceiling_bytes: 33_554_432, warning_threshold_bytes: 25_165_824 },
    export_destinations: [
      {
        destination_id: "runtime-export",
        root: exportRoot,
        max_files: 8,
        max_bytes: 8_388_608,
      },
    ],
  };
}

function writeManifest(root: string, value: unknown): string {
  const filename = path.join(root, "runtime.json");
  writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  chmodSync(filename, 0o600);
  return filename;
}

function serviceEnvironment(root: string, filename: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: filename,
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
}

function startRequest(runId: string, goal: string): Record<string, unknown> {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "imagegen",
      engine_owner: "typescript",
    },
    goal,
    constraints: { schema_version: 1, count: 1, seed: 424242 },
    project_root: PROJECT_ROOT,
    trust_profile: "trusted-interactive",
  };
}

function denied(error: unknown): ImagegenActivationDeniedError {
  if (error instanceof ImagegenActivationDeniedError) return error;
  throw new Error(`expected an ImagegenActivationDeniedError, received ${String(error)}`);
}

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail closed");
}

describe("operator-private imagegen runtime configuration", () => {
  it("loads exact profiles, storage, export, activation, and the three registered adapters", () => {
    const root = temporaryRoot();
    const stateRoot = path.join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const filename = writeManifest(
      root,
      manifest(root, {
        mode: "canary",
        canary: {
          canary_id: "operator-canary-1",
          request_sha256: "a".repeat(64),
          profile_sha256: "b".repeat(64),
        },
      })
    );
    const runtime = loadImagegenRuntimeFromEnvironment({
      env: { PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: filename },
      state_root: stateRoot,
    });
    expect(runtime).toBeDefined();
    expect(runtime?.providers.profiles.resolve().profile.profile_id).toBe("synthetic-profile");
    expect(runtime?.providers.activation.mode).toBe("canary");
    expect(runtime?.providers.activation.status()).toMatchObject({
      mode: "canary",
      canary: { canary_id: "operator-canary-1", state: "installed" },
    });
    expect([...(runtime?.adapters.keys() ?? [])].sort()).toEqual(
      [
        COMFY_IMAGEGEN_ADAPTER_ID,
        COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
        IMAGEGEN_EXPORT_ADAPTER_ID,
      ].sort()
    );
    runtime?.close();
  });

  it("defaults to a closed disabled mode and denies a registered exact-name start", () => {
    const root = temporaryRoot();
    const filename = writeManifest(root, manifest(root));
    const env = serviceEnvironment(root, filename);
    initializePennyState(PROJECT_ROOT, { env });
    const service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "imagegen",
    });
    try {
      const error = denied(
        capture(() => service.handle(startRequest("run-imagegen-disabled", "a calm blue scene")))
      );
      expect(error.code).toBe("mode_disabled");
    } finally {
      service.close();
    }
  });

  it("admits only the exact canary-bound request while ordinary starts stay denied", () => {
    const root = temporaryRoot();
    const profile = syntheticProfile({ port: 8188 });
    const canaryGoal = "a calm blue scene";
    const filename = writeManifest(
      root,
      manifest(root, {
        mode: "canary",
        canary: {
          canary_id: "operator-canary-2",
          request_sha256: imagegenActivationRequestSha256({
            goal: canaryGoal,
            constraints: { schema_version: 1, count: 1, seed: 424242 },
          }),
          profile_sha256: profile.profile_sha256,
        },
      })
    );
    const env = serviceEnvironment(root, filename);
    initializePennyState(PROJECT_ROOT, { env });
    const service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "imagegen",
    });
    try {
      const admitted = service.handle(startRequest("run-imagegen-canary", canaryGoal));
      expect(admitted.identity.run_id).toBe("run-imagegen-canary");
      const error = denied(
        capture(() => service.handle(startRequest("run-imagegen-ordinary", "an unrelated scene")))
      );
      expect(error.code).toBe("canary_request_drift");
    } finally {
      service.close();
    }
  });

  it("revokes a consumed canary fail-closed when the run terminalizes non-positively", async () => {
    const root = temporaryRoot();
    const profile = syntheticProfile({ port: 8188 });
    const canaryGoal = "a calm blue scene";
    const activation = new SqliteImagegenActivationController({
      directory: path.join(root, "activation"),
      mode: "canary",
      canary: {
        canary_id: "operator-canary-cleanup",
        request_sha256: imagegenActivationRequestSha256({
          goal: canaryGoal,
          constraints: { schema_version: 1, count: 1, seed: 424242 },
        }),
        profile_sha256: profile.profile_sha256,
      },
    });
    const env = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(root, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    initializePennyState(PROJECT_ROOT, { env });
    const service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "imagegen",
      imagegen: {
        profiles: new StaticImagegenProfileRegistry({
          profiles: [profile],
          approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
          node_class_policies: SYNTHETIC_NODE_POLICIES,
          default_profile_id: profile.profile_id,
        }),
        exports: new StaticImagegenExportRegistry([]),
        storage: new SqliteImagegenStorageAdmission({
          directory: path.join(root, "storage"),
          ceiling_bytes: 64 * 1024 * 1024,
          warning_threshold_bytes: 48 * 1024 * 1024,
        }),
        activation,
      },
    });
    try {
      expect(activation.status()).toMatchObject({ canary: { state: "installed", run_id: null } });
      let terminalAction: string | undefined;
      try {
        const directive = await service.execute(
          startRequest("run-imagegen-canary-cleanup", canaryGoal)
        );
        terminalAction = directive.action;
      } catch {
        terminalAction = "threw";
      }
      expect(terminalAction).not.toBe("complete");
      // The run consumed the capability and terminalized non-positively, so durability now shows
      // no active capability: a second start can never re-use it.
      expect(activation.status().canary).toBeNull();
      const error = denied(
        capture(() => service.handle(startRequest("run-imagegen-canary-replay", canaryGoal)))
      );
      expect(error.code).toBe("canary_absent");
    } finally {
      service.close();
      activation.close();
    }
  });

  it("is absent without the pinned environment key and rejects unknown fields", () => {
    const root = temporaryRoot();
    const stateRoot = path.join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    expect(loadImagegenRuntimeFromEnvironment({ env: {}, state_root: stateRoot })).toBeUndefined();
    const value = { ...manifest(root), unexpected: true };
    const filename = writeManifest(root, value);
    expect(() =>
      loadImagegenRuntimeFromEnvironment({
        env: { PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: filename },
        state_root: stateRoot,
      })
    ).toThrow("unknown fields");
  });

  it("rejects writable and symlinked manifest custody", () => {
    const root = temporaryRoot();
    const stateRoot = path.join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    const filename = writeManifest(root, manifest(root));
    chmodSync(filename, 0o666);
    expect(() =>
      loadImagegenRuntimeFromEnvironment({
        env: { PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: filename },
        state_root: stateRoot,
      })
    ).toThrow("group/world writable");
    chmodSync(filename, 0o600);
    const link = path.join(root, "runtime-link.json");
    symlinkSync(filename, link);
    expect(() =>
      loadImagegenRuntimeFromEnvironment({
        env: { PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: link },
        state_root: stateRoot,
      })
    ).toThrow("non-symlink regular file");
  });
});
