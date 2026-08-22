import { readPageRevision, readSourceObject, readSourceRecord } from "./filesystem.js";
import { readSelectedGeneration } from "./generations.js";
import type { Checkpointer } from "../checkpointer.js";
import { RunArtifactStore } from "./run-artifacts.js";
import { canonicalJson, validateKbContract, QueryAnswerArtifactSchema } from "./contracts.js";

/** Readers binding save composition/verification to the exact claimed query answer evidence. */
export function createSaveEvidenceReader(input: {
  kbRoot: string;
  queryRunId: string;
  answerArtifactId: string;
  checkpointer: Checkpointer;
}) {
  const store = new RunArtifactStore(input.kbRoot, input.queryRunId, input.checkpointer);
  let document: ReturnType<typeof validateAnswer>;
  try {
    document = validateAnswer(store.read(input.answerArtifactId).content);
  } finally {
    store.close();
  }
  const selected = readSelectedGeneration(input.kbRoot);
  if (selected === undefined) throw new Error("the KB has no selected generation");

  const allowedPages = new Map<string, string>();
  const directlyAllowedSources = new Set<string>();
  for (const citation of document.answer.citations) {
    if (citation.kind === "source") directlyAllowedSources.add(citation.source_id);
    else allowedPages.set(citation.page_id, citation.revision_id);
  }
  const cachedPages = new Map<string, ReturnType<typeof readPageRevision>>();
  const allowedSources = new Set(directlyAllowedSources);
  for (const [pageId, revisionId] of allowedPages) {
    const entry = selected.catalog.pages[pageId];
    if (entry?.revision_id !== revisionId) {
      throw new Error("a cited page revision is no longer selected");
    }
    const page = readPageRevision(input.kbRoot, pageId, revisionId, {
      pageSha256: entry.page_sha256,
      claimsSha256: entry.claims_sha256,
    });
    cachedPages.set(pageId, page);
    for (const claim of page.claims.claims) {
      if (claim.state !== "supported") continue;
      for (const evidence of claim.evidence) allowedSources.add(evidence.source_id);
    }
  }

  return {
    allowedSelectedPages(): Array<{ page_id: string; revision_id: string }> {
      return [...allowedPages].map(([page_id, revision_id]) => ({ page_id, revision_id }));
    },
    readSelectedPage(pageId: string, requestedRevisionId: string): string {
      const revisionId = allowedPages.get(pageId);
      const page = cachedPages.get(pageId);
      if (revisionId === undefined || revisionId !== requestedRevisionId || page === undefined) {
        throw new Error("page is outside the claimed answer evidence scope");
      }
      const document = splitPage(page.page_markdown);
      return canonicalJson({
        schema_version: 1,
        generation_id: selected.selector.generation_id,
        frontmatter: document.frontmatter,
        markdown: document.markdown,
        claims: page.claims,
      });
    },
    readSelectedSource(sourceId: string): string {
      if (
        !allowedSources.has(sourceId) ||
        !Object.hasOwn(selected.catalog.source_records, sourceId)
      ) {
        throw new Error("source is outside the claimed answer evidence scope");
      }
      const recordDigest = selected.catalog.source_records[sourceId];
      if (recordDigest === undefined) {
        throw new Error("selected source record lost its catalog digest");
      }
      const record = readSourceRecord(input.kbRoot, sourceId, recordDigest);
      return readSourceObject(input.kbRoot, record.sha256).toString("utf8");
    },
  };
}

function splitPage(pageMarkdown: string): {
  frontmatter: Record<string, unknown>;
  markdown: string;
} {
  const match = pageMarkdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("selected page does not have the canonical page encoding");
  }
  const frontmatter = JSON.parse(match[1]) as unknown;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("selected page frontmatter is invalid");
  }
  return { frontmatter: frontmatter as Record<string, unknown>, markdown: match[2] };
}

function validateAnswer(content: string) {
  return validateKbContract(
    QueryAnswerArtifactSchema,
    JSON.parse(content),
    "claimed query answer artifact"
  );
}
