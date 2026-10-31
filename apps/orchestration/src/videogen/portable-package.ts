import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { previewArtifactRef, type PersistArtifactInput } from "../artifact-store.js";
import type { ArtifactRef } from "../contracts.js";
import { assertUnique } from "../skill-contracts/common.js";
import { ScriptV1Schema, validateScript } from "./foundation-contracts.js";
import {
  exactRef,
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import { compareTime, validateRationalTime } from "./rational-time.js";
import { checkRights, ProvenanceBindingV1Schema } from "./rights-ledger.js";
import {
  EditFeatureSubsetV1Schema,
  EditQuantizationV1Schema,
  PortableManifestV1Schema,
  type PortableManifestV1,
} from "./edit-contracts.js";
import {
  inspectEditDecision,
  isExternalEditEvidence,
  type EditHostV1,
  type EditClosureV1,
  type EditReferenceEdge,
} from "./edit-decision.js";

type PackageFile = PortableManifestV1["files"][number];
export interface PortablePolicyV1 {
  readonly max_files: number;
  readonly max_file_bytes: number;
  readonly max_payload_bytes: number;
}
export interface PortableHostV1 extends EditHostV1 {
  readonly package_policy: PortablePolicyV1;
}
function checkPackageBudget(host: PortableHostV1, manifest: PortableManifestV1): void {
  const policy = host.package_policy;
  for (const value of [policy.max_files, policy.max_file_bytes, policy.max_payload_bytes])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("finite package policy required");
  if (manifest.files.length > policy.max_files) throw new Error("package file count cap");
  let bytes = 0n;
  for (const file of manifest.files) {
    if (file.bytes > policy.max_file_bytes) throw new Error("package individual byte cap");
    bytes += BigInt(file.bytes);
    if (bytes > BigInt(policy.max_payload_bytes)) throw new Error("package aggregate byte cap");
  }
}
export const PORTABLE_MANIFEST_PATH = "manifest.json";
/** Conservative cross-platform path vocabulary. Caller names never become executable addresses. */
export function validatePortablePath(value: string): string {
  if (
    value.length > 512 ||
    !/^[a-zA-Z0-9_./-]+$/.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    path.posix.normalize(value) !== value
  )
    throw new Error("noncanonical internal relative POSIX path");
  for (const part of value.split("/")) {
    if (
      part.length === 0 ||
      part.length > 255 ||
      part.startsWith(".") ||
      part.endsWith(".") ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw new Error("unsafe portable path component");
  }
  return value;
}
/** Stable per exact artifact/role, independent of caller roots, names and package revisions. */
export function portablePathFor(ref: ArtifactRef, role: PackageFile["role"]): string {
  exactRef(ref);
  const suffix =
    role === "project"
      ? ".kdenlive"
      : role === "master" || ref.media_type === "video/mp4"
        ? ".mp4"
        : ref.media_type === "audio/wav"
          ? ".wav"
          : ref.media_type === "font/ttf"
            ? ".ttf"
            : ref.media_type === "font/otf"
              ? ".otf"
              : ref.media_type === "image/png"
                ? ".png"
                : ref.media_type === "application/json"
                  ? ".json"
                  : ".txt";
  return validatePortablePath(`${role}/${ref.artifact_id}${suffix}`);
}
export function validatePortableManifest(
  value: unknown,
  limits: FoundationLimitsV1
): PortableManifestV1 {
  const manifest = validateFoundation(PortableManifestV1Schema, value, limits);
  validateRationalTime(manifest.accepted_master.duration);
  if (manifest.accepted_master.duration.numerator <= 0)
    throw new Error("positive master duration required");
  assertUnique(
    manifest.files.map((f) => validatePortablePath(f.relative_path).toLowerCase()),
    "case-folded package paths"
  );
  assertUnique(
    manifest.files.map((f) => f.producer_ref.artifact_id),
    "payload artifact mapping"
  );
  assertUnique(
    manifest.clip_to_timeline.map((m) => m.clip_id),
    "clip placement mappings"
  );
  assertUnique(
    manifest.environment.dependencies.map((d) => d.id),
    "environment dependencies"
  );
  const paths = manifest.files.map((f) => f.relative_path.toLowerCase()).sort();
  for (let i = 1; i < paths.length; i++) {
    const current = paths[i];
    const prior = paths[i - 1];
    if (current !== undefined && prior !== undefined && current.startsWith(`${prior}/`))
      throw new Error("file/directory collision");
  }
  for (const file of manifest.files) {
    if (
      file.relative_path.toLowerCase() === PORTABLE_MANIFEST_PATH ||
      file.producer_ref.content_schema?.schema_id === manifest.schema_id ||
      isExternalEditEvidence(file.producer_ref)
    )
      throw new Error("manifest excludes self, review and delivery receipts");
    if (
      file.bytes !== file.producer_ref.byte_length ||
      file.sha256 !== file.producer_ref.content_digest ||
      file.media_type !== file.producer_ref.media_type
    )
      throw new Error("payload declared bytes/hash/media drift");
  }
  for (const field of [
    manifest.accepted_master.relative_path,
    manifest.native_project.relative_path,
    manifest.instructions_relative_path,
  ])
    validatePortablePath(field);
  const files = new Set(manifest.files.map((f) => f.relative_path));
  const indegree = new Map(manifest.files.map((f) => [f.relative_path, 0]));
  const outgoing = new Map<string, string[]>();
  assertUnique(
    manifest.reference_graph.map((e) => `${e.from}\n${e.to}`),
    "package reference edges"
  );
  for (const edge of manifest.reference_graph) {
    if (!files.has(edge.from) || !files.has(edge.to) || edge.from === edge.to)
      throw new Error("unlisted/dangling/self resource edge");
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const next = outgoing.get(edge.from) ?? [];
    next.push(edge.to);
    outgoing.set(edge.from, next);
  }
  const queue = manifest.files
    .filter((f) => indegree.get(f.relative_path) === 0)
    .map((f) => f.relative_path);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current === undefined) throw new Error("reference queue corrupt");
    visited++;
    for (const next of outgoing.get(current) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (visited !== manifest.files.length) throw new Error("cyclic package resources");
  return manifest;
}
export interface PortableClosureV1 {
  readonly status: "structural_checked";
  readonly manifest: PortableManifestV1;
  readonly canonical_bytes: Buffer;
  readonly manifest_sha256: string;
  readonly edit_closure: EditClosureV1;
  readonly production_admission: "blocked";
  readonly effect_permission: "none";
  readonly unverified: readonly string[];
}
/** Read-only structural closure. A declared .kdenlive is not native interoperability evidence. */
export function inspectPortablePackage(host: PortableHostV1, value: unknown): PortableClosureV1 {
  const manifest = validatePortableManifest(value, host.limits);
  checkPackageBudget(host, manifest);
  const edit = inspectEditDecision(host, manifest.edit_decision_ref);
  if (!sameRef(manifest.rights_ledger_ref, edit.edit.source_dependency_ledger_ref))
    throw new Error("package/edit rights ledger mismatch");
  if (compareTime(manifest.accepted_master.duration, edit.edit.end_time) !== 0)
    throw new Error("master/edit duration mismatch");
  const byRef = new Map(manifest.files.map((f) => [f.producer_ref.artifact_id, f]));
  function payload(ref: ArtifactRef): PackageFile {
    const file = byRef.get(ref.artifact_id);
    if (file === undefined || !sameRef(file.producer_ref, ref))
      throw new Error("missing exact payload dependency");
    return file;
  }
  const required = new Map(edit.dependency_refs.map((ref) => [ref.artifact_id, ref]));
  const edges: EditReferenceEdge[] = [...edit.reference_edges];
  function requireRef(ref: ArtifactRef, from?: ArtifactRef): void {
    if (isExternalEditEvidence(ref)) return;
    required.set(ref.artifact_id, ref);
    payload(ref);
    if (from !== undefined && !sameRef(from, ref) && !isExternalEditEvidence(from))
      edges.push({ from, to: ref });
  }
  for (const ref of [
    manifest.edit_decision_ref,
    manifest.rights_ledger_ref,
    manifest.credits_ref,
    manifest.provenance_ref,
    manifest.feature_subset_ref,
  ]) {
    if (ref.run_id !== host.run_id) throw new Error("package host operand from another run");
    requireRef(ref);
  }
  const subset = readSemantic({
    ...host,
    ref: manifest.feature_subset_ref,
    schema: EditFeatureSubsetV1Schema,
    schema_id: "penny.videogen-edit-feature-subset.v1",
  });
  const neededFeatures = new Set(["hard_cuts", "ordered_clips", "trims"]);
  for (const track of edit.edit.tracks)
    for (const item of track.items) {
      if (item.kind === "gap") neededFeatures.add("gaps");
      if (item.kind === "caption") neededFeatures.add("captions");
      if (item.kind === "clip" && item.gain_envelope !== undefined)
        neededFeatures.add("voice_gain");
    }
  if (edit.edit.mix_buses.length > 0) neededFeatures.add("voice_gain");
  for (const feature of neededFeatures)
    if (!subset.features.some((f) => f === feature))
      throw new Error("subset would drop an edit feature");
  const master = manifest.files.find(
    (f) => f.relative_path === manifest.accepted_master.relative_path
  );
  const project = manifest.files.find(
    (f) => f.relative_path === manifest.native_project.relative_path
  );
  const instructions = manifest.files.find(
    (f) => f.relative_path === manifest.instructions_relative_path
  );
  if (
    master?.role !== "master" ||
    project?.role !== "project" ||
    instructions?.role !== "documentation" ||
    master.bytes === 0 ||
    project.bytes === 0 ||
    instructions.bytes === 0 ||
    master.media_type !== "video/mp4" ||
    manifest.accepted_master.format !== "mp4" ||
    project.media_type !== "application/x-kdenlive" ||
    !project.relative_path.endsWith(".kdenlive")
  )
    throw new Error("master/native/instructions product missing or substituted");
  for (const [file, descriptor] of [
    [master, manifest.accepted_master],
    [project, manifest.native_project],
  ] as const)
    if (file.sha256 !== descriptor.sha256 || file.bytes !== descriptor.bytes)
      throw new Error("product descriptor drift");
  for (const file of [master, project, instructions]) {
    if (file.producer_ref.run_id !== host.run_id) throw new Error("product belongs to another run");
    requireRef(file.producer_ref);
  }
  requireRef(manifest.edit_decision_ref, master.producer_ref);
  requireRef(manifest.edit_decision_ref, project.producer_ref);
  const placements = edit.edit.tracks.flatMap((track) =>
    track.items.filter((i) => i.kind === "clip").map((clip) => ({ track, clip }))
  );
  if (manifest.clip_to_timeline.length !== placements.length)
    throw new Error("clip mapping coverage");
  for (const { track, clip } of placements) {
    const mapping = manifest.clip_to_timeline.find((m) => m.clip_id === clip.item_id);
    if (
      mapping === undefined ||
      mapping.track_id !== track.track_id ||
      compareTime(mapping.start, clip.timeline_start) !== 0 ||
      compareTime(mapping.end, clip.timeline_end) !== 0
    )
      throw new Error("stable placement ID/track/span mismatch");
    const source = payload(clip.source_ref);
    requireRef(clip.source_ref, project.producer_ref);
    if (
      track.kind === "video"
        ? source.role !== "original_video"
        : !["voice_stem", "original_audio"].includes(source.role)
    )
      throw new Error("proxy-only or wrong original role");
    if (!source.used_by.includes(clip.item_id))
      throw new Error("source missing placement association");
  }
  for (const track of edit.edit.tracks)
    for (const item of track.items)
      if (item.kind === "caption") {
        if (payload(item.text_source_ref).role !== "caption_source")
          throw new Error("active caption source missing");
        requireRef(item.text_source_ref, project.producer_ref);
        requireRef(item.style_ref, project.producer_ref);
      }
  const supportingRights = new Set<string>();
  for (const row of host.current_rights) {
    const grant = checkRights(host, row.subject_ref, row.rights_ref, "deliver");
    const provenance = readSemantic({
      ...host,
      ref: grant.provenance_ref,
      schema: ProvenanceBindingV1Schema,
      schema_id: "penny.videogen-provenance-binding.v1",
    });
    for (const ref of [
      row.rights_ref,
      grant.license_ref,
      grant.provenance_ref,
      ...grant.consent_refs,
      provenance.producer_receipt_ref,
    ])
      supportingRights.add(ref.artifact_id);
  }
  let scripts = 0;
  const knownIds = new Set([
    manifest.package_id,
    ...host.current_dependencies.map((n) => n.stable_id),
    ...edit.edit.tracks.flatMap((t) => t.items.map((i) => i.item_id)),
    ...manifest.environment.dependencies.map((d) => d.id),
  ]);
  for (const file of manifest.files) {
    if (file.relative_path !== portablePathFor(file.producer_ref, file.role))
      throw new Error("unstable internal artifact path");
    if (file.used_by.some((id) => !knownIds.has(id)))
      throw new Error("dangling used_by association");
    readExact(host.store, host.project_id, file.producer_ref, host.limits.max_integer);
    const current = host.current_rights.find((r) => sameRef(r.subject_ref, file.producer_ref));
    const needsRights = [
      "original_video",
      "original_audio",
      "voice_stem",
      "reference",
      "reference_revision",
      "script",
      "caption_source",
      "title_asset",
      "master",
      "project",
    ].includes(file.role);
    if (needsRights || current !== undefined) {
      if (current === undefined) throw new Error("payload current rights missing");
      const rights = checkRights(host, file.producer_ref, current.rights_ref, "deliver");
      if (file.license_ref === undefined || !sameRef(file.license_ref, rights.license_ref))
        throw new Error("payload license binding mismatch");
      requireRef(current.rights_ref, file.producer_ref);
      requireRef(rights.license_ref, current.rights_ref);
      requireRef(rights.provenance_ref, current.rights_ref);
      for (const consent of rights.consent_refs) requireRef(consent, current.rights_ref);
      const provenance = readSemantic({
        ...host,
        ref: rights.provenance_ref,
        schema: ProvenanceBindingV1Schema,
        schema_id: "penny.videogen-provenance-binding.v1",
      });
      for (const original of provenance.source_refs) requireRef(original, rights.provenance_ref);
      requireRef(provenance.producer_receipt_ref, rights.provenance_ref);
    } else if (
      file.producer_ref.run_id !== host.run_id &&
      !supportingRights.has(file.producer_ref.artifact_id)
    )
      throw new Error("unapproved cross-run payload");
    if (file.license_ref !== undefined) requireRef(file.license_ref, file.producer_ref);
    if (file.role === "script") {
      const script = validateScript(
        readSemantic({
          ...host,
          ref: file.producer_ref,
          schema: ScriptV1Schema,
          schema_id: "penny.videogen-script.v1",
        }),
        host.limits
      );
      scripts++;
      requireRef(script.story_outline_ref, file.producer_ref);
    }
  }
  if (scripts === 0) throw new Error("complete script payload required");
  const quantizedFiles = manifest.files.filter(
    (f) => f.producer_ref.content_schema?.schema_id === "penny.videogen-edit-quantization.v1"
  );
  if (quantizedFiles.length !== 1)
    throw new Error("persisted exact quantization residuals required");
  for (const file of quantizedFiles) {
    if (file.producer_ref.run_id !== host.run_id) throw new Error("quantization run mismatch");
    const quantized = readSemantic({
      ...host,
      ref: file.producer_ref,
      schema: EditQuantizationV1Schema,
      schema_id: "penny.videogen-edit-quantization.v1",
    });
    if (canonicalJson(quantized) !== canonicalJson(edit.quantization))
      throw new Error("persisted quantization drift");
    requireRef(file.producer_ref);
    requireRef(manifest.edit_decision_ref, file.producer_ref);
  }
  for (const ref of required.values()) payload(ref);
  for (const dependency of manifest.environment.dependencies) {
    if (
      !dependency.packaged ||
      !manifest.files.some(
        (f) => f.sha256 === dependency.digest && f.used_by.includes(dependency.id)
      )
    )
      throw new Error("unpackaged environment dependency");
  }
  for (const edge of edges) {
    const from = payload(edge.from).relative_path;
    const to = payload(edge.to).relative_path;
    if (!manifest.reference_graph.some((e) => e.from === from && e.to === to))
      throw new Error("dropped semantic resource dependency");
  }
  // Native XML resource introspection belongs to the unqualified confined adapter, not a guess here.
  const canonicalBytes = Buffer.from(canonicalJson(manifest), "utf8");
  return {
    status: "structural_checked",
    manifest,
    canonical_bytes: canonicalBytes,
    manifest_sha256: sha256(canonicalBytes),
    edit_closure: edit,
    production_admission: "blocked",
    effect_permission: "none",
    unverified: [
      ...edit.unverified,
      "native_xml_resource_and_plugin_readback",
      "editor_open_save_reopen_relocation_render_comparison",
      "environment_dependency_qualification",
      "external_manifest_bound_reviews",
    ],
  };
}

function assertPrivateDirectory(root: string): void {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error("absolute canonical caller staging root required");
  let cursor = path.parse(root).root;
  for (const component of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("staging ancestor is not a no-follow directory");
  }
  const stat = lstatSync(root);
  if (
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    realpathSync(root) !== root
  )
    throw new Error("owner-only staging required");
}
function syncDirectory(root: string): void {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Atomic complete file with exclusive link publication; neither overwrite nor destination delivery. */
function writeAtomic(root: string, relative: string, bytes: Buffer): void {
  validatePortablePath(relative);
  const target = path.join(root, relative);
  const parent = path.dirname(target);
  if (parent !== root) {
    const components = relative.split("/").slice(0, -1);
    let cursor = root;
    for (const component of components) {
      cursor = path.join(cursor, component);
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      assertPrivateDirectory(cursor);
    }
  }
  assertPrivateDirectory(parent);
  const temporary = path.join(parent, `.pending-${path.basename(relative)}`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, target);
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(parent);
}
function readNoFollow(root: string, relative: string, cap: number): Buffer {
  const target = path.join(root, validatePortablePath(relative));
  assertPrivateDirectory(path.dirname(target));
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid()) ||
      stat.size > cap
    )
      throw new Error("unsafe/nonregular/linked/oversized payload file");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("payload changed during bounded read");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
function checkTree(root: string, expected: ReadonlySet<string>, cap: number): void {
  assertPrivateDirectory(root);
  const seen = new Set<string>();
  let entries = 0;
  function walk(directory: string, prefix: string): void {
    const directoryHandle = opendirSync(directory);
    try {
      for (
        let entry = directoryHandle.readSync();
        entry !== null;
        entry = directoryHandle.readSync()
      ) {
        if (++entries > cap) throw new Error("staging tree complexity limit");
        const name = entry.name;
        const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
        validatePortablePath(relative);
        const target = path.join(root, relative);
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error("symlink payload");
        if (stat.isDirectory()) {
          if (![...expected].some((p) => p.startsWith(`${relative}/`)))
            throw new Error("unlisted payload directory");
          assertPrivateDirectory(target);
          walk(target, relative);
        } else {
          if (!stat.isFile() || stat.nlink !== 1 || !expected.has(relative))
            throw new Error("unlisted/linked/nonregular payload");
          seen.add(relative);
        }
      }
    } finally {
      directoryHandle.closeSync();
    }
  }
  walk(root, "");
  if (seen.size !== expected.size) throw new Error("payload tree coverage");
}
function verifyPayload(
  host: PortableHostV1,
  manifest: PortableManifestV1,
  root: string,
  withManifest: boolean
): void {
  checkTree(
    root,
    new Set([
      ...manifest.files.map((f) => f.relative_path),
      ...(withManifest ? [PORTABLE_MANIFEST_PATH] : []),
    ]),
    host.limits.max_nodes
  );
  for (const file of manifest.files) {
    const actual = readNoFollow(root, file.relative_path, file.bytes);
    const canonical = readExact(
      host.store,
      host.project_id,
      file.producer_ref,
      host.limits.max_integer
    );
    if (actual.length !== file.bytes || sha256(actual) !== file.sha256 || !actual.equals(canonical))
      throw new Error("payload hash/readback drift");
  }
}
export interface FrozenPortableStageV1 extends PortableClosureV1 {
  readonly staging_root: string;
  readonly manifest_ref: ArtifactRef;
}
/** Only caller-supplied disposable, owner-only staging. Not a host operation, signer or delivery. */
export function stageFrozenPortablePackage(input: {
  readonly host: PortableHostV1;
  readonly manifest: unknown;
  readonly staging_parent: string;
  readonly output_metadata: PersistArtifactInput["metadata"];
}): FrozenPortableStageV1 {
  const checked = inspectPortablePackage(input.host, input.manifest);
  const prepared = {
    metadata: input.output_metadata,
    content: checked.canonical_bytes,
  } satisfies PersistArtifactInput;
  const expectedRef = previewArtifactRef(prepared);
  if (
    expectedRef.run_id !== input.host.run_id ||
    !expectedRef.producer.startsWith("host:") ||
    expectedRef.media_type !== "application/json" ||
    expectedRef.content_schema?.schema_id !== checked.manifest.schema_id ||
    expectedRef.content_schema.schema_version !== 1
  )
    throw new Error("host manifest output identity required");
  assertPrivateDirectory(input.staging_parent);
  const root = mkdtempSync(path.join(input.staging_parent, "videogen-package-"));
  // A failure retains only this exclusive partial stage, never a positive result or user destination.
  for (const file of checked.manifest.files)
    writeAtomic(
      root,
      file.relative_path,
      readExact(
        input.host.store,
        input.host.project_id,
        file.producer_ref,
        input.host.limits.max_integer
      )
    );
  verifyPayload(input.host, checked.manifest, root, false); // ALL payload hashes before manifest.
  writeAtomic(root, PORTABLE_MANIFEST_PATH, checked.canonical_bytes);
  syncDirectory(root);
  syncDirectory(input.staging_parent);
  const manifestRef = input.host.store.persist(prepared); // Existing canonical owner only.
  if (!sameRef(manifestRef, expectedRef)) throw new Error("persisted manifest identity drift");
  const verified = verifyFrozenPortablePackage({
    host: input.host,
    manifest_ref: manifestRef,
    staging_root: root,
  });
  return { ...verified, staging_root: root, manifest_ref: manifestRef };
}
/** Reopen exact canonical manifest and recheck CURRENT rights/operands and every staged file. */
export function verifyFrozenPortablePackage(input: {
  readonly host: PortableHostV1;
  readonly manifest_ref: ArtifactRef;
  readonly staging_root: string;
}): PortableClosureV1 {
  if (input.manifest_ref.run_id !== input.host.run_id)
    throw new Error("manifest current run mismatch");
  const manifest = readSemantic({
    ...input.host,
    ref: input.manifest_ref,
    schema: PortableManifestV1Schema,
    schema_id: "penny.videogen-portable-package.v1",
  });
  const checked = inspectPortablePackage(input.host, manifest);
  verifyPayload(input.host, manifest, input.staging_root, true);
  const bytes = readNoFollow(
    input.staging_root,
    PORTABLE_MANIFEST_PATH,
    input.host.limits.max_json_bytes
  );
  if (!bytes.equals(checked.canonical_bytes) || sha256(bytes) !== input.manifest_ref.content_digest)
    throw new Error("frozen manifest hash drift");
  return checked;
}
