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
 * `resolveKbRoot` resolves the opaque profile id through the owner-only registry and
 * requires an unexpired grant for the active Pi session. A root supplied by a caller
 * is never accepted or reconstructed from the profile id.
 */

import path from "node:path";

import type { Checkpointer } from "../checkpointer.js";
import { resolveGrantedProfile } from "./profile-registry.js";
import {
  claimCapabilities,
  denyGate,
  discardSourceAdmissions,
  invalidateCapabilities,
  persistIngestGate,
  sourcesFromAdmissions,
  type GateState,
} from "./gate.js";
import { CapabilityStore } from "./capabilities.js";
import { readCurrent, readPolicy } from "./filesystem.js";
import { RunArtifactStore, type ArtifactHandle } from "./run-artifacts.js";
import {
  canonicalJson,
  sha256Hex,
  type QueryKbRequest,
  type SaveKbRequest,
  type Sha256Hex,
} from "./contracts.js";
import { validateQueryRequest } from "./parent-delivery.js";
import { approveIngest, sourceRecordFor } from "./ingest.js";
import { admitKbRun, queryKb, recheckAdmittedPolicy } from "./workflows.js";
import { citationsBelongToSelection, selectQueryCandidates } from "./query-reader.js";
import { assessQueryVerification } from "./query-verification.js";
import { SaveQueryClaimStore, saveClaimStoreDir, validateSaveRequest } from "./save-claim.js";
import { verifyPromotionCandidate } from "./promote.js";
import { PromotionApprovalStore } from "./promotion.js";
import {
  buildContentReviewPacket,
  validateContentReviewPacket,
  verifyLiveContentReviewBindings,
} from "./content-review.js";
import type { ContentReviewGatePacket } from "./contracts.js";

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
 * §5.6 the safe projection of one query preparation/finalization — metadata the
 * playbook may carry in control state. Content-free: counts, opaque page ids, ONE
 * path-free handle, bounded warnings. Never the query text, the answer text,
 * or a path.
 */
export interface KbQueryOutcome {
  readonly status: "complete" | "refused";
  readonly met: boolean;
  readonly kbId?: string;
  readonly candidateCount: number;
  readonly pageIds: readonly string[];
  readonly answerHandle?: ArtifactHandle;
  readonly selectedGenerationId?: string;
  readonly groundingRequired: boolean;
  readonly warnings: readonly string[];
  readonly unresolved: readonly string[];
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
  }): { policy_sha256: string; kb_id: string };
  /** Recheck the exact admitted policy before status/resume/gate/publication. */
  recheckPolicy(input: { kbRoot: string; admittedPolicySha256: string }): void;
  /**
   * §5.6 — validate the run's stored closed request against its admitted
   * digest. The document arrives read-only through the custody seam; this
   * method derives the canonical digest from the SAME bytes and refuses any
   * drift before the closed-schema validation admits it. Optional capability:
   * a plane that does not declare it cannot serve query starts.
   */
  readStartRequest?(input: { request: unknown; expectedSha256: string }): QueryKbRequest;
  /** Save titles remain in the same private-input custody plane as query text. */
  readSaveStartRequest?(input: { request: unknown; expectedSha256: string }): SaveKbRequest;
  /**
   * §5.6 — begin the query. An explicit `verify_grounding:false` request runs
   * deterministic retrieval and seals an explicitly unverified answer. The
   * default-true path binds one selected generation and candidate allowlist for
   * Synthia → Vera; it creates neither an answer nor a claim at this step.
   * Neither path writes the publication plane.
   */
  runQuery?(input: {
    projectRoot: string;
    kbRoot: string;
    profileId: string;
    runId: string;
    request: QueryKbRequest;
  }): KbQueryOutcome;
  /**
   * Seal and evaluate Synthia's answer plus Vera's report, then create the one
   * save claim only when the answer is cited, the citation set belongs to the
   * bound generation, and Vera's closed report passes every citation.
   */
  finalizeVerifiedQuery?(input: {
    projectRoot: string;
    kbRoot: string;
    profileId: string;
    runId: string;
    request: QueryKbRequest;
    selectedGenerationId: string;
    answerArtifactId: string;
    verificationArtifactId: string;
  }): KbQueryOutcome & { verificationArtifactId: string };
  /**
   * Bind the admitted source capabilities to this run, all-or-none.
   *
   * Claiming happens before any phase work: a capability that cannot be claimed
   * (expired, replayed, already bound to another run) must stop the run before an
   * agent reads anything, not after.
   */
  claim(input: {
    projectRoot: string;
    kbRoot: string;
    capabilityIds: readonly string[];
    runId: string;
    sessionId: string;
    profileId: string;
    operation: "ingest" | "promote";
  }): readonly string[];
  /**
   * Verify the run's already-created immutable source snapshots before phase
   * dispatch. This writes nothing to the publication plane; approved review is
   * the first operation allowed to publish source objects or records.
   */
  admit(input: {
    projectRoot: string;
    kbRoot: string;
    sourceIds: readonly string[];
    runId: string;
    sessionId: string;
    profileId: string;
    operation: "ingest";
  }): void;
  /** Seal the exact candidate set, freezing what the review gate will offer. */
  seal(input: KbSealInput): void;
  /**
   * Construct the complete canonical §5.1 packet before the engine atomically
   * stores it with `await_user`. No packet body is written under the KB root.
   */
  prepareContentReview(
    input: KbGateInput & {
      projectRoot: string;
      sessionId: string;
      challengeId: string;
      action: "ingest" | "save";
      queryRunId?: string;
      policySha256: string;
    }
  ): ContentReviewGatePacket;
  /**
   * §5.11 approval-DB-first promotion packet custody. This commits exact packet
   * JCS privately before the playbook may return an `awaiting_user` directive.
   */
  preparePromotionGate?(
    input: KbGateInput & {
      projectRoot: string;
      sessionId: string;
      challengeId: string;
      pageRevisions: readonly { page_id: string; revision_id: string }[];
    }
  ): { challengeId: string; packetSha256: string };
  /** Legacy non-promotion gate projection retained for standalone compatibility. */
  persistGate(input: KbGateInput): GateState;
  /** Publish an approved control-DB packet from snapshots, then consume exact leases. */
  approve(input: {
    projectRoot: string;
    kbRoot: string;
    runId: string;
    /** Exact host callback/publication transaction; never accepted from the model. */
    transactionId?: string;
    packet: ContentReviewGatePacket;
    capabilityIds: readonly string[];
  }): KbPublishOutcome;
  /** Deny a control-DB packet. Publishes nothing and invalidates the leases. */
  deny(input: {
    projectRoot: string;
    kbRoot: string;
    runId: string;
    packet?: ContentReviewGatePacket;
    capabilityIds?: readonly string[];
    action?: "ingest" | "save" | "promote";
  }): void;
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
  /**
   * Settle a save's claim after the publication attempt resolves.
   *
   * Production selector-proven consumption happens inside `approve`; this
   * seam handles only reversible pre-commit outcomes. `released` returns an ordinary
   * claimed row to available only while the sealed answer is still valid;
   * `invalidated` is the fail-closed direction when neither can be proven.
   */
  settleSave(input: {
    projectRoot: string;
    profileId: string;
    kbRoot: string;
    queryRunId: string;
    saveRunId: string;
    outcome: "released" | "invalidated";
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
    projectRoot: string;
    kbRoot: string;
    runId: string;
    sessionId: string;
    profileId: string;
    operation: "promote";
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
export function resolveKbRoot(projectRoot: string, profileId: string, sessionId: string): string {
  return resolveGrantedProfile({
    profileId,
    sessionId,
    registryPath: path.join(projectRoot, ".penny", "kb-profiles.json"),
    grantStoreDir: path.join(projectRoot, ".penny", "kb-host-grants"),
  }).resolvedRoot;
}

/** The real plane, over the existing KB modules. */
export function defaultKbIngestPlane(
  checkpointer?: Checkpointer,
  options: { testOnlyLegacyReview?: boolean } = {}
): KbIngestPlaneV1 {
  const publicationCheckpointer = options.testOnlyLegacyReview === true ? undefined : checkpointer;
  const artifactControl = (): Checkpointer => {
    if (checkpointer === undefined) {
      throw new Error("KB artifact work requires the orchestration control DB");
    }
    return checkpointer;
  };
  return {
    admitRun(input) {
      const { policy_sha256, kb_id } = admitKbRun({
        kbRoot: input.kbRoot,
        parentIdentity: input.parentIdentity,
      });
      return { policy_sha256, kb_id };
    },
    recheckPolicy(input) {
      recheckAdmittedPolicy(input);
    },
    readStartRequest(input) {
      const derived = sha256Hex(canonicalJson(input.request));
      if (derived !== input.expectedSha256) {
        throw new Error(
          "the stored request does not canonicalize to its admitted digest; refusing to bind it"
        );
      }
      return validateQueryRequest(input.request);
    },
    readSaveStartRequest(input) {
      const derived = sha256Hex(canonicalJson(input.request));
      if (derived !== input.expectedSha256) {
        throw new Error(
          "the stored save request does not canonicalize to its admitted digest; refusing to bind it"
        );
      }
      return validateSaveRequest(input.request);
    },
    runQuery(input) {
      const request = input.request;
      if (request.verify_grounding === false) {
        const result = queryKb(
          {
            kbRoot: input.kbRoot,
            profileId: input.profileId,
            runId: input.runId,
            checkpointer: artifactControl(),
          },
          request.query,
          {
            ...(request.max_candidates !== undefined
              ? { maxCandidates: request.max_candidates }
              : {}),
            ...(request.page_ids !== undefined ? { pageIds: request.page_ids } : {}),
            ...(request.source_ids !== undefined ? { sourceIds: request.source_ids } : {}),
            verifyGrounding: false,
          }
        );
        const handle = result.artifacts[0];
        return {
          status: result.status === "complete" ? "complete" : "refused",
          met: result.met === true,
          ...(result.kb_id !== undefined ? { kbId: result.kb_id } : {}),
          candidateCount: result.counts["candidates"] ?? 0,
          pageIds: [...result.ids],
          ...(handle !== undefined ? { answerHandle: handle } : {}),
          groundingRequired: false,
          warnings: [...result.warnings],
          unresolved: [...result.unresolved],
        };
      }

      // Default-true path: bind the exact selected generation and candidate
      // allowlist, but do not synthesize an answer here. Synthia and Vera must
      // run through the engine/session seams before an answer can gain claim or
      // parent-delivery authority.
      const selection = selectQueryCandidates({ kbRoot: input.kbRoot, request });
      if (selection === undefined) {
        return {
          status: "refused",
          met: false,
          candidateCount: 0,
          pageIds: [],
          groundingRequired: false,
          warnings: ["No KB is initialized at this profile"],
          unresolved: [],
        };
      }
      if (selection.candidates.length === 0) {
        const empty = queryKb(
          {
            kbRoot: input.kbRoot,
            profileId: input.profileId,
            runId: input.runId,
            checkpointer: artifactControl(),
          },
          request.query,
          {
            ...(request.max_candidates !== undefined
              ? { maxCandidates: request.max_candidates }
              : {}),
            ...(request.page_ids !== undefined ? { pageIds: request.page_ids } : {}),
            ...(request.source_ids !== undefined ? { sourceIds: request.source_ids } : {}),
            verifyGrounding: false,
          }
        );
        return {
          status: "complete",
          met: false,
          kbId: selection.kbId,
          candidateCount: 0,
          pageIds: [],
          ...(empty.artifacts[0] !== undefined ? { answerHandle: empty.artifacts[0] } : {}),
          selectedGenerationId: selection.generationId,
          groundingRequired: false,
          warnings: [...empty.warnings],
          unresolved: [...empty.unresolved],
        };
      }
      return {
        status: "complete",
        met: false,
        kbId: selection.kbId,
        candidateCount: selection.candidates.length,
        pageIds: selection.candidates.map((candidate) => candidate.page_id),
        selectedGenerationId: selection.generationId,
        groundingRequired: true,
        warnings: [],
        unresolved: [...selection.unresolved],
      };
    },
    finalizeVerifiedQuery(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId, artifactControl());
      try {
        const answerRecord = store.read(input.answerArtifactId);
        const verificationRecord = store.read(input.verificationArtifactId);
        let answerDocument: unknown;
        let verificationDocument: unknown;
        try {
          answerDocument = JSON.parse(answerRecord.content) as unknown;
          verificationDocument = JSON.parse(verificationRecord.content) as unknown;
        } catch {
          answerDocument = null;
          verificationDocument = null;
        }
        const assessment = assessQueryVerification(
          answerDocument,
          verificationDocument,
          answerRecord.handle
        );
        let selection: ReturnType<typeof selectQueryCandidates>;
        try {
          selection = selectQueryCandidates({
            kbRoot: input.kbRoot,
            request: input.request,
            expectedGenerationId: input.selectedGenerationId,
          });
        } catch {
          selection = undefined;
        }
        const citationsSupported =
          input.request.verify_grounding !== false &&
          assessment.passed &&
          assessment.answer !== undefined &&
          selection !== undefined &&
          citationsBelongToSelection(selection, assessment.answer);

        // Freeze both records regardless of pass/fail. A failed report remains
        // honest evidence, but it grants no save or delivery authority.
        store.seal([input.answerArtifactId, input.verificationArtifactId]);

        let saveClaimAvailable = false;
        if (citationsSupported && selection !== undefined) {
          try {
            const claimStore = new SaveQueryClaimStore(
              saveClaimStoreDir(input.projectRoot, input.profileId)
            );
            const existing = claimStore.find(input.runId);
            if (existing !== undefined) {
              saveClaimAvailable =
                existing.kb_profile_id === input.profileId &&
                existing.kb_id === selection.kbId &&
                existing.answer_artifact_id === answerRecord.handle.artifact_id &&
                existing.answer_sha256 === answerRecord.handle.sha256;
            } else {
              claimStore.create({
                query_run_id: input.runId,
                kb_profile_id: input.profileId,
                kb_id: selection.kbId,
                answer_artifact_id: answerRecord.handle.artifact_id,
                answer_sha256: answerRecord.handle.sha256,
              });
              saveClaimAvailable = true;
            }
          } catch {
            saveClaimAvailable = false;
          }
        }
        const met = citationsSupported && saveClaimAvailable;
        return {
          status: "complete",
          met,
          ...(selection !== undefined ? { kbId: selection.kbId } : {}),
          candidateCount: selection?.candidates.length ?? 0,
          pageIds: selection?.candidates.map((candidate) => candidate.page_id) ?? [],
          answerHandle: answerRecord.handle,
          selectedGenerationId: input.selectedGenerationId,
          groundingRequired: true,
          verificationArtifactId: verificationRecord.handle.artifact_id,
          warnings: [
            ...(!citationsSupported ? ["grounding_verification_failed"] : []),
            ...(citationsSupported && !saveClaimAvailable ? ["save_claim_unavailable"] : []),
          ],
          unresolved: [
            ...(!citationsSupported
              ? [assessment.reason ?? "answer citations are outside the bound candidate set"]
              : []),
            ...(citationsSupported && !saveClaimAvailable
              ? ["verified query result is not saveable"]
              : []),
          ],
        };
      } finally {
        store.close();
      }
    },
    claim(input) {
      return claimCapabilities({
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
        capabilityIds: input.capabilityIds,
        runId: input.runId,
        transactionId: input.runId,
        sessionId: input.sessionId,
        profileId: input.profileId,
        kind: input.operation === "ingest" ? "source_read" : "canonical_target",
        operation: input.operation,
        ...(input.operation === "ingest"
          ? { maxSourceBytes: readPolicy(input.kbRoot).reader_limits.max_call_utf8_bytes }
          : {}),
      });
    },
    admit(input) {
      // Admission is now a verification-only seam: claim() already preindexed
      // and atomically created every immutable snapshot before returning.
      void sourcesFromAdmissions(input.projectRoot, input.kbRoot, input.sourceIds, {
        runId: input.runId,
        transactionId: input.runId,
        sessionId: input.sessionId,
        profileId: input.profileId,
      });
    },
    seal(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId, artifactControl());
      try {
        store.seal(input.artifactIds);
      } finally {
        store.close();
      }
    },
    prepareContentReview(input) {
      const sourceRecordDigests =
        input.action === "ingest"
          ? Object.fromEntries(
              sourcesFromAdmissions(input.projectRoot, input.kbRoot, input.sourceIds, {
                runId: input.runId,
                transactionId: input.runId,
                sessionId: input.sessionId,
                profileId: input.profileId,
              }).map((source) => [
                source.sourceId,
                sha256Hex(canonicalJson(sourceRecordFor(source, input.runId))),
              ])
            )
          : {};
      return buildContentReviewPacket({
        kbRoot: input.kbRoot,
        runId: input.runId,
        sessionId: input.sessionId,
        challengeId: input.challengeId,
        profileId: input.profileId,
        action: input.action,
        ...(input.queryRunId !== undefined ? { queryRunId: input.queryRunId } : {}),
        artifactIds: input.artifactIds,
        sourceRecordDigests,
        policySha256: input.policySha256,
        checkpointer: artifactControl(),
      });
    },
    preparePromotionGate(input) {
      if (input.artifactIds.length !== 3) {
        throw new Error(
          "promotion approval packet requires plan, patch, and verification artifacts"
        );
      }
      const store = new PromotionApprovalStore({
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
        artifactCheckpointer: artifactControl(),
      });
      try {
        const record = store.storePreparedGate({
          runId: input.runId,
          sessionId: input.sessionId,
          challengeId: input.challengeId,
          profileId: input.profileId,
          pageRevisions: input.pageRevisions,
          targetCapabilityIds: input.capabilityIds,
          planArtifactId: input.artifactIds[0]!,
          patchArtifactId: input.artifactIds[1]!,
          verificationArtifactId: input.artifactIds[2]!,
        });
        return { challengeId: record.challenge_id, packetSha256: record.packet_sha256 };
      } finally {
        store.close();
      }
    },
    persistGate(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId, artifactControl());
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
      const packet = validateContentReviewPacket(input.packet);
      if (packet.run_id !== input.runId) {
        throw new Error("content-review packet belongs to another run");
      }
      verifyLiveContentReviewBindings({
        projectRoot: input.projectRoot,
        packet,
        checkpointer: artifactControl(),
      });
      const byKind = (kind: "page_draft" | "lint_report" | "verification_report"): string => {
        const handle = packet.candidate_artifacts.find(
          (candidate) => candidate.artifact_kind === kind
        );
        if (handle === undefined) throw new Error(`content-review packet has no '${kind}' handle`);
        return handle.artifact_id;
      };
      // Re-resolve external source bytes from the exact run-bound capability set;
      // the packet separately binds the admitted source-record digests.
      const sourceIds = Object.keys(packet.candidate_source_record_digests);
      const sources =
        packet.action === "ingest"
          ? sourcesFromAdmissions(input.projectRoot, input.kbRoot, sourceIds, {
              runId: packet.run_id,
              transactionId: packet.run_id,
              sessionId: packet.session_id,
              profileId: packet.kb_profile_id,
            })
          : [];
      const publicationTransactionId = input.transactionId ?? input.runId;
      const publicationAuthority =
        publicationCheckpointer === undefined
          ? undefined
          : packet.action === "ingest"
            ? {
                reserve(transactionId: string) {
                  using capabilities = new CapabilityStore(input.projectRoot);
                  capabilities.reserveSourceCommitAll(
                    input.capabilityIds,
                    input.runId,
                    transactionId
                  );
                },
                finalize(transactionId: string) {
                  using capabilities = new CapabilityStore(input.projectRoot);
                  capabilities.settlePublishedSources({
                    capabilityIds: input.capabilityIds,
                    sourceIds,
                    runId: input.runId,
                    transactionId,
                  });
                },
                abort(transactionId: string) {
                  using capabilities = new CapabilityStore(input.projectRoot);
                  capabilities.invalidateSourceCommitAll(
                    input.capabilityIds,
                    input.runId,
                    transactionId
                  );
                },
              }
            : {
                reserve(transactionId: string) {
                  using store = new SaveQueryClaimStore(
                    saveClaimStoreDir(input.projectRoot, packet.kb_profile_id)
                  );
                  store.reserveCommit({
                    query_run_id: packet.query_run_id!,
                    save_run_id: input.runId,
                    publication_transaction_id: transactionId,
                  });
                },
                finalize(transactionId: string) {
                  using store = new SaveQueryClaimStore(
                    saveClaimStoreDir(input.projectRoot, packet.kb_profile_id)
                  );
                  store.consume({
                    query_run_id: packet.query_run_id!,
                    save_run_id: input.runId,
                    publication_transaction_id: transactionId,
                  });
                },
                abort(transactionId: string) {
                  using store = new SaveQueryClaimStore(
                    saveClaimStoreDir(input.projectRoot, packet.kb_profile_id)
                  );
                  const claim = store.load(packet.query_run_id!);
                  if (claim.save_transaction_id !== transactionId) {
                    throw new Error("save claim abort transaction is not exact");
                  }
                  store.invalidate(packet.query_run_id!, input.runId);
                },
              };
      let result: ReturnType<typeof approveIngest>;
      try {
        result = approveIngest(
          {
            kbRoot: input.kbRoot,
            profileId: packet.kb_profile_id,
            runId: packet.run_id,
            checkpointer: artifactControl(),
          },
          sources,
          {
            runId: packet.run_id,
            sourceIds,
            pageDraftArtifactId: byKind("page_draft"),
            lintReportArtifactId: byKind("lint_report"),
            verificationArtifactId: byKind("verification_report"),
            candidateConflictAllocations: packet.candidate_conflict_allocations,
            reviewIssuedAt: packet.issued_at,
          },
          publicationCheckpointer === undefined
            ? undefined
            : {
                checkpointer: publicationCheckpointer,
                transactionId: publicationTransactionId,
                baseGenerationId: packet.base_generation_id,
                baseSelectorSha256: packet.base_selector_sha256,
                action: packet.action,
                publishedAt: packet.issued_at,
                ...(publicationAuthority !== undefined ? { authority: publicationAuthority } : {}),
                requireContentReview: true,
                awaitOperationReceipt: true,
              }
        );
      } catch (error) {
        let selectorCommitted = false;
        if (publicationCheckpointer !== undefined) {
          try {
            publicationCheckpointer.kbPublicationSelectorEvidence({
              transaction_id: publicationTransactionId,
              run_id: input.runId,
              candidate_generation_id: `gen_${sha256Hex(publicationTransactionId).slice(0, 40)}`,
            });
            selectorCommitted = true;
          } catch {
            const publication = publicationCheckpointer.kbPublication(publicationTransactionId);
            const current = readCurrent(input.kbRoot);
            selectorCommitted =
              publication?.selector_jcs !== undefined &&
              publication.selector_sha256 !== undefined &&
              current?.generation_id === publication.candidate_generation_id &&
              canonicalJson(current) === publication.selector_jcs &&
              sha256Hex(canonicalJson(current)) === publication.selector_sha256;
          }
        }
        if (packet.action === "ingest" && !selectorCommitted) {
          const publicationDiscarded =
            publicationCheckpointer?.kbPublication(publicationTransactionId)?.lifecycle ===
            "discarded";
          discardSourceAdmissions({
            projectRoot: input.projectRoot,
            kbRoot: input.kbRoot,
            runId: input.runId,
            transactionId: input.runId,
            capabilityIds: input.capabilityIds,
            invalidateClaims: !publicationDiscarded,
          });
        }
        throw error;
      }
      if (result.status !== "complete" || !result.met) {
        if (packet.action === "ingest") {
          discardSourceAdmissions({
            projectRoot: input.projectRoot,
            kbRoot: input.kbRoot,
            runId: input.runId,
            transactionId: input.runId,
            capabilityIds: input.capabilityIds,
            invalidateClaims: true,
          });
        }
        throw new Error(result.warnings[0] ?? "approved content-review publication was refused");
      }
      if (packet.action === "ingest" && publicationCheckpointer === undefined) {
        using capabilities = new CapabilityStore(input.projectRoot);
        capabilities.reserveSourceCommitAll(input.capabilityIds, input.runId, input.runId);
        capabilities.settlePublishedSources({
          capabilityIds: input.capabilityIds,
          sourceIds,
          runId: input.runId,
          transactionId: input.runId,
        });
      }
      const artifactStore = new RunArtifactStore(input.kbRoot, input.runId, artifactControl());
      try {
        artifactStore.consume(packet.candidate_artifacts.map((artifact) => artifact.artifact_id));
      } finally {
        artifactStore.close();
      }
      const generationId = (result.ids ?? []).find((id) => id.startsWith("gen_")) ?? "";
      return { generationId, counts: result.counts ?? {} };
    },
    deny(input) {
      if (input.packet !== undefined || input.action === "ingest") {
        const packet =
          input.packet === undefined ? undefined : validateContentReviewPacket(input.packet);
        if (packet !== undefined && packet.run_id !== input.runId)
          throw new Error("content-review packet belongs to another run");
        if (packet?.action === "ingest" || input.action === "ingest") {
          discardSourceAdmissions({
            projectRoot: input.projectRoot,
            kbRoot: input.kbRoot,
            runId: input.runId,
            transactionId: input.runId,
            capabilityIds: input.capabilityIds ?? [],
            invalidateClaims: true,
          });
        }
        return;
      }
      // Promotion decisions are already durable in the approval DB. The plane
      // settles only the exact target claims; no KB-root gate row is authority.
      if (input.capabilityIds !== undefined) {
        invalidateCapabilities(input.projectRoot, input.capabilityIds, {
          runId: input.runId,
          transactionId: input.runId,
        });
        return;
      }
      denyGate(input.kbRoot, input.runId, input.projectRoot);
    },
    claimSave(input) {
      const store = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, input.profileId));
      const existing = store.load(input.queryRunId);
      // Re-read the sealed answer's CURRENT digest so a drifted answer is
      // refused here rather than composed over.
      const digest = sealedAnswerDigest(
        input.kbRoot,
        input.queryRunId,
        existing.answer_artifact_id,
        artifactControl()
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
    settleSave(input) {
      const store = new SaveQueryClaimStore(saveClaimStoreDir(input.projectRoot, input.profileId));
      if (input.outcome === "invalidated") {
        store.invalidate(input.queryRunId, input.saveRunId);
        return;
      }
      const claim = store.find(input.queryRunId);
      const digest =
        claim === undefined
          ? undefined
          : sealedAnswerDigest(
              input.kbRoot,
              input.queryRunId,
              claim.answer_artifact_id,
              artifactControl()
            );
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
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
        runId: input.runId,
        sessionId: input.sessionId,
        profileId: input.profileId,
        operation: input.operation,
        pageRevisions: refs,
        targetCapabilityIds: input.targetCapabilityIds,
      });
      const store = new RunArtifactStore(input.kbRoot, input.runId, artifactControl());
      try {
        const handle = store.stage({
          state_id: "promotion_verification",
          kb_profile_id: input.profileId,
          artifact_kind: "verification_report",
          content: canonicalJson(report),
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
  artifactId: string,
  checkpointer: Checkpointer
): Sha256Hex | undefined {
  const store = new RunArtifactStore(kbRoot, queryRunId, checkpointer);
  try {
    return store.read(artifactId).handle.sha256;
  } catch {
    return undefined;
  } finally {
    store.close();
  }
}
