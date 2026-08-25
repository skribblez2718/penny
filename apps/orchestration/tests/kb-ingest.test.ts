import {
  parseJson,
  requireArray,
  requireRecord,
  requireString,
  requireValue,
} from "./helpers/narrowing.js";
/**
 * KB ingest workflow tests (G8.1).
 *
 * Deterministic coverage of the full ingest pipeline with the explicit test-only body adapter:
 *   init → ingest (4 phases, sealed candidate set, awaiting_user) →
 *   approveIngest (strict normalization, publication) → query/status invariants.
 *
 * The live E2E (real agents on ollama/qwen3.8:latest) runs separately via
 * KbModelClient — see the E2E script, not here.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveIngest,
  createTestOnlyIngestBodyRunner,
  ingestKb,
  type IngestSource,
  type TestOnlyIngestBodyRunner,
  type PendingIngest,
} from "../src/kb/ingest.js";
import { conflictRecordForAllocation } from "../src/kb/content-review.js";
import { canonicalJson, sha256Hex } from "../src/kb/contracts.js";
import { defaultKbIngestPlane } from "../src/kb/ingest-plane.js";
import { initKb, queryKb, statusKb } from "../src/kb/workflows.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SRC_A = {
  sourceId: "src_quorum_notes",
  capabilityDigest: "1".repeat(64),
  title: "Quorum protocol notes",
  authors: ["Ada Lovelace"],
  content:
    "The quorum protocol requires a signed acknowledgment from at least two of the three coordinators before any state transition. A single coordinator's acknowledgment is never sufficient. The protocol was hardened after the 2024 replay incident, where a duplicate acknowledgment briefly produced a conflicting state.",
  mediaType: "text/markdown" as const,
  sourceType: "manual" as const,
  capturedAt: "2026-08-18T00:00:00Z",
};

const SRC_B = {
  sourceId: "src_incident_rca",
  capabilityDigest: "2".repeat(64),
  title: "2024 replay incident RCA",
  authors: ["Grace Hopper", "Linus T."],
  content:
    "Root cause: the acknowledgment log lacked a stable sequence number, so a replayed ACK was processed twice. Fix: assign a monotonically increasing sequence number to each acknowledgment and reject any ACK whose sequence is at or below the last applied one. This fix was verified in staging and promoted to production on 2024-03-11.",
  mediaType: "text/markdown" as const,
  sourceType: "research_artifact" as const,
  capturedAt: "2026-08-18T00:00:00Z",
};

const PAGE_MARKDOWN = [
  "## Synthesis",
  "The quorum protocol hardens state transitions behind a two-of-three signed quorum, a rule that exists because an unsequenced acknowledgment once let a replayed duplicate drive a conflicting state.",
  "## Evidence",
  "- Two-of-three signed quorum is required before any state transition (src_quorum_notes).",
  "- The 2024 replay incident was caused by a missing stable sequence number; the fix rejected out-of-order/replayed ACKs (src_incident_rca).",
  "## Tensions and unknowns",
  "- Sources do not state the current deployment status of the sequence-number fix; the RCA says it was promoted in 2024 but no later source confirms it still runs.",
  "## Related",
  "- No related pages in this generation.",
].join("\n");

const CLAIMS = [
  {
    claim_id: "clm_quorum_two_of_three",
    text: "The quorum protocol requires signed acknowledgment from at least two of three coordinators before any state transition.",
    kind: "fact",
    state: "supported",
    confidence: "CERTAIN",
    evidence: [{ source_id: "src_quorum_notes" }],
    contradicts_claim_ids: [],
    canonical_verification_refs: [],
  },
  {
    claim_id: "clm_sequence_fix",
    text: "The 2024 replay incident was fixed by assigning a monotonic sequence number and rejecting replayed ACKs.",
    kind: "fact",
    state: "supported",
    confidence: "PROBABLE",
    evidence: [{ source_id: "src_incident_rca" }],
    contradicts_claim_ids: [],
    canonical_verification_refs: [],
  },
  {
    claim_id: "clm_deployment_unknown",
    text: "The current deployment status of the sequence-number fix is unconfirmed by later sources.",
    kind: "unknown",
    state: "unverified_current",
    confidence: "UNCERTAIN",
    evidence: [{ source_id: "src_incident_rca" }],
    contradicts_claim_ids: [],
    canonical_verification_refs: [],
  },
];

const EXTRACTED_CLAIMS = CLAIMS.map((claim) => ({
  provisional_id: `provisional_${claim.claim_id}`,
  text: claim.text,
  kind: claim.kind,
  confidence: claim.confidence,
  evidence: claim.evidence,
}));

function claimJson(claims = EXTRACTED_CLAIMS) {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: ["src_quorum_notes", "src_incident_rca"],
    claims,
  });
}

function pageDraftJson() {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: "page_quorum_sync",
          revision_id: "rev_0001",
          kind: "synthesis",
          title: "Quorum hardening and the replay-incident fix",
          summary:
            "Two-of-three signed quorum and the ACK sequence-number fix, with one open deployment question.",
          authority: "advisory",
          lifecycle: "validated",
          created_at: "2026-08-18T00:00:00Z",
          derived_from: ["src_quorum_notes", "src_incident_rca"],
          related_page_ids: [],
        },
        markdown: PAGE_MARKDOWN,
        claims: {
          schema_version: 1,
          page_id: "page_quorum_sync",
          revision_id: "rev_0001",
          claims: CLAIMS,
        },
      },
    ],
  });
}

function candidateConflict() {
  return {
    candidate_conflict_id: "cfl_0001",
    claim_refs: [
      {
        page_id: "page_quorum_sync",
        revision_id: "rev_0001",
        claim_id: "clm_deployment_unknown",
      },
    ],
    summary: "RCA says fix promoted 2024; no later source confirms it is still deployed.",
    evidence_refs: [
      { evidence_id: "evidence_sequence_fix", kind: "artifact", ref: "clm_sequence_fix" },
      {
        evidence_id: "evidence_deployment_conflict",
        kind: "artifact",
        ref: "clm_deployment_unknown",
      },
    ],
  };
}

function lintJson() {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: [
      {
        finding_id: "fnd_0001",
        severity: "warning",
        summary:
          "Deployment status of the sequence fix is asserted in synthesis but only RCA-dated.",
        evidence: [
          {
            evidence_id: "evidence_deployment_unknown",
            kind: "artifact",
            ref: "clm_deployment_unknown",
          },
        ],
      },
    ],
    candidate_conflicts: [candidateConflict()],
  });
}

function verificationJson() {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [
      {
        page_id: "page_quorum_sync",
        revision_id: "rev_0001",
        claim_id: "clm_quorum_two_of_three",
        verdict: "supported",
        evidence: [{ evidence_id: "evidence_quorum", kind: "source", ref: "src_quorum_notes" }],
      },
      {
        page_id: "page_quorum_sync",
        revision_id: "rev_0001",
        claim_id: "clm_sequence_fix",
        verdict: "supported",
        evidence: [{ evidence_id: "evidence_sequence", kind: "source", ref: "src_incident_rca" }],
      },
      {
        page_id: "page_quorum_sync",
        revision_id: "rev_0001",
        claim_id: "clm_deployment_unknown",
        verdict: "unsupported",
        evidence: [],
      },
    ],
  });
}

/** Mock runner: schema-complete outputs for each KB phase. */
function makeMockRunner(overrides: Partial<Record<string, string>> = {}): {
  runner: TestOnlyIngestBodyRunner;
  calls: { agent: string; stateId: string }[];
} {
  const calls: { agent: string; stateId: string }[] = [];
  const runner = createTestOnlyIngestBodyRunner(async (inv) => {
    calls.push({ agent: inv.agent, stateId: inv.stateId });
    // Probe the host-closed readers exactly as a live agent would: every
    // allowlisted source and every allowlisted prior-phase output must resolve.
    for (const id of inv.sourceAllowlist) {
      const text = inv.readSource(id);
      if (typeof text !== "string" || text.length === 0) {
        throw new Error(`host readSource('${id}') returned no content`);
      }
    }
    const readPhaseOutput = inv.readPhaseOutput;
    for (const phase of inv.priorPhaseAllowlist) {
      if (readPhaseOutput === undefined) {
        throw new Error("host did not provide the required prior-phase reader");
      }
      const text = readPhaseOutput(phase);
      if (typeof text !== "string" || text.length === 0) {
        throw new Error(`host readPhaseOutput('${phase}') returned no content`);
      }
    }
    const table: Record<string, string> = {
      ingest: claimJson(),
      compose: pageDraftJson(),
      lint: lintJson(),
      verify: verificationJson(),
    };
    const out = overrides[inv.stateId] ?? table[inv.stateId];
    if (out === undefined) throw new Error(`mock runner: no output for ${inv.stateId}`);
    return out;
  });
  return { runner, calls };
}

// ── Harness ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-ingest-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeKbArtifactControls();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(root: string, runId = "kb-ingest-run") {
  return {
    kbRoot: root,
    profileId: "kbp_test",
    runId,
    checkpointer: kbArtifactControl({ root, runId, profileId: "kbp_test" }),
  };
}

function requiredArtifactId(ids: Readonly<Record<string, string>>, kind: string): string {
  const artifactId = ids[kind];
  if (artifactId === undefined) throw new Error(`ingest result is missing '${kind}'`);
  return artifactId;
}

async function ingestPending(
  root: string,
  runner: TestOnlyIngestBodyRunner,
  sources: IngestSource[] = [SRC_A, SRC_B]
) {
  const result = await ingestKb(ctx(root, "kb-ingest-run"), sources, runner);
  expect(result.status).toBe("awaiting_user");
  expect(result.next).toBe("review");
  expect(result.artifacts).toHaveLength(4);
  const kinds = result.artifacts.map((a) => a.artifact_kind).sort();
  expect(kinds).toEqual(["claims", "lint_report", "page_draft", "verification_report"]);
  const byKind = Object.fromEntries(result.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
  const pending: PendingIngest = {
    runId: "kb-ingest-run",
    sourceIds: sources.map((s) => s.sourceId),
    claimsArtifactId: requiredArtifactId(byKind, "claims"),
    pageDraftArtifactId: requiredArtifactId(byKind, "page_draft"),
    lintReportArtifactId: requiredArtifactId(byKind, "lint_report"),
    verificationArtifactId: requiredArtifactId(byKind, "verification_report"),
  };
  return { result, pending };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ingest: gate (no publication)", () => {
  it("runs all four phases in order, seals the candidate set, and publishes nothing", async () => {
    const root = tmpRoot();
    const init = initKb(ctx(root), "Ingest Test KB");
    expect(init.status).toBe("complete");
    const baseGen = readCurrent(root).generation_id;

    const { runner, calls } = makeMockRunner();
    const { result, pending } = await ingestPending(root, runner);

    // All four agents ran, in pipeline order, with briefs + host readers wired.
    expect(calls.map((c) => c.agent)).toEqual(["echo", "synthia", "carren", "vera"]);
    expect(calls.map((c) => c.stateId)).toEqual(["ingest", "compose", "lint", "verify"]);

    // Gate: awaiting_user, four sealed handles, no paths anywhere.
    expect(result.status).toBe("awaiting_user");
    expect(result.met).toBe(false);
    expect(result.next).toBe("review");
    expect(JSON.stringify(result)).not.toContain(root);
    for (const a of result.artifacts) {
      expect(a.artifact_id).toMatch(/^art_[0-9a-f]{32}$/);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.artifact_kind).toBe(
        requireValue(
          result.artifacts.find((x) => x.artifact_id === a.artifact_id),
          "apps/orchestration/tests/kb-ingest.test.ts:344"
        ).artifact_kind
      );
    }

    // Nothing published: selector still points at the init generation; no pages.
    expect(readCurrent(root).generation_id).toBe(baseGen);
    expect(existsSync(path.join(root, "sources"))).toBe(false);
    expect(existsSync(path.join(root, "pages"))).toBe(false);
    expect(existsSync(path.join(root, "conflicts"))).toBe(false);

    // Work plane holds the candidate artifacts (owner-only).
    const workDir = path.join(root, "work", "kb-ingest-run", "artifacts");
    expect(existsSync(workDir)).toBe(true);

    void pending;
  });

  it("projects indexed handles exactly into the legacy gate and fails before persistence on a missing artifact", async () => {
    const root = tmpRoot();
    const context = ctx(root);
    initKb(context, "Ingest Test KB");
    const { runner } = makeMockRunner();
    const { result, pending } = await ingestPending(root, runner);
    const plane = defaultKbIngestPlane(context.checkpointer, { testOnlyLegacyReview: true });
    const gateInput = {
      kbRoot: root,
      profileId: context.profileId,
      runId: context.runId,
      artifactIds: result.artifacts.map((artifact) => artifact.artifact_id),
      sourceIds: pending.sourceIds,
      capabilityIds: [],
    };

    const gate = plane.persistGate(gateInput);
    expect(gate.artifacts).toEqual(result.artifacts);
    const firstArtifact = gate.artifacts[0];
    if (firstArtifact === undefined) throw new Error("legacy gate persisted no artifacts");
    expect(Object.keys(firstArtifact).sort()).toEqual([
      "artifact_id",
      "artifact_kind",
      "byte_length",
      "media_type",
      "schema_version",
      "sha256",
    ]);
    const gatePath = path.join(root, ".kb", "gates", `${gate.gate_id}.json`);
    expect(readFileSync(gatePath, "utf8")).toBe(canonicalJson(gate));

    const before = readdirSync(path.dirname(gatePath)).sort();
    expect(() =>
      plane.persistGate({
        ...gateInput,
        artifactIds: ["art_missing_boundary"],
      })
    ).toThrow("artifact_not_found");
    expect(readdirSync(path.dirname(gatePath)).sort()).toEqual(before);
  });

  it("is refused on an uninitialized KB and stages nothing", async () => {
    const root = tmpRoot();
    const { runner } = makeMockRunner();
    const result = await ingestKb(ctx(root), [SRC_A], runner);
    expect(result.status).toBe("refused");
    expect(result.artifacts).toHaveLength(0);
    expect(existsSync(path.join(root, "work"))).toBe(false);
  });

  it("is refused with zero sources", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const { runner } = makeMockRunner();
    const result = await ingestKb(ctx(root), [], runner);
    expect(result.status).toBe("refused");
    expect(result.warnings.join(" ")).toMatch(/at least one source/i);
  });
});

describe("approveIngest: publication", () => {
  it("publishes exactly one new generation with the page pair, sources, and converted conflict", async () => {
    const root = tmpRoot();
    const init = initKb(ctx(root), "Ingest Test KB");
    const baseGen = init.ids.find((id) => id.startsWith("gen_")) ?? readCurrent(root).generation_id;
    const { runner } = makeMockRunner();
    const { pending } = await ingestPending(root, runner);

    const approval = approveIngest(ctx(root), [SRC_A, SRC_B], pending);
    expect(approval.status).toBe("complete");
    expect(approval.met).toBe(true);
    expect(approval.counts.pages).toBe(1);
    expect(approval.counts.sources).toBe(2);
    expect(approval.counts.conflicts).toBe(1);

    // Selector advanced exactly one generation; parent chain intact.
    const current = readCurrent(root);
    expect(current.generation_id).not.toBe(baseGen);
    const catalog = requireRecord(
      parseJson(
        readFileSync(
          path.join(root, ".kb", "generations", current.generation_id, "catalog.json"),
          "utf8"
        )
      ),
      "published generation catalog"
    );
    expect(requireString(catalog["parent_generation_id"], "catalog parent generation id")).toBe(
      baseGen
    );

    // Publication plane: one source object per distinct content (sharded 2-char
    // prefix), two records, one page revision pair, one conflict.
    const objects = listFilesRecursive(path.join(root, "sources", "objects"));
    expect(objects).toHaveLength(2);
    const records = readdirSync(path.join(root, "sources", "records"));
    expect(records).toHaveLength(2);
    const pageDir = path.join(root, "pages", "page_quorum_sync", "revisions", "rev_0001");
    expect(existsSync(path.join(pageDir, "page.md"))).toBe(true);
    expect(existsSync(path.join(pageDir, "claims.json"))).toBe(true);
    expect(readFileSync(path.join(root, "conflicts", "cfl_0001.json"), "utf8")).toContain(
      '"state":"open"'
    );

    // Page bytes: strict frontmatter + required H2 sections, owner-only custody.
    const pageMd = readFileSync(path.join(pageDir, "page.md"), "utf8");
    expect(statSync(path.join(pageDir, "page.md")).mode & 0o777).toBe(0o600);
    for (const h2 of ["## Synthesis", "## Evidence", "## Tensions and unknowns", "## Related"]) {
      expect(pageMd).toContain(h2);
    }
    const fmJson = pageMd.split("---\n")[1];
    if (fmJson === undefined) throw new Error("published page is missing frontmatter JSON");
    expect(() => {
      JSON.parse(fmJson);
    }).not.toThrow();

    // Work plane stays out of the publication plane.
    expect(JSON.stringify(catalog)).not.toContain("work/");
    expect(requireArray(catalog["source_objects"], "catalog source objects")).toHaveLength(2);
    expect(Object.keys(requireRecord(catalog["pages"], "catalog pages"))).toEqual([
      "page_quorum_sync",
    ]);
    expect(
      Object.keys(requireRecord(catalog["conflict_records"], "catalog conflict records"))
    ).toEqual(["cfl_0001"]);
  });

  it("publishes the exact preallocated conflict bytes from the reviewed packet", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const { runner } = makeMockRunner();
    const { pending } = await ingestPending(root, runner);
    const issuedAt = "2026-08-24T12:00:00Z";
    const placeholder = {
      candidate_conflict_id: "cfl_0001",
      conflict_record_id: "conf_reviewed_0001",
      conflict_record_sha256: "0".repeat(64),
    };
    const conflict = conflictRecordForAllocation({
      candidate: candidateConflict(),
      allocation: placeholder,
      issuedAt,
      allowedClaimRefs: new Set(["page_quorum_sync\u0000rev_0001\u0000clm_deployment_unknown"]),
    });
    const allocation = {
      ...placeholder,
      conflict_record_sha256: sha256Hex(canonicalJson(conflict)),
    };

    const approval = approveIngest(ctx(root), [SRC_A, SRC_B], {
      ...pending,
      candidateConflictAllocations: [allocation],
      reviewIssuedAt: issuedAt,
    });

    expect(approval.status).toBe("complete");
    expect(readFileSync(path.join(root, "conflicts", "conf_reviewed_0001.json"), "utf8")).toBe(
      canonicalJson(conflict)
    );
  });

  it("refuses a changed conflict allocation digest without moving the selector", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const baseGenerationId = readCurrent(root).generation_id;
    const { runner } = makeMockRunner();
    const { pending } = await ingestPending(root, runner);

    const approval = approveIngest(ctx(root), [SRC_A, SRC_B], {
      ...pending,
      candidateConflictAllocations: [
        {
          candidate_conflict_id: "cfl_0001",
          conflict_record_id: "conf_reviewed_0001",
          conflict_record_sha256: "f".repeat(64),
        },
      ],
      reviewIssuedAt: "2026-08-24T12:00:00Z",
    });

    expect(approval.status).toBe("refused");
    expect(approval.warnings).toEqual([
      "content-review conflict allocation digest changed; nothing published",
    ]);
    expect(readCurrent(root).generation_id).toBe(baseGenerationId);
    expect(existsSync(path.join(root, "conflicts"))).toBe(false);
  });

  it("rejects a malformed page draft at staging before any gate or publication", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const baseGen = readCurrent(root).generation_id;

    const { runner } = makeMockRunner({
      compose: "I composed the page but here is prose without JSON. Sorry!",
    });
    await expect(ingestPending(root, runner)).rejects.toThrow();

    const current = readCurrent(root);
    expect(current.generation_id).toBe(baseGen);
    expect(existsSync(path.join(root, "pages"))).toBe(false);
  });

  it("deduplicates identical source content into one content-addressed object", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const { runner } = makeMockRunner();
    const dupA = { ...SRC_A };
    const dupB = { ...SRC_B, content: SRC_A.content };
    const { pending } = await ingestPending(root, runner, [dupA, dupB]);
    // Pre-review snapshots are work-plane bytes, never publication objects.
    expect(existsSync(path.join(root, "sources"))).toBe(false);
    approveIngest(ctx(root), [dupA, dupB], pending);

    const objects = listFilesRecursive(path.join(root, "sources", "objects"));
    expect(objects).toHaveLength(1);
  });

  it("query after approval retrieves the published page", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const { runner } = makeMockRunner();
    const { pending } = await ingestPending(root, runner);
    approveIngest(ctx(root), [SRC_A, SRC_B], pending);

    const q = queryKb(
      ctx(root, "kb-query-after-ingest"),
      "quorum acknowledgment sequence number replay fix"
    );
    expect(q.status).toBe("complete");
    expect(q.met).toBe(true);
    expect(q.counts.candidates).toBeGreaterThanOrEqual(1);
  });

  it("status after approval reports the new counts without leaking paths", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const { runner } = makeMockRunner();
    const { pending } = await ingestPending(root, runner);
    approveIngest(ctx(root), [SRC_A, SRC_B], pending);

    const s = statusKb(ctx(root, "kb-status-after-ingest"));
    expect(s.status).toBe("complete");
    expect(s.met).toBe(true);
    expect(s.counts.pages).toBe(1);
    expect(s.counts.sources).toBe(2);
    expect(JSON.stringify(s)).not.toContain(root);
  });
});

// Read `.kb/current.json` without a public helper (test-local).
function readCurrent(root: string): { generation_id: string } {
  const selector = requireRecord(
    parseJson(readFileSync(path.join(root, ".kb", "current.json"), "utf8")),
    "current generation selector"
  );
  return {
    generation_id: requireString(selector["generation_id"], "current generation id"),
  };
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(entry);
  }
  return out;
}
