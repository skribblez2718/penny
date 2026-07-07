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
): Array<
  Required<Pick<EscalationQuestion, "id" | "label" | "prompt">> & {
    options: EscalationQuestionOption[];
    allowOther: boolean;
  }
> {
  return (questions ?? []).map((q) => ({
    id: q.id,
    label: q.label,
    prompt: q.prompt,
    options: (q.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    allowOther: q.allowOther ?? true,
  }));
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
      error: "No invocation mode provided. Provide skill_name+goal, skills, chain, or resume_chain.",
    };
  }
  if (modeCount > 1) {
    return {
      mode: "single",
      error: "Ambiguous parameters. Provide exactly one of: skill_name+goal, skills, chain, or resume_chain.",
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
        theme("muted", "Full plan details are in mempalace — fetch with memory_smart_search.")
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
  } else if (result.escalation) {
    const esc = result.escalation;

    lines.push(theme("warning", `⏸️ ${result.skill_name} awaiting user input`));
    lines.push(`  State: ${result.state}`);
    lines.push(`  Agents invoked: ${result.agents_invoked.join(" → ") || "none"}`);
    lines.push("");
    if (esc.unknown_reason) {
      lines.push(theme("text", `  Reason: ${esc.unknown_reason}`));
    }
    if (esc.previous_state) {
      lines.push(theme("muted", `  Previous state: ${esc.previous_state}`));
    }
    lines.push("");

    // ── Explicit questionnaire tool call (copy-pasteable) ──
    // The Apr 17 lesson: behavior must be enforced in tool output format,
    // not just in SKILL.md. Penny sees this text and must copy-paste it.
    lines.push(theme("toolTitle", "  Invoke this questionnaire tool call:"));
    lines.push(theme("accent", "  questionnaire({"));
    lines.push(theme("accent", "    questions: ["));

    for (const q of esc.questions || []) {
      lines.push(theme("accent", "      {"));
      lines.push(theme("accent", `        id: "${q.id}",`));
      lines.push(theme("accent", `        label: "${q.label}",`));
      lines.push(
        theme("accent", `        prompt: "${(q.prompt || "").replace(/\\n/g, " ").slice(0, 300)}",`)
      );
      lines.push(theme("accent", "        options: ["));
      for (const opt of q.options || []) {
        const desc = opt.description ? `, description: "${opt.description}"` : "";
        lines.push(
          theme("accent", `          { value: "${opt.value}", label: "${opt.label}"${desc} },`)
        );
      }
      lines.push(theme("accent", "        ],"));
      if (q.allowOther !== false) {
        lines.push(theme("accent", "        allowOther: true,"));
      }
      lines.push(theme("accent", "      },"));
    }

    lines.push(theme("accent", "    ]"));
    lines.push(theme("accent", "  })"));
    lines.push("");
    // NOTE: no orchestrator_state to carry — the engine's durable checkpointer
    // owns all FSM state, keyed by session_id/run_id. Re-invoking with the SAME
    // session_id + constraints.user_response is sufficient: `recover` finds the
    // pending run and `step --agent user` consumes the answer.
    lines.push(theme("muted", "  After the user responds, re-invoke the skill with:"));
    lines.push(theme("muted", "  skill({"));
    lines.push(theme("muted", `    skill_name: "${result.skill_name}",`));
    lines.push(theme("muted", `    session_id: "${result.session_id}",`));
    lines.push(theme("muted", '    goal: "<original goal>",'));
    lines.push(theme("muted", "    constraints: {"));
    lines.push(theme("muted", '      user_response: "<answer from questionnaire>"'));
    lines.push(theme("muted", "    }"));
    lines.push(theme("muted", "  })"));
  } else {
    lines.push(theme("error", `✗ ${result.skill_name} failed`));
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
 * Truncate text for use as {previous} in chain mode.
 *
 * Cuts at a word boundary near maxChars, appending '…' when truncated.
 * If no word boundary exists within 80% of maxChars, does a hard cut.
 * Returns empty string as-is (no truncation marker).
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
 * Extract a text summary from a SkillResult for chain {previous} handoff.
 *
 * Uses plan.plan_summary if available (structured output from completion action),
 * falls back to a simple session + state description.
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
