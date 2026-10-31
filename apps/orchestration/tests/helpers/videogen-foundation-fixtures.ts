import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson } from "../../dist/canonical-json.js";
import type { ArtifactRef } from "../../dist/contracts.js";
import type { FoundationLimitsV1 } from "../../dist/videogen/bounds.js";
import type {
  CurrentRightsV1,
  RightsHostV1,
  RightsBindingV1,
  ProvenanceBindingV1,
} from "../../dist/videogen/rights-ledger.js";
export const FOUNDATION_LIMITS: FoundationLimitsV1 = {
  schema_id: "penny.videogen-foundation-limits.v1",
  schema_version: 1,
  max_json_bytes: 1000000,
  max_text_bytes: 10000,
  max_collection_items: 1000,
  max_depth: 24,
  max_nodes: 100000,
  max_integer: Number.MAX_SAFE_INTEGER,
};
/** Concrete temporary project-bound owner stores. No fixture issuer can attest production quality. */
export class FoundationFixture implements Disposable {
  readonly project_id = `prj_${"1".repeat(32)}`;
  readonly run_id = "run_foundation";
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-videogen-foundation-"));
  readonly store = ArtifactStore.provision(path.join(this.root, "artifacts"), {
    projectId: this.project_id,
  });
  readonly checkpointer = Checkpointer.provision(path.join(this.root, "control.db"), undefined, {
    projectId: this.project_id,
  });
  readonly current_rights: CurrentRightsV1[] = [];
  private next = 0;
  raw(
    bytes: string | Uint8Array,
    media_type = "application/json",
    schema_id?: string,
    run_id = this.run_id,
    phase = "foundation",
    kind = "videogen-fixture"
  ): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id,
        phase,
        branch_id: null,
        kind,
        operation_id: `fixture_${++this.next}`,
        version: 1,
        producer: "host:videogen-fixture",
        media_type,
        parent_ref: null,
        upstream_refs: [],
        ...(schema_id === undefined ? {} : { content_schema: { schema_id, schema_version: 1 } }),
      },
      content: bytes,
    });
  }
  json(
    value: unknown,
    schema_id: string,
    run_id = this.run_id,
    phase = "foundation",
    kind = "videogen-fixture"
  ): ArtifactRef {
    return this.raw(canonicalJson(value), "application/json", schema_id, run_id, phase, kind);
  }
  opaque(label: string, media_type = "application/json", run_id = this.run_id): ArtifactRef {
    return this.raw(label, media_type, undefined, run_id);
  }
  rights(
    subject: ArtifactRef,
    subject_kind: RightsBindingV1["subject_kind"] = "image",
    consent_refs: ArtifactRef[] = []
  ): ArtifactRef {
    const provenance: ProvenanceBindingV1 = {
      schema_id: "penny.videogen-provenance-binding.v1",
      schema_version: 1,
      subject_ref: subject,
      source_refs: [],
      producer_receipt_ref: this.opaque("fixture journal, not production receipt"),
    };
    const binding: RightsBindingV1 = {
      schema_id: "penny.videogen-rights-binding.v1",
      schema_version: 1,
      subject_ref: subject,
      subject_kind,
      revision: 1,
      provenance_ref: this.json(provenance, provenance.schema_id),
      license_ref: this.opaque("fixture license, not clearance"),
      consent_refs,
      allowed_uses: ["source", "preview", "motion", "edit", "deliver"],
      territories: ["test-territory"],
      credits: ["fixture credit"],
      valid_from_utc: "2026-01-01T00:00:00Z",
      expires_at_utc: "2027-01-01T00:00:00Z",
    };
    const ref = this.json(binding, binding.schema_id);
    this.current_rights.push({
      subject_ref: subject,
      rights_ref: ref,
      revision: 1,
      status: "cleared",
    });
    return ref;
  }
  host(): RightsHostV1 {
    return {
      store: this.store,
      project_id: this.project_id,
      run_id: this.run_id,
      limits: FOUNDATION_LIMITS,
      now_utc: "2026-10-12T00:00:00Z",
      territory: "test-territory",
      current_rights: this.current_rights,
      cross_run_edges: [],
    };
  }
  [Symbol.dispose](): void {
    this.checkpointer.close();
    this.store.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
