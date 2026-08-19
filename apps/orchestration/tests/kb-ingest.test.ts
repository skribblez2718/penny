/**
 * KB ingest workflow tests (G8.1).
 *
 * Deterministic coverage of the full ingest pipeline with a mock AgentRunner:
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
  ingestKb,
  type AgentRunner,
  type IngestSource,
  type PendingIngest,
} from "../src/kb/ingest.js";
import { initKb, queryKb, statusKb } from "../src/kb/workflows.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SRC_A = {
  sourceId: "src_quorum_notes",
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

function claimJson(claims = CLAIMS) {
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
        evidence: ["clm_deployment_unknown"],
      },
    ],
    candidate_conflicts: [
      {
        candidate_conflict_id: "cfl_0001",
        claim_refs: [
          {
            page_id: "page_quorum_sync",
            revision_id: "rev_0001",
            claim_id: "clm_deployment_unknown",
          },
        ],
        summary: "RCA says fix promoted 2024; no later source confirms it is still deployed.",
        evidence_refs: ["clm_sequence_fix", "clm_deployment_unknown"],
      },
    ],
  });
}

function verificationJson() {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [
      {
        claim_ref: {
          page_id: "page_quorum_sync",
          revision_id: "rev_0001",
          claim_id: "clm_quorum_two_of_three",
        },
        verdict: "supported",
        notes: "Directly stated in src_quorum_notes.",
      },
      {
        claim_ref: {
          page_id: "page_quorum_sync",
          revision_id: "rev_0001",
          claim_id: "clm_sequence_fix",
        },
        verdict: "supported",
        notes: "Stated in src_incident_rca.",
      },
      {
        claim_ref: {
          page_id: "page_quorum_sync",
          revision_id: "rev_0001",
          claim_id: "clm_deployment_unknown",
        },
        verdict: "unsupported",
        notes: "No source confirms current deployment; correctly flagged as unknown.",
      },
    ],
  });
}

/** Mock runner: schema-complete outputs for each KB phase. */
function makeMockRunner(overrides: Partial<Record<string, string>> = {}): {
  runner: AgentRunner;
  calls: { agent: string; stateId: string }[];
} {
  const calls: { agent: string; stateId: string }[] = [];
  const runner: AgentRunner = async (inv) => {
    calls.push({ agent: inv.agent, stateId: inv.stateId });
    // Probe the host-closed readers exactly as a live agent would: every
    // allowlisted source and every allowlisted prior-phase output must resolve.
    for (const id of inv.sourceAllowlist) {
      const text = inv.readSource(id);
      if (typeof text !== "string" || text.length === 0) {
        throw new Error(`host readSource('${id}') returned no content`);
      }
    }
    for (const phase of inv.priorPhaseAllowlist) {
      const text = inv.readPhaseOutput(phase);
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
  };
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(
  root: string,
  runId = "kb-ingest-run"
): { kbRoot: string; profileId: string; runId: string } {
  return { kbRoot: root, profileId: "kbp_test", runId };
}

async function ingestPending(
  root: string,
  runner: AgentRunner,
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
    claimsArtifactId: byKind.claims,
    pageDraftArtifactId: byKind.page_draft,
    lintReportArtifactId: byKind.lint_report,
    verificationArtifactId: byKind.verification_report,
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
        result.artifacts.find((x) => x.artifact_id === a.artifact_id)!.artifact_kind
      );
    }

    // Nothing published: selector still points at the init generation; no pages.
    expect(readCurrent(root).generation_id).toBe(baseGen);
    expect(existsSync(path.join(root, "pages"))).toBe(false);
    expect(existsSync(path.join(root, "conflicts"))).toBe(false);

    // Work plane holds the candidate artifacts (owner-only).
    const workDir = path.join(root, "work", "kb-ingest-run", "artifacts");
    expect(existsSync(workDir)).toBe(true);

    void pending;
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
    const catalog = JSON.parse(
      readFileSync(
        path.join(root, ".kb", "generations", current.generation_id, "catalog.json"),
        "utf8"
      )
    );
    expect(catalog.parent_generation_id).toBe(baseGen);

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
    expect(() => JSON.parse(fmJson)).not.toThrow();

    // Work plane stays out of the publication plane.
    expect(JSON.stringify(catalog)).not.toContain("work/");
    expect(catalog.source_objects).toHaveLength(2);
    expect(Object.keys(catalog.pages)).toEqual(["page_quorum_sync"]);
    expect(Object.keys(catalog.conflict_records)).toEqual(["cfl_0001"]);
  });

  it("never publishes a malformed page draft even after the gate was presented", async () => {
    const root = tmpRoot();
    initKb(ctx(root), "Ingest Test KB");
    const baseGen = readCurrent(root).generation_id;

    const { runner } = makeMockRunner({
      compose: "I composed the page but here is prose without JSON. Sorry!",
    });
    const { pending } = await ingestPending(root, runner);

    let approval: unknown;
    expect(() => {
      approval = approveIngest(ctx(root), [SRC_A, SRC_B], pending);
    }).not.toThrow();
    expect((approval as { status: string }).status).toBe("refused");

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
    await ingestPending(root, runner, [dupA, dupB]);

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
  return JSON.parse(readFileSync(path.join(root, ".kb", "current.json"), "utf8"));
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
