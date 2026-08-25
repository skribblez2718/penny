import { canonicalJson } from "./contracts.js";
import { readPageRevision } from "./filesystem.js";
import { readClaimedCanonicalTarget } from "./gate.js";
import { readSelectedGeneration } from "./generations.js";

/** Host-closed promotion readers over one exact request scope. No path is returned. */
export function createPromotionReader(input: {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  sessionId: string;
  profileId: string;
  operation: "promote";
  pageRevisions: readonly { page_id: string; revision_id: string }[];
  targetCapabilityIds: readonly string[];
}) {
  const allowedPages = new Map(input.pageRevisions.map((item) => [item.page_id, item.revision_id]));
  const allowedTargets = new Set(input.targetCapabilityIds);
  return {
    allowedSelectedPages(): Array<{ page_id: string; revision_id: string }> {
      return input.pageRevisions.map((revision) => ({ ...revision }));
    },
    readPhaseBrief(): string {
      return canonicalJson({
        schema_version: 1,
        action: "promote",
        page_revisions: input.pageRevisions,
        target_capability_ids: input.targetCapabilityIds,
      });
    },
    readSelectedPage(pageId: string, requestedRevisionId: string): string {
      const revisionId = allowedPages.get(pageId);
      if (revisionId === undefined || revisionId !== requestedRevisionId) {
        throw new Error("page is outside the promotion request scope");
      }
      const selected = readSelectedGeneration(input.kbRoot);
      const entry = selected?.catalog.pages[pageId];
      if (selected === undefined || entry?.revision_id !== revisionId) {
        throw new Error("page revision is no longer selected");
      }
      const revision = readPageRevision(input.kbRoot, pageId, revisionId, {
        pageSha256: entry.page_sha256,
        claimsSha256: entry.claims_sha256,
      });
      const document = splitPage(revision.page_markdown);
      return canonicalJson({
        schema_version: 1,
        generation_id: selected.selector.generation_id,
        frontmatter: document.frontmatter,
        markdown: document.markdown,
        claims: revision.claims,
      });
    },
    readCanonicalTarget(capabilityId: string): string {
      if (!allowedTargets.has(capabilityId)) {
        throw new Error("target capability is outside the promotion request scope");
      }
      if (input.operation !== "promote") {
        throw new Error("target capability reader has the wrong operation binding");
      }
      const {
        envelope,
        bytes,
        sha256: currentSha256,
      } = readClaimedCanonicalTarget({
        projectRoot: input.projectRoot,
        capabilityId,
        runId: input.runId,
        sessionId: input.sessionId,
        profileId: input.profileId,
      });
      return canonicalJson({
        schema_version: 1,
        capability_id: capabilityId,
        preimage_sha256: currentSha256,
        media_type: envelope.media_type ?? "text/plain",
        content_utf8: bytes.toString("utf8"),
      });
    },
  };
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitPage(pageMarkdown: string): {
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
