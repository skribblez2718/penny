import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/checkpointer.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { CatalogWorkerContinuityMetadataV1Schema } from "../dist/model-client.js";
import { RESEARCH_BUDGET_POLICY, researchLivenessPolicy } from "../dist/liveness.js";
import {
  ContextSourceRefV1Schema,
  ContextSourceRefV2Schema,
  GroundedSynthesisV1Schema,
  MAX_RESEARCH_SEMANTIC_DRAFT_BYTES,
  RESEARCH_HISTORY_HANDOFF_MAX_ARTIFACTS,
  RESEARCH_CORE_MAX_EVIDENCE_ARTIFACTS,
  ResearchEvidenceCapacityError,
  ProductReceiptV1Schema,
  ResearchBudgetAdmissionV3Schema,
  ResearchBudgetPolicyV3Schema,
  ResearchBudgetSnapshotV3Schema,
  ResearchProductEnvelopeV1Schema,
  ResearchSemanticDraftV1Schema,
  ResolvedContextV2Schema,
  SemanticCoreRefV1Schema,
  SkillPortV1Schema,
  canonicalizeResearchRequest,
  productReceiptId,
  projectResearchSemanticDraft,
  researchRequestSha256,
  researchSemanticDraftPromptContract,
  resolveResearchBudgetAdmission,
  researchRuntimeConstraints,
  validateCanonicalGroundedSynthesisBytes,
  validateContextSourceRef,
  validateContextSourceRefV2,
  validateDeterministicRenderRef,
  validateGroundedSynthesis,
  validateProductReceipt,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchRequest,
  validateResearchSemanticDraft,
  validateResolvedContextV2,
  validateSemanticCoreRef,
  validateVersionedContextSourceRef,
  validateSkillPort,
} from "../dist/skill-contracts/research.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";

type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isUnknownRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function artifactRef(input: {
  readonly id: string;
  readonly phase: "researching" | "synthesizing";
  readonly producer: "agent:echo" | "agent:synthia";
  readonly content: string;
}): ArtifactRef {
  const bytes = Buffer.from(input.content, "utf8");
  const digest = sha256(bytes);
  return {
    schema_version: 2,
    artifact_id: `art_${input.id.repeat(64)}`,
    run_id: "run-semantic-draft-vector",
    phase: input.phase,
    branch_id: input.phase === "researching" ? "sq1" : null,
    kind: "agent-output",
    operation_id: `operation-${input.id}`,
    version: 1,
    producer: input.producer,
    media_type: "text/plain; charset=utf-8",
    byte_length: bytes.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function fixture(name: "positive-vectors.json" | "negative-vectors.json"): UnknownRecord {
  const url = new URL(`./fixtures/skills/research/${name}`, import.meta.url);
  return record(JSON.parse(readFileSync(url, "utf8")), name);
}

describe("P2 closed research schema vectors", () => {
  const positive = fixture("positive-vectors.json");
  const negative = fixture("negative-vectors.json");

  it("admits every positive request/context/product/graph/port vector", () => {
    validateResearchRequest(positive.research_request);
    validateContextSourceRef(positive.context_source_ref);
    validateResearchSemanticDraft(positive.research_semantic_draft);
    validateGroundedSynthesis(positive.grounded_synthesis);
    validateSemanticCoreRef(positive.semantic_core_ref);
    for (const value of array(positive.product_receipts, "product receipts")) {
      validateProductReceipt(value);
    }
    for (const value of array(positive.deterministic_renders, "deterministic renders")) {
      validateDeterministicRenderRef(value);
    }
    validateResearchProductEnvelope(positive.research_product_envelope);
    validateResearchProductGraph({
      core: positive.grounded_synthesis,
      envelope: positive.research_product_envelope,
      receipts: array(positive.product_receipts, "product receipts"),
      renders: array(positive.deterministic_renders, "deterministic renders"),
    });
    for (const value of array(positive.skill_ports, "skill ports")) validateSkillPort(value);
  });

  it("rejects the canonical negative vector for each schema family", () => {
    expect(() => validateResearchRequest(negative.research_request_unknown_field)).toThrow();
    expect(() => validateContextSourceRef(negative.context_kb_normative)).toThrow(/advisory/);
    expect(() =>
      validateResearchSemanticDraft(negative.research_semantic_draft_owner_field)
    ).toThrow();
    expect(() => validateResearchSemanticDraft(negative.research_semantic_draft_bad_index)).toThrow(
      /does not resolve/
    );
    expect(() => validateGroundedSynthesis(negative.grounded_synthesis_duplicate_id)).toThrow(
      /unique/
    );
    expect(() => validateSemanticCoreRef(negative.semantic_core_wrong_kind)).toThrow(/kind/);
    expect(() => validateProductReceipt(negative.product_receipt_pass_without_evidence)).toThrow(
      /PASS/
    );
    expect(() =>
      validateDeterministicRenderRef(negative.deterministic_render_wrong_filename)
    ).toThrow(/path/);
    expect(() =>
      validateResearchProductEnvelope(negative.product_envelope_duplicate_render)
    ).toThrow(/exactly report/);
    expect(() => validateSkillPort(negative.skill_port_invalid_cardinality)).toThrow(/min_items/);
  });

  it("rejects stale receipt substitution and missing render graph members", () => {
    const receipts = array(positive.product_receipts, "receipts").map(validateProductReceipt);
    const first = receipts[0];
    if (first === undefined) throw new Error("grounding receipt vector missing");
    const { receipt_id: _oldId, ...changedBody } = {
      ...first,
      findings: ["substituted finding"],
    };
    const substituted = { ...changedBody, receipt_id: productReceiptId(changedBody) };
    expect(() =>
      validateResearchProductGraph({
        core: positive.grounded_synthesis,
        envelope: positive.research_product_envelope,
        receipts: [substituted, ...receipts.slice(1)],
        renders: array(positive.deterministic_renders, "renders"),
      })
    ).toThrow(/stale or substituted/);
    expect(() =>
      validateResearchProductGraph({
        core: positive.grounded_synthesis,
        envelope: positive.research_product_envelope,
        receipts,
        renders: array(positive.deterministic_renders, "renders").slice(0, 2),
      })
    ).toThrow(/cardinality/);
  });

  it("keeps every exported schema closed", () => {
    const vectors = [
      [ContextSourceRefV1Schema, positive.context_source_ref],
      [ResearchSemanticDraftV1Schema, positive.research_semantic_draft],
      [GroundedSynthesisV1Schema, positive.grounded_synthesis],
      [SemanticCoreRefV1Schema, positive.semantic_core_ref],
      [ProductReceiptV1Schema, array(positive.product_receipts, "receipts")[0]],
      [ResearchProductEnvelopeV1Schema, positive.research_product_envelope],
      [SkillPortV1Schema, array(positive.skill_ports, "ports")[0]],
    ] as const;
    for (const [schema, vector] of vectors) {
      expect(() =>
        validateSkillSchema(schema, { ...record(vector, "closed vector"), rogue: true }, "closed")
      ).toThrow();
    }
  });

  it("versions current context and resolver contracts while refusing unknown future versions", () => {
    const legacy = validateContextSourceRef(positive.context_source_ref);
    const contextV2 = validateContextSourceRefV2({
      ...legacy,
      schema_id: "penny.context-source-ref.v2",
      schema_version: 2,
      admission: {
        authority_kind: "resolver_v2",
        resolver_schema_id: "penny.research-context-resolution.v2",
        resolver_schema_version: 2,
        eligibility: {
          status: "eligible",
          checked_at: "2026-09-01T00:00:00Z",
          valid_from: "2026-09-01T00:00:00Z",
          valid_through: "2026-10-01T00:00:00Z",
        },
        approval: { status: "not_required" },
      },
    });
    expect(contextV2.schema_version).toBe(2);

    const currentResolution = validateResolvedContextV2({
      schema_id: "penny.research-context-resolution.v2",
      schema_version: 2,
      source_kind: "versioned_document",
      source_id: legacy.source_id,
      content: "current bytes",
      media_type: legacy.content.media_type,
      role: legacy.role,
      scope_id: legacy.scope_id,
      revision: legacy.revision,
      freshness: { status: "not_time_sensitive" },
      upstream_locators: legacy.upstream_locators,
      provider: legacy.provider,
      verification_disposition: legacy.verification_disposition,
      conflict: { status: "none" },
      eligibility: {
        status: "eligible",
        checked_at: "2026-09-01T00:00:00Z",
        valid_from: "2026-09-01T00:00:00Z",
        valid_through: "2026-10-01T00:00:00Z",
      },
      approval: { status: "not_required" },
    });
    expect(currentResolution.schema_version).toBe(2);
    expect(() =>
      validateSkillSchema(
        ContextSourceRefV2Schema,
        { ...contextV2, unbound_default: true },
        "closed ContextSourceRefV2"
      )
    ).toThrow();
    expect(() =>
      validateSkillSchema(
        ResolvedContextV2Schema,
        { ...currentResolution, unbound_default: true },
        "closed ResolvedContextV2"
      )
    ).toThrow();
    expect(() =>
      validateVersionedContextSourceRef({
        ...contextV2,
        schema_id: "penny.context-source-ref.v3",
        schema_version: 3,
      })
    ).toThrow(/ContextSourceRef/u);
  });

  it("requires exact canonical GroundedSynthesis bytes and matching typed metadata", () => {
    const core = validateGroundedSynthesis(positive.grounded_synthesis);
    const bytes = Buffer.from(canonicalJson(core), "utf8");
    const binding = validateSemanticCoreRef(positive.semantic_core_ref);
    const ref = {
      ...binding.artifact_ref,
      byte_length: bytes.length,
      content_digest: sha256(bytes),
      store_ref: `artifact://sha256/${sha256(bytes)}`,
    };
    expect(validateCanonicalGroundedSynthesisBytes(bytes, ref)).toEqual(core);
    expect(() =>
      validateCanonicalGroundedSynthesisBytes(
        Buffer.from(JSON.stringify(core, null, 2), "utf8"),
        ref
      )
    ).toThrow(/canonical/);
    expect(() =>
      validateCanonicalGroundedSynthesisBytes(Buffer.from(`${canonicalJson(core)}\n`, "utf8"), ref)
    ).toThrow(/trailing newline/);
  });

  it("projects the compact semantic-draft schema mechanically without owner fields", () => {
    const projected = record(
      JSON.parse(researchSemanticDraftPromptContract()),
      "research semantic draft prompt contract"
    );
    expect(canonicalJson(projected["schema"])).toBe(canonicalJson(ResearchSemanticDraftV1Schema));
    expect(projected).not.toHaveProperty("example");
    expect(projected["draft_bytes"]).toMatchObject({
      encoding: "UTF-8 JSON",
      maximum: MAX_RESEARCH_SEMANTIC_DRAFT_BYTES,
      canonical_serialization_required: false,
      response_framing: "draft JSON value, one LF, then the closed SUMMARY line",
    });
    expect(projected["owner_fields_forbidden"]).toEqual(
      expect.arrayContaining(["request", "provenance", "stable global IDs", "artifact IDs"])
    );
  });

  it("projects a typed draft deterministically into exact canonical GroundedSynthesisV1", () => {
    const request = canonicalizeResearchRequest({
      question: "What does the typed draft prove?",
      constraints: { mode: "quick", scope: { include: ["projection"], exclude: [] } },
    });
    const draft = validateResearchSemanticDraft(positive.research_semantic_draft);
    const evidenceText = "prefix vector excerpt suffix";
    const evidenceRef = artifactRef({
      id: "e",
      phase: "researching",
      producer: "agent:echo",
      content: evidenceText,
    });
    const synthiaRef = artifactRef({
      id: "f",
      phase: "synthesizing",
      producer: "agent:synthia",
      content: canonicalJson(draft),
    });
    const core = projectResearchSemanticDraft({
      draft,
      request,
      contextTraceSha256: "3".repeat(64),
      evidenceArtifacts: [evidenceRef],
      synthesisSourceArtifact: synthiaRef,
      readEvidenceArtifact: () => Buffer.from(evidenceText, "utf8"),
    });
    expect(canonicalJson(core)).toBe(
      canonicalJson({
        schema_id: "penny.grounded-synthesis.v1",
        schema_version: 1,
        request: {
          request_sha256: researchRequestSha256(request),
          normalized_question: request.question,
          scope: request.scope,
        },
        title: "Verified semantic draft",
        executive_summary: "One local claim is supported by an exact excerpt.",
        claims: [
          {
            claim_id: "claim-0001",
            statement: "The vector is internally linked.",
            claim_kind: "fact",
            support_status: "supported",
            confidence: 1,
            evidence_ids: ["evidence-0001"],
            qualifications: [],
          },
        ],
        sources: [
          {
            source_id: "source-0001",
            source_kind: "primary",
            role: "evidentiary",
            tier: 1,
            title: "Vector source",
            locator: "https://example.invalid/vector",
            observed_at: "2026-08-26T00:00:00Z",
          },
        ],
        evidence: [
          {
            evidence_id: "evidence-0001",
            source_id: "source-0001",
            locator: "section-1",
            excerpt_sha256: sha256("vector excerpt"),
            evidence_artifact_id: evidenceRef.artifact_id,
            relation: "supports",
          },
        ],
        contradictions: [],
        unresolved_gaps: [],
        irreducible_uncertainties: [],
        narrative: {
          sections: [
            {
              section_id: "section-0001",
              heading: "Finding",
              body: "The supported finding.",
              claim_ids: ["claim-0001"],
              evidence_ids: ["evidence-0001"],
            },
          ],
        },
        provenance: {
          context_trace_sha256: "3".repeat(64),
          evidence_artifacts: [evidenceRef],
          synthesis_source_artifact: synthiaRef,
        },
      })
    );
    expect(
      validateCanonicalGroundedSynthesisBytes(Buffer.from(canonicalJson(core), "utf8"))
    ).toEqual(core);
  });

  it("accepts meaning-preserving wording variation without exact-string grading", () => {
    const original = validateResearchSemanticDraft(positive.research_semantic_draft);
    const varied = validateResearchSemanticDraft({
      ...original,
      title: "Grounded semantic draft",
      executive_summary: "An exact excerpt supports the single local claim.",
      claims: original.claims.map((claim) => ({
        ...claim,
        statement: "The fixture has a complete internal evidence link.",
      })),
      sections: original.sections.map((section) => ({
        ...section,
        heading: "Supported finding",
        body: "The evidence supports the finding.",
      })),
    });
    expect(canonicalJson(varied)).not.toBe(canonicalJson(original));
    expect({
      claimTopology: varied.claims.map((claim) => [
        claim.claim_kind,
        claim.support_status,
        claim.evidence_indexes,
      ]),
      evidenceTopology: varied.evidence.map((item) => [
        item.source_index,
        item.evidence_artifact_slot,
        item.relation,
      ]),
      sectionTopology: varied.sections.map((section) => [
        section.claim_indexes,
        section.evidence_indexes,
      ]),
    }).toEqual({
      claimTopology: original.claims.map((claim) => [
        claim.claim_kind,
        claim.support_status,
        claim.evidence_indexes,
      ]),
      evidenceTopology: original.evidence.map((item) => [
        item.source_index,
        item.evidence_artifact_slot,
        item.relation,
      ]),
      sectionTopology: original.sections.map((section) => [
        section.claim_indexes,
        section.evidence_indexes,
      ]),
    });
  });

  it("changes the sealed request binding after a material input mutation", () => {
    const draft = validateResearchSemanticDraft(positive.research_semantic_draft);
    const evidenceText = "prefix vector excerpt suffix";
    const evidenceRef = artifactRef({
      id: "e",
      phase: "researching",
      producer: "agent:echo",
      content: evidenceText,
    });
    const synthiaRef = artifactRef({
      id: "f",
      phase: "synthesizing",
      producer: "agent:synthia",
      content: canonicalJson(draft),
    });
    const project = (question: string) =>
      projectResearchSemanticDraft({
        draft,
        request: canonicalizeResearchRequest({
          question,
          constraints: { mode: "quick", scope: { include: ["projection"], exclude: [] } },
        }),
        contextTraceSha256: "3".repeat(64),
        evidenceArtifacts: [evidenceRef],
        synthesisSourceArtifact: synthiaRef,
        readEvidenceArtifact: () => Buffer.from(evidenceText, "utf8"),
      });
    const original = project("What does the typed draft prove?");
    const mutated = project("What different question does the typed draft address?");
    expect(mutated.request.normalized_question).not.toBe(original.request.normalized_question);
    expect(mutated.request.request_sha256).not.toBe(original.request.request_sha256);
    expect(validateGroundedSynthesis(mutated)).toEqual(mutated);
  });

  it("rejects owner injection, bad slots, absent excerpts, dangling relations, and oversized drafts", () => {
    const request = canonicalizeResearchRequest({ question: "Reject?", constraints: {} });
    const draft = validateResearchSemanticDraft(positive.research_semantic_draft);
    const evidenceText = "prefix vector excerpt suffix";
    const evidenceRef = artifactRef({
      id: "e",
      phase: "researching",
      producer: "agent:echo",
      content: evidenceText,
    });
    const synthiaRef = artifactRef({
      id: "f",
      phase: "synthesizing",
      producer: "agent:synthia",
      content: canonicalJson(draft),
    });
    const projection = (candidate: unknown) =>
      projectResearchSemanticDraft({
        draft: candidate,
        request,
        contextTraceSha256: "3".repeat(64),
        evidenceArtifacts: [evidenceRef],
        synthesisSourceArtifact: synthiaRef,
        readEvidenceArtifact: () => Buffer.from(evidenceText, "utf8"),
      });
    expect(() => validateResearchSemanticDraft({ ...draft, provenance: {} })).toThrow();
    expect(() =>
      validateResearchSemanticDraft({
        ...draft,
        claims: [{ ...draft.claims[0], claim_id: "claim-0001" }],
      })
    ).toThrow();
    expect(() =>
      validateResearchSemanticDraft({
        ...draft,
        sources: [{ ...draft.sources[0], source_id: "source-0001" }],
      })
    ).toThrow();
    expect(() =>
      validateResearchSemanticDraft({
        ...draft,
        evidence: [{ ...draft.evidence[0], excerpt_sha256: "0".repeat(64) }],
      })
    ).toThrow();
    expect(() =>
      projection({ ...draft, evidence: [{ ...draft.evidence[0], evidence_artifact_slot: 1 }] })
    ).toThrow(/slot does not resolve/);
    expect(() =>
      projection({ ...draft, evidence: [{ ...draft.evidence[0], excerpt: "absent" }] })
    ).toThrow(/excerpt is absent/);
    expect(() =>
      validateResearchSemanticDraft({
        ...draft,
        sections: [{ ...draft.sections[0], claim_indexes: [1] }],
      })
    ).toThrow(/does not resolve/);
    expect(() =>
      validateResearchSemanticDraft(draft, MAX_RESEARCH_SEMANTIC_DRAFT_BYTES + 1)
    ).toThrow(/byte limit/);
    expect(() =>
      projectResearchSemanticDraft({
        draft,
        request,
        contextTraceSha256: "3".repeat(64),
        evidenceArtifacts: [{ ...evidenceRef, producer: "agent:synthia" }],
        synthesisSourceArtifact: synthiaRef,
        readEvidenceArtifact: () => Buffer.from(evidenceText, "utf8"),
      })
    ).toThrow(/Echo/);
  });

  it("binds history slot bounds to actual shared handoff capacity without lifting the core bound", () => {
    expect(RESEARCH_HISTORY_HANDOFF_MAX_ARTIFACTS).toBe(
      record(CatalogWorkerContinuityMetadataV1Schema.properties.input_artifacts, "handoff schema")[
        "maxItems"
      ]
    );
    expect(
      record(
        ResearchSemanticDraftV1Schema.properties.evidence.items.properties.evidence_artifact_slot,
        "slot schema"
      )["maximum"]
    ).toBe(RESEARCH_HISTORY_HANDOFF_MAX_ARTIFACTS - 1);
    expect(
      record(
        GroundedSynthesisV1Schema.properties.provenance.properties.evidence_artifacts,
        "core schema"
      )["maxItems"]
    ).toBe(64);
    expect(RESEARCH_CORE_MAX_EVIDENCE_ARTIFACTS).toBe(64);
  });

  it("projects cited old0 + new64 only, deduplicates repeated citations and preserves every exact relation", () => {
    const draft = validateResearchSemanticDraft(positive.research_semantic_draft);
    const request = canonicalizeResearchRequest({
      question: "Consider every supplied observation?",
      constraints: {},
    });
    const history = Array.from({ length: RESEARCH_HISTORY_HANDOFF_MAX_ARTIFACTS }, (_, index) => ({
      ...artifactRef({
        id: "e",
        phase: "researching",
        producer: "agent:echo",
        content: `observation ${index}.`,
      }),
      artifact_id: `art_${sha256(`history-${index}`)}`,
      operation_id: `history-${index}`,
    }));
    const synthesis = artifactRef({
      id: "f",
      phase: "synthesizing",
      producer: "agent:synthia",
      content: canonicalJson(draft),
    });
    const evidenceFor = (slot: number) => ({
      ...draft.evidence[0],
      source_index: 0,
      locator: `observation ${slot}`,
      relation: "supports" as const,
      evidence_artifact_slot: slot,
      excerpt: `observation ${slot}.`,
    });
    const candidate = (slots: readonly number[]) => ({
      ...draft,
      evidence: slots.map(evidenceFor),
      claims: draft.claims.map((claim) => ({
        ...claim,
        evidence_indexes: slots.map((_slot, index) => index),
      })),
      sections: draft.sections.map((section) => ({
        ...section,
        evidence_indexes: slots.map((_slot, index) => index),
      })),
    });
    const reads: string[] = [];
    const project = (value: unknown, refs: readonly ArtifactRef[] = history) =>
      projectResearchSemanticDraft({
        draft: value,
        request,
        contextTraceSha256: "3".repeat(64),
        evidenceArtifacts: refs,
        synthesisSourceArtifact: synthesis,
        readEvidenceArtifact: (ref) => {
          reads.push(ref.artifact_id);
          const index = history.findIndex((item) => item.artifact_id === ref.artifact_id);
          return Buffer.from(`observation ${index}.`);
        },
      });
    const core = project(candidate([64, 0, 64]));
    expect(core.provenance.evidence_artifacts).toEqual([history[0], history[64]]);
    expect(reads).toEqual([history[64]?.artifact_id, history[0]?.artifact_id]);
    expect(core.evidence.map((item) => item.evidence_artifact_id)).toEqual([
      history[64]?.artifact_id,
      history[0]?.artifact_id,
      history[64]?.artifact_id,
    ]);
    expect(core.evidence.map((item) => item.excerpt_sha256)).toEqual([
      sha256("observation 64."),
      sha256("observation 0."),
      sha256("observation 64."),
    ]);
    expect(core.claims[0]?.evidence_ids).toEqual([
      "evidence-0001",
      "evidence-0002",
      "evidence-0003",
    ]);
    expect(core.evidence.every((item) => item.source_id === "source-0001")).toBe(true);
    expect(history).toHaveLength(RESEARCH_HISTORY_HANDOFF_MAX_ARTIFACTS);
    expect(project(candidate([255])).provenance.evidence_artifacts).toEqual([history[255]]);
    expect(() => project(candidate([256]))).toThrow();
    expect(() => project(candidate([64]), history.slice(0, 64))).toThrow(/slot does not resolve/);
    expect(() =>
      project({
        ...candidate([0]),
        evidence: [{ ...evidenceFor(0), evidence_artifact_slot: history[0] }],
      })
    ).toThrow();
    expect(() =>
      project({
        ...candidate([0]),
        evidence: [{ ...evidenceFor(0), artifact_id: history[64]?.artifact_id }],
      })
    ).toThrow();
    expect(() =>
      project({ ...candidate([64]), evidence: [{ ...evidenceFor(64), excerpt: "observation 0." }] })
    ).toThrow(/excerpt is absent/);
    expect(() =>
      project(
        candidate([0]),
        [history[0], history[0]].filter((ref): ref is ArtifactRef => ref !== undefined)
      )
    ).toThrow(/unique/);
    expect(() => project(candidate(Array.from({ length: 65 }, (_, index) => index)))).toThrow(
      ResearchEvidenceCapacityError
    );
    expect(() => project(candidate([0]), [...history, synthesis])).toThrow(
      ResearchEvidenceCapacityError
    );
    // Old revisions are addressable, not silently replaced by newer same-operation bytes.
    const old = history[0];
    const next = history[64];
    if (old === undefined || next === undefined) throw new Error("missing revision operands");
    const revision = {
      ...next,
      operation_id: old.operation_id,
      branch_id: old.branch_id,
      version: 2,
    };
    expect(
      project(
        {
          ...candidate([0, 1]),
          evidence: [evidenceFor(0), { ...evidenceFor(64), evidence_artifact_slot: 1 }],
        },
        [old, revision]
      ).provenance.evidence_artifacts
    ).toEqual([old, revision]);
  });

  it("admits partial unsupported and qualified cores but rejects broken support", () => {
    const core = validateGroundedSynthesis(positive.grounded_synthesis);
    const partial = structuredClone(core);
    const partialClaim = partial.claims[0];
    if (partialClaim === undefined) throw new Error("claim vector missing");
    partialClaim.support_status = "unsupported";
    partialClaim.evidence_ids = [];
    expect(() => validateGroundedSynthesis(partial)).not.toThrow();
    expect(() =>
      validateResearchProductGraph({
        core: partial,
        envelope: positive.research_product_envelope,
        receipts: array(positive.product_receipts, "receipts"),
        renders: array(positive.deterministic_renders, "renders"),
      })
    ).toThrow(/unsupported claim/);

    const qualified = structuredClone(core);
    const qualifiedClaim = qualified.claims[0];
    if (qualifiedClaim === undefined) throw new Error("claim vector missing");
    qualifiedClaim.support_status = "qualified";
    qualifiedClaim.qualifications = ["Only the vector scope was checked."];
    expect(() => validateGroundedSynthesis(qualified)).not.toThrow();

    const broken = structuredClone(core);
    const brokenClaim = broken.claims[0];
    if (brokenClaim === undefined) throw new Error("claim vector missing");
    brokenClaim.evidence_ids = [];
    expect(() => validateGroundedSynthesis(broken)).toThrow(/supporting evidence/);

    const dangling = structuredClone(core);
    const danglingSection = dangling.narrative.sections[0];
    if (danglingSection === undefined) throw new Error("section vector missing");
    danglingSection.claim_ids = ["claim-9999"];
    expect(() => validateGroundedSynthesis(dangling)).toThrow(/does not resolve/);

    expect(() => validateGroundedSynthesis({ ...core, receipt: { verdict: "PASS" } })).toThrow();
  });
});

describe("P2 research request and budget projections", () => {
  it("canonicalizes minimal, scoped, narrowed, and widened compatibility requests", () => {
    const minimal = canonicalizeResearchRequest({ question: "Minimal?", constraints: {} });
    expect(minimal.mode).toBeNull();
    expect(minimal.scope).toEqual({ include: [], exclude: [] });

    const request = canonicalizeResearchRequest({
      question: "Budgeted?",
      constraints: {
        mode: "quick",
        scope: { include: ["in"], exclude: ["out"] },
        max_sub_queries: 12,
        max_fan_width: 3,
        max_research_rounds: 4,
        max_iterations: 5,
        critique_passes: 1,
      },
    });
    const admission = resolveResearchBudgetAdmission(request, RESEARCH_BUDGET_POLICY);
    expect(admission).toMatchObject({
      mode: "quick",
      max_sub_queries: 12,
      max_fan_width: 3,
      effective_decomposition_width: 3,
      total_research_rounds: 4,
      max_evaluator_attempts_per_loop: 5,
      max_semantic_repairs_per_loop: 4,
      critique_passes: 1,
    });
  });

  it("classifies native synthesis products by exact identity instead of a misleading slot", () => {
    const evidenceContextRef: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${"e".repeat(64)}`,
      run_id: "run-evidence-context",
      phase: "evidence_context",
      branch_id: null,
      kind: "evidence-context",
      operation_id: "evidence-context:misleading-slot",
      version: 1,
      producer: "host:evidence-context",
      media_type: "application/json",
      content_schema: { schema_id: "penny.evidence-context.v1", schema_version: 1 },
      byte_length: 2,
      content_digest: "e".repeat(64),
      store_ref: `artifact://sha256/${"e".repeat(64)}`,
    };
    const groundedSynthesisRef: ArtifactRef = {
      ...evidenceContextRef,
      artifact_id: `art_${"b".repeat(64)}`,
      run_id: "run-grounded-synthesis",
      phase: "sealing_core",
      kind: "semantic-core",
      operation_id: "grounded-synthesis:nonstandard-slot",
      producer: "host:research-core",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      content_digest: "a".repeat(64),
      store_ref: `artifact://sha256/${"a".repeat(64)}`,
    };
    const request = canonicalizeResearchRequest({
      question: "Classify exact inputs?",
      constraints: {},
      inputArtifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "prior_grounded_synthesis", ref: evidenceContextRef },
          { slot: "caller-selected-product", ref: groundedSynthesisRef },
        ],
      },
    });
    expect(request.input_products).toEqual([
      { port_name: "prior_grounded_synthesis", artifact_ref: groundedSynthesisRef },
    ]);
  });

  it("maps frozen presets onto V3 progress leases without elapsed-work ceilings", () => {
    validateSkillSchema(ResearchBudgetPolicyV3Schema, RESEARCH_BUDGET_POLICY, "policy");
    for (const mode of ["quick", "standard", "deep"] as const) {
      expect(RESEARCH_BUDGET_POLICY.presets[mode].liveness).toEqual(researchLivenessPolicy(mode));
    }
    const quick = RESEARCH_BUDGET_POLICY.presets.quick.liveness;
    expect(quick.schema_version).toBe(3);
    expect(quick.renewal_policy).toBe("trusted_host_activity_or_convergence_v1");
    expect(quick.unknown_provider_phase_inactivity_ms).toBe(10 * 60_000);
    expect(quick.calibration_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect("worker_active_work_budget_ms" in quick).toBe(false);
    expect("run_active_work_budget_ms" in quick).toBe(false);
    expect("external_calls_per_run" in quick).toBe(false);
  });

  it("validates admission and snapshot projections as closed values", () => {
    const request = canonicalizeResearchRequest({
      question: "Snapshot?",
      constraints: { mode: "standard" },
    });
    const admission = resolveResearchBudgetAdmission(request, RESEARCH_BUDGET_POLICY);
    validateSkillSchema(ResearchBudgetAdmissionV3Schema, admission, "admission");
    validateSkillSchema(
      ResearchBudgetSnapshotV3Schema,
      {
        schema_id: "penny.research-budget-snapshot.v3",
        schema_version: 3,
        admission,
        liveness_snapshot_sha256: "a".repeat(64),
        phase_attempts_by_state_branch: { "planning:null": 1 },
      },
      "snapshot"
    );
  });

  it("rejects overlap, unknowns, illegal rigor, host ceilings, and alias conflicts", () => {
    expect(() =>
      canonicalizeResearchRequest({
        question: "Scope?",
        constraints: { scope: { include: ["same"], exclude: ["same"] } },
      })
    ).toThrow(/overlap/);
    expect(() =>
      canonicalizeResearchRequest({ question: "Unknown?", constraints: { surprise: true } })
    ).toThrow(/unknown/);
    expect(() =>
      canonicalizeResearchRequest({ question: "Rigor?", constraints: { rigor_escalation: true } })
    ).toThrow(/not a supported/);
    expect(() =>
      canonicalizeResearchRequest({ question: "Host?", constraints: { max_steps: 10 } })
    ).toThrow(/host liveness/);
    expect(() =>
      canonicalizeResearchRequest({
        question: "Aliases?",
        constraints: { total_research_rounds: 2, max_research_rounds: 3 },
      })
    ).toThrow(/disagree/);
    const legacyModel = canonicalizeResearchRequest({
      question: "Legacy model?",
      constraints: { validate_model: "provider/verifier-model" },
    });
    expect(legacyModel.verification_model_override).toMatch(/^legacy-model-/u);
    expect(
      researchRuntimeConstraints(legacyModel, {
        legacyVerificationModelOverride: "provider/verifier-model",
      }).validate_model
    ).toBe("provider/verifier-model");
    expect(() =>
      canonicalizeResearchRequest({
        question: "Canonical model?",
        constraints: { verification_model_override: "provider/verifier-model" },
      })
    ).toThrow();

    const valid = canonicalizeResearchRequest({ question: "Valid?", constraints: {} });
    expect(() => validateResearchRequest({ ...valid, question: "   " })).toThrow(/text/);
    expect(() => validateResearchRequest({ ...valid, question: "e\u0301" })).toThrow(/NFC/);
    expect(() =>
      validateResearchRequest({
        ...valid,
        scope: { ...valid.scope, include: Array.from({ length: 33 }, (_, index) => `i-${index}`) },
      })
    ).toThrow();
  });
});
