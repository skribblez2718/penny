/**
 * Host-owned advisory identity allocation for KB composition.
 *
 * The control DB freezes the returned body-free authority before a compose
 * child exists. Synthia may copy these opaque IDs from the private phase brief,
 * but it cannot create an identity, select an existing page to replace, or
 * leave part of the pool unused.
 */

import {
  ClaimsArtifactSchema,
  KbComposeAuthoritySchema,
  PageDraftArtifactSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type ClaimsArtifact,
  type GenerationCatalog,
  type KbComposeAuthority,
  type KbComposeSupersedeBound,
  type PageDraftArtifact,
  type PageLifecycle,
  type Sha256Hex,
} from "./contracts.js";

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CompositionAuthorityError extends Error {
  readonly code = "compose_authority_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CompositionAuthorityError";
  }
}

export interface ComposeClaimCandidateBody {
  readonly text: string;
  readonly kind: "fact" | "inference" | "speculation" | "unknown";
  readonly confidence: "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN";
  readonly evidence: readonly {
    readonly source_id: string;
    readonly locator?: string;
    readonly excerpt_sha256?: string;
  }[];
}

/** Exact candidate bodies keyed by their transient correlation refs. */
export function claimCandidateBodies(document: unknown): Map<string, ComposeClaimCandidateBody> {
  const claims = validateKbContract(
    ClaimsArtifactSchema,
    document,
    "compose claims input"
  ) as ClaimsArtifact;
  const result = new Map<string, ComposeClaimCandidateBody>();
  for (const claim of claims.claims) {
    const candidateRef = claim.provisional_id;
    if (result.has(candidateRef)) {
      throw new CompositionAuthorityError("compose claim candidate refs are duplicated");
    }
    result.set(candidateRef, {
      text: claim.text,
      kind: claim.kind,
      confidence: claim.confidence,
      evidence: claim.evidence,
    });
  }
  return result;
}

export interface ComposePageCandidate {
  /** Host correlation key for this exact candidate group; never published. */
  readonly candidate_ref: string;
  readonly source_ids: readonly string[];
  readonly claim_candidate_refs: readonly string[];
  readonly supersedes?: KbComposeSupersedeBound;
  readonly lifecycle?: PageLifecycle;
}

function allocatedId(
  prefix: "page" | "rev" | "clm",
  input: {
    runId: string;
    baseGenerationId: string;
    pageCandidateRef: string;
    claimCandidateRef?: string;
  }
): string {
  return `${prefix}_${sha256Hex(
    canonicalJson({
      schema_version: 1,
      domain: `kb-compose-${prefix}`,
      run_id: input.runId,
      base_generation_id: input.baseGenerationId,
      page_candidate_ref: input.pageCandidateRef,
      ...(input.claimCandidateRef === undefined
        ? {}
        : { claim_candidate_ref: input.claimCandidateRef }),
    })
  ).slice(0, 32)}`;
}

/** Allocate an exact deterministic host pool suitable for one durable INSERT. */
export function allocateComposeAuthority(input: {
  readonly runId: string;
  readonly operation: "ingest" | "save";
  readonly kbId: string;
  readonly baseGenerationId: string;
  readonly baseCatalogSha256: Sha256Hex;
  readonly privateInputSha256: Sha256Hex;
  readonly baseCatalog: GenerationCatalog;
  readonly selectedPages?: readonly KbComposeSupersedeBound[];
  readonly candidates: readonly ComposePageCandidate[];
}): KbComposeAuthority {
  if (input.candidates.length < 1 || input.candidates.length > 8) {
    throw new CompositionAuthorityError("compose candidate count is outside the allocation bound");
  }
  if (input.operation === "save" && input.candidates.length !== 1) {
    throw new CompositionAuthorityError("save requires exactly one compose allocation");
  }
  const selectedPages = [...(input.selectedPages ?? [])];
  const selectedPageIds = new Set<string>();
  for (const selectedPage of selectedPages) {
    if (
      selectedPageIds.has(selectedPage.page_id) ||
      !sameCatalogPage(input.baseCatalog.pages[selectedPage.page_id], selectedPage)
    ) {
      throw new CompositionAuthorityError(
        "selected-page allocation is duplicated or outside the base"
      );
    }
    selectedPageIds.add(selectedPage.page_id);
  }
  const candidateRefs = new Set<string>();
  const claimCandidateRefs = new Set<string>();
  const pageIds = new Set<string>();
  const revisionIds = new Set<string>();
  const claimIds = new Set<string>();
  const allocations = input.candidates.map((candidate) => {
    if (!OPAQUE.test(candidate.candidate_ref) || candidateRefs.has(candidate.candidate_ref)) {
      throw new CompositionAuthorityError("compose page candidate refs are invalid or duplicated");
    }
    candidateRefs.add(candidate.candidate_ref);
    if (
      candidate.source_ids.length > 64 ||
      new Set(candidate.source_ids).size !== candidate.source_ids.length ||
      candidate.source_ids.some((sourceId) => !OPAQUE.test(sourceId))
    ) {
      throw new CompositionAuthorityError("compose source bounds are invalid or duplicated");
    }
    const allocatedPageId = allocatedId("page", {
      runId: input.runId,
      baseGenerationId: input.baseGenerationId,
      pageCandidateRef: candidate.candidate_ref,
    });
    const pageId = candidate.supersedes?.page_id ?? allocatedPageId;
    const revisionId = allocatedId("rev", {
      runId: input.runId,
      baseGenerationId: input.baseGenerationId,
      pageCandidateRef: candidate.candidate_ref,
    });
    if (pageIds.has(pageId) || revisionIds.has(revisionId)) {
      throw new CompositionAuthorityError("compose page or revision allocation is duplicated");
    }
    pageIds.add(pageId);
    revisionIds.add(revisionId);

    const selected = input.baseCatalog.pages[pageId];
    if (candidate.supersedes === undefined) {
      if (selected !== undefined) {
        throw new CompositionAuthorityError("new-page allocation collides with a selected page");
      }
    } else if (
      candidate.supersedes.page_id !== pageId ||
      !selectedPageIds.has(pageId) ||
      selected === undefined ||
      selected.revision_id !== candidate.supersedes.revision_id ||
      selected.page_sha256 !== candidate.supersedes.page_sha256 ||
      selected.claims_sha256 !== candidate.supersedes.claims_sha256
    ) {
      throw new CompositionAuthorityError("supersede allocation is outside the selected base");
    }

    const claimAllocations = candidate.claim_candidate_refs.map((candidateRef) => {
      if (!OPAQUE.test(candidateRef) || claimCandidateRefs.has(candidateRef)) {
        throw new CompositionAuthorityError(
          "compose claim candidate refs are invalid or duplicated"
        );
      }
      claimCandidateRefs.add(candidateRef);
      const claimId = allocatedId("clm", {
        runId: input.runId,
        baseGenerationId: input.baseGenerationId,
        pageCandidateRef: candidate.candidate_ref,
        claimCandidateRef: candidateRef,
      });
      if (claimIds.has(claimId)) {
        throw new CompositionAuthorityError("compose claim identity allocation is duplicated");
      }
      claimIds.add(claimId);
      return { candidate_ref: candidateRef, claim_id: claimId };
    });

    return {
      page_id: pageId,
      revision_id: revisionId,
      lifecycle: candidate.lifecycle ?? ("draft" as const),
      source_ids: [...candidate.source_ids],
      claim_allocations: claimAllocations,
      supersedes: candidate.supersedes ?? null,
    };
  });

  return validateKbContract(
    KbComposeAuthoritySchema,
    {
      schema_version: 1,
      kb_id: input.kbId,
      base_generation_id: input.baseGenerationId,
      base_catalog_sha256: input.baseCatalogSha256,
      private_input_sha256: input.privateInputSha256,
      selected_pages: selectedPages,
      allocations,
    },
    "compose authority"
  );
}

function sameCatalogPage(
  left: { revision_id: string; page_sha256: string; claims_sha256: string } | undefined,
  right: KbComposeSupersedeBound
): boolean {
  return (
    left !== undefined &&
    left.revision_id === right.revision_id &&
    left.page_sha256 === right.page_sha256 &&
    left.claims_sha256 === right.claims_sha256
  );
}

/**
 * Validate draft conversion against the all-and-only allocation pool and the
 * exact selected base. No normalization or fallback may create an identity.
 */
export function validatePageDraftAuthority(input: {
  readonly document: unknown;
  readonly authority: KbComposeAuthority;
  readonly selectedGenerationId: string;
  readonly selectedCatalogSha256: string;
  readonly selectedCatalog: GenerationCatalog;
  readonly claimCandidates?: ReadonlyMap<string, ComposeClaimCandidateBody>;
}): PageDraftArtifact {
  const authority = validateKbContract(
    KbComposeAuthoritySchema,
    input.authority,
    "compose authority"
  );
  if (
    authority.base_generation_id !== input.selectedGenerationId ||
    authority.base_catalog_sha256 !== input.selectedCatalogSha256
  ) {
    throw new CompositionAuthorityError("compose allocation base generation drifted");
  }
  const selectedPageIds = new Set<string>();
  for (const bound of authority.selected_pages) {
    if (
      selectedPageIds.has(bound.page_id) ||
      !sameCatalogPage(input.selectedCatalog.pages[bound.page_id], bound)
    ) {
      throw new CompositionAuthorityError("compose selected-page bound drifted");
    }
    selectedPageIds.add(bound.page_id);
  }
  const document = validateKbContract(PageDraftArtifactSchema, input.document, "page draft");
  if (document.pages.length !== authority.allocations.length) {
    throw new CompositionAuthorityError(
      "page draft did not consume every page allocation exactly once"
    );
  }

  const allocations = new Map(authority.allocations.map((item) => [item.page_id, item]));
  const consumedPages = new Set<string>();
  const consumedRevisions = new Set<string>();
  const consumedClaims = new Set<string>();

  for (const page of document.pages) {
    const pageId = page.frontmatter.page_id;
    const allocation = allocations.get(pageId);
    if (allocation === undefined) {
      throw new CompositionAuthorityError("page draft used an unallocated page identity");
    }
    if (consumedPages.has(pageId)) {
      throw new CompositionAuthorityError("page draft consumed one page allocation more than once");
    }
    consumedPages.add(pageId);
    if (
      page.frontmatter.revision_id !== allocation.revision_id ||
      page.claims.page_id !== allocation.page_id ||
      page.claims.revision_id !== allocation.revision_id ||
      page.frontmatter.lifecycle !== allocation.lifecycle ||
      consumedRevisions.has(page.frontmatter.revision_id)
    ) {
      throw new CompositionAuthorityError(
        "page draft used an identity or lifecycle outside its allocation"
      );
    }
    consumedRevisions.add(page.frontmatter.revision_id);

    if (allocation.supersedes === null) {
      if (
        page.frontmatter.previous_revision_id !== undefined ||
        input.selectedCatalog.pages[pageId] !== undefined
      ) {
        throw new CompositionAuthorityError("page draft invented an existing-page supersede");
      }
    } else if (
      page.frontmatter.previous_revision_id !== allocation.supersedes.revision_id ||
      allocation.supersedes.page_id !== pageId ||
      !sameCatalogPage(input.selectedCatalog.pages[pageId], allocation.supersedes)
    ) {
      throw new CompositionAuthorityError(
        "page draft exceeded its exact selected-page supersede bound"
      );
    }

    const claimAllocations = new Map(
      allocation.claim_allocations.map((claimAllocation) => [
        claimAllocation.claim_id,
        claimAllocation,
      ])
    );
    const allowedClaims = new Set(claimAllocations.keys());
    if (page.claims.claims.length !== allowedClaims.size) {
      throw new CompositionAuthorityError(
        "page draft did not consume every claim allocation exactly once"
      );
    }
    const allowedSources = new Set(allocation.source_ids);
    for (const claim of page.claims.claims) {
      if (!allowedClaims.has(claim.claim_id)) {
        throw new CompositionAuthorityError("page draft used an unallocated claim identity");
      }
      if (consumedClaims.has(claim.claim_id)) {
        throw new CompositionAuthorityError(
          "page draft consumed one claim allocation more than once"
        );
      }
      if (claim.evidence.some((entry) => !allowedSources.has(entry.source_id))) {
        throw new CompositionAuthorityError("page draft claim exceeded its allocated source bound");
      }
      const candidateRef = claimAllocations.get(claim.claim_id)?.candidate_ref;
      const candidate =
        candidateRef === undefined ? undefined : input.claimCandidates?.get(candidateRef);
      if (
        input.claimCandidates !== undefined &&
        (candidate === undefined ||
          canonicalJson({
            text: claim.text,
            kind: claim.kind,
            confidence: claim.confidence,
            evidence: claim.evidence,
          }) !== canonicalJson(candidate))
      ) {
        throw new CompositionAuthorityError(
          "page draft reassigned an allocated claim identity to a different candidate"
        );
      }
      consumedClaims.add(claim.claim_id);
    }
  }

  const allocatedClaimCount = authority.allocations.reduce(
    (count, allocation) => count + allocation.claim_allocations.length,
    0
  );
  if (
    consumedPages.size !== authority.allocations.length ||
    consumedClaims.size !== allocatedClaimCount
  ) {
    throw new CompositionAuthorityError(
      "compose allocation pool was not consumed all-and-only once"
    );
  }
  return document;
}
