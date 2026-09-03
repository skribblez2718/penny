import { TextDecoder } from "node:util";

import type { PersistArtifactInput } from "./artifact-store.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import type { ArtifactRef, OutputArtifactMetadata } from "./contracts.js";
import {
  CONTEXT_CONSUMER_STATES,
  type ContextSourceRefV1,
  type ResearchContextBindingRequestV1,
  type ResearchRequestV1,
  assertContextOverlayBudget,
  assertResolvedContextContent,
  researchRequestSha256,
  validateContextSourceRef,
  validateResearchRequest,
} from "./skill-contracts/research.js";
import { SkillSchemaValidationError, assertOpaqueId } from "./skill-contracts/common.js";

export type ResearchContextMediaType = "text/plain" | "text/markdown" | "application/json";

type ContextRole = ContextSourceRefV1["role"];
type ContextFreshness = ContextSourceRefV1["freshness"];
type ContextConflict = ContextSourceRefV1["conflict"];
type ContextDisposition = ContextSourceRefV1["verification_disposition"];
type ContextProviderEvidence = ContextSourceRefV1["provider"];
type ContextUpstreamLocator = ContextSourceRefV1["upstream_locators"][number];

export interface VersionedDocumentResolutionRequestV1 {
  readonly source_id: string;
  readonly document_id: string;
  readonly revision_id: string;
  readonly expected_sha256: string;
  readonly slot: ResearchContextBindingRequestV1["slot"];
}

export interface ApprovedKbResultResolutionRequestV1 {
  readonly source_id: string;
  readonly kb_profile_id: string;
  readonly result_id: string;
  readonly expected_sha256: string;
  readonly slot: ResearchContextBindingRequestV1["slot"];
}

export interface ResolvedContextBaseV1 {
  readonly content: string | Uint8Array;
  readonly media_type: ResearchContextMediaType;
  readonly role: ContextRole;
  readonly scope_id: string;
  readonly freshness: ContextFreshness;
  readonly upstream_locators: readonly ContextUpstreamLocator[];
  readonly provider: ContextProviderEvidence;
  readonly verification_disposition: ContextDisposition;
  readonly conflict: ContextConflict;
}

export type ResolvedVersionedDocumentV1 = ResolvedContextBaseV1;

export interface ResolvedApprovedKbResultV1 extends ResolvedContextBaseV1 {
  readonly approval_id: string;
  readonly approval_sha256: string;
}

export interface ResearchContextProviderHandlersV1 {
  readonly versionedDocument?: (
    request: VersionedDocumentResolutionRequestV1
  ) => ResolvedVersionedDocumentV1;
  /** Exact pre-resolved approved result only. This seam never accepts a query or search. */
  readonly approvedKbResult?: (
    request: ApprovedKbResultResolutionRequestV1
  ) => ResolvedApprovedKbResultV1;
  /** Optional recovery seam for caller input. Ordinary starts use the owner's bounded cache. */
  readonly callerInput?: (source: ContextSourceRefV1, runId: string) => string | Uint8Array;
}

export interface ResearchContextArtifactOwnerV1 {
  persist(input: PersistArtifactInput): ArtifactRef;
  refById(artifactId: string): ArtifactRef | undefined;
  readById(artifactId: string): Buffer;
}

export interface ResearchContextOverlayV1 {
  readonly source: ContextSourceRefV1;
  readonly content: string;
}

function outputMetadata(input: {
  readonly runId: string;
  readonly source: ContextSourceRefV1;
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: "context_binding",
    branch_id: null,
    kind: "context-source-ref",
    operation_id: `context-${input.source.slot}-${sha256(input.source.source_id).slice(0, 32)}`,
    version: 1,
    producer: "host:research-context-owner",
    media_type: "application/json",
    content_schema: {
      schema_id: "penny.context-source-ref.v1",
      schema_version: 1,
    },
    parent_ref: null,
    upstream_refs: [],
  };
}

function contentBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function sourceIdentity(binding: ResearchContextBindingRequestV1): string {
  if (binding.binding_kind === "versioned_document") {
    return canonicalJson({
      document_id: binding.document_id,
      revision_id: binding.revision_id,
      source_id: binding.source_id,
    });
  }
  if (binding.binding_kind === "approved_kb_result") {
    return canonicalJson({
      kb_profile_id: binding.kb_profile_id,
      result_id: binding.result_id,
      source_id: binding.source_id,
    });
  }
  return canonicalJson({ source_id: binding.source_id });
}

function isResolvedApprovedKb(
  resolved: ResolvedContextBaseV1 | ResolvedApprovedKbResultV1
): resolved is ResolvedApprovedKbResultV1 {
  return (
    "approval_id" in resolved &&
    typeof resolved.approval_id === "string" &&
    "approval_sha256" in resolved &&
    typeof resolved.approval_sha256 === "string"
  );
}

function assertResolutionBase(resolved: ResolvedContextBaseV1, label: string): void {
  assertOpaqueId(resolved.scope_id, `${label}.scope_id`);
  assertOpaqueId(resolved.provider.provider_id, `${label}.provider.provider_id`);
  assertOpaqueId(
    resolved.provider.eligibility_record_id,
    `${label}.provider.eligibility_record_id`
  );
}

export class ResearchContextOwnerV1 {
  private readonly callerContent = new Map<string, Buffer>();

  constructor(
    private readonly artifacts: ResearchContextArtifactOwnerV1,
    private readonly providers: ResearchContextProviderHandlersV1 = {}
  ) {}

  prepare(requestValue: ResearchRequestV1, runId: string): ArtifactRef[] {
    const request = validateResearchRequest(requestValue);
    const requestDigest = researchRequestSha256(request);
    const boundSourceIds = request.context_bindings.map((binding) => binding.source_id);
    const prepared = request.context_bindings.map((binding) => {
      const resolved = this.resolveBinding(binding, requestDigest);
      const source = validateContextSourceRef(
        this.envelope(binding, requestDigest, resolved),
        boundSourceIds
      );
      const bytes = contentBuffer(resolved.content);
      assertResolvedContextContent(source, bytes);
      return { binding, source, bytes };
    });
    const sources = prepared.map((item) => item.source);
    assertContextOverlayBudget(sources);
    for (const source of sources) {
      const conflict = source.conflict;
      if (conflict.status !== "resolved") continue;
      const winner = sources.find((candidate) => candidate.source_id === conflict.winner_source_id);
      if (
        winner === undefined ||
        (winner.role === "advisory" && winner.verification_disposition !== "accepted_for_scope")
      ) {
        throw new SkillSchemaValidationError("research context resolved conflict", [
          `winner '${conflict.winner_source_id}' cannot govern the bound scope`,
        ]);
      }
    }
    return prepared.map(({ binding, source, bytes }) => {
      const ref = this.artifacts.persist({
        metadata: outputMetadata({ runId, source }),
        content: canonicalJson(source),
      });
      if (binding.binding_kind === "caller_input") {
        this.callerContent.set(ref.artifact_id, bytes);
      }
      return ref;
    });
  }

  acceptsState(ref: ArtifactRef, state: string): boolean {
    if (ref.kind !== "context-source-ref") return false;
    const source = this.readEnvelope(ref);
    return source.consumer_states.some((consumer) => consumer === state);
  }

  resolveOverlays(refs: readonly ArtifactRef[], state: string): ResearchContextOverlayV1[] {
    const contextRefs = refs.filter((ref) => ref.kind === "context-source-ref");
    const sources = contextRefs.map((ref) => this.readEnvelope(ref));
    assertContextOverlayBudget(sources);
    const overlays: ResearchContextOverlayV1[] = [];
    for (const [index, source] of sources.entries()) {
      const ref = contextRefs[index];
      if (ref === undefined) throw new Error("research context ref/source projection diverged");
      if (!source.consumer_states.some((consumer) => consumer === state)) {
        throw new SkillSchemaValidationError("research context state selection", [
          `source '${source.source_id}' is unrelated to state '${state}'`,
        ]);
      }
      const content = this.resolveExisting(ref, source);
      overlays.push({ source, content });
    }
    return overlays;
  }

  readEnvelope(ref: ArtifactRef): ContextSourceRefV1 {
    if (
      ref.kind !== "context-source-ref" ||
      ref.media_type !== "application/json" ||
      ref.content_schema?.schema_id !== "penny.context-source-ref.v1" ||
      ref.content_schema.schema_version !== 1
    ) {
      throw new SkillSchemaValidationError("research context artifact", [
        "kind, media type, or content schema mismatch",
      ]);
    }
    const stored = this.artifacts.refById(ref.artifact_id);
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
      throw new SkillSchemaValidationError("research context artifact", [
        `artifact '${ref.artifact_id}' is missing or substituted`,
      ]);
    }
    const bytes = this.artifacts.readById(ref.artifact_id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SkillSchemaValidationError("research context artifact", [
        "safe envelope is not JSON",
      ]);
    }
    const source = validateContextSourceRef(parsed);
    if (
      canonicalJson(source) !== bytes.toString("utf8") ||
      ref.content_digest !== sha256(bytes) ||
      ref.byte_length !== bytes.length
    ) {
      throw new SkillSchemaValidationError("research context artifact", [
        "safe envelope is noncanonical or its exact bytes drifted",
      ]);
    }
    return source;
  }

  private resolveBinding(
    binding: ResearchContextBindingRequestV1,
    requestDigest: string
  ): ResolvedContextBaseV1 | ResolvedApprovedKbResultV1 {
    if (binding.binding_kind === "versioned_document") {
      const handler = this.providers.versionedDocument;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("versioned research context", [
          `no provider resolves source '${binding.source_id}'`,
        ]);
      }
      const resolved = handler({
        source_id: binding.source_id,
        document_id: binding.document_id,
        revision_id: binding.revision_id,
        expected_sha256: binding.expected_sha256,
        slot: binding.slot,
      });
      assertResolutionBase(resolved, "resolved versioned document");
      if (sha256(contentBuffer(resolved.content)) !== binding.expected_sha256) {
        throw new SkillSchemaValidationError("versioned research context", [
          `source '${binding.source_id}' digest drifted`,
        ]);
      }
      return resolved;
    }
    if (binding.binding_kind === "approved_kb_result") {
      const handler = this.providers.approvedKbResult;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("approved KB research context", [
          `no provider resolves source '${binding.source_id}'`,
        ]);
      }
      const resolved = handler({
        source_id: binding.source_id,
        kb_profile_id: binding.kb_profile_id,
        result_id: binding.result_id,
        expected_sha256: binding.expected_sha256,
        slot: binding.slot,
      });
      assertResolutionBase(resolved, "resolved approved KB result");
      assertOpaqueId(resolved.approval_id, "resolved approved KB result.approval_id");
      if (sha256(contentBuffer(resolved.content)) !== binding.expected_sha256) {
        throw new SkillSchemaValidationError("approved KB research context", [
          `source '${binding.source_id}' digest drifted`,
        ]);
      }
      return resolved;
    }
    const bytes = contentBuffer(binding.content);
    return {
      content: bytes,
      media_type: "text/plain",
      role: "caller_constraint",
      scope_id: `request-${requestDigest.slice(0, 32)}`,
      freshness: { status: "not_time_sensitive" },
      upstream_locators: [],
      provider: {
        provider_id: "caller",
        configuration_sha256: requestDigest,
        eligibility_record_id: `caller-input-${sha256(sourceIdentity(binding)).slice(0, 32)}`,
        eligibility_sha256: sha256(
          canonicalJson({
            request_sha256: requestDigest,
            source_id: binding.source_id,
          })
        ),
      },
      verification_disposition: "caller_constraint",
      conflict: { status: "none" },
    };
  }

  private envelope(
    binding: ResearchContextBindingRequestV1,
    requestDigest: string,
    resolved: ResolvedContextBaseV1 | ResolvedApprovedKbResultV1
  ): ContextSourceRefV1 {
    const bytes = contentBuffer(resolved.content);
    let revision: ContextSourceRefV1["revision"];
    if (binding.binding_kind === "versioned_document") {
      revision = {
        kind: "document",
        document_id: binding.document_id,
        revision_id: binding.revision_id,
      };
    } else if (binding.binding_kind === "approved_kb_result") {
      if (!isResolvedApprovedKb(resolved)) {
        throw new SkillSchemaValidationError("approved KB research context", [
          "provider omitted exact approval identity",
        ]);
      }
      revision = {
        kind: "approved_kb",
        kb_profile_id: binding.kb_profile_id,
        result_id: binding.result_id,
        approval_id: resolved.approval_id,
        approval_sha256: resolved.approval_sha256,
      };
    } else {
      revision = { kind: "caller", request_sha256: requestDigest };
    }
    return {
      schema_id: "penny.context-source-ref.v1",
      schema_version: 1,
      source_kind: binding.binding_kind,
      source_id: binding.source_id,
      slot: binding.slot,
      role: resolved.role,
      scope_id: resolved.scope_id,
      content: {
        sha256: sha256(bytes),
        utf8_bytes: bytes.length,
        media_type: resolved.media_type,
      },
      revision,
      freshness: resolved.freshness,
      upstream_locators: [...resolved.upstream_locators],
      provider: resolved.provider,
      verification_disposition: resolved.verification_disposition,
      conflict: resolved.conflict,
      consumer_states: [...CONTEXT_CONSUMER_STATES[binding.slot]],
    };
  }

  private resolveExisting(ref: ArtifactRef, source: ContextSourceRefV1): string {
    let resolved: string | Uint8Array;
    if (source.source_kind === "caller_input") {
      const cached = this.callerContent.get(ref.artifact_id);
      resolved =
        cached ??
        this.providers.callerInput?.(source, ref.run_id) ??
        (() => {
          throw new SkillSchemaValidationError("caller research context", [
            `source '${source.source_id}' is unavailable after owner restart`,
          ]);
        })();
    } else if (source.source_kind === "versioned_document") {
      if (source.revision.kind !== "document") {
        throw new SkillSchemaValidationError("versioned research context", [
          "revision kind mismatch",
        ]);
      }
      const handler = this.providers.versionedDocument;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("versioned research context", [
          `no provider resolves source '${source.source_id}'`,
        ]);
      }
      resolved = handler({
        source_id: source.source_id,
        document_id: source.revision.document_id,
        revision_id: source.revision.revision_id,
        expected_sha256: source.content.sha256,
        slot: source.slot,
      }).content;
    } else {
      if (source.revision.kind !== "approved_kb") {
        throw new SkillSchemaValidationError("approved KB research context", [
          "revision kind mismatch",
        ]);
      }
      const handler = this.providers.approvedKbResult;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("approved KB research context", [
          `no provider resolves source '${source.source_id}'`,
        ]);
      }
      const resolution = handler({
        source_id: source.source_id,
        kb_profile_id: source.revision.kb_profile_id,
        result_id: source.revision.result_id,
        expected_sha256: source.content.sha256,
        slot: source.slot,
      });
      if (
        resolution.approval_id !== source.revision.approval_id ||
        resolution.approval_sha256 !== source.revision.approval_sha256
      ) {
        throw new SkillSchemaValidationError("approved KB research context", [
          `source '${source.source_id}' approval identity drifted`,
        ]);
      }
      resolved = resolution.content;
    }
    const bytes = assertResolvedContextContent(source, resolved);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SkillSchemaValidationError("resolved research context", [
        `source '${source.source_id}' is not valid UTF-8`,
      ]);
    }
  }
}
