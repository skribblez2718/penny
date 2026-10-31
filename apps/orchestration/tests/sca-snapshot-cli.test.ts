import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runScaSnapshotCliV1 } from "../dist/sca-snapshot-cli.js";
import {
  computeScaSourceSnapshotSha256,
  describeScaSourceSnapshotV1,
} from "../dist/playbooks/sca.js";
import { sha256 } from "../dist/canonical-json.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "penny-sca-snapshot-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

describe("SCA source snapshot CLI", () => {
  it("uses root scope semantics and the exact active digest representation", () => {
    const root = fixture();
    const description = describeScaSourceSnapshotV1({
      source_root: root,
      scope: { include: ["."], exclude: [] },
    });
    expect(description.files.map((entry) => entry.path)).toEqual(["a.ts", "src/b.ts"]);
    expect(description.source_snapshot_sha256).toBe(
      computeScaSourceSnapshotSha256({
        scope: { include: ["."], exclude: [] },
        files: [
          {
            path: "a.ts",
            byte_length: Buffer.byteLength("export const a = 1;\n"),
            content_sha256: sha256("export const a = 1;\n"),
          },
          {
            path: "src/b.ts",
            byte_length: Buffer.byteLength("export const b = 2;\n"),
            content_sha256: sha256("export const b = 2;\n"),
          },
        ],
      })
    );
    expect(
      describeScaSourceSnapshotV1({
        source_root: root,
        scope: { include: [], exclude: ["."] },
      }).files
    ).toEqual([]);
  });

  it("writes one canonical stdout record or a new owner-only manifest", () => {
    const root = fixture();
    let stdout = "";
    runScaSnapshotCliV1([`--source-root=${root}`, "--include=."], (value) => {
      stdout += value;
    });
    expect(stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_id: "penny.sca-source-snapshot-description.v1",
      source_root: root,
      scope: { include: ["."], exclude: [] },
    });

    const output = path.join(root, "manifest.json");
    runScaSnapshotCliV1([`--source-root=${root}`, "--include=src", `--output=${output}`]);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      scope: { include: ["src"], exclude: [] },
    });
  });

  it("refuses to overwrite or remove an existing output", () => {
    const root = fixture();
    const output = path.join(root, "existing.json");
    writeFileSync(output, "keep", { mode: 0o600 });
    chmodSync(output, 0o600);
    expect(() => runScaSnapshotCliV1([`--source-root=${root}`, `--output=${output}`])).toThrow();
    expect(readFileSync(output, "utf8")).toBe("keep");
  });
});
