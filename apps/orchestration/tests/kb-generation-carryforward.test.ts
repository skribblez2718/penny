/**
 * Generations are COMPLETE views, not diffs (PRD acceptance 4; §§5.4–5.5).
 *
 * This suite exists because publication was replace-only: `approveIngest` built
 * each catalog from just that run's entries, so a second publish silently
 * dropped the first generation's pages from the selected generation. The page
 * files survived on disk, but the catalog — what `readSelectedGeneration` and
 * every retrieval path actually read — no longer listed them. A `save` built on
 * that would have deleted the KB it was adding to.
 *
 * The properties pinned here are the ones that make carry-forward safe rather
 * than a blind copy: accumulation, supersede-by-id, and the integrity recheck
 * that refuses to publish on top of drifted bytes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveIngest,
  createTestOnlyIngestBodyRunner,
  ingestKb,
  type IngestSource,
  type PendingIngest,
} from "../src/kb/ingest.js";
import { initKb } from "../src/kb/workflows.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import { pageMarkdownPath } from "../src/kb/filesystem.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-carryfwd-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeKbArtifactControls();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SRC_A: IngestSource = {
  sourceId: "src_alpha",
  capabilityDigest: "1".repeat(64),
  title: "Alpha notes",
  authors: ["Ada"],
  content:
    "The quorum protocol requires acknowledgement from two of three coordinators before any state transition is durable.",
  mediaType: "text/markdown",
  sourceType: "manual",
  capturedAt: "2026-08-19T00:00:00Z",
};
const SRC_B: IngestSource = {
  ...SRC_A,
  sourceId: "src_beta",
  capabilityDigest: "2".repeat(64),
  title: "Beta notes",
  content: "Replay was fixed by a monotonic sequence number carried in every acknowledgement.",
};

function ctx(root: string, runId: string) {
  return {
    kbRoot: root,
    profileId: "kbp_test",
    runId,
    checkpointer: kbArtifactControl({ root, runId, profileId: "kbp_test" }),
  };
}

function draft(pageId: string, revisionId: string, title: string, body: string): string {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: pageId,
          revision_id: revisionId,
          kind: "synthesis",
          title,
          summary: title,
          authority: "advisory",
          lifecycle: "validated",
          created_at: "2026-08-19T00:00:00Z",
          derived_from: [],
          related_page_ids: [],
        },
        markdown: `# ${title}\n\n${body}`,
        claims: { schema_version: 1, page_id: pageId, revision_id: revisionId, claims: [] },
      },
    ],
  });
}

const PHASE_BODIES = (composeBody: string): Record<string, string> => ({
  ingest: JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: [SRC_A.sourceId, SRC_B.sourceId],
    claims: [],
  }),
  compose: composeBody,
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
});

/** Run one full ingest to a sealed gate, then publish it. */
async function publish(
  root: string,
  runId: string,
  composeBody: string,
  sources: IngestSource[] = [SRC_A, SRC_B]
) {
  // Host source IDs are immutable publication identities, not reusable names.
  // A later ingest of equivalent evidence receives fresh IDs; raw object bytes
  // still deduplicate by digest.
  const admittedSources =
    runId === "run_one"
      ? sources
      : sources.map((source) => ({ ...source, sourceId: `${source.sourceId}_${runId}` }));
  const bodies = PHASE_BODIES(composeBody);
  const gated = await ingestKb(
    ctx(root, runId),
    admittedSources,
    createTestOnlyIngestBodyRunner(async (inv) => {
      const out = bodies[inv.stateId];
      if (out === undefined) throw new Error(`no body for ${inv.stateId}`);
      return out;
    })
  );
  expect(gated.status).toBe("awaiting_user");
  const byKind = Object.fromEntries(gated.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
  const pending: PendingIngest = {
    runId,
    sourceIds: admittedSources.map((s) => s.sourceId),
    claimsArtifactId: byKind.claims!,
    pageDraftArtifactId: byKind.page_draft!,
    lintReportArtifactId: byKind.lint_report!,
    verificationArtifactId: byKind.verification_report!,
  };
  return approveIngest(ctx(root, runId), admittedSources, pending);
}

describe("generations accumulate (the regression that motivated this suite)", () => {
  it("a second publish RETAINS the first generation's page", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "r0"), "Carry-forward KB");

    await publish(root, "run_one", draft("page_alpha", "rev_1", "Alpha", "first page"));
    const gen1 = readSelectedGeneration(root)!;
    expect(Object.keys(gen1.catalog.pages)).toEqual(["page_alpha"]);

    const second = await publish(
      root,
      "run_two",
      draft("page_beta", "rev_1", "Beta", "second page")
    );
    expect(second.status).toBe("complete");
    const gen2 = readSelectedGeneration(root)!;

    // The exact assertion the old implementation failed.
    expect(Object.keys(gen2.catalog.pages).sort()).toEqual(["page_alpha", "page_beta"]);
    expect(gen2.catalog.pages.page_alpha?.revision_id).toBe("rev_1");
    expect(gen2.catalog.parent_generation_id).toBe(gen1.selector.generation_id);
    expect(second.counts.pages).toBe(1); // this run contributed one …
    expect(second.counts.total_pages).toBe(2); // … the generation selects two.
  });

  it("carries source records and objects forward, so a zero-source publish keeps them", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "r0"), "Carry-forward KB");
    await publish(root, "run_one", draft("page_alpha", "rev_1", "Alpha", "first"));
    const gen1 = readSelectedGeneration(root)!;
    expect(Object.keys(gen1.catalog.source_records).sort()).toEqual(["src_alpha", "src_beta"]);

    // A save-shaped publish: a new page derived from existing material, with no
    // NEW sources admitted. `ingest` itself still requires >=1 capability (its
    // own rule, enforced upstream), so this exercises the publication path the
    // way `save` will drive it — straight into approveIngest with no sources.
    const bodies = PHASE_BODIES(draft("page_saved", "rev_1", "Saved", "from a query"));
    const gated = await ingestKb(
      ctx(root, "run_save"),
      [SRC_A, SRC_B],
      createTestOnlyIngestBodyRunner(async (inv) => {
        const out = bodies[inv.stateId];
        if (out === undefined) throw new Error(`no body for ${inv.stateId}`);
        return out;
      })
    );
    const byKind = Object.fromEntries(gated.artifacts.map((a) => [a.artifact_kind, a.artifact_id]));
    const saved = approveIngest(ctx(root, "run_save"), [], {
      runId: "run_save",
      sourceIds: [],
      claimsArtifactId: byKind.claims!,
      pageDraftArtifactId: byKind.page_draft!,
      lintReportArtifactId: byKind.lint_report!,
      verificationArtifactId: byKind.verification_report!,
    });

    expect(saved.status).toBe("complete");
    expect(saved.counts.sources).toBe(0); // admitted nothing of its own …
    const gen2 = readSelectedGeneration(root)!;
    expect(Object.keys(gen2.catalog.pages).sort()).toEqual(["page_alpha", "page_saved"]);
    // … and the KB's sources survive it.
    expect(Object.keys(gen2.catalog.source_records).sort()).toEqual(["src_alpha", "src_beta"]);
    expect(gen2.catalog.source_objects.length).toBe(gen1.catalog.source_objects.length);
  });

  it("supersedes by page_id: the newest revision wins, one entry not two", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "r0"), "Carry-forward KB");
    await publish(root, "run_one", draft("page_alpha", "rev_1", "Alpha v1", "first"));
    await publish(root, "run_two", draft("page_alpha", "rev_2", "Alpha v2", "revised"));

    const gen = readSelectedGeneration(root)!;
    expect(Object.keys(gen.catalog.pages)).toEqual(["page_alpha"]);
    expect(gen.catalog.pages.page_alpha?.revision_id).toBe("rev_2");
  });

  it("refuses to publish on top of a drifted carried page, and publishes nothing", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "r0"), "Carry-forward KB");
    await publish(root, "run_one", draft("page_alpha", "rev_1", "Alpha", "first"));
    const gen1 = readSelectedGeneration(root)!;

    // Tamper with an already-published page's bytes.
    writeFileSync(pageMarkdownPath(root, "page_alpha", "rev_1"), "---\n{}\n---\n\ntampered", {
      mode: 0o600,
    });

    const blocked = await publish(root, "run_two", draft("page_beta", "rev_1", "Beta", "second"));
    expect(blocked.status).toBe("refused");
    expect(blocked.met).toBe(false);
    expect(blocked.warnings.join(" ")).toMatch(/catalog digest.*nothing published/i);

    // The selector never moved: the KB still selects the pre-tamper generation.
    const after = readSelectedGeneration(root)!;
    expect(after.selector.generation_id).toBe(gen1.selector.generation_id);
  });

  it("keeps the derived index in step with the union, not just the new page", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "r0"), "Carry-forward KB");
    await publish(root, "run_one", draft("page_alpha", "rev_1", "Alpha", "quorum coordinators"));
    await publish(root, "run_two", draft("page_beta", "rev_1", "Beta", "monotonic sequence"));

    // The catalog is anchored to the index digest, and readSelectedGeneration
    // verifies it — so a stale index would fail this read outright.
    const gen = readSelectedGeneration(root)!;
    expect(gen.catalog.index_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(gen.catalog.pages).sort()).toEqual(["page_alpha", "page_beta"]);
  });
});
