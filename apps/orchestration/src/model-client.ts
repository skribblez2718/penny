import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  parseSessionEntries,
  resolveModelScopeWithDiagnostics,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
export type { InlineExtension };

import { canonicalJson } from "./checkpointer.js";
import {
  LivenessTerminalReasonSchema,
  validateContract,
  type ArtifactRef,
  type Confidence,
  type JsonValue,
  type LivenessTerminalReason,
  type SkillContract,
} from "./contracts.js";
import {
  isExternalCallTool,
  LivenessExhaustedError,
  type WorkerPromptBudgetV1,
} from "./liveness.js";
import type { ResearchContextOverlayV1 } from "./research-context.js";
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

export interface ActiveWorkerRegistrationMetadataV1 {
  readonly playbook_name: string;
  readonly workflow_name: string;
  readonly guidance: SkillContract["guidance"];
  readonly result_transport: "persisted_summary" | "host_typed";
  readonly opening_policy: "registration_guidance_task_artifacts" | "host_private_opening";
  readonly model_policy: "directive_override_or_runtime_default" | "host_private_ssot_model";
  /**
   * Exact phase surface projected from the active PlaybookRegistrationV1. Absence preserves
   * YAML equality; presence is the registration-digest-bound strict subset revalidated here.
   */
  readonly allowed_tools?: readonly string[];
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

export function validateCatalogWorkerSessionMetadata(
  value: unknown
): CatalogWorkerSessionMetadataV1 {
  return validateContract(
    CatalogWorkerSessionMetadataV1Schema,
    value,
    "catalog worker session metadata"
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
  /** Bounded owner-resolved content; never used for tool selection or telemetry. */
  readonly contextOverlays?: readonly ResearchContextOverlayV1[];
  readonly signal?: AbortSignal;
  /** Host-enforced, non-observational charge sink. Errors abort before admission. */
  readonly liveness?: AgentSessionLivenessSink;
  /** Read-only projection of the host-enforced counters for this open worker lease. */
  readonly livenessBudget?: WorkerPromptBudgetV1;
  readonly modelOverride?: string;
  /** Host-owned per-invocation policy; when absent, session-level fallback remains authoritative. */
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
 * PlaybookRegistrationV1 may bind one fixed strict subset for an orchestration phase.
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

export type AgentSessionLivenessEventV1 =
  | {
      readonly kind: "model_turn";
      readonly source:
        | "turn_start"
        | "auto_retry_start"
        | "summarization_retry_attempt_start"
        | "compaction_start";
    }
  | { readonly kind: "tool_call"; readonly tool_name: string }
  | {
      readonly kind: "protocol_error";
      readonly tool_name: string;
      readonly error_code: AgentSessionProtocolErrorCodeV1;
    };

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

/** Project one Pi event onto the host-enforced, content-free charge vocabulary. */
export function contentFreeSessionLivenessEvent(
  event: AgentSessionEvent,
  allowedToolNames: ReadonlySet<string>
): AgentSessionLivenessEventV1 | undefined {
  if (
    event.type === "turn_start" ||
    event.type === "auto_retry_start" ||
    event.type === "summarization_retry_attempt_start" ||
    event.type === "compaction_start"
  ) {
    return { kind: "model_turn", source: event.type };
  }
  if (event.type === "tool_execution_start") {
    return {
      kind: "tool_call",
      tool_name: allowedToolNames.has(event.toolName) ? event.toolName : "unknown_tool",
    };
  }
  if (event.type !== "tool_execution_end" || !event.isError) return undefined;
  const unknownTool = !allowedToolNames.has(event.toolName);
  const errorCode = unknownTool
    ? "unknown_tool"
    : contentFreeSessionProtocolErrorCode(event.result);
  return errorCode === undefined
    ? undefined
    : {
        kind: "protocol_error",
        tool_name: unknownTool ? "unknown_tool" : event.toolName,
        error_code: errorCode,
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

export interface PiAgentClientOptions {
  readonly resolveModel?: (modelId: string) => Promise<PiModel> | PiModel;
  readonly workerExtensions?: readonly InlineExtension[];
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
   * TEST-ONLY fallback used only when host invocation policy is absent. Other
   * production sessions omit both fields and retain normal settings behavior.
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

export function canonicalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index], "agent message");
    if (message.role !== "assistant") continue;
    const livenessReason = piAssistantLivenessReason(message);
    if (livenessReason !== undefined) throw new LivenessExhaustedError(livenessReason);
    if (typeof message.content === "string") {
      return requireNonEmptyStageOutput(message.content);
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => objectValue(part, "assistant content part"))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
      return requireNonEmptyStageOutput(text);
    }
    throw new EmptyStageOutputError();
  }
  throw new EmptyStageOutputError();
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

/** The agent SSOT body with its frontmatter removed. */
export function ssotBody(agentDoc: string): string {
  const match = agentDoc.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
  return (match ? agentDoc.slice(match[0].length) : agentDoc).trim();
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

export async function createWorkerResourceLoader(
  projectRoot: string,
  extensionFactories: readonly InlineExtension[] = []
) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(projectRoot, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(extensionFactories.length > 0 ? { extensionFactories: [...extensionFactories] } : {}),
  });
  await loader.reload();
  return loader;
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
  const settingsManager = SettingsManager.inMemory();
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
}): string {
  const repair = input.invocation.executionPurpose === "routing_repair";
  const operativeGuidance = repair ? input.invocation.routingRepairGuidance : input.domainGuidance;
  if (repair && operativeGuidance?.trim().length === 0) {
    throw new Error("routing repair has no mechanically projected summary-only guidance");
  }
  const livenessContext =
    input.invocation.livenessBudget === undefined
      ? ""
      : [
          "HOST-ENFORCED LIVENESS BUDGET:",
          canonicalJson(input.invocation.livenessBudget),
          "EXTERNAL-BUDGET TOOLS:",
          canonicalJson(input.activeToolNames.filter(isExternalCallTool).sort()),
          [
            "Each assistant response consumes one model turn. Reserve one effective model",
            "turn for the final assistant answer. Before emitting tool calls, ensure another",
            "model turn remains for that answer. Every requested tool call—including each",
            "call in a parallel batch—is charged individually. Stop tool use and answer with",
            "the best supported result when evidence is sufficient or another tool round",
            "would consume the reserve.",
          ].join("\n"),
        ].join("\n\n");
  return [
    `You are executing the '${input.invocation.agent}' role for a registered workflow.`,
    input.agentGuidance,
    operativeGuidance ?? "",
    livenessContext,
    "TASK:",
    input.invocation.task,
    input.invocation.inputArtifacts.length > 0
      ? `INPUT ARTIFACTS:\n${input.invocation.inputArtifacts
          .map((ref) => JSON.stringify(ref))
          .join("\n")}\nRead each needed ID with artifact_read before working.`
      : "INPUT ARTIFACTS: none.",
    (input.invocation.contextOverlays?.length ?? 0) > 0
      ? `OWNER-RESOLVED RESEARCH CONTEXT:\n${input.invocation.contextOverlays
          ?.map(
            (overlay) =>
              `SOURCE ENVELOPE ${canonicalJson(overlay.source)}\nCONTENT:\n${overlay.content}`
          )
          .join("\n\n")}`
      : "",
    repair
      ? "Return exactly the one summary-only line required above. Do not return prose or semantic body bytes."
      : "Return the complete stage output in assistant text and end with the closed SUMMARY line defined by the domain guidance.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
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
    const catalogAgentDoc = await optionalText(
      path.join(invocation.projectRoot, ".pi", "agents", `${invocation.agent}.md`)
    );
    if (isolated && catalogAgentDoc.trim().length > 0) {
      throw new Error(
        `catalog agent '${invocation.agent}' cannot run with an isolated replacement tool matrix`
      );
    }
    const agentGuidance = isolated ? "" : catalogAgentDoc;
    // W6: contract-resolved, not hardcoded. Private sessions already carry the
    // exact resolved guidance in their isolated system prompt, so they never
    // rediscover a project/global prompt here.
    const routingRepair = invocation.executionPurpose === "routing_repair";
    if (
      routingRepair !== (invocation.workflowSession?.purpose === "routing_repair") ||
      (routingRepair && invocation.routingRepairGuidance?.trim().length === 0)
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
              stateId: invocation.stateId,
              guidance: registration.guidance,
            })
          );
    if (!isolated && !routingRepair && domainGuidance.trim().length === 0) {
      throw new Error(
        `agent '${invocation.agent}' state '${invocation.stateId}' has empty required guidance`
      );
    }
    const yamlMaximum = isolated ? [] : [...parseSsotTools(agentGuidance, invocation.agent)];
    // This is the sole catalog narrowing gate. WorkerExecutor may copy only the active
    // PlaybookRegistrationV1 phase value here; task/trust/runtime state has no selector.
    // Validate strict membership before createAgentSession, then pass the accepted list unchanged.
    const registeredSubset = registration.allowed_tools;
    if (isolated && registeredSubset !== undefined) {
      throw new Error("private session cannot carry a catalog registration tool subset");
    }
    if (!isolated && registeredSubset !== undefined) {
      if (
        registeredSubset.length === 0 ||
        new Set(registeredSubset).size !== registeredSubset.length ||
        registeredSubset.some((tool) => !yamlMaximum.includes(tool)) ||
        registeredSubset.length >= yamlMaximum.length
      ) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}' registration tools must be one non-empty exact strict subset of YAML`
        );
      }
    }
    const allowed = isolated
      ? [...(spec?.tools ?? [])]
      : registeredSubset === undefined
        ? yamlMaximum
        : [...registeredSubset];
    if (isolated && allowed.length === 0) {
      throw new Error("private session has no exact tool-name allowlist");
    }
    const isolatedResources =
      isolatedSystemPrompt === undefined
        ? undefined
        : await createPrivateSessionResourceLoader({
            projectRoot: invocation.projectRoot,
            systemPrompt: isolatedSystemPrompt,
          });
    const resourceLoader =
      isolatedResources?.resourceLoader ??
      (await createWorkerResourceLoader(
        invocation.projectRoot,
        this.options.workerExtensions ?? []
      ));
    let resolvedModel: PiModel | undefined;
    let resolvedRuntime: CreateSessionOptions["modelRuntime"];
    if (invocation.modelOverride !== undefined) {
      if (this.options.resolveModel !== undefined) {
        resolvedModel = await this.options.resolveModel(invocation.modelOverride);
      } else {
        const runtime = await ModelRuntime.create();
        await runtime.refresh({ allowNetwork: false });
        const separator = invocation.modelOverride.indexOf("/");
        if (separator > 0 && separator !== invocation.modelOverride.length - 1) {
          const provider = invocation.modelOverride.slice(0, separator);
          const modelId = invocation.modelOverride.slice(separator + 1);
          const model = runtime.getModel(provider, modelId);
          if (model === undefined) {
            throw new Error(`model override '${invocation.modelOverride}' is unavailable`);
          }
          resolvedModel = model;
        } else {
          // A catalog alias (an agent SSOT declares `model: sol`, not a
          // provider/model pair). Previously any non-slash override threw, so
          // resolving one here is additive rather than a behaviour change.
          const resolved = await resolveModelScopeWithDiagnostics(
            [invocation.modelOverride],
            runtime
          );
          const scoped = resolved.scopedModels[0];
          if (scoped === undefined) {
            throw new Error(
              `model override '${invocation.modelOverride}' does not resolve to an available model`
            );
          }
          resolvedModel = scoped.model;
        }
        resolvedRuntime = runtime;
      }
    }

    if (invocation.admitResolvedModel !== undefined) {
      const provider = typeof resolvedModel?.provider === "string" ? resolvedModel.provider : "";
      const id = typeof resolvedModel?.id === "string" ? resolvedModel.id : "";
      if (provider.length === 0 || id.length === 0) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}': no resolved model identity to admit; refusing to create a session`
        );
      }
      // Throws on denial. Nothing below this line may create a session.
      invocation.admitResolvedModel({ provider, model: id });
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
    const thinkingLevel = invocation.thinkingLevel ?? this.options.testOnlyThinkingLevelOverride;
    const sessionOptions: CreateSessionOptions = {
      cwd: invocation.projectRoot,
      sessionManager,
      resourceLoader,
      ...(isolatedResources ? { settingsManager: isolatedResources.settingsManager } : {}),
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
    const unsubscribeLiveness =
      invocation.liveness === undefined
        ? undefined
        : session.subscribe((event) => {
            const charge = contentFreeSessionLivenessEvent(event, traceToolNames);
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
    const abort = (): void => {
      void session.abort();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (invocation.signal?.aborted) {
        throw new Error("agent invocation aborted before prompt");
      }
      const opening =
        spec?.opening ??
        buildAgentOpening({
          invocation,
          registration,
          agentGuidance,
          domainGuidance,
          activeToolNames: activeTools,
        });
      await session.prompt(opening, { expandPromptTemplates: false, source: "rpc" });
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
      await closeCreatedSession(session, sessionManager);
    }
  }
}
