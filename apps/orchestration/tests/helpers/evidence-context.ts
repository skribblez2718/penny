import type { ArtifactHostStore } from "../../src/artifact-store.js";
import { canonicalJson } from "../../src/checkpointer.js";
import {
  validateEvidenceContext,
  type EvidenceContextV1,
} from "../../src/child-workflows/contracts.js";
import type { ArtifactRef } from "../../src/contracts.js";

let sequence = 0;

export interface EvidenceContextFixture {
  readonly context: EvidenceContextV1;
  readonly ref: ArtifactRef;
  readonly sourceRef: ArtifactRef;
  readonly statementMarker: string;
}

export function persistEvidenceContext(
  store: ArtifactHostStore,
  label = "provider-adapter"
): EvidenceContextFixture {
  sequence += 1;
  const suffix = `${label}-${sequence}`;
  const runId = `evidence-context-fixture-${suffix}`;
  const statementMarker = `EVIDENCE_CONTEXT_PACKET_SENTINEL_${label}_${sequence}`;
  const sourceRef = store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "source_capture",
      branch_id: null,
      kind: "source-document",
      operation_id: `evidence-context-source:${suffix}`,
      version: 1,
      producer: "host:test-evidence-context",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
    content: `${statementMarker}\n`,
  });
  const context = validateEvidenceContext({
    schema_id: "penny.evidence-context.v1",
    schema_version: 1,
    purpose: "Provide bounded contextual evidence to a compatible provider.",
    question: "What does the exact selected source establish?",
    origin: {
      project_id: "project-evidence-context-fixture",
      principal_id: "principal-evidence-context-fixture",
      scope_id: "scope-evidence-context-fixture",
      snapshot_id: `snapshot-${suffix}`,
    },
    policy: {
      source_policy_id: "source-policy-evidence-context-fixture",
      destination_policy_id: "destination-policy-evidence-context-fixture",
    },
    entries: [
      {
        entry_id: `entry-${suffix}`,
        source_type: "document",
        source_ref: sourceRef,
        selector: { kind: "line_range", start: 1, end: 2 },
        classification: "observation",
        statement: statementMarker,
        uncertainty: { status: "none" },
      },
    ],
    transitive_refs: [sourceRef],
    limitations: ["The observation is limited to the selected source range."],
  });
  const ref = store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "evidence_context",
      branch_id: null,
      kind: "evidence-context",
      operation_id: `evidence-context:${suffix}`,
      version: 1,
      producer: "host:test-evidence-context",
      media_type: "application/json",
      content_schema: { schema_id: "penny.evidence-context.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [sourceRef],
    },
    content: canonicalJson(context),
  });
  return { context, ref, sourceRef, statementMarker };
}
