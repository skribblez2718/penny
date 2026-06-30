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
    questions: Array<{
      id: string;
      label: string;
      prompt: string;
      options: Array<{ value: string; label: string; description?: string }>;
      allowOther?: boolean;
    }>;
    unknown_reason?: string;
    previous_state?: string;
    orchestrator_state?: Record<string, unknown>;
  };
}

/**
 * Detect the invocation mode from tool parameters.
 *
 * Exactly one mode must be provided — ambiguous params produce an error.
 * This is a pure function (no side effects) for testability.
 *
 * Priority order: resume_skill > resume_chain > chain > skills > single
 */
export function detectSkillMode(params: {
  skill_name?: string;
  goal?: string;
  skills?: Array<{ skill_name: string; goal: string }>;
  chain?: Array<{ skill_name: string; goal: string }>;
  resume_chain?: string;
  resume_skill?: string;
}): { mode: "single" | "parallel" | "chain" | "resume" | "resume_skill"; error?: string } {
  const hasSkills = (params.skills?.length ?? 0) > 0;
  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasSingle = Boolean(params.skill_name && params.goal);
  const hasResumeChain = Boolean(params.resume_chain);
  const hasResumeSkill = Boolean(params.resume_skill);

  const modeCount =
    Number(hasSkills) + Number(hasChain) + Number(hasSingle) + Number(hasResumeChain) + Number(hasResumeSkill);

  if (modeCount === 0) {
    return {
      mode: "single",
      error:
        "No invocation mode provided. Provide skill_name+goal, skills, chain, resume_chain, or resume_skill.",
    };
  }
  if (modeCount > 1) {
    return {
      mode: "single",
      error:
        "Ambiguous parameters. Provide exactly one of: skill_name+goal, skills, chain, resume_chain, or resume_skill.",
    };
  }

  if (hasResumeSkill) return { mode: "resume_skill" };
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

      const goal = (result.plan as any)?.goal;
      if (goal) {
        lines.push(theme("text", `  Goal: ${goal}`));
      }

      for (const step of result.plan_steps) {
        const num = (step as any).step || (step as any).id || "•";
        const title = (step as any).title || String(step);
        lines.push(theme("text", `  ${num}. ${title}`));
      }

      if (result.steps_total > result.plan_steps.length) {
        lines.push(theme("dim", `  ... and ${result.steps_total - result.plan_steps.length} more`));
      }
    } else if (result.plan) {
      const plan = result.plan as any;
      const steps = plan.steps || plan.tasks || [];
      if (Array.isArray(steps) && steps.length > 0) {
        lines.push(`  Steps: ${steps.length}`);
        for (const step of steps.slice(0, 8)) {
          const title = step.title || step.description || step;
          lines.push(`    ${step.id || step.step || "•"}. ${title}`);
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
    lines.push(theme("muted", "  After the user responds, re-invoke the skill with:"));
    lines.push(theme("muted", "  skill({"));
    lines.push(theme("muted", `    skill_name: "${result.skill_name}",`));
    lines.push(theme("muted", '    goal: "<original goal>",'));
    lines.push(theme("muted", "    constraints: {"));
    lines.push(theme("muted", '      user_response: "<answer from questionnaire>",'));
    lines.push(theme("muted", `      orchestrator_state: ${JSON.stringify(esc.orchestrator_state)}`));
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
 * Parse sub-queries from Piper's text output when no SUMMARY block is found.
 * Tries multiple heuristics:
 * 1. JSON array in a markdown code block (```json [...])
 * 2. Numbered list lines (1. "query")
 * 3. Bullet list lines (- or * "query")
 *
 * --- L2 FIXES ---
 * - Minimum length: 20 chars (was 5) to avoid capturing headers and fragments
 * - Excludes common section headers, markdown formatting markers, and metadata
 * - Dedupes by keeping only unique lines (first occurrence wins)
 */
export function extractSubQueriesFromPiperOutput(output: string): string[] {
  const queries: string[] = [];

  // --- L2 FIX: known non-query patterns to exclude ---
  // These are section headers, formatting markers, or metadata that
  // the old heuristic would misinterpret as queries.
  const NON_QUERY_PATTERNS = new Set([
    "overview", "purpose", "scope", "goals", "objectives",
    "summary", "conclusion", "recommendations", "next steps",
    "background", "context", "constraints", "assumptions",
    "tradeoffs", "alternatives", "dimensions", "rubric",
    "dimension", "category", "status", "notes", "details",
    "plan steps", "sub-queries", "sub queries", "research plan",
  ]);
  const MAX_QUERY_LENGTH = 400;

  // Heuristic 1: JSON array in markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (q): q is string => typeof q === "string" && q.length >= 20 && q.length <= MAX_QUERY_LENGTH
        );
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Heuristic 2: Numbered list lines like "1. sub-query text" or "1) sub-query text"
  const numberedMatches = output.match(/^\s*\d+[.)]\s+(.+)$/gm);
  if (numberedMatches) {
    for (const line of numberedMatches) {
      const trimmed = line.replace(/^\s*\d+[.)]\s+/, "").trim();
      const lower = trimmed.toLowerCase();
      if (
        trimmed.length >= 20 &&
        trimmed.length <= MAX_QUERY_LENGTH &&
        !NON_QUERY_PATTERNS.has(lower) &&
        !lower.startsWith("[source title]") &&
        !lower.startsWith("tier:") &&
        !lower.startsWith("###") &&
        !lower.startsWith("##")
      ) {
        queries.push(trimmed);
      }
    }
  }

  // Heuristic 3: Bullet list lines like "- sub-query text" or "* sub-query text"
  const bulletMatches = output.match(/^\s*[-*]\s+(.+)$/gm);
  if (bulletMatches) {
    for (const line of bulletMatches) {
      const trimmed = line.replace(/^\s*[-*]\s+/, "").trim();
      const lower = trimmed.toLowerCase();
      if (
        trimmed.length >= 20 &&
        trimmed.length <= MAX_QUERY_LENGTH &&
        !NON_QUERY_PATTERNS.has(lower) &&
        !trimmed.startsWith("[") &&
        !lower.startsWith("[source title]") &&
        !lower.startsWith("tier:") &&
        !lower.toLowerCase().includes("dimension") &&
        !lower.startsWith("###") &&
        !lower.startsWith("##")
      ) {
        queries.push(trimmed);
      }
    }
  }

  // Dedupe while preserving order
  const seen = new Set<string>();
  return queries.filter((q) => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });
}

/**
 * Extract research signals from Echo's text output when no SUMMARY block is found.
 * Counts findings, detects content sections, and generates a fallback task ID.
 */
export function extractEchoResearchSummary(output: string): Record<string, unknown> {
  const findings: string[] = [];

  // Count "### Finding" or "## Finding" headers
  const findingMatches = output.match(/^\s*#{2,3}\s+(?:Finding|Key\s*Finding)[\s\d:]*(.+)?$/gim);
  if (findingMatches) {
    for (const line of findingMatches) {
      const title = line.replace(/^\s*#{2,3}\s+(?:Finding|Key\s*Finding)[\s\d:]*/, "").trim();
      if (title && title.length > 3) findings.push(title);
    }
  }

  // Also detect bullet findings: "- **Claim**:-" or "- Claim:"
  const claimMatches = output.match(/^\s*[-*]\s*\*\*?(?:Claim|Finding|Result)\*\*?\s*[:\-]?\s*(.+)$/gim);
  if (claimMatches) {
    for (const line of claimMatches) {
      const claim = line.replace(/^\s*[-*]\s*\*\*?(?:Claim|Finding|Result)\*\*?\s*[:\-]?\s*/, "").trim();
      if (claim && claim.length > 5) findings.push(claim);
    }
  }

  // Count sources
  const sourceMatches = output.match(/\[Source Title\]\(|Tier:\s*([✓○◇?]T[1-4])/gi);
  const sourceCount = sourceMatches ? sourceMatches.length : 0;

  // Check for substantial output
  const hasContent = output.includes("## Key Findings") || output.includes("### Finding") || output.includes("## Sources Table");
  const isSubstantive = output.length > 500 && (hasContent || findings.length > 0 || sourceCount > 0);

  // Generate a task ID for the orchestrator to count this agent as complete
  const fallbackId = `echo-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    findings_count: findings.length,
    sources_count: sourceCount,
    explore_complete: isSubstantive,
    mempalace_drawer: isSubstantive ? fallbackId : "",
    confidence: findings.length > 0 ? "PROBABLE" : "UNCERTAIN",
  };
}

/**
 * Build a safe default summary for an agent when no SUMMARY block was found.
 * These defaults let the orchestrator continue the workflow instead of
 * failing immediately on missing summary data.
 *
 * CRITICAL: These defaults must NOT claim completion status.
 * The old behavior claimed explore_complete=true, plan_complete=true, etc.
 * which caused the skill to advance on empty/missing agent output.
 *
 * NOTE: This is a last-resort fallback. All agents are required to emit
 * SUMMARY:{"..."} per the skill prompt standard. If this fires, the agent
 * deviated from the format — investigate rather than rely on it.
 */
export function defaultSummaryForAgent(agent: string, agentOutput?: string): Record<string, unknown> {
  switch (agent) {
    case "echo": {
      const fallback = agentOutput ? extractEchoResearchSummary(agentOutput) : {};
      return {
        findings_count: 0,
        files_count: 0,
        unknowns_count: 0,
        explore_complete: false,
        ...fallback,
      };
    }
    case "piper": {
      // Fallback: try to extract sub-queries from text output
      const subQueries = agentOutput
        ? extractSubQueriesFromPiperOutput(agentOutput)
        : [];
      return {
        plan_steps: subQueries,
        plan_complete: subQueries.length > 0,
        mode: "standard",
        sub_query_count: subQueries.length,
        // Skill-aware aliases — see research/skills-agent-output-mismatch-audit.md
        design_steps: [],           // agent skill expects this
        design_complete: false,     // agent skill expects this
        stakes: "",               // plan skill verification expects this
        alternatives: [],         // plan skill verification expects this
        counter_argument: "",     // plan skill verification expects this
      };
    }
    case "annie":
      return {
        preferences_rating: 0,
        skill_rating: 1,
        skill_matches: [],
        skill_misses: [],
        skill_translations: [],
        employee_satisfaction: null,
        salary_competitiveness: null,
        remote_work_flexibility: null,
        skills_alignment: null,
        cultural_fit: null,
        determination: "no",
      };
    case "carren":
      return {
        verdict: "NEEDS_REVISION",
        issues: ["Agent did not emit SUMMARY or summary was empty"],
      };
    case "tabitha":
      return { title: "", step_count: 0, complete: false };
    case "vera":
      // CANONICAL VOCABULARY: aligned with prd skill's authoritative
      // _safe_default_summary() for vera in
      // .pi/skills/prd/scripts/orchestrate.py. The orchestrator is
      // the source of truth for its own schema; the extension's
      // fallback MUST match so validation passes when the agent's
      // stdout has no parseable SUMMARY block. Update this when
      // the prd orchestrator's schema changes.
      return {
        valid: false,
        ideal_state_valid: false,
        issues: ["Agent did not emit SUMMARY or summary was empty"],
        confidence: "POSSIBLE",
        complete: false,
      };
    case "synthia":
      // CANONICAL VOCABULARY: aligned with prd skill's authoritative
      // _safe_default_summary() in .pi/skills/prd/scripts/orchestrate.py.
      // The orchestrator is the source of truth for its own schema;
      // when the agent's stdout has no parseable SUMMARY block, this
      // fallback MUST match the prd orchestrator's expected fields
      // exactly so validation passes. Update this when the prd
      // orchestrator's schema changes.
      return {
        requirement_count: 0,
        narrative_sections: 0,
        verification_matrix_complete: false,
        ideal_state_valid: false,
        needs_clarification: false,
        clarifying_questions: [],
        complete: false,
        confidence: "POSSIBLE",
      };
    case "skribble":
      return {
        write_complete: false,
        files_written: [],
        word_count: 0,
        theme_count: 0,
        source_count: 0,
        // Skill-aware aliases — see research/skills-agent-output-mismatch-audit.md
        files_created: [],        // agent skill expects this
        files_modified: [],       // agent skill expects this
        generation_complete: false, // agent skill expects this
        agent_definition: "",     // agent skill expects this
        agent_file_path: "",      // agent skill expects this
      };
    default:
      return {};
  }
}

/**
 * Check whether a parsed summary is empty or effectively missing.
 * Used to decide whether to apply defaultSummaryForAgent.
 */
export function isSummaryEmpty(summary: Record<string, unknown>): boolean {
  if (!summary) return true;
  if (Object.keys(summary).length === 0) return true;
  return false;
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
