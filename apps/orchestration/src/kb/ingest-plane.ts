/**
 * The KB ingest plane — the deterministic host I/O the playbook performs between
 * agent phases.
 *
 * ## Why this is an interface
 *
 * The playbook is the host-side orchestrator for KB, so it genuinely owns the
 * sealing, gating, and publication steps: these are not agent work, and there is no
 * directive action for "the host does something deterministic" (adding one would
 * expand the engine's directive contract and touch every consumer plus research
 * parity, to express something only KB needs).
 *
 * Putting that I/O behind this interface keeps two properties that matter:
 *
 * - the playbook's state machine stays testable without a filesystem, and
 * - the KB's privacy rules stay in the KB modules that already enforce them, rather
 *   than being re-implemented inside a playbook.
 *
 * ## Roots are resolved here, never accepted
 *
 * `resolveKbRoot` derives the root from the project root and a **validated** profile
 * id. A profile id reaches this code from a model-facing tool parameter, so it is
 * validated against the opaque-id contract before it is ever used as a path segment;
 * a root supplied by a caller is ignored rather than trusted.
 */

import path from "node:path";

import { isValidProfileId } from "./profile-registry.js";
import {
  approveGate,
  claimCapabilities,
  denyGate,
  findGateForRun,
  persistIngestGate,
  sourcesFromCapabilities,
  type GateState,
} from "./gate.js";
import { RunArtifactStore } from "./run-artifacts.js";
import { writeSourceObject, writeSourceRecord } from "./filesystem.js";
import { sha256Hex, type Sha256Hex } from "./contracts.js";
import { sourceRecordFor } from "./ingest.js";
import { admitKbRun } from "./workflows.js";
import { SaveQueryClaimStore, saveClaimStoreDir } from "./save-claim.js";
import { verifyPromotionCandidate } from "./promote.js";

export interface KbSealInput {
  readonly kbRoot: string;
  readonly runId: string;
  readonly artifactIds: readonly string[];
}

export interface KbGateInput {
  readonly kbRoot: string;
  readonly profileId: string;
  readonly runId: string;
  /**
   * Ids of the sealed artifacts, in phase order.
   *
   * Ids rather than handles: the playbook holds only handles-as-ids in control
   * state, and the plane resolves the full records from the content plane. Letting
   * the caller pass partial handle objects is how a gate once got written with
   * `undefined` fields — unparseable JSON that readers then skipped as "no gate".
   */
  readonly artifactIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly capabilityIds: readonly string[];
}

export interface KbPublishOutcome {
  readonly generationId: string;
  readonly counts: Record<string, number>;
}

/**
 * Deterministic KB operations the playbook performs itself.
 *
 * Every method is synchronous. KB storage is synchronous by construction
 * (`node:sqlite` plus atomic file replacement), which is what lets the playbook's
 * `acceptSummary`/`resume` remain ordinary synchronous state transitions.
 */
export interface KbIngestPlaneV1 {
  /**
   * §5.3 deny-before-session admission — the FIRST plane call of any run.
   *
   * Validates the policy and the ACTIVE parent identity and returns the digest
   * the run binds as `admitted_policy_sha256`. It must precede `claim`/`admit`,
   * because admitting a source reads private bytes: a denial that happens after
   * that point is a denial that already leaked. Child identities are admitted
   * later, at the only moment they exist — after the runtime resolves the
   * agent's alias and before its session is created.
   */
  admitRun(input: {
    kbRoot: string;
    parentIdentity: { provider: string; model: string } | undefined;
  }): { policy_sha256: string };
  /**
   * Bind the admitted source capabilities to this run, all-or-none.
   *
   * Claiming happens before any phase work: a capability that cannot be claimed
   * (expired, replayed, already bound to another run) must stop the run before an
   * agent reads anything, not after.
   */
  claim(input: { kbRoot: string; capabilityIds: readonly string[]; runId: string }): void;
  /**
   * Admit the run's sources into the publication plane (content-addressed
   * objects + records), re-verifying each against its capability envelope.
   *
   * Approval publishes the source objects this admits, so it must happen
   * before any agent reads — the agents then see exactly what will be
   * published.
   */
  admit(input: { kbRoot: string; capabilityIds: readonly string[]; runId: string }): void;
  /** Seal the exact candidate set, freezing what the review gate will offer. */
  seal(input: KbSealInput): void;
  /** Persist the review gate, bound to the sealed set and the base generation. */
  persistGate(input: KbGateInput): GateState;
  /** Publish an approved gate. Consumes the bound capability leases. */
  approve(input: { kbRoot: string; runId: string }): KbPublishOutcome;
  /** Deny a pending gate. Publishes nothing and invalidates the leases. */
  deny(input: { kbRoot: string; runId: string }): void;
  /**
   * §5.6 `save` admission — CAS the query's claim `available → claimed` BEFORE
   * any side effect, and return the sealed answer this save is entitled to.
   *
   * A useful query does not authorize a save: this is the call that turns a
   * named query run into a single-use right, and it refuses a drifted,
   * consumed, invalidated, cross-profile, or already-claimed answer.
   */
  claimSave(input: {
    projectRoot: string;
    profileId: string;
    kbRoot: string;
    queryRunId: string;
    saveRunId: string;
    transactionId: string;
  }): { answerArtifactId: string };
  /** CAS `claimed → commit_reserved` immediately before publication. */
  reserveSave(input: {
    projectRoot: string;
    profileId: string;
    queryRunId: string;
    saveRunId: string;
  }): void;
  /**
   * Settle a save's claim after the publication attempt resolves.
   *
   * `consumed` requires selector evidence; `released` returns an ordinary
   * claimed row to available only while the sealed answer is still valid;
   * `invalidated` is the fail-closed direction when neither can be proven.
   */
  settleSave(input: {
    projectRoot: string;
    profileId: string;
    kbRoot: string;
    queryRunId: string;
    saveRunId: string;
    outcome: "consumed" | "released" | "invalidated";
  }): void;
  /**
   * §5.11 promotion verification — the host's own finding, staged as the third
   * handle in the review packet.
   *
   * Prepare-only by construction: it re-resolves targets, captures current
   * preimages, and checks the named revisions against the selected generation.
   * It writes nothing to any canonical target.
   */
  verifyPromotion(input: {
    kbRoot: string;
    runId: string;
    profileId: string;
    pageRevisions: unknown;
    targetCapabilityIds: readonly string[];
  }): { artifactId: string; verified: boolean };
}

/**
 * Resolve the KB root for one profile.
 *
 * Throws on an invalid profile id rather than normalizing it: an id that fails the
 * opaque-id contract is a refusal, not something to sanitize into a path.
 */
export function resolveKbRoot(projectRoot: string, profileId: string): string {
  if (!isValidProfileId(profileId)) {
    throw new Error(`kb_profile_id '${profileId}' is not a valid opaque profile id`);
  }
  return path.join(projectRoot, ".penny", "kb", profileId);
}

/** The real plane, over the existing KB modules. */
export function defaultKbIngestPlane(): KbIngestPlaneV1 {
  return {
    admitRun(input) {
      const { policy_sha256 } = admitKbRun({
        kbRoot: input.kbRoot,
        parentIdentity: input.parentIdentity,
      });
      return { policy_sha256 };
    },
    claim(input) {
      claimCapabilities(input.kbRoot, input.capabilityIds, input.runId);
    },
    admit(input) {
      // Host reads, re-verified against the envelope; the file must still match
      // its mint-time digest or the admit refuses.
      const sources = sourcesFromCapabilities(input.kbRoot, input.capabilityIds);
      for (const src of sources) {
        writeSourceObject(input.kbRoot, sha256Hex(src.content), Buffer.from(src.content, "utf8"));
        writeSourceRecord(input.kbRoot, sourceRecordFor(src, input.runId));
      }
    },
    seal(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId);
      try {
        store.seal(input.artifactIds);
      } finally {
        store.close();
      }
    },
    persistGate(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId);
      let handles: Record<string, unknown>[];
      try {
        handles = input.artifactIds.map((id) => {
          const { handle } = store.read(id);
          return handle as unknown as Record<string, unknown>;
        });
      } finally {
        store.close();
      }
      return persistIngestGate(
        input.kbRoot,
        input.profileId,
        input.runId,
        handles,
        input.sourceIds,
        input.capabilityIds
      );
    },
    approve(input) {
      const gate = findGateForRun(input.kbRoot, input.runId);
      if (gate === undefined) {
        throw new Error(`no content-review gate exists for run '${input.runId}'`);
      }
      // Source content is re-resolved from the bound capabilities so the approval
      // path re-verifies digests instead of trusting anything carried in run state.
      const sources = sourcesFromCapabilities(input.kbRoot, gate.source_capability_ids ?? []);
      const { result } = approveGate(input.kbRoot, sources, input.runId);
      const generationId = (result.ids ?? []).find((id) => id.startsWith("gen_")) ?? "";
      return { generationId, counts: result.counts ?? {} };
    },
    deny(input) {
      denyGate(input.kbRoot, input.runId);
    },
    claimSave(input) {
      const store = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, input.profileId));
      const existing = store.load(input.queryRunId);
      // Re-read the sealed answer's CURRENT digest so a drifted answer is
      // refused here rather than composed over.
      const digest = sealedAnswerDigest(
        input.kbRoot,
        input.queryRunId,
        existing.answer_artifact_id
      );
      const claim = store.claimForSave({
        query_run_id: input.queryRunId,
        kb_profile_id: input.profileId,
        save_run_id: input.saveRunId,
        save_transaction_id: input.transactionId,
        answer_sha256: digest ?? "",
      });
      return { answerArtifactId: claim.answer_artifact_id };
    },
    reserveSave(input) {
      new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, input.profileId)).reserveCommit({
        query_run_id: input.queryRunId,
        save_run_id: input.saveRunId,
      });
    },
    settleSave(input) {
      const store = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, input.profileId));
      if (input.outcome === "consumed") {
        store.consume({ query_run_id: input.queryRunId, save_run_id: input.saveRunId });
        return;
      }
      if (input.outcome === "invalidated") {
        store.invalidate(input.queryRunId);
        return;
      }
      const claim = store.find(input.queryRunId);
      const digest =
        claim === undefined
          ? undefined
          : sealedAnswerDigest(input.kbRoot, input.queryRunId, claim.answer_artifact_id);
      store.release({
        query_run_id: input.queryRunId,
        save_run_id: input.saveRunId,
        answer_sha256: digest,
      });
    },
    verifyPromotion(input) {
      const refs = Array.isArray(input.pageRevisions)
        ? (input.pageRevisions as Array<Record<string, unknown>>)
            .filter((r) => typeof r?.page_id === "string" && typeof r?.revision_id === "string")
            .map((r) => ({ page_id: String(r.page_id), revision_id: String(r.revision_id) }))
        : [];
      const report = verifyPromotionCandidate({
        kbRoot: input.kbRoot,
        pageRevisions: refs,
        targetCapabilityIds: input.targetCapabilityIds,
      });
      const store = new RunArtifactStore(input.kbRoot, input.runId);
      try {
        const handle = store.stage({
          state_id: "promotion_verification",
          kb_profile_id: input.profileId,
          artifact_kind: "verification_report",
          content: JSON.stringify(report),
        });
        return { artifactId: handle.artifact_id, verified: report.verified };
      } finally {
        store.close();
      }
    },
  };
}

/** The sealed answer's digest as recorded by the content plane, or undefined. */
function sealedAnswerDigest(
  kbRoot: string,
  queryRunId: string,
  artifactId: string
): Sha256Hex | undefined {
  const store = new RunArtifactStore(kbRoot, queryRunId);
  try {
    return store.read(artifactId).handle.sha256;
  } catch {
    return undefined;
  } finally {
    store.close();
  }
}
