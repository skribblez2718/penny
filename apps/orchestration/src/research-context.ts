import { TextDecoder } from "node:util";

import type { PersistArtifactInput } from "./artifact-store.js";
import { canonicalJson, sha256 } from "./checkpointer.js";
import type { ArtifactRef, OutputArtifactMetadata } from "./contracts.js";
import {
  CONTEXT_CONSUMER_STATES,
  type ContextSourceRef,
  type ContextSourceRefV1,
  type ContextSourceRefV2,
  type ResearchContextBindingRequestV1,
  type ResearchRequestV1,
  type ResolvedApprovedKbResultV2,
  type ResolvedContextMetadataV2,
  type ResolvedContextV2,
  type ResolvedVersionedDocumentV2,
  assertContextOverlayBudget,
  assertResolvedContextContent,
  researchRequestSha256,
  validateContextSourceRef,
  validateContextSourceRefV2,
  validateContextSourceUseV2,
  validateResearchRequest,
  validateResolvedContextV2,
  validateVersionedContextSourceRef,
} from "./skill-contracts/research.js";
import { SkillSchemaValidationError, assertOpaqueId } from "./skill-contracts/common.js";

export type {
  ResolvedApprovedKbResultV2,
  ResolvedVersionedDocumentV2,
} from "./skill-contracts/research.js";

export type ResearchContextMediaType = "text/plain" | "text/markdown" | "application/json";
export type ResearchContextClockV2 = () => number;

const MAX_RESEARCH_CONTEXT_ADMISSION_RESOLUTIONS = 9;
const MAX_RESEARCH_CONTEXT_RESOLUTION_BYTES = 32_768;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ResearchContextProgressV2 {
  readonly activity_class: "provider_activity" | "source_resolved";
  readonly observed_units: number;
}

/** Host-owned renewable inactivity boundary passed to every use-time resolver. */
export interface ResearchContextUseBoundaryV2 {
  readonly signal: AbortSignal;
  readonly inactivity_interval_ms: number;
  /** Content-free trusted progress projection; listener failures remain observational. */
  readonly on_progress?: (progress: ResearchContextProgressV2) => void;
}

/** Cooperative controls delivered to one trusted in-process provider adapter. */
export interface ResearchContextResolverControlV2 {
  readonly purpose: "use_time";
  readonly signal: AbortSignal;
  readonly inactivity_interval_ms: number;
  /** Renew only for real provider progress; repeated timer heartbeats are not progress. */
  reportProgress(observedUnits?: number): void;
}

export class ResearchContextResolutionTimeoutError extends Error {
  readonly code = "research_context_resolution_timeout" as const;

  constructor() {
    super("research context resolution inactivity lease expired before model execution");
    this.name = "ResearchContextResolutionTimeoutError";
  }
}

export class ResearchContextResolutionCancelledError extends Error {
  readonly code = "research_context_resolution_cancelled" as const;

  constructor() {
    super("research context resolution was cancelled before model execution");
    this.name = "ResearchContextResolutionCancelledError";
  }
}

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

export interface VersionedDocumentResolutionRequestV2 extends VersionedDocumentResolutionRequestV1 {
  readonly resolver_contract_version: 2;
}

export interface ApprovedKbResultResolutionRequestV2 extends ApprovedKbResultResolutionRequestV1 {
  readonly resolver_contract_version: 2;
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

/**
 * Admission-only compatibility. Reuse through this contract previously consumed
 * only returned content, so it cannot establish current eligibility at use time.
 * Its synchronous handlers are never invoked from the model-use path.
 */
export interface ResearchContextProviderHandlersV1 {
  readonly resolver_contract_version?: 1;
  readonly versionedDocument?: (
    request: VersionedDocumentResolutionRequestV1
  ) => ResolvedVersionedDocumentV1;
  readonly approvedKbResult?: (
    request: ApprovedKbResultResolutionRequestV1
  ) => ResolvedApprovedKbResultV1;
  /** Legacy synchronous caller recovery is admission-only and refused at model use. */
  readonly callerInput?: (source: ContextSourceRef, runId: string) => string | Uint8Array;
}

/**
 * Complete current-resolution contract required for every external use.
 *
 * Handlers are explicitly trusted in-process adapters, not sandboxed plugin code. The host
 * defers invocation so cancellation can win before start and races the returned Promise against
 * cancellation or renewable inactivity expiry. Productive long-running adapters must call
 * `control.reportProgress()` from trusted observed work. JavaScript cannot preempt CPU-infinite
 * synchronous work after a trusted adapter starts; untrusted implementations require an
 * interruptible worker/process boundary behind this adapter.
 */
export interface ResearchContextProviderHandlersV2 {
  readonly resolver_contract_version: 2;
  readonly provider_execution: "trusted_in_process";
  /** Bounded pre-resolved admission snapshots; bodies are never persisted in envelopes. */
  readonly admission_resolutions: readonly ResolvedContextV2[];
  readonly versionedDocument?: (
    request: VersionedDocumentResolutionRequestV2,
    control: ResearchContextResolverControlV2
  ) => Promise<ResolvedVersionedDocumentV2>;
  /** Exact pre-resolved approved result only. This seam never accepts a query or search. */
  readonly approvedKbResult?: (
    request: ApprovedKbResultResolutionRequestV2,
    control: ResearchContextResolverControlV2
  ) => Promise<ResolvedApprovedKbResultV2>;
  /** Exact fixed caller bytes; this is recovery, not external approval. */
  readonly callerInput?: (
    source: ContextSourceRef,
    runId: string,
    control: ResearchContextResolverControlV2
  ) => Promise<string | Uint8Array>;
}

export type ResearchContextProviderHandlers =
  | ResearchContextProviderHandlersV1
  | ResearchContextProviderHandlersV2;

export interface ResearchContextArtifactOwnerV1 {
  persist(input: PersistArtifactInput): ArtifactRef;
  refById(artifactId: string): ArtifactRef | undefined;
  readById(artifactId: string): Buffer;
}

/** Historical direct-overlay shape retained for non-owner compatibility tests. */
export interface ResearchContextOverlayV1 {
  readonly source: ContextSourceRefV1;
  readonly content: string;
}

export interface ResearchContextOverlayV2 {
  readonly source: ContextSourceRef;
  readonly content: string;
  readonly validation:
    | { readonly authority_kind: "caller_fixed" }
    | {
        readonly authority_kind: "resolver_v2";
        readonly validated_at: string;
        readonly current: ResolvedContextMetadataV2;
      };
}

export type ResearchContextOverlay = ResearchContextOverlayV1 | ResearchContextOverlayV2;

type PreparedBinding = {
  readonly binding: ResearchContextBindingRequestV1;
  readonly source: ContextSourceRef;
  readonly bytes: Buffer;
};

function outputMetadata(input: {
  readonly runId: string;
  readonly source: ContextSourceRef;
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
      schema_id: input.source.schema_id,
      schema_version: input.source.schema_version,
    },
    parent_ref: null,
    upstream_refs: [],
  };
}

function contentBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function decodeContent(source: ContextSourceRef, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillSchemaValidationError("resolved research context", [
      `source '${source.source_id}' is not valid UTF-8`,
    ]);
  }
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

function isResolvedApprovedKbV1(
  resolved: ResolvedContextBaseV1 | ResolvedApprovedKbResultV1
): resolved is ResolvedApprovedKbResultV1 {
  return (
    "approval_id" in resolved &&
    typeof resolved.approval_id === "string" &&
    "approval_sha256" in resolved &&
    typeof resolved.approval_sha256 === "string"
  );
}

function assertResolutionBaseV1(resolved: ResolvedContextBaseV1, label: string): void {
  assertOpaqueId(resolved.scope_id, `${label}.scope_id`);
  assertOpaqueId(resolved.provider.provider_id, `${label}.provider.provider_id`);
  assertOpaqueId(
    resolved.provider.eligibility_record_id,
    `${label}.provider.eligibility_record_id`
  );
}

function isProvidersV2(
  providers: ResearchContextProviderHandlers
): providers is ResearchContextProviderHandlersV2 {
  return providers.resolver_contract_version === 2;
}

const EMPTY_TRUSTED_PROVIDERS_V2: ResearchContextProviderHandlersV2 = {
  resolver_contract_version: 2,
  provider_execution: "trusted_in_process",
  admission_resolutions: [],
};

function resolutionBoundaryError(signal: AbortSignal): Error {
  return signal.reason instanceof ResearchContextResolutionTimeoutError
    ? signal.reason
    : new ResearchContextResolutionCancelledError();
}

function throwIfResolutionAborted(signal: AbortSignal): void {
  if (signal.aborted) throw resolutionBoundaryError(signal);
}

function throwIfUseBoundaryClosed(control: { readonly signal: AbortSignal }): void {
  throwIfResolutionAborted(control.signal);
}

function validateUseBoundary(boundary: ResearchContextUseBoundaryV2): void {
  if (
    !Number.isSafeInteger(boundary.inactivity_interval_ms) ||
    boundary.inactivity_interval_ms <= 0 ||
    boundary.inactivity_interval_ms > MAX_TIMER_DELAY_MS
  ) {
    throw new Error("research context inactivity_interval_ms must be a bounded positive integer");
  }
  if (boundary.signal.aborted) throw resolutionBoundaryError(boundary.signal);
}

/** One event-loop turn ensures already-requested cancellation can prevent adapter start. */
function deferProviderInvocation(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(resolutionBoundaryError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(resolutionBoundaryError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(resolutionBoundaryError(signal));
      else resolve();
    }, 0);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runWithinUseBoundary<T>(
  boundary: ResearchContextUseBoundaryV2,
  operation: (control: ResearchContextResolverControlV2) => Promise<T>
): Promise<T> {
  validateUseBoundary(boundary);
  const controller = new AbortController();
  const cancelFromParent = (): void => {
    controller.abort(new ResearchContextResolutionCancelledError());
  };
  boundary.signal.addEventListener("abort", cancelFromParent, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const scheduleExpiry = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new ResearchContextResolutionTimeoutError());
    }, boundary.inactivity_interval_ms);
  };
  const renew = (progress: ResearchContextProgressV2): void => {
    if (controller.signal.aborted) throw resolutionBoundaryError(controller.signal);
    if (
      !Number.isSafeInteger(progress.observed_units) ||
      progress.observed_units <= 0 ||
      progress.observed_units > 16_777_216
    ) {
      throw new Error("research context progress units must be a bounded positive integer");
    }
    scheduleExpiry();
    try {
      boundary.on_progress?.(progress);
    } catch {
      // Progress delivery is observational and cannot replace resolver truth.
    }
  };
  scheduleExpiry();
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => reject(resolutionBoundaryError(controller.signal));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  let completed = false;
  try {
    const work = operation({
      purpose: "use_time",
      signal: controller.signal,
      inactivity_interval_ms: boundary.inactivity_interval_ms,
      reportProgress: (observedUnits = 1) =>
        renew({ activity_class: "provider_activity", observed_units: observedUnits }),
    });
    const result = await Promise.race([work, aborted]);
    completed = true;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    boundary.signal.removeEventListener("abort", cancelFromParent);
    if (!completed && !controller.signal.aborted) {
      controller.abort(new ResearchContextResolutionCancelledError());
    }
  }
}

export class ResearchContextOwnerV2 {
  private readonly callerContent = new Map<string, Buffer>();

  constructor(
    private readonly artifacts: ResearchContextArtifactOwnerV1,
    private readonly providers: ResearchContextProviderHandlers = EMPTY_TRUSTED_PROVIDERS_V2,
    private readonly clock: ResearchContextClockV2 = Date.now
  ) {}

  prepare(requestValue: ResearchRequestV1, runId: string): ArtifactRef[] {
    const request = validateResearchRequest(requestValue);
    const requestDigest = researchRequestSha256(request);
    const boundSourceIds = request.context_bindings.map((binding) => binding.source_id);
    const prepared = request.context_bindings.map((binding) =>
      this.prepareBinding(binding, requestDigest, boundSourceIds)
    );
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

  async resolveOverlays(
    refs: readonly ArtifactRef[],
    state: string,
    boundary: ResearchContextUseBoundaryV2
  ): Promise<ResearchContextOverlayV2[]> {
    validateUseBoundary(boundary);
    const contextRefs = refs.filter((ref) => ref.kind === "context-source-ref");
    const sources = contextRefs.map((ref) => this.readEnvelope(ref));
    assertContextOverlayBudget(sources);
    const boundSourceIds = sources.map((source) => source.source_id);
    for (const source of sources) {
      if (!source.consumer_states.some((consumer) => consumer === state)) {
        throw new SkillSchemaValidationError("research context state selection", [
          `source '${source.source_id}' is unrelated to state '${state}'`,
        ]);
      }
    }
    return runWithinUseBoundary(boundary, async (control) =>
      Promise.all(
        sources.map(async (source, index) => {
          const ref = contextRefs[index];
          if (ref === undefined) {
            throw new Error("research context ref/source projection diverged");
          }
          const overlay = await this.resolveExisting(ref, source, boundSourceIds, control);
          control.reportProgress(Math.max(1, Math.min(ref.byte_length, 16_777_216)));
          return overlay;
        })
      )
    );
  }

  readEnvelope(ref: ArtifactRef): ContextSourceRef {
    const schemaVersion = ref.content_schema?.schema_version;
    const validSchema =
      (ref.content_schema?.schema_id === "penny.context-source-ref.v1" && schemaVersion === 1) ||
      (ref.content_schema?.schema_id === "penny.context-source-ref.v2" && schemaVersion === 2);
    if (
      ref.kind !== "context-source-ref" ||
      ref.media_type !== "application/json" ||
      !validSchema
    ) {
      throw new SkillSchemaValidationError("research context artifact", [
        "kind, media type, or supported content schema mismatch",
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
    const source = validateVersionedContextSourceRef(parsed);
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

  private prepareBinding(
    binding: ResearchContextBindingRequestV1,
    requestDigest: string,
    boundSourceIds: readonly string[]
  ): PreparedBinding {
    if (binding.binding_kind === "caller_input") {
      const bytes = contentBuffer(binding.content);
      const source = validateContextSourceRefV2(
        this.callerEnvelope(binding, requestDigest, bytes),
        boundSourceIds
      );
      assertResolvedContextContent(source, bytes);
      return { binding, source, bytes };
    }
    if (isProvidersV2(this.providers)) {
      const resolution = this.admissionResolution(binding);
      const source = validateContextSourceRefV2(
        this.currentEnvelope(binding, resolution),
        boundSourceIds
      );
      validateContextSourceUseV2({
        source,
        resolution,
        now: this.clock(),
        boundSourceIds,
      });
      return { binding, source, bytes: contentBuffer(resolution.content) };
    }
    const resolution = this.resolveLegacyBinding(binding);
    const source = validateContextSourceRef(
      this.legacyEnvelope(binding, resolution),
      boundSourceIds
    );
    const bytes = contentBuffer(resolution.content);
    assertResolvedContextContent(source, bytes);
    return { binding, source, bytes };
  }

  private resolveLegacyBinding(
    binding: Exclude<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>
  ): ResolvedContextBaseV1 | ResolvedApprovedKbResultV1 {
    if (isProvidersV2(this.providers)) {
      throw new SkillSchemaValidationError("legacy research context", [
        "resolver-v2 providers cannot be called through the admission-only contract",
      ]);
    }
    const providers = this.providers;
    if (binding.binding_kind === "versioned_document") {
      const handler = providers.versionedDocument;
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
      assertResolutionBaseV1(resolved, "resolved versioned document");
      if (sha256(contentBuffer(resolved.content)) !== binding.expected_sha256) {
        throw new SkillSchemaValidationError("versioned research context", [
          `source '${binding.source_id}' digest drifted`,
        ]);
      }
      return resolved;
    }
    const handler = providers.approvedKbResult;
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
    assertResolutionBaseV1(resolved, "resolved approved KB result");
    assertOpaqueId(resolved.approval_id, "resolved approved KB result.approval_id");
    if (sha256(contentBuffer(resolved.content)) !== binding.expected_sha256) {
      throw new SkillSchemaValidationError("approved KB research context", [
        `source '${binding.source_id}' digest drifted`,
      ]);
    }
    return resolved;
  }

  private assertV2ProviderContract(): ResearchContextProviderHandlersV2 {
    if (!isProvidersV2(this.providers)) {
      throw new SkillSchemaValidationError("current research context", [
        "resolver contract v2 is required before external context use",
      ]);
    }
    if (this.providers.provider_execution !== "trusted_in_process") {
      throw new SkillSchemaValidationError("current research context", [
        "resolver contract v2 requires an explicit trusted_in_process provider boundary",
      ]);
    }
    if (
      !Array.isArray(this.providers.admission_resolutions) ||
      this.providers.admission_resolutions.length > MAX_RESEARCH_CONTEXT_ADMISSION_RESOLUTIONS
    ) {
      throw new SkillSchemaValidationError("current research context admission", [
        `admission_resolutions must contain at most ${MAX_RESEARCH_CONTEXT_ADMISSION_RESOLUTIONS} entries`,
      ]);
    }
    return this.providers;
  }

  private admissionResolution(
    binding: Exclude<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>
  ): ResolvedContextV2 {
    const providers = this.assertV2ProviderContract();
    const candidates = providers.admission_resolutions
      .map((value) => {
        const resolution = validateResolvedContextV2(value);
        const bytes =
          typeof resolution.content === "string"
            ? Buffer.byteLength(resolution.content, "utf8")
            : resolution.content.byteLength;
        if (bytes > MAX_RESEARCH_CONTEXT_RESOLUTION_BYTES) {
          throw new SkillSchemaValidationError("current research context admission", [
            `source '${resolution.source_id}' exceeds the 32 KiB resolution bound`,
          ]);
        }
        return resolution;
      })
      .filter((resolution) => {
        if (
          resolution.source_id !== binding.source_id ||
          resolution.source_kind !== binding.binding_kind
        ) {
          return false;
        }
        if (binding.binding_kind === "versioned_document") {
          return (
            resolution.revision.kind === "document" &&
            resolution.revision.document_id === binding.document_id &&
            resolution.revision.revision_id === binding.revision_id
          );
        }
        return (
          resolution.revision.kind === "approved_kb" &&
          resolution.revision.kb_profile_id === binding.kb_profile_id &&
          resolution.revision.result_id === binding.result_id
        );
      });
    if (candidates.length !== 1) {
      throw new SkillSchemaValidationError("current research context admission", [
        `source '${binding.source_id}' requires exactly one bounded pre-resolved admission snapshot`,
      ]);
    }
    const resolution = candidates[0];
    if (resolution === undefined) {
      throw new Error("research context admission candidate projection diverged");
    }
    return resolution;
  }

  private async resolveCurrentBinding(
    binding: Exclude<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>,
    control: ResearchContextResolverControlV2
  ): Promise<ResolvedContextV2> {
    const providers = this.assertV2ProviderContract();
    await deferProviderInvocation(control.signal);
    throwIfUseBoundaryClosed(control);
    let promise: Promise<ResolvedContextV2>;
    if (binding.binding_kind === "versioned_document") {
      const handler = providers.versionedDocument;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("versioned research context", [
          `no current resolver handles source '${binding.source_id}'`,
        ]);
      }
      try {
        promise = handler(
          {
            resolver_contract_version: 2,
            source_id: binding.source_id,
            document_id: binding.document_id,
            revision_id: binding.revision_id,
            expected_sha256: binding.expected_sha256,
            slot: binding.slot,
          },
          control
        );
      } catch {
        throwIfUseBoundaryClosed(control);
        throw new SkillSchemaValidationError("versioned research context", [
          `current resolver is unavailable for source '${binding.source_id}'`,
        ]);
      }
    } else {
      const handler = providers.approvedKbResult;
      if (handler === undefined) {
        throw new SkillSchemaValidationError("approved KB research context", [
          `no current resolver handles source '${binding.source_id}'`,
        ]);
      }
      try {
        promise = handler(
          {
            resolver_contract_version: 2,
            source_id: binding.source_id,
            kb_profile_id: binding.kb_profile_id,
            result_id: binding.result_id,
            expected_sha256: binding.expected_sha256,
            slot: binding.slot,
          },
          control
        );
      } catch {
        throwIfUseBoundaryClosed(control);
        throw new SkillSchemaValidationError("approved KB research context", [
          `current resolver is unavailable for source '${binding.source_id}'`,
        ]);
      }
    }
    throwIfUseBoundaryClosed(control);
    if (!(promise instanceof Promise)) {
      throw new SkillSchemaValidationError("current research context", [
        `resolver contract v2 for source '${binding.source_id}' must return a Promise`,
      ]);
    }
    let value: unknown;
    try {
      value = await promise;
    } catch {
      throwIfUseBoundaryClosed(control);
      throw new SkillSchemaValidationError(
        binding.binding_kind === "versioned_document"
          ? "versioned research context"
          : "approved KB research context",
        [`current resolver is unavailable for source '${binding.source_id}'`]
      );
    }
    throwIfUseBoundaryClosed(control);
    const resolution = validateResolvedContextV2(value);
    throwIfUseBoundaryClosed(control);
    return resolution;
  }

  private legacyEnvelope(
    binding: Exclude<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>,
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
    } else {
      if (!isResolvedApprovedKbV1(resolved)) {
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

  private callerEnvelope(
    binding: Extract<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>,
    requestDigest: string,
    bytes: Buffer
  ): ContextSourceRefV2 {
    return {
      schema_id: "penny.context-source-ref.v2",
      schema_version: 2,
      source_kind: "caller_input",
      source_id: binding.source_id,
      slot: binding.slot,
      role: "caller_constraint",
      scope_id: `request-${requestDigest.slice(0, 32)}`,
      content: {
        sha256: sha256(bytes),
        utf8_bytes: bytes.length,
        media_type: "text/plain",
      },
      revision: { kind: "caller", request_sha256: requestDigest },
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
      consumer_states: [...CONTEXT_CONSUMER_STATES[binding.slot]],
      admission: { authority_kind: "caller_fixed" },
    };
  }

  private currentEnvelope(
    binding: Exclude<ResearchContextBindingRequestV1, { binding_kind: "caller_input" }>,
    resolution: ResolvedContextV2
  ): ContextSourceRefV2 {
    const bytes = contentBuffer(resolution.content);
    const revision: ContextSourceRefV2["revision"] =
      binding.binding_kind === "versioned_document"
        ? {
            kind: "document",
            document_id: binding.document_id,
            revision_id: binding.revision_id,
          }
        : resolution.source_kind === "approved_kb_result"
          ? {
              kind: "approved_kb",
              kb_profile_id: binding.kb_profile_id,
              result_id: binding.result_id,
              approval_id: resolution.revision.approval_id,
              approval_sha256: resolution.revision.approval_sha256,
            }
          : (() => {
              throw new SkillSchemaValidationError("approved KB research context", [
                "resolver returned the wrong source kind",
              ]);
            })();
    return {
      schema_id: "penny.context-source-ref.v2",
      schema_version: 2,
      source_kind: binding.binding_kind,
      source_id: binding.source_id,
      slot: binding.slot,
      role: resolution.role,
      scope_id: resolution.scope_id,
      content: {
        sha256: binding.expected_sha256,
        utf8_bytes: bytes.length,
        media_type: resolution.media_type,
      },
      revision,
      freshness: resolution.freshness,
      upstream_locators: [...resolution.upstream_locators],
      provider: resolution.provider,
      verification_disposition: resolution.verification_disposition,
      conflict: resolution.conflict,
      consumer_states: [...CONTEXT_CONSUMER_STATES[binding.slot]],
      admission: {
        authority_kind: "resolver_v2",
        resolver_schema_id: "penny.research-context-resolution.v2",
        resolver_schema_version: 2,
        eligibility: resolution.eligibility,
        approval: resolution.approval,
      },
    };
  }

  private async resolveExisting(
    ref: ArtifactRef,
    source: ContextSourceRef,
    boundSourceIds: readonly string[],
    control: ResearchContextResolverControlV2
  ): Promise<ResearchContextOverlayV2> {
    throwIfUseBoundaryClosed(control);
    if (source.source_kind === "caller_input") {
      const cached = this.callerContent.get(ref.artifact_id);
      let resolved = cached;
      if (resolved === undefined) {
        if (!isProvidersV2(this.providers)) {
          throw new SkillSchemaValidationError("caller research context", [
            `fixed source '${source.source_id}' requires async resolver contract v2 after owner restart`,
          ]);
        }
        const providers = this.assertV2ProviderContract();
        const handler = providers.callerInput;
        if (handler === undefined) {
          throw new SkillSchemaValidationError("caller research context", [
            `fixed source '${source.source_id}' is unavailable after owner restart`,
          ]);
        }
        await deferProviderInvocation(control.signal);
        throwIfUseBoundaryClosed(control);
        let promise: Promise<string | Uint8Array>;
        try {
          promise = handler(source, ref.run_id, control);
        } catch {
          throwIfUseBoundaryClosed(control);
          throw new SkillSchemaValidationError("caller research context", [
            `fixed source '${source.source_id}' is unavailable after owner restart`,
          ]);
        }
        throwIfUseBoundaryClosed(control);
        if (!(promise instanceof Promise)) {
          throw new SkillSchemaValidationError("caller research context", [
            `resolver contract v2 for fixed source '${source.source_id}' must return a Promise`,
          ]);
        }
        try {
          resolved = contentBuffer(await promise);
        } catch {
          throwIfUseBoundaryClosed(control);
          throw new SkillSchemaValidationError("caller research context", [
            `fixed source '${source.source_id}' is unavailable after owner restart`,
          ]);
        }
      }
      throwIfUseBoundaryClosed(control);
      const bytes = assertResolvedContextContent(source, resolved);
      throwIfUseBoundaryClosed(control);
      return {
        source,
        content: decodeContent(source, bytes),
        validation: { authority_kind: "caller_fixed" },
      };
    }
    if (!isProvidersV2(this.providers)) {
      throw new SkillSchemaValidationError("current research context", [
        `source '${source.source_id}' requires resolver contract v2; admission-only providers cannot establish current approval`,
      ]);
    }
    let resolution: ResolvedContextV2;
    if (source.source_kind === "versioned_document") {
      if (source.revision.kind !== "document") {
        throw new SkillSchemaValidationError("versioned research context", [
          "revision kind mismatch",
        ]);
      }
      resolution = await this.resolveCurrentBinding(
        {
          slot: source.slot,
          binding_kind: "versioned_document",
          selected_by: "host",
          source_id: source.source_id,
          document_id: source.revision.document_id,
          revision_id: source.revision.revision_id,
          expected_sha256: source.content.sha256,
        },
        control
      );
    } else {
      if (source.revision.kind !== "approved_kb") {
        throw new SkillSchemaValidationError("approved KB research context", [
          "revision kind mismatch",
        ]);
      }
      resolution = await this.resolveCurrentBinding(
        {
          slot: source.slot,
          binding_kind: "approved_kb_result",
          selected_by: "host",
          source_id: source.source_id,
          kb_profile_id: source.revision.kb_profile_id,
          result_id: source.revision.result_id,
          expected_sha256: source.content.sha256,
        },
        control
      );
    }
    throwIfUseBoundaryClosed(control);
    const validated = validateContextSourceUseV2({
      source,
      resolution,
      now: this.clock(),
      boundSourceIds,
    });
    throwIfUseBoundaryClosed(control);
    return {
      source,
      content: validated.content,
      validation: {
        authority_kind: "resolver_v2",
        validated_at: validated.validated_at,
        current: validated.current,
      },
    };
  }
}

/** @deprecated Use ResearchContextOwnerV2. The compatibility owner has the same fail-closed use path. */
export class ResearchContextOwnerV1 extends ResearchContextOwnerV2 {}
