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
import { join } from "node:path";
import { resolvePennyProjectState } from "@penny/orchestration/source";
import { randomBytes } from "node:crypto";

import { ArtifactClientError, parseArtifactRef, type ArtifactRef } from "./artifact-client.js";

export const SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION = 1 as const;
const CHAIN_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ChainCheckpointStep {
  index: number;
  skill_name: string;
  goal: string;
  input_artifacts?: string[];
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
  state_layout_version: 1;
  project_id: string;
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
    input_artifacts?: string[];
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
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  if (env.PENNY_SKILL_CHAIN_STATE_ROOT?.trim()) {
    checkpointError(
      "PENNY_SKILL_CHAIN_STATE_ROOT is retired; chains are bound to the Penny project partition"
    );
  }
  try {
    return resolvePennyProjectState(projectRoot, { env }).paths.skillChains;
  } catch (error) {
    checkpointError(error instanceof Error ? error.message : "Penny project state is unavailable");
  }
}

function checkpointPath(
  chainSessionId: string,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return join(
    resolveSkillChainStateRoot(projectRoot, env),
    `${canonicalChainSessionId(chainSessionId)}.json`
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  try {
    parseArtifactRef(value);
    return true;
  } catch {
    return false;
  }
}

function isCheckpointStep(value: unknown): value is ChainCheckpointStep {
  if (!isRecord(value)) return false;
  const status = value.status;
  const errorDetail = value.error_detail;
  return (
    typeof value.index === "number" &&
    typeof value.skill_name === "string" &&
    typeof value.goal === "string" &&
    (value.input_artifacts === undefined || isStringArray(value.input_artifacts)) &&
    typeof value.session_id === "string" &&
    (status === "pending" ||
      status === "running" ||
      status === "complete" ||
      status === "failed") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.constraints === undefined || isRecord(value.constraints)) &&
    (value.result_preview === undefined || typeof value.result_preview === "string") &&
    (value.output_artifact_ref === undefined || isArtifactRef(value.output_artifact_ref)) &&
    (value.handoff_artifact_ref === undefined || isArtifactRef(value.handoff_artifact_ref)) &&
    (value.error === undefined || typeof value.error === "string") &&
    (errorDetail === undefined ||
      (isRecord(errorDetail) &&
        (errorDetail.agent === undefined || typeof errorDetail.agent === "string") &&
        (errorDetail.stop_reason === undefined || typeof errorDetail.stop_reason === "string") &&
        typeof errorDetail.timestamp === "string"))
  );
}

function isPendingCheckpointStep(
  value: unknown
): value is ChainCheckpoint["pending_steps"][number] {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.skill_name === "string" &&
    typeof value.goal === "string" &&
    (value.input_artifacts === undefined || isStringArray(value.input_artifacts)) &&
    typeof value.session_id === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.constraints === undefined || isRecord(value.constraints))
  );
}

function isChainCheckpoint(value: unknown): value is ChainCheckpoint {
  if (!isRecord(value)) return false;
  const status = value.chain_status;
  return (
    value.schema_version === SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION &&
    value.state_layout_version === 1 &&
    typeof value.project_id === "string" &&
    typeof value.chain_session_id === "string" &&
    typeof value.chain_run_id === "string" &&
    typeof value.chain_goal_summary === "string" &&
    Array.isArray(value.steps) &&
    value.steps.every(isCheckpointStep) &&
    typeof value.current_step === "number" &&
    typeof value.total_steps === "number" &&
    (status === "running" || status === "failed" || status === "complete") &&
    Array.isArray(value.pending_steps) &&
    value.pending_steps.every(isPendingCheckpointStep) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function normalizeCheckpoint(value: unknown, expectedProjectId: string): ChainCheckpoint {
  if (!isChainCheckpoint(value)) {
    checkpointError("skill-chain checkpoint does not match its schema");
  }
  if (value.schema_version !== SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION) {
    checkpointError("unsupported skill-chain checkpoint schema");
  }
  if (value.state_layout_version !== 1) checkpointError("unsupported state layout version");
  if (value.project_id !== expectedProjectId) {
    checkpointError("skill-chain checkpoint belongs to another Penny project");
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
    if (step.input_artifacts !== undefined) {
      if (
        !Array.isArray(step.input_artifacts) ||
        new Set(step.input_artifacts).size !== step.input_artifacts.length ||
        step.input_artifacts.some((id) => !/^art_[a-f0-9]{64}$/u.test(id))
      ) {
        checkpointError("skill-chain explicit input artifacts are invalid");
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
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  checkpoint.updated_at = new Date().toISOString();
  const state = resolvePennyProjectState(projectRoot, { env });
  const normalized = normalizeCheckpoint(checkpoint, state.projectId);
  const root = resolveSkillChainStateRoot(projectRoot, env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  assertOwnerOnly(root, "directory");
  const destination = checkpointPath(normalized.chain_session_id, projectRoot, env);
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
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): ChainCheckpoint | null {
  const state = resolvePennyProjectState(projectRoot, { env });
  const filePath = checkpointPath(chainSessionId, projectRoot, env);
  if (!existsSync(filePath)) return null;
  assertOwnerOnly(resolveSkillChainStateRoot(projectRoot, env), "directory");
  assertOwnerOnly(filePath, "file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    checkpointError("skill-chain checkpoint is not valid JSON");
  }
  return normalizeCheckpoint(value, state.projectId);
}
