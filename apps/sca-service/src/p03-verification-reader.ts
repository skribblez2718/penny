import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import type { HostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/contracts.js";
import type { ScaP03BootstrapVerificationReaderV1 } from "./p03-bootstrap.js";

/** Exact bound refs only. Provenance is read/hash-verified in the canonical manifest, never
 * synthesized from ref labels. This bridge grants no discovery, selection, or write capability. */
export function createScaP03BoundVerificationReaderV1(
  context: HostOperationExecutionContextV1,
  store: ArtifactStore
): ScaP03BootstrapVerificationReaderV1 {
  if (!(store instanceof ArtifactStore))
    throw new Error("p03_verification_canonical_store_required");
  store.assertBoundProject(context.journal.project_id);
  const slots = new Map<string, { slot: string; ref: ArtifactRef }>();
  for (const binding of context.directive.input_artifacts.artifacts) {
    if (slots.has(binding.ref.artifact_id)) throw new Error("p03_verification_duplicate_ref");
    slots.set(binding.ref.artifact_id, binding);
  }
  const exact = (ref: ArtifactRef) => {
    context.signal.throwIfAborted();
    const binding = slots.get(ref.artifact_id);
    if (binding === undefined || canonicalJson(binding.ref) !== canonicalJson(ref))
      throw new Error("p03_verification_ref_out_of_scope");
    const owned = context.readInput(binding.slot);
    const metadata = store.metadata(ref);
    const bytes = store.read(ref);
    if (
      canonicalJson(owned.ref) !== canonicalJson(ref) ||
      !Buffer.from(owned.bytes).equals(bytes) ||
      bytes.length !== ref.byte_length ||
      sha256(bytes) !== ref.content_digest ||
      canonicalJson(previewArtifactRef({ metadata, content: bytes })) !== canonicalJson(ref)
    )
      throw new Error("p03_verification_custody_mismatch");
    return { bytes, metadata };
  };
  const bound = (id: string): ArtifactRef => {
    const binding = slots.get(id);
    if (binding === undefined) throw new Error("p03_verification_ref_out_of_scope");
    exact(binding.ref);
    return structuredClone(binding.ref);
  };
  return Object.freeze({
    read: (ref: ArtifactRef) => Buffer.from(exact(ref).bytes),
    metadata: (ref: ArtifactRef) => structuredClone(exact(ref).metadata),
    refById: bound,
    readById: (id: string) => Buffer.from(exact(bound(id)).bytes),
  });
}
