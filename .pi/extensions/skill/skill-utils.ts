import type { ThemeColor } from "@earendil-works/pi-coding-agent";

import {
  registerTrustedQuestionnaireTransport,
  type TrustedQuestionnaireBinding,
  type TrustedQuestionnaireQuestion,
} from "./execution-receipts.js";
import { ARTIFACT_DISPATCH_MODE_ENV } from "./dispatch-control.js";
import { parseArtifactRef, type ArtifactRef } from "./artifact-client.js";
import type { SkillResult } from "@penny/orchestration";

export type { SkillResult } from "@penny/orchestration";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export type RepairDiagnostics = NonNullable<SkillResult["repair_diagnostics"]>;

/** Parse the engine's bounded diagnostic projection at the extension boundary. */
export function parseRepairDiagnostics(value: unknown): RepairDiagnostics {
  if (!isRecord(value) || !isRecord(value.budget) || !Array.isArray(value.feedback_report_refs)) {
    throw new TypeError("invalid repair diagnostics");
  }
  if (
    typeof value.origin_state !== "string" ||
    typeof value.feedback_kind !== "string" ||
    !Number.isSafeInteger(value.budget.used) ||
    (value.budget.limit !== null && !Number.isSafeInteger(value.budget.limit)) ||
    typeof value.budget.used !== "number" ||
    (value.budget.limit !== null && typeof value.budget.limit !== "number") ||
    value.budget.used < 0 ||
    (value.budget.limit !== null && value.budget.limit < 0) ||
    value.feedback_report_refs.length > 128
  ) {
    throw new TypeError("invalid repair diagnostics");
  }
  return {
    origin_state: value.origin_state,
    feedback_kind: value.feedback_kind,
    budget: { used: value.budget.used, limit: value.budget.limit },
    feedback_report_refs: value.feedback_report_refs.map(parseArtifactRef),
  };
}

export type SealDiagnostics = NonNullable<SkillResult["seal_diagnostics"]>;

/** Only parse the bounded terminal projection; never fetch diagnostic contents. */
export function parseSealDiagnostics(value: unknown): SealDiagnostics {
  const fields = [
    "latest_diagnostic_ref",
    "rejected_draft_ref",
    "epoch_anchor_ref",
    "corrections_used",
    "correction_limit",
    "disposition",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.epoch_anchor_ref === undefined ||
    !Number.isSafeInteger(value.corrections_used) ||
    (value.correction_limit !== null && !Number.isSafeInteger(value.correction_limit)) ||
    typeof value.corrections_used !== "number" ||
    (value.correction_limit !== null && typeof value.correction_limit !== "number") ||
    value.corrections_used < 0 ||
    (value.correction_limit !== null && value.correction_limit < 0) ||
    (value.correction_limit !== null && value.corrections_used > value.correction_limit) ||
    (value.disposition !== "correction_offered" &&
      value.disposition !== "exhausted" &&
      value.disposition !== "stalled") ||
    (value.disposition === "exhausted" &&
      (value.correction_limit === null || value.corrections_used !== value.correction_limit)) ||
    (value.disposition === "correction_offered" &&
      value.correction_limit !== null &&
      value.corrections_used >= value.correction_limit)
  ) {
    throw new TypeError("invalid seal diagnostics");
  }
  const latest = parseArtifactRef(value.latest_diagnostic_ref);
  const rejected = parseArtifactRef(value.rejected_draft_ref);
  const anchor = value.epoch_anchor_ref === null ? null : parseArtifactRef(value.epoch_anchor_ref);
  if (
    latest.kind !== "seal-diagnostic" ||
    latest.run_id !== rejected.run_id ||
    (anchor !== null && anchor.run_id !== rejected.run_id)
  ) {
    throw new TypeError("invalid seal diagnostic ref binding");
  }
  return {
    latest_diagnostic_ref: latest,
    rejected_draft_ref: rejected,
    epoch_anchor_ref: anchor,
    corrections_used: value.corrections_used,
    correction_limit: value.correction_limit,
    disposition: value.disposition,
  };
}

export type SkillProgressMode = "single" | "parallel" | "chain" | "resume";

export interface ActiveSkillProgress {
  readonly index: number;
  readonly skill_name: string;
  readonly state_id?: string;
  readonly agents: readonly string[];
}

/** Structured, bounded details for Pi partial results while a skill tool is running. */
export interface SkillProgressDetails {
  readonly kind: "progress";
  readonly mode: SkillProgressMode;
  readonly stage:
    | "preparing"
    | "phase_started"
    | "worker_completed"
    | "worker_failed"
    | "host_operation_progress"
    | "boundary_reached"
    | "composition_started"
    | "item_finished"
    | "resuming";
  readonly message: string;
  readonly skill_name: string;
  readonly session_id: string;
  readonly state_id?: string;
  readonly agents?: readonly string[];
  readonly workers_completed?: number;
  readonly workers_total?: number;
  readonly skills_finished?: number;
  readonly skills_total?: number;
  readonly active_skills?: readonly ActiveSkillProgress[];
  readonly chain_step?: number;
  readonly chain_total?: number;
  readonly boundary_action?: string;
}

export type SkillToolDetails = SkillResult | SkillProgressDetails;

export function isSkillProgressDetails(value: unknown): value is SkillProgressDetails {
  return isRecord(value) && value.kind === "progress" && typeof value.message === "string";
}

/**
 * A single escalation (human-gate) question surfaced to the user.
 *
 * `options` is OPTIONAL: free-text questions (e.g. an "out of scope paths"
 * prompt) legitimately omit predefined options and rely on the questionnaire's
 * free-text ("Type something") affordance via `allowOther`. Consumers MUST NOT
 * assume `options` is present — use `normalizeEscalationQuestions()`.
 * Private questionnaire rendering metadata is not part of the current skill-result wire.
 */
export type EscalationQuestion = NonNullable<SkillResult["escalation"]>["questions"][number] & {
  artifact_ref?: Record<string, unknown>;
  approval_challenge?: string;
  approval_run_id?: string;
  approval_gate_id?: string;
  questionnaire_transport_ref?: Record<string, unknown>;
  rendered_questions_digest?: string;
};
export type EscalationQuestionOption = NonNullable<EscalationQuestion["options"]>[number];

/**
 * Normalize orchestrator-produced escalation questions into the shape the
 * questionnaire tool expects, defensively defaulting a missing/empty `options`
 * array and stripping empty `description` fields.
 *
 * Root-cause fix for charter gates whose playbook emits
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
function serializeToolPayload(payload: unknown): string {
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
  input_artifacts?: string[];
  context_artifacts?: string[];
  previous_artifact_designation?: "binding" | "context";
  session_id?: string;
  constraints?: Record<string, unknown>;
  model?: string;
}

/** Minimal checkpoint shape reconstructResumeChain reads (subset of ChainCheckpoint). */
export interface ResumeCheckpointStep {
  index: number;
  skill_name: string;
  goal: string;
  input_artifacts?: string[];
  context_artifacts?: string[];
  previous_artifact_designation?: "binding" | "context";
  session_id: string;
  status: "pending" | "running" | "complete" | "failed";
  model?: string;
  constraints?: Record<string, unknown>;
  result_preview?: string;
  output_artifact_ref?: ArtifactRef;
  handoff_artifact_ref?: ArtifactRef;
  input_assurance?: SkillResult["input_assurance"];
}

export interface ResumeCheckpointShape {
  steps: ResumeCheckpointStep[];
  pending_steps?: Array<{
    index: number;
    skill_name: string;
    goal: string;
    input_artifacts?: string[];
    context_artifacts?: string[];
    previous_artifact_designation?: "binding" | "context";
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
    input_assurance?: SkillResult["input_assurance"];
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
        input_assurance: step.input_assurance,
      });
      continue;
    }
    if (seen.has(step.index)) continue;
    if (step.status === "failed") {
      const override = stepOverrides?.[step.index];
      chain.push({
        skill_name: step.skill_name,
        goal: override?.goal ?? step.goal,
        input_artifacts: step.input_artifacts,
        context_artifacts: step.context_artifacts,
        previous_artifact_designation: step.previous_artifact_designation,
        constraints: { ...(step.constraints ?? {}), ...(override?.constraints ?? {}) },
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
        input_artifacts: step.input_artifacts,
        context_artifacts: step.context_artifacts,
        previous_artifact_designation: step.previous_artifact_designation,
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
      input_artifacts: pending.input_artifacts,
      context_artifacts: pending.context_artifacts,
      previous_artifact_designation: pending.previous_artifact_designation,
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
  context_artifacts?: string[];
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

  if (!hasSingle && params.context_artifacts !== undefined)
    return {
      mode: "single",
      error:
        "context_artifacts belongs on each parallel/chain step; resume reuses checkpointed inputs",
    };
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
/**
 * Emit the exact terminal artifact ID plus its read form.
 *
 * Kept as one helper so the success path and the approval path cannot drift,
 * and so a result without an artifact silently adds nothing.
 */
function appendExactOutputLines(
  lines: string[],
  ref: ArtifactRef | undefined,
  theme: (color: ThemeColor, text: string) => string,
  label?: string
): void {
  if (!ref?.artifact_id) return;
  lines.push(`  Exact output artifact${label ? ` (${label})` : ""}: ${ref.artifact_id}`);
  lines.push(theme("muted", `  Read it with artifact_read({"artifact":"${ref.artifact_id}"}).`));
}

function appendInputAssurance(
  lines: string[],
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string
): void {
  const entries = [
    ...(result.chain_results ?? result.parallel_results ?? []),
    ...(result.input_assurance === undefined ? [] : [result]),
  ];
  for (const entry of entries) {
    const assurance = entry.input_assurance;
    if (assurance === undefined) continue;
    const label =
      entry.skill_name === "chain" && entry.chain_error_step !== undefined
        ? `chain step ${entry.chain_error_step + 1}`
        : entry.skill_name;
    lines.push(
      theme(
        "muted",
        `  ${label} input specification assurance: ${assurance.mode}${assurance.specification_artifact_id === null ? " (no SpecificationV1 input)" : ` for ${assurance.specification_artifact_id}`}; record ${assurance.assurance_ref.artifact_id}. This does not certify the output or its earlier ancestors.`
      )
    );
  }
}

function appendEffectStatus(
  lines: string[],
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string
): void {
  const limitation = result.result?.["effect_limitation"];
  const notice = result.result?.["effect_scope_notice"];
  if (typeof limitation === "string" && limitation.length > 0) {
    lines.push(theme("warning", `  Effect limitation: ${limitation}`));
  }
  if (typeof notice === "string" && notice.length > 0) {
    lines.push(theme("muted", `  Effect scope: ${notice}`));
  }
}

function outputLabel(result: SkillResult, ref: ArtifactRef): string | undefined {
  if (result.success) return undefined;
  if (result.seal_diagnostics?.rejected_draft_ref.artifact_id === ref.artifact_id) {
    return "rejected draft — not an accepted product";
  }
  if (result.seal_diagnostics?.epoch_anchor_ref?.artifact_id === ref.artifact_id) {
    return "prior accepted product; best partial";
  }
  const kind =
    result.output_artifact_ref?.artifact_id === ref.artifact_id
      ? result.result?.["output_kind"]
      : undefined;
  if (kind === "rejected_draft" || kind === "rejected_draft_best_partial") {
    return "rejected draft — not an accepted product";
  }
  if (kind === "accepted_product_best_partial") return "accepted product; best partial";
  if (kind === "unreviewed_best_partial") return "unreviewed best partial";
  // Historical results may not have a structured output_kind. Do not upgrade
  // an unknown negative ref to an accepted product by guessing from its name.
  return "best partial (acceptance not established)";
}

function appendAllExactOutputs(
  lines: string[],
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string
): void {
  const entries: Array<{ label?: string; ref: ArtifactRef }> = [];
  const add = (item: SkillResult, prefix?: string): void => {
    if (item.output_artifact_ref) {
      const label = outputLabel(item, item.output_artifact_ref);
      entries.push({
        ref: item.output_artifact_ref,
        ...(prefix || label ? { label: [prefix, label].filter(Boolean).join(": ") } : {}),
      });
    }
    for (const [index, ref] of (item.best_partial_artifact_refs ?? []).entries()) {
      entries.push({
        ref,
        label: [prefix, `best partial ${index + 1}`, outputLabel(item, ref)]
          .filter(Boolean)
          .join(": "),
      });
    }
    for (const [index, child] of (item.parallel_results ?? []).entries()) {
      add(child, `parallel ${index + 1}: ${child.skill_name}`);
    }
    for (const [index, child] of (item.chain_results ?? []).entries()) {
      add(child, `chain step ${(child.chain_step ?? index) + 1}: ${child.skill_name}`);
    }
  };
  // Children precede the aggregate on failures: a chain's legacy output may
  // alias its rejected step or the last completed product. Preserve its identity
  // but use the child's more precise label when available.
  if (result.success) add(result);
  else {
    for (const [index, child] of (result.parallel_results ?? []).entries()) {
      add(child, `parallel ${index + 1}: ${child.skill_name}`);
    }
    for (const [index, child] of (result.chain_results ?? []).entries()) {
      add(child, `chain step ${(child.chain_step ?? index) + 1}: ${child.skill_name}`);
    }
    if (result.output_artifact_ref) {
      const ref = result.output_artifact_ref;
      const child = result.chain_results?.find(
        (item) => item.output_artifact_ref?.artifact_id === ref.artifact_id
      );
      entries.push({ ref, label: child ? outputLabel(child, ref) : outputLabel(result, ref) });
    }
    for (const [index, ref] of (result.best_partial_artifact_refs ?? []).entries()) {
      entries.push({ ref, label: `best partial ${index + 1}: ${outputLabel(result, ref)}` });
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.ref.artifact_id)) continue;
    seen.add(entry.ref.artifact_id);
    appendExactOutputLines(lines, entry.ref, theme, entry.label);
  }
}

function appendRepairDiagnostics(
  lines: string[],
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string,
  label = result.skill_name
): void {
  const diagnostic = result.repair_diagnostics;
  if (diagnostic !== undefined) {
    lines.push(
      theme(
        "warning",
        `  Repair diagnostics (${label}): ${diagnostic.origin_state}:${diagnostic.feedback_kind}; budget used ${diagnostic.budget.used}/${diagnostic.budget.limit ?? "unlimited"}`
      )
    );
    if (diagnostic.feedback_report_refs.length === 0) {
      lines.push(theme("muted", "  Feedback report: not available for this receipt."));
    }
    for (const ref of diagnostic.feedback_report_refs) {
      lines.push(`  Feedback report artifact: ${ref.artifact_id}`);
      lines.push(
        theme("muted", `  Read feedback with artifact_read({"artifact":"${ref.artifact_id}"}).`)
      );
    }
  }
  for (const [index, child] of (result.parallel_results ?? []).entries()) {
    appendRepairDiagnostics(lines, child, theme, `parallel ${index + 1}: ${child.skill_name}`);
  }
  for (const [index, child] of (result.chain_results ?? []).entries()) {
    appendRepairDiagnostics(
      lines,
      child,
      theme,
      `chain step ${child.chain_step ?? index + 1}: ${child.skill_name}`
    );
  }
}

function appendSealDiagnostics(
  lines: string[],
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string,
  label = result.skill_name
): void {
  const diagnostic = result.seal_diagnostics;
  if (!result.success && diagnostic) {
    const reason =
      diagnostic.disposition === "exhausted"
        ? "Draft rejected by deterministic seal; correction allowance exhausted."
        : diagnostic.disposition === "stalled"
          ? "Draft rejected by deterministic seal; correction stopped."
          : "Draft rejected by deterministic seal; correction offered.";
    lines.push(theme("warning", `  Seal diagnostics (${label}): ${reason}`));
    lines.push(
      theme(
        "muted",
        `  Corrections used ${diagnostic.corrections_used}/${diagnostic.correction_limit ?? "unlimited"}; diagnostic: ${diagnostic.latest_diagnostic_ref.artifact_id}`
      )
    );
    lines.push(`  Rejected draft artifact: ${diagnostic.rejected_draft_ref.artifact_id}`);
    if (diagnostic.epoch_anchor_ref === null) {
      lines.push(theme("warning", "  No accepted sealed product in this run."));
    } else {
      lines.push(`  Prior accepted product: ${diagnostic.epoch_anchor_ref.artifact_id}`);
    }
  }
  for (const [index, child] of (result.parallel_results ?? []).entries()) {
    appendSealDiagnostics(lines, child, theme, `parallel ${index + 1}: ${child.skill_name}`);
  }
  for (const [index, child] of (result.chain_results ?? []).entries()) {
    appendSealDiagnostics(
      lines,
      child,
      theme,
      `chain step ${(child.chain_step ?? index) + 1}: ${child.skill_name}`
    );
  }
}

export function formatSealDiagnostics(
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string
): string {
  const lines: string[] = [];
  appendSealDiagnostics(lines, result, theme);
  return lines.join("\n");
}

function hasSealDiagnostics(result: SkillResult): boolean {
  return (
    result.seal_diagnostics !== undefined ||
    (result.parallel_results ?? []).some(hasSealDiagnostics) ||
    (result.chain_results ?? []).some(hasSealDiagnostics)
  );
}

export function formatResult(
  result: SkillResult,
  theme: (color: ThemeColor, text: string) => string
): string {
  const lines: string[] = [];

  if (
    result.mode === "parallel" &&
    result.parallel_results?.some((child) => child.continuation !== undefined)
  ) {
    const waiting = result.parallel_results.filter(
      (child) => child.continuation !== undefined
    ).length;
    lines.push(
      theme(
        result.success ? "success" : "warning",
        `Parallel: ${result.parallel_results.length} branches; ${waiting} awaiting user input`
      )
    );
    lines.push(`  Session: ${result.session_id}`);
    lines.push(
      "  Handle each waiting branch separately; do not rerun successful siblings or resume the aggregate session."
    );
    for (const [index, child] of result.parallel_results.entries()) {
      lines.push("");
      lines.push(
        theme(
          "toolTitle",
          `Branch ${index + 1}: ${escapeTerminalDisplayText(child.skill_name)} (session ${escapeTerminalDisplayText(child.session_id)})`
        )
      );
      lines.push(formatResult(child, theme));
    }
    return lines.join("\n");
  }

  if (result.success) {
    lines.push(theme("success", `✓ ${result.skill_name} completed`));
    lines.push(`  Session: ${result.session_id}`);
    lines.push(`  Phases: ${result.agents_invoked.join(" → ")}`);

    if (result.session_room) {
      lines.push(`  Room: ${result.session_room}`);
    }

    // The terminal artifact ID must appear HERE, in model-visible content.
    // `details` is not provider-visible, so print every terminal/branch/step ID.
    appendAllExactOutputs(lines, result, theme);
    appendEffectStatus(lines, result, theme);

    if (result.requires_approval && result.plan_steps && result.plan_steps.length > 0) {
      lines.push("");
      lines.push(theme("warning", "⛔ APPROVAL REQUIRED — DO NOT EXECUTE YET"));
      lines.push(
        theme("warning", "Present this plan to the user for approval before doing ANY work.")
      );
      lines.push(theme("muted", "Use the questionnaire tool to ask: Approve / Refine / Deny."));
      lines.push(theme("muted", "Read the exact plan artifact ID with artifact_read when needed."));
      appendExactOutputLines(lines, result.output_artifact_ref, theme);
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
      if (isUnknownArray(steps) && steps.length > 0) {
        lines.push(`  Steps: ${steps.length}`);
        for (const rawStep of steps.slice(0, 8)) {
          const step = isRecord(rawStep) ? rawStep : {};
          const title = step["title"] || step["description"] || rawStep;
          lines.push(`    ${String(step["id"] || step["step"] || "•")}. ${String(title)}`);
        }
        if (steps.length > 8) {
          lines.push(`    ... and ${steps.length - 8} more`);
        }
      }
    }
  } else if (result.dispatch_pause) {
    const pause = result.dispatch_pause;
    const recovery = pause.recovery;
    lines.push(theme("warning", `⏸️ ${result.skill_name} dispatch paused`));
    lines.push(`  Run: ${pause.identity.run_id}`);
    lines.push(`  Session: ${pause.identity.session_id}`);
    lines.push(`  State: ${pause.state_id}`);
    lines.push(`  Code: ${pause.code}`);
    lines.push(`  Reason: ${pause.reason}`);
    if (recovery.checkpoint_exists === null) {
      lines.push("  Checkpoint exists: unverified; resumable: false");
      lines.push(
        `  Historical checkpoint_preserved claim: ${String(recovery.legacy_checkpoint_preserved_claim)}`
      );
    } else {
      lines.push(
        `  Checkpoint exists: ${String(recovery.checkpoint_exists)}; resumable: ${String(recovery.resumable)}`
      );
    }
    if (pause.dispatch.code === "DISPATCH_MODE_INVALID") {
      lines.push(theme("warning", `  Dispatch setting: invalid (fails closed as paused)`));
    }
    if (recovery.kind === "recoverable_checkpoint") {
      lines.push(
        theme(
          "muted",
          `  Recovery: set ${ARTIFACT_DISPATCH_MODE_ENV}=${recovery.requires_dispatch_mode}, then recover run ${recovery.identity.run_id} in session ${recovery.identity.session_id} from state ${recovery.state_id}.`
        )
      );
    } else if (recovery.kind === "start_retry") {
      const checkpointFact = recovery.checkpoint_exists
        ? "An admission checkpoint row exists, but it is not a resumable run checkpoint."
        : "No engine checkpoint exists for this attempted start.";
      const retryTarget = result.chain_session_id
        ? `resume chain ${result.chain_session_id}`
        : `retry the original ${result.skill_name} start for session ${recovery.identity.session_id}`;
      lines.push(theme("muted", `  Recovery: ${checkpointFact}`));
      lines.push(
        theme(
          "muted",
          `  Set ${ARTIFACT_DISPATCH_MODE_ENV}=${recovery.requires_dispatch_mode}, then ${retryTarget}.`
        )
      );
    } else if (recovery.checkpoint_exists === null) {
      lines.push(
        theme(
          "warning",
          `  Compatibility (${recovery.ineligibility_code}): ${recovery.reason} Do not recover; use status or cancel for run ${recovery.identity.run_id}.`
        )
      );
    } else {
      lines.push(
        theme(
          "warning",
          `  Recovery (${recovery.ineligibility_code}): ${recovery.reason} Checkpoint exists but is not eligible to resume. Do not recover; use status or cancel for run ${recovery.identity.run_id}.`
        )
      );
    }
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

    const continuation = result.continuation;
    if (continuation !== undefined) {
      lines.push(
        `  Paused run: ${escapeTerminalDisplayText(continuation.identity.run_id)}; session: ${escapeTerminalDisplayText(continuation.identity.session_id)}`
      );
      lines.push(
        `  Gate: ${escapeTerminalDisplayText(continuation.gate_id)}; challenge: ${escapeTerminalDisplayText(continuation.challenge)}`
      );
    }
    for (const question of esc.questions) {
      lines.push(
        `  [${escapeTerminalDisplayText(question.id)}] ${escapeTerminalDisplayText(question.prompt)}`
      );
    }

    // ── Explicit questionnaire tool call (copy-pasteable) ──
    // The Apr 17 lesson: behavior must be enforced in tool output format,
    // not just in SKILL.md. Penny sees this text and must copy-paste it.
    lines.push(theme("toolTitle", "  Invoke this questionnaire tool call:"));
    const questionnaireLiteral = serializeToolPayload(
      esc.trustedTransportCapability === undefined
        ? prepareQuestionnairePayload(esc.questions)
        : { trustedTransportCapability: esc.trustedTransportCapability }
    );
    const literalLines = questionnaireLiteral.split("\n");
    lines.push(theme("accent", `  questionnaire(${literalLines[0]}`));
    for (const line of literalLines.slice(1)) {
      lines.push(theme("accent", `  ${line}`));
    }
    lines.push(theme("accent", "  )"));
    lines.push("");
    if (esc.trustedTransportCapability !== undefined) {
      if (continuation?.resume_invocation !== undefined) {
        lines.push(
          "  Bound single-step resume data (reference only; native completion owns continuation):"
        );
        lines.push(serializeToolPayload(continuation.resume_invocation));
      }
      lines.push(
        theme(
          "muted",
          "  Only the actual user may answer. Native completion will report the next step; do not forward model-written answers."
        )
      );
      return lines.join("\n");
    }
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
    } else if (continuation?.resume_invocation !== undefined) {
      const invocation = continuation.resume_invocation;
      lines.push(
        theme(
          "muted",
          "  After the user responds, resume only this step (replace user_response with the actual questionnaire answer):"
        )
      );
      lines.push(
        `  skill(${serializeToolPayload({
          ...invocation,
          constraints: { ...invocation.constraints, user_response: "<answer from questionnaire>" },
        })})`
      );
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
    // A seal failure has its own bounded, body-free reason below. Legacy
    // unresolved prose may contain authored material; never echo it as a
    // second unbounded diagnostic in single or aggregate failure output.
    if (!hasSealDiagnostics(result)) {
      for (const error of result.errors) lines.push(`  Error: ${error}`);
    }
    appendAllExactOutputs(lines, result, theme);
    appendEffectStatus(lines, result, theme);
  }

  appendInputAssurance(lines, result, theme);
  appendSealDiagnostics(lines, result, theme);
  appendRepairDiagnostics(lines, result, theme);
  return lines.join("\n");
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
  const planSummary = result.plan?.["plan_summary"];
  if (typeof planSummary === "string" && planSummary.trim()) return planSummary.trim();

  // Fallback: session identity + state
  const parts: string[] = [];
  if (result.session_id) parts.push(`session:${result.session_id}`);
  if (result.skill_name) parts.push(`skill:${result.skill_name}`);
  if (result.state) parts.push(`state:${result.state}`);
  if (result.errors.length > 0) parts.push(`errors:${result.errors.join("; ")}`);

  return parts.join(" ") || "(no output)";
}
