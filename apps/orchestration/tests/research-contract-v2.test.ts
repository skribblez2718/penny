import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../src/checkpointer.js";
import type { ArtifactRef } from "../src/contracts.js";
import { RESEARCH_BUDGET_POLICY, researchLivenessPolicy } from "../src/liveness.js";
import {
  ContextSourceRefV1Schema,
  GroundedSynthesisV1Schema,
  MAX_RESEARCH_SEMANTIC_DRAFT_BYTES,
  ProductReceiptV1Schema,
  ResearchBudgetAdmissionV1Schema,
  ResearchBudgetPolicyV1Schema,
  ResearchBudgetSnapshotV1Schema,
  ResearchProductEnvelopeV1Schema,
  ResearchSemanticDraftV1Schema,
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
  validateDeterministicRenderRef,
  validateGroundedSynthesis,
  validateProductReceipt,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchRequest,
  validateResearchSemanticDraft,
  validateSemanticCoreRef,
  validateSkillPort,
} from "../src/skill-contracts/research.js";
import { validateSkillSchema } from "../src/skill-contracts/common.js";

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

  it("maps frozen presets exactly onto P1 liveness without changing host ceilings", () => {
    validateSkillSchema(ResearchBudgetPolicyV1Schema, RESEARCH_BUDGET_POLICY, "policy");
    for (const mode of ["quick", "standard", "deep"] as const) {
      expect(RESEARCH_BUDGET_POLICY.presets[mode].liveness).toEqual(researchLivenessPolicy(mode));
    }
    expect(RESEARCH_BUDGET_POLICY.presets.quick.liveness.external_calls_per_run).toBe(12);
    expect(RESEARCH_BUDGET_POLICY.presets.standard.liveness.total_phase_repair_invocations).toBe(
      16
    );
    expect(RESEARCH_BUDGET_POLICY.presets.deep.liveness.run_wall_clock_ms).toBe(180 * 60_000);
  });

  it("validates admission and snapshot projections as closed values", () => {
    const request = canonicalizeResearchRequest({
      question: "Snapshot?",
      constraints: { mode: "standard" },
    });
    const admission = resolveResearchBudgetAdmission(request, RESEARCH_BUDGET_POLICY);
    validateSkillSchema(ResearchBudgetAdmissionV1Schema, admission, "admission");
    validateSkillSchema(
      ResearchBudgetSnapshotV1Schema,
      {
        schema_id: "penny.research-budget-snapshot.v1",
        schema_version: 1,
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
