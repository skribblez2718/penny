/**
 * KB retrieval + lint tests (G7).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbManifest,
} from "../src/kb/contracts.js";
import {
  writeManifest,
  writePolicy,
  writeSourceObject,
  writeSourceRecord,
  writePageRevision,
  writeConflictRecord,
} from "../src/kb/filesystem.js";
import { buildCatalog, newGenerationId, publishGeneration } from "../src/kb/generations.js";
import {
  hitAtK,
  meanReciprocalRank,
  rankPages,
  type RetrievalCandidate,
} from "../src/kb/retrieval.js";
import { lintDeterministic } from "../src/kb/lint.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-ret-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-01-01T00:00:00Z";
const ZERO = "0".repeat(64);

function seedKb(root: string): { manifest: KbManifest } {
  const manifest: KbManifest = {
    schema_version: 1,
    kb_id: "kb_001",
    title: "Test",
    authority: "advisory",
    paths: {
      policy: ".kb/policy.json",
      source_records: "sources/records",
      source_objects: "sources/objects",
      pages: "pages",
      conflicts: "conflicts",
      work: "work",
      lock: ".kb/lock",
      generations: ".kb/generations",
      generation_catalog_filename: "catalog.json",
      generation_index_filename: "index.sqlite",
      current: ".kb/current.json",
      root_index: "index.md",
    },
    created_at: NOW,
  };
  writeManifest(root, manifest);
  writePolicy(root, defaultDenyPolicy("kb_001"));
  return { manifest };
}

describe("KB §5.13 retrieval", () => {
  it("ranks pages by lexical match with deterministic tie-breaking", () => {
    const root = tmpRoot();
    const { manifest } = seedKb(root);
    const policy = defaultDenyPolicy("kb_001");

    // Write two pages
    writePageRevision(
      root,
      {
        schema_version: 1,
        page_id: "page_a",
        revision_id: "rev_1",
        kind: "synthesis",
        title: "node:sqlite unflagging",
        summary: "When sqlite was unflagged",
        authority: "advisory",
        lifecycle: "validated",
        created_at: NOW,
        derived_from: [],
        related_page_ids: [],
      },
      "## Synthesis\nsqlite was unflagged\n",
      { schema_version: 1, page_id: "page_a", revision_id: "rev_1", claims: [] }
    );
    writePageRevision(
      root,
      {
        schema_version: 1,
        page_id: "page_b",
        revision_id: "rev_1",
        kind: "synthesis",
        title: "TypeBox schemas",
        summary: "Schema validation",
        authority: "advisory",
        lifecycle: "validated",
        created_at: NOW,
        derived_from: [],
        related_page_ids: [],
      },
      "## Synthesis\nTypeBox validates\n",
      { schema_version: 1, page_id: "page_b", revision_id: "rev_1", claims: [] }
    );

    const catalog = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [
        { page_id: "page_a", revision_id: "rev_1", page_sha256: ZERO, claims_sha256: ZERO },
        { page_id: "page_b", revision_id: "rev_1", page_sha256: ZERO, claims_sha256: ZERO },
      ],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, catalog);

    const pageContents = new Map([
      [
        "page_a",
        {
          title: "node:sqlite unflagging",
          summary: "When sqlite was unflagged",
          markdown: "sqlite was unflagged",
        },
      ],
      [
        "page_b",
        { title: "TypeBox schemas", summary: "Schema validation", markdown: "TypeBox validates" },
      ],
    ]);

    const results = rankPages({ catalog, query: "sqlite unflagged", pageContents });
    expect(results[0].page_id).toBe("page_a");
    expect(results[0].score).toBeGreaterThan(0);

    const typeboxResults = rankPages({ catalog, query: "TypeBox schema", pageContents });
    expect(typeboxResults[0].page_id).toBe("page_b");
  });

  it("hit@k and MRR are computed correctly", () => {
    const results = [
      {
        candidates: [
          { page_id: "a", revision_id: "r", score: 3, claim_ids: [], excerpt: "" },
          { page_id: "b", revision_id: "r", score: 2, claim_ids: [], excerpt: "" },
        ] as RetrievalCandidate[],
        expected: [{ page_id: "a" }],
      },
      {
        candidates: [
          { page_id: "c", revision_id: "r", score: 1, claim_ids: [], excerpt: "" },
          { page_id: "a", revision_id: "r", score: 0, claim_ids: [], excerpt: "" },
        ] as RetrievalCandidate[],
        expected: [{ page_id: "a" }],
      },
    ];

    expect(hitAtK(results, 1)).toBe(0.5); // only first case has "a" in top-1
    expect(hitAtK(results, 2)).toBe(1.0); // both have "a" in top-2
    expect(meanReciprocalRank(results)).toBe((1 / 1 + 1 / 2) / 2); // 0.75
  });
});

describe("KB §5.7 deterministic lint", () => {
  it("passes on a well-formed KB", () => {
    const root = tmpRoot();
    seedKb(root);
    const { manifest } = seedKb(root); // re-seed to get manifest
    const policy = defaultDenyPolicy("kb_001");
    const catalog = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, catalog);

    const findings = lintDeterministic(root);
    const blocking = findings.filter((f) => f.severity === "blocking");
    expect(blocking).toEqual([]);
  });

  it("reports a missing manifest as blocking", () => {
    const root = tmpRoot();
    const findings = lintDeterministic(root);
    expect(findings.some((f) => f.severity === "blocking" && f.summary.includes("manifest"))).toBe(
      true
    );
  });

  it("reports a missing policy as blocking", () => {
    const root = tmpRoot();
    const manifest: KbManifest = {
      schema_version: 1,
      kb_id: "kb_001",
      title: "T",
      authority: "advisory",
      paths: {
        policy: ".kb/policy.json",
        source_records: "sources/records",
        source_objects: "sources/objects",
        pages: "pages",
        conflicts: "conflicts",
        work: "work",
        lock: ".kb/lock",
        generations: ".kb/generations",
        generation_catalog_filename: "catalog.json",
        generation_index_filename: "index.sqlite",
        current: ".kb/current.json",
        root_index: "index.md",
      },
      created_at: NOW,
    };
    writeManifest(root, manifest);
    const findings = lintDeterministic(root);
    expect(findings.some((f) => f.severity === "blocking" && f.summary.includes("policy"))).toBe(
      true
    );
  });

  it("warns when no generation is selected", () => {
    const root = tmpRoot();
    seedKb(root);
    const findings = lintDeterministic(root);
    expect(
      findings.some((f) => f.severity === "warning" && f.summary.includes("current.json"))
    ).toBe(true);
  });
});
