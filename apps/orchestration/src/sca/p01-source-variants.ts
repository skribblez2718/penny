import {
  currentArtifactRef,
  previewArtifactRef,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
  SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
  SCA_SOURCE_PROVENANCE_V1_SCHEMA,
  scaP01VariantCaptureManifestRefs,
  validateScaCampaignSourceSnapshotV2,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
  validateScaP01VariantCaptureManifestV1,
  validateScaSourceProvenanceV1,
  type ScaP01AdmissionRequestV3,
  type ScaP01VariantCaptureManifestV1,
} from "./p01-contracts.js";

const KIND = "sca-p01-variant-capture-manifest";
const PHASE = "SCA-P01-source";
const OPERATION = "variant-capture-manifest";
const MAX_ARTIFACT_BYTES = 64 * 1_048_576;
const MAX_CLOSURE_BYTES = 256 * 1_048_576;
type CaptureContext = Pick<
  ScaP01AdmissionRequestV3,
  "tenant_id" | "project_id" | "run_id" | "implementation_revision" | "source"
>;
export interface ScaP01VariantCaptureReadV1 {
  readonly manifest: ScaP01VariantCaptureManifestV1;
  readonly all_refs: readonly ArtifactRef[];
}
type ExactRead = (ref: ArtifactRef, label: string) => Buffer;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const ordered = (refs: readonly ArtifactRef[]): ArtifactRef[] =>
  [...refs].sort((a, b) => Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id)));

function exactJson(store: ArtifactHostStore, ref: ArtifactRef, read?: ExactRead): unknown {
  if (ref.byte_length > MAX_ARTIFACT_BYTES)
    throw new Error("variant capture artifact is oversized");
  const stored = store.refById(ref.artifact_id);
  const metadata = store.metadata(ref);
  const bytes =
    read === undefined ? store.readById(ref.artifact_id) : read(ref, "variant capture closure");
  if (
    stored === undefined ||
    !same(stored, ref) ||
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest ||
    !same(previewArtifactRef({ metadata, content: bytes }), ref)
  ) {
    throw new Error("variant capture exact ref/metadata/bytes drifted");
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (canonicalJson(value) !== bytes.toString("utf8"))
    throw new Error("variant capture bytes are not canonical JSON");
  return value;
}

function artifactContract(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  schema: string,
  version: number,
  operation: string | null,
  upstream: readonly ArtifactRef[],
  phase: string | null = PHASE
): void {
  const metadata = store.metadata(ref);
  if (
    ref.kind !== kind ||
    ref.content_schema?.schema_id !== schema ||
    ref.content_schema.schema_version !== version ||
    ref.producer !== SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source ||
    ref.media_type !== "application/json" ||
    (phase !== null && ref.phase !== phase) ||
    ref.branch_id !== null ||
    (operation !== null && ref.operation_id !== operation) ||
    ref.version !== 1 ||
    metadata.parent_ref !== null ||
    metadata.domain_revision_parent_ref !== undefined ||
    !same(metadata.upstream_refs, ordered(upstream))
  ) {
    throw new Error("variant capture artifact metadata/upstream/revision contract drifted");
  }
}

function validateClosure(
  store: ArtifactHostStore,
  manifest: ScaP01VariantCaptureManifestV1,
  context: CaptureContext,
  read?: ExactRead
): void {
  if (
    manifest.tenant_id !== context.tenant_id ||
    manifest.project_id !== context.project_id ||
    manifest.run_id !== context.run_id ||
    manifest.implementation_revision !== context.implementation_revision ||
    !same(manifest.baseline_snapshot_ref, context.source.snapshot_ref) ||
    !same(manifest.baseline_provenance_ref, context.source.provenance_ref)
  ) {
    throw new Error("variant capture campaign/revision/baseline binding drifted");
  }
  const refs = scaP01VariantCaptureManifestRefs(manifest);
  if (refs.reduce((sum, ref) => sum + ref.byte_length, 0) > MAX_CLOSURE_BYTES)
    throw new Error("variant capture closure is oversized");
  // Exact baseline anchors and their transitive source material are part of the root
  // commitment. Validate the same complete custody closure and artifact metadata as
  // every named variant before the capture root can be published.
  const baseline = validateScaCampaignSourceSnapshotV2(
    exactJson(store, manifest.baseline_snapshot_ref, read)
  );
  const baselineFileManifest = validateScaP01SourceFileManifestV1(
    exactJson(store, baseline.file_manifest_ref, read)
  );
  const baselineCustody = validateScaP01SourceCustodyCorpusV1(
    exactJson(store, baseline.custody_ref, read)
  );
  const provenanceAnchor = validateScaSourceProvenanceV1(
    exactJson(store, manifest.baseline_provenance_ref, read)
  );
  validateScaP01SourceMaterialV1({
    snapshot: baseline,
    file_manifest_ref: baseline.file_manifest_ref,
    file_manifest: baselineFileManifest,
    custody_ref: baseline.custody_ref,
    custody: baselineCustody,
  });
  if (
    !same(provenanceAnchor.snapshot_ref, manifest.baseline_snapshot_ref) ||
    !same(provenanceAnchor.file_manifest_ref, baseline.file_manifest_ref) ||
    !same(provenanceAnchor.custody_ref, baseline.custody_ref) ||
    provenanceAnchor.custody_sha256 !== baseline.custody_sha256
  ) {
    throw new Error("variant capture baseline provenance binding drifted");
  }
  artifactContract(
    store,
    baseline.file_manifest_ref,
    "sca-p01-source-file-manifest",
    SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    1,
    null,
    [],
    null
  );
  artifactContract(
    store,
    baseline.custody_ref,
    "sca-p01-source-custody-corpus",
    SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    1,
    null,
    [baseline.file_manifest_ref],
    null
  );
  artifactContract(
    store,
    manifest.baseline_snapshot_ref,
    "source-snapshot",
    SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    2,
    null,
    [baseline.file_manifest_ref, baseline.custody_ref],
    null
  );
  artifactContract(
    store,
    manifest.baseline_provenance_ref,
    "source-provenance",
    SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    1,
    null,
    [manifest.baseline_snapshot_ref, baseline.file_manifest_ref, baseline.custody_ref],
    null
  );
  for (const entry of manifest.entries) {
    const snapshot = validateScaCampaignSourceSnapshotV2(
      exactJson(store, entry.snapshot_ref, read)
    );
    const fileManifest = validateScaP01SourceFileManifestV1(
      exactJson(store, entry.file_manifest_ref, read)
    );
    const custody = validateScaP01SourceCustodyCorpusV1(exactJson(store, entry.custody_ref, read));
    const provenance = validateScaSourceProvenanceV1(exactJson(store, entry.provenance_ref, read));
    validateScaP01SourceMaterialV1({
      snapshot,
      file_manifest_ref: entry.file_manifest_ref,
      file_manifest: fileManifest,
      custody_ref: entry.custody_ref,
      custody,
    });
    if (
      !same(provenance.snapshot_ref, entry.snapshot_ref) ||
      !same(provenance.file_manifest_ref, entry.file_manifest_ref) ||
      !same(provenance.custody_ref, entry.custody_ref) ||
      provenance.custody_sha256 !== entry.custody_ref.content_digest ||
      custody.custody_id !== snapshot.snapshot_id
    )
      throw new Error("variant capture provenance/cross-entry binding drifted");
    const id = snapshot.snapshot_id;
    artifactContract(
      store,
      entry.file_manifest_ref,
      "sca-p01-source-file-manifest",
      SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      1,
      `source-manifest:${id}`,
      []
    );
    artifactContract(
      store,
      entry.custody_ref,
      "sca-p01-source-custody-corpus",
      SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      1,
      `source-custody:${id}`,
      [entry.file_manifest_ref]
    );
    artifactContract(
      store,
      entry.snapshot_ref,
      "source-snapshot",
      SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      2,
      `source-snapshot:${id}`,
      [entry.file_manifest_ref, entry.custody_ref]
    );
    artifactContract(
      store,
      entry.provenance_ref,
      "source-provenance",
      SCA_SOURCE_PROVENANCE_V1_SCHEMA,
      1,
      `source-provenance:${id}`,
      [entry.snapshot_ref, entry.file_manifest_ref, entry.custody_ref]
    );
  }
}

/** Host-only exact closure reader. Evidence membership proves admission, not merely same-run custody. */
export function readScaP01VariantCaptureV1(input: {
  readonly store: ArtifactHostStore;
  readonly manifest_ref: ArtifactRef;
  readonly context: CaptureContext;
  readonly evidence_refs?: readonly ArtifactRef[];
  readonly exact_read?: ExactRead;
}): ScaP01VariantCaptureReadV1 {
  if (
    input.context.source.variant_capture_manifest_ref === undefined ||
    !same(input.manifest_ref, input.context.source.variant_capture_manifest_ref)
  )
    throw new Error("variant capture request/root presence or ref mismatch");
  const manifest = validateScaP01VariantCaptureManifestV1(
    exactJson(input.store, input.manifest_ref, input.exact_read)
  );
  if (input.manifest_ref.run_id !== manifest.run_id)
    throw new Error("variant capture root belongs to another campaign");
  const members = scaP01VariantCaptureManifestRefs(manifest);
  artifactContract(
    input.store,
    input.manifest_ref,
    KIND,
    SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
    1,
    OPERATION,
    members
  );
  validateClosure(input.store, manifest, input.context, input.exact_read);
  const allRefs = ordered([input.manifest_ref, ...members]);
  if (input.evidence_refs !== undefined) {
    const evidence = new Map(input.evidence_refs.map((ref) => [ref.artifact_id, ref]));
    for (const ref of allRefs)
      if (!same(evidence.get(ref.artifact_id) ?? null, ref))
        throw new Error("variant capture closure is not in accepted admission evidence");
  }
  return { manifest, all_refs: allRefs };
}

/** Build from already captured refs only. No discovery, scanner, network, or qualification. */
export function buildScaP01VariantCaptureManifestV1(input: {
  readonly store: ArtifactHostStore;
  readonly manifest: unknown;
}): ArtifactRef {
  const manifest = validateScaP01VariantCaptureManifestV1(input.manifest);
  const context = {
    ...manifest,
    source: {
      snapshot_ref: manifest.baseline_snapshot_ref,
      provenance_ref: manifest.baseline_provenance_ref,
    },
  };
  validateClosure(input.store, manifest, context);
  const artifactInput = {
    metadata: {
      schema_version: 2 as const,
      run_id: manifest.run_id,
      phase: PHASE,
      branch_id: null,
      kind: KIND,
      operation_id: OPERATION,
      version: 1,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      media_type: "application/json",
      content_schema: { schema_id: SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...scaP01VariantCaptureManifestRefs(manifest)],
    },
    content: canonicalJson(manifest),
  };
  const planned = previewArtifactRef(artifactInput);
  // Complete semantic preflight and exact member reread before publication.
  validateClosure(input.store, manifest, context);
  const ref = input.store.persist(artifactInput);
  if (!same(ref, planned)) throw new Error("variant capture persisted ref drifted");
  readScaP01VariantCaptureV1({
    store: input.store,
    manifest_ref: ref,
    context: { ...context, source: { ...context.source, variant_capture_manifest_ref: ref } },
  });
  return currentArtifactRef(ref);
}
