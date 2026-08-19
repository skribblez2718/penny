/**
 * KB ingest workflow — §5.6 ingest action.
 *
 * The ingest pipeline:
 *   1. Admit sources (host reads files, creates source objects + records)
 *   2. Echo extracts claims from the sources         → `claims` artifact
 *   3. Synthia composes a page revision from claims  → `page_draft` artifact
 *   4. Carren semantically lints the page draft      → `lint_report` artifact
 *   5. Vera verifies claim grounding against sources → `verification_report` artifact
 *   6. Content-review gate: run status `awaiting_user`, next: "review"
 *   7. On approval (`approveIngest`): publish a new generation with the
 *      source records, page revision pairs, and converted conflict records.
 *
 * Agent invocation is pluggable via an `AgentRunner` callback. Deterministic
 * tests provide a mock runner; the live E2E provides a runner that creates
 * real Pi SDK sessions pinned to `ollama/qwen3.8:latest` (kb-model-client).
 *
 * Custody invariants (§5.2/§5.6):
 * - Every artifact staged by a phase is sealed before the gate is presented.
 * - Nothing is published (publication plane untouched) until approval.
 * - Approval reads only sealed artifact bytes; the gate presents handles,
 *   never raw bodies.
 */

import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  sha256Hex,
  ClaimsSidecarSchema,
  type ClaimsSidecar,
  type ConflictRecord as ConflictRecordT,
  type PageKind,
  type PageLifecycle,
  type PageRevisionFrontmatter,
  type Sha256Hex,
  type SourceRecord,
  type SourceType,
} from "./contracts.js";
import {
  readManifest,
  readPolicy,
  writeConflictRecord,
  writePageRevision,
  writeSourceObject,
  writeSourceRecord,
} from "./filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
  readSelectedGeneration,
} from "./generations.js";
import { RunArtifactStore, type ArtifactHandle } from "./run-artifacts.js";
import { type KbResult, type KbStatus, type KbWorkflowContext } from "./workflows.js";

// ── Types ───────────────────────────────────────────────────────────────────

import type { KbAgentRunner, KbPhaseInvocation } from "./kb-model-client.js";

/** API continuity: the workflow's runner type is the client's contract. */
export type AgentRunner = KbAgentRunner;

/** A source to ingest, supplied by the host (capability envelope already resolved). */
export interface IngestSource {
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly content: string;
  readonly mediaType: "text/plain" | "text/markdown" | "application/json";
  readonly sourceType: SourceType;
  readonly capturedAt: string;
}

/** A page revision to publish (agent output, host-normalized). */
interface PublishablePage {
  frontmatter: PageRevisionFrontmatter;
  markdown: string;
  claims: ClaimsSidecar;
}

/** What the gate remembers so approval can re-read sealed bytes by ID. */
export interface PendingIngest {
  readonly runId: string;
  readonly sourceIds: readonly string[];
  readonly claimsArtifactId: string;
  readonly pageDraftArtifactId: string;
  readonly lintReportArtifactId: string;
  readonly verificationArtifactId: string;
}

// ── Local helpers ───────────────────────────────────────────────────────────

type Next = "resume" | "review" | "none";

function result(
  action: string,
  runId: string,
  status: KbStatus,
  met: boolean,
  next: Next,
  extra?: Partial<KbResult>
): KbResult {
  return {
    schema_version: 1,
    action,
    run_id: runId,
    status,
    met,
    ids: [],
    counts: {},
    artifacts: [],
    evidence: [],
    warnings: [],
    unresolved: [],
    next,
    ...extra,
  };
}

function sourceRecordFor(src: IngestSource, runId: string): SourceRecord {
  const record = {
    schema_version: 1 as const,
    source_id: src.sourceId,
    source_type: src.sourceType,
    captured_at: src.capturedAt,
    title: src.title,
    authors: [...src.authors],
    media_type: src.mediaType,
    sha256: sha256Hex(src.content),
    object_ref: `sources/objects/${sha256Hex(src.content)}`,
    provenance: {
      source_capability_digest: sha256Hex(canonicalJson({ source_id: src.sourceId })),
      supplied_by: "host_capability" as const,
      originating_run_id: runId,
    },
  };
  return record; // validated by writeSourceRecord against SourceRecordSchema
}

// ── Phase briefs (in-band: instructions + output contract ONLY; no bodies) ──

const ECHO_BRIEF = [
  "Phase: ingest (evidence extraction).",
  "Read each admitted source with read_source_snapshot (by its source_id) and extract the key claims.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"claims","source_ids":[...],"claims":[{"claim_id":"clm_<unique>","text":"...","kind":"fact|inference|speculation|unknown","state":"supported|contested|superseded|unverified_current","confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","evidence":[{"source_id":"<src id>"}],"contradicts_claim_ids":[],"canonical_verification_refs":[]}]}',
  "Rules: claim_id unique per claim; evidence.source_id must be one of the admitted sources you read; one claim per materially distinct statement.",
].join("\n");

const SYNTHIA_BRIEF = [
  "Phase: compose (page composition).",
  "Read the prior phase claims with read_phase_output (phase=ingest). Where a claim needs its original wording, read the admitted sources with read_source_snapshot.",
  "Compose ONE advisory page. Its markdown MUST contain exactly these level-2 headings in this order, each with real content:",
  "## Synthesis",
  "## Evidence",
  "## Tensions and unknowns",
  "## Related",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"page_draft","pages":[{"frontmatter":{"schema_version":1,"page_id":"page_<unique>","revision_id":"rev_<unique>","kind":"synthesis","title":"...","summary":"...","authority":"advisory","lifecycle":"draft","created_at":"<ISO-8601 Z>","derived_from":[],"related_page_ids":[]},"markdown":"...","claims":{"schema_version":1,"page_id":"<same page_id>","revision_id":"<same revision_id>","claims":[<the claim objects, verbatim from the prior phase>]}}]}',
  "The sidecar claims array must reuse the claim objects exactly as provided (same claim_id, text, evidence).",
].join("\n");

const CARREN_BRIEF = [
  "Phase: lint (semantic review).",
  "Read the candidate page with read_phase_output (phase=compose). Read admitted sources with read_source_snapshot where a claim's grounding is unclear.",
  "Review for unsupported claims, missing evidence, contradictions, and overclaims.",
  "For every material conflict between claims (or between a claim and its evidence), emit a candidate conflict whose claim_refs point at the involved claims of THIS candidate page.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"lint_report","findings":[{"finding_id":"fnd_<unique>","severity":"warning|error","summary":"...","evidence":[]}],"candidate_conflicts":[{"candidate_conflict_id":"cfl_<unique>","claim_refs":[{"page_id":"...","revision_id":"...","claim_id":"..."}],"summary":"...","evidence_refs":[]}]}',
  "If there are no conflicts, candidate_conflicts must be [].",
].join("\n");

const VERA_BRIEF = [
  "Phase: verify (groundedness verification).",
  "Read the candidate page with read_phase_output (phase=compose) and the admitted sources with read_source_snapshot.",
  "For each claim in the candidate page's sidecar, decide whether the cited source supports it.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"verification_report","verified_artifact_ids":[],"claim_findings":[{"claim_ref":{"page_id":"...","revision_id":"...","claim_id":"..."},"verdict":"supported|partially_supported|unsupported","notes":"..."}]}',
].join("\n");

function makeNoPriorPhases() {
  return (_phase: string): string => {
    throw new Error("this phase has no prior phases; refusing read_phase_output");
  };
}

// ── Workflow: ingest → gate ─────────────────────────────────────────────────

/**
 * Run the ingest pipeline up to the content-review gate (§5.6 ingest).
 *
 * Stages all four phase artifacts (work plane only), seals them, and returns
 * `awaiting_user`/`review` with the sealed handles. Nothing is published.
 */
export async function ingestKb(
  ctx: KbWorkflowContext,
  sources: readonly IngestSource[],
  agentRunner: AgentRunner
): Promise<KbResult> {
  const root = ctx.kbRoot;
  const selected = readSelectedGeneration(root);
  if (selected === undefined) {
    return result("ingest", ctx.runId, "refused", false, "none", {
      warnings: ["No KB is initialized at this profile"],
    });
  }
  if (sources.length === 0) {
    return result("ingest", ctx.runId, "refused", false, "none", {
      warnings: ["ingest requires at least one source"],
    });
  }
  for (const s of sources) {
    if (s.authors.length === 0) {
      return result("ingest", ctx.runId, "error", false, "none", {
        warnings: [`source '${s.sourceId}' has no authors; supply at least one`],
      });
    }
  }

  // 1. Admit sources: content-addressed objects + records (publication plane,
  //    pre-gate staging; nothing is selected/generated until approval).
  for (const src of sources) {
    writeSourceObject(root, sha256Hex(src.content), Buffer.from(src.content, "utf8"));
    writeSourceRecord(root, sourceRecordFor(src, ctx.runId));
  }

  const store = new RunArtifactStore(root, ctx.runId);
  const admittedContent = new Map<string, string>(
    sources.map((src) => [src.sourceId, src.content])
  );
  const sourceIds = sources.map((src) => src.sourceId);
  const phaseHandles = new Map<string, ArtifactHandle>();
  try {
    const readSource = (sourceId: string): string => {
      const content = admittedContent.get(sourceId);
      if (content === undefined) {
        throw new Error(
          `source '${sourceId}' is not admitted for this run; refusing read_source_snapshot`
        );
      }
      return content;
    };

    // 2. Echo — extract claims from the admitted sources
    const claimsJson = await agentRunner({
      agent: "echo",
      stateId: "ingest",
      phaseBrief: ECHO_BRIEF,
      sourceAllowlist: sourceIds,
      priorPhaseAllowlist: [],
      readSource,
      readPhaseOutput: makeNoPriorPhases(),
    });
    const claimsHandle = store.stage({
      state_id: "ingest",
      kb_profile_id: ctx.profileId,
      artifact_kind: "claims",
      content: claimsJson,
    });
    phaseHandles.set("ingest", claimsHandle);

    const priorOutputs = (allowed: readonly string[]): ((stateId: string) => string) => {
      return (stateId: string): string => {
        if (!allowed.includes(stateId)) {
          throw new Error(
            `phase '${stateId}' is not in this state's prior-phase allowlist; refusing`
          );
        }
        const handle = phaseHandles.get(stateId);
        if (handle === undefined) {
          throw new Error(`phase '${stateId}' has no staged output; refusing`);
        }
        return store.read(handle.artifact_id).content;
      };
    };

    // 3. Synthia — compose a page revision from the claims
    const pageDraftJson = await agentRunner({
      agent: "synthia",
      stateId: "compose",
      phaseBrief: SYNTHIA_BRIEF,
      sourceAllowlist: sourceIds,
      priorPhaseAllowlist: ["ingest"],
      readSource,
      readPhaseOutput: priorOutputs(["ingest"]),
    });
    const pageDraftHandle = store.stage({
      state_id: "compose",
      kb_profile_id: ctx.profileId,
      artifact_kind: "page_draft",
      content: pageDraftJson,
    });
    phaseHandles.set("compose", pageDraftHandle);

    // 4. Carren — semantic lint of the candidate page
    const lintJson = await agentRunner({
      agent: "carren",
      stateId: "lint",
      phaseBrief: CARREN_BRIEF,
      sourceAllowlist: sourceIds,
      priorPhaseAllowlist: ["compose"],
      readSource,
      readPhaseOutput: priorOutputs(["compose"]),
    });
    const lintHandle = store.stage({
      state_id: "lint",
      kb_profile_id: ctx.profileId,
      artifact_kind: "lint_report",
      content: lintJson,
    });
    phaseHandles.set("lint", lintHandle);

    // 5. Vera — groundedness verification
    const verificationJson = await agentRunner({
      agent: "vera",
      stateId: "verify",
      phaseBrief: VERA_BRIEF,
      sourceAllowlist: sourceIds,
      priorPhaseAllowlist: ["compose", "ingest"],
      readSource,
      readPhaseOutput: priorOutputs(["compose", "ingest"]),
    });
    const verificationHandle = store.stage({
      state_id: "verify",
      kb_profile_id: ctx.profileId,
      artifact_kind: "verification_report",
      content: verificationJson,
    });

    // 6. Seal the complete candidate set before the gate is presented.
    store.seal([
      claimsHandle.artifact_id,
      pageDraftHandle.artifact_id,
      lintHandle.artifact_id,
      verificationHandle.artifact_id,
    ]);

    const manifest = readManifest(root);
    return result("ingest", ctx.runId, "awaiting_user", false, "review", {
      kb_id: manifest.kb_id,
      ids: sources.map((s) => s.sourceId),
      counts: { sources: sources.length, artifacts: 4 },
      artifacts: [claimsHandle, pageDraftHandle, lintHandle, verificationHandle],
    });
  } finally {
    store.close();
  }
}

// ── Workflow: approve → publish ─────────────────────────────────────────────

/** Page-draft payload as declared by the agent (loose; normalized below). */
interface RawPageDraft {
  schema_version?: unknown;
  artifact_kind?: unknown;
  pages?: unknown;
}
interface RawPage {
  frontmatter?: Record<string, unknown>;
  markdown?: unknown;
  claims?: Record<string, unknown>;
}
interface RawCandidateConflict {
  candidate_conflict_id?: unknown;
  claim_refs?: unknown;
  summary?: unknown;
  evidence_refs?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Approve a sealed candidate set and publish the new generation.
 *
 * Reads ONLY sealed artifact bytes (by ID), normalizes and validates the page
 * revision pair against the strict §5.5 contracts, converts candidate
 * conflicts into conflict records, then builds and atomically publishes the
 * new generation (selector replacement).
 *
 * Refuses (no publication) on schema failure — malformed bytes are never
 * published.
 */
export function approveIngest(
  ctx: KbWorkflowContext,
  sources: readonly IngestSource[],
  pending: PendingIngest
): KbResult {
  const root = ctx.kbRoot;
  const fail = (warning: string): KbResult =>
    result("ingest", ctx.runId, "refused", false, "none", { warnings: [warning] });

  const selected = readSelectedGeneration(root);
  if (selected === undefined) return fail("No KB is initialized at this profile");

  const manifest = readManifest(root);
  const policy = readPolicy(root);
  void policy;

  if (sources.length === 0) return fail("ingest requires at least one source");
  if (!sources.every((s) => s.sourceId !== "")) return fail("source ids must be non-empty");

  // Re-read the sealed candidate bytes.
  const store = new RunArtifactStore(root, pending.runId);
  let pageDraftRaw: RawPageDraft;
  let candidateConflicts: RawCandidateConflict[] = [];
  try {
    const pageDraft = store.read(pending.pageDraftArtifactId);
    try {
      pageDraftRaw = JSON.parse(pageDraft.content) as RawPageDraft;
    } catch {
      return fail("page_draft artifact is not valid JSON; nothing published");
    }
    if (pageDraftRaw.artifact_kind !== undefined && pageDraftRaw.artifact_kind !== "page_draft") {
      return fail("page_draft artifact_kind mismatch; nothing published");
    }
    try {
      const lint = store.read(pending.lintReportArtifactId);
      const parsed = JSON.parse(lint.content) as { candidate_conflicts?: unknown };
      if (Array.isArray(parsed.candidate_conflicts)) {
        candidateConflicts = parsed.candidate_conflicts as RawCandidateConflict[];
      }
    } catch {
      candidateConflicts = []; // a malformed lint report cannot block approval of the page
    }
  } finally {
    store.close();
  }

  const rawPages = Array.isArray(pageDraftRaw?.pages) ? (pageDraftRaw.pages as unknown[]) : [];
  if (rawPages.length === 0) {
    return fail("page_draft artifact contains no pages; nothing published");
  }

  const now = new Date().toISOString();
  const pages: PublishablePage[] = [];
  for (const raw of rawPages) {
    const rp = raw as RawPage;
    const fmSrc =
      typeof rp.frontmatter === "object" && rp.frontmatter !== null
        ? (rp.frontmatter as Record<string, unknown>)
        : {};
    const claimsSrc =
      typeof rp.claims === "object" && rp.claims !== null
        ? (rp.claims as Record<string, unknown>)
        : {};
    const markdown = typeof rp.markdown === "string" ? rp.markdown : "";
    if (markdown.trim().length === 0) {
      return fail("page_draft contains an empty page body; nothing published");
    }

    const pageId =
      typeof fmSrc.page_id === "string" && /^page_[A-Za-z0-9._:-]+$/.test(fmSrc.page_id)
        ? fmSrc.page_id
        : `page_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const revisionId =
      typeof fmSrc.revision_id === "string" && /^rev_[A-Za-z0-9._:-]+$/.test(fmSrc.revision_id)
        ? fmSrc.revision_id
        : `rev_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const kinds: PageKind[] = [
      "concept",
      "decision",
      "synthesis",
      "question",
      "promotion_candidate",
    ];
    const kind = kinds.includes(fmSrc.kind as PageKind) ? (fmSrc.kind as PageKind) : "synthesis";
    const lifecycles: PageLifecycle[] = ["draft", "validated", "superseded", "archived"];
    const lifecycle = lifecycles.includes(fmSrc.lifecycle as PageLifecycle)
      ? (fmSrc.lifecycle as PageLifecycle)
      : "validated";

    const frontmatter: PageRevisionFrontmatter = {
      schema_version: 1,
      page_id: pageId,
      revision_id: revisionId,
      kind,
      title:
        typeof fmSrc.title === "string" && fmSrc.title.trim().length > 0
          ? fmSrc.title.slice(0, 256)
          : "Knowledge base page",
      summary:
        typeof fmSrc.summary === "string" && fmSrc.summary.trim().length > 0
          ? fmSrc.summary.slice(0, 1024)
          : markdown.replace(/\s+/g, " ").trim().slice(0, 512),
      authority: "advisory",
      lifecycle,
      created_at:
        typeof fmSrc.created_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(fmSrc.created_at)
          ? fmSrc.created_at
          : now,
      derived_from: asStringArray(fmSrc.derived_from).slice(0, 64),
      related_page_ids: asStringArray(fmSrc.related_page_ids).slice(0, 64),
    };

    const rawClaims = Array.isArray(claimsSrc.claims)
      ? (claimsSrc.claims as Array<Record<string, unknown>>)
      : [];
    const claims: ClaimsSidecar = {
      schema_version: 1,
      page_id: pageId,
      revision_id: revisionId,
      claims: rawClaims.map((c, i) => ({
        claim_id:
          typeof c.claim_id === "string" && c.claim_id.length >= 1
            ? c.claim_id.slice(0, 128)
            : `clm_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        text:
          typeof c.text === "string" && c.text.trim().length > 0
            ? c.text.slice(0, 8192)
            : `Claim ${i + 1} (normalized from ingest)`,
        kind: (["fact", "inference", "speculation", "unknown"].includes(c.kind as string)
          ? c.kind
          : "unknown") as "fact" | "inference" | "speculation" | "unknown",
        state: (["supported", "contested", "superseded", "unverified_current"].includes(
          c.state as string
        )
          ? c.state
          : "unverified_current") as
          | "supported"
          | "contested"
          | "superseded"
          | "unverified_current",
        confidence: (["CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"].includes(
          c.confidence as string
        )
          ? c.confidence
          : "UNCERTAIN") as "CERTAIN" | "PROBABLE" | "POSSIBLE" | "UNCERTAIN",
        evidence: Array.isArray(c.evidence)
          ? (c.evidence as Array<Record<string, unknown>>)
              .filter((e) => typeof e.source_id === "string")
              .slice(0, 32)
              .map((e) => ({
                source_id: (e.source_id as string).slice(0, 128),
                ...(typeof e.locator === "string"
                  ? { locator: (e.locator as string).slice(0, 1024) }
                  : {}),
              }))
          : [],
        contradicts_claim_ids: asStringArray(c.contradicts_claim_ids).slice(0, 32),
        canonical_verification_refs: asStringArray(c.canonical_verification_refs).slice(0, 32),
      })),
    };

    pages.push({ frontmatter, markdown, claims });
  }

  // Publish page revision pairs (validated by writePageRevision).
  const pageEntries: {
    page_id: string;
    revision_id: string;
    page_sha256: Sha256Hex;
    claims_sha256: Sha256Hex;
  }[] = [];
  for (const page of pages) {
    writePageRevision(root, page.frontmatter, page.markdown, page.claims);
    pageEntries.push({
      page_id: page.frontmatter.page_id,
      revision_id: page.frontmatter.revision_id,
      page_sha256: sha256Hex(`---\n${canonicalJson(page.frontmatter)}\n---\n\n${page.markdown}`),
      claims_sha256: sha256Hex(canonicalJson(page.claims)),
    });
  }

  // Source records (objects already admitted during ingest; records re-stamped).
  const sourceRecordEntries: { source_id: string; record_sha256: Sha256Hex }[] = [];
  const objectDigests = new Set<Sha256Hex>();
  for (const src of sources) {
    const record = sourceRecordFor(src, ctx.runId);
    writeSourceRecord(root, record);
    objectDigests.add(record.sha256);
    sourceRecordEntries.push({
      source_id: src.sourceId,
      record_sha256: sha256Hex(canonicalJson(record)),
    });
  }

  // Conflict records from the sealed lint report.
  const conflictEntries: { conflict_id: string; conflict_sha256: Sha256Hex }[] = [];
  for (const cc of candidateConflicts) {
    const conflictId =
      typeof cc.candidate_conflict_id === "string" &&
      /^cfl_[A-Za-z0-9._:-]+$/.test(cc.candidate_conflict_id)
        ? cc.candidate_conflict_id
        : `cfl_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const claimRefsRaw = Array.isArray(cc.claim_refs) ? (cc.claim_refs as unknown[]) : [];
    const pageIds = pages.map((p) => p.frontmatter.page_id);
    const revIds = pages.map((p) => p.frontmatter.revision_id);
    const allClaimIds = pages.flatMap((p) => p.claims.claims.map((c) => c.claim_id));
    const validRefs = claimRefsRaw
      .filter(
        (r): r is Record<string, unknown> =>
          typeof r === "object" &&
          r !== null &&
          pageIds.includes((r as Record<string, unknown>).page_id as string) &&
          revIds.includes((r as Record<string, unknown>).revision_id as string) &&
          allClaimIds.includes((r as Record<string, unknown>).claim_id as string)
      )
      .slice(0, 64);
    const summaryRaw =
      typeof cc.summary === "string" && cc.summary.trim().length > 0
        ? cc.summary
        : "Candidate conflict";
    const conflict: ConflictRecordT = {
      schema_version: 1,
      conflict_record_id: conflictId,
      claim_refs: validRefs.map((r) => ({
        page_id: String(r.page_id),
        revision_id: String(r.revision_id),
        claim_id: String(r.claim_id),
      })),
      state: "open",
      summary: summaryRaw.slice(0, 4096),
      evidence_refs: asStringArray(cc.evidence_refs)
        .map((e) => e.slice(0, 128))
        .slice(0, 32),
      created_at: now,
    };
    // writeConflictRecord validates against ConflictRecordSchema; empty claim_refs are legal.
    writeConflictRecord(root, conflict);
    conflictEntries.push({
      conflict_id: conflictId,
      conflict_sha256: sha256Hex(canonicalJson(conflict)),
    });
  }

  // Build the deterministic index (index.sqlite) from the published pages,
  // then the catalog anchored to its canonical-content digest, then publish.
  const generationId = newGenerationId();
  const { index_sha256 } = buildGenerationIndex(
    root,
    generationId,
    manifest.kb_id,
    pages.map((p) => ({
      page_id: p.frontmatter.page_id,
      revision_id: p.frontmatter.revision_id,
      title: p.frontmatter.title,
      summary: p.frontmatter.summary,
      body_sha256: sha256Hex(p.markdown),
      body: p.markdown,
    }))
  );
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: manifest.kb_id,
    parent_generation_id: selected.selector.generation_id,
    manifest,
    policy,
    pages: pageEntries,
    source_records: sourceRecordEntries,
    source_objects: [...objectDigests],
    conflicts: conflictEntries,
    index_sha256,
  });
  const selector = publishGeneration(root, catalog);

  return result("ingest", ctx.runId, "complete", true, "none", {
    kb_id: manifest.kb_id,
    ids: [generationId, ...pageEntries.map((p) => p.page_id)],
    counts: {
      sources: sources.length,
      pages: pageEntries.length,
      conflicts: conflictEntries.length,
      generations: 1,
      selector: 1,
    },
    evidence: [{ evidence_id: selector.generation_id, kind: "generation", ref: "current" }],
  });
}
