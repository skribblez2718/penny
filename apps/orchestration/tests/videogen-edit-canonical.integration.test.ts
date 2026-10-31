import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../dist/artifact-store.js";
import { inspectEditDecision } from "../dist/videogen/edit-decision.js";
import { readSemantic } from "../dist/videogen/bounds.js";
import { EditTransformationV1Schema } from "../dist/videogen/edit-contracts.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { editFixture } from "./helpers/videogen-edit-fixtures.js";

describe("edit canonical-store exact lineage and current authority", () => {
  it("reopens the real project-bound canonical store, preserving quantization and reading without selection/writes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const initial = inspectEditDecision(e.host, e.edit_ref);
    using reopened = ArtifactStore.openExisting(path.join(f.root, "artifacts"), {
      projectId: f.project_id,
    });
    const persist = vi.spyOn(reopened, "persist");
    const select = vi.spyOn(reopened, "select");
    const after = inspectEditDecision({ ...e.host, store: reopened }, e.edit_ref);
    expect(after).toEqual(initial);
    expect(persist).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(after.production_admission).toBe("blocked");
    // The explicitly silent PCM fixture cannot become playback proof through structural inspection.
    expect(
      reopened
        .read(e.audio.source.media_ref)
        .subarray(44)
        .every((byte) => byte === 0)
    ).toBe(true);
  });
  it("detects every exact-ref operand drift instead of adopting same-name bytes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    for (const patch of [
      { producer: "worker:forged" },
      { operation_id: "other" },
      { run_id: "other" },
      { content_digest: "f".repeat(64) },
      { byte_length: e.edit_ref.byte_length + 1 },
      { artifact_id: `art_${"f".repeat(64)}` },
    ])
      expect(() => inspectEditDecision(e.host, { ...e.edit_ref, ...patch })).toThrow();
    using other = new FoundationFixture();
    expect(() => inspectEditDecision({ ...e.host, store: other.store }, e.edit_ref)).toThrow();
    expect(() =>
      inspectEditDecision({ ...e.host, project_id: `prj_${"2".repeat(32)}` }, e.edit_ref)
    ).toThrow();
    expect(() => inspectEditDecision({ ...e.host, current_dependencies: [] }, e.edit_ref)).toThrow(
      /index coverage/
    );
    expect(() =>
      inspectEditDecision(
        {
          ...e.host,
          current_dependencies: e.host.current_dependencies.map((n, i) =>
            i === 0 ? { ...n, revision: 2 } : n
          ),
        },
        e.edit_ref
      )
    ).toThrow(/stale/);
  });
  it("does not allow previously readable rights to survive revocation, expiry, territory or consent changes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    for (const host of [
      { ...e.host, current_rights: [] },
      {
        ...e.host,
        current_rights: e.host.current_rights.map((r) => ({ ...r, status: "revoked" as const })),
      },
      { ...e.host, now_utc: "2027-01-01T00:00:00Z" },
      { ...e.host, territory: "other" },
      { ...e.host, current_rights: e.host.current_rights.map((r) => ({ ...r, revision: 2 })) },
      { ...e.host, audio_sources: [{ source_ref: e.audio.source_ref, measurement_ref: e.style }] },
      { ...e.host, audio_sources: [] },
    ])
      expect(() => inspectEditDecision(host, e.edit_ref)).toThrow();
  });
  it("requires exact authorized cross-run media edges, not matching run names or caller approval booleans", () => {
    using f = new FoundationFixture();
    const e = editFixture(f, { video_run: "prior_asset_run" });
    expect(inspectEditDecision(e.host, e.edit_ref).status).toBe("structural_checked");
    const callerClaims = { ...e.host, cross_run_edges: [], approved: true };
    expect(() => inspectEditDecision(callerClaims, e.edit_ref)).toThrow(/cross-run/);
    for (const patch of [
      { consumer_run_id: "other" },
      { project_id: `prj_${"9".repeat(32)}` },
      { source_ref: e.edit_ref },
      { rights_ref: e.style },
      { provenance_ref: e.style },
    ])
      expect(() =>
        inspectEditDecision(
          {
            ...e.host,
            cross_run_edges: e.host.cross_run_edges.map((edge) => ({ ...edge, ...patch })),
          },
          e.edit_ref
        )
      ).toThrow();
  });
  it("retains originals AND processed bytes with exact transformation operands and target-bound prior review", () => {
    using f = new FoundationFixture();
    const e = editFixture(f, { transformed: true });
    const result = inspectEditDecision(e.host, e.edit_ref);
    expect(result.dependency_refs).toContainEqual(e.original);
    expect(result.dependency_refs).toContainEqual(e.video);
    expect(result.dependency_refs).toContainEqual(e.transformation_ref);
    expect(result.external_evidence_refs).toContainEqual(e.transformation_review_ref);
    const ref = e.transformation_ref;
    if (ref === undefined) throw new Error("transformation fixture missing");
    const t = readSemantic({
      ...e.host,
      ref,
      schema: EditTransformationV1Schema,
      schema_id: "penny.videogen-edit-transformation.v1",
    });
    for (const patch of [
      { processed_ref: e.original },
      { original_ref: e.video },
      { review_binding_ref: e.style },
      { parameters_ref: { ...t.parameters_ref, producer: "worker:forged" } },
    ]) {
      const replacement = f.json({ ...t, ...patch }, t.schema_id);
      const facts = f.json(
        { ...e.measured, transformation_ref: replacement },
        e.measured.schema_id
      );
      expect(() =>
        inspectEditDecision({ ...e.host, measured_source_refs: [facts] }, e.edit_ref)
      ).toThrow();
    }
    const blockedReview = f.json(
      {
        schema_id: "penny.videogen-review-binding.v1",
        schema_version: 1,
        worker_result_ref: t.parameters_ref,
        target_ref: e.original,
        evidence_refs: [t.measurement_ref],
        model_capability_ref: t.parameters_ref,
        disposition: "pass",
      },
      "penny.videogen-review-binding.v1"
    );
    const replacement = f.json({ ...t, review_binding_ref: blockedReview }, t.schema_id);
    const facts = f.json({ ...e.measured, transformation_ref: replacement }, e.measured.schema_id);
    expect(() =>
      inspectEditDecision({ ...e.host, measured_source_refs: [facts] }, e.edit_ref)
    ).toThrow(/exact-target review/);
    expect(result.unverified).toContain("decode_and_review_journal_authority");
  });
});
