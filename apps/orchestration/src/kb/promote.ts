/**
 * §5.11 promotion — **prepare and verify only**.
 *
 * Promotion is an authority transition, not a KB write, so nothing in this
 * module mutates a canonical target. It resolves exact host-minted target
 * capabilities, captures each target's CURRENT preimage digest, confirms the
 * named page revisions are actually selected, and produces the host's own
 * verification finding for the review packet.
 *
 * What is deliberately ABSENT is the point of the module: no approval decision,
 * no signature, no apply journal, no write, no commit, no push. Those live
 * behind the separate host-only G9 approval/apply service. A packet produced here is evidence
 * for a human, never authority.
 */

import {
  validateKbContract,
  PromoteKbRequestSchema,
  PromotionVerificationSchema,
  type PageRevisionRef,
  type PromoteKbRequest,
  type PromotionVerification,
  type Sha256Hex,
} from "./contracts.js";
import { readClaimedCanonicalTarget } from "./gate.js";
import { readSelectedGeneration } from "./generations.js";

/** §5.6 closed validation for the public `promote` request. */
export function validatePromoteRequest(raw: unknown): PromoteKbRequest {
  const request = validateKbContract(PromoteKbRequestSchema, raw, "promote request");
  // §5.6: page revisions sort by UTF-8 (page_id, revision_id) and must be unique
  // as pairs. Sorting is part of the contract because the request digest and the
  // packet must not depend on caller ordering.
  const keys = request.page_revisions.map((r) => `${r.page_id}\u0000${r.revision_id}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("promote request: page_revisions must be unique");
  }
  return {
    ...request,
    page_revisions: [...request.page_revisions].sort((a, b) =>
      a.page_id < b.page_id
        ? -1
        : a.page_id > b.page_id
          ? 1
          : a.revision_id < b.revision_id
            ? -1
            : a.revision_id > b.revision_id
              ? 1
              : 0
    ),
    canonical_target_capability_ids: [...request.canonical_target_capability_ids].sort(),
  };
}

/**
 * The host's independent verification of a promotion candidate.
 *
 * Every finding here is the host's own read, never a child's claim:
 *
 * - each target capability must resolve, be a `canonical_target`, and carry the
 *   `promote` operation \u2014 a source capability can never be promoted to;
 * - each target's current bytes are hashed into a **preimage digest**, which is
 *   what a later apply would have to still find in place;
 * - each named page revision must be the one the selected generation actually
 *   selects, so a promotion cannot quietly reference a superseded revision.
 *
 * A failed check is recorded as a bounded finding with `verified: false`. It is
 * not an exception, because an honest "this cannot be promoted as stated" is a
 * legitimate result of preparing.
 */
export function verifyPromotionCandidate(input: {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  sessionId: string;
  profileId: string;
  operation: "promote";
  pageRevisions: readonly PageRevisionRef[];
  targetCapabilityIds: readonly string[];
}): PromotionVerification {
  const findings: string[] = [];
  const targets: PromotionVerification["targets"] = [];

  if (new Set(input.targetCapabilityIds).size !== input.targetCapabilityIds.length) {
    throw new Error("promotion verification target capability ids are duplicated");
  }
  const orderedTargetIds = [...input.targetCapabilityIds];

  for (const capId of orderedTargetIds) {
    let preimage: Sha256Hex | undefined;
    try {
      if (input.operation !== "promote") {
        throw new Error("promotion verification has the wrong operation binding");
      }
      const target = readClaimedCanonicalTarget({
        projectRoot: input.projectRoot,
        capabilityId: capId,
        runId: input.runId,
        sessionId: input.sessionId,
        profileId: input.profileId,
      });
      preimage = target.sha256 as Sha256Hex;
    } catch (err) {
      findings.push(
        `target capability '${capId}' did not resolve: ${String((err as Error).message ?? err).slice(0, 200)}`
      );
    }
    targets.push({
      capability_id: capId,
      ...(preimage !== undefined ? { preimage_sha256: preimage } : {}),
    });
  }

  // The named revisions must be the ones actually selected right now.
  const selected = readSelectedGeneration(input.kbRoot);
  if (selected === undefined) {
    findings.push("no generation is selected; nothing can be promoted");
  } else {
    for (const ref of input.pageRevisions) {
      const entry = selected.catalog.pages[ref.page_id];
      if (entry === undefined) {
        findings.push(`page '${ref.page_id}' is not in the selected generation`);
      } else if (entry.revision_id !== ref.revision_id) {
        findings.push(
          `page '${ref.page_id}' selects a different revision than the one named for promotion`
        );
      }
    }
  }

  const report: PromotionVerification = {
    schema_version: 1,
    artifact_kind: "verification_report",
    verified: findings.length === 0,
    page_revisions: input.pageRevisions.map((r) => ({ ...r })),
    targets,
    findings: findings.slice(0, 64),
  };
  const validated = validateKbContract(
    PromotionVerificationSchema,
    report,
    "promotion verification"
  );
  if (
    validated.targets.map((target) => target.capability_id).join("\u0000") !==
      orderedTargetIds.join("\u0000") ||
    (validated.verified && validated.targets.some((target) => target.preimage_sha256 === undefined))
  ) {
    throw new Error("promotion verification targets are not the exact ordered request projection");
  }
  return validated;
}
