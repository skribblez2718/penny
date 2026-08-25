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
 * Durable state lives in `context.knowledgeBaseData`, so `status`/`resume` inherit the
 * engine's checkpointer instead of a private KB run store. It holds **metadata only**
 * — counts, ids, verdicts. Phase bodies stay in the KB content plane and reach agents
 * only through the private readers, so no private body ever enters orchestration
 * control state.
 */

import { randomUUID } from "node:crypto";

import { Type } from "typebox";

import { canonicalJson, type Checkpointer } from "../checkpointer.js";
import {
  validateDirective,
  type Confidence,
  type Directive,
  type EvaluationResult,
  type JsonValue,
  type SkillContract,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import type { KbPhaseRecord } from "../durable-state.js";
import type { ArtifactRevisionLookup } from "../artifact-store.js";
import type { GapClassificationCapabilityV1, PlaybookCoreV1 } from "./playbook.js";
import { PolicyRefusal } from "../kb/policy.js";
import {
  packetDigest as contentReviewPacketDigest,
  packetJcs as contentReviewPacketJcs,
  validateContentReviewPacket,
} from "../kb/content-review.js";
import {
  PageRevisionRefSchema,
  validateKbContract,
  type ContentReviewGatePacket,
} from "../kb/contracts.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import {
  defaultKbIngestPlane,
  resolveKbRoot,
  type KbIngestPlaneV1,
  type KbPublishOutcome,
} from "../kb/ingest-plane.js";

/**
 * The custody seam the engine offers for §5.6 private start inputs. Read-only,
 * scoped to one run: the playbook never sees a store or a path, only the
 * bound digest and the parsed request document for its own run.
 */
export interface PrivateInputCapabilityV1 {
  readonly read: (runId: string) => unknown;
  readonly sha256: (runId: string) => string | undefined;
}

/** The agent phases of an ingest run, in order. */
export const KB_AGENT_PHASES = [
  "ingest",
  "compose",
  "query",
  "lint",
  "verify",
  "plan",
  "patch",
] as const;
export type KbAgentPhase = (typeof KB_AGENT_PHASES)[number];

/** Every non-terminal state of the KB machine. */
export const KB_STATES = [...KB_AGENT_PHASES, "awaiting_review", "publishing"] as const;
export type KbState = (typeof KB_STATES)[number];

const AGENT_BY_PHASE: Record<KbAgentPhase, string> = {
  ingest: "echo",
  compose: "synthia",
  query: "synthia",
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
  query: "verify",
  lint: "verify",
  verify: "awaiting_review",
  plan: "patch",
  patch: "awaiting_review",
  awaiting_review: "publishing",
  publishing: "complete",
};

/** Phases whose sealed output a later phase may read. */
const PRIOR_PHASES: Record<KbAgentPhase, readonly KbAgentPhase[]> = {
  ingest: [],
  compose: ["ingest"],
  query: [],
  lint: ["compose"],
  verify: ["compose", "query"],
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
  readonly routes_from: readonly string[];
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
    // A verified `query` enters Synthia only after deterministic retrieval has
    // bound one selected generation and a non-empty candidate allowlist. An
    // explicit verify_grounding:false query stays on the deterministic host path.
    {
      from: "start",
      to: "query",
      kind: "forward",
      trigger: "initialize query (verify_grounding true; bind candidates)",
    },
    {
      from: "start",
      to: "complete",
      kind: "terminal",
      trigger: "deterministic query (verify_grounding false; explicitly unverified)",
    },
    {
      from: "start",
      to: "incomplete",
      kind: "terminal",
      trigger: "query refused or no supported candidates",
    },
    // A `save` enters at compose: it has no extraction phase, because it
    // composes from the sealed answer of the query run its claim names.
    {
      from: "start",
      to: "compose",
      kind: "forward",
      trigger: "initialize save (claim the query answer)",
    },
    // A public `promote` prepares only: plan and patch, then review. The signed
    // host-internal continuation may later terminalize from that gate; it never
    // gives the public tool a publishing/apply edge.
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
      trigger: "content-review approve (host-authenticated)",
    },
    {
      from: "awaiting_review",
      to: "complete",
      kind: "terminal",
      trigger: "signed promotion apply verified (host-internal only)",
    },
    { from: "awaiting_review", to: "incomplete", kind: "terminal", trigger: "deny" },
    {
      from: "awaiting_review",
      to: "compose",
      kind: "repair",
      trigger: "content-review refine",
      bounded: true,
    },
    {
      from: "awaiting_review",
      to: "plan",
      kind: "repair",
      trigger: "promotion refine (host-authenticated)",
      bounded: true,
    },
    // publishing → complete is the publication happy path. A query may reach
    // the same met terminal only from Vera after host validation of the closed
    // citation report and save-claim creation.
    { from: "publishing", to: "complete", kind: "terminal", trigger: "publish (host I/O)" },
    {
      from: "verify",
      to: "complete",
      kind: "terminal",
      trigger: "verified query (supported citations + passing report + save claim)",
    },
    {
      from: "verify",
      to: "incomplete",
      kind: "terminal",
      trigger: "query verification failed or save claim unavailable",
    },
    // Repairs — the same routes `classifyGap` produces (bounded by the budget).
    {
      from: "lint",
      to: "compose",
      kind: "repair",
      trigger: "blocking-severity finding(s)",
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
      // Decisions reach the run only through authenticated host facades. Content
      // review and signed promotion approval are distinct stores/callbacks.
      host_only: true,
    },
  ],
  terminals: [
    // The completion gate admits agent-produced met terminals from publication
    // or query verification. `start` is the deterministic unverified host path
    // and has no save or parent-delivery authority.
    {
      id: "complete",
      met: true,
      routes_from: ["start", "awaiting_review", "publishing", "verify"],
    },
    { id: "incomplete", met: false, routes_from: ["start", "awaiting_review", "verify"] },
  ],
};

export function isKbState(value: string): value is KbState {
  return KB_STATES.some((state) => state === value);
}

function isAgentPhase(value: string): value is KbAgentPhase {
  return KB_AGENT_PHASES.some((phase) => phase === value);
}

function reviewableKbAction(value: unknown): "ingest" | "save" | "promote" {
  if (value === "ingest" || value === "save" || value === "promote") return value;
  throw new Error(`KB review authority does not support action '${String(value)}'`);
}

/**
 * The KB skill contract.
 *
 * `completion_gate` is live rather than decorative: an agent-produced `met:true`
 * terminal must come from `publishing` or query `verify`. Ingest/save therefore
 * cannot report success without approved publication, and a grounded query cannot
 * report success before Vera plus host finalization.
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
    // Publication admits ingest/save; Vera admits grounded query; awaiting_review
    // admits only the separate signed promotion finalizer (not ordinary resume).
    required_states: ["awaiting_review", "publishing", "verify"],
  },
};

// ── durable state (metadata only) ───────────────────────────────────────────

const PageRevisionListSchema = Type.Array(PageRevisionRefSchema, { minItems: 1 });

function phaseRecords(context: RunContext): Record<string, KbPhaseRecord> {
  return context.knowledgeBaseData.phases ?? {};
}

function recordPhase(context: RunContext, phase: string, record: KbPhaseRecord): void {
  context.knowledgeBaseData.phases = {
    ...phaseRecords(context),
    [phase]: record,
  };
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
  const provider = typeof value.provider === "string" ? value.provider : "";
  const model = typeof value.model === "string" ? value.model : "";
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined;
}

function counter(details: Record<string, JsonValue>, key: string): number {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The query's candidate count as safe metadata for the replay projection. */
function candidateCountOf(context: RunContext): number {
  const value = context.knowledgeBaseData.query_counts?.candidates;
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
    query: "query_answer",
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
      const value = details[field];
      if (typeof value !== "string" || value.length === 0) {
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
    ) => string = resolveKbRoot,
    private readonly privateInput?: PrivateInputCapabilityV1,
    private readonly checkpointer?: Checkpointer
  ) {
    // The real plane by default: an optional-I/O playbook could silently run
    // without persisting anything, which is precisely the failure mode that lets a
    // "successful" ingest publish nothing.
    this.plane = plane ?? defaultKbIngestPlane(checkpointer);
  }

  /** Host-resolved, never caller-supplied. */
  private kbRoot(context: RunContext): string {
    return this.rootResolver(
      context.projectRoot,
      String(context.knowledgeBaseData.profile_id ?? ""),
      context.identity.session_id
    );
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== "knowledge-base") {
      throw new Error(`KnowledgeBasePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    const action = String(context.constraints.action ?? "ingest");
    if (action !== "ingest" && action !== "save" && action !== "promote" && action !== "query") {
      throw new Error(`KB playbook action '${action}' is not implemented yet`);
    }
    const sourceCapabilityIds = stringList(context.constraints.source_capability_ids);
    if (action === "ingest" && sourceCapabilityIds.length === 0) {
      throw new Error("KB ingest requires at least one admitted source capability");
    }
    context.knowledgeBaseData.action = action;
    context.knowledgeBaseData.source_capability_ids = sourceCapabilityIds;
    context.knowledgeBaseData.profile_id = String(context.constraints.kb_profile_id ?? "");
    const kbRoot = this.kbRoot(context);
    const runId = context.identity.run_id;

    // §5.3 deny-before-session. The profile and root are already resolved
    // above; admission validates the policy and the ACTIVE parent identity
    // and binds the digest the run is admitted under.
    const parentIdentity = readParentIdentity(context.constraints.parent_identity);

    if (action === "query") {
      // §5.6 engine-owned query start, with no publication. The request body
      // arrives ONLY through the private-input custody seam — never via the
      // goal, constraints, prompt, or control state. Explicitly unverified
      // requests terminate on the deterministic path; default-true requests
      // bind candidates and enter Synthia → Vera through private readers.
      // Status/recover address both through the engine's one checkpointer.
      //
      // §5.3 admission is the FIRST phase for the query too. A policy refusal
      // is a DURABLE, ADDRESSABLE terminal state (public `refused`) — the run
      // is recorded, never leaked — not an exception. A host misconfiguration
      // (the granted root is not a KB at all) is not a refusal: it propagates
      // and the recorded run stays incomplete for the operator to address.
      try {
        const admitted = this.plane.admitRun({ kbRoot, parentIdentity });
        context.knowledgeBaseData.admitted_policy_sha256 = admitted.policy_sha256;
        context.knowledgeBaseData.kb_id = admitted.kb_id;
        return this.initializeQuery(context, kbRoot);
      } catch (error) {
        if (error instanceof PolicyRefusal) {
          context.knowledgeBaseData.public_status = "refused";
          context.knowledgeBaseData.warnings = [error.code];
          return this.terminal(context, "incomplete", false, [`policy refusal: ${error.code}`]);
        }
        throw error;
      }
    }

    // §5.3 deny-before-session (ingest/save/promote). Admission must precede
    // claim/admit, because admitting a source object reads private bytes — a
    // denial after that point would be a denial that already leaked.
    const admitted = this.plane.admitRun({ kbRoot, parentIdentity });
    context.knowledgeBaseData.admitted_policy_sha256 = admitted.policy_sha256;
    context.knowledgeBaseData.kb_id = admitted.kb_id;

    if (action === "promote") {
      // §5.11 prepare only. The targets are claimed all-or-none before any child
      // runs, exactly as ingest claims sources — but nothing here can apply,
      // sign, or mutate a canonical target. That is a host-only path at G9.
      const targetIds = stringList(context.constraints.canonical_target_capability_ids);
      if (targetIds.length === 0) {
        throw new Error("KB promote requires at least one canonical target capability");
      }
      const rawPageRevisions = context.constraints.page_revisions;
      if (!Array.isArray(rawPageRevisions) || rawPageRevisions.length === 0) {
        throw new Error("KB promote requires at least one page revision to promote");
      }
      const pageRevisions = validateKbContract(
        PageRevisionListSchema,
        rawPageRevisions,
        "KB promote page revisions"
      );
      context.knowledgeBaseData.target_capability_ids = targetIds;
      context.knowledgeBaseData.page_revisions = pageRevisions;
      this.plane.claim({
        projectRoot: context.projectRoot,
        kbRoot,
        capabilityIds: targetIds,
        runId,
        sessionId: context.identity.session_id,
        profileId: String(context.knowledgeBaseData.profile_id ?? ""),
        operation: "promote",
      });
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
        profileId: String(context.knowledgeBaseData.profile_id ?? ""),
        kbRoot,
        queryRunId,
        saveRunId: runId,
        transactionId,
      });
      context.knowledgeBaseData.query_run_id = queryRunId;
      context.knowledgeBaseData.save_transaction_id = transactionId;
      context.knowledgeBaseData.answer_artifact_id = answerArtifactId;
      if (this.privateInput === undefined || this.plane.readSaveStartRequest === undefined) {
        throw new Error(
          "KB save requires the private-input custody seam; its title is never taken from run state"
        );
      }
      const expectedSha256 = this.privateInput.sha256(runId);
      if (expectedSha256 === undefined) {
        throw new Error(`save run '${runId}' has no indexed private-input digest`);
      }
      const saveRequest = this.plane.readSaveStartRequest({
        request: this.privateInput.read(runId),
        expectedSha256,
      });
      if (saveRequest.query_run_id !== queryRunId) {
        throw new Error("the claimed query run does not match the stored save request");
      }
      // The title remains only in the private request/phase brief; control state
      // carries the opaque query binding and claim metadata, never body text.
      // A save composes from the claimed answer; there is no extraction phase.
      context.transition("compose");
      return this.dispatch(context);
    }

    // All-or-none, before any agent reads a source.
    const admittedSourceIds = this.plane.claim({
      projectRoot: context.projectRoot,
      kbRoot,
      capabilityIds: sourceCapabilityIds,
      runId,
      sessionId: context.identity.session_id,
      profileId: String(context.knowledgeBaseData.profile_id ?? ""),
      operation: "ingest",
    });
    context.knowledgeBaseData.source_ids = [...admittedSourceIds];
    // Verification-only: claim() has already created every immutable snapshot.
    this.plane.admit({
      projectRoot: context.projectRoot,
      kbRoot,
      sourceIds: admittedSourceIds,
      runId,
      sessionId: context.identity.session_id,
      profileId: String(context.knowledgeBaseData.profile_id ?? ""),
      operation: "ingest",
    });
    context.transition("ingest");
    return this.dispatch(context);
  }

  /**
   * Query initialization (§5.6).
   *
   * Order: §5.3 admission → digest-verified private-input read → deterministic
   * retrieval bound to one selected generation. `verify_grounding:false` then
   * seals an explicitly unverified answer and terminates. Default true enters
   * the purpose-built `query` (Synthia) and `verify` (Vera) states; only their
   * host-validated citation/report pair may create a save claim and terminate
   * met:true. Control state receives metadata and handles only.
   */
  private initializeQuery(context: RunContext, kbRoot: string): Directive {
    const runId = context.identity.run_id;
    const profileId = String(context.knowledgeBaseData.profile_id ?? "");
    if (profileId.length === 0) {
      throw new Error("KB query requires the host-supplied kb_profile_id constraint");
    }
    if (this.privateInput === undefined) {
      throw new Error(
        "KB query requires the private-input custody seam; the request body is never taken from run state"
      );
    }
    const expectedSha256 = this.privateInput.sha256(runId);
    if (expectedSha256 === undefined) {
      throw new Error(
        `run '${runId}' has no indexed private input; a query body is never taken from run state`
      );
    }
    if (this.plane.readStartRequest === undefined || this.plane.runQuery === undefined) {
      throw new Error(
        "the KB plane does not declare the §5.6 query capability; refusing to start a query run"
      );
    }
    const request = this.plane.readStartRequest({
      request: this.privateInput.read(runId),
      expectedSha256,
    });
    const outcome = this.plane.runQuery({
      projectRoot: context.projectRoot,
      kbRoot,
      profileId,
      runId,
      request,
    });
    // Safe metadata only: counts, opaque page ids, one path-free handle. The
    // request body never enters control state, a prompt, or a public result.
    context.knowledgeBaseData.kb_id = outcome.kbId ?? "";
    context.knowledgeBaseData.query_page_ids = [...outcome.pageIds];
    context.knowledgeBaseData.query_counts = {
      candidates: outcome.candidateCount,
    };
    context.knowledgeBaseData.selected_generation_id = outcome.selectedGenerationId ?? "";
    context.knowledgeBaseData.warnings = [...outcome.warnings];
    if (outcome.answerHandle !== undefined) {
      context.knowledgeBaseData.answer_artifact_id = outcome.answerHandle.artifact_id;
      context.knowledgeBaseData.answer_handle = outcome.answerHandle;
    }
    const unresolved = [...stringList(context.knowledgeBaseData.unresolved), ...outcome.unresolved];
    context.knowledgeBaseData.unresolved = unresolved;
    if (outcome.status === "refused") {
      context.knowledgeBaseData.public_status = "refused";
      return this.terminal(context, "incomplete", false, unresolved);
    }
    context.knowledgeBaseData.public_status = "complete";
    if (outcome.groundingRequired) {
      if (this.plane.finalizeVerifiedQuery === undefined) {
        throw new Error(
          "the KB plane cannot finalize a grounded query; refusing to bypass the verification seam"
        );
      }
      context.transition("query");
      return this.dispatch(context);
    }
    if (outcome.met === true) {
      return this.terminal(context, "complete", true, unresolved);
    }
    // §5.6 result matrix: a completed query with no supported answer is
    // `complete` but `met: false` — a satisfied flow, an honest negative
    // outcome. The engine terminal action for an unmet run is `incomplete`
    // (engine truth contract); the public projection maps it via
    // `public_status` back to §5.6's `complete`/`met:false`.
    return this.terminal(
      context,
      "incomplete",
      false,
      unresolved.length > 0 ? unresolved : ["empty result set"]
    );
  }

  private readStoredQueryRequest(context: RunContext) {
    if (this.privateInput === undefined || this.plane.readStartRequest === undefined) {
      throw new Error("the grounded query lost its private-input reader seam");
    }
    const expectedSha256 = this.privateInput.sha256(context.identity.run_id);
    if (expectedSha256 === undefined) {
      throw new Error("the grounded query has no indexed private-input digest");
    }
    return this.plane.readStartRequest({
      request: this.privateInput.read(context.identity.run_id),
      expectedSha256,
    });
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
    const upstream = context.selectedArtifacts.filter(
      (ref) => isAgentPhase(ref.phase) && PRIOR_PHASES[phase].includes(ref.phase)
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
        schema_version: 2,
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
    const revision = context.iteration > 0 ? ` (revision ${context.iteration})` : "";
    const action = String(context.knowledgeBaseData.action ?? "");
    if (action === "query") {
      return `Execute the knowledge-base '${phase}' phase${revision} through the host-closed query readers. Follow the phase guidance and submit the typed result.`;
    }
    if (action === "promote") {
      const pageRevisions = Array.isArray(context.knowledgeBaseData.page_revisions)
        ? context.knowledgeBaseData.page_revisions
        : [];
      const targetIds = stringList(context.knowledgeBaseData.target_capability_ids);
      return `Execute the knowledge-base '${phase}' phase${revision} for page revisions ${canonicalJson(
        pageRevisions
      )} and target capability ids ${canonicalJson(targetIds)}. Read them only through the host-closed promotion readers; prepare only and submit the typed result.`;
    }
    const sources = stringList(context.knowledgeBaseData.source_ids);
    return `Execute the knowledge-base '${phase}' phase${revision} over ${sources.length} admitted source(s). Follow the phase guidance and submit the typed result.`;
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
    if (state === "lint" && counter(details, "blocking_count") > 0) {
      return {
        schema_version: 1,
        kind: "synthesis_gap",
        detail: `semantic lint reported ${counter(details, "blocking_count")} blocking-severity finding(s)`,
        target_state: "compose",
        exhausted,
      };
    }
    if (
      state === "verify" &&
      String(context.knowledgeBaseData.action ?? "") !== "query" &&
      counter(details, "unsupported") > 0
    ) {
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

    if (state === "verify" && String(context.knowledgeBaseData.action ?? "") === "query") {
      return this.finishVerifiedQuery(context);
    }

    const gap = this.classifyGap(context, state, details);
    if (gap !== null && !gap.exhausted && gap.target_state !== undefined) {
      const warnings = stringList(context.knowledgeBaseData.warnings);
      context.knowledgeBaseData.warnings = [...warnings, gap.detail];
      context.iteration += 1;
      context.transition(gap.target_state);
      return this.dispatch(context);
    }
    if (gap !== null && gap.exhausted) {
      // Budget spent. Carry the finding forward as unresolved rather than looping
      // again or pretending the phase passed.
      const unresolved = stringList(context.knowledgeBaseData.unresolved);
      context.knowledgeBaseData.unresolved = [...unresolved, gap.detail];
    }

    const next = NEXT_STATE[state];
    if (next === "complete") {
      return this.terminal(
        context,
        "complete",
        true,
        stringList(context.knowledgeBaseData.unresolved)
      );
    }
    context.transition(next);
    return this.dispatch(context);
  }

  private finishVerifiedQuery(context: RunContext): Directive {
    if (this.plane.finalizeVerifiedQuery === undefined) {
      throw new Error("the KB plane cannot finalize a verified query");
    }
    const phases = phaseRecords(context);
    const answerArtifactId = phases.query?.kb_artifact_id ?? "";
    const verificationArtifactId = phases.verify?.kb_artifact_id ?? "";
    const selectedGenerationId = String(context.knowledgeBaseData.selected_generation_id ?? "");
    if (
      answerArtifactId.length === 0 ||
      verificationArtifactId.length === 0 ||
      selectedGenerationId.length === 0
    ) {
      throw new Error("the grounded query is missing its bound answer, report, or generation");
    }
    const outcome = this.plane.finalizeVerifiedQuery({
      projectRoot: context.projectRoot,
      kbRoot: this.kbRoot(context),
      profileId: String(context.knowledgeBaseData.profile_id ?? ""),
      runId: context.identity.run_id,
      request: this.readStoredQueryRequest(context),
      selectedGenerationId,
      answerArtifactId,
      verificationArtifactId,
    });
    context.knowledgeBaseData.kb_id = outcome.kbId ?? "";
    context.knowledgeBaseData.query_page_ids = [...outcome.pageIds];
    context.knowledgeBaseData.query_counts = {
      candidates: outcome.candidateCount,
    };
    context.knowledgeBaseData.answer_artifact_id = outcome.answerHandle?.artifact_id ?? "";
    context.knowledgeBaseData.answer_handle = outcome.answerHandle ?? null;
    context.knowledgeBaseData.verification_artifact_id = outcome.verificationArtifactId;
    context.knowledgeBaseData.grounding_verified = outcome.met;
    const warnings = [...stringList(context.knowledgeBaseData.warnings), ...outcome.warnings];
    const unresolved = [...stringList(context.knowledgeBaseData.unresolved), ...outcome.unresolved];
    context.knowledgeBaseData.warnings = warnings;
    context.knowledgeBaseData.unresolved = unresolved;
    context.knowledgeBaseData.public_status = "complete";
    return outcome.met
      ? this.terminal(context, "complete", true, unresolved)
      : this.terminal(context, "incomplete", false, unresolved);
  }

  private countsFor(
    state: KbAgentPhase,
    details: Record<string, JsonValue>
  ): Record<string, number> {
    const keys: Record<KbAgentPhase, readonly string[]> = {
      ingest: ["claim_count"],
      compose: ["claim_count"],
      query: ["citation_count"],
      lint: ["finding_count", "blocking_count", "candidate_conflict_count"],
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
    const action = String(context.knowledgeBaseData.action ?? "ingest");
    const isPromote = action === "promote";
    const isContentReview = action === "ingest" || action === "save";
    let engineGateId = String(
      isPromote
        ? (context.knowledgeBaseData.promotion_challenge_id ?? "")
        : (context.knowledgeBaseData.content_review_challenge_id ?? "")
    );
    if (engineGateId.length === 0) engineGateId = randomUUID();

    // Seal the exact candidate set and construct its authority packet BEFORE
    // presenting it. Checkpointer.persistPendingGate stores the packet and the
    // run/generic gate in one control-DB transaction.
    if (
      (isContentReview && context.knowledgeBaseData.content_review_packet_jcs === undefined) ||
      (isPromote && context.knowledgeBaseData.promotion_packet_sha256 === undefined)
    ) {
      const kbRoot = this.kbRoot(context);
      const artifactIds = KB_AGENT_PHASES.map((phase) => phases[phase]?.kb_artifact_id).filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
      if (isPromote) {
        // Prepare remains non-authority evidence. The separate G9 approval DB
        // may sign/apply only after this host verification artifact is sealed.
        const verification = this.plane.verifyPromotion({
          projectRoot: context.projectRoot,
          kbRoot,
          runId: context.identity.run_id,
          sessionId: context.identity.session_id,
          profileId: String(context.knowledgeBaseData.profile_id ?? ""),
          operation: "promote",
          pageRevisions: context.knowledgeBaseData.page_revisions ?? [],
          targetCapabilityIds: stringList(context.knowledgeBaseData.target_capability_ids),
        });
        artifactIds.push(verification.artifactId);
        context.knowledgeBaseData.promotion_verified = verification.verified;
        if (!verification.verified) {
          const unresolved = stringList(context.knowledgeBaseData.unresolved);
          context.knowledgeBaseData.unresolved = [
            ...unresolved,
            "promotion verification did not pass; the packet is evidence, not authority",
          ];
        }
      }
      this.plane.seal({ kbRoot, runId: context.identity.run_id, artifactIds });
      context.knowledgeBaseData.review_artifact_ids = [...artifactIds];
      const capabilityIds = isPromote
        ? stringList(context.knowledgeBaseData.target_capability_ids)
        : stringList(context.knowledgeBaseData.source_capability_ids);
      const sourceIds =
        isContentReview && action === "ingest"
          ? stringList(context.knowledgeBaseData.source_ids)
          : [];
      if (isContentReview) {
        const admittedPolicySha256 = String(context.knowledgeBaseData.admitted_policy_sha256 ?? "");
        if (admittedPolicySha256.length === 0) {
          throw new Error("content-review packet requires the admitted policy digest");
        }
        const packet = this.plane.prepareContentReview({
          projectRoot: context.projectRoot,
          kbRoot,
          profileId: String(context.knowledgeBaseData.profile_id ?? ""),
          runId: context.identity.run_id,
          artifactIds,
          sourceIds,
          capabilityIds,
          sessionId: context.identity.session_id,
          challengeId: engineGateId,
          action,
          ...(action === "save"
            ? { queryRunId: String(context.knowledgeBaseData.query_run_id ?? "") }
            : {}),
          policySha256: admittedPolicySha256,
        });
        context.knowledgeBaseData.content_review_challenge_id = engineGateId;
        context.knowledgeBaseData.content_review_packet_jcs = contentReviewPacketJcs(packet);
        context.knowledgeBaseData.content_review_packet_sha256 = contentReviewPacketDigest(packet);
        context.knowledgeBaseData.gate_id = engineGateId;
        context.knowledgeBaseData.base_generation_id = packet.base_generation_id;
      } else if (isPromote) {
        if (this.plane.preparePromotionGate === undefined) {
          throw new Error(
            "promotion cannot reach awaiting_user without the approval-DB-first packet service"
          );
        }
        const pageRevisions = context.knowledgeBaseData.page_revisions ?? [];
        const stored = this.plane.preparePromotionGate({
          projectRoot: context.projectRoot,
          kbRoot,
          profileId: String(context.knowledgeBaseData.profile_id ?? ""),
          runId: context.identity.run_id,
          artifactIds,
          sourceIds: [],
          capabilityIds,
          sessionId: context.identity.session_id,
          challengeId: engineGateId,
          pageRevisions,
        });
        context.knowledgeBaseData.promotion_challenge_id = stored.challengeId;
        context.knowledgeBaseData.promotion_packet_sha256 = stored.packetSha256;
        context.knowledgeBaseData.gate_id = stored.challengeId;
      } else {
        throw new Error(`KB action '${action}' cannot enter the review gate`);
      }
    }
    const gateId = isContentReview
      ? String(context.knowledgeBaseData.content_review_challenge_id ?? engineGateId)
      : String(context.knowledgeBaseData.promotion_challenge_id ?? engineGateId);
    const challenge = isPromote ? gateId : randomUUID();
    context.status = "awaiting_user";
    const next = directive({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_review",
      gate_id: gateId,
      challenge,
      payload_digest: isContentReview
        ? String(context.knowledgeBaseData.content_review_packet_sha256 ?? "")
        : String(context.knowledgeBaseData.promotion_packet_sha256 ?? ""),
      questions: [
        {
          id: "content-review-1",
          prompt: isPromote
            ? "Review the stored promotion packet through the authenticated host approval surface. Public responses cannot approve or apply it."
            : "Approve publication of the reviewed candidate page(s) into the knowledge base? Answer 'approve', 'deny', or 'refine'.",
        },
      ],
    });
    context.pendingDirective = next;
    return next;
  }

  private storedContentReviewPacket(context: RunContext): ContentReviewGatePacket {
    const raw = context.knowledgeBaseData.content_review_packet_jcs;
    if (typeof raw !== "string") {
      throw new Error("the run has no canonical content-review packet in control state");
    }
    const value: unknown = JSON.parse(raw);
    return validateContentReviewPacket(value);
  }

  resume(context: RunContext, response: JsonValue): Directive {
    if (context.stateId !== "awaiting_review") {
      throw new Error(`KB run is not at a review gate (state '${context.stateId}')`);
    }
    const kbRoot = this.kbRoot(context);
    const admittedPolicySha256 = String(context.knowledgeBaseData.admitted_policy_sha256 ?? "");
    if (admittedPolicySha256.length === 0) {
      throw new PolicyRefusal("policy_changed", "the run has no admitted policy binding");
    }
    try {
      this.plane.recheckPolicy({ kbRoot, admittedPolicySha256 });
    } catch (error) {
      if (!(error instanceof PolicyRefusal)) throw error;
      const action = reviewableKbAction(context.knowledgeBaseData.action ?? "ingest");
      const packet =
        action === "ingest" || action === "save"
          ? this.storedContentReviewPacket(context)
          : undefined;
      this.plane.deny({
        projectRoot: context.projectRoot,
        kbRoot,
        runId: context.identity.run_id,
        action,
        ...(packet !== undefined ? { packet } : {}),
        capabilityIds:
          action === "promote"
            ? stringList(context.knowledgeBaseData.target_capability_ids)
            : stringList(context.knowledgeBaseData.source_capability_ids),
      });
      if (action === "save") {
        this.plane.settleSave({
          projectRoot: context.projectRoot,
          profileId: String(context.knowledgeBaseData.profile_id ?? ""),
          kbRoot,
          queryRunId: String(context.knowledgeBaseData.query_run_id ?? ""),
          saveRunId: context.identity.run_id,
          outcome: "invalidated",
        });
      }
      context.knowledgeBaseData.public_status = "refused";
      context.knowledgeBaseData.warnings = [error.code];
      return this.terminal(context, "incomplete", false, [error.code]);
    }
    const decision = this.readDecision(response);
    context.knowledgeBaseData.review_decision = decision;
    const isSave = String(context.knowledgeBaseData.action ?? "ingest") === "save";
    const saveClaim = {
      projectRoot: context.projectRoot,
      profileId: String(context.knowledgeBaseData.profile_id ?? ""),
      kbRoot,
      queryRunId: String(context.knowledgeBaseData.query_run_id ?? ""),
      saveRunId: context.identity.run_id,
    };
    if (decision === "approve") {
      if (String(context.knowledgeBaseData.action ?? "ingest") === "promote") {
        // The signed G9 path calls `completeApprovedPromotion` only after the
        // approval DB and apply journal have settled. Generic/public gate resume
        // is never allowed to turn this string into canonical-write authority.
        throw new Error(
          "promotion approve/apply is host-only; public gate responses cannot carry approval authority"
        );
      }
      context.transition("publishing");
      const publicationTransactionId = String(
        context.knowledgeBaseData.publication_transaction_id ??
          (this.checkpointer === undefined ? context.identity.run_id : "")
      );
      if (publicationTransactionId.length === 0) {
        throw new Error("approved publication has no host-owned callback transaction");
      }
      // Reservation, selector commit, and selector-proven authority consumption
      // are one transaction-owned host step inside the writer lock. The
      // playbook must not reserve early or guess after an ambiguous exception.
      const published: KbPublishOutcome = this.plane.approve({
        projectRoot: context.projectRoot,
        kbRoot,
        runId: context.identity.run_id,
        transactionId: publicationTransactionId,
        packet: this.storedContentReviewPacket(context),
        capabilityIds: stringList(context.knowledgeBaseData.source_capability_ids),
      });
      context.knowledgeBaseData.published_generation_id = published.generationId;
      context.knowledgeBaseData.published_counts = published.counts;
      return this.terminal(
        context,
        "complete",
        true,
        stringList(context.knowledgeBaseData.unresolved)
      );
    }
    if (decision === "refine") {
      // Refine RETAINS the claim (§5.6): the same save transaction continues.
      const unresolvedRefine = stringList(context.knowledgeBaseData.unresolved);
      context.knowledgeBaseData.unresolved = [...unresolvedRefine, "reviewer requested refinement"];
      context.iteration += 1;
      // Refine closes this challenge. Revised artifacts must produce a fresh
      // packet/challenge; retaining these keys would silently re-offer old bytes.
      delete context.knowledgeBaseData.content_review_challenge_id;
      delete context.knowledgeBaseData.content_review_packet_jcs;
      delete context.knowledgeBaseData.content_review_packet_sha256;
      delete context.knowledgeBaseData.promotion_challenge_id;
      delete context.knowledgeBaseData.promotion_packet_sha256;
      delete context.knowledgeBaseData.review_receipt_id;
      delete context.knowledgeBaseData.review_receipt_sha256;
      delete context.knowledgeBaseData.gate_id;
      const isPromotion = String(context.knowledgeBaseData.action ?? "") === "promote";
      if (isPromotion) {
        const retainedPhases = { ...phaseRecords(context) };
        delete retainedPhases.plan;
        delete retainedPhases.patch;
        context.knowledgeBaseData.phases = retainedPhases;
      }
      context.transition(isPromotion ? "plan" : "compose");
      return this.dispatch(context);
    }
    // Denial publishes nothing and is an honest negative terminal, not an error.
    const deniedAction = reviewableKbAction(context.knowledgeBaseData.action ?? "ingest");
    this.plane.deny({
      projectRoot: context.projectRoot,
      kbRoot,
      runId: context.identity.run_id,
      action: deniedAction,
      ...(deniedAction === "ingest" || deniedAction === "save"
        ? { packet: this.storedContentReviewPacket(context) }
        : {}),
      capabilityIds:
        deniedAction === "promote"
          ? stringList(context.knowledgeBaseData.target_capability_ids)
          : stringList(context.knowledgeBaseData.source_capability_ids),
    });
    // §5.6: a denied save returns its claim to available while the sealed answer
    // is still valid, so the operator may compose a different page from the same
    // query; otherwise the claim is invalidated.
    if (isSave) this.plane.settleSave({ ...saveClaim, outcome: "released" });
    const unresolved = [
      ...stringList(context.knowledgeBaseData.unresolved),
      "reviewer denied publication",
    ];
    context.status = "running";
    return this.terminal(context, "incomplete", false, unresolved);
  }

  /**
   * Host-only terminal reconciliation after the signed apply service settles its
   * approval DB first and target-capability DB second. This method has no public
   * request representation and receives metadata only—never a receipt body.
   */
  completeApprovedPromotion(
    context: RunContext,
    outcome: {
      status: "complete" | "failed" | "blocked_external_drift";
      receiptId: string;
      receiptSha256: string;
      transactionId: string;
      targetCount: number;
      postApplyVerified: boolean;
    }
  ): Directive {
    if (
      context.stateId !== "awaiting_review" ||
      String(context.knowledgeBaseData.action ?? "") !== "promote"
    ) {
      throw new Error("run is not awaiting host-only promotion apply finalization");
    }
    context.knowledgeBaseData.review_decision = "approve";
    context.knowledgeBaseData.promotion_receipt_id = outcome.receiptId;
    context.knowledgeBaseData.promotion_receipt_sha256 = outcome.receiptSha256;
    context.knowledgeBaseData.promotion_apply_transaction_id = outcome.transactionId;
    context.knowledgeBaseData.promotion_apply_status = outcome.status;
    context.knowledgeBaseData.promotion_post_apply_verified = outcome.postApplyVerified;
    context.knowledgeBaseData.promotion_target_count = outcome.targetCount;
    if (outcome.status === "complete" && outcome.postApplyVerified) {
      return this.terminal(
        context,
        "complete",
        true,
        stringList(context.knowledgeBaseData.unresolved)
      );
    }
    const unresolved = [
      ...stringList(context.knowledgeBaseData.unresolved),
      outcome.status === "blocked_external_drift"
        ? "promotion apply blocked on external target drift"
        : "promotion apply failed and owned target bytes were restored",
    ];
    return this.terminal(context, "incomplete", false, unresolved);
  }

  /** Host-only expiry/drift invalidation; no decision is invented. */
  invalidateReview(context: RunContext, reason: string): Directive {
    if (context.stateId !== "awaiting_review") {
      throw new Error(`KB run is not at a review gate (state '${context.stateId}')`);
    }
    const action = reviewableKbAction(context.knowledgeBaseData.action ?? "ingest");
    const kbRoot = this.kbRoot(context);
    this.plane.deny({
      projectRoot: context.projectRoot,
      kbRoot,
      runId: context.identity.run_id,
      action,
      ...(action === "ingest" || action === "save"
        ? { packet: this.storedContentReviewPacket(context) }
        : {}),
      capabilityIds:
        action === "promote"
          ? stringList(context.knowledgeBaseData.target_capability_ids)
          : stringList(context.knowledgeBaseData.source_capability_ids),
    });
    if (action === "save") {
      this.plane.settleSave({
        projectRoot: context.projectRoot,
        profileId: String(context.knowledgeBaseData.profile_id ?? ""),
        kbRoot,
        queryRunId: String(context.knowledgeBaseData.query_run_id ?? ""),
        saveRunId: context.identity.run_id,
        outcome: "invalidated",
      });
    }
    context.knowledgeBaseData.public_status = "refused";
    context.knowledgeBaseData.warnings = [reason];
    return this.terminal(context, "incomplete", false, [reason]);
  }

  private readDecision(response: JsonValue): "approve" | "deny" | "refine" {
    const raw =
      typeof response === "string"
        ? response
        : response !== null && typeof response === "object" && !Array.isArray(response)
          ? String(response.decision ?? "")
          : "";
    const value = raw.trim().toLowerCase();
    if (value === "approve" || value === "deny" || value === "refine") {
      return value;
    }
    throw new Error(`KB review decision must be approve, deny, or refine; received '${raw}'`);
  }

  cancel(context: RunContext, reason: string): Directive {
    const action = String(context.knowledgeBaseData.action ?? "");
    const capabilities = stringList(context.knowledgeBaseData.source_capability_ids);
    if (action === "ingest" && capabilities.length > 0) {
      this.plane.deny({
        projectRoot: context.projectRoot,
        kbRoot: this.kbRoot(context),
        runId: context.identity.run_id,
        action: "ingest",
        capabilityIds: capabilities,
      });
    }
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
        action: String(context.knowledgeBaseData.action ?? "ingest"),
        kb_profile_id: String(context.knowledgeBaseData.profile_id ?? ""),
        source_count: stringList(context.knowledgeBaseData.source_ids).length,
        phases,
        gate_id: String(context.knowledgeBaseData.gate_id ?? ""),
        published_generation_id: String(context.knowledgeBaseData.published_generation_id ?? ""),
        published_counts: context.knowledgeBaseData.published_counts ?? {},
        review_decision: String(context.knowledgeBaseData.review_decision ?? ""),
        // §5.6 query replay metadata — safe metadata only: the §5.6 public
        // status for the result matrix (complete|refused), opaque page ids,
        // counts, and the ONE path-free `query_answer` handle. Never the
        // request body, a path, or the answer text.
        kb_id: String(context.knowledgeBaseData.kb_id ?? ""),
        public_status: String(context.knowledgeBaseData.public_status ?? ""),
        candidate_count: candidateCountOf(context),
        query_page_ids: stringList(context.knowledgeBaseData.query_page_ids),
        answer_artifact_id: String(context.knowledgeBaseData.answer_artifact_id ?? ""),
        answer_handle: context.knowledgeBaseData.answer_handle ?? null,
        verification_artifact_id: String(context.knowledgeBaseData.verification_artifact_id ?? ""),
        grounding_verified: context.knowledgeBaseData.grounding_verified === true,
        promotion_apply_status: String(context.knowledgeBaseData.promotion_apply_status ?? ""),
        promotion_post_apply_verified:
          context.knowledgeBaseData.promotion_post_apply_verified === true,
        promotion_target_count:
          typeof context.knowledgeBaseData.promotion_target_count === "number"
            ? context.knowledgeBaseData.promotion_target_count
            : 0,
        warnings: stringList(context.knowledgeBaseData.warnings),
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
