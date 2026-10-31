import { describe, expect, it } from "vitest";
import { RunContext } from "../dist/context.js";
import { canonicalJson } from "../dist/canonical-json.js";
import {
  RightsBindingV1Schema,
  checkRights,
  checkLedgerCurrent,
  invalidateDependencies,
  selectDependencyLedger,
  validateDependencyLedger,
  type DependencyLedgerV1,
  type CrossRunEdgeV1,
} from "../dist/videogen/rights-ledger.js";
import { readSemantic } from "../dist/videogen/bounds.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
function ledger(f: FoundationFixture): DependencyLedgerV1 {
  const node = (
    stable_id: string,
    role: DependencyLedgerV1["nodes"][number]["role"]
  ): DependencyLedgerV1["nodes"][number] => ({
    stable_id,
    role,
    ref: f.opaque(stable_id),
    revision: 1,
    approval_ref: f.opaque(`${stable_id} approval`),
    status: "current",
  });
  const nodes = [
    node("storyA", "story"),
    node("referenceA", "reference"),
    node("rightsA", "rights"),
    node("voiceA", "voice"),
    node("timingA", "timing"),
    node("shotA", "final"),
    node("editA", "edit"),
    node("gradeA", "grade"),
    node("mixA", "mix"),
    node("encodeA", "encode"),
    node("masterA", "master"),
    node("packageA", "package"),
    node("storyB", "story"),
    node("shotB", "final"),
  ];
  const refs = nodes.map((x) => ({
    target_id: x.stable_id,
    evidence_refs: [f.opaque(`${x.stable_id} review`)],
  }));
  return {
    schema_id: "penny.videogen-dependency-ledger.v1",
    schema_version: 1,
    nodes,
    edges: [
      { from: "storyA", to: "shotA", reason: "canon" },
      { from: "referenceA", to: "shotA", reason: "reference" },
      { from: "rightsA", to: "shotA", reason: "rights" },
      { from: "voiceA", to: "timingA", reason: "performance" },
      { from: "timingA", to: "shotA", reason: "timing" },
      { from: "shotA", to: "editA", reason: "source" },
      { from: "editA", to: "gradeA", reason: "edit" },
      { from: "gradeA", to: "mixA", reason: "source" },
      { from: "mixA", to: "encodeA", reason: "source" },
      { from: "encodeA", to: "masterA", reason: "source" },
      { from: "masterA", to: "packageA", reason: "source" },
      { from: "storyB", to: "shotB", reason: "canon" },
    ],
    review_epochs: refs,
    invalidations: [],
  };
}
describe("WP003 rights and selective dependency closure", () => {
  it("uses host-current rights, required performer/voice consent, exact origin and revocation", () => {
    using f = new FoundationFixture();
    const subject = f.opaque("performance", "audio/wav");
    const consent = f.opaque("consent");
    const rightsRef = f.rights(subject, "voice", [consent]);
    expect(checkRights(f.host(), subject, rightsRef, "deliver").subject_kind).toBe("voice");
    const binding = readSemantic({
      store: f.store,
      project_id: f.project_id,
      ref: rightsRef,
      schema: RightsBindingV1Schema,
      schema_id: "penny.videogen-rights-binding.v1",
      limits,
    });
    for (const host of [
      { ...f.host(), current_rights: [] },
      {
        ...f.host(),
        current_rights: [
          { subject_ref: subject, rights_ref: rightsRef, revision: 1, status: "revoked" as const },
        ],
      },
      { ...f.host(), territory: "wrong" },
      { ...f.host(), now_utc: "2027-01-01T00:00:00Z" },
      {
        ...f.host(),
        current_rights: [
          { subject_ref: subject, rights_ref: rightsRef, revision: 2, status: "cleared" as const },
        ],
      },
    ])
      expect(() => checkRights(host, subject, rightsRef, "deliver")).toThrow();
    const missingConsent = f.json({ ...binding, consent_refs: [] }, binding.schema_id);
    expect(() =>
      checkRights(
        {
          ...f.host(),
          current_rights: [
            { subject_ref: subject, rights_ref: missingConsent, revision: 1, status: "cleared" },
          ],
        },
        subject,
        missingConsent,
        "motion"
      )
    ).toThrow();
    expect(() =>
      checkRights(f.host(), { ...subject, content_digest: "e".repeat(64) }, rightsRef, "motion")
    ).toThrow();
  });
  it("requires exact authorized cross-run source/provenance edge, not possession", () => {
    using f = new FoundationFixture();
    const subject = f.opaque("upstream PNG", "image/png", "run_upstream");
    const rights = f.rights(subject);
    const binding = readSemantic({
      store: f.store,
      project_id: f.project_id,
      ref: rights,
      schema: RightsBindingV1Schema,
      schema_id: "penny.videogen-rights-binding.v1",
      limits,
    });
    expect(() => checkRights(f.host(), subject, rights, "source")).toThrow(/cross-run/);
    const edge: CrossRunEdgeV1 = {
      schema_id: "penny.videogen-cross-run-edge.v1",
      schema_version: 1,
      project_id: f.project_id,
      consumer_run_id: f.run_id,
      source_ref: subject,
      rights_ref: rights,
      provenance_ref: binding.provenance_ref,
      authorization_ref: f.opaque("trusted host cross-run authorization"),
    };
    expect(
      checkRights({ ...f.host(), cross_run_edges: [edge] }, subject, rights, "source").subject_ref
    ).toEqual(subject);
    for (const bad of [
      { ...edge, consumer_run_id: "other" },
      { ...edge, project_id: `prj_${"9".repeat(32)}` },
      { ...edge, source_ref: f.opaque("another", "image/png", "run_upstream") },
    ])
      expect(() =>
        checkRights({ ...f.host(), cross_run_edges: [bad] }, subject, rights, "source")
      ).toThrow();
  });
  it("invalidates every changed operand's descendants while retaining exact independent sibling", () => {
    using f = new FoundationFixture();
    const v = ledger(f);
    validateDependencyLedger(v, limits);
    for (const selected of v.nodes.filter((x) => !x.stable_id.endsWith("B"))) {
      const current = v.nodes.map((x) => ({
        stable_id: x.stable_id,
        ref: x.stable_id === selected.stable_id ? f.opaque(`${x.stable_id} revision`) : x.ref,
        revision: x.stable_id === selected.stable_id ? 2 : 1,
      }));
      const next = invalidateDependencies({
        ledger: v,
        current,
        revoked_ids: [],
        reason: "changed exact version",
        earliest_producer: "admit",
        limits,
      });
      expect(next.nodes.find((x) => x.stable_id === selected.stable_id)).toMatchObject({
        status: "stale",
        revision: 2,
      });
      for (const node of next.nodes.filter((x) => x.status !== "current"))
        expect(node.approval_ref).toBeUndefined();
      expect(next.nodes.filter((x) => x.stable_id.endsWith("B"))).toEqual(
        v.nodes.filter((x) => x.stable_id.endsWith("B"))
      );
      expect(next.nodes.find((x) => x.stable_id === "packageA")?.status).toBe("stale");
      expect(next.review_epochs.some((x) => x.target_id === selected.stable_id)).toBe(false);
      expect(v.invalidations).toEqual([]);
    }
    const revoked = invalidateDependencies({
      ledger: v,
      current: v.nodes.map((x) => ({ stable_id: x.stable_id, ref: x.ref, revision: x.revision })),
      revoked_ids: ["rightsA"],
      reason: "rights revoked without byte change",
      earliest_producer: "admit",
      limits,
    });
    expect(revoked.nodes.find((x) => x.stable_id === "rightsA")?.status).toBe("blocked");
    expect(revoked.nodes.find((x) => x.stable_id === "shotA")?.status).toBe("stale");
  });
  it("rejects cycles, dangling/duplicate IDs, rollback and missing current rights", () => {
    using f = new FoundationFixture();
    const v = ledger(f);
    const current = v.nodes.map((x) => ({
      stable_id: x.stable_id,
      ref: x.ref,
      revision: x.revision,
    }));
    for (const bad of [
      { ...v, nodes: [...v.nodes, v.nodes[0]] },
      { ...v, edges: [...v.edges, { from: "packageA", to: "storyA", reason: "source" }] },
      { ...v, edges: [...v.edges, { from: "missing", to: "shotA", reason: "source" }] },
    ])
      expect(() => validateDependencyLedger(bad, limits)).toThrow();
    expect(() =>
      invalidateDependencies({
        ledger: v,
        current: current.slice(1),
        revoked_ids: [],
        reason: "missing",
        earliest_producer: "admit",
        limits,
      })
    ).toThrow();
    expect(() =>
      invalidateDependencies({
        ledger: v,
        current: current.map((x, i) => (i === 0 ? { ...x, ref: f.opaque("new"), revision: 1 } : x)),
        revoked_ids: [],
        reason: "rollback",
        earliest_producer: "admit",
        limits,
      })
    ).toThrow();
    expect(() => checkLedgerCurrent(f.host(), v, current, "deliver")).toThrow(/rights/);
  });
  it("checkpoints only selected ledger refs and preserves them through restart", () => {
    using f = new FoundationFixture();
    const v = ledger(f);
    const ref = f.json(v, v.schema_id);
    const identity = {
      schema_version: 2,
      run_id: f.run_id,
      session_id: "session_ledger",
      playbook: "research",
      engine_owner: "typescript",
    } as const;
    const context = RunContext.create({
      identity,
      goal: "fixture",
      constraints: {},
      projectRoot: f.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
    });
    selectDependencyLedger(context, ref);
    f.checkpointer.createRun(context, "foundation_ledger", {});
    const loaded = f.checkpointer.loadRun(identity);
    expect(loaded.selectedArtifacts).toEqual([ref]);
    expect(canonicalJson(loaded.snapshot())).not.toContain("review_epochs");
    expect(() => selectDependencyLedger(context, { ...ref, run_id: "other" })).toThrow();
  });
});
