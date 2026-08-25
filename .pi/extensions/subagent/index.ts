import { registerTool } from "../../lib/pi-tool-registration.js";
/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  adaptPiJsonMessage,
  createPendingSingleResult,
  formatUsageStats,
  getFinalOutput,
  mapWithConcurrencyLimit,
  resolveSkillContext,
  runSingleAgent,
  type SingleResult,
  type SubagentCatalogDriftError,
  type SubagentDetails,
  type UsageStats,
  ProgressEmitter,
  MAX_PARALLEL_TASKS,
  MAX_CONCURRENCY,
  WORKER_READ_MEMORY_TOOLS,
} from "./agent-runner.js";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  formatModelVisibleAgentCatalog,
  snapshotAgentCatalog,
} from "./agents.js";
import {
  ArtifactClientError,
  readArtifactsById,
  type ArtifactRef,
} from "../artifacts/owner-client.js";
import { appendInputArtifactInstruction, parseInputArtifacts } from "../artifacts/handoff.js";
import {
  appendBlock,
  exactOutputBlock,
  exactOutputListBlock,
  inlineArtifactMarker,
} from "../artifacts/visible-refs.js";
import { createLogger } from "../../lib/logger/logger.js";
import { resolveToolResultBudget } from "../lib/tool-result-budget.js";
import {
  directAgentOutputMetadata,
  directChainInput,
  directChainOutputMetadata,
  directChainTask,
  persistDirectChainOutput,
} from "./chain-artifacts.js";

const logger = createLogger("subagent");

const COLLAPSED_ITEM_COUNT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstStringArgument(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback: string
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function optionalNumberArgument(
  args: Readonly<Record<string, unknown>>,
  key: string
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

// ── Tool-specific domain types ─────────────────────────────────────────────

// ── Agent discovery at module load (drives dynamic enum + promptSnippet) ──
const registeredDiscovery = discoverAgents(process.cwd(), "project");
const discoveredAgents = registeredDiscovery.agents;
const registeredCatalogSnapshot = snapshotAgentCatalog(registeredDiscovery);
const agentNames =
  discoveredAgents.length > 0 ? discoveredAgents.map((a) => a.name) : ["no-agents-found"];

/** Build Pi's Google-compatible TypeBox enum from the discovered string catalog. */
export function createAgentNameEnumSchema(values: readonly string[]) {
  return StringEnum(values, {
    description: "Name of the agent to invoke",
  });
}

const AgentNameEnum = createAgentNameEnumSchema(agentNames);

const dynamicPromptSnippet =
  discoveredAgents.length > 0
    ? `Delegate to specialized agents (${agentNames.join(", ")}) for domain-specific tasks`
    : "Delegate tasks to specialized subagents (no agents discovered)";

const dynamicAgentCatalog = formatModelVisibleAgentCatalog(discoveredAgents);

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = firstStringArgument(args, ["command"], "...");
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = firstStringArgument(args, ["file_path", "path"], "...");
      const filePath = shortenPath(rawPath);
      const offset = optionalNumberArgument(args, "offset");
      const limit = optionalNumberArgument(args, "limit");
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = firstStringArgument(args, ["file_path", "path"], "...");
      const filePath = shortenPath(rawPath);
      const content = firstStringArgument(args, ["content"], "");
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = firstStringArgument(args, ["file_path", "path"], "...");
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = firstStringArgument(args, ["path"], ".");
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = firstStringArgument(args, ["pattern"], "*");
      const rawPath = firstStringArgument(args, ["path"], ".");
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = firstStringArgument(args, ["pattern"], "");
      const rawPath = firstStringArgument(args, ["path"], ".");
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

// Types and utility functions are now imported from ./agent-runner.js

// getFinalOutput is imported from ./agent-runner.js

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: readonly unknown[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const rawMessage of messages) {
    const message = adaptPiJsonMessage(rawMessage);
    if (message?.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text" && typeof part.text === "string") {
        items.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall") {
        items.push({
          type: "toolCall",
          name: typeof part.name === "string" ? part.name : "",
          args: isRecord(part.arguments) ? part.arguments : {},
        });
      }
    }
  }
  return items;
}

// mapWithConcurrencyLimit, writePromptToTempFile, resolveSkillContext,
// getPiInvocation, and runSingleAgent are now imported from ./agent-runner.js

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// Wrapper that adapts the shared agent-runner's runSingleAgent to the
// subagent extension's OnUpdateCallback type (AgentToolResult vs raw object)
async function runSingleAgentLocal(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  skillContextContent: string | undefined = undefined,
  progressEmitter?: ProgressEmitter,
  modelOverride?: string,
  ownerEnvironment?: NodeJS.ProcessEnv
): Promise<SingleResult> {
  // Adapt OnUpdateCallback from AgentToolResult<SubagentDetails> to the shared
  // agent-runner's simpler update callback signature
  const adaptedOnUpdate: import("./agent-runner.js").OnUpdateCallback | undefined = onUpdate
    ? (partial) => {
        onUpdate({
          content: partial.content,
          details: partial.details,
        });
      }
    : undefined;

  return runSingleAgent(
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    adaptedOnUpdate,
    makeDetails,
    skillContextContent,
    progressEmitter,
    modelOverride,
    ownerEnvironment
  );
}

const ArtifactIdSchema = Type.String({
  pattern: "^art_[a-f0-9]{64}$",
  description: "Exact artifact id from an earlier delegation result",
});

const InputArtifactsSchema = Type.Array(ArtifactIdSchema, {
  uniqueItems: true,
  description:
    "Unique exact artifact IDs from any prior run. The runtime verifies every ID before spawn, and the worker reads exact bytes with artifact_read.",
});

const TaskItem = Type.Object({
  agent: AgentNameEnum,
  task: Type.String({ description: "Task to delegate to the agent" }),
  input_artifacts: Type.Optional(InputArtifactsSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  skillContext: Type.Optional(
    Type.String({
      description:
        "Path to a skill prompt file to inject as \u003cskill_context\u003e in the system prompt, or inline content. Goes between agent body and \u003cagent_boundary\u003e.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override the model for this agent invocation (uses agent's default model if not set)",
    })
  ),
});

const ChainItem = Type.Object({
  agent: AgentNameEnum,
  task: Type.String({
    description:
      "Task with optional {previous} placeholder. The owner replaces it with an exact artifact instruction, never prior payload bytes.",
  }),
  input_artifacts: Type.Optional(InputArtifactsSchema),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  skillContext: Type.Optional(
    Type.String({
      description:
        "Path to a skill prompt file to inject as \u003cskill_context\u003e in the system prompt, or inline content. Goes between agent body and \u003cagent_boundary\u003e.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override the model for this agent invocation (uses agent's default model if not set)",
    })
  ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "project". All scopes resolve to the project\'s .pi/agents/ directory.',
  default: "project",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(AgentNameEnum),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: false.",
      default: true,
    })
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process (single mode)" })
  ),
  skillContext: Type.Optional(
    Type.String({
      description:
        "Path to a skill prompt file to inject as \u003cskill_context\u003e in the system prompt, or inline content. Goes between agent body and \u003cagent_boundary\u003e. Used in single mode only; for parallel/chain, use per-task skillContext.",
    })
  ),
  maxConcurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_PARALLEL_TASKS,
      default: 4,
      description:
        "Max simultaneous agents (1-25, default 4). Raise for bulk parallel analysis; lower for resource-constrained environments.",
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override the model for this agent invocation (uses agent's default model if not set)",
    })
  ),
  input_artifacts: Type.Optional(InputArtifactsSchema),
});

type SubagentToolParams = Static<typeof SubagentParams>;

/** Raised when a caller-supplied artifact ID fails existence/integrity preflight. */
class InputArtifactError extends Error {}
class ArtifactCommunicationError extends Error {}

interface HostToolCatalog {
  getAllTools(): unknown;
}

function hasHostToolCatalog(value: unknown): value is HostToolCatalog {
  return isRecord(value) && typeof value.getAllTools === "function";
}

function isNamedHostTool(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

/** Read an optional host tool catalog while validating every provider name. */
export function readHostToolNames(host: unknown): Set<string> | undefined {
  if (!hasHostToolCatalog(host)) return undefined;
  const tools = host.getAllTools();
  if (!Array.isArray(tools) || !tools.every(isNamedHostTool)) {
    throw new InputArtifactError("TOOL_PROVIDER_CATALOG_INVALID: host tool catalog is malformed");
  }
  return new Set(tools.map((tool) => tool.name));
}

export default function (pi: ExtensionAPI) {
  const handoffBudget = resolveToolResultBudget(process.env);

  const buildInputArtifactHandoff = async (
    artifactIds: readonly string[] | undefined,
    projectRoot: string
  ): Promise<{ input: ReturnType<typeof parseInputArtifacts> } | undefined> => {
    if (!artifactIds || artifactIds.length === 0) return undefined;
    let refs: ArtifactRef[];
    try {
      refs = (await readArtifactsById({ artifactIds, projectRoot, env: process.env })).map(
        (read) => read.ref
      );
    } catch (error) {
      const code = error instanceof ArtifactClientError ? error.code : "ARTIFACT_MISSING";
      throw new InputArtifactError(`${code}: input artifact existence/integrity preflight failed`);
    }
    logger.info("subagent_input_artifacts_verified", {
      count: refs.length,
      artifactIds: refs.map((ref) => ref.artifact_id),
    });
    return {
      input: parseInputArtifacts({
        schema_version: 2,
        artifacts: refs.map((ref, index) => ({
          slot: `input-${(index + 1).toString().padStart(4, "0")}`,
          ref,
        })),
      }),
    };
  };

  const attachOwnerArtifacts = async (options: {
    results: SingleResult[];
    runId: string;
    cwd: string;
    upstreamRefsByIndex?: ReadonlyArray<readonly ArtifactRef[]>;
  }): Promise<void> => {
    for (let index = 0; index < options.results.length; index += 1) {
      const result = options.results[index];
      if (result === undefined) continue;
      try {
        result.outputArtifactRef = await persistDirectChainOutput({
          metadata: directAgentOutputMetadata({
            runId: options.runId,
            index,
            agent: result.agent,
            upstreamRefs: options.upstreamRefsByIndex?.[index],
          }),
          output: getFinalOutput(result.messages),
          cwd: options.cwd,
          env: process.env,
        });
        logger.info("subagent_output_artifact_verified", {
          mode: options.runId.split(":", 1)[0],
          agent: result.agent,
          index,
          artifactId: result.outputArtifactRef.artifact_id,
        });
      } catch (error) {
        const code = error instanceof ArtifactClientError ? error.code : "ARTIFACT_PERSIST_FAILED";
        logger.warn("subagent_output_persist_failed", {
          errorCode: code,
          agent: result.agent,
          mode: options.runId.split(":", 1)[0],
        });
        throw new ArtifactCommunicationError(
          `${code}: exact output for '${result.agent}' could not be persisted and re-read`
        );
      }
    }
  };

  const assertRegisteredProviders = (agents: readonly AgentConfig[], names: readonly string[]) => {
    const registered = readHostToolNames(pi);
    if (registered === undefined) return;
    for (const name of WORKER_READ_MEMORY_TOOLS) registered.add(name);
    for (const requested of new Set(names)) {
      const agent = agents.find((candidate) => candidate.name === requested);
      if (agent === undefined) continue;
      const missing = agent.tools.filter((tool) => !registered.has(tool));
      if (missing.length > 0) {
        throw new InputArtifactError(
          `TOOL_PROVIDER_MISSING: agent '${requested}' declares unregistered tool(s): ${missing.join(", ")}`
        );
      }
    }
  };

  registerTool<typeof SubagentParams, SubagentDetails>(pi, {
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Use when a task matches an agent's specialty and benefits from isolation, parallel work, or separate judgment.",
      "Do not use for trivial direct work; use the skill tool instead for multi-step workflows with state, gates, retries, or resumability.",
      "Modes: single (agent + task), parallel (isolated tasks array), chain (sequential exact-ID handoff through {previous} plus optional explicit inputs).",
      "Every result names its exact output artifact ID; pass those IDs as input_artifacts to give another agent the exact bytes instead of re-running a producer.",
      "Agents are discovered from the project's .pi/agents/ directory.",
      'Use agentScope: "both" to include agents from parent directories.',
      "Pass sufficient context because agents cannot see the parent conversation.",
      "Use skillContext to inject skill-specific prompt content (file path or inline) as <skill_context> in the system prompt.",
      dynamicAgentCatalog,
    ].join(" "),
    promptSnippet: dynamicPromptSnippet,
    parameters: SubagentParams,

    async execute(
      _toolCallId: string,
      params,
      signal: AbortSignal | undefined,
      onUpdate: OnUpdateCallback | undefined,
      ctx: ExtensionContext
    ) {
      const agentScope: AgentScope = params.agentScope ?? "project";
      const parentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      const ownerEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        ...(parentSessionId ? { PENNY_SUBAGENT_PARENT_SESSION_ID: parentSessionId } : {}),
      };
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? false;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const requestedMode: "single" | "parallel" | "chain" = hasChain
        ? "chain"
        : hasTasks
          ? "parallel"
          : "single";

      let artifactRunId: string | undefined;
      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => {
          const outputArtifactRefs = results.flatMap((result) =>
            result.outputArtifactRef ? [result.outputArtifactRef] : []
          );
          // Every mode that produced exact artifacts surfaces them, so the
          // orchestrator can re-read complete output instead of a preview.
          return {
            mode,
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            results,
            ...(artifactRunId ? { artifactRunId } : {}),
            ...(outputArtifactRefs.length > 0
              ? {
                  outputArtifactRefs,
                  finalOutputArtifactRef: outputArtifactRefs.at(-1),
                }
              : {}),
          };
        };

      // Resolve every requested exact ID and every declared provider before any
      // model usage. Cross-run and multi-source fan-in are intentionally valid.
      let singleHandoff: Awaited<ReturnType<typeof buildInputArtifactHandoff>>;
      let taskHandoffs: Array<Awaited<ReturnType<typeof buildInputArtifactHandoff>>> = [];
      let chainHandoffs: Array<Awaited<ReturnType<typeof buildInputArtifactHandoff>>> = [];
      try {
        const requestedAgents = [
          ...(params.agent ? [params.agent] : []),
          ...(params.tasks ?? []).map((task) => task.agent),
          ...(params.chain ?? []).map((step) => step.agent),
        ];
        assertRegisteredProviders(agents, requestedAgents);
        singleHandoff = await buildInputArtifactHandoff(params.input_artifacts, ctx.cwd);
        taskHandoffs = await Promise.all(
          (params.tasks ?? []).map((task) =>
            buildInputArtifactHandoff(task.input_artifacts, ctx.cwd)
          )
        );
        chainHandoffs = await Promise.all(
          (params.chain ?? []).map((step) =>
            buildInputArtifactHandoff(step.input_artifacts, ctx.cwd)
          )
        );
      } catch (error) {
        if (!(error instanceof InputArtifactError)) throw error;
        return {
          content: [{ type: "text", text: `Delegation preflight failed. ${error.message}` }],
          details: makeDetails(requestedMode)([]),
          isError: true,
        };
      }

      const executionCatalogSnapshot = snapshotAgentCatalog(discovery);
      if (executionCatalogSnapshot.digest !== registeredCatalogSnapshot.digest) {
        const error: SubagentCatalogDriftError = {
          code: "SUBAGENT_RELOAD_REQUIRED",
          kind: "catalog_drift",
          retryable: true,
          registeredCatalogDigest: registeredCatalogSnapshot.digest,
          executionCatalogDigest: executionCatalogSnapshot.digest,
        };
        return {
          content: [
            {
              type: "text",
              text: "Subagent catalog drift detected. Run /reload before invoking an agent so the registered schema and execution catalog agree.",
            },
          ],
          details: {
            ...makeDetails(requestedMode)([]),
            error,
          },
          isError: true,
        };
      }

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`
          );
          if (!ok)
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        artifactRunId = `subagent-chain:${randomUUID()}`;
        let previousRef: ArtifactRef | undefined;

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const additionalRefs = chainHandoffs[i]?.input.artifacts.map((binding) => binding.ref);
          const input = directChainInput({
            previousRef,
            additionalRefs,
          });
          const taskWithContext = directChainTask({
            task: step.task,
            input,
            budget: handoffBudget,
          });
          const outputMetadata = directChainOutputMetadata({
            runId: artifactRunId,
            stepIndex: i,
            agent: step.agent,
            upstreamRefs: input.artifacts.map((binding) => binding.ref),
          });

          // Create update callback that includes all previous results.
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...results, currentResult]),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgentLocal(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
            resolveSkillContext(step.skillContext, ctx.cwd),
            undefined,
            step.model,
            ownerEnvironment
          );
          const exactOutput = getFinalOutput(result.messages);
          let stepOutputRef: ArtifactRef;
          try {
            const persisted = await persistDirectChainOutput({
              metadata: outputMetadata,
              output: exactOutput,
              cwd: ctx.cwd,
              env: process.env,
            });
            stepOutputRef = persisted;
            result.outputArtifactRef = persisted;
            logger.info("subagent_output_artifact_verified", {
              mode: "chain",
              agent: step.agent,
              step: i + 1,
              artifactId: persisted.artifact_id,
            });
          } catch (error) {
            if (!(error instanceof ArtifactClientError)) throw error;
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${step.agent}): exact output persistence failed (${error.code}).`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          results.push(result);

          const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted";
          if (isError) {
            const errorMsg = result.errorMessage || result.stderr || exactOutput || "(no output)";
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousRef = stepOutputRef;
        }
        // Only the final step's text is returned inline. Every step's exact
        // output is an artifact, and the ID must reach the model here: it is
        // absent from `details` as far as any provider is concerned.
        const chainRefs = results.flatMap((result) =>
          result.outputArtifactRef
            ? [
                {
                  label: `step ${result.step ?? results.indexOf(result) + 1} (${result.agent})`,
                  ref: result.outputArtifactRef,
                },
              ]
            : []
        );
        return {
          content: [
            {
              type: "text",
              text: appendBlock(
                getFinalOutput(results[results.length - 1].messages) || "(no output)",
                exactOutputListBlock(chainRefs)
              ),
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        // Track all results for streaming updates.
        const allResults = params.tasks.map((task) =>
          createPendingSingleResult(task.agent, task.task)
        );

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          params.maxConcurrency ?? MAX_CONCURRENCY,
          async (t, index) => {
            const handoff = taskHandoffs[index];
            const taskText = handoff
              ? appendInputArtifactInstruction(t.task, handoff.input, handoffBudget)
              : t.task;
            const result = await runSingleAgentLocal(
              ctx.cwd,
              agents,
              t.agent,
              taskText,
              t.cwd,
              undefined,
              signal,
              // Per-task update callback
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails("parallel"),
              resolveSkillContext(t.skillContext, ctx.cwd),
              undefined,
              t.model,
              ownerEnvironment
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          }
        );

        const successCount = results.filter((r) => r.exitCode === 0).length;

        artifactRunId = `subagent-parallel:${randomUUID()}`;
        try {
          await attachOwnerArtifacts({
            results,
            runId: artifactRunId,
            cwd: ctx.cwd,
            upstreamRefsByIndex: taskHandoffs.map(
              (handoff) => handoff?.input.artifacts.map((binding) => binding.ref) ?? []
            ),
          });
        } catch (error) {
          if (!(error instanceof ArtifactCommunicationError)) throw error;
          return {
            content: [{ type: "text", text: `Parallel communication failed. ${error.message}` }],
            details: makeDetails("parallel")(results),
            isError: true,
          };
        }

        // The preview is 100 characters; the artifact is the output. Naming the
        // exact ID inline is what makes the preview a summary of something
        // readable rather than a prompt to re-run the agent.
        const summaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          const suffix = r.outputArtifactRef ? inlineArtifactMarker(r.outputArtifactRef) : "";
          return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}${suffix}`;
        });
        const parallelText = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
        const anyParallelRef = results.some((r) => r.outputArtifactRef);
        return {
          content: [
            {
              type: "text",
              text: anyParallelRef
                ? appendBlock(
                    parallelText,
                    'Previews are truncated at 100 characters. Read any exact output with artifact_read({"artifact":"art_<id>"}).'
                  )
                : parallelText,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const singleTask = singleHandoff
          ? appendInputArtifactInstruction(params.task, singleHandoff.input, handoffBudget)
          : params.task;
        const result = await runSingleAgentLocal(
          ctx.cwd,
          agents,
          params.agent,
          singleTask,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
          resolveSkillContext(params.skillContext, ctx.cwd),
          undefined,
          params.model,
          ownerEnvironment
        );
        const isError =
          result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          const errorMsg =
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(no output)";
          return {
            content: [
              { type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        // Single-mode output is returned in full, but compaction can drop the
        // inline copy later. The artifact keeps it recoverable by exact ref.
        artifactRunId = `subagent-single:${randomUUID()}`;
        try {
          await attachOwnerArtifacts({
            results: [result],
            runId: artifactRunId,
            cwd: ctx.cwd,
            upstreamRefsByIndex: [
              singleHandoff?.input.artifacts.map((binding) => binding.ref) ?? [],
            ],
          });
        } catch (error) {
          if (!(error instanceof ArtifactCommunicationError)) throw error;
          return {
            content: [
              { type: "text", text: `Single-agent communication failed. ${error.message}` },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: result.outputArtifactRef
                ? appendBlock(
                    getFinalOutput(result.messages) || "(no output)",
                    exactOutputBlock(result.outputArtifactRef)
                  )
                : getFinalOutput(result.messages) || "(no output)",
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args: SubagentToolParams, theme: Theme, _context: unknown) {
      const scope: AgentScope = args.agentScope ?? "project";
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          // Clean up {previous} placeholder for display
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(
      result: AgentToolResult<SubagentDetails | undefined>,
      { expanded }: ToolRenderResultOptions,
      theme: Theme,
      _context: unknown
    ) {
      const details = result.details;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const aggregateUsage = (results: SingleResult[]): UsageStats => {
        const total: UsageStats = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
          contextTokens: 0,
        };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
          total.contextTokens += r.usage.contextTokens;
        }
        return total;
      };

      if (details.mode === "chain") {
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const icon =
          successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                theme.fg("toolTitle", theme.bold("chain ")) +
                theme.fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0
            )
          );

          for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0
              )
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0)
            );

            // Show tool calls
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const stepUsage = formatUsageStats(r.usage, r.model);
            if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed view
        let text =
          icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const failCount = details.results.filter((r) => r.exitCode > 0).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0
            )
          );

          for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0)
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0)
            );

            // Show tool calls
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed view (or still running)
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const rIcon =
            r.exitCode === -1
              ? theme.fg("warning", "⏳")
              : r.exitCode === 0
                ? theme.fg("success", "✓")
                : theme.fg("error", "✗");
          const displayItems = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}
