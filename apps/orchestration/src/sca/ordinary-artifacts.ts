import type { TSchema, Static } from "typebox";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef, type OutputArtifactMetadata } from "../contracts.js";
import type { RunContext } from "../context.js";
import { parseSealedScaSourceCorpusV1, type ParsedScaSourceCorpusV1 } from "./active-compliance.js";
import type { ScaPointer } from "./ordinary-contracts.js";

export function exactBytes(store: ArtifactHostStore, ref: ArtifactRef): Buffer {
  const found = store.refById(ref.artifact_id);
  if (found === undefined || canonicalJson(found) !== canonicalJson(ref))
    throw new Error("SCA exact artifact metadata mismatch");
  const bytes = store.readById(ref.artifact_id);
  if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
    throw new Error("SCA exact artifact bytes mismatch");
  return bytes;
}
export function exactJson<T extends TSchema>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  schema: T
): Static<T> {
  const value: unknown = JSON.parse(exactBytes(store, ref).toString("utf8"));
  return validateContract(schema, value, ref.kind);
}
export function selected(context: RunContext, kind: string): ArtifactRef {
  const ref = [...context.selectedArtifacts].reverse().find((entry) => entry.kind === kind);
  if (ref === undefined) throw new Error(`SCA missing exact produced artifact: ${kind}`);
  return ref;
}
export function select(context: RunContext, ref: ArtifactRef): ArtifactRef {
  context.selectedArtifacts = context.selectedArtifacts.filter(
    (entry) =>
      entry.kind !== ref.kind || entry.phase !== ref.phase || entry.branch_id !== ref.branch_id
  );
  context.selectedArtifacts.push(ref);
  return ref;
}
export function persistScaArtifact(input: {
  store: ArtifactHostStore;
  runId: string;
  phase: string;
  kind: string;
  schemaId: string;
  content: string | Buffer;
  upstream: readonly ArtifactRef[];
  mediaType?: string;
  schemaVersion?: number;
  context?: RunContext;
}): ArtifactRef {
  const operation = `sca:${sha256(canonicalJson({ run_id: input.runId, phase: input.phase, kind: input.kind }))}`;
  const last = input.store.lastVersion(input.runId, input.phase, null, input.kind, operation);
  const previous =
    last === 0
      ? undefined
      : (input.store.refFor(input.runId, input.phase, null, input.kind, operation, last) ??
        undefined);
  if (last > 0 && previous === undefined) throw new Error("SCA artifact revision lineage broken");
  if (
    previous !== undefined &&
    exactBytes(input.store, previous).equals(Buffer.from(input.content)) &&
    canonicalJson(input.store.metadata(previous).upstream_refs) === canonicalJson(input.upstream)
  ) {
    input.store.select(previous);
    if (input.context !== undefined) select(input.context, previous);
    return previous;
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: operation,
    version: last + 1,
    producer: "host:sca-ordinary",
    media_type: input.mediaType ?? "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: input.schemaVersion ?? 1 },
    parent_ref: previous ?? null,
    upstream_refs: [...input.upstream],
  };
  const ref = input.store.persist({ metadata, content: input.content });
  if (
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(metadata) ||
    !exactBytes(input.store, ref).equals(Buffer.from(input.content))
  )
    throw new Error(`SCA conflicting immutable write: ${input.kind}`);
  input.store.select(ref);
  if (input.context !== undefined) select(input.context, ref);
  return ref;
}
export function sourceCorpus(
  store: ArtifactHostStore,
  context: RunContext
): ParsedScaSourceCorpusV1 {
  return parseSealedScaSourceCorpusV1(exactBytes(store, selected(context, "sca-source-corpus")));
}
export function repositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export function resolveRange(
  corpus: ParsedScaSourceCorpusV1,
  range: { path: string; start_line: number; end_line: number }
): ScaPointer {
  if (!repositoryPath(range.path)) throw new Error("SCA citation path is not repository-relative");
  const file = corpus.files.get(range.path);
  if (file === undefined) throw new Error(`SCA citation source absent: ${range.path}`);
  const lines = file.text.split(/\r?\n/u);
  if (
    !Number.isSafeInteger(range.start_line) ||
    !Number.isSafeInteger(range.end_line) ||
    range.start_line < 1 ||
    range.end_line < range.start_line ||
    range.end_line > lines.length ||
    range.end_line - range.start_line > 256
  )
    throw new Error("SCA citation range invalid or exceeds focused slice limit");
  const exact_quote = lines.slice(range.start_line - 1, range.end_line).join("\n");
  if (Buffer.byteLength(exact_quote) > 16_384 || exact_quote.length === 0)
    throw new Error("SCA citation quote empty or exceeds slice limit");
  return { ...range, exact_quote };
}
export function verifyPointer(corpus: ParsedScaSourceCorpusV1, pointer: ScaPointer): void {
  if (resolveRange(corpus, pointer).exact_quote !== pointer.exact_quote)
    throw new Error(
      `SCA citation quote mismatch: ${pointer.path}:${pointer.start_line}-${pointer.end_line}`
    );
}
export function assertSetEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((id) => !expected.includes(id))
  )
    throw new Error(`SCA ${label}: missing, duplicate or foreign record`);
}
