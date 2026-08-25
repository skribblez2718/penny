/**
 * KB purpose-built private-reader sessions (§§5.7–5.8).
 *
 * A KB child receives no ambient or built-in authority. Private input arrives
 * only through the exact reader names in `KB_PHASE_TOOL_MATRIX`; output leaves
 * through `stage_run_artifact` followed by exactly one terminating,
 * body-free `submit_phase_result` call.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { AgentSessionSpecV1 } from "../model-client.js";
import {
  EvidenceRefSchema,
  KbArtifactHandleSchema,
  OpaqueIdSchema,
  ReadCanonicalTargetInputSchema,
  ReadCanonicalTargetResultSchema,
  ReadPhaseBriefInputSchema,
  ReadPhaseBriefResultSchema,
  ReadRunArtifactInputSchema,
  ReadRunArtifactResultSchema,
  ReadSelectedPageInputSchema,
  ReadSelectedPageResultSchema,
  ReadSourceSnapshotInputSchema,
  ReadSourceSnapshotResultSchema,
  SearchSelectedKbInputSchema,
  SearchSelectedKbResultSchema,
  canonicalJson,
  validateKbContract,
  type ArtifactKind,
} from "./contracts.js";
import {
  StageRunArtifactInputSchema,
  type ArtifactHandle,
  type StageRunArtifactInput,
} from "./run-artifacts.js";
import { strictParseJson } from "./approval-receipts.js";

export type KbPhaseState = "ingest" | "compose" | "query" | "lint" | "verify" | "plan" | "patch";

export const KB_PHASE_TOOL_MATRIX: Readonly<Record<KbPhaseState, readonly string[]>> = {
  ingest: ["read_phase_brief", "read_source_snapshot", "stage_run_artifact", "submit_phase_result"],
  compose: [
    "read_phase_brief",
    "read_source_snapshot",
    "read_run_artifact",
    "read_selected_page",
    "stage_run_artifact",
    "submit_phase_result",
  ],
  query: [
    "read_phase_brief",
    "search_selected_kb",
    "read_selected_page",
    "stage_run_artifact",
    "submit_phase_result",
  ],
  lint: [
    "read_phase_brief",
    "read_run_artifact",
    "read_selected_page",
    "stage_run_artifact",
    "submit_phase_result",
  ],
  verify: [
    "read_phase_brief",
    "read_source_snapshot",
    "read_run_artifact",
    "read_selected_page",
    "stage_run_artifact",
    "submit_phase_result",
  ],
  plan: [
    "read_phase_brief",
    "read_selected_page",
    "read_canonical_target",
    "read_run_artifact",
    "stage_run_artifact",
    "submit_phase_result",
  ],
  patch: [
    "read_phase_brief",
    "read_selected_page",
    "read_canonical_target",
    "read_run_artifact",
    "stage_run_artifact",
    "submit_phase_result",
  ],
};

const EXPECTED_RESULT_KIND: Readonly<Record<KbPhaseState, string>> = {
  ingest: "ingest_extraction",
  compose: "page_composition",
  query: "query_synthesis",
  lint: "semantic_lint",
  verify: "verification",
  plan: "promotion_plan",
  patch: "promotion_patch",
};

const EXPECTED_ARTIFACT_FIELD: Readonly<Record<KbPhaseState, string>> = {
  ingest: "claims_artifact",
  compose: "page_revision_artifact",
  query: "answer_artifact",
  lint: "report_artifact",
  verify: "report_artifact",
  plan: "plan_artifact",
  patch: "patch_artifact",
};

/** One host-controlled phase input surface for one agent invocation. */
export interface KbPhaseInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly phaseBrief: string;
  readonly sourceAllowlist: readonly string[];
  readonly priorPhaseAllowlist: readonly string[];
  readonly readSource: (sourceId: string) => string;

  /** Exact production boundary fields. Optional only for legacy deterministic workflow tests. */
  readonly runId?: string;
  readonly profileId?: string;
  readonly expectedArtifactKind?: ArtifactKind;
  readonly readerLimits?: {
    readonly max_call_utf8_bytes: number;
    readonly max_phase_utf8_bytes: number;
    readonly max_calls_per_phase: number;
  };
  readonly readPhaseBrief?: () => string;
  readonly allowedPriorArtifacts?: readonly ArtifactHandle[];
  readonly readRunArtifact?: (artifactId: string) => string;
  readonly searchSelectedKb?: () => string;
  readonly readSelectedPage?: (pageId: string, revisionId: string) => string;
  readonly readCanonicalTarget?: (capabilityId: string) => string;
  readonly stageArtifact?: (input: StageRunArtifactInput) => ArtifactHandle;
  readonly submitPhaseResult?: (result: Record<string, unknown>) => string;

  /** Legacy deterministic workflow callback. It is never exposed as a production tool. */
  readonly readPhaseOutput?: (stateId: string) => string;
  /** Legacy query aliases retained only while old focused fixtures are migrated. */
  readonly readQueryRequest?: () => string;
  readonly searchSelectedGeneration?: () => string;
  readonly readSelectedSource?: (sourceId: string) => string;

  /** §5.3 resolved child identity admission, called before session creation. */
  readonly admitModel?: (resolved: { provider: string; model: string }) => void;
}

/** A production runner returns only canonical, body-free phase-result metadata. */
export type KbAgentRunner = (invocation: KbPhaseInvocation) => Promise<string>;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isUnknownRecord) : [];
}

function parseJsonValue(source: string): unknown {
  const value: unknown = JSON.parse(source);
  return value;
}

function isPhaseState(value: string): value is KbPhaseState {
  return (
    value === "ingest" ||
    value === "compose" ||
    value === "query" ||
    value === "lint" ||
    value === "verify" ||
    value === "plan" ||
    value === "patch"
  );
}

function phaseState(value: string): KbPhaseState {
  if (isPhaseState(value)) return value;
  throw new Error("kb_phase_unknown");
}

function baseResultProperties(invocation: KbPhaseInvocation) {
  if (invocation.runId === undefined) throw new Error("kb_phase_run_binding_missing");
  return {
    schema_version: Type.Literal(1),
    run_id: Type.Literal(invocation.runId),
    state_id: Type.Literal(invocation.stateId),
    agent: Type.Literal(invocation.agent),
    verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("revise"),
      Type.Literal("blocked"),
      Type.Literal("not_met"),
    ]),
    confidence: Type.Union([
      Type.Literal("CERTAIN"),
      Type.Literal("PROBABLE"),
      Type.Literal("POSSIBLE"),
      Type.Literal("UNCERTAIN"),
    ]),
    evidence: Type.Array(EvidenceRefSchema, { maxItems: 64 }),
    warnings: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
    unresolved: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
  } as const;
}

export function phaseResultSchema(invocation: KbPhaseInvocation): TSchema {
  const state = phaseState(invocation.stateId);
  const base = baseResultProperties(invocation);
  switch (state) {
    case "ingest":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("ingest_extraction"),
          source_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 64, uniqueItems: true }),
          claim_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
          claims_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "compose":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("page_composition"),
          page_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 8, uniqueItems: true }),
          page_revision_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "query":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("query_synthesis"),
          page_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
          citation_count: Type.Integer({ minimum: 0, maximum: 64 }),
          answer_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "lint":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("semantic_lint"),
          issue_ids: Type.Array(OpaqueIdSchema, { maxItems: 1_024, uniqueItems: true }),
          blocking_count: Type.Integer({ minimum: 0, maximum: 1_024 }),
          report_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "verify":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("verification"),
          verified_artifact_ids: Type.Array(OpaqueIdSchema, { maxItems: 64, uniqueItems: true }),
          unsupported_claim_ids: Type.Array(OpaqueIdSchema, { maxItems: 1_024, uniqueItems: true }),
          report_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "plan":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("promotion_plan"),
          target_capability_ids: Type.Array(OpaqueIdSchema, {
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
          }),
          plan_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
    case "patch":
      return Type.Object(
        {
          ...base,
          result_kind: Type.Literal("promotion_patch"),
          target_capability_ids: Type.Array(OpaqueIdSchema, {
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
          }),
          patch_artifact: KbArtifactHandleSchema,
        },
        { additionalProperties: false }
      );
  }
}

export function validatePhaseResult(
  invocation: KbPhaseInvocation,
  value: unknown
): Record<string, unknown> {
  const schema = phaseResultSchema(invocation);
  if (!Value.Check(schema, value) || !isUnknownRecord(value)) {
    throw new Error("submit_phase_result_schema_invalid");
  }
  return value;
}

function resultArtifact(
  invocation: KbPhaseInvocation,
  result: Record<string, unknown>
): ArtifactHandle {
  const state = phaseState(invocation.stateId);
  return validateKbContract(
    KbArtifactHandleSchema,
    result[EXPECTED_ARTIFACT_FIELD[state]],
    "phase result artifact handle"
  );
}

function requireBoundary(invocation: KbPhaseInvocation): asserts invocation is KbPhaseInvocation & {
  runId: string;
  profileId: string;
  expectedArtifactKind: ArtifactKind;
  stageArtifact: (input: StageRunArtifactInput) => ArtifactHandle;
  submitPhaseResult: (result: Record<string, unknown>) => string;
} {
  if (
    invocation.runId === undefined ||
    invocation.profileId === undefined ||
    invocation.expectedArtifactKind === undefined ||
    invocation.stageArtifact === undefined ||
    invocation.submitPhaseResult === undefined
  ) {
    throw new Error("kb_private_session_boundary_missing");
  }
}

/**
 * Build one exact §5.8 session posture. The ResourceLoader receives only the
 * supplied Cognitive Frame, generic role, and workflow guidance; the opening
 * contains no private brief/body.
 */
export function kbSessionSpec(input: {
  invocation: KbPhaseInvocation;
  cognitiveFrame: string;
  phaseGuidance: string;
}): AgentSessionSpecV1 {
  const { invocation } = input;
  requireBoundary(invocation);
  const state = phaseState(invocation.stateId);
  const allowedSources = new Set(invocation.sourceAllowlist);
  const allowedArtifacts = new Map(
    (invocation.allowedPriorArtifacts ?? []).map((handle) => [handle.artifact_id, handle])
  );
  const staged = new Map<string, ArtifactHandle>();
  const readerLimits = invocation.readerLimits ?? {
    max_call_utf8_bytes: 1_048_576,
    max_phase_utf8_bytes: 8_388_608,
    max_calls_per_phase: 64,
  };
  let readerCalls = 0;
  let readerBytes = 0;
  let submitted: string | undefined;

  const readerResult = (text: string, details: Record<string, unknown> = {}) => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      bytes > readerLimits.max_call_utf8_bytes ||
      readerBytes + bytes > readerLimits.max_phase_utf8_bytes ||
      readerCalls + 1 > readerLimits.max_calls_per_phase
    ) {
      throw new Error("kb_reader_limit_exceeded");
    }
    readerCalls += 1;
    readerBytes += bytes;
    return { content: [{ type: "text" as const, text }], details };
  };

  const exactReaderResult = (schema: TSchema, text: string, label: string): string =>
    canonicalJson(validateKbContract(schema, strictParseJson(text), label));

  const readPhaseBrief = defineTool({
    name: "read_phase_brief",
    label: "Read phase brief",
    description:
      "Mandatory first tool for every KB phase. Read the exact state-bound brief by passing only schema_version: 1. Do not call another tool or stop in prose before this succeeds.",
    promptSnippet: "Start every KB phase with read_phase_brief before any other tool.",
    promptGuidelines: [
      "Call read_phase_brief first; do not plan or answer in assistant prose before it succeeds.",
      "If a bounded tool-schema error occurs, correct the closed arguments and retry rather than stopping.",
    ],
    parameters: ReadPhaseBriefInputSchema,
    async execute() {
      const brief = invocation.readPhaseBrief?.() ?? invocation.phaseBrief;
      return readerResult(
        exactReaderResult(ReadPhaseBriefResultSchema, brief, "phase brief result")
      );
    },
  });

  const readSourceSnapshot = defineTool({
    name: "read_source_snapshot",
    label: "Read source snapshot",
    description:
      "After read_phase_brief, read one exact admitted source snapshot by opaque source_id; never a path. Use only IDs exposed by host readers, and correct/retry a bounded closed-schema error instead of stopping.",
    promptSnippet: "Read admitted source bytes only through read_source_snapshot after the brief.",
    promptGuidelines: [
      "Call read_phase_brief before read_source_snapshot.",
      "Use only host-returned source IDs; on a schema error, correct the arguments and retry.",
    ],
    parameters: ReadSourceSnapshotInputSchema,
    async execute(_id, params) {
      const sourceId = String(params.source_id);
      const selectedSource = invocation.readSelectedSource;
      let text: string;
      if (allowedSources.has(sourceId)) {
        text = invocation.readSource(sourceId);
      } else {
        if (selectedSource === undefined) throw new Error("read_source_snapshot_not_allowed");
        text = selectedSource(sourceId);
      }
      return readerResult(
        exactReaderResult(ReadSourceSnapshotResultSchema, text, "source snapshot result"),
        { source_id: sourceId }
      );
    },
  });

  const readRunArtifact = defineTool({
    name: "read_run_artifact",
    label: "Read run artifact",
    description:
      "After read_phase_brief, read one exact path-free prior artifact by an artifact_id listed in the brief. Never guess an ID; correct/retry a bounded closed-schema error instead of stopping.",
    promptSnippet: "Read an allowlisted prior artifact only after read_phase_brief.",
    promptGuidelines: [
      "Copy artifact_id from allowed_prior_artifacts returned by read_phase_brief.",
      "On a schema error, correct the arguments and retry; do not stop in prose.",
    ],
    parameters: ReadRunArtifactInputSchema,
    async execute(_id, params) {
      const artifactId = String(params.artifact_id);
      if (!allowedArtifacts.has(artifactId) || invocation.readRunArtifact === undefined) {
        throw new Error("read_run_artifact_not_allowed");
      }
      return readerResult(
        exactReaderResult(
          ReadRunArtifactResultSchema,
          invocation.readRunArtifact(artifactId),
          "run artifact result"
        ),
        { artifact_id: artifactId }
      );
    },
  });

  const searchSelectedKb = defineTool({
    name: "search_selected_kb",
    label: "Search selected KB",
    description:
      "After read_phase_brief, search the one bound selected generation using only schema_version: 1. Never supply or widen the query. Correct/retry a bounded closed-schema error instead of stopping.",
    promptSnippet: "After the brief, search the bound KB with no arguments.",
    promptGuidelines: [
      "Call read_phase_brief before search_selected_kb and pass only schema_version: 1.",
      "On a schema error, correct the call and retry; do not stop in prose.",
    ],
    parameters: SearchSelectedKbInputSchema,
    async execute() {
      if (invocation.searchSelectedKb === undefined)
        throw new Error("search_selected_kb_not_allowed");
      return readerResult(
        exactReaderResult(
          SearchSelectedKbResultSchema,
          invocation.searchSelectedKb(),
          "selected KB search result"
        )
      );
    },
  });

  const readSelectedPage = defineTool({
    name: "read_selected_page",
    label: "Read selected page",
    description:
      "After read_phase_brief and any required search, read one exact host-returned page_id/revision_id pair from the bound generation. Never guess or mix pairs; correct/retry a bounded closed-schema error instead of stopping.",
    promptSnippet: "Read only an exact host-returned selected page/revision pair.",
    promptGuidelines: [
      "Call read_phase_brief first and copy both IDs from one host-returned pair.",
      "On a schema error, correct the arguments and retry; do not stop in prose.",
    ],
    parameters: ReadSelectedPageInputSchema,
    async execute(_id, params) {
      if (invocation.readSelectedPage === undefined)
        throw new Error("read_selected_page_not_allowed");
      const pageId = String(params.page_id);
      const revisionId = String(params.revision_id);
      return readerResult(
        exactReaderResult(
          ReadSelectedPageResultSchema,
          invocation.readSelectedPage(pageId, revisionId),
          "selected page result"
        ),
        { page_id: pageId, revision_id: revisionId }
      );
    },
  });

  const readCanonicalTarget = defineTool({
    name: "read_canonical_target",
    label: "Read canonical target",
    description:
      "After read_phase_brief, read one exact claimed canonical target by a host-returned capability_id; never a path. Correct/retry a bounded closed-schema error instead of stopping.",
    promptSnippet: "Read a claimed canonical target only by its host-returned capability ID.",
    promptGuidelines: [
      "Call read_phase_brief first and use only an admitted capability ID.",
      "On a schema error, correct the arguments and retry; do not stop in prose.",
    ],
    parameters: ReadCanonicalTargetInputSchema,
    async execute(_id, params) {
      if (invocation.readCanonicalTarget === undefined) {
        throw new Error("read_canonical_target_not_allowed");
      }
      const capabilityId = String(params.capability_id);
      return readerResult(
        exactReaderResult(
          ReadCanonicalTargetResultSchema,
          invocation.readCanonicalTarget(capabilityId),
          "canonical target result"
        ),
        { capability_id: capabilityId }
      );
    },
  });

  const stageRunArtifact = defineTool({
    name: "stage_run_artifact",
    label: "Stage run artifact",
    description:
      "After all required readers, successfully stage exactly one closed JSON artifact for this run/state. The host chooses every path and returns {schema_version,artifact}; retain the complete artifact object exactly. If validation fails before success, correct only the closed input and retry—do not stop in prose.",
    promptSnippet: "Stage one closed artifact, then retain the exact returned artifact object.",
    promptGuidelines: [
      "Use stage_run_artifact only after every required reader has succeeded.",
      "Retain the complete returned artifact object byte-for-value; never invent a handle field.",
      "If a bounded schema/validation error occurs before staging succeeds, correct the closed input and retry.",
    ],
    parameters: StageRunArtifactInputSchema,
    executionMode: "sequential" as const,
    async execute(_id, params) {
      if (submitted !== undefined) throw new Error("stage_run_artifact_after_submit");
      if (staged.size >= 1) throw new Error("stage_run_artifact_count_exceeded");
      const handle = invocation.stageArtifact(params as StageRunArtifactInput);
      staged.set(handle.artifact_id, handle);
      const result = { schema_version: 1 as const, artifact: handle };
      return {
        content: [{ type: "text" as const, text: canonicalJson(result) }],
        details: result,
      };
    },
  });

  const submitPhaseResult = defineTool({
    name: "submit_phase_result",
    label: "Submit phase result",
    description:
      "The only successful phase termination. After one artifact stages, submit closed body-free routing metadata and copy the complete artifact handle object returned by this session's successful stage_run_artifact exactly—not an input/prior handle; never reconstruct it or use placeholders. If the closed schema rejects the call, correct the arguments and retry; never stop in assistant prose.",
    promptSnippet:
      "Terminate only with submit_phase_result using the exact returned artifact handle.",
    promptGuidelines: [
      "Copy the complete artifact object returned by this session's successful stage_run_artifact into the phase artifact field exactly; never use an input/prior artifact handle.",
      "Never substitute placeholders, guessed byte lengths, payload content, paths, or prose.",
      "On a bounded schema error, correct the closed metadata and retry; only an accepted submit terminates.",
    ],
    parameters: phaseResultSchema(invocation),
    executionMode: "sequential" as const,
    async execute(_id, params) {
      if (submitted !== undefined) throw new Error("submit_phase_result_duplicate");
      const result = validatePhaseResult(invocation, params);
      const handle = resultArtifact(invocation, result);
      const issued = staged.get(handle.artifact_id);
      if (
        issued === undefined ||
        canonicalJson(issued) !== canonicalJson(handle) ||
        staged.size !== 1
      ) {
        throw new Error("submit_phase_result_handle_not_staged_by_session");
      }
      submitted = invocation.submitPhaseResult(result);
      return {
        content: [{ type: "text" as const, text: "Phase result accepted." }],
        details: { accepted: true },
        terminate: true,
      };
    },
  });

  const allTools = new Map(
    [
      readPhaseBrief,
      readSourceSnapshot,
      readRunArtifact,
      searchSelectedKb,
      readSelectedPage,
      readCanonicalTarget,
      stageRunArtifact,
      submitPhaseResult,
    ].map((tool) => [tool.name, tool])
  );
  const names = [...KB_PHASE_TOOL_MATRIX[state]];
  const customTools = names.map((name) => {
    const tool = allTools.get(name);
    if (tool === undefined) throw new Error("kb_phase_tool_matrix_invalid");
    return tool;
  });

  return {
    noTools: "all",
    tools: names,
    customTools,
    isolatedSystemPrompt: [
      input.cognitiveFrame,
      "ANONYMOUS PRIVATE KB PHASE GUIDANCE:",
      input.phaseGuidance,
      "This is not a catalog-agent invocation and must not claim a catalog role.",
    ].join("\n\n"),
    opening: [
      `Execute the anonymous private knowledge-base phase '${invocation.stateId}'.`,
      "Your first action must be read_phase_brief with {schema_version: 1}. Do not plan, answer, or stop in assistant prose before it succeeds.",
      "Read every private input through the available host-closed readers, using only IDs and exact pairs they return.",
      "After all required reads, successfully stage exactly one artifact with stage_run_artifact and retain the complete returned artifact object exactly.",
      "Then terminate only by calling submit_phase_result with closed body-free metadata and that exact handle. Never reconstruct a handle or use a placeholder.",
      "If any tool returns a bounded schema or validation error, correct only the closed arguments from reader/host output and retry the same step. Do not stop in prose.",
      "Do not put artifact payloads, private bodies, paths, reasoning, or assistant prose in submit_phase_result.",
    ].join("\n\n"),
    readResult: () => submitted,
    requireResultMessage: `KB phase '${invocation.stateId}' ended without submit_phase_result`,
    sensitiveOutput: true,
  };
}

/**
 * Explicit TEST-ONLY adapter for deterministic fixtures that already describe
 * the child artifact body. Production never treats a runner return string as an
 * artifact: this adapter calls the same stage/seal callbacks the real tools use.
 */
export function createTestOnlyArtifactBodyRunner(
  bodyRunner: (invocation: KbPhaseInvocation) => Promise<string> | string
): KbAgentRunner {
  return async (invocation) => {
    requireBoundary(invocation);
    const content = await bodyRunner(invocation);
    const handle = invocation.stageArtifact({
      schema_version: 1,
      artifact_kind: invocation.expectedArtifactKind,
      media_type: "application/json",
      encoding: "utf8",
      content,
    });
    let payload: Record<string, unknown>;
    try {
      const value = parseJsonValue(content);
      if (!isUnknownRecord(value)) throw new Error("test_only_artifact_body_invalid");
      payload = value;
    } catch {
      throw new Error("test_only_artifact_body_invalid");
    }
    const result = testOnlyPhaseResult(invocation, handle, payload);
    return invocation.submitPhaseResult(result);
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function testOnlyPhaseResult(
  invocation: KbPhaseInvocation & {
    runId: string;
    expectedArtifactKind: ArtifactKind;
  },
  handle: ArtifactHandle,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const state = phaseState(invocation.stateId);
  const base = {
    schema_version: 1,
    run_id: invocation.runId,
    state_id: invocation.stateId,
    agent: invocation.agent,
    verdict: "pass",
    confidence: "CERTAIN",
    evidence: [],
    warnings: [],
    unresolved: [],
  };
  if (state === "ingest") {
    const claims = Array.isArray(payload.claims) ? payload.claims : [];
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      source_ids: strings(payload.source_ids),
      claim_count: claims.length,
      claims_artifact: handle,
    };
  }
  if (state === "compose") {
    const pages = unknownRecords(payload["pages"]);
    const pageIds = pages.flatMap((page) => {
      const frontmatter = page["frontmatter"];
      return isUnknownRecord(frontmatter) && typeof frontmatter["page_id"] === "string"
        ? [frontmatter["page_id"]]
        : [];
    });
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      page_ids: pageIds,
      page_revision_artifact: handle,
    };
  }
  if (state === "query") {
    const answerValue = payload["answer"];
    const answer = isUnknownRecord(answerValue) ? answerValue : undefined;
    const citations = unknownRecords(answer?.["citations"]);
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      page_ids: [
        ...new Set(
          citations.flatMap((citation) =>
            typeof citation.page_id === "string" ? [citation.page_id] : []
          )
        ),
      ],
      citation_count: citations.length,
      answer_artifact: handle,
    };
  }
  if (state === "lint") {
    const findings = unknownRecords(payload["findings"]);
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      issue_ids: findings.flatMap((finding) =>
        typeof finding.finding_id === "string" ? [finding.finding_id] : []
      ),
      blocking_count: findings.filter((finding) => finding.severity === "blocking").length,
      report_artifact: handle,
    };
  }
  if (state === "verify") {
    const claimFindings = unknownRecords(payload["claim_findings"]);
    const citationFindings = unknownRecords(payload["citation_findings"]);
    const unsupportedClaimIds = [
      ...claimFindings.flatMap((finding) =>
        finding.verdict !== "supported" && typeof finding.claim_id === "string"
          ? [finding.claim_id]
          : []
      ),
      ...citationFindings.flatMap((finding) => {
        if (finding["verdict"] === "supported") return [];
        const citation = finding["citation"];
        return isUnknownRecord(citation) && typeof citation["claim_id"] === "string"
          ? [citation["claim_id"]]
          : [];
      }),
    ];
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      verified_artifact_ids: [
        ...new Set([
          ...strings(payload.verified_artifact_ids),
          ...(invocation.allowedPriorArtifacts ?? []).map((artifact) => artifact.artifact_id),
        ]),
      ],
      unsupported_claim_ids: [...new Set(unsupportedClaimIds)],
      report_artifact: handle,
    };
  }
  if (state === "plan") {
    return {
      ...base,
      result_kind: EXPECTED_RESULT_KIND[state],
      target_capability_ids: strings(payload.target_capability_ids),
      plan_artifact: handle,
    };
  }
  const targets = unknownRecords(payload["targets"]);
  return {
    ...base,
    result_kind: EXPECTED_RESULT_KIND[state],
    target_capability_ids: targets.flatMap((target) =>
      typeof target.target_capability_id === "string" ? [target.target_capability_id] : []
    ),
    patch_artifact: handle,
  };
}
