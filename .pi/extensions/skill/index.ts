/**
 * Skill Invocation Extension
 *
 * Drives Python-based skill orchestration with subagent invocation.
 *
 * Architecture:
 *   Penny (DA) → invokes skill tool → this extension drives the loop:
 *     1. Call Python to get next action (state machine decision)
 *     2. Invoke agent directly via the shared agent-runner module
 *     3. Feed results back to Python for next action (state transition)
 *     4. Repeat until complete
 *     5. Return final result to Penny
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

import * as fs from "fs";
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
import {
  parseSummaryFromOutput,
  SkillResult,
  formatResult,
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  detectSkillMode,
  reconstructResumeChain,
  isClarificationEscalation,
} from "./skill-utils.js";
import {
  buildAgentExecutionReceipt,
  buildObservedCommandReceipts,
  parseTrustedHumanEventMarker,
  signTrustedInvocation,
  withExecutionOwnerEnvironment,
} from "./execution-receipts.js";
import {
  ArtifactClientError,
  RESULT_PROTOCOL_VERSION,
  parseArtifactRef,
  parseOutputArtifactMetadata,
  persistArtifactOutput,
  stableArtifactReceiptId,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "./artifact-client.js";
import {
  appendInputArtifactInstruction,
  buildArtifactInvocationEnvironment,
  parseInputArtifacts,
  type InputArtifactsV1,
} from "./input-artifacts.js";
import {
  artifactDispatchControl,
  localArtifactDispatchPause,
  parseArtifactDispatchPause,
  type ArtifactDispatchPause,
} from "./dispatch-control.js";
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
import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";
import { resolveToolResultBudget, type ToolResultBudget } from "../lib/tool-result-budget.js";

const logger = createLogger("skill");

import {
  discoverAgents,
  getFinalOutput,
  resolveSkillContext,
  runSingleAgent,
  type SingleResult,
  type SubagentDetails,
  ProgressEmitter,
  mapWithConcurrencyLimit,
} from "../subagent/agent-runner.js";

// ============================================================
// Error helpers
// ============================================================

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract a stack trace from an unknown thrown value, when available. */
function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** Recognize typed artifact errors across test/runtime module-realm boundaries. */
function isArtifactClientError(err: unknown): err is ArtifactClientError {
  return (
    err instanceof ArtifactClientError ||
    (err instanceof Error &&
      "code" in err &&
      typeof err.code === "string" &&
      err.code.startsWith("ARTIFACT_"))
  );
}

// ============================================================
// Configuration
// ============================================================

interface SkillConfig {
  venvPython: string;
  skillsDir: string;
  skillTimeout: number;
  agentTimeout: number;
  resultBudget: ToolResultBudget;
}

let config: SkillConfig;

// ============================================================
// Types
// ============================================================

// Orchestration step timeout — individual Python steps (explore/plan/critique/taskify)
// should complete well within this; cold starts may need the full window.
const STEP_TIMEOUT_MS = 300_000;

// Action protocol from Python orchestrate.py — canonical source of truth
interface Action {
  action: string; // invoke_agent | invoke_agents_parallel | paused | escalate_to_user | complete | incomplete | error | status
  state_id: string;
  session_id: string;
  // run_id: minted once per run and threaded through every directive. The
  // durable checkpointer (keyed by run_id) owns all FSM state — directives
  // carry NO orchestrator_state.
  run_id?: string;
  complete?: boolean; // present on engine `status` directives
  state?: string; // Allow arbitrary state label from Python
  agent?: string;
  task?: string;
  task_summary?: string;
  // Explicit, orchestrator-supplied skill-context prompt file (single-agent
  // path). When present and non-empty, this WINS over the generic bare
  // `assets/prompts/{agent}.md` guess. Emitted as a path relative to the
  // skill root (e.g. "assets/prompts/tabitha-threat-model.md"); the extension
  // joins it against skill.path. Absent/empty ⇒ fall back to the bare guess.
  skillContext?: string;
  /** Trusted owner metadata for the exact single-agent final output. */
  output_artifact?: OutputArtifactMetadata;
  /** Exact owner-selected predecessor refs for this state. */
  input_artifacts?: InputArtifactsV1;
  tasks?: Array<{
    agent: string;
    task_summary: string;
    model?: string;
    branch_id?: string;
    skillContext?: string;
    /** Trusted owner metadata for this exact fan-out branch output. */
    output_artifact?: OutputArtifactMetadata;
  }>;
  model?: string;
  agent_config?: Record<string, unknown>;
  plan_summary?: Record<string, unknown>;
  /** Structured terminal result from Python; never reconstruct or drop fields. */
  result?: Record<string, unknown>;
  session_room?: string;
  errors?: string[];
  // UNKNOWN_STATE escalation fields
  questions?: Array<{
    id: string;
    label: string;
    prompt: string;
    // OPTIONAL: free-text gate questions legitimately omit predefined options
    // (see normalizeEscalationQuestions). Never call .map on this directly.
    options?: Array<{ value: string; label: string; description?: string }>;
    allowOther?: boolean;
  }>;
  unknown_reason?: string;
  previous_state?: string;
  agent_timeout_ms?: number;
  /**
   * AUTHORITATIVE target root for this run, supplied by the engine (which owns the
   * durable checkpoint). Prefer this over any locally re-derived value: the driver's
   * own `params.project_root || cwd` silently resolves to the DRIVER's cwd on a
   * resume, because the printed resume contract carries no project_root.
   */
  project_root?: string;
  // When true, this response represents a logical step boundary
  // (e.g., job analysis complete, phase transition). The iteration
  // counter only advances on logical_step boundaries, allowing
  // orchestrators to define their own iteration granularity.
  logical_step?: boolean;
  email_data?: {
    to_email: string;
    top_jobs: Array<Record<string, unknown>>;
    stats: Record<string, unknown>;
    errors?: Array<Record<string, unknown>> | null;
  };
  // Present on the `send-email` directive response (callPython for send-email
  // returns a delivery-status object rather than a state-machine action).
  sent?: boolean;
  // Owner-controlled forward-recovery pause. The closed shape is validated by
  // parseArtifactDispatchPause before it becomes a public SkillResult.
  schema_version?: number;
  code?: string;
  reason?: string;
  retryable?: boolean;
  dispatch_mode?: string;
  run_status?: string;
  recovery?: Record<string, unknown>;
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

/**
 * Build a timeout result for an agent that exceeded its time budget.
 */
function createTimeoutResult(agentName: string, timeoutMs: number): SingleResult {
  return {
    agent: agentName,
    agentSource: "project",
    task: "(timed out)",
    exitCode: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: `Agent timed out after ${timeoutMs / 1000}s` }],
      },
    ],
    stderr: `Agent "${agentName}" exceeded timeout of ${timeoutMs / 1000}s`,
    stopReason: "timeout",
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

/** Resolve an interrupted agent promptly instead of waiting for its hard cap. */
function createAbortedResult(agentName: string): SingleResult {
  return {
    agent: agentName,
    agentSource: "project",
    task: "(aborted)",
    exitCode: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Agent invocation interrupted" }],
      },
    ],
    stderr: `Agent "${agentName}" invocation was interrupted`,
    stopReason: "aborted",
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

function abortError(agentName: string): Error {
  return Object.assign(new Error(`Agent "${agentName}" invocation was interrupted`), {
    name: "AbortError",
    code: "AGENT_ABORTED" as const,
  });
}

/**
 * Race an agent promise against a timeout with progress heartbeats.
 *
 * Three-tier threshold model:
 *   - Progress window (timeoutMs): no progress → warning logged
 *   - Staleness kill (timeoutMs × 2): no progress → resolve with fallback/timeout
 *   - Hard cap (timeoutMs × 3): total elapsed → resolve with fallback/timeout
 *
 * `fallbackFactory` is required when `T` is not a single `SingleResult`.
 */
function withAgentTimeout<T>(
  agentPromise: Promise<T>,
  agentName: string,
  signal: AbortSignal | undefined,
  progressEmitter: ProgressEmitter | undefined,
  timeoutMs: number,
  fallbackFactory?: (agentName: string, err?: unknown) => T
): Promise<T> {
  // Backward compatibility: no progressEmitter → one bounded timeout.
  if (!progressEmitter) {
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (result: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish(
          fallbackFactory
            ? fallbackFactory(agentName)
            : (createTimeoutResult(agentName, timeoutMs) as T)
        );
      }, timeoutMs);

      if (signal) {
        const onAbort = () => {
          const err = abortError(agentName);
          finish(
            fallbackFactory
              ? fallbackFactory(agentName, err)
              : (createAbortedResult(agentName) as T)
          );
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      agentPromise.then(
        (result) => finish(result),
        (err) => {
          if (fallbackFactory) {
            finish(fallbackFactory(agentName, err));
            return;
          }
          logger.error(
            "Agent invocation failed",
            { agent: agentName, timeout: `${timeoutMs}ms`, isTimeout: false },
            Object.assign(err instanceof Error ? err : new Error(String(err)), {
              code: "AGENT_ERROR" as ErrorCode,
            })
          );
          finish({
            agent: agentName,
            agentSource: "project",
            task: "(error)",
            exitCode: 1,
            messages: [],
            stderr: `Agent "${agentName}" invocation error: ${(err as Error)?.message || String(err)}`,
            stopReason: "error",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          } as T);
        }
      );
    });
  }

  // Progressive heartbeat monitoring
  return new Promise<T>((resolve) => {
    const totalStart = Date.now();
    let lastProgress = totalStart;
    let resolved = false;

    const onProgress = () => {
      lastProgress = Date.now();
    };
    progressEmitter.on("progress", onProgress);

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(checkInterval);
      progressEmitter.removeAllListeners("progress");
    };

    const checkInterval = setInterval(() => {
      if (resolved) return;
      const elapsed = Date.now() - totalStart;
      const sinceProgress = Date.now() - lastProgress;

      if (elapsed > timeoutMs * 3) {
        // Hard cap kill
        cleanup();
        logger.error(
          "Agent exceeded hard cap timeout",
          { agent: agentName, timeoutMs, elapsed, sinceProgress },
          Object.assign(new Error(`Agent exceeded hard cap of ${timeoutMs * 3}ms`), {
            code: "AGENT_TIMEOUT" as ErrorCode,
          })
        );
        if (fallbackFactory) {
          resolve(fallbackFactory(agentName));
          return;
        }
        resolve(createTimeoutResult(agentName, timeoutMs) as T);
        return;
      }

      if (sinceProgress > timeoutMs * 2) {
        // Staleness kill
        cleanup();
        logger.error(
          "Agent stalled — no progress detected",
          { agent: agentName, timeoutMs, sinceProgress },
          Object.assign(new Error(`Agent stalled for ${sinceProgress}ms`), {
            code: "AGENT_TIMEOUT" as ErrorCode,
          })
        );
        if (fallbackFactory) {
          resolve(fallbackFactory(agentName));
          return;
        }
        resolve(createTimeoutResult(agentName, timeoutMs) as T);
        return;
      }

      if (sinceProgress > timeoutMs) {
        // Warning — agent is slow but not stalled yet
        logger.warn(`Agent ${agentName} slow but hasn't stalled yet`, {
          agent: agentName,
          timeoutMs,
          sinceProgress,
        });
      }
    }, 15_000);

    if (signal) {
      const onAbort = () => {
        if (resolved) return;
        cleanup();
        const err = abortError(agentName);
        resolve(
          fallbackFactory ? fallbackFactory(agentName, err) : (createAbortedResult(agentName) as T)
        );
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    agentPromise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        if (fallbackFactory) {
          resolve(fallbackFactory(agentName, err));
          return;
        }
        logger.error(
          "Agent invocation failed",
          { agent: agentName, timeout: `${timeoutMs}ms`, isTimeout: false },
          Object.assign(err instanceof Error ? err : new Error(String(err)), {
            code: "AGENT_ERROR" as ErrorCode,
          })
        );
        resolve({
          agent: agentName,
          agentSource: "project",
          task: "(error)",
          exitCode: 1,
          messages: [],
          stderr: `Agent "${agentName}" invocation error: ${(err as Error)?.message || String(err)}`,
          stopReason: "error",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        } as T);
      }
    );
  });
}

// ============================================================
// Python Orchestration Calls
// ============================================================

/**
 * Call Python orchestrate.py and parse the JSON action from stdout.
 */
async function callPython(args: string[], cwd: string, timeoutMs: number): Promise<Action> {
  const { spawn } = await import("child_process");
  const { mkdirSync, existsSync } = await import("fs");

  // Node 20+ throws ENOENT from spawn() when cwd does not exist, with an
  // error message that points at the *executable* (not the cwd) — masking
  // the real cause. Create the cwd if missing so user-supplied project
  // roots / output dirs Just Work, including on first run.
  let safeCwd = cwd;
  if (!safeCwd || !existsSync(safeCwd)) {
    try {
      mkdirSync(safeCwd, { recursive: true });
    } catch (mkdirErr: unknown) {
      // Fall back to process.cwd() so spawn can still proceed; the
      // orchestrator script receives the original cwd via its --project-root
      // argument and will create the directory itself if needed.
      logger.warn("Could not create cwd for Python spawn, falling back to process.cwd()", {
        requested: safeCwd,
        error: errorMessage(mkdirErr),
      });
      safeCwd = process.cwd();
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(config.venvPython, args, {
      cwd: safeCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: withExecutionOwnerEnvironment(process.env),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      logger.error(
        "Python timeout",
        { step: args[0], timeout: `${timeoutMs}ms` },
        Object.assign(new Error(`Python timed out after ${timeoutMs}ms`), {
          code: "PYTHON_TIMEOUT" as const,
        })
      );
      resolve({
        action: "error",
        state_id: "error",
        state: "error",
        session_id: "",
        errors: [`Python orchestration timed out after ${timeoutMs}ms`],
      });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const action = JSON.parse(stdout.trim());
        resolve(action);
      } catch {
        logger.warn(
          "Python response parse error",
          { step: args[0], exitCode: code, stderr: stderr.slice(0, 300) },
          Object.assign(new Error(`Python parse error`), { code: "PYTHON_PARSE_ERROR" as const })
        );
        resolve({
          action: "error",
          state_id: "error",
          state: "error",
          session_id: "",
          errors: [
            `Python parse error (exit ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`,
          ],
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger.error(
        "Python spawn failed",
        { step: args[0] },
        Object.assign(err, { code: "PYTHON_SPAWN_ERROR" as const })
      );
      resolve({
        action: "error",
        state_id: "error",
        state: "error",
        session_id: "",
        errors: [err.message],
      });
    });
  });
}

async function pythonStart(
  orchestratePath: string,
  sessionId: string,
  goal: string,
  projectRoot: string,
  constraints: string,
  runId: string
): Promise<Action> {
  // run_id is minted once per run; state lives entirely in the checkpointer.
  const args = [
    orchestratePath,
    "start",
    "--session-id",
    sessionId,
    "--run-id",
    runId,
    "--goal",
    goal,
    "--project-root",
    projectRoot,
    "--constraints",
    constraints,
  ];
  return callPython(args, projectRoot, STEP_TIMEOUT_MS);
}

// Engine path: auto-recover a pending run for this session (re-issue the pending
// step or re-present the escalation). Returns a `status` action if none exists.
async function pythonRecover(
  orchestratePath: string,
  sessionId: string,
  projectRoot: string,
  runId: string
): Promise<Action> {
  return callPython(
    [
      orchestratePath,
      "recover",
      "--session-id",
      sessionId,
      "--run-id",
      runId,
      "--project-root",
      projectRoot,
    ],
    projectRoot,
    STEP_TIMEOUT_MS
  );
}

async function pythonStep(
  orchestratePath: string,
  sessionId: string,
  agent: string,
  resultJson: string,
  projectRoot: string,
  runId: string
): Promise<Action> {
  // --run-id only; state is never sent — the durable checkpointer owns it.
  const args = [
    orchestratePath,
    "step",
    "--session-id",
    sessionId,
    "--agent",
    agent,
    "--result",
    resultJson,
    "--run-id",
    runId,
    "--project-root",
    projectRoot,
  ];
  return callPython(args, projectRoot, STEP_TIMEOUT_MS);
}

// ============================================================
// Result Parsing — extracts minimal summaries for orchestrator
// ============================================================

/**
 * Parse SUMMARY block from agent output.
 * Agents are instructed to emit inline JSON SUMMARY blocks via their
 * skill context prompts. The execution owner persists the exact output first;
 * the orchestrator then receives the summary beside the verified artifact ref.
 *
 * Standard format: SUMMARY:{"key":"value",...}
 * - Single line of valid JSON (no newlines in the JSON)
 * - Starts with SUMMARY: followed immediately by {
 * - Must handle nested braces (arrays of objects)
 */
export { parseSummaryFromOutput, formatResult } from "./skill-utils.js";

// ============================================================
// Skill Context Resolution
// ============================================================

/**
 * Resolve which skill-context prompt file to use for a single-agent dispatch.
 *
 * Preference order (strictly additive / backward-compatible):
 *   1. An explicit, non-empty orchestrator-supplied `explicitContext` (a path
 *      relative to the skill root, e.g. "assets/prompts/tabitha-threat-model.md"),
 *      joined against `skillPath` — used only if it exists on disk.
 *   2. Otherwise the legacy generic bare `assets/prompts/{agent}.md` guess —
 *      used only if it exists on disk.
 *   3. Otherwise undefined (no skill context).
 *
 * Fallback discipline (deliberate, documented choice): an explicit-but-missing
 * (or empty/whitespace-only) context degrades gracefully to the legacy bare
 * guess — it never crashes and is never treated as "explicitly no context".
 * This mirrors the existing existsSync guard used before resolveSkillContext so
 * a non-existent path is never misread as inline content by the runner.
 *
 * Security: `explicitContext` is orchestrator-supplied (trusted today; each
 * skill hardcodes it in Python), but this is shared infra for ALL skills, so it
 * is treated as defense-in-depth untrusted. Before the explicit path is trusted
 * it is fully resolved (path.resolve, which normalizes embedded `..`) and
 * containment-checked against the resolved skill root: the resolved path must be
 * the root itself OR live strictly beneath it. A path that escapes the skill
 * directory (e.g. `../../etc/passwd`, which normalizes to `/etc/passwd`) is
 * treated EXACTLY like a missing path — it falls through to the legacy bare
 * `{agent}.md` guess. This never throws; it just refuses to trust an
 * out-of-bounds path (same graceful-degradation discipline as missing/empty).
 */
export function resolveSkillContextPath(
  skillPath: string,
  agent: string,
  explicitContext: string | undefined
): string | undefined {
  if (explicitContext && explicitContext.trim()) {
    // Resolve both sides so embedded `..`/`.` are normalized, then require the
    // explicit path to stay within the skill root before trusting existsSync.
    const resolvedSkillPath = path.resolve(skillPath);
    const resolvedExplicitPath = path.resolve(resolvedSkillPath, explicitContext.trim());
    const isContained =
      resolvedExplicitPath === resolvedSkillPath ||
      resolvedExplicitPath.startsWith(resolvedSkillPath + path.sep);
    if (isContained && fs.existsSync(resolvedExplicitPath)) return resolvedExplicitPath;
  }
  const bareGuessPath = path.join(skillPath, "assets", "prompts", `${agent}.md`);
  return fs.existsSync(bareGuessPath) ? bareGuessPath : undefined;
}

// ============================================================
// Opt-in TypeScript orchestration pilot
// ============================================================

async function executeTypeScriptSkill(
  skillName: string,
  params: {
    goal: string;
    session_id?: string;
    project_root?: string;
    constraints?: Record<string, unknown>;
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
      errors: ["The TypeScript orchestration pilot currently supports only research."],
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
  const trustedProject =
    typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
  const orchestration = await import("@penny/orchestration/source");
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
  using service = new orchestration.OrchestrationService({
    projectRoot,
    env: process.env,
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
// Skill Execution Loop
// ============================================================

/**
 * Execute a skill by driving the Python ↔ TypeScript loop.
 *
 * 1. Call Python START → get first action
 * 2. For each agent action:
 *    a. Invoke the subagent tool (delegates to subagent extension)
 *    b. Persist exact final-output bytes and verify the canonical ArtifactRef
 *    c. Parse the SUMMARY and bind a signed receipt to the real ref
 *    d. Feed the trusted result wrapper back to Python for the next action
 * 3. Repeat until complete or error
 * 4. Return final result to Penny
 *
 * Exact output stays in the artifact plane. Structured SUMMARY data remains
 * routing input, while optional durable-memory writes are outside this owner's
 * persistence and trust contract.
 */
async function executeSkill(
  skillName: string,
  params: {
    goal: string;
    session_id?: string;
    project_root?: string;
    constraints?: Record<string, unknown>;
    /** Caller-level fallback; an orchestrator's per-state model remains authoritative. */
    model?: string;
    /** Internal owner-only exact handoff from a preceding skill-chain step. */
    chain_input_artifacts?: InputArtifactsV1;
  },
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionAPI,
  onUpdate:
    | ((partial: { content: Array<{ type: string; text: string }>; details: unknown }) => void)
    | undefined
): Promise<SkillResult> {
  const skills = discoverSkills();
  const skill = skills.find((s) => s.name === skillName || s.path.endsWith(skillName));

  if (!skill || !skill.hasOrchestrate) {
    return {
      success: false,
      session_id: params.session_id || "",
      skill_name: skillName,
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: [],
      errors: [skill ? `Skill has no orchestrate.py` : `Skill not found: ${skillName}`],
    };
  }

  // Detect a clarification-resume: after an escalate_to_user, Penny re-invokes
  // with the user's answer alone (constraints.user_response). There is no
  // orchestrator_state to carry — the durable checkpointer (keyed by
  // session_id/run_id) owns all FSM state. `recover` (below) is already
  // session-keyed, so passing the SAME session_id back is sufficient to find
  // the pending run; `step --agent user` then consumes the answer instead of
  // starting a brand-new session (which would re-ask the same questions
  // forever).
  const _constraintsObj =
    params.constraints && typeof params.constraints === "object"
      ? (params.constraints as Record<string, unknown>)
      : {};
  const clarificationResponse = _constraintsObj.user_response;
  const isClarificationResume =
    clarificationResponse !== undefined && clarificationResponse !== null;
  const sessionId = params.session_id || `skill-${Date.now()}`;
  const projectRoot = params.project_root || cwd;
  const orchestratePath = path.join(skill.path, "scripts", "orchestrate.py");
  // `skill_dir` (ABSOLUTE) is injected into every run's constraints so a playbook can
  // hand its agents absolute guidance/validator paths. This matters because an agent
  // subprocess is spawned with `cwd = projectRoot` — the TARGET repo, which for
  // runs against another project are NOT in this repo — so a skill-relative path in a task message
  // ("resources/foo.md", "scripts/bar.py") resolves into the wrong tree and the agent
  // silently proceeds without the guidance. The driver is the only component that knows
  // `skill.path` authoritatively; everything downstream was guessing via __file__ walk-ups.
  // A caller-supplied `skill_dir` still wins (spread last).
  const constraints = (() => {
    if (typeof params.constraints === "string") {
      try {
        const parsed = JSON.parse(params.constraints) as Record<string, unknown>;
        return JSON.stringify({ skill_dir: skill.path, ...parsed });
      } catch {
        // Unparseable string: pass through untouched rather than silently dropping it.
        return params.constraints;
      }
    }
    return JSON.stringify({ skill_dir: skill.path, ..._constraintsObj });
  })();
  const agentsInvoked: string[] = [];
  const errors: string[] = [];
  let interruptionReason: "external_abort" | "skill_timeout" | undefined;

  // Keep one controller local to this skill invocation. An interrupted tool must
  // stop its active child promptly; otherwise the outer call waits until the
  // agent's 3× hard cap (90 minutes at the default) before it can return.
  const agentAbortController = new AbortController();
  const interrupt = (reason: "external_abort" | "skill_timeout") => {
    if (interruptionReason) return;
    interruptionReason = reason;
    agentAbortController.abort(reason);
  };

  if (signal) {
    const onAbort = () => interrupt("external_abort");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // Helper to emit TUI progress updates during orchestration.
  // This keeps the user informed while agents run — without it,
  // the TUI appears frozen for the entire skill duration.
  const emitProgress = (message: string) => {
    onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
  };

  const skillTimer = setTimeout(() => {
    interrupt("skill_timeout");
  }, config.skillTimeout);

  const dispatchPausedResult = (pause: ArtifactDispatchPause): SkillResult => {
    clearTimeout(skillTimer);
    emitProgress(`Dispatch paused at ${pause.state_id}; checkpoint preserved for recovery`);
    return {
      success: false,
      session_id: pause.session_id || sessionId,
      skill_name: skillName,
      state: pause.state_id,
      requires_approval: false,
      steps_total: 0,
      agents_invoked: agentsInvoked,
      errors: [],
      retriable: true,
      dispatch_pause: pause,
      recovery: pause.recovery,
    };
  };

  try {
    // Step 1: Call Python START — or, when the user has answered a prior
    // escalate_to_user, RESUME that session via `step --agent user` so the
    // orchestrator consumes the answer (process_user_clarification →
    // resume_generate) instead of starting over.
    let action: Action;
    let runId = "";
    // Auto-recover a pending run for this session, else start fresh. run_id is
    // minted ONCE per run and reused across step/resume via --run-id. The
    // durable checkpointer (keyed by run_id) owns all FSM state.
    const recovered = await pythonRecover(orchestratePath, sessionId, projectRoot, sessionId);
    // A recovery error belongs to the existing run and must be surfaced. Treating
    // it as "no pending run" starts a second run with resume-only constraints,
    // obscuring the real tool failure and corrupting operator expectations.
    const hasPending = recovered && recovered.action !== "status";
    const recoveredRunId =
      recovered && typeof recovered.run_id === "string" ? recovered.run_id : "";
    if (recovered?.action === "paused") {
      runId = recoveredRunId;
      action = recovered;
    } else if (isClarificationResume) {
      runId = recoveredRunId || randomUUID();
      emitProgress(`Resuming ${skillName} with user clarification...`);
      const trustedHumanEvent =
        typeof clarificationResponse === "string"
          ? parseTrustedHumanEventMarker(clarificationResponse)
          : undefined;
      const clarificationText =
        typeof clarificationResponse === "string"
          ? clarificationResponse
          : JSON.stringify(clarificationResponse);
      const resumeResult = JSON.stringify({
        answer: clarificationResponse,
        clarification: clarificationText,
        user_response: clarificationResponse,
        ...(trustedHumanEvent ? { trusted_human_event: trustedHumanEvent } : {}),
      });
      action = await pythonStep(
        orchestratePath,
        sessionId,
        "user",
        resumeResult,
        projectRoot,
        runId
      );
    } else if (hasPending) {
      runId = recoveredRunId || randomUUID();
      emitProgress(`Resuming ${skillName} run from checkpointer...`);
      action = recovered;
    } else {
      runId = randomUUID();
      emitProgress(`Starting ${skillName} skill...`);
      action = await pythonStart(
        orchestratePath,
        sessionId,
        params.goal,
        projectRoot,
        constraints,
        runId
      );
    }

    if (action.action === "error") {
      clearTimeout(skillTimer);
      return {
        success: false,
        session_id: sessionId,
        skill_name: skillName,
        state: action.state_id || "error",
        requires_approval: false,
        steps_total: 0,
        agents_invoked: [],
        errors: action.errors || ["Python start failed"],
      };
    }
    if (action.action === "paused") {
      return dispatchPausedResult(parseArtifactDispatchPause(action));
    }

    // Step 2: Drive the action loop. A skill-chain predecessor is an
    // execution-owner input, not a caller/model grant. It is offered to the
    // first fresh worker action only; a recovered state with current-run inputs
    // has already incorporated that predecessor and keeps its engine refs.
    const chainInput = params.chain_input_artifacts
      ? parseInputArtifacts(params.chain_input_artifacts)
      : undefined;
    let chainInputPending = Boolean(chainInput);
    const selectWorkerInputs = (engineInput: InputArtifactsV1): InputArtifactsV1 => {
      if (!chainInputPending || !chainInput) return engineInput;
      chainInputPending = false;
      return engineInput.artifacts.length === 0 ? chainInput : engineInput;
    };
    let iterations = 0;
    const maxIterations = parseInt(process.env.PENNY_SKILL_MAX_ITERATIONS || "300");

    while (
      action.action !== "complete" &&
      action.action !== "incomplete" &&
      action.action !== "error" &&
      iterations < maxIterations &&
      !interruptionReason
    ) {
      if (action.action === "paused") {
        return dispatchPausedResult(parseArtifactDispatchPause(action));
      }
      if (action.action === "invoke_agent" || action.action === "invoke_agents_parallel") {
        const dispatchControl = artifactDispatchControl(process.env);
        if (!dispatchControl.dispatchAllowed) {
          // Defense in depth for an older/stale Python engine: the driver still
          // refuses to spend an agent/fan-out dispatch under paused or unknown mode.
          return dispatchPausedResult(
            localArtifactDispatchPause(dispatchControl, {
              state_id: action.state_id,
              session_id: action.session_id,
              run_id: action.run_id || runId,
            })
          );
        }
      }

      // Only count logical step boundaries (orchestrator-defined).
      // If an orchestrator doesn't emit logical_step, fall back to
      // counting every action to preserve backward compatibility.
      if (action.logical_step === true) {
        iterations++;
        emitProgress(
          `Step ${iterations}: ${action.action} (state: ${action.state_id || "?"}) [logical]`
        );
      } else if (action.logical_step === undefined) {
        // Backward-compatible: count every action when logical_step is absent
        iterations++;
        emitProgress(`Step ${iterations}: ${action.action} (state: ${action.state_id || "?"})`);
      } else {
        // logical_step is explicitly false — don't count, just log progress
        emitProgress(`  ↳ ${action.action} (state: ${action.state_id || "?"})`);
      }

      if (action.action === "invoke_agent" && action.agent) {
        // === Single agent invocation via agent-runner ===
        const rawTaskText = action.task || action.task_summary || "";
        // Prefer an explicit orchestrator-supplied skillContext; fall back to
        // the legacy bare `{agent}.md` guess when absent (see
        // resolveSkillContextPath). Returns undefined if neither exists.
        const skillContextPath = resolveSkillContextPath(
          skill.path,
          action.agent,
          action.skillContext
        );
        agentsInvoked.push(action.agent);

        // Discover agents and invoke directly via the shared agent-runner module.
        // The pi framework's ExtensionContext does not provide ctx.tools or
        // ctx.callTool — extensions cannot call other registered tools.
        // We use the same agent-running logic that the subagent extension uses.
        const discovery = discoverAgents(cwd, "project");
        const agents = discovery.agents;
        const makeDetails = (results: SingleResult[]): SubagentDetails => ({
          mode: "single",
          agentScope: "project",
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

        emitProgress(`Running ${action.agent} agent (iteration ${iterations})...`);

        // Stream agent progress to the TUI so the user sees activity
        // instead of a blank screen during multi-minute skill execution.
        const agentOnUpdate = onUpdate
          ? (partial: {
              content: Array<{ type: string; text: string }>;
              details: SubagentDetails;
            }) => {
              const agentOutput = partial.content?.[0]?.text || "running...";
              const preview =
                agentOutput.length > 120 ? `${agentOutput.slice(0, 120)}...` : agentOutput;
              onUpdate({
                content: [{ type: "text", text: `[${action.agent}] ${preview}` }],
                details: partial.details,
              });
            }
          : undefined;

        // The orchestrator may carry a per-agent model override inside the
        // untyped agent_config bag; only honor it when it's actually a string.
        const rawAgentConfigModel = action.agent_config?.["model"];
        const agentConfigModel =
          typeof rawAgentConfigModel === "string" ? rawAgentConfigModel : undefined;

        // AUTHORITATIVE target root, stated by the engine on every directive.
        //
        // `projectRoot` is re-derived per invocation from `params.project_root || cwd`,
        // and the printed resume contract carries NO project_root -- so after the first
        // HITL gate every resumed invocation silently fell back to the DRIVER's cwd.
        // That pointed the agent's cwd and every execution receipt at the wrong
        // repository; Python then rejected all of them with "execution receipt working
        // directory is outside the selected target". The checkpointer owns the run's
        // target, so the directive is authoritative and the local fallback is only for
        // pre-existing playbooks that omit it.
        const targetRoot =
          typeof action.project_root === "string" && action.project_root
            ? action.project_root
            : projectRoot;
        // Validate the complete owner contract BEFORE spending an agent invocation.
        // Missing, extra, stale, or mismatched metadata is an execution-owner fault,
        // never something model output may repair after the fact.
        const stateConsumer = `state:${action.state_id || "unknown"}`;
        const engineInputArtifacts = parseInputArtifacts(action.input_artifacts, {
          runId,
          consumer: stateConsumer,
        });
        const inputArtifacts = selectWorkerInputs(engineInputArtifacts);
        const outputArtifact = parseOutputArtifactMetadata(action.output_artifact, {
          runId,
          phase: action.state_id || "unknown",
          branchId: null,
          producer: `agent:${action.agent}`,
          kind: "agent-output",
        });
        const taskText = appendInputArtifactInstruction(
          rawTaskText,
          inputArtifacts,
          config.resultBudget
        );
        const artifactEnvironment = buildArtifactInvocationEnvironment(
          inputArtifacts,
          `skill:${randomUUID()}`
        );
        const receiptStartedAt = new Date().toISOString();
        const receiptId = stableArtifactReceiptId(outputArtifact);
        const progressEmitter = new ProgressEmitter();
        const agentResult = await withAgentTimeout(
          runSingleAgent(
            cwd,
            agents,
            action.agent,
            taskText,
            targetRoot,
            undefined,
            agentAbortController.signal,
            agentOnUpdate,
            makeDetails,
            resolveSkillContext(skillContextPath, cwd),
            progressEmitter,
            action.model || params.model || agentConfigModel,
            artifactEnvironment
          ),
          action.agent,
          agentAbortController.signal,
          progressEmitter,
          action.agent_timeout_ms ?? config.agentTimeout,
          undefined
        );

        // Preserve the engine's current checkpoint for recovery; never submit a
        // synthetic failed agent result after the outer invocation was interrupted.
        if (interruptionReason) break;

        const output = getFinalOutput(agentResult.messages);
        const isError =
          agentResult.exitCode !== 0 ||
          agentResult.stopReason === "error" ||
          agentResult.stopReason === "aborted";

        // GOV-02 ordering is load-bearing: exact bytes are durable and verified
        // BEFORE model-authored SUMMARY parsing can influence routing.
        const outputArtifactRef = await persistArtifactOutput({
          pythonPath: config.venvPython,
          metadata: outputArtifact,
          output,
          cwd: targetRoot,
          env: process.env,
        });
        const summary = parseSummaryFromOutput(output);
        const summaryMissing = Object.keys(summary).length === 0;
        const configuredSecrets = Array.isArray(_constraintsObj.secret_values)
          ? _constraintsObj.secret_values.filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        const receiptEndedAt = new Date().toISOString();
        const executionReceipt = buildAgentExecutionReceipt({
          receiptId,
          runId,
          stateId: action.state_id || "unknown",
          agent: action.agent,
          // The receipt's working_directory MUST be the selected target: Python
          // validates it against ctx.project_root and rejects anything outside it.
          projectRoot: targetRoot,
          startedAt: receiptStartedAt,
          endedAt: receiptEndedAt,
          exitStatus: isError ? 1 : 0,
          outputArtifactRef,
          output,
          secretValues: configuredSecrets,
        });
        const observedCommandReceipts = buildObservedCommandReceipts({
          messages: agentResult.messages,
          claims: summary.receipt_claims,
          runId,
          stateId: action.state_id || "unknown",
          agent: action.agent,
          projectRoot: targetRoot,
          startedAt: receiptStartedAt,
          endedAt: receiptEndedAt,
          outputArtifactRef,
          secretValues: configuredSecrets,
        });
        const trustedInvocation = signTrustedInvocation({
          invocationId: receiptId,
          runId,
          stateId: action.state_id || "unknown",
          agentIdentity: `agent:${action.agent}`,
          model: agentResult.model || action.model || params.model || agentConfigModel || "",
          startedAt: receiptStartedAt,
          endedAt: receiptEndedAt,
        });
        // NO domain-shaped synthesis. Each state's summary_contract in the
        // playbook is the sole validator. Owner fields remain outside SUMMARY;
        // legacy exit/error/receipt/invocation fields stay present until the Python
        // consumer completes its additive result-protocol-v2 migration.
        const resultJson = JSON.stringify({
          protocol_version: RESULT_PROTOCOL_VERSION,
          run_id: outputArtifactRef.run_id,
          phase: outputArtifactRef.phase,
          branch_id: outputArtifactRef.branch_id,
          producer: outputArtifactRef.producer,
          operation_id: outputArtifactRef.operation_id,
          output_artifact_ref: outputArtifactRef,
          execution_receipt: executionReceipt,
          exitCode: isError ? 1 : 0,
          summary,
          summary_missing: summaryMissing,
          receipts: [executionReceipt, ...observedCommandReceipts],
          trusted_invocation: trustedInvocation,
          error: isError
            ? agentResult.errorMessage ||
              agentResult.stderr.trim() ||
              `Agent "${action.agent}" stopped with ${agentResult.stopReason || "a runtime error"}`
            : summaryMissing
              ? `Agent "${action.agent}" emitted no parseable SUMMARY:{...} block`
              : undefined,
        });

        // Feed result back to Python
        emitProgress(`Processing ${action.agent} results...`);
        action = await pythonStep(
          orchestratePath,
          sessionId,
          action.agent,
          resultJson,
          projectRoot,
          runId
        );
      } else if (action.action === "invoke_agents_parallel" && action.tasks) {
        // === Parallel agent invocation via agent-runner ===
        for (const t of action.tasks) {
          agentsInvoked.push(t.agent);
        }

        const targetRoot =
          typeof action.project_root === "string" && action.project_root
            ? action.project_root
            : projectRoot;
        const stateConsumer = `state:${action.state_id || "unknown"}`;
        const engineInputArtifacts = parseInputArtifacts(action.input_artifacts, {
          runId,
          consumer: stateConsumer,
        });
        const inputArtifacts = selectWorkerInputs(engineInputArtifacts);
        // Validate EVERY branch contract before invoking any branch. A partial
        // fan-out with owner metadata missing on one task must fail closed.
        const parallelTasks = action.tasks.map((t) => {
          if (typeof t.branch_id !== "string" || !t.branch_id.trim()) {
            throw new ArtifactClientError(
              "ARTIFACT_CONTRACT_INVALID",
              "parallel output artifact requires a canonical branch_id"
            );
          }
          return {
            branch_id: t.branch_id,
            agent: t.agent,
            task: appendInputArtifactInstruction(
              t.task_summary,
              inputArtifacts,
              config.resultBudget
            ),
            cwd: targetRoot,
            artifactEnvironment: buildArtifactInvocationEnvironment(
              inputArtifacts,
              `skill:${randomUUID()}`
            ),
            // Honor an orchestrator-supplied per-task prompt (explicit wins over
            // the bare `<agent>.md` guess), path-containment checked — same as the
            // single-agent path. A playbook can fan the same agent out with
            // different role prompts per branch.
            skillContext: resolveSkillContextPath(skill.path, t.agent, t.skillContext),
            model: t.model || params.model,
            outputArtifact: parseOutputArtifactMetadata(t.output_artifact, {
              runId,
              phase: action.state_id || "unknown",
              branchId: t.branch_id,
              producer: `agent:${t.agent}`,
              kind: "agent-output",
            }),
          };
        });

        const agentNames = parallelTasks.map((t) => t.agent).join(", ");
        emitProgress(`Running ${parallelTasks.length} agents in parallel (${agentNames})...`);

        // Discover agents and invoke in parallel via the shared agent-runner module.
        const discovery = discoverAgents(cwd, "project");
        const agents = discovery.agents;
        const makeDetails = (results: SingleResult[]): SubagentDetails => ({
          mode: "parallel",
          agentScope: "project",
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

        // P4: Per-agent timeouts — each agent gets its own full timeout window.
        // Previously the entire batch shared one timeout (unfair to fast agents).
        const individualPromises = parallelTasks.map(async (t) => {
          const receiptStartedAt = new Date().toISOString();
          const progressEmitter = new ProgressEmitter();
          const result = await withAgentTimeout(
            runSingleAgent(
              cwd,
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              agentAbortController.signal,
              undefined,
              makeDetails,
              resolveSkillContext(t.skillContext, cwd),
              progressEmitter,
              t.model,
              t.artifactEnvironment
            ),
            t.agent,
            agentAbortController.signal,
            progressEmitter,
            action.agent_timeout_ms ?? config.agentTimeout,
            (name, err) => {
              const msg = err
                ? `Agent "${name}" failed: ${(err as Error)?.message || String(err)}`
                : `Agent "${name}" timed out after ${(action.agent_timeout_ms ?? config.agentTimeout) / 1000}s`;
              return {
                agent: name,
                agentSource: "project" as const,
                task: "(parallel fallback)",
                exitCode: 1,
                messages: [],
                stderr: msg,
                stopReason: err ? "error" : "timeout",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  contextTokens: 0,
                  turns: 0,
                },
              } as SingleResult;
            }
          );
          return { task: t, result, receiptStartedAt };
        });

        const parallelResults = await Promise.all(individualPromises);
        if (interruptionReason) break;

        // Persist EVERY exact branch output before parsing even one SUMMARY.
        // Promise.all may leave harmless immutable artifacts from successful
        // siblings when one persistence fails, but it never calls pythonStep.
        const persistedBranches = await Promise.all(
          parallelResults.map(async ({ task, result, receiptStartedAt }) => {
            const output = getFinalOutput(result.messages);
            const outputArtifactRef = await persistArtifactOutput({
              pythonPath: config.venvPython,
              metadata: task.outputArtifact,
              output,
              cwd: targetRoot,
              env: process.env,
            });
            return {
              task,
              result,
              output,
              outputArtifactRef,
              receiptStartedAt,
              receiptEndedAt: new Date().toISOString(),
            };
          })
        );

        const configuredSecrets = Array.isArray(_constraintsObj.secret_values)
          ? _constraintsObj.secret_values.filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        // Only after all branch refs are durable may model-authored summaries
        // influence fan-in routing.
        const resultEntries = persistedBranches.map(
          ({ task, result, output, outputArtifactRef, receiptStartedAt, receiptEndedAt }) => {
            const summary = parseSummaryFromOutput(output);
            const summaryMissing = Object.keys(summary).length === 0;
            const isError =
              result.exitCode !== 0 ||
              result.stopReason === "error" ||
              result.stopReason === "aborted";
            const receiptId = stableArtifactReceiptId(task.outputArtifact);
            const executionReceipt = buildAgentExecutionReceipt({
              receiptId,
              runId,
              stateId: action.state_id || "unknown",
              agent: task.agent,
              projectRoot: targetRoot,
              startedAt: receiptStartedAt,
              endedAt: receiptEndedAt,
              exitStatus: isError ? 1 : 0,
              outputArtifactRef,
              output,
              secretValues: configuredSecrets,
            });
            const observedCommandReceipts = buildObservedCommandReceipts({
              messages: result.messages,
              claims: summary.receipt_claims,
              runId,
              stateId: action.state_id || "unknown",
              agent: task.agent,
              projectRoot: targetRoot,
              startedAt: receiptStartedAt,
              endedAt: receiptEndedAt,
              outputArtifactRef,
              secretValues: configuredSecrets,
            });
            const trustedInvocation = signTrustedInvocation({
              invocationId: receiptId,
              runId,
              stateId: action.state_id || "unknown",
              agentIdentity: `agent:${task.agent}`,
              model: result.model || task.model || "",
              startedAt: receiptStartedAt,
              endedAt: receiptEndedAt,
            });

            return {
              protocol_version: RESULT_PROTOCOL_VERSION,
              run_id: outputArtifactRef.run_id,
              phase: outputArtifactRef.phase,
              branch_id: outputArtifactRef.branch_id,
              producer: outputArtifactRef.producer,
              operation_id: outputArtifactRef.operation_id,
              output_artifact_ref: outputArtifactRef,
              execution_receipt: executionReceipt,
              exitCode: isError ? 1 : 0,
              summary,
              summary_missing: summaryMissing,
              receipts: [executionReceipt, ...observedCommandReceipts],
              trusted_invocation: trustedInvocation,
              agent: result.agent,
              error: isError
                ? result.errorMessage ||
                  result.stderr.trim() ||
                  `Agent "${task.agent}" stopped with ${result.stopReason || "a runtime error"}`
                : summaryMissing
                  ? `Agent "${task.agent}" emitted no parseable SUMMARY:{...} block`
                  : undefined,
            };
          }
        );

        const resultJson = JSON.stringify(resultEntries);
        emitProgress("Processing parallel results...");
        // The engine fan-in is keyed per branch, so it takes the
        // "__parallel__" marker rather than a single agent name.
        action = await pythonStep(
          orchestratePath,
          sessionId,
          "__parallel__",
          resultJson,
          projectRoot,
          runId
        );
      } else if (action.action === "escalate_to_user" && action.questions) {
        // === UNKNOWN_STATE escalation — route questionnaire to user ===
        // The FSM entered `unknown` state due to UNCERTAIN confidence.
        // Present the escalation questionnaire to the user, then feed the
        // response back to orchestrate.py as a "user" agent step.
        emitProgress(`Escalating to user for clarification (state: ${action.state_id})...`);

        // Carry the escalation questions through UNNORMALIZED.
        //
        // normalizeEscalationQuestions() keeps only id/label/prompt/options/
        // allowOther/type and therefore DROPS the six trusted-approval binding
        // fields the Python gate attaches (approval_run_id, approval_gate_id,
        // approval_challenge, artifact_ref, questionnaire_transport_ref,
        // rendered_questions_digest). Without them prepareQuestionnairePayload()
        // cannot mint a trustedTransportCapability, the questionnaire tool cannot
        // emit a signed trusted_human_event, and route_user rejects every answer
        // -> a P0 gate re-asks forever and is literally unsatisfiable.
        //
        // Normalization is NOT lost: prepareQuestionnairePayload() calls
        // normalizeEscalationQuestions() itself when building the questions
        // payload, so the defensive `options ?? []` handling still applies (the
        // original reason this normalizer existed: sca charter-gate questions omit
        // `options`, and a bare `q.options.map(...)` throws). Keeping the binding
        // out of that payload also matters because the questionnaire tool's
        // question schema is additionalProperties:false.
        const questionnaireQuestions = action.questions ?? [];

        // Use the questionnaire extension to get user input.
        // ctx.tools.callTool is not available, but the questionnaire tool
        // is registered via the standard Pi tool interface, so we invoke
        // it through the extension context's tool API.
        //
        // NOTE: Since ExtensionContext doesn't provide cross-tool invocation,
        // we return the escalation action to Penny (the DA) who handles
        // questionnaire routing at the conversation level. The escalation
        // data is included in the result for Penny to act on.
        //
        // For now, we treat escalation as a soft stop: include the
        // questionnaire data in the result so Penny can invoke questionnaire
        // and then feed back via `step --agent user`.
        //
        // This is a BREAK from the loop — Penny takes over from here.
        emitProgress(`Escalation required — returning to Penny for user input`);
        agentsInvoked.push("user-escalation");

        const escalationResult: SkillResult = {
          success: false, // Not complete yet — needs user input
          session_id: sessionId,
          skill_name: skillName,
          state: action.state_id || "awaiting_clarification",
          plan: undefined,
          plan_steps: undefined,
          requires_approval: false,
          session_room: action.session_room,
          steps_total: 0,
          agents_invoked: agentsInvoked,
          errors: [],
          escalation: {
            questions: questionnaireQuestions,
            unknown_reason: action.unknown_reason,
            previous_state: action.previous_state,
          },
        };
        return escalationResult;
      } else {
        // Unknown action
        action = {
          action: "error",
          state_id: action.state_id || "error",
          session_id: sessionId,
          errors: [`Unknown action: ${action.action}`],
        } as Action;
        break;
      }
    }

    clearTimeout(skillTimer);

    if (interruptionReason) {
      const state = action.state_id || "unknown";
      if (interruptionReason === "skill_timeout") {
        emitProgress(`Skill timed out after ${config.skillTimeout / 1000}s`);
        errors.push(
          `Skill timed out after ${config.skillTimeout / 1000}s — checkpoint preserved at ${state}; resume with session_id "${sessionId}"`
        );
      } else {
        emitProgress("Skill invocation interrupted; checkpoint preserved");
        errors.push(
          `Skill invocation interrupted — checkpoint preserved at ${state}; resume with session_id "${sessionId}"`
        );
      }
    } else if (action.action === "complete" && action.result?.["met"] === true) {
      emitProgress(`Skill completed successfully`);

      // Issue 1 fix: send report email AFTER the skill loop completes,
      // so the user sees "completed" in the TUI before the email fires.
      const emailData = action.email_data;
      if (emailData && emailData.to_email) {
        emitProgress(`Sending report email to ${emailData.to_email}...`);
        try {
          const emailResult = await callPython(
            [
              orchestratePath,
              "send-email",
              "--to-email",
              emailData.to_email,
              "--top-jobs-json",
              JSON.stringify(emailData.top_jobs || []),
              "--stats-json",
              JSON.stringify(emailData.stats || {}),
              "--errors-json",
              JSON.stringify(emailData.errors ?? null),
            ],
            projectRoot,
            STEP_TIMEOUT_MS
          );
          if (emailResult.sent) {
            emitProgress(`Report email sent to ${emailData.to_email}`);
          } else {
            emitProgress(`Report email could not be sent`);
            errors.push(`Email delivery failed`);
          }
        } catch (emailErr: unknown) {
          logger.error(
            "Report email delivery failed",
            {},
            Object.assign(
              emailErr instanceof Error ? emailErr : new Error(errorMessage(emailErr)),
              { code: "SKILL_REPORT_EMAIL_FAILED" as ErrorCode }
            )
          );
          emitProgress(`Report email failed: ${errorMessage(emailErr)}`);
          errors.push(`Email error: ${errorMessage(emailErr)}`);
        }
      }
    } else if (action.action === "incomplete" || action.result?.["met"] === false) {
      emitProgress(`Skill stopped incomplete — completion predicate was not met`);
      const completionFailures = action.result?.["completion_failures"];
      if (Array.isArray(completionFailures)) {
        errors.push(...completionFailures.map((failure) => String(failure)));
      }
    } else if (iterations >= maxIterations) {
      emitProgress(`Skill reached max iterations (${maxIterations})`);
      errors.push(
        `Skill reached max iterations (${maxIterations}) — last state was ${action.state_id || "unknown"}`
      );
    }

    // A public success signal derives from the complete structured result. A
    // missing result.met is unverified and therefore cannot be promoted to success.
    const isSuccess = action.action === "complete" && action.result?.["met"] === true;
    const planSummary = action.plan_summary as Record<string, unknown> | undefined;
    const terminalRefValue = action.result?.["output_artifact_ref"];
    const outputArtifactRef =
      terminalRefValue === undefined || terminalRefValue === null
        ? undefined
        : parseArtifactRef(terminalRefValue);
    if (outputArtifactRef && outputArtifactRef.run_id !== runId) {
      throw new ArtifactClientError(
        "ARTIFACT_CONTRACT_INVALID",
        "skill terminal output artifact belongs to another run"
      );
    }
    const result: SkillResult = {
      success: isSuccess,
      session_id: sessionId,
      skill_name: skillName,
      state: action.state_id || (isSuccess ? "complete" : "error"),
      plan: planSummary,
      plan_steps: (planSummary?.steps as Array<Record<string, unknown>>) || undefined,
      requires_approval: (planSummary?.requires_approval as boolean) || false,
      session_room: action.session_room || undefined,
      steps_total:
        (planSummary?.steps as unknown[])?.length || (planSummary?.step_count as number) || 0,
      agents_invoked: agentsInvoked,
      errors: [...errors, ...(action.errors || [])],
      result: action.result,
      output_artifact_ref: outputArtifactRef,
    };

    return result;
  } catch (err: unknown) {
    clearTimeout(skillTimer);
    if (isArtifactClientError(err)) {
      // Artifact failures are typed owner failures. Do not flatten them into a
      // model-facing summary error or call pythonStep: the pending checkpoint is
      // intentionally left for deterministic retry/recovery.
      logger.error(
        "Artifact owner capture failed",
        { code: err.code, ...err.metadata },
        Object.assign(new Error(err.message), { code: "SKILL_EXECUTION_FAILED" as const })
      );
      throw err;
    }
    logger.error(
      "Skill execution failed",
      { error: errorMessage(err) },
      Object.assign(new Error(errorMessage(err) || "Unknown error"), {
        code: "SKILL_EXECUTION_FAILED" as const,
        stack: errorStack(err),
      })
    );
    return {
      success: false,
      session_id: sessionId,
      skill_name: skillName,
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: agentsInvoked,
      errors: [errorMessage(err) || "Unknown error"],
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
  engine: Type.Optional(
    Type.String({
      pattern: "^(python|typescript)$",
      description:
        "Execution engine for single research runs. Omit for the stable Python default; TypeScript is an explicit pilot.",
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

// Re-export internals for unit testing
export { createAbortedResult, createTimeoutResult, withAgentTimeout };
export { detectSkillMode } from "./skill-utils.js";

// ============================================================
// Forward declarations (stubs — implemented in Steps 4–5)
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
      const result = await executeSkill(
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
          chainRunId: checkpoint.chain_run_id,
          stepIndex,
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

    const result = await executeSkill(
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
        handoffRef = await persistSkillChainHandoff({
          pythonPath: config.venvPython,
          chainRunId: checkpoint.chain_run_id,
          completedStepIndex: stepIndex,
          nextStepIndex: stepIndex + 1,
          skillName: step.skill_name,
          terminalRef,
          cwd,
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
  // Resolve the python interpreter path at extension-load time. We try:
  //   1. PI_VENV_PYTHON env var
  //   2. PROJECT_ROOT/.venv/bin/python
  //   3. process.cwd()/.venv/bin/python
  // We call realpathSync ONLY to verify the symlink target is an executable
  // file, but we SPAWN the original (symlink) path. A venv's bin/python is a
  // symlink to the base interpreter; Python must be invoked through the
  // symlink (beside pyvenv.cfg) to activate the venv's site-packages.
  // Spawning the realpath'd base binary silently bypasses the venv.
  // If the candidate doesn't exist or isn't executable, we log a clear error
  // pointing at the exact missing path — the user can fix the env without
  // having to dig through Node's ENOENT message.
  const { realpathSync, statSync, existsSync } = fs;
  const candidates = [
    process.env.PI_VENV_PYTHON,
    process.env.PROJECT_ROOT ? path.join(process.env.PROJECT_ROOT, ".venv", "bin", "python") : null,
    path.join(process.cwd(), ".venv", "bin", "python"),
  ].filter((p): p is string => Boolean(p));

  let resolvedPython: string | null = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      // Resolve symlinks ONLY to verify the target is an executable file.
      // Do NOT spawn the realpath: a venv's bin/python is a symlink to the
      // base interpreter, and Python relies on being invoked through the
      // symlink (next to pyvenv.cfg) to activate the venv's site-packages.
      // Spawning the realpath'd base binary bypasses the venv entirely.
      const real = realpathSync(candidate);
      const st = statSync(real);
      // Check executable bit (any of x for owner/group/other)
      if ((st.mode & 0o111) === 0) continue;
      resolvedPython = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!resolvedPython) {
    // Fall back to the original behavior (PI_VENV_PYTHON || first candidate)
    // so spawn still gets a path — the spawn itself will fail with a
    // clear ENOENT message that the user can act on.
    resolvedPython = candidates[0] || "python";
    logger.error(
      `No valid python interpreter found. Tried: ${candidates.join(", ")}. Spawns will fail. Set PI_VENV_PYTHON to a valid executable.`,
      { candidates },
      Object.assign(new Error("no valid python interpreter found"), {
        code: "SKILL_NO_PYTHON_INTERPRETER" as ErrorCode,
      })
    );
  }

  config = {
    venvPython: resolvedPython,
    skillsDir:
      process.env.PENNY_SKILLS_DIR ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), ".pi", "skills"),
    skillTimeout: parseInt(process.env.PENNY_SKILL_TIMEOUT || "43200000"), // 12 hrs (batch processing headroom)
    agentTimeout: parseInt(process.env.PENNY_AGENT_TIMEOUT || "1800000"), // 30 min per agent invocation
    resultBudget: resolveToolResultBudget(process.env),
  };

  // Pi's standard `disable-model-invocation` field is a soft hide: keep those
  // skills executable for explicit `/skill:name` requests, but do not advertise
  // them through this model-facing tool description or the `/skills` listing.
  const skills = modelInvocableSkills(discoverSkills());

  let currentSessionId: string | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    setSessionId(sessionId);
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
      "Use when the operator explicitly asks to initialize, ingest, query, save, lint,",
      "inspect, resume, or prepare promotion for a configured KB profile.",
      "Do not use for canonical current-state lookup without verification, automatic",
      "research ingestion, arbitrary filesystem access, or unapproved canonical writes.",
    ].join(" "),
    execute: async (rawParams: Record<string, unknown>) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schema_version: 1,
              action: rawParams["action"] ?? "unknown",
              status: "disabled",
              met: false,
              ids: [],
              counts: {},
              artifacts: [],
              evidence: [],
              warnings: [
                "Knowledge-base workflows are not yet enabled.",
                "Stateful KB implementation requires G6 (research canary) and G7 (KB core).",
                "This tool is registered but disabled until those gates pass.",
              ],
              unresolved: [],
              next: "none",
            }),
          },
        ],
        details: {
          schema_version: 1,
          action: rawParams["action"] ?? "unknown",
          status: "disabled",
          met: false,
          next: "none",
        },
      };
    },
  });

  pi.registerTool({
    name: "skill",
    label: "Invoke Skill",
    description: [
      "Invoke a skill with durable state-machine orchestration (Python default; TypeScript research pilot only when explicitly selected).",
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

      if (params.engine === "typescript" && detected.mode !== "single") {
        const errorResult: SkillResult = {
          success: false,
          session_id: params.session_id || "error",
          skill_name: "skill",
          state: "error",
          requires_approval: false,
          steps_total: 0,
          agents_invoked: [],
          errors: ["The TypeScript orchestration pilot supports single research mode only."],
        };
        return {
          content: [
            { type: "text", text: formatResult(errorResult, ctx.ui.theme.fg.bind(ctx.ui.theme)) },
          ],
          details: errorResult,
        };
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
          // Reconstruct clean single-mode params (executeSkill signature unchanged)
          const cleanParams = {
            goal,
            session_id: params.session_id,
            project_root: params.project_root,
            constraints: params.constraints,
          };
          result =
            params.engine === "typescript"
              ? await executeTypeScriptSkill(skillName, cleanParams, ctx.cwd, signal, ctx, onUpdate)
              : await executeSkill(skillName, cleanParams, ctx.cwd, signal, ctx, onUpdate);
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


