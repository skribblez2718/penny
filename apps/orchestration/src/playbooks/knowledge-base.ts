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
import {
  defaultKbIngestPlane,
  resolveKbRoot,
  type KbIngestPlaneV1,
  type KbPublishOutcome,
} from "../kb/ingest-plane.js";

/** The agent phases of an ingest run, in order. */
export const KB_AGENT_PHASES = ["ingest", "compose", "lint", "verify", "plan", "patch"] as const;
export type KbAgentPhase = (typeof KB_AGENT_PHASES)[number];

/** Every non-terminal state of the KB machine. */
export const KB_STATES = [...KB_AGENT_PHASES, "awaiting_review", "publishing"] as const;
export type KbState = (typeof KB_STATES)[number];

const AGENT_BY_PHASE: Record<KbAgentPhase, string> = {
  ingest: "echo",
  compose: "synthia",
  lint: "carren",
  verify: "vera",
  // Promotion prepares only: Piper plans the transition, Skribble scopes the
  // patch. Neither can apply anything — they produce advisory artifacts.
  plan: "piper",
  patch: "skribble",
};

/** Successor state for each phase on the happy path. */
const NEXT_STATE: Record<KbState, KbState | "complete"> = {
  ingest: "compose",
  compose: "lint",
  lint: "verify",
  verify: "awaiting_review",
  plan: "patch",
  patch: "awaiting_review",
  awaiting_review: "publishing",
  publishing: "complete",
};

/** Phases whose sealed output a later phase may read (drives consumer scope). */
const PRIOR_PHASES: Record<KbAgentPhase, readonly KbAgentPhase[]> = {
  ingest: [],
  compose: ["ingest"],
  lint: ["compose"],
  verify: ["compose"],
  plan: [],
  patch: ["plan"],
};

// ── exported flow descriptor (§5.12) ─────────────────────────────────────────
//
// The machine's state/edge descriptor, exported so the skill's `resources/flow.html`
// and `flow-diagrams.test.ts` compare against the REAL machine rather than a copy
// of it. Forward edges are DERIVED from NEXT_STATE (the same table the machine
// transitions on); the gate decisions are the decisions `resume` accepts; the
// repair edges mirror `classifyGap` (the test re-checks them against
// `classifyGap`'s actual routing, so the table and the code cannot drift apart).

export type KbFlowStateKind = "agent" | "gate" | "host" | "terminal";
export interface KbFlowState {
  readonly id: string;
  readonly kind: KbFlowStateKind;
  readonly agent?: string;
  readonly guidance?: string;
}
export type KbFlowEdgeKind = "forward" | "gate" | "repair" | "terminal";
export type KbFeedbackKind = "synthesis_gap" | "validation_gap" | "malformed_result";
export interface KbFlowEdge {
  readonly from: string; // a state, or the virtual entry point "start"
  readonly to: string;
  readonly kind: KbFlowEdgeKind;
  readonly trigger: string;
  readonly bounded?: boolean;
  readonly feedback_kind?: KbFeedbackKind;
}
export interface KbFlowGate {
  readonly state: string;
  readonly decisions: readonly string[];
  readonly host_only: boolean;
}
export interface KbFlowTerminal {
  readonly id: string;
  readonly met: boolean;
  readonly route_from: string;
}
export interface KbFlowDescriptor {
  readonly schema_version: 1;
  readonly playbook: "knowledge-base";
  readonly states: KbFlowState[];
  readonly edges: KbFlowEdge[];
  readonly gates: KbFlowGate[];
  readonly terminals: KbFlowTerminal[];
}

export const KB_FLOW: KbFlowDescriptor = {
  schema_version: 1,
  playbook: "knowledge-base",
  states: [
    ...KB_AGENT_PHASES.map(
      (p): KbFlowState => ({
        id: p,
        kind: "agent",
        agent: AGENT_BY_PHASE[p],
        guidance: `${AGENT_BY_PHASE[p]}-${p}.md`,
      })
    ),
    { id: "awaiting_review", kind: "gate" },
    { id: "publishing", kind: "host" },
    { id: "complete", kind: "terminal" },
    { id: "incomplete", kind: "terminal" },
  ],
  edges: [
    { from: "start", to: "ingest", kind: "forward", trigger: "initialize (claim + admit sources)" },
    // A `save` enters at compose: it has no extraction phase, because it
    // composes from the sealed answer of the query run its claim names.
    {
      from: "start",
      to: "compose",
      kind: "forward",
      trigger: "initialize save (claim the query answer)",
    },
    // A `promote` prepares only: plan and patch, then the review gate. It has no
    // publishing edge, because the public tool can never apply a promotion.
    {
      from: "start",
      to: "plan",
      kind: "forward",
      trigger: "initialize promote (claim targets, prepare only)",
    },
    // Happy path, derived from the machine's own transition table.
    ...Object.entries(NEXT_STATE)
      .filter(([state]) => isAgentPhase(state))
      .map(([from, to]) => ({ from, to, kind: "forward" as const, trigger: "phase_complete" })),
    // Gate decisions — exactly what `resume` accepts.
    {
      from: "awaiting_review",
      to: "publishing",
      kind: "gate",
      trigger: "approve (host-authenticated)",
    },
    { from: "awaiting_review", to: "incomplete", kind: "terminal", trigger: "deny" },
    { from: "awaiting_review", to: "compose", kind: "repair", trigger: "refine", bounded: true },
    // publishing → complete is the machine's happy-path successor table entry,
    // realized by the host publication behind the approval.
    { from: "publishing", to: "complete", kind: "terminal", trigger: "publish (host I/O)" },
    // Repairs — the same routes `classifyGap` produces (bounded by the budget).
    {
      from: "lint",
      to: "compose",
      kind: "repair",
      trigger: "error-severity finding(s)",
      bounded: true,
      feedback_kind: "synthesis_gap",
    },
    {
      from: "verify",
      to: "compose",
      kind: "repair",
      trigger: "unsupported claim(s)",
      bounded: true,
      feedback_kind: "validation_gap",
    },
    ...KB_AGENT_PHASES.map((p) => ({
      from: p,
      to: p,
      kind: "repair" as const,
      trigger: "incomplete result (complete = false)",
      bounded: true,
      feedback_kind: "malformed_result" as const,
    })),
  ],
  gates: [
    {
      state: "awaiting_review",
      decisions: ["approve", "deny", "refine"],
      // Approval/denial/refinement reach the run only as a gate response from the
      // host (penny-kb-gate → engine respond); the model-facing tool cannot decide.
      host_only: true,
    },
  ],
  terminals: [
    // The completion gate pins these: a `met: true` terminal is reachable only
    // from publishing (KNOWLEDGE_BASE_SKILL_CONTRACT.completion_gate).
    { id: "complete", met: true, route_from: "publishing" },
    { id: "incomplete", met: false, route_from: "awaiting_review" },
  ],
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

/**
 * The active parent identity as the host supplied it (§5.3).
 *
 * Never model-supplied: the adapter reads it from the runtime and puts it in
 * constraints. A malformed or absent value yields `undefined`, which
 * {@link admitKbRun} treats as a denial rather than a pass.
 */
function readParentIdentity(
  value: JsonValue | undefined
): { provider: string; model: string } | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const model = typeof record.model === "string" ? record.model : "";
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined;
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
    plan: "promotion_plan",
    patch: "promotion_patch",
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
    plane?: KbIngestPlaneV1,
    private readonly rootResolver: (
      projectRoot: string,
      profileId: string,
      sessionId: string
    ) => string = resolveKbRoot
  ) {
    // The real plane by default: an optional-I/O playbook could silently run
    // without persisting anything, which is precisely the failure mode that lets a
    // "successful" ingest publish nothing.
    this.plane = plane ?? defaultKbIngestPlane();
  }

  /** Host-resolved, never caller-supplied. */
  private kbRoot(context: RunContext): string {
    return this.rootResolver(
      context.projectRoot,
      String(context.playbookData.profile_id ?? ""),
      context.identity.session_id
    );
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== "knowledge-base") {
      throw new Error(`KnowledgeBasePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    const action = String(context.constraints.action ?? "ingest");
    if (action !== "ingest" && action !== "save" && action !== "promote") {
      throw new Error(`KB playbook action '${action}' is not implemented yet`);
    }
    const sourceCapabilityIds = stringList(context.constraints.source_capability_ids as JsonValue);
    if (action === "ingest" && sourceCapabilityIds.length === 0) {
      throw new Error("KB ingest requires at least one admitted source capability");
    }
    context.playbookData.action = action;
    context.playbookData.source_ids = sourceCapabilityIds as unknown as JsonValue;
    context.playbookData.profile_id = String(context.constraints.kb_profile_id ?? "");
    const kbRoot = this.kbRoot(context);
    const runId = context.identity.run_id;

    // §5.3 deny-before-session. The profile and root are already resolved above;
    // this validates the policy and the ACTIVE parent identity, and binds the
    // digest the run is admitted under. It must precede claim/admit, because
    // admitting a source object reads private bytes — a denial after that point
    // would be a denial that already leaked.
    const parentIdentity = readParentIdentity(context.constraints.parent_identity as JsonValue);
    const admitted = this.plane.admitRun({ kbRoot, parentIdentity });
    context.playbookData.admitted_policy_sha256 = admitted.policy_sha256;

    if (action === "promote") {
      // §5.11 prepare only. The targets are claimed all-or-none before any child
      // runs, exactly as ingest claims sources — but nothing here can apply,
      // sign, or mutate a canonical target. That is a host-only path at G9.
      const targetIds = stringList(
        context.constraints.canonical_target_capability_ids as JsonValue
      );
      if (targetIds.length === 0) {
        throw new Error("KB promote requires at least one canonical target capability");
      }
      const pageRevisions = context.constraints.page_revisions as JsonValue;
      if (!Array.isArray(pageRevisions) || pageRevisions.length === 0) {
        throw new Error("KB promote requires at least one page revision to promote");
      }
      context.playbookData.target_capability_ids = targetIds as unknown as JsonValue;
      context.playbookData.page_revisions = pageRevisions;
      this.plane.claim({ kbRoot, capabilityIds: targetIds, runId });
      context.transition("plan");
      return this.dispatch(context);
    }

    if (action === "save") {
      // §5.6: a useful query does not authorize a save. The save must name its
      // query run, and claiming that run's answer is the FIRST side effect —
      // before any compose, read, or write — so a drifted, consumed, or
      // concurrently-claimed answer stops the run here.
      const queryRunId = String(context.constraints.query_run_id ?? "");
      if (queryRunId.length === 0) {
        throw new Error(
          "KB save requires the query_run_id whose sealed answer it proposes to save"
        );
      }
      const transactionId = `tx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const { answerArtifactId } = this.plane.claimSave({
        projectRoot: context.projectRoot,
        profileId: String(context.playbookData.profile_id ?? ""),
        kbRoot,
        queryRunId,
        saveRunId: runId,
        transactionId,
      });
      context.playbookData.query_run_id = queryRunId;
      context.playbookData.save_transaction_id = transactionId;
      context.playbookData.answer_artifact_id = answerArtifactId;
      context.playbookData.page_kind = String(context.constraints.page_kind ?? "synthesis");
      context.playbookData.title = String(context.constraints.title ?? "");
      // A save composes from the claimed answer; there is no extraction phase.
      context.transition("compose");
      return this.dispatch(context);
    }

    // All-or-none, before any agent reads a source.
    this.plane.claim({
      kbRoot,
      capabilityIds: sourceCapabilityIds,
      runId,
    });
    // Admit the source objects before any agent work: the approval path publishes
    // what this admitted, so the agents must see exactly what will publish.
    this.plane.admit({
      kbRoot,
      capabilityIds: sourceCapabilityIds,
      runId,
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
      plan: ["step_count", "target_count"],
      patch: ["hunk_count", "target_count"],
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
    const isPromote = String(context.playbookData.action ?? "ingest") === "promote";
    // Seal the exact candidate set and persist the gate BEFORE presenting it. A gate
    // offered before its candidates are frozen could be approved against a set that
    // changed afterwards.
    if (context.playbookData.gate_id === undefined) {
      const kbRoot = this.kbRoot(context);
      const artifactIds = KB_AGENT_PHASES.map((phase) => phases[phase]?.kb_artifact_id).filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
      if (isPromote) {
        // §5.11: the host's OWN verification, not a child's claim — re-resolve
        // every target, capture its current preimage, and confirm the named
        // revisions are the ones actually selected. The finding is sealed into
        // the packet alongside the plan and patch.
        const verification = this.plane.verifyPromotion({
          kbRoot,
          runId: context.identity.run_id,
          profileId: String(context.playbookData.profile_id ?? ""),
          pageRevisions: (context.playbookData.page_revisions ?? []) as JsonValue,
          targetCapabilityIds: stringList(context.playbookData.target_capability_ids),
        });
        artifactIds.push(verification.artifactId);
        context.playbookData.promotion_verified = verification.verified;
        if (!verification.verified) {
          const unresolved = stringList(context.playbookData.unresolved);
          context.playbookData.unresolved = [
            ...unresolved,
            "promotion verification did not pass; the packet is evidence, not authority",
          ] as unknown as JsonValue;
        }
      }
      this.plane.seal({ kbRoot, runId: context.identity.run_id, artifactIds });
      const capabilityIds = isPromote
        ? stringList(context.playbookData.target_capability_ids)
        : stringList(context.playbookData.source_ids);
      const gate = this.plane.persistGate({
        kbRoot,
        profileId: String(context.playbookData.profile_id ?? ""),
        runId: context.identity.run_id,
        artifactIds,
        sourceIds: isPromote ? [] : capabilityIds,
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
    const isSave = String(context.playbookData.action ?? "ingest") === "save";
    const saveClaim = {
      projectRoot: context.projectRoot,
      profileId: String(context.playbookData.profile_id ?? ""),
      kbRoot: this.kbRoot(context),
      queryRunId: String(context.playbookData.query_run_id ?? ""),
      saveRunId: context.identity.run_id,
    };
    if (decision === "approve") {
      if (String(context.playbookData.action ?? "ingest") === "promote") {
        // §5.11 / PRD acceptance 9: the public tool prepares only. Applying a
        // promotion needs the host-only signed approval path, which is G9 and
        // does not exist yet. Refusing here is the honest answer — publishing a
        // KB generation would be the WRONG action entirely, and pretending to
        // apply would be worse.
        throw new Error(
          "promotion apply is host-only and not implemented (G9); the public gate prepares and verifies only"
        );
      }
      context.transition("publishing");
      // §5.6/§5.10: reserve the claim immediately before publication. After this
      // the claim can only be consumed or invalidated — never returned to
      // available — so a failure here cannot become a second save.
      if (isSave) this.plane.reserveSave(saveClaim);
      // Publication is the deterministic host step this state exists for. The gate
      // is CAS-guarded and the selector swap is atomic underneath, so a crash
      // between publishing and checkpointing cannot double-publish.
      let published: KbPublishOutcome;
      try {
        published = this.plane.approve({
          kbRoot: this.kbRoot(context),
          runId: context.identity.run_id,
        });
      } catch (err) {
        // The host cannot prove from out here whether the selector moved, and
        // re-saving a possibly-published answer is worse than refusing a
        // legitimate retry. Fail closed.
        if (isSave) this.plane.settleSave({ ...saveClaim, outcome: "invalidated" });
        throw err;
      }
      if (isSave) this.plane.settleSave({ ...saveClaim, outcome: "consumed" });
      context.playbookData.published_generation_id = published.generationId;
      context.playbookData.published_counts = published.counts as unknown as JsonValue;
      return this.terminal(context, "complete", true, stringList(context.playbookData.unresolved));
    }
    if (decision === "refine") {
      // Refine RETAINS the claim (§5.6): the same save transaction continues.
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
    // §5.6: a denied save returns its claim to available while the sealed answer
    // is still valid, so the operator may compose a different page from the same
    // query; otherwise the claim is invalidated.
    if (isSave) this.plane.settleSave({ ...saveClaim, outcome: "released" });
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
