/** Exact no-follow source capture, shared by ordinary SCA and the portable snapshot CLI. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateScaRequestV1 } from "../skill-contracts/sca-request.js";
import { SCA_MODEL_ALIAS } from "./model-identity.js";
const STATIC_MAX_FILES = 100_000;
const STATIC_MAX_FILE_BYTES = 2_097_152;
export const SCA_STATIC_MAX_TOTAL_BYTES = 134_217_728;
const STATIC_MAX_SOURCE_CORPUS_BYTES = 192 * 1_024 * 1_024;
interface CapturedTextSource {
  readonly path: string;
  readonly bytes: Buffer;
  readonly content_sha256: string;
}

interface StaticInventoryBuild {
  readonly sourceCorpus: Buffer;
  readonly sourceSnapshotSha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly byte_length: number;
    readonly content_sha256: string;
  }[];
}

export interface ScaSourceSnapshotDescriptionV1 {
  readonly schema_id: "penny.sca-source-snapshot-description.v1";
  readonly schema_version: 1;
  readonly source_root: string;
  readonly scope: ReturnType<typeof validateScaRequestV1>["scope"];
  readonly files: StaticInventoryBuild["files"];
  readonly source_snapshot_sha256: string;
}

class StaticSourceCaptureError extends Error {
  constructor(
    readonly code: "unsafe-file" | "path-race" | "unreadable-file" | "byte-limit",
    message: string
  ) {
    super(message);
    this.name = "StaticSourceCaptureError";
  }
}

function scopePathMatches(prefix: string, relativePath: string): boolean {
  return (
    prefix === "." ||
    relativePath === prefix ||
    relativePath.startsWith(`${prefix.replace(/\/$/u, "")}/`)
  );
}

function scopeContains(
  request: ReturnType<typeof validateScaRequestV1>,
  relativePath: string
): boolean {
  const matches = (prefix: string) => scopePathMatches(prefix, relativePath);
  return (
    (request.scope.include.length === 0 || request.scope.include.some(matches)) &&
    !request.scope.exclude.some(matches)
  );
}

export function computeScaSourceSnapshotSha256(input: {
  readonly scope: ReturnType<typeof validateScaRequestV1>["scope"];
  readonly files: readonly { path: string; byte_length: number; content_sha256: string }[];
}): string {
  return sha256(
    canonicalJson({
      schema_id: "penny.sca-source-snapshot.v1",
      schema_version: 1,
      scope: input.scope,
      files: input.files,
    })
  );
}

export function allowsScaStaticBytes(currentBytes: number, nextBytes: number): boolean {
  return (
    Number.isSafeInteger(currentBytes) &&
    Number.isSafeInteger(nextBytes) &&
    currentBytes >= 0 &&
    nextBytes >= 0 &&
    currentBytes <= SCA_STATIC_MAX_TOTAL_BYTES &&
    nextBytes <= SCA_STATIC_MAX_TOTAL_BYTES - currentBytes
  );
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function capturedDescriptorPath(descriptor: number): string {
  try {
    return realpathSync.native(`/proc/self/fd/${descriptor}`);
  } catch {
    throw new StaticSourceCaptureError(
      "unsafe-file",
      "SCA source capture requires a stable descriptor path"
    );
  }
}

/** Captures one source file through the same no-follow, bounded path used by SCA admission. */
export function captureScaStaticSourceFile(input: {
  readonly sourceRoot: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly onBeforeRead?: () => void;
}): Buffer {
  const absolute = path.join(input.sourceRoot, ...input.relativePath.split("/"));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(absolute, { bigint: true });
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      opened.nlink !== 1n ||
      !sameFileIdentity(opened, linked) ||
      !pathIsWithin(input.sourceRoot, capturedDescriptorPath(descriptor))
    ) {
      throw new StaticSourceCaptureError(
        "unsafe-file",
        `SCA source path '${input.relativePath}' is not a stable regular file within the admitted root`
      );
    }
    if (opened.size > BigInt(input.maximumBytes)) {
      throw new StaticSourceCaptureError(
        "byte-limit",
        `SCA source path '${input.relativePath}' exceeds the remaining byte limit`
      );
    }
    input.onBeforeRead?.();
    const byteLength = Number(opened.size);
    const bytes = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const read = readSync(descriptor, bytes, offset, byteLength - offset, offset);
      if (read === 0) {
        throw new StaticSourceCaptureError(
          "path-race",
          `SCA source path '${input.relativePath}' became shorter while captured`
        );
      }
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, byteLength) !== 0) {
      throw new StaticSourceCaptureError(
        "path-race",
        `SCA source path '${input.relativePath}' became longer while captured`
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    const linkedAfter = lstatSync(absolute, { bigint: true });
    if (
      !after.isFile() ||
      !linkedAfter.isFile() ||
      after.nlink !== 1n ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(opened, linkedAfter) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      !pathIsWithin(input.sourceRoot, capturedDescriptorPath(descriptor))
    ) {
      throw new StaticSourceCaptureError(
        "path-race",
        `SCA source path '${input.relativePath}' changed while captured`
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof StaticSourceCaptureError) throw error;
    throw new StaticSourceCaptureError(
      "unreadable-file",
      `SCA source path '${input.relativePath}' could not be captured`
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function asStrictUtf8(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sourceCorpusFrame(source: CapturedTextSource): readonly Buffer[] {
  const header = Buffer.from(
    `SCA_SOURCE_FILE ${canonicalJson({
      path: source.path,
      byte_length: source.bytes.byteLength,
      content_sha256: source.content_sha256,
    })}\n`,
    "utf8"
  );
  return [header, source.bytes, Buffer.from("\nSCA_SOURCE_FILE_END\n", "utf8")];
}

export function buildHostStaticInventory(
  request: ReturnType<typeof validateScaRequestV1>,
  verifyExpectedSnapshot = true
): StaticInventoryBuild {
  let sourceRoot: string;
  try {
    sourceRoot = realpathSync.native(request.source_root);
    if (!lstatSync(sourceRoot, { bigint: true }).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error("SCA source root is not a readable directory");
  }
  const discovered: string[] = [];
  const gaps: string[] = [];
  const stack = [sourceRoot];
  while (stack.length > 0 && discovered.length < STATIC_MAX_FILES) {
    const current = stack.pop();
    if (current === undefined) break;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      gaps.push(`unreadable:${path.relative(sourceRoot, current) || "."}`);
      continue;
    }
    const relative = path.relative(sourceRoot, current).split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      gaps.push(`symlink:${relative || "."}`);
      continue;
    }
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(current).sort((left, right) => right.localeCompare(left));
      } catch {
        gaps.push(`unreadable-directory:${relative || "."}`);
        continue;
      }
      for (const name of names) {
        if (name === ".git") continue;
        const child = path.join(current, name);
        const childRelative = path.relative(sourceRoot, child).split(path.sep).join("/");
        if (request.scope.exclude.some((prefix) => scopePathMatches(prefix, childRelative)))
          continue;
        stack.push(child);
      }
      continue;
    }
    if (stat.isFile() && scopeContains(request, relative)) discovered.push(relative);
  }
  if (stack.length > 0) gaps.push(`file-limit:${STATIC_MAX_FILES}`);
  discovered.sort((left, right) => left.localeCompare(right));
  const files: Array<{ path: string; byte_length: number; content_sha256: string }> = [];
  const textSources: CapturedTextSource[] = [];
  const sourceCorpusExclusions: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;
  for (const relative of discovered) {
    if (totalBytes >= SCA_STATIC_MAX_TOTAL_BYTES) {
      gaps.push(`byte-limit:${SCA_STATIC_MAX_TOTAL_BYTES}`);
      break;
    }
    let bytes: Buffer;
    try {
      bytes = captureScaStaticSourceFile({
        sourceRoot,
        relativePath: relative,
        maximumBytes: Math.min(STATIC_MAX_FILE_BYTES, SCA_STATIC_MAX_TOTAL_BYTES - totalBytes),
      });
    } catch (error) {
      const code = error instanceof StaticSourceCaptureError ? error.code : "unreadable-file";
      gaps.push(`${code}:${relative}`);
      continue;
    }
    if (!allowsScaStaticBytes(totalBytes, bytes.byteLength)) {
      gaps.push(`byte-limit:${SCA_STATIC_MAX_TOTAL_BYTES}`);
      break;
    }
    totalBytes += bytes.byteLength;
    const contentSha256 = sha256(bytes);
    files.push({ path: relative, byte_length: bytes.byteLength, content_sha256: contentSha256 });
    const text = asStrictUtf8(bytes);
    if (text === undefined) {
      sourceCorpusExclusions.push({ path: relative, reason: "binary_or_non_utf8" });
      continue;
    }
    textSources.push({ path: relative, bytes, content_sha256: contentSha256 });
  }
  if (gaps.length > 0) {
    throw new Error(
      `SCA source snapshot could not be bound completely: ${[...new Set(gaps)].sort().join(", ")}`
    );
  }
  const computedSourceSnapshotSha256 = computeScaSourceSnapshotSha256({
    scope: request.scope,
    files,
  });
  if (
    verifyExpectedSnapshot &&
    request.source_snapshot_sha256 !== undefined &&
    computedSourceSnapshotSha256 !== request.source_snapshot_sha256
  ) {
    throw new Error(
      `SCA source snapshot digest mismatch: expected ${request.source_snapshot_sha256}, computed ${computedSourceSnapshotSha256}`
    );
  }
  const sourceCorpusParts: Buffer[] = [
    Buffer.from(
      `${canonicalJson({
        schema_id: "penny.sca-source-corpus.v1",
        schema_version: 1,
        source_snapshot_sha256: computedSourceSnapshotSha256,
        text_file_count: textSources.length,
        excluded_files: sourceCorpusExclusions,
        frame_format:
          "Each frame is SCA_SOURCE_FILE plus canonical JSON metadata, a newline, exact UTF-8 source bytes, then SCA_SOURCE_FILE_END.",
      })}\n`,
      "utf8"
    ),
  ];
  let sourceCorpusBytes = sourceCorpusParts[0]?.byteLength ?? 0;
  for (const source of textSources) {
    const frame = sourceCorpusFrame(source);
    const frameBytes = frame.reduce((total, part) => total + part.byteLength, 0);
    if (sourceCorpusBytes + frameBytes > STATIC_MAX_SOURCE_CORPUS_BYTES) {
      throw new Error(`SCA sealed source corpus exceeds ${STATIC_MAX_SOURCE_CORPUS_BYTES} bytes`);
    }
    sourceCorpusParts.push(...frame);
    sourceCorpusBytes += frameBytes;
  }
  return {
    sourceCorpus: Buffer.concat(sourceCorpusParts, sourceCorpusBytes),
    sourceSnapshotSha256: computedSourceSnapshotSha256,
    files,
  };
}

/**
 * Computes the caller-facing portable digest through the exact discovery and no-follow capture
 * path used by active SCA admission. It performs no model, broker, network, or target execution.
 */
export function describeScaSourceSnapshotV1(input: {
  readonly source_root: string;
  readonly scope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
}): ScaSourceSnapshotDescriptionV1 {
  const request = validateScaRequestV1({
    schema_version: 1,
    purpose: "Compute the exact SCA source snapshot digest without starting a run.",
    source_root: input.source_root,
    source_snapshot_sha256: "0".repeat(64),
    scope: input.scope,
    execution_mode: "static_only",
    model: SCA_MODEL_ALIAS,
  });
  const built = buildHostStaticInventory(request, false);
  return Object.freeze({
    schema_id: "penny.sca-source-snapshot-description.v1",
    schema_version: 1,
    source_root: realpathSync.native(request.source_root),
    scope: request.scope,
    files: Object.freeze(built.files.map((entry) => Object.freeze({ ...entry }))),
    source_snapshot_sha256: built.sourceSnapshotSha256,
  });
}
