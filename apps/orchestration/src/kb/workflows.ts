/**
 * KB workflows — §5.6 the eight public actions.
 *
 * This module implements the stateful workflows that tie together the G7 core
 * modules (contracts, profile-registry, capabilities, policy, filesystem,
 * generations, retrieval, lint) and the G8 artifact content plane (run-artifacts).
 *
 * Each action returns a `KbResult` — a safe, path-free projection. No raw body
 * ever appears in a result.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { PolicyRefusal, checkParentModelIdentity } from "./policy.js";
import { SaveQueryClaimStore } from "./save-claim.js";
import type { JsonValue } from "../contracts.js";
import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbManifest,
  type KbPolicy,
} from "./contracts.js";
import { writeManifest, writePolicy, readManifest, readPolicy, readCurrent } from "./filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
  readSelectedGeneration,
} from "./generations.js";
import { rankPages } from "./retrieval.js";
import { lintDeterministic } from "./lint.js";
import { RunArtifactStore, type ArtifactHandle } from "./run-artifacts.js";

// ── Result type (§5.6) ──────────────────────────────────────────────────────

export type KbStatus = "running" | "awaiting_user" | "complete" | "refused" | "error" | "exhausted";

export interface KbResult {
  schema_version: 1;
  action: string;
  run_id: string;
  kb_id?: string;
  status: KbStatus;
  met: boolean;
  ids: string[];
  counts: Record<string, number>;
  artifacts: ArtifactHandle[];
  evidence: { evidence_id: string; kind: string; ref: string }[];
  warnings: string[];
  unresolved: string[];
  derived_answer?: unknown;
  next: "resume" | "review" | "none";
}

// ── Workflow context ────────────────────────────────────────────────────────

export interface KbWorkflowContext {
  readonly kbRoot: string;
  readonly profileId: string;
  readonly runId: string;
}

function result(
  action: string,
  runId: string,
  status: KbStatus,
  met: boolean,
  next: "resume" | "review" | "none",
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

// ── init (§5.6) ─────────────────────────────────────────────────────────────

/**
 * Initialize a KB: validate the profile, create the manifest + default-deny
 * policy + layout, and publish the first empty generation.
 */
export function initKb(ctx: KbWorkflowContext, title: string): KbResult {
  const root = ctx.kbRoot;

  // Check if already initialized
  const existing = readCurrent(root);
  if (existing !== undefined) {
    const manifest = readManifest(root);
    return result("init", ctx.runId, "complete", true, "none", {
      kb_id: manifest.kb_id,
      counts: { generations: 1 },
      warnings: ["KB already initialized; validated existing state"],
    });
  }

  // Create the layout
  const kbId = `kb_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const manifest: KbManifest = {
    schema_version: 1,
    kb_id: kbId,
    title,
    authority: "advisory",
    paths: {
      policy: ".kb/policy.json",
      source_records: "sources/records",
      source_objects: "sources/objects",
      pages: "pages",
      conflicts: "conflicts",
      work: "work",
      lock: ".kb/lock",
      generations: ".kb/generations",
      generation_catalog_filename: "catalog.json",
      generation_index_filename: "index.sqlite",
      current: ".kb/current.json",
      root_index: "index.md",
    },
    created_at: now,
  };
  writeManifest(root, manifest);

  const policy = defaultDenyPolicy(kbId);
  writePolicy(root, policy);

  // Publish the first empty generation (with its real, verified index)
  const genId = newGenerationId();
  const { index_sha256 } = buildGenerationIndex(root, genId, kbId, []);
  const catalog = buildCatalog({
    generation_id: genId,
    kb_id: kbId,
    manifest,
    policy,
    pages: [],
    source_records: [],
    source_objects: [],
    conflicts: [],
    index_sha256,
  });
  publishGeneration(root, catalog);

  return result("init", ctx.runId, "complete", true, "none", {
    kb_id: kbId,
    counts: { generations: 1, pages: 0, sources: 0 },
  });
}

// ── query (§5.6) ────────────────────────────────────────────────────────────

/**
 * Query the selected generation: deterministic retrieval against the current
 * catalog, returning ranked candidates. The result is advisory and cited.
 *
 * No publication-plane change occurs. The query may produce a same-run answer
 * artifact under `work/<run_id>/`, but it never publishes a source, page, claim,
 * conflict, generation, or root index.
 */
export function queryKb(
  ctx: KbWorkflowContext,
  query: string,
  options?: {
    maxCandidates?: number;
    /** §5.6 `page_ids` — restrict retrieval to these pages of the selected generation. */
    pageIds?: readonly string[];
    /** §5.6 `source_ids` — restrict retrieval to pages citing at least one of these sources. */
    sourceIds?: readonly string[];
    /** §5.6 `verify_grounding` (defaults true) — recorded honestly, see below. */
    verifyGrounding?: boolean;
    /**
     * Owner-only claim store directory (§5.6). When supplied, a complete query
     * with a sealed answer creates exactly one `SaveQueryClaimV1` — the single
     * right that a later `save` must claim. Omitted only by callers that are
     * not offering the answer for saving (deterministic tests, probes).
     */
    claimStoreDir?: string;
  }
): KbResult {
  const root = ctx.kbRoot;
  const selected = readSelectedGeneration(root);
  if (selected === undefined) {
    return result("query", ctx.runId, "refused", false, "none", {
      warnings: ["No KB is initialized at this profile"],
    });
  }

  const { catalog } = selected;
  const pageFilter = options?.pageIds === undefined ? undefined : new Set(options.pageIds);
  const sourceFilter = options?.sourceIds === undefined ? undefined : new Set(options.sourceIds);
  const unresolved: string[] = [];
  if (pageFilter !== undefined) {
    for (const requested of pageFilter) {
      if (!Object.hasOwn(catalog.pages, requested)) unresolved.push("unknown page filter id");
    }
  }

  // Build page contents from the catalog (in a real system, this reads from disk)
  // For now, we read the page markdown and frontmatter from the filesystem
  const pageContents = new Map<string, { title: string; summary: string; markdown: string }>();
  for (const [pageId, entry] of Object.entries(catalog.pages)) {
    if (pageFilter !== undefined && !pageFilter.has(pageId)) continue;
    try {
      const revId = entry.revision_id;
      const pageMdPath = path.join(root, "pages", pageId, "revisions", revId, "page.md");
      const claimsPath = path.join(root, "pages", pageId, "revisions", revId, "claims.json");
      if (existsSync(pageMdPath) && existsSync(claimsPath)) {
        const md = readFileSync(pageMdPath, "utf8");
        const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
        // §5.6 source filter: keep only pages whose claims cite an allowed source.
        if (sourceFilter !== undefined && !claimsCiteAnySource(claims, sourceFilter)) continue;
        // Extract title and summary from the frontmatter in the markdown
        const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
        let title = pageId;
        let summary = "";
        const fmText = fmMatch?.[1];
        if (typeof fmText === "string") {
          try {
            const fm = JSON.parse(fmText);
            title = fm.title ?? pageId;
            summary = fm.summary ?? "";
          } catch {
            // fall through with defaults
          }
        }
        pageContents.set(pageId, { title, summary, markdown: md });
      }
    } catch {
      // skip unreadable pages
    }
  }

  const candidates = rankPages({
    catalog,
    query,
    pageContents,
    maxCandidates: options?.maxCandidates ?? 20,
  });

  // Produce a same-run answer artifact (work plane only, no publication)
  using store = new RunArtifactStore(root, ctx.runId);
  const answerContent = JSON.stringify({
    schema_version: 1,
    artifact_kind: "query_answer",
    answer: {
      authority: "advisory" as const,
      text: `Found ${candidates.length} candidate(s) for query: "${query}"`,
      citations: candidates.slice(0, 5).map((c) => ({
        kind: "page" as const,
        page_id: c.page_id,
        revision_id: c.revision_id,
      })),
      contradictions: [],
      unknowns: candidates.length === 0 ? ["No matching pages found"] : [],
      canonical_verification_required: true as const,
    },
  });
  const handle = store.stage({
    state_id: "synthia_query",
    kb_profile_id: ctx.profileId,
    artifact_kind: "query_answer",
    content: answerContent,
  });
  // Seal it: the answer a save may later claim must be frozen, and the claim
  // binds its digest so a drifted answer can never be published as the one the
  // operator reviewed.
  store.seal([handle.artifact_id]);

  if (options?.claimStoreDir !== undefined && candidates.length > 0) {
    // Exactly one claim per completed query with a sealed answer (§5.6). A
    // failure here must not fail the query — the answer is still valid and
    // readable; only the right to save it is unavailable, and a save without a
    // claim refuses honestly rather than proceeding.
    try {
      new SaveQueryClaimStore(options.claimStoreDir).create({
        query_run_id: ctx.runId,
        kb_profile_id: ctx.profileId,
        kb_id: catalog.kb_id,
        answer_artifact_id: handle.artifact_id,
        answer_sha256: handle.sha256,
      });
    } catch {
      // Already-claimed (a retry of the same run) or an unwritable store.
    }
  }

  return result("query", ctx.runId, "complete", candidates.length > 0, "none", {
    kb_id: catalog.kb_id,
    ids: candidates.map((c) => c.page_id),
    counts: { candidates: candidates.length },
    artifacts: [handle],
    warnings: [
      ...(candidates.length === 0 ? ["No matching pages found"] : []),
      // Honest capability statement: this flow ranks and cites; it does not run
      // a grounding phase. Saying so is what keeps `verify_grounding` from
      // being a silent no-op, and parent delivery refuses on it (§5.6).
      ...(options?.verifyGrounding === false ? [] : ["grounding_not_verified"]),
    ],
    unresolved: [...unresolved, ...(candidates.length === 0 ? ["empty result set"] : [])],
  });
}

/** True when any claim's evidence cites one of the requested source IDs (§5.6 filter). */
function claimsCiteAnySource(claims: unknown, allowed: ReadonlySet<string>): boolean {
  const list = (claims as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) return false;
  for (const claim of list) {
    const evidence = (claim as { evidence?: unknown })?.evidence;
    if (!Array.isArray(evidence)) continue;
    for (const entry of evidence) {
      const sourceId = (entry as { source_id?: unknown })?.source_id;
      if (typeof sourceId === "string" && allowed.has(sourceId)) return true;
    }
  }
  return false;
}

// ── §5.3 run admission (deny before session) ─────────────────────────────

/**
 * Admit a run before it may read a private body or create a child session.
 *
 * §5.3 fixes the ORDER, and the order is the guarantee:
 *   profile grant → root/repository admission → manifest/policy metadata only
 *   → current parent tuple → every selected child tuple → only then private I/O.
 *
 * This function owns the middle of that chain: it reads and validates only the
 * policy, verifies the ACTIVE parent identity against the allowlist, and returns
 * the digest the run binds as `admitted_policy_sha256`. Child tuples are
 * verified later, at the one moment their identity actually exists — after the
 * runtime resolves the agent's alias and before the session is created.
 *
 * Callers must invoke this BEFORE claiming capabilities, admitting sources, or
 * dispatching any phase. It throws `PolicyRefusal` on denial.
 */
export function admitKbRun(input: {
  kbRoot: string;
  parentIdentity: { provider: string; model: string } | undefined;
}): { policy: KbPolicy; policy_sha256: string } {
  const policy = readPolicy(input.kbRoot);
  if (input.parentIdentity === undefined) {
    throw new PolicyRefusal(
      "parent_model_denied",
      "the host could not establish the active parent identity — denied by default"
    );
  }
  checkParentModelIdentity(policy, input.parentIdentity);
  return { policy, policy_sha256: sha256Hex(canonicalJson(policy as unknown as JsonValue)) };
}

/**
 * Recheck that the policy a run was admitted under is still exactly current.
 *
 * §5.3: every child creation, gate, publish step, status, and resume rechecks
 * exact equality; a mid-run change is `policy_changed` and needs a new run.
 */
export function recheckAdmittedPolicy(input: {
  kbRoot: string;
  admittedPolicySha256: string;
}): KbPolicy {
  const policy = readPolicy(input.kbRoot);
  const current = sha256Hex(canonicalJson(policy as unknown as JsonValue));
  if (current !== input.admittedPolicySha256) {
    throw new PolicyRefusal(
      "policy_changed",
      "the KB policy changed mid-run; this run is invalid and a new run is required"
    );
  }
  return policy;
}

// ── parent delivery support (§5.6) ───────────────────────────────────────────

/**
 * Read the sealed `query_answer` artifact for this run and return exactly its
 * `answer` sub-object (raw unknown; the caller validates it against the closed
 * §5.6 shape before anything is delivered). Returns `null` when the artifact
 * cannot be read — delivery then fails closed; it never falls back to content.
 */
export function readSealedAnswer(
  root: string,
  runId: string,
  handle: { artifact_id: string }
): unknown {
  using store = new RunArtifactStore(root, runId);
  try {
    const { content } = store.read(handle.artifact_id);
    const doc = JSON.parse(content) as { artifact_kind?: unknown; answer?: unknown };
    if (doc.artifact_kind !== "query_answer" || doc.answer === undefined) return null;
    return doc.answer;
  } catch {
    return null;
  }
}

// ── lint (§5.6) ─────────────────────────────────────────────────────────────

/**
 * Run the deterministic lint floor. May produce a same-run lint-report artifact
 * containing candidate conflicts, but publishes nothing.
 */
export function lintKb(ctx: KbWorkflowContext): KbResult {
  const root = ctx.kbRoot;
  const findings = lintDeterministic(root);
  const blocking = findings.filter((f) => f.severity === "blocking");
  const warnings = findings.filter((f) => f.severity === "warning");

  if (blocking.length > 0) {
    return result("lint", ctx.runId, "refused", false, "none", {
      warnings: blocking.map((f) => f.summary),
      unresolved: blocking.map((f) => f.finding_id),
      counts: { blocking: blocking.length, warnings: warnings.length },
    });
  }

  // Produce a same-run lint-report artifact (work plane only)
  using store = new RunArtifactStore(root, ctx.runId);
  const reportContent = JSON.stringify({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: findings.map((f) => ({
      finding_id: f.finding_id,
      severity: f.severity,
      summary: f.summary,
      evidence: f.evidence,
    })),
    candidate_conflicts: [],
  });
  const handle = store.stage({
    state_id: "lint",
    kb_profile_id: ctx.profileId,
    artifact_kind: "lint_report",
    content: reportContent,
  });

  return result("lint", ctx.runId, "complete", true, "none", {
    counts: { findings: findings.length, warnings: warnings.length, blocking: 0 },
    artifacts: [handle],
    warnings: warnings.map((f) => f.summary),
  });
}

// ── status (§5.6) ────────────────────────────────────────────────────────────

/**
 * Return a safe projection of the KB state. Never reveals roots or bodies.
 */
export function statusKb(ctx: KbWorkflowContext): KbResult {
  const root = ctx.kbRoot;
  const selected = readSelectedGeneration(root);
  if (selected === undefined) {
    return result("status", ctx.runId, "complete", false, "none", {
      warnings: ["No KB is initialized"],
    });
  }

  const { catalog, selector } = selected;
  return result("status", ctx.runId, "complete", true, "none", {
    kb_id: catalog.kb_id,
    ids: [selector.generation_id],
    counts: {
      pages: Object.keys(catalog.pages).length,
      sources: Object.keys(catalog.source_records).length,
      conflicts: Object.keys(catalog.conflict_records).length,
    },
  });
}
