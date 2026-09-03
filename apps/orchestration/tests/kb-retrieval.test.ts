/**
 * KB retrieval + lint tests (G7).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRetrievalFixture } from "../src/kb/gate-decisions.js";
import {
  canonicalJson,
  defaultDenyPolicy,
  type KbManifest,
  type KbRetrievalFixtureV1,
} from "../src/kb/contracts.js";
import { writeManifest, writePolicy, writePageRevision } from "../src/kb/filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
} from "../src/kb/generations.js";
import {
  hitAtK,
  meanReciprocalRank,
  microContradictionRecallAtK,
  rankPages,
  type ExpectedContradiction,
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
const TRACKED_FIXTURE_PATH = "apps/orchestration/tests/fixtures/kb-retrieval.json";
const TRACKED_CASE_IDS = ["sqlite-query", "typebox-query", "cross-query"] as const;
const RETRIEVAL_K = 10;
const MINIMUM_HIT_AT_K = 1;
const MINIMUM_MRR = 1;
const MINIMUM_CONTRADICTION_RECALL = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const trackedFixturePath = path.join(repoRoot, TRACKED_FIXTURE_PATH);

type TrackedRetrievalFixture = KbRetrievalFixtureV1;

function requireTracked(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid tracked retrieval fixture: ${message}`);
}

/** Load and validate the tracked regression fixture directly. */
function loadTrackedRetrievalFixture(): TrackedRetrievalFixture {
  const fixture = parseRetrievalFixture(readFileSync(trackedFixturePath, "utf8"));
  requireTracked(fixture.fixture_id === "kb-retrieval-v1", "fixture ID changed");
  requireTracked(fixture.corpus.length > 0, "fixture corpus must be non-empty");
  requireTracked(fixture.cases.length === TRACKED_CASE_IDS.length, "case count must remain 3");
  requireTracked(
    canonicalJson(fixture.cases.map((testCase) => testCase.case_id)) ===
      canonicalJson(TRACKED_CASE_IDS),
    "the original three query cases changed"
  );
  requireTracked(
    fixture.cases.some((testCase) => testCase.expected_contradictions.length > 0),
    "at least one labeled contradiction pair is required"
  );
  for (const page of fixture.corpus) {
    requireTracked(page.markdown.length > 0, "page markdown must be non-empty");
  }
  return fixture;
}

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
    const sqliteResult = results[0];
    if (sqliteResult === undefined) throw new Error("sqlite query returned no ranked page");
    expect(sqliteResult.page_id).toBe("page_a");
    expect(sqliteResult.score).toBeGreaterThan(0);

    const typeboxResults = rankPages({ catalog, query: "TypeBox schema", pageContents });
    const typeboxResult = typeboxResults[0];
    if (typeboxResult === undefined) throw new Error("TypeBox query returned no ranked page");
    expect(typeboxResult.page_id).toBe("page_b");
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

  it("computes micro contradiction recall over exact claim endpoints", () => {
    const pair: ExpectedContradiction = {
      left: { page_id: "a", revision_id: "r1", claim_id: "clm_a" },
      right: { page_id: "b", revision_id: "r1", claim_id: "clm_b" },
    };
    const candidates: RetrievalCandidate[] = [
      { page_id: "a", revision_id: "r1", score: 2, claim_ids: ["clm_a"], excerpt: "" },
      { page_id: "b", revision_id: "r1", score: 1, claim_ids: ["clm_b"], excerpt: "" },
    ];

    expect(microContradictionRecallAtK([{ candidates, expectedContradictions: [pair] }], 1)).toBe(
      0
    );
    expect(microContradictionRecallAtK([{ candidates, expectedContradictions: [pair] }], 2)).toBe(
      1
    );
    expect(microContradictionRecallAtK([], 10)).toBe(0);
  });
});

describe("provider-free knowledge-base conformance", () => {
  function retrievalInputs() {
    const root = tmpRoot();
    const { manifest } = seedKb(root);
    const catalog = buildCatalog({
      generation_id: "gen_provider_free_conformance",
      kb_id: manifest.kb_id,
      manifest,
      policy: defaultDenyPolicy(manifest.kb_id),
      pages: [
        { page_id: "page_a", revision_id: "rev_1", page_sha256: ZERO, claims_sha256: ZERO },
        { page_id: "page_b", revision_id: "rev_1", page_sha256: ZERO, claims_sha256: ZERO },
      ],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
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
        {
          title: "TypeBox schemas",
          summary: "Schema validation",
          markdown: "TypeBox validates",
        },
      ],
    ]);
    return { catalog, pageContents };
  }

  it("accepts meaning-preserving query variation without exact-string grading", () => {
    const input = retrievalInputs();
    const original = rankPages({ ...input, query: "sqlite unflagged" });
    const varied = rankPages({ ...input, query: "UNFLAGGED sqlite" });
    expect(varied).toEqual(original);
  });

  it("changes the ranked result after a material query mutation", () => {
    const input = retrievalInputs();
    const sqlite = rankPages({ ...input, query: "sqlite unflagged" });
    const typebox = rankPages({ ...input, query: "TypeBox schema" });
    expect(sqlite[0]?.page_id).toBe("page_a");
    expect(typebox[0]?.page_id).toBe("page_b");
    expect(typebox[0]?.page_id).not.toBe(sqlite[0]?.page_id);
  });
});

describe("tracked §5.13 retrieval regression", () => {
  it("scores the tracked fixture at k=10 and enforces the 1/1/1 floors", () => {
    const fixture = loadTrackedRetrievalFixture();
    const root = tmpRoot();
    const { manifest } = seedKb(root);
    const catalog = buildCatalog({
      generation_id: "gen_retrieval_frozen",
      kb_id: manifest.kb_id,
      manifest,
      policy: defaultDenyPolicy(manifest.kb_id),
      pages: fixture.corpus.map((page) => ({
        page_id: page.frontmatter.page_id,
        revision_id: page.frontmatter.revision_id,
        page_sha256: ZERO,
        claims_sha256: ZERO,
      })),
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    const pageContents = new Map(
      fixture.corpus.map((page) => [
        page.frontmatter.page_id,
        {
          title: page.frontmatter.title,
          summary: page.frontmatter.summary,
          markdown: page.markdown,
          claim_ids: page.claims.claims.map((claim) => claim.claim_id),
        },
      ])
    );
    const executions = fixture.cases.map((testCase) => ({
      candidates: rankPages({
        catalog,
        query: testCase.query,
        pageContents,
        maxCandidates: RETRIEVAL_K,
      }),
      expected: testCase.expected_relevant,
      expectedContradictions: testCase.expected_contradictions,
    }));
    const metrics = {
      hit_at_k: hitAtK(executions, RETRIEVAL_K),
      mrr: meanReciprocalRank(executions),
      contradiction_recall: microContradictionRecallAtK(executions, RETRIEVAL_K),
    };
    const diagnostic = canonicalJson({
      fixture_id: fixture.fixture_id,
      case_count: fixture.cases.length,
      k: RETRIEVAL_K,
      floors: {
        hit_at_k: MINIMUM_HIT_AT_K,
        mrr: MINIMUM_MRR,
        contradiction_recall: MINIMUM_CONTRADICTION_RECALL,
      },
      metrics,
    });

    expect(metrics.hit_at_k, diagnostic).toBeGreaterThanOrEqual(MINIMUM_HIT_AT_K);
    expect(metrics.mrr, diagnostic).toBeGreaterThanOrEqual(MINIMUM_MRR);
    expect(metrics.contradiction_recall, diagnostic).toBeGreaterThanOrEqual(
      MINIMUM_CONTRADICTION_RECALL
    );
  });
});

describe("KB §5.7 deterministic lint", () => {
  it("passes on a well-formed KB", () => {
    const root = tmpRoot();
    seedKb(root);
    const { manifest } = seedKb(root); // re-seed to get manifest
    const policy = defaultDenyPolicy("kb_001");
    const generationId = newGenerationId();
    const indexSha256 = buildGenerationIndex(root, generationId, "kb_001", []).index_sha256;
    const catalog = buildCatalog({
      generation_id: generationId,
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: indexSha256,
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
