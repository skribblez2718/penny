import { describe, expect, it } from "vitest";

import { sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ScaDependencyInventoryError,
  buildScaDependencyInventoryV1,
  validateScaDependencyInventoryResultV1,
} from "../src/adapters/dependency-inventory.js";

const SNAPSHOT = "a".repeat(64);

function manifest(path: string, value: unknown) {
  const content = JSON.stringify(value);
  return { path, sha256: sha256(content), content };
}

function inventoryInput() {
  return {
    schema_id: "penny.sca-dependency-inventory-input.v1",
    schema_version: 1,
    source_snapshot_sha256: SNAPSHOT,
    manifests: [
      manifest("web/package-lock.json", {
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", version: "1.0.0" },
          "node_modules/@scope/lib": { version: "2.3.4" },
          "node_modules/dev-only": { version: "5.0.0", dev: true },
        },
      }),
      manifest("composer.lock", {
        packages: [{ name: "vendor/runtime", version: "1.2.3" }],
        "packages-dev": [{ name: "vendor/dev", version: "dev-main" }],
      }),
    ],
  };
}

function expectInventoryError(run: () => unknown, code: ScaDependencyInventoryError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaDependencyInventoryError);
    if (error instanceof ScaDependencyInventoryError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected dependency inventory error '${code}'`);
}

describe("S-04-T3 dependency inventory", () => {
  it("records a complete empty ecosystem inventory when no lockfile is present", () => {
    const result = buildScaDependencyInventoryV1({
      schema_id: "penny.sca-dependency-inventory-input.v1",
      schema_version: 1,
      source_snapshot_sha256: SNAPSHOT,
      manifests: [],
    });
    expect(result).toMatchObject({ status: "succeeded", manifests: [], coordinates: [] });
    expect(validateScaDependencyInventoryResultV1(result)).toEqual(result);
  });

  it("extracts deterministic exact npm and Composer coordinates", () => {
    const input = inventoryInput();
    const before = JSON.stringify(input);
    const result = buildScaDependencyInventoryV1(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result.status).toBe("succeeded");
    expect(result.coordinates).toEqual([
      expect.objectContaining({
        ecosystem: "Packagist",
        name: "vendor/dev",
        version: "dev-main",
        scope: "development",
        purl: "pkg:composer/vendor/dev@dev-main",
      }),
      expect.objectContaining({
        ecosystem: "Packagist",
        name: "vendor/runtime",
        version: "1.2.3",
        scope: "runtime",
        purl: "pkg:composer/vendor/runtime@1.2.3",
      }),
      expect.objectContaining({
        ecosystem: "npm",
        name: "@scope/lib",
        version: "2.3.4",
        scope: "runtime",
        purl: "pkg:npm/%40scope/lib@2.3.4",
      }),
      expect.objectContaining({
        ecosystem: "npm",
        name: "dev-only",
        version: "5.0.0",
        scope: "development",
      }),
    ]);
    expect(validateScaDependencyInventoryResultV1(result)).toEqual(result);
  });

  it("supports nested npm lockfile v1 dependencies with a depth bound", () => {
    const input = {
      ...inventoryInput(),
      manifests: [
        manifest("package-lock.json", {
          name: "legacy",
          lockfileVersion: 1,
          dependencies: {
            alpha: {
              version: "1.0.0",
              dependencies: { beta: { version: "2.0.0", dev: true } },
            },
          },
        }),
      ],
    };
    const result = buildScaDependencyInventoryV1(input);
    expect(
      result.coordinates.map(({ name, version, scope }) => ({ name, version, scope }))
    ).toEqual([
      { name: "alpha", version: "1.0.0", scope: "runtime" },
      { name: "beta", version: "2.0.0", scope: "development" },
    ]);
  });

  it("keeps unsupported and invalid manifests explicit", () => {
    const invalidContent = "not-json";
    const result = buildScaDependencyInventoryV1({
      ...inventoryInput(),
      manifests: [
        { path: "other.lock", sha256: sha256("{}"), content: "{}" },
        { path: "bad/package-lock.json", sha256: sha256(invalidContent), content: invalidContent },
        manifest("composer.lock", { packages: [], "packages-dev": [] }),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.manifests.map(({ status, error_code }) => ({ status, error_code }))).toEqual([
      { status: "failed", error_code: "invalid_json" },
      { status: "succeeded", error_code: "none" },
      { status: "unsupported", error_code: "unsupported_manifest" },
    ]);
  });

  it("rejects unknown input, unsafe/colliding paths, content drift, and result drift", () => {
    const input = inventoryInput();
    expectInventoryError(
      () => buildScaDependencyInventoryV1({ ...input, unexpected: true }),
      "invalid_input"
    );
    expectInventoryError(
      () =>
        buildScaDependencyInventoryV1({
          ...input,
          manifests: [{ ...input.manifests[0], path: "../package-lock.json" }],
        }),
      "unsafe_path"
    );
    expectInventoryError(
      () =>
        buildScaDependencyInventoryV1({
          ...input,
          manifests: [
            { ...input.manifests[0], path: "A/package-lock.json" },
            { ...input.manifests[0], path: "a/package-lock.json" },
          ],
        }),
      "path_collision"
    );
    expectInventoryError(
      () =>
        buildScaDependencyInventoryV1({
          ...input,
          manifests: [{ ...input.manifests[0], content: "{}" }],
        }),
      "digest_mismatch"
    );
    const result = buildScaDependencyInventoryV1(input);
    expectInventoryError(
      () => validateScaDependencyInventoryResultV1({ ...result, inventory_sha256: SNAPSHOT }),
      "invalid_input"
    );
  });
});
