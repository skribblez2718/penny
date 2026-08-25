import { createHash } from "node:crypto";

import { artifactIdFor, type ArtifactRef, type OutputArtifactMetadata } from "../owner-client.js";

export function outputMetadata(
  overrides: Partial<OutputArtifactMetadata> = {}
): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: "run-fixture",
    phase: "phase-fixture",
    branch_id: null,
    kind: "agent-output",
    operation_id: "operation-fixture",
    version: 1,
    producer: "agent:fixture",
    media_type: "text/plain; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
    ...overrides,
  };
}

export function expectedRef(metadata: OutputArtifactMetadata, content: Buffer): ArtifactRef {
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    schema_version: 2,
    artifact_id: artifactIdFor(metadata),
    run_id: metadata.run_id,
    phase: metadata.phase,
    branch_id: metadata.branch_id,
    kind: metadata.kind,
    operation_id: metadata.operation_id,
    version: metadata.version,
    producer: metadata.producer,
    media_type: metadata.media_type,
    byte_length: content.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}
