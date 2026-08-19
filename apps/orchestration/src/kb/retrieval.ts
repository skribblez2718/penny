/**
 * KB retrieval — deterministic lexical ranking over one selected generation.
 *
 * v1 retrieval is deterministic: lexical/FTS matching with descending score and
 * ties broken by UTF-8 bytewise `(page_id, revision_id)`. There is one candidate
 * per revision. Semantic retrieval is a measured future decision, not a v1 promise.
 *
 * The search is closed over the validated request — the child's search tool takes
 * no query field, using the admitted query, filters, and candidate bound already
 * validated by the host.
 */

import type { GenerationCatalog } from "./contracts.js";

export interface RetrievalCandidate {
  page_id: string;
  revision_id: string;
  score: number;
  claim_ids: string[];
  excerpt: string;
}

/**
 * Rank pages from a generation catalog by lexical match against a query.
 *
 * Scoring is simple term-frequency: for each query term, a page that contains it
 * in its title or summary scores higher. Ties are broken by UTF-8 bytewise
 * `(page_id, revision_id)`, which makes the ranking deterministic and reproducible.
 *
 * This is the v1 deterministic floor. It is deliberately simple — the point is
 * that the same corpus and query always produce the same ranking, so a retrieval
 * regression is measurable rather than anecdotal.
 */
export function rankPages(input: {
  catalog: GenerationCatalog;
  query: string;
  pageContents: ReadonlyMap<string, { title: string; summary: string; markdown: string }>;
  maxCandidates?: number;
}): RetrievalCandidate[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const candidates: RetrievalCandidate[] = [];
  for (const [pageId, entry] of Object.entries(input.catalog.pages)) {
    const content = input.pageContents.get(pageId);
    if (content === undefined) continue;

    let score = 0;
    const text = `${content.title} ${content.summary} ${content.markdown}`.toLowerCase();
    for (const term of terms) {
      const matches = text.split(term).length - 1;
      score += matches;
    }

    candidates.push({
      page_id: pageId,
      revision_id: entry.revision_id,
      score,
      claim_ids: [],
      excerpt: content.summary,
    });
  }

  // Sort by descending score, ties by UTF-8 bytewise (page_id, revision_id)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.page_id !== b.page_id) return a.page_id < b.page_id ? -1 : 1;
    return a.revision_id < b.revision_id ? -1 : a.revision_id > b.revision_id ? 1 : 0;
  });

  const max = input.maxCandidates ?? 20;
  return candidates.slice(0, max);
}

/**
 * Compute hit@k: the fraction of cases whose top-k intersects the expected relevant set.
 */
export function hitAtK(
  results: ReadonlyArray<{
    candidates: RetrievalCandidate[];
    expected: ReadonlyArray<{ page_id: string }>;
  }>,
  k: number
): number {
  if (results.length === 0) return 0;
  let hits = 0;
  for (const r of results) {
    const topK = new Set(r.candidates.slice(0, k).map((c) => c.page_id));
    const expected = new Set(r.expected.map((e) => e.page_id));
    if ([...topK].some((p) => expected.has(p))) hits++;
  }
  return hits / results.length;
}

/**
 * Compute MRR: mean reciprocal rank of the first relevant result.
 */
export function meanReciprocalRank(
  results: ReadonlyArray<{
    candidates: RetrievalCandidate[];
    expected: ReadonlyArray<{ page_id: string }>;
  }>
): number {
  if (results.length === 0) return 0;
  let sum = 0;
  for (const r of results) {
    const expected = new Set(r.expected.map((e) => e.page_id));
    for (let i = 0; i < r.candidates.length; i++) {
      if (expected.has(r.candidates[i]!.page_id)) {
        sum += 1 / (i + 1);
        break;
      }
    }
  }
  return sum / results.length;
}
