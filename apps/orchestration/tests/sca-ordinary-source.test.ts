import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  buildHostStaticInventory,
  captureScaStaticSourceFile,
  describeScaSourceSnapshotV1,
} from "../dist/sca/ordinary-source.js";
import { parseSealedScaSourceCorpusV1 } from "../dist/sca/active-compliance.js";
import { validateScaRequestV1 } from "../dist/skill-contracts/sca-request.js";
import { sourceOnlyEvidence } from "../dist/sca/ordinary-host.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-ordinary-source-"));
  roots.push(root);
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "handler.ts"), "export const ordinary = 1;\n");
  const request = validateScaRequestV1({
    schema_version: 1,
    purpose: "Exact source admission test",
    source_root: source,
    scope: { include: [], exclude: [] },
    execution_mode: "static_only",
    model: "deepseek-flash",
  });
  return { root, source, request };
}
describe("ordinary SCA exact source and caller-owned analyzer admission", () => {
  it("computes an optional digest, verifies a supplied one and uses the portable CLI representation", () => {
    const input = fixture();
    const captured = buildHostStaticInventory(input.request);
    expect(
      describeScaSourceSnapshotV1({ source_root: input.source, scope: input.request.scope })
        .source_snapshot_sha256
    ).toBe(captured.sourceSnapshotSha256);
    expect(
      buildHostStaticInventory({
        ...input.request,
        source_snapshot_sha256: captured.sourceSnapshotSha256,
      }).sourceCorpus
    ).toEqual(captured.sourceCorpus);
    expect(() =>
      buildHostStaticInventory({ ...input.request, source_snapshot_sha256: "0".repeat(64) })
    ).toThrow("digest mismatch");
  });
  it.each(["symlink", "hardlink"])(
    "rejects %s input instead of weakening the bound snapshot",
    (kind) => {
      const input = fixture();
      const destination = path.join(input.source, "linked.ts");
      if (kind === "symlink") symlinkSync(path.join(input.source, "handler.ts"), destination);
      else linkSync(path.join(input.source, "handler.ts"), destination);
      expect(() => buildHostStaticInventory(input.request)).toThrow(
        "could not be bound completely"
      );
    }
  );
  it("rejects descriptor mutation and finite byte overflow during capture", () => {
    const input = fixture();
    expect(() =>
      captureScaStaticSourceFile({
        sourceRoot: input.source,
        relativePath: "handler.ts",
        maximumBytes: 8,
      })
    ).toThrow();
    expect(() =>
      captureScaStaticSourceFile({
        sourceRoot: input.source,
        relativePath: "handler.ts",
        maximumBytes: 4096,
        onBeforeRead: () =>
          writeFileSync(path.join(input.source, "handler.ts"), "changed length\n"),
      })
    ).toThrow();
  });
  it("keeps non-text exclusion explicit and withholds credential-bearing source before model evidence disclosure", async () => {
    const input = fixture();
    writeFileSync(path.join(input.source, "binary.bin"), Buffer.from([0, 255, 1]));
    writeFileSync(
      path.join(input.source, "credential.ts"),
      'export const API_KEY = "fixture-private-value";\n'
    );
    const captured = buildHostStaticInventory(input.request);
    const parsed = parseSealedScaSourceCorpusV1(captured.sourceCorpus);
    expect(parsed.excluded_paths.has("binary.bin")).toBe(true);
    const evidence = await sourceOnlyEvidence({
      corpus: captured.sourceCorpus,
      actions: {
        schema_version: 1,
        gaps: [],
        actions: [
          {
            id: "source",
            hypothesis_id: "h-1",
            kind: "source",
            ranges: [{ path: "credential.ts", start_line: 1, end_line: 1 }],
            query_id: null,
            rationale: "Inspect exact selected source",
            discriminating_observation: "Whether the key value is source-owned",
          },
        ],
      },
    });
    expect(evidence.results[0]?.status).toBe("unavailable");
    expect(evidence.results[0]?.pointers).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("fixture-private-value");
    expect(evidence.results[0]?.execution).toBe("NOT RUN");
  });
  it("rejects normalized or symlinked analyzer paths into the target, and duplicate script IDs", () => {
    const input = fixture();
    const alias = path.join(input.root, "outside-alias");
    symlinkSync(path.join(input.source, "handler.ts"), alias);
    const tool = { executable: alias, sha256: "a".repeat(64), version: "fixture" };
    expect(() =>
      validateScaRequestV1({
        ...input.request,
        analysis_tools: {
          semgrep: {
            tool,
            rules_path: path.join(input.root, "rules"),
            rules_sha256: "a".repeat(64),
          },
        },
      })
    ).toThrow("outside the target");
    expect(() =>
      validateScaRequestV1({
        ...input.request,
        analysis_tools: {
          semgrep: {
            tool: {
              ...tool,
              executable: path.join(input.root, "source", "..", "source", "handler.ts"),
            },
            rules_path: path.join(input.root, "rules"),
            rules_sha256: "a".repeat(64),
          },
        },
      })
    ).toThrow("outside the target");
    const script = {
      id: "duplicate",
      script_path: path.join(input.root, "query.sc"),
      sha256: "a".repeat(64),
    };
    expect(() =>
      validateScaRequestV1({
        ...input.request,
        analysis_tools: {
          graph: {
            joern: { ...tool, executable: path.join(input.root, "joern") },
            queries: [script, script],
          },
        },
      })
    ).toThrow("unique");
  });
});
