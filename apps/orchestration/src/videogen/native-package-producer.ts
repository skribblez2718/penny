import { NativeBuildResultV1Schema } from "./stage-contracts.js";
import type { ArtifactRef } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { readExact, readSemantic, sameRef } from "./bounds.js";
import { inspectEditDecision, isExternalEditEvidence } from "./edit-decision.js";
import { ScriptV1Schema } from "./foundation-contracts.js";
import { checkRights, ProvenanceBindingV1Schema } from "./rights-ledger.js";
import { type PortableManifestV1, EditFeatureSubsetV1Schema } from "./edit-contracts.js";
import { NativeProductProducer } from "./native-products.js";
import {
  inspectPortablePackage,
  portablePathFor,
  type PortableHostV1,
} from "./portable-package.js";
import { NativeQualifiedRawResultV1Schema } from "./native-contracts.js";
type Role = PortableManifestV1["files"][number]["role"];
/** Builds the complete existing manifest contract from current semantic/rights closure and
 * exact custodied native products. Inputs are individual canonical operands, never a supplied
 * manifest or a qualified/PASS flag. No rights, licenses or environment files are invented. */
export function produceNativePortableManifest(input: {
  readonly producer: NativeProductProducer;
  readonly operation_record_id: string;
  readonly host: PortableHostV1;
  readonly edit_ref: ArtifactRef;
  readonly package_id: string;
  readonly credits_ref: ArtifactRef;
  readonly provenance_ref: ArtifactRef;
  readonly feature_subset_ref: ArtifactRef;
  readonly quantization_ref: ArtifactRef;
  readonly instructions_ref: ArtifactRef;
  readonly environment: PortableManifestV1["environment"];
  readonly environment_files: readonly { readonly id: string; readonly ref: ArtifactRef }[];
}): {
  readonly manifest: PortableManifestV1;
  readonly native_ref: ArtifactRef;
  readonly canonical_bytes: Buffer;
} {
  if (!(input.producer instanceof NativeProductProducer))
    throw new Error("concrete native product custody required");
  const host = input.host,
    product = input.producer.produce(input.operation_record_id, host);
  for (const ref of [
    product.normalized_project_ref,
    product.accepted_master_ref,
    ...product.required_assets.map((a) => a.source_ref),
    ...input.environment_files.map((f) => f.ref),
  ]) {
    const current = host.current_rights.find((r) => sameRef(r.subject_ref, ref));
    if (!current) throw new Error("native package current rights binding required");
    checkRights(host, ref, current.rights_ref, "deliver");
  }
  const raw = readSemantic({
    ...host,
    ref: product.raw_ref,
    schema: NativeQualifiedRawResultV1Schema,
    schema_id: "penny.videogen-native-raw-result.v1",
  });
  if (!sameRef(input.edit_ref, product.edit_ref))
    throw new Error("native package exact edit reference substitution");
  const closure = inspectEditDecision(host, input.edit_ref),
    edit = closure.edit;
  // The caller may not package a different current edit alongside a qualifying operation.
  const roundtrip = readSemantic({
    ...host,
    ref: product.native_ref,
    schema: NativeBuildResultV1Schema,
    schema_id: "penny.videogen-native-build-result.v1",
  });
  const roundtripBytes = readExact(
    host.store,
    host.project_id,
    roundtrip.roundtrip_edit_ref,
    host.limits.max_json_bytes
  );
  if (!roundtripBytes.equals(Buffer.from(canonicalJson(edit))))
    throw new Error("native package edit substitution");
  readSemantic({
    ...host,
    ref: input.feature_subset_ref,
    schema: EditFeatureSubsetV1Schema,
    schema_id: "penny.videogen-edit-feature-subset.v1",
  });
  const pins = input.producer.environmentPins;
  if (
    input.environment.editor_build !== pins.editor ||
    input.environment.mlt_build !== pins.mlt ||
    input.environment.decoder_build !== raw.comparison.decoder_runtime_sha256 ||
    input.environment.encoder_build !== raw.phases[3]?.processes[0]?.executable_sha256 ||
    input.environment.config_digest !== raw.phases[0]?.runtime_sha256 ||
    input.environment.os_arch !== `${process.platform}_${process.arch}`
  )
    throw new Error("native observed environment pin drift");
  const refs = new Map<string, ArtifactRef>(),
    roles = new Map<string, Role>(),
    used = new Map<string, Set<string>>(),
    edges = new Map<string, { from: ArtifactRef; to: ArtifactRef }>();
  const add = (ref: ArtifactRef, role: Role = "documentation", by: string = input.package_id) => {
    if (isExternalEditEvidence(ref)) return;
    const old = refs.get(ref.artifact_id);
    if (old && !sameRef(old, ref)) throw new Error("package artifact alias");
    refs.set(ref.artifact_id, ref);
    if (!roles.has(ref.artifact_id) || role !== "documentation") roles.set(ref.artifact_id, role);
    const u = used.get(ref.artifact_id) ?? new Set<string>();
    u.add(by);
    used.set(ref.artifact_id, u);
  };
  const edge = (from: ArtifactRef, to: ArtifactRef) => {
    if (!sameRef(from, to) && !isExternalEditEvidence(from) && !isExternalEditEvidence(to))
      edges.set(`${from.artifact_id}:${to.artifact_id}`, { from, to });
  };
  for (const ref of closure.dependency_refs) add(ref);
  for (const e of closure.reference_edges) edge(e.from, e.to);
  for (const ref of [
    input.edit_ref,
    edit.source_dependency_ledger_ref,
    input.credits_ref,
    input.provenance_ref,
    input.feature_subset_ref,
    input.quantization_ref,
    input.instructions_ref,
  ])
    add(ref);
  add(input.credits_ref, "credit");
  add(input.provenance_ref, "provenance");
  add(product.accepted_master_ref, "master");
  add(product.normalized_project_ref, "project");
  edge(product.accepted_master_ref, input.edit_ref);
  edge(product.normalized_project_ref, input.edit_ref);
  edge(input.quantization_ref, input.edit_ref);
  for (const track of edit.tracks)
    for (const item of track.items) {
      if (item.kind === "clip") {
        add(
          item.source_ref,
          track.kind === "video"
            ? "original_video"
            : track.kind === "voice"
              ? "voice_stem"
              : "original_audio",
          item.item_id
        );
        edge(product.normalized_project_ref, item.source_ref);
      }
      if (item.kind === "caption") {
        add(item.text_source_ref, "caption_source", item.item_id);
        add(item.style_ref, "documentation", item.item_id);
        edge(product.normalized_project_ref, item.text_source_ref);
        edge(product.normalized_project_ref, item.style_ref);
      }
    }
  for (const f of input.environment_files) {
    const d = input.environment.dependencies.find((d) => d.id === f.id);
    if (!d || !d.packaged || d.digest !== f.ref.content_digest)
      throw new Error("environment payload binding");
    add(f.ref, "documentation", f.id);
  }
  const requiredDigests = new Set(
    raw.phases.flatMap((p) => [
      ...p.fonts.map((f) => f.sha256),
      ...p.processes.flatMap((process) => process.plugins.map((p) => p.sha256)),
    ])
  );
  for (const digest of requiredDigests)
    if (!input.environment_files.some((f) => f.ref.content_digest === digest))
      throw new Error("observed font/plugin missing from portable payload");
  const licenses = new Map<string, ArtifactRef>();
  const pending = [...refs.values()];
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > host.package_policy.max_files)
      throw new Error("native package closure count cap");
    const ref = pending[i];
    if (!ref) throw new Error("package queue corrupt");
    const before = new Set(refs.keys());
    readExact(host.store, host.project_id, ref, host.package_policy.max_file_bytes);
    if (ref.content_schema?.schema_id === "penny.videogen-script.v1") {
      roles.set(ref.artifact_id, "script");
      const script = readSemantic({
        ...host,
        ref,
        schema: ScriptV1Schema,
        schema_id: ref.content_schema.schema_id,
      });
      add(script.story_outline_ref);
      edge(ref, script.story_outline_ref);
    }
    const current = host.current_rights.find((r) => sameRef(r.subject_ref, ref));
    if (current) {
      const rights = checkRights(host, ref, current.rights_ref, "deliver");
      licenses.set(ref.artifact_id, rights.license_ref);
      edge(ref, rights.license_ref);
      add(current.rights_ref, "license");
      edge(ref, current.rights_ref);
      add(rights.license_ref, "license");
      edge(current.rights_ref, rights.license_ref);
      add(rights.provenance_ref, "provenance");
      edge(current.rights_ref, rights.provenance_ref);
      for (const consent of rights.consent_refs) {
        add(consent, "license");
        edge(current.rights_ref, consent);
      }
      const provenance = readSemantic({
        ...host,
        ref: rights.provenance_ref,
        schema: ProvenanceBindingV1Schema,
        schema_id: "penny.videogen-provenance-binding.v1",
      });
      for (const source of provenance.source_refs) {
        add(source);
        edge(rights.provenance_ref, source);
      }
      add(provenance.producer_receipt_ref);
      edge(rights.provenance_ref, provenance.producer_receipt_ref);
    }
    for (const [key, value] of refs) if (!before.has(key)) pending.push(value);
  }
  const files = [...refs.values()]
    .map((ref) => {
      const role = roles.get(ref.artifact_id) ?? "documentation",
        license = licenses.get(ref.artifact_id);
      return {
        relative_path: portablePathFor(ref, role),
        role,
        sha256: ref.content_digest,
        bytes: ref.byte_length,
        media_type: ref.media_type,
        producer_ref: ref,
        ...(license === undefined ? {} : { license_ref: license }),
        used_by: [...(used.get(ref.artifact_id) ?? [])].sort(),
      };
    })
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  for (const asset of product.required_assets) {
    const file = files.find((f) => sameRef(f.producer_ref, asset.source_ref));
    if (!file || file.relative_path !== asset.relative_path)
      throw new Error("portable native resource path drift");
  }
  const path = (ref: ArtifactRef) => {
    const f = files.find((f) => sameRef(f.producer_ref, ref));
    if (!f) throw new Error("package edge payload missing");
    return f.relative_path;
  };
  const manifest = {
    schema_id: "penny.videogen-portable-package.v1",
    schema_version: 1,
    package_id: input.package_id,
    accepted_master: {
      relative_path: path(product.accepted_master_ref),
      sha256: product.accepted_master_ref.content_digest,
      bytes: product.accepted_master_ref.byte_length,
      format: "mp4",
      duration: edit.end_time,
    },
    native_project: {
      relative_path: path(product.normalized_project_ref),
      sha256: product.normalized_project_ref.content_digest,
      bytes: product.normalized_project_ref.byte_length,
      kdenlive_version: "26.08.1",
      mlt_version: "7.41.0",
    },
    edit_decision_ref: input.edit_ref,
    files,
    reference_graph: [...edges.values()]
      .map((e) => ({ from: path(e.from), to: path(e.to) }))
      .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    clip_to_timeline: edit.tracks.flatMap((t) =>
      t.items
        .filter((i) => i.kind === "clip")
        .map((i) => ({
          clip_id: i.item_id,
          track_id: t.track_id,
          start: i.timeline_start,
          end: i.timeline_end,
        }))
    ),
    rights_ledger_ref: edit.source_dependency_ledger_ref,
    credits_ref: input.credits_ref,
    provenance_ref: input.provenance_ref,
    environment: input.environment,
    feature_subset_ref: input.feature_subset_ref,
    known_losses: [],
    instructions_relative_path: path(input.instructions_ref),
  };
  const checked = inspectPortablePackage(host, manifest);
  return {
    manifest: checked.manifest,
    native_ref: product.native_ref,
    canonical_bytes: checked.canonical_bytes,
  };
}
