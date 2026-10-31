import {
  currentArtifactRef,
  currentOutputArtifactMetadata,
  previewArtifactRef,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../contracts.js";
import {
  sealPolicySha256,
  validateSealDiagnostic,
  validateSealPolicy,
  type SealDiagnosticV1,
  type SealIssueV1,
  type SealPolicyV1,
} from "../skill-contracts/sealing.js";

export type SealProjectionV1 =
  | {
      readonly status: "sealed";
      readonly content: string | Uint8Array;
      readonly content_schema: { readonly schema_id: string; readonly schema_version: number };
      /** Ordered canonical inputs, including request/frame/support. The draft is prepended by the host. */
      readonly upstream_refs: readonly ArtifactRef[];
      /** Actual revision parent, distinct from the same-run epoch anchor. */
      readonly revision_parent_ref: ArtifactRef | null;
    }
  | {
      readonly status: "rejected";
      readonly failure_class: SealDiagnosticV1["failure_class"];
      readonly issues: readonly SealIssueV1[];
    };

export type SealAttemptResultV1 =
  | { readonly status: "sealed"; readonly product_ref: ArtifactRef; readonly adopted: boolean }
  | {
      readonly status: "rejected";
      readonly diagnostic_ref: ArtifactRef;
      readonly diagnostic: SealDiagnosticV1;
      readonly adopted: boolean;
    }
  | {
      readonly status: "fault";
      readonly code:
        | "SEAL_INPUT_FAULT"
        | "SEAL_PROJECTION_FAULT"
        | "SEAL_DIAGNOSTIC_SIZE_FAULT"
        | "SEAL_PERSISTENCE_FAULT"
        | "SEAL_OPERATION_CONFLICT";
    };

export interface SealAttemptInputV1 {
  readonly store: ArtifactHostStore;
  readonly policy: SealPolicyV1;
  /** Digest bound by the host registration, not supplied by worker content. */
  readonly registered_policy_sha256: string;
  readonly run_id: string;
  readonly branch_id: string | null;
  readonly phase: string;
  readonly draft_ref: ArtifactRef;
  /** Latest checkpoint-selected successful product from THIS run, not a manifest maximum. */
  readonly epoch_anchor_ref: ArtifactRef | null;
  readonly previous_diagnostic_ref: ArtifactRef | null;
  /** Number of previous rejections in this epoch (zero before the first rejection). */
  readonly rejection_ordinal: number;
  readonly project: (draftBytes: Buffer) => SealProjectionV1;
  /** Independent final canonical product validation; any thrown error is a host fault. */
  readonly validate_product_bytes: (productBytes: Buffer, ref: ArtifactRef) => void;
}

/** Distinct immutable address, independent of proposed product or diagnostic bytes. */
export function sealOperationId(input: {
  readonly operation: "seal_product" | "seal_diagnostic";
  readonly run_id: string;
  readonly branch_id: string | null;
  readonly phase: string;
  readonly epoch_anchor_ref: ArtifactRef | null;
  readonly draft_ref: ArtifactRef;
  readonly policy_sha256: string;
}): string {
  return `seal-${input.operation}:${sha256(
    canonicalJson({
      operation: input.operation,
      version: 1,
      run_id: input.run_id,
      branch_id: input.branch_id,
      phase: input.phase,
      epoch_anchor_artifact_id: input.epoch_anchor_ref?.artifact_id ?? null,
      draft_ref: input.draft_ref,
      policy_sha256: input.policy_sha256,
    })
  )}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueRefs(refs: readonly ArtifactRef[]): boolean {
  return new Set(refs.map((ref) => ref.artifact_id)).size === refs.length;
}

function immutableWrite(input: {
  readonly store: ArtifactHostStore;
  readonly metadata: OutputArtifactMetadata;
  readonly content: string | Uint8Array;
  readonly verify: (bytes: Buffer) => void;
}):
  | { readonly status: "persisted"; readonly ref: ArtifactRef; readonly adopted: boolean }
  | { readonly status: "missing" | "conflict" } {
  const { store, metadata, content } = input;
  const candidate = previewArtifactRef({ metadata, content });
  const coordinates = [
    metadata.run_id,
    metadata.phase,
    metadata.branch_id,
    metadata.kind,
    metadata.operation_id,
    metadata.version,
  ] as const;
  let existing = store.refFor(...coordinates);
  const adopted = existing !== null;
  if (existing === null) {
    try {
      store.persist({ metadata, content });
    } catch {
      // A racing write or an interruption after insertion is adoptable only on exact equality.
      // No new version, scan, or blind retry is permitted.
    }
    existing = store.refFor(...coordinates);
  }
  if (existing === null) return { status: "missing" };
  if (!same(existing, candidate)) return { status: "conflict" };
  if (!same(store.refById(candidate.artifact_id), candidate)) return { status: "conflict" };
  if (!same(currentOutputArtifactMetadata(store.metadata(candidate)), metadata)) {
    return { status: "conflict" };
  }
  const bytes = store.readById(candidate.artifact_id);
  if (bytes.length !== candidate.byte_length || sha256(bytes) !== candidate.content_digest) {
    return { status: "conflict" };
  }
  if (!bytes.equals(Buffer.from(content))) return { status: "conflict" };
  input.verify(bytes);
  return { status: "persisted", ref: existing, adopted };
}

/**
 * No state transitions, selected-ref updates, retry charging, or review admission happen here.
 * Caller checkpoints the returned exact ref; without that commit the same operands re-adopt.
 */
export function sealAttempt(input: SealAttemptInputV1): SealAttemptResultV1 {
  let draftBytes: Buffer;
  let policy: SealPolicyV1;
  let previousDiagnostic: SealDiagnosticV1 | undefined;
  try {
    policy = validateSealPolicy(input.policy);
    if (input.registered_policy_sha256 !== sealPolicySha256(policy)) {
      return { status: "fault", code: "SEAL_INPUT_FAULT" };
    }
    const draft = currentArtifactRef(input.draft_ref);
    if (
      draft.run_id !== input.run_id ||
      draft.branch_id !== input.branch_id ||
      input.phase !== policy.seal_phase ||
      draft.phase !== policy.draft_phase ||
      draft.kind !== policy.draft_kind ||
      draft.content_schema?.schema_id !== policy.draft_schema ||
      draft.content_schema?.schema_version !== policy.draft_schema_version ||
      (input.epoch_anchor_ref?.run_id !== undefined &&
        input.epoch_anchor_ref.run_id !== input.run_id) ||
      (input.previous_diagnostic_ref?.run_id !== undefined &&
        input.previous_diagnostic_ref.run_id !== input.run_id) ||
      (input.previous_diagnostic_ref?.kind !== undefined &&
        input.previous_diagnostic_ref.kind !== "seal-diagnostic") ||
      !Number.isSafeInteger(input.rejection_ordinal) ||
      input.rejection_ordinal < 0 ||
      (policy.correction_limit !== null && input.rejection_ordinal > policy.correction_limit + 1) ||
      (input.rejection_ordinal === 0) !== (input.previous_diagnostic_ref === null) ||
      !same(input.store.refById(draft.artifact_id), draft)
    ) {
      return { status: "fault", code: "SEAL_INPUT_FAULT" };
    }
    if (input.epoch_anchor_ref !== null) {
      currentArtifactRef(input.epoch_anchor_ref);
      if (!same(input.store.refById(input.epoch_anchor_ref.artifact_id), input.epoch_anchor_ref)) {
        return { status: "fault", code: "SEAL_INPUT_FAULT" };
      }
      input.store.readById(input.epoch_anchor_ref.artifact_id);
    }
    if (input.previous_diagnostic_ref !== null) {
      currentArtifactRef(input.previous_diagnostic_ref);
      if (
        !same(
          input.store.refById(input.previous_diagnostic_ref.artifact_id),
          input.previous_diagnostic_ref
        )
      ) {
        return { status: "fault", code: "SEAL_INPUT_FAULT" };
      }
      const priorBytes = input.store.readById(input.previous_diagnostic_ref.artifact_id);
      const priorValue: unknown = JSON.parse(priorBytes.toString("utf8"));
      const prior = validateSealDiagnostic(priorValue, policy);
      if (
        !same(prior.epoch_anchor_ref, input.epoch_anchor_ref) ||
        prior.phase !== input.phase ||
        prior.rejection_ordinal !== input.rejection_ordinal ||
        prior.disposition !== "correction_offered" ||
        priorBytes.toString("utf8") !== canonicalJson(prior)
      )
        return { status: "fault", code: "SEAL_INPUT_FAULT" };
      previousDiagnostic = prior;
    }
    draftBytes = input.store.readById(draft.artifact_id);
  } catch {
    return { status: "fault", code: "SEAL_INPUT_FAULT" };
  }

  let projection: SealProjectionV1;
  try {
    projection = input.project(draftBytes);
  } catch {
    // Callbacks return typed authored rejections; a throw is NOT a prose repair route.
    return { status: "fault", code: "SEAL_PROJECTION_FAULT" };
  }

  const operation = projection.status === "sealed" ? "seal_product" : "seal_diagnostic";
  const metadataBase = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: input.branch_id,
    operation_id: sealOperationId({
      operation,
      run_id: input.run_id,
      branch_id: input.branch_id,
      phase: input.phase,
      epoch_anchor_ref: input.epoch_anchor_ref,
      draft_ref: input.draft_ref,
      policy_sha256: input.registered_policy_sha256,
    }),
    version: 1,
    producer:
      (
        {
          assess: "host:assessment-sealer",
          decide: "host:decision-sealer",
          define: "host:specification-sealer",
          diagnose: "host:diagnosis-sealer",
          plan: "host:strategy-sealer",
          produce: "host:artifact-sealer",
          research: "host:core-sealer",
        } as Record<string, string>
      )[policy.skill] ?? `host:seal-${policy.skill}`,
    media_type: "application/json",
    parent_ref: null,
  } as const;
  if (projection.status === "sealed") {
    try {
      const upstream = [input.draft_ref, ...projection.upstream_refs];
      // Version 1 cannot have a store revision parent across distinct operations.
      // Keep the checkpoint-selected epoch anchor and the domain revision parent as
      // exact, ordered upstream metadata instead (once if they are the same ref).
      for (const parent of [input.epoch_anchor_ref, projection.revision_parent_ref]) {
        if (parent !== null && !upstream.some((ref) => ref.artifact_id === parent.artifact_id)) {
          upstream.push(parent);
        }
      }
      if (
        projection.revision_parent_ref?.artifact_id === input.draft_ref.artifact_id ||
        (input.epoch_anchor_ref !== null &&
          upstream.filter((ref) => ref.artifact_id === input.epoch_anchor_ref?.artifact_id)
            .length !== 1)
      )
        return { status: "fault", code: "SEAL_INPUT_FAULT" };
      if (
        !uniqueRefs(upstream) ||
        upstream.some((ref) => !same(currentArtifactRef(ref), input.store.refById(ref.artifact_id)))
      ) {
        return { status: "fault", code: "SEAL_INPUT_FAULT" };
      }
      for (const ref of upstream) input.store.readById(ref.artifact_id);
      const metadata = currentOutputArtifactMetadata({
        ...metadataBase,
        kind: policy.product_kind,
        content_schema: projection.content_schema,
        domain_revision_parent_ref: projection.revision_parent_ref,
        upstream_refs: upstream,
      });
      const bytes = Buffer.from(projection.content);
      input.validate_product_bytes(bytes, previewArtifactRef({ metadata, content: bytes }));
      try {
        const persisted = immutableWrite({
          store: input.store,
          metadata,
          content: bytes,
          verify: (readback) =>
            input.validate_product_bytes(
              readback,
              previewArtifactRef({ metadata, content: bytes })
            ),
        });
        if (persisted.status !== "persisted") {
          return {
            status: "fault",
            code:
              persisted.status === "conflict"
                ? "SEAL_OPERATION_CONFLICT"
                : "SEAL_PERSISTENCE_FAULT",
          };
        }
        return { status: "sealed", product_ref: persisted.ref, adopted: persisted.adopted };
      } catch {
        return { status: "fault", code: "SEAL_PERSISTENCE_FAULT" };
      }
    } catch {
      return { status: "fault", code: "SEAL_PROJECTION_FAULT" };
    }
  }

  try {
    if (!Number.isSafeInteger(projection.issues.length) || projection.issues.length < 1) {
      return { status: "fault", code: "SEAL_DIAGNOSTIC_SIZE_FAULT" };
    }
    // Count discovered distinct issues without sorting an unbounded collection. The
    // closed diagnostic contract has a hard 1,024-item capacity; exceeding it is a
    // host-visible size fault, not an authored correction whose omitted tail could be
    // mistaken for complete feedback.
    const keys = new Set<string>();
    const issues: SealIssueV1[] = [];
    for (const issue of projection.issues) {
      const key = canonicalJson([issue.code, issue.path, issue.source_ordinals]);
      if (keys.has(key)) continue;
      if (issues.length === 1024) {
        return { status: "fault", code: "SEAL_DIAGNOSTIC_SIZE_FAULT" };
      }
      keys.add(key);
      issues.push(issue);
    }
    issues.sort((a, b) => {
      const left = canonicalJson([a.code, a.path, a.source_ordinals]);
      const right = canonicalJson([b.code, b.path, b.source_ordinals]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const used = input.rejection_ordinal;
    const stallReason =
      policy.stall_on_unchanged_rejection === true &&
      previousDiagnostic !== undefined &&
      (policy.correction_limit === null || used < policy.correction_limit)
        ? previousDiagnostic.rejected_draft_ref.content_digest === input.draft_ref.content_digest
          ? ("identical_rejected_digest" as const)
          : previousDiagnostic.failure_class === projection.failure_class &&
              previousDiagnostic.issues_complete &&
              previousDiagnostic.issue_count === projection.issues.length &&
              same(previousDiagnostic.issues, issues)
            ? ("unchanged_diagnostics" as const)
            : undefined
        : undefined;
    const candidate = {
      schema_id: "penny.seal-diagnostic.v1",
      schema_version: 1,
      skill: policy.skill,
      phase: input.phase,
      draft_schema: policy.draft_schema,
      policy_sha256: input.registered_policy_sha256,
      rejected_draft_ref: input.draft_ref,
      epoch_anchor_ref: input.epoch_anchor_ref,
      rejection_ordinal: used + 1,
      previous_diagnostic_ref: input.previous_diagnostic_ref,
      failure_class: projection.failure_class,
      issues,
      issue_count: projection.issues.length,
      issues_complete: projection.issues.length === issues.length,
      corrections_used: used,
      correction_limit: policy.correction_limit,
      disposition:
        stallReason === undefined
          ? policy.correction_limit === null || used < policy.correction_limit
            ? ("correction_offered" as const)
            : ("exhausted" as const)
          : ("stalled" as const),
      ...(stallReason === undefined ? {} : { stall_reason: stallReason }),
    };
    // Preserve the complete discovered count while fitting the persisted prefix in 1 MiB.
    while (Buffer.byteLength(canonicalJson(candidate), "utf8") > 1024 * 1024 && issues.length > 1) {
      issues.pop();
      candidate.issues_complete = false;
    }
    const content = canonicalJson(candidate);
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
      return { status: "fault", code: "SEAL_DIAGNOSTIC_SIZE_FAULT" };
    }
    const diagnostic = validateSealDiagnostic(candidate, policy);
    const metadata = currentOutputArtifactMetadata({
      ...metadataBase,
      kind: "seal-diagnostic",
      content_schema: { schema_id: diagnostic.schema_id, schema_version: 1 },
      upstream_refs: [
        input.draft_ref,
        ...(input.epoch_anchor_ref === null ? [] : [input.epoch_anchor_ref]),
        ...(input.previous_diagnostic_ref === null ? [] : [input.previous_diagnostic_ref]),
      ],
    });
    const persisted = immutableWrite({
      store: input.store,
      metadata,
      content,
      verify: (bytes) => {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (
          !same(validateSealDiagnostic(parsed, policy), diagnostic) ||
          bytes.toString("utf8") !== content
        ) {
          throw new Error("seal diagnostic readback diverged");
        }
      },
    });
    if (persisted.status !== "persisted") {
      return {
        status: "fault",
        code:
          persisted.status === "conflict" ? "SEAL_OPERATION_CONFLICT" : "SEAL_PERSISTENCE_FAULT",
      };
    }
    return {
      status: "rejected",
      diagnostic_ref: persisted.ref,
      diagnostic,
      adopted: persisted.adopted,
    };
  } catch {
    return { status: "fault", code: "SEAL_PERSISTENCE_FAULT" };
  }
}
