import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore, type ArtifactHostStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  sealAttempt,
  sealOperationId,
  type SealAttemptInputV1,
  type SealProjectionV1,
} from "../dist/playbooks/seal-attempt.js";
import {
  sealPolicySha256,
  sealDiagnosticsProjection,
  validateSealDiagnostic,
  validateSealDiagnosticsProjection,
  validateSealPolicy,
  type SealPolicyV1,
} from "../dist/skill-contracts/sealing.js";

const policy: SealPolicyV1 = {
  schema_id: "penny.seal-policy.v1",
  schema_version: 1,
  skill: "assess",
  draft_phase: "authoring_assessment",
  seal_phase: "sealing_assessment",
  draft_schema: "penny.assessment-draft.v2",
  draft_schema_version: 2,
  draft_kind: "assessment-draft",
  product_kind: "semantic-core",
  correction_limit: 1,
  diagnostic_schema: "penny.seal-diagnostic.v1",
};
const roots: string[] = [];
const stores: ArtifactStore[] = [];
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-seal-attempt-"));
  roots.push(root);
  const instance = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: `prj_${"0".repeat(32)}`,
  });
  stores.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of stores.splice(0)) instance.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function draft(artifacts: ArtifactStore, version: number): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: "run-one",
      phase: "authoring_assessment",
      branch_id: null,
      kind: "assessment-draft",
      operation_id: `draft-${version}`,
      version: 1,
      producer: "agent:carren",
      media_type: "application/json",
      content_schema: { schema_id: policy.draft_schema, schema_version: 2 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: `draft-${version}`,
  });
}

const issue = {
  code: "MISSING_SOURCE",
  path: "/coverage",
  detail: "Missing source 0",
  source_ordinals: [0],
};
function rejected(): SealProjectionV1 {
  return { status: "rejected", failure_class: "SEMANTIC_INVALID", issues: [issue] };
}
function accepted(text = "good"): SealProjectionV1 {
  return {
    status: "sealed",
    content: canonicalJson({ schema_version: 1, text }),
    content_schema: { schema_id: "penny.assessment.v1", schema_version: 1 },
    upstream_refs: [],
    revision_parent_ref: null,
  };
}
function attempt(
  artifacts: ArtifactHostStore,
  draftRef: ArtifactRef,
  project: () => SealProjectionV1,
  options: {
    readonly anchor?: ArtifactRef | null;
    readonly previous?: ArtifactRef | null;
    readonly ordinal?: number;
  } = {}
): SealAttemptInputV1 {
  return {
    store: artifacts,
    policy,
    registered_policy_sha256: sealPolicySha256(policy),
    run_id: "run-one",
    phase: "sealing_assessment",
    branch_id: null,
    draft_ref: draftRef,
    epoch_anchor_ref: options.anchor ?? null,
    previous_diagnostic_ref: options.previous ?? null,
    rejection_ordinal: options.ordinal ?? 0,
    project: () => project(),
    validate_product_bytes: (bytes) => {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (bytes.toString("utf8") !== canonicalJson(value)) throw new Error("not canonical");
    },
  };
}

describe("registered seal contracts", () => {
  it("persists and re-adopts unlimited corrections beyond the former allowance without fake caps", () => {
    const artifacts = store();
    const unlimited = validateSealPolicy({ ...policy, correction_limit: null });
    let previous: ArtifactRef | null = null;
    for (let index = 0; index < 6; index += 1) {
      const input = {
        ...attempt(artifacts, draft(artifacts, index + 1), rejected, { previous, ordinal: index }),
        policy: unlimited,
        registered_policy_sha256: sealPolicySha256(unlimited),
      };
      const result = sealAttempt(input);
      if (result.status !== "rejected") throw new Error("unlimited seal correction failed");
      expect(result.diagnostic).toMatchObject({
        correction_limit: null,
        corrections_used: index,
        rejection_ordinal: index + 1,
        disposition: "correction_offered",
      });
      expect(sealAttempt(input)).toEqual({ ...result, adopted: true });
      expect(
        validateSealDiagnosticsProjection(
          sealDiagnosticsProjection(result.diagnostic, result.diagnostic_ref, unlimited)
        )
      ).toMatchObject({ correction_limit: null });
      expect(() =>
        validateSealDiagnostic({ ...result.diagnostic, disposition: "exhausted" }, unlimited)
      ).toThrow();
      previous = result.diagnostic_ref;
    }
    const result = sealAttempt({
      ...attempt(artifacts, draft(artifacts, 7), accepted, { previous, ordinal: 6 }),
      policy: unlimited,
      registered_policy_sha256: sealPolicySha256(unlimited),
    });
    expect(result.status).toBe("sealed");
  });

  it("closes policy, diagnostic, projection and exact per-epoch counters", () => {
    expect(validateSealPolicy(policy)).toEqual(policy);
    expect(() => validateSealPolicy({ ...policy, correction_limit: -1 })).toThrow();
    expect(() => validateSealPolicy({ ...policy, worker_allowance: 500 })).toThrow();
    const artifacts = store();
    const result = sealAttempt(attempt(artifacts, draft(artifacts, 1), rejected));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("expected exact diagnostic");
    const { diagnostic, diagnostic_ref } = result;
    expect(diagnostic.rejection_ordinal).toBe(1);
    expect(diagnostic.corrections_used).toBe(0);
    expect(diagnostic.disposition).toBe("correction_offered");
    expect(validateSealDiagnostic(diagnostic, policy)).toEqual(diagnostic);
    expect(() => validateSealDiagnostic({ ...diagnostic, issue_count: 0 }, policy)).toThrow();
    expect(() =>
      validateSealDiagnostic({ ...diagnostic, disposition: "exhausted" }, policy)
    ).toThrow();
    expect(() => validateSealDiagnostic({ ...diagnostic, extra: true }, policy)).toThrow();
    expect(() =>
      validateSealDiagnostic(
        { ...diagnostic, issues: [{ ...issue, detail: "x".repeat(513) }] },
        policy
      )
    ).toThrow();
    expect(() =>
      validateSealDiagnostic(
        { ...diagnostic, issues: [{ ...issue, path: "x".repeat(257) }] },
        policy
      )
    ).toThrow();
    expect(() =>
      validateSealDiagnostic(
        { ...diagnostic, issues: Array.from({ length: 1025 }, () => issue) },
        policy
      )
    ).toThrow();
    const projection = {
      latest_diagnostic_ref: diagnostic_ref,
      rejected_draft_ref: diagnostic.rejected_draft_ref,
      epoch_anchor_ref: null,
      corrections_used: 0,
      correction_limit: 1,
      disposition: "correction_offered",
    };
    expect(validateSealDiagnosticsProjection(projection)).toEqual(projection);
    expect(sealDiagnosticsProjection(diagnostic, diagnostic_ref, policy)).toEqual(projection);
    expect(() =>
      sealDiagnosticsProjection(diagnostic, diagnostic.rejected_draft_ref, policy)
    ).toThrow();
    expect(() =>
      validateSealDiagnosticsProjection({ ...projection, accepted_product_ref: diagnostic_ref })
    ).toThrow();
  });
});

describe("deterministic seal attempt", () => {
  it("persists first and final rejections, adopts both without extra versions, and resets on a new anchor", () => {
    const artifacts = store();
    const firstDraft = draft(artifacts, 1);
    const first = sealAttempt(attempt(artifacts, firstDraft, rejected));
    expect(first.status).toBe("rejected");
    if (first.status !== "rejected") throw new Error("missing first diagnostic");
    expect(sealAttempt(attempt(artifacts, firstDraft, rejected))).toMatchObject({
      status: "rejected",
      adopted: true,
      diagnostic_ref: first.diagnostic_ref,
    });
    expect(
      sealAttempt(
        attempt(artifacts, firstDraft, () => ({
          status: "rejected",
          failure_class: "SEMANTIC_INVALID",
          issues: [{ ...issue, detail: "changed detail" }],
        }))
      )
    ).toEqual({ status: "fault", code: "SEAL_OPERATION_CONFLICT" });
    const nextDraft = draft(artifacts, 2);
    const second = sealAttempt(
      attempt(artifacts, nextDraft, rejected, { previous: first.diagnostic_ref, ordinal: 1 })
    );
    expect(second.status).toBe("rejected");
    if (second.status !== "rejected") throw new Error("missing final diagnostic");
    expect(second.diagnostic).toMatchObject({
      rejection_ordinal: 2,
      corrections_used: 1,
      correction_limit: 1,
      disposition: "exhausted",
      previous_diagnostic_ref: first.diagnostic_ref,
    });
    expect(
      sealAttempt(
        attempt(artifacts, nextDraft, rejected, { previous: first.diagnostic_ref, ordinal: 1 })
      )
    ).toMatchObject({
      status: "rejected",
      adopted: true,
      diagnostic_ref: second.diagnostic_ref,
    });
    const newDraft = draft(artifacts, 3);
    const product = sealAttempt(attempt(artifacts, newDraft, accepted));
    expect(product.status).toBe("sealed");
    if (product.status !== "sealed") throw new Error("missing accepted product");
    const later = sealAttempt(
      attempt(artifacts, draft(artifacts, 4), rejected, { anchor: product.product_ref })
    );
    expect(later.status).toBe("rejected");
    if (later.status !== "rejected") throw new Error("missing new-epoch diagnostic");
    expect(later.diagnostic).toMatchObject({
      rejection_ordinal: 1,
      corrections_used: 0,
      epoch_anchor_ref: product.product_ref,
    });
    expect(
      sealAttempt(
        attempt(artifacts, draft(artifacts, 5), rejected, {
          anchor: product.product_ref,
          previous: first.diagnostic_ref,
          ordinal: 1,
        })
      )
    ).toEqual({
      status: "fault",
      code: "SEAL_INPUT_FAULT",
    });
  });

  it("adopts an accepted product and conflicts on changed bytes or metadata at the same address", () => {
    const artifacts = store();
    const ref = draft(artifacts, 1);
    const input = attempt(artifacts, ref, accepted);
    const first = sealAttempt(input);
    expect(first.status).toBe("sealed");
    if (first.status !== "sealed") throw new Error("missing product");
    expect(sealAttempt(input)).toMatchObject({
      status: "sealed",
      product_ref: first.product_ref,
      adopted: true,
    });
    expect(sealAttempt(attempt(artifacts, ref, () => accepted("different")))).toEqual({
      status: "fault",
      code: "SEAL_OPERATION_CONFLICT",
    });
    const extra = draft(artifacts, 2);
    const changedMetadata = attempt(artifacts, ref, () => ({
      ...accepted(),
      upstream_refs: [extra],
    }));
    expect(sealAttempt(changedMetadata)).toEqual({
      status: "fault",
      code: "SEAL_OPERATION_CONFLICT",
    });
    const replacementDraft = draft(artifacts, 3);
    const replacement = attempt(artifacts, replacementDraft, accepted, {
      anchor: first.product_ref,
    });
    const replacementResult = sealAttempt(replacement);
    expect(replacementResult.status).toBe("sealed");
    expect(
      sealAttempt({
        ...replacement,
        project: () => ({ ...accepted(), revision_parent_ref: first.product_ref }),
      })
    ).toEqual({ status: "fault", code: "SEAL_OPERATION_CONFLICT" });
    expect(
      sealOperationId({
        operation: "seal_product",
        run_id: "run-one",
        branch_id: null,
        phase: "sealing_assessment",
        epoch_anchor_ref: null,
        draft_ref: ref,
        policy_sha256: sealPolicySha256(policy),
      })
    ).not.toBe(
      sealOperationId({
        operation: "seal_diagnostic",
        run_id: "run-one",
        branch_id: null,
        phase: "sealing_assessment",
        epoch_anchor_ref: null,
        draft_ref: ref,
        policy_sha256: sealPolicySha256(policy),
      })
    );
  });

  it("adopts the exact operation from a fresh artifact owner after restart", () => {
    const first = store();
    const ref = draft(first, 1);
    const sealed = sealAttempt(attempt(first, ref, accepted));
    expect(sealed.status).toBe("sealed");
    if (sealed.status !== "sealed") throw new Error("missing product");
    const root = first.root;
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const recovered = ArtifactStore.openExisting(root, { projectId: `prj_${"0".repeat(32)}` });
    stores.push(recovered);
    expect(sealAttempt(attempt(recovered, ref, accepted))).toMatchObject({
      status: "sealed",
      adopted: true,
      product_ref: sealed.product_ref,
    });
    const failed = sealAttempt(
      attempt(recovered, draft(recovered, 2), rejected, {
        anchor: sealed.product_ref,
      })
    );
    expect(failed.status).toBe("rejected");
    if (failed.status !== "rejected") throw new Error("missing diagnostic");
    expect(
      sealAttempt(
        attempt(recovered, failed.diagnostic.rejected_draft_ref, rejected, {
          anchor: sealed.product_ref,
        })
      )
    ).toMatchObject({ status: "rejected", adopted: true, diagnostic_ref: failed.diagnostic_ref });
  });

  it("recovers an interrupted insert only on exact metadata and fails closed on missing reads, thrown projection, or failed write", () => {
    const artifacts = store();
    const ref = draft(artifacts, 1);
    let once = true;
    const afterInsert: ArtifactHostStore = {
      persist: (value) => {
        const result = artifacts.persist(value);
        if (once) {
          once = false;
          throw new Error("simulated crash after insert");
        }
        return result;
      },
      refFor: (...args) => artifacts.refFor(...args),
      refById: (id) => artifacts.refById(id),
      readById: (id) => artifacts.readById(id),
      lastVersion: (...args) => artifacts.lastVersion(...args),
      select: (value) => artifacts.select(value),
      metadata: (value) => artifacts.metadata(value),
    };
    expect(sealAttempt(attempt(afterInsert, ref, rejected))).toMatchObject({
      status: "rejected",
      adopted: false,
    });
    expect(sealAttempt(attempt(artifacts, ref, rejected))).toMatchObject({
      status: "rejected",
      adopted: true,
    });
    const missingWrite: ArtifactHostStore = {
      ...afterInsert,
      persist: () => {
        throw new Error("no write");
      },
      refFor: () => null,
    };
    expect(sealAttempt(attempt(missingWrite, draft(artifacts, 2), rejected))).toEqual({
      status: "fault",
      code: "SEAL_PERSISTENCE_FAULT",
    });
    expect(
      sealAttempt(
        attempt(artifacts, draft(artifacts, 3), () => ({
          status: "rejected",
          failure_class: "SCHEMA_INVALID",
          issues: Array.from({ length: 1025 }, (_, index) => ({
            ...issue,
            code: `ISSUE_${index}`,
          })),
        }))
      )
    ).toEqual({ status: "fault", code: "SEAL_DIAGNOSTIC_SIZE_FAULT" });
    expect(
      sealAttempt({
        ...attempt(artifacts, ref, rejected),
        registered_policy_sha256: "0".repeat(64),
      })
    ).toEqual({ status: "fault", code: "SEAL_INPUT_FAULT" });
    expect(
      sealAttempt(
        attempt(artifacts, ref, () => {
          throw new Error("secret body");
        })
      )
    ).toEqual({ status: "fault", code: "SEAL_PROJECTION_FAULT" });
    const noRead: ArtifactHostStore = {
      ...afterInsert,
      readById: () => {
        throw new Error("missing bytes");
      },
    };
    expect(sealAttempt(attempt(noRead, ref, rejected))).toEqual({
      status: "fault",
      code: "SEAL_INPUT_FAULT",
    });
  });
});
