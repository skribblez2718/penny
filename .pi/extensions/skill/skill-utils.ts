import {
  registerTrustedQuestionnaireTransport,
  type TrustedQuestionnaireBinding,
  type TrustedQuestionnaireQuestion,
} from "./execution-receipts.js";
import type { ArtifactDispatchPause, ArtifactDispatchRecovery } from "./dispatch-control.js";
import type { ArtifactRef } from "./artifact-client.js";

/**
 * Result shape returned by executeSkill to the skill extension.
 * Pure data — no UI or extension types.
 */
export interface SkillResult {
  success: boolean;
  session_id: string;
  skill_name: string;
  state: string;
  plan?: Record<string, unknown>;
  plan_steps?: Array<Record<string, unknown>>;
  requires_approval: boolean;
  session_room?: string;
  steps_total: number;
  agents_invoked: string[];
  errors: string[];
  /** Complete Python engine terminal result, preserved without reconstruction. */
  result?: Record<string, unknown>;
  /** Exact terminal output selected by the skill's execution owner. */
  output_artifact_ref?: ArtifactRef;
  /** Owner dispatch pause is non-success and safe to retry from the same checkpoint. */
  retriable?: boolean;
  /** Closed Python/driver pause contract retained verbatim for operator tooling. */
  dispatch_pause?: ArtifactDispatchPause;
  /** Exact forward-recovery instruction associated with a dispatch pause. */
  recovery?: ArtifactDispatchRecovery;

  // ── Multi-mode fields (all optional — default 'single' backward compat) ──

  /** Which invocation mode produced this result. */
  mode?: "single" | "parallel" | "chain";

  // Chain-specific
  /** Which step in the chain (0-indexed). */
  chain_step?: number;
  /** Total steps in the chain. */
  chain_total?: number;
  /** Shared session ID for the entire chain — used as resume key. */
  chain_session_id?: string;
  /** Which step failed (populated on chain error). */
  chain_error_step?: number;
  /** Partial results from steps that completed before the error. */
  chain_results?: SkillResult[];
  /** Whether this failed chain can be resumed via resume_chain. */
  resumable?: boolean;

  // Parallel-specific
  /** Individual results from each parallel skill invocation. */
  parallel_results?: SkillResult[];

  escalation?: {
    questions: EscalationQuestion[];
    unknown_reason?: string;
    previous_state?: string;
  };
}

/**
 * A single escalation (human-gate) question surfaced to the user.
 *
 * `options` is OPTIONAL: free-text questions (e.g. an "out of scope paths"
 * prompt) legitimately omit predefined options and rely on the questionnaire's
 * free-text ("Type something") affordance via `allowOther`. Consumers MUST NOT
 * assume `options` is present — use `normalizeEscalationQuestions()`.
 */
export interface EscalationQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface EscalationQuestion {
  id: string;
  label: string;
  prompt: string;
  options?: EscalationQuestionOption[];
  allowOther?: boolean;
  type?: "single" | "multi";
  artifact_ref?: Record<string, unknown>;
  approval_challenge?: string;
  approval_run_id?: string;
  approval_gate_id?: string;
  questionnaire_transport_ref?: Record<string, unknown>;
  rendered_questions_digest?: string;
}

/**
 * Normalize orchestrator-produced escalation questions into the shape the
 * questionnaire tool expects, defensively defaulting a missing/empty `options`
 * array and stripping empty `description` fields.
 *
 * Root-cause fix for the sca charter-gate crash: the Python orchestrator emits
 * free-text gate questions WITHOUT an `options` key, but the consumer used to
 * call `q.options.map(...)` unconditionally (TypeError: reading 'map' of
 * undefined). This pure helper (matching the already-safe `q.options || []`
 * pattern in `formatResult`) makes every gate robust to optionless questions.
 */
export function normalizeEscalationQuestions(
  questions: EscalationQuestion[] | undefined | null
): TrustedQuestionnaireQuestion[] {
  return (questions ?? []).map((q, index) => ({
    id: q.id,
    label: q.label || `Q${index + 1}`,
    prompt: q.prompt,
    options: (q.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    allowOther: q.allowOther ?? true,
    ...(q.type ? { type: q.type } : {}),
  }));
}

function trustedQuestionnaireBinding(
  questions: EscalationQuestion[]
): TrustedQuestionnaireBinding | undefined {
  if (questions.length !== 1) return undefined;
  const question = questions[0];
  if (
    !question.approval_run_id ||
    !question.approval_gate_id ||
    !question.approval_challenge ||
    !question.artifact_ref ||
    !question.questionnaire_transport_ref ||
    !question.rendered_questions_digest
  ) {
    return undefined;
  }
  return {
    runId: question.approval_run_id,
    gateId: question.approval_gate_id,
    challenge: question.approval_challenge,
    artifactRef: question.artifact_ref,
    transportRef: question.questionnaire_transport_ref,
    renderedQuestionsDigest: question.rendered_questions_digest,
  };
}

export function prepareQuestionnairePayload(
  questions: EscalationQuestion[]
): { questions: TrustedQuestionnaireQuestion[] } | { trustedTransportCapability: string } {
  const normalized = normalizeEscalationQuestions(questions);
  const binding = trustedQuestionnaireBinding(questions);
  const capability = binding
    ? registerTrustedQuestionnaireTransport(normalized, binding)
    : undefined;
  return capability ? { trustedTransportCapability: capability } : { questions: normalized };
}

const JSON_LITERAL_TERMINAL_CONTROL_OR_BIDI =
  /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function isTerminalControlOrBidi(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function escapeTerminalDisplayText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isTerminalControlOrBidi(codePoint)) return character;
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }).join("");
}

/**
 * Serialize the complete questionnaire payload as one lossless JSON literal.
 *
 * JSON.stringify already escapes C0 controls, quotes, and backslashes. JavaScript
 * leaves DEL/C1, line separators, and bidi controls literal, though, so escape
 * those code points as `\\uXXXX` too. JSON.parse reverses every escape and therefore
 * reconstructs the normalized payload exactly while the displayed call remains
 * safe for terminals and copy/paste.
 */
function serializeQuestionnairePayload(
  payload: { questions: TrustedQuestionnaireQuestion[] } | { trustedTransportCapability: string }
): string {
  return JSON.stringify(payload, null, 2).replace(
    JSON_LITERAL_TERMINAL_CONTROL_OR_BIDI,
    (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) return character;
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
  );
}

/**
 * True when a SkillResult is a *clarification pause* (the skill needs user input)
 * rather than a hard error. A clarification carries the skill's actual questions
 * and no error text; a chain surfaces those questions and routes the answer back
 * to the paused step, instead of the generic retry/skip/diagnose recovery prompt.
 */
export function isClarificationEscalation(result: SkillResult): boolean {
  return (
    !result.success &&
    !!result.escalation &&
    Array.isArray(result.escalation.questions) &&
    result.escalation.questions.length > 0 &&
    (result.state === "awaiting_clarification" || result.errors.length === 0)
  );
}

/**
 * A step to run when resuming a chain from a checkpoint.
 */
export interface ResumeChainStep {
  skill_name: string;
  goal: string;
  session_id?: string;
  constraints?: Record<string, unknown>;
  model?: string;
}

/** Minimal checkpoint shape reconstructResumeChain reads (subset of ChainCheckpoint). */
export interface ResumeCheckpointStep {
  index: number;
  skill_name: string;
  goal: string;
  session_id: string;
  status: "pending" | "running" | "complete" | "failed";
  model?: string;
  constraints?: Record<string, unknown>;
  result_preview?: string;
  output_artifact_ref?: ArtifactRef;
  handoff_artifact_ref?: ArtifactRef;
}

export interface ResumeCheckpointShape {
  steps: ResumeCheckpointStep[];
  pending_steps?: Array<{
    index: number;
    skill_name: string;
    goal: string;
    session_id?: string;
    model?: string;
    constraints?: Record<string, unknown>;
  }>;
}

export interface ResumeReconstruction {
  /** Steps still to run (failed step first, then still-pending), each exactly once. */
  chain: ResumeChainStep[];
  /** Already-completed steps in order, with durable exact terminal/handoff refs. */
  completed: Array<{
    index: number;
    skill_name: string;
    session_id: string;
    result_preview: string;
    output_artifact_ref?: ArtifactRef;
    handoff_artifact_ref?: ArtifactRef;
  }>;
  /** 0-based index of the first step to (re)run. */
  startStep: number;
}

/**
 * Reconstruct the remaining chain from a failed/paused checkpoint.
 *
 * Fixes two resume bugs that broke resuming a chain after a step paused for
 * clarification:
 *  1. **No duplicate steps.** Pending steps live in BOTH `checkpoint.steps`
 *     (status "pending") and `checkpoint.pending_steps`; the old code added them
 *     from both loops, yielding e.g. "prd → code → code". This dedupes by step
 *     index (a step is added at most once).
 *  2. **Session identity preserved.** Each still-to-run step carries its
 *     checkpointed `session_id`, so the resumed run reuses the SAME session and
 *     the durable checkpointer can `recover` the paused run (e.g. a clarification
 *     pause) instead of minting a fresh run_id — the cause of "unknown run_id".
 *
 * `stepOverrides` (goal/constraints) apply only to the failed step. Pure and
 * side-effect free for testability.
 */
export function reconstructResumeChain(
  checkpoint: ResumeCheckpointShape,
  stepOverrides?: Record<number, { goal?: string; constraints?: Record<string, unknown> }>
): ResumeReconstruction {
  const chain: ResumeChainStep[] = [];
  const completed: ResumeReconstruction["completed"] = [];
  const seen = new Set<number>();
  let startStep = 0;
  let sawFailed = false;

  for (const step of checkpoint.steps) {
    if (step.status === "complete") {
      completed.push({
        index: step.index,
        skill_name: step.skill_name,
        session_id: step.session_id,
        result_preview: step.result_preview || "",
        output_artifact_ref: step.output_artifact_ref,
        handoff_artifact_ref: step.handoff_artifact_ref,
      });
      continue;
    }
    if (seen.has(step.index)) continue;
    if (step.status === "failed") {
      const override = stepOverrides?.[step.index];
      chain.push({
        skill_name: step.skill_name,
        goal: override?.goal ?? step.goal,
        constraints: override?.constraints ?? step.constraints ?? {},
        session_id: step.session_id,
        model: step.model,
      });
      startStep = step.index;
      sawFailed = true;
    } else {
      // pending / running — carry the checkpointed session_id
      chain.push({
        skill_name: step.skill_name,
        goal: step.goal,
        session_id: step.session_id,
        constraints: step.constraints,
        model: step.model,
      });
    }
    seen.add(step.index);
  }

  for (const pending of checkpoint.pending_steps ?? []) {
    if (seen.has(pending.index)) continue;
    chain.push({
      skill_name: pending.skill_name,
      goal: pending.goal,
      session_id: pending.session_id,
      constraints: pending.constraints,
      model: pending.model,
    });
    seen.add(pending.index);
  }

  // No failed step recorded (e.g. a pause-only checkpoint) → resume from the
  // lowest still-to-run index.
  if (!sawFailed && seen.size > 0) {
    startStep = Math.min(...seen);
  }

  return { chain, completed, startStep };
}

/**
 * Detect the invocation mode from tool parameters.
 *
 * Exactly one mode must be provided — ambiguous params produce an error.
 * This is a pure function (no side effects) for testability.
 *
 * Priority order: resume_chain > chain > skills > single
 */
export function detectSkillMode(params: {
  skill_name?: string;
  goal?: string;
  skills?: Array<{ skill_name: string; goal: string }>;
  chain?: Array<{ skill_name: string; goal: string }>;
  resume_chain?: string;
}): { mode: "single" | "parallel" | "chain" | "resume"; error?: string } {
  const hasSkills = (params.skills?.length ?? 0) > 0;
  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasSingle = Boolean(params.skill_name && params.goal);
  const hasResumeChain = Boolean(params.resume_chain);

  const modeCount =
    Number(hasSkills) + Number(hasChain) + Number(hasSingle) + Number(hasResumeChain);

  if (modeCount === 0) {
    return {
      mode: "single",
      error:
        "No invocation mode provided. Provide skill_name+goal, skills, chain, or resume_chain.",
    };
  }
  if (modeCount > 1) {
    return {
      mode: "single",
      error:
        "Ambiguous parameters. Provide exactly one of: skill_name+goal, skills, chain, or resume_chain.",
    };
  }

  if (hasResumeChain) return { mode: "resume" };
  if (hasChain) return { mode: "chain" };
  if (hasSkills) return { mode: "parallel" };
  return { mode: "single" };
}

/**
 * Format a SkillResult into human-readable text for the TUI.
 *
 * CRITICAL: Escalation/verification states must emit an explicit
 * questionnaire tool call, not vague instructions. The Apr 17
 * lesson: behavior must be enforced in tool output format, not
 * just in SKILL.md.
 */
export function formatResult(
  result: SkillResult,
  theme: (color: string, text: string) => string
): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(theme("success", `✓ ${result.skill_name} completed`));
    lines.push(`  Session: ${result.session_id}`);
    lines.push(`  Phases: ${result.agents_invoked.join(" → ")}`);

    if (result.session_room) {
      lines.push(`  Room: ${result.session_room}`);
    }

    if (result.requires_approval && result.plan_steps && result.plan_steps.length > 0) {
      lines.push("");
      lines.push(theme("warning", "⛔ APPROVAL REQUIRED — DO NOT EXECUTE YET"));
      lines.push(
        theme("warning", "Present this plan to the user for approval before doing ANY work.")
      );
      lines.push(theme("muted", "Use the questionnaire tool to ask: Approve / Refine / Deny."));
      lines.push(
        theme("muted", "Read the exact granted plan artifact with artifact_read when needed.")
      );
      lines.push("");
      lines.push(theme("toolTitle", "Plan Steps:"));

      const goal = result.plan?.["goal"];
      if (goal) {
        lines.push(theme("text", `  Goal: ${String(goal)}`));
      }

      for (const step of result.plan_steps) {
        const num = step["step"] || step["id"] || "•";
        const title = step["title"] || String(step);
        lines.push(theme("text", `  ${String(num)}. ${String(title)}`));
      }

      if (result.steps_total > result.plan_steps.length) {
        lines.push(theme("dim", `  ... and ${result.steps_total - result.plan_steps.length} more`));
      }
    } else if (result.plan) {
      const steps = result.plan["steps"] || result.plan["tasks"] || [];
      if (Array.isArray(steps) && steps.length > 0) {
        lines.push(`  Steps: ${steps.length}`);
        for (const rawStep of steps.slice(0, 8)) {
          const step = (rawStep ?? {}) as Record<string, unknown>;
          const title = step["title"] || step["description"] || rawStep;
          lines.push(`    ${String(step["id"] || step["step"] || "•")}. ${String(title)}`);
        }
        if (steps.length > 8) {
          lines.push(`    ... and ${steps.length - 8} more`);
        }
      }
    }
  } else if (result.dispatch_pause) {
    lines.push(theme("warning", `⏸️ ${result.skill_name} dispatch paused`));
    lines.push(`  State: ${result.state}`);
    lines.push(`  Session: ${result.session_id}`);
    lines.push(`  Code: ${result.dispatch_pause.code}`);
    lines.push(`  Reason: ${result.dispatch_pause.reason}`);
    lines.push(
      theme(
        "muted",
        `  Retriable: set PENNY_ARTIFACT_DISPATCH_MODE=active, then recover run ${result.dispatch_pause.run_id}.`
      )
    );
  } else if (result.escalation) {
    const esc = result.escalation;

    lines.push(theme("warning", `⏸️ ${result.skill_name} awaiting user input`));
    lines.push(`  State: ${result.state}`);
    lines.push(`  Agents invoked: ${result.agents_invoked.join(" → ") || "none"}`);
    lines.push("");
    if (esc.unknown_reason) {
      lines.push(
        theme("text", `  Reason: ${escapeTerminalDisplayText(String(esc.unknown_reason))}`)
      );
    }
    if (esc.previous_state) {
      lines.push(theme("muted", `  Previous state: ${esc.previous_state}`));
    }
    lines.push("");

    // ── Explicit questionnaire tool call (copy-pasteable) ──
    // The Apr 17 lesson: behavior must be enforced in tool output format,
    // not just in SKILL.md. Penny sees this text and must copy-paste it.
    lines.push(theme("toolTitle", "  Invoke this questionnaire tool call:"));
    const questionnaireLiteral = serializeQuestionnairePayload(
      prepareQuestionnairePayload(esc.questions)
    );
    const literalLines = questionnaireLiteral.split("\n");
    lines.push(theme("accent", `  questionnaire(${literalLines[0]}`));
    for (const line of literalLines.slice(1)) {
      lines.push(theme("accent", `  ${line}`));
    }
    lines.push(theme("accent", "  )"));
    lines.push("");
    // NOTE: no orchestrator_state to carry — the engine's durable checkpointer
    // owns all FSM state, keyed by session_id/run_id. Re-invoking with the SAME
    // session_id + constraints.user_response is sufficient: `recover` finds the
    // pending run and `step --agent user` consumes the answer.
    if (result.mode === "chain" && result.chain_session_id) {
      // Chain escalation: resume the CHAIN (not a bare skill). The answer is
      // routed to the paused step as constraints.user_response via step_overrides.
      lines.push(theme("muted", "  After the user responds, resume the chain with:"));
      lines.push(theme("muted", "  skill({"));
      lines.push(theme("muted", `    resume_chain: "${result.chain_session_id}",`));
      if (typeof result.chain_error_step === "number") {
        lines.push(
          theme(
            "muted",
            `    step_overrides: { "${result.chain_error_step}": { constraints: { user_response: "<answer from questionnaire>" } } }`
          )
        );
      }
      lines.push(theme("muted", "  })"));
    } else {
      lines.push(theme("muted", "  After the user responds, re-invoke the skill with:"));
      lines.push(theme("muted", "  skill({"));
      lines.push(theme("muted", `    skill_name: "${result.skill_name}",`));
      lines.push(theme("muted", `    session_id: "${result.session_id}",`));
      lines.push(theme("muted", '    goal: "<original goal>",'));
      lines.push(theme("muted", "    constraints: {"));
      lines.push(theme("muted", '      user_response: "<answer from questionnaire>"'));
      lines.push(theme("muted", "    }"));
      lines.push(theme("muted", "  })"));
    }
  } else {
    const incomplete = result.result && result.result["met"] === false;
    lines.push(
      theme(
        incomplete ? "warning" : "error",
        `${incomplete ? "⏹" : "✗"} ${result.skill_name} ${incomplete ? "incomplete" : "failed"}`
      )
    );
    lines.push(`  State: ${result.state}`);
    lines.push(`  Agents invoked: ${result.agents_invoked.join(" → ") || "none"}`);
    for (const error of result.errors) {
      lines.push(`  Error: ${error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse SUMMARY block from agent output.
 * Agents are instructed to emit inline JSON SUMMARY blocks via their
 * skill context prompts. The orchestrator receives only this summary,
 * not the full agent output.
 *
 * Standard format: SUMMARY:{"key":"value",...}
 * - Single line of valid JSON (no newlines in the JSON)
 * - Starts with SUMMARY: followed immediately by {
 * - Must handle nested braces (arrays of objects)
 */
export function parseSummaryFromOutput(output: string): Record<string, unknown> {
  if (!output || !output.trim()) return {};

  const summaryIdx = output.indexOf("SUMMARY:");
  if (summaryIdx === -1) return {};

  const braceIdx = output.indexOf("{", summaryIdx);
  if (braceIdx === -1) return {};

  // --- L3 FIX: Line-aware JSON parse first ---
  // Agents are instructed to emit SUMMARY on a single line.
  // Try parsing the rest of the line as JSON before falling back to brace counting.
  // This correctly handles strings containing { or }.
  const lineStart = output.indexOf("SUMMARY:", summaryIdx);
  const lineContent = output.slice(lineStart + 8); // after "SUMMARY:"
  const newlineIdx = lineContent.indexOf("\n");
  const lineCandidate = newlineIdx === -1 ? lineContent : lineContent.slice(0, newlineIdx);
  const lineTrimmed = lineCandidate.trim();
  if (lineTrimmed.startsWith("{") && lineTrimmed.endsWith("}")) {
    try {
      return JSON.parse(lineTrimmed);
    } catch {
      // Fall through to brace-counting fallback
    }
  }

  // --- L3 FALLBACK: Brace-counting (handles multi-line JSON) ---
  // NOTE: This is inherently fragile for strings with unbalanced braces.
  let depth = 0;
  let endIdx = -1;
  for (let i = braceIdx; i < output.length; i++) {
    if (output[i] === "{") depth++;
    else if (output[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) return {};

  const jsonStr = output.slice(braceIdx, endIdx + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return {};
  }
}

/**
 * Build an optional bounded display preview for chain status/checkpoints.
 *
 * The preview is never handoff authority; exact terminal/handoff ArtifactRefs
 * carry chain data. Cuts near a word boundary and marks truncation with `…`.
 */
export function truncateForPrevious(text: string, maxChars: number = 2000): string {
  if (!text || text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");

  // Use word boundary if it's within a reasonable range (80%+ of maxChars)
  const cutPoint = lastSpace > maxChars * 0.8 ? lastSpace : maxChars;

  return truncated.slice(0, cutPoint) + "…";
}

/**
 * Extract optional human-readable chain status text.
 *
 * Uses plan.plan_summary when available and otherwise emits session/state
 * metadata. Callers may store a bounded preview, never use it as exact handoff.
 */
export function getFinalOutputFromSkillResult(result: SkillResult): string {
  // Structured plan_summary from the skill's completion action
  const planSummary = result.plan?.["plan_summary"] as string | undefined;
  if (planSummary && planSummary.trim()) return planSummary.trim();

  // Fallback: session identity + state
  const parts: string[] = [];
  if (result.session_id) parts.push(`session:${result.session_id}`);
  if (result.skill_name) parts.push(`skill:${result.skill_name}`);
  if (result.state) parts.push(`state:${result.state}`);
  if (result.errors.length > 0) parts.push(`errors:${result.errors.join("; ")}`);

  return parts.join(" ") || "(no output)";
}
