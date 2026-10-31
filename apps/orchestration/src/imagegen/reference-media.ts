import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { decodePng, encodeCanonicalPng, validateCanonicalPng } from "../png-media.js";
import type { ImageAssetRequestV1, ImageInputBindingV1 } from "./reference-contracts.js";

export function readReferencePng(
  store: Pick<ArtifactHostStore, "refById" | "readById">,
  ref: ArtifactRef,
  role: "source" | "mask"
): Uint8Array {
  if (
    ref.media_type !== "image/png" ||
    (role === "source"
      ? !["generated-image", "reference-image"].includes(ref.kind)
      : ref.kind !== "reference-mask")
  )
    throw new Error("canonical reference PNG role mismatch");
  if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref))
    throw new Error("reference custody mismatch");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("reference bytes mismatch");
  validateCanonicalPng(bytes);
  return bytes;
}
export function editMask(
  source: Uint8Array,
  asset: ImageAssetRequestV1,
  mask?: Uint8Array
): Uint8Array | null {
  const info = validateCanonicalPng(source);
  if (asset.input.kind !== "revision") throw new Error("revision source missing");
  const area = asset.input.area;
  if (area.kind === "whole") {
    if (mask !== undefined) throw new Error("unexpected mask");
    return null;
  }
  if (area.kind === "mask") {
    if (mask === undefined) throw new Error("mask missing");
    const decoded = decodePng(mask);
    validateCanonicalPng(mask);
    if (decoded.info.width !== info.width || decoded.info.height !== info.height)
      throw new Error("mask canvas mismatch");
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      const v = decoded.rgba[i];
      if (
        (v !== 0 && v !== 255) ||
        decoded.rgba[i + 1] !== v ||
        decoded.rgba[i + 2] !== v ||
        decoded.rgba[i + 3] !== 255
      )
        throw new Error("mask must be opaque binary grayscale white-edit black-keep");
    }
    return mask;
  }
  if (mask !== undefined || area.x + area.width > info.width || area.y + area.height > info.height)
    throw new Error("rectangle outside source canvas");
  const rgba = new Uint8Array(info.width * info.height * 4);
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const v =
        x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height ? 255 : 0;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  return encodeCanonicalPng({ width: info.width, height: info.height, rgba });
}
/** Convert only an independently bound backend polarity, retaining the original edit mask. */
export function backendMask(mask: Uint8Array, polarity: "white_edit" | "black_edit"): Uint8Array {
  if (polarity === "white_edit") return mask;
  const decoded = decodePng(mask);
  const rgba = Uint8Array.from(decoded.rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    const v = rgba[i];
    if (v === undefined) throw new Error("mask pixel missing");
    rgba[i] = 255 - v;
    rgba[i + 1] = 255 - v;
    rgba[i + 2] = 255 - v;
  }
  return encodeCanonicalPng({ width: decoded.info.width, height: decoded.info.height, rgba });
}
export function compositeRevision(
  source: Uint8Array,
  rawCanonical: Uint8Array,
  mask: Uint8Array | null
): { bytes: Uint8Array; outside: number } {
  const original = decodePng(source),
    raw = decodePng(rawCanonical);
  if (original.info.width !== raw.info.width || original.info.height !== raw.info.height)
    throw new Error("revision output canvas changed");
  if (mask === null) return { bytes: rawCanonical, outside: 0 };
  const selection = decodePng(mask);
  const rgba = Uint8Array.from(raw.rgba);
  let outside = 0;
  for (let i = 0; i < rgba.length; i += 4)
    if (selection.rgba[i] === 0) {
      rgba.set(original.rgba.subarray(i, i + 4), i);
      outside++;
    }
  const bytes = encodeCanonicalPng({
    width: original.info.width,
    height: original.info.height,
    rgba,
  });
  const final = decodePng(bytes);
  for (let i = 0; i < rgba.length; i += 4)
    if (selection.rgba[i] === 0)
      for (let c = 0; c < 4; c++)
        if (final.rgba[i + c] !== original.rgba[i + c])
          throw new Error("outside pixel verification failed");
  return { bytes, outside };
}
export function persistReferenceMask(
  store: ArtifactHostStore,
  runId: string,
  bytes: Uint8Array,
  upstream: ArtifactRef[]
): ArtifactRef {
  validateCanonicalPng(bytes);
  const metadata = {
    schema_version: 2 as const,
    run_id: runId,
    phase: "intake",
    branch_id: null,
    kind: "image-edit-mask",
    operation_id: `image-mask-${sha256(bytes).slice(0, 32)}-${sha256(canonicalJson(upstream)).slice(0, 32)}`,
    version: 1,
    producer: "host:imagegen-reference",
    media_type: "image/png",
    parent_ref: null,
    upstream_refs: upstream,
  };
  const old = store.refFor(runId, metadata.phase, null, metadata.kind, metadata.operation_id, 1);
  const ref = old ?? store.persist({ metadata, content: bytes });
  if (
    sha256(store.readById(ref.artifact_id)) !== sha256(bytes) ||
    canonicalJson(store.metadata(ref)) !== canonicalJson(metadata)
  )
    throw new Error("mask custody conflict");
  return ref;
}
export function referenceOperands(binding: ImageInputBindingV1): ArtifactRef[] {
  return [
    binding.source_ref,
    ...(binding.edit_mask_ref === null ? [] : [binding.edit_mask_ref]),
    ...(binding.backend_mask_ref === null ? [] : [binding.backend_mask_ref]),
    ...binding.uploads,
  ];
}
