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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
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
  resolveArtifactPythonPath,
  type ArtifactRef,
} from "../artifacts/owner-client.js";
import { registerOwnerArtifactGrants } from "../artifacts/owner-grants.js";
import { createLogger } from "../../lib/logger/logger.js";
import { resolveToolResultBudget } from "../lib/tool-result-budget.js";
import {
  directAgentOutputMetadata,
  directChainEnvironment,
  directChainInput,
  directChainOutputMetadata,
  directChainTask,
  persistDirectChainOutput,
} from "./chain-artifacts.js";

const logger = createLogger("subagent");

interface SessionStartContext {
  sessionManager: { getSessionId(): string };
}

const COLLAPSED_ITEM_COUNT = 10;

// ── Local types for the (untyped) Pi tool boundary ──────────────────────────
// Pi's ExtensionAPI/ExtensionContext are `any` in the SDK; these interfaces
// pin down the exact shapes this extension actually reads/writes.

/** A single agent invocation as it appears in tool params (task/parallel/chain). */
interface AgentTaskSpec {
  agent: string;
  task: string;
  cwd?: string;
  skillContext?: string;
  model?: string;
}

/** Parameters accepted by the `subagent` tool (mirrors SubagentParams schema). */
interface SubagentToolParams {
  agent?: string;
  task?: string;
  tasks?: AgentTaskSpec[];
  chain?: AgentTaskSpec[];
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
  cwd?: string;
  skillContext?: string;
  maxConcurrency?: number;
  model?: string;
}

/** The execution context Pi passes to tool `execute` (subset this tool uses). */
interface SubagentToolContext {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean> };
}

/** The render theme Pi passes to renderCall/renderResult (fg + bold helpers). */
interface RenderTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

// ── Agent discovery at module load (drives dynamic enum + promptSnippet) ──
const registeredDiscovery = discoverAgents(process.cwd(), "project");
const discoveredAgents = registeredDiscovery.agents;
const registeredCatalogSnapshot = snapshotAgentCatalog(registeredDiscovery);
const agentNames =
  discoveredAgents.length > 0 ? discoveredAgents.map((a) => a.name) : ["no-agents-found"];

const AgentNameEnum = StringEnum(agentNames as unknown as readonly string[], {
  description: "Name of the agent to invoke",
});

const dynamicPromptSnippet =
  discoveredAgents.length > 0
    ? `Delegate to specialized agents (${agentNames.join(", ")}) for domain-specific tasks`
    : "Delegate tasks to specialized subagents (no agents discovered)";

const dynamicAgentCatalog = formatModelVisibleAgentCatalog(discoveredAgents);

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
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

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text || "" });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name || "", args: part.arguments || {} });
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
          content: partial.content as Array<{ type: "text"; text: string }>,
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

const TaskItem = Type.Object({
  agent: AgentNameEnum,
  task: Type.String({ description: "Task to delegate to the agent" }),
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
      "Task with optional {previous} placeholder. The owner replaces it with an exact granted artifact instruction, never prior payload bytes.",
  }),
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
});

export default function (pi: ExtensionAPI) {
  // Resolve owner-lowered caps inside the factory; a cap cannot raise the shared hard limit.
  const handoffBudget = resolveToolResultBudget(process.env);
  let currentSessionId: string | undefined;

  pi.on("session_start", async (_event: unknown, context: SessionStartContext) => {
    currentSessionId = context.sessionManager.getSessionId();
  });

  /**
   * Record owner grants so the orchestrator can re-read exact agent output on
   * demand. Registration never fails a delegation: the agent result is already
   * complete, and a missing grant only costs the optional re-read.
   */
  const grantToOwner = (refs: readonly ArtifactRef[]): ArtifactRef[] => {
    if (!currentSessionId || refs.length === 0) return [...refs];
    try {
      return registerOwnerArtifactGrants({ sessionId: currentSessionId, refs });
    } catch (error) {
      logger.warn("subagent_owner_grant_failed", {
        errorCode: "SUBAGENT_OWNER_GRANT_FAILED",
        reason: error instanceof Error ? error.message : "unknown",
      });
      return [...refs];
    }
  };

  /**
   * Persist exact output for a mode that has no successor worker. Best effort:
   * a persistence failure must not discard a completed agent result.
   */
  const persistOwnerOutput = async (options: {
    pythonPath: string;
    runId: string;
    index: number;
    agent: string;
    output: string;
    cwd: string;
  }): Promise<ArtifactRef | undefined> => {
    if (!options.output) return undefined;
    try {
      return await persistDirectChainOutput({
        pythonPath: options.pythonPath,
        metadata: directAgentOutputMetadata({
          runId: options.runId,
          index: options.index,
          agent: options.agent,
        }),
        output: options.output,
        cwd: options.cwd,
        env: process.env,
      });
    } catch (error) {
      logger.warn("subagent_output_persist_failed", {
        errorCode: "SUBAGENT_OUTPUT_PERSIST_FAILED",
        agent: options.agent,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return undefined;
    }
  };

  /**
   * Persist exact output for each result, grant the owner, and attach the
   * granted refs. Entirely best effort: results are returned unchanged when the
   * artifact plane is unavailable.
   */
  const attachOwnerArtifacts = async (options: {
    results: SingleResult[];
    runId: string;
    cwd: string;
  }): Promise<void> => {
    let pythonPath: string;
    try {
      pythonPath = resolveArtifactPythonPath(options.cwd, process.env);
    } catch (error) {
      logger.warn("subagent_artifact_python_unavailable", {
        errorCode: "SUBAGENT_OUTPUT_PERSIST_FAILED",
        reason: error instanceof Error ? error.message : "unknown",
      });
      return;
    }

    const persisted = await Promise.all(
      options.results.map((result, index) =>
        persistOwnerOutput({
          pythonPath,
          runId: options.runId,
          index,
          agent: result.agent,
          output: getFinalOutput(result.messages),
          cwd: options.cwd,
        })
      )
    );

    const indexed = persisted.flatMap((ref, index) => (ref ? [{ ref, index }] : []));
    if (indexed.length === 0) return;
    const granted = grantToOwner(indexed.map((entry) => entry.ref));
    indexed.forEach((entry, position) => {
      const result = options.results[entry.index];
      if (result) result.outputArtifactRef = granted[position] ?? entry.ref;
    });
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (isolated tasks array), chain (sequential exact-artifact handoff through {previous}).",
      "Agents are discovered from the project's .pi/agents/ directory.",
      'Use agentScope: "both" to include agents from parent directories.',
      "Use skillContext to inject skill-specific prompt content (file path or inline) as <skill_context> in the system prompt.",
      dynamicAgentCatalog,
    ].join(" "),
    promptSnippet: dynamicPromptSnippet,
    promptGuidelines: [
      "Use subagent when a task matches an agent's specialty and benefits from isolated context or specialized constraints.",
      dynamicAgentCatalog,
      "For ad-hoc single tasks, use single mode: { agent, task }. For multi-step workflows with state/approval gates, use the skill tool instead.",
      "Always pass sufficient context in the task parameter — the agent has no access to your conversation history.",
      "Anti-pattern: do NOT use subagent for trivial single-step tasks (single file read, simple edit, one-line bash command). Do those directly with your own tools.",
    ],
    parameters: SubagentParams,

    async execute(
      _toolCallId: string,
      params: SubagentToolParams,
      signal: AbortSignal | undefined,
      onUpdate: OnUpdateCallback | undefined,
      ctx: SubagentToolContext
    ) {
      const agentScope: AgentScope = params.agentScope ?? "project";
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
        const pythonPath = resolveArtifactPythonPath(ctx.cwd, process.env);
        let previousRef: ArtifactRef | undefined;

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const input = directChainInput({
            runId: artifactRunId,
            stepIndex: i,
            previousRef,
          });
          const taskWithContext = directChainTask({
            task: step.task,
            input,
            budget: handoffBudget,
          });
          const ownerEnvironment = directChainEnvironment(
            input,
            `subagent-chain:${artifactRunId}:step:${i + 1}:${randomUUID()}`
          );
          const outputMetadata = directChainOutputMetadata({
            runId: artifactRunId,
            stepIndex: i,
            totalSteps: params.chain.length,
            agent: step.agent,
            previousRef,
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
              pythonPath,
              metadata: outputMetadata,
              output: exactOutput,
              cwd: ctx.cwd,
              env: process.env,
            });
            // Two refs, deliberately kept distinct.
            //
            // `persisted` is the envelope exactly as the manifest stores it. It is
            // the ONLY value that may flow into the next step, because a chain step
            // declares its predecessor in `upstream_refs` and both stores require
            // that envelope to match stored metadata byte-for-byte
            // (artifacts.py `_validate` / artifact-store.ts `validateMetadata`).
            //
            // `grantToOwner` returns a DIFFERENT envelope: it appends
            // `penny-primary:owner` to `consumer_scope` so Penny may read the
            // artifact. Surfacing that ref is correct; forwarding it as an upstream
            // is not — it fails the exact-match check and every step after the
            // first dies with ARTIFACT_PERSIST_FAILED.
            stepOutputRef = persisted;
            result.outputArtifactRef = grantToOwner([persisted])[0] ?? persisted;
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
          // Hand the stored envelope forward, never the owner-granted one.
          previousRef = stepOutputRef;
        }
        return {
          content: [
            {
              type: "text",
              text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
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

        // Track all results for streaming updates
        const allResults: SingleResult[] = new Array(params.tasks.length);

        // Initialize placeholder results
        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: "unknown",
            task: params.tasks[i].task,
            exitCode: -1, // -1 = still running
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          };
        }

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
            const result = await runSingleAgentLocal(
              ctx.cwd,
              agents,
              t.agent,
              t.task,
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
              t.model
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          }
        );

        const successCount = results.filter((r) => r.exitCode === 0).length;

        // Parallel results are previewed, not returned whole. Persist exact
        // output and grant it to the owner so the preview is a summary of
        // something readable rather than the only surviving copy.
        artifactRunId = `subagent-parallel:${randomUUID()}`;
        await attachOwnerArtifacts({
          results,
          runId: artifactRunId,
          cwd: ctx.cwd,
        });

        const summaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          const suffix = r.outputArtifactRef ? " [exact output: artifact_read]" : "";
          return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}${suffix}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgentLocal(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
          resolveSkillContext(params.skillContext, ctx.cwd),
          undefined,
          params.model
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
        await attachOwnerArtifacts({
          results: [result],
          runId: artifactRunId,
          cwd: ctx.cwd,
        });

        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args: SubagentToolParams, theme: RenderTheme, _context: unknown) {
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
      result: AgentToolResult<SubagentDetails>,
      { expanded }: { expanded: boolean },
      theme: RenderTheme,
      _context: unknown
    ) {
      const details = result.details as SubagentDetails | undefined;
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
