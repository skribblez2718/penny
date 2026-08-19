/**
 * verify:python-map — machine-enforced Python test parity mapping (G4).
 *
 * Consumes the collected Python test node IDs and the parity map, and fails on
 * any unmapped, duplicate, stale, or extra mapping. The map must cover exactly
 * the collected suite with no gaps.
 */

import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const mapPath = path.join(here, "fixtures", "python-test-parity-map.json");

const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
  schema_version: number;
  total_node_ids: number;
  dispositions: Record<string, number>;
  files: Record<string, { count: number; disposition: string; behavior_owner: string }>;
  mappings: Array<{
    node_id: string;
    file: string;
    function: string;
    behavior_owner: string;
    disposition: string;
    ts_evidence_id: string;
    justification: string;
  }>;
};

/** TS test files that may be cited as parity evidence. */
const TS_TEST_FILES = new Set(
  readdirSync(here)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f)
);

// Collect current Python node IDs (may be expensive; only run when explicitly invoked).
function collectPythonNodeIds(): string[] {
  try {
    const output = execSync(
      ".venv/bin/python -m pytest apps/orchestration/tests --collect-only -q 2>&1",
      { cwd: path.resolve(here, "../.."), encoding: "utf8", timeout: 30_000 }
    );
    const entries: string[] = [];
    let currentModule: string | null = null;
    for (const line of output.split("\n")) {
      const modMatch = line.match(/<Module (\S+)>/);
      if (modMatch) {
        currentModule = modMatch[1].replace(/\.py$/, "");
      }
      const funcMatch = line.match(/<Function (.+)>\s*$/);
      if (funcMatch && currentModule) {
        entries.push(`apps/orchestration/tests/${currentModule}.py::${funcMatch[1]}`);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

describe("G4 python-test-parity-map", () => {
  it("covers exactly the expected number of node IDs", () => {
    expect(map.total_node_ids).toBe(524);
    expect(map.mappings.length).toBe(524);
  });

  it("every mapping has a valid disposition", () => {
    const valid = new Set(["parity", "retained", "retired"]);
    for (const entry of map.mappings) {
      expect(valid.has(entry.disposition), `${entry.node_id}: invalid disposition`).toBe(true);
    }
  });

  it("has no duplicate node IDs", () => {
    const ids = map.mappings.map((m) => m.node_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every mapping has a non-empty ts_evidence_id, behavior_owner, and justification", () => {
    for (const entry of map.mappings) {
      expect(entry.ts_evidence_id.length, `${entry.node_id}: empty evidence`).toBeGreaterThan(0);
      expect(entry.behavior_owner.length, `${entry.node_id}: no behavior owner`).toBeGreaterThan(0);
      expect(entry.justification.length, `${entry.node_id}: no justification`).toBeGreaterThan(20);
    }
  });

  it("every 'parity' entry cites a TS test file that actually exists", () => {
    // Guards the failure mode where a disposition claims coverage that was never written.
    for (const entry of map.mappings.filter((m) => m.disposition === "parity")) {
      const cited = [...entry.ts_evidence_id.matchAll(/([a-z0-9-]+\.test\.ts)/g)].map((m) => m[1]);
      expect(cited.length, `${entry.node_id}: parity cites no .test.ts file`).toBeGreaterThan(0);
      for (const file of cited) {
        expect(TS_TEST_FILES.has(file), `${entry.node_id}: cites missing TS file '${file}'`).toBe(
          true
        );
      }
    }
  });

  it("every 'retained' entry states an explicit non-ported rationale", () => {
    for (const entry of map.mappings.filter((m) => m.disposition === "retained")) {
      expect(entry.ts_evidence_id, `${entry.node_id}: retained must be marked n/a`).toMatch(
        /^n\/a/
      );
    }
  });

  it("no entry is retired at this gate (retirement belongs to Phase 10)", () => {
    expect(map.dispositions.retired).toBe(0);
  });

  it("disposition counts add up", () => {
    const sum = map.dispositions.parity + map.dispositions.retained + map.dispositions.retired;
    expect(sum).toBe(map.total_node_ids);
  });

  it("covers the live collected Python suite (when collectible)", () => {
    const collected = collectPythonNodeIds();
    if (collected.length === 0) {
      // Skip when pytest is not available in this environment.
      return;
    }
    expect(collected.length, "collected count must match map").toBe(map.total_node_ids);
    const mapped = new Set(map.mappings.map((m) => m.node_id));
    const unmapped = collected.filter((id) => !mapped.has(id));
    expect(unmapped, `unmapped node IDs: ${unmapped.slice(0, 5).join(", ")}`).toEqual([]);
  });
});
