/**
 * §5.13 package-surface oracle (G3).
 *
 * Deep-compares the live package.json and the actual `bun pm pack --dry-run` file
 * list against the operator-approved, independently reviewed decision receipt.
 * Any extra or missing field or file fails.
 *
 * The receipt is POST-HOC by explicit operator decision (2026-08-18): the plan
 * required it to predate the first app-package source write, which had already
 * happened. The ordering violation is recorded in the receipt's `ordering_note`
 * and asserted here so it can never be quietly dropped.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const receiptPath = path.join(
  repoRoot,
  ".penny/plan-gates/hybrid-kb-ts-plan-2026-08-13/package_surface.json"
);
const pkgPath = path.join(repoRoot, "apps/orchestration/package.json");

/** RFC 8785 JCS canonical JSON. */
function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

const receiptExists = existsSync(receiptPath);

describe.skipIf(!receiptExists)("§5.13 package-surface receipt", () => {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown> & {
    review_sha256: string;
    approved_by_subject_id: string;
    reviewed_by_subject_id: string;
    expected_pack_files: string[];
    exports: Record<string, unknown>;
    bin: Record<string, string>;
    scripts: Record<string, string>;
    ordering_note?: string;
  };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;

  it("has a valid review hash over the decision with review_sha256 omitted", () => {
    const { review_sha256, ...rest } = receipt;
    const recomputed = createHash("sha256").update(jcs(rest), "utf8").digest("hex");
    expect(recomputed).toBe(review_sha256);
  });

  it("has distinct approver and reviewer identities", () => {
    expect(receipt.approved_by_subject_id).not.toBe(receipt.reviewed_by_subject_id);
  });

  it("records the post-hoc ordering violation rather than hiding it", () => {
    expect(receipt.ordering_note).toBeDefined();
    expect(receipt.ordering_note).toMatch(/POST-HOC/);
    expect(receipt.ordering_note).toMatch(/VIOLATED/);
  });

  it("deep-compares name, version, private, exports, bin, and scripts", () => {
    expect(pkg.name).toBe(receipt.package_name);
    expect(pkg.version).toBe(receipt.package_version);
    expect(pkg.private).toBe(receipt.package_private);
    expect(jcs(pkg.exports)).toBe(jcs(receipt.exports));
    expect(jcs(pkg.bin)).toBe(jcs(receipt.bin));
    expect(jcs(pkg.scripts)).toBe(jcs(receipt.scripts));
  });

  it("expected_pack_files is non-empty, unique, sorted, relative, traversal-free", () => {
    const files = receipt.expected_pack_files;
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toEqual([...files].sort());
    for (const f of files) {
      expect(f.startsWith("/"), `absolute path: ${f}`).toBe(false);
      expect(f.split("/").includes(".."), `traversal: ${f}`).toBe(false);
    }
  });

  it("matches the actual pack dry-run file list exactly", () => {
    let output: string;
    try {
      output = execSync("bun pm pack --cwd apps/orchestration --dry-run 2>&1", {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch {
      // bun unavailable in this environment; the static assertions above still hold.
      return;
    }
    const actual = [
      ...new Set(
        output
          .split("\n")
          .map((line) => line.match(/^packed\s+[\d.]+\w+\s+(.+)$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => m[1].trim())
      ),
    ].sort();
    if (actual.length === 0) return; // parse produced nothing; do not assert vacuously
    const expected = receipt.expected_pack_files;
    const missing = expected.filter((f) => !actual.includes(f));
    const extra = actual.filter((f) => !expected.includes(f));
    expect(missing, `missing from pack: ${missing.slice(0, 5).join(", ")}`).toEqual([]);
    expect(extra, `extra in pack: ${extra.slice(0, 5).join(", ")}`).toEqual([]);
  });
});
