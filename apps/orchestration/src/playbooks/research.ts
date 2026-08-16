import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type, type TSchema } from "typebox";

import { sha256 } from "../checkpointer.js";
import { positiveIntegerConstraint, RunContext, type PendingBranch } from "../context.js";
import {
  DirectiveSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  validateContract,
} from "../contracts.js";

const MODES = new Set(["quick", "standard", "deep"]);
const DEFAULT_MODE = "standard";
const MAX_BRANCHES = 64;

const ClarificationFields = {
  needs_clarification: Type.Optional(Type.Boolean()),
  clarifying_questions: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 16,
    })
  ),
};

const PlanningSummarySchema = Type.Object(
  {
    plan_steps: Type.Array(Type.String({ maxLength: 32_768 }), {
      maxItems: MAX_BRANCHES,
    }),
    plan_complete: Type.Boolean(),
    mode: Type.Optional(Type.String({ pattern: "^(quick|standard|deep)$" })),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const CritiqueSummarySchema = Type.Object(
  {
    verdict: Type.String({ pattern: "^(APPROVE|NEEDS_REVISION)$" }),
    issues: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 128 }),
    evidence: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 256 }),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const ExploreSummarySchema = Type.Object(
  {
    explore_complete: Type.Boolean(),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const SynthesisSummarySchema = Type.Object(
  {
    synthesis_complete: Type.Boolean(),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const ValidationSummarySchema = Type.Object(
  {
    verdict: Type.String({ pattern: "^(PASS|FAIL)$" }),
    unsupported_claims: Type.Array(Type.String({ maxLength: 4_096 }), {
      maxItems: 128,
    }),
    evidence: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 256 }),
    evidence_needed: Type.Optional(
      Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 128 })
    ),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const ReportSummarySchema = Type.Object(
  { write_complete: Type.Boolean() },
  { additionalProperties: false }
);

const AGENT_BY_STATE = {
  planning: "piper",
  critiquing_plan: "carren",
  researching: "echo",
  synthesizing: "synthia",
  critiquing_report: "carren",
  validating: "vera",
  report_writing: "skribble",
} as const;

type ResearchState = keyof typeof AGENT_BY_STATE;

const SUMMARY_SCHEMA_BY_STATE: Record<ResearchState, TSchema> = {
  planning: PlanningSummarySchema,
  critiquing_plan: CritiqueSummarySchema,
  researching: ExploreSummarySchema,
  synthesizing: SynthesisSummarySchema,
  critiquing_report: CritiqueSummarySchema,
  validating: ValidationSummarySchema,
  report_writing: ReportSummarySchema,
};

const INPUT_PHASES_BY_STATE: Record<ResearchState, readonly string[]> = {
  planning: ["planning", "critiquing_plan"],
  critiquing_plan: ["planning"],
  researching: ["planning", "critiquing_plan", "synthesizing", "validating"],
  synthesizing: ["researching", "synthesizing", "critiquing_report", "validating"],
  critiquing_report: ["researching", "synthesizing"],
  validating: ["researching", "synthesizing", "critiquing_report"],
  report_writing: ["researching", "synthesizing", "critiquing_report", "validating"],
};

function isResearchState(value: string): value is ResearchState {
  return Object.hasOwn(AGENT_BY_STATE, value);
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanValue(value: JsonValue | undefined): boolean {
  return value === true;
}

function normalizedIssues(issues: readonly string[]): string[] {
  return [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))].sort();
}

function sameIssues(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(normalizedIssues(left)) === JSON.stringify(normalizedIssues(right));
}

function modeBudget(mode: string): {
  critiquePasses: number;
  maxResearchRounds: number;
} {
  if (mode === "deep") {
    return { critiquePasses: 2, maxResearchRounds: 3 };
  }
  return { critiquePasses: 0, maxResearchRounds: 2 };
}

function boundedConstraint(
  context: RunContext,
  name: string,
  fallback: number,
  ceiling: number
): number {
  return Math.min(positiveIntegerConstraint(context.constraints[name], fallback), ceiling);
}

function reportDirectory(context: RunContext): string {
  const normalized = context.goal
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 71);
  const digest = sha256(context.goal.trim()).slice(0, 8);
  return path.join(
    context.projectRoot,
    "research",
    normalized.length > 0 ? `${normalized}-${digest}` : digest
  );
}

function taskForState(context: RunContext, state: ResearchState): string {
  const research = context.research;
  const clarification = context.clarificationText
    ? `\n\nUser clarification: ${context.clarificationText}`
    : "";
  const handoff =
    "\n\nRead every task-provided input_artifact through the artifact reader before working. " +
    "Treat those exact bytes as the sole prior-stage handoff. Return the complete stage output; " +
    "the execution owner captures it. Summary fields are routing data only.";
  let task: string;
  switch (state) {
    case "planning": {
      const modeLine = research.mode
        ? `Mode: ${research.mode}.`
        : "Mode is not fixed by the caller; declare quick, standard, or deep in the result.";
      task =
        `Research planning: decompose '${context.goal}' into focused sub-queries.\n${modeLine} ` +
        `Produce at most ${research.max_sub_queries} non-blank sub-queries.`;
      if (research.plan_revision > 0) {
        task += `\nRevision ${research.plan_revision}; address: ${research.plan_critique_issues.join("; ")}`;
      }
      break;
    }
    case "critiquing_plan":
      task = `Critique the exact research plan for '${context.goal}'. APPROVE or NEEDS_REVISION with evidence.`;
      break;
    case "researching":
      task = `Research '${context.goal}' thoroughly and return tiered, cited findings.`;
      break;
    case "synthesizing":
      task = `Synthesize the exact research artifacts for '${context.goal}' into a complete cited report.`;
      if (research.report_revision > 0) {
        task += ` Address critique issues: ${research.report_critique_issues.join("; ")}.`;
      }
      if (research.validation_revision > 0) {
        task += ` Re-ground or remove unsupported claims: ${research.validation_issues.join("; ")}.`;
      }
      break;
    case "critiquing_report":
      task = `Critique the exact synthesized report for '${context.goal}' for overclaiming, bias, fairness, and uncertainty.`;
      break;
    case "validating":
      task =
        `Verify every material claim in the exact synthesis for '${context.goal}' is supported by a captured cited source. ` +
        "PASS only when all material claims are grounded; otherwise FAIL and identify unsupported claims and researchable evidence gaps.";
      break;
    case "report_writing":
      task =
        `Write the final research products for '${context.goal}' to ${reportDirectory(context)}. ` +
        "Produce report.md, sources.md, and README.md, and include the complete contents of all three in your response.";
      break;
  }
  return `${task}${handoff}${clarification}`;
}

function inputArtifacts(context: RunContext, state: ResearchState): ArtifactRef[] {
  const phases = new Set(INPUT_PHASES_BY_STATE[state]);
  return context.selectedArtifacts
    .filter((artifact) => phases.has(artifact.phase))
    .sort((left, right) =>
      `${left.phase}/${left.artifact_id}`.localeCompare(`${right.phase}/${right.artifact_id}`)
    )
    .slice(0, 128);
}

function directive<T>(value: T): Directive {
  return validateContract(DirectiveSchema, value, "research directive");
}

function unresolvedIssues(context: RunContext): string[] {
  const research = context.research;
  return [
    ...(research.plan_critique_exhausted ? research.plan_critique_issues : []),
    ...(research.report_critique_exhausted ? research.report_critique_issues : []),
    ...(research.validation_exhausted ? research.validation_issues : []),
  ];
}

export function researchSummarySchema(state: string): TSchema {
  if (!isResearchState(state)) {
    throw new Error(`unknown research state '${state}'`);
  }
  return SUMMARY_SCHEMA_BY_STATE[state];
}

export class ResearchPlaybook {
  modelForState(
    context: RunContext,
    state: string,
    env: NodeJS.ProcessEnv = process.env
  ): string | undefined {
    if (state === "validating") {
      const explicit = String(context.constraints.validate_model ?? "").trim();
      if (explicit.length > 0) {
        return explicit;
      }
      const verifier = env.PENNY_RESEARCH_VERA_MODEL?.trim();
      if (verifier) {
        return verifier;
      }
    }
    const stateKey = `PENNY_RESEARCH_${state.toUpperCase()}_MODEL`;
    const stateModel = env[stateKey]?.trim();
    return stateModel || env.PENNY_RESEARCH_DEFAULT_MODEL?.trim() || undefined;
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== "research") {
      throw new Error(`ResearchPlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    const callerMode = String(context.constraints.mode ?? "");
    context.research.mode = MODES.has(callerMode) ? callerMode : "";
    context.research.max_sub_queries = Math.min(
      boundedConstraint(context, "max_sub_queries", 4, MAX_BRANCHES),
      boundedConstraint(context, "max_fan_width", 8, MAX_BRANCHES)
    );
    context.research.report_format = String(context.constraints.report_format ?? "default");
    this.applyBudget(context, context.research.mode || DEFAULT_MODE);
    context.transition(context.research.mode === "quick" ? "researching" : "planning");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!isResearchState(context.stateId)) {
      throw new Error(`cannot dispatch research state '${context.stateId}'`);
    }
    const state = context.stateId;
    const attempt = context.stepCount;
    const artifacts = inputArtifacts(context, state);
    const modelOverride = this.modelForState(context, state);
    const branchTasks = state === "researching" ? this.researchBranchTasks(context) : [];
    let next: Directive;
    if (branchTasks.length > 0) {
      const branches = branchTasks.map((branch) => ({
        branch_id: branch.branchId,
        state_id: state,
        agent: "echo",
        attempt,
        trust_profile: context.trustProfile,
        ...(modelOverride ? { model_override: modelOverride } : {}),
        task: branch.task,
        input_artifacts: artifacts,
      }));
      next = directive({
        schema_version: 2,
        action: "invoke_agents_parallel",
        identity: context.identity,
        state_id: state,
        branches,
      });
      context.pendingBranches = branches.map(
        (branch): PendingBranch => ({
          branch_id: branch.branch_id,
          agent: branch.agent,
          attempt: branch.attempt,
          completed: false,
          confidence: null,
          result: null,
          artifact: null,
        })
      );
    } else {
      next = directive({
        schema_version: 2,
        action: "invoke_agent",
        identity: context.identity,
        state_id: state,
        agent: AGENT_BY_STATE[state],
        attempt,
        trust_profile: context.trustProfile,
        ...(modelOverride ? { model_override: modelOverride } : {}),
        task: taskForState(context, state),
        input_artifacts: artifacts,
      });
      context.pendingBranches = [];
    }
    context.pendingDirective = next;
    context.status = "running";
    return next;
  }

  validateDetails(state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    if (!isResearchState(state)) {
      throw new Error(`unexpected result for state '${state}'`);
    }
    return validateContract(SUMMARY_SCHEMA_BY_STATE[state], details, `${state} summary`) as Record<
      string,
      JsonValue
    >;
  }

  aggregateResearchBranches(
    branchDetails: readonly Record<string, JsonValue>[]
  ): Record<string, JsonValue> {
    const questions = branchDetails.flatMap((details) => stringArray(details.clarifying_questions));
    return {
      explore_complete: branchDetails.every((details) => booleanValue(details.explore_complete)),
      ...(branchDetails.some((details) => booleanValue(details.needs_clarification))
        ? { needs_clarification: true }
        : {}),
      ...(questions.length > 0 ? { clarifying_questions: questions } : {}),
    };
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    confidence: Confidence
  ): Directive {
    if (!isResearchState(context.stateId)) {
      throw new Error(`unexpected result for state '${context.stateId}'`);
    }
    const state = context.stateId;
    const summary = this.validateDetails(state, details);
    const clarificationReason = this.progressProblem(context, state, summary, confidence);
    if (clarificationReason !== null) {
      return this.awaitUser(context, clarificationReason, summary);
    }
    this.route(context, state, summary);
    if (context.terminalDirective !== null) {
      return context.terminalDirective;
    }
    return this.dispatch(context);
  }

  resume(context: RunContext, response: JsonValue): Directive {
    if (context.status !== "awaiting_user" || context.stateId !== "awaiting_clarification") {
      throw new Error("run is not awaiting user clarification");
    }
    const previous = context.previousState ?? "planning";
    const target =
      previous === "researching"
        ? "researching"
        : ["synthesizing", "critiquing_report", "validating"].includes(previous)
          ? "synthesizing"
          : "planning";
    context.iteration = 0;
    context.iterationHistory = [];
    context.research.plan_revision = 0;
    context.research.report_revision = 0;
    context.research.validation_revision = 0;
    context.clarificationText = typeof response === "string" ? response : JSON.stringify(response);
    context.transition(target);
    return this.dispatch(context);
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  private applyBudget(context: RunContext, mode: string): void {
    const preset = modeBudget(mode);
    context.research.critique_passes = positiveIntegerOrZeroConstraint(
      context.constraints.critique_passes,
      preset.critiquePasses
    );
    context.research.max_research_rounds = Math.max(
      1,
      positiveIntegerOrZeroConstraint(
        context.constraints.max_research_rounds,
        preset.maxResearchRounds
      )
    );
  }

  private researchBranchTasks(context: RunContext): Array<{ branchId: string; task: string }> {
    const evidence = context.research.evidence_needed;
    const queries = evidence.length > 0 ? evidence : context.research.sub_queries;
    if (queries.length === 0) {
      return [];
    }
    const isEvidence = evidence.length > 0;
    const start = isEvidence ? context.research.echo_branches_dispatched + 1 : 1;
    const branches = queries.slice(0, context.research.max_sub_queries).map((query, index) => {
      const branchNumber = start + index;
      const prefix = isEvidence
        ? `EVIDENCE-SEEKING research for '${context.goal}'. Find a source that directly supports or refutes this gap, or report honestly that none was found. Gap:`
        : `Research this sub-query for '${context.goal}'. Sub-query:`;
      return {
        branchId: `sq${branchNumber}`,
        task: `${prefix} ${query}`,
      };
    });
    context.research.echo_branches_dispatched = Math.max(
      context.research.echo_branches_dispatched,
      start - 1 + branches.length
    );
    return branches;
  }

  private progressProblem(
    context: RunContext,
    state: ResearchState,
    summary: Record<string, JsonValue>,
    confidence: Confidence
  ): string | null {
    if (confidence === "UNCERTAIN") {
      return `${state} returned UNCERTAIN confidence`;
    }
    if (booleanValue(summary.needs_clarification)) {
      const questions = stringArray(summary.clarifying_questions);
      return `${state} requested clarification${questions.length ? `: ${questions.join("; ")}` : ""}`;
    }
    if (state === "planning" && !booleanValue(summary.plan_complete)) {
      return "planning could not produce a complete research plan";
    }
    if (state === "researching" && !booleanValue(summary.explore_complete)) {
      return "researching could not complete the assigned scope";
    }
    if (state === "synthesizing" && !booleanValue(summary.synthesis_complete)) {
      return "synthesis could not produce a complete report";
    }
    if (state === "critiquing_plan" || state === "critiquing_report") {
      const issues = stringArray(summary.issues);
      const previous = context.iterationHistory.at(-1) ?? null;
      if (summary.verdict !== "APPROVE" && previous !== null && sameIssues(previous, issues)) {
        return "the same critique issues persisted without measurable progress";
      }
    }
    if (state === "validating") {
      const issues = stringArray(summary.unsupported_claims);
      const previous = context.iterationHistory.at(-1) ?? null;
      if (summary.verdict !== "PASS" && previous !== null && sameIssues(previous, issues)) {
        return "the same validation issues persisted without measurable progress";
      }
    }
    return null;
  }

  private recordIteration(context: RunContext, issues: string[]): void {
    context.iterationHistory.push(normalizedIssues(issues));
  }

  private endLoop(context: RunContext, kind: "plan" | "report" | "validation"): void {
    if (kind === "plan") {
      context.research.plan_revisions = context.iteration;
      context.research.plan_revision = 0;
    } else if (kind === "report") {
      context.research.report_revisions = context.iteration;
      context.research.report_revision = 0;
      context.research.phase = "validation";
    } else {
      context.research.validation_revisions = context.iteration;
      context.research.validation_revision = 0;
    }
    context.iteration = 0;
    context.iterationHistory = [];
  }

  private route(
    context: RunContext,
    state: ResearchState,
    summary: Record<string, JsonValue>
  ): void {
    const research = context.research;
    switch (state) {
      case "planning": {
        if (!research.mode) {
          const declared = String(summary.mode ?? "");
          research.mode = MODES.has(declared) ? declared : DEFAULT_MODE;
          this.applyBudget(context, research.mode);
        }
        const steps = stringArray(summary.plan_steps).slice(0, research.max_sub_queries);
        research.sub_queries = steps;
        context.transition(research.critique_passes >= 2 ? "critiquing_plan" : "researching");
        return;
      }
      case "critiquing_plan": {
        const issues = stringArray(summary.issues);
        research.plan_critique_issues = issues;
        if (summary.verdict === "APPROVE") {
          this.endLoop(context, "plan");
          context.transition("researching");
        } else if (context.iteration + 1 < context.maxIterations) {
          this.recordIteration(context, issues);
          context.iteration += 1;
          research.plan_revision = context.iteration;
          context.transition("planning");
        } else {
          research.plan_critique_exhausted = true;
          research.warnings.push(
            `plan critique budget exhausted with unresolved issues: ${issues.join("; ") || "none listed"}`
          );
          this.endLoop(context, "plan");
          context.transition("researching");
        }
        return;
      }
      case "researching":
        research.evidence_needed = [];
        context.transition("synthesizing");
        return;
      case "synthesizing":
        context.transition(
          research.critique_passes >= 1 && research.phase !== "validation"
            ? "critiquing_report"
            : "validating"
        );
        return;
      case "critiquing_report": {
        const issues = stringArray(summary.issues);
        research.report_critique_issues = issues;
        if (summary.verdict === "APPROVE") {
          this.endLoop(context, "report");
          context.transition("validating");
        } else if (context.iteration + 1 < context.maxIterations) {
          this.recordIteration(context, issues);
          context.iteration += 1;
          research.report_revision = context.iteration;
          context.transition("synthesizing");
        } else {
          research.report_critique_exhausted = true;
          research.warnings.push(
            `report critique budget exhausted with unresolved issues: ${issues.join("; ") || "none listed"}`
          );
          this.endLoop(context, "report");
          context.transition("validating");
        }
        return;
      }
      case "validating": {
        const issues = stringArray(summary.unsupported_claims);
        const needed = stringArray(summary.evidence_needed);
        research.validation_verdict = String(summary.verdict);
        research.validation_issues = issues;
        if (summary.verdict === "PASS") {
          this.endLoop(context, "validation");
          context.transition("report_writing");
        } else if (context.iteration + 1 < context.maxIterations) {
          this.recordIteration(context, issues);
          context.iteration += 1;
          if (needed.length > 0 && research.research_round < research.max_research_rounds) {
            research.research_round += 1;
            research.evidence_needed = needed.slice(0, research.max_sub_queries);
            research.validation_revision = 0;
            context.transition("researching");
          } else {
            research.validation_revision = context.iteration;
            context.transition("synthesizing");
          }
        } else {
          research.validation_exhausted = true;
          research.warnings.push(
            `validation budget exhausted with unverified claims: ${issues.join("; ") || "none listed"}`
          );
          this.endLoop(context, "validation");
          context.transition("report_writing");
        }
        return;
      }
      case "report_writing": {
        research.report_written = booleanValue(summary.write_complete);
        research.report_dir = reportDirectory(context);
        research.report_files = research.report_written
          ? ["report.md", "sources.md", "README.md"].map((file) =>
              path.join(research.report_dir, file)
            )
          : [];
        const finalArtifact = [...context.selectedArtifacts]
          .reverse()
          .find((artifact) => artifact.phase === "report_writing");
        const met =
          research.validation_verdict === "PASS" &&
          research.report_written &&
          finalArtifact !== undefined;
        this.terminal(context, met ? "complete" : "incomplete", met, unresolvedIssues(context));
      }
    }
  }

  private awaitUser(
    context: RunContext,
    reason: string,
    summary: Record<string, JsonValue>
  ): Directive {
    const questions = stringArray(summary.clarifying_questions);
    const prompts =
      questions.length > 0 ? questions : [`${reason}. What clarification should the run use?`];
    const state = context.stateId;
    context.transition("awaiting_clarification");
    context.status = "awaiting_user";
    const gateId = randomUUID();
    const challenge = randomUUID();
    const payloadDigest = sha256(JSON.stringify({ reason, prompts, state }));
    const next = directive({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_clarification",
      gate_id: gateId,
      challenge,
      payload_digest: payloadDigest,
      questions: prompts.map((prompt, index) => ({
        id: `clarification-${index + 1}`,
        prompt,
      })),
    });
    context.pendingDirective = next;
    return next;
  }

  private terminal(
    context: RunContext,
    status: "complete" | "incomplete" | "cancelled",
    met: boolean,
    unresolved: string[]
  ): Directive {
    context.previousState = context.stateId;
    context.stateId = status === "cancelled" ? "cancelled" : "complete";
    context.status = status;
    context.met = met;
    context.pendingBranches = [];
    const research = context.research;
    const finalArtifact = [...context.selectedArtifacts]
      .reverse()
      .find((artifact) => artifact.phase === "report_writing");
    const next = directive({
      schema_version: 2,
      action: status,
      identity: context.identity,
      status,
      met,
      result: {
        met,
        research_rounds: research.research_round,
        critique_passes: research.critique_passes,
        rigor_escalated: research.rigor_escalated,
        grounded: research.validation_verdict === "PASS",
        iterations:
          research.plan_revisions + research.report_revisions + research.validation_revisions,
        query_sha256: sha256(context.goal),
        query_bytes: Buffer.byteLength(context.goal, "utf8"),
        mode: research.mode,
        sub_queries: research.sub_queries,
        output_artifact_ref: finalArtifact ?? null,
        report_dir: research.report_dir,
        report_files: research.report_files,
        warnings: research.warnings,
        plan_critique_exhausted: research.plan_critique_exhausted,
        report_critique_exhausted: research.report_critique_exhausted,
        validation_exhausted: research.validation_exhausted,
        unresolved_issues: unresolved,
      },
      artifacts: finalArtifact ? [finalArtifact] : [],
      unresolved,
    });
    if ((next.action === "complete") !== met) {
      throw new Error("terminal truth invariant violated");
    }
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }
}

function positiveIntegerOrZeroConstraint(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
