import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/checkpointer.js";
import { RunContext } from "../dist/context.js";
import type { ArtifactRef, Directive, JsonValue } from "../dist/contracts.js";
import type { AgentInvocation, ModelClient } from "../dist/model-client.js";
import { resolvePlaybook } from "../dist/playbooks/registry.js";
import { ResearchPlaybook } from "../dist/playbooks/research.js";
import {
  ResearchContextOwnerV1,
  ResearchContextOwnerV2,
  type ResearchContextProviderHandlers,
  type ResearchContextProviderHandlersV1,
  type ResearchContextProviderHandlersV2,
  type ResolvedApprovedKbResultV2,
  type ResolvedVersionedDocumentV1,
  type ResolvedVersionedDocumentV2,
} from "../dist/research-context.js";
import {
  CONTEXT_CONSUMER_STATES,
  assertResolvedContextContent,
  canonicalizeResearchRequest,
  researchRuntimeConstraints,
  validateContextSourceRefV2,
  type ResearchRequestV1,
} from "../dist/skill-contracts/research.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { WorkerExecutor } from "../dist/worker.js";

const roots: string[] = [];
const DOCUMENT = "Exact normative document guidance.";
const KB_BODY = "Private approved KB advisory body.";

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-research-context-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  vi.useRealTimers();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const VALID_FROM = "2026-01-01T00:00:00Z";
const CHECKED_AT = "2026-09-01T00:00:00Z";
const VALID_THROUGH = "9999-12-31T23:59:59Z";

function documentResult(
  overrides: Partial<ResolvedVersionedDocumentV2> = {}
): ResolvedVersionedDocumentV2 {
  return {
    schema_id: "penny.research-context-resolution.v2",
    schema_version: 2,
    source_kind: "versioned_document",
    source_id: "document-source",
    content: DOCUMENT,
    media_type: "text/markdown",
    role: "normative",
    scope_id: "scope-research",
    revision: {
      kind: "document",
      document_id: "document-one",
      revision_id: "revision-one",
    },
    freshness: { status: "not_time_sensitive" },
    upstream_locators: [
      { source_id: "document-source", locator: "https://example.invalid/document" },
    ],
    provider: {
      provider_id: "document-provider",
      configuration_sha256: "a".repeat(64),
      eligibility_record_id: "document-eligibility",
      eligibility_sha256: "b".repeat(64),
    },
    verification_disposition: "accepted_for_scope",
    conflict: { status: "none" },
    eligibility: {
      status: "eligible",
      checked_at: CHECKED_AT,
      valid_from: VALID_FROM,
      valid_through: VALID_THROUGH,
    },
    approval: { status: "not_required" },
    ...overrides,
  };
}

function kbResult(overrides: Partial<ResolvedApprovedKbResultV2> = {}): ResolvedApprovedKbResultV2 {
  return {
    schema_id: "penny.research-context-resolution.v2",
    schema_version: 2,
    source_kind: "approved_kb_result",
    source_id: "kb-source",
    content: KB_BODY,
    media_type: "text/markdown",
    role: "advisory",
    scope_id: "scope-research",
    revision: {
      kind: "approved_kb",
      kb_profile_id: "kb-profile",
      result_id: "approved-result",
      approval_id: "approval-record",
      approval_sha256: "e".repeat(64),
    },
    freshness: { status: "not_time_sensitive" },
    upstream_locators: [{ source_id: "kb-source", locator: "kb-result:approved-result" }],
    provider: {
      provider_id: "approved-kb-provider",
      configuration_sha256: "c".repeat(64),
      eligibility_record_id: "kb-eligibility",
      eligibility_sha256: "d".repeat(64),
    },
    verification_disposition: "advisory_only",
    conflict: { status: "none" },
    eligibility: {
      status: "eligible",
      checked_at: CHECKED_AT,
      valid_from: VALID_FROM,
      valid_through: VALID_THROUGH,
    },
    approval: {
      status: "approved",
      checked_at: CHECKED_AT,
      valid_from: VALID_FROM,
      valid_through: VALID_THROUGH,
    },
    ...overrides,
  };
}

function providers(
  input: {
    readonly document?: () => ResolvedVersionedDocumentV2;
    readonly kb?: () => ResolvedApprovedKbResultV2;
  } = {}
): ResearchContextProviderHandlersV2 {
  const admissionResolutions = [input.document?.(), input.kb?.()].filter(
    (value): value is ResolvedVersionedDocumentV2 | ResolvedApprovedKbResultV2 =>
      value !== undefined
  );
  return {
    resolver_contract_version: 2,
    provider_execution: "trusted_in_process",
    admission_resolutions: admissionResolutions,
    ...(input.document === undefined
      ? {}
      : { versionedDocument: async () => input.document?.() ?? documentResult() }),
    ...(input.kb === undefined ? {} : { approvedKbResult: async () => input.kb?.() ?? kbResult() }),
  };
}

function useBoundary(signal = new AbortController().signal, timeoutMs = 60_000) {
  return { signal, inactivity_interval_ms: timeoutMs };
}

function request(
  bindings: readonly JsonValue[],
  extra: Readonly<Record<string, JsonValue>> = {}
): ResearchRequestV1 {
  return canonicalizeResearchRequest({
    question: "Use selected owner context.",
    constraints: { mode: "quick", context_bindings: [...bindings], ...extra },
  });
}

function documentBinding(): Record<string, JsonValue> {
  return {
    slot: "domain_guidance",
    binding_kind: "versioned_document",
    selected_by: "caller",
    source_id: "document-source",
    document_id: "document-one",
    revision_id: "revision-one",
    expected_sha256: sha256(DOCUMENT),
  };
}

function kbBinding(): Record<string, JsonValue> {
  return {
    slot: "standard_guidance",
    binding_kind: "approved_kb_result",
    selected_by: "host",
    source_id: "kb-source",
    kb_profile_id: "kb-profile",
    result_id: "approved-result",
    expected_sha256: sha256(KB_BODY),
  };
}

function runContext(
  requestValue: ResearchRequestV1,
  refs: readonly ReturnType<ArtifactStore["persist"]>[]
) {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: "context-run",
      session_id: "context-run",
      playbook: "research",
      engine_owner: "typescript",
    },
    goal: requestValue.question,
    constraints: researchRuntimeConstraints(requestValue),
    projectRoot: root(),
    trustProfile: "trusted-interactive",
    maxSteps: 96,
    initialArtifacts: refs,
  });
}

function fakeClock(initial: string): {
  readonly now: () => number;
  readonly set: (value: string) => void;
} {
  let current = Date.parse(initial);
  return {
    now: () => current,
    set: (value) => {
      current = Date.parse(value);
    },
  };
}

function timedDocument(validThrough: string): ResolvedVersionedDocumentV2 {
  return documentResult({
    freshness: {
      status: "current",
      observed_at: "2026-09-09T10:00:00Z",
      valid_through: validThrough,
    },
    eligibility: {
      status: "eligible",
      checked_at: "2026-09-09T10:00:00Z",
      valid_from: "2026-09-09T10:00:00Z",
      valid_through: validThrough,
    },
  });
}

function legacyDocumentResult(): ResolvedVersionedDocumentV1 {
  return {
    content: DOCUMENT,
    media_type: "text/markdown",
    role: "normative",
    scope_id: "scope-research",
    freshness: { status: "not_time_sensitive" },
    upstream_locators: [
      { source_id: "document-source", locator: "https://example.invalid/document" },
    ],
    provider: {
      provider_id: "document-provider",
      configuration_sha256: "a".repeat(64),
      eligibility_record_id: "legacy-eligibility",
      eligibility_sha256: "b".repeat(64),
    },
    verification_disposition: "accepted_for_scope",
    conflict: { status: "none" },
  };
}

function timedKb(validThrough: string): ResolvedApprovedKbResultV2 {
  return kbResult({
    freshness: {
      status: "current",
      observed_at: "2026-09-09T10:00:00Z",
      valid_through: validThrough,
    },
    eligibility: {
      status: "eligible",
      checked_at: "2026-09-09T10:00:00Z",
      valid_from: "2026-09-09T10:00:00Z",
      valid_through: validThrough,
    },
    approval: {
      status: "approved",
      checked_at: "2026-09-09T10:00:00Z",
      valid_from: "2026-09-09T10:00:00Z",
      valid_through: validThrough,
    },
  });
}

function contextDirective(input: {
  readonly ref: ArtifactRef;
  readonly runId: string;
  readonly stateId?: "planning" | "researching" | "synthesizing";
}): Extract<Directive, { action: "invoke_agent" }> {
  const stateId = input.stateId ?? "planning";
  const agent = stateId === "planning" ? "piper" : stateId === "researching" ? "echo" : "synthia";
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: input.runId,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: stateId,
    agent,
    attempt: 1,
    trust_profile: "trusted-interactive",
    task: "Consume only currently eligible owner context.",
    input_artifacts: {
      schema_version: 2,
      artifacts: [{ slot: "context-0001", ref: input.ref }],
    },
    output_artifact: {
      schema_version: 2,
      run_id: input.runId,
      phase: stateId,
      branch_id: null,
      kind: "agent-output",
      operation_id: `${input.runId}-output`,
      version: 1,
      producer: `agent:${agent}`,
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [input.ref],
    },
  };
}

function parallelContextDirective(
  ref: ArtifactRef,
  runId: string
): Extract<Directive, { action: "invoke_agents_parallel" }> {
  const branch = (branchId: string) => ({
    branch_id: branchId,
    state_id: "researching",
    agent: "echo",
    attempt: 1,
    trust_profile: "trusted-interactive" as const,
    task: "Consume only currently eligible owner context.",
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [{ slot: "context-0001", ref }],
    },
    output_artifact: {
      schema_version: 2 as const,
      run_id: runId,
      phase: "researching",
      branch_id: branchId,
      kind: "agent-output",
      operation_id: `${runId}-${branchId}-output`,
      version: 1,
      producer: "agent:echo",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [ref],
    },
  });
  return {
    schema_version: 2,
    action: "invoke_agents_parallel",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: runId,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "researching",
    branches: [branch("branch-a"), branch("branch-b")],
  };
}

function contextWorkers(
  artifacts: ArtifactStore,
  owner: ResearchContextOwnerV2,
  runAgent: ModelClient["runAgent"],
  parallelConcurrency = 1,
  fallbackInactivityLeaseMs = 60_000
): WorkerExecutor {
  const registration = resolvePlaybook("research");
  if (registration === undefined) throw new Error("research registration unavailable");
  const workers = new WorkerExecutor({ runAgent }, artifacts, {
    projectRoot: root(),
    parallelConcurrency,
    fallbackInactivityLeaseMs,
    registration,
    researchContext: owner,
  });
  workers.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
  return workers;
}

const CURRENT_MODEL_RESULT = {
  text: 'stage body\nSUMMARY:{"confidence":"CERTAIN"}',
  confidence: "CERTAIN" as const,
  details: {},
};

describe("P2 owner-resolved research context", () => {
  it("uses one safe envelope/trace shape for document-only, approved-KB-only, and combined bindings", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const owner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: documentResult, kb: kbResult })
    );
    const cases = [
      request([documentBinding()]),
      request([kbBinding()]),
      request([documentBinding(), kbBinding()]),
    ];
    for (const [index, requestValue] of cases.entries()) {
      const refs = owner.prepare(requestValue, `context-case-${index}`);
      expect(refs).toHaveLength(requestValue.context_bindings.length);
      const overlays = await owner.resolveOverlays(refs, "researching", useBoundary());
      expect(overlays.map((overlay) => overlay.source.source_id)).toEqual(
        requestValue.context_bindings.map((binding) => binding.source_id)
      );
      for (const ref of refs) {
        const bytes = artifacts.readById(ref.artifact_id).toString("utf8");
        expect(bytes).not.toContain(DOCUMENT);
        expect(bytes).not.toContain(KB_BODY);
        expect(ref.kind).toBe("context-source-ref");
        expect(ref.content_schema).toEqual({
          schema_id: "penny.context-source-ref.v2",
          schema_version: 2,
        });
        const source = owner.readEnvelope(ref);
        const binding = requestValue.context_bindings.find(
          (candidate) => candidate.source_id === source.source_id
        );
        expect(binding).toBeDefined();
        expect(source).toMatchObject({
          schema_id: "penny.context-source-ref.v2",
          schema_version: 2,
          source_kind: binding?.binding_kind,
          source_id: binding?.source_id,
          slot: binding?.slot,
          scope_id: "scope-research",
          freshness: { status: "not_time_sensitive" },
          conflict: { status: "none" },
        });
        if (binding === undefined || binding.binding_kind === "caller_input") {
          throw new Error(`external context binding '${source.source_id}' is absent`);
        }
        expect(source.content.sha256).toBe(binding.expected_sha256);
        expect(source.content.utf8_bytes).toBe(
          Buffer.byteLength(source.source_kind === "versioned_document" ? DOCUMENT : KB_BODY)
        );
        expect(source.provider).toEqual(
          source.source_kind === "versioned_document"
            ? documentResult().provider
            : kbResult().provider
        );
        expect(source.upstream_locators).toEqual(
          source.source_kind === "versioned_document"
            ? documentResult().upstream_locators
            : kbResult().upstream_locators
        );
        expect(source.consumer_states).toEqual(CONTEXT_CONSUMER_STATES[source.slot]);
        if (source.source_kind === "versioned_document") {
          expect(source.role).toBe("normative");
          expect(source.revision).toEqual({
            kind: "document",
            document_id: "document-one",
            revision_id: "revision-one",
          });
          expect(source.verification_disposition).toBe("accepted_for_scope");
        } else {
          expect(source.role).toBe("advisory");
          expect(source.revision).toEqual({
            kind: "approved_kb",
            kb_profile_id: "kb-profile",
            result_id: "approved-result",
            approval_id: "approval-record",
            approval_sha256: "e".repeat(64),
          });
          expect(source.verification_disposition).toBe("advisory_only");
        }
      }
    }
  });

  it("makes deprecated report_format a real output-shape overlay for exactly three consumers", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const requestValue = canonicalizeResearchRequest({
      question: "Shape the compatibility report.",
      constraints: { mode: "quick", report_format: "Use a decision table." },
    });
    const owner = new ResearchContextOwnerV1(artifacts);
    const refs = owner.prepare(requestValue, "context-run");
    const context = runContext(requestValue, refs);
    const playbook = new ResearchPlaybook(artifacts, owner);
    playbook.initialize(context);
    expect(context.pendingDirective?.action).toBe("invoke_agent");
    if (context.pendingDirective?.action === "invoke_agent") {
      expect(
        context.pendingDirective.input_artifacts.artifacts.some(
          (binding) => binding.ref.kind === "context-source-ref"
        )
      ).toBe(false);
    }
    const evidence = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: "researching",
        branch_id: null,
        kind: "agent-output",
        operation_id: "context-overlay-evidence",
        version: 1,
        producer: "agent:echo",
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "context overlay evidence",
    });
    context.selectedArtifacts.push(evidence);
    context.transition("synthesizing");
    const synthesis = playbook.dispatch(context);
    if (synthesis.action !== "invoke_agent") throw new Error("expected synthesis directive");
    expect(
      synthesis.input_artifacts.artifacts.filter(
        (binding) => binding.ref.kind === "context-source-ref"
      )
    ).toHaveLength(1);

    const runAgent = vi.fn<ModelClient["runAgent"]>(async (_invocation: AgentInvocation) => ({
      text: 'synthesis body\nSUMMARY:{"synthesis_complete":true}',
      confidence: "PROBABLE",
      details: { synthesis_complete: true },
    }));
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("research registration unavailable");
    const workers = new WorkerExecutor({ runAgent }, artifacts, {
      projectRoot: context.projectRoot,
      parallelConcurrency: 1,
      registration,
      researchContext: owner,
    });
    workers.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
    await workers.execute(synthesis);
    const invocation = runAgent.mock.calls[0]?.[0];
    expect(invocation?.contextOverlays?.map((overlay) => overlay.content)).toEqual([
      "Use a decision table.",
    ]);
    expect(invocation?.contextOverlays?.[0]?.source.consumer_states).toEqual([
      "synthesizing",
      "critiquing_report",
      "validating",
    ]);
  });

  it("fails missing resolver, stale/drifted content, unapproved role, missing locator, and conflict before worker use", () => {
    const cases: Array<{
      readonly label: string;
      readonly binding: JsonValue;
      readonly handlers: ResearchContextProviderHandlers;
    }> = [
      { label: "missing resolver", binding: documentBinding(), handlers: {} },
      {
        label: "stale",
        binding: documentBinding(),
        handlers: providers({
          document: () =>
            documentResult({
              freshness: {
                status: "stale",
                observed_at: "2026-08-01T00:00:00Z",
                stale_at: "2026-08-02T00:00:00Z",
              },
            }),
        }),
      },
      {
        label: "digest drift",
        binding: documentBinding(),
        handlers: providers({ document: () => documentResult({ content: "changed" }) }),
      },
      {
        label: "unapproved KB",
        binding: kbBinding(),
        handlers: providers({
          kb: () =>
            kbResult({
              revision: { ...kbResult().revision, approval_id: "__proto__" },
            }),
        }),
      },
      {
        label: "KB normative",
        binding: kbBinding(),
        handlers: providers({ kb: () => kbResult({ role: "normative" }) }),
      },
      {
        label: "KB locator",
        binding: kbBinding(),
        handlers: providers({ kb: () => kbResult({ upstream_locators: [] }) }),
      },
      {
        label: "conflict",
        binding: documentBinding(),
        handlers: providers({
          document: () =>
            documentResult({
              conflict: {
                status: "unresolved",
                source_ids: ["document-source", "other-source"],
              },
            }),
        }),
      },
      {
        label: "winner",
        binding: documentBinding(),
        handlers: providers({
          document: () =>
            documentResult({
              conflict: {
                status: "resolved",
                source_ids: ["document-source", "other-source"],
                winner_source_id: "unbound-source",
                rationale_sha256: "f".repeat(64),
              },
            }),
        }),
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const directory = root();
      using artifacts = new ArtifactStore(path.join(directory, `artifacts-${index}`));
      const owner = new ResearchContextOwnerV1(artifacts, testCase.handlers);
      expect(
        () => owner.prepare(request([testCase.binding]), `negative-${index}`),
        testCase.label
      ).toThrow();
    }
  });

  it("rejects invented path/provider fields, unrelated state loading, provider unavailability, and post-bind drift", async () => {
    expect(() =>
      request([
        {
          ...documentBinding(),
          path: "/invented/private/path",
          provider: "model-selected",
        },
      ])
    ).toThrow();

    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    let currentDocument = DOCUMENT;
    const owner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: () => documentResult({ content: currentDocument }) })
    );
    const refs = owner.prepare(request([documentBinding()]), "drift-run");
    await expect(owner.resolveOverlays(refs, "unknown-state", useBoundary())).rejects.toThrow(
      /unrelated/
    );
    currentDocument = "post-bind drift";
    await expect(owner.resolveOverlays(refs, "planning", useBoundary())).rejects.toThrow(
      /digest|length/
    );

    const restarted = new ResearchContextOwnerV1(artifacts, {});
    await expect(restarted.resolveOverlays(refs, "planning", useBoundary())).rejects.toThrow(
      /resolver contract v2/
    );
  });

  it("loads only declared selected source IDs and never a bound unrelated output-shape source", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const owner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: documentResult, kb: kbResult })
    );
    const requestValue = request([documentBinding(), kbBinding()], {
      report_format: "Only shape the final report.",
    });
    const refs = owner.prepare(requestValue, "greedy-run");
    const researching = refs.filter((ref) => owner.acceptsState(ref, "researching"));
    const overlays = await owner.resolveOverlays(researching, "researching", useBoundary());
    expect(overlays.map((overlay) => overlay.source.source_id)).toEqual([
      "document-source",
      "kb-source",
    ]);
    expect(overlays.map((overlay) => overlay.content).join("\n")).not.toContain(
      "Only shape the final report."
    );
  });

  it("accounts for every slot in every cognitive, host, and non-consumer state", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const owner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: documentResult, kb: kbResult })
    );
    const requestValue = request([documentBinding(), kbBinding()], {
      report_format: "Use a bounded evidence table.",
    });
    const refs = owner.prepare(requestValue, "state-matrix-run");
    const states = [
      "intake",
      "planning",
      "critiquing_plan",
      "researching",
      "synthesizing",
      "sealing_core",
      "validating",
      "critiquing_report",
      "rendering",
      "awaiting_clarification",
      "complete",
    ];
    for (const ref of refs) {
      const source = owner.readEnvelope(ref);
      for (const state of states) {
        const expected = source.consumer_states.some((consumer) => consumer === state);
        expect(owner.acceptsState(ref, state), `${source.slot}/${state}`).toBe(expected);
        if (expected) {
          const overlays = await owner.resolveOverlays([ref], state, useBoundary());
          expect(overlays).toHaveLength(1);
          expect(overlays[0]?.source).toEqual(source);
        } else {
          await expect(
            owner.resolveOverlays([ref], state, useBoundary()),
            `${source.slot}/${state}`
          ).rejects.toThrow(/unrelated/u);
        }
      }
    }
    expect(CONTEXT_CONSUMER_STATES).toEqual({
      domain_guidance: [
        "planning",
        "critiquing_plan",
        "researching",
        "synthesizing",
        "critiquing_report",
        "validating",
      ],
      standard_guidance: [
        "planning",
        "critiquing_plan",
        "researching",
        "synthesizing",
        "critiquing_report",
        "validating",
      ],
      output_shape_guidance: ["synthesizing", "critiquing_report", "validating"],
    });
  });

  it("rejects unknown, duplicate, missing, and over-bound request selections", () => {
    const invalidBindings: readonly JsonValue[][] = [
      [{ ...documentBinding(), slot: "unknown_slot" }],
      [{ ...documentBinding(), binding_kind: "model_selected" }],
      [{ ...documentBinding(), source_id: "" }],
      [documentBinding(), documentBinding()],
      Array.from({ length: 5 }, (_value, index) => ({
        ...documentBinding(),
        source_id: `domain-source-${index}`,
        document_id: `domain-document-${index}`,
        revision_id: `domain-revision-${index}`,
      })),
      Array.from({ length: 10 }, (_value, index) => ({
        ...documentBinding(),
        slot:
          index < 4 ? "domain_guidance" : index < 8 ? "standard_guidance" : "output_shape_guidance",
        source_id: `aggregate-source-${index}`,
        document_id: `aggregate-document-${index}`,
        revision_id: `aggregate-revision-${index}`,
      })),
    ];
    for (const bindings of invalidBindings) expect(() => request(bindings)).toThrow();
  });

  it("enforces exact length, per-source, aggregate, and private-failure bounds", () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const owner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: documentResult, kb: kbResult })
    );
    const [documentRef] = owner.prepare(request([documentBinding()]), "length-run");
    if (documentRef === undefined) throw new Error("document context ref is absent");
    const source = owner.readEnvelope(documentRef);
    const lengthDrift = validateContextSourceRefV2({
      ...source,
      content: { ...source.content, utf8_bytes: source.content.utf8_bytes + 1 },
    });
    expect(() => assertResolvedContextContent(lengthDrift, DOCUMENT)).toThrow(/length/u);

    const oversized = "x".repeat(32_769);
    const oversizedBinding = {
      ...documentBinding(),
      expected_sha256: sha256(oversized),
    };
    const oversizedOwner = new ResearchContextOwnerV1(
      artifacts,
      providers({ document: () => documentResult({ content: oversized }) })
    );
    expect(() => oversizedOwner.prepare(request([oversizedBinding]), "source-bound-run")).toThrow();

    const bodies = new Map(
      Array.from({ length: 5 }, (_value, index) => [
        `aggregate-source-${index}`,
        `${index}`.repeat(30_000),
      ])
    );
    const aggregateBindings = [...bodies].map(([sourceId, content], index) => ({
      ...documentBinding(),
      slot: index < 4 ? ("domain_guidance" as const) : ("standard_guidance" as const),
      source_id: sourceId,
      document_id: `aggregate-document-${index}`,
      revision_id: `aggregate-revision-${index}`,
      expected_sha256: sha256(content),
    }));
    const aggregateAdmission = aggregateBindings.map((binding) => {
      const content = bodies.get(binding.source_id);
      if (content === undefined) throw new Error("selected source is absent");
      return documentResult({
        source_id: binding.source_id,
        content,
        revision: {
          kind: "document",
          document_id: binding.document_id,
          revision_id: binding.revision_id,
        },
        upstream_locators: [
          {
            source_id: binding.source_id,
            locator: `https://example.invalid/${binding.source_id}`,
          },
        ],
      });
    });
    const aggregateOwner = new ResearchContextOwnerV1(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: aggregateAdmission,
      versionedDocument: async ({ source_id, document_id, revision_id }) => {
        const content = bodies.get(source_id);
        if (content === undefined) throw new Error("selected source is absent");
        return documentResult({
          source_id,
          content,
          revision: { kind: "document", document_id, revision_id },
          upstream_locators: [{ source_id, locator: `https://example.invalid/${source_id}` }],
        });
      },
    });
    expect(() => aggregateOwner.prepare(request(aggregateBindings), "aggregate-bound-run")).toThrow(
      /128 KiB/u
    );

    const driftedKbOwner = new ResearchContextOwnerV1(
      artifacts,
      providers({ kb: () => kbResult({ content: `${KB_BODY} ${"PRIVATE-SENTINEL"}` }) })
    );
    let failure = "";
    try {
      driftedKbOwner.prepare(request([kbBinding()]), "private-failure-run");
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).not.toContain(KB_BODY);
    expect(failure).not.toContain("PRIVATE-SENTINEL");
  });
});

describe("F12 use-time research context eligibility", () => {
  it("rejects unchanged bytes at the exact expiry edge and accepts a current renewal", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const clock = fakeClock("2026-09-09T11:00:00Z");
    let current = timedDocument("2026-09-09T12:00:00Z");
    const owner = new ResearchContextOwnerV2(
      artifacts,
      providers({ document: () => current }),
      clock.now
    );
    const [ref] = owner.prepare(request([documentBinding()]), "expiry-source-run");
    if (ref === undefined) throw new Error("expiry source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const workers = contextWorkers(artifacts, owner, runAgent);

    clock.set("2026-09-09T12:00:00Z");
    await expect(
      workers.execute(contextDirective({ ref, runId: "expiry-boundary-run" }))
    ).rejects.toThrow(/exclusive valid_through boundary/u);
    expect(runAgent).not.toHaveBeenCalled();

    current = timedDocument("2026-09-09T13:00:00Z");
    current = {
      ...current,
      provider: {
        ...current.provider,
        eligibility_record_id: "document-eligibility-renewed",
        eligibility_sha256: "9".repeat(64),
      },
      freshness: {
        status: "current",
        observed_at: "2026-09-09T12:00:00Z",
        valid_through: "2026-09-09T13:00:00Z",
      },
      eligibility: {
        status: "eligible",
        checked_at: "2026-09-09T12:00:00Z",
        valid_from: "2026-09-09T12:00:00Z",
        valid_through: "2026-09-09T13:00:00Z",
      },
    };
    await expect(
      workers.execute(contextDirective({ ref, runId: "renewed-current-run" }))
    ).resolves.toHaveLength(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const overlay = runAgent.mock.calls[0]?.[0].contextOverlays?.[0];
    expect(overlay).toMatchObject({
      content: DOCUMENT,
      validation: {
        authority_kind: "resolver_v2",
        validated_at: "2026-09-09T12:00:00.000Z",
        current: {
          provider: { eligibility_record_id: "document-eligibility-renewed" },
          eligibility: { valid_through: "2026-09-09T13:00:00Z" },
        },
      },
    });
  });

  it("blocks revocation, conflict, ineligibility, future metadata, approval drift, content drift, and resolver outage before the model seam", async () => {
    type Scenario = {
      readonly label: string;
      readonly binding: Record<string, JsonValue>;
      readonly initial: ResolvedVersionedDocumentV2 | ResolvedApprovedKbResultV2;
      readonly current: ResolvedVersionedDocumentV2 | ResolvedApprovedKbResultV2;
      readonly unavailable?: boolean;
      readonly pattern: RegExp;
    };
    const validThrough = "2026-09-09T13:00:00Z";
    const validDocument = timedDocument(validThrough);
    const validKb = timedKb(validThrough);
    const scenarios: readonly Scenario[] = [
      {
        label: "revoked approval",
        binding: kbBinding(),
        initial: validKb,
        current: {
          ...validKb,
          approval: {
            status: "revoked",
            checked_at: "2026-09-09T11:30:00Z",
            reason_code: "owner-revoked",
          },
        },
        pattern: /approval is revoked/u,
      },
      {
        label: "unresolved conflict",
        binding: documentBinding(),
        initial: validDocument,
        current: {
          ...validDocument,
          conflict: {
            status: "unresolved",
            source_ids: ["document-source", "other-source"],
          },
        },
        pattern: /current unresolved conflict/u,
      },
      {
        label: "provider ineligible",
        binding: documentBinding(),
        initial: validDocument,
        current: {
          ...validDocument,
          eligibility: {
            status: "ineligible",
            checked_at: "2026-09-09T11:30:00Z",
            reason_code: "provider-policy-denied",
          },
        },
        pattern: /provider marked the source ineligible/u,
      },
      {
        label: "future observation",
        binding: documentBinding(),
        initial: validDocument,
        current: {
          ...validDocument,
          freshness: {
            status: "current",
            observed_at: "2026-09-09T12:30:00Z",
            valid_through: validThrough,
          },
        },
        pattern: /observed_at is in the future/u,
      },
      {
        label: "approval identity drift",
        binding: kbBinding(),
        initial: validKb,
        current: {
          ...validKb,
          revision: {
            ...validKb.revision,
            approval_id: "replacement-approval",
          },
        },
        pattern: /identity drifted/u,
      },
      {
        label: "content drift",
        binding: documentBinding(),
        initial: validDocument,
        current: { ...validDocument, content: "changed current bytes" },
        pattern: /digest or UTF-8 byte length/u,
      },
      {
        label: "resolver unavailable",
        binding: documentBinding(),
        initial: validDocument,
        current: validDocument,
        unavailable: true,
        pattern: /current resolver is unavailable/u,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const scenarioDirectory = root();
      using scenarioArtifacts = new ArtifactStore(
        path.join(scenarioDirectory, `artifacts-${index}`)
      );
      const clock = fakeClock("2026-09-09T11:00:00Z");
      let current = scenario.initial;
      let unavailable = false;
      const handlers: ResearchContextProviderHandlersV2 = {
        resolver_contract_version: 2,
        provider_execution: "trusted_in_process",
        admission_resolutions: [scenario.initial],
        versionedDocument: () => {
          if (unavailable) throw new Error("private resolver detail");
          if (current.source_kind !== "versioned_document") {
            throw new Error("scenario resolver kind mismatch");
          }
          return Promise.resolve(current);
        },
        approvedKbResult: () => {
          if (unavailable) throw new Error("private resolver detail");
          if (current.source_kind !== "approved_kb_result") {
            throw new Error("scenario resolver kind mismatch");
          }
          return Promise.resolve(current);
        },
      };
      const owner = new ResearchContextOwnerV2(scenarioArtifacts, handlers, clock.now);
      const [ref] = owner.prepare(request([scenario.binding]), `scenario-source-${index}`);
      if (ref === undefined) throw new Error(`${scenario.label} source ref is absent`);
      current = scenario.current;
      unavailable = scenario.unavailable === true;
      clock.set("2026-09-09T12:00:00Z");
      const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
      const workers = contextWorkers(scenarioArtifacts, owner, runAgent);
      await expect(
        workers.execute(contextDirective({ ref, runId: `scenario-use-${index}` })),
        scenario.label
      ).rejects.toThrow(scenario.pattern);
      expect(runAgent, scenario.label).not.toHaveBeenCalled();
    }
  });

  it("revalidates on retry and after owner restart", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const clock = fakeClock("2026-09-09T11:00:00Z");
    let current = timedDocument("2026-09-09T13:00:00Z");
    const handlers = providers({ document: () => current });
    const owner = new ResearchContextOwnerV2(artifacts, handlers, clock.now);
    const [ref] = owner.prepare(request([documentBinding()]), "retry-source-run");
    if (ref === undefined) throw new Error("retry source ref is absent");
    const storedBefore = artifacts.readById(ref.artifact_id);
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const workers = contextWorkers(artifacts, owner, runAgent);

    await expect(
      workers.execute(contextDirective({ ref, runId: "retry-first-use" }))
    ).resolves.toHaveLength(1);
    current = {
      ...current,
      eligibility: {
        status: "ineligible",
        checked_at: "2026-09-09T11:05:00Z",
        reason_code: "retry-revoked",
      },
    };
    await expect(
      workers.execute(contextDirective({ ref, runId: "retry-second-use" }))
    ).rejects.toThrow(/ineligible/u);
    expect(runAgent).toHaveBeenCalledTimes(1);

    current = timedDocument("2026-09-09T12:00:00Z");
    clock.set("2026-09-09T12:00:00Z");
    const restartedOwner = new ResearchContextOwnerV2(artifacts, handlers, clock.now);
    const restartedWorkers = contextWorkers(artifacts, restartedOwner, runAgent);
    await expect(
      restartedWorkers.execute(contextDirective({ ref, runId: "restart-expired-use" }))
    ).rejects.toThrow(/exclusive valid_through boundary/u);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(artifacts.readById(ref.artifact_id)).toEqual(storedBefore);
  });

  it("rechecks a queued branch after the queue crosses expiry", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const clock = fakeClock("2026-09-09T11:00:00Z");
    const current = timedDocument("2026-09-09T12:00:00Z");
    const owner = new ResearchContextOwnerV2(
      artifacts,
      providers({ document: () => current }),
      clock.now
    );
    const [ref] = owner.prepare(request([documentBinding()]), "queue-source-run");
    if (ref === undefined) throw new Error("queue source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => {
      clock.set("2026-09-09T12:00:00Z");
      return CURRENT_MODEL_RESULT;
    });
    const workers = contextWorkers(artifacts, owner, runAgent, 1);

    await expect(workers.execute(parallelContextDirective(ref, "queue-delay-run"))).rejects.toThrow(
      /exclusive valid_through boundary/u
    );
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a rejected resolver Promise before the model seam", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("9999-12-31T23:59:59Z");
    const owner = new ResearchContextOwnerV2(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [admitted],
      versionedDocument: () => Promise.reject(new Error("private rejected detail")),
    });
    const [ref] = owner.prepare(request([documentBinding()]), "rejected-promise-source");
    if (ref === undefined) throw new Error("rejected-promise source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);

    await expect(
      contextWorkers(artifacts, owner, runAgent).execute(
        contextDirective({ ref, runId: "rejected-promise-use" })
      )
    ).rejects.toThrow(/current resolver is unavailable/u);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("accepts trusted resolver completion beyond the former total-time deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-09T11:00:00Z");
    vi.setSystemTime(startedAt);
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("2026-09-09T13:00:00Z");
    const resolver = vi.fn(() => {
      vi.setSystemTime(startedAt + 2_000);
      return Promise.resolve(admitted);
    });
    const owner = new ResearchContextOwnerV2(
      artifacts,
      {
        resolver_contract_version: 2,
        provider_execution: "trusted_in_process",
        admission_resolutions: [admitted],
        versionedDocument: resolver,
      },
      () => startedAt
    );
    const [ref] = owner.prepare(request([documentBinding()]), "deadline-recheck-source");
    if (ref === undefined) throw new Error("deadline-recheck source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const execution = contextWorkers(artifacts, owner, runAgent, 1, 1_000).execute(
      contextDirective({ ref, runId: "deadline-recheck-use" })
    );
    const completed = expect(execution).resolves.toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    await completed;
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("times out and aborts a never-resolving provider before the model seam", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T11:00:00Z"));
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("2026-09-09T13:00:00Z");
    let providerSignal: AbortSignal | undefined;
    let providerInactivityMs: number | undefined;
    const resolver = vi.fn(
      async (
        _request: Parameters<
          NonNullable<ResearchContextProviderHandlersV2["versionedDocument"]>
        >[0],
        control: Parameters<NonNullable<ResearchContextProviderHandlersV2["versionedDocument"]>>[1]
      ): Promise<ResolvedVersionedDocumentV2> => {
        providerSignal = control.signal;
        providerInactivityMs = control.inactivity_interval_ms;
        return new Promise(() => undefined);
      }
    );
    const owner = new ResearchContextOwnerV2(
      artifacts,
      {
        resolver_contract_version: 2,
        provider_execution: "trusted_in_process",
        admission_resolutions: [admitted],
        versionedDocument: resolver,
      },
      () => Date.parse("2026-09-09T11:00:00Z")
    );
    const [ref] = owner.prepare(request([documentBinding()]), "never-resolving-source");
    if (ref === undefined) throw new Error("never-resolving source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const execution = contextWorkers(artifacts, owner, runAgent, 1, 1_000).execute(
      contextDirective({ ref, runId: "never-resolving-use" })
    );
    const timedOut = expect(execution).rejects.toThrow(/worker_inactivity_lease_expired/u);

    await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(providerInactivityMs).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    expect(providerSignal?.aborted).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("lets cancellation win before deferred provider start and before the model seam", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("9999-12-31T23:59:59Z");
    const resolver = vi.fn(async () => admitted);
    const owner = new ResearchContextOwnerV2(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [admitted],
      versionedDocument: resolver,
    });
    const [ref] = owner.prepare(request([documentBinding()]), "cancel-before-start-source");
    if (ref === undefined) throw new Error("cancel-before-start source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const controller = new AbortController();
    const execution = contextWorkers(artifacts, owner, runAgent).execute(
      contextDirective({ ref, runId: "cancel-before-start-use" }),
      controller.signal
    );
    controller.abort();

    await expect(execution).rejects.toThrow(/cancelled/u);
    expect(resolver).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not start a queued branch resolver after queue cancellation", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("9999-12-31T23:59:59Z");
    const resolver = vi.fn(async () => admitted);
    const owner = new ResearchContextOwnerV2(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [admitted],
      versionedDocument: resolver,
    });
    const [ref] = owner.prepare(request([documentBinding()]), "queue-cancel-source");
    if (ref === undefined) throw new Error("queue-cancel source ref is absent");
    let notifyModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      notifyModelStarted = resolve;
    });
    const runAgent = vi.fn<ModelClient["runAgent"]>(
      async (invocation) =>
        new Promise((_resolve, reject) => {
          const notify = notifyModelStarted;
          if (notify === undefined) throw new Error("model start observer is unavailable");
          notify();
          const rejectAbort = (): void => reject(new Error("model cancelled"));
          if (invocation.signal?.aborted) rejectAbort();
          else invocation.signal?.addEventListener("abort", rejectAbort, { once: true });
        })
    );
    const controller = new AbortController();
    const execution = contextWorkers(artifacts, owner, runAgent, 1).executeSettled(
      parallelContextDirective(ref, "queue-cancel-use"),
      controller.signal
    );
    await modelStarted;
    controller.abort();
    const settlement = await execution;

    expect(settlement.results).toEqual([]);
    expect(settlement.errors).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects the former synchronous V2 handler shape during migration", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const admitted = timedDocument("9999-12-31T23:59:59Z");
    const formerSynchronousV2 = {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [admitted],
      versionedDocument: () => admitted,
    } as const;
    // @ts-expect-error negative compile/type contract: V2 resolvers must now return Promise values
    const owner = new ResearchContextOwnerV2(artifacts, formerSynchronousV2);
    const [ref] = owner.prepare(request([documentBinding()]), "sync-v2-migration-source");
    if (ref === undefined) throw new Error("sync-v2 migration source ref is absent");
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);

    await expect(
      contextWorkers(artifacts, owner, runAgent).execute(
        contextDirective({ ref, runId: "sync-v2-migration-use" })
      )
    ).rejects.toThrow(/must return a Promise/u);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses admission-only resolver reuse instead of treating its bytes as current approval", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const legacyHandler = vi.fn(legacyDocumentResult);
    const legacyProviders: ResearchContextProviderHandlersV1 = {
      resolver_contract_version: 1,
      versionedDocument: legacyHandler,
    };
    const owner = new ResearchContextOwnerV2(artifacts, legacyProviders);
    const [ref] = owner.prepare(request([documentBinding()]), "legacy-source-run");
    if (ref === undefined) throw new Error("legacy source ref is absent");
    expect(ref.content_schema).toEqual({
      schema_id: "penny.context-source-ref.v1",
      schema_version: 1,
    });
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const workers = contextWorkers(artifacts, owner, runAgent);

    await expect(
      workers.execute(contextDirective({ ref, runId: "legacy-use-run" }))
    ).rejects.toThrow(/requires resolver contract v2/u);
    expect(legacyHandler).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("re-resolves a legacy manifest selection under current policy and refuses unverified restricted-to-public supersession", async () => {
    const directory = root();
    const artifactRoot = path.join(directory, "artifacts");
    const persisted = (() => {
      using legacyArtifacts = new ArtifactStore(artifactRoot);
      const legacyOwner = new ResearchContextOwnerV2(legacyArtifacts, {
        resolver_contract_version: 1,
        versionedDocument: () => ({
          ...legacyDocumentResult(),
          scope_id: "restricted-scope",
          verification_disposition: "requires_independent_verification",
        }),
      });
      const [ref] = legacyOwner.prepare(request([documentBinding()]), "legacy-upgrade-source");
      if (ref === undefined) throw new Error("legacy upgrade source ref is absent");
      legacyArtifacts.select(ref);
      return { ref, storedBefore: legacyArtifacts.readById(ref.artifact_id) };
    })();

    using artifacts = new ArtifactStore(artifactRoot);
    const storedSelection = artifacts.selected(
      persisted.ref.run_id,
      persisted.ref.phase,
      persisted.ref.branch_id,
      persisted.ref.kind
    );
    if (storedSelection === undefined) throw new Error("legacy manifest selection is absent");
    const clock = fakeClock("2026-09-09T11:00:00Z");
    let current: ResolvedVersionedDocumentV2 = {
      ...timedDocument("2026-09-09T13:00:00Z"),
      scope_id: "restricted-scope",
      verification_disposition: "requires_independent_verification",
      eligibility: {
        status: "ineligible",
        checked_at: "2026-09-09T10:30:00Z",
        reason_code: "current-policy-denied",
      },
    };
    const currentOwner = new ResearchContextOwnerV2(
      artifacts,
      providers({ document: () => current }),
      clock.now
    );
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const workers = contextWorkers(artifacts, currentOwner, runAgent);

    await expect(
      workers.execute(contextDirective({ ref: storedSelection, runId: "legacy-policy-denied" }))
    ).rejects.toThrow(/current-policy-denied/u);
    expect(runAgent).not.toHaveBeenCalled();

    current = {
      ...timedDocument("2026-09-09T13:00:00Z"),
      scope_id: "public-scope",
      verification_disposition: "accepted_for_scope",
    };
    await expect(
      workers.execute(contextDirective({ ref: storedSelection, runId: "legacy-scope-escalation" }))
    ).rejects.toThrow(/identity drifted/u);
    expect(runAgent).not.toHaveBeenCalled();

    const newlyAdmittingOwner = new ResearchContextOwnerV2(
      artifacts,
      providers({ document: () => current }),
      clock.now
    );
    const [verifiedPublicRef] = newlyAdmittingOwner.prepare(
      request([documentBinding()]),
      "verified-public-binding"
    );
    if (verifiedPublicRef === undefined) throw new Error("verified public binding is absent");
    await expect(
      contextWorkers(artifacts, newlyAdmittingOwner, runAgent).execute(
        contextDirective({ ref: verifiedPublicRef, runId: "verified-public-binding-use" })
      )
    ).resolves.toHaveLength(1);
    expect(verifiedPublicRef.content_schema).toEqual({
      schema_id: "penny.context-source-ref.v2",
      schema_version: 2,
    });
    expect(runAgent).toHaveBeenCalledTimes(1);

    current = {
      ...timedDocument("2026-09-09T13:00:00Z"),
      scope_id: "restricted-scope",
      verification_disposition: "requires_independent_verification",
    };
    await expect(
      workers.execute(contextDirective({ ref: storedSelection, runId: "legacy-verified-use" }))
    ).resolves.toHaveLength(1);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(artifacts.readById(storedSelection.artifact_id)).toEqual(persisted.storedBefore);
    expect(storedSelection.content_schema).toEqual({
      schema_id: "penny.context-source-ref.v1",
      schema_version: 1,
    });
  });

  it("preserves exact fixed caller context across restart without inventing approval", async () => {
    const directory = root();
    using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
    const requestValue = canonicalizeResearchRequest({
      question: "Preserve fixed caller shape.",
      constraints: { report_format: "Use the caller's exact fixed table." },
    });
    const owner = new ResearchContextOwnerV2(artifacts);
    const [ref] = owner.prepare(requestValue, "caller-fixed-source");
    if (ref === undefined) throw new Error("caller source ref is absent");
    const restarted = new ResearchContextOwnerV2(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [],
      callerInput: async () => "Use the caller's exact fixed table.",
    });
    const runAgent = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    const workers = contextWorkers(artifacts, restarted, runAgent);

    await expect(
      workers.execute(contextDirective({ ref, runId: "caller-fixed-use", stateId: "synthesizing" }))
    ).resolves.toHaveLength(1);
    const overlay = runAgent.mock.calls[0]?.[0].contextOverlays?.[0];
    expect(overlay).toMatchObject({
      content: "Use the caller's exact fixed table.",
      validation: { authority_kind: "caller_fixed" },
    });
    expect(canonicalJson(overlay)).not.toContain("approval");

    const changed = new ResearchContextOwnerV2(artifacts, {
      resolver_contract_version: 2,
      provider_execution: "trusted_in_process",
      admission_resolutions: [],
      callerInput: async () => "Changed caller bytes.",
    });
    const rejectedModel = vi.fn<ModelClient["runAgent"]>(async () => CURRENT_MODEL_RESULT);
    await expect(
      contextWorkers(artifacts, changed, rejectedModel).execute(
        contextDirective({ ref, runId: "caller-fixed-drift", stateId: "synthesizing" })
      )
    ).rejects.toThrow(/digest or UTF-8 byte length/u);
    expect(rejectedModel).not.toHaveBeenCalled();
  });
});
