import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { sha256 } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import type { JsonValue } from "../src/contracts.js";
import type { AgentInvocation, ModelClient } from "../src/model-client.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";
import { ResearchPlaybook } from "../src/playbooks/research.js";
import {
  ResearchContextOwnerV1,
  type ResearchContextProviderHandlersV1,
  type ResolvedApprovedKbResultV1,
  type ResolvedVersionedDocumentV1,
} from "../src/research-context.js";
import {
  CONTEXT_CONSUMER_STATES,
  assertResolvedContextContent,
  canonicalizeResearchRequest,
  researchRuntimeConstraints,
  validateContextSourceRef,
  type ResearchRequestV1,
} from "../src/skill-contracts/research.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { WorkerExecutor } from "../src/worker.js";

const roots: string[] = [];
const DOCUMENT = "Exact normative document guidance.";
const KB_BODY = "Private approved KB advisory body.";

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-research-context-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function documentResult(
  overrides: Partial<ResolvedVersionedDocumentV1> = {}
): ResolvedVersionedDocumentV1 {
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
      eligibility_record_id: "document-eligibility",
      eligibility_sha256: "b".repeat(64),
    },
    verification_disposition: "accepted_for_scope",
    conflict: { status: "none" },
    ...overrides,
  };
}

function kbResult(overrides: Partial<ResolvedApprovedKbResultV1> = {}): ResolvedApprovedKbResultV1 {
  return {
    content: KB_BODY,
    media_type: "text/markdown",
    role: "advisory",
    scope_id: "scope-research",
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
    approval_id: "approval-record",
    approval_sha256: "e".repeat(64),
    ...overrides,
  };
}

function providers(
  input: {
    readonly document?: () => ResolvedVersionedDocumentV1;
    readonly kb?: () => ResolvedApprovedKbResultV1;
  } = {}
): ResearchContextProviderHandlersV1 {
  return {
    ...(input.document === undefined
      ? {}
      : { versionedDocument: () => input.document?.() ?? documentResult() }),
    ...(input.kb === undefined ? {} : { approvedKbResult: () => input.kb?.() ?? kbResult() }),
  };
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

describe("P2 owner-resolved research context", () => {
  it("uses one safe envelope/trace shape for document-only, approved-KB-only, and combined bindings", () => {
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
      const overlays = owner.resolveOverlays(refs, "researching");
      expect(overlays.map((overlay) => overlay.source.source_id)).toEqual(
        requestValue.context_bindings.map((binding) => binding.source_id)
      );
      for (const ref of refs) {
        const bytes = artifacts.readById(ref.artifact_id).toString("utf8");
        expect(bytes).not.toContain(DOCUMENT);
        expect(bytes).not.toContain(KB_BODY);
        expect(ref.kind).toBe("context-source-ref");
        expect(ref.content_schema).toEqual({
          schema_id: "penny.context-source-ref.v1",
          schema_version: 1,
        });
        const source = owner.readEnvelope(ref);
        const binding = requestValue.context_bindings.find(
          (candidate) => candidate.source_id === source.source_id
        );
        expect(binding).toBeDefined();
        expect(source).toMatchObject({
          schema_id: "penny.context-source-ref.v1",
          schema_version: 1,
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
      readonly handlers: ResearchContextProviderHandlersV1;
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
        handlers: providers({ kb: () => kbResult({ approval_id: "__proto__" }) }),
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

  it("rejects invented path/provider fields, unrelated state loading, provider unavailability, and post-bind drift", () => {
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
    expect(() => owner.resolveOverlays(refs, "unknown-state")).toThrow(/unrelated/);
    currentDocument = "post-bind drift";
    expect(() => owner.resolveOverlays(refs, "planning")).toThrow(/digest|length/);

    const restarted = new ResearchContextOwnerV1(artifacts, {});
    expect(() => restarted.resolveOverlays(refs, "planning")).toThrow(/no provider/);
  });

  it("loads only declared selected source IDs and never a bound unrelated output-shape source", () => {
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
    const overlays = owner.resolveOverlays(researching, "researching");
    expect(overlays.map((overlay) => overlay.source.source_id)).toEqual([
      "document-source",
      "kb-source",
    ]);
    expect(overlays.map((overlay) => overlay.content).join("\n")).not.toContain(
      "Only shape the final report."
    );
  });

  it("accounts for every slot in every cognitive, host, and non-consumer state", () => {
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
          const overlays = owner.resolveOverlays([ref], state);
          expect(overlays).toHaveLength(1);
          expect(overlays[0]?.source).toEqual(source);
        } else {
          expect(() => owner.resolveOverlays([ref], state), `${source.slot}/${state}`).toThrow(
            /unrelated/u
          );
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
    const lengthDrift = validateContextSourceRef({
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
    const aggregateOwner = new ResearchContextOwnerV1(artifacts, {
      versionedDocument: ({ source_id }) => {
        const content = bodies.get(source_id);
        if (content === undefined) throw new Error("selected source is absent");
        return documentResult({ content });
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
