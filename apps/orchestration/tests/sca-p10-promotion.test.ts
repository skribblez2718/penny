import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../dist/contracts.js";
import {
  ScaRulePromotionSimulatedCrash,
  ScaRulePromotionStore,
  createArtifactScaRulePromotionBackendV1,
  createMemoryScaRulePromotionBackendV1,
} from "../dist/sca/p10-promotion.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-promotion-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function save(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly value: unknown;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: "SCA-P10",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: "host:sca-p10-test",
    media_type: "application/json",
    content_schema: { schema_id: "penny.test.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}
function release(store: ArtifactStore, runId: string, id: string): ArtifactRef {
  return save({
    store,
    run_id: runId,
    kind: "sca-rule-release",
    operation_id: `release-${id}`,
    value: { schema_id: "penny.sca-rule-release.v1", schema_version: 1, release_id: id },
  });
}
function authority(store: ArtifactStore, runId: string): ArtifactRef {
  return save({
    store,
    run_id: runId,
    kind: "sca-p10-promotion-authority",
    operation_id: "authority",
    value: { authority: runId },
  });
}
function newStore(
  artifacts: ArtifactStore,
  runId: string,
  fault?: (boundary: string) => void
): ScaRulePromotionStore {
  return new ScaRulePromotionStore({
    backend: createMemoryScaRulePromotionBackendV1(),
    store: artifacts,
    runId,
    phase: "SCA-P10",
    now: () => new Date("2026-09-26T00:00:05.000Z"),
    ...(fault === undefined ? {} : { fault }),
  });
}

describe("SCA P10 future-only atomic immutable promotion store", () => {
  it("requires separate authority and refuses an unauthorized promotion", () => {
    using artifacts = makeStore();
    const store = newStore(artifacts, "run-promotion-denied");
    const outcome = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, "run-promotion-denied"),
      promotion_authority_admitted: false,
      successor_release_ref: release(artifacts, "run-promotion-denied", "v1"),
      bundle_ref: release(artifacts, "run-promotion-denied", "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    expect(outcome.outcome).toBe("denied");
    expect(outcome.receipt).toBeNull();
    expect(store.currentHead()).toBeNull();
  });

  it("commits one successor release with an exact receipt", () => {
    using artifacts = makeStore();
    const store = newStore(artifacts, "run-promotion-ok");
    const successor = release(artifacts, "run-promotion-ok", "v1");
    const outcome = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, "run-promotion-ok"),
      promotion_authority_admitted: true,
      successor_release_ref: successor,
      bundle_ref: release(artifacts, "run-promotion-ok", "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    expect(outcome.outcome).toBe("promoted");
    expect(outcome.receipt?.successor_release_sha256).toBe(successor.content_digest);
    expect(outcome.receipt?.future_only).toBe(true);
    expect(outcome.receipt?.atomic).toBe(true);
    expect(store.currentHead()?.release_sha256).toBe(successor.content_digest);
  });

  it("admits exactly one of two concurrent promotions for the same head", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-cas";
    const store = newStore(artifacts, runId);
    const first = release(artifacts, runId, "v1");
    const firstOutcome = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: first,
      bundle_ref: release(artifacts, runId, "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    expect(firstOutcome.outcome).toBe("promoted");
    // A peer that observed the same (null) predecessor fails closed with a conflict.
    const second = store.promote({
      candidate_id: "p10cand_b",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: release(artifacts, runId, "v2"),
      bundle_ref: release(artifacts, runId, "v2-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    expect(second.outcome).toBe("conflict");
    expect(second.blocker_codes).toContain("p10_promotion_head_conflict");
    expect(store.currentHead()?.release_sha256).toBe(first.content_digest);
  });

  it("is idempotent across a later promotion and fails closed on a conflicting successor", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-later-head-replay";
    const store = newStore(artifacts, runId);
    const first = release(artifacts, runId, "v1");
    const firstInput = {
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: first,
      bundle_ref: release(artifacts, runId, "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [] as readonly ArtifactRef[],
    };
    const firstOutcome = store.promote(firstInput);
    expect(firstOutcome.outcome).toBe("promoted");
    // A *later* promotion of a different candidate advances the current head.
    const second = release(artifacts, runId, "v2");
    const secondOutcome = store.promote({
      candidate_id: "p10cand_b",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: second,
      bundle_ref: release(artifacts, runId, "v2-bundle"),
      expected_predecessor: store.currentHead(),
      active_run_rule_release_refs: [],
    });
    expect(secondOutcome.outcome).toBe("promoted");
    expect(store.history().length).toBe(2);
    // Re-deriving the first candidate now observes the later head. It must converge to the original
    // receipt and never promote the same candidate again atop the later head.
    const replay = store.promote({ ...firstInput, expected_predecessor: store.currentHead() });
    expect(replay.outcome).toBe("promoted");
    expect(replay.receipt?.receipt_sha256).toBe(firstOutcome.receipt?.receipt_sha256);
    expect(replay.receipt?.predecessor_release_sha256).toBeNull();
    expect(store.history().length).toBe(2);
    expect(store.currentHead()?.release_sha256).toBe(second.content_digest);
    // The same candidate presenting a different successor fails closed rather than re-promoting.
    const conflict = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: release(artifacts, runId, "v1-alternate"),
      bundle_ref: release(artifacts, runId, "v1-alternate-bundle"),
      expected_predecessor: store.currentHead(),
      active_run_rule_release_refs: [],
    });
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.blocker_codes).toContain("p10_promotion_replay_conflict");
    expect(store.history().length).toBe(2);
  });

  it("converges a duplicate promotion to the same receipt", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-replay";
    const store = newStore(artifacts, runId);
    const successor = release(artifacts, runId, "v1");
    const input = {
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: successor,
      bundle_ref: release(artifacts, runId, "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [] as readonly ArtifactRef[],
    };
    const first = store.promote(input);
    const second = store.promote(input);
    expect(second.outcome).toBe("promoted");
    expect(second.receipt?.receipt_sha256).toBe(first.receipt?.receipt_sha256);
    expect(store.history().length).toBe(1);
  });

  it("leaves the prior head when a fault interrupts a durable boundary", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-fault";
    const successor = release(artifacts, runId, "v1");
    const crashing = newStore(artifacts, runId, (boundary) => {
      if (boundary === "before_commit") throw new ScaRulePromotionSimulatedCrash(boundary);
    });
    expect(() =>
      crashing.promote({
        candidate_id: "p10cand_a",
        promotion_authority_ref: authority(artifacts, runId),
        promotion_authority_admitted: true,
        successor_release_ref: successor,
        bundle_ref: release(artifacts, runId, "v1-bundle"),
        expected_predecessor: null,
        active_run_rule_release_refs: [],
      })
    ).toThrow(ScaRulePromotionSimulatedCrash);
    expect(crashing.currentHead()).toBeNull();
  });

  it("restores the prior head with history intact on an authorized rollback", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-rollback";
    const store = newStore(artifacts, runId);
    const first = release(artifacts, runId, "v1");
    store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: first,
      bundle_ref: release(artifacts, runId, "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    const originalHead = store.currentHead();
    if (originalHead === null) throw new Error("head is absent");
    const second = release(artifacts, runId, "v2");
    store.promote({
      candidate_id: "p10cand_b",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: second,
      bundle_ref: release(artifacts, runId, "v2-bundle"),
      expected_predecessor: store.currentHead(),
      active_run_rule_release_refs: [],
    });
    const rollback = store.rollback({
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      target: originalHead,
    });
    expect(rollback.outcome).toBe("promoted");
    expect(store.currentHead()?.release_sha256).toBe(first.content_digest);
    expect(store.history().length).toBe(3);
  });

  it("refuses a promotion that would alter a frozen active-run rule", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-frozen";
    const store = newStore(artifacts, runId);
    const active = release(artifacts, runId, "active");
    const outcome = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: active,
      bundle_ref: release(artifacts, runId, "bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [active],
    });
    expect(outcome.outcome).toBe("unavailable");
    expect(outcome.blocker_codes).toContain("p10_promotion_would_alter_frozen_active_run_rule");
    expect(store.currentHead()).toBeNull();
  });

  it("persists one immutable head document with the artifact-backed backend", () => {
    using artifacts = makeStore();
    const runId = "run-promotion-durable";
    const store = new ScaRulePromotionStore({
      backend: createArtifactScaRulePromotionBackendV1({
        store: artifacts,
        runId,
        phase: "SCA-P10",
      }),
      store: artifacts,
      runId,
      phase: "SCA-P10",
      now: () => new Date("2026-09-26T00:00:05.000Z"),
    });
    const successor = release(artifacts, runId, "v1");
    const outcome = store.promote({
      candidate_id: "p10cand_a",
      promotion_authority_ref: authority(artifacts, runId),
      promotion_authority_admitted: true,
      successor_release_ref: successor,
      bundle_ref: release(artifacts, runId, "v1-bundle"),
      expected_predecessor: null,
      active_run_rule_release_refs: [],
    });
    expect(outcome.outcome).toBe("promoted");
    const reopened = new ScaRulePromotionStore({
      backend: createArtifactScaRulePromotionBackendV1({
        store: artifacts,
        runId,
        phase: "SCA-P10",
      }),
      store: artifacts,
      runId,
      phase: "SCA-P10",
    });
    expect(reopened.currentHead()?.release_sha256).toBe(successor.content_digest);
  });
});
