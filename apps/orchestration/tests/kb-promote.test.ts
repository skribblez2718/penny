import { requireValue } from "./helpers/narrowing.js";
/**
 * §5.11 `promote` — prepare and verify only (§6.2A step 8).
 *
 * The defining property is what promote CANNOT do. It has no publishing edge,
 * no approval decision, no signature, no journal, and no write to any canonical
 * target; approving its gate is refused outright because apply is a host-only
 * path at G9. What it does do is produce a packet a human can judge: a plan, a
 * patch, and the host's OWN verification — targets re-resolved, current
 * preimages captured, named revisions checked against the selected generation.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validatePromoteRequest, verifyPromotionCandidate } from "../src/kb/promote.js";
import { initKb } from "../src/kb/workflows.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";
import { claimCapabilities, mintSourceCapability } from "../src/kb/gate.js";
import { CapabilityStore, envelopeDigest, mintEnvelope } from "../src/kb/capabilities.js";
import { sha256Hex } from "../src/kb/contracts.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { approveIngest, createTestOnlyIngestBodyRunner, ingestKb } from "../src/kb/ingest.js";

const PROFILE = "kbp_promote";
const SESSION = "sess_promote";
const PROMOTE_RUN = "run_promote";
const dirs: string[] = [];
function tmp(label: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `${label}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeKbArtifactControls();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("promote request (§5.6 closed shape)", () => {
  const valid = {
    schema_version: 1,
    action: "promote",
    kb_profile_id: PROFILE,
    page_revisions: [{ page_id: "page_b", revision_id: "rev_2" }],
    canonical_target_capability_ids: ["cap_t2"],
  };

  it("admits an exact request and sorts both identity arrays", () => {
    const req = validatePromoteRequest({
      ...valid,
      page_revisions: [
        { page_id: "page_b", revision_id: "rev_2" },
        { page_id: "page_a", revision_id: "rev_9" },
        { page_id: "page_a", revision_id: "rev_1" },
      ],
      canonical_target_capability_ids: ["cap_t2", "cap_t1"],
    });
    // Sorting is contractual: the packet must not depend on caller ordering.
    expect(req.page_revisions).toEqual([
      { page_id: "page_a", revision_id: "rev_1" },
      { page_id: "page_a", revision_id: "rev_9" },
      { page_id: "page_b", revision_id: "rev_2" },
    ]);
    expect(req.canonical_target_capability_ids).toEqual(["cap_t1", "cap_t2"]);
  });

  it("refuses anything that would smuggle authority or ambiguity", () => {
    // An approval decision, a target path, or any other open key.
    expect(() => validatePromoteRequest({ ...valid, decision: "approve" })).toThrow();
    expect(() => validatePromoteRequest({ ...valid, target_path: "/etc/x" })).toThrow();
    expect(() => validatePromoteRequest({ ...valid, approval_receipt: "..." })).toThrow();
    // Nothing to promote, or nowhere to promote to.
    expect(() => validatePromoteRequest({ ...valid, page_revisions: [] })).toThrow();
    expect(() =>
      validatePromoteRequest({ ...valid, canonical_target_capability_ids: [] })
    ).toThrow();
    // Duplicate pairs would make the packet ambiguous.
    expect(() =>
      validatePromoteRequest({
        ...valid,
        page_revisions: [
          { page_id: "page_a", revision_id: "rev_1" },
          { page_id: "page_a", revision_id: "rev_1" },
        ],
      })
    ).toThrow(/schema validation/);
    // Ids are opaque, never locators.
    expect(() =>
      validatePromoteRequest({
        ...valid,
        page_revisions: [{ page_id: "../../etc/passwd", revision_id: "rev_1" }],
      })
    ).toThrow();
  });
});

/** A KB with one published page, and a canonical target file + capability. */
async function kbWithPageAndTarget() {
  const projectRoot = tmp("penny-kb-promote");
  installTestProjectState(projectRoot);
  const kbRoot = path.join(projectRoot, ".penny", "kb", PROFILE);
  initKb({ kbRoot, profileId: PROFILE, runId: "run_init" }, "Promote KB");

  const srcDir = tmp("penny-kb-promote-src");
  const srcPath = path.join(srcDir, "a.md");
  writeFileSync(srcPath, "Quorum requires two of three acknowledgements.", { mode: 0o600 });
  const cap = mintSourceCapability({
    projectRoot,
    kbProfileId: PROFILE,
    sessionId: SESSION,
    allowedOperation: "ingest",
    absolutePath: srcPath,
    title: "Quorum note",
    authors: ["Ada"],
    sourceType: "manual",
    mediaType: "text/markdown",
  });
  const sourceId = "src_promote_seed";
  const source = {
    sourceId,
    capabilityDigest: envelopeDigest(cap),
    title: "Quorum note",
    authors: ["Ada"],
    content: "Quorum requires two of three acknowledgements.",
    mediaType: "text/markdown" as const,
    sourceType: "manual" as const,
    capturedAt: "2026-08-19T00:00:00Z",
  };
  const bodies: Record<string, string> = {
    ingest: JSON.stringify({
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: [sourceId],
      claims: [],
    }),
    compose: JSON.stringify({
      schema_version: 1,
      artifact_kind: "page_draft",
      pages: [
        {
          frontmatter: {
            schema_version: 1,
            page_id: "page_quorum",
            revision_id: "rev_1",
            kind: "synthesis",
            title: "Quorum",
            summary: "Quorum rule",
            authority: "advisory",
            lifecycle: "validated",
            created_at: "2026-08-19T00:00:00Z",
            derived_from: [],
            related_page_ids: [],
          },
          markdown: "# Quorum\n\nTwo of three acknowledgements.",
          claims: { schema_version: 1, page_id: "page_quorum", revision_id: "rev_1", claims: [] },
        },
      ],
    }),
    lint: JSON.stringify({
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [],
      candidate_conflicts: [],
    }),
    verify: JSON.stringify({
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: [],
      claim_findings: [],
    }),
  };
  const checkpointer = kbArtifactControl({
    root: kbRoot,
    runId: "run_seed",
    profileId: PROFILE,
  });
  const gated = await ingestKb(
    {
      kbRoot,
      profileId: PROFILE,
      runId: "run_seed",
      checkpointer,
    },
    [source],
    createTestOnlyIngestBodyRunner(async (inv) => {
      const b = bodies[inv.stateId];
      if (b === undefined) throw new Error(`no body for ${inv.stateId}`);
      return b;
    })
  );
  const byKind = Object.fromEntries(gated.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
  approveIngest({ kbRoot, profileId: PROFILE, runId: "run_seed", checkpointer }, [source], {
    runId: "run_seed",
    sourceIds: [sourceId],
    claimsArtifactId: requireValue(
      byKind.claims,
      "apps/orchestration/tests/kb-promote.test.ts:199"
    ),
    pageDraftArtifactId: requireValue(
      byKind.page_draft,
      "apps/orchestration/tests/kb-promote.test.ts:200"
    ),
    lintReportArtifactId: requireValue(
      byKind.lint_report,
      "apps/orchestration/tests/kb-promote.test.ts:201"
    ),
    verificationArtifactId: requireValue(
      byKind.verification_report,
      "apps/orchestration/tests/kb-promote.test.ts:202"
    ),
  });

  // A canonical target the operator has authorized for promotion.
  const targetDir = tmp("penny-kb-canonical");
  const targetPath = path.join(targetDir, "AGENTS.md");
  writeFileSync(targetPath, "# Canonical\n\nExisting guidance.\n", { mode: 0o600 });
  const targetEnv = mintEnvelope({
    kind: "canonical_target",
    session_id: SESSION,
    kb_profile_id: PROFILE,
    resolved_path: targetPath,
    expected_sha256: sha256Hex(readFileSync(targetPath, "utf8")),
    allowed_operation: "promote",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    authority_root: targetDir,
  });
  const capabilities = new CapabilityStore(projectRoot);
  capabilities.register(targetEnv);
  capabilities.close();
  claimCapabilities({
    projectRoot,
    kbRoot,
    capabilityIds: [targetEnv.capability_id],
    runId: PROMOTE_RUN,
    sessionId: SESSION,
    profileId: PROFILE,
    kind: "canonical_target",
    operation: "promote",
  });

  return { projectRoot, kbRoot, targetPath, targetDir, targetCapId: targetEnv.capability_id };
}

describe("host verification (§5.11) — the host's own finding, not a child's claim", () => {
  it("verifies a real target and captures its CURRENT preimage", async () => {
    const kb = await kbWithPageAndTarget();
    const report = verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_1" }],
      targetCapabilityIds: [kb.targetCapId],
    });

    expect(report.verified).toBe(true);
    expect(report.findings).toEqual([]);
    const target = requireValue(
      report.targets[0],
      "apps/orchestration/tests/kb-promote.test.ts:253"
    );
    expect(Object.keys(target).sort()).toEqual(["capability_id", "preimage_sha256"]);
    // The preimage is what a later apply would have to still find in place.
    const actual = createHash("sha256").update(readFileSync(kb.targetPath)).digest("hex");
    expect(target.preimage_sha256).toBe(actual);
    expect(JSON.stringify(target)).not.toContain(kb.targetDir);
  });

  it("refuses to verify a revision the selected generation does not select", async () => {
    const kb = await kbWithPageAndTarget();
    const superseded = verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_999" }],
      targetCapabilityIds: [kb.targetCapId],
    });
    expect(superseded.verified).toBe(false);
    expect(superseded.findings.join(" ")).toMatch(/different revision/i);

    const absent = verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_absent", revision_id: "rev_1" }],
      targetCapabilityIds: [kb.targetCapId],
    });
    expect(absent.verified).toBe(false);
    expect(absent.findings.join(" ")).toMatch(/not in the selected generation/i);
  });

  it("records an unresolvable or missing target as a finding, not an exception", async () => {
    const kb = await kbWithPageAndTarget();
    const report = verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_1" }],
      targetCapabilityIds: ["cap_does_not_exist"],
    });
    // An honest "this cannot be promoted as stated" is a legitimate result of
    // preparing — the packet is still produced, and it still applies nothing.
    expect(report.verified).toBe(false);
    expect(report.findings.join(" ")).toMatch(/did not resolve/i);
    expect(report.targets[0]).toEqual({ capability_id: "cap_does_not_exist" });
  });

  it("projects all and only target ids/preimages in request order without host paths", async () => {
    const kb = await kbWithPageAndTarget();
    const requested = ["cap_does_not_exist", kb.targetCapId];
    const report = verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_1" }],
      targetCapabilityIds: requested,
    });
    expect(report.targets.map((target) => target.capability_id)).toEqual(requested);
    expect(report.targets[0]).toEqual({ capability_id: "cap_does_not_exist" });
    const admittedTarget = report.targets[1];
    if (admittedTarget === undefined) throw new Error("admitted target is missing from the report");
    expect(admittedTarget.preimage_sha256).toBe(
      createHash("sha256").update(readFileSync(kb.targetPath)).digest("hex")
    );
    expect(JSON.stringify(report)).not.toContain(kb.targetDir);
    expect(JSON.stringify(report)).not.toContain(kb.targetPath);
    expect(() =>
      verifyPromotionCandidate({
        projectRoot: kb.projectRoot,
        kbRoot: kb.kbRoot,
        runId: PROMOTE_RUN,
        sessionId: SESSION,
        profileId: PROFILE,
        operation: "promote",
        pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_1" }],
        targetCapabilityIds: [kb.targetCapId, kb.targetCapId],
      })
    ).toThrow(/duplicated/);
  });

  it("never mutates the canonical target while preparing", async () => {
    const kb = await kbWithPageAndTarget();
    const before = readFileSync(kb.targetPath, "utf8");
    verifyPromotionCandidate({
      projectRoot: kb.projectRoot,
      kbRoot: kb.kbRoot,
      runId: PROMOTE_RUN,
      sessionId: SESSION,
      profileId: PROFILE,
      operation: "promote",
      pageRevisions: [{ page_id: "page_quorum", revision_id: "rev_1" }],
      targetCapabilityIds: [kb.targetCapId],
    });
    expect(readFileSync(kb.targetPath, "utf8")).toBe(before);
    // And the KB's own selected generation is untouched by preparing.
    expect(
      Object.keys(
        requireValue(
          readSelectedGeneration(kb.kbRoot),
          "apps/orchestration/tests/kb-promote.test.ts:360"
        ).catalog.pages
      )
    ).toEqual(["page_quorum"]);
  });
});
