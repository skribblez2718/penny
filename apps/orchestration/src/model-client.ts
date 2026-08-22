import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
export type { InlineExtension };
import { Type } from "typebox";

import {
  ConfidenceSchema,
  type ArtifactRef,
  type Confidence,
  type JsonValue,
  type SkillContract,
  validateContract,
} from "./contracts.js";
import { researchSummarySchema } from "./playbooks/research.js";

type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type PiModel = NonNullable<CreateSessionOptions["model"]>;
export type SessionThinkingLevel = NonNullable<CreateSessionOptions["thinkingLevel"]>;

export interface AgentInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly task: string;
  readonly projectRoot: string;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly artifactConsumer: string;
  readonly signal?: AbortSignal;
  readonly modelOverride?: string;
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
   * W6: the active skill's guidance declaration. Optional so existing callers keep
   * working; when absent, resolution follows the reference research contract.
   */
  readonly guidance?: SkillContract["guidance"];
  /**
   * Optional session posture supplied by the dispatching playbook.
   *
   * Research supplies nothing and takes the default posture (SSOT tools + the
   * result/artifact tools + the research opening), so its path is unchanged.
   *
   * A playbook whose agents must not hold built-in tool authority — the KB
   * private-reader sessions of `agents-md-research` §5.8 — supplies its own tools
   * and result contract here instead of standing up a second session runner.
   * That duplication is exactly what this seam exists to prevent.
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
  /** Explicit SDK suppression posture. Private KB sessions require `all`. */
  readonly noTools?: "all" | "builtin";
  /** Exact active tool-name allowlist; required with KB `noTools: "all"`. */
  readonly tools?: readonly string[];
  /** Host-closed tools replacing the default result/artifact pair. */
  readonly customTools?: readonly { readonly name: string }[];
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

/** W6 — the resolved worker posture. Tool authority still comes from the agent SSOT. */
export interface WorkerPostureV1 {
  readonly agentGuidancePath: string;
  readonly domainGuidancePath: string;
  readonly allowedTools: readonly string[];
}

/**
 * Default guidance declaration.
 *
 * Before W6 the domain-guidance path was the string literal
 * `.pi/skills/research/assets/prompts/<agent>.md`. Research has since migrated to the
 * phase-specific convention shared with KB, so the no-contract fallback follows the
 * reference skill's declared guidance contract.
 */
export const DEFAULT_GUIDANCE: SkillContract["guidance"] = {
  skill_root: ".pi/skills/research/assets/prompts",
  resolution: "per_agent_phase",
};

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
  guidance?: SkillContract["guidance"];
}): string {
  const guidance = input.guidance ?? DEFAULT_GUIDANCE;
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
 * allow-list: the tools a worker may call come from the SSOT
 * (`.pi/agents/<agent>.md` `tools:`), exactly as the native agent-runner does
 * (the frontmatter `tools:` field is the control plane). The app stays agnostic
 * about the capability's domain.
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
  const record = value as Record<string, unknown>;
  return ["code", "message", "error", "content"]
    .map((key) => boundedProtocolErrorSignal(record[key], depth + 1))
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
  readonly readArtifact?: (ref: ArtifactRef, consumer: string) => Promise<Buffer> | Buffer;
  readonly workerExtensions?: readonly InlineExtension[];
  /**
   * TEST-ONLY. Production omits this so settings/model defaults remain the
   * authority. Live compatibility smokes may pin a level without editing SSOT.
   */
  readonly testOnlyThinkingLevelOverride?: SessionThinkingLevel;
}

interface CapturedRoutingResult {
  readonly confidence: Confidence;
  readonly details: Record<string, JsonValue>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function canonicalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index], "agent message");
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => objectValue(part, "assistant content part"))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
    }
  }
  throw new Error("agent session produced no assistant text");
}

// Under the `hardened-untrusted` trust profile a worker may read and gather but
// must not execute or mutate the (untrusted) target. With the allow-list now
// derived from the SSOT, these built-in execution/mutation tools are stripped
// (the native agent-runner enforces the same authority boundary).
const HARDENED_STRIP = new Set(["bash", "write", "edit"]);

const WORKER_EXTENSION_NAMES = new Set(["search", "youtube"]);

/**
 * Derive a worker's tool allow-list from the SSOT: the `tools:` frontmatter of
 * `.pi/agents/<agent>.md`. That file is the single source of truth for per-agent
 * tool authority (enforced by check_tool_profiles.py); the orchestration app
 * must not maintain a private per-agent table. Fails loudly rather than running
 * a worker with an empty or guessed allow-list.
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
  const names = line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(
      `agent '${agent}' has an empty 'tools:' list; refusing to run with no declared authority`
    );
  }
  return [...new Set(names)];
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
    extensionsOverride(base) {
      const extensions = base.extensions.filter((extension) => {
        // Owner-supplied inline grants are always kept: the execution owner decides
        // what a worker may use (e.g. read-only memory). Only *file* extensions are
        // restricted to the worker-safe set so no other on-disk extension leaks in.
        if (extension.path.startsWith("<inline:")) {
          return true;
        }
        const parent = path.basename(path.dirname(extension.resolvedPath));
        return WORKER_EXTENSION_NAMES.has(parent);
      });
      const allowedPaths = new Set(
        extensions.flatMap((extension) => [extension.path, extension.resolvedPath])
      );
      return {
        ...base,
        extensions,
        errors: base.errors.filter((error) => allowedPaths.has(error.path)),
      };
    },
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class PiAgentClient implements ModelClient {
  constructor(private readonly options: PiAgentClientOptions = {}) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const spec = invocation.session;
    // A dispatcher that brings its own tools also brings its own result contract.
    // Building research's summary schema unconditionally would make this runner
    // reject every non-research state before it ever reached the session — the
    // exact coupling the seam is meant to remove.
    const usesDefaultTools = spec?.customTools === undefined;
    const summarySchema = usesDefaultTools
      ? researchSummarySchema(invocation.stateId)
      : Type.Object({}, { additionalProperties: true });
    const ToolParameters = Type.Object(
      {
        confidence: Type.String({
          pattern: "^(CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN)$",
        }),
        details: summarySchema,
      },
      { additionalProperties: false }
    );
    let captured: CapturedRoutingResult | undefined;
    const readArtifact = this.options.readArtifact;
    const resultTool = defineTool({
      name: "submit_orchestration_result",
      label: "Submit orchestration result",
      description:
        "Submit the typed routing result for this phase exactly once after completing the task.",
      promptSnippet: "Submit the typed result for the current orchestration phase.",
      promptGuidelines: [
        "Call submit_orchestration_result exactly once after the complete stage output is ready.",
      ],
      parameters: ToolParameters,
      async execute(_toolCallId, params) {
        if (captured !== undefined) {
          throw new Error("phase result was already submitted");
        }
        const confidence = validateContract(ConfidenceSchema, params.confidence, "tool confidence");
        const details = validateContract(
          summarySchema,
          params.details,
          `${invocation.stateId} tool result`
        ) as Record<string, JsonValue>;
        captured = { confidence, details };
        return {
          content: [
            {
              type: "text" as const,
              text: "Typed phase result accepted. Finish with the complete stage output.",
            },
          ],
          details: { accepted: true },
        };
      },
    });

    const artifactTool = defineTool({
      name: "artifact_read",
      label: "Read exact artifact",
      description:
        "Read one exact task-granted artifact. Continue from next_offset until truncated is false.",
      parameters: Type.Object(
        {
          artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const ref = invocation.inputArtifacts.find(
          (candidate) => candidate.artifact_id === params.artifact_id
        );
        if (ref === undefined) {
          throw new Error(`artifact '${params.artifact_id}' is not granted`);
        }
        if (readArtifact === undefined) {
          throw new Error("artifact reader is not configured");
        }
        const bytes = await readArtifact(ref, invocation.artifactConsumer);
        const offset = params.offset ?? 0;
        if (offset > bytes.length) {
          throw new Error("artifact offset exceeds byte length");
        }
        let end = Math.min(bytes.length, offset + 48_000);
        while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
          end -= 1;
        }
        const truncated = end < bytes.length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                artifact_id: ref.artifact_id,
                offset,
                next_offset: end,
                truncated,
                text: bytes.subarray(offset, end).toString("utf8"),
              }),
            },
          ],
          details: { nextOffset: end, truncated },
        };
      },
    });

    const isolatedSystemPrompt = spec?.isolatedSystemPrompt;
    const isolated = isolatedSystemPrompt !== undefined;
    const agentGuidance = isolated
      ? ""
      : await optionalText(
          path.join(invocation.projectRoot, ".pi", "agents", `${invocation.agent}.md`)
        );
    // W6: contract-resolved, not hardcoded. Private sessions already carry the
    // exact resolved guidance in their isolated system prompt, so they never
    // rediscover a project/global prompt here.
    const domainGuidance = isolated
      ? ""
      : await optionalText(
          resolveDomainGuidancePath({
            projectRoot: invocation.projectRoot,
            agent: invocation.agent,
            stateId: invocation.stateId,
            ...(invocation.guidance ? { guidance: invocation.guidance } : {}),
          })
        );
    const allowed = isolated
      ? [...(spec?.tools ?? [])]
      : (invocation.trustProfile === "hardened-untrusted"
          ? parseSsotTools(agentGuidance, invocation.agent).filter(
              (tool) => !HARDENED_STRIP.has(tool)
            )
          : [...parseSsotTools(agentGuidance, invocation.agent)]
        ).concat("submit_orchestration_result");
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
    const sessionOptions: CreateSessionOptions = {
      cwd: invocation.projectRoot,
      sessionManager: SessionManager.inMemory(invocation.projectRoot),
      resourceLoader,
      ...(isolatedResources ? { settingsManager: isolatedResources.settingsManager } : {}),
      ...(spec?.noTools !== undefined ? { noTools: spec.noTools } : {}),
      tools: allowed,
      customTools: (spec?.customTools ?? [
        resultTool,
        ...(invocation.inputArtifacts.length > 0 ? [artifactTool] : []),
      ]) as NonNullable<CreateSessionOptions["customTools"]>,
      ...(this.options.testOnlyThinkingLevelOverride === undefined
        ? {}
        : { thinkingLevel: this.options.testOnlyThinkingLevelOverride }),
    };
    if (invocation.modelOverride !== undefined) {
      if (this.options.resolveModel !== undefined) {
        sessionOptions.model = await this.options.resolveModel(invocation.modelOverride);
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
          sessionOptions.model = model;
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
          sessionOptions.model = scoped.model;
        }
        sessionOptions.modelRuntime = runtime;
      }
    }

    if (invocation.admitResolvedModel !== undefined) {
      const resolved = sessionOptions.model as { provider?: unknown; id?: unknown } | undefined;
      const provider = typeof resolved?.provider === "string" ? resolved.provider : "";
      const id = typeof resolved?.id === "string" ? resolved.id : "";
      if (provider.length === 0 || id.length === 0) {
        throw new Error(
          `agent '${invocation.agent}' state '${invocation.stateId}': no resolved model identity to admit; refusing to create a session`
        );
      }
      // Throws on denial. Nothing below this line may run for a denied model.
      invocation.admitResolvedModel({ provider, model: id });
    }

    const { session } = await createAgentSession(sessionOptions);
    const traceToolNames = new Set(allowed);
    const unsubscribeTrace =
      spec?.trace === undefined
        ? undefined
        : session.subscribe((event) => {
            const record = contentFreeSessionTraceRecord(event, traceToolNames);
            if (record === undefined) return;
            try {
              spec.trace?.(record);
            } catch {
              // Diagnostics are observational and may not alter session authority
              // or completion semantics.
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
        [
          `You are executing the '${invocation.agent}' role in a durable research workflow.`,
          agentGuidance,
          domainGuidance,
          "TASK:",
          invocation.task,
          invocation.inputArtifacts.length > 0
            ? `GRANTED INPUT ARTIFACTS:\n${invocation.inputArtifacts
                .map((ref) => JSON.stringify(ref))
                .join("\n")}\nRead each with artifact_read before working.`
            : "GRANTED INPUT ARTIFACTS: none.",
          "Return the complete stage output in assistant text. Use the result tool for routing metadata.",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
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
      const text = canonicalAssistantText(session.messages);
      if (captured === undefined) {
        // The execution owner persists exact assistant bytes before parsing fallback
        // SUMMARY text. WorkerExecutor performs that parse after artifact persistence.
        return { text };
      }
      return {
        text,
        confidence: captured.confidence,
        details: captured.details,
      };
    } finally {
      invocation.signal?.removeEventListener("abort", abort);
      unsubscribeTrace?.();
      session.dispose();
    }
  }
}
