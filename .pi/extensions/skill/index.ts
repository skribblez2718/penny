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
 * Key principle: Penny's context window stays clean.
 * All substantial data flows through mempalace (agents read/write directly).
 * The extension only passes minimal summaries to the orchestrator.
 *
 * Agent invocation: Uses the shared agent-runner module from the subagent
 * extension. This module spawns pi processes for agents directly, bypassing
 * the non-existent ctx.tools API (the pi framework's ExtensionContext does
 * not provide cross-tool invocation — extensions cannot call other tools).
 */

import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  parseSummaryFromOutput,
  defaultSummaryForAgent,
  SkillResult,
  formatResult,
  truncateForPrevious,
  getFinalOutputFromSkillResult,
  detectSkillMode,
} from "./skill-utils.js";
import { createLogger, setSessionId, type ErrorCode } from "../../lib/logger/logger.js";

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
// Configuration
// ============================================================

interface SkillConfig {
  venvPython: string;
  skillsDir: string;
  skillTimeout: number;
  agentTimeout: number;
}

let config: SkillConfig;

// Module-level dedup flag: prevents checkAndEmitSignals from running twice per session
let _signalsSurfacedThisSession = false;

/** Test-only setter for _signalsSurfacedThisSession */
export function _setSignalsSurfacedThisSession(value: boolean): void {
  _signalsSurfacedThisSession = value;
}

/** Test-only getter for _signalsSurfacedThisSession */
export function _getSignalsSurfacedThisSession(): boolean {
  return _signalsSurfacedThisSession;
}

// ============================================================
// Types
// ============================================================

interface SkillDiscovery {
  name: string;
  description: string;
  path: string;
  hasOrchestrate: boolean;
}

// Orchestration step timeout — individual Python steps (explore/plan/critique/taskify)
// should complete well within this; cold starts may need the full window.
const STEP_TIMEOUT_MS = 300_000;

// Action protocol from Python orchestrate.py — canonical source of truth
interface Action {
  action: string; // "invoke_agent" | "invoke_agents_parallel" | "escalate_to_user" | "complete" | "error"
  state_id: string;
  session_id: string;
  state?: string; // Allow arbitrary state label from Python
  orchestrator_state?: Record<string, unknown>;
  agent?: string;
  task_summary?: string;
  tasks?: Array<{ agent: string; task_summary: string; model?: string }>;
  model?: string;
  agent_config?: Record<string, unknown>;
  plan_summary?: Record<string, unknown>;
  session_room?: string;
  errors?: string[];
  // UNKNOWN_STATE escalation fields
  questions?: Array<{
    id: string;
    label: string;
    prompt: string;
    options: Array<{ value: string; label: string; description?: string }>;
    allowOther?: boolean;
  }>;
  unknown_reason?: string;
  previous_state?: string;
  agent_timeout_ms?: number;
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
}

// ============================================================
// Skill Discovery
// ============================================================

function discoverSkills(): SkillDiscovery[] {
  const skills: SkillDiscovery[] = [];
  if (!fs.existsSync(config.skillsDir)) return skills;

  for (const entry of fs.readdirSync(config.skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(config.skillsDir, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    const orchestratePath = path.join(skillPath, "scripts", "orchestrate.py");
    if (!fs.existsSync(skillMdPath)) continue;

    let name = entry.name;
    let description = "";
    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const nm = fm[1].match(/^name:\s*(.+)$/m);
        const dm = fm[1].match(/^description:\s*(.+)$/m);
        if (nm) name = nm[1].trim();
        if (dm) description = dm[1].trim();
      }
    } catch {
      logger.debug("Skill metadata parse failed, using default description", { skill: entry.name });
      description = `Skill: ${entry.name}`;
    }

    skills.push({
      name,
      description,
      path: skillPath,
      hasOrchestrate: fs.existsSync(orchestratePath),
    });
  }
  return skills;
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
  // Backward compatibility: no progressEmitter → old single-setTimeout behavior
  if (!progressEmitter) {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        if (fallbackFactory) {
          resolve(fallbackFactory(agentName));
          return;
        }
        resolve(createTimeoutResult(agentName, timeoutMs) as T);
      }, timeoutMs);

      if (signal) {
        signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      }

      agentPromise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          if (fallbackFactory) {
            resolve(fallbackFactory(agentName, err));
            return;
          }
          logger.error(
            "Agent invocation failed",
            { agent: agentName, timeout: `${timeoutMs}ms`, isTimeout: false },
            Object.assign(new Error((err as Error)?.message || String(err)), {
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
      signal.addEventListener("abort", () => cleanup(), { once: true });
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
          Object.assign(new Error((err as Error)?.message || String(err)), {
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
    } catch (mkdirErr: any) {
      // Fall back to process.cwd() so spawn can still proceed; the
      // orchestrator script receives the original cwd via its --project-root
      // argument and will create the directory itself if needed.
      logger.warn(
        "Could not create cwd for Python spawn, falling back to process.cwd()",
        { requested: safeCwd, error: mkdirErr?.message || String(mkdirErr) },
      );
      safeCwd = process.cwd();
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(config.venvPython, args, {
      cwd: safeCwd,
      stdio: ["ignore", "pipe", "pipe"],
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
          code: "PYTHON_TIMEOUT",
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
          Object.assign(new Error(`Python parse error`), { code: "PYTHON_PARSE_ERROR" })
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
        Object.assign(err, { code: "PYTHON_SPAWN_ERROR" })
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

async function checkAndEmitSignals(
  sessionId: string,
  emitProgress: (msg: string) => void
): Promise<void> {
  if (_signalsSurfacedThisSession) return;
  try {
    const { spawn } = await import("child_process");
    const checkerPath = path.join(
      process.env.PROJECT_ROOT || process.cwd(),
      "scripts",
      "system",
      "watchers",
      "session_start_checker.py"
    );
    const venvPython =
      process.env.PI_VENV_PYTHON ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), ".venv", "bin", "python");

    const proc = spawn(venvPython, [checkerPath, sessionId], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", () => {
      // stderr intentionally discarded for signal checker
    });

    await new Promise<void>((resolve) => {
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
      // Failsafe timeout — don't let signal checking block skill start
      setTimeout(resolve, 5000);
    });

    const parsed = JSON.parse(stdout);
    const criticalCount = parsed?.pending?.critical_count ?? 0;
    const infoCount = parsed?.pending?.info_count ?? 0;
    const presentation = parsed?.presentation ?? "";

    if (criticalCount > 0 || infoCount > 0) {
      emitProgress("📡 Pending signals detected:");
      emitProgress(presentation);
    }
  } catch (e) {
    logger.debug("Signal check failed", { error: e instanceof Error ? e.message : String(e) });
  }
  _signalsSurfacedThisSession = true;
}

async function pythonStart(
  orchestratePath: string,
  sessionId: string,
  goal: string,
  projectRoot: string,
  constraints: string
): Promise<Action> {
  return callPython(
    [
      orchestratePath,
      "start",
      "--session-id",
      sessionId,
      "--goal",
      goal,
      "--project-root",
      projectRoot,
      "--constraints",
      constraints,
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
  stateJson: string
): Promise<Action> {
  return callPython(
    [
      orchestratePath,
      "step",
      "--session-id",
      sessionId,
      "--agent",
      agent,
      "--result",
      resultJson,
      "--state",
      stateJson,
      "--project-root",
      projectRoot,
    ],
    projectRoot,
    STEP_TIMEOUT_MS
  );
}

// ============================================================
// Result Parsing — extracts minimal summaries for orchestrator
// ============================================================

/**
 * Parse SUMMARY block from agent output.
 * Agents are instructed to emit inline JSON SUMMARY blocks via their
 * skill context prompts. The orchestrator receives only this summary,
 * not the full agent output. All substantial data flows through mempalace.
 *
 * Standard format: SUMMARY:{"key":"value",...}
 * - Single line of valid JSON (no newlines in the JSON)
 * - Starts with SUMMARY: followed immediately by {
 * - Must handle nested braces (arrays of objects)
 */
export { parseSummaryFromOutput, defaultSummaryForAgent, formatResult } from "./skill-utils.js";

// ============================================================
// Skill Execution Loop
// ============================================================

/**
 * Execute a skill by driving the Python ↔ TypeScript loop.
 *
 * 1. Call Python START → get first action
 * 2. For each agent action:
 *    a. Invoke the subagent tool (delegates to subagent extension)
 *    b. Extract the SUMMARY from agent output (minimal data)
 *    c. Feed summary back to Python for next action
 * 3. Repeat until complete or error
 * 4. Return final result to Penny
 *
 * Mempalace-first: Agents read/write mempalace directly. The extension
 * only passes structured summaries to the Python orchestrator, keeping
 * Penny's context window clean.
 */
async function executeSkill(
  skillName: string,
  params: {
    goal: string;
    session_id?: string;
    project_root?: string;
    constraints?: Record<string, unknown>;
    resumeFrom?: string;  // session_id to resume from a checkpoint
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

  const sessionId = params.session_id || `plan-${Date.now()}`;
  const projectRoot = params.project_root || cwd;
  const orchestratePath = path.join(skill.path, "scripts", "orchestrate.py");
  const constraints = typeof params.constraints === "string"
    ? params.constraints
    : params.constraints ? JSON.stringify(params.constraints) : "{}";
  const agentsInvoked: string[] = [];
  const errors: string[] = [];
  let skillTimedOut = false;

  // Issue 3 fix: create a local AbortController for agent subprocesses.
  // Pi's tool-level AbortSignal must NOT reach agents — Pi can abort a
  // long-running tool call before agents finish, killing all subprocesses
  // and losing all analysis work. Agents have their own 30-min timeout.
  const agentAbortController = new AbortController();

  // If Pi aborts the tool, stop starting new agents but let running ones finish.
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        skillTimedOut = true;
        // NOTE: we deliberately do NOT call agentAbortController.abort() here.
        // The agents have their own timeout (30 min) via withAgentTimeout.
      },
      { once: true }
    );
  }

  // Helper to emit TUI progress updates during orchestration.
  // This keeps the user informed while agents run — without it,
  // the TUI appears frozen for the entire skill duration.
  const emitProgress = (message: string) => {
    onUpdate?.({ content: [{ type: "text", text: message }], details: undefined as any });
  };

  const skillTimer = setTimeout(() => {
    skillTimedOut = true;
  }, config.skillTimeout);

  // ── Resume path: load checkpoint, skip to saved state ──
  if (params.resumeFrom) {
    const cp = readSkillCheckpoint(params.resumeFrom, projectRoot);
    if (!cp) {
      return {
        success: false,
        session_id: params.resumeFrom,
        skill_name: skillName,
        state: "error",
        requires_approval: false,
        steps_total: 0,
        agents_invoked: [],
        errors: [`Skill checkpoint not found for session: ${params.resumeFrom}. The checkpoint file may have been cleaned up or the session ID is incorrect.`],
      };
    }
    logger.info("Resuming skill from checkpoint", {
      skillName: cp.skill_name,
      sessionId: cp.session_id,
      pendingAgent: cp.pending_agent,
      iteration: cp.iteration,
    });
    // Restore saved state and re-invoke the pending agent.
    // The agent reads from mempalace, so it will produce equivalent output.
    const savedState = JSON.stringify(cp.orchestrator_state);
    emitProgress(`Resuming ${skillName} skill — re-running ${cp.pending_agent} agent...`);

    // Re-invoke the agent that was about to run
    const taskText = ""; // Task is in the orchestrator state; agent reads from mempalace
    const skillContextPath = path.join(skill.path, "assets", "prompts", `${cp.pending_agent}.md`);
    const discovery = discoverAgents(cwd, "project");
    const agents = discovery.agents;
    const makeDetails = (results: SingleResult[]): SubagentDetails => ({
      mode: "single",
      agentScope: "project",
      projectAgentsDir: discovery.projectAgentsDir,
      results,
    });
    const progressEmitter = new ProgressEmitter();

    const agentResult = await withAgentTimeout(
      runSingleAgent(
        cwd,
        agents,
        cp.pending_agent,
        taskText,
        projectRoot,
        undefined,
        agentAbortController.signal,
        undefined,
        makeDetails,
        resolveSkillContext(
          fs.existsSync(skillContextPath) ? skillContextPath : undefined,
          cwd
        ),
        progressEmitter,
        undefined
      ),
      cp.pending_agent,
      agentAbortController.signal,
      progressEmitter,
      config.agentTimeout,
      undefined
    );

    const output = getFinalOutput(agentResult.messages);
    const isError =
      agentResult.exitCode !== 0 ||
      agentResult.stopReason === "error" ||
      agentResult.stopReason === "aborted";
    const summary = parseSummaryFromOutput(output);
    const effectiveSummary =
      Object.keys(summary).length > 0 ? summary : defaultSummaryForAgent(cp.pending_agent, output);

    const resultJson = JSON.stringify({
      exitCode: isError ? 1 : 0,
      summary: effectiveSummary,
      error: isError
        ? agentResult.errorMessage || agentResult.stderr || "Agent failed"
        : undefined,
    });

    emitProgress(`Processing ${cp.pending_agent} results...`);
    const action = await pythonStep(
      orchestratePath,
      cp.session_id,
      cp.pending_agent,
      resultJson,
      projectRoot,
      savedState
    );

    if (action.action === "complete") {
      return {
        success: true,
        session_id: cp.session_id,
        skill_name: skillName,
        state: "complete",
        requires_approval: action.plan_summary?.requires_approval || false,
        steps_total: cp.agents_invoked.length + 1,
        agents_invoked: [...cp.agents_invoked, cp.pending_agent],
        errors: [],
        plan_summary: action.plan_summary || {},
        session_room: action.session_room,
      };
    }

    if (action.action === "error") {
      return {
        success: false,
        session_id: cp.session_id,
        skill_name: skillName,
        state: "error",
        requires_approval: false,
        steps_total: cp.agents_invoked.length + 1,
        agents_invoked: [...cp.agents_invoked, cp.pending_agent],
        errors: action.errors || ["Agent step failed after resume"],
      };
    }

    // If the resume produced a non-terminal action, continue the loop
    // BUT: this is complex because we're in a resume path.
    // Simply: resume produced an action → treat as success-like return
    return {
      success: true,
      session_id: cp.session_id,
      skill_name: skillName,
      state: action.state_id || action.action,
      requires_approval: action.plan_summary?.requires_approval || false,
      steps_total: cp.agents_invoked.length + 1,
      agents_invoked: [...cp.agents_invoked, cp.pending_agent],
      errors: [],
      plan_summary: action.plan_summary || {},
      session_room: action.session_room,
    };
  }

  try {
    // ── Ambient Watchers: Check for pending signals before starting skill ──
    if (!_signalsSurfacedThisSession) {
      await checkAndEmitSignals(sessionId, emitProgress);
      _signalsSurfacedThisSession = true;
    }

    emitProgress(`Starting ${skillName} skill...`);

    // Step 1: Call Python START
    let action = await pythonStart(
      orchestratePath,
      sessionId,
      params.goal,
      projectRoot,
      constraints
    );
    let currentStateJson = JSON.stringify(action.orchestrator_state || {});

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

    // Step 2: Drive the action loop
    let iterations = 0;
    const maxIterations = parseInt(process.env.PENNY_SKILL_MAX_ITERATIONS || "300");

    while (
      action.action !== "complete" &&
      action.action !== "error" &&
      iterations < maxIterations &&
      !skillTimedOut
    ) {
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
        const taskText = action.task || action.task_summary || "";
        const skillContextPath = path.join(skill.path, "assets", "prompts", `${action.agent}.md`);
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

        // Save checkpoint before agent runs — enables resume on failure.
        // The orchestrator state captures the FSM position; re-running the
        // agent from this state produces equivalent output (agents read from mempalace).
        try {
          saveSkillCheckpoint(
            {
              skill_name: skillName,
              session_id: sessionId,
              orchestrator_state: JSON.parse(currentStateJson),
              pending_agent: action.agent,
              iteration: iterations,
              agents_invoked: [...agentsInvoked],
              goal: params.goal,
              constraints,
              project_root: projectRoot,
              created_at: "",
            },
            projectRoot
          );
        } catch {
          // Checkpoint save is best-effort; never block the skill on I/O failure
          logger.debug("Failed to save skill checkpoint", { sessionId });
        }

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

        const progressEmitter = new ProgressEmitter();
        const agentResult = await withAgentTimeout(
          runSingleAgent(
            cwd,
            agents,
            action.agent,
            taskText,
            projectRoot,
            undefined,
            agentAbortController.signal,
            agentOnUpdate,
            makeDetails,
            resolveSkillContext(
              fs.existsSync(skillContextPath) ? skillContextPath : undefined,
              cwd
            ),
            progressEmitter,
            action.model || (action as any).agent_config?.model
          ),
          action.agent,
          agentAbortController.signal,
          progressEmitter,
          action.agent_timeout_ms ?? config.agentTimeout,
          undefined
        );

        // Extract minimal summary from agent output.
        // All substantial data is in mempalace — we only send the summary to Python.
        const output = getFinalOutput(agentResult.messages);
        const isError =
          agentResult.exitCode !== 0 ||
          agentResult.stopReason === "error" ||
          agentResult.stopReason === "aborted";

        const summary = parseSummaryFromOutput(output);
        const effectiveSummary =
          Object.keys(summary).length > 0 ? summary : defaultSummaryForAgent(action.agent, output);

        const resultJson = JSON.stringify({
          exitCode: isError ? 1 : 0,
          summary: effectiveSummary,
          error: isError
            ? agentResult.errorMessage || agentResult.stderr || "Agent failed"
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
          currentStateJson
        );
        currentStateJson = JSON.stringify(action.orchestrator_state || currentStateJson);
      } else if (action.action === "invoke_agents_parallel" && action.tasks) {
        // === Parallel agent invocation via agent-runner ===
        for (const t of action.tasks) {
          agentsInvoked.push(t.agent);
        }

        const parallelTasks = action.tasks.map((t) => {
          const skillContextPath = path.join(skill.path, "assets", "prompts", `${t.agent}.md`);
          return {
            agent: t.agent,
            task: t.task_summary,
            cwd: projectRoot,
            skillContext: fs.existsSync(skillContextPath) ? skillContextPath : undefined,
            model: (t as any).model,
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
        const individualPromises = parallelTasks.map((t) => {
          const progressEmitter = new ProgressEmitter();
          return withAgentTimeout(
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
              t.model
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
        });

        const parallelResults = await Promise.all(individualPromises);

        // Extract summaries from parallel results
        const resultEntries = parallelResults.map((r) => {
          const output = getFinalOutput(r.messages);
          const summary = parseSummaryFromOutput(output);
          const effectiveSummary =
            Object.keys(summary).length > 0 ? summary : defaultSummaryForAgent(r.agent, output);

          return {
            exitCode: r.exitCode !== 0 ? 1 : 0,
            summary: effectiveSummary,
            agent: r.agent,
          };
        });

        const resultJson = JSON.stringify(resultEntries);
        emitProgress("Processing parallel results...");
        action = await callPython(
          [
            orchestratePath,
            "step",
            "--session-id",
            sessionId,
            "--agent",
            "echo",
            "--result",
            resultJson,
            "--state",
            currentStateJson,
            "--project-root",
            projectRoot,
          ],
          projectRoot,
          STEP_TIMEOUT_MS
        );
        currentStateJson = JSON.stringify(action.orchestrator_state || currentStateJson);
      } else if (action.action === "escalate_to_user" && action.questions) {
        // === UNKNOWN_STATE escalation — route questionnaire to user ===
        // The FSM entered `unknown` state due to UNCERTAIN confidence.
        // Present the escalation questionnaire to the user, then feed the
        // response back to orchestrate.py as a "user" agent step.
        emitProgress(`Escalating to user for clarification (state: ${action.state_id})...`);

        // Build questionnaire from orchestrate.py's escalation questions
        const questionnaireQuestions = action.questions.map((q) => ({
          id: q.id,
          label: q.label,
          prompt: q.prompt,
          options: q.options.map((o) => ({
            value: o.value,
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          allowOther: q.allowOther ?? true,
        }));

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
            orchestrator_state: action.orchestrator_state,
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

    if (skillTimedOut) {
      emitProgress(`Skill timed out after ${config.skillTimeout / 1000}s`);
      errors.push(
        `Skill timed out after ${config.skillTimeout / 1000}s — last state was ${action.state_id || "unknown"}`
      );
    } else if (action.action === "complete") {
      emitProgress(`Skill completed successfully`);

      // Issue 1 fix: send report email AFTER the skill loop completes,
      // so the user sees "completed" in the TUI before the email fires.
      const emailData = (action as any).email_data;
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
          if ((emailResult as any).sent) {
            emitProgress(`Report email sent to ${emailData.to_email}`);
          } else {
            emitProgress(`Report email could not be sent`);
            errors.push(`Email delivery failed`);
          }
        } catch (emailErr: any) {
          emitProgress(`Report email failed: ${emailErr.message || String(emailErr)}`);
          errors.push(`Email error: ${emailErr.message || String(emailErr)}`);
        }
      }
    } else if (iterations >= maxIterations) {
      emitProgress(`Skill reached max iterations (${maxIterations})`);
      errors.push(
        `Skill reached max iterations (${maxIterations}) — last state was ${action.state_id || "unknown"}`
      );
    }

    const isSuccess = action.action === "complete";
    const planSummary = action.plan_summary as Record<string, unknown> | undefined;
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
        (planSummary?.steps as any[])?.length || (planSummary?.step_count as number) || 0,
      agents_invoked: agentsInvoked,
      errors: [...errors, ...(action.errors || [])],
    };

    return result;
  } catch (err: any) {
    clearTimeout(skillTimer);
    logger.error(
      "Skill execution failed",
      { error: err.message || String(err) },
      Object.assign(new Error(err.message || "Unknown error"), { code: "SKILL_EXECUTION_FAILED" })
    );
    return {
      success: false,
      session_id: sessionId,
      skill_name: skillName,
      state: "error",
      requires_approval: false,
      steps_total: 0,
      agents_invoked: agentsInvoked,
      errors: [err.message || "Unknown error"],
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
    description: "Name of the skill to invoke (e.g., 'plan')",
  }),
  goal: Type.String({
    description:
      "The goal or objective for the skill to accomplish. " +
      "In chain mode, use {previous} placeholder to receive prior step's output.",
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

  // Parallel mode — invoke multiple skills concurrently (max 3).
  skills: Type.Optional(
    Type.Array(SkillStep, {
      description:
        "Invoke multiple skills in parallel. " + `Max ${MAX_PARALLEL_SKILLS} concurrent skills.`,
    })
  ),

  // Chain mode — invoke skills sequentially with {previous} output handoff.
  chain: Type.Optional(
    Type.Array(SkillStep, {
      description:
        "Invoke skills sequentially, with {previous} placeholder for prior step output. " +
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

  // Resume a failed single skill from its last checkpoint.
  resume_skill: Type.Optional(
    Type.String({
      description:
        "Resume a failed single-skill invocation by its session_id. " +
        "The skill will re-run the agent that was in progress when it failed. " +
        "Use this when a skill crashes mid-execution (e.g., Python parse error).",
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

// Re-export internals for unit testing
export { createTimeoutResult, withAgentTimeout, checkAndEmitSignals };
export { detectSkillMode } from "./skill-utils.js";

// ============================================================
// Forward declarations (stubs — implemented in Steps 4–5)
// ============================================================

/**
 * Run multiple skills concurrently with concurrency limiting.
 *
 * Each skill gets its own session and mempalace room — no cross-contamination.
 * On abort, pending skills are cancelled and partial results returned.
 */
async function executeSkillsParallel(
  skills: Array<{
    skill_name: string;
    goal: string;
    session_id?: string;
    constraints?: Record<string, unknown>;
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
        details: undefined as any,
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
 * Chain checkpoint shape — persisted to disk as JSON.
 * TODO: Migrate to mempalace when cross-tool invocation is available.
 */
interface ChainCheckpoint {
  chain_session_id: string;
  chain_goal_summary: string;
  steps: Array<{
    index: number;
    skill_name: string;
    goal: string;
    session_id: string;
    status: "pending" | "running" | "complete" | "failed";
    result_summary?: string;
    error?: string;
    error_detail?: {
      agent?: string;
      stop_reason?: string;
      timestamp: string;
    };
  }>;
  current_step: number;
  total_steps: number;
  chain_status: "running" | "failed" | "complete";
  pending_steps: Array<{
    index: number;
    skill_name: string;
    goal: string;
  }>;
  created_at: string;
  updated_at: string;
}

/**
 * Single-skill checkpoint — saved before each agent invocation so
 * failed skills can be resumed without re-running earlier agents.
 */
interface SkillCheckpoint {
  skill_name: string;
  session_id: string;
  orchestrator_state: Record<string, unknown>;
  pending_agent: string;
  iteration: number;
  agents_invoked: string[];
  goal: string;
  constraints: string;
  project_root: string;
  created_at: string;
}

/**
 * Checkpoint directory location.
 *
 * Penny rule: NEVER write temporary files into the project tree. Skill
 * checkpoints are runtime artifacts (resume state) and live in /tmp.
 * Located in a stable, well-known directory so users can find/list them
 * with `ls /tmp/skill-checkpoints/`.
 *
 * NOTE: /tmp is OS-managed and may be cleared on reboot. This is
 * intentional — checkpoints are short-lived resume state, not durable
 * data. Long-term state belongs in mempalace.
 */
const CHECKPOINTS_DIR = path.join(tmpdir(), "skill-checkpoints");

function ensureCheckpointsDir(): void {
  if (!fs.existsSync(CHECKPOINTS_DIR)) {
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

function skillCheckpointPath(sessionId: string, _projectRoot: string): string {
  // projectRoot kept in signature for call-site compatibility but unused —
  // checkpoints are intentionally project-agnostic (live in /tmp).
  void _projectRoot;
  ensureCheckpointsDir();
  return path.join(CHECKPOINTS_DIR, `skill-${sessionId}.json`);
}

function saveSkillCheckpoint(cp: SkillCheckpoint, projectRoot: string): void {
  const filePath = skillCheckpointPath(cp.session_id, projectRoot);
  // Directory is created by ensureCheckpointsDir() in skillCheckpointPath().
  cp.created_at = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(cp, null, 2), "utf-8");
  logger.debug("Skill checkpoint saved", {
    sessionId: cp.session_id,
    pendingAgent: cp.pending_agent,
    iteration: cp.iteration,
  });
}

function readSkillCheckpoint(sessionId: string, projectRoot: string): SkillCheckpoint | null {
  const filePath = skillCheckpointPath(sessionId, projectRoot);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SkillCheckpoint;
  } catch {
    return null;
  }
}

function checkpointPath(chainSessionId: string, _projectRoot: string): string {
  // projectRoot kept in signature for call-site compatibility but unused —
  // checkpoints are intentionally project-agnostic (live in /tmp).
  void _projectRoot;
  ensureCheckpointsDir();
  return path.join(CHECKPOINTS_DIR, `${chainSessionId}.json`);
}

function saveCheckpoint(checkpoint: ChainCheckpoint, projectRoot: string): void {
  const filePath = checkpointPath(checkpoint.chain_session_id, projectRoot);
  // Directory is created by ensureCheckpointsDir() in checkpointPath().
  checkpoint.updated_at = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  logger.debug("Chain checkpoint saved", {
    chainSessionId: checkpoint.chain_session_id,
    step: checkpoint.current_step,
    status: checkpoint.chain_status,
  });
}

function readCheckpoint(chainSessionId: string, projectRoot: string): ChainCheckpoint | null {
  const filePath = checkpointPath(chainSessionId, projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ChainCheckpoint;
  } catch (err) {
    logger.error(
      "Failed to read chain checkpoint",
      { chainSessionId },
      err instanceof Error ? err : new Error(String(err))
    );
    return null;
  }
}

/**
 * Run skills sequentially with {previous} output handoff + checkpoint/resume.
 *
 * Checkpoints are saved before each step and on error. On resume (resumeFrom
 * provided), completed steps are skipped and execution continues from the failed
 * step with optional overrides applied.
 *
 * Checkpoints are written as JSON files to /tmp/skill-checkpoints/.
 * Future: migrate to mempalace when cross-tool API is available.
 */
async function executeSkillsChain(
  chain: Array<{
    skill_name: string;
    goal: string;
    session_id?: string;
    constraints?: Record<string, unknown>;
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
  const projectRoot = cwd;

  // ── Resume path: load checkpoint, skip completed steps ──
  let startStep = 0;
  let previousOutput = "";
  const results: SkillResult[] = [];
  let chainSessionId: string;

  if (resumeFrom) {
    const checkpoint = readCheckpoint(resumeFrom, projectRoot);
    if (!checkpoint) {
      return {
        success: false,
        session_id: resumeFrom,
        skill_name: "chain",
        state: "error",
        requires_approval: false,
        steps_total: chain.length,
        agents_invoked: [],
        errors: [`Checkpoint not found: ${resumeFrom}`],
        mode: "chain",
      };
    }

    if (checkpoint.chain_status === "complete") {
      return {
        success: true,
        session_id: resumeFrom,
        skill_name: "chain",
        state: "complete",
        requires_approval: false,
        steps_total: checkpoint.total_steps,
        agents_invoked: [],
        errors: [],
        mode: "chain",
        chain_session_id: resumeFrom,
      };
    }

    // Reconstruct chain from checkpoint
    chainSessionId = resumeFrom;
    chain = [];
    for (const step of checkpoint.steps) {
      if (step.status === "complete") {
        results.push({
          success: true,
          session_id: step.session_id,
          skill_name: step.skill_name,
          state: "complete",
          requires_approval: false,
          steps_total: 1,
          agents_invoked: [],
          errors: [],
          mode: "chain",
          chain_step: step.index,
          chain_total: checkpoint.total_steps,
          chain_session_id: resumeFrom,
          plan: { plan_summary: step.result_summary || "" },
        });
        if (step.result_summary) {
          previousOutput = step.result_summary;
        }
      } else if (step.status === "failed") {
        // This is the step to retry — apply overrides
        const override = stepOverrides?.[step.index];
        const resolvedGoal = override?.goal ?? step.goal;
        const resolvedConstraints = override?.constraints ?? {};
        chain.push({
          skill_name: step.skill_name,
          goal: resolvedGoal,
          constraints: resolvedConstraints,
        });
        startStep = step.index;
      } else {
        // pending steps — add to chain for execution
        chain.push({
          skill_name: step.skill_name,
          goal: step.goal,
        });
      }
    }
    // Add remaining pending steps
    for (const pending of checkpoint.pending_steps) {
      chain.push({
        skill_name: pending.skill_name,
        goal: pending.goal,
      });
    }

    logger.info("Resuming chain from checkpoint", {
      chainSessionId: resumeFrom,
      startStep,
      stepsToRun: chain.length,
    });
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Resuming chain ${resumeFrom} from step ${startStep + 1}/${checkpoint.total_steps}`,
        },
      ],
      details: undefined as any,
    });
  } else {
    chainSessionId = `chain-${Date.now()}`;
  }

  // ── Build initial checkpoint ──
  const allStepDefs = [];
  for (let i = 0; i < chain.length; i++) {
    const existingComplete = results.find((r) => r.chain_step === startStep + i);
    if (existingComplete) continue;
    allStepDefs.push({
      index: startStep + i,
      skill_name: chain[i].skill_name,
      goal: chain[i].goal,
      status: "pending" as const,
      session_id: chain[i].session_id || `${chain[i].skill_name}-${Date.now() + i}`,
    });
  }

  const checkpoint: ChainCheckpoint = {
    chain_session_id: chainSessionId,
    chain_goal_summary: chain.map((s) => s.skill_name).join(" → "),
    steps: [
      ...results.map((r, i) => ({
        index: i,
        skill_name: r.skill_name,
        goal: "",
        session_id: r.session_id,
        status: "complete" as const,
        result_summary: (r.plan?.["plan_summary"] as string) || `Completed: ${r.skill_name}`,
      })),
      ...allStepDefs,
    ],
    current_step: startStep,
    total_steps: startStep + chain.length,
    chain_status: "running",
    pending_steps: allStepDefs
      .slice(1)
      .map((s) => ({ index: s.index, skill_name: s.skill_name, goal: s.goal })),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // ── Execute each step ──
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const stepIndex = startStep + i;

    // Save pre-step checkpoint (status: running)
    checkpoint.current_step = stepIndex;
    const stepEntry = checkpoint.steps.find((s) => s.index === stepIndex);
    if (stepEntry) stepEntry.status = "running";
    saveCheckpoint(checkpoint, projectRoot);

    // Replace {previous} placeholder
    const resolvedGoal = step.goal.replaceAll("{previous}", previousOutput);

    // If the previous step was prd, inject its context into this step's
    // constraints so the downstream skill (e.g. code) can locate the
    // IDEAL_STATE via mempalace room. This is the fix for the gap where
    // the chain only passed truncated text, discarding session_room.
    if (results.length > 0) {
      const prev = results[results.length - 1];
      if (prev.session_room && prev.session_room.startsWith("skills/prd-")) {
        // Merge prd context into this step's constraints (or create if absent)
        step.constraints = {
          ...(step.constraints || {}),
          prd_room: prev.session_room,
          prd_session_id: prev.session_id,
        };
      }
    }

    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Chain step ${stepIndex + 1}/${checkpoint.total_steps}: ${step.skill_name}`,
        },
      ],
      details: undefined as any,
    });

    // Execute the skill
    const result = await executeSkill(
      step.skill_name,
      {
        goal: resolvedGoal,
        session_id: step.session_id,
        constraints: step.constraints,
      },
      cwd,
      signal,
      ctx,
      undefined
    );

    // Enrich result with chain metadata
    result.mode = "chain";
    result.chain_step = stepIndex;
    result.chain_total = checkpoint.total_steps;
    result.chain_session_id = chainSessionId;
    results.push(result);

    if (!result.success) {
      // ── Error: save checkpoint and stop ──
      if (stepEntry) {
        stepEntry.status = "failed";
        stepEntry.error = result.errors.join("; ") || `Step ${stepIndex + 1} failed`;
        stepEntry.error_detail = {
          agent: result.agents_invoked[result.agents_invoked.length - 1] || "unknown",
          stop_reason: result.state,
          timestamp: new Date().toISOString(),
        };
      }
      checkpoint.chain_status = "failed";
      saveCheckpoint(checkpoint, projectRoot);

      return {
        success: false,
        session_id: chainSessionId,
        skill_name: "chain",
        state: "failed",
        requires_approval: true,
        session_room: `skills/chain-${chainSessionId}`,
        steps_total: checkpoint.total_steps,
        agents_invoked: results.flatMap((r) => r.agents_invoked),
        errors: [
          `Chain stopped at step ${stepIndex + 1}/${checkpoint.total_steps} (${step.skill_name}): ${result.errors.join("; ")}`,
        ],
        mode: "chain",
        chain_step: stepIndex,
        chain_total: checkpoint.total_steps,
        chain_session_id: chainSessionId,
        chain_error_step: stepIndex,
        chain_results: results.slice(0, -1), // prior successes only
        resumable: true,
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

    // ── Success: capture output (truncated), save checkpoint, continue ──
    previousOutput = truncateForPrevious(getFinalOutputFromSkillResult(result));

    if (stepEntry) {
      stepEntry.status = "complete";
      stepEntry.result_summary = previousOutput;
    }
    checkpoint.pending_steps = checkpoint.pending_steps.filter((s) => s.index !== stepIndex);
    saveCheckpoint(checkpoint, projectRoot);
  }

  // ── All steps complete ──
  checkpoint.chain_status = "complete";
  saveCheckpoint(checkpoint, projectRoot);

  return {
    success: true,
    session_id: chainSessionId,
    skill_name: "chain",
    state: "complete",
    requires_approval: false,
    session_room: `skills/chain-${chainSessionId}`,
    steps_total: checkpoint.total_steps,
    agents_invoked: results.flatMap((r) => r.agents_invoked),
    errors: [],
    mode: "chain",
    chain_step: checkpoint.total_steps - 1,
    chain_total: checkpoint.total_steps,
    chain_session_id: chainSessionId,
    chain_results: results,
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
  // We then call realpathSync to resolve symlinks, and statSync to verify
  // the resolved file is executable. If the resolved file doesn't exist
  // or isn't executable, we log a clear error pointing at the exact
  // missing path — the user can fix the env without having to dig
  // through Node's ENOENT message.
  const { realpathSync, statSync, existsSync } = require("fs") as typeof import("fs");
  const candidates = [
    process.env.PI_VENV_PYTHON,
    process.env.PROJECT_ROOT ? path.join(process.env.PROJECT_ROOT, ".venv", "bin", "python") : null,
    path.join(process.cwd(), ".venv", "bin", "python"),
  ].filter((p): p is string => Boolean(p));

  let resolvedPython: string | null = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      const st = statSync(real);
      // Check executable bit (any of x for owner/group/other)
      if ((st.mode & 0o111) === 0) continue;
      resolvedPython = real;
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
    );
  }

  config = {
    venvPython: resolvedPython,
    skillsDir:
      process.env.PENNY_SKILLS_DIR ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), ".pi", "skills"),
    skillTimeout: parseInt(process.env.PENNY_SKILL_TIMEOUT || "43200000"), // 12 hrs (batch processing headroom)
    agentTimeout: parseInt(process.env.PENNY_AGENT_TIMEOUT || "1800000"), // 30 min per agent invocation
  };

  const skills = discoverSkills();

  pi.on("session_start", async (_event: any, ctx: any) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setSessionId(sessionId);

    // Reset dedup flag for new session
    _signalsSurfacedThisSession = false;

    // Check for pending signals proactively
    await checkAndEmitSignals(sessionId, (msg: string) => {
      ctx.ui.notify(msg, "info");
    });
    _signalsSurfacedThisSession = true;
  });

  pi.registerTool({
    name: "skill",
    label: "Invoke Skill",
    description: [
      "Invoke a Python-based skill with state machine orchestration.",
      "Skills define workflows (phases, transitions, subagent order).",
      "Penny decides WHEN to invoke; skills decide HOW to execute.",
      "Agents communicate via mempalace — Penny's context stays clean.",
      "",
      "Modes:",
      "  - Single:  skill({ skill_name, goal })",
      "  - Parallel: skill({ skills: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_PARALLEL_SKILLS} concurrent skills. Each skill runs independently.`,
      "  - Chain:   skill({ chain: [{ skill_name, goal }, ...] })",
      `    Max ${MAX_CHAIN_STEPS} steps. {previous} placeholder receives prior step output.`,
      "    Stops on first error — use resume_chain to recover from the failed step.",
      "  - Resume:  skill({ resume_chain: chain_session_id, step_overrides?: {...} })",
      "    Skips completed steps, resumes from the failed step.",
      "  - Resume Skill: skill({ resume_skill: session_id })",
      "    Resumes a failed single-skill from its last checkpoint.",
      "",
      "Available skills:",
      ...skills.map((s) => `  - ${s.name}: ${s.description}`),
    ].join("\n"),
    parameters: SkillParams,
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any
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
          // Reconstruct clean single-mode params (executeSkill signature unchanged)
          const skillName = params.skill_name!;
          const cleanParams = {
            goal: params.goal!,
            session_id: params.session_id,
            project_root: params.project_root,
            constraints: params.constraints,
          };
          result = await executeSkill(skillName, cleanParams, ctx.cwd, signal, ctx, onUpdate);
          result.mode = "single";
          break;
        }
        case "parallel": {
          const parallelSkills = params.skills!;
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
          const chainSteps = params.chain!;
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
            params.resume_chain!,
            params.step_overrides
          );
          break;
        }
        case "resume_skill": {
          // Reconstruct skill from stored skill_name in checkpoint
          const cp = readSkillCheckpoint(params.resume_skill!, ctx.cwd);
          const skillName = cp?.skill_name || "unknown";
          result = await executeSkill(
            skillName,
            {
              goal: cp?.goal || "(resumed)",
              session_id: params.resume_skill,
              project_root: params.project_root,
              constraints: params.constraints,
              resumeFrom: params.resume_skill,
            },
            ctx.cwd,
            signal,
            ctx,
            onUpdate
          );
          result.mode = "resume_skill";
          break;
        }
        default:
          throw new Error(`Unknown mode: ${(detected as any).mode}`);
      }

      return {
        content: [{ type: "text", text: formatResult(result, ctx.ui.theme.fg.bind(ctx.ui.theme)) }],
        details: result,
      };
    },

    renderCall(args: any, theme: any) {
      // ── Parallel mode ──
      if (args.skills && Array.isArray(args.skills)) {
        const names = args.skills
          .slice(0, 3)
          .map((s: any) => s.skill_name)
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
          .map((s: any) => s.skill_name)
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

      // ── Resume skill mode ──
      if (args.resume_skill) {
        const text =
          theme("toolTitle", "skill ") +
          theme("dim", "[resume] ") +
          theme("accent", args.resume_skill.slice(0, 20));
        return new Text(text, 0, 0);
      }

      // ── Single mode (unchanged) ──
      const skill = skills.find((s) => s.name === args.skill_name);
      const name = skill?.name || args.skill_name;
      const goal = args.goal?.slice(0, 50) || "...";
      const text =
        theme("toolTitle", "skill ") + theme("accent", name) + theme("dim", ` "${goal}..."`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as SkillResult | undefined;
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

      if (expanded && (details as any).escalation) {
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

        const esc = (details as any).escalation;
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
            const title = (step as any).title || String(step);
            const num = (step as any).step || (step as any).id || "•";
            container.addChild(new Text(theme("text", `  ${num}. ${title}`), 0, 0));
          }
          if (planSteps.length > 15) {
            container.addChild(
              new Text(theme("dim", `  ... and ${planSteps.length - 15} more`), 0, 0)
            );
          }
        } else if (details.plan) {
          const plan = details.plan as any;
          const steps = plan.steps || plan.tasks || [];
          if (Array.isArray(steps) && steps.length > 0) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme("toolTitle", "Steps:"), 0, 0));
            for (const step of steps.slice(0, 15)) {
              const title = step.title || step.description || step;
              container.addChild(
                new Text(theme("text", `  ${step.id || step.step || "•"}. ${title}`), 0, 0)
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
