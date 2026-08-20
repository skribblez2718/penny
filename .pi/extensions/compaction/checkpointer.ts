// Exact, read-only orchestration checkpoint access for compaction.
//
// Compaction never lists pending runs or searches by session semantics. Callers
// supply exact run IDs already present in trusted tool-result metadata or a
// prior RESUME-REFS block. The TypeScript v2 SQLite database is opened read-only
// and every selected artifact reference is validated before it can enter model context.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

import { createLogger } from "../../lib/logger/logger.js";
import {
  ArtifactRefSchema,
  EngineRunRefSchema,
  type ArtifactRef,
  type EngineRunRef,
} from "./schema.js";
import { asRecord, asString } from "./pi-messages.js";

const logger = createLogger("compaction-checkpointer");
const MAX_EXACT_RUN_IDS = 20;
const MAX_SELECTED_REFS_PER_RUN = 100;

export interface CheckpointReadResult {
  runs: EngineRunRef[];
  artifactRefs: ArtifactRef[];
  issues: string[];
}

function canonicalRunId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  const hasControl = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? -1;
    return codePoint < 32 || codePoint === 127;
  });
  if (value !== value.trim() || hasControl) return null;
  return value;
}

function configuredDatabasePath(projectRoot?: string): string | null {
  const configured = process.env.PENNY_ORCH_V2_DB?.trim();
  if (configured) return isAbsolute(configured) ? resolve(configured) : null;
  const root = projectRoot || process.env.PROJECT_ROOT || process.cwd();
  return resolve(join(root, ".penny", "orchestration-v2.db"));
}

function artifactIdentity(ref: ArtifactRef): string {
  return JSON.stringify({
    branch_id: ref.branch_id,
    kind: ref.kind,
    operation_id: ref.operation_id,
    phase: ref.phase,
    run_id: ref.run_id,
    version: ref.version,
  });
}

/** Validate cross-field invariants that a shape-only schema cannot express. */
export function parseSelectedArtifactRef(value: unknown, runId: string): ArtifactRef {
  const ref = ArtifactRefSchema.parse(value);
  const expectedId = `art_${createHash("sha256").update(artifactIdentity(ref), "utf8").digest("hex")}`;
  if (ref.artifact_id !== expectedId) {
    throw new Error("artifact_id does not match the canonical artifact identity");
  }
  if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
    throw new Error("store_ref does not match content_digest");
  }
  if (ref.run_id !== runId) {
    throw new Error("selected artifact ref belongs to another run");
  }
  return ref;
}

function parseSelectedArtifacts(
  context: Record<string, unknown>,
  runId: string
): { refs: ArtifactRef[]; issues: string[] } {
  const raw = context.selected_artifacts;
  if (raw === undefined || raw === null) return { refs: [], issues: [] };
  if (!Array.isArray(raw)) {
    return { refs: [], issues: [`run ${runId}: selected_artifacts is not an array`] };
  }
  if (raw.length > MAX_SELECTED_REFS_PER_RUN) {
    return {
      refs: [],
      issues: [`run ${runId}: selected_artifacts exceeds the strict limit`],
    };
  }

  const refs: ArtifactRef[] = [];
  const issues: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    try {
      refs.push(parseSelectedArtifactRef(raw[index], runId));
    } catch (error) {
      issues.push(
        `run ${runId}: selected_artifacts[${index}] rejected: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { refs, issues };
}

function parseCheckpointRow(rowValue: unknown): {
  run?: EngineRunRef;
  refs: ArtifactRef[];
  issues: string[];
} {
  const row = asRecord(rowValue);
  const runId = canonicalRunId(row.run_id);
  if (!runId) return { refs: [], issues: ["checkpoint row has an invalid run_id"] };

  let context: Record<string, unknown> = {};
  try {
    context = asRecord(JSON.parse(asString(row.context_json) || "{}"));
  } catch {
    return { refs: [], issues: [`run ${runId}: context_json is not valid JSON`] };
  }

  const status = asString(row.status);
  if (status !== "running" && status !== "awaiting_user") {
    // Exact IDs may point at a run that completed after the prior compaction.
    // It is no longer resumable, so do not emit a stale run reference.
    return { refs: [], issues: [] };
  }

  const runCandidate = {
    run_id: runId,
    session_id: row.session_id,
    playbook: row.playbook,
    current_state_id: row.current_state_id,
    status,
    updated_at: asString(row.updated_at),
    ...(asString(context.goal).slice(0, 500) ? { goal: asString(context.goal).slice(0, 500) } : {}),
    ...(asString(context.clarification_text).slice(0, 300)
      ? { clarification_text: asString(context.clarification_text).slice(0, 300) }
      : {}),
  };
  const parsedRun = EngineRunRefSchema.safeParse(runCandidate);
  if (!parsedRun.success) {
    return {
      refs: [],
      issues: [`run ${runId}: checkpoint row failed strict validation`],
    };
  }

  const selectedArtifacts = parseSelectedArtifacts(context, runId);
  return {
    run: parsedRun.data,
    refs: selectedArtifacts.refs,
    issues: selectedArtifacts.issues,
  };
}

/**
 * Read only the exact run IDs supplied by the caller. Missing databases, rows,
 * optional memory services, and invalid artifact metadata all degrade without
 * blocking recovery of any other valid run.
 */
export function readExactCheckpoints(
  runIds: readonly string[],
  projectRoot?: string
): CheckpointReadResult {
  const exactIds = Array.from(
    new Set(runIds.map(canonicalRunId).filter((value): value is string => value !== null))
  ).slice(0, MAX_EXACT_RUN_IDS);
  if (exactIds.length === 0) return { runs: [], artifactRefs: [], issues: [] };

  const databasePath = configuredDatabasePath(projectRoot);
  if (!databasePath || !existsSync(databasePath)) {
    return { runs: [], artifactRefs: [], issues: [] };
  }

  let database: InstanceType<(typeof import("node:sqlite"))["DatabaseSync"]> | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite"
    ) as typeof import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const placeholders = exactIds.map(() => "?").join(",");
    const rows = database
      .prepare(
        "SELECT run_id, session_id, playbook, state_id AS current_state_id, status, updated_at, context_json " +
          `FROM runs WHERE run_id IN (${placeholders})`
      )
      .all(...exactIds);
    const byId = new Map(rows.map((row: unknown) => [asString(asRecord(row).run_id), row]));

    const runs: EngineRunRef[] = [];
    const artifactRefs: ArtifactRef[] = [];
    const issues: string[] = [];
    for (const runId of exactIds) {
      const row = byId.get(runId);
      if (!row) continue;
      const parsed = parseCheckpointRow(row);
      if (parsed.run) runs.push(parsed.run);
      artifactRefs.push(...parsed.refs);
      issues.push(...parsed.issues);
    }

    const dedupedRefs = Array.from(
      new Map(artifactRefs.map((ref) => [ref.artifact_id, ref])).values()
    );
    for (const issue of issues) logger.warn("Checkpoint reference rejected", { issue });
    return { runs, artifactRefs: dedupedRefs, issues };
  } catch (error) {
    logger.warn("Exact checkpointer read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { runs: [], artifactRefs: [], issues: ["checkpointer read failed"] };
  } finally {
    database?.close();
  }
}
