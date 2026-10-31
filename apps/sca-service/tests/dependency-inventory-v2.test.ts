import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ScaDependencyInventoryV2Error,
  buildScaDependencyInventoryV2,
  scaDependencyCoordinateIdV2,
  scaJsonPointerToken,
  validateScaDependencyInventoryResultV2,
  type ScaDependencyInventoryResultV2,
} from "../src/adapters/dependency-inventory-v2.js";

const SNAPSHOT = "a".repeat(64);

type Ecosystem = "npm" | "Packagist";
type Role = "manifest" | "lockfile";

function document(
  ecosystem: Ecosystem,
  project_path: string,
  role: Role,
  path: string,
  value: unknown,
  raw = false
) {
  const content = raw && typeof value === "string" ? value : JSON.stringify(value);
  return { ecosystem, project_path, role, path, sha256: sha256(content), content };
}

function input(
  documents: ReturnType<typeof document>[],
  ecosystems: Ecosystem[] = ["npm", "Packagist"]
) {
  return {
    schema_id: "penny.sca-dependency-inventory-input.v2",
    schema_version: 2,
    source_snapshot_sha256: SNAPSHOT,
    ecosystems,
    documents,
  };
}

function redigest(result: ScaDependencyInventoryResultV2): ScaDependencyInventoryResultV2 {
  const { inventory_sha256: digest, ...unsigned } = result;
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  return { ...unsigned, inventory_sha256: sha256(canonicalJson(unsigned)) };
}

function redigestEdge(
  edge: ScaDependencyInventoryResultV2["edges"][number]
): ScaDependencyInventoryResultV2["edges"][number] {
  const { edge_id: digest, ...unsigned } = edge;
  expect(digest).toMatch(/^depedge_[a-f0-9]{64}$/u);
  return {
    edge_id: `depedge_${sha256(canonicalJson({ source_snapshot_sha256: SNAPSHOT, ...unsigned }))}`,
    ...unsigned,
  };
}

function expectInventoryError(
  run: () => unknown,
  code: ScaDependencyInventoryV2Error["code"]
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaDependencyInventoryV2Error);
    if (error instanceof ScaDependencyInventoryV2Error) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected dependency inventory v2 error '${code}'`);
}

describe("SCA-P02 path-resolved dependency inventory v2", () => {
  it("retains the inactive v2 ID while exposing the atomically updated edge shape", () => {
    const admitted = input([]);
    const result = buildScaDependencyInventoryV2(admitted);
    expect(result).toMatchObject({
      schema_id: "penny.sca-dependency-inventory-result.v2",
      schema_version: 2,
      status: "succeeded",
      edges: [],
    });
    expect(result.ecosystems).toEqual([
      {
        ecosystem: "Packagist",
        state: "absent",
        project_count: 0,
        occurrence_count: 0,
        coordinate_count: 0,
        edge_count: 0,
      },
      {
        ecosystem: "npm",
        state: "absent",
        project_count: 0,
        occurrence_count: 0,
        coordinate_count: 0,
        edge_count: 0,
      },
    ]);
    expect(validateScaDependencyInventoryResultV2(result, admitted)).toEqual(result);
  });

  it("resolves nested npm versions and hoisted children without copying a root constraint", () => {
    const result = buildScaDependencyInventoryV2(
      input(
        [
          document("npm", ".", "manifest", "package.json", {
            dependencies: { alpha: "^1.0.0", parent: "1.0.0" },
          }),
          document("npm", ".", "lockfile", "package-lock.json", {
            lockfileVersion: 3,
            packages: {
              "": {
                name: "root",
                version: "1.0.0",
                dependencies: { alpha: "^1.0.0", parent: "1.0.0" },
              },
              "node_modules/alpha": { name: "alpha", version: "1.4.0" },
              "node_modules/parent": {
                name: "parent",
                version: "1.0.0",
                dependencies: { alpha: "^2.0.0", beta: "^3.0.0" },
              },
              "node_modules/parent/node_modules/alpha": { name: "alpha", version: "2.2.0" },
              "node_modules/beta": { name: "beta", version: "3.1.0" },
            },
          }),
        ],
        ["npm"]
      )
    );

    const alphaV1 = result.occurrences.find((item) => item.version === "1.4.0");
    const alphaV2 = result.occurrences.find((item) => item.version === "2.2.0");
    const beta = result.occurrences.find((item) => item.name === "beta");
    if (alphaV1 === undefined || alphaV2 === undefined || beta === undefined) {
      throw new Error("expected nested npm fixture occurrences");
    }
    expect(alphaV1.constraints).toEqual([
      expect.objectContaining({ constraint: "^1.0.0", source_json_pointer: "/dependencies/alpha" }),
    ]);
    expect(alphaV2.constraints).toEqual([
      expect.objectContaining({
        constraint: "^2.0.0",
        source_json_pointer: "/packages/node_modules~1parent/dependencies/alpha",
      }),
    ]);
    expect(beta.constraints).toEqual([
      expect.objectContaining({
        constraint: "^3.0.0",
        source_json_pointer: "/packages/node_modules~1parent/dependencies/beta",
      }),
    ]);
    expect(
      result.edges.find((edge) => edge.constraint === "^2.0.0" && edge.child_name === "alpha")
    ).toMatchObject({
      parent_kind: "occurrence",
      child_occurrence_id: alphaV2.occurrence_id,
      ambiguity_status: "unambiguous",
      scope: "runtime",
    });
    expect(result.edges.find((edge) => edge.constraint === "^3.0.0")?.child_occurrence_id).toBe(
      beta.occurrence_id
    );
  });

  it("records optional and peer scopes with RFC 6901 escaping", () => {
    const escapedName = "@scope/pkg~name";
    expect(scaJsonPointerToken(escapedName)).toBe("@scope~1pkg~0name");
    const result = buildScaDependencyInventoryV2(
      input(
        [
          document("npm", ".", "manifest", "package.json", {
            optionalDependencies: { [escapedName]: "^1" },
            peerDependencies: { peerlib: "^2" },
          }),
          document("npm", ".", "lockfile", "package-lock.json", {
            lockfileVersion: 3,
            packages: {
              "": {
                optionalDependencies: { [escapedName]: "^1" },
                peerDependencies: { peerlib: "^2" },
              },
              [`node_modules/${escapedName}`]: {
                name: escapedName,
                version: "1.2.0",
                optional: true,
              },
              "node_modules/peerlib": { name: "peerlib", version: "2.1.0", peer: true },
            },
          }),
        ],
        ["npm"]
      )
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          child_name: escapedName,
          scope: "optional",
          source_json_pointer: "/optionalDependencies/@scope~1pkg~0name",
        }),
        expect.objectContaining({
          child_name: "peerlib",
          scope: "peer",
          source_json_pointer: "/peerDependencies/peerlib",
        }),
      ])
    );
  });

  it("maps a shared-root npm link occurrence to its exact versioned workspace target", () => {
    const admitted = input(
      [
        document("npm", ".", "manifest", "package.json", {
          dependencies: { app: "workspace:*" },
        }),
        document("npm", "packages/app", "manifest", "packages/app/package.json", {
          name: "app",
          dependencies: { shared: "^1" },
        }),
        document("npm", ".", "lockfile", "package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { app: "workspace:*" } },
            "packages/app": { name: "app", version: "1.0.0", dependencies: { shared: "^1" } },
            "node_modules/app": { resolved: "packages/app", link: true },
            "node_modules/shared": { name: "shared", version: "1.1.0" },
          },
        }),
      ],
      ["npm"]
    );
    const result = buildScaDependencyInventoryV2(admitted);

    const workspaceProject = result.projects.find(
      (project) => project.project_path === "packages/app"
    );
    expect(workspaceProject).toMatchObject({
      state: "supported",
      manifest_path: "packages/app/package.json",
      lockfile_path: "package-lock.json",
      edge_count: 1,
    });
    const linkOccurrence = result.occurrences.find(
      (occurrence) => occurrence.lock_path === "node_modules/app"
    );
    const workspaceTarget = result.occurrences.find(
      (occurrence) => occurrence.lock_path === "packages/app"
    );
    if (linkOccurrence === undefined || workspaceTarget === undefined) {
      throw new Error("expected explicit workspace link and target occurrences");
    }
    expect(linkOccurrence).toMatchObject({
      name: "app",
      version: null,
      coordinate_id: null,
      workspace_link: true,
      link_resolved_path: "packages/app",
      link_target_occurrence_id: workspaceTarget.occurrence_id,
    });
    expect(workspaceTarget).toMatchObject({
      name: "app",
      version: "1.0.0",
      coordinate_id: scaDependencyCoordinateIdV2("npm", "app", "1.0.0"),
      workspace_link: false,
      link_resolved_path: null,
      link_target_occurrence_id: null,
    });
    expect(workspaceTarget.constraints).toEqual([
      {
        source_document_path: "package.json",
        source_json_pointer: "/dependencies/app",
        constraint: "workspace:*",
        scope: "runtime",
      },
    ]);
    const rootWorkspaceEdge = result.edges.find((edge) => edge.child_name === "app");
    expect(rootWorkspaceEdge).toMatchObject({
      child_occurrence_id: workspaceTarget.occurrence_id,
      child_coordinate_id: workspaceTarget.coordinate_id,
      workspace_link_occurrence_id: linkOccurrence.occurrence_id,
      candidate_occurrence_ids: [workspaceTarget.occurrence_id],
      ambiguity_status: "unambiguous",
    });
    expect(rootWorkspaceEdge?.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "manifest", document_path: "package.json" }),
        expect.objectContaining({
          kind: "workspace_link",
          source_json_pointer: "/packages/node_modules~1app/link",
        }),
        expect.objectContaining({
          kind: "workspace_link",
          source_json_pointer: "/packages/node_modules~1app/resolved",
        }),
      ])
    );
    const workspaceEdge = result.edges.find(
      (edge) => edge.project_path === "packages/app" && edge.child_name === "shared"
    );
    const workspaceParent = result.occurrences.find(
      (occurrence) => occurrence.lock_path === "packages/app"
    );
    expect(workspaceEdge).toMatchObject({
      parent_kind: "occurrence",
      parent_occurrence_id: workspaceParent?.occurrence_id,
      ambiguity_status: "unambiguous",
    });
    expect(validateScaDependencyInventoryResultV2(result, admitted)).toEqual(result);
  });

  it("marks an npm workspace link with a noncanonical resolved target incomplete", () => {
    const admitted = input(
      [
        document("npm", ".", "manifest", "package.json", {
          dependencies: { app: "workspace:*" },
        }),
        document("npm", ".", "lockfile", "package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { app: "workspace:*" } },
            "node_modules/app": { resolved: "../packages/app", link: true },
          },
        }),
      ],
      ["npm"]
    );
    const result = buildScaDependencyInventoryV2(admitted);
    expect(result).toMatchObject({ status: "partial" });
    expect(result.occurrences.find((occurrence) => occurrence.workspace_link)).toMatchObject({
      link_resolved_path: null,
      link_target_occurrence_id: null,
    });
    expect(result.edges[0]).toMatchObject({
      child_occurrence_id: null,
      child_coordinate_id: null,
      ambiguity_status: "unresolved",
    });
    expect(
      result.documents.find((documentResult) => documentResult.role === "lockfile")
    ).toMatchObject({ state: "partial", error_code: "unresolved_relationship" });
    expect(validateScaDependencyInventoryResultV2(result, admitted)).toEqual(result);
  });

  it("resolves Composer root and transitive requires and reports ambiguous occurrences partial", () => {
    const unambiguous = buildScaDependencyInventoryV2(
      input(
        [
          document("Packagist", ".", "manifest", "composer.json", {
            require: { "vendor/a": "^1" },
          }),
          document("Packagist", ".", "lockfile", "composer.lock", {
            packages: [
              { name: "vendor/a", version: "1.0.0", require: { "vendor/b": "^2" } },
              { name: "vendor/b", version: "2.1.0" },
            ],
            "packages-dev": [],
          }),
        ],
        ["Packagist"]
      )
    );
    expect(unambiguous.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parent_kind: "project_root",
          child_name: "vendor/a",
          source_json_pointer: "/require/vendor~1a",
          ambiguity_status: "unambiguous",
        }),
        expect.objectContaining({
          parent_kind: "occurrence",
          child_name: "vendor/b",
          source_json_pointer: "/packages/0/require/vendor~1b",
          ambiguity_status: "unambiguous",
        }),
      ])
    );
    const composerTransitive = unambiguous.occurrences.find(
      (occurrence) => occurrence.name === "vendor/b"
    );
    expect(composerTransitive?.constraints).toEqual([
      {
        source_document_path: "composer.lock",
        source_json_pointer: "/packages/0/require/vendor~1b",
        constraint: "^2",
        scope: "runtime",
      },
    ]);

    const ambiguous = buildScaDependencyInventoryV2(
      input(
        [
          document("Packagist", ".", "manifest", "composer.json", {
            require: { "vendor/a": "^1" },
          }),
          document("Packagist", ".", "lockfile", "composer.lock", {
            packages: [
              { name: "vendor/a", version: "1.0.0", require: { "vendor/b": "^2" } },
              { name: "vendor/b", version: "2.1.0" },
              { name: "vendor/b", version: "3.0.0" },
            ],
            "packages-dev": [],
          }),
        ],
        ["Packagist"]
      )
    );
    const ambiguousEdge = ambiguous.edges.find((edge) => edge.child_name === "vendor/b");
    expect(ambiguous).toMatchObject({ status: "partial" });
    expect(ambiguousEdge).toMatchObject({
      child_occurrence_id: null,
      ambiguity_status: "ambiguous",
      diagnostic_code: "ambiguous_target",
    });
    expect(ambiguousEdge?.candidate_occurrence_ids).toHaveLength(2);
    expect(
      ambiguous.occurrences
        .filter((occurrence) => occurrence.name === "vendor/b")
        .flatMap((occurrence) => occurrence.constraints)
    ).toEqual([]);
    expect(ambiguous.documents.find((item) => item.role === "lockfile")).toMatchObject({
      state: "partial",
      error_code: "ambiguous_relationship",
    });
  });

  it("keeps malformed and unsupported lock states distinct", () => {
    const malformed = buildScaDependencyInventoryV2(
      input(
        [
          document("npm", ".", "manifest", "package.json", {}),
          document("npm", ".", "lockfile", "package-lock.json", "not-json", true),
        ],
        ["npm"]
      )
    );
    expect(malformed).toMatchObject({ status: "failed" });
    expect(malformed.ecosystems[0]?.state).toBe("malformed");

    const unsupported = buildScaDependencyInventoryV2(
      input(
        [
          document("npm", ".", "manifest", "package.json", {}),
          document("npm", ".", "lockfile", "package-lock.json", { lockfileVersion: 99 }),
        ],
        ["npm"]
      )
    );
    expect(unsupported.status).toBe("partial");
    expect(unsupported.ecosystems[0]?.state).toBe("unsupported");
  });

  it("semantic validation rejects recomputed-digest mapping and aggregate mutations", () => {
    const admitted = input(
      [
        document("npm", ".", "manifest", "package.json", { dependencies: { alpha: "^1" } }),
        document("npm", ".", "lockfile", "package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { alpha: "^1" } },
            "node_modules/alpha": { name: "alpha", version: "1.0.0" },
          },
        }),
      ],
      ["npm"]
    );
    const result = buildScaDependencyInventoryV2(admitted);
    expect(validateScaDependencyInventoryResultV2(result, admitted)).toEqual(result);

    const mutatedCount = redigest({
      ...result,
      ecosystems: [{ ...result.ecosystems[0], occurrence_count: 0 }],
    });
    expectInventoryError(
      () => validateScaDependencyInventoryResultV2(mutatedCount, admitted),
      "semantic_mismatch"
    );

    const edge = result.edges[0];
    if (edge === undefined) throw new Error("expected a dependency edge");
    const mutatedEdge = redigest({
      ...result,
      edges: [{ ...edge, child_occurrence_id: null }],
    });
    expectInventoryError(
      () => validateScaDependencyInventoryResultV2(mutatedEdge, admitted),
      "semantic_mismatch"
    );
  });

  it("rejects a cross-project edge even after every affected relationship is redigested", () => {
    const admitted = input(
      [
        document("npm", "a", "manifest", "a/package.json", {
          dependencies: { alpha: "^1" },
        }),
        document("npm", "a", "lockfile", "a/package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { alpha: "^1" } },
            "node_modules/alpha": { name: "alpha", version: "1.0.0" },
          },
        }),
        document("npm", "b", "manifest", "b/package.json", {}),
        document("npm", "b", "lockfile", "b/package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/alpha": { name: "alpha", version: "1.0.0" },
          },
        }),
      ],
      ["npm"]
    );
    const result = buildScaDependencyInventoryV2(admitted);
    const edge = result.edges[0];
    const projectA = result.occurrences.find(
      (occurrence) =>
        occurrence.lockfile_path === "a/package-lock.json" && occurrence.name === "alpha"
    );
    const projectB = result.occurrences.find(
      (occurrence) =>
        occurrence.lockfile_path === "b/package-lock.json" && occurrence.name === "alpha"
    );
    const movedConstraint = projectA?.constraints[0];
    if (
      edge === undefined ||
      projectA === undefined ||
      projectB === undefined ||
      movedConstraint === undefined
    ) {
      throw new Error("expected cross-project mutation fixture");
    }
    const forgedEdge = redigestEdge({
      ...edge,
      child_occurrence_id: projectB.occurrence_id,
      child_coordinate_id: projectB.coordinate_id,
      candidate_occurrence_ids: [projectB.occurrence_id],
    });
    const forged = redigest({
      ...result,
      edges: [forgedEdge],
      occurrences: result.occurrences.map((occurrence) =>
        occurrence.occurrence_id === projectA.occurrence_id
          ? { ...occurrence, constraints: [] }
          : occurrence.occurrence_id === projectB.occurrence_id
            ? { ...occurrence, constraints: [movedConstraint] }
            : occurrence
      ),
    });

    expectInventoryError(
      () => validateScaDependencyInventoryResultV2(forged, admitted),
      "semantic_mismatch"
    );
  });

  it("rejects unsafe paths and exact document digest drift", () => {
    const manifest = document("npm", ".", "manifest", "package.json", {});
    expectInventoryError(
      () =>
        buildScaDependencyInventoryV2(input([{ ...manifest, path: "../package.json" }], ["npm"])),
      "unsafe_path"
    );
    expectInventoryError(
      () =>
        buildScaDependencyInventoryV2(input([{ ...manifest, sha256: "b".repeat(64) }], ["npm"])),
      "digest_mismatch"
    );
  });
});
