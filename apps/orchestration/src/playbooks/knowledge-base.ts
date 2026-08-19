/**
 * The knowledge-base playbook — a real state machine on the engine's seams.
 *
 * This file was previously a stub whose own docstring admitted the workflow lived
 * elsewhere: the `knowledge_base` tool called `kb/workflows.ts` directly, so the KB
 * never entered `engine.start/step/recover` and gained none of the engine's durable
 * run state, recovery, artifact protocol, or contract enforcement. The
 * universal-skills Foundation stage extracted those seams specifically so the KB
 * could be the second playbook; bypassing them made W13 fail as written.
 *
 * ## The ingest machine
 *
 * ```
 * intake → ingest → compose → lint → verify → awaiting_review → publishing → complete
 *                     ↑                          │        │
 *                     └──── revise (bounded) ────┘        └── denied → incomplete
 * ```
 *
 * - Agent phases (`ingest`, `compose`, `lint`, `verify`) emit `invoke_agent`; each
 *   runs in a §5.8 private-reader session supplied by the dispatcher.
 * - `awaiting_review` emits `await_user`: the human content-review gate. Publication
 *   is never reachable without passing through it.
 * - Repair is routed by *cause* through `classifyGap` (W5) rather than by bespoke
 *   branching, and is bounded — an exhausted budget proceeds honestly with the
 *   unresolved findings named, never as a silent pass.
 *
 * ## What this playbook does and does not hold
 *
 * Durable state lives in `context.playbookData`, so `status`/`resume` inherit the
 * engine's checkpointer instead of a private KB run store. It holds **metadata only**
 * — counts, ids, verdicts. Phase bodies stay in the KB content plane and reach agents
 * only through the private readers, so no private body ever enters orchestration
 * control state.
 */

import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  validateDirective,
  type Confidence,
  type Directive,
  type EvaluationResult,
  type JsonValue,
  type SkillContract,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import type { ArtifactRevisionLookup } from "../artifact-store.js";
import type { GapClassificationCapabilityV1, PlaybookCoreV1 } from "./playbook.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import { defaultKbIngestPlane, resolveKbRoot, type KbIngestPlaneV1 } from "../kb/ingest-plane.js";

/** The agent phases of an ingest run, in order. */
export const KB_AGENT_PHASES = ["ingest", "compose", "lint", "verify"] as const;
export type KbAgentPhase = (typeof KB_AGENT_PHASES)[number];

/** Every non-terminal state of the KB machine. */
export const KB_STATES = [...KB_AGENT_PHASES, "awaiting_review", "publishing"] as const;
export type KbState = (typeof KB_STATES)[number];

const AGENT_BY_PHASE: Record<KbAgentPhase, string> = {
  ingest: "echo",
  compose: "synthia",
  lint: "carren",
  verify: "vera",
};

/** Successor state for each phase on the happy path. */
const NEXT_STATE: Record<KbState, KbState | "complete"> = {
  ingest: "compose",
  compose: "lint",
  lint: "verify",
  verify: "awaiting_review",
  awaiting_review: "publishing",
  publishing: "complete",
};

/** Phases whose sealed output a later phase may read (drives consumer scope). */
const PRIOR_PHASES: Record<KbAgentPhase, readonly KbAgentPhase[]> = {
  ingest: [],
  compose: ["ingest"],
  lint: ["compose"],
  verify: ["compose"],
};

export function isKbState(value: string): value is KbState {
  return (KB_STATES as readonly string[]).includes(value);
}

function isAgentPhase(value: string): value is KbAgentPhase {
  return (KB_AGENT_PHASES as readonly string[]).includes(value);
}

/**
 * The KB skill contract.
 *
 * `completion_gate` is live rather than decorative: a `met: true` terminal must be
 * reached from `publishing`, so no ingest run can report success without an approved
 * publication behind it.
 */
export const KNOWLEDGE_BASE_SKILL_CONTRACT: SkillContract = {
  schema_version: 1,
  name: "knowledge-base",
  objective:
    "Manage a private advisory knowledge base: initialize, ingest sources, query, save, lint, and prepare promotions.",
  accepts: ["agent-output"],
  produces: ["agent-output"],
  invariants: [
    "No raw source, page, claim, report, or patch body is returned to the parent.",
    "Query and lint do not publish; only ingest and save publish after content review.",
    "Promotion only prepares; approved apply is a separate host-only path.",
  ],
  authority: {
    trust_profiles: ["trusted-interactive", "hardened-untrusted"],
  },
  guidance: {
    skill_root: ".pi/skills/knowledge-base/assets/prompts",
    resolution: "per_agent_phase",
  },
  feedback_kinds: ["evidence_gap", "synthesis_gap", "validation_gap", "malformed_result"],
  budgets: {},
  completion_gate: {
    schema_version: 1,
    required_receipts: [],
    // Publication is the only route to a met ingest terminal.
    required_states: ["publishing"],
  },
};

// ── durable state (metadata only) ───────────────────────────────────────────

interface KbPhaseRecord {
  readonly artifact_kind: string;
  /** Handle into the KB content plane. An id, never a body. */
  readonly kb_artifact_id: string;
  readonly counts: Record<string, number>;
  readonly verdict?: string;
}

function phaseRecords(context: RunContext): Record<string, KbPhaseRecord> {
  const raw = context.playbookData.phases;
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as unknown as Record<string, KbPhaseRecord>;
}

function recordPhase(context: RunContext, phase: string, record: KbPhaseRecord): void {
  context.playbookData.phases = {
    ...phaseRecords(context),
    [phase]: record as unknown as JsonValue,
  } as unknown as JsonValue;
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function counter(details: Record<string, JsonValue>, key: string): number {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function directive<T>(value: T): Directive {
  return validateDirective(value);
}

// ── result contracts, per phase ─────────────────────────────────────────────

/**
 * What each phase must return as routing metadata.
 *
 * Deliberately small and body-free: the phase's actual output is the captured
 * artifact, and control state must never carry private content.
 */
function validatePhaseDetails(
  phase: KbAgentPhase,
  details: Record<string, JsonValue>
): Record<string, JsonValue> {
  const kind = details.artifact_kind;
  const expected: Record<KbAgentPhase, string> = {
    ingest: "claims",
    compose: "page_draft",
    lint: "lint_report",
    verify: "verification_report",
  };
  if (kind !== expected[phase]) {
    throw new Error(
      `KB phase '${phase}' must return artifact_kind '${expected[phase]}', received '${String(kind)}'`
    );
  }
  if (typeof details.complete !== "boolean") {
    throw new Error(`KB phase '${phase}' must report a boolean 'complete'`);
  }
  if (typeof details.kb_artifact_id !== "string" || details.kb_artifact_id.length === 0) {
    // The body lives in the KB content plane; control state carries only its
    // handle. Without one there is nothing to seal, so the phase has not really
    // produced its artifact.
    throw new Error(`KB phase '${phase}' must return the kb_artifact_id it staged`);
  }
  if (phase === "ingest" && stringList(details.source_ids).length === 0) {
    throw new Error("KB phase 'ingest' must name the source_ids it read");
  }
  if (phase === "compose") {
    for (const field of ["page_id", "revision_id"] as const) {
      if (typeof details[field] !== "string" || (details[field] as string).length === 0) {
        throw new Error(`KB phase 'compose' must return a non-empty '${field}'`);
      }
    }
  }
  return details;
}

export class KnowledgeBasePlaybook implements PlaybookCoreV1, GapClassificationCapabilityV1 {
  private readonly plane: KbIngestPlaneV1;

  constructor(
    private readonly revisions?: ArtifactRevisionLookup,
    plane?: KbIngestPlaneV1
  ) {
    // The real plane by default: an optional-I/O playbook could silently run
    // without persisting anything, which is precisely the failure mode that lets a
    // "successful" ingest publish nothing.
    this.plane = plane ?? defaultKbIngestPlane();
  }

  /** Host-resolved, never caller-supplied. */
  private kbRoot(context: RunContext): string {
    return resolveKbRoot(context.projectRoot, String(context.playbookData.profile_id ?? ""));
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== "knowledge-base") {
      throw new Error(`KnowledgeBasePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    const action = String(context.constraints.action ?? "ingest");
    if (action !== "ingest") {
      // save/promote reuse this machine and land in later slices. Refusing is the
      // honest answer until they do; silently running the ingest machine for a
      // different action would publish under the wrong contract.
      throw new Error(`KB playbook action '${action}' is not implemented yet`);
    }
    const sourceIds = stringList(context.constraints.source_ids as JsonValue);
    if (sourceIds.length === 0) {
      throw new Error("KB ingest requires at least one admitted source capability");
    }
    context.playbookData.action = action;
    context.playbookData.source_ids = sourceIds as unknown as JsonValue;
    context.playbookData.profile_id = String(context.constraints.kb_profile_id ?? "");
    // All-or-none, before any agent reads a source.
    this.plane.claim({
      kbRoot: this.kbRoot(context),
      capabilityIds: sourceIds,
      runId: context.identity.run_id,
    });
    context.transition("ingest");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const state = context.stateId;
    if (!isKbState(state)) {
      throw new Error(`cannot dispatch KB state '${state}'`);
    }
    if (state === "awaiting_review") {
      return this.awaitReview(context);
    }
    if (state === "publishing") {
      // Reached only via `resume(approve)`, which publishes and terminates there.
      // Arriving here by any other route means the machine entered publishing
      // without an approval, which must not silently succeed.
      throw new Error("KB publishing state is only reachable through an approved review gate");
    }
    return this.invokePhase(context, state);
  }

  private invokePhase(context: RunContext, phase: KbAgentPhase): Directive {
    const agent = AGENT_BY_PHASE[phase];
    const upstream = context.selectedArtifacts.filter((ref) =>
      PRIOR_PHASES[phase].includes(ref.phase as KbAgentPhase)
    );
    const next = directive({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: phase,
      agent,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: this.phaseTask(context, phase),
      input_artifacts: {
        schema_version: 1,
        run_id: context.identity.run_id,
        consumer: `state:${phase}`,
        artifacts: upstream.map((ref, index) => ({
          slot: `upstream-${String(index).padStart(4, "0")}`,
          ref,
        })),
      },
      output_artifact: buildOutputArtifactMetadata({
        context,
        phase,
        agent,
        branchId: null,
        consumerScope: this.consumerScope(phase),
        upstreamRefs: upstream,
        ...(this.revisions ? { revisions: this.revisions } : {}),
      }),
    });
    context.pendingDirective = next;
    return next;
  }

  /**
   * The task line only *names* the work. The phase's instructions come from the
   * skill's per-agent-per-phase guidance, and its inputs arrive through the private
   * readers — never through this string, which is control-plane data.
   */
  private phaseTask(context: RunContext, phase: KbAgentPhase): string {
    const sources = stringList(context.playbookData.source_ids);
    const revision = context.iteration > 0 ? ` (revision ${context.iteration})` : "";
    return `Execute the knowledge-base '${phase}' phase${revision} over ${sources.length} admitted source(s). Follow the phase guidance and submit the typed result.`;
  }

  private consumerScope(phase: KbAgentPhase): string[] {
    const consumers = new Set<string>([`state:${phase}`]);
    for (const [candidate, priors] of Object.entries(PRIOR_PHASES)) {
      if ((priors as readonly string[]).includes(phase)) {
        consumers.add(`state:${candidate}`);
      }
    }
    consumers.add("state:awaiting_review");
    return [...consumers].sort();
  }

  validateDetails(state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    if (!isAgentPhase(state)) {
      throw new Error(`KB state '${state}' does not accept an agent result`);
    }
    return validatePhaseDetails(state, details);
  }

  /**
   * W5 — classify why a phase result is inadequate, so the engine routes repair by
   * cause. The same call decides the transition below, which keeps the typed seam and
   * the behaviour one source of truth rather than two that can disagree.
   */
  classifyGap(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null {
    const exhausted = context.iteration >= context.maxIterations;
    if (state === "lint" && counter(details, "error_count") > 0) {
      return {
        schema_version: 1,
        kind: "synthesis_gap",
        detail: `semantic lint reported ${counter(details, "error_count")} error-severity finding(s)`,
        target_state: "compose",
        exhausted,
      };
    }
    if (state === "verify" && counter(details, "unsupported") > 0) {
      return {
        schema_version: 1,
        kind: "validation_gap",
        detail: `${counter(details, "unsupported")} claim(s) are not supported by their cited evidence`,
        target_state: "compose",
        exhausted,
      };
    }
    if (details.complete === false) {
      return {
        schema_version: 1,
        kind: "malformed_result",
        detail: `KB phase '${state}' reported incomplete work`,
        target_state: state,
        exhausted,
      };
    }
    return null;
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    const state = context.stateId;
    if (!isAgentPhase(state)) {
      throw new Error(`KB state '${state}' does not accept an agent result`);
    }
    recordPhase(context, state, {
      artifact_kind: String(details.artifact_kind),
      kb_artifact_id: String(details.kb_artifact_id),
      counts: this.countsFor(state, details),
      ...(typeof details.verdict === "string" ? { verdict: details.verdict } : {}),
    });

    const gap = this.classifyGap(context, state, details);
    if (gap !== null && !gap.exhausted && gap.target_state !== undefined) {
      const warnings = stringList(context.playbookData.warnings);
      context.playbookData.warnings = [...warnings, gap.detail] as unknown as JsonValue;
      context.iteration += 1;
      context.transition(gap.target_state);
      return this.dispatch(context);
    }
    if (gap !== null && gap.exhausted) {
      // Budget spent. Carry the finding forward as unresolved rather than looping
      // again or pretending the phase passed.
      const unresolved = stringList(context.playbookData.unresolved);
      context.playbookData.unresolved = [...unresolved, gap.detail] as unknown as JsonValue;
    }

    const next = NEXT_STATE[state];
    if (next === "complete") {
      return this.terminal(context, "complete", true, stringList(context.playbookData.unresolved));
    }
    context.transition(next);
    return this.dispatch(context);
  }

  private countsFor(
    state: KbAgentPhase,
    details: Record<string, JsonValue>
  ): Record<string, number> {
    const keys: Record<KbAgentPhase, readonly string[]> = {
      ingest: ["claim_count"],
      compose: ["claim_count"],
      lint: ["finding_count", "error_count", "candidate_conflict_count"],
      verify: ["supported", "partially_supported", "unsupported"],
    };
    const counts: Record<string, number> = {};
    for (const key of keys[state]) {
      counts[key] = counter(details, key);
    }
    return counts;
  }

  /**
   * The human content-review gate. Its payload digest binds the exact candidate set
   * being offered, so an approval cannot silently apply to a different one.
   */
  private awaitReview(context: RunContext): Directive {
    const phases = phaseRecords(context);
    // Seal the exact candidate set and persist the gate BEFORE presenting it. A gate
    // offered before its candidates are frozen could be approved against a set that
    // changed afterwards.
    if (context.playbookData.gate_id === undefined) {
      const kbRoot = this.kbRoot(context);
      const artifactIds = KB_AGENT_PHASES.map((phase) => phases[phase]?.kb_artifact_id).filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
      this.plane.seal({ kbRoot, runId: context.identity.run_id, artifactIds });
      const capabilityIds = stringList(context.playbookData.source_ids);
      const gate = this.plane.persistGate({
        kbRoot,
        profileId: String(context.playbookData.profile_id ?? ""),
        runId: context.identity.run_id,
        artifactIds,
        sourceIds: capabilityIds,
        capabilityIds,
      });
      context.playbookData.gate_id = gate.gate_id;
      context.playbookData.base_generation_id = gate.base_generation_id ?? "";
    }
    const summary = {
      sources: stringList(context.playbookData.source_ids).length,
      phases,
      gate_id: String(context.playbookData.gate_id ?? ""),
      unresolved: stringList(context.playbookData.unresolved),
    };
    const gateId = randomUUID();
    const challenge = randomUUID();
    context.status = "awaiting_user";
    const next = directive({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_review",
      gate_id: gateId,
      challenge,
      payload_digest: sha256(canonicalJson(summary as unknown as JsonValue)),
      questions: [
        {
          id: "content-review-1",
          prompt:
            "Approve publication of the reviewed candidate page(s) into the knowledge base? Answer 'approve', 'deny', or 'refine'.",
        },
      ],
    });
    context.pendingDirective = next;
    return next;
  }

  resume(context: RunContext, response: JsonValue): Directive {
    if (context.stateId !== "awaiting_review") {
      throw new Error(`KB run is not at a review gate (state '${context.stateId}')`);
    }
    const decision = this.readDecision(response);
    context.playbookData.review_decision = decision;
    if (decision === "approve") {
      context.transition("publishing");
      // Publication is the deterministic host step this state exists for. The gate
      // is CAS-guarded and the selector swap is atomic underneath, so a crash
      // between publishing and checkpointing cannot double-publish.
      const published = this.plane.approve({
        kbRoot: this.kbRoot(context),
        runId: context.identity.run_id,
      });
      context.playbookData.published_generation_id = published.generationId;
      context.playbookData.published_counts = published.counts as unknown as JsonValue;
      return this.terminal(context, "complete", true, stringList(context.playbookData.unresolved));
    }
    if (decision === "refine") {
      const unresolvedRefine = stringList(context.playbookData.unresolved);
      context.playbookData.unresolved = [
        ...unresolvedRefine,
        "reviewer requested refinement",
      ] as unknown as JsonValue;
      context.iteration += 1;
      context.transition("compose");
      return this.dispatch(context);
    }
    // Denial publishes nothing and is an honest negative terminal, not an error.
    this.plane.deny({ kbRoot: this.kbRoot(context), runId: context.identity.run_id });
    const unresolved = [
      ...stringList(context.playbookData.unresolved),
      "reviewer denied publication",
    ];
    context.status = "running";
    return this.terminal(context, "incomplete", false, unresolved);
  }

  private readDecision(response: JsonValue): "approve" | "deny" | "refine" {
    const raw =
      typeof response === "string"
        ? response
        : response !== null && typeof response === "object" && !Array.isArray(response)
          ? String((response as Record<string, JsonValue>).decision ?? "")
          : "";
    const value = raw.trim().toLowerCase();
    if (value === "approve" || value === "deny" || value === "refine") {
      return value;
    }
    throw new Error(`KB review decision must be approve, deny, or refine; received '${raw}'`);
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending === null || pending.action !== "invoke_agent") {
      return pending;
    }
    if (!isAgentPhase(pending.state_id)) {
      return pending;
    }
    return directive({
      ...pending,
      output_artifact: buildOutputArtifactMetadata({
        context,
        phase: pending.state_id,
        agent: pending.agent,
        branchId: null,
        consumerScope: this.consumerScope(pending.state_id),
        upstreamRefs: pending.output_artifact.upstream_refs,
        ...(this.revisions ? { revisions: this.revisions } : {}),
      }),
    });
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
    const phases = phaseRecords(context);
    const next = directive({
      schema_version: 2,
      action: status,
      identity: context.identity,
      status,
      met,
      result: {
        met,
        action: String(context.playbookData.action ?? "ingest"),
        kb_profile_id: String(context.playbookData.profile_id ?? ""),
        source_count: stringList(context.playbookData.source_ids).length,
        phases: phases as unknown as JsonValue,
        gate_id: String(context.playbookData.gate_id ?? ""),
        published_generation_id: String(context.playbookData.published_generation_id ?? ""),
        published_counts: (context.playbookData.published_counts ?? {}) as JsonValue,
        review_decision: String(context.playbookData.review_decision ?? ""),
        warnings: stringList(context.playbookData.warnings),
        unresolved_issues: unresolved,
      },
      artifacts: [],
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
