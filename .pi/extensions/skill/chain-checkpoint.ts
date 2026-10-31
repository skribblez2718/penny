import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolvePennyRuntimeState } from "@penny/orchestration";
import { randomBytes } from "node:crypto";

import { ArtifactClientError, parseArtifactRef, type ArtifactRef } from "./artifact-client.js";

export const SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION = 3 as const;
const CHAIN_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ChainCheckpointStep {
  index: number;
  skill_name: string;
  contract_sha256?: string;
  goal: string;
  input_artifacts?: string[];
  context_artifacts?: string[];
  previous_artifact_designation?: "binding" | "context";
  session_id: string;
  status: "pending" | "running" | "complete" | "failed";
  model?: string;
  constraints?: Record<string, unknown>;
  result_preview?: string;
  output_artifact_ref?: ArtifactRef;
  handoff_artifact_ref?: ArtifactRef;
  input_assurance?: {
    readonly mode: "reviewed_definition" | "semantic_only" | "not_applicable";
    readonly specification_artifact_id: string | null;
    readonly assurance_ref: ArtifactRef;
  };
  error?: string;
  error_detail?: {
    agent?: string;
    stop_reason?: string;
    timestamp: string;
  };
}

export interface ChainCheckpoint {
  schema_version: 1 | 2 | 3;
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
    contract_sha256?: string;
    goal: string;
    input_artifacts?: string[];
    context_artifacts?: string[];
    previous_artifact_designation?: "binding" | "context";
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
    return resolvePennyRuntimeState(projectRoot, { env }).paths.skillChains;
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

function isInputAssurance(
  value: unknown
): value is NonNullable<ChainCheckpointStep["input_assurance"]> {
  return (
    isRecord(value) &&
    (value.mode === "reviewed_definition" ||
      value.mode === "semantic_only" ||
      value.mode === "not_applicable") &&
    (value.specification_artifact_id === null ||
      (typeof value.specification_artifact_id === "string" &&
        /^art_[a-f0-9]{64}$/u.test(value.specification_artifact_id))) &&
    isArtifactRef(value.assurance_ref) &&
    value.assurance_ref.kind === "composition-assurance"
  );
}

function isCheckpointStep(value: unknown): value is ChainCheckpointStep {
  if (!isRecord(value)) return false;
  const status = value.status;
  const errorDetail = value.error_detail;
  return (
    typeof value.index === "number" &&
    typeof value.skill_name === "string" &&
    (value.contract_sha256 === undefined ||
      (typeof value.contract_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.contract_sha256))) &&
    typeof value.goal === "string" &&
    (value.input_artifacts === undefined || isStringArray(value.input_artifacts)) &&
    (value.context_artifacts === undefined || isStringArray(value.context_artifacts)) &&
    (value.previous_artifact_designation === undefined ||
      value.previous_artifact_designation === "context" ||
      value.previous_artifact_designation === "binding") &&
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
    (value.input_assurance === undefined || isInputAssurance(value.input_assurance)) &&
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
    (value.contract_sha256 === undefined ||
      (typeof value.contract_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.contract_sha256))) &&
    typeof value.goal === "string" &&
    (value.input_artifacts === undefined || isStringArray(value.input_artifacts)) &&
    (value.context_artifacts === undefined || isStringArray(value.context_artifacts)) &&
    (value.previous_artifact_designation === undefined ||
      value.previous_artifact_designation === "context" ||
      value.previous_artifact_designation === "binding") &&
    typeof value.session_id === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.constraints === undefined || isRecord(value.constraints))
  );
}

function isChainCheckpoint(value: unknown): value is ChainCheckpoint {
  if (!isRecord(value)) return false;
  const status = value.chain_status;
  return (
    (value.schema_version === 1 ||
      value.schema_version === 2 ||
      value.schema_version === SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION) &&
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
  if (
    value.schema_version !== 1 &&
    value.schema_version !== 2 &&
    value.schema_version !== SKILL_CHAIN_CHECKPOINT_SCHEMA_VERSION
  ) {
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
    if (value.schema_version === 3 && step.contract_sha256 === undefined) {
      checkpointError("schema-v3 skill-chain step is missing its registration binding");
    }
    if (value.schema_version === 3 && "release_status" in step) {
      checkpointError("schema-v3 skill-chain checkpoint retains a retired release field");
    }
    for (const ids of [step.input_artifacts, step.context_artifacts]) {
      if (
        ids !== undefined &&
        (new Set(ids).size !== ids.length || ids.some((id) => !/^art_[a-f0-9]{64}$/u.test(id)))
      )
        checkpointError("skill-chain explicit input artifacts are invalid");
    }
    if (step.input_artifacts?.some((id) => step.context_artifacts?.includes(id)))
      checkpointError("skill-chain context/native inputs overlap");
    return {
      index: step.index,
      skill_name: step.skill_name,
      ...(step.contract_sha256 === undefined ? {} : { contract_sha256: step.contract_sha256 }),
      goal: step.goal,
      ...(step.input_artifacts === undefined ? {} : { input_artifacts: [...step.input_artifacts] }),
      ...(step.context_artifacts === undefined
        ? {}
        : { context_artifacts: [...step.context_artifacts] }),
      ...(step.previous_artifact_designation === undefined
        ? {}
        : { previous_artifact_designation: step.previous_artifact_designation }),
      session_id: step.session_id,
      status: step.status,
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.constraints === undefined ? {} : { constraints: { ...step.constraints } }),
      ...(step.result_preview === undefined ? {} : { result_preview: step.result_preview }),
      ...(outputRef ? { output_artifact_ref: outputRef } : {}),
      ...(handoffRef ? { handoff_artifact_ref: handoffRef } : {}),
      ...(step.input_assurance === undefined ? {} : { input_assurance: step.input_assurance }),
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.error_detail === undefined ? {} : { error_detail: { ...step.error_detail } }),
    };
  });
  const pendingSteps = value.pending_steps.map((pending) => {
    const step = steps.find((candidate) => candidate.index === pending.index);
    if (step === undefined) checkpointError("pending chain step has no canonical step");
    if (
      value.schema_version === 3 &&
      (pending.contract_sha256 === undefined || pending.contract_sha256 !== step.contract_sha256)
    ) {
      checkpointError("schema-v3 pending step registration binding is missing or stale");
    }
    if (
      JSON.stringify(pending.context_artifacts ?? []) !==
        JSON.stringify(step.context_artifacts ?? []) ||
      pending.previous_artifact_designation !== step.previous_artifact_designation
    )
      checkpointError("pending step context designation differs from canonical step");
    if (value.schema_version === 3 && "release_status" in pending) {
      checkpointError("schema-v3 pending step retains a retired release field");
    }
    return {
      index: pending.index,
      skill_name: pending.skill_name,
      ...(pending.contract_sha256 === undefined
        ? {}
        : { contract_sha256: pending.contract_sha256 }),
      goal: pending.goal,
      ...(pending.context_artifacts === undefined
        ? {}
        : { context_artifacts: [...pending.context_artifacts] }),
      ...(pending.previous_artifact_designation === undefined
        ? {}
        : { previous_artifact_designation: pending.previous_artifact_designation }),
      ...(pending.input_artifacts === undefined
        ? {}
        : { input_artifacts: [...pending.input_artifacts] }),
      session_id: pending.session_id,
      ...(pending.model === undefined ? {} : { model: pending.model }),
      ...(pending.constraints === undefined ? {} : { constraints: { ...pending.constraints } }),
    };
  });
  return {
    schema_version: 3,
    state_layout_version: 1,
    project_id: value.project_id,
    chain_session_id: chainSessionId,
    chain_run_id: value.chain_run_id,
    chain_goal_summary: value.chain_goal_summary,
    steps,
    current_step: value.current_step,
    total_steps: value.total_steps,
    chain_status: value.chain_status,
    pending_steps: pendingSteps,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

/** Atomically persist complete owner-only restart state under XDG state. */
export function saveChainCheckpoint(
  checkpoint: ChainCheckpoint,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  checkpoint.updated_at = new Date().toISOString();
  const state = resolvePennyRuntimeState(projectRoot, { env });
  const normalized = normalizeCheckpoint(checkpoint, state.projectId);
  const root = resolveSkillChainStateRoot(projectRoot, env);
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
    const fileDescriptor = openSync(temporary, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(temporary, destination);
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
  const state = resolvePennyRuntimeState(projectRoot, { env });
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
