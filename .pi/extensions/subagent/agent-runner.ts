/**
 * Shared Agent Runner
 *
 * Core logic for spawning and managing agent processes.
 * Extracted from the subagent extension for reuse by other extensions
 * (e.g., the skill extension) that need direct agent invocation
 * without going through the tool API.
 *
 * The pi framework's ExtensionContext does not provide a way for
 * one extension to call another extension's registered tool
 * (there is no ctx.tools or ctx.callTool). Extensions that need
 * agent invocation must use this shared module directly.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { createLogger } from "../../lib/logger/logger.js";

const logger = createLogger("agent-runner");

// Re-export agent discovery for convenience
export { type AgentConfig, type AgentScope, discoverAgents };

// ============================================================
// Provider resolution
// ============================================================

// Pi's `--model <id>` flag, without `--provider`, performs cross-provider id
// resolution and may select a provider that has no API key configured (e.g.
// amazon-bedrock / github-copilot), crashing the spawned agent at startup.
// Custom providers declared in ~/.pi/agent/models.json (such as a LiteLLM
// proxy) require the matching `--provider`. We resolve the user's configured
// default provider once and reuse it for every dispatched agent.
let _defaultProviderCache: string | null | undefined; // undefined = not yet resolved
function resolveDefaultProvider(): string | undefined {
  if (_defaultProviderCache !== undefined) return _defaultProviderCache ?? undefined;
  // Explicit env override wins.
  const envProvider = process.env.PI_DEFAULT_PROVIDER || process.env.PI_PROVIDER;
  if (envProvider) {
    _defaultProviderCache = envProvider;
    return envProvider;
  }
  // Fall back to Pi's settings.json `defaultProvider`. Note: PI_DIRECTORY points
  // at the PROJECT .pi resources dir, whose settings.json typically has no
  // provider config — the authoritative defaultProvider lives in the global
  // agent config (~/.pi/agent/settings.json). Check candidates in order and use
  // the first one that actually declares a defaultProvider.
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "settings.json") : null,
    path.join(os.homedir(), ".pi", "agent", "settings.json"),
  ].filter((p): p is string => Boolean(p));
  for (const settingsPath of candidates) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { defaultProvider?: string };
      if (settings.defaultProvider) {
        _defaultProviderCache = settings.defaultProvider;
        return settings.defaultProvider;
      }
    } catch {
      // try next candidate
    }
  }
  _defaultProviderCache = null;
  return undefined;
}

// Map a model id to the provider that DECLARES it, by reading the model catalog
// (models.json). This is what makes a MIXED Claude+Ollama fleet work: an agent
// pinned to an Ollama-provider model (e.g. `glm-5.2:cloud`) must be dispatched
// with `--provider ollama`, NOT the global `defaultProvider` (which is
// `anthropic` for Penny herself). Without this, `pi --model glm-5.2:cloud`
// resolves against the default provider (anthropic) and 404s
// (`not_found_error`), taking down every agent-backed skill.
//
// Candidates mirror resolveDefaultProvider's search order (project .pi first,
// then the global agent config). The first declaration of an id wins.
let _modelProviderMapCache: Map<string, string> | undefined;
function loadModelProviderMap(): Map<string, string> {
  if (_modelProviderMapCache) return _modelProviderMapCache;
  const map = new Map<string, string>();
  const candidates = [
    process.env.PI_DIRECTORY ? path.join(process.env.PI_DIRECTORY, "models.json") : null,
    path.join(os.homedir(), ".pi", "agent", "models.json"),
  ].filter((p): p is string => Boolean(p));
  for (const modelsPath of candidates) {
    try {
      const raw = fs.readFileSync(modelsPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      };
      for (const [providerName, providerCfg] of Object.entries(parsed.providers ?? {})) {
        for (const m of providerCfg.models ?? []) {
          if (m.id && !map.has(m.id)) map.set(m.id, providerName);
        }
      }
    } catch {
      // missing/malformed catalog at this candidate — skip it
    }
  }
  _modelProviderMapCache = map;
  return map;
}

/**
 * Resolve the provider that serves `modelId`, or undefined when the model is not
 * declared in any catalog (in which case the caller falls back to the global
 * default provider). Exported for unit testing.
 */
export function resolveProviderForModel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return loadModelProviderMap().get(modelId);
}

// ============================================================
// Constants
// ============================================================

export const MAX_PARALLEL_TASKS = 25;
export const MAX_CONCURRENCY = 25;

// ============================================================
// Types
// ============================================================

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

// ============================================================
// Progress Emitter
// ============================================================

import { EventEmitter } from "node:events";

export interface ProgressEvent {
  type: "tool_result" | "message_end" | "agent_start";
  timestamp: number;
  detail?: string;
}

export class ProgressEmitter extends EventEmitter {
  markProgress(event: ProgressEvent): void {
    this.emit("progress", event);
  }
}

// ============================================================
// Utility functions
// ============================================================

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) {
    const k = count / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}k` : `${rounded.toFixed(1)}k`;
  }
  const m = count / 1000000;
  const roundedM = Math.round(m * 10) / 10;
  return roundedM % 1 === 0 ? `${roundedM.toFixed(0)}M` : `${roundedM.toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text || "";
      }
    }
  }
  return "";
}

// ============================================================
// Pi invocation
// ============================================================

export interface PiInvocation {
  command: string;
  args: string[];
}

/**
 * Canonical filename of pi's CLI entry point.
 * Used to verify that process.argv[1] actually points to pi, not some
 * other Node script that happened to import this module.
 */
const PI_CLI_BASENAME = "cli.js";

export function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];

  // Only re-use execPath + argv[1] when argv[1] is pi's actual entry point.
  // If argv[1] points to any other script (e.g. a test file, a standalone
  // tool), spawning `node <that-script>` would re-execute it recursively,
  // creating a fork bomb.
  if (
    currentScript &&
    fs.existsSync(currentScript) &&
    path.basename(currentScript) === PI_CLI_BASENAME
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ============================================================
// Skill context resolution
// ============================================================

/**
 * Resolve skillContext: if it's a file path that exists, read it;
 * otherwise use as inline content.
 */
export function resolveSkillContext(
  skillContext: string | undefined,
  cwd: string
): string | undefined {
  if (!skillContext || !skillContext.trim()) return undefined;
  const resolvedPath = path.resolve(cwd, skillContext);
  if (fs.existsSync(resolvedPath)) {
    try {
      return fs.readFileSync(resolvedPath, "utf-8");
    } catch {
      // Fall through to inline content
    }
  }
  return skillContext;
}

// ============================================================
// Prompt temp file management
// ============================================================

export async function writePromptToTempFile(
  agentName: string,
  prompt: string
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

// ============================================================
// Concurrency-limited mapping
// ============================================================

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ============================================================
// Single agent execution
// ============================================================

export type OnUpdateCallback = (partial: {
  content: Array<{ type: string; text: string }>;
  details: SubagentDetails;
}) => void;

/**
 * Run a single agent in an isolated pi process.
 *
 * This is the core function for agent invocation. It spawns a pi subprocess
 * with the agent's system prompt, optional skill context, and task description.
 */
export async function runSingleAgent(
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
  modelOverride?: string
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let tmpSessionDir: string | null = null;

  tmpSessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-session-"));
  const compactionPath = path.resolve(defaultCwd, ".pi/extensions/compaction/index.ts");
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    tmpSessionDir,
    "--no-themes",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    compactionPath,
  ];
  const model = modelOverride || agent.model;
  if (model) args.push("--model", model);
  // Pass --provider so custom-provider models (e.g. Ollama :cloud models or a
  // LiteLLM proxy defined in ~/.pi/agent/models.json) resolve correctly. Without
  // it, `pi --model <id>` does cross-provider id resolution and can pick a
  // provider that does not serve the model (crash / 404 not_found at startup).
  // Precedence: agent frontmatter `provider:` → the provider that DECLARES this
  // model in models.json (so an Ollama-model agent gets --provider ollama even
  // when the global defaultProvider is anthropic) → Pi's configured default.
  const provider = agent.provider || resolveProviderForModel(model) || resolveDefaultProvider();
  if (provider) args.push("--provider", provider);
  // Per-agent thinking/effort level (frontmatter `thinking:`), e.g. xhigh. The
  // spawned pi subprocess accepts `--thinking <off|minimal|low|medium|high|xhigh>`.
  if (agent.thinking) args.push("--thinking", agent.thinking);
  // Pass all declared agent tools via --tools so Pi exposes them to the agent.
  // Pi's --tools flag is an allowlist — when passed, ONLY listed tools are
  // available. Without this, builtins and extensions would both be available,
  // but agents list their tools explicitly for a reason (least privilege).
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
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
    model: modelOverride || agent.model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    // Combine agent body with optional skill context
    let combinedPrompt = agent.systemPrompt;
    if (skillContextContent && skillContextContent.trim()) {
      const boundaryMarker = "<agent_boundary>";
      const boundaryIdx = combinedPrompt.indexOf(boundaryMarker);
      if (boundaryIdx !== -1) {
        combinedPrompt =
          combinedPrompt.substring(0, boundaryIdx) +
          `\n<skill_context>\n${skillContextContent}\n</skill_context>\n\n` +
          combinedPrompt.substring(boundaryIdx);
      } else {
        combinedPrompt += `\n\n<skill_context>\n${skillContextContent}\n</skill_context>`;
      }
    }

    if (combinedPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, combinedPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    let buffer = "";
    let eventCount = 0;
    let lastEventType = "";
    let hasMessageEnd = false;
    let _hasAgentEnd = false;
    // _hasAgentEnd tracked for diagnostics; prefix _ per lint convention.
    // Preserve tracking for future use (e.g., detecting agent_end without process exit).

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;

      const resolveOnce = (code: number) => {
        if (resolved) return;
        resolved = true;
        resolve(code);
      };

      const invocation = getPiInvocation(args);
      // stdin = "ignore" so Pi reads /dev/null (immediate EOF).
      // Using "pipe" would keep a writable stream handle in the parent's
      // event loop, preventing Pi's process from exiting cleanly.
      //
      // Pi's print mode exits when the event loop drains. Extensions that
      // create persistent connections (WebSocket, timers) must call .unref()
      // on them, or they prevent the event loop from draining and the
      // subprocess never exits. See: observability/index.ts, memory/index.ts.
      //
      // No hard timeout — Pi has internal safety (context limits, cost limits).
      // The abort signal handles user-initiated cancellation.
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        eventCount++;
        lastEventType = (event.type as string) || "unknown";

        // Emit progress events for heartbeat tracking
        if (progressEmitter) {
          if (event.type === "agent_start") {
            progressEmitter.markProgress({ type: "agent_start", timestamp: Date.now() });
          } else if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            if (msg.role === "assistant" && msg.stopReason) {
              progressEmitter.markProgress({ type: "message_end", timestamp: Date.now() });
            }
          } else if (event.type === "tool_result_end" && event.message) {
            const msg = event.message as Message;
            progressEmitter.markProgress({
              type: "tool_result",
              timestamp: Date.now(),
              detail: (msg as { toolName?: string }).toolName || undefined,
            });
          } else if (event.type === "message" && event.message) {
            const msg = event.message as Message;
            if (msg.role === "toolResult") {
              progressEmitter.markProgress({
                type: "tool_result",
                timestamp: Date.now(),
                detail: (msg as { toolName?: string }).toolName || undefined,
              });
            }
          }
        }

        if (event.type === "agent_end") {
          _hasAgentEnd = true;
          // Pi's print mode sets process.exitCode and returns from main().
          // The process exits when the event loop drains. Extensions that hold
          // event loop references (WebSocket connections, timers) must call
          // .unref() on them so they don't prevent process exit.
          // See: observability/index.ts and memory/index.ts for the .unref() fixes.
        }

        if (event.type === "message_end" && event.message) {
          hasMessageEnd = true;
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost +=
                (usage.cost as { total?: number } | undefined)?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolveOnce(code ?? 0);
      });

      proc.on("error", (err) => {
        logger.error(
          "Agent spawn failed",
          { agent: agentName, error: err.message },
          Object.assign(err, { code: "AGENT_SPAWN_ERROR" as const })
        );
        resolveOnce(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Agent was aborted");

    if (!hasMessageEnd && eventCount > 0) {
      logger.warn(
        "Agent completed without message_end",
        { agent: agentName, events: eventCount, lastType: lastEventType, exitCode },
        Object.assign(new Error("Completed without message_end"), { code: "AGENT_INCOMPLETE" as const })
      );
      // Agent process exited cleanly (exitCode 0) but never emitted message_end.
      // This happens when Pi's SSE stream is killed mid-generation (e.g., 5-min
      // body timeout in undici before 0.70.3) or when the agent crashes without
      // emitting its final message. We must propagate this as an error so the
      // skill extension does NOT treat it as success.
      currentResult.errorMessage =
        currentResult.errorMessage ||
        `Agent '${agentName}' completed without emitting message_end. ` +
          `The agent may have been killed by a timeout or crashed. ` +
          `Events received: ${eventCount}, last event: ${lastEventType}, exit code: ${exitCode}. ` +
          `Check Pi logs for SSE timeout or process errors. ` +
          `Common cause: Pi version < 0.70.3 had a 5-minute SSE body timeout.`;
      currentResult.stopReason = currentResult.stopReason || "incomplete";
      if (currentResult.exitCode === 0) {
        // Process exited cleanly but without a message — treat as failure
        currentResult.exitCode = 1;
      }
    }
    if (currentResult.exitCode !== 0) {
      logger.warn("Agent process exited with non-zero code", {
        agent: agentName,
        exitCode: currentResult.exitCode,
      });
    } else {
      logger.info("Agent completed", {
        agent: agentName,
        events: eventCount,
        exitCode: currentResult.exitCode,
      });
    }

    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    // Use rmSync (not rmdirSync) — Pi writes session files into the session directory.
    if (tmpSessionDir)
      try {
        fs.rmSync(tmpSessionDir, { recursive: true });
      } catch {
        /* ignore — session dir may be locked by Pi process */
      }
  }
}

/**
 * Run multiple agents in parallel with concurrency limiting.
 *
 * @param defaultCwd - Default working directory
 * @param agents - Discovered agent configs
 * @param tasks - Array of task specifications
 * @param signal - Abort signal
 * @param makeDetails - Factory for creating SubagentDetails
 * @returns Array of results, one per task
 */
export async function runAgentsParallel(
  defaultCwd: string,
  agents: AgentConfig[],
  tasks: Array<{
    agent: string;
    task: string;
    cwd?: string;
    skillContext?: string;
  }>,
  signal: AbortSignal | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): Promise<SingleResult[]> {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  }

  const allResults: SingleResult[] = new Array(tasks.length);

  // Initialize placeholder results
  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].agent,
      agentSource: "unknown",
      task: tasks[i].task,
      exitCode: -1,
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

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent(
      defaultCwd,
      agents,
      t.agent,
      t.task,
      t.cwd,
      undefined,
      signal,
      undefined, // No streaming updates for parallel - the caller handles aggregation
      makeDetails,
      resolveSkillContext(t.skillContext, defaultCwd)
    );
    allResults[index] = result;
    return result;
  });

  return results;
}
