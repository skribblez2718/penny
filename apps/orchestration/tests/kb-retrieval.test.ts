/**
 * KB retrieval + lint tests (G7).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRetrievalDecisionFixture,
  parseGateDecisionReceiptJcs,
} from "../src/kb/gate-decisions.js";
import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbManifest,
  type KbRetrievalFixtureV1,
  type RetrievalBaselineDecisionV1,
  type RetrievalFixtureCaseV1,
} from "../src/kb/contracts.js";
import {
  writeManifest,
  writePolicy,
  writeSourceObject,
  writeSourceRecord,
  writePageRevision,
  writeConflictRecord,
} from "../src/kb/filesystem.js";
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
const FROZEN_FIXTURE_PATH = "apps/orchestration/tests/fixtures/kb-retrieval.json";
const FROZEN_CASE_IDS = ["sqlite-query", "typebox-query", "cross-query"] as const;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const ownerReceiptPath = path.join(
  repoRoot,
  ".penny/plan-gates/hybrid-kb-ts-plan-2026-08-13/retrieval_baseline.json"
);

type FrozenRetrievalReceipt = RetrievalBaselineDecisionV1;
type FrozenRetrievalCase = RetrievalFixtureCaseV1;
type FrozenRetrievalFixture = KbRetrievalFixtureV1;

function requireFrozen(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid owner retrieval receipt/fixture: ${message}`);
}

function endpointKey(endpoint: ExpectedContradiction["left"]): string {
  return `${endpoint.page_id}\u0000${endpoint.revision_id}\u0000${endpoint.claim_id}`;
}

function pairKey(pair: ExpectedContradiction): string {
  return [endpointKey(pair.left), endpointKey(pair.right)].sort().join("\u0001");
}

/** Load only the exact owner path. Candidate receipts are never a test authority. */
function loadReviewedRetrievalBaseline(): {
  readonly receipt: FrozenRetrievalReceipt;
  readonly fixture: FrozenRetrievalFixture;
} {
  const receiptBytes = readFileSync(ownerReceiptPath, "utf8");
  const parsed = parseGateDecisionReceiptJcs(receiptBytes);
  requireFrozen(parsed.decision_kind === "retrieval_baseline", "decision kind changed");
  const receipt: FrozenRetrievalReceipt = parsed;
  requireFrozen(receipt.fixture_path === FROZEN_FIXTURE_PATH, "fixture path changed");
  requireFrozen(receipt.case_count === FROZEN_CASE_IDS.length, "case_count must remain 3");
  requireFrozen(receipt.k === 10, "k must remain 10");
  requireFrozen(receipt.minimum_hit_at_k === 1, "minimum_hit_at_k must remain 1");
  requireFrozen(receipt.minimum_mrr === 1, "minimum_mrr must remain 1");
  requireFrozen(
    receipt.minimum_contradiction_recall === 1,
    "minimum_contradiction_recall must remain 1"
  );
  requireFrozen(
    receipt.maximum_unsupported_answer_rate === 0,
    "maximum_unsupported_answer_rate must remain 0"
  );

  const fixturePath = path.resolve(repoRoot, receipt.fixture_path);
  requireFrozen(
    fixturePath === path.join(repoRoot, FROZEN_FIXTURE_PATH),
    "fixture path does not resolve to the tracked fixture"
  );
  const fixtureBytes = readFileSync(fixturePath, "utf8");
  const fixture = assertRetrievalDecisionFixture({ decision: receipt, fixtureBytes });
  requireFrozen(fixture.corpus.length > 0, "fixture corpus must be non-empty");
  requireFrozen(fixture.cases.length === receipt.case_count, "fixture case count mismatch");
  requireFrozen(
    canonicalJson(fixture.cases.map((testCase) => testCase.case_id)) ===
      canonicalJson(FROZEN_CASE_IDS),
    "the original three query cases changed"
  );

  const pages = new Map<string, FrozenRetrievalPage>();
  const claims = new Map<string, { readonly page: FrozenRetrievalPage }>();
  for (const page of fixture.corpus) {
    const pageKey = `${page.frontmatter.page_id}\u0000${page.frontmatter.revision_id}`;
    requireFrozen(!pages.has(pageKey), "duplicate corpus page/revision");
    requireFrozen(page.markdown.length > 0, "page markdown must be non-empty");
    requireFrozen(
      page.claims.page_id === page.frontmatter.page_id &&
        page.claims.revision_id === page.frontmatter.revision_id,
      "claims sidecar does not match its page/revision"
    );
    pages.set(pageKey, page);
    for (const claim of page.claims.claims) {
      requireFrozen(!claims.has(claim.claim_id), "claim IDs must be globally unique");
      claims.set(claim.claim_id, { page });
    }
  }

  const labels: ExpectedContradiction[] = [];
  const labelKeys = new Set<string>();
  for (const testCase of fixture.cases) {
    requireFrozen(testCase.query.length > 0, "query must be non-empty");
    requireFrozen(testCase.expected_relevant.length > 0, "expected_relevant must be non-empty");
    for (const relevant of testCase.expected_relevant) {
      requireFrozen(
        pages.has(`${relevant.page_id}\u0000${relevant.revision_id}`),
        "expected_relevant points outside the corpus"
      );
    }
    for (const pair of testCase.expected_contradictions) {
      const key = pairKey(pair);
      requireFrozen(!labelKeys.has(key), "contradiction labels must be unique");
      labelKeys.add(key);
      labels.push(pair);
      for (const endpoint of [pair.left, pair.right]) {
        const page = pages.get(`${endpoint.page_id}\u0000${endpoint.revision_id}`);
        const claim = claims.get(endpoint.claim_id);
        requireFrozen(page !== undefined, "contradiction endpoint page is missing");
        requireFrozen(claim?.page === page, "contradiction endpoint claim is missing");
      }
      const leftClaim = claims
        .get(pair.left.claim_id)
        ?.page.claims.claims.find((claim) => claim.claim_id === pair.left.claim_id);
      const rightClaim = claims
        .get(pair.right.claim_id)
        ?.page.claims.claims.find((claim) => claim.claim_id === pair.right.claim_id);
      requireFrozen(
        leftClaim?.contradicts_claim_ids.includes(pair.right.claim_id) === true &&
          rightClaim?.contradicts_claim_ids.includes(pair.left.claim_id) === true,
        "labeled contradiction must be cross-linked by both endpoint claims"
      );
    }
  }
  requireFrozen(labels.length > 0, "at least one labeled contradiction pair is required");
  requireFrozen(
    receipt.evidence_refs.some(
      (evidence) =>
        evidence.evidence_id === "retrieval-fixture" &&
        evidence.kind === "digest" &&
        evidence.ref === fixture.fixture_id
    ),
    "receipt does not bind the fixture ID"
  );
  return { receipt, fixture };
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

describe.skipIf(!existsSync(ownerReceiptPath))("frozen §5.13 retrieval baseline", () => {
  it("validates the exact owner receipt before scoring and enforces every frozen floor", () => {
    const { receipt, fixture } = loadReviewedRetrievalBaseline();
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
        maxCandidates: receipt.k,
      }),
      expected: testCase.expected_relevant,
      expectedContradictions: testCase.expected_contradictions,
    }));
    const metrics = {
      hit_at_k: hitAtK(executions, receipt.k),
      mrr: meanReciprocalRank(executions),
      contradiction_recall: microContradictionRecallAtK(executions, receipt.k),
    };
    const diagnostic = canonicalJson({
      fixture_sha256: receipt.fixture_sha256,
      case_count: receipt.case_count,
      k: receipt.k,
      metrics,
    });

    expect(metrics.hit_at_k, diagnostic).toBeGreaterThanOrEqual(receipt.minimum_hit_at_k);
    expect(metrics.mrr, diagnostic).toBeGreaterThanOrEqual(receipt.minimum_mrr);
    expect(metrics.contradiction_recall, diagnostic).toBeGreaterThanOrEqual(
      receipt.minimum_contradiction_recall
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
