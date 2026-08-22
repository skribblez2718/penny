/**
 * KB ingest workflow — §5.6 ingest action.
 *
 * The ingest pipeline:
 *   1. Read immutable same-run source snapshots (external paths are already closed)
 *   2. Echo extracts claims from the sources         → `claims` artifact
 *   3. Synthia composes a page revision from claims  → `page_draft` artifact
 *   4. Carren semantically lints the page draft      → `lint_report` artifact
 *   5. Vera verifies claim grounding against sources → `verification_report` artifact
 *   6. Content-review gate: run status `awaiting_user`, next: "review"
 *   7. On approval (`approveIngest`): publish source objects/records and a new
 *      generation with page revision pairs and converted conflict records.
 *
 * This pure publication-machine fixture accepts only an explicitly branded
 * test adapter for deterministic phase bodies. Live child execution never uses
 * this callback: it runs through KbWorkerClient's stage/submit tool boundary.
 *
 * Custody invariants (§5.2/§5.6):
 * - Every artifact staged by a phase is sealed before the gate is presented.
 * - Nothing is published (publication plane untouched) until approval.
 * - Approval reads only sealed artifact bytes; the gate presents handles,
 *   never raw bodies.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Checkpointer } from "../checkpointer.js";

import {
  canonicalJson,
  sha256Hex,
  type CandidateConflictAllocation,
  type ClaimsSidecar,
  ConflictRecordSchema,
  PageRevisionFrontmatterSchema,
  ClaimsSidecarSchema,
  SourceRecordSchema,
  validateKbContract,
  type ConflictRecord as ConflictRecordT,
  type PageKind,
  type PageLifecycle,
  type PageRevisionFrontmatter,
  type GenerationCatalog,
  type Sha256Hex,
  type SourceRecord,
  type SourceType,
} from "./contracts.js";
import {
  readManifest,
  readPageRevision,
  readPolicy,
  conflictPath,
  pageClaimsPath,
  pageMarkdownPath,
  sourceObjectPath,
  sourceObjectRef,
  sourceRecordPath,
} from "./filesystem.js";
import {
  buildCatalog,
  generationIndexDigest,
  openStandalonePublicationCheckpointer,
  publishGenerationTransaction,
  readSelectedGeneration,
  standalonePublicationTransactionId,
  type PublicationAuthorityHooks,
  type PublicationImmutableInput,
} from "./generations.js";
import { RunArtifactStore, type ArtifactHandle } from "./run-artifacts.js";
import { type KbResult, type KbStatus, type KbWorkflowContext } from "./workflows.js";
import { conflictRecordForAllocation } from "./content-review.js";
import { claimCandidateBodies, validatePageDraftAuthority } from "./composition-authority.js";

// ── Types ───────────────────────────────────────────────────────────────────

import type { KbPhaseInvocation } from "./session-tools.js";

/** Explicit test-only adapter; production cannot pass a raw body callback accidentally. */
export interface TestOnlyIngestBodyRunner {
  readonly test_only: true;
  readonly run: (invocation: KbPhaseInvocation) => Promise<string>;
}

export function createTestOnlyIngestBodyRunner(
  run: (invocation: KbPhaseInvocation) => Promise<string> | string
): TestOnlyIngestBodyRunner {
  return {
    test_only: true,
    run: async (invocation) => run(invocation),
  };
}

/** A source to ingest, supplied by the host (capability envelope already resolved). */
export interface IngestSource {
  readonly sourceId: string;
  /** Exact JCS digest of the owner-stored source capability envelope. */
  readonly capabilityDigest: Sha256Hex;
  readonly title: string;
  readonly authors: readonly string[];
  readonly content: string;
  readonly mediaType: "text/plain" | "text/markdown" | "application/json";
  readonly sourceType: SourceType;
  readonly capturedAt: string;
  readonly publishedAt?: string;
  readonly redactedLocator?: string;
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
  /**
   * Present for an ingest, absent for a `save`.
   *
   * A save has no extraction phase — it composes from a claimed query answer —
   * so there is no `claims` artifact to seal. Publication never reads this id
   * (it republishes from the sealed page draft and lint report), so requiring it
   * would reject a valid save for an artifact nothing consumes.
   */
  readonly claimsArtifactId?: string;
  readonly pageDraftArtifactId: string;
  readonly lintReportArtifactId: string;
  readonly verificationArtifactId: string;
  /** Exact all-and-only conflict allocations frozen in the canonical packet. */
  readonly candidateConflictAllocations?: readonly CandidateConflictAllocation[];
  /** Packet issue time copied into every allocated conflict record. */
  readonly reviewIssuedAt?: string;
}

/** Production-only control/authority bindings for the selector transaction. */
export interface ApprovedPublicationContext {
  readonly checkpointer: Checkpointer;
  readonly transactionId: string;
  readonly baseGenerationId: string;
  readonly baseSelectorSha256: Sha256Hex;
  readonly action: "ingest" | "save";
  readonly publishedAt: string;
  readonly authority?: PublicationAuthorityHooks;
  readonly requireContentReview?: boolean;
  readonly awaitOperationReceipt?: boolean;
}

// ── Local helpers ───────────────────────────────────────────────────────────

type Next = "resume" | "review" | "none";

function result(
  action: "ingest",
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

/** Shared by the workflow and the ingest plane. */
export function sourceRecordFor(src: IngestSource, runId: string): SourceRecord {
  const record = {
    schema_version: 1 as const,
    source_id: src.sourceId,
    source_type: src.sourceType,
    captured_at: src.capturedAt,
    ...(src.publishedAt !== undefined ? { published_at: src.publishedAt } : {}),
    title: src.title,
    authors: [...src.authors],
    media_type: src.mediaType,
    sha256: sha256Hex(src.content),
    object_ref: sourceObjectRef(sha256Hex(src.content)),
    provenance: {
      source_capability_digest: src.capabilityDigest,
      supplied_by: "host_capability" as const,
      originating_run_id: runId,
      ...(src.redactedLocator !== undefined ? { redacted_locator: src.redactedLocator } : {}),
    },
  };
  return record; // validated by writeSourceRecord against SourceRecordSchema
}

// ── Phase briefs (in-band: instructions + output contract ONLY; no bodies) ──

const ECHO_BRIEF = [
  "Phase: ingest (evidence extraction).",
  "Read each admitted source with read_source_snapshot (by its source_id) and extract the key claims.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"claims","source_ids":[...],"claims":[{"provisional_id":"candidate_<unique>","text":"...","kind":"fact|inference|speculation|unknown","confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","evidence":[{"source_id":"<src id>"}]}]}',
  "Rules: provisional_id is transient and unique; never choose a stable claim_id. evidence.source_id must be one of the admitted sources you read; one candidate per materially distinct statement.",
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
  '{"schema_version":1,"artifact_kind":"page_draft","pages":[{"frontmatter":{"schema_version":1,"page_id":"<host allocation>","revision_id":"<host allocation>","kind":"synthesis","title":"...","summary":"...","authority":"advisory","lifecycle":"draft","created_at":"<ISO-8601 Z>","derived_from":[],"related_page_ids":[]},"markdown":"...","claims":{"schema_version":1,"page_id":"<same allocated page_id>","revision_id":"<same allocated revision_id>","claims":[<each candidate using its host-allocated claim_id>]}}]}',
  "Production composition consumes every host allocation exactly once; this direct workflow is an explicit deterministic test adapter only.",
].join("\n");

const CARREN_BRIEF = [
  "Phase: lint (semantic review).",
  "Read the candidate page with read_phase_output (phase=compose). Read admitted sources with read_source_snapshot where a claim's grounding is unclear.",
  "Review for unsupported claims, missing evidence, contradictions, and overclaims.",
  "For every material conflict between claims (or between a claim and its evidence), emit a candidate conflict whose claim_refs point at the involved claims of THIS candidate page.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"lint_report","findings":[{"finding_id":"fnd_<unique>","severity":"info|warning|blocking","summary":"...","evidence":[{"evidence_id":"ev_<unique>","kind":"artifact|test|source|gate|digest","ref":"<opaque_ref>"}]}],"candidate_conflicts":[{"candidate_conflict_id":"cfl_<unique>","claim_refs":[{"page_id":"...","revision_id":"...","claim_id":"..."}],"summary":"...","evidence_refs":[{"evidence_id":"ev_<unique>","kind":"artifact|test|source|gate|digest","ref":"<opaque_ref>"}]}]}',
  "If there are no conflicts, candidate_conflicts must be [].",
].join("\n");

const VERA_BRIEF = [
  "Phase: verify (groundedness verification).",
  "Read the candidate page with read_phase_output (phase=compose) and the admitted sources with read_source_snapshot.",
  "For each claim in the candidate page's sidecar, decide whether the cited source supports it.",
  "Submit EXACTLY ONE JSON object via submit_phase_result with this shape:",
  '{"schema_version":1,"artifact_kind":"verification_report","verified_artifact_ids":[],"claim_findings":[{"page_id":"...","revision_id":"...","claim_id":"...","verdict":"supported|partially_supported|unsupported","evidence":[{"evidence_id":"ev_<unique>","kind":"artifact|test|source|gate|digest","ref":"<opaque_ref>"}]}]}',
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
  testRunner: TestOnlyIngestBodyRunner
): Promise<KbResult> {
  const agentRunner = testRunner.run;
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
  // Source bytes are already immutable same-run snapshots (or explicit test
  // fixtures). The publication plane remains untouched until approved review.
  if (ctx.checkpointer === undefined) {
    throw new Error("KB artifact work requires the orchestration control DB");
  }
  const store = new RunArtifactStore(root, ctx.runId, ctx.checkpointer);
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
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { evidence_id?: unknown }).evidence_id !== "string"
    ) {
      return [];
    }
    return [(entry as { evidence_id: string }).evidence_id];
  });
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
/** Carried publication state failed its integrity recheck; nothing is published. */
export class IngestDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestDriftError";
  }
}

/**
 * A generation is a COMPLETE view of the KB, not a diff.
 *
 * Publication therefore carries the selected generation's entries forward into
 * the next catalog and layers this run's entries on top. Three properties make
 * that safe rather than a blind copy:
 *
 * - **Catalog-level, never a re-copy.** Carried pages/sources/conflicts are
 *   already-published immutable files at their existing keys; the next catalog
 *   references them. §5.10's preallocated planned file set therefore stays
 *   bounded to genuinely new bytes instead of growing with the KB every publish.
 * - **Re-verified while carried.** Every carried entry's on-disk bytes are
 *   re-hashed against the base catalog's digest. A mismatch is drift or
 *   tampering and refuses the publish, so each publish re-attests the whole
 *   selected set rather than trusting it.
 * - **Supersede by id.** This run's entries replace carried ones with the same
 *   `page_id`/`source_id`/`conflict_id`; the prior revision stays immutable on
 *   disk and reachable through the older generation.
 *
 * Removal is deliberately not expressible here: a page leaves circulation by
 * publishing a revision whose lifecycle is `superseded`/`archived`, never by
 * being dropped from a catalog. Omission-as-delete is exactly the failure this
 * function exists to prevent.
 */
function carryForward(
  root: string,
  base: GenerationCatalog
): {
  pages: Map<string, { revision_id: string; page_sha256: Sha256Hex; claims_sha256: Sha256Hex }>;
  sourceRecords: Map<string, Sha256Hex>;
  sourceObjects: Set<Sha256Hex>;
  conflicts: Map<string, Sha256Hex>;
  indexPages: Map<string, { revision_id: string; title: string; summary: string; body: string }>;
} {
  const pages = new Map<
    string,
    { revision_id: string; page_sha256: Sha256Hex; claims_sha256: Sha256Hex }
  >();
  const indexPages = new Map<
    string,
    { revision_id: string; title: string; summary: string; body: string }
  >();

  for (const [pageId, entry] of Object.entries(base.pages)) {
    let pageContent: string;
    let claimsContent: string;
    try {
      const revision = readPageRevision(root, pageId, entry.revision_id, {
        pageSha256: entry.page_sha256,
        claimsSha256: entry.claims_sha256,
      });
      pageContent = revision.page_markdown;
      claimsContent = canonicalJson(revision.claims);
    } catch {
      throw new IngestDriftError(
        `carried page '${pageId}' revision '${entry.revision_id}' failed custody or catalog digest validation`
      );
    }
    // page.md is written as exactly `---\n<JCS(frontmatter)>\n---\n\n<markdown>`
    // and its catalog digest covers those same bytes, so the check is a direct
    // byte comparison rather than a re-derivation that could drift.
    if (sha256Hex(pageContent) !== entry.page_sha256) {
      throw new IngestDriftError(`carried page '${pageId}' does not match its catalog digest`);
    }
    if (sha256Hex(claimsContent) !== entry.claims_sha256) {
      throw new IngestDriftError(
        `carried claims for '${pageId}' do not match their catalog digest`
      );
    }
    pages.set(pageId, {
      revision_id: entry.revision_id,
      page_sha256: entry.page_sha256,
      claims_sha256: entry.claims_sha256,
    });

    // The per-generation index is derived, so it is rebuilt over the union. The
    // reads that feed it are the same reads that just re-verified the bytes.
    const fmMatch = pageContent.match(/^---\n([\s\S]*?)\n---\n\n?/u);
    const body = fmMatch ? pageContent.slice(fmMatch[0].length) : pageContent;
    let title = pageId;
    let summary = "";
    try {
      const fm = JSON.parse(fmMatch?.[1] ?? "{}") as { title?: unknown; summary?: unknown };
      if (typeof fm.title === "string") title = fm.title;
      if (typeof fm.summary === "string") summary = fm.summary;
    } catch {
      // A carried page whose frontmatter will not parse is drift, not a default.
      throw new IngestDriftError(`carried page '${pageId}' has unreadable frontmatter`);
    }
    indexPages.set(pageId, { revision_id: entry.revision_id, title, summary, body });
  }

  return {
    pages,
    sourceRecords: new Map(Object.entries(base.source_records)),
    sourceObjects: new Set(base.source_objects),
    conflicts: new Map(Object.entries(base.conflict_records)),
    indexPages,
  };
}

export function approveIngest(
  ctx: KbWorkflowContext,
  sources: readonly IngestSource[],
  pending: PendingIngest,
  publicationContext?: ApprovedPublicationContext
): KbResult {
  const root = ctx.kbRoot;
  const fail = (warning: string): KbResult =>
    result("ingest", ctx.runId, "refused", false, "none", { warnings: [warning] });

  const selected = readSelectedGeneration(root);
  if (selected === undefined) return fail("No KB is initialized at this profile");
  if (
    publicationContext !== undefined &&
    (selected.selector.generation_id !== publicationContext.baseGenerationId ||
      sha256Hex(canonicalJson(selected.selector)) !== publicationContext.baseSelectorSha256)
  ) {
    return fail("reviewed base selector drifted; nothing published");
  }

  const manifest = readManifest(root);
  const policy = readPolicy(root);

  // Zero NEW sources is legal: a `save` publishes a page derived from an
  // existing query over already-published sources, and the generation carries
  // those sources forward. The ingest action's own ≥1 capability requirement is
  // enforced upstream, where the capabilities are claimed.
  if (!sources.every((s) => s.sourceId !== "")) return fail("source ids must be non-empty");

  // Re-read the sealed candidate bytes.
  if (ctx.checkpointer === undefined) {
    throw new Error("KB artifact work requires the orchestration control DB");
  }
  const store = new RunArtifactStore(root, pending.runId, ctx.checkpointer);
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

  const composeOperands = ctx.checkpointer.kbPhaseOperandsRecord(pending.runId, "compose");
  const composeAuthority = composeOperands?.operands.compose_authority;
  if (publicationContext?.requireContentReview === true && composeAuthority === undefined) {
    return fail("reviewed page draft has no host compose allocation; nothing published");
  }
  if (composeAuthority !== undefined) {
    const privateInput = ctx.checkpointer.getPrivateInput(pending.runId);
    const currentPolicySha256 = sha256Hex(canonicalJson(policy));
    if (
      composeOperands?.lifecycle !== "closed" ||
      composeOperands.operands.run_id !== pending.runId ||
      composeOperands.operands.state_id !== "compose" ||
      composeOperands.operands.kb_profile_id !== ctx.profileId ||
      composeOperands.operands.operation !==
        (publicationContext?.action ?? (sources.length === 0 ? "save" : "ingest")) ||
      composeOperands.operands.admitted_policy_sha256 !== currentPolicySha256 ||
      composeAuthority.kb_id !== manifest.kb_id ||
      privateInput?.state !== "active" ||
      composeAuthority.private_input_sha256 !== privateInput.request_sha256
    ) {
      return fail("reviewed page draft compose authority drifted; nothing published");
    }
    try {
      const claimCandidates =
        composeOperands.operands.operation === "ingest"
          ? (() => {
              const prior = composeOperands.operands.allowed_prior_artifacts[0];
              if (
                prior === undefined ||
                prior.run_id !== pending.runId ||
                prior.state_id !== "ingest" ||
                prior.handle.artifact_kind !== "claims"
              ) {
                throw new Error("compose claim candidate operand is absent");
              }
              const priorStore = new RunArtifactStore(root, prior.run_id, ctx.checkpointer!);
              try {
                return claimCandidateBodies(
                  JSON.parse(
                    priorStore.read(prior.handle.artifact_id, {
                      expected_state_id: prior.state_id,
                      expected_handle: prior.handle,
                      required_lifecycle: "sealed",
                    }).content
                  ) as unknown
                );
              } finally {
                priorStore.close();
              }
            })()
          : undefined;
      pageDraftRaw = validatePageDraftAuthority({
        document: pageDraftRaw,
        authority: composeAuthority,
        selectedGenerationId: selected.selector.generation_id,
        selectedCatalogSha256: selected.selector.catalog_sha256,
        selectedCatalog: selected.catalog,
        ...(claimCandidates === undefined ? {} : { claimCandidates }),
      }) as RawPageDraft;
    } catch {
      return fail("page_draft identity allocation is invalid; nothing published");
    }
  }

  const rawPages = Array.isArray(pageDraftRaw?.pages) ? (pageDraftRaw.pages as unknown[]) : [];
  if (rawPages.length === 0) {
    return fail("page_draft artifact contains no pages; nothing published");
  }

  // Carry the selected generation forward (and re-verify it) BEFORE writing
  // anything new, so an integrity failure refuses with nothing published.
  let carried: ReturnType<typeof carryForward>;
  try {
    carried = carryForward(root, selected.catalog);
  } catch (err) {
    if (err instanceof IngestDriftError) return fail(`${err.message}; nothing published`);
    throw err;
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
        : composeAuthority === undefined
          ? `page_${randomUUID().replace(/-/g, "").slice(0, 12)}`
          : "";
    const revisionId =
      typeof fmSrc.revision_id === "string" && /^rev_[A-Za-z0-9._:-]+$/.test(fmSrc.revision_id)
        ? fmSrc.revision_id
        : composeAuthority === undefined
          ? `rev_${randomUUID().replace(/-/g, "").slice(0, 12)}`
          : "";
    if (pageId.length === 0 || revisionId.length === 0) {
      return fail("page_draft omitted a host-allocated identity; nothing published");
    }
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
      ...(typeof fmSrc.previous_revision_id === "string"
        ? { previous_revision_id: fmSrc.previous_revision_id }
        : {}),
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
            : composeAuthority === undefined
              ? `clm_${randomUUID().replace(/-/g, "").slice(0, 12)}`
              : "",
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

  // Build page revision pairs. Production stages these bytes only after their
  // complete file rows are durable; the standalone fixture keeps the legacy
  // direct writer for tests without a control DB.
  const immutableFiles: PublicationImmutableInput[] = [];
  const relativeKey = (absolute: string): string =>
    path.relative(root, absolute).split(path.sep).join("/");
  const pageEntries: {
    page_id: string;
    revision_id: string;
    page_sha256: Sha256Hex;
    claims_sha256: Sha256Hex;
  }[] = [];
  for (const page of pages) {
    validateKbContract(PageRevisionFrontmatterSchema, page.frontmatter, "publication frontmatter");
    validateKbContract(ClaimsSidecarSchema, page.claims, "publication claims");
    const pageBytes = `---\n${canonicalJson(page.frontmatter)}\n---\n\n${page.markdown}`;
    const claimsBytes = canonicalJson(page.claims);
    immutableFiles.push(
      {
        role: "page_markdown",
        final_key: relativeKey(
          pageMarkdownPath(root, page.frontmatter.page_id, page.frontmatter.revision_id)
        ),
        bytes: pageBytes,
      },
      {
        role: "claims",
        final_key: relativeKey(
          pageClaimsPath(root, page.frontmatter.page_id, page.frontmatter.revision_id)
        ),
        bytes: claimsBytes,
      }
    );
    const pageId = page.frontmatter.page_id;
    const entry = {
      page_id: pageId,
      revision_id: page.frontmatter.revision_id,
      page_sha256: sha256Hex(pageBytes),
      claims_sha256: sha256Hex(claimsBytes),
    };
    pageEntries.push(entry);
    // Supersede by page_id: this revision becomes the one this generation
    // selects. The prior revision stays immutable and reachable through the
    // generation that selected it.
    carried.pages.set(pageId, {
      revision_id: entry.revision_id,
      page_sha256: entry.page_sha256,
      claims_sha256: entry.claims_sha256,
    });
    carried.indexPages.set(pageId, {
      revision_id: page.frontmatter.revision_id,
      title: page.frontmatter.title,
      summary: page.frontmatter.summary,
      body: page.markdown,
    });
  }

  // Approved-review publication is the first moment source objects/records may
  // enter the KB publication tree. Bytes come only from immutable snapshots.
  const sourceRecordEntries: { source_id: string; record_sha256: Sha256Hex }[] = [];
  // The publication plan contains only genuinely new object bytes; a digest
  // already selected by the carried base is re-opened at the selector cliff,
  // not redundantly reallocated as a new file row.
  const objectDigests = new Set<Sha256Hex>(carried.sourceObjects);
  for (const src of sources) {
    const record = validateKbContract(
      SourceRecordSchema,
      sourceRecordFor(src, ctx.runId),
      "publication source record"
    );
    const objectBytes = Buffer.from(src.content, "utf8");
    const recordBytes = canonicalJson(record);
    if (!objectDigests.has(record.sha256)) {
      immutableFiles.push({
        role: "source_object",
        final_key: relativeKey(sourceObjectPath(root, record.sha256)),
        bytes: objectBytes,
      });
    }
    immutableFiles.push({
      role: "source_record",
      final_key: relativeKey(sourceRecordPath(root, record.source_id)),
      bytes: recordBytes,
    });
    objectDigests.add(record.sha256);
    const recordDigest = sha256Hex(recordBytes);
    sourceRecordEntries.push({ source_id: src.sourceId, record_sha256: recordDigest });
    carried.sourceRecords.set(src.sourceId, recordDigest);
    carried.sourceObjects.add(record.sha256);
  }

  // Conflict records from the sealed lint report. On the authenticated review
  // path the packet preallocates all-and-only IDs/digests and fixes created_at;
  // publication reconstructs and verifies those exact bytes rather than making
  // a fresh post-approval choice.
  const conflictEntries: { conflict_id: string; conflict_sha256: Sha256Hex }[] = [];
  const allocations = pending.candidateConflictAllocations;
  const orderedCandidates =
    allocations === undefined
      ? candidateConflicts
      : [...candidateConflicts].sort((left, right) =>
          String(left.candidate_conflict_id).localeCompare(String(right.candidate_conflict_id))
        );
  if (
    allocations !== undefined &&
    (allocations.length !== orderedCandidates.length || pending.reviewIssuedAt === undefined)
  ) {
    return fail("content-review conflict allocation set is incomplete; nothing published");
  }
  const allowedClaimRefs = new Set([
    ...pages.flatMap((page) =>
      page.claims.claims.map(
        (claim) =>
          `${page.frontmatter.page_id}\u0000${page.frontmatter.revision_id}\u0000${claim.claim_id}`
      )
    ),
    ...Object.entries(selected.catalog.pages).flatMap(([pageId, entry]) =>
      readPageRevision(root, pageId, entry.revision_id, {
        pageSha256: entry.page_sha256,
        claimsSha256: entry.claims_sha256,
      }).claims.claims.map((claim) => `${pageId}\u0000${entry.revision_id}\u0000${claim.claim_id}`)
    ),
  ]);
  for (let index = 0; index < orderedCandidates.length; index += 1) {
    const cc = orderedCandidates[index]!;
    let conflict: ConflictRecordT;
    if (allocations !== undefined) {
      const allocation = allocations[index]!;
      if (String(cc.candidate_conflict_id) !== allocation.candidate_conflict_id) {
        return fail("content-review conflict allocation identity changed; nothing published");
      }
      try {
        conflict = conflictRecordForAllocation({
          candidate: cc,
          allocation,
          issuedAt: pending.reviewIssuedAt!,
          allowedClaimRefs,
        }) as unknown as ConflictRecordT;
      } catch {
        return fail("content-review conflict allocation no longer validates; nothing published");
      }
      if (sha256Hex(canonicalJson(conflict)) !== allocation.conflict_record_sha256) {
        return fail("content-review conflict allocation digest changed; nothing published");
      }
    } else {
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
      conflict = {
        schema_version: 1,
        conflict_record_id: conflictId,
        claim_refs: validRefs.map((r) => ({
          page_id: String(r.page_id),
          revision_id: String(r.revision_id),
          claim_id: String(r.claim_id),
        })),
        state: "open",
        summary: summaryRaw.slice(0, 4096),
        evidence_refs: asEvidenceIds(cc.evidence_refs)
          .map((e) => e.slice(0, 128))
          .slice(0, 32),
        created_at: now,
      };
    }
    conflict = validateKbContract(ConflictRecordSchema, conflict, "publication conflict record");
    const conflictBytes = canonicalJson(conflict);
    immutableFiles.push({
      role: "conflict",
      final_key: relativeKey(conflictPath(root, conflict.conflict_record_id)),
      bytes: conflictBytes,
    });
    const conflictDigest = sha256Hex(conflictBytes);
    conflictEntries.push({
      conflict_id: conflict.conflict_record_id,
      conflict_sha256: conflictDigest,
    });
    carried.conflicts.set(conflict.conflict_record_id, conflictDigest);
  }

  // Build the deterministic index (index.sqlite) from the UNION of carried and
  // newly published pages, then the catalog anchored to its canonical-content
  // digest, then publish. A generation is complete: it lists everything the KB
  // selects, not just what this run produced.
  let ownedCheckpointer: Checkpointer | undefined;
  const standaloneAction = sources.length === 0 ? "save" : "ingest";
  const transactionId =
    publicationContext?.transactionId ??
    standalonePublicationTransactionId(ctx.runId, standaloneAction);
  const checkpointer =
    publicationContext?.checkpointer ??
    (ownedCheckpointer = openStandalonePublicationCheckpointer({
      root,
      runId: ctx.runId,
      profileId: ctx.profileId,
      action: standaloneAction,
    }));
  const priorPublication = checkpointer.kbPublication(transactionId);
  const publishedAt =
    priorPublication?.created_at ??
    publicationContext?.publishedAt ??
    pending.reviewIssuedAt ??
    now;
  const generationId =
    priorPublication?.candidate_generation_id ?? `gen_${sha256Hex(transactionId).slice(0, 40)}`;
  const unionPages = [...carried.pages.entries()]
    .map(([page_id, e]) => ({ page_id, ...e }))
    .sort((a, b) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0));
  const indexPages = [...carried.indexPages.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([page_id, p]) => ({
      page_id,
      revision_id: p.revision_id,
      title: p.title,
      summary: p.summary,
      body_sha256: sha256Hex(p.body),
      body: p.body,
    }));
  const index_sha256 = generationIndexDigest(generationId, manifest.kb_id, indexPages);
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: manifest.kb_id,
    parent_generation_id: selected.selector.generation_id,
    manifest,
    policy,
    pages: unionPages,
    source_records: [...carried.sourceRecords.entries()]
      .map(([source_id, record_sha256]) => ({ source_id, record_sha256 }))
      .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0)),
    source_objects: [...carried.sourceObjects].sort(),
    conflicts: [...carried.conflicts.entries()]
      .map(([conflict_id, conflict_sha256]) => ({ conflict_id, conflict_sha256 }))
      .sort((a, b) => (a.conflict_id < b.conflict_id ? -1 : a.conflict_id > b.conflict_id ? 1 : 0)),
    index_sha256,
    created_at: publishedAt,
  });
  let selector;
  try {
    selector = publishGenerationTransaction({
      root,
      checkpointer,
      run_id: ctx.runId,
      transaction_id: transactionId,
      kb_profile_id: ctx.profileId,
      action: publicationContext?.action ?? standaloneAction,
      base_generation_id: publicationContext?.baseGenerationId ?? selected.selector.generation_id,
      base_selector_sha256:
        publicationContext?.baseSelectorSha256 ?? sha256Hex(canonicalJson(selected.selector)),
      catalog,
      index_pages: indexPages,
      immutable_files: immutableFiles,
      published_at: publishedAt,
      ...(publicationContext?.authority !== undefined
        ? { authority: publicationContext.authority }
        : {}),
      require_content_review: publicationContext?.requireContentReview ?? false,
      await_operation_receipt: publicationContext?.awaitOperationReceipt ?? false,
    }).selector;
  } finally {
    ownedCheckpointer?.close();
  }

  return result("ingest", ctx.runId, "complete", true, "none", {
    kb_id: manifest.kb_id,
    ids: [generationId, ...pageEntries.map((p) => p.page_id)],
    counts: {
      // What this run contributed …
      sources: sources.length,
      pages: pageEntries.length,
      conflicts: conflictEntries.length,
      // … and what the generation now selects in total.
      total_pages: unionPages.length,
      total_sources: carried.sourceRecords.size,
      total_conflicts: carried.conflicts.size,
      generations: 1,
      selector: 1,
    },
    evidence: [
      {
        evidence_id: selector.generation_id,
        kind: "digest",
        ref: selector.generation_id,
        sha256: selector.catalog_sha256,
      },
    ],
  });
}
