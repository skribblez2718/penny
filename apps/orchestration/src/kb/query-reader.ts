import { readPageRevision, readSourceObject, readSourceRecord } from "./filesystem.js";
import { readSelectedGeneration } from "./generations.js";
import { validateQueryRequest } from "./parent-delivery.js";
import { rankPages, type RetrievalCandidate } from "./retrieval.js";
import {
  canonicalJson,
  type ClaimsSidecar,
  type DerivedQueryAnswer,
  type QueryKbRequest,
  type Sha256Hex,
} from "./contracts.js";

export interface SupportedClaim {
  readonly claim_id: string;
  readonly source_ids: readonly string[];
}

export interface SelectedPage {
  readonly page_id: string;
  readonly revision_id: string;
  readonly title: string;
  readonly summary: string;
  readonly page_markdown: string;
  readonly claims: ClaimsSidecar;
  readonly supported_claims: readonly SupportedClaim[];
}

export interface QuerySelection {
  readonly kbId: string;
  readonly generationId: string;
  readonly candidates: readonly RetrievalCandidate[];
  readonly pages: ReadonlyMap<string, SelectedPage>;
  readonly selectedSourceRecords: ReadonlyMap<string, Sha256Hex>;
  readonly unresolved: readonly string[];
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitSelectedPage(pageMarkdown: string): {
  frontmatter: Record<string, unknown>;
  markdown: string;
} {
  const match = pageMarkdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("selected page does not have the canonical page encoding");
  }
  const frontmatter = parseJsonValue(match[1]);
  if (!isUnknownRecord(frontmatter)) {
    throw new Error("selected page frontmatter is invalid");
  }
  return { frontmatter, markdown: match[2] };
}

function frontmatterText(pageMarkdown: string): { title?: string; summary?: string } {
  const match = pageMarkdown.match(/^---\n([\s\S]*?)\n---/);
  if (match?.[1] === undefined) return {};
  try {
    const value = parseJsonValue(match[1]);
    if (!isUnknownRecord(value)) return {};
    return {
      ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
      ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    };
  } catch {
    return {};
  }
}

function supportedClaims(claims: ClaimsSidecar): SupportedClaim[] {
  return claims.claims.flatMap((claim) => {
    const sourceIds = claim.evidence.map((entry) => entry.source_id);
    return claim.state === "supported" && sourceIds.length > 0
      ? [{ claim_id: claim.claim_id, source_ids: sourceIds }]
      : [];
  });
}

function claimsCiteAllowedSource(claims: ClaimsSidecar, allowed: ReadonlySet<string>): boolean {
  return claims.claims.some((claim) =>
    claim.evidence.some((entry) => allowed.has(entry.source_id))
  );
}

/**
 * Resolve one deterministic candidate set from one currently selected
 * generation. The optional generation binding makes every later reader fail
 * closed if the selector changes during the query run.
 */
export function selectQueryCandidates(input: {
  readonly kbRoot: string;
  readonly request: QueryKbRequest;
  readonly expectedGenerationId?: string;
}): QuerySelection | undefined {
  const selected = readSelectedGeneration(input.kbRoot);
  if (selected === undefined) return undefined;
  if (
    input.expectedGenerationId !== undefined &&
    selected.selector.generation_id !== input.expectedGenerationId
  ) {
    throw new Error("the selected KB generation changed during the query run");
  }

  const pageFilter =
    input.request.page_ids === undefined ? undefined : new Set(input.request.page_ids);
  const sourceFilter =
    input.request.source_ids === undefined ? undefined : new Set(input.request.source_ids);
  const unresolved: string[] = [];
  if (pageFilter !== undefined) {
    for (const requested of pageFilter) {
      if (!Object.hasOwn(selected.catalog.pages, requested)) {
        unresolved.push("unknown page filter id");
      }
    }
  }

  const pages = new Map<string, SelectedPage>();
  const pageContents = new Map<
    string,
    { title: string; summary: string; markdown: string; claim_ids: readonly string[] }
  >();
  for (const [pageId, entry] of Object.entries(selected.catalog.pages)) {
    if (pageFilter !== undefined && !pageFilter.has(pageId)) continue;
    try {
      const revision = readPageRevision(input.kbRoot, pageId, entry.revision_id, {
        pageSha256: entry.page_sha256,
        claimsSha256: entry.claims_sha256,
      });
      if (sourceFilter !== undefined && !claimsCiteAllowedSource(revision.claims, sourceFilter)) {
        continue;
      }
      const frontmatter = frontmatterText(revision.page_markdown);
      const page: SelectedPage = {
        page_id: pageId,
        revision_id: entry.revision_id,
        title: frontmatter.title ?? pageId,
        summary: frontmatter.summary ?? "",
        page_markdown: revision.page_markdown,
        claims: revision.claims,
        supported_claims: supportedClaims(revision.claims),
      };
      pages.set(pageId, page);
      pageContents.set(pageId, {
        title: page.title,
        summary: page.summary,
        markdown: page.page_markdown,
        claim_ids: page.claims.claims.map((claim) => claim.claim_id),
      });
    } catch {
      unresolved.push("selected page could not be read");
    }
  }

  const candidates = rankPages({
    catalog: selected.catalog,
    query: input.request.query,
    pageContents,
    maxCandidates: input.request.max_candidates ?? 20,
  }).filter((candidate) => (pages.get(candidate.page_id)?.supported_claims.length ?? 0) > 0);
  const candidateIds = new Set(candidates.map((candidate) => candidate.page_id));
  return {
    kbId: selected.catalog.kb_id,
    generationId: selected.selector.generation_id,
    candidates,
    pages: new Map([...pages].filter(([pageId]) => candidateIds.has(pageId))),
    selectedSourceRecords: new Map(Object.entries(selected.catalog.source_records)),
    unresolved,
  };
}

/**
 * Host-closed readers for the two query agent phases. The request closure is
 * called only by these readers; neither the request nor any selected body is
 * copied into a prompt or control-state field.
 */
export class KbQueryReader {
  private selection?: QuerySelection;
  private request?: QueryKbRequest;

  constructor(
    private readonly input: {
      readonly kbRoot: string;
      readonly profileId: string;
      readonly readRequest: () => unknown;
      readonly selectedGenerationId: () => string;
    }
  ) {}

  private requireRequest(): QueryKbRequest {
    if (this.request === undefined) {
      const request = validateQueryRequest(this.input.readRequest());
      if (request.kb_profile_id !== this.input.profileId) {
        throw new Error("the private query request belongs to another KB profile");
      }
      this.request = request;
    }
    return this.request;
  }

  private requireSelection(): QuerySelection {
    if (this.selection === undefined) {
      const expectedGenerationId = this.input.selectedGenerationId();
      if (expectedGenerationId.length === 0) {
        throw new Error("the query run has no selected-generation binding");
      }
      const selected = selectQueryCandidates({
        kbRoot: this.input.kbRoot,
        request: this.requireRequest(),
        expectedGenerationId,
      });
      if (selected === undefined) throw new Error("the KB has no selected generation");
      this.selection = selected;
    }
    return this.selection;
  }

  readRequest = (): string => canonicalJson(this.requireRequest());

  selectedPageRefs = (): Array<{ page_id: string; revision_id: string }> =>
    this.requireSelection().candidates.map((candidate) => ({
      page_id: candidate.page_id,
      revision_id: candidate.revision_id,
    }));

  searchSelectedKb = (): string => {
    const selected = this.requireSelection();
    return canonicalJson({
      schema_version: 1,
      generation_id: selected.generationId,
      candidates: selected.candidates.map((candidate) => ({
        page_id: candidate.page_id,
        revision_id: candidate.revision_id,
        score: candidate.score,
        claim_ids: candidate.claim_ids,
        excerpt: candidate.excerpt,
      })),
    });
  };

  /** Legacy name for focused non-session callers; never registered as a child tool. */
  searchSelectedGeneration = this.searchSelectedKb;

  readSelectedPage = (pageId: string, revisionId: string): string => {
    const selection = this.requireSelection();
    const page = selection.pages.get(pageId);
    if (page === undefined || page.revision_id !== revisionId) {
      throw new Error(`page '${pageId}' is not in this query's candidate allowlist; refusing`);
    }
    const document = splitSelectedPage(page.page_markdown);
    return canonicalJson({
      schema_version: 1,
      generation_id: selection.generationId,
      frontmatter: document.frontmatter,
      markdown: document.markdown,
      claims: page.claims,
    });
  };

  readSelectedSource = (sourceId: string): string => {
    const selected = this.requireSelection();
    const allowed = new Set(
      [...selected.pages.values()].flatMap((page) =>
        page.supported_claims.flatMap((claim) => [...claim.source_ids])
      )
    );
    if (!allowed.has(sourceId)) {
      throw new Error(`source '${sourceId}' is not cited by this query's candidates; refusing`);
    }
    return selectedCatalogSource(selected, this.input.kbRoot, sourceId);
  };
}

function selectedCatalogSource(
  selection: QuerySelection,
  kbRoot: string,
  sourceId: string
): string {
  // Re-open through the custody-checked source record/object readers. The
  // generation binding was revalidated while constructing `selection`; source
  // IDs outside candidate evidence never reach this function.
  const recordDigest = selection.selectedSourceRecords.get(sourceId);
  if (recordDigest === undefined) {
    throw new Error(`source '${sourceId}' is not part of the bound selected generation; refusing`);
  }
  const record = readSourceRecord(kbRoot, sourceId, recordDigest);
  return readSourceObject(kbRoot, record.sha256).toString("utf8");
}

/** Host check that every answer citation belongs to the bound candidate set. */
export function citationsBelongToSelection(
  selection: QuerySelection,
  answer: DerivedQueryAnswer
): boolean {
  for (const citation of answer.citations) {
    if (citation.kind === "page") {
      const page = selection.pages.get(citation.page_id);
      if (page === undefined || page.revision_id !== citation.revision_id) return false;
      continue;
    }
    if (citation.kind === "claim") {
      const page = selection.pages.get(citation.page_id);
      if (
        page === undefined ||
        page.revision_id !== citation.revision_id ||
        !page.supported_claims.some((claim) => claim.claim_id === citation.claim_id)
      ) {
        return false;
      }
      continue;
    }
    const supportedSourceIds = new Set(
      [...selection.pages.values()].flatMap((page) =>
        page.supported_claims.flatMap((claim) => [...claim.source_ids])
      )
    );
    if (!supportedSourceIds.has(citation.source_id)) return false;
  }
  return true;
}
