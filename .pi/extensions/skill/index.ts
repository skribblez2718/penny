import type { VideogenRuntimeProvidersV1 } from "@penny/orchestration";
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
 * Agent invocation: The shared orchestration service dispatches registered
 * workers through PiAgentClient and isolated Pi SDK sessions. The direct
 * subagent tool's subprocess runner is separate; this extension does not
 * invoke another tool through ExtensionContext. Worker progress reaches the
 * caller through the skill tool's partial updates.
 */

import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  Theme,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  KnowledgeBaseRequestSchema,
  OrchestrationService,
  PLAYBOOK_REGISTRY,
  selectedCompositionAssurance,
  validateCompositionAssurance,
  assertExistingStartAssurance,
  CompositionAssuranceAdmissionError,
  canonicalJson,
  nativeArtifactInputs,
  nativeStartRequest,
  recoverAdmittedArtifactInputs,
  JsonValueSchema,
  validateContract,
  PennyStateResolutionError,
  resolvePennyRuntimeState,
  resolvePngMediaLimits,
  validateKnowledgeBaseRequest,
  type Checkpointer,
  type KbAgentRunner,
  type JsonValue,
  type KnowledgeBaseRequest,
  type OrchestrationProgressEvent,
  type ReplayableKnowledgeBaseResult,
  type RunContext,
} from "@penny/orchestration";
import {
  SkillResult,
  formatResult,
  formatSealDiagnostics,
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  detectSkillMode,
  reconstructResumeChain,
  isClarificationEscalation,
  isSkillProgressDetails,
  parseRepairDiagnostics,
  parseSealDiagnostics,
  type ActiveSkillProgress,
  type SkillProgressDetails,
  type SkillProgressMode,
  type SkillToolDetails,
} from "./skill-utils.js";
import {
  ArtifactClientError,
  parseArtifactRef,
  readArtifactsById,
  readArtifactOutput,
  type ArtifactRef,
} from "./artifact-client.js";
import { parseInputArtifacts, type InputArtifactsV2 } from "./input-artifacts.js";
import { skillArtifactInputs } from "./skill-context-inputs.js";
import { parseArtifactDispatchPause } from "./dispatch-control.js";
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
  validateUnifiedSkillRegistryPackages,
  type SkillDiscovery,
} from "./skill-discovery.js";
import { alignNativeSkillInstruction } from "./skill-prompt.js";
import { resolveSkillIngress, type SkillIngressResolution } from "./skill-ingress.js";
import { terminalImagePresentation } from "./terminal-image.js";
import { PlaybookUiOwner } from "./playbook-ui.js";

import { parseCurrentSkillResult } from "@penny/orchestration";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("skill");

import { mapWithConcurrencyLimit } from "../subagent/agent-runner.js";

type SkillIngressResolver = typeof resolveSkillIngress;

function stateFailureDiagnostic(error: PennyStateResolutionError): string {
  const details = error.details;
  const versions =
    details.actualSchemaVersion === undefined || details.requiredSchemaVersion === undefined
      ? ""
      : ` (${details.actualSchemaVersion} → ${details.requiredSchemaVersion})`;
  const recovery =
    details.recoveryAction === undefined ? "" : `; recovery=${details.recoveryAction}`;
  return `${error.code}: ${details.component ?? "retained"} state unavailable${versions}${recovery}`;
}

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
  const discovered = discoverSkillsFromDirectory(config.skillsDir, {
    onMetadataError: (skill) =>
      logger.debug("Skill metadata parse failed; unified package validation will refuse", {
        skill,
      }),
  });
  return [
    ...validateUnifiedSkillRegistryPackages({
      skillsDir: config.skillsDir,
      registry: PLAYBOOK_REGISTRY,
      discoveredSkills: discovered,
    }),
  ];
}

// ============================================================
// TypeScript orchestration
// ============================================================

interface SkillRunProgress {
  readonly stage: SkillProgressDetails["stage"];
  readonly message: string;
  readonly skill_name: string;
  readonly session_id: string;
  readonly state_id?: string;
  readonly agents?: readonly string[];
  readonly workers_completed?: number;
  readonly workers_total?: number;
  readonly boundary_action?: string;
}

type SkillRunProgressSink = (progress: SkillRunProgress) => void;
type SkillToolUpdate = AgentToolUpdateCallback<SkillToolDetails | undefined>;

function emitSkillProgress(
  onUpdate: SkillToolUpdate | undefined,
  details: SkillProgressDetails
): void {
  onUpdate?.({
    content: [{ type: "text", text: details.message }],
    details,
  });
}

function runProgressFromOrchestration(
  skillName: string,
  sessionId: string,
  event: OrchestrationProgressEvent
): SkillRunProgress {
  if (event.event === "phase_started") {
    const agents = [...new Set(event.workers.map((worker) => worker.agent))];
    const displayedAgents = agents.slice(0, 3);
    const moreAgents = agents.length > displayedAgents.length ? `, +${agents.length - 3} more` : "";
    const workerLabel =
      event.workers.length === 1
        ? (agents[0] ?? "agent")
        : `${event.workers.length} workers (${displayedAgents.join(", ")}${moreAgents})`;
    const repair = event.workers.every((worker) => worker.execution_purpose === "routing_repair")
      ? " routing repair"
      : "";
    return {
      stage: "phase_started",
      message: `${skillName} — ${event.state_id}${repair} with ${workerLabel}`,
      skill_name: skillName,
      session_id: sessionId,
      state_id: event.state_id,
      agents,
      workers_completed: 0,
      workers_total: event.workers.length,
    };
  }
  if (event.event === "worker_completed") {
    return {
      stage: "worker_completed",
      message: `${skillName} — ${event.worker.agent} finished ${event.state_id} (${event.completed_workers}/${event.total_workers})`,
      skill_name: skillName,
      session_id: sessionId,
      state_id: event.state_id,
      agents: [event.worker.agent],
      workers_completed: event.completed_workers,
      workers_total: event.total_workers,
    };
  }
  if (event.event === "worker_failed") {
    return {
      stage: "worker_failed",
      message: `${skillName} — ${event.state_id} stopped after ${event.failed_workers}/${event.total_workers} worker failures`,
      skill_name: skillName,
      session_id: sessionId,
      state_id: event.state_id,
      workers_total: event.total_workers,
    };
  }
  if (event.event === "host_operation_progress") {
    const completed =
      event.progress.completed_units === undefined
        ? ""
        : event.progress.total_units === undefined
          ? ` (${event.progress.completed_units})`
          : ` (${event.progress.completed_units}/${event.progress.total_units})`;
    return {
      stage: "host_operation_progress",
      message: `${skillName} — ${event.state_id} ${event.operation_kind}: ${event.progress.progress_class}${completed}`,
      skill_name: skillName,
      session_id: sessionId,
      state_id: event.state_id,
    };
  }
  const labels: Record<
    Extract<OrchestrationProgressEvent, { event: "boundary_reached" }>["action"],
    string
  > = {
    await_user: "awaiting user input",
    complete: "engine complete; checking output",
    incomplete: "incomplete",
    error: "stopped with an error",
    cancelled: "cancelled",
    paused: "paused",
    status: "status returned",
  };
  return {
    stage: "boundary_reached",
    message: `${skillName} — ${labels[event.action]}`,
    skill_name: skillName,
    session_id: sessionId,
    ...(event.state_id ? { state_id: event.state_id } : {}),
    boundary_action: event.action,
  };
}

/** Recovery reuses admission; it never replaces it. Compare the immutable intake
 * request and its upstream refs, not the changing selected-artifact set.
 * No retry materialization, selection, or checkpoint mutation occurs here. */
function assertExistingInputAdmission(input: {
  service: OrchestrationService;
  existing: RunContext;
  registration: Extract<SkillIngressResolution, { ok: true }>["registration"];
  goal: string;
  constraints: Record<string, unknown>;
  inputArtifacts: InputArtifactsV2 | undefined;
}): void {
  const { service, existing, registration } = input;
  const admission = registration.start_admission;
  if (admission === undefined) throw new Error("SKILL_RECOVERY_BINDING_INVALID: no admission");
  const kind = existing.identity.playbook === "research" ? "research-request" : "decision-request";
  const operationId = `${kind}:${createHash("sha256").update(existing.identity.run_id).digest("hex").slice(0, 32)}`;
  const requestRef = service.artifacts.refFor(
    existing.identity.run_id,
    "intake",
    null,
    kind,
    operationId,
    1
  );
  if (
    requestRef === null ||
    requestRef.content_schema?.schema_id !== admission.schema_id ||
    requestRef.content_schema.schema_version !== admission.schema_version ||
    !existing.selectedArtifacts.some((ref) => canonicalJson(ref) === canonicalJson(requestRef)) ||
    service.artifacts.lastVersion(existing.identity.run_id, "intake", null, kind, operationId) !== 1
  ) {
    throw new Error("SKILL_RECOVERY_BINDING_INVALID: original request unavailable");
  }
  const metadata = service.artifacts.metadata(requestRef);
  if (metadata.producer !== "host:request-admission" || metadata.parent_ref !== null)
    throw new Error("SKILL_RECOVERY_BINDING_INVALID: original request metadata");
  // Research also binds host-owned context envelopes. They are not caller
  // composition inputs and must remain selected, exact and readable.
  const originalRefs = metadata.upstream_refs.filter((ref) => {
    service.artifacts.read(ref);
    if (
      existing.identity.playbook === "research" &&
      ref.kind === "context-source-ref" &&
      ref.phase === "context_binding" &&
      ref.run_id === existing.identity.run_id
    ) {
      if (
        !existing.selectedArtifacts.some(
          (selected) => canonicalJson(selected) === canonicalJson(ref)
        )
      )
        throw new Error("SKILL_RECOVERY_BINDING_INVALID: original context unavailable");
      return false;
    }
    return true;
  });
  const retryRefs = (nativeArtifactInputs(input.inputArtifacts)?.artifacts ?? []).map(
    (binding) => binding.ref
  );
  const sortedRefs = (refs: readonly ArtifactRef[]) =>
    [...refs].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  if (canonicalJson(sortedRefs(retryRefs)) !== canonicalJson(sortedRefs(originalRefs)))
    throw new Error(
      "SKILL_RECOVERY_BINDING_INVALID: input_artifacts differ from original admission"
    );
  const prepared = admission.prepare(
    {
      schema_version: 2,
      action: "start",
      identity: existing.identity,
      goal: input.goal,
      constraints: validateContract(
        Type.Record(Type.String(), JsonValueSchema),
        input.constraints,
        "skill retry constraints"
      ),
      project_root: existing.projectRoot,
      trust_profile: existing.trustProfile,
      ...(input.inputArtifacts === undefined ? {} : { input_artifacts: input.inputArtifacts }),
    },
    { artifactReader: service.artifacts }
  );
  if (
    canonicalJson(prepared.admission_data) !== service.artifacts.read(requestRef).toString("utf8")
  )
    throw new Error("SKILL_RECOVERY_BINDING_INVALID: request differs from original admission");
}

async function executeTypeScriptSkillUnchecked(
  skillName: string,
  params: {
    goal: string;
    session_id?: string;
    constraints?: Record<string, unknown>;
    /** Caller-approved override applied to every worker without changing SSOT defaults. */
    model?: string;
    /** Exact IDs supplied explicitly by the caller, from any run. */
    input_artifacts?: string[];
    context_artifacts?: string[];
    previous_artifact_designation?: "binding" | "context";
    /** Exact predecessor inserted automatically by skill-chain composition. */
    chain_input_artifacts?: InputArtifactsV2;
  },
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onRunProgress: SkillRunProgressSink | undefined,
  ingressResolver: SkillIngressResolver = resolveSkillIngress,
  hostRuntime: SkillInvocationRuntime = {}
): Promise<SkillResult> {
  if (signal?.aborted) {
    throw abortError(skillName);
  }
  const projectRoot = path.resolve(cwd);
  const ingress: SkillIngressResolution = ingressResolver({
    projectRoot,
    skillsDir: config.skillsDir,
    name: skillName,
  });
  if (!ingress.ok) {
    return {
      success: false,
      session_id: params.session_id || "",
      skill_name: skillName,
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: [],
      errors: [`${ingress.code}: ${ingress.message}`],
      refusal_code: ingress.code,
    };
  }
  const sessionId = params.session_id || `skill-${randomUUID()}`;
  const runId = sessionId;
  hostRuntime.ui?.assertAvailable(projectRoot, runId);
  onRunProgress?.({
    stage: "preparing",
    message: `Preparing ${skillName}`,
    skill_name: skillName,
    session_id: sessionId,
  });
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
  const contextRefs = (
    await readArtifactsById({
      artifactIds: params.context_artifacts ?? [],
      projectRoot,
      env: process.env,
    })
  ).map((read) => read.ref);
  let inputArtifacts = skillArtifactInputs({ nativeRefs: explicitRefs, contextRefs, chainInput });
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
  const workerExtensionReplacements = [
    {
      // The skill host owns this capability and its exact ambient source identity.
      // Composition happens before factories, not by hiding/filtering registered tools.
      source: memory.memoryExtensionSource,
      extension: {
        name: "memory-worker-read",
        factory: memory.createMemoryExtension({ env: readEnv }),
        hidden: true,
      },
    },
  ];
  const service = new OrchestrationService({
    projectRoot,
    env: process.env,
    ...(params.model === undefined ? {} : { modelOverride: params.model }),
    workerExtensionReplacements,
    playbookName: skillName,
    ...(skillName === "videogen" && hostRuntime.videogen !== undefined
      ? { videogen: hostRuntime.videogen }
      : {}),
  });
  let serviceRetained = false;
  try {
    const identity = {
      schema_version: 2 as const,
      run_id: runId,
      session_id: sessionId,
      playbook: skillName,
      engine_owner: "typescript" as const,
    };
    const onOrchestrationProgress = (event: OrchestrationProgressEvent): void => {
      onRunProgress?.(runProgressFromOrchestration(skillName, sessionId, event));
    };

    const existing = service.checkpointer.loadRunById(runId);
    if (inputArtifacts !== undefined && existing === undefined) {
      for (const binding of inputArtifacts.artifacts) service.artifacts.read(binding.ref);
    }
    if (existing?.admittedInputArtifacts !== undefined)
      inputArtifacts = parseInputArtifacts(
        recoverAdmittedArtifactInputs(existing.admittedInputArtifacts, inputArtifacts)
      );
    const nativeInputs = nativeArtifactInputs(inputArtifacts);
    if (existing !== undefined && (skillName === "define" || skillName === "plan")) {
      const admission = ingress.registration.start_admission;
      const binding = existing.registrationContractBinding;
      if (admission === undefined || binding?.registration_sha256 === undefined)
        throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: missing run binding");
      const retryConstraints = validateContract(
        Type.Record(Type.String(), JsonValueSchema),
        workflowConstraints,
        "skill retry constraints"
      );
      const existingAssurance = selectedCompositionAssurance(existing, service.artifacts).value;
      const supportedDefineRegistrationSha256 =
        existingAssurance.mode === "reviewed_definition"
          ? existingAssurance.producer.registration_sha256
          : null;
      const projectId = resolvePennyRuntimeState(projectRoot, { env: process.env }).projectId;
      const retry = {
        schema_version: 2 as const,
        action: "start" as const,
        identity,
        goal: params.goal,
        constraints: retryConstraints,
        project_root: projectRoot,
        trust_profile: existing.trustProfile,
        ...(inputArtifacts === undefined ? {} : { input_artifacts: inputArtifacts }),
      };
      const prepared = admission.prepare(nativeStartRequest(retry), {
        artifactReader: service.artifacts,
        assurance: {
          artifacts: service.artifacts,
          checkpointer: service.checkpointer,
          project_id: projectId,
          project_root: projectRoot,
          supported_define_registration_sha256: supportedDefineRegistrationSha256,
          consumer: {
            run_id: runId,
            registration_name: skillName,
            contract_sha256: binding.contract_sha256,
            registration_sha256: binding.registration_sha256,
          },
        },
      });
      const data = prepared.admission_data;
      if (typeof data !== "object" || data === null || !("native" in data))
        throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: missing native retry");
      const refs =
        nativeInputs?.artifacts
          .map((item) => item.ref)
          .filter((ref) => ref.content_schema?.schema_id === "penny.specification.v1") ?? [];
      if (refs.length > 1) throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID: inputs");
      assertExistingStartAssurance({
        artifacts: service.artifacts,
        checkpointer: service.checkpointer,
        project_id: projectId,
        project_root: projectRoot,
        supported_define_registration_sha256: supportedDefineRegistrationSha256,
        consumer: {
          run_id: runId,
          registration_name: skillName,
          contract_sha256: binding.contract_sha256,
          registration_sha256: binding.registration_sha256,
        },
        invocation: retryConstraints,
        request_bytes: canonicalJson(data.native),
        request_schema: {
          schema_id: admission.schema_id,
          schema_version: admission.schema_version,
        },
        specification_ref: refs[0] ?? null,
        mode:
          refs.length === 0
            ? "not_applicable"
            : workflowConstraints.specification_assurance === "reviewed_definition"
              ? "reviewed_definition"
              : "semantic_only",
      });
    } else if (existing !== undefined && (skillName === "research" || skillName === "decide")) {
      assertExistingInputAdmission({
        service,
        existing,
        registration: ingress.registration,
        goal: params.goal,
        constraints: workflowConstraints,
        inputArtifacts: nativeInputs,
      });
    } else if (nativeInputs !== undefined && existing !== undefined) {
      throw new Error(
        `run '${runId}' already exists; input_artifacts cannot be changed on recovery`
      );
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
        signal,
        onOrchestrationProgress
      );
    } else if (existing !== undefined) {
      directive = await service.execute(
        {
          schema_version: 2,
          action: "recover",
          identity,
        },
        signal,
        onOrchestrationProgress
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
        signal,
        onOrchestrationProgress
      );
    }

    // The returned directive is durable engine truth; an aborted signal must not
    // hide a terminal that settled during execution.
    const currentRun = service.checkpointer.loadRunById(runId);
    const inputAssuranceRef = currentRun?.selectedArtifacts.find(
      (ref) => ref.kind === "composition-assurance"
    );
    const inputAssurance =
      inputAssuranceRef === undefined || currentRun === undefined
        ? undefined
        : (() => {
            const { ref, value } = selectedCompositionAssurance(currentRun, service.artifacts);
            return {
              mode: value.mode,
              specification_artifact_id: value.specification_ref?.artifact_id ?? null,
              assurance_ref: ref,
            };
          })();
    const agentsInvoked = service.checkpointer
      .events(runId)
      .map((event) => event.payload.agent)
      .filter((agent): agent is string => typeof agent === "string");

    if (directive.action === "await_user") {
      const nativeUi =
        trustedProject && ctx.hasUI && ctx.mode === "tui"
          ? await hostRuntime.ui?.prepare({ service, directive, projectRoot })
          : undefined;
      serviceRetained = nativeUi !== undefined;
      return {
        success: false,
        session_id: sessionId,
        skill_name: skillName,
        state: directive.state_id,
        requires_approval: false,
        steps_total: agentsInvoked.length,
        agents_invoked: agentsInvoked,
        errors: [],
        ...(inputAssurance === undefined ? {} : { input_assurance: inputAssurance }),
        continuation: {
          kind: "clarification",
          identity: directive.identity,
          gate_id: directive.gate_id,
          challenge: directive.challenge,
          resume_invocation: {
            skill_name: skillName,
            session_id: sessionId,
            goal: params.goal,
            constraints: validateContract(
              Type.Record(Type.String(), JsonValueSchema),
              workflowConstraints,
              "skill resume constraints"
            ),
            ...(inputArtifacts?.artifacts.some((binding) => binding.designation === "context")
              ? {
                  input_artifacts: inputArtifacts.artifacts
                    .filter((binding) => binding.designation !== "context")
                    .map((binding) => binding.ref.artifact_id),
                  context_artifacts: inputArtifacts.artifacts
                    .filter((binding) => binding.designation === "context")
                    .map((binding) => binding.ref.artifact_id),
                }
              : params.input_artifacts === undefined
                ? {}
                : { input_artifacts: params.input_artifacts }),
            ...(params.model === undefined ? {} : { model: params.model }),
          },
        },
        escalation: {
          questions: directive.questions.map((question, index) => ({
            id: question.id,
            label: `Clarification ${index + 1}`,
            prompt: question.prompt,
            options: [],
            allowOther: true,
          })),
          ...(nativeUi === undefined ? {} : { trustedTransportCapability: nativeUi.capability }),
          unknown_reason:
            nativeUi?.text ?? `The TypeScript ${skillName} run requires user clarification.`,
          previous_state: existing?.previousState || undefined,
        },
      };
    }

    if (directive.action === "paused") {
      const pause = parseArtifactDispatchPause(directive);
      return {
        success: false,
        session_id: pause.identity.session_id,
        skill_name: pause.identity.playbook,
        state: pause.state_id,
        requires_approval: false,
        steps_total: agentsInvoked.length,
        agents_invoked: agentsInvoked,
        errors: [],
        retriable: pause.retryable,
        dispatch_pause: pause,
        recovery: pause.recovery,
        ...(inputAssurance === undefined ? {} : { input_assurance: inputAssurance }),
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
      const partialRefValue = directive.result.best_partial_artifact_refs;
      const partialRefs = Array.isArray(partialRefValue)
        ? partialRefValue.map((value) => parseArtifactRef(value))
        : [];
      const repairDiagnostics = directive.result.repair_diagnostics;
      const sealDiagnostics = directive.result.seal_diagnostics;
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
        ...(inputAssurance === undefined ? {} : { input_assurance: inputAssurance }),
        output_artifact_ref: outputRef,
        ...(partialRefs.length > 0 ? { best_partial_artifact_refs: partialRefs } : {}),
        ...(directive.action !== "complete" &&
        directive.met === false &&
        repairDiagnostics !== undefined
          ? { repair_diagnostics: parseRepairDiagnostics(repairDiagnostics) }
          : {}),
        ...(directive.action !== "complete" &&
        directive.met === false &&
        sealDiagnostics !== undefined
          ? { seal_diagnostics: parseSealDiagnostics(sealDiagnostics) }
          : {}),
      };
    }

    throw new Error(`TypeScript orchestration stopped at unexpected action '${directive.action}'`);
  } finally {
    if (!serviceRetained) service.close();
  }
}

/** Admission/recovery binding refusals are failed invocations, never downgraded runs. */
async function executeTypeScriptSkill(
  ...args: Parameters<typeof executeTypeScriptSkillUnchecked>
): Promise<SkillResult> {
  try {
    return await executeTypeScriptSkillUnchecked(...args);
  } catch (error) {
    const code =
      error instanceof CompositionAssuranceAdmissionError
        ? error.refusal.code
        : error instanceof Error &&
            /^(?:SPECIFICATION_(?:ASSURANCE|REVISION)_|SKILL_RECOVERY_BINDING_INVALID:)/u.test(
              error.message
            )
          ? error.message.split(":")[0]
          : undefined;
    if (code === undefined) throw error;
    return {
      success: false,
      session_id: args[1].session_id ?? "",
      skill_name: args[0],
      state: "refused",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: [],
      errors: [code],
    };
  }
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
      "In chain mode, {previous} becomes the prior skill's exact terminal artifact ID; payload bytes are never substituted.",
  }),
  input_artifacts: Type.Optional(InputArtifactIdsSchema),
  context_artifacts: Type.Optional(
    Type.Array(ArtifactIdSchema, {
      uniqueItems: true,
      description:
        "Exact accepted current terminal products as NONBINDING context; never native required inputs, evidence, approval or tool authority",
    })
  ),
  previous_artifact_designation: Type.Optional(
    Type.Union([Type.Literal("binding"), Type.Literal("context")], {
      description:
        "Chain only: explicitly designate the automatic prior terminal as NONBINDING context or native binding input. Default binding preserves typed native ports; no type-based fallback.",
    })
  ),
  session_id: Type.Optional(
    Type.String({
      description: "Override auto-generated session identifier",
    })
  ),
  constraints: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Per-step registered invocation. Define/Plan V2: {schema_version:2,request:<native V1 constraints>,specification_assurance:'reviewed_definition'|'semantic_only'}. Legacy V1 is semantic-only; neither chain position nor artifact slot upgrades it.",
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
      description:
        "Override the failed step's caller-admitted constraints; Define/Plan V2 assurance must remain explicit. A V1 override requests semantic-only. Host liveness and inactivity controls cannot be raised here.",
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
  context_artifacts: Type.Optional(
    Type.Array(ArtifactIdSchema, {
      uniqueItems: true,
      description:
        "Exact accepted current terminal products as NONBINDING context; never native required inputs, evidence, approval or tool authority",
    })
  ),
  session_id: Type.Optional(
    Type.String({
      description: "Unique session identifier (auto-generated if not provided)",
    })
  ),
  constraints: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Registered invocation constraints. Define/Plan V2 requires {schema_version:2,request:<native V1 constraints>,specification_assurance:'reviewed_definition'|'semantic_only'}. V1 means semantic-only; strict policy never comes from {previous}, slot or producer name.",
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
    context_artifacts?: string[];
    previous_artifact_designation?: "binding" | "context";
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: SkillToolUpdate | undefined,
  ingressResolver: SkillIngressResolver = resolveSkillIngress,
  hostRuntime: SkillInvocationRuntime = {}
): Promise<SkillResult> {
  if (skills.some((skill) => skill.previous_artifact_designation !== undefined))
    throw new Error("previous_artifact_designation is only valid for a chain step");
  const parallelSessionId = `parallel-${Date.now()}`;
  let finished = 0;
  const total = skills.length;
  const active = new Map<number, SkillRunProgress>();
  const emitAggregate = (
    stage: SkillProgressDetails["stage"],
    latest?: { readonly index: number; readonly progress: SkillRunProgress }
  ): void => {
    const activeSkills: ActiveSkillProgress[] = [...active.entries()].map(([index, progress]) => ({
      index,
      skill_name: progress.skill_name,
      ...(progress.state_id ? { state_id: progress.state_id } : {}),
      agents: progress.agents ?? [],
    }));
    const activeText = [...active.entries()]
      .map(([index, progress]) => `${index + 1}:${progress.message}`)
      .join(" · ");
    const statusText = activeText
      ? ` · ${activeText}`
      : finished === 0
        ? ` · preparing ${total} skills`
        : "";
    emitSkillProgress(onUpdate, {
      kind: "progress",
      mode: "parallel",
      stage,
      message: `Parallel ${finished}/${total} finished${statusText}`,
      skill_name: "parallel",
      session_id: parallelSessionId,
      skills_finished: finished,
      skills_total: total,
      active_skills: activeSkills,
      ...(latest?.progress.state_id ? { state_id: latest.progress.state_id } : {}),
      ...(latest?.progress.agents ? { agents: latest.progress.agents } : {}),
    });
  };

  emitAggregate("composition_started");
  const results = await mapWithConcurrencyLimit(
    skills,
    MAX_PARALLEL_SKILLS,
    async (skill, index) => {
      const result = await executeTypeScriptSkill(
        skill.skill_name,
        {
          goal: skill.goal,
          input_artifacts: skill.input_artifacts,
          context_artifacts: skill.context_artifacts,
          previous_artifact_designation: skill.previous_artifact_designation,
          session_id: skill.session_id,
          constraints: skill.constraints,
          model: skill.model,
        },
        cwd,
        signal,
        ctx,
        (progress) => {
          active.set(index, progress);
          emitAggregate(progress.stage, { index, progress });
        },
        ingressResolver,
        hostRuntime
      );
      active.delete(index);
      finished += 1;
      emitAggregate("item_finished");
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
    context_artifacts?: string[];
    previous_artifact_designation?: "binding" | "context";
    session_id?: string;
    constraints?: Record<string, unknown>;
    model?: string;
  }>,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: SkillToolUpdate | undefined,
  resumeFrom?: string,
  stepOverrides?: Record<number, { goal?: string; constraints?: Record<string, unknown> }>,
  ingressResolver: SkillIngressResolver = resolveSkillIngress,
  hostRuntime: SkillInvocationRuntime = {}
): Promise<SkillResult> {
  const results: SkillResult[] = [];
  let startStep = 0;
  let chainSessionId: string;
  let checkpoint: ChainCheckpoint;
  let previousHandoffRef: ReturnType<typeof parseArtifactRef> | undefined;
  let finalOutputRef: ReturnType<typeof parseArtifactRef> | undefined;
  const projectRoot = path.resolve(cwd);
  const projectState = resolvePennyRuntimeState(projectRoot, { env: process.env });
  const progressMode: SkillProgressMode = resumeFrom ? "resume" : "chain";

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
    for (const storedStep of recovered.steps) {
      const resolved = ingressResolver({
        projectRoot,
        skillsDir: config.skillsDir,
        name: storedStep.skill_name,
      });
      const missingDigest = storedStep.contract_sha256 === undefined;
      const staleBinding =
        resolved.ok && !missingDigest && storedStep.contract_sha256 !== resolved.contract_sha256;
      if (!resolved.ok || missingDigest || staleBinding) {
        const detail = !resolved.ok
          ? `${resolved.code}: ${resolved.message}`
          : missingDigest
            ? "legacy checkpoint has no immutable contract digest"
            : "checkpoint contract digest is stale";
        return {
          success: false,
          session_id: chainSessionId,
          skill_name: "chain",
          state: "failed",
          requires_approval: false,
          steps_total: recovered.total_steps,
          agents_invoked: [],
          errors: [`Chain registration binding failed at step ${storedStep.index + 1}: ${detail}`],
          mode: "chain",
          chain_step: storedStep.index,
          chain_total: recovered.total_steps,
          chain_session_id: chainSessionId,
          chain_error_step: storedStep.index,
          resumable: true,
        };
      }
    }
    const completedSteps = [...recovered.steps]
      .filter((step) => step.status === "complete")
      .sort((left, right) => left.index - right.index);
    for (const done of completedSteps) {
      if (done.input_assurance !== undefined) {
        const bytes = await readArtifactOutput({
          ref: done.input_assurance.assurance_ref,
          projectRoot,
          env: process.env,
        });
        const value = validateCompositionAssurance(JSON.parse(bytes.toString("utf8")));
        using completedService = new OrchestrationService({
          projectRoot,
          env: process.env,
          playbookName: done.skill_name,
        });
        const completedRun = completedService.checkpointer.loadRunById(done.session_id);
        if (completedRun === undefined)
          throw new Error("skill-chain completed assurance has no run");
        const selected = selectedCompositionAssurance(completedRun, completedService.artifacts);
        if (
          selected.ref.artifact_id !== done.input_assurance.assurance_ref.artifact_id ||
          selected.value.binding_sha256 !== value.binding_sha256 ||
          value.consumer.run_id !== done.session_id ||
          value.consumer.registration_name !== done.skill_name ||
          value.mode !== done.input_assurance.mode ||
          (value.specification_ref?.artifact_id ?? null) !==
            done.input_assurance.specification_artifact_id
        ) {
          throw new Error("skill-chain completed step input assurance is stale");
        }
      }
      results.push({
        ...(done.input_assurance === undefined ? {} : { input_assurance: done.input_assurance }),
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
    emitSkillProgress(onUpdate, {
      kind: "progress",
      mode: "resume",
      stage: "resuming",
      message: `Resuming chain from step ${startStep + 1}/${recovered.total_steps}`,
      skill_name: "chain",
      session_id: chainSessionId,
      skills_finished: startStep,
      skills_total: recovered.total_steps,
      chain_step: startStep,
      chain_total: recovered.total_steps,
    });
  } else {
    chainSessionId = `chain-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const resolvedChain = chain.map((step) => ({
      step,
      resolution: ingressResolver({
        projectRoot,
        skillsDir: config.skillsDir,
        name: step.skill_name,
      }),
    }));
    const refused = resolvedChain.find((item) => !item.resolution.ok);
    if (refused !== undefined && !refused.resolution.ok) {
      return {
        success: false,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "failed",
        requires_approval: false,
        steps_total: chain.length,
        agents_invoked: [],
        errors: [`${refused.resolution.code}: ${refused.resolution.message}`],
        refusal_code: refused.resolution.code,
        mode: "chain",
        chain_step: resolvedChain.indexOf(refused),
        chain_total: chain.length,
        chain_session_id: chainSessionId,
        chain_error_step: resolvedChain.indexOf(refused),
        resumable: false,
      };
    }
    const steps = resolvedChain.map(({ step, resolution }, index) => {
      if (!resolution.ok) throw new Error("resolved chain registration vanished");
      return {
        index,
        skill_name: step.skill_name,
        contract_sha256: resolution.contract_sha256,
        goal: step.goal,
        input_artifacts: step.input_artifacts,
        context_artifacts: step.context_artifacts,
        previous_artifact_designation: step.previous_artifact_designation,
        session_id: step.session_id || `${step.skill_name}-${randomUUID()}`,
        status: "pending" as const,
        model: step.model,
        constraints: step.constraints,
      };
    });
    checkpoint = {
      schema_version: 3,
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
        contract_sha256: step.contract_sha256,
        goal: step.goal,
        input_artifacts: step.input_artifacts,
        context_artifacts: step.context_artifacts,
        previous_artifact_designation: step.previous_artifact_designation,
        session_id: step.session_id,
        model: step.model,
        constraints: step.constraints,
      })),
      created_at: createdAt,
      updated_at: createdAt,
    };
    emitSkillProgress(onUpdate, {
      kind: "progress",
      mode: "chain",
      stage: "composition_started",
      message: `Starting chain with ${steps.length} steps`,
      skill_name: "chain",
      session_id: chainSessionId,
      skills_finished: 0,
      skills_total: steps.length,
      chain_step: 0,
      chain_total: steps.length,
    });
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
          designation: step.previous_artifact_designation ?? "binding",
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

    const previousMarker = chainInputArtifacts?.artifacts[0]?.ref.artifact_id ?? "";
    const resolvedGoal = step.goal.replaceAll("{previous}", previousMarker);
    emitSkillProgress(onUpdate, {
      kind: "progress",
      mode: progressMode,
      stage: "composition_started",
      message: `Chain step ${stepIndex + 1}/${checkpoint.total_steps}: ${step.skill_name}`,
      skill_name: "chain",
      session_id: chainSessionId,
      skills_finished: stepIndex,
      skills_total: checkpoint.total_steps,
      chain_step: stepIndex,
      chain_total: checkpoint.total_steps,
    });

    const result = await executeTypeScriptSkill(
      step.skill_name,
      {
        goal: resolvedGoal,
        input_artifacts: step.input_artifacts,
        context_artifacts: step.context_artifacts,
        previous_artifact_designation: step.previous_artifact_designation,
        session_id: stepEntry.session_id,
        constraints: step.constraints,
        model: step.model,
        chain_input_artifacts: chainInputArtifacts,
      },
      cwd,
      signal,
      ctx,
      (progress) => {
        emitSkillProgress(onUpdate, {
          kind: "progress",
          mode: progressMode,
          stage: progress.stage,
          message: `Chain step ${stepIndex + 1}/${checkpoint.total_steps} · ${progress.message}`,
          skill_name: "chain",
          session_id: chainSessionId,
          ...(progress.state_id ? { state_id: progress.state_id } : {}),
          ...(progress.agents ? { agents: progress.agents } : {}),
          ...(progress.workers_completed === undefined
            ? {}
            : { workers_completed: progress.workers_completed }),
          ...(progress.workers_total === undefined
            ? {}
            : { workers_total: progress.workers_total }),
          ...(progress.boundary_action ? { boundary_action: progress.boundary_action } : {}),
          skills_finished: stepIndex,
          skills_total: checkpoint.total_steps,
          chain_step: stepIndex,
          chain_total: checkpoint.total_steps,
        });
      },
      ingressResolver,
      hostRuntime
    );
    result.mode = "chain";
    // Chain transport is artifact/checkpoint-only; legacy playbook rooms are
    // neither exposed nor retained as chain authority.
    result.session_room = undefined;
    result.chain_step = stepIndex;
    result.chain_total = checkpoint.total_steps;
    result.chain_session_id = chainSessionId;
    results.push(result);

    if (!result.success && result.dispatch_pause) {
      const recovery = result.dispatch_pause.recovery;
      const chainCanResume = recovery.kind !== "saved_but_ineligible";
      // Dispatch pauses preserve exact owner facts. Recoverable runs and unstarted
      // steps remain pending; an ineligible saved run is retained but never called resumable.
      stepEntry.status = chainCanResume ? "running" : "failed";
      if (chainCanResume) {
        delete stepEntry.error;
        delete stepEntry.error_detail;
      } else {
        stepEntry.error = `${result.dispatch_pause.code}: ${result.dispatch_pause.reason}`;
      }
      checkpoint.chain_status = chainCanResume ? "running" : "failed";
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
        resumable: chainCanResume,
        retriable: result.dispatch_pause.retryable,
        dispatch_pause: result.dispatch_pause,
        recovery,
        ...(result.input_assurance === undefined
          ? {}
          : { input_assurance: result.input_assurance }),
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
      emitSkillProgress(onUpdate, {
        kind: "progress",
        mode: progressMode,
        stage: "item_finished",
        message: `Chain step ${stepIndex + 1}/${checkpoint.total_steps} stopped: ${step.skill_name}`,
        skill_name: "chain",
        session_id: chainSessionId,
        skills_finished: stepIndex + 1,
        skills_total: checkpoint.total_steps,
        chain_step: stepIndex,
        chain_total: checkpoint.total_steps,
      });

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
          ...(result.input_assurance === undefined
            ? {}
            : { input_assurance: result.input_assurance }),
          output_artifact_ref: finalOutputRef,
          continuation: result.continuation,
          escalation: {
            questions: escalation.questions,
            ...(escalation.trustedTransportCapability === undefined
              ? {}
              : { trustedTransportCapability: escalation.trustedTransportCapability }),
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
        requires_approval: false,
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
        chain_results: results,
        resumable: true,
        output_artifact_ref: result.output_artifact_ref ?? finalOutputRef,
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
    stepEntry.input_assurance = result.input_assurance;
    stepEntry.output_artifact_ref = terminalRef;
    stepEntry.handoff_artifact_ref = handoffRef;
    previousHandoffRef = handoffRef;
    checkpoint.pending_steps = checkpoint.pending_steps.filter(
      (pending) => pending.index !== stepIndex
    );
    saveChainCheckpoint(checkpoint, projectRoot, process.env);
    emitSkillProgress(onUpdate, {
      kind: "progress",
      mode: progressMode,
      stage: "item_finished",
      message: `Chain step ${stepIndex + 1}/${checkpoint.total_steps} completed: ${step.skill_name}`,
      skill_name: "chain",
      session_id: chainSessionId,
      skills_finished: stepIndex + 1,
      skills_total: checkpoint.total_steps,
      chain_step: stepIndex,
      chain_total: checkpoint.total_steps,
    });
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

/** Private host construction. Never read from model-visible tool parameters, discovered
 * package frontmatter, environment guesses or persisted workflow data. */
export interface SkillExtensionRuntimeOptions {
  readonly videogen?: VideogenRuntimeProvidersV1;
}

interface SkillInvocationRuntime extends SkillExtensionRuntimeOptions {
  readonly ui?: PlaybookUiOwner;
}

export interface SkillExtensionTestDependencies {
  /** TEST-ONLY registry/config resolution seam for deterministic generic-ingress E2E coverage. */
  readonly skillIngressResolver?: SkillIngressResolver;
  /**
   * TEST-ONLY deterministic KB phase runner. The registered adapter still builds
   * the production KbWorkerClient, private readers, artifact store, worker
   * executor, and engine; this seam replaces only the live provider call.
   */
  readonly kbAgentRunner?: KbAgentRunner;
}

export default function skillExtension(
  pi: ExtensionAPI,
  testDependencies: SkillExtensionTestDependencies = {},
  hostRuntime: SkillExtensionRuntimeOptions = {}
): void {
  const ui = new PlaybookUiOwner();
  const invocationRuntime: SkillInvocationRuntime = { ...hostRuntime, ui };
  pi.on("session_shutdown", () => ui.close());
  config = {
    skillsDir:
      process.env.PENNY_SKILLS_DIR ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), ".pi", "skills"),
  };

  const discoveredSkills = discoverSkills();
  const ingressResolver: SkillIngressResolver =
    testDependencies.skillIngressResolver ??
    ((input) =>
      resolveSkillIngress({
        ...input,
        skillsDir: config.skillsDir,
        discoveredSkills,
      }));

  // The parsed disable flag alone controls Penny's model-facing listing.
  // Pi discovers all packages normally and filters its own model advertising by that flag.
  const skills = modelInvocableSkills(discoveredSkills);

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
  ): Promise<{
    readonly result: SkillResult;
    readonly terminalImage?: { readonly ref: ArtifactRef; readonly bytes: Buffer };
  }> => {
    const refs = [
      ...(result.output_artifact_ref ? [result.output_artifact_ref] : []),
      ...(result.best_partial_artifact_refs ?? []),
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
    let terminalImage: { readonly ref: ArtifactRef; readonly bytes: Buffer } | undefined;
    for (const ref of new Map(refs.map((value) => [value.artifact_id, value])).values()) {
      const parsedRef = ref as ArtifactRef;
      const bytes = await readArtifactOutput({
        ref: parsedRef,
        projectRoot,
        env: process.env,
      });
      if (
        result.success &&
        result.output_artifact_ref?.artifact_id === parsedRef.artifact_id &&
        parsedRef.media_type === "image/png"
      ) {
        terminalImage = { ref: parsedRef, bytes };
      }
    }
    return {
      result,
      ...(terminalImage === undefined ? {} : { terminalImage }),
    };
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
      const orch = await import("@penny/orchestration");
      const hostSessionId = currentSessionId ?? "";
      const hostInvocationId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : `call-${randomUUID()}`;
      let resolvedProfile;
      let hostGrantRoot: string;
      try {
        const projectState = resolvePennyRuntimeState(projectRoot);
        hostGrantRoot = projectState.paths.knowledgeBase.hostGrants;
        resolvedProfile = orch.resolveGrantedProfile({
          profileId,
          sessionId: hostSessionId,
          registryPath: projectState.paths.knowledgeBase.profiles,
          grantStoreDir: hostGrantRoot,
        });
      } catch (error) {
        const stateFailure =
          error instanceof PennyStateResolutionError ? stateFailureDiagnostic(error) : undefined;
        logger.warn("kb_profile_admission_refused", {
          errorCode:
            error instanceof PennyStateResolutionError
              ? error.code
              : "KB_PROFILE_ADMISSION_REFUSED",
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
          warnings: [stateFailure ?? "profile_not_authorized"],
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
      let hostContext: import("@penny/orchestration").KbHostInvocationContextV1 | undefined;
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
              maxIterations: custody.config.maxIterations,
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
              ...(rawParams["query_context"] !== undefined
                ? { query_context: rawParams["query_context"] }
                : {}),
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
              maxIterations: custodyService.config.maxIterations,
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
            const directive = await executionService.execute(
              {
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
              },
              _signal
            );
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
              const partialHandles = Array.isArray(result["best_partial_artifact_handles"])
                ? result["best_partial_artifact_handles"].filter(isKnowledgeBaseArtifactHandle)
                : [];
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
                  : result["public_status"] === "refused"
                    ? "refused"
                    : result["public_status"] === "cancelled"
                      ? "cancelled"
                      : result["public_status"] === "exhausted"
                        ? "exhausted"
                        : "complete",
                met,
                ids: [
                  queryRunId,
                  ...pageIds,
                  ...(answerArtifactId.length > 0 ? [answerArtifactId] : []),
                ],
                counts: { candidates: Number(result["candidate_count"] ?? 0) },
                artifacts: handle ? [handle] : partialHandles,
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
            const answerHandle = kbResult.artifacts[0];
            if (!isRecord(answerHandle) || typeof answerHandle.artifact_id !== "string") {
              throw new Error("invalid sealed answer artifact handle");
            }
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
              maxIterations: custody.config.maxIterations,
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
              maxIterations: custody.config.maxIterations,
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
            const directive = await service.execute(
              {
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
              },
              _signal
            );
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
              maxIterations: custody.config.maxIterations,
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
            const directive = await service.execute(
              {
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
              },
              _signal
            );
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
            maxIterations: promoteService.config.maxIterations,
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
            const directive = await promoteService.execute(
              {
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
              },
              _signal
            );
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

  registerTool<typeof SkillParams, SkillToolDetails>(pi, {
    name: "skill",
    label: "Invoke Skill",
    description: [
      "Invoke a skill with durable TypeScript state-machine orchestration.",
      "Skills define workflows (phases, transitions, subagent order).",
      "Penny decides WHEN to invoke; skills decide HOW to execute.",
      "Exact agent output is owner-persisted and re-read before SUMMARY routing; single and step inputs may include exact IDs from any run.",
      "Use for engine-backed skills whose listed description matches the task or whose model-hidden contract the user explicitly invokes; do not use for a skill with a dedicated typed Pi-tool entrypoint such as knowledge_base.",
      "Use a registered skill name from Pi's <available_skills> system catalog or an explicitly user-invoked model-hidden /skill:<name> contract; descriptions are not repeated here. Before invoking an unfamiliar generic skill, read its SKILL.md Invocation contract (already supplied by native command expansion when explicitly invoked) and supply only its compatible fields. Hidden visibility does not grant registration, private activation, approval or execution authority.",
      "",
      "Modes:",
      "  - Single:  skill({ skill_name, goal })",
      "  - Parallel: skill({ skills: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_PARALLEL_SKILLS} concurrent skills. Each skill runs independently.`,
      "  - Chain:   skill({ chain: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_CHAIN_STEPS} steps. {previous} points to the prior terminal ID; each step may add native input_artifacts and NONBINDING context_artifacts. Set previous_artifact_designation: context to use the automatic predecessor as context (default binding).`,
      "    Stops on first error — use resume_chain to recover from the failed step.",
      "  - Resume:  skill({ resume_chain: chain_session_id, step_overrides?: {...} })",
      "    Skips completed steps, resumes from the failed step.",
    ].join("\n"),
    parameters: SkillParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Every final public result, including early errors, crosses the shared
      // parser before formatting/readback. Rejection is a communication failure;
      // never truncate or return a permissive replacement. Durable engine and
      // chain checkpoints/artifacts remain available for exact recovery.
      const textResult = (value: SkillResult) => {
        const details = parseCurrentSkillResult(value);
        return {
          content: [
            {
              type: "text" as const,
              text: formatResult(details, ctx.ui.theme.fg.bind(ctx.ui.theme)),
            },
          ],
          details,
        };
      };
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
        return textResult(errorResult);
      }

      let result: SkillResult;

      try {
        resolvePennyRuntimeState(path.resolve(ctx.cwd), { env: process.env });
      } catch (error) {
        if (!(error instanceof PennyStateResolutionError)) throw error;
        const errorResult: SkillResult = {
          success: false,
          session_id: params.session_id ?? "",
          skill_name: params.skill_name ?? detected.mode,
          state: "error",
          requires_approval: false,
          steps_total: 0,
          agents_invoked: [],
          errors: [stateFailureDiagnostic(error)],
          state_failure: {
            code: error.code,
            details: {
              component: error.details.component ?? "state",
              ...(error.details.recoveryAction === undefined
                ? {}
                : { recoveryAction: error.details.recoveryAction }),
              ...(error.details.actualSchemaVersion === undefined
                ? {}
                : { actualSchemaVersion: error.details.actualSchemaVersion }),
              ...(error.details.requiredSchemaVersion === undefined
                ? {}
                : { requiredSchemaVersion: error.details.requiredSchemaVersion }),
              ...(error.details.upgradeSupported === undefined
                ? {}
                : { upgradeSupported: error.details.upgradeSupported }),
            },
          },
          ...(detected.mode === "single" ? { mode: "single" as const } : {}),
          ...(detected.mode === "parallel" ? { mode: "parallel" as const } : {}),
          ...(detected.mode === "chain" || detected.mode === "resume"
            ? { mode: "chain" as const }
            : {}),
        };
        return textResult(errorResult);
      }

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
            context_artifacts: params.context_artifacts,
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
            (progress) => {
              emitSkillProgress(onUpdate, {
                kind: "progress",
                mode: "single",
                ...progress,
              });
            },
            ingressResolver,
            invocationRuntime
          );
          result.mode = "single";
          break;
        }
        case "parallel": {
          const parallelSkills = (params.skills ?? []).map((step) => ({
            ...step,
            model: step.model ?? params.model,
          }));
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
            return textResult(errResult);
          }
          result = await executeSkillsParallel(
            parallelSkills,
            ctx.cwd,
            signal,
            ctx,
            onUpdate,
            ingressResolver,
            invocationRuntime
          );
          break;
        }
        case "chain": {
          const chainSteps = (params.chain ?? []).map((step) => ({
            ...step,
            model: step.model ?? params.model,
          }));
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
            return textResult(errResult);
          }
          result = await executeSkillsChain(
            chainSteps,
            ctx.cwd,
            signal,
            ctx,
            onUpdate,
            undefined,
            undefined,
            ingressResolver,
            invocationRuntime
          );
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
            params.step_overrides,
            ingressResolver,
            invocationRuntime
          );
          break;
        }
        default:
          throw new Error(`Unknown mode: ${String(detected.mode)}`);
      }

      const verified = await verifyTerminalArtifact(parseCurrentSkillResult(result), ctx.cwd);
      if (verified.terminalImage !== undefined) {
        const presentation = terminalImagePresentation({
          skillName: verified.result.skill_name,
          ref: verified.terminalImage.ref,
          bytes: verified.terminalImage.bytes,
          limits: resolvePngMediaLimits(process.env),
        });
        return {
          content: presentation.content,
          details: verified.result,
        };
      }
      return textResult(verified.result);
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
      result: AgentToolResult<SkillToolDetails | undefined>,
      { expanded, isPartial }: ToolRenderResultOptions,
      theme: Theme
    ) {
      const details = result.details;
      if (isSkillProgressDetails(details)) {
        if (details.stage === "worker_failed") {
          return new Text(theme.fg("error", `Stopping · ${details.message}`), 0, 0);
        }
        if (details.stage === "boundary_reached") {
          if (details.boundary_action === "complete") {
            return new Text(theme.fg("accent", `Finalizing · ${details.message}`), 0, 0);
          }
          if (details.boundary_action === "await_user" || details.boundary_action === "paused") {
            return new Text(theme.fg("warning", `Paused · ${details.message}`), 0, 0);
          }
          if (details.boundary_action === "status") {
            return new Text(theme.fg("accent", `Status · ${details.message}`), 0, 0);
          }
          return new Text(theme.fg("error", `Stopped · ${details.message}`), 0, 0);
        }
        return new Text(theme.fg("accent", `Running · ${details.message}`), 0, 0);
      }
      if (isPartial || !details) {
        const text = result.content.find((item) => item.type === "text");
        return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Running…"), 0, 0);
      }
      if (details.dispatch_pause) {
        return new Text(formatResult(details, theme.fg.bind(theme)), 0, 0);
      }

      // All clarification views share the public text formatter: rendering is read-only and
      // cannot consume/rebind a branch's one-time trusted questionnaire capability.
      if (expanded && details.escalation) {
        return new Text(formatResult(details, theme.fg.bind(theme)), 0, 0);
      }

      // ── Parallel mode ──
      if (details.mode === "parallel" && details.parallel_results) {
        const waiting = details.parallel_results.filter(
          (item) => item.continuation !== undefined
        ).length;
        if (expanded && waiting > 0)
          return new Text(formatResult(details, theme.fg.bind(theme)), 0, 0);
        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              theme.fg(
                details.success ? "success" : "warning",
                `${details.success ? "✓" : "⚠"} ${details.parallel_results.length} skills`
              ),
              0,
              0
            )
          );
          container.addChild(new Text(theme.fg("muted", `Session: ${details.session_id}`), 0, 0));
          container.addChild(new Spacer(1));
          for (const child of details.parallel_results) {
            const icon = child.success ? "✓" : child.dispatch_pause ? "⏸" : "✗";
            const color = child.success ? "success" : child.dispatch_pause ? "warning" : "error";
            container.addChild(new Text(theme.fg(color, `  ${icon} ${child.skill_name}`), 0, 0));
            container.addChild(new Text(theme.fg("muted", `     ${child.session_id}`), 0, 0));
            if (child.dispatch_pause) {
              container.addChild(
                new Text(
                  theme.fg("muted", `     ${child.dispatch_pause.code}: ${child.state}`),
                  0,
                  0
                )
              );
            }
            if (!child.success && child.seal_diagnostics) {
              container.addChild(
                new Text(formatSealDiagnostics(child, theme.fg.bind(theme)), 0, 0)
              );
            }
          }
          return container;
        }
        const paused = details.parallel_results.filter((item) => item.dispatch_pause).length;
        const pending = waiting + paused;
        const status = details.success ? "✓" : pending > 0 ? "⏸" : "✗";
        return new Text(
          theme.fg(
            details.success ? "success" : pending > 0 ? "warning" : "error",
            waiting > 0
              ? `${status} ${waiting}/${details.parallel_results.length} awaiting user input — expand for branch questionnaires`
              : paused > 0
                ? `${status} ${paused}/${details.parallel_results.length} dispatch paused`
                : `${status} ${details.parallel_results.length} skills`
          ),
          0,
          0
        );
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
            container.addChild(new Text(theme.fg("muted", "Chain steps:"), 0, 0));
            for (const r of details.chain_results) {
              container.addChild(
                new Text(
                  theme.fg(
                    r.success ? "text" : "warning",
                    `  ${r.success ? "✓" : "✗"} step ${(r.chain_step ?? 0) + 1}: ${r.skill_name}`
                  ),
                  0,
                  0
                )
              );
              if (!r.success && r.seal_diagnostics) {
                container.addChild(new Text(formatSealDiagnostics(r, theme.fg.bind(theme)), 0, 0));
              }
            }
          }
        }
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

/** A host may register this factory with explicit project-bound private videogen providers.
 * The default extension can also load the explicit private runtime manifest from the host
 * environment. With neither binding, videogen refuses before run creation. */
export function createSkillExtension(
  hostRuntime: SkillExtensionRuntimeOptions
): (pi: ExtensionAPI) => void {
  return (pi) => skillExtension(pi, {}, hostRuntime);
}
