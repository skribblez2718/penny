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
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { OrchestrationService } from "@penny/orchestration/source";
import {
  SkillResult,
  formatResult,
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  detectSkillMode,
  reconstructResumeChain,
  isClarificationEscalation,
} from "./skill-utils.js";
import { ArtifactClientError, parseArtifactRef, type ArtifactRef } from "./artifact-client.js";
import { parseInputArtifacts, type InputArtifactsV1 } from "./input-artifacts.js";
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
import { registerOwnerArtifactGrants } from "../artifacts/owner-grants.js";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("skill");

import { mapWithConcurrencyLimit } from "../subagent/agent-runner.js";

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

const KbOpaqueId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const KbProfileField = { schema_version: Type.Literal(1), kb_profile_id: KbOpaqueId };
const KnowledgeBaseParameters = Type.Union([
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("init"),
      create: Type.Literal(true),
      title: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("init"),
      create: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("ingest"),
      source_capability_ids: Type.Array(KbOpaqueId, {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("query"),
      query: Type.String({ minLength: 1, maxLength: 32768 }),
      page_ids: Type.Optional(Type.Array(KbOpaqueId, { maxItems: 256, uniqueItems: true })),
      source_ids: Type.Optional(Type.Array(KbOpaqueId, { maxItems: 256, uniqueItems: true })),
      max_candidates: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      verify_grounding: Type.Optional(Type.Boolean()),
      answer_delivery: Type.Optional(
        Type.Union([Type.Literal("artifact_ref"), Type.Literal("parent_tool_result")])
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("save"),
      query_run_id: KbOpaqueId,
      page_kind: Type.Union([
        Type.Literal("concept"),
        Type.Literal("decision"),
        Type.Literal("synthesis"),
        Type.Literal("question"),
      ]),
      title: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("lint"),
      mode: Type.Union([Type.Literal("deterministic"), Type.Literal("deterministic_and_semantic")]),
      page_ids: Type.Optional(Type.Array(KbOpaqueId, { maxItems: 256, uniqueItems: true })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...KbProfileField,
      action: Type.Literal("promote"),
      page_revisions: Type.Array(
        Type.Object(
          { page_id: KbOpaqueId, revision_id: KbOpaqueId },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: 64, uniqueItems: true }
      ),
      canonical_target_capability_ids: Type.Array(KbOpaqueId, {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { ...KbProfileField, action: Type.Literal("status"), run_id: KbOpaqueId },
    { additionalProperties: false }
  ),
  Type.Object(
    { ...KbProfileField, action: Type.Literal("resume"), run_id: KbOpaqueId },
    { additionalProperties: false }
  ),
]);
type KnowledgeBaseParams = Static<typeof KnowledgeBaseParameters>;

let config: SkillConfig;

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
    project_root?: string;
    constraints?: Record<string, unknown>;
    /** Test/caller override applied to every research agent without changing SSOT defaults. */
    model?: string;
    /** Owner-only exact predecessor imported by skill-chain composition. */
    chain_input_artifacts?: InputArtifactsV1;
  },
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionCommandContext,
  onUpdate:
    | ((partial: { content: Array<{ type: string; text: string }>; details: unknown }) => void)
    | undefined
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
  const projectRoot = path.resolve(params.project_root || cwd);
  const sessionId = params.session_id || `skill-${randomUUID()}`;
  const runId = sessionId;
  const constraints =
    params.constraints && typeof params.constraints === "object" ? params.constraints : {};
  const { user_response: clarificationResponse, ...workflowConstraints } = constraints;
  const chainInput = params.chain_input_artifacts
    ? parseInputArtifacts(params.chain_input_artifacts)
    : undefined;
  const trustedProject =
    typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
  // Owner-supplied, read-only memory grant for TS workers (worker-read posture).
  // The memory extension is instantiated HERE (bun owner context) with a pinned,
  // minimal worker-read env, so the worker session never reads the primary env and
  // cannot gain write/logstream/inline-token access. Fail-closed: if worker-read
  // memory is not fully provisioned, the workers simply run without memory tools
  // (search/youtube only) and the run is not broken.
  const workerExtensions = await (async () => {
    try {
      const memory = await import("@penny/memory-extension");
      memory.loadWorkerReadConfig(process.env); // validate provisioning; throws if incomplete
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
      // Credential: either a token file (copy the path; the secret is read from
      // disk) or an environment secret (copy BOTH the referencing variable name and
      // the secret it holds, since the factory resolves the credential from the
      // env object it is given, not from the worker's process env).
      const tokenFile = process.env.PENNY_MEMORY_MCP_TOKEN_FILE;
      const tokenEnvName = process.env.PENNY_MEMORY_MCP_TOKEN_ENV;
      if (tokenFile && tokenFile.trim().length > 0) {
        readEnv.PENNY_MEMORY_MCP_TOKEN_FILE = tokenFile;
      } else if (tokenEnvName && tokenEnvName.trim().length > 0) {
        readEnv.PENNY_MEMORY_MCP_TOKEN_ENV = tokenEnvName;
        const secret = process.env[tokenEnvName];
        if (secret && secret.trim().length > 0) readEnv[tokenEnvName] = secret;
      }
      readEnv.PENNY_RUNTIME_ROLE = "worker-read";
      // Scope/load the extension only. The worker's tool allow-list comes from the
      // .pi/agents/<agent>.md SSOT (which declares memory.read), so there is no
      // per-grant tool list to maintain here.
      return [
        {
          name: "memory-worker-read",
          factory: memory.createMemoryExtension({ env: readEnv }),
          hidden: true,
        },
      ];
    } catch {
      return undefined; // memory not provisioned -> workers stay memory-free
    }
  })();
  const serviceEnv = params.model
    ? { ...process.env, PENNY_RESEARCH_DEFAULT_MODEL: params.model }
    : process.env;
  using service = new OrchestrationService({
    projectRoot,
    env: serviceEnv,
    ...(workerExtensions ? { workerExtensions } : {}),
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
  if (chainInput !== undefined && existing === undefined) {
    if (chainInput.run_id !== runId) {
      throw new Error("skill-chain input is not bound to the target TypeScript run");
    }
    for (const binding of chainInput.artifacts) {
      service.artifacts.read(binding.ref, chainInput.consumer);
    }
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
        ...(chainInput ? { input_artifacts: chainInput } : {}),
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
      "In chain mode, {previous} identifies the prior skill's exact granted terminal artifact; payload bytes are never substituted.",
  }),
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
  session_id: Type.Optional(
    Type.String({
      description: "Unique session identifier (auto-generated if not provided)",
    })
  ),
  project_root: Type.Optional(
    Type.String({
      description: "Project root directory (defaults to cwd)",
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
        "Invoke skills sequentially with owner-granted exact terminal artifacts; {previous} is an artifact marker, not payload text. " +
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
 * Each parallel skill gets an independent session and no chain-artifact grant.
 * On abort, pending skills are cancelled and partial results returned.
 */
async function executeSkillsParallel(
  skills: Array<{
    skill_name: string;
    goal: string;
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionCommandContext,
  onUpdate:
    | ((update: { content: Array<{ type: string; text: string }>; details: unknown }) => void)
    | undefined
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
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionCommandContext,
  onUpdate:
    | ((update: { content: Array<{ type: string; text: string }>; details: unknown }) => void)
    | undefined,
  resumeFrom?: string,
  stepOverrides?: Record<number, { goal?: string; constraints?: Record<string, unknown> }>
): Promise<SkillResult> {
  const results: SkillResult[] = [];
  let startStep = 0;
  let chainSessionId: string;
  let checkpoint: ChainCheckpoint;
  let previousHandoffRef: ReturnType<typeof parseArtifactRef> | undefined;
  let finalOutputRef: ReturnType<typeof parseArtifactRef> | undefined;

  if (resumeFrom) {
    const recovered = readChainCheckpoint(resumeFrom, process.env);
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
      session_id: step.session_id || `${step.skill_name}-${randomUUID()}`,
      status: "pending" as const,
      model: step.model,
      constraints: step.constraints,
    }));
    checkpoint = {
      schema_version: 1,
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

    let chainInputArtifacts: InputArtifactsV1 | undefined;
    if (previousHandoffRef) {
      try {
        await validateSkillChainHandoff(previousHandoffRef, process.env);
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
        saveChainCheckpoint(checkpoint, process.env);
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
    saveChainCheckpoint(checkpoint, process.env);

    const previousMarker = chainInputArtifacts
      ? "the exact granted prior-skill terminal artifact"
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
      saveChainCheckpoint(checkpoint, process.env);
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
      saveChainCheckpoint(checkpoint, process.env);

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
      saveChainCheckpoint(checkpoint, process.env);
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
        saveChainCheckpoint(checkpoint, process.env);
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
    saveChainCheckpoint(checkpoint, process.env);
  }

  checkpoint.chain_status = "complete";
  saveChainCheckpoint(checkpoint, process.env);
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

export default function skillExtension(pi: ExtensionAPI): void {
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
    const m = model as { provider?: unknown; id?: unknown } | undefined;
    const provider = typeof m?.provider === "string" ? m.provider : "";
    const id = typeof m?.id === "string" ? m.id : "";
    currentParentIdentity =
      provider.length > 0 && id.length > 0 ? { provider, model: id } : undefined;
  };

  pi.on("session_start", async (_event: unknown, ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    setSessionId(sessionId);
    captureParentIdentity((ctx as { model?: unknown }).model);
  });

  pi.on("model_select", async (event: unknown) => {
    captureParentIdentity((event as { model?: unknown })?.model);
  });

  /**
   * Grant the terminal skill artifact to the execution owner so the
   * orchestrator can read the exact result it is handed a ref for. Best effort:
   * a completed skill run is never failed by grant bookkeeping.
   */
  const grantTerminalArtifact = (result: SkillResult): SkillResult => {
    const ref = result.output_artifact_ref;
    if (!ref || !currentSessionId) return result;
    try {
      const [granted] = registerOwnerArtifactGrants({
        sessionId: currentSessionId,
        refs: [ref as ArtifactRef],
      });
      return granted ? { ...result, output_artifact_ref: granted } : result;
    } catch (error) {
      logger.warn("skill_owner_grant_failed", {
        errorCode: "SKILL_OWNER_GRANT_FAILED",
        reason: error instanceof Error ? error.message : "unknown",
      });
      return result;
    }
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
  pi.registerTool({
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
      _toolCallId: string,
      typedParams: KnowledgeBaseParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      toolContext: ExtensionCommandContext
    ) => {
      const rawParams = typedParams as unknown as Record<string, unknown>;
      const action = typedParams.action;
      const profileId = typedParams.kb_profile_id;
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
      let resolvedProfile;
      try {
        resolvedProfile = orch.resolveGrantedProfile({
          profileId,
          sessionId: hostSessionId,
          registryPath: path.join(projectRoot, ".penny", "kb-profiles.json"),
          grantStoreDir: path.join(projectRoot, ".penny", "kb-host-grants", "profile-grants"),
        });
      } catch (error) {
        logger.warn("kb_profile_admission_refused", {
          errorCode: "KB_PROFILE_ADMISSION_REFUSED",
          reason: error instanceof Error ? error.message : "unknown",
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
      const wfCtx = { kbRoot, profileId, runId };
      let kbResult;
      try {
        const current = orch.readCurrent(kbRoot);
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
          if (!create && current === undefined) {
            throw new Error("KB is not initialized and create was not authorized");
          }
        } else if (current === undefined) {
          throw new Error("KB is not initialized for this profile");
        }
        if (current !== undefined && resolvedProfile.profile.expected_kb_id !== undefined) {
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
          reason: error instanceof Error ? error.message : "unknown",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(refused) }],
          details: refused,
        };
      }
      switch (action) {
        case "init": {
          kbResult = orch.initKb(
            wfCtx,
            typeof rawParams["title"] === "string" ? rawParams["title"] : "Advisory KB"
          );
          break;
        }
        case "query": {
          // §5.6 closed admission: the request is a closed object, and exactly
          // those bytes bind the grant digest (SHA-256(JCS(request))).
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
          } catch (err) {
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
              warnings: [
                `query request failed closed validation: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }
          const delivery = request.answer_delivery ?? ("artifact_ref" as const);
          kbResult = orch.queryKb(wfCtx, request.query, {
            maxCandidates: request.max_candidates ?? 20,
            ...(request.page_ids !== undefined ? { pageIds: request.page_ids } : {}),
            ...(request.source_ids !== undefined ? { sourceIds: request.source_ids } : {}),
            ...(request.verify_grounding !== undefined
              ? { verifyGrounding: request.verify_grounding }
              : {}),
          });
          // Parent delivery — the only path where a parent may see derived
          // content: request + policy + exactly one unconsumed exact grant.
          // The grant is atomically consumed by the delivered run; on any miss
          // the artifact result is retained and the single public code is warned.
          if (
            delivery === "parent_tool_result" &&
            kbResult.status === "complete" &&
            kbResult.met === true &&
            Array.isArray(kbResult.artifacts) &&
            kbResult.artifacts.length > 0
          ) {
            const answer = orch.readSealedAnswer(
              kbRoot,
              runId,
              kbResult.artifacts[0] as { artifact_id: string }
            );
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
              storeDir: path.join(projectRoot, ".penny", "kb-parent-grants"),
              // Session-scoped invocation pairing (operator decision 2026-08-19):
              // invocation_id := the Pi session id; the operator mints both
              // fields with their session, and admission requires EXACTLY ONE
              // unconsumed matching grant (never a coin flip).
              host: { session_id: currentSessionId ?? "", invocation_id: currentSessionId ?? "" },
              request,
              policy,
              parentIdentity: currentParentIdentity,
              runId,
              answer,
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
          kbResult = orch.lintKb(wfCtx);
          break;
        }
        case "ingest": {
          const capIds = Array.isArray(rawParams["source_capability_ids"])
            ? (rawParams["source_capability_ids"] as unknown[])
                .map((x) => String(x))
                .filter((x) => x.length > 0)
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
              warnings: [
                "ingest requires 'source_capability_ids' — mint with: penny-kb-gate capability-mint --profile \"" +
                  profileId +
                  '" --path <file> --title <t> --author <a>',
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }
          // §5.3 deny-before-session. Admit the run HERE too, so an unadmitted
          // parent or an un-editable policy is a clean bounded refusal instead of
          // an engine exception — and so the run never starts. The playbook
          // re-admits inside `initialize`; that duplication is deliberate defense
          // in depth, and the digest below binds what the children run under.
          let admittedPolicySha256: string;
          try {
            admittedPolicySha256 = orch.admitKbRun({
              kbRoot,
              parentIdentity: currentParentIdentity,
            }).policy_sha256;
          } catch (err) {
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
              warnings: [
                `ingest refused before any private read: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }
          // Engine-driven ingest (§6.2 step 4). The KB playbook is the run's state
          // machine: initialize claims + admits the sources (host I/O), four agent
          // phases produce and seal their typed artifacts, and the run stops at the
          // human content-review gate. Approval/denial is a HOST decision that
          // reaches the KB through `penny-kb-gate`, never through this tool.
          const goal =
            `Ingest the admitted sources into KB profile '${profileId}' and produce a ` +
            `reviewable candidate page set for human review.`;
          const service = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
            modelClient: new orch.KbWorkerClient({
              projectRoot,
              kbRoot,
              runId,
              profileId,
              sourceCapabilityIds: capIds,
              admittedPolicySha256,
              ...(rawParams["model"] !== undefined
                ? { modelOverride: String(rawParams["model"]) }
                : {}),
            }),
          });
          try {
            const directive = await service.execute({
              schema_version: 2,
              action: "start",
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
                // Host-supplied, never model-supplied (§5.3).
                parent_identity: currentParentIdentity ?? null,
              },
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (
              directive.action === "complete" ||
              directive.action === "incomplete" ||
              directive.action === "cancelled"
            ) {
              const terminal = directive as {
                action: string;
                status?: string;
                met?: boolean;
                result?: Record<string, unknown>;
              };
              const result = (terminal.result ?? {}) as Record<string, unknown>;
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: String(terminal.status ?? terminal.action),
                met: Boolean(terminal.met),
                ids: [runId, ...(Array.isArray(result.ids) ? (result.ids as string[]) : [])],
                counts: (result.counts ?? {}) as Record<string, number>,
                artifacts: (result.artifacts ?? []) as unknown[],
                evidence: (result.evidence ?? []) as unknown[],
                warnings: Array.isArray(result.warnings) ? (result.warnings as string[]) : [],
                unresolved: Array.isArray(result.unresolved) ? (result.unresolved as string[]) : [],
                next: "none",
              };
            } else {
              // await_user at the content-review gate. Safe projection only: counts
              // and ids, never the candidate bodies, the gate challenge, or the
              // payload digest — approval is a host decision via penny-kb-gate.
              const gate = orch.findGateForRun(kbRoot, runId) ?? orch.latestPendingGate(kbRoot);
              const run = service.checkpointer.loadRunById(runId);
              const playbookData = (run?.playbookData as Record<string, unknown> | undefined) ?? {};
              const phases =
                (playbookData["phases"] as
                  | Record<string, { kb_artifact_id?: string; counts?: Record<string, number> }>
                  | undefined) ?? {};
              const artifactIds = Object.values(phases)
                .map((phaseRecord) => phaseRecord?.kb_artifact_id)
                .filter((id): id is string => typeof id === "string" && id.length > 0);
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: "waiting_for_review",
                met: false,
                ids: [runId, ...artifactIds],
                counts: {
                  admitted_sources: capIds.length,
                  ...Object.fromEntries(
                    Object.entries(phases).map(([phase, record]) => [phase, record?.counts ?? {}])
                  ),
                },
                artifacts: (gate !== undefined
                  ? gate.artifacts.map((a) => ({
                      artifact_id: String(
                        (a as { artifact_id?: string } | undefined)?.artifact_id ?? ""
                      ),
                      artifact_kind: String(
                        (a as { artifact_kind?: string } | undefined)?.artifact_kind ?? ""
                      ),
                      status: "sealed",
                    }))
                  : artifactIds.map((id) => ({
                      artifact_id: id,
                      artifact_kind: "unknown",
                      status: "sealed",
                    }))) as unknown[],
                evidence: [],
                warnings: [
                  "human content-review gate is pending; approve or deny on the host: " +
                    `penny-kb-gate approve --profile ${profileId} --run ${runId}  |  penny-kb-gate deny --profile ${profileId} --run ${runId}`,
                ],
                unresolved: [],
                next: "review",
              };
            }
          } catch (err) {
            // Refused mid-initialize (drifted source, expired capability, invalid
            // profile): the run never started; release any claims that were bound.
            try {
              orch.invalidateCapabilities(kbRoot, capIds);
            } catch {
              // best effort — claims also expire by TTL
            }
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: [String((err as Error)?.message ?? err).slice(0, 300)],
              unresolved: [],
              next: "none",
            };
          } finally {
            service.close();
          }
          break;
        }
        case "resume": {
          const requestedRunId = String(rawParams["run_id"] ?? "");
          const resumeService = new OrchestrationService({
            projectRoot,
            playbookName: "knowledge-base",
          });
          try {
            const run = resumeService.checkpointer.loadRunById(requestedRunId);
            if (
              run === undefined ||
              run.identity.playbook !== "knowledge-base" ||
              run.identity.session_id !== currentSessionId ||
              String(run.playbookData.profile_id ?? "") !== profileId
            ) {
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
            const pending = orch.findGateForRun(kbRoot, requestedRunId);
            if (run.status === "awaiting_user" && pending?.status === "awaiting") {
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "awaiting_user",
                met: false,
                ids: [requestedRunId],
                counts: { artifacts: pending.artifacts.length },
                artifacts: pending.artifacts,
                evidence: [],
                warnings: [
                  "re-presenting pending human content-review gate; approve/deny/refine is a host decision",
                ],
                unresolved: [],
                next: "review",
              };
            } else if (run.status === "complete") {
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "complete",
                met: run.met,
                ids: [requestedRunId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: [],
                unresolved: run.met ? [] : ["run completed without satisfying its goal"],
                next: "none",
              };
            } else if (["incomplete", "cancelled", "error"].includes(run.status)) {
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "error",
                met: false,
                ids: [requestedRunId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["run is terminal and cannot be resumed"],
                unresolved: [],
                next: "none",
              };
            } else {
              kbResult = {
                schema_version: 1,
                action: "resume",
                run_id: requestedRunId,
                status: "running",
                met: false,
                ids: [requestedRunId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["run is not at a public resumable boundary"],
                unresolved: [],
                next: "resume",
              };
            }
          } finally {
            resumeService.close();
          }
          break;
        }
        case "save": {
          // §5.6: a useful query does not authorize a save. The request must name
          // the exact prior query run, and that run's claim — not this request —
          // is what authorizes publication.
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
          } catch (err) {
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
              warnings: [
                `save request failed closed validation: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }

          // §5.3 admission before the run starts, exactly as ingest does.
          let savePolicySha: string;
          try {
            savePolicySha = orch.admitKbRun({
              kbRoot,
              parentIdentity: currentParentIdentity,
            }).policy_sha256;
          } catch (err) {
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
              warnings: [
                `save refused before any private read: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }

          // The claim names the exact sealed answer this save may compose from;
          // the worker is allowed to read that one artifact from that one run.
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
              warnings: [
                `no saveable answer exists for query run '${saveRequest.query_run_id}' in this profile`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }

          const saveService = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
            modelClient: new orch.KbWorkerClient({
              projectRoot,
              kbRoot,
              runId,
              profileId,
              sourceCapabilityIds: [],
              admittedPolicySha256: savePolicySha,
              // §5.8 "read an allowed prior run artifact": compose reads exactly
              // the claimed sealed answer, in place of an extraction phase.
              seedPhaseOutputs: {
                ingest: {
                  runId: saveRequest.query_run_id,
                  artifactId: claim.answer_artifact_id,
                },
              },
              ...(rawParams["model"] !== undefined
                ? { modelOverride: String(rawParams["model"]) }
                : {}),
            }),
          });
          try {
            const directive = await saveService.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal:
                `Compose an advisory '${saveRequest.page_kind}' page titled '${saveRequest.title}' from the ` +
                `claimed answer of query run '${saveRequest.query_run_id}', for human review.`,
              constraints: {
                action: "save",
                kb_profile_id: profileId,
                query_run_id: saveRequest.query_run_id,
                page_kind: saveRequest.page_kind,
                title: saveRequest.title,
                parent_identity: currentParentIdentity ?? null,
              },
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (directive.action === "await_user") {
              // Same safe projection as ingest: counts and ids only. Approval is
              // a host decision through penny-kb-gate, never this tool.
              const gate = orch.findGateForRun(kbRoot, runId) ?? orch.latestPendingGate(kbRoot);
              const run = saveService.checkpointer.loadRunById(runId);
              const playbookData = (run?.playbookData as Record<string, unknown> | undefined) ?? {};
              const phases =
                (playbookData["phases"] as
                  | Record<string, { kb_artifact_id?: string; counts?: Record<string, number> }>
                  | undefined) ?? {};
              const artifactIds = Object.values(phases)
                .map((phaseRecord) => phaseRecord?.kb_artifact_id)
                .filter((id): id is string => typeof id === "string" && id.length > 0);
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: "waiting_for_review",
                met: false,
                ids: [runId, ...artifactIds],
                counts: {
                  claimed_query_runs: 1,
                  ...Object.fromEntries(
                    Object.entries(phases).map(([phase, record]) => [phase, record?.counts ?? {}])
                  ),
                },
                artifacts: (gate !== undefined
                  ? gate.artifacts.map((a) => ({
                      artifact_id: String(
                        (a as { artifact_id?: string } | undefined)?.artifact_id ?? ""
                      ),
                      artifact_kind: String(
                        (a as { artifact_kind?: string } | undefined)?.artifact_kind ?? ""
                      ),
                      status: "sealed",
                    }))
                  : artifactIds.map((id) => ({
                      artifact_id: id,
                      artifact_kind: "unknown",
                      status: "sealed",
                    }))) as unknown[],
                evidence: [],
                warnings: [
                  "human content-review gate is pending; approve or deny on the host: " +
                    `penny-kb-gate approve --profile ${profileId} --run ${runId}  |  penny-kb-gate deny --profile ${profileId} --run ${runId}`,
                ],
                unresolved: [],
                next: "review",
              };
            } else {
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: directive.action === "complete" ? "complete" : "error",
                met: directive.action === "complete",
                ids: [runId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: [],
                unresolved: [],
                next: "none",
              };
            }
          } catch (err) {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: [`save run failed: ${String((err as Error).message ?? err).slice(0, 200)}`],
              unresolved: [],
              next: "none",
            };
          } finally {
            saveService.close();
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
          } catch (err) {
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
              warnings: [
                `promote request failed closed validation: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }

          let promotePolicySha: string;
          try {
            promotePolicySha = orch.admitKbRun({
              kbRoot,
              parentIdentity: currentParentIdentity,
            }).policy_sha256;
          } catch (err) {
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
              warnings: [
                `promote refused before any private read: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
            break;
          }

          const promoteService = new orch.OrchestrationService({
            projectRoot,
            env: process.env,
            playbookName: "knowledge-base",
            modelClient: new orch.KbWorkerClient({
              projectRoot,
              kbRoot,
              runId,
              profileId,
              sourceCapabilityIds: [],
              admittedPolicySha256: promotePolicySha,
              ...(rawParams["model"] !== undefined
                ? { modelOverride: String(rawParams["model"]) }
                : {}),
            }),
          });
          try {
            const directive = await promoteService.execute({
              schema_version: 2,
              action: "start",
              identity: {
                schema_version: 2,
                run_id: runId,
                session_id: hostSessionId,
                playbook: "knowledge-base",
                engine_owner: "typescript",
              },
              goal:
                `Prepare and verify a promotion candidate for ${promoteRequest.page_revisions.length} page ` +
                `revision(s) against ${promoteRequest.canonical_target_capability_ids.length} claimed ` +
                `canonical target(s). Prepare only — never apply.`,
              constraints: {
                action: "promote",
                kb_profile_id: profileId,
                page_revisions: promoteRequest.page_revisions as unknown as never,
                canonical_target_capability_ids: [
                  ...promoteRequest.canonical_target_capability_ids,
                ],
                parent_identity: currentParentIdentity ?? null,
              },
              project_root: projectRoot,
              trust_profile: "hardened-untrusted",
            });
            if (directive.action === "await_user") {
              const gate = orch.findGateForRun(kbRoot, runId) ?? orch.latestPendingGate(kbRoot);
              const run = promoteService.checkpointer.loadRunById(runId);
              const playbookData = (run?.playbookData as Record<string, unknown> | undefined) ?? {};
              const phases =
                (playbookData["phases"] as
                  | Record<string, { kb_artifact_id?: string; counts?: Record<string, number> }>
                  | undefined) ?? {};
              const verified = playbookData["promotion_verified"] === true;
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: "awaiting_user",
                met: false,
                ids: [runId],
                counts: {
                  page_revisions: promoteRequest.page_revisions.length,
                  targets: promoteRequest.canonical_target_capability_ids.length,
                  ...Object.fromEntries(
                    Object.entries(phases).map(([phase, record]) => [phase, record?.counts ?? {}])
                  ),
                },
                // The exact plan / patch / verification handles (§5.6).
                artifacts: (gate?.artifacts ?? []).map((a) => ({
                  artifact_id: String(
                    (a as { artifact_id?: string } | undefined)?.artifact_id ?? ""
                  ),
                  artifact_kind: String(
                    (a as { artifact_kind?: string } | undefined)?.artifact_kind ?? ""
                  ),
                  status: "sealed",
                })) as unknown[],
                evidence: [],
                warnings: [
                  "promotion is PREPARED and VERIFIED only; this tool cannot apply it",
                  ...(verified
                    ? []
                    : [
                        "host verification did not pass — read the verification report before deciding",
                      ]),
                ],
                unresolved: verified ? [] : ["promotion verification did not pass"],
                next: "review",
              };
            } else {
              kbResult = {
                schema_version: 1,
                action,
                run_id: runId,
                status: "error",
                met: false,
                ids: [runId],
                counts: {},
                artifacts: [],
                evidence: [],
                warnings: ["promote did not reach its review gate"],
                unresolved: [],
                next: "none",
              };
            }
          } catch (err) {
            kbResult = {
              schema_version: 1,
              action,
              run_id: runId,
              status: "error",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: [
                `promote run failed: ${String((err as Error).message ?? err).slice(0, 200)}`,
              ],
              unresolved: [],
              next: "none",
            };
          } finally {
            promoteService.close();
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
            const run = statusService.checkpointer.loadRunById(requestedRunId);
            if (
              run === undefined ||
              run.identity.playbook !== "knowledge-base" ||
              run.identity.session_id !== currentSessionId ||
              String(run.playbookData.profile_id ?? "") !== profileId
            ) {
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
            const pending = orch.findGateForRun(kbRoot, requestedRunId);
            const publicStatus =
              run.status === "complete"
                ? "complete"
                : run.status === "awaiting_user"
                  ? "awaiting_user"
                  : run.status === "running"
                    ? "running"
                    : "error";
            kbResult = {
              schema_version: 1,
              action: "status",
              run_id: requestedRunId,
              status: publicStatus,
              met: run.status === "complete" ? run.met : false,
              ids: [requestedRunId],
              counts: {},
              artifacts: pending?.status === "awaiting" ? pending.artifacts : [],
              evidence: [],
              warnings: [],
              unresolved: [],
              next:
                publicStatus === "awaiting_user"
                  ? "review"
                  : publicStatus === "running"
                    ? "resume"
                    : "none",
            };
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

  pi.registerTool({
    name: "skill",
    label: "Invoke Skill",
    description: [
      "Invoke a skill with durable TypeScript state-machine orchestration.",
      "Skills define workflows (phases, transitions, subagent order).",
      "Penny decides WHEN to invoke; skills decide HOW to execute.",
      "Exact agent output is owner-persisted as an artifact before SUMMARY routing.",
      "",
      "Modes:",
      "  - Single:  skill({ skill_name, goal })",
      "  - Parallel: skill({ skills: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_PARALLEL_SKILLS} concurrent skills. Each skill runs independently.`,
      "  - Chain:   skill({ chain: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_CHAIN_STEPS} steps. {previous} points to the prior skill's exact granted terminal artifact.`,
      "    Stops on first error — use resume_chain to recover from the failed step.",
      "  - Resume:  skill({ resume_chain: chain_session_id, step_overrides?: {...} })",
      "    Skips completed steps, resumes from the failed step.",
      "",
      "Available skills:",
      ...skills.map((s) => `  - ${s.name}: ${s.description}`),
    ].join("\n"),
    parameters: SkillParams,
    async execute(
      _toolCallId: string,
      params: SkillToolParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionCommandContext
    ) {
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
            session_id: params.session_id,
            project_root: params.project_root,
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

      const granted = grantTerminalArtifact(result);
      return {
        content: [
          { type: "text", text: formatResult(granted, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
        ],
        details: granted,
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
          theme("toolTitle", "skill ") +
          theme("dim", "[parallel] ") +
          theme("accent", names) +
          theme("dim", more);
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
          theme("toolTitle", "skill ") +
          theme("dim", "[chain] ") +
          theme("accent", names) +
          theme("dim", more);
        return new Text(text, 0, 0);
      }

      // ── Resume mode ──
      if (args.resume_chain) {
        const text =
          theme("toolTitle", "skill ") +
          theme("dim", "[resume] ") +
          theme("accent", args.resume_chain.slice(0, 20));
        return new Text(text, 0, 0);
      }

      // ── Single mode (unchanged) ──
      const skill = skills.find((s) => s.name === args.skill_name);
      const name = skill?.name || args.skill_name || "skill";
      const goal = args.goal?.slice(0, 50) || "...";
      const text =
        theme("toolTitle", "skill ") + theme("accent", name) + theme("dim", ` "${goal}..."`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: AgentToolResult<SkillResult>,
      { expanded }: { expanded: boolean },
      theme: Theme
    ) {
      const details = result.details;
      if (!details) return new Text(theme("muted", "No result"), 0, 0);

      // ── Parallel mode ──
      if (details.mode === "parallel" && details.parallel_results) {
        if (!expanded) {
          const status = details.success ? "✓" : "✗";
          const text = theme(
            details.success ? "success" : "error",
            `${status} ${details.parallel_results.length} skills`
          );
          return new Text(text, 0, 0);
        }
        const container = new Container();
        const statusIcon = details.success ? "✓" : "⚠";
        container.addChild(
          new Text(
            theme(
              details.success ? "success" : "warning",
              `${statusIcon} ${details.parallel_results.length} skills`
            ),
            0,
            0
          )
        );
        container.addChild(new Text(theme("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(new Spacer(1));
        for (const r of details.parallel_results) {
          const s = r.success ? "✓" : "✗";
          container.addChild(
            new Text(theme(r.success ? "success" : "error", `  ${s} ${r.skill_name}`), 0, 0)
          );
          container.addChild(new Text(theme("muted", `     ${r.session_id}`), 0, 0));
        }
        return container;
      }

      // ── Chain mode ──
      if (details.mode === "chain") {
        if (!expanded) {
          if (details.success) {
            return new Text(theme("success", `✓ chain ${details.chain_total || "?"} steps`), 0, 0);
          }
          const errorStep = (details.chain_error_step ?? 0) + 1;
          const resumableTag = details.resumable ? " (resumable)" : "";
          return new Text(
            theme(
              "error",
              `✗ chain step ${errorStep}/${details.chain_total || "?"}${resumableTag}`
            ),
            0,
            0
          );
        }
        const container = new Container();
        if (details.success) {
          container.addChild(new Text(theme("success", `✓ chain completed`), 0, 0));
          container.addChild(new Text(theme("muted", `Session: ${details.session_id}`), 0, 0));
          container.addChild(new Text(theme("muted", `Steps: ${details.chain_total}`), 0, 0));
          if (details.chain_results) {
            container.addChild(new Spacer(1));
            for (const r of details.chain_results) {
              container.addChild(
                new Text(
                  theme("text", `  ✓ step ${(r.chain_step ?? 0) + 1}: ${r.skill_name}`),
                  0,
                  0
                )
              );
            }
          }
        } else {
          container.addChild(new Text(theme("error", `✗ chain failed`), 0, 0));
          container.addChild(new Text(theme("muted", `Session: ${details.session_id}`), 0, 0));
          if (details.chain_error_step !== undefined) {
            container.addChild(
              new Text(
                theme(
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
                theme("warning", `  Resumable via resume_chain: "${details.chain_session_id}"`),
                0,
                0
              )
            );
          }
          if (details.chain_results) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme("muted", "Completed steps:"), 0, 0));
            for (const r of details.chain_results) {
              container.addChild(
                new Text(
                  theme("text", `  ✓ step ${(r.chain_step ?? 0) + 1}: ${r.skill_name}`),
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
          new Text(theme("warning", `⏸️ ${details.skill_name} awaiting user input`), 0, 0)
        );
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(new Text(theme("muted", `State: ${details.state}`), 0, 0));
        container.addChild(
          new Text(theme("muted", `Phases: ${details.agents_invoked.join(" → ")}`), 0, 0)
        );

        const esc = details.escalation;
        if (esc.unknown_reason) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme("text", `Reason: ${esc.unknown_reason}`), 0, 0));
        }
        if (esc.previous_state) {
          container.addChild(
            new Text(theme("muted", `Previous state: ${esc.previous_state}`), 0, 0)
          );
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme("toolTitle", "Escalation Questions:"), 0, 0));
        for (const q of esc.questions || []) {
          container.addChild(new Text(theme("text", `  [${q.id}] ${q.label}`), 0, 0));
        }
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme("muted", "Use questionnaire tool to respond, then re-invoke skill."), 0, 0)
        );
        return container;
      }

      if (expanded && details.success && details.session_room) {
        const container = new Container();
        container.addChild(new Text(theme("success", `✓ ${details.skill_name} completed`), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme("muted", `Session: ${details.session_id}`), 0, 0));
        container.addChild(
          new Text(theme("muted", `Phases: ${details.agents_invoked.join(" → ")}`), 0, 0)
        );
        container.addChild(new Text(theme("muted", `Room: ${details.session_room}`), 0, 0));

        // Show approval-required banner when plan needs review
        if (details.requires_approval) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme("warning", "⛔ APPROVAL REQUIRED — Present to user for review"), 0, 0)
          );
          container.addChild(
            new Text(theme("muted", "Use questionnaire tool: Approve / Refine / Deny"), 0, 0)
          );
        }

        // Show plan steps with details
        const planSteps = details.plan_steps || [];
        if (planSteps.length > 0) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme("toolTitle", "Plan Steps:"), 0, 0));
          for (const step of planSteps.slice(0, 15)) {
            const title = step["title"] || String(step);
            const num = step["step"] || step["id"] || "•";
            container.addChild(new Text(theme("text", `  ${String(num)}. ${String(title)}`), 0, 0));
          }
          if (planSteps.length > 15) {
            container.addChild(
              new Text(theme("dim", `  ... and ${planSteps.length - 15} more`), 0, 0)
            );
          }
        } else if (details.plan) {
          const steps = details.plan["steps"] || details.plan["tasks"] || [];
          if (Array.isArray(steps) && steps.length > 0) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme("toolTitle", "Steps:"), 0, 0));
            for (const rawStep of steps.slice(0, 15)) {
              const step = (rawStep ?? {}) as Record<string, unknown>;
              const title = step["title"] || step["description"] || rawStep;
              container.addChild(
                new Text(
                  theme("text", `  ${String(step["id"] || step["step"] || "•")}. ${String(title)}`),
                  0,
                  0
                )
              );
            }
            if (steps.length > 15) {
              container.addChild(
                new Text(theme("dim", `  ... and ${steps.length - 15} more`), 0, 0)
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
