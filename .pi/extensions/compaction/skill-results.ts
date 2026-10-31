import { parseCurrentSkillResult, skillResultNodes, type SkillResult } from "@penny/orchestration";

import type { SkillResultStatus } from "./schema.js";

export interface ParsedSkillResultDetails {
  format: "current";
  status: SkillResultStatus;
  success: boolean;
  sessionId?: string;
  skillName: string;
  state: string;
  mode?: string;
  summary?: string;
  details: SkillResult;
}

function classify(details: SkillResult): SkillResultStatus {
  const success = details.success;
  const state = details.state.trim().toLowerCase();
  if (details.result !== undefined && details.result.met !== success) return "unknown";
  if (details.continuation !== undefined || details.dispatch_pause !== undefined) {
    return success ? "unknown" : "paused";
  }
  if (state === "complete") return success ? "success" : "unknown";
  if (state === "incomplete" || state === "partial") return success ? "unknown" : "incomplete";
  if (state === "cancelled") return success ? "unknown" : "cancelled";
  if (state === "error" || state === "failed" || state === "refused") {
    return success ? "unknown" : "failure";
  }
  return "unknown";
}

function extractSummary(details: SkillResult): string | undefined {
  for (const key of ["plan_summary", "title", "goal", "summary"] as const) {
    const value = details.plan?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return undefined;
}

function normalize(details: SkillResult): ParsedSkillResultDetails {
  const summary = extractSummary(details);
  return {
    format: "current",
    status: classify(details),
    success: details.success,
    ...(details.session_id ? { sessionId: details.session_id } : {}),
    skillName: details.skill_name,
    state: details.state,
    ...(details.mode === undefined ? {} : { mode: details.mode }),
    ...(summary === undefined ? {} : { summary }),
    details,
  };
}

/** Current structured details only: no prose parsing or obsolete failed-run adapters. */
export function parseSkillResultDetails(value: unknown): ParsedSkillResultDetails | null {
  try {
    return normalize(parseCurrentSkillResult(value));
  } catch {
    return null;
  }
}

/** The shared parser validates the entire bounded tree; malformed children reject the root. */
export function collectValidatedSkillResultNodes(
  root: ParsedSkillResultDetails
): ParsedSkillResultDetails[] {
  return skillResultNodes(root.details).map(normalize);
}
