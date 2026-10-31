import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScaP03DeploymentBundleV1,
  stageScaP03DeploymentFilesV1,
} from "../src/p03-deployment-preparation.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "p03-deployment-")));
  chmodSync(root, 0o700);
  roots.push(root);
  const source = path.join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const entry = path.join(source, "entry.ts");
  writeFileSync(entry, "export const answer: number = 42;\n", { mode: 0o664 });
  return { root, source, entry, target: path.join(root, "new-deployment") };
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function plan(f: ReturnType<typeof fixture>) {
  return {
    deployment_root: f.target,
    max_file_bytes: 1024,
    max_total_bytes: 2048,
    files: [
      {
        source_path: f.entry,
        target_relative: "source/entry.ts",
        sha256: digest(f.entry),
        mode: 0o400,
      },
    ],
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("explicit private deployment staging", () => {
  it("copies exact bytes, breaks installed hardlinks, protects new files without chmod on sources", () => {
    const f = fixture();
    linkSync(f.entry, path.join(f.source, "hardlink.ts"));
    const before = lstatSync(f.entry);
    const receipt = stageScaP03DeploymentFilesV1(plan(f));
    const deployed = path.join(f.target, "source/entry.ts");
    expect(readFileSync(deployed)).toEqual(readFileSync(f.entry));
    expect(lstatSync(deployed).nlink).toBe(1);
    expect(lstatSync(deployed).mode & 0o777).toBe(0o400);
    expect(lstatSync(f.target).mode & 0o777).toBe(0o700);
    expect(lstatSync(f.entry).mode).toBe(before.mode);
    expect(lstatSync(f.entry).ino).toBe(before.ino);
    expect(receipt.assurance).toBe("measured_files_only_not_runtime_authority");
    expect(receipt.files[0]?.sha256).toBe(digest(deployed));
    expect(JSON.parse(readFileSync(path.join(f.target, "deployment-files.json"), "utf8"))).toEqual(
      receipt
    );
    expect(() => stageScaP03DeploymentFilesV1(plan(f))).toThrow();
  });
  it.each([
    "../escape.ts",
    "/escape.ts",
    "x/../escape.ts",
    "x//escape.ts",
    ".env",
    "auth.json",
    "x/key.pem",
    "credentials.json",
  ])("refuses traversal and secret target %s before creating anything", (target) => {
    const f = fixture();
    const input = plan(f);
    const first = input.files[0];
    if (first === undefined) throw new Error("fixture file missing");
    first.target_relative = target;
    expect(() => stageScaP03DeploymentFilesV1(input)).toThrow();
    expect(existsSync(f.target)).toBe(false);
  });
  it("refuses source symlinks, drift, duplicates, prefix collisions, budgets and unknown fields", () => {
    const f = fixture();
    const input = plan(f);
    const first = input.files[0];
    if (first === undefined) throw new Error("fixture file missing");
    symlinkSync(f.entry, path.join(f.source, "link.ts"));
    expect(() =>
      stageScaP03DeploymentFilesV1({
        ...input,
        files: [{ ...first, source_path: path.join(f.source, "link.ts") }],
      })
    ).toThrow();
    expect(() =>
      stageScaP03DeploymentFilesV1({ ...input, files: [{ ...first, sha256: "0".repeat(64) }] })
    ).toThrow("digest");
    expect(() => stageScaP03DeploymentFilesV1({ ...input, files: [first, first] })).toThrow(
      "duplicate"
    );
    expect(() =>
      stageScaP03DeploymentFilesV1({
        ...input,
        files: [{ ...first, target_relative: "source" }, first],
      })
    ).toThrow("collision");
    expect(() => stageScaP03DeploymentFilesV1({ ...input, max_total_bytes: 1 })).toThrow("limit");
    expect(() => stageScaP03DeploymentFilesV1({ ...input, max_file_bytes: 1 })).toThrow("custody");
    expect(() => stageScaP03DeploymentFilesV1({ ...input, create_store: true })).toThrow();
    expect(existsSync(f.target)).toBe(false);
    const secret = path.join(f.source, ".env");
    writeFileSync(secret, "fixture only");
    expect(() =>
      stageScaP03DeploymentFilesV1({
        ...input,
        files: [{ ...first, source_path: secret, sha256: digest(secret) }],
      })
    ).toThrow("relative_path");
    expect(existsSync(f.target)).toBe(false);
  });
  it("refuses writable destination ancestors without repairing them", () => {
    const f = fixture();
    chmodSync(f.root, 0o770);
    expect(() => stageScaP03DeploymentFilesV1(plan(f))).toThrow("writable_ancestor");
    expect(lstatSync(f.root).mode & 0o777).toBe(0o770);
    expect(existsSync(f.target)).toBe(false);
  });
});

describe("real installed bundler, not a callback stand-in", () => {
  function buildPlan(f: ReturnType<typeof fixture>, name: string) {
    // Test host supplies its actual installed tool paths; production helper has no discovery/default.
    const found = spawnSync("which", ["bun"], { encoding: "utf8", maxBuffer: 4096 });
    if (found.status !== 0) throw new Error("installed Bun required for deployment build evidence");
    const bun = realpathSync(found.stdout.trim());
    const node = realpathSync(process.execPath);
    return {
      source_project_root: f.source,
      build_root: path.join(f.root, name),
      bun_executable: bun,
      bun_sha256: digest(bun),
      node_executable: node,
      node_sha256: digest(node),
      entrypoint: f.entry,
      entrypoint_sha256: digest(f.entry),
      external_packages: [],
    };
  }
  it("builds twice byte-identically and executes only Node syntax checking", () => {
    const f = fixture();
    writeFileSync(
      f.entry,
      `import {writeFileSync} from 'node:fs'; export function mustNotRun(){writeFileSync(${JSON.stringify(path.join(f.root, "forbidden"))}, 'bad');} export const answer: number = 42;\n`
    );
    const one = buildScaP03DeploymentBundleV1(buildPlan(f, "build-one"));
    const two = buildScaP03DeploymentBundleV1(buildPlan(f, "build-two"));
    expect(one.status).toBe("syntax_checked_bundle_only");
    expect(one.bundle_sha256).toBe(two.bundle_sha256);
    expect(existsSync(path.join(f.root, "forbidden"))).toBe(false);
    expect(lstatSync(path.join(f.root, "build-one/runtime.mjs")).mode & 0o777).toBe(0o400);
  });
  it("records a real opaque runtime import blocker and publishes no runtime", () => {
    const f = fixture();
    writeFileSync(f.entry, "export function unresolved(name: string) { return import(name); }\n");
    const result = buildScaP03DeploymentBundleV1(buildPlan(f, "blocked"));
    expect(result.status).toBe("blocked");
    expect(result.diagnostic).toContain("not a string literal");
    expect(result.bundle_sha256).toBe(null);
    expect(existsSync(path.join(f.root, "blocked/runtime.mjs"))).toBe(false);
  });
  it("refuses changed tool pins and checkout output paths before build", () => {
    const f = fixture();
    const input = buildPlan(f, "build");
    expect(() => buildScaP03DeploymentBundleV1({ ...input, bun_sha256: "0".repeat(64) })).toThrow(
      "digest"
    );
    expect(() =>
      buildScaP03DeploymentBundleV1({ ...input, build_root: path.join(f.source, "dist") })
    ).toThrow("boundary");
    expect(() =>
      buildScaP03DeploymentBundleV1({ ...input, entrypoint_sha256: "0".repeat(64) })
    ).toThrow("entrypoint_digest");
    expect(existsSync(input.build_root)).toBe(false);
    expect(existsSync(path.join(f.source, "dist"))).toBe(false);
  });
});
