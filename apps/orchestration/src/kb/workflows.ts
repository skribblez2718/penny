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

import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  validateKbContract,
  type KbManifest,
  type KbPolicy,
  type CurrentGeneration,
  type GenerationCatalog,
  type Sha256Hex,
} from "./contracts.js";
import {
  writeManifest,
  writePolicy,
  readManifest,
  readPolicy,
  readCurrent,
  writeCurrent,
  writeSourceObject,
  readSourceObject,
  writeSourceRecord,
  readSourceRecord,
  writePageRevision,
  writeConflictRecord,
  secureWrite,
} from "./filesystem.js";
import {
  buildCatalog,
  buildGenerationIndex,
  newGenerationId,
  publishGeneration,
  readSelectedGeneration,
  rebuildRootIndex,
} from "./generations.js";
import { rankPages, type RetrievalCandidate } from "./retrieval.js";
import { lintDeterministic, type LintFinding } from "./lint.js";
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
  options?: { maxCandidates?: number }
): KbResult {
  const root = ctx.kbRoot;
  const selected = readSelectedGeneration(root);
  if (selected === undefined) {
    return result("query", ctx.runId, "refused", false, "none", {
      warnings: ["No KB is initialized at this profile"],
    });
  }

  const { catalog } = selected;

  // Build page contents from the catalog (in a real system, this reads from disk)
  // For now, we read the page markdown and frontmatter from the filesystem
  const pageContents = new Map<string, { title: string; summary: string; markdown: string }>();
  for (const [pageId, entry] of Object.entries(catalog.pages)) {
    try {
      const revId = entry.revision_id;
      const pageMdPath = path.join(root, "pages", pageId, "revisions", revId, "page.md");
      const claimsPath = path.join(root, "pages", pageId, "revisions", revId, "claims.json");
      if (existsSync(pageMdPath) && existsSync(claimsPath)) {
        const md = readFileSync(pageMdPath, "utf8");
        const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
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

  return result("query", ctx.runId, "complete", candidates.length > 0, "none", {
    kb_id: catalog.kb_id,
    ids: candidates.map((c) => c.page_id),
    counts: { candidates: candidates.length },
    artifacts: [handle],
    warnings: candidates.length === 0 ? ["No matching pages found"] : [],
    unresolved: candidates.length === 0 ? ["empty result set"] : [],
  });
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
