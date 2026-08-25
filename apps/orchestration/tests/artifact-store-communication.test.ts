import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "penny-artifact-store-"));
  roots.push(value);
  chmodSync(value, 0o700);
  return value;
}

describe("ArtifactStore communication manifest", () => {
  it("looks up and reads exact IDs across runs without a consumer", () => {
    using store = new ArtifactStore(root());
    const first = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-a",
        phase: "phase-a",
        branch_id: null,
        kind: "agent-output",
        operation_id: "operation-a",
        version: 1,
        producer: "agent:annie",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "alpha",
    });
    const second = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-b",
        phase: "phase-b",
        branch_id: null,
        kind: "agent-output",
        operation_id: "operation-b",
        version: 1,
        producer: "agent:synthia",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [first],
      },
      content: "beta",
    });
    expect(store.refById(first.artifact_id)).toEqual(first);
    expect(store.readById(first.artifact_id).toString()).toBe("alpha");
    expect(store.readById(second.artifact_id).toString()).toBe("beta");
    expect(second.schema_version).toBe(2);
    expect(second).not.toHaveProperty("consumer_scope");
  });

  it("does not return a ref when object or manifest persistence fails", () => {
    const objectFailureRoot = root();
    using objectFailureStore = new ArtifactStore(objectFailureRoot);
    const content = Buffer.from("blocked object", "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    const destination = join(
      objectFailureRoot,
      "objects",
      "sha256",
      digest.slice(0, 2),
      digest.slice(2)
    );
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    expect(() =>
      objectFailureStore.persist({
        metadata: {
          schema_version: 2,
          run_id: "object-failure",
          phase: "phase",
          branch_id: null,
          kind: "agent-output",
          operation_id: "object-failure-operation",
          version: 1,
          producer: "agent:fixture",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content,
      })
    ).toThrow(/wrong type/);

    const manifestFailureRoot = root();
    const manifestFailureStore = new ArtifactStore(manifestFailureRoot);
    manifestFailureStore.close();
    expect(() =>
      manifestFailureStore.persist({
        metadata: {
          schema_version: 2,
          run_id: "manifest-failure",
          phase: "phase",
          branch_id: null,
          kind: "agent-output",
          operation_id: "manifest-failure-operation",
          version: 1,
          producer: "agent:fixture",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: "no ref",
      })
    ).toThrow();
  });

  it("binds the manifest to one opaque project partition", () => {
    const artifactRoot = root();
    const firstProject = `prj_${"1".repeat(32)}`;
    const secondProject = `prj_${"2".repeat(32)}`;
    const first = new ArtifactStore(artifactRoot, { projectId: firstProject });
    first.close();
    expect(() => new ArtifactStore(artifactRoot, { projectId: secondProject })).toThrow(
      "belongs to another Penny project"
    );
  });

  it("uses only the stable unversioned canonical manifest", () => {
    const artifactRoot = root();
    using _store = new ArtifactStore(artifactRoot);
    expect(existsSync(join(artifactRoot, "manifest.db"))).toBe(true);
    expect(existsSync(join(artifactRoot, "manifest-v2.db"))).toBe(false);
  });

  it("does not inspect or import a legacy manifest during ordinary construction", () => {
    const artifactRoot = root();
    const legacyPath = join(artifactRoot, "manifest.sqlite3");
    const legacyBytes = Buffer.from("not even a SQLite database", "utf8");
    writeFileSync(legacyPath, legacyBytes, { mode: 0o600 });

    using store = new ArtifactStore(artifactRoot);
    expect(store.refById(`art_${"0".repeat(64)}`)).toBeUndefined();
    expect(readFileSync(legacyPath)).toEqual(legacyBytes);
  });
});
