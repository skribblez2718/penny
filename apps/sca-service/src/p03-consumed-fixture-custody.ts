import {
  ArtifactStore,
  currentArtifactRef,
  currentOutputArtifactMetadata,
  previewArtifactRef,
} from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../orchestration/dist/contracts.js";

export type ScaP03ConsumedFixtureFailureV1 =
  | "missing_evidence"
  | "owner_binding"
  | "scope"
  | "fixture_consistency"
  | "witness_consistency"
  | "bytes"
  | "provenance"
  | "bounds"
  | "reread_drift";
/** Public diagnostics contain no underlying validator text, paths, or observations. */
export class ScaP03ConsumedFixtureErrorV1 extends Error {
  constructor(readonly code: ScaP03ConsumedFixtureFailureV1) {
    super(`p03_consumed_fixture_${code}`);
    this.name = "ScaP03ConsumedFixtureErrorV1";
  }
}
export function consumedFixtureCheckV1(
  condition: boolean,
  code: ScaP03ConsumedFixtureFailureV1
): asserts condition {
  if (!condition) throw new ScaP03ConsumedFixtureErrorV1(code);
}
export function consumedFixtureGuardV1<T>(code: ScaP03ConsumedFixtureFailureV1, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ScaP03ConsumedFixtureErrorV1) throw error;
    // Preserve the owning approved-input reader's bounded diagnostic categories,
    // never its operand text or underlying filesystem/validator exception.
    if (code === "fixture_consistency" && error instanceof Error && "code" in error) {
      switch (error.code) {
        case "missing_input":
          throw new ScaP03ConsumedFixtureErrorV1("missing_evidence");
        case "budget_exceeded":
          throw new ScaP03ConsumedFixtureErrorV1("bounds");
        case "metadata_denied":
          throw new ScaP03ConsumedFixtureErrorV1("provenance");
        case "ref_mismatch":
        case "noncanonical_json":
          throw new ScaP03ConsumedFixtureErrorV1("bytes");
      }
    }
    throw new ScaP03ConsumedFixtureErrorV1(code);
  }
}
/** Bound lexical nesting before any recursive canonicalization; duplicate keys fail equality. */
export function parseScaP03ConsumedJsonV1(
  bytes: Uint8Array,
  limit: number,
  canonical = true
): unknown {
  consumedFixtureCheckV1(bytes.byteLength > 0 && bytes.byteLength <= limit, "bounds");
  return consumedFixtureGuardV1("bytes", () => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let depth = 0,
      quoted = false,
      escaped = false;
    for (const c of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") consumedFixtureCheckV1(++depth <= 64, "bounds");
      else if (c === "}" || c === "]") depth--;
    }
    const value: unknown = JSON.parse(text);
    if (canonical) consumedFixtureCheckV1(canonicalJson(value) === text, "bytes");
    return value;
  });
}
export function decodeScaP03ConsumedBase64V1(text: string, limit: number): Buffer {
  consumedFixtureCheckV1(text.length <= 4 * Math.ceil(limit / 3), "bounds");
  const bytes = Buffer.from(text, "base64");
  consumedFixtureCheckV1(bytes.byteLength <= limit, "bounds");
  consumedFixtureCheckV1(bytes.toString("base64") === text, "bytes");
  return bytes;
}
export function consumedFixtureSameV1(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

interface Snapshot {
  readonly ref: ArtifactRef;
  readonly metadata: OutputArtifactMetadata;
  readonly bytes: Buffer;
}
/** Only the six explicitly admitted controls/envelopes. Approved inputs use their owning reader. */
export class ScaP03ConsumedEnvelopeReaderV1 {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly allowed: Map<string, ArtifactRef>;
  constructor(
    private readonly store: ArtifactStore,
    refs: readonly ArtifactRef[]
  ) {
    this.allowed = new Map(refs.map((ref) => [ref.artifact_id, currentArtifactRef(ref)]));
    consumedFixtureCheckV1(refs.length === 6 && this.allowed.size === 6, "owner_binding");
  }
  exact(
    ref: ArtifactRef,
    limit: number,
    upstream: readonly ArtifactRef[],
    inputRefs: readonly ArtifactRef[]
  ): Snapshot {
    consumedFixtureCheckV1(
      consumedFixtureSameV1(this.allowed.get(ref.artifact_id), ref),
      "owner_binding"
    );
    consumedFixtureCheckV1(ref.byte_length <= limit, "bounds");
    const stored = consumedFixtureGuardV1("missing_evidence", () =>
      this.store.refById(ref.artifact_id)
    );
    consumedFixtureCheckV1(stored !== undefined, "missing_evidence");
    consumedFixtureCheckV1(consumedFixtureSameV1(stored, ref), "bytes");
    const metadata = consumedFixtureGuardV1("provenance", () => {
      const raw = this.store.metadata(ref);
      consumedFixtureCheckV1(
        Array.isArray(raw.upstream_refs) && raw.upstream_refs.length <= inputRefs.length + 3,
        "bounds"
      );
      return currentOutputArtifactMetadata(raw);
    });
    consumedFixtureCheckV1(
      metadata.parent_ref === null &&
        metadata.domain_revision_parent_ref == null &&
        consumedFixtureSameV1(metadata.upstream_refs, upstream),
      "provenance"
    );
    const members = new Map(
      [...this.allowed.values(), ...inputRefs].map((r) => [r.artifact_id, r])
    );
    consumedFixtureCheckV1(
      upstream.length <= inputRefs.length + 3 &&
        upstream.every((r) => consumedFixtureSameV1(members.get(r.artifact_id), r)),
      "provenance"
    );
    const bytes = consumedFixtureGuardV1("missing_evidence", () =>
      Buffer.from(this.store.read(ref))
    );
    consumedFixtureCheckV1(bytes.byteLength <= limit, "bounds");
    consumedFixtureCheckV1(
      bytes.byteLength === ref.byte_length &&
        sha256(bytes) === ref.content_digest &&
        ref.store_ref === `artifact://sha256/${ref.content_digest}`,
      "bytes"
    );
    consumedFixtureCheckV1(
      consumedFixtureSameV1(previewArtifactRef({ metadata, content: bytes }), ref),
      "provenance"
    );
    const snapshot = { ref: structuredClone(ref), metadata: structuredClone(metadata), bytes };
    this.snapshots.set(ref.artifact_id, snapshot);
    return snapshot;
  }
  finish(): void {
    consumedFixtureCheckV1(this.snapshots.size === 6, "missing_evidence");
    for (const entry of this.snapshots.values())
      consumedFixtureGuardV1("reread_drift", () => {
        consumedFixtureCheckV1(
          consumedFixtureSameV1(this.store.refById(entry.ref.artifact_id), entry.ref) &&
            consumedFixtureSameV1(this.store.metadata(entry.ref), entry.metadata) &&
            Buffer.from(this.store.read(entry.ref)).equals(entry.bytes),
          "reread_drift"
        );
      });
  }
}
