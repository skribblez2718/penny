import { requireValue } from "./helpers/narrowing.js";
import { describe, expect, it } from "vitest";

import {
  CompositionAuthorityError,
  allocateComposeAuthority,
  validatePageDraftAuthority,
} from "../src/kb/composition-authority.js";
import type {
  GenerationCatalog,
  KbComposeAuthority,
  PageDraftArtifact,
} from "../src/kb/contracts.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const BASE_GENERATION = "gen_compose_base";
const BASE_CATALOG_SHA256 = "d".repeat(64);

function baseCatalog(): GenerationCatalog {
  return {
    schema_version: 1,
    generation_id: BASE_GENERATION,
    kb_id: "kb_compose_authority",
    manifest_sha256: DIGEST_A,
    policy_sha256: DIGEST_B,
    pages: {
      page_selected: {
        revision_id: "rev_selected",
        page_sha256: DIGEST_A,
        claims_sha256: DIGEST_B,
      },
    },
    source_records: { src_one: DIGEST_C, src_two: DIGEST_B },
    source_objects: [DIGEST_C],
    conflict_records: {},
    index_sha256: DIGEST_A,
    created_at: "2026-08-21T00:00:00Z",
  };
}

function authority(candidateCount = 1): KbComposeAuthority {
  const catalog = baseCatalog();
  return allocateComposeAuthority({
    runId: "run_compose_authority",
    operation: "ingest",
    kbId: catalog.kb_id,
    baseGenerationId: BASE_GENERATION,
    baseCatalogSha256: BASE_CATALOG_SHA256,
    privateInputSha256: DIGEST_C,
    baseCatalog: catalog,
    candidates: Array.from({ length: candidateCount }, (_, index) => ({
      candidate_ref: `candidate_page_${index}`,
      source_ids: [index === 0 ? "src_one" : "src_two"],
      claim_candidate_refs: [`candidate_claim_${index}_a`, `candidate_claim_${index}_b`],
    })),
  });
}

function draft(inputAuthority: KbComposeAuthority): PageDraftArtifact {
  return {
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: inputAuthority.allocations.map((allocation, pageIndex) => ({
      frontmatter: {
        schema_version: 1,
        page_id: allocation.page_id,
        revision_id: allocation.revision_id,
        ...(allocation.supersedes === null
          ? {}
          : { previous_revision_id: allocation.supersedes.revision_id }),
        kind: "synthesis",
        title: `Allocated page ${pageIndex}`,
        summary: "Every identity came from the host allocation.",
        authority: "advisory",
        lifecycle: allocation.lifecycle,
        created_at: "2026-08-21T00:00:00Z",
        derived_from: [],
        related_page_ids: [],
      },
      markdown:
        "## Synthesis\nAllocated synthesis.\n\n## Evidence\nAllocated evidence.\n\n" +
        "## Tensions and unknowns\nNone.\n\n## Related\nNone.\n",
      claims: {
        schema_version: 1,
        page_id: allocation.page_id,
        revision_id: allocation.revision_id,
        claims: allocation.claim_allocations.map((claim, claimIndex) => ({
          claim_id: claim.claim_id,
          text: `Allocated claim ${claimIndex}`,
          kind: "fact",
          state: "supported",
          confidence: "CERTAIN",
          evidence: [
            {
              source_id: requireValue(
                allocation.source_ids[0],
                "apps/orchestration/tests/kb-compose-authority.test.ts:94"
              ),
            },
          ],
          contradicts_claim_ids: [],
          canonical_verification_refs: [],
        })),
      },
    })),
  };
}

function validate(document: PageDraftArtifact, inputAuthority: KbComposeAuthority): void {
  validatePageDraftAuthority({
    document,
    authority: inputAuthority,
    selectedGenerationId: BASE_GENERATION,
    selectedCatalogSha256: BASE_CATALOG_SHA256,
    selectedCatalog: baseCatalog(),
  });
}

describe("host-owned compose identity authority", () => {
  it("mints deterministic page/revision/claim IDs and requires exactly one save page", () => {
    const first = authority();
    const second = authority();
    expect(second).toEqual(first);
    const allocation = requireValue(
      first.allocations[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:first allocation"
    );
    expect(allocation.page_id).toMatch(/^page_/);
    expect(allocation.revision_id).toMatch(/^rev_/);
    expect(allocation.lifecycle).toBe("draft");
    expect(allocation.supersedes).toBeNull();
    expect(allocation.claim_allocations).toHaveLength(2);
    for (const claim of allocation.claim_allocations) expect(claim.claim_id).toMatch(/^clm_/);
    expect(() =>
      allocateComposeAuthority({
        runId: "run_save_allocation",
        operation: "save",
        kbId: "kb_compose_authority",
        baseGenerationId: BASE_GENERATION,
        baseCatalogSha256: BASE_CATALOG_SHA256,
        privateInputSha256: DIGEST_C,
        baseCatalog: baseCatalog(),
        candidates: [
          { candidate_ref: "save_a", source_ids: ["src_one"], claim_candidate_refs: ["answer_a"] },
          { candidate_ref: "save_b", source_ids: ["src_two"], claim_candidate_refs: ["answer_b"] },
        ],
      })
    ).toThrow(/exactly one/);
  });

  it("permits only a host-selected exact existing-page supersede bound", () => {
    const catalog = baseCatalog();
    const selected = requireValue(
      catalog.pages.page_selected,
      "apps/orchestration/tests/kb-compose-authority.test.ts:147"
    );
    const allocated = allocateComposeAuthority({
      runId: "run_exact_supersede",
      operation: "ingest",
      kbId: catalog.kb_id,
      baseGenerationId: BASE_GENERATION,
      baseCatalogSha256: BASE_CATALOG_SHA256,
      privateInputSha256: DIGEST_C,
      baseCatalog: catalog,
      selectedPages: [
        {
          page_id: "page_selected",
          revision_id: selected.revision_id,
          page_sha256: selected.page_sha256,
          claims_sha256: selected.claims_sha256,
        },
      ],
      candidates: [
        {
          candidate_ref: "candidate_exact_supersede",
          source_ids: ["src_one"],
          claim_candidate_refs: ["candidate_supersede_claim"],
          supersedes: {
            page_id: "page_selected",
            revision_id: selected.revision_id,
            page_sha256: selected.page_sha256,
            claims_sha256: selected.claims_sha256,
          },
        },
      ],
    });
    expect(() => validate(draft(allocated), allocated)).not.toThrow();

    const widened = structuredClone(draft(allocated));
    requireValue(
      widened.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:181"
    ).frontmatter.previous_revision_id = "rev_other_selected";
    expect(() => validate(widened, allocated)).toThrow(/supersede bound/);
  });

  it("rejects a hostile child that chooses an existing selected page to supersede", () => {
    const allocated = authority();
    const hostile = structuredClone(draft(allocated));
    requireValue(
      hostile.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:188"
    ).frontmatter.page_id = "page_selected";
    requireValue(
      hostile.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:189"
    ).frontmatter.previous_revision_id = "rev_selected";
    requireValue(
      hostile.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:190"
    ).claims.page_id = "page_selected";
    expect(() => validate(hostile, allocated)).toThrow(/unallocated page identity/);
  });

  it("binds each allocated stable claim ID to its exact extracted candidate", () => {
    const allocated = authority();
    const valid = draft(allocated);
    const claimCandidates = new Map([
      [
        "candidate_claim_0_a",
        {
          text: "Allocated claim 0",
          kind: "fact" as const,
          confidence: "CERTAIN" as const,
          evidence: [{ source_id: "src_one" }],
        },
      ],
      [
        "candidate_claim_0_b",
        {
          text: "Allocated claim 1",
          kind: "fact" as const,
          confidence: "CERTAIN" as const,
          evidence: [{ source_id: "src_one" }],
        },
      ],
    ]);
    expect(() =>
      validatePageDraftAuthority({
        document: valid,
        authority: allocated,
        selectedGenerationId: BASE_GENERATION,
        selectedCatalogSha256: BASE_CATALOG_SHA256,
        selectedCatalog: baseCatalog(),
        claimCandidates,
      })
    ).not.toThrow();

    const reassigned = structuredClone(valid);
    requireValue(
      requireValue(reassigned.pages[0], "apps/orchestration/tests/kb-compose-authority.test.ts:229")
        .claims.claims[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:229"
    ).text = "Allocated claim 1";
    expect(() =>
      validatePageDraftAuthority({
        document: reassigned,
        authority: allocated,
        selectedGenerationId: BASE_GENERATION,
        selectedCatalogSha256: BASE_CATALOG_SHA256,
        selectedCatalog: baseCatalog(),
        claimCandidates,
      })
    ).toThrow(/different candidate/);
  });

  it("rejects invented page/revision/claim identity outside the pool", () => {
    const allocated = authority();
    const inventedRevision = structuredClone(draft(allocated));
    requireValue(
      inventedRevision.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:245"
    ).frontmatter.revision_id = "rev_invented";
    requireValue(
      inventedRevision.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:246"
    ).claims.revision_id = "rev_invented";
    expect(() => validate(inventedRevision, allocated)).toThrow(/outside its allocation/);

    const inventedClaim = structuredClone(draft(allocated));
    requireValue(
      requireValue(
        inventedClaim.pages[0],
        "apps/orchestration/tests/kb-compose-authority.test.ts:250"
      ).claims.claims[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:250"
    ).claim_id = "clm_invented";
    expect(() => validate(inventedClaim, allocated)).toThrow(/unallocated claim identity/);
  });

  it("rejects duplicate and omitted page or claim allocation consumption", () => {
    const allocated = authority(2);
    const valid = draft(allocated);

    const duplicatePage = structuredClone(valid);
    duplicatePage.pages[1] = structuredClone(
      requireValue(
        duplicatePage.pages[0],
        "apps/orchestration/tests/kb-compose-authority.test.ts:259"
      )
    );
    expect(() => validate(duplicatePage, allocated)).toThrow(/more than once/);

    const omittedPage = structuredClone(valid);
    omittedPage.pages.pop();
    expect(() => validate(omittedPage, allocated)).toThrow(/every page allocation/);

    const omittedClaim = structuredClone(valid);
    requireValue(
      omittedClaim.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:267"
    ).claims.claims.pop();
    expect(() => validate(omittedClaim, allocated)).toThrow(/every claim allocation/);

    const duplicateClaim = structuredClone(valid);
    requireValue(
      duplicateClaim.pages[0],
      "apps/orchestration/tests/kb-compose-authority.test.ts:271"
    ).claims.claims[1] = structuredClone(
      requireValue(
        requireValue(
          duplicateClaim.pages[0],
          "apps/orchestration/tests/kb-compose-authority.test.ts:272"
        ).claims.claims[0],
        "apps/orchestration/tests/kb-compose-authority.test.ts:272"
      )
    );
    expect(() => validate(duplicateClaim, allocated)).toThrow(/more than once/);
  });

  it("rejects selected-base drift even when all child IDs match", () => {
    const allocated = authority();
    expect(() =>
      validatePageDraftAuthority({
        document: draft(allocated),
        authority: allocated,
        selectedGenerationId: "gen_other",
        selectedCatalogSha256: BASE_CATALOG_SHA256,
        selectedCatalog: baseCatalog(),
      })
    ).toThrow(CompositionAuthorityError);
  });
});
