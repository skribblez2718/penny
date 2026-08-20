import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { ArtifactClientError, parseArtifactRef, type ArtifactRef } from "./artifact-client.js";

export const SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION = 1 as const;
const CHAIN_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ChainCheckpointStep {
  index: number;
  skill_name: string;
  goal: string;
  session_id: string;
  status: "pending" | "running" | "complete" | "failed";
  model?: string;
  constraints?: Record<string, unknown>;
  result_preview?: string;
  output_artifact_ref?: ArtifactRef;
  handoff_artifact_ref?: ArtifactRef;
  error?: string;
  error_detail?: {
    agent?: string;
    stop_reason?: string;
    timestamp: string;
  };
}

export interface ChainCheckpoint {
  schema_version: 1;
  chain_session_id: string;
  chain_run_id: string;
  chain_goal_summary: string;
  steps: ChainCheckpointStep[];
  current_step: number;
  total_steps: number;
  chain_status: "running" | "failed" | "complete";
  pending_steps: Array<{
    index: number;
    skill_name: string;
    goal: string;
    session_id: string;
    model?: string;
    constraints?: Record<string, unknown>;
  }>;
  created_at: string;
  updated_at: string;
}

function checkpointError(message: string): never {
  throw new ArtifactClientError("ARTIFACT_CONTRACT_INVALID", message);
}

function canonicalChainSessionId(value: unknown): string {
  if (typeof value !== "string" || !CHAIN_SESSION_ID_PATTERN.test(value)) {
    checkpointError("chain session ID is not canonical");
  }
  return value;
}

export function resolveSkillChainStateRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const explicit = env.PENNY_SKILL_CHAIN_STATE_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) checkpointError("PENNY_SKILL_CHAIN_STATE_ROOT must be absolute");
    return resolve(explicit);
  }
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    if (!isAbsolute(xdgStateHome)) checkpointError("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgStateHome), "penny", "skill-chains");
  }
  const home = env.HOME?.trim() || homedir();
  if (!home || !isAbsolute(home))
    checkpointError("no absolute skill-chain state root is available");
  return join(resolve(home), ".local", "state", "penny", "skill-chains");
}

function checkpointPath(
  chainSessionId: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return join(resolveSkillChainStateRoot(env), `${canonicalChainSessionId(chainSessionId)}.json`);
}

function assertOwnerOnly(path: string, type: "file" | "directory"): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) checkpointError("skill-chain state cannot be a symbolic link");
  if ((type === "file" && !stats.isFile()) || (type === "directory" && !stats.isDirectory())) {
    checkpointError("skill-chain state has the wrong type");
  }
  if ((stats.mode & 0o077) !== 0) checkpointError("skill-chain state must be owner-only");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    checkpointError("skill-chain state has the wrong owner");
  }
}

function normalizeCheckpoint(value: ChainCheckpoint): ChainCheckpoint {
  if (value.schema_version !== SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION) {
    checkpointError("unsupported skill-chain checkpoint schema");
  }
  const chainSessionId = canonicalChainSessionId(value.chain_session_id);
  if (value.chain_run_id !== chainSessionId) checkpointError("skill-chain run identity is stale");
  if (!Array.isArray(value.steps) || !Array.isArray(value.pending_steps)) {
    checkpointError("skill-chain checkpoint steps are invalid");
  }
  const seen = new Set<number>();
  const steps = value.steps.map((step): ChainCheckpointStep => {
    if (!Number.isSafeInteger(step.index) || step.index < 0 || seen.has(step.index)) {
      checkpointError("skill-chain checkpoint step index is invalid");
    }
    seen.add(step.index);
    const outputRef = step.output_artifact_ref
      ? parseArtifactRef(step.output_artifact_ref)
      : undefined;
    const handoffRef = step.handoff_artifact_ref
      ? parseArtifactRef(step.handoff_artifact_ref)
      : undefined;
    if (handoffRef) {
      const target = value.steps.find((candidate) => candidate.index === step.index + 1);
      if (!target || handoffRef.run_id !== target.session_id) {
        checkpointError("skill-chain handoff artifact is not bound to the next target run");
      }
    }
    return {
      ...step,
      ...(outputRef ? { output_artifact_ref: outputRef } : {}),
      ...(handoffRef ? { handoff_artifact_ref: handoffRef } : {}),
    };
  });
  return { ...value, chain_session_id: chainSessionId, steps };
}

/** Atomically persist complete owner-only restart state under XDG state. */
export function saveChainCheckpoint(
  checkpoint: ChainCheckpoint,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  checkpoint.updated_at = new Date().toISOString();
  const normalized = normalizeCheckpoint(checkpoint);
  const root = resolveSkillChainStateRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  assertOwnerOnly(root, "directory");
  const destination = checkpointPath(normalized.chain_session_id, env);
  const temporary = join(
    root,
    `.${normalized.chain_session_id}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    const fileDescriptor = openSync(temporary, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    const directoryDescriptor = openSync(root, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Load and validate durable exact refs; absence is distinct from corruption. */
export function readChainCheckpoint(
  chainSessionId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): ChainCheckpoint | null {
  const filePath = checkpointPath(chainSessionId, env);
  if (!existsSync(filePath)) return null;
  assertOwnerOnly(resolveSkillChainStateRoot(env), "directory");
  assertOwnerOnly(filePath, "file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    checkpointError("skill-chain checkpoint is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    checkpointError("skill-chain checkpoint must be an object");
  }
  return normalizeCheckpoint(value as ChainCheckpoint);
}
