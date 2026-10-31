import {
  enforceNativeAutoCompaction,
  createCompactionProgressObserver,
  type CompactionProgressObserver,
} from "../../../.pi/lib/compaction-policy.mjs";
import {
  buildCatalogPrompt,
  catalogRoleBody,
  loadPromptDocumentation,
  verifyPromptDocumentation,
  verifyStaticPromptSourceBindings,
  type StaticDocumentSource,
} from "./catalog-prompt.js";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
  type EventBus,
  getAgentDir,
  parseSessionEntries,
  parseFrontmatter,
  resolveCliModel,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
export type { InlineExtension };

import { canonicalJson, sha256 } from "./checkpointer.js";
import type { WorkerActivityClassV1 } from "./child-workflows/contracts.js";
import {
  assertRegisteredBrowserPolicyCarrier,
  registeredBrowserPolicyOwnerScopeId,
} from "./browser-policy-carrier.js";
import {
  ContractValidationError,
  ArtifactRefSchema,
  LivenessTerminalReasonSchema,
  validateContract,
  type ArtifactRef,
  type Confidence,
  type JsonValue,
  type LivenessTerminalReason,
  type SkillContract,
} from "./contracts.js";
import { LivenessExhaustedError, type WorkerPromptBudget } from "./liveness.js";
import {
  admitImageInputModel,
  recheckImageInputModel,
  type ModelImageCapabilityEvidenceV1,
} from "./model-vision.js";
import {
  PhaseResultProjectionDeclarationV1Schema,
  type PhaseResultProjectionDeclarationV1,
} from "./phase-result-projection.js";
import { isProviderOpeningGuardId } from "./provider-opening-guard.js";
import type { ResearchContextOverlay } from "./research-context.js";
import {
  assertResolvedModelIdentity,
  validateRequiredModelIdentity,
  type RequiredModelIdentityV1,
} from "./required-model.js";
import {
  assertOwnerDirectory,
  assertOwnerFile,
  ensureOwnerDirectory,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./state/custody.js";
import { PROJECT_ID_PATTERN } from "./state/paths.js";

type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type PiModel = NonNullable<CreateSessionOptions["model"]>;
type PiCustomTool = NonNullable<CreateSessionOptions["customTools"]>[number];
export type SessionThinkingLevel = NonNullable<CreateSessionOptions["thinkingLevel"]>;

/** Exact generic-child YAML authority bound before a worker reaches this client. */
export interface GenericChildCatalogAgentYamlMaximumCarrierV1 {
  readonly carrier: "catalog_agent_yaml_maximum";
  /** Null preserves an unbound template and must never be upgraded from a later filesystem read. */
  readonly allowed_tools: readonly string[] | null;
}

export interface ActiveWorkerRegistrationMetadataV1 {
  readonly playbook_name: string;
  readonly workflow_name: string;
  readonly guidance: SkillContract["guidance"];
  readonly documentation_sources?: readonly StaticDocumentSource[];
  readonly prompt_sources?: readonly StaticDocumentSource[];
  readonly result_transport: "persisted_summary" | "host_typed";
  /** Exact active phase declaration; absent preserves the model-authored SUMMARY opening. */
  readonly result_projection?: PhaseResultProjectionDeclarationV1;
  readonly opening_policy: "registration_guidance_task_artifacts" | "host_private_opening" | "none";
  readonly model_policy:
    | "directive_override_or_runtime_default"
    | "host_private_ssot_model"
    | "none";
  /**
   * Exact phase surface projected from the active PlaybookRegistration. Absence preserves
   * YAML equality; presence is the registration-digest-bound strict subset revalidated here.
   */
  readonly allowed_tools?: readonly string[];
  /** Registration-bound final-opening authorization policy for an explicit zero-tool phase. */
  readonly provider_opening_guard?:
    | "sca_p04_payload_disclosure_v1"
    | "sca_p05_payload_disclosure_v1"
    | "sca_p06_payload_disclosure_v1"
    | "sca_p08_payload_disclosure_v1"
    | "sca_p10_payload_disclosure_v1"
    | "sca_p11_payload_disclosure_v1";
  /**
   * Present only for a generic-child YAML-maximum phase. Absence means no such carrier; a present
   * null snapshot means registration binding was unbound and must fail closed.
   */
  readonly generic_child_yaml_authority?: GenericChildCatalogAgentYamlMaximumCarrierV1;
  /** Exact immutable phase policy; only WorkerExecutor may project it from registration. */
  readonly browser_network_allowlist?: readonly string[];
  /** Optional prompt filename state for internal fan-branch execution states. */
  readonly guidance_state_id?: string;
  /** Registration-owned exact model identity; no catalog default or fallback is permitted. */
  readonly required_model?: RequiredModelIdentityV1;
  /** Registration-bound demand for positive image-input metadata before every model prompt. */
  readonly requires_image_input?: true;
}

export interface WorkflowSessionCorrelationV1 {
  readonly run_id: string;
  readonly workflow_session_id: string;
  readonly branch_id: string | null;
  readonly attempt: number;
  readonly worker_id: string;
  readonly purpose: "phase" | "routing_repair";
}

export const CATALOG_WORKER_SESSION_METADATA = "penny.orchestration.worker-session" as const;
export const CATALOG_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const CatalogSessionIdSchema = Type.String({ minLength: 1, maxLength: 256 });

/** Closed path-free correlation stored as the first entry in every catalog-worker JSONL. */
export const CatalogWorkerSessionMetadataV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    run_id: CatalogSessionIdSchema,
    workflow_session_id: CatalogSessionIdSchema,
    state_id: CatalogSessionIdSchema,
    branch_id: Type.Union([CatalogSessionIdSchema, Type.Null()]),
    attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    worker_id: CatalogSessionIdSchema,
    agent: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,127}$" }),
    purpose: Type.Union([Type.Literal("phase"), Type.Literal("routing_repair")]),
  },
  { additionalProperties: false }
);
export type CatalogWorkerSessionMetadataV1 = Readonly<
  Static<typeof CatalogWorkerSessionMetadataV1Schema>
>;

export const CATALOG_WORKER_CONTINUITY_METADATA = "penny.orchestration.worker-continuity" as const;
export const CATALOG_WORKER_CONTINUITY_OPENING_MAX_CHARACTERS = 1_048_576 as const;

/**
 * Closed, path-free assignment material appended before the first model prompt.
 * The correlation entry remains V1 and unchanged for retention/catalog compatibility;
 * compaction consumes this companion only when both entries validate and bind exactly.
 */
export const CatalogWorkerContinuityMetadataV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    run_id: CatalogSessionIdSchema,
    workflow_session_id: CatalogSessionIdSchema,
    state_id: CatalogSessionIdSchema,
    branch_id: Type.Union([CatalogSessionIdSchema, Type.Null()]),
    attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    worker_id: CatalogSessionIdSchema,
    agent: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,127}$" }),
    purpose: Type.Union([Type.Literal("phase"), Type.Literal("routing_repair")]),
    task: Type.String({ minLength: 1, maxLength: 131_072 }),
    registered_guidance: Type.String({ minLength: 1, maxLength: 262_144 }),
    input_artifacts: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    compaction_continuity: Type.Union([
      Type.Object(
        {
          mode: Type.Literal("exact_opening"),
          opening: Type.String({
            minLength: 1,
            maxLength: CATALOG_WORKER_CONTINUITY_OPENING_MAX_CHARACTERS,
          }),
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          mode: Type.Literal("pi_default_private_context"),
          reason: Type.Literal("owner_resolved_context_present"),
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);
export type CatalogWorkerContinuityMetadataV1 = Readonly<
  Static<typeof CatalogWorkerContinuityMetadataV1Schema>
>;

export function validateCatalogWorkerSessionMetadata(
  value: unknown
): CatalogWorkerSessionMetadataV1 {
  return validateContract(
    CatalogWorkerSessionMetadataV1Schema,
    value,
    "catalog worker session metadata"
  );
}

export function validateCatalogWorkerContinuityMetadata(
  value: unknown
): CatalogWorkerContinuityMetadataV1 {
  return validateContract(
    CatalogWorkerContinuityMetadataV1Schema,
    value,
    "catalog worker continuity metadata"
  );
}

export interface AgentInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly task: string;
  readonly projectRoot: string;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly inputArtifacts: readonly ArtifactRef[];
  /** Required production correlation for every durable catalog-worker JSONL. */
  readonly workflowSession?: WorkflowSessionCorrelationV1;
  /** Summary-only guidance mechanically projected from the active phase registration. */
  readonly routingRepairGuidance?: string;
  readonly executionPurpose?: "phase" | "routing_repair";
  /**
   * Bounded owner-resolved content plus use-time validation metadata. WorkerExecutor supplies
   * this only after its cancellable resolver Promise has passed the host-owned inactivity lease.
   */
  readonly contextOverlays?: readonly ResearchContextOverlay[];
  readonly signal?: AbortSignal;
  /** Host-enforced, non-observational charge sink. Errors abort before admission. */
  readonly liveness?: AgentSessionLivenessSink;
  /** Read-only projection of the host-enforced counters for this open worker lease. */
  readonly livenessBudget?: WorkerPromptBudget;
  readonly modelOverride?: string;
  /**
   * Exact positive image-input evidence captured at admission. When present, an explicit override
   * is checked before session creation and every created session is checked again before prompt.
   */
  readonly requiredImageCapability?: ModelImageCapabilityEvidenceV1;
  /** Host-owned policy (including Research presets), ahead of test and catalog/settings defaults. */
  readonly thinkingLevel?: SessionThinkingLevel;
  /**
   * Pre-session admission hook.
   *
   * Called with the model the runtime actually RESOLVED, immediately before the
   * session is created. Throwing denies the invocation with no session created
   * and no private input read — which is what lets a caller enforce a policy
   * that must hold "before `createAgentSession`" rather than after it.
   *
   * A resolved identity is required whenever this hook is supplied: if no model
   * could be resolved there is nothing to admit, and the invocation is denied
   * rather than run on an unadmitted default.
   */
  readonly admitResolvedModel?: (resolved: { provider: string; model: string }) => void;
  /**
   * Lazily materialized provider-visible appendix. Pi calls this only after final session-model and
   * tool-surface checks, immediately before serializing the complete opening.
   */
  readonly providerOpeningAppendix?: () => string;
  /**
   * Durable dispatch fence. Pi supplies the exact complete opening immediately before the first
   * provider prompt. Throwing proves that no prompt was dispatched by this invocation.
   */
  readonly guardModelDispatch?: (serializedOpening: string) => void;
  /**
   * Post-creation, pre-prompt binding for host controls that need Pi's actual session model when
   * no explicit override was supplied. Unlike admitResolvedModel, this does not authorize session
   * creation; throwing closes the created session before any model invocation.
   */
  readonly bindResolvedSessionModel?: (resolved: { provider: string; model: string }) => void;
  /** W6: bounded metadata projected from the exact active playbook registration. */
  readonly registration: ActiveWorkerRegistrationMetadataV1;
  /**
   * Optional session posture supplied by the dispatching playbook.
   *
   * Catalog agents never use this private-session seam. Ordinary catalog phases
   * use either exact YAML equality or an exact registration-bound strict subset
   * of that YAML maximum. This seam remains only for explicitly anonymous
   * private host sessions such as the KB reader matrix.
   */
  readonly session?: AgentSessionSpecV1;
}

/**
 * A dispatcher-supplied session posture.
 *
 * The tools are closures over the dispatcher's own private state (a KB phase's
 * admitted-source allowlist, for instance), so they cannot be constructed here;
 * the dispatcher passes them in ready-made and this client remains agnostic
 * about their domain.
 */
export interface AgentSessionSpecV1 {
  /** Explicit SDK suppression posture for anonymous private sessions only. */
  readonly noTools?: "all" | "builtin";
  /** Exact active tool-name allowlist; required with KB `noTools: "all"`. */
  readonly tools?: readonly string[];
  /** Host-closed SDK tools for an anonymous non-catalog session. */
  readonly customTools?: readonly PiCustomTool[];
  /**
   * Exact isolated system content. When present, the runner creates an
   * in-memory-settings ResourceLoader with no extensions, skills, templates,
   * themes, context files, project settings, or global settings.
   */
  readonly isolatedSystemPrompt?: string;
  /** Complete opening prompt, replacing the default research opening. */
  readonly opening?: string;
  /**
   * Reads the dispatcher's captured result after the turn ends. Returning
   * `undefined` means the agent never satisfied the contract, which is a hard
   * failure rather than a prose fallback.
   */
  readonly readResult?: () => string | undefined;
  /** Failure text used when `readResult` yields nothing. */
  readonly requireResultMessage?: string;
  /** Suppress assistant-text diagnostics because the child can see private bodies. */
  readonly sensitiveOutput?: boolean;
  /**
   * Content-free lifecycle diagnostic sink. The runner projects Pi events into
   * the closed trace record below before invoking it; raw events are never
   * exposed because they contain tool arguments, content, and reasoning.
   */
  readonly trace?: AgentSessionTraceSink;
}

/**
 * W6 — resolved worker posture. YAML is the maximum; only the active TypeScript
 * PlaybookRegistration may bind one fixed strict subset for an orchestration phase.
 */
export interface WorkerPostureV1 {
  readonly agentGuidancePath: string;
  readonly domainGuidancePath: string;
  readonly allowedTools: readonly string[];
}

/**
 * W6 — resolve the domain-guidance file for one agent in one phase.
 *
 * `per_agent` yields `<agent>.md` for legacy/simple skills. `per_agent_phase` yields
 * `<agent>-<phase>.md`, the shared convention for agents that can serve distinct states.
 */
export function resolveDomainGuidancePath(input: {
  projectRoot: string;
  agent: string;
  stateId: string;
  guidance: SkillContract["guidance"];
}): string {
  const guidance = input.guidance;
  const file =
    guidance.resolution === "per_agent_phase"
      ? `${input.agent}-${input.stateId}.md`
      : `${input.agent}.md`;
  return path.join(input.projectRoot, ...guidance.skill_root.split("/"), file);
}

export interface AgentCompletion {
  readonly text: string;
  readonly confidence?: Confidence;
  readonly details?: Record<string, JsonValue>;
}

export interface ModelClient {
  runAgent(invocation: AgentInvocation): Promise<AgentCompletion>;
}

/**
 * Owner-supplied extension factories to load into each worker session (e.g. a
 * worker-read, read-only memory factory). These supply capabilities that need
 * the owner's scoping (actor role, a minimal pinned env). They are NOT a tool
 * allow-list: YAML (`.pi/agents/<agent>.md` `tools:`) remains the maximum and the
 * native agent-runner uses it exactly. An eligible orchestration phase may use only
 * the fixed strict subset projected from its active canonical registration. Extension
 * factories, task data, and runtime state cannot select that surface. The app stays
 * agnostic about the capability's domain.
 */
export interface AgentSessionTokenCountsV1 {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly total: number;
}

export const AGENT_SESSION_PROTOCOL_ERROR_CODES = [
  "schema_invalid",
  "handle_mismatch",
  "reader_ordering",
  "unknown_tool",
  "timeout",
] as const;
export type AgentSessionProtocolErrorCodeV1 = (typeof AGENT_SESSION_PROTOCOL_ERROR_CODES)[number];

/**
 * Closed content-free session trace record.
 *
 * Deliberately absent: tool call IDs/arguments/results, message content,
 * reasoning, provider bodies, raw errors, costs, paths, run IDs, and private data.
 * Error classification can emit only the fixed protocol-code allowlist above.
 */
export type AgentSessionTraceRecordV1 =
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly outcome: "success" | "error";
      readonly error_code?: AgentSessionProtocolErrorCodeV1;
    }
  | {
      readonly kind: "turn";
      readonly name: string;
      readonly outcome: "success" | "error";
      readonly stop_reason:
        | "pending"
        | "stop"
        | "length"
        | "toolUse"
        | "error"
        | "aborted"
        | "deferred";
      readonly token_counts: AgentSessionTokenCountsV1;
    }
  | {
      readonly kind: "protocol_error";
      readonly error_code: AgentSessionProtocolErrorCodeV1;
    };

export type AgentSessionTraceSink = (record: AgentSessionTraceRecordV1) => void;

export interface AgentSessionProgressActivityV1 {
  readonly activity_class: WorkerActivityClassV1;
  readonly observed_units: number;
}

export type AgentSessionLivenessEventV1 =
  | {
      readonly kind: "model_turn";
      readonly source:
        | "turn_start"
        | "auto_retry_start"
        | "summarization_retry_attempt_start"
        | "compaction_start";
    }
  | {
      readonly kind: "tool_call";
      readonly tool_name: string;
      readonly progress?: AgentSessionProgressActivityV1;
    }
  | {
      readonly kind: "protocol_error";
      readonly tool_name: string;
      readonly error_code: AgentSessionProtocolErrorCodeV1;
      readonly progress?: AgentSessionProgressActivityV1;
    }
  | ({ readonly kind: "activity" } & AgentSessionProgressActivityV1);

export interface ContentFreeSessionLivenessProjectionStateV1 {
  readonly tool_update_sha256: Map<string, string>;
}

export function createContentFreeSessionLivenessProjectionState(): ContentFreeSessionLivenessProjectionStateV1 {
  return { tool_update_sha256: new Map() };
}

export type AgentSessionLivenessSink = (event: AgentSessionLivenessEventV1) => void;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorHasCode(error: unknown, code: string): boolean {
  return isUnknownRecord(error) && error.code === code;
}

function boundedProtocolErrorSignal(value: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (typeof value === "string") return value.slice(0, 4_096).toLowerCase();
  if (value instanceof Error) return `${value.name} ${value.message}`.slice(0, 4_096).toLowerCase();
  if (value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value
      .slice(0, 16)
      .map((entry) => boundedProtocolErrorSignal(entry, depth + 1))
      .join(" ")
      .slice(0, 4_096);
  }
  if (!isUnknownRecord(value)) return "";
  return ["code", "message", "error", "content"]
    .map((key) => boundedProtocolErrorSignal(value[key], depth + 1))
    .join(" ")
    .slice(0, 4_096);
}

/** Classify a raw failure into a fixed content-free protocol code, or omit it. */
export function contentFreeSessionProtocolErrorCode(
  value: unknown
): AgentSessionProtocolErrorCodeV1 | undefined {
  const signal = boundedProtocolErrorSignal(value);
  if (/unknown[_ -]tool|tool[^\n]{0,80}(unknown|not found)/u.test(signal)) {
    return "unknown_tool";
  }
  if (/artifact[_ -]handle[_ -]mismatch|handle[_ -]mismatch/u.test(signal)) {
    return "handle_mismatch";
  }
  if (
    /reader[_ -]ordering|read[_ -]phase[_ -]brief[_ -]first|before[^\n]{0,80}read[_ -]phase[_ -]brief|after[_ -]submit/u.test(
      signal
    )
  ) {
    return "reader_ordering";
  }
  if (/schema[_ -]invalid|schema validation|invalid[^\n]{0,80}(schema|arguments)/u.test(signal)) {
    return "schema_invalid";
  }
  if (/timed out|timeout/u.test(signal)) return "timeout";
  return undefined;
}

/** Project a non-event session failure without retaining its raw error. */
export function contentFreeSessionProtocolErrorRecord(
  value: unknown
): AgentSessionTraceRecordV1 | undefined {
  const errorCode = contentFreeSessionProtocolErrorCode(value);
  return errorCode === undefined ? undefined : { kind: "protocol_error", error_code: errorCode };
}

function observedDeltaUnits(delta: string): number | undefined {
  const units = Buffer.byteLength(delta, "utf8");
  return units === 0 ? undefined : Math.min(units, 16_777_216);
}

function toolUpdateProgress(
  event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
  state?: ContentFreeSessionLivenessProjectionStateV1
): AgentSessionProgressActivityV1 | undefined {
  let bytes: string;
  try {
    bytes = canonicalJson(event.partialResult);
  } catch {
    return undefined;
  }
  if (typeof bytes !== "string" || bytes.length === 0) return undefined;
  const digest = sha256(bytes);
  if (state?.tool_update_sha256.get(event.toolCallId) === digest) return undefined;
  state?.tool_update_sha256.set(event.toolCallId, digest);
  return {
    activity_class: "tool_execution_updated",
    observed_units: Math.min(Buffer.byteLength(bytes, "utf8"), 16_777_216),
  };
}

/**
 * Project one Pi event onto the host-enforced, content-free charge/activity vocabulary.
 * Raw deltas and tool results are inspected only to prove non-empty/change; only class and
 * bounded unit count leave this adapter. Production callers supply state so repeated cumulative
 * tool updates do not renew a lease.
 */
export function contentFreeSessionLivenessEvent(
  event: AgentSessionEvent,
  allowedToolNames: ReadonlySet<string>,
  state?: ContentFreeSessionLivenessProjectionStateV1
): AgentSessionLivenessEventV1 | undefined {
  if (
    event.type === "turn_start" ||
    event.type === "auto_retry_start" ||
    event.type === "summarization_retry_attempt_start" ||
    event.type === "compaction_start"
  ) {
    return { kind: "model_turn", source: event.type };
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      const observedUnits = observedDeltaUnits(update.delta);
      return observedUnits === undefined
        ? undefined
        : {
            kind: "activity",
            activity_class: "assistant_text_delta",
            observed_units: observedUnits,
          };
    }
    if (update.type === "thinking_delta") {
      const observedUnits = observedDeltaUnits(update.delta);
      return observedUnits === undefined
        ? undefined
        : {
            kind: "activity",
            activity_class: "assistant_thinking_delta",
            observed_units: observedUnits,
          };
    }
    return undefined;
  }
  if (event.type === "tool_execution_start") {
    const admitted = allowedToolNames.has(event.toolName);
    return {
      kind: "tool_call",
      tool_name: admitted ? event.toolName : "unknown_tool",
      ...(admitted
        ? {
            progress: {
              activity_class: "tool_execution_started" as const,
              observed_units: 1,
            },
          }
        : {}),
    };
  }
  if (event.type === "tool_execution_update") {
    if (!allowedToolNames.has(event.toolName)) return undefined;
    const progress = toolUpdateProgress(event, state);
    return progress === undefined ? undefined : { kind: "activity", ...progress };
  }
  if (event.type === "turn_end" && event.message.role === "assistant") {
    return {
      kind: "activity",
      activity_class: "provider_turn_ended",
      observed_units: 1,
    };
  }
  if (event.type === "agent_end") {
    return {
      kind: "activity",
      activity_class: "worker_completed",
      observed_units: 1,
    };
  }
  if (event.type !== "tool_execution_end") return undefined;
  state?.tool_update_sha256.delete(event.toolCallId);
  const unknownTool = !allowedToolNames.has(event.toolName);
  const progress = unknownTool
    ? undefined
    : ({ activity_class: "tool_execution_completed", observed_units: 1 } as const);
  if (!event.isError) return progress === undefined ? undefined : { kind: "activity", ...progress };
  const errorCode = unknownTool
    ? "unknown_tool"
    : contentFreeSessionProtocolErrorCode(event.result);
  return errorCode === undefined
    ? progress === undefined
      ? undefined
      : { kind: "activity", ...progress }
    : {
        kind: "protocol_error",
        tool_name: unknownTool ? "unknown_tool" : event.toolName,
        error_code: errorCode,
        ...(progress === undefined ? {} : { progress }),
      };
}

/** Project one Pi event onto the closed content-free trace vocabulary. */
export function contentFreeSessionTraceRecord(
  event: AgentSessionEvent,
  allowedToolNames?: ReadonlySet<string>
): AgentSessionTraceRecordV1 | undefined {
  if (event.type === "tool_execution_end") {
    const unknownTool = allowedToolNames !== undefined && !allowedToolNames.has(event.toolName);
    const errorCode = unknownTool
      ? "unknown_tool"
      : event.isError
        ? contentFreeSessionProtocolErrorCode(event.result)
        : undefined;
    return {
      kind: "tool",
      // Provider-emitted unknown names are model-authored. Never forward one to
      // diagnostics when the host supplied an exact active-tool set.
      name: unknownTool ? "unknown_tool" : event.toolName,
      outcome: unknownTool || event.isError ? "error" : "success",
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    };
  }
  if (event.type !== "turn_end" || event.message.role !== "assistant") return undefined;
  const { stopReason, usage } = event.message;
  return {
    kind: "turn",
    name: "turn",
    outcome: stopReason === "error" || stopReason === "aborted" ? "error" : "success",
    stop_reason: stopReason,
    token_counts: {
      input: usage.input,
      output: usage.output,
      cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite,
      total: usage.totalTokens,
    },
  };
}

/**
 * Trusted host composition, never a model/request-selected tool policy. The source must
 * identify one exact extension entry file; symlink aliases share its canonical identity.
 * The scoped factory also loads when that source is absent from the enabled inventory.
 */
export interface WorkerExtensionSourceReplacement {
  readonly source: string;
  readonly extension: InlineExtension;
}

export interface PiAgentClientOptions {
  /** Host-only SDK instrumentation. Omitted ordinary clients retain their existing defaults. */
  readonly sessionRuntime?: {
    readonly settingsManager: SettingsManager;
    readonly noAmbientExtensions: true;
    readonly attach: (
      session: Awaited<ReturnType<typeof createAgentSession>>["session"],
      invocation: AgentInvocation
    ) => () => void;
  };
  readonly resolveModel?: (modelId: string, provider?: string) => Promise<PiModel> | PiModel;
  readonly workerExtensions?: readonly InlineExtension[];
  readonly workerExtensionReplacements?: readonly WorkerExtensionSourceReplacement[];
  /** Optional content-free lifecycle accounting for ordinary and private sessions. */
  readonly sessionTrace?: AgentSessionTraceSink;
  /** Existing owner-resolved project partition; no path selector or fallback is accepted. */
  readonly catalogSessions?: {
    readonly projectId: string;
    readonly root: string;
  };
  /** TEST-ONLY session seam. Production catalog workers must use catalogSessions. */
  readonly testOnlySessionManagerFactory?: (invocation: AgentInvocation) => SessionManager;
  /**
   * TEST-ONLY fallback used only when host invocation policy is absent. Catalog YAML
   * supplies the ordinary default; anonymous private sessions retain SDK settings.
   */
  readonly testOnlyThinkingLevelOverride?: SessionThinkingLevel;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export class EmptyStageOutputError extends Error {
  readonly code = "empty_stage_output" as const;

  constructor(message = "agent session produced no non-empty final assistant text") {
    super(message);
    this.name = "EmptyStageOutputError";
  }
}

export function requireNonEmptyStageOutput(text: string): string {
  if (text.trim().length === 0) throw new EmptyStageOutputError();
  return text;
}

function piAssistantLivenessReason(
  message: Readonly<Record<string, unknown>>
): LivenessTerminalReason | undefined {
  if (message.stopReason !== "error") return undefined;
  try {
    return validateContract(
      LivenessTerminalReasonSchema,
      message.errorMessage,
      "Pi assistant liveness error"
    );
  } catch {
    return undefined;
  }
}

/** Terminal failure is independent of exact captured text; neither is a successful completion. */
export class AgentTerminalError extends Error {
  readonly code = "agent_terminal_error" as const;
  readonly #partialText: string;

  constructor(
    readonly stopReason: "error" | "aborted",
    partialText: string
  ) {
    // Provider errors and partial output can contain private data. Keep ordinary error
    // serialization content-free; exact non-sensitive evidence is available explicitly.
    super(`agent session ended with assistant terminal stop reason: ${stopReason}`);
    this.name = "AgentTerminalError";
    this.#partialText = partialText;
  }

  get partialText(): string {
    return this.#partialText;
  }
}

function finalAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index], "agent message");
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function assistantMessageText(message: Readonly<Record<string, unknown>>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => objectValue(part, "assistant content part"))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function assertAssistantTerminalSucceeded(
  message: Readonly<Record<string, unknown>> | undefined,
  sensitiveOutput = false
): void {
  if (message === undefined) return;
  const livenessReason = piAssistantLivenessReason(message);
  if (livenessReason !== undefined) throw new LivenessExhaustedError(livenessReason);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new AgentTerminalError(
      message.stopReason,
      sensitiveOutput ? "" : assistantMessageText(message)
    );
  }
}

export function canonicalAssistantText(messages: readonly unknown[]): string {
  const message = finalAssistantMessage(messages);
  assertAssistantTerminalSucceeded(message);
  if (message === undefined) throw new EmptyStageOutputError();
  return requireNonEmptyStageOutput(assistantMessageText(message));
}

/**
 * Parse the agent's maximum ordinary catalog authority from the `tools:` frontmatter of
 * `.pi/agents/<agent>.md`. Profiles lint this list exactly and the orchestration app must
 * not maintain a private per-agent table. A phase subset is validated against this maximum
 * later, before session creation; absence preserves exact YAML equality.
 */
/**
 * The agent's SSOT-declared model, or `undefined` when the frontmatter omits it.
 *
 * Lives beside `parseSsotTools` because it is the same idea: the agent definition
 * is the single source of truth for how that agent runs, and the app reads it
 * rather than keeping a private table. A caller that requires a declared model
 * refuses to guess when this returns `undefined`.
 */
export function ssotModel(agentDoc: string): string | undefined {
  const match = agentDoc.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const line = (match?.[1] ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("model:"));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  return value && value.length > 0 ? value : undefined;
}

/** The provider pin is independent of the model alias and must not fall back to session settings. */
export function ssotProvider(agentDoc: string): string | undefined {
  const match = agentDoc.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const line = (match?.[1] ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("provider:"));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  return value && value.length > 0 ? value : undefined;
}

/** Optional catalog default, validated against the SDK thinking vocabulary without coercion. */
export function ssotThinkingLevel(agentDoc: string): SessionThinkingLevel | undefined {
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(agentDoc);
  const level = frontmatter.thinking;
  switch (level) {
    case undefined:
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return level;
    default:
      throw new Error("invalid catalog thinking level");
  }
}

/** The agent SSOT body with its frontmatter removed. */
export function ssotBody(agentDoc: string): string {
  return catalogRoleBody(agentDoc);
}

export function parseSsotTools(agentDoc: string, agent: string): readonly string[] {
  if (agentDoc.trim().length === 0) {
    throw new Error(
      `agent '${agent}' has no definition (.pi/agents/${agent}.md missing); its SSOT 'tools:' allow-list is required`
    );
  }
  const frontmatter = agentDoc.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const region = frontmatter?.[1] ?? agentDoc;
  const line = region.split(/\r?\n/).find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) {
    throw new Error(
      `agent '${agent}' declares no top-level 'tools:' in .pi/agents/${agent}.md; the SSOT is required and must not be bypassed`
    );
  }
  const rawNames = line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((name) => name.trim());
  if (rawNames.some((name) => name.length === 0)) {
    throw new Error(`agent '${agent}' has an empty tools: entry`);
  }
  const names = rawNames;
  if (names.length === 0) {
    throw new Error(
      `agent '${agent}' has an empty 'tools:' list; refusing to run with no declared authority`
    );
  }
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(`agent '${agent}' declares duplicate tool '${duplicate}'`);
  }
  return names;
}

// Disclosure ceiling, not a retry/factory limit: every error still refuses the loader.
const WORKER_EXTENSION_DIAGNOSTIC_LIMIT = 8;

interface WorkerExtensionDiagnostic {
  readonly source: "installed_artifact_reader" | "inline_extension" | "external_extension";
  readonly classification:
    | "ORCHESTRATION_BUILD_STALE"
    | "INSTALLED_ARTIFACT_READER_UNAVAILABLE"
    | "EXTENSION_CONFLICT"
    | "EXTENSION_LOAD_ERROR";
  readonly path_sha256: string;
  readonly error_sha256: string;
}

/** SDK diagnostics may embed arbitrary private paths, inputs or secrets, even in names. */
class WorkerExtensionLoadError extends ContractValidationError {
  readonly code = "WORKER_EXTENSION_LOAD_FAILED" as const;

  constructor(errors: readonly { path: string; error: string }[]) {
    const installedReader = (entry: { path: string }): boolean =>
      entry.path === "<inline:artifact-worker-read>";
    // Keep the fixed reader's failure intelligible even behind many unrelated loader errors.
    const ordered = [
      ...errors.filter(installedReader),
      ...errors.filter((entry) => !installedReader(entry)),
    ];
    const diagnostics: WorkerExtensionDiagnostic[] = ordered
      .slice(0, WORKER_EXTENSION_DIAGNOSTIC_LIMIT)
      .map((entry) => ({
        source:
          entry.path === "<inline:artifact-worker-read>"
            ? "installed_artifact_reader"
            : entry.path.startsWith("<inline:")
              ? "inline_extension"
              : "external_extension",
        // These are diagnostic classifications, never authority or permission decisions.
        classification: entry.error.startsWith("ORCHESTRATION_BUILD_STALE:")
          ? "ORCHESTRATION_BUILD_STALE"
          : entry.error === "Installed artifact reader unavailable"
            ? "INSTALLED_ARTIFACT_READER_UNAVAILABLE"
            : /^(?:Tool ".*"|Flag "--.*") conflicts with /u.test(entry.error)
              ? "EXTENSION_CONFLICT"
              : "EXTENSION_LOAD_ERROR",
        path_sha256: sha256(entry.path),
        error_sha256: sha256(entry.error),
      }));
    // Reuse the structured contract-error transport; never retain a raw cause or stack.
    super("WORKER_EXTENSION_LOAD_FAILED before model/session creation", [
      `extension_errors=${errors.length}; omitted=${errors.length - diagnostics.length}; installed_reader_errors=${errors.filter(installedReader).length}; stale_build_errors=${errors.filter((entry) => entry.error.startsWith("ORCHESTRATION_BUILD_STALE:")).length}`,
      ...diagnostics.map((diagnostic) => canonicalJson(diagnostic)),
    ]);
    this.name = "WorkerExtensionLoadError";
    this.message = `WORKER_EXTENSION_LOAD_FAILED: extension registration refused before model/session creation; ${this.issues.join("; ")}`;
  }
}

export async function createWorkerResourceLoader(
  projectRoot: string,
  extensionFactories: readonly InlineExtension[] = [],
  catalogSystemPrompt?: string,
  runtime?: PiAgentClientOptions["sessionRuntime"],
  sharedSettings?: SettingsManager,
  eventBus?: EventBus,
  compactionProgress?: CompactionProgressObserver,
  replacements: readonly WorkerExtensionSourceReplacement[] = []
) {
  const agentDir = getAgentDir();
  const settingsManager = enforceNativeAutoCompaction(
    sharedSettings ?? runtime?.settingsManager ?? SettingsManager.create(projectRoot, agentDir)
  );
  try {
    // Resolve the native inventory without executing any extension factory. Do not
    // hand-enumerate directories: settings, package manifests/filters, project trust,
    // global providers and native discovery all participate in this same catalog.
    let extensionPaths: readonly string[] | undefined;
    const replacedSources = new Set<string>();
    for (const replacement of replacements) {
      if (!path.isAbsolute(replacement.source) || !statSync(replacement.source).isFile()) {
        throw new Error("Replacement source must be an absolute extension entry file");
      }
      const source = realpathSync(replacement.source);
      if (replacedSources.has(source)) throw new Error("Duplicate extension source replacement");
      replacedSources.add(source);
    }
    if (replacements.length > 0 && runtime === undefined) {
      await settingsManager.reload();
      const inventory = await new DefaultPackageManager({
        cwd: projectRoot,
        agentDir,
        settingsManager,
      }).resolve(async () => "error");
      extensionPaths = Object.freeze(
        inventory.extensions
          .filter((resource) => resource.enabled)
          .filter((resource) => !replacedSources.has(realpathSync(resource.path)))
          .map((resource) => resource.path)
      );
    }
    const factories = [
      ...extensionFactories,
      ...replacements.map((replacement) => replacement.extension),
    ];
    const loader = new DefaultResourceLoader({
      cwd: projectRoot,
      agentDir,
      settingsManager,
      ...(eventBus === undefined ? {} : { eventBus }),
      ...(compactionProgress === undefined
        ? {}
        : { extensionsOverride: compactionProgress.extensionsOverride }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(runtime === undefined && extensionPaths === undefined ? {} : { noExtensions: true }),
      ...(extensionPaths === undefined ? {} : { additionalExtensionPaths: [...extensionPaths] }),
      ...(catalogSystemPrompt === undefined
        ? {}
        : {
            systemPrompt: catalogSystemPrompt,
            systemPromptOverride: () => catalogSystemPrompt,
            appendSystemPromptOverride: () => [],
            agentsFilesOverride: () => ({ agentsFiles: [] }),
          }),
      ...(factories.length > 0 ? { extensionFactories: factories } : {}),
    });
    await loader.reload();
    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) throw new WorkerExtensionLoadError(extensionErrors);
    return loader;
  } catch (error) {
    if (error instanceof WorkerExtensionLoadError) throw error;
    throw new WorkerExtensionLoadError([
      {
        path: "<worker-resource-loader>",
        error: error instanceof Error ? error.message : "non-Error resource loader failure",
      },
    ]);
  }
}

/**
 * Purpose-built private-child loader. In-memory settings prevent project/global
 * package configuration from re-enabling resources; every discoverable ambient
 * resource class is disabled and then defensively projected to an empty set.
 */
export async function createPrivateSessionResourceLoader(input: {
  projectRoot: string;
  systemPrompt: string;
  agentDir?: string;
}) {
  const settingsManager = enforceNativeAutoCompaction(SettingsManager.inMemory());
  const loader = new DefaultResourceLoader({
    cwd: input.projectRoot,
    agentDir: input.agentDir ?? getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: input.systemPrompt,
    appendSystemPrompt: [],
    extensionsOverride: (base) => ({ ...base, extensions: [], errors: [] }),
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => input.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return { resourceLoader: loader, settingsManager };
}

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

export function createDurableCatalogSession(input: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionRoot: string;
  readonly agent: string;
  readonly stateId: string;
  readonly correlation: WorkflowSessionCorrelationV1;
}): SessionManager {
  if (!PROJECT_ID_PATTERN.test(input.projectId)) throw new Error("project ID is not canonical");
  if (!path.isAbsolute(input.sessionRoot)) throw new Error("catalog session root must be absolute");
  if (!CATALOG_AGENT_NAME_PATTERN.test(input.agent)) {
    throw new Error("catalog agent name is not canonical");
  }
  assertOwnerDirectory(input.sessionRoot, "catalog session root");
  const agentDirectory = path.join(input.sessionRoot, input.agent);
  ensureOwnerDirectory(agentDirectory, `catalog session directory for '${input.agent}'`);
  const manager = SessionManager.create(input.projectRoot, agentDirectory);
  const metadata = validateCatalogWorkerSessionMetadata({
    schema_version: 1,
    project_id: input.projectId,
    run_id: input.correlation.run_id,
    workflow_session_id: input.correlation.workflow_session_id,
    state_id: input.stateId,
    branch_id: input.correlation.branch_id,
    attempt: input.correlation.attempt,
    worker_id: input.correlation.worker_id,
    agent: input.agent,
    purpose: input.correlation.purpose,
  });
  manager.appendCustomEntry(CATALOG_WORKER_SESSION_METADATA, metadata);
  const sessionFile = finalizeDurableCatalogSession(manager);
  if (sessionFile === undefined) {
    throw new Error("durable catalog session correlation did not materialize");
  }
  manager.setSessionFile(sessionFile);
  return manager;
}

/** Append the validated assignment companion while the durable session is still pre-prompt. */
export function appendCatalogWorkerContinuity(input: {
  readonly manager: SessionManager;
  readonly projectId: string;
  readonly invocation: AgentInvocation;
  readonly registeredGuidance: string;
  readonly opening: string;
}): CatalogWorkerContinuityMetadataV1 {
  const correlation = input.invocation.workflowSession;
  if (correlation === undefined) {
    throw new Error("catalog worker continuity requires workflow correlation");
  }
  const metadata = validateCatalogWorkerContinuityMetadata({
    schema_version: 1,
    project_id: input.projectId,
    run_id: correlation.run_id,
    workflow_session_id: correlation.workflow_session_id,
    state_id: input.invocation.stateId,
    branch_id: correlation.branch_id,
    attempt: correlation.attempt,
    worker_id: correlation.worker_id,
    agent: input.invocation.agent,
    purpose: correlation.purpose,
    task: input.invocation.task,
    registered_guidance: input.registeredGuidance,
    input_artifacts: input.invocation.inputArtifacts,
    compaction_continuity:
      (input.invocation.contextOverlays?.length ?? 0) > 0
        ? {
            mode: "pi_default_private_context",
            reason: "owner_resolved_context_present",
          }
        : { mode: "exact_opening", opening: input.opening },
  });
  input.manager.appendCustomEntry(CATALOG_WORKER_CONTINUITY_METADATA, metadata);
  finalizeDurableCatalogSession(input.manager);
  return metadata;
}

/**
 * Pi intentionally delays a JSONL write until an assistant message exists. Workflow
 * diagnostics cannot make that assumption: provider/setup errors and aborts need the
 * same durable transcript address. Materialize the public SessionManager snapshot only
 * when Pi has not created the file, then verify owner-only custody and exact entry IDs.
 */
export function finalizeDurableCatalogSession(manager: SessionManager): string | undefined {
  if (!manager.isPersisted()) return undefined;
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (sessionFile === undefined || header === null) {
    throw new Error("durable catalog session has no file or header");
  }
  const entries = manager.getEntries();
  if (!pathExistsNoFollow(sessionFile)) {
    const descriptor = openSync(
      sessionFile,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      writeFileSync(
        descriptor,
        `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8"
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  const before = lstatSync(sessionFile);
  const uid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (uid !== undefined && before.uid !== uid)
  ) {
    throw new Error("catalog session JSONL has unsafe custody");
  }
  if ((before.mode & 0o777) !== 0o600) chmodSync(sessionFile, 0o600);
  assertOwnerFile(sessionFile, "catalog session JSONL");

  const stored = parseSessionEntries(readFileSync(sessionFile, "utf8"));
  const storedHeader = stored.find((entry) => entry.type === "session");
  const storedEntryIds = new Set(
    stored.flatMap((entry) => (entry.type === "session" ? [] : [entry.id]))
  );
  if (storedHeader?.id !== header.id || entries.some((entry) => !storedEntryIds.has(entry.id))) {
    throw new Error("catalog session JSONL did not flush the authoritative session entries");
  }

  const descriptor = openSync(sessionFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("catalog session JSONL changed during verification");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(sessionFile));
  return sessionFile;
}

type CreatedAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Mirror Pi runtime teardown for sessions created directly through the SDK. */
export async function closeCreatedSession(
  session: CreatedAgentSession,
  sessionManager: SessionManager
): Promise<void> {
  try {
    if (session.hasExtensionHandlers("session_shutdown")) {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    }
  } finally {
    try {
      session.dispose();
    } finally {
      finalizeDurableCatalogSession(sessionManager);
    }
  }
}

export function buildAgentOpening(input: {
  readonly invocation: AgentInvocation;
  readonly registration: ActiveWorkerRegistrationMetadataV1;
  readonly agentGuidance: string;
  readonly domainGuidance: string;
  readonly activeToolNames: readonly string[];
  readonly providerOpeningAppendix?: string;
}): string {
  const repair = input.invocation.executionPurpose === "routing_repair";
  const projection = input.registration.result_projection;
  if (projection !== undefined) {
    const declaration = validateContract(
      PhaseResultProjectionDeclarationV1Schema,
      projection,
      "opening result projection"
    );
    if (
      declaration.registration_name !== input.registration.playbook_name ||
      declaration.state_id !== input.invocation.stateId ||
      declaration.agent !== input.invocation.agent ||
      input.registration.result_transport !== "persisted_summary" ||
      input.registration.opening_policy !== "registration_guidance_task_artifacts" ||
      input.registration.provider_opening_guard !== undefined
    ) {
      throw new Error("opening result projection does not match the active catalog phase");
    }
  }
  const operativeGuidance = repair ? input.invocation.routingRepairGuidance : input.domainGuidance;
  if (repair && !operativeGuidance?.trim()) {
    throw new Error("routing repair has no mechanically projected summary-only guidance");
  }
  const budget = input.invocation.livenessBudget;
  const livenessContext =
    budget === undefined
      ? ""
      : [
          "HOST-ENFORCED RENEWABLE INACTIVITY LEASE:",
          "The host renews the lease only from trusted non-empty assistant/thinking deltas,",
          "admitted tool lifecycle progress, provider turn completion, or durable workflow",
          "convergence. Total elapsed work is not a liveness budget; stalled work is stopped.",
        ].join("\n");
  return [
    `You are executing the '${input.invocation.agent}' role for a registered workflow.`,
    livenessContext,
    "TASK:",
    input.invocation.task,
    input.invocation.inputArtifacts.length > 0
      ? input.registration.provider_opening_guard !== undefined
        ? `INPUT ARTIFACT IDENTITIES:\n${input.invocation.inputArtifacts
            .map((ref) => JSON.stringify(ref))
            .join(
              "\n"
            )}\nThe host has embedded the exact admitted payload below. Use only that inline input; no tools are available.`
        : `INPUT ARTIFACTS:\n${input.invocation.inputArtifacts
            .map((ref) => JSON.stringify(ref))
            .join("\n")}\nRead each needed ID with artifact_read before working.`
      : "INPUT ARTIFACTS: none.",
    (input.invocation.contextOverlays?.length ?? 0) > 0
      ? `OWNER-RESOLVED RESEARCH CONTEXT:\n${input.invocation.contextOverlays
          ?.map((overlay) => {
            const validation =
              "validation" in overlay
                ? `\nUSE-TIME VALIDATION ${canonicalJson(overlay.validation)}`
                : "";
            return `SOURCE ENVELOPE ${canonicalJson(overlay.source)}${validation}\nCONTENT:\n${overlay.content}`;
          })
          .join("\n\n")}`
      : "",
    input.providerOpeningAppendix ?? "",
    repair
      ? "Return exactly the one summary-only line required above. Do not return prose or semantic body bytes."
      : projection === undefined
        ? "Return the complete stage output in assistant text and end with the closed SUMMARY line defined by the domain guidance."
        : "Return the complete immutable core required by the domain guidance in assistant text. The registered host projection derives routing confidence/details; no model-authored SUMMARY is required. If the domain guidance permits an optional redundant SUMMARY, it must match the entire core exactly.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export class RemoteModelOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteModelOutcomeUnknownError";
  }
}

export class PiAgentClient implements ModelClient {
  constructor(private readonly options: PiAgentClientOptions = {}) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const registration = invocation.registration;
    if (
      registration === undefined ||
      registration.playbook_name.trim().length === 0 ||
      registration.workflow_name.trim().length === 0 ||
      registration.guidance.skill_root.trim().length === 0
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has no active-registration guidance`
      );
    }
    const requiredModel = registration.required_model;
    if (requiredModel !== undefined) {
      validateRequiredModelIdentity(requiredModel, "active worker required model");
      if (invocation.modelOverride !== requiredModel.override) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}' requires model override '${requiredModel.override}'`
        );
      }
      if (
        invocation.admitResolvedModel === undefined ||
        invocation.guardModelDispatch === undefined
      ) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}' lacks required model admission or dispatch fencing`
        );
      }
    }
    const browserNetworkAllowlist = registration.browser_network_allowlist;
    if (browserNetworkAllowlist !== undefined && invocation.workflowSession === undefined) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' restricted browser policy requires host workflow correlation`
      );
    }
    // This is the runtime-host admission check. A registration policy without the
    // Worker's matching context-local carrier, or any carrier on an ordinary phase,
    // is refused before resource loading and before createAgentSession.
    assertRegisteredBrowserPolicyCarrier({
      registrationName: registration.playbook_name,
      stateId: invocation.stateId,
      ...(invocation.workflowSession === undefined
        ? {}
        : {
            ownerScopeId: registeredBrowserPolicyOwnerScopeId({
              projectRoot: invocation.projectRoot,
              registrationName: registration.playbook_name,
              runId: invocation.workflowSession.run_id,
            }),
            invocationId: invocation.workflowSession.worker_id,
          }),
      ...(browserNetworkAllowlist === undefined ? {} : { allowlist: browserNetworkAllowlist }),
    });
    const spec = invocation.session;
    const isolatedSystemPrompt = spec?.isolatedSystemPrompt;
    const isolated = isolatedSystemPrompt !== undefined;
    if (
      isolated
        ? registration.result_transport !== "host_typed" ||
          registration.opening_policy !== "host_private_opening" ||
          registration.model_policy !== "host_private_ssot_model"
        : registration.result_transport !== "persisted_summary" ||
          registration.opening_policy !== "registration_guidance_task_artifacts" ||
          registration.model_policy !== "directive_override_or_runtime_default"
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has registration/session posture mismatch`
      );
    }
    const genericChildYamlAuthority = registration.generic_child_yaml_authority;
    if (genericChildYamlAuthority?.allowed_tools === null) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has unbound generic child YAML authority`
      );
    }
    const genericChildYamlSnapshot = genericChildYamlAuthority?.allowed_tools;
    const catalogAgentDoc = await optionalText(
      path.join(invocation.projectRoot, ".pi", "agents", `${invocation.agent}.md`)
    );
    if (isolated && catalogAgentDoc.trim().length > 0) {
      throw new Error(
        `catalog agent '${invocation.agent}' cannot run with an isolated replacement tool matrix`
      );
    }
    const agentGuidance = isolated ? "" : catalogAgentDoc;
    // Explicit Research/host policy and the test seam keep their precedence. Ordinary
    // agent_ssot callers supply neither, so use the same catalog YAML as direct workers.
    // Anonymous private sessions deliberately never inherit a catalog default.
    const thinkingLevel =
      invocation.thinkingLevel ??
      this.options.testOnlyThinkingLevelOverride ??
      (isolated ? undefined : ssotThinkingLevel(agentGuidance));
    const yamlMaximum = isolated ? [] : [...parseSsotTools(agentGuidance, invocation.agent)];
    if (
      genericChildYamlSnapshot !== undefined &&
      canonicalJson(yamlMaximum) !== canonicalJson(genericChildYamlSnapshot)
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' generic child YAML authority drifted after registration binding`
      );
    }
    // W6: contract-resolved, not hardcoded. Private sessions already carry the
    // exact resolved guidance in their isolated system prompt, so they never
    // rediscover a project/global prompt here.
    const routingRepair = invocation.executionPurpose === "routing_repair";
    if (
      routingRepair !== (invocation.workflowSession?.purpose === "routing_repair") ||
      (routingRepair && !invocation.routingRepairGuidance?.trim())
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has invalid routing-repair guidance binding`
      );
    }
    const domainGuidance =
      isolated || routingRepair
        ? ""
        : await optionalText(
            resolveDomainGuidancePath({
              projectRoot: invocation.projectRoot,
              agent: invocation.agent,
              stateId: registration.guidance_state_id ?? invocation.stateId,
              guidance: registration.guidance,
            })
          );
    if (!isolated && !routingRepair && domainGuidance.trim().length === 0) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has empty required guidance`
      );
    }
    verifyStaticPromptSourceBindings(invocation.projectRoot, registration.prompt_sources);
    const documentation =
      isolated || routingRepair || registration.guidance.documentation === undefined
        ? []
        : registration.documentation_sources === undefined
          ? loadPromptDocumentation(invocation.projectRoot, registration.guidance.documentation)
          : verifyPromptDocumentation(invocation.projectRoot, registration.documentation_sources);
    // This is the sole catalog narrowing gate. WorkerExecutor may copy only the active
    // PlaybookRegistration phase value here; task/trust/runtime state has no selector.
    // Validate strict membership before createAgentSession, then pass the accepted list unchanged.
    const registeredSubset = registration.allowed_tools;
    const providerOpeningGuard = registration.provider_opening_guard;
    if (isolated && registeredSubset !== undefined) {
      throw new Error("private session cannot carry a catalog registration tool subset");
    }
    if (isolated && browserNetworkAllowlist !== undefined) {
      throw new Error("private session cannot carry a catalog browser network policy");
    }
    if (!isolated && registeredSubset !== undefined) {
      if (
        new Set(registeredSubset).size !== registeredSubset.length ||
        registeredSubset.some((tool) => !yamlMaximum.includes(tool)) ||
        registeredSubset.length >= yamlMaximum.length ||
        (registeredSubset.length === 0 && providerOpeningGuard === undefined)
      ) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}' registration tools must be a non-empty exact strict subset of YAML; zero tools require a provider-opening guard`
        );
      }
    }
    if (
      providerOpeningGuard !== undefined &&
      (!isProviderOpeningGuardId(providerOpeningGuard) ||
        registeredSubset?.length !== 0 ||
        requiredModel === undefined ||
        invocation.providerOpeningAppendix === undefined ||
        invocation.contextOverlays?.length)
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has an invalid guarded zero-tool opening posture`
      );
    }
    const allowed = isolated
      ? [...(spec?.tools ?? [])]
      : registeredSubset === undefined
        ? yamlMaximum
        : [...registeredSubset];
    if (isolated && allowed.length === 0) {
      throw new Error("private session has no exact tool-name allowlist");
    }
    if (
      browserNetworkAllowlist !== undefined &&
      !allowed.some((tool) => tool.startsWith("playwright_"))
    ) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' browser policy has no active Playwright tool`
      );
    }
    const isolatedResources =
      isolatedSystemPrompt === undefined
        ? undefined
        : await createPrivateSessionResourceLoader({
            projectRoot: invocation.projectRoot,
            systemPrompt: isolatedSystemPrompt,
          });
    // The loader and actual SDK factory MUST share this exact enforced manager.
    const settingsManager =
      isolatedResources?.settingsManager ??
      enforceNativeAutoCompaction(
        this.options.sessionRuntime?.settingsManager ??
          SettingsManager.create(invocation.projectRoot, getAgentDir())
      );
    const compactionEvents = createEventBus();
    const compactionProgress = createCompactionProgressObserver((progress) =>
      invocation.liveness?.({ kind: "activity", ...progress })
    );
    const resourceLoader =
      isolatedResources?.resourceLoader ??
      (await createWorkerResourceLoader(
        invocation.projectRoot,
        this.options.workerExtensions ?? [],
        buildCatalogPrompt({
          projectRoot: invocation.projectRoot,
          agentName: invocation.agent,
          role: agentGuidance,
          domainGuidance: routingRepair ? (invocation.routingRepairGuidance ?? "") : domainGuidance,
          documentation,
        }).systemPrompt,
        this.options.sessionRuntime,
        settingsManager,
        compactionEvents,
        compactionProgress,
        this.options.workerExtensionReplacements
      ));
    let resolvedModel: PiModel | undefined;
    let resolvedRuntime: CreateSessionOptions["modelRuntime"];
    // Anonymous host-private sessions retain their separate model/settings contract.
    if (!isolated || invocation.modelOverride !== undefined) {
      const configuredModel = isolated ? undefined : ssotModel(agentGuidance);
      const configuredProvider = isolated ? undefined : ssotProvider(agentGuidance);
      if (
        invocation.modelOverride === undefined &&
        (configuredModel === undefined || configuredProvider === undefined)
      ) {
        throw new Error(
          `agent '${invocation.agent}' requires both 'model:' and 'provider:' in its SSOT frontmatter; refusing the global session default`
        );
      }
      const requestedModel = invocation.modelOverride ?? configuredModel;
      if (requestedModel === undefined || requestedModel.trim().length === 0) {
        throw new Error(`agent '${invocation.agent}' has no non-empty model identity to resolve`);
      }
      const separator = requestedModel.indexOf("/");
      const explicitProvider = invocation.modelOverride !== undefined && separator > 0;
      const provider = explicitProvider ? requestedModel.slice(0, separator) : configuredProvider;
      const modelId = explicitProvider ? requestedModel.slice(separator + 1) : requestedModel;
      if (modelId.trim().length === 0 || provider?.trim().length === 0) {
        throw new Error(`agent '${invocation.agent}' has an invalid configured model identity`);
      }
      if (this.options.resolveModel !== undefined) {
        // Preserve the existing composite-override resolver seam. Defaults carry their provider
        // separately so aliases resolve within the declared provider, not the global session.
        resolvedModel = await this.options.resolveModel(requestedModel, provider);
      } else {
        const runtime = await ModelRuntime.create();
        const extensions = resourceLoader.getExtensions().runtime;
        for (const entry of extensions.pendingNativeProviderRegistrations) {
          runtime.registerNativeProvider(entry.provider);
        }
        for (const entry of extensions.pendingProviderRegistrations) {
          runtime.registerProvider(entry.name, entry.config);
        }
        await runtime.refresh({ allowNetwork: false });
        const resolved = resolveCliModel({
          cliModel: modelId,
          ...(provider === undefined ? {} : { cliProvider: provider }),
          modelRuntime: runtime,
        });
        if (
          resolved.model === undefined ||
          resolved.error !== undefined ||
          resolved.warning !== undefined
        ) {
          throw new Error(
            `agent '${invocation.agent}' model '${requestedModel}' is unavailable or not configured`
          );
        }
        const selectedModel = resolved.model;
        resolvedModel = selectedModel;
        const available = await runtime.getAvailable(
          provider,
          invocation.signal === undefined ? {} : { signal: invocation.signal }
        );
        if (
          !available.some(
            (model) => model.provider === selectedModel.provider && model.id === selectedModel.id
          )
        ) {
          throw new Error(`agent '${invocation.agent}' model '${requestedModel}' is unavailable`);
        }
        resolvedRuntime = runtime;
      }
      // Pi deliberately supports fuzzy CLI matching and synthesized custom IDs. Catalog workers
      // must instead use an exact configured ID or display-name alias, never a near match.
      if (
        (provider !== undefined && resolvedModel.provider !== provider) ||
        (resolvedModel.id !== modelId && resolvedModel.name !== modelId)
      ) {
        throw new Error(
          `agent '${invocation.agent}' resolved model '${resolvedModel.provider}/${resolvedModel.id}' does not match configured identity '${provider === undefined ? "" : `${provider}/`}${modelId}'`
        );
      }
    }

    let imageCapabilityEvidence = invocation.requiredImageCapability;
    if (invocation.registration.requires_image_input === true && resolvedModel !== undefined) {
      // An explicit override is known before createAgentSession. Resolve positive evidence from
      // Pi's model metadata now; the final session identity is still rechecked before prompt.
      imageCapabilityEvidence = admitImageInputModel(resolvedModel);
    } else if (imageCapabilityEvidence !== undefined && resolvedModel !== undefined) {
      // An explicit override is known before createAgentSession, so deny unsupported/drifted
      // models before a session is created or a prompt is dispatched.
      recheckImageInputModel(imageCapabilityEvidence, resolvedModel);
    }

    if (invocation.admitResolvedModel !== undefined) {
      const provider = typeof resolvedModel?.provider === "string" ? resolvedModel.provider : "";
      const id = typeof resolvedModel?.id === "string" ? resolvedModel.id : "";
      if (provider.length === 0 || id.length === 0) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}': no resolved model identity to admit; refusing to create a session`
        );
      }
      const observed = { provider, model: id };
      if (requiredModel !== undefined) {
        assertResolvedModelIdentity(requiredModel, observed, "Pi resolved model");
      }
      // Throws on denial. Nothing below this line may create a session.
      invocation.admitResolvedModel(observed);
    }

    const sessionManager = isolated
      ? SessionManager.inMemory(invocation.projectRoot)
      : (this.options.testOnlySessionManagerFactory?.(invocation) ??
        (() => {
          const catalogSessions = this.options.catalogSessions;
          const correlation = invocation.workflowSession;
          if (catalogSessions === undefined || correlation === undefined) {
            throw new Error(
              `catalog agent '${invocation.agent}' requires the existing project session partition and workflow correlation`
            );
          }
          return createDurableCatalogSession({
            projectRoot: invocation.projectRoot,
            projectId: catalogSessions.projectId,
            sessionRoot: catalogSessions.root,
            agent: invocation.agent,
            stateId: invocation.stateId,
            correlation,
          });
        })());
    const sessionOptions: CreateSessionOptions = {
      cwd: invocation.projectRoot,
      sessionManager,
      resourceLoader,
      settingsManager,
      ...(isolated && spec?.noTools !== undefined ? { noTools: spec.noTools } : {}),
      tools: allowed,
      ...(isolated && spec?.customTools !== undefined
        ? { customTools: [...spec.customTools] }
        : {}),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
      ...(resolvedRuntime === undefined ? {} : { modelRuntime: resolvedRuntime }),
    };

    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await createAgentSession(sessionOptions);
    } catch (error) {
      finalizeDurableCatalogSession(sessionManager);
      throw error;
    }
    const { session } = created;
    if (
      resolvedModel !== undefined &&
      (session.model?.provider !== resolvedModel.provider || session.model.id !== resolvedModel.id)
    ) {
      await closeCreatedSession(session, sessionManager);
      throw new Error(
        `agent '${invocation.agent}' Pi session model does not match the resolved configured identity`
      );
    }
    if (requiredModel !== undefined) {
      const provider = typeof session.model?.provider === "string" ? session.model.provider : "";
      const model = typeof session.model?.id === "string" ? session.model.id : "";
      try {
        assertResolvedModelIdentity(requiredModel, { provider, model }, "Pi session model");
      } catch (error) {
        await closeCreatedSession(session, sessionManager);
        throw error;
      }
    }
    if (
      invocation.registration.requires_image_input === true ||
      imageCapabilityEvidence !== undefined
    ) {
      try {
        // The session model is Pi's final active identity. Establish positive evidence when the
        // runtime default was not knowable earlier, or recheck the already-admitted identity.
        imageCapabilityEvidence =
          imageCapabilityEvidence === undefined
            ? admitImageInputModel(session.model)
            : recheckImageInputModel(imageCapabilityEvidence, session.model);
      } catch (error) {
        await closeCreatedSession(session, sessionManager);
        throw error;
      }
    }
    if (invocation.bindResolvedSessionModel !== undefined) {
      const provider = typeof session.model?.provider === "string" ? session.model.provider : "";
      const id = typeof session.model?.id === "string" ? session.model.id : "";
      if (provider.length === 0 || id.length === 0) {
        await closeCreatedSession(session, sessionManager);
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}': created session has no model identity to bind before prompt`
        );
      }
      try {
        invocation.bindResolvedSessionModel({ provider, model: id });
      } catch (error) {
        await closeCreatedSession(session, sessionManager);
        throw error;
      }
    }
    const activeTools = [...session.getActiveToolNames()].sort();
    const expectedTools = [...allowed].sort();
    if (
      activeTools.length !== expectedTools.length ||
      activeTools.some((tool, index) => tool !== expectedTools[index])
    ) {
      await closeCreatedSession(session, sessionManager);
      const missing = expectedTools.filter((tool) => !activeTools.includes(tool));
      const added = activeTools.filter((tool) => !expectedTools.includes(tool));
      throw new Error(
        `agent '${invocation.agent}' tool surface mismatch before model invocation; missing=[${missing.join(",")}], added=[${added.join(",")}]`
      );
    }
    const traceToolNames = new Set(allowed);
    const livenessProjection = createContentFreeSessionLivenessProjectionState();
    const unsubscribeLiveness =
      invocation.liveness === undefined
        ? undefined
        : session.subscribe((event) => {
            const charge = contentFreeSessionLivenessEvent(
              event,
              traceToolNames,
              livenessProjection
            );
            if (charge !== undefined) invocation.liveness?.(charge);
          });
    const traceSinks = [this.options.sessionTrace, spec?.trace].filter(
      (sink): sink is AgentSessionTraceSink => sink !== undefined
    );
    const unsubscribeTrace =
      traceSinks.length === 0
        ? undefined
        : session.subscribe((event) => {
            const record = contentFreeSessionTraceRecord(event, traceToolNames);
            if (record === undefined) return;
            for (const sink of traceSinks) {
              try {
                sink(record);
              } catch {
                // Diagnostics are observational and may not alter session authority
                // or completion semantics.
              }
            }
          });
    let releaseRuntime: (() => void) | undefined;
    let releaseCompactionProgress: (() => void) | undefined;
    const abort = (): void => {
      void session.abort();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (invocation.signal?.aborted) {
        throw new Error("agent invocation aborted before prompt");
      }
      const providerOpeningAppendix = invocation.providerOpeningAppendix?.();
      const opening =
        spec?.opening ??
        buildAgentOpening({
          invocation,
          registration,
          agentGuidance,
          domainGuidance,
          activeToolNames: activeTools,
          ...(providerOpeningAppendix === undefined ? {} : { providerOpeningAppendix }),
        });
      if (!isolated && this.options.catalogSessions !== undefined) {
        appendCatalogWorkerContinuity({
          manager: sessionManager,
          projectId: this.options.catalogSessions.projectId,
          invocation,
          registeredGuidance: routingRepair
            ? (invocation.routingRepairGuidance ?? "")
            : domainGuidance,
          opening,
        });
      }
      releaseRuntime = this.options.sessionRuntime?.attach(session, invocation);
      if (invocation.liveness !== undefined) {
        releaseCompactionProgress = compactionProgress.observe(session, invocation.signal);
      }
      invocation.guardModelDispatch?.(opening);
      try {
        await session.prompt(opening, { expandPromptTemplates: false, source: "rpc" });
      } catch (error) {
        throw new RemoteModelOutcomeUnknownError(
          `agent '${invocation.agent}' state '${invocation.stateId}' provider outcome is remote_unknown; automatic replay is prohibited`,
          { cause: error }
        );
      }
      // Even a typed private result cannot turn a failed/aborted provider terminal into
      // success. Durable catalog JSONL is finalized below and retains the original turn.
      assertAssistantTerminalSucceeded(
        finalAssistantMessage(session.messages),
        spec?.sensitiveOutput === true
      );
      if (spec?.readResult !== undefined) {
        const body = spec.readResult();
        if (body === undefined) {
          // Fail loudly. Accepting prose here would silently convert a contract
          // violation into a result the workflow would then act on.
          const message =
            spec.requireResultMessage ??
            `agent '${invocation.agent}' ended without submitting a typed result`;
          if (spec.sensitiveOutput === true) {
            throw new Error(`${message}. Private assistant output omitted.`);
          }
          let tail = "(no assistant text)";
          try {
            tail = canonicalAssistantText(session.messages).slice(0, 400);
          } catch {
            /* diagnostics only */
          }
          throw new Error(`${message}. Assistant tail: ${tail}`);
        }
        return { text: body };
      }
      return { text: canonicalAssistantText(session.messages) };
    } finally {
      invocation.signal?.removeEventListener("abort", abort);
      unsubscribeLiveness?.();
      unsubscribeTrace?.();
      try {
        releaseCompactionProgress?.();
        releaseRuntime?.();
      } finally {
        await closeCreatedSession(session, sessionManager);
      }
    }
  }
}
