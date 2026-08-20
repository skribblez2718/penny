/**
 * KB worker client — bridges the engine's `ModelClient` surface to the KB's
 * §5.8 private-reader sessions.
 *
 * The engine's `WorkerExecutor` calls `ModelClient.runAgent(invocation)` for every
 * `invoke_agent` directive. Research gets a `PiAgentClient` (default posture +
 * result/artifact tools). KB gets this client instead: it builds the §5.8 session
 * spec (no built-in tools, four host-closed readers) for the phase named by the
 * directive, runs the agent, stages the typed result body into the KB content
 * plane, and returns routing metadata as `details`.
 *
 * Privacy: the phase body (claims, page draft, reports) lands in TWO owner-only
 * stores — the KB content plane (authoritative; sealed and approved by the host)
 * and the engine's artifact store (the engine's receipt chain requires it).
 * Neither is model-visible: the tool's result to the parent carries only counts
 * and ids, and the KB reader closures serve only allowlisted content.
 *
 * The agent runner is injectable (`agentRunner`) so tests can drive the entire
 * engine pipeline with deterministic bodies and no model.
 */

import { RunArtifactStore } from "./run-artifacts.js";
import { sourcesFromCapabilities } from "./gate.js";
import { KbModelClient, type KbAgentRunner } from "./kb-model-client.js";
import { checkChildModelIdentity } from "./policy.js";
import { recheckAdmittedPolicy } from "./workflows.js";
import type { KbPhaseInvocation } from "./session-tools.js";
import type {
  AgentCompletion,
  AgentInvocation,
  InlineExtension,
  ModelClient,
} from "../model-client.js";
import type { JsonValue } from "../contracts.js";

/** Prior phase state-ids each KB phase may read (mirrors the playbook's). */
const PRIOR_PHASES: Record<string, readonly string[]> = {
  ingest: [],
  compose: ["ingest"],
  lint: ["compose"],
  verify: ["compose"],
};

const PHASE_ARTIFACT_KIND: Record<
  string,
  "claims" | "page_draft" | "lint_report" | "verification_report"
> = {
  ingest: "claims",
  compose: "page_draft",
  lint: "lint_report",
  verify: "verification_report",
};

export interface KbWorkerClientOptions {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly runId: string;
  readonly profileId: string;
  /** The capability ids (= source ids) admitted for this run. */
  readonly sourceCapabilityIds: readonly string[];
  readonly modelOverride?: string;
  readonly workerExtensions?: readonly InlineExtension[];
  /**
   * The policy digest this run was admitted under (§5.3). When present, every
   * child creation rechecks exact equality and refuses `policy_changed` on
   * drift, and the resolved child identity is admitted against that policy
   * before a session exists. Omitted only by tests that inject a runner.
   */
  readonly admittedPolicySha256?: string;
  /**
   * Cross-run inputs this run is allowed to read, keyed by the phase slot they
   * fill (§5.8 "read an allowed prior run artifact").
   *
   * A `save` composes from the sealed `query_answer` of the query run its claim
   * names, so `ingest` is seeded with that artifact instead of being produced by
   * an extraction phase. The allowlist is exact: one run id, one artifact id,
   * decided by the host when the claim was taken.
   */
  readonly seedPhaseOutputs?: Readonly<Record<string, { runId: string; artifactId: string }>>;
  /** Injectable agent runner (tests substitute deterministic bodies). */
  readonly agentRunner?: KbAgentRunner;
}

export class KbWorkerClient implements ModelClient {
  private kbClient?: KbModelClient;
  private readonly runner: KbAgentRunner;
  private readonly store: RunArtifactStore;

  constructor(private readonly options: KbWorkerClientOptions) {
    this.store = new RunArtifactStore(options.kbRoot, options.runId);
    this.runner =
      options.agentRunner ??
      ((invocation: KbPhaseInvocation) => {
        if (this.kbClient === undefined) {
          this.kbClient = new KbModelClient({
            projectRoot: options.projectRoot,
            ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
            ...(options.workerExtensions ? { workerExtensions: options.workerExtensions } : {}),
          });
        }
        return this.kbClient.run(invocation);
      });
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const phase = invocation.stateId;
    const artifactKind = PHASE_ARTIFACT_KIND[phase];
    if (artifactKind === undefined) {
      throw new Error(`KbWorkerClient cannot serve KB phase '${phase}'`);
    }

    // Resolve the admitted sources once, at dispatch: the readers serve exactly
    // what the plane admitted, keyed by the same ids (source id = capability id).
    // A capability that no longer resolves here means the source drifted after
    // admission — refuse the phase rather than serve partial truth.
    const sources = sourcesFromCapabilities(this.options.kbRoot, this.options.sourceCapabilityIds);
    const contentBySourceId = new Map(sources.map((src) => [src.sourceId, src.content]));
    const sourceAllowlist = [...contentBySourceId.keys()];

    // §5.3 child admission, evaluated per child creation:
    //   1. the policy must still be EXACTLY the one this run was admitted under;
    //   2. the RESOLVED child identity must match the child allowlist.
    // Both run inside the pre-session hook, so a denial creates no session.
    const admittedSha = this.options.admittedPolicySha256;
    const admitModel =
      admittedSha === undefined
        ? undefined
        : (resolved: { provider: string; model: string }): void => {
            const policy = recheckAdmittedPolicy({
              kbRoot: this.options.kbRoot,
              admittedPolicySha256: admittedSha,
            });
            checkChildModelIdentity(policy, resolved);
          };

    const phaseInvocation: KbPhaseInvocation = {
      agent: invocation.agent,
      stateId: phase,
      phaseBrief: invocation.task,
      sourceAllowlist,
      priorPhaseAllowlist: PRIOR_PHASES[phase] ?? [],
      ...(admitModel ? { admitModel } : {}),
      readSource: (sourceId: string): string => {
        const content = contentBySourceId.get(sourceId);
        if (content === undefined) {
          throw new Error(`source '${sourceId}' is not admitted for this run; refusing`);
        }
        return content;
      },
      readPhaseOutput: (stateId: string): string => {
        // A host-seeded cross-run input (the claimed query answer for a save)
        // takes precedence: it is the exact artifact the claim authorized.
        const seed = this.options.seedPhaseOutputs?.[stateId];
        if (seed !== undefined) {
          const seedStore = new RunArtifactStore(this.options.kbRoot, seed.runId);
          try {
            return seedStore.read(seed.artifactId).content;
          } finally {
            seedStore.close();
          }
        }
        // A prior phase's latest staged (or sealed) artifact, by state id.
        const handles = this.store.listByState(stateId);
        const latest = handles[handles.length - 1];
        if (latest === undefined) {
          throw new Error(
            `phase '${stateId}' has no staged output for run '${this.options.runId}'; refusing read_phase_output`
          );
        }
        return this.store.read(latest.artifact_id).content;
      },
    };

    const body = await this.runner(phaseInvocation);

    // Stage the body into the KB content plane (authoritative copy), then derive
    // body-free routing metadata for the engine.
    const handle = this.store.stage({
      state_id: phase,
      kb_profile_id: this.options.profileId,
      artifact_kind: artifactKind,
      content: body,
    });
    const parsed = (JSON.parse(body) ?? {}) as Record<string, JsonValue>;
    const details: Record<string, JsonValue> = {
      artifact_kind: artifactKind,
      complete: true,
      kb_artifact_id: handle.artifact_id,
      ...this.phaseDetails(phase, parsed),
    };
    return { text: body, confidence: "CERTAIN", details };
  }

  /** Body-free routing metadata, per the playbook's per-phase details contract. */
  private phaseDetails(
    phase: string,
    parsed: Record<string, JsonValue>
  ): Record<string, JsonValue> {
    if (phase === "ingest") {
      const claims = Array.isArray(parsed.claims) ? (parsed.claims as unknown[]) : [];
      const sourceIds = Array.isArray(parsed.source_ids)
        ? (parsed.source_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      return { claim_count: claims.length, source_ids: sourceIds };
    }
    if (phase === "compose") {
      const pages = Array.isArray(parsed.pages)
        ? (parsed.pages as Array<Record<string, JsonValue>>)
        : [];
      const first = pages[0] ?? {};
      const frontmatter =
        typeof first.frontmatter === "object" && first.frontmatter !== null
          ? (first.frontmatter as Record<string, JsonValue>)
          : {};
      const claimCount = pages.reduce((sum, page) => {
        const claims = page.claims as Record<string, JsonValue> | undefined;
        const list = claims && Array.isArray(claims.claims) ? (claims.claims as unknown[]) : [];
        return sum + list.length;
      }, 0);
      return {
        page_id: typeof frontmatter.page_id === "string" ? frontmatter.page_id : "page_unknown",
        revision_id:
          typeof frontmatter.revision_id === "string" ? frontmatter.revision_id : "rev_unknown",
        claim_count: claimCount,
      };
    }
    if (phase === "lint") {
      const findings = Array.isArray(parsed.findings)
        ? (parsed.findings as Array<Record<string, JsonValue>>)
        : [];
      const conflicts = Array.isArray(parsed.candidate_conflicts)
        ? (parsed.candidate_conflicts as unknown[])
        : [];
      return {
        finding_count: findings.length,
        error_count: findings.filter((f) => f.severity === "error").length,
        candidate_conflict_count: conflicts.length,
      };
    }
    // verify
    const verdicts = Array.isArray(parsed.claim_findings)
      ? (parsed.claim_findings as Array<Record<string, JsonValue>>).map((f) => String(f.verdict))
      : [];
    return {
      supported: verdicts.filter((v) => v === "supported").length,
      partially_supported: verdicts.filter((v) => v === "partially_supported").length,
      unsupported: verdicts.filter((v) => v === "unsupported").length,
    };
  }

  close(): void {
    this.store.close();
  }
}
