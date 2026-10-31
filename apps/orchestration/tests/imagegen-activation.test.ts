import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue, StartRequest } from "../dist/contracts.js";
import {
  ImagegenActivationDeniedError,
  SqliteImagegenActivationController,
  imagegenActivationRequestSha256,
  type ImagegenActivationCanaryDeclarationV1,
} from "../dist/imagegen/activation.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import { IMAGEGEN_START_ADMISSION } from "../dist/imagegen/start-admission.js";
import { SYNTHETIC_NODE_POLICIES, syntheticProfile } from "./helpers/imagegen-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-imagegen-activation-"));
  roots.push(directory);
  return directory;
}

const GOAL = "a calm wordless blue geometric scene";
const CONSTRAINTS = { schema_version: 1, count: 1, seed: 4242 } as const;
const PROFILE_SHA256 = "1".repeat(64);
const REQUEST_SHA256 = imagegenActivationRequestSha256({ goal: GOAL, constraints: CONSTRAINTS });

function canary(overrides: Partial<ImagegenActivationCanaryDeclarationV1> = {}) {
  return {
    canary_id: "operator-canary",
    request_sha256: REQUEST_SHA256,
    profile_sha256: PROFILE_SHA256,
    ...overrides,
  } satisfies ImagegenActivationCanaryDeclarationV1;
}

function denied(run: () => unknown): ImagegenActivationDeniedError {
  try {
    run();
  } catch (error) {
    if (error instanceof ImagegenActivationDeniedError) return error;
    throw error;
  }
  throw new Error("expected the call to fail closed");
}

function startRequest(
  runId: string,
  goal = GOAL,
  constraints: Readonly<Record<string, JsonValue>> = CONSTRAINTS
): StartRequest {
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
    constraints,
    project_root: "/provider-free-project-root",
    trust_profile: "trusted-interactive",
  } satisfies StartRequest;
}

describe("durable imagegen activation authority", () => {
  it("denies every new start in the closed disabled mode", () => {
    const controller = new SqliteImagegenActivationController({
      directory: path.join(root(), "activation"),
      mode: "disabled",
    });
    try {
      expect(controller.mode).toBe("disabled");
      expect(controller.status()).toEqual({ schema_version: 1, mode: "disabled", canary: null });
      const error = denied(() =>
        controller.admit({
          run_id: "run-1",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        })
      );
      expect(error.code).toBe("mode_disabled");
      expect(controller.finalizeRun({ run_id: "run-1", outcome: "failed" })).toBeUndefined();
    } finally {
      controller.close();
    }
  });

  it("admits ordinary starts in enabled mode without consuming capability state", () => {
    const controller = new SqliteImagegenActivationController({
      directory: path.join(root(), "activation"),
      mode: "enabled",
    });
    try {
      const receipt = controller.admit({
        run_id: "run-ordinary",
        request_sha256: REQUEST_SHA256,
        profile_sha256: PROFILE_SHA256,
      });
      expect(receipt).toMatchObject({
        decision: "admitted_ordinary",
        mode: "enabled",
        canary_id: null,
        run_id: "run-ordinary",
      });
      expect(controller.status().canary).toBeNull();
      expect(
        controller.finalizeRun({ run_id: "run-ordinary", outcome: "completed" })
      ).toBeUndefined();
    } finally {
      controller.close();
    }
  });

  it("denies canary mode with no installed capability (absence)", () => {
    const controller = new SqliteImagegenActivationController({
      directory: path.join(root(), "activation"),
      mode: "canary",
    });
    try {
      expect(controller.status()).toEqual({ schema_version: 1, mode: "canary", canary: null });
      const error = denied(() =>
        controller.admit({
          run_id: "run-1",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        })
      );
      expect(error.code).toBe("canary_absent");
    } finally {
      controller.close();
    }
  });

  it("consumes the exact canary once and binds it to the preallocated run id", () => {
    const directory = path.join(root(), "activation");
    const controller = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    try {
      const receipt = controller.admit({
        run_id: "run-canary",
        request_sha256: REQUEST_SHA256,
        profile_sha256: PROFILE_SHA256,
      });
      expect(receipt).toMatchObject({
        decision: "admitted_canary",
        mode: "canary",
        canary_id: "operator-canary",
        run_id: "run-canary",
      });
      expect(controller.status()).toMatchObject({
        mode: "canary",
        canary: {
          canary_id: "operator-canary",
          state: "consumed",
          run_id: "run-canary",
        },
      });
      // The same capability cannot admit a second, different run.
      const replay = denied(() =>
        controller.admit({
          run_id: "run-other",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        })
      );
      expect(replay.code).toBe("canary_replay");
    } finally {
      controller.close();
    }
  });

  it("resumes the exact same run after a crash-safe restart and still denies others", () => {
    const directory = path.join(root(), "activation");
    const first = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    first.admit({
      run_id: "run-canary",
      request_sha256: REQUEST_SHA256,
      profile_sha256: PROFILE_SHA256,
    });
    first.close();
    // Restart with the identical operator declaration: durable consumption survives and the
    // capability is neither re-armed nor re-installed.
    const restarted = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    try {
      expect(restarted.status()).toMatchObject({
        canary: { state: "consumed", run_id: "run-canary" },
      });
      const resumed = restarted.admit({
        run_id: "run-canary",
        request_sha256: REQUEST_SHA256,
        profile_sha256: PROFILE_SHA256,
      });
      expect(resumed.decision).toBe("admitted_canary_resumed");
      const replay = denied(() =>
        restarted.admit({
          run_id: "run-other",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        })
      );
      expect(replay.code).toBe("canary_replay");
    } finally {
      restarted.close();
    }
  });

  it("fails closed on request and profile drift", () => {
    const controller = new SqliteImagegenActivationController({
      directory: path.join(root(), "activation"),
      mode: "canary",
      canary: canary(),
    });
    try {
      const requestDrift = denied(() =>
        controller.admit({
          run_id: "run-1",
          request_sha256: imagegenActivationRequestSha256({
            goal: "a completely different scene",
            constraints: CONSTRAINTS,
          }),
          profile_sha256: PROFILE_SHA256,
        })
      );
      expect(requestDrift.code).toBe("canary_request_drift");
      const profileDrift = denied(() =>
        controller.admit({
          run_id: "run-1",
          request_sha256: REQUEST_SHA256,
          profile_sha256: "2".repeat(64),
        })
      );
      expect(profileDrift.code).toBe("canary_profile_drift");
      // A denied attempt must not have consumed anything.
      expect(controller.status()).toMatchObject({ canary: { state: "installed", run_id: null } });
    } finally {
      controller.close();
    }
  });

  it("revokes the capability fail-closed on success, failure, and timeout", () => {
    for (const outcome of ["completed", "failed", "timed_out"] as const) {
      const directory = path.join(root(), "activation");
      const controller = new SqliteImagegenActivationController({
        directory,
        mode: "canary",
        canary: canary(),
      });
      try {
        controller.admit({
          run_id: "run-canary",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        });
        const receipt = controller.finalizeRun({ run_id: "run-canary", outcome });
        expect(receipt).toMatchObject({
          canary_id: "operator-canary",
          run_id: "run-canary",
          outcome,
        });
        // Idempotent replay of the same disposition.
        expect(controller.finalizeRun({ run_id: "run-canary", outcome })).toEqual(receipt);
        // A different disposition is a fail-closed cleanup ambiguity.
        const conflicting = outcome === "completed" ? "failed" : "completed";
        expect(() =>
          controller.finalizeRun({ run_id: "run-canary", outcome: conflicting })
        ).toThrow("conflicts with the durable canary disposition");
        // The revoked capability can never admit again, even for the same run.
        expect(() =>
          controller.admit({
            run_id: "run-canary",
            request_sha256: REQUEST_SHA256,
            profile_sha256: PROFILE_SHA256,
          })
        ).toThrowError(ImagegenActivationDeniedError);
      } finally {
        controller.close();
      }
    }
  });

  it("refuses to overwrite an active capability with a different one", () => {
    const directory = path.join(root(), "activation");
    const active = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    try {
      expect(
        () =>
          new SqliteImagegenActivationController({
            directory,
            mode: "canary",
            canary: canary({ canary_id: "operator-canary-2" }),
          })
      ).toThrow("different active canary");
    } finally {
      active.close();
    }
  });

  it("refuses to re-arm a revoked capability id but permits a fresh one", () => {
    const directory = path.join(root(), "activation");
    const controller = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    controller.admit({
      run_id: "run-canary",
      request_sha256: REQUEST_SHA256,
      profile_sha256: PROFILE_SHA256,
    });
    controller.finalizeRun({ run_id: "run-canary", outcome: "completed" });
    controller.close();

    expect(
      () => new SqliteImagegenActivationController({ directory, mode: "canary", canary: canary() })
    ).toThrow("cannot be re-armed");

    const fresh = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary({ canary_id: "operator-canary-2" }),
    });
    try {
      expect(fresh.status()).toMatchObject({
        canary: { canary_id: "operator-canary-2", state: "installed", run_id: null },
      });
    } finally {
      fresh.close();
    }
  });

  it("refuses to enable ordinary starts while a canary capability is still active", () => {
    const directory = path.join(root(), "activation");
    const controller = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    controller.admit({
      run_id: "run-canary",
      request_sha256: REQUEST_SHA256,
      profile_sha256: PROFILE_SHA256,
    });
    controller.close();
    expect(() => new SqliteImagegenActivationController({ directory, mode: "enabled" })).toThrow(
      "while a canary capability remains active"
    );
    const cleanup = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    cleanup.finalizeRun({ run_id: "run-canary", outcome: "completed" });
    cleanup.close();
    const enabled = new SqliteImagegenActivationController({ directory, mode: "enabled" });
    try {
      expect(enabled.status().mode).toBe("enabled");
      expect(
        enabled.admit({
          run_id: "run-ordinary",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        }).decision
      ).toBe("admitted_ordinary");
    } finally {
      enabled.close();
    }
  });

  it("fails closed when durable custody is broken", () => {
    const directory = path.join(root(), "activation");
    const controller = new SqliteImagegenActivationController({
      directory,
      mode: "canary",
      canary: canary(),
    });
    try {
      chmodSync(directory, 0o755);
      expect(() =>
        controller.admit({
          run_id: "run-1",
          request_sha256: REQUEST_SHA256,
          profile_sha256: PROFILE_SHA256,
        })
      ).toThrow("mode must be exactly 0700");
      chmodSync(directory, 0o700);
    } finally {
      controller.close();
    }
  });
});

describe("typed imagegen start admission activation gate", () => {
  function host(directory: string, mode: "disabled" | "enabled" | "canary") {
    const profile = syntheticProfile({ port: 8188 });
    return {
      profile,
      profiles: new StaticImagegenProfileRegistry({
        profiles: [profile],
        approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
        node_class_policies: SYNTHETIC_NODE_POLICIES,
        default_profile_id: profile.profile_id,
      }),
      exports: new StaticImagegenExportRegistry([]),
      storage: new SqliteImagegenStorageAdmission({
        directory: path.join(directory, "storage"),
        ceiling_bytes: 64 * 1024 * 1024,
        warning_threshold_bytes: 48 * 1024 * 1024,
      }),
      activation: new SqliteImagegenActivationController({
        directory: path.join(directory, "activation"),
        mode,
        ...(mode === "canary"
          ? {
              canary: {
                canary_id: "operator-canary",
                request_sha256: imagegenActivationRequestSha256({
                  goal: GOAL,
                  constraints: CONSTRAINTS,
                }),
                profile_sha256: profile.profile_sha256,
              },
            }
          : {}),
      }),
    };
  }

  it("denies a disabled start through the typed admission", () => {
    const directory = root();
    const providers = host(directory, "disabled");
    try {
      const error = denied(() =>
        IMAGEGEN_START_ADMISSION.prepare(startRequest("run-disabled"), { imagegen: providers })
      );
      expect(error.code).toBe("mode_disabled");
    } finally {
      providers.activation.close();
      providers.storage.close();
    }
  });

  it("admits the exact canary request through the typed admission and denies ordinary ones", () => {
    const directory = root();
    const providers = host(directory, "canary");
    try {
      const prepared = IMAGEGEN_START_ADMISSION.prepare(startRequest("run-canary"), {
        imagegen: providers,
      });
      expect(prepared.request.identity.run_id).toBe("run-canary");
      expect(providers.activation.status()).toMatchObject({
        canary: { state: "consumed", run_id: "run-canary" },
      });
      const error = denied(() =>
        IMAGEGEN_START_ADMISSION.prepare(startRequest("run-ordinary", "a different scene"), {
          imagegen: providers,
        })
      );
      expect(error.code).toBe("canary_request_drift");
    } finally {
      providers.activation.close();
      providers.storage.close();
    }
  });

  it("admits an ordinary start once the durable mode is enabled", () => {
    const directory = root();
    const providers = host(directory, "enabled");
    try {
      const prepared = IMAGEGEN_START_ADMISSION.prepare(startRequest("run-enabled"), {
        imagegen: providers,
      });
      expect(prepared.request.identity.run_id).toBe("run-enabled");
      expect(providers.activation.status().canary).toBeNull();
    } finally {
      providers.activation.close();
      providers.storage.close();
    }
  });
});

describe("imagegen activation boundary", () => {
  const packageRoot = path.resolve(import.meta.dirname, "..");

  it("admits only through the typed start admission seam", () => {
    const admission = readFileSync(
      path.join(packageRoot, "src/imagegen/start-admission.ts"),
      "utf8"
    );
    expect(admission).toContain("host.activation.admit(");
    // Status, cancel, step, and recover never reach start admission, so the disabled mode cannot
    // strand an existing run: no other module consults activation authority.
    for (const file of ["src/engine.ts", "src/worker.ts", "src/service.ts"]) {
      const source = readFileSync(path.join(packageRoot, file), "utf8");
      expect(source, file).not.toContain(".activation.admit(");
    }
  });
});
