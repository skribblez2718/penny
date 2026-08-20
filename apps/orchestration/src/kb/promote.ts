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
 * behind the host-only approval path at G9. A packet produced here is evidence
 * for a human, never authority.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";

import {
  validateKbContract,
  PromoteKbRequestSchema,
  PromotionVerificationSchema,
  type PageRevisionRef,
  type PromoteKbRequest,
  type PromotionVerification,
  type Sha256Hex,
} from "./contracts.js";
import { loadEnvelope } from "./gate.js";
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

function sha256Of(bytes: Buffer): Sha256Hex {
  return createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
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
  kbRoot: string;
  pageRevisions: readonly PageRevisionRef[];
  targetCapabilityIds: readonly string[];
}): PromotionVerification {
  const findings: string[] = [];
  const targets: PromotionVerification["targets"] = [];

  for (const capId of input.targetCapabilityIds) {
    let authorityRoot: string | undefined;
    let exists = false;
    let preimage: Sha256Hex | undefined;
    try {
      const env = loadEnvelope(input.kbRoot, capId);
      if (env.kind !== "canonical_target") {
        findings.push(`capability '${capId}' is not a canonical_target capability`);
      }
      if (env.allowed_operation !== "promote") {
        findings.push(`capability '${capId}' does not allow the promote operation`);
      }
      authorityRoot = env.authority_root;
      if (authorityRoot === undefined || authorityRoot.length === 0) {
        findings.push(`capability '${capId}' carries no authority_root`);
      }
      // Capture the CURRENT preimage: what an apply would have to still find.
      const target = env.resolved_path;
      if (existsSync(target) && lstatSync(target).isFile()) {
        exists = true;
        preimage = sha256Of(readFileSync(target));
      } else {
        findings.push(`target for '${capId}' does not currently exist as a regular file`);
      }
    } catch (err) {
      findings.push(
        `target capability '${capId}' did not resolve: ${String((err as Error).message ?? err).slice(0, 200)}`
      );
    }
    targets.push({
      capability_id: capId,
      ...(authorityRoot !== undefined && authorityRoot.length > 0
        ? { authority_root: authorityRoot }
        : {}),
      exists,
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
  return validateKbContract(PromotionVerificationSchema, report, "promotion verification");
}
