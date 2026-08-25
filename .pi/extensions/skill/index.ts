import { registerTool } from "../../lib/pi-tool-registration.js";
/**
 * Skill Invocation Extension
 *
 * Drives TypeScript state-machine skills through the shared orchestration service.
 *
 * Architecture:
 *   Penny → skill tool → TypeScript OrchestrationService → Pi SDK workers →
 *   immutable owner artifacts → durable TypeScript checkpoints → terminal result.
 *
 * Key principle: Penny's context window stays clean without making semantic
 * memory the output authority. The execution owner persists exact final-output
 * bytes before parsing SUMMARY and passes only the trusted ref plus bounded
 * routing/evidence metadata to the orchestrator.
 *
 * Agent invocation: Uses the shared agent-runner module from the subagent
 * extension. This module spawns pi processes for agents directly, bypassing
 * the non-existent ctx.tools API (the pi framework's ExtensionContext does
 * not provide cross-tool invocation — extensions cannot call other tools).
 */

import * as path from "path";
import { randomUUID } from "crypto";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  Theme,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  KnowledgeBaseRequestSchema,
  OrchestrationService,
  resolvePennyProjectState,
  validateKnowledgeBaseRequest,
  type Checkpointer,
  type KbAgentRunner,
  type JsonValue,
  type KnowledgeBaseRequest,
  type ReplayableKnowledgeBaseResult,
  type RunContext,
} from "@penny/orchestration/source";
import {
  SkillResult,
  formatResult,
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  detectSkillMode,
  reconstructResumeChain,
  isClarificationEscalation,
} from "./skill-utils.js";
import {
  ArtifactClientError,
  parseArtifactRef,
  readArtifactsById,
  readArtifactOutput,
  type ArtifactRef,
} from "./artifact-client.js";
import { parseInputArtifacts, type InputArtifactsV2 } from "./input-artifacts.js";
import { artifactDispatchControl, localArtifactDispatchPause } from "./dispatch-control.js";
import {
  readChainCheckpoint,
  saveChainCheckpoint,
  type ChainCheckpoint,
} from "./chain-checkpoint.js";
import {
  persistSkillChainHandoff,
  skillChainInput,
  validateSkillChainHandoff,
} from "./skill-chain-artifacts.js";
import {
  discoverSkillsFromDirectory,
  modelInvocableSkills,
  type SkillDiscovery,
} from "./skill-discovery.js";
import { alignNativeSkillInstruction } from "./skill-prompt.js";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("skill");

import { mapWithConcurrencyLimit } from "../subagent/agent-runner.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringArrayOrEmpty(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!isUnknownArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`knowledge-base terminal result has invalid ${field}`);
  }
  return value;
}

type ReplayOperationAction = "init" | "ingest" | "query" | "save" | "lint" | "promote" | "resume";

function isReplayOperationAction(value: unknown): value is ReplayOperationAction {
  return (
    value === "init" ||
    value === "ingest" ||
    value === "query" ||
    value === "save" ||
    value === "lint" ||
    value === "promote" ||
    value === "resume"
  );
}

type KnowledgeBaseArtifactHandle = ReplayableKnowledgeBaseResult["artifacts"][number];

const KNOWLEDGE_BASE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "claims",
  "page_draft",
  "query_answer",
  "lint_report",
  "verification_report",
  "promotion_plan",
  "promotion_patch",
]);

function isKnowledgeBaseArtifactHandle(value: unknown): value is KnowledgeBaseArtifactHandle {
  return (
    isRecord(value) &&
    value.schema_version === 1 &&
    typeof value.artifact_id === "string" &&
    value.artifact_id.length > 0 &&
    typeof value.artifact_kind === "string" &&
    KNOWLEDGE_BASE_ARTIFACT_KINDS.has(value.artifact_kind) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    value.media_type === "application/json" &&
    typeof value.byte_length === "number" &&
    Number.isSafeInteger(value.byte_length) &&
    value.byte_length >= 0 &&
    value.byte_length <= 1_048_576
  );
}

/** Abort one TypeScript skill invocation without converting it to success. */
function abortError(skillName: string): Error {
  return Object.assign(new Error(`Skill '${skillName}' invocation was interrupted`), {
    name: "AbortError",
    code: "SKILL_ABORTED" as const,
  });
}

// ============================================================
// Configuration
// ============================================================

interface SkillConfig {
  skillsDir: string;
}

/** Public KB tool wire is owned solely by apps/orchestration/src/kb/contracts.ts. */
const KnowledgeBaseParameters = KnowledgeBaseRequestSchema;
type KnowledgeBaseParams = KnowledgeBaseRequest;

let config: SkillConfig;

/** Open a schema-validated KB request for action-specific field projection. */
function validatedKnowledgeBaseRequestFields(
  request: KnowledgeBaseRequest
): Readonly<Record<string, unknown>> {
  return { ...request };
}

/** Project validated promotion refs into the orchestration JSON constraint domain. */
function promotionPageRevisionsForConstraints(
  pageRevisions: readonly { readonly page_id: string; readonly revision_id: string }[]
): JsonValue[] {
  return pageRevisions.map((revision) => ({
    page_id: revision.page_id,
    revision_id: revision.revision_id,
  }));
}

// ============================================================
// Skill Discovery
// ============================================================

function discoverSkills(): SkillDiscovery[] {
  return discoverSkillsFromDirectory(config.skillsDir, {
    onMetadataError: (skill) =>
      logger.debug("Skill metadata parse failed, using default description", { skill }),
  });
}

// ============================================================
// TypeScript orchestration
// ============================================================

async function executeTypeScriptSkill(
  skillName: string,
  params: {
    goal: string;
    session_id?: string;
    constraints?: Record<string, unknown>;
    /** Test/caller override applied to every research agent without changing SSOT defaults. */
    model?: string;
    /** Exact IDs supplied explicitly by the caller, from any run. */
    input_artifacts?: string[];
    /** Exact predecessor inserted automatically by skill-chain composition. */
    chain_input_artifacts?: InputArtifactsV2;
  },
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: AgentToolUpdateCallback<SkillResult | undefined> | undefined
): Promise<SkillResult> {
  if (skillName !== "research") {
    return {
      success: false,
      session_id: params.session_id || "",
      skill_name: skillName,
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: [],
      errors: ["TypeScript orchestration currently supports the research skill on this tool."],
    };
  }
  if (signal?.aborted) {
    throw abortError(skillName);
  }
  const projectRoot = path.resolve(cwd);
  const sessionId = params.session_id || `skill-${randomUUID()}`;
  const runId = sessionId;
  const constraints =
    params.constraints && typeof params.constraints === "object" ? params.constraints : {};
  const { user_response: clarificationResponse, ...workflowConstraints } = constraints;
  const chainInput = params.chain_input_artifacts
    ? parseInputArtifacts(params.chain_input_artifacts)
    : undefined;
  const explicitRefs = (
    await readArtifactsById({
      artifactIds: params.input_artifacts ?? [],
      projectRoot,
      env: process.env,
    })
  ).map((read) => read.ref);
  const allInputRefs = [
    ...(chainInput?.artifacts.map((binding) => binding.ref) ?? []),
    ...explicitRefs,
  ];
  const dedupedInputRefs = [...new Map(allInputRefs.map((ref) => [ref.artifact_id, ref])).values()];
  const inputArtifacts =
    dedupedInputRefs.length > 0
      ? parseInputArtifacts({
          schema_version: 2,
          artifacts: dedupedInputRefs.map((ref, index) => ({
            slot: `input-${String(index + 1).padStart(4, "0")}`,
            ref,
          })),
        })
      : undefined;
  const trustedProject =
    typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
  // Always register the worker-read memory provider because every catalog
  // agent declares its exact memory.read surface. Missing service configuration
  // becomes a typed tool-call error; it never removes declared tools.
  const memory = await import("@penny/memory-extension");
  const readEnv: Record<string, string> = {};
  const copy = (name: string) => {
    const value = process.env[name];
    if (value && value.trim().length > 0) readEnv[name] = value;
  };
  for (const name of [
    "PENNY_MEMORY_MCP_ENDPOINT",
    "PENNY_MEMORY_PALACE_ID",
    "PENNY_MEMORY_PRINCIPAL_ID",
    "PENNY_MEMORY_TRUST_MODE",
    "PENNY_MEMORY_ISOLATION_BOUNDARY_ID",
    "PENNY_MEMORY_DATA_ROOT_ID",
    "PENNY_MEMORY_MAX_RESPONSE_BYTES",
    "PENNY_MEMORY_REQUEST_TIMEOUT_MS",
  ]) {
    copy(name);
  }
  const tokenFile = process.env.PENNY_MEMORY_MCP_TOKEN_FILE;
  const tokenEnvName = process.env.PENNY_MEMORY_MCP_TOKEN_ENV;
  if (tokenFile?.trim()) {
    readEnv.PENNY_MEMORY_MCP_TOKEN_FILE = tokenFile;
  } else if (tokenEnvName?.trim()) {
    readEnv.PENNY_MEMORY_MCP_TOKEN_ENV = tokenEnvName;
    const secret = process.env[tokenEnvName];
    if (secret?.trim()) readEnv[tokenEnvName] = secret;
  }
  readEnv.PENNY_RUNTIME_ROLE = "worker-read";
  const workerExtensions = [
    {
      name: "memory-worker-read",
      factory: memory.createMemoryExtension({ env: readEnv }),
      hidden: true,
    },
  ];
  const serviceEnv = params.model
    ? { ...process.env, PENNY_RESEARCH_DEFAULT_MODEL: params.model }
    : process.env;
  using service = new OrchestrationService({
    projectRoot,
    env: serviceEnv,
    workerExtensions,
  });
  const identity = {
    schema_version: 2 as const,
    run_id: runId,
    session_id: sessionId,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
  onUpdate?.({
    content: [{ type: "text", text: `Starting TypeScript research run ${runId}...` }],
    details: undefined,
  });

  const existing = service.checkpointer.loadRunById(runId);
  if (inputArtifacts !== undefined && existing === undefined) {
    for (const binding of inputArtifacts.artifacts) service.artifacts.read(binding.ref);
  }
  if (inputArtifacts !== undefined && existing !== undefined) {
    throw new Error(`run '${runId}' already exists; input_artifacts cannot be changed on recovery`);
  }
  let directive;
  if (existing !== undefined && clarificationResponse !== undefined) {
    const gate = existing.pendingDirective;
    if (gate?.action !== "await_user") {
      throw new Error(`run '${runId}' is not awaiting clarification`);
    }
    directive = await service.execute(
      {
        schema_version: 2,
        action: "respond",
        identity,
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        response: clarificationResponse,
      },
      signal
    );
  } else if (existing !== undefined) {
    directive = await service.execute(
      {
        schema_version: 2,
        action: "recover",
        identity,
      },
      signal
    );
  } else {
    directive = await service.execute(
      {
        schema_version: 2,
        action: "start",
        identity,
        goal: params.goal,
        constraints: workflowConstraints,
        project_root: projectRoot,
        trust_profile: trustedProject ? "trusted-interactive" : "hardened-untrusted",
        ...(inputArtifacts ? { input_artifacts: inputArtifacts } : {}),
      },
      signal
    );
  }

  if (signal?.aborted) {
    throw abortError(skillName);
  }
  const agentsInvoked = service.checkpointer
    .events(runId)
    .map((event) => event.payload.agent)
    .filter((agent): agent is string => typeof agent === "string");

  if (directive.action === "await_user") {
    return {
      success: false,
      session_id: sessionId,
      skill_name: skillName,
      state: directive.state_id,
      requires_approval: false,
      steps_total: agentsInvoked.length,
      agents_invoked: agentsInvoked,
      errors: [],
      escalation: {
        questions: directive.questions.map((question, index) => ({
          id: question.id,
          label: `Clarification ${index + 1}`,
          prompt: question.prompt,
          options: [],
          allowOther: true,
        })),
        unknown_reason: "The TypeScript research run requires user clarification.",
        previous_state: existing?.previousState || undefined,
      },
    };
  }

  if (directive.action === "paused") {
    const control = artifactDispatchControl(process.env);
    const pause = localArtifactDispatchPause(control, {
      state_id: directive.state_id,
      session_id: sessionId,
      run_id: runId,
    });
    return {
      success: false,
      session_id: sessionId,
      skill_name: skillName,
      state: directive.state_id,
      requires_approval: false,
      steps_total: agentsInvoked.length,
      agents_invoked: agentsInvoked,
      errors: [],
      retriable: true,
      dispatch_pause: pause,
      recovery: pause.recovery,
    };
  }

  if (
    directive.action === "complete" ||
    directive.action === "incomplete" ||
    directive.action === "error" ||
    directive.action === "cancelled"
  ) {
    const outputRefValue = directive.result.output_artifact_ref;
    const outputRef =
      outputRefValue === null || outputRefValue === undefined
        ? undefined
        : parseArtifactRef(outputRefValue);
    return {
      success: directive.action === "complete" && directive.met === true,
      session_id: sessionId,
      skill_name: skillName,
      state: directive.status,
      requires_approval: false,
      steps_total: agentsInvoked.length,
      agents_invoked: agentsInvoked,
      errors: directive.unresolved.map(String),
      result: directive.result,
      output_artifact_ref: outputRef,
    };
  }

  throw new Error(`TypeScript orchestration stopped at unexpected action '${directive.action}'`);
}

// ============================================================
// Formatting
// ============================================================

// ============================================================
// Skill Invocation Limits
// ============================================================

const MAX_PARALLEL_SKILLS = 3;
const MAX_CHAIN_STEPS = 10;

// ============================================================
// Skill Parameter Schema
// ============================================================

const ArtifactIdSchema = Type.String({
  pattern: "^art_[a-f0-9]{64}$",
  description: "Exact immutable artifact ID from any prior run",
});
const InputArtifactIdsSchema = Type.Array(ArtifactIdSchema, {
  uniqueItems: true,
  description: "Unique exact artifact IDs verified before the skill run starts",
});

/**
 * Single skill step shape — used in both skills[] and chain[] arrays.
 */
const SkillStep = Type.Object({
  skill_name: Type.String({
    description: "Name of the skill to invoke (e.g., 'research')",
  }),
  goal: Type.String({
    description:
      "The goal or objective for the skill to accomplish. " +
      "In chain mode, {previous} identifies the prior skill's exact terminal artifact; payload bytes are never substituted.",
  }),
  input_artifacts: Type.Optional(InputArtifactIdsSchema),
  session_id: Type.Optional(
    Type.String({
      description: "Override auto-generated session identifier",
    })
  ),
  constraints: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Per-step constraints as JSON object",
    })
  ),
  model: Type.Optional(
    Type.String({ description: "Override the model for all agents in this skill step" })
  ),
});

const StepOverride = Type.Object({
  goal: Type.Optional(
    Type.String({
      description: "Override the failed step's goal",
    })
  ),
  constraints: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Override the failed step's constraints (e.g., longer timeout)",
    })
  ),
});

const SkillParams = Type.Object({
  // Single mode (skill_name + goal are optional because parallel/chain mode
  // doesn't use them; mutual exclusion is enforced in detectSkillMode()).
  skill_name: Type.Optional(
    Type.String({
      description: "Name of the skill to invoke (single mode)",
    })
  ),
  goal: Type.Optional(
    Type.String({
      description: "The goal or objective for the skill to accomplish (single mode)",
    })
  ),
  input_artifacts: Type.Optional(InputArtifactIdsSchema),
  session_id: Type.Optional(
    Type.String({
      description: "Unique session identifier (auto-generated if not provided)",
    })
  ),
  constraints: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Additional constraints as JSON object",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Test/caller model override applied to every agent in this invocation; production defaults remain in agent SSOT frontmatter.",
    })
  ),
  // Parallel mode — invoke multiple skills concurrently (max 3).
  skills: Type.Optional(
    Type.Array(SkillStep, {
      description:
        "Invoke multiple skills in parallel. " + `Max ${MAX_PARALLEL_SKILLS} concurrent skills.`,
    })
  ),

  // Chain mode — invoke skills sequentially with exact terminal-artifact handoff.
  chain: Type.Optional(
    Type.Array(SkillStep, {
      description:
        "Invoke skills sequentially with exact terminal artifact IDs; {previous} is an artifact marker, not payload text. " +
        `Max ${MAX_CHAIN_STEPS} steps. Stops on first error — use resume_chain to recover.`,
    })
  ),

  // Resume a failed chain from its checkpoint.
  resume_chain: Type.Optional(
    Type.String({
      description:
        "Resume a failed chain by its chain_session_id. " +
        "Skips completed steps, resumes from the failed step. " +
        "Use step_overrides to modify the failed step's goal or constraints.",
    })
  ),

  // Override parameters for a specific step when resuming a chain.
  step_overrides: Type.Optional(
    Type.Record(Type.Number({ minimum: 0 }), StepOverride, {
      description:
        "Per-step overrides when resuming a chain. " +
        "Key is the step index (0-based). Only the failed step is applied; others are ignored.",
    })
  ),
});

/** Statically-derived shape of the `skill` tool's validated parameters. */
type SkillToolParams = Static<typeof SkillParams>;

export { detectSkillMode } from "./skill-utils.js";

// ============================================================
// TypeScript composition
// ============================================================

/**
 * Run multiple skills concurrently with concurrency limiting.
 *
 * Each parallel skill gets an independent session and independent exact inputs.
 * On abort, pending skills are cancelled and partial results returned.
 */
async function executeSkillsParallel(
  skills: Array<{
    skill_name: string;
    goal: string;
    input_artifacts?: string[];
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: AgentToolUpdateCallback<SkillResult | undefined> | undefined
): Promise<SkillResult> {
  const parallelSessionId = `parallel-${Date.now()}`;
  let completed = 0;
  const total = skills.length;

  const results = await mapWithConcurrencyLimit(
    skills,
    MAX_PARALLEL_SKILLS,
    async (skill, _index) => {
      const result = await executeTypeScriptSkill(
        skill.skill_name,
        {
          goal: skill.goal,
          input_artifacts: skill.input_artifacts,
          session_id: skill.session_id,
          constraints: skill.constraints,
          model: skill.model,
        },
        cwd,
        signal,
        ctx,
        undefined // no per-skill onUpdate to avoid TUI noise
      );
      completed++;
      onUpdate?.({
        content: [
          { type: "text", text: `Skill ${completed}/${total} complete: ${skill.skill_name}` },
        ],
        details: undefined,
      });
      return result;
    }
  );

  const allSucceeded = results.every((r) => r.success);
  const allErrors = results.flatMap((r) => r.errors);
  const allAgents = results.flatMap((r) => r.agents_invoked);

  return {
    success: allSucceeded,
    session_id: parallelSessionId,
    skill_name: "parallel",
    state: allSucceeded ? "complete" : "partial",
    requires_approval: false,
    session_room: undefined,
    steps_total: total,
    agents_invoked: allAgents,
    errors: allErrors,
    mode: "parallel",
    parallel_results: results,
  };
}

/**
 * Run skills sequentially with exact terminal-artifact handoff and durable
 * owner-only XDG checkpoint/resume state. A bounded preview may be retained for
 * display, but it never replaces the canonical ref.
 */
async function executeSkillsChain(
  chain: Array<{
    skill_name: string;
    goal: string;
    input_artifacts?: string[];
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: AgentToolUpdateCallback<SkillResult | undefined> | undefined,
  resumeFrom?: string,
  stepOverrides?: Record<number, { goal?: string; constraints?: Record<string, unknown> }>
): Promise<SkillResult> {
  const results: SkillResult[] = [];
  let startStep = 0;
  let chainSessionId: string;
  let checkpoint: ChainCheckpoint;
  let previousHandoffRef: ReturnType<typeof parseArtifactRef> | undefined;
  let finalOutputRef: ReturnType<typeof parseArtifactRef> | undefined;
  const projectRoot = path.resolve(cwd);
  const projectState = resolvePennyProjectState(projectRoot, { env: process.env });

  if (resumeFrom) {
    const recovered = readChainCheckpoint(resumeFrom, projectRoot, process.env);
    if (!recovered) {
      return {
        success: false,
        session_id: resumeFrom,
        skill_name: "chain",
        state: "error",
        requires_approval: false,
        steps_total: 0,
        agents_invoked: [],
        errors: [`Checkpoint not found: ${resumeFrom}`],
        mode: "chain",
      };
    }
    checkpoint = recovered;
    chainSessionId = recovered.chain_session_id;
    const completedSteps = [...recovered.steps]
      .filter((step) => step.status === "complete")
      .sort((left, right) => left.index - right.index);
    for (const done of completedSteps) {
      results.push({
        success: true,
        session_id: done.session_id,
        skill_name: done.skill_name,
        state: "complete",
        requires_approval: false,
        steps_total: 1,
        agents_invoked: [],
        errors: [],
        mode: "chain",
        chain_step: done.index,
        chain_total: recovered.total_steps,
        chain_session_id: chainSessionId,
        plan: done.result_preview ? { plan_summary: done.result_preview } : undefined,
        output_artifact_ref: done.output_artifact_ref,
      });
      if (done.handoff_artifact_ref) previousHandoffRef = done.handoff_artifact_ref;
      if (done.output_artifact_ref) finalOutputRef = done.output_artifact_ref;
    }

    if (recovered.chain_status === "complete") {
      return {
        success: true,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "complete",
        requires_approval: false,
        steps_total: recovered.total_steps,
        agents_invoked: [],
        errors: [],
        mode: "chain",
        chain_step: recovered.total_steps - 1,
        chain_total: recovered.total_steps,
        chain_session_id: chainSessionId,
        chain_results: results,
        output_artifact_ref: finalOutputRef,
      };
    }

    const reconstruction = reconstructResumeChain(recovered, stepOverrides);
    chain = reconstruction.chain;
    startStep = reconstruction.startStep;
    logger.info("Resuming chain from durable checkpoint", {
      chainSessionId,
      startStep,
      stepsToRun: chain.length,
    });
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Resuming chain ${chainSessionId} from step ${startStep + 1}/${recovered.total_steps}`,
        },
      ],
      details: undefined,
    });
  } else {
    chainSessionId = `chain-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const steps = chain.map((step, index) => ({
      index,
      skill_name: step.skill_name,
      goal: step.goal,
      input_artifacts: step.input_artifacts,
      session_id: step.session_id || `${step.skill_name}-${randomUUID()}`,
      status: "pending" as const,
      model: step.model,
      constraints: step.constraints,
    }));
    checkpoint = {
      schema_version: 1,
      state_layout_version: 1,
      project_id: projectState.projectId,
      chain_session_id: chainSessionId,
      chain_run_id: chainSessionId,
      chain_goal_summary: chain.map((step) => step.skill_name).join(" → "),
      steps,
      current_step: 0,
      total_steps: steps.length,
      chain_status: "running",
      pending_steps: steps.map((step) => ({
        index: step.index,
        skill_name: step.skill_name,
        goal: step.goal,
        input_artifacts: step.input_artifacts,
        session_id: step.session_id,
        model: step.model,
        constraints: step.constraints,
      })),
      created_at: createdAt,
      updated_at: createdAt,
    };
  }

  for (let index = 0; index < chain.length; index++) {
    const step = chain[index];
    const stepIndex = startStep + index;
    const stepEntry = checkpoint.steps.find((candidate) => candidate.index === stepIndex);
    if (!stepEntry) {
      throw new ArtifactClientError(
        "ARTIFACT_CONTRACT_INVALID",
        `skill-chain checkpoint is missing step ${stepIndex}`
      );
    }

    let chainInputArtifacts: InputArtifactsV2 | undefined;
    if (previousHandoffRef) {
      try {
        await validateSkillChainHandoff(previousHandoffRef, path.resolve(cwd), process.env);
        chainInputArtifacts = skillChainInput({
          targetRunId: stepEntry.session_id,
          handoffRef: previousHandoffRef,
        });
      } catch (error) {
        const code = error instanceof ArtifactClientError ? error.code : "ARTIFACT_MISSING";
        stepEntry.status = "failed";
        stepEntry.error = `Exact predecessor artifact is unavailable (${code})`;
        checkpoint.current_step = stepIndex;
        checkpoint.chain_status = "failed";
        saveChainCheckpoint(checkpoint, projectRoot, process.env);
        return {
          success: false,
          session_id: chainSessionId,
          skill_name: "chain",
          state: "failed",
          requires_approval: false,
          steps_total: checkpoint.total_steps,
          agents_invoked: results.flatMap((result) => result.agents_invoked),
          errors: [stepEntry.error],
          mode: "chain",
          chain_step: stepIndex,
          chain_total: checkpoint.total_steps,
          chain_session_id: chainSessionId,
          chain_error_step: stepIndex,
          chain_results: results,
          resumable: true,
          output_artifact_ref: finalOutputRef,
        };
      }
    }

    checkpoint.current_step = stepIndex;
    checkpoint.chain_status = "running";
    stepEntry.status = "running";
    saveChainCheckpoint(checkpoint, projectRoot, process.env);

    const previousMarker = chainInputArtifacts
      ? "the exact prior-skill terminal artifact identified below"
      : "";
    const resolvedGoal = step.goal.replaceAll("{previous}", previousMarker);
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Chain step ${stepIndex + 1}/${checkpoint.total_steps}: ${step.skill_name}`,
        },
      ],
      details: undefined,
    });

    const result = await executeTypeScriptSkill(
      step.skill_name,
      {
        goal: resolvedGoal,
        input_artifacts: step.input_artifacts,
        session_id: stepEntry.session_id,
        constraints: step.constraints,
        model: step.model,
        chain_input_artifacts: chainInputArtifacts,
      },
      cwd,
      signal,
      ctx,
      undefined
    );
    result.mode = "chain";
    // Chain transport is artifact/checkpoint-only; legacy playbook rooms are
    // neither exposed nor retained as chain authority.
    result.session_room = undefined;
    result.chain_step = stepIndex;
    result.chain_total = checkpoint.total_steps;
    result.chain_session_id = chainSessionId;
    results.push(result);

    if (!result.success && result.retriable && result.dispatch_pause) {
      // A dispatch pause is not a failed chain step. Keep both the engine run and
      // chain step pending/running so a fresh resume reuses the same session and
      // exact predecessor refs after the owner returns the mode to active.
      stepEntry.status = "running";
      delete stepEntry.error;
      delete stepEntry.error_detail;
      checkpoint.chain_status = "running";
      saveChainCheckpoint(checkpoint, projectRoot, process.env);
      return {
        success: false,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "paused",
        requires_approval: false,
        steps_total: checkpoint.total_steps,
        agents_invoked: results.flatMap((item) => item.agents_invoked),
        errors: [],
        mode: "chain",
        chain_step: stepIndex,
        chain_total: checkpoint.total_steps,
        chain_session_id: chainSessionId,
        chain_error_step: stepIndex,
        chain_results: results.slice(0, -1),
        resumable: true,
        retriable: true,
        dispatch_pause: result.dispatch_pause,
        recovery: result.recovery,
        output_artifact_ref: finalOutputRef,
      };
    }

    if (!result.success) {
      stepEntry.status = "failed";
      stepEntry.error = result.errors.join("; ") || `Step ${stepIndex + 1} failed`;
      stepEntry.error_detail = {
        agent: result.agents_invoked.at(-1) || "unknown",
        stop_reason: result.state,
        timestamp: new Date().toISOString(),
      };
      checkpoint.chain_status = "failed";
      saveChainCheckpoint(checkpoint, projectRoot, process.env);

      const escalation = result.escalation;
      if (isClarificationEscalation(result) && escalation) {
        return {
          success: false,
          session_id: chainSessionId,
          skill_name: "chain",
          state: "awaiting_clarification",
          requires_approval: false,
          steps_total: checkpoint.total_steps,
          agents_invoked: results.flatMap((item) => item.agents_invoked),
          errors: [],
          mode: "chain",
          chain_step: stepIndex,
          chain_total: checkpoint.total_steps,
          chain_session_id: chainSessionId,
          chain_error_step: stepIndex,
          chain_results: results.slice(0, -1),
          resumable: true,
          output_artifact_ref: finalOutputRef,
          escalation: {
            questions: escalation.questions,
            unknown_reason:
              `Step ${stepIndex + 1}/${checkpoint.total_steps} (${step.skill_name}) needs clarification before the chain can continue.` +
              (escalation.unknown_reason ? ` ${escalation.unknown_reason}` : ""),
            previous_state: escalation.previous_state,
          },
        };
      }

      return {
        success: false,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "failed",
        requires_approval: true,
        steps_total: checkpoint.total_steps,
        agents_invoked: results.flatMap((item) => item.agents_invoked),
        errors: [
          `Chain stopped at step ${stepIndex + 1}/${checkpoint.total_steps} (${step.skill_name}): ${result.errors.join("; ")}`,
        ],
        mode: "chain",
        chain_step: stepIndex,
        chain_total: checkpoint.total_steps,
        chain_session_id: chainSessionId,
        chain_error_step: stepIndex,
        chain_results: results.slice(0, -1),
        resumable: true,
        output_artifact_ref: finalOutputRef,
        escalation: {
          questions: [
            {
              id: "chain_recovery",
              label: "Chain Failed",
              prompt: `Chain "${checkpoint.chain_goal_summary}" failed at step ${stepIndex + 1}/${checkpoint.total_steps} (${step.skill_name}). The chain is resumable. How would you like to proceed?`,
              options: [
                { value: "retry", label: "Retry this step (diagnose and fix first)" },
                { value: "retry_longer", label: "Retry with doubled agent timeout" },
                { value: "skip", label: "Skip this step and continue chain" },
                { value: "diagnose", label: "Diagnose via observability logs" },
              ],
              allowOther: true,
            },
          ],
          unknown_reason: result.errors.join("; "),
          previous_state: "chain_execution",
        },
      };
    }

    const terminalRef = result.output_artifact_ref;
    if (terminalRef) finalOutputRef = terminalRef;
    const hasNextStep = stepIndex + 1 < checkpoint.total_steps;
    if (hasNextStep && !terminalRef) {
      stepEntry.status = "failed";
      stepEntry.error = "Successful skill step has no exact terminal output artifact ref";
      checkpoint.chain_status = "failed";
      saveChainCheckpoint(checkpoint, projectRoot, process.env);
      return {
        success: false,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "failed",
        requires_approval: false,
        steps_total: checkpoint.total_steps,
        agents_invoked: results.flatMap((item) => item.agents_invoked),
        errors: [stepEntry.error],
        mode: "chain",
        chain_step: stepIndex,
        chain_total: checkpoint.total_steps,
        chain_session_id: chainSessionId,
        chain_error_step: stepIndex,
        chain_results: results.slice(0, -1),
        resumable: true,
        output_artifact_ref: finalOutputRef,
      };
    }

    let handoffRef: ReturnType<typeof parseArtifactRef> | undefined;
    if (hasNextStep && terminalRef) {
      try {
        const nextStep = checkpoint.steps.find((candidate) => candidate.index === stepIndex + 1);
        if (!nextStep) {
          throw new ArtifactClientError(
            "ARTIFACT_CONTRACT_INVALID",
            `skill-chain checkpoint is missing target step ${stepIndex + 1}`
          );
        }
        handoffRef = await persistSkillChainHandoff({
          chainRunId: checkpoint.chain_run_id,
          completedStepIndex: stepIndex,
          targetRunId: nextStep.session_id,
          skillName: step.skill_name,
          terminalRef,
          projectRoot: path.resolve(cwd),
          env: process.env,
        });
      } catch (error) {
        const code = error instanceof ArtifactClientError ? error.code : "ARTIFACT_PERSIST_FAILED";
        stepEntry.status = "failed";
        stepEntry.output_artifact_ref = terminalRef;
        stepEntry.error = `Exact skill-chain handoff persistence failed (${code})`;
        checkpoint.chain_status = "failed";
        saveChainCheckpoint(checkpoint, projectRoot, process.env);
        return {
          success: false,
          session_id: chainSessionId,
          skill_name: "chain",
          state: "failed",
          requires_approval: false,
          steps_total: checkpoint.total_steps,
          agents_invoked: results.flatMap((item) => item.agents_invoked),
          errors: [stepEntry.error],
          mode: "chain",
          chain_step: stepIndex,
          chain_total: checkpoint.total_steps,
          chain_session_id: chainSessionId,
          chain_error_step: stepIndex,
          chain_results: results.slice(0, -1),
          resumable: true,
          output_artifact_ref: finalOutputRef,
        };
      }
    }

    stepEntry.status = "complete";
    stepEntry.result_preview = truncateForPrevious(getFinalOutputFromSkillResult(result));
    stepEntry.output_artifact_ref = terminalRef;
    stepEntry.handoff_artifact_ref = handoffRef;
    previousHandoffRef = handoffRef;
    checkpoint.pending_steps = checkpoint.pending_steps.filter(
      (pending) => pending.index !== stepIndex
    );
    saveChainCheckpoint(checkpoint, projectRoot, process.env);
  }

  checkpoint.chain_status = "complete";
  saveChainCheckpoint(checkpoint, projectRoot, process.env);
  return {
    success: true,
    session_id: chainSessionId,
    skill_name: "chain",
    state: "complete",
    requires_approval: false,
    steps_total: checkpoint.total_steps,
    agents_invoked: results.flatMap((result) => result.agents_invoked),
    errors: [],
    mode: "chain",
    chain_step: checkpoint.total_steps - 1,
    chain_total: checkpoint.total_steps,
    chain_session_id: chainSessionId,
    chain_results: results,
    output_artifact_ref: finalOutputRef,
  };
}
// ============================================================
// Extension Registration
// ============================================================

export interface SkillExtensionTestDependencies {
  /**
   * TEST-ONLY deterministic KB phase runner. The registered adapter still builds
   * the production KbWorkerClient, private readers, artifact store, worker
   * executor, and engine; this seam replaces only the live provider call.
   */
  readonly kbAgentRunner?: KbAgentRunner;
}

export default function skillExtension(
  pi: ExtensionAPI,
  testDependencies: SkillExtensionTestDependencies = {}
): void {
  config = {
    skillsDir:
      process.env.PENNY_SKILLS_DIR ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), ".pi", "skills"),
  };

  // Pi's standard `disable-model-invocation` field is a soft hide: keep those
  // skills executable for explicit `/skill:name` requests, but do not advertise
  // them through this model-facing tool description or the `/skills` listing.
  const skills = modelInvocableSkills(discoverSkills());

  let currentSessionId: string | undefined;
  /**
   * Exact provider/model of the ACTIVE parent context, as reported by the
   * runtime (§5.3 — never inferred from a model name). Captured at session
   * start and updated on model selection. `undefined` means the host cannot
   * establish the parent identity, which refuses parent delivery rather than
   * passing it.
   */
  let currentParentIdentity: { provider: string; model: string } | undefined;

  const captureParentIdentity = (model: unknown): void => {
    const provider = isRecord(model) && typeof model.provider === "string" ? model.provider : "";
    const id = isRecord(model) && typeof model.id === "string" ? model.id : "";
    currentParentIdentity =
      provider.length > 0 && id.length > 0 ? { provider, model: id } : undefined;
  };

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    setSessionId(sessionId);
    captureParentIdentity(ctx.model);
  });

  pi.on("model_select", async (event) => {
    captureParentIdentity(event.model);
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    const systemPrompt = alignNativeSkillInstruction(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  /** Successful terminal communication is valid only after an exact re-read. */
  const verifyTerminalArtifact = async (
    result: SkillResult,
    projectRoot: string
  ): Promise<SkillResult> => {
    const refs = [
      ...(result.output_artifact_ref ? [result.output_artifact_ref] : []),
      ...(result.parallel_results ?? []).flatMap((child) =>
        child.output_artifact_ref ? [child.output_artifact_ref] : []
      ),
      ...(result.chain_results ?? []).flatMap((child) =>
        child.output_artifact_ref ? [child.output_artifact_ref] : []
      ),
    ];
    if (result.success && refs.length === 0) {
      throw new ArtifactClientError(
        "ARTIFACT_PERSIST_FAILED",
        "successful skill result is missing its terminal output artifact"
      );
    }
    for (const ref of new Map(refs.map((value) => [value.artifact_id, value])).values()) {
      await readArtifactOutput({
        ref: ref as ArtifactRef,
        projectRoot,
        env: process.env,
      });
    }
    return result;
  };

  // ── knowledge_base tool (Phase 6 requirement, pre-G7 disabled state) ────────
  //
  // The agents-md-research plan (§4.5) requires the adapter to register BOTH the
  // existing `skill` tool AND a typed `knowledge_base` tool. Before G7 (stateful
  // KB implementation), `knowledge_base` must return a typed disabled/configuration
  // status rather than executing stateful work. This registration satisfies the
  // Phase 6 acceptance outcome without crossing the G6/G7 line.
  //
  // Registered BEFORE `skill` so the last-registered tool (which unit-test mocks
  // capture) remains `skill` — adding a tool must not break existing test fixtures.
  registerTool(pi, {
    name: "knowledge_base",
    label: "Knowledge Base",
    description: [
      "Private advisory knowledge-base workflows.",
      "Use when the operator explicitly asks to initialize, ingest approved sources, query, save, lint,",
      "inspect, resume, or prepare promotion for a configured KB profile.",
      "Do not use for canonical current-state lookup without verification, automatic",
      "research ingestion, arbitrary filesystem access, or unapproved canonical writes.",
    ].join(" "),
    parameters: KnowledgeBaseParameters,
    execute: async (
      toolCallId: string,
      typedParams: KnowledgeBaseParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      toolContext: ExtensionCommandContext
    ) => {
      const request = validateKnowledgeBaseRequest(typedParams);
      const rawParams = validatedKnowledgeBaseRequestFields(request);
      const action = request.action;
      const profileId = request.kb_profile_id;
      if (profileId.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                schema_version: 1,
                action,
                status: "refused",
                met: false,
                warnings: ["kb_profile_id is required"],
                next: "none",
              }),
            },
          ],
          details: { status: "refused", met: false, next: "none" },
        };
      }
      const runId = `kb-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const projectRoot = path.resolve(
        process.env.PROJECT_ROOT || toolContext?.cwd || process.cwd()
      );
      const orch = await import("@penny/orchestration/source");
      const hostSessionId = currentSessionId ?? "";
      const hostInvocationId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : `call-${randomUUID()}`;
      let resolvedProfile;
      let hostGrantRoot: string;
      try {
        const projectState = resolvePennyProjectState(projectRoot);
        hostGrantRoot = projectState.paths.knowledgeBase.hostGrants;
        resolvedProfile = orch.resolveGrantedProfile({
          profileId,
          sessionId: hostSessionId,
          registryPath: projectState.paths.knowledgeBase.profiles,
          grantStoreDir: hostGrantRoot,
        });
      } catch (error) {
        logger.warn("kb_profile_admission_refused", {
          errorCode: "KB_PROFILE_ADMISSION_REFUSED",
          reason: error instanceof Error ? error.name : "unknown",
        });
        const refused = {
          schema_version: 1,
          action,
          run_id: runId,
          status: "refused",
          met: false,
          ids: [],
          counts: {},
          artifacts: [],
          evidence: [],
          warnings: ["profile_not_authorized"],
          unresolved: [],
          next: "none",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(refused) }],
          details: refused,
        };
      }
      const kbRoot = resolvedProfile.resolvedRoot;
      let kbResult;
      let currentSelector: { generation_id: string } | undefined;
      let currentPolicy: ReturnType<typeof orch.readPolicy> | undefined;
      try {
        currentSelector = orch.readCurrent(kbRoot);
        currentPolicy = currentSelector === undefined ? undefined : orch.readPolicy(kbRoot);
        if (action === "init") {
          const create = rawParams["create"] === true;
          if (create && !resolvedProfile.profile.allow_create) {
            throw new Error("profile does not authorize KB creation");
          }
          if (create && typeof rawParams["title"] !== "string") {
            throw new Error("title is required when create is true");
          }
          if (!create && rawParams["title"] !== undefined) {
            throw new Error("title is forbidden when create is false");
          }
          if (!create && currentSelector === undefined) {
            throw new Error("KB is not initialized and create was not authorized");
          }
        } else if (currentSelector === undefined) {
          throw new Error("KB is not initialized for this profile");
        }
        if (currentSelector !== undefined && resolvedProfile.profile.expected_kb_id !== undefined) {
          const manifest = orch.readManifest(kbRoot);
          if (manifest.kb_id !== resolvedProfile.profile.expected_kb_id) {
            throw new Error("profile KB identity does not match the current manifest");
          }
        }
      } catch (error) {
        const refused = {
          schema_version: 1,
          action,
          run_id: runId,
          status: "refused",
          met: false,
          ids: [],
          counts: {},
          artifacts: [],
          evidence: [],
          warnings: ["profile_state_refused"],
          unresolved: [],
          next: "none",
        };
        logger.warn("kb_profile_state_refused", {
          errorCode: "KB_PROFILE_STATE_REFUSED",
          reason: error instanceof Error ? error.name : "unknown",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(refused) }],
          details: refused,
        };
      }
      // Bind this exact host invocation to the session/profile and the policy
      // observed before work. A create-init against an exact uninitialized root
      // binds `null`; an idempotent retry reuses that immutable original use.
      const profileGrantStore = new orch.KbSessionProfileGrantStore(hostGrantRoot);
      let allowedKbProfileIds: string[] = [];
      try {
        allowedKbProfileIds = [...profileGrantStore.allowedProfiles(hostSessionId)].sort();
        if (!allowedKbProfileIds.includes(profileId)) {
          throw new Error("requested profile is absent from the authenticated session authority");
        }
        const priorUse = profileGrantStore.useForInvocation(hostSessionId, hostInvocationId);
        const observedPolicySha256 =
          currentPolicy === undefined ? null : orch.sha256(orch.canonicalJson(currentPolicy));
        profileGrantStore.consume({
          session_id: hostSessionId,
          invocation_id: hostInvocationId,
          kb_profile_id: profileId,
          action,
          request_sha256: orch.sha256(orch.canonicalJson(request)),
          policy_sha256: priorUse?.policy_sha256 ?? observedPolicySha256,
        });
      } catch (error) {
        logger.warn("kb_profile_invocation_refused", {
          errorCode: "KB_PROFILE_INVOCATION_REFUSED",
          reason: error instanceof Error ? error.name : "unknown",
        });
        const refused = {
          schema_version: 1,
          action,
          run_id: runId,
          status: "refused",
          met: false,
          ids: [],
          counts: {},
          artifacts: [],
          evidence: [],
          warnings: ["profile_invocation_not_authorized"],
          unresolved: [],
          next: "none",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(refused) }],
          details: refused,
        };
      } finally {
        profileGrantStore.close();
      }

      // Every initialized-KB app dispatch receives one closed host context.
      // Its fields come only from the authenticated Pi session, the shared
      // profile/parent-grant SQLite authority, and the exact current validated
      // policy rule. The model request contributes no authority field.
      let hostContext: import("@penny/orchestration/source").KbHostInvocationContextV1 | undefined;
      if (currentPolicy !== undefined) {
        try {
          let parentDeliveryGrant;
          if (request.action === "query" && request.answer_delivery === "parent_tool_result") {
            try {
              parentDeliveryGrant = orch.loadParentDeliveryGrantForHostContext({
                storeDir: hostGrantRoot,
                sessionId: hostSessionId,
                invocationId: hostInvocationId,
                request,
              });
            } catch (error) {
              // A malformed/ambiguous delivery grant denies only derived parent
              // delivery. The safe artifact query still proceeds with a closed
              // context that carries no grant.
              logger.warn("kb_parent_grant_context_refused", {
                errorCode: "KB_PARENT_GRANT_CONTEXT_REFUSED",
                reason: error instanceof Error ? error.name : "unknown",
              });
            }
          }
          if (currentParentIdentity === undefined) {
            throw new Error("authenticated parent identity is unavailable");
          }
          hostContext = orch.buildKbHostInvocationContext({
            sessionId: hostSessionId,
            invocationId: hostInvocationId,
            parentIdentity: currentParentIdentity,
            currentPolicy,
            allowedProfileIds: allowedKbProfileIds,
            request,
            ...(parentDeliveryGrant === undefined ? {} : { parentDeliveryGrant }),
          });
        } catch (error) {
          logger.warn("kb_host_context_refused", {
            errorCode: "KB_HOST_CONTEXT_REFUSED",
            reason: error instanceof Error ? error.name : "unknown",
          });
          const refused = {
            schema_version: 1,
            action,
            run_id: runId,
            status: "refused",
            met: false,
            ids: [],
            counts: {},
            artifacts: [],
            evidence: [],
            warnings: ["host_context_not_authorized"],
            unresolved: [],
            next: "none",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(refused) }],
            details: refused,
          };
        }
      }
      const hostParentIdentity =
        hostContext === undefined
          ? currentParentIdentity
          : { provider: hostContext.parent_provider, model: hostContext.parent_model };
      const corruptTerminalQueryProjection = (
        projectedAction: "status" | "resume",
        requestedRunId: string
      ): ReplayableKnowledgeBaseResult =>
        orch.toReplayableKnowledgeBaseResult({
          schema_version: 1,
          action: projectedAction,
          run_id: requestedRunId,
          status: "error",
          met: false,
          ids: [requestedRunId],
          counts: {},
          artifacts: [],
          evidence: [],
          warnings: ["required_query_answer_corrupt"],
          unresolved: [],
          next: "none",
        });
      const projectRunForStatusOrResume = (input: {
        projectedAction: "status" | "resume";
        run: RunContext;
        checkpointer: Checkpointer;
      }): ReplayableKnowledgeBaseResult => {
        let projected: ReplayableKnowledgeBaseResult;
        try {
          const storedAction = input.run.playbookData.action;
          const durableAction =
            input.projectedAction === "resume"
              ? "resume"
              : isReplayOperationAction(storedAction)
                ? storedAction
                : "init";
          const replay = orch.replayableResultFromRun({
            action: durableAction,
            run: input.run,
            checkpointer: input.checkpointer,
          });
          projected =
            input.projectedAction === "status"
              ? orch.toReplayableKnowledgeBaseResult({ ...replay, action: "status" })
              : replay;
        } catch (error) {
          if (
            String(input.run.playbookData.action ?? "") === "query" &&
            input.run.terminalDirective !== null
          ) {
            return corruptTerminalQueryProjection(input.projectedAction, input.run.identity.run_id);
          }
          throw error;
        }
        if (
          String(input.run.playbookData.action ?? "") !== "query" ||
          projected.status !== "complete"
        ) {
          return projected;
        }
        try {
          if (
            projected.artifacts.length !== 1 ||
            projected.artifacts[0]?.artifact_kind !== "query_answer"
          ) {
            throw new Error("terminal query requires exactly one answer artifact");
          }
          const expected = projected.artifacts[0];
          const store = new orch.RunArtifactStore(
            kbRoot,
            input.run.identity.run_id,
            input.checkpointer
          );
          try {
            const checked = store.read(expected.artifact_id, {
              expected_state_id: "query",
              expected_profile_id: profileId,
              expected_handle: expected,
              required_lifecycle: "sealed",
            });
            if (checked.handle.artifact_kind !== "query_answer") {
              throw new Error("terminal query answer kind changed");
            }
            return orch.toReplayableKnowledgeBaseResult({
              ...projected,
              artifacts: [checked.handle],
            });
          } finally {
            store.close();
          }
        } catch {
          return corruptTerminalQueryProjection(input.projectedAction, input.run.identity.run_id);
        }
      };

      switch (action) {
        case "init": {
          const initRequest = {
            schema_version: 1 as const,
            action: "init" as const,
            kb_profile_id: profileId,
            create: rawParams["create"] === true,
            ...(typeof rawParams["title"] === "string" ? { title: rawParams["title"] } : {}),
          };
          const invocationId = hostInvocationId;
          const profileCommitmentSha256 = orch.normalizedProfileCommitment(resolvedProfile);
          const planned = {
            kb_id:
              resolvedProfile.profile.expected_kb_id ??
              `kb_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            generation_id: `gen_${randomUUID().replace(/-/g, "")}`,
            created_at: new Date().toISOString(),
          };
          const custody = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          try {
            const admissionContext = orch.RunContext.create({
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal: "Initialize or validate the admitted advisory KB profile.",
              constraints: {
                action: "init",
                kb_profile_id: profileId,
                create: initRequest.create,
              },
              projectRoot,
              trustProfile: "hardened-untrusted",
              maxSteps: custody.config.maxSteps,
            });
            admissionContext.playbookData.action = "init";
            admissionContext.playbookData.profile_id = profileId;
            admissionContext.playbookData.planned_kb_id = planned.kb_id;
            admissionContext.playbookData.planned_generation_id = planned.generation_id;
            admissionContext.playbookData.planned_created_at = planned.created_at;
            admissionContext.playbookData.init_profile_commitment_sha256 = profileCommitmentSha256;
            admissionContext.playbookData.planned_base_generation_id =
              currentSelector?.generation_id ?? "";
            const admitted = orch.admitOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              context: admissionContext,
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "init",
              profile_id: profileId,
              request: initRequest,
            });
            if (admitted.replay !== undefined) {
              kbResult = admitted.replay.replay_result;
              break;
            }
            let result: unknown = admitted.recovered_result;
            const durable = custody.checkpointer.loadRunById(admitted.run_id);
            if (durable === undefined) throw new Error("admitted init run is absent");
            const admittedProfileCommitment = String(
              durable.playbookData.init_profile_commitment_sha256 ?? ""
            );
            if (admittedProfileCommitment !== profileCommitmentSha256) {
              throw new Error("profile_remapped");
            }
            const durablePlanned = {
              kb_id: String(durable.playbookData.planned_kb_id ?? planned.kb_id),
              generation_id: String(
                durable.playbookData.planned_generation_id ?? planned.generation_id
              ),
              created_at: String(durable.playbookData.planned_created_at ?? planned.created_at),
              transaction_id: admitted.transaction_id,
              checkpointer: custody.checkpointer,
              request_sha256: admitted.request_sha256,
              profile_commitment_sha256: profileCommitmentSha256,
            };
            const plannedBaseGenerationId = String(
              durable.playbookData.planned_base_generation_id ?? ""
            );
            if (result === undefined) {
              result = orch.initKb(
                { kbRoot, profileId, runId: admitted.run_id },
                initRequest.title ?? "Advisory KB",
                durablePlanned
              );
            }
            const manifest = orch.readManifest(kbRoot);
            const policySha = orch.sha256(orch.canonicalJson(orch.readPolicy(kbRoot)));
            const afterSelector = orch.readCurrent(kbRoot);
            const replay = orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: admitted.run_id,
              result,
              kb_id: manifest.kb_id,
              policy_sha256: policySha,
            });
            const published =
              plannedBaseGenerationId.length === 0 &&
              afterSelector?.generation_id === durablePlanned.generation_id;
            const publicationEvidence = published
              ? custody.checkpointer.kbPublicationSelectorEvidence({
                  transaction_id: admitted.transaction_id,
                  run_id: admitted.run_id,
                  candidate_generation_id: durablePlanned.generation_id,
                })
              : undefined;
            kbResult = orch.completeOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              group_id: admitted.group.request_event_group_id,
              profile_id: profileId,
              result: replay,
              input_digests: [admitted.request_sha256],
              kb_id: manifest.kb_id,
              ...(published ? { candidate_generation_id: durablePlanned.generation_id } : {}),
              policy_sha256: policySha,
              safe_metrics: replay.counts,
              ...(publicationEvidence?.selector_sha256 !== undefined
                ? {
                    selector_evidence: {
                      transaction_id: admitted.transaction_id,
                      candidate_generation_id: durablePlanned.generation_id,
                      selector_sha256: publicationEvidence.selector_sha256,
                    },
                  }
                : {}),
            }).replay_result;
          } catch (error) {
            if (error instanceof orch.StartAdmissionMismatchError) {
              kbResult = {
                schema_version: 1,
                action: "init",
                run_id: runId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["idempotency_mismatch"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            const sourceIdentity = orch.externalOperationSourceIdentity({
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "init",
              request_sha256: orch.sha256(orch.canonicalJson(initRequest)),
            });
            const group = custody.checkpointer.operationEventGroupBySource(
              "external_start",
              sourceIdentity
            );
            if (group === undefined) throw error;
            const failed = {
              schema_version: 1,
              action: "init",
              run_id: group.run_id,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["init_run_failed"],
              unresolved: [],
              next: "none",
            };
            orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: group.run_id,
              result: failed,
            });
            kbResult = orch.completeOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              group_id: group.request_event_group_id,
              profile_id: profileId,
              result: failed,
              input_digests: [orch.sha256(orch.canonicalJson(initRequest))],
            }).replay_result;
          } finally {
            custody.close();
          }
          break;
        }
        case "query": {
          // §5.6 — the ENGINE-OWNED deterministic start action:
          //
          //   closed request validation (host)
          //   → ONE control-DB transaction: durable run row + idempotency
          //     record + `preparing` private-input index (exact host-allocated
          //     keys) — before any byte is written
          //   → owner-only temp/fsync/rename of the request bytes → CAS active
          //   → the engine binds deterministic retrieval to one generation;
          //     explicit verify_grounding:false seals an unverified answer with
          //     no claim, while default true runs Synthia → Vera through
          //     host-closed request/page/source readers and creates a claim only
          //     after the host validates every citation and the passing report
          //   → terminal checkpoint → the host settles the idempotency record
          //     with the replay result digest and discards the exact indexed
          //     bytes (metadata survives, the body does not).
          //
          // The query text therefore enters no control row, event, prompt, or
          // public result; the run id is status-addressable through the shared
          // checkpointer — the same single authoritative run store.
          let request;
          try {
            request = orch.validateQueryRequest({
              schema_version: 1,
              action: "query",
              kb_profile_id: profileId,
              query: String(rawParams["query"] ?? ""),
              ...(rawParams["page_ids"] !== undefined ? { page_ids: rawParams["page_ids"] } : {}),
              ...(rawParams["source_ids"] !== undefined
                ? { source_ids: rawParams["source_ids"] }
                : {}),
              ...(rawParams["max_candidates"] !== undefined
                ? { max_candidates: rawParams["max_candidates"] }
                : {}),
              ...(rawParams["verify_grounding"] !== undefined
                ? { verify_grounding: rawParams["verify_grounding"] }
                : {}),
              ...(rawParams["answer_delivery"] !== undefined
                ? { answer_delivery: rawParams["answer_delivery"] }
                : {}),
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["query_request_invalid"],
              unresolved: [],
              next: "none",
            };
            break;
          }

          // Policy refusal is a pre-admission outcome: no run, operation
          // group, receipt, or private-input row is created for it.
          try {
            orch.admitKbRun({ kbRoot, parentIdentity: hostParentIdentity });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["query_admission_refused"],
              unresolved: [],
              next: "none",
            };
            break;
          }

          // Host-issued idempotency identity — never from model or caller
          // fields. The tool call id IS the host invocation identity: a
          // replayed call with the same digest gets the original run back, a
          // mutated body is `idempotency_mismatch`, and a fresh call is a
          // fresh invocation.
          const invocationId = hostInvocationId;
          const transactionId = `tx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const requestSha = orch.computeRequestSha256(request);
          const queryGoal =
            "Answer the stored private request from the selected generation. " +
            "Advisory only; no publication.";
          const queryConstraints: Record<string, JsonValue> = {
            action: "query",
            kb_profile_id: profileId,
            // §5.3: derived from the one validated private host context.
            parent_identity: hostParentIdentity ?? null,
          };
          let queryRunId = runId;
          let queryOperationGroupId: string | undefined;
          let queryInvocationReplay = false;
          const querySourceIdentity = orch.externalOperationSourceIdentity({
            session_id: hostSessionId,
            invocation_id: invocationId,
            action: "query",
            request_sha256: requestSha,
          });
          const custodyService = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          let executionService: InstanceType<typeof orch.OrchestrationService> | undefined;
          let queryWorker: InstanceType<typeof orch.KbWorkerClient> | undefined;
          const settleFailedQuery = (failureRunId: string, warningCode: string): void => {
            const failed = custodyService.checkpointer.loadRunById(failureRunId);
            if (failed === undefined || failed.terminalDirective !== null) return;
            failed.status = "error";
            failed.previousState = failed.stateId;
            failed.stateId = "query_failed";
            failed.met = false;
            failed.playbookData.action = "query";
            failed.playbookData.profile_id = profileId;
            failed.playbookData.public_status = "refused";
            failed.playbookData.warnings = [warningCode];
            const result = {
              action: "query",
              public_status: "refused",
              met: false,
              warnings: [warningCode],
              unresolved_issues: [],
            };
            failed.terminalDirective = orch.validateDirective({
              schema_version: 2,
              action: "error",
              identity: failed.identity,
              status: "error",
              met: false,
              result,
              artifacts: [],
              unresolved: [],
            });
            custodyService.checkpointer.saveRun(failed, "query_start_failed", {
              run_id: failureRunId,
              warning_code: warningCode,
            });
            // Operation-receipt finalization below atomically binds the exact
            // public replay + receipt before private-input cleanup. Settling the
            // admission here would bind a different internal directive result.
          };
          try {
            // Index FIRST: the durable run row, the idempotency record, and
            // the `preparing` private-input index commit together, before any
            // byte of the request touches disk.
            const admissionContext = orch.RunContext.create({
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal: queryGoal,
              constraints: queryConstraints,
              projectRoot,
              trustProfile: "hardened-untrusted",
              maxSteps: custodyService.config.maxSteps,
            });
            admissionContext.playbookData.action = "query";
            admissionContext.playbookData.profile_id = profileId;
            const admission = custodyService.checkpointer.admitStartRun(admissionContext, {
              session_id: hostSessionId,
              invocation_id: invocationId,
              request_sha256: requestSha,
              action: "query",
              profile_id: profileId,
              transaction_id: transactionId,
              private_input_id: `pri_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
              // Exact §5.6 keys under the trusted input root.
              storage_key: `${runId}/request.json`,
              temporary_storage_key: `${runId}/.${transactionId}.tmp`,
            });
            queryRunId = admission.kind === "created" ? runId : admission.run_id;
            queryInvocationReplay = admission.kind === "replay";
            const operationGroup = custodyService.checkpointer.operationEventGroupBySource(
              "external_start",
              querySourceIdentity
            );
            if (operationGroup === undefined || operationGroup.run_id !== queryRunId) {
              throw new Error("query admission lost its operation event group");
            }
            queryOperationGroupId = operationGroup.request_event_group_id;
            const admittedRun = custodyService.checkpointer.loadRunById(queryRunId);
            const terminalReplay = admittedRun?.terminalDirective != null;
            // Byte lifecycle: exact temp (0600, no-follow) → fsync → rename
            // → fsync parent → CAS `preparing → active`. A terminal replay has
            // already discarded its private bytes and must never rematerialize
            // them; an unfinished replay resumes from its indexed lifecycle.
            if (!terminalReplay) {
              orch.materializeRunInput({
                projectRoot,
                checkpointer: custodyService.checkpointer,
                runId: queryRunId,
                request,
                requestSha256: requestSha,
              });
            }
            const queryReader = new orch.KbQueryReader({
              kbRoot,
              profileId,
              readRequest: () =>
                orch.readRunInput({
                  projectRoot,
                  checkpointer: custodyService.checkpointer,
                  runId: queryRunId,
                }),
              selectedGenerationId: () =>
                String(
                  executionService?.checkpointer.loadRunById(queryRunId)?.playbookData
                    .selected_generation_id ?? ""
                ),
            });
            queryWorker = new orch.KbWorkerClient({
              projectRoot,
              kbRoot,
              runId: queryRunId,
              sessionId: hostSessionId,
              profileId,
              operation: "query",
              sourceCapabilityIds: [],
              admittedPolicySha256: () =>
                String(
                  executionService?.checkpointer.loadRunById(queryRunId)?.playbookData
                    .admitted_policy_sha256 ?? ""
                ),
              queryReader,
              ...(testDependencies.kbAgentRunner
                ? { testOnlyAgentRunner: testDependencies.kbAgentRunner }
                : {}),
            });
            executionService = new orch.OrchestrationService({
              projectRoot,
              env: process.env,
              playbookName: "knowledge-base",
              modelClient: queryWorker,
            });
            const directive = await executionService.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: queryRunId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal: queryGoal,
              constraints: queryConstraints,
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (
              directive.action === "complete" ||
              directive.action === "incomplete" ||
              directive.action === "cancelled"
            ) {
              const terminal: unknown = directive;
              const terminalRecord = isRecord(terminal) ? terminal : {};
              const result = isRecord(terminalRecord.result) ? terminalRecord.result : {};
              // The exact PUBLIC replay is bound with the receipt in the
              // operation-plane finalizer below; private bytes are discarded
              // only after that atomic control commit.
              const met = terminalRecord.met === true;
              const pageIds = stringArrayOrEmpty(result["query_page_ids"], "query_page_ids");
              const handle = isKnowledgeBaseArtifactHandle(result["answer_handle"])
                ? result["answer_handle"]
                : undefined;
              const answerArtifactId = String(result["answer_artifact_id"] ?? "");
              kbResult = {
                schema_version: 1,
                action: "query",
                run_id: queryRunId,
                // §5.6 result matrix: `met` → `complete`; an unmet run is the
                // public status the terminal projection recorded (refused for
                // an unadmissible state, `complete` with `met:false` for a
                // finished query with no supported answer).
                status: met
                  ? "complete"
                  : String(result["public_status"] === "refused" ? "refused" : "complete"),
                met,
                ids: [
                  queryRunId,
                  ...pageIds,
                  ...(answerArtifactId.length > 0 ? [answerArtifactId] : []),
                ],
                counts: { candidates: Number(result["candidate_count"] ?? 0) },
                artifacts: handle ? [handle] : [],
                evidence: [],
                warnings: stringArrayOrEmpty(result["warnings"], "warnings"),
                unresolved: stringArrayOrEmpty(result["unresolved_issues"], "unresolved_issues"),
                next: "none",
              };
            } else {
              // Not terminal: honest nonterminal projection (durable run, no
              // fabricated success).
              kbResult = {
                schema_version: 1,
                action: "query",
                run_id: queryRunId,
                status: "running",
                met: false,
                ids: [queryRunId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["query run is not yet terminal; status it by run id"],
                unresolved: [],
                next: "resume",
              };
            }
          } catch (err) {
            if (err instanceof orch.StartAdmissionMismatchError) {
              logger.warn("kb_query_idempotency_mismatch", {
                errorCode: "KB_QUERY_IDEMPOTENCY_MISMATCH",
                reason: err.message.slice(0, 200),
              });
              kbResult = {
                schema_version: 1,
                action: "query",
                run_id: runId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["idempotency_mismatch"],
                unresolved: [],
                next: "none",
              };
            } else if (err instanceof orch.PolicyRefusal || err instanceof orch.PrivateInputError) {
              settleFailedQuery(queryRunId, err.code);
              logger.warn("kb_query_start_refused", {
                errorCode: "KB_QUERY_START_REFUSED",
                reason: err.code,
              });
              kbResult = {
                schema_version: 1,
                action: "query",
                run_id: queryRunId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: [`query refused: ${err.code}`],
                unresolved: [],
                next: "none",
              };
            } else {
              settleFailedQuery(queryRunId, "query_start_failed");
              logger.warn("kb_query_start_failed", {
                errorCode: "KB_QUERY_START_FAILED",
                reason: err instanceof Error ? err.name : "error",
              });
              kbResult = {
                schema_version: 1,
                action: "query",
                run_id: queryRunId,
                status: "error",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["query_run_failed"],
                unresolved: [],
                next: "none",
              };
            }
          } finally {
            try {
              if (queryOperationGroupId !== undefined && kbResult !== undefined) {
                const durable = custodyService.checkpointer.loadRunById(queryRunId);
                const kbId = String(durable?.playbookData.kb_id ?? "");
                const policySha = String(durable?.playbookData.admitted_policy_sha256 ?? "");
                const completion = new orch.OperationReceiptStore({
                  projectRoot,
                  checkpointer: custodyService.checkpointer,
                }).complete({
                  request_event_group_id: queryOperationGroupId,
                  kb_profile_id: profileId,
                  result: kbResult,
                  input_digests: [requestSha],
                  ...(kbId.length > 0 ? { kb_id: kbId } : {}),
                  ...(policySha.length > 0 ? { policy_sha256: policySha } : {}),
                  safe_metrics: kbResult.counts ?? {},
                });
                kbResult = completion.replay_result;
                if (kbResult.status !== "running" && kbResult.status !== "awaiting_user") {
                  orch.settleRunInput({
                    projectRoot,
                    checkpointer: custodyService.checkpointer,
                    runId: queryRunId,
                  });
                }
              }
            } finally {
              executionService?.close();
              queryWorker?.close();
              custodyService.close();
            }
          }
          // Parent delivery — the only path where a parent may see derived
          // content: request + policy + exactly one unconsumed exact grant.
          // The grant is atomically consumed by the delivered run; on any miss
          // the artifact result is retained and the single public code is
          // warned.
          const delivery = request.answer_delivery ?? ("artifact_ref" as const);
          if (
            !queryInvocationReplay &&
            delivery === "parent_tool_result" &&
            kbResult.status === "complete" &&
            kbResult.met === true &&
            Array.isArray(kbResult.artifacts) &&
            kbResult.artifacts.length > 0
          ) {
            const answerHandle = kbResult.artifacts[0] as { artifact_id: string };
            // The execution/custody services above are deliberately closed before
            // parent delivery. Reopen one bounded owner handle rather than reading
            // the artifact index through a closed Checkpointer.
            const deliveryCustody = new orch.OrchestrationService({
              projectRoot,
              env: process.env,
              playbookName: "knowledge-base",
            });
            let answer;
            let verificationReport;
            try {
              answer = orch.readSealedAnswer(
                kbRoot,
                queryRunId,
                answerHandle,
                deliveryCustody.checkpointer
              );
              verificationReport = orch.readSealedQueryVerification(
                kbRoot,
                queryRunId,
                answerHandle,
                deliveryCustody.checkpointer
              );
            } finally {
              deliveryCustody.close();
            }
            let policy: ReturnType<typeof orch.readPolicy> | undefined;
            try {
              policy = orch.readPolicy(kbRoot);
            } catch {
              policy = undefined;
            }
            if (answer === null || policy === undefined) {
              // Fail closed: never deliver unvalidated content, and never under an unreadable policy.
              kbResult = {
                ...kbResult,
                warnings: [...(kbResult.warnings ?? []), "refused_parent_delivery"],
              };
              break;
            }
            const decision = orch.decideParentDelivery({
              storeDir: hostGrantRoot,
              ...(hostContext === undefined ? {} : { hostContext }),
              request,
              policy,
              runId: queryRunId,
              answer,
              answerHandle,
              verificationReport,
              queryCompleteAndMet: kbResult.status === "complete" && kbResult.met === true,
            });
            if (decision.outcome === "delivered") {
              kbResult = { ...kbResult, derived_answer: decision.derived_answer };
            } else {
              logger.warn("kb_parent_delivery_refused", {
                errorCode: "KB_PARENT_DELIVERY_REFUSED",
                reason: decision.reason_code,
              });
              kbResult = {
                ...kbResult,
                warnings: [...(kbResult.warnings ?? []), "refused_parent_delivery"],
              };
            }
          }
          break;
        }
        case "lint": {
          let lintAdmission: ReturnType<typeof orch.admitKbRun>;
          try {
            lintAdmission = orch.admitKbRun({
              kbRoot,
              parentIdentity: hostParentIdentity,
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action: "lint",
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["lint_admission_refused"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          const lintRequest = {
            schema_version: 1 as const,
            action: "lint" as const,
            kb_profile_id: profileId,
            mode: rawParams["mode"],
            ...(rawParams["page_ids"] !== undefined ? { page_ids: rawParams["page_ids"] } : {}),
          };
          const invocationId = hostInvocationId;
          const custody = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          try {
            const admissionContext = orch.RunContext.create({
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal: "Lint the selected advisory KB generation without publication.",
              constraints: { action: "lint", kb_profile_id: profileId },
              projectRoot,
              trustProfile: "hardened-untrusted",
              maxSteps: custody.config.maxSteps,
            });
            admissionContext.playbookData.action = "lint";
            admissionContext.playbookData.profile_id = profileId;
            admissionContext.playbookData.kb_id = lintAdmission.kb_id;
            admissionContext.playbookData.admitted_policy_sha256 = lintAdmission.policy_sha256;
            const admitted = orch.admitOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              context: admissionContext,
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "lint",
              profile_id: profileId,
              request: lintRequest,
            });
            if (admitted.replay !== undefined) {
              kbResult = admitted.replay.replay_result;
              break;
            }
            const result =
              admitted.recovered_result ??
              orch.lintKb({
                kbRoot,
                profileId,
                runId: admitted.run_id,
                checkpointer: custody.checkpointer,
              });
            const replay = orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: admitted.run_id,
              result,
              kb_id: lintAdmission.kb_id,
              policy_sha256: lintAdmission.policy_sha256,
            });
            kbResult = orch.completeOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              group_id: admitted.group.request_event_group_id,
              profile_id: profileId,
              result: replay,
              input_digests: [admitted.request_sha256],
              kb_id: lintAdmission.kb_id,
              policy_sha256: lintAdmission.policy_sha256,
              safe_metrics: replay.counts,
            }).replay_result;
          } catch (error) {
            if (error instanceof orch.StartAdmissionMismatchError) {
              kbResult = {
                schema_version: 1,
                action: "lint",
                run_id: runId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["idempotency_mismatch"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            const sourceIdentity = orch.externalOperationSourceIdentity({
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "lint",
              request_sha256: orch.sha256(orch.canonicalJson(lintRequest)),
            });
            const group = custody.checkpointer.operationEventGroupBySource(
              "external_start",
              sourceIdentity
            );
            if (group === undefined) throw error;
            const failed = {
              schema_version: 1,
              action: "lint",
              run_id: group.run_id,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["lint_run_failed"],
              unresolved: [],
              next: "none",
            };
            orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: group.run_id,
              result: failed,
              kb_id: lintAdmission.kb_id,
              policy_sha256: lintAdmission.policy_sha256,
            });
            kbResult = orch.completeOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              group_id: group.request_event_group_id,
              profile_id: profileId,
              result: failed,
              input_digests: [orch.sha256(orch.canonicalJson(lintRequest))],
              kb_id: lintAdmission.kb_id,
              policy_sha256: lintAdmission.policy_sha256,
            }).replay_result;
          } finally {
            custody.close();
          }
          break;
        }
        case "ingest": {
          const capIds = Array.isArray(rawParams["source_capability_ids"])
            ? (rawParams["source_capability_ids"] as unknown[])
                .map((value) => String(value))
                .filter((value) => value.length > 0)
            : [];
          if (capIds.length === 0) {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["ingest_request_invalid"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          let ingestAdmission: ReturnType<typeof orch.admitKbRun>;
          try {
            ingestAdmission = orch.admitKbRun({
              kbRoot,
              parentIdentity: hostParentIdentity,
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["ingest_admission_refused"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          const ingestRequest = {
            schema_version: 1 as const,
            action: "ingest" as const,
            kb_profile_id: profileId,
            source_capability_ids: capIds,
          };
          const invocationId = hostInvocationId;
          const goal = "Ingest the admitted source capabilities and prepare human content review.";
          const custody = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          let service: InstanceType<typeof orch.OrchestrationService> | undefined;
          let admitted: ReturnType<typeof orch.admitOperationStart> | undefined;
          try {
            const admissionContext = orch.RunContext.create({
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal,
              constraints: {
                action: "ingest",
                kb_profile_id: profileId,
                source_capability_ids: capIds,
                parent_identity: hostParentIdentity ?? null,
              },
              projectRoot,
              trustProfile: "hardened-untrusted",
              maxSteps: custody.config.maxSteps,
            });
            admissionContext.playbookData.action = "ingest";
            admissionContext.playbookData.profile_id = profileId;
            admissionContext.playbookData.kb_id = ingestAdmission.kb_id;
            admissionContext.playbookData.admitted_policy_sha256 = ingestAdmission.policy_sha256;
            admitted = orch.admitOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              context: admissionContext,
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "ingest",
              profile_id: profileId,
              request: ingestRequest,
            });
            if (admitted.replay !== undefined) {
              kbResult = admitted.replay.replay_result;
              break;
            }
            if (admitted.recovered_result !== undefined) {
              kbResult = admitted.recovered_result;
              break;
            }
            const ingestRunId = admitted.run_id;
            service = new orch.OrchestrationService({
              projectRoot,
              env: process.env,
              playbookName: "knowledge-base",
              modelClient: new orch.KbWorkerClient({
                projectRoot,
                kbRoot,
                runId: ingestRunId,
                sessionId: hostSessionId,
                profileId,
                operation: "ingest",
                sourceCapabilityIds: capIds,
                admittedPolicySha256: ingestAdmission.policy_sha256,
                ...(testDependencies.kbAgentRunner
                  ? { testOnlyAgentRunner: testDependencies.kbAgentRunner }
                  : {}),
              }),
            });
            const directive = await service.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: ingestRunId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal,
              constraints: {
                action: "ingest",
                kb_profile_id: profileId,
                source_capability_ids: capIds,
                parent_identity: hostParentIdentity ?? null,
              },
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (
              directive.action === "complete" ||
              directive.action === "incomplete" ||
              directive.action === "cancelled" ||
              directive.action === "error"
            ) {
              const durable = service.checkpointer.loadRunById(ingestRunId);
              if (durable === undefined) throw new Error("admitted ingest run is absent");
              kbResult = orch.replayableResultFromRun({ action: "ingest", run: durable });
            } else {
              const durable = service.checkpointer.loadRunById(ingestRunId);
              if (durable === undefined) throw new Error("admitted ingest run is absent");
              kbResult = orch.replayableResultFromRun({
                action: "ingest",
                run: durable,
                checkpointer: service.checkpointer,
                status_override: "awaiting_user",
              });
            }
          } catch (error) {
            if (error instanceof orch.StartAdmissionMismatchError) {
              kbResult = {
                schema_version: 1,
                action: "ingest",
                run_id: runId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["idempotency_mismatch"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            if (admitted === undefined) {
              const requestSha256 = orch.sha256(orch.canonicalJson(ingestRequest));
              const sourceIdentity = orch.externalOperationSourceIdentity({
                session_id: hostSessionId,
                invocation_id: invocationId,
                action: "ingest",
                request_sha256: requestSha256,
              });
              const group = custody.checkpointer.operationEventGroupBySource(
                "external_start",
                sourceIdentity
              );
              if (group === undefined) throw error;
              admitted = {
                run_id: group.run_id,
                request_sha256: requestSha256,
                transaction_id: group.transaction_id,
                group,
              };
            }
            try {
              orch.invalidateCapabilities(kbRoot, capIds);
            } catch {
              // best effort; capability claims also expire
            }
            kbResult = orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: admitted.run_id,
              kb_id: ingestAdmission.kb_id,
              policy_sha256: ingestAdmission.policy_sha256,
              result: {
                schema_version: 1,
                action: "ingest",
                run_id: admitted.run_id,
                status: "error",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["ingest_run_failed"],
                unresolved: [],
                next: "none",
              },
            });
          } finally {
            try {
              if (admitted !== undefined && kbResult !== undefined) {
                kbResult = orch.completeOperationStart({
                  projectRoot,
                  checkpointer: custody.checkpointer,
                  group_id: admitted.group.request_event_group_id,
                  profile_id: profileId,
                  result: kbResult,
                  input_digests: [admitted.request_sha256],
                  kb_id: ingestAdmission.kb_id,
                  policy_sha256: ingestAdmission.policy_sha256,
                  safe_metrics: kbResult.counts ?? {},
                }).replay_result;
              }
            } finally {
              service?.close();
              custody.close();
            }
          }
          break;
        }
        case "resume": {
          const requestedRunId = String(rawParams["run_id"] ?? "");
          const resumeCustody = new OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          let executionService: InstanceType<typeof orch.OrchestrationService> | undefined;
          let resumeWorker: InstanceType<typeof orch.KbWorkerClient> | undefined;
          let resumeOperationGroupId: string | undefined;
          const resumeRequestSha = orch.sha256(
            orch.canonicalJson({
              schema_version: 1,
              action: "resume",
              kb_profile_id: profileId,
              run_id: requestedRunId,
            })
          );
          const projectResumeResult = (
            durable: NonNullable<ReturnType<typeof resumeCustody.checkpointer.loadRunById>>
          ): ReplayableKnowledgeBaseResult => {
            let projected = projectRunForStatusOrResume({
              projectedAction: "resume",
              run: durable,
              checkpointer: resumeCustody.checkpointer,
            });
            if (projected.status === "awaiting_user") {
              const pending = orch.findGateForRun(kbRoot, requestedRunId);
              projected = orch.toReplayableKnowledgeBaseResult({
                ...projected,
                counts: {
                  ...projected.counts,
                  ...(pending === undefined ? {} : { artifacts: pending.artifacts.length }),
                },
                artifacts: pending?.artifacts ?? [],
                warnings: [...projected.warnings, "review_pending"],
              });
            }
            return projected;
          };
          try {
            const candidate = resumeCustody.checkpointer.loadRunById(requestedRunId);
            let run;
            try {
              run = orch.requireKbRunAccess(candidate, {
                runId: requestedRunId,
                sessionId: hostSessionId,
                profileId,
              });
              orch.requireKbRunIdentityCurrent(run, kbRoot);
            } catch (error) {
              if (!(error instanceof orch.KbRunAccessError)) throw error;
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["run_not_available_for_session_profile"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            try {
              orch.requireKbCurrentParent(kbRoot, hostParentIdentity);
              orch.requireKbRunPolicyCurrent(run, kbRoot);
            } catch (error) {
              if (!(error instanceof orch.PolicyRefusal)) throw error;
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: [error.code],
                unresolved: [],
                next: "none",
              };
              break;
            }
            const resumeInvocationId =
              typeof toolCallId === "string" && toolCallId.length > 0
                ? toolCallId
                : `call-${randomUUID()}`;
            const resumeSourceIdentity = orch.externalOperationSourceIdentity({
              session_id: hostSessionId,
              invocation_id: resumeInvocationId,
              action: "resume",
              request_sha256: resumeRequestSha,
            });
            const operationStore = new orch.OperationReceiptStore({
              projectRoot,
              checkpointer: resumeCustody.checkpointer,
            });
            const resumeGroup = operationStore.reserve({
              run_id: requestedRunId,
              session_id: hostSessionId,
              transaction_id: `tx_resume_${resumeSourceIdentity.slice(0, 24)}`,
              action: "resume",
              source_kind: "external_resume",
              source_identity_sha256: resumeSourceIdentity,
            }).group;
            resumeOperationGroupId = resumeGroup.request_event_group_id;
            if (resumeGroup.state === "committed") {
              kbResult = operationStore.finish(resumeGroup.request_event_group_id).replay_result;
              break;
            }

            let durable = run;
            if (run.status === "running") {
              resumeWorker = orch.createKbWorkerClientForResume({
                projectRoot,
                kbRoot,
                checkpointer: resumeCustody.checkpointer,
                run,
                ...(testDependencies.kbAgentRunner
                  ? { testOnlyAgentRunner: testDependencies.kbAgentRunner }
                  : {}),
              });
              executionService = new orch.OrchestrationService({
                projectRoot,
                env: process.env,
                playbookName: "knowledge-base",
                modelClient: resumeWorker,
              });
              await executionService.execute(
                {
                  schema_version: 2,
                  action: "recover",
                  identity: run.identity,
                },
                _signal
              );
              const recovered = executionService.checkpointer.loadRunById(requestedRunId);
              durable = orch.requireKbRunAccess(recovered, {
                runId: requestedRunId,
                sessionId: hostSessionId,
                profileId,
              });
              orch.requireKbRunIdentityCurrent(durable, kbRoot);
              orch.requireKbRunPolicyCurrent(durable, kbRoot);
            }

            if (["complete", "incomplete", "cancelled", "error"].includes(durable.status)) {
              orch.verifyAndSettleTerminalStart({
                projectRoot,
                checkpointer: resumeCustody.checkpointer,
                run: durable,
              });
            }
            kbResult = projectResumeResult(durable);
          } catch (error) {
            if (resumeOperationGroupId === undefined) throw error;
            const refused =
              error instanceof orch.KbRunAccessError ||
              error instanceof orch.PolicyRefusal ||
              error instanceof orch.PrivateInputError;
            const warning =
              error instanceof orch.KbRunAccessError
                ? error.code
                : error instanceof orch.PolicyRefusal
                  ? error.code
                  : error instanceof orch.PrivateInputError
                    ? "terminal_result_digest_mismatch"
                    : error instanceof orch.KbWorkerPostureError
                      ? error.code
                      : "resume_run_failed";
            kbResult = {
              schema_version: 1,
              action: "resume",
              run_id: requestedRunId,
              status: refused ? "refused" : "error",
              met: false,
              ids: [requestedRunId],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: [warning],
              unresolved: [],
              next: "none",
            };
          } finally {
            try {
              if (resumeOperationGroupId !== undefined && kbResult !== undefined) {
                const durable = resumeCustody.checkpointer.loadRunById(requestedRunId);
                const completion = new orch.OperationReceiptStore({
                  projectRoot,
                  checkpointer: resumeCustody.checkpointer,
                }).complete({
                  request_event_group_id: resumeOperationGroupId,
                  kb_profile_id: profileId,
                  result: kbResult,
                  input_digests: [resumeRequestSha],
                  ...(String(durable?.playbookData.kb_id ?? "").length > 0
                    ? { kb_id: String(durable?.playbookData.kb_id) }
                    : {}),
                  ...(String(durable?.playbookData.admitted_policy_sha256 ?? "").length > 0
                    ? {
                        policy_sha256: String(durable?.playbookData.admitted_policy_sha256),
                      }
                    : {}),
                  safe_metrics: kbResult.counts ?? {},
                });
                kbResult = completion.replay_result;
              }
            } finally {
              executionService?.close();
              resumeWorker?.close();
              resumeCustody.close();
            }
          }
          break;
        }
        case "save": {
          let saveRequest;
          try {
            saveRequest = orch.validateSaveRequest({
              schema_version: 1,
              action: "save",
              kb_profile_id: profileId,
              query_run_id: String(rawParams["query_run_id"] ?? ""),
              page_kind: String(rawParams["page_kind"] ?? "synthesis"),
              title: String(rawParams["title"] ?? ""),
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["save_request_invalid"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          let saveAdmission: ReturnType<typeof orch.admitKbRun>;
          try {
            saveAdmission = orch.admitKbRun({
              kbRoot,
              parentIdentity: hostParentIdentity,
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["save_admission_refused"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          const claim = orch.findSaveClaim(projectRoot, profileId, saveRequest.query_run_id);
          if (claim === undefined) {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["save_claim_unavailable"],
              unresolved: [],
              next: "none",
            };
            break;
          }
          const invocationId = hostInvocationId;
          const goal = "Compose the claimed query answer into a reviewable advisory page.";
          const custody = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
          });
          let service: InstanceType<typeof orch.OrchestrationService> | undefined;
          let admitted: ReturnType<typeof orch.admitOperationStart> | undefined;
          try {
            const admissionContext = orch.RunContext.create({
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal,
              constraints: {
                action: "save",
                kb_profile_id: profileId,
                query_run_id: saveRequest.query_run_id,
                page_kind: saveRequest.page_kind,
                parent_identity: hostParentIdentity ?? null,
              },
              projectRoot,
              trustProfile: "hardened-untrusted",
              maxSteps: custody.config.maxSteps,
            });
            admissionContext.playbookData.action = "save";
            admissionContext.playbookData.profile_id = profileId;
            admissionContext.playbookData.kb_id = saveAdmission.kb_id;
            admissionContext.playbookData.admitted_policy_sha256 = saveAdmission.policy_sha256;
            admitted = orch.admitOperationStart({
              projectRoot,
              checkpointer: custody.checkpointer,
              context: admissionContext,
              session_id: hostSessionId,
              invocation_id: invocationId,
              action: "save",
              profile_id: profileId,
              request: saveRequest,
            });
            if (admitted.replay !== undefined) {
              kbResult = admitted.replay.replay_result;
              break;
            }
            if (admitted.recovered_result !== undefined) {
              kbResult = admitted.recovered_result;
              break;
            }
            const saveRunId = admitted.run_id;
            service = new orch.OrchestrationService({
              projectRoot,
              env: process.env,
              playbookName: "knowledge-base",
              modelClient: new orch.KbWorkerClient({
                projectRoot,
                kbRoot,
                runId: saveRunId,
                sessionId: hostSessionId,
                profileId,
                operation: "save",
                sourceCapabilityIds: [],
                admittedPolicySha256: saveAdmission.policy_sha256,
                readPhaseBrief: () => JSON.stringify(saveRequest),
                evidenceReader: orch.createSaveEvidenceReader({
                  kbRoot,
                  queryRunId: saveRequest.query_run_id,
                  answerArtifactId: claim.answer_artifact_id,
                  checkpointer: custody.checkpointer,
                }),
                seedPhaseOutputs: {
                  ingest: {
                    runId: saveRequest.query_run_id,
                    artifactId: claim.answer_artifact_id,
                  },
                },
                ...(testDependencies.kbAgentRunner
                  ? { testOnlyAgentRunner: testDependencies.kbAgentRunner }
                  : {}),
              }),
            });
            const directive = await service.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: saveRunId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal,
              constraints: {
                action: "save",
                kb_profile_id: profileId,
                query_run_id: saveRequest.query_run_id,
                page_kind: saveRequest.page_kind,
                parent_identity: hostParentIdentity ?? null,
              },
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (directive.action === "await_user") {
              const durable = service.checkpointer.loadRunById(saveRunId);
              if (durable === undefined) throw new Error("admitted save run is absent");
              kbResult = orch.replayableResultFromRun({
                action: "save",
                run: durable,
                checkpointer: service.checkpointer,
                status_override: "awaiting_user",
              });
            } else {
              const durable = service.checkpointer.loadRunById(saveRunId);
              if (durable === undefined) throw new Error("admitted save run is absent");
              kbResult = orch.replayableResultFromRun({ action: "save", run: durable });
            }
          } catch (error) {
            if (error instanceof orch.StartAdmissionMismatchError) {
              kbResult = {
                schema_version: 1,
                action: "save",
                run_id: runId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["idempotency_mismatch"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            if (admitted === undefined) {
              const requestSha256 = orch.sha256(orch.canonicalJson(saveRequest));
              const sourceIdentity = orch.externalOperationSourceIdentity({
                session_id: hostSessionId,
                invocation_id: invocationId,
                action: "save",
                request_sha256: requestSha256,
              });
              const group = custody.checkpointer.operationEventGroupBySource(
                "external_start",
                sourceIdentity
              );
              if (group === undefined) throw error;
              admitted = {
                run_id: group.run_id,
                request_sha256: requestSha256,
                transaction_id: group.transaction_id,
                group,
              };
            }
            kbResult = orch.checkpointDirectOperationResult({
              checkpointer: custody.checkpointer,
              run_id: admitted.run_id,
              kb_id: saveAdmission.kb_id,
              policy_sha256: saveAdmission.policy_sha256,
              result: {
                schema_version: 1,
                action: "save",
                run_id: admitted.run_id,
                status: "error",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["save_run_failed"],
                unresolved: [],
                next: "none",
              },
            });
          } finally {
            try {
              if (admitted !== undefined && kbResult !== undefined) {
                kbResult = orch.completeOperationStart({
                  projectRoot,
                  checkpointer: custody.checkpointer,
                  group_id: admitted.group.request_event_group_id,
                  profile_id: profileId,
                  result: kbResult,
                  input_digests: [admitted.request_sha256],
                  kb_id: saveAdmission.kb_id,
                  policy_sha256: saveAdmission.policy_sha256,
                  safe_metrics: kbResult.counts ?? {},
                }).replay_result;
              }
            } finally {
              service?.close();
              custody.close();
            }
          }
          break;
        }
        case "promote": {
          // §5.11 / PRD acceptance 9: the public action PREPARES ONLY. It cannot
          // carry an approval decision or apply anything; the packet it returns
          // is evidence for a human, never authority.
          let promoteRequest;
          try {
            promoteRequest = orch.validatePromoteRequest({
              schema_version: 1,
              action: "promote",
              kb_profile_id: profileId,
              page_revisions: rawParams["page_revisions"] ?? [],
              canonical_target_capability_ids: rawParams["canonical_target_capability_ids"] ?? [],
            });
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["promote_request_invalid"],
              unresolved: [],
              next: "none",
            };
            break;
          }

          let promotePolicySha: string;
          try {
            promotePolicySha = orch.admitKbRun({
              kbRoot,
              parentIdentity: hostParentIdentity,
            }).policy_sha256;
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "refused",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["promote_admission_refused"],
              unresolved: [],
              next: "none",
            };
            break;
          }

          const promoteInvocationId =
            typeof toolCallId === "string" && toolCallId.length > 0
              ? toolCallId
              : `call-${randomUUID()}`;
          const promoteRequestSha = orch.sha256(orch.canonicalJson(promoteRequest));
          const promoteSourceIdentity = orch.externalOperationSourceIdentity({
            session_id: hostSessionId,
            invocation_id: promoteInvocationId,
            action: "promote",
            request_sha256: promoteRequestSha,
          });
          const promoteRunId = `kb-${promoteSourceIdentity.slice(0, 24)}`;
          const promoteTransactionId = `tx_start_${promoteSourceIdentity.slice(0, 24)}`;
          let promoteOperationGroupId: string | undefined;
          const promoteService = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
            modelClient: new orch.KbWorkerClient({
              projectRoot,
              kbRoot,
              runId: promoteRunId,
              sessionId: hostSessionId,
              profileId,
              operation: "promote",
              sourceCapabilityIds: [],
              admittedPolicySha256: promotePolicySha,
              promotionReader: orch.createPromotionReader({
                projectRoot,
                kbRoot,
                runId: promoteRunId,
                sessionId: hostSessionId,
                profileId,
                operation: "promote",
                pageRevisions: promoteRequest.page_revisions,
                targetCapabilityIds: promoteRequest.canonical_target_capability_ids,
              }),
              ...(testDependencies.kbAgentRunner
                ? { testOnlyAgentRunner: testDependencies.kbAgentRunner }
                : {}),
            }),
          });
          const promoteGoal =
            `Prepare and verify a promotion candidate for ${promoteRequest.page_revisions.length} page ` +
            `revision(s) against ${promoteRequest.canonical_target_capability_ids.length} claimed ` +
            `canonical target(s). Prepare only — never apply.`;
          const promoteConstraints = {
            action: "promote",
            kb_profile_id: profileId,
            page_revisions: promotionPageRevisionsForConstraints(promoteRequest.page_revisions),
            canonical_target_capability_ids: [...promoteRequest.canonical_target_capability_ids],
            parent_identity: hostParentIdentity ?? null,
          };
          const promoteAdmissionContext = orch.RunContext.create({
            identity: {
              schema_version: 2,
              run_id: promoteRunId,
              session_id: hostSessionId,
              playbook: "knowledge-base",
              engine_owner: "typescript",
            },
            goal: promoteGoal,
            constraints: promoteConstraints,
            projectRoot,
            trustProfile: "hardened-untrusted",
            maxSteps: promoteService.config.maxSteps,
          });
          promoteAdmissionContext.playbookData.action = "promote";
          promoteAdmissionContext.playbookData.profile_id = profileId;
          promoteAdmissionContext.playbookData.admitted_policy_sha256 = promotePolicySha;
          const promoteAdmission = promoteService.checkpointer.admitStartRun(
            promoteAdmissionContext,
            {
              session_id: hostSessionId,
              invocation_id: promoteInvocationId,
              request_sha256: promoteRequestSha,
              action: "promote",
              profile_id: profileId,
              transaction_id: promoteTransactionId,
              private_input_id: `pri_${promoteSourceIdentity.slice(0, 24)}`,
              storage_key: `${promoteRunId}/request.json`,
              temporary_storage_key: `${promoteRunId}/.${promoteTransactionId}.tmp`,
            }
          );
          const admittedPromoteRun = promoteService.checkpointer.loadRunById(
            promoteAdmission.run_id
          );
          if (admittedPromoteRun?.terminalDirective === null) {
            orch.materializeRunInput({
              projectRoot,
              checkpointer: promoteService.checkpointer,
              runId: promoteAdmission.run_id,
              request: promoteRequest,
              requestSha256: promoteRequestSha,
            });
          }
          const existingPromoteGroup = promoteService.checkpointer.operationEventGroupBySource(
            "external_start",
            promoteSourceIdentity
          );
          if (existingPromoteGroup !== undefined && existingPromoteGroup.state !== "reserved") {
            kbResult = new orch.OperationReceiptStore({
              projectRoot,
              checkpointer: promoteService.checkpointer,
            }).finish(existingPromoteGroup.request_event_group_id).replay_result;
            promoteService.close();
            break;
          }
          if (existingPromoteGroup?.state === "reserved") {
            const recoveredRun = promoteService.checkpointer.loadRunById(
              existingPromoteGroup.run_id
            );
            if (recoveredRun !== undefined && recoveredRun.stateId !== "intake") {
              const recoveredResult = orch.replayableResultFromRun({
                action: "promote",
                run: recoveredRun,
              });
              kbResult = new orch.OperationReceiptStore({
                projectRoot,
                checkpointer: promoteService.checkpointer,
              }).complete({
                request_event_group_id: existingPromoteGroup.request_event_group_id,
                kb_profile_id: profileId,
                result: recoveredResult,
                input_digests: [promoteRequestSha],
                ...(String(recoveredRun.playbookData.kb_id ?? "").length > 0
                  ? { kb_id: String(recoveredRun.playbookData.kb_id) }
                  : {}),
                ...(String(recoveredRun.playbookData.admitted_policy_sha256 ?? "").length > 0
                  ? {
                      policy_sha256: String(recoveredRun.playbookData.admitted_policy_sha256),
                    }
                  : {}),
                safe_metrics: recoveredResult.counts,
              }).replay_result;
              promoteService.close();
              break;
            }
          }
          try {
            const directive = await promoteService.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: promoteRunId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal: promoteGoal,
              constraints: promoteConstraints,
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            const reserved = promoteService.checkpointer.operationEventGroupBySource(
              "external_start",
              promoteSourceIdentity
            );
            if (reserved === undefined || reserved.run_id !== promoteRunId) {
              throw new Error("promotion start lost its operation event group");
            }
            promoteOperationGroupId = reserved.request_event_group_id;
            if (directive.action === "await_user") {
              const run = promoteService.checkpointer.loadRunById(promoteRunId);
              if (run === undefined) throw new Error("admitted promotion run is absent");
              kbResult = orch.replayableResultFromRun({
                action: "promote",
                run,
                checkpointer: promoteService.checkpointer,
                status_override: "awaiting_user",
              });
            } else {
              kbResult = {
                schema_version: 1,
                action,
                run_id: promoteRunId,
                status: "error",
                met: false,
                ids: [promoteRunId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["promote did not reach its review gate"],
                unresolved: [],
                next: "none",
              };
            }
          } catch {
            kbResult = {
              schema_version: 1,
              action,
              run_id: promoteRunId,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: ["promote_run_failed"],
              unresolved: [],
              next: "none",
            };
          } finally {
            try {
              const reserved =
                promoteOperationGroupId === undefined
                  ? promoteService.checkpointer.operationEventGroupBySource(
                      "external_start",
                      promoteSourceIdentity
                    )
                  : promoteService.checkpointer.operationEventGroup(promoteOperationGroupId);
              if (reserved !== undefined && kbResult !== undefined) {
                promoteOperationGroupId = reserved.request_event_group_id;
                const durable = promoteService.checkpointer.loadRunById(promoteRunId);
                const completion = new orch.OperationReceiptStore({
                  projectRoot,
                  checkpointer: promoteService.checkpointer,
                }).complete({
                  request_event_group_id: reserved.request_event_group_id,
                  kb_profile_id: profileId,
                  result: kbResult,
                  input_digests: [promoteRequestSha],
                  ...(String(durable?.playbookData.kb_id ?? "").length > 0
                    ? { kb_id: String(durable?.playbookData.kb_id) }
                    : {}),
                  ...(String(durable?.playbookData.admitted_policy_sha256 ?? "").length > 0
                    ? {
                        policy_sha256: String(durable?.playbookData.admitted_policy_sha256),
                      }
                    : {}),
                  safe_metrics: kbResult.counts ?? {},
                });
                kbResult = completion.replay_result;
              }
            } finally {
              promoteService.close();
            }
          }
          break;
        }
        case "status": {
          const requestedRunId = String(rawParams["run_id"] ?? "");
          const statusService = new OrchestrationService({
            projectRoot,
            playbookName: "knowledge-base",
          });
          try {
            const candidate = statusService.checkpointer.loadRunById(requestedRunId);
            let run;
            try {
              run = orch.requireKbRunAccess(candidate, {
                runId: requestedRunId,
                sessionId: hostSessionId,
                profileId,
              });
              orch.requireKbRunIdentityCurrent(run, kbRoot);
            } catch (error) {
              if (!(error instanceof orch.KbRunAccessError)) throw error;
              kbResult = {
                schema_version: 1,
                action: "status",
                run_id: requestedRunId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["run_not_available_for_session_profile"],
                unresolved: [],
                next: "none",
              };
              break;
            }
            try {
              orch.requireKbCurrentParent(kbRoot, hostParentIdentity);
              orch.requireKbRunPolicyCurrent(run, kbRoot);
            } catch (error) {
              if (!(error instanceof orch.PolicyRefusal)) throw error;
              kbResult = {
                schema_version: 1,
                action: "status",
                run_id: requestedRunId,
                status: "refused",
                met: false,
                ids: [],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: [error.code],
                unresolved: [],
                next: "none",
              };
              break;
            }
            const isQueryRun = String(run.playbookData.action ?? "") === "query";
            const isTerminalRun = ["complete", "incomplete", "cancelled", "error"].includes(
              run.status
            );
            if (isQueryRun && isTerminalRun) {
              try {
                orch.verifyAndSettleTerminalStart({
                  projectRoot,
                  checkpointer: statusService.checkpointer,
                  run,
                });
              } catch (error) {
                if (!(error instanceof orch.PrivateInputError)) throw error;
                kbResult = {
                  schema_version: 1,
                  action: "status",
                  run_id: requestedRunId,
                  status: "refused",
                  met: false,
                  ids: [],
                  counts: {},
                  artifacts: [],
                  evidence: [],
                  warnings: ["terminal_result_digest_mismatch"],
                  unresolved: [],
                  next: "none",
                };
                break;
              }
            }
            kbResult = projectRunForStatusOrResume({
              projectedAction: "status",
              run,
              checkpointer: statusService.checkpointer,
            });
          } finally {
            statusService.close();
          }
          break;
        }
        default:
          kbResult = {
            schema_version: 1,
            action,
            run_id: runId,
            status: "refused",
            met: false,
            ids: [],
            counts: {},
            artifacts: [],
            evidence: [],
            warnings: [`action '${action}' is not yet implemented`],
            unresolved: [],
            next: "none",
          };
      }
      return { content: [{ type: "text", text: JSON.stringify(kbResult) }], details: kbResult };
    },
  });

  registerTool<typeof SkillParams, SkillResult>(pi, {
    name: "skill",
    label: "Invoke Skill",
    description: [
      "Invoke a skill with durable TypeScript state-machine orchestration.",
      "Skills define workflows (phases, transitions, subagent order).",
      "Penny decides WHEN to invoke; skills decide HOW to execute.",
      "Exact agent output is owner-persisted and re-read before SUMMARY routing; single and step inputs may include exact IDs from any run.",
      "Use for engine-backed skills whose listed description matches the task; do not use for a skill with a dedicated typed Pi-tool entrypoint such as knowledge_base.",
      "Use a skill name from Pi's <available_skills> system catalog; descriptions are not repeated here.",
      "",
      "Modes:",
      "  - Single:  skill({ skill_name, goal })",
      "  - Parallel: skill({ skills: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_PARALLEL_SKILLS} concurrent skills. Each skill runs independently.`,
      "  - Chain:   skill({ chain: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_CHAIN_STEPS} steps. {previous} points to the prior terminal ID; each step may add explicit input_artifacts.`,
      "    Stops on first error — use resume_chain to recover from the failed step.",
      "  - Resume:  skill({ resume_chain: chain_session_id, step_overrides?: {...} })",
      "    Skips completed steps, resumes from the failed step.",
    ].join("\n"),
    parameters: SkillParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Mode detection + routing ──
      const detected = detectSkillMode(params);

      if (detected.error) {
        const errorResult: SkillResult = {
          success: false,
          session_id: "error",
          skill_name: "skill",
          state: "error",
          requires_approval: false,
          steps_total: 0,
          agents_invoked: [],
          errors: [detected.error],
        };
        return {
          content: [
            { type: "text", text: formatResult(errorResult, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
          ],
          details: errorResult,
        };
      }

      let result: SkillResult;

      switch (detected.mode) {
        case "single": {
          // detectSkillMode guarantees skill_name+goal in single mode; re-check
          // defensively since params cross the untyped tool boundary.
          const skillName = params.skill_name;
          const goal = params.goal;
          if (!skillName || !goal) {
            throw new Error("single mode requires skill_name and goal");
          }
          // Reconstruct clean single-mode parameters at the tool boundary.
          const cleanParams = {
            goal,
            input_artifacts: params.input_artifacts,
            session_id: params.session_id,
            constraints: params.constraints,
            model: params.model,
          };
          result = await executeTypeScriptSkill(
            skillName,
            cleanParams,
            ctx.cwd,
            signal,
            ctx,
            onUpdate
          );
          result.mode = "single";
          break;
        }
        case "parallel": {
          const parallelSkills = params.skills ?? [];
          if (parallelSkills.length > MAX_PARALLEL_SKILLS) {
            const errResult: SkillResult = {
              success: false,
              session_id: "error",
              skill_name: "parallel",
              state: "error",
              requires_approval: false,
              steps_total: 0,
              agents_invoked: [],
              errors: [
                `Too many parallel skills (${parallelSkills.length}). Max is ${MAX_PARALLEL_SKILLS}.`,
              ],
            };
            return {
              content: [
                { type: "text", text: formatResult(errResult, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
              ],
              details: errResult,
            };
          }
          result = await executeSkillsParallel(parallelSkills, ctx.cwd, signal, ctx, onUpdate);
          break;
        }
        case "chain": {
          const chainSteps = params.chain ?? [];
          if (chainSteps.length > MAX_CHAIN_STEPS) {
            const errResult: SkillResult = {
              success: false,
              session_id: "error",
              skill_name: "chain",
              state: "error",
              requires_approval: false,
              steps_total: 0,
              agents_invoked: [],
              errors: [`Too many chain steps (${chainSteps.length}). Max is ${MAX_CHAIN_STEPS}.`],
            };
            return {
              content: [
                { type: "text", text: formatResult(errResult, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
              ],
              details: errResult,
            };
          }
          result = await executeSkillsChain(chainSteps, ctx.cwd, signal, ctx, onUpdate);
          break;
        }
        case "resume": {
          result = await executeSkillsChain(
            [], // chain steps are reconstructed from checkpoint
            ctx.cwd,
            signal,
            ctx,
            onUpdate,
            params.resume_chain,
            params.step_overrides
          );
          break;
        }
        default:
          throw new Error(`Unknown mode: ${String(detected.mode)}`);
      }

      const verified = await verifyTerminalArtifact(result, ctx.cwd);
      return {
        content: [
          { type: "text", text: formatResult(verified, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
        ],
        details: verified,
      };
    },

    renderCall(args: SkillToolParams, theme: Theme) {
      // ── Parallel mode ──
      if (args.skills && Array.isArray(args.skills)) {
        const names = args.skills
          .slice(0, 3)
          .map((s) => s.skill_name)
          .join(" + ");
        const more = args.skills.length > 3 ? ` ...+${args.skills.length - 3} more` : "";
        const text =
          theme.fg("toolTitle", "skill ") +
          theme.fg("dim", "[parallel] ") +
          theme.fg("accent", names) +
          theme.fg("dim", more);
        return new Text(text, 0, 0);
      }

      // ── Chain mode ──
      if (args.chain && Array.isArray(args.chain)) {
        const names = args.chain
          .slice(0, 3)
          .map((s) => s.skill_name)
          .join(" → ");
        const more = args.chain.length > 3 ? ` ...+${args.chain.length - 3} more` : "";
        const text =
          theme.fg("toolTitle", "skill ") +
          theme.fg("dim", "[chain] ") +
          theme.fg("accent", names) +
          theme.fg("dim", more);
        return new Text(text, 0, 0);
      }

      // ── Resume mode ──
      if (args.resume_chain) {
        const text =
          theme.fg("toolTitle", "skill ") +
          theme.fg("dim", "[resume] ") +
          theme.fg("accent", args.resume_chain.slice(0, 20));
        return new Text(text, 0, 0);
      }

      // ── Single mode (unchanged) ──
      const skill = skills.find((s) => s.name === args.skill_name);
      const name = skill?.name || args.skill_name || "skill";
      const goal = args.goal?.slice(0, 50) || "...";
      const text =
        theme.fg("toolTitle", "skill ") +
        theme.fg("accent", name) +
        theme.fg("dim", ` "${goal}..."`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: AgentToolResult<SkillResult | undefined>,
      { expanded }: { expanded: boolean },
      theme: Theme
    ) {
      const details = result.details;
      if (!details) return new Text(theme.fg("muted", "No result"), 0, 0);

      // ── Parallel mode ──
      if (details.mode === "parallel" && details.parallel_results) {
        if (!expanded) {
          const status = details.success ? "✓" : "✗";
          const text = theme.fg(
            details.success ? "success" : "error",
            `${status} ${details.parallel_results.length} skills`
          );
          return new Text(text, 0, 0);
        }
        const container = new Container();
        const statusIcon = details.success ? "✓" : "⚠";
        container.addChild(
          new Text(
            theme.fg(
              details.success ? "success" : "warning",
              `${statusIcon} ${details.parallel_results.length} skills`
            ),
            0,
            0
          )
        );
        container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(new Spacer(1));
        for (const r of details.parallel_results) {
          const s = r.success ? "✓" : "✗";
          container.addChild(
            new Text(theme.fg(r.success ? "success" : "error", `  ${s} ${r.skill_name}`), 0, 0)
          );
          container.addChild(new Text(theme.fg("muted", `     ${r.session_id}`), 0, 0));
        }
        return container;
      }

      // ── Chain mode ──
      if (details.mode === "chain") {
        if (!expanded) {
          if (details.success) {
            return new Text(
              theme.fg("success", `✓ chain ${details.chain_total || "?"} steps`),
              0,
              0
            );
          }
          const errorStep = (details.chain_error_step ?? 0) + 1;
          const resumableTag = details.resumable ? " (resumable)" : "";
          return new Text(
            theme.fg(
              "error",
              `✗ chain step ${errorStep}/${details.chain_total || "?"}${resumableTag}`
            ),
            0,
            0
          );
        }
        const container = new Container();
        if (details.success) {
          container.addChild(new Text(theme.fg("success", `✓ chain completed`), 0, 0));
          container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
          container.addChild(new Text(theme.fg("muted", `Steps: ${details.chain_total}`), 0, 0));
          if (details.chain_results) {
            container.addChild(new Spacer(1));
            for (const r of details.chain_results) {
              container.addChild(
                new Text(
                  theme.fg("text", `  ✓ step ${(r.chain_step ?? 0) + 1}: ${r.skill_name}`),
                  0,
                  0
                )
              );
            }
          }
        } else {
          container.addChild(new Text(theme.fg("error", `✗ chain failed`), 0, 0));
          container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
          if (details.chain_error_step !== undefined) {
            container.addChild(
              new Text(
                theme.fg(
                  "error",
                  `Failed at step ${details.chain_error_step + 1}/${details.chain_total}`
                ),
                0,
                0
              )
            );
          }
          if (details.resumable) {
            container.addChild(
              new Text(
                theme.fg("warning", `  Resumable via resume_chain: "${details.chain_session_id}"`),
                0,
                0
              )
            );
          }
          if (details.chain_results) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("muted", "Completed steps:"), 0, 0));
            for (const r of details.chain_results) {
              container.addChild(
                new Text(
                  theme.fg("text", `  ✓ step ${(r.chain_step ?? 0) + 1}: ${r.skill_name}`),
                  0,
                  0
                )
              );
            }
          }
        }
        return container;
      }

      if (expanded && details.escalation) {
        const container = new Container();
        container.addChild(
          new Text(theme.fg("warning", `⏸️ ${details.skill_name} awaiting user input`), 0, 0)
        );
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(new Text(theme.fg("muted", `State: ${details.state}`), 0, 0));
        container.addChild(
          new Text(theme.fg("muted", `Phases: ${details.agents_invoked.join(" → ")}`), 0, 0)
        );

        const esc = details.escalation;
        if (esc.unknown_reason) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("text", `Reason: ${esc.unknown_reason}`), 0, 0));
        }
        if (esc.previous_state) {
          container.addChild(
            new Text(theme.fg("muted", `Previous state: ${esc.previous_state}`), 0, 0)
          );
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("toolTitle", "Escalation Questions:"), 0, 0));
        for (const q of esc.questions || []) {
          container.addChild(new Text(theme.fg("text", `  [${q.id}] ${q.label}`), 0, 0));
        }
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("muted", "Use questionnaire tool to respond, then re-invoke skill."),
            0,
            0
          )
        );
        return container;
      }

      if (expanded && details.success && details.session_room) {
        const container = new Container();
        container.addChild(
          new Text(theme.fg("success", `✓ ${details.skill_name} completed`), 0, 0)
        );
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(
          new Text(theme.fg("muted", `Phases: ${details.agents_invoked.join(" → ")}`), 0, 0)
        );
        container.addChild(new Text(theme.fg("muted", `Room: ${details.session_room}`), 0, 0));

        // Show approval-required banner when plan needs review
        if (details.requires_approval) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("warning", "⛔ APPROVAL REQUIRED — Present to user for review"), 0, 0)
          );
          container.addChild(
            new Text(theme.fg("muted", "Use questionnaire tool: Approve / Refine / Deny"), 0, 0)
          );
        }

        // Show plan steps with details
        const planSteps = details.plan_steps || [];
        if (planSteps.length > 0) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("toolTitle", "Plan Steps:"), 0, 0));
          for (const step of planSteps.slice(0, 15)) {
            const title = step["title"] || String(step);
            const num = step["step"] || step["id"] || "•";
            container.addChild(
              new Text(theme.fg("text", `  ${String(num)}. ${String(title)}`), 0, 0)
            );
          }
          if (planSteps.length > 15) {
            container.addChild(
              new Text(theme.fg("dim", `  ... and ${planSteps.length - 15} more`), 0, 0)
            );
          }
        } else if (details.plan) {
          const steps = details.plan["steps"] || details.plan["tasks"] || [];
          if (isUnknownArray(steps) && steps.length > 0) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("toolTitle", "Steps:"), 0, 0));
            for (const rawStep of steps.slice(0, 15)) {
              const step = isRecord(rawStep) ? rawStep : {};
              const title = step["title"] || step["description"] || rawStep;
              container.addChild(
                new Text(
                  theme.fg(
                    "text",
                    `  ${String(step["id"] || step["step"] || "•")}. ${String(title)}`
                  ),
                  0,
                  0
                )
              );
            }
            if (steps.length > 15) {
              container.addChild(
                new Text(theme.fg("dim", `  ... and ${steps.length - 15} more`), 0, 0)
              );
            }
          }
        }
        return container;
      }

      const text = formatResult(details, theme.fg.bind(theme));
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("skills", {
    description: "List available skills",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const skillList = skills.map((s) => `  ${s.name}: ${s.description}`).join("\n");
      ctx.ui.notify(`Available skills:\n${skillList}`, "info");
    },
  });
}
