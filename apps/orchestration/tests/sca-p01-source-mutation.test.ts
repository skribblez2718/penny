import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({ file: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (file: string | number | URL) => {
      if (typeof file === "number" && mutation.file !== "") {
        const target = mutation.file;
        mutation.file = "";
        fs.writeFileSync(target, "changed during read");
      }
      return fs.readFileSync(file);
    },
  };
});

import { ScaControlledHostHarness } from "../dist/sca/controlled-host-harness.js";
import { buildP01SourceSnapshotV2 } from "../dist/sca/p01-source-snapshot-builder.js";

const roots: string[] = [];
afterEach(() => {
  mutation.file = "";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a source mutated between fstat and read without publishing artifacts", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "penny-sca-source-change-"));
  roots.push(base);
  const file = path.join(base, "src", "main.ts");
  mkdirSync(path.dirname(file));
  writeFileSync(file, "original");
  using host = await ScaControlledHostHarness.provision({
    temporary_root: base,
    project_root: base,
    now_ms: 1_700_000_000_000,
    limits: { max_unique_artifact_bytes: 10_000, max_observations: 1 },
  });
  mutation.file = file;
  expect(() =>
    buildP01SourceSnapshotV2({
      source_root: base,
      store: host.artifacts,
      run_id: "mutation-run",
      snapshot_id: "mutation-snapshot",
      policy: {
        include_paths: ["src"],
        exclude_paths: [],
        max_files: 2,
        max_total_bytes: 1_000,
        max_file_bytes: 1_000,
        max_walk_entries: 10,
      },
    })
  ).toThrow(/source file changed during capture/);
  expect(mutation.file).toBe("");
  expect(
    host.artifacts.refFor(
      "mutation-run",
      "SCA-P01-source",
      null,
      "sca-p01-source-file-manifest",
      "source-manifest:mutation-snapshot",
      1
    )
  ).toBeNull();
});
